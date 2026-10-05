//! Exec credential plugins (`user.exec` in a kubeconfig: `aws eks get-token`, `kubelogin get-token`,
//! `gke-gcloud-auth-plugin`…), run by k10s rather than by kube.
//!
//! kube runs a plugin itself while building a client — three times over — and again inside requests
//! whenever its token is about to expire: as many at once as there are clusters, without a timeout, holding
//! the client's token lock while a plugin waits for a login. Here a plugin runs once per client, through
//! the gates of `cluster::ExecGates`, and kube gets what it returned as plain credentials (a bearer token or
//! a client certificate) that it never refreshes on its own: the engine renews them ahead of their expiry,
//! through the same gates (see `cluster::Endpoint::renewal_due`).
//!
//! Errors never carry the plugin's environment or output: those hold the user's credentials.

use std::process::Stdio;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use kube::config::{AuthInfo, ExecConfig, ExecInteractiveMode};
use serde::Deserialize;

use crate::cluster::ConnectError;
use crate::redact;

/// What a plugin returned: a bearer token or a client certificate, and until when it is valid. Not
/// `Debug`: it is a credential.
pub(crate) struct Credential {
    token: Option<String>,
    /// PEM certificate and key.
    certificate: Option<(String, String)>,
    pub expires: Option<SystemTime>,
}

impl Credential {
    /// Makes `config` authenticate with this credential: kube then never runs the plugin itself. A
    /// certificate wins over a token, as with kube and client-go.
    pub(crate) fn apply(self, config: &mut kube::Config) {
        use base64::Engine as _;
        let auth = &mut config.auth_info;
        auth.exec = None;
        if let Some((cert, key)) = self.certificate {
            // kube joins key and certificate into one PEM bundle: each has to end its own line.
            let line = |mut pem: String| {
                if !pem.ends_with('\n') {
                    pem.push('\n');
                }
                pem
            };
            let b64 = base64::engine::general_purpose::STANDARD;
            auth.client_certificate_data = Some(b64.encode(line(cert)));
            auth.client_key_data = Some(b64.encode(line(key)).into());
            auth.client_certificate = None;
            auth.client_key = None;
        } else if let Some(token) = self.token {
            auth.token = Some(token.into());
        }
    }
}

/// The exec plugin kube would use for `auth`: only when no other credential comes first (an auth
/// provider, a username and password, a token or a token file — kube's own order).
pub(crate) fn in_use(auth: &AuthInfo) -> Option<&ExecConfig> {
    let other = auth.auth_provider.is_some() || (auth.username.is_some() && auth.password.is_some()) || auth.token.is_some() || auth.token_file.is_some();
    if other { None } else { auth.exec.as_ref() }
}

#[derive(Deserialize)]
struct ExecCredential {
    status: Option<ExecCredentialStatus>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExecCredentialStatus {
    expiration_timestamp: Option<String>,
    token: Option<String>,
    client_certificate_data: Option<String>,
    client_key_data: Option<String>,
}

/// Runs the plugin `name` (its program name, for messages) once and reads the credential it prints, the
/// way kube does: its arguments and environment, `KUBERNETES_EXEC_INFO`, stdin and stderr left to it unless
/// `interactiveMode: Never`. Not bounded here: the caller stops waiting after a timeout, while a run that
/// waits for a login goes on — it may still complete and leave its token cached for the next attempt.
/// `env_failed`: the login-shell environment could not be imported (for hints).
pub(crate) async fn run(exec: &ExecConfig, name: &str, env_failed: bool) -> Result<Credential, ConnectError> {
    let command = exec.command.as_deref().ok_or_else(|| fatal("the kubeconfig's exec auth plugin names no command".into()))?;
    let mut cmd = tokio::process::Command::new(command);
    cmd.args(exec.args.iter().flatten());
    for vars in exec.env.iter().flatten() {
        if let (Some(var), Some(value)) = (vars.get("name"), vars.get("value")) {
            cmd.env(var, value);
        }
    }
    let interactive = exec.interactive_mode != Some(ExecInteractiveMode::Never);
    let mut spec = serde_json::json!({ "interactive": interactive });
    if exec.provide_cluster_info {
        let cluster = exec
            .cluster
            .as_ref()
            .ok_or_else(|| fatal(format!("auth plugin `{name}` asks for the cluster's details (provideClusterInfo), which the kubeconfig does not give")))?;
        spec["cluster"] = serde_json::to_value(cluster).map_err(|e| fatal(format!("auth plugin `{name}`: the cluster's details cannot be passed on: {e}")))?;
    }
    let info = serde_json::json!({ "apiVersion": exec.api_version, "kind": "ExecCredential", "spec": spec });
    cmd.env("KUBERNETES_EXEC_INFO", info.to_string());
    for var in exec.drop_env.iter().flatten() {
        cmd.env_remove(var);
    }
    cmd.stdout(Stdio::piped());
    if interactive {
        cmd.stdin(Stdio::inherit()).stderr(Stdio::inherit());
    } else {
        cmd.stdin(Stdio::null()).stderr(Stdio::piped());
    }

    let out = cmd.output().await.map_err(|io| start_failure(name, &io, env_failed))?;
    if !out.status.success() {
        let words = std::iter::once(name.to_string()).chain(exec.args.iter().flatten().cloned()).collect();
        let failure = redact::plugin_run_failure(words, &out.status.to_string(), &String::from_utf8_lossy(&out.stderr));
        return Err(fatal(format!("{failure} (run the plugin in a terminal to see why)")));
    }
    parse(&out.stdout, name)
}

/// Why a plugin could not be started, naming it.
fn start_failure(name: &str, io: &std::io::Error, env_failed: bool) -> ConnectError {
    fatal(match io.kind() {
        std::io::ErrorKind::NotFound if env_failed => format!(
            "auth plugin `{name}` was not found: the environment of your login shell (with its PATH) could not be imported. k10s tries again — use Reload kubeconfig, then reconnect"
        ),
        std::io::ErrorKind::NotFound => {
            format!("auth plugin `{name}` was not found: install it or add its folder to PATH in your shell profile, then reconnect")
        }
        _ => format!("auth plugin `{name}` could not be started: {io}"),
    })
}

/// The credential in a plugin's output. Error texts say where reading failed, never what was read: a
/// plugin printing a bare token would have it quoted back.
fn parse(stdout: &[u8], name: &str) -> Result<Credential, ConnectError> {
    let unreadable = |e: &serde_json::Error| {
        fatal(format!("auth plugin `{name}` printed no ExecCredential (line {}, column {}) (run the plugin in a terminal to see why)", e.line(), e.column()))
    };
    let credential: ExecCredential = match serde_json::from_slice(stdout) {
        Ok(c) => c,
        // client-go reads plugin output YAML-tolerantly, and some plugins print YAML.
        Err(json) => serde_saphyr::from_slice(stdout).map_err(|_| unreadable(&json))?,
    };
    let none = || fatal(format!("auth plugin `{name}` returned no credential (run the plugin in a terminal to see why)"));
    let status = credential.status.ok_or_else(none)?;
    let expires = match status.expiration_timestamp.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(ts) => Some(timestamp(ts).ok_or_else(|| fatal(format!("auth plugin `{name}` returned an expirationTimestamp that is not an RFC 3339 time")))?),
        None => None,
    };
    let certificate = match (status.client_certificate_data, status.client_key_data) {
        (Some(cert), Some(key)) if !cert.is_empty() && !key.is_empty() => Some((cert, key)),
        _ => None,
    };
    let token = status.token.filter(|t| !t.is_empty());
    if certificate.is_none() && token.is_none() {
        return Err(none());
    }
    Ok(Credential { token, certificate, expires })
}

fn timestamp(s: &str) -> Option<SystemTime> {
    let (secs, nanos) = crate::time::parse_rfc3339(s)?;
    Some(UNIX_EPOCH + Duration::new(u64::try_from(secs).ok()?, nanos))
}

fn fatal(message: String) -> ConnectError {
    ConnectError { message, code: None, retryable: false }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// An exec config running `sh -c <script>`, not interactive (stderr is captured).
    fn sh(script: &str) -> ExecConfig {
        ExecConfig {
            api_version: Some("client.authentication.k8s.io/v1".into()),
            command: Some("sh".into()),
            args: Some(vec!["-c".into(), script.into()]),
            interactive_mode: Some(ExecInteractiveMode::Never),
            ..Default::default()
        }
    }

    fn printing(output: &str) -> ExecConfig {
        sh(&format!("printf '%s' '{output}'"))
    }

    fn config() -> kube::Config {
        kube::Config::new("https://127.0.0.1:1".parse().unwrap())
    }

    #[tokio::test]
    async fn a_token_with_its_expiry_becomes_a_plain_bearer_token() {
        let exec = printing(
            r#"{"apiVersion":"client.authentication.k8s.io/v1","kind":"ExecCredential","status":{"token":"t0k3n","expirationTimestamp":"2030-01-02T03:04:05Z"}}"#,
        );
        let credential = run(&exec, "sh", false).await.unwrap();
        assert_eq!(credential.expires, Some(UNIX_EPOCH + Duration::from_secs(1_893_553_445)));
        let mut cfg = config();
        cfg.auth_info.exec = Some(exec);
        credential.apply(&mut cfg);
        assert!(cfg.auth_info.exec.is_none(), "kube must never run the plugin itself");
        assert_eq!(cfg.auth_info.token.as_ref().map(|t| secrecy::ExposeSecret::expose_secret(t).to_string()).as_deref(), Some("t0k3n"));
    }

    #[tokio::test]
    async fn a_client_certificate_becomes_kubeconfig_data_and_wins_over_a_token() {
        let exec = printing(
            r#"{"status":{"token":"ignored","clientCertificateData":"-----BEGIN CERTIFICATE-----\nAAA\n-----END CERTIFICATE-----","clientKeyData":"-----BEGIN PRIVATE KEY-----\nBBB\n-----END PRIVATE KEY-----\n"}}"#,
        );
        let credential = run(&exec, "sh", false).await.unwrap();
        assert!(credential.expires.is_none());
        let mut cfg = config();
        credential.apply(&mut cfg);
        use base64::Engine as _;
        let decode = |s: &str| String::from_utf8(base64::engine::general_purpose::STANDARD.decode(s).unwrap()).unwrap();
        assert_eq!(decode(cfg.auth_info.client_certificate_data.as_deref().unwrap()), "-----BEGIN CERTIFICATE-----\nAAA\n-----END CERTIFICATE-----\n");
        let key = cfg.auth_info.client_key_data.as_ref().map(|k| secrecy::ExposeSecret::expose_secret(k).to_string()).unwrap();
        assert_eq!(decode(&key), "-----BEGIN PRIVATE KEY-----\nBBB\n-----END PRIVATE KEY-----\n");
        assert!(cfg.auth_info.token.is_none() && cfg.auth_info.exec.is_none());
    }

    #[tokio::test]
    async fn yaml_output_is_read_too() {
        let credential = run(&sh("printf 'kind: ExecCredential\\nstatus:\\n  token: from-yaml\\n'"), "sh", false).await.unwrap();
        assert_eq!(credential.token.as_deref(), Some("from-yaml"));
    }

    #[tokio::test]
    async fn the_plugin_gets_exec_info_its_environment_and_not_the_dropped_variables() {
        let mut exec = sh(r#"printf '{"status":{"token":"%s|%s|%s"}}' "$TEAM" "${DROPPED:-gone}" "$(printf '%s' "$KUBERNETES_EXEC_INFO" | tr -d '"')""#);
        let var = |name: &str, value: &str| [("name".to_string(), name.to_string()), ("value".to_string(), value.to_string())].into();
        // Dropped after the plugin's own variables are set, like kube does.
        exec.env = Some(vec![var("TEAM", "payments"), var("DROPPED", "present")]);
        exec.drop_env = Some(vec!["DROPPED".into()]);
        let credential = run(&exec, "sh", false).await.unwrap();
        assert_eq!(
            credential.token.as_deref(),
            Some("payments|gone|{apiVersion:client.authentication.k8s.io/v1,kind:ExecCredential,spec:{interactive:false}}")
        );
    }

    #[tokio::test]
    async fn failures_name_the_plugin_and_never_repeat_its_output() {
        let failed = run(&sh("echo partial-SECRET; echo please sign in again >&2; exit 1"), "sh", false).await.err().unwrap();
        assert!(failed.message.starts_with("auth plugin `sh -c echo partial-SECRET"), "{}", failed.message);
        assert!(failed.message.ends_with("failed (exit status: 1): please sign in again (run the plugin in a terminal to see why)"), "{}", failed.message);
        assert!(!failed.retryable);

        // A bare token instead of an ExecCredential: not quoted back.
        for output in [r#""eyJhbGciOiJSUzI1NiJ9.SECRET.sig""#, "eyJhbGciOiJSUzI1NiJ9.SECRET.sig", r#"{"status": ["#] {
            let err = run(&printing(output), "sh", false).await.err().unwrap().message;
            assert!(err.starts_with("auth plugin `sh` printed no ExecCredential (line 1, column") && !err.contains("SECRET"), "{err}");
        }
        for output in [r#"{"kind":"ExecCredential"}"#, r#"{"status":{"token":""}}"#, r#"{"status":{"clientCertificateData":"only a certificate"}}"#] {
            let err = run(&printing(output), "sh", false).await.err().unwrap().message;
            assert_eq!(err, "auth plugin `sh` returned no credential (run the plugin in a terminal to see why)");
        }
        let err = run(&printing(r#"{"status":{"token":"t","expirationTimestamp":"tomorrow"}}"#), "sh", false).await.err().unwrap().message;
        assert_eq!(err, "auth plugin `sh` returned an expirationTimestamp that is not an RFC 3339 time");
    }

    #[tokio::test]
    async fn a_missing_plugin_says_how_to_fix_it() {
        let mut exec = sh("");
        exec.command = Some("/nonexistent/bin/kubelogin".into());
        let err = run(&exec, "kubelogin", false).await.err().unwrap().message;
        assert_eq!(err, "auth plugin `kubelogin` was not found: install it or add its folder to PATH in your shell profile, then reconnect");
        let err = run(&exec, "kubelogin", true).await.err().unwrap().message;
        assert!(err.starts_with("auth plugin `kubelogin` was not found: the environment of your login shell"), "{err}");
    }

    #[test]
    fn which_exec_plugin_kube_would_use() {
        let exec = sh("true");
        let with = |f: fn(&mut AuthInfo)| {
            let mut auth = AuthInfo { exec: Some(exec.clone()), ..Default::default() };
            f(&mut auth);
            in_use(&auth).is_some()
        };
        assert!(with(|_| {}));
        assert!(!with(|a| a.token = Some("t".to_string().into())));
        assert!(!with(|a| a.token_file = Some("/var/run/token".into())));
        assert!(with(|a| a.username = Some("only a username".into())));
    }
}
