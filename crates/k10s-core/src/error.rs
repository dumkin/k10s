use std::fmt;

use serde::{Serialize, Serializer, ser::SerializeStruct};

pub use crate::redact::redact_secrets;
pub(crate) use crate::redact::sanitize_error_text;

pub type Result<T, E = Error> = std::result::Result<T, E>;

/// Every way this error becomes text (`Display`, `Debug`, [`Error::message`], serialization) is
/// sanitized: kube's exec auth failures embed the plugin's environment and output (see [`redact_secrets`]).
#[derive(thiserror::Error)]
pub enum Error {
    #[error("kubeconfig: {}", sanitize_error_text(.0))]
    Kubeconfig(String),
    #[error("context \"{0}\" not found in kubeconfig")]
    UnknownContext(String),
    #[error("cluster \"{context}\": {}", sanitize_error_text(.message))]
    Connect { context: String, message: String, code: Option<u16> },
    #[error("resource \"{resource}\" is not served by cluster \"{cluster}\"")]
    UnknownResource { cluster: String, resource: String },
    #[error("read-only mode is on: mutating actions are disabled")]
    ReadOnly,
    #[error("{0}")]
    Unsupported(String),
    /// Deliberately not a `#[source]`: generic chain walkers would print the raw kube error.
    #[error("{}", kube_message(.0))]
    Kube(kube::Error),
    #[error("{}", sanitize_error_text(.0))]
    Other(String),
}

impl From<kube::Error> for Error {
    fn from(e: kube::Error) -> Self {
        Error::Kube(e)
    }
}

/// Hand-written: the derived form would print kube's raw error.
impl fmt::Debug for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Error").field("kind", &self.kind()).field("message", &self.message()).field("code", &self.code()).finish()
    }
}

impl Error {
    pub fn other(msg: impl Into<String>) -> Self {
        Error::Other(msg.into())
    }

    /// HTTP status code reported by the API server, if any.
    pub fn code(&self) -> Option<u16> {
        match self {
            Error::Kube(kube::Error::Api(s)) if s.code != 0 => Some(s.code),
            Error::Connect { code, .. } => *code,
            _ => None,
        }
    }

    /// API `reason` (`Forbidden`, `NotFound`…), when the server provided one.
    pub fn reason(&self) -> Option<String> {
        match self {
            Error::Kube(kube::Error::Api(s)) if !s.reason.is_empty() => Some(s.reason.clone()),
            Error::Connect { code: Some(401), .. } => Some("Unauthorized".into()),
            Error::Connect { code: Some(403), .. } => Some("Forbidden".into()),
            Error::UnknownResource { .. } => Some("NotFound".into()),
            _ => None,
        }
    }

    pub fn kind(&self) -> &'static str {
        match self {
            Error::Kubeconfig(_) => "kubeconfig",
            Error::UnknownContext(_) => "unknownContext",
            Error::Connect { .. } => "connect",
            Error::UnknownResource { .. } => "unknownResource",
            Error::ReadOnly => "readOnly",
            Error::Unsupported(_) => "unsupported",
            Error::Kube(kube::Error::Api(_)) => "api",
            Error::Kube(kube::Error::Auth(_)) => "auth",
            Error::Kube(_) => "transport",
            Error::Other(_) => "other",
        }
    }

    /// Human-friendly message without Rust debug noise, with the source chain flattened.
    pub fn message(&self) -> String {
        self.to_string()
    }
}

/// Sanitized message of a kube error; use it (never `%err`/`?err`) wherever one is logged.
pub(crate) fn kube_message(e: &kube::Error) -> String {
    match e {
        kube::Error::Api(status) => {
            let msg = if status.message.is_empty() { status.reason.as_str() } else { status.message.as_str() };
            match status.code {
                401 => sanitize_error_text(&format!("Unauthorized: credentials are missing or expired ({msg})")),
                _ => sanitize_error_text(msg),
            }
        }
        other => chain(other),
    }
}

/// "outer: inner: root cause" — deduplicated, since many errors repeat their source in Display — and
/// sanitized as a whole (per-part sanitizing would defeat the de-duplication).
pub(crate) fn chain(e: &(dyn std::error::Error + 'static)) -> String {
    let mut out = e.to_string();
    let mut cur = e.source();
    while let Some(src) = cur {
        let s = src.to_string();
        if !out.contains(&s) {
            out.push_str(": ");
            out.push_str(&s);
        }
        cur = src.source();
    }
    sanitize_error_text(&out)
}

impl Serialize for Error {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let mut st = s.serialize_struct("Error", 3)?;
        st.serialize_field("kind", self.kind())?;
        st.serialize_field("message", &self.message())?;
        st.serialize_field("code", &self.code())?;
        st.end()
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::process::Command;

    /// A real exec auth failure, built the way kube 4.2 builds it.
    pub(crate) fn exec_failure() -> kube::client::AuthError {
        let mut cmd = Command::new("kubelogin");
        cmd.args(["get-token"]).envs([
            ("API_TOKEN", "SECRET123"),
            ("PATH", "/usr/bin"),
            ("KUBERNETES_EXEC_INFO", r#"{"apiVersion":"client.authentication.k8s.io/v1"}"#),
        ]);
        let out = Command::new("sh").args(["-c", "echo please sign in again >&2; echo partial-token; exit 1"]).output().unwrap();
        kube::client::AuthError::AuthExecRun { cmd: format!("{cmd:?}"), status: out.status, out }
    }

    pub(crate) const EXEC_FAILURE: &str = "exec auth plugin `kubelogin get-token` failed (exit status: 1): please sign in again";

    fn assert_clean(text: &str) {
        for secret in ["SECRET123", "partial-token", "/usr/bin", "client.authentication.k8s.io"] {
            assert!(!text.contains(secret), "{secret:?} leaked: {text}");
        }
    }

    #[test]
    fn exec_auth_failures_never_leak_the_environment() {
        assert!(kube::Error::Auth(exec_failure()).to_string().contains("SECRET123"), "kube's own text leaks");

        let e = Error::from(kube::Error::Auth(exec_failure()));
        assert_eq!(e.kind(), "auth");
        assert_eq!(e.message(), format!("auth error: {EXEC_FAILURE}"));
        assert_eq!(e.to_string(), e.message());
        assert_clean(&format!("{e:?}"));
        assert_clean(&serde_json::to_string(&e).unwrap());
        assert!(std::error::Error::source(&e).is_none());

        // What the cluster list shows after a failed connect.
        let connect = Error::Connect { context: "dc1".into(), message: e.message(), code: None };
        assert_eq!(connect.to_string(), format!("cluster \"dc1\": auth error: {EXEC_FAILURE}"));

        // A token refresh failing inside a request comes back wrapped in a service error.
        let wrapped = kube::Error::Service(Box::new(exec_failure()));
        assert_eq!(kube_message(&wrapped), format!("ServiceError: {EXEC_FAILURE}"));
        assert_eq!(chain(&wrapped), kube_message(&wrapped));

        // Raw strings that slipped into other variants are sanitized too, even debug-printed ones.
        for raw in [kube::Error::Auth(exec_failure()).to_string(), format!("{:?}", kube::Error::Auth(exec_failure()))] {
            assert_clean(&Error::other(raw.clone()).to_string());
            assert_clean(&Error::Kubeconfig(raw.clone()).message());
            assert_clean(&Error::Connect { context: "dc1".into(), message: raw, code: None }.message());
        }
    }

    #[tokio::test]
    async fn exec_auth_failure_of_a_real_plugin_run() {
        // The connect path: kube runs the plugin while building the client.
        let kc = kube::config::Kubeconfig::from_yaml(
            r#"
apiVersion: v1
kind: Config
clusters: [{name: c, cluster: {server: "https://127.0.0.1:1"}}]
users:
- name: u
  user:
    exec:
      apiVersion: client.authentication.k8s.io/v1
      command: sh
      args: ["-c", "echo please sign in again >&2; echo $API_TOKEN; exit 1"]
      env: [{name: API_TOKEN, value: SECRET123}, {name: PATH, value: /usr/bin:/bin}]
      interactiveMode: Never
contexts: [{name: ctx, context: {cluster: c, user: u}}]
current-context: ctx
"#,
        )
        .unwrap();
        let config = kube::Config::from_custom_kubeconfig(kc, &Default::default()).await.unwrap();
        let e = Error::from(kube::Client::try_from(config).err().expect("the plugin fails"));
        assert_clean(&e.message());
        assert_eq!(
            e.message(),
            "auth error: exec auth plugin `sh -c echo please sign in again >&2; echo $API_TOKEN; exit 1` failed (exit status: 1): please sign in again"
        );
    }

    #[test]
    fn api_messages_are_unchanged() {
        let msg = r#"pods "x" is forbidden: User "u" cannot list resource "pods" in API group "" in the namespace "default""#;
        let status = kube::core::Status { message: msg.into(), reason: "Forbidden".into(), code: 403, ..Default::default() };
        let e = Error::from(kube::Error::Api(Box::new(status)));
        assert_eq!(e.message(), msg);
        assert_eq!((e.code(), e.reason().as_deref(), e.kind()), (Some(403), Some("Forbidden"), "api"));
    }
}
