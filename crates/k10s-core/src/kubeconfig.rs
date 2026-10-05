//! Kubeconfig loading (respecting `KUBECONFIG` lists), context listing and per-context client configs.

use std::path::PathBuf;
use std::time::{Duration, SystemTime};

use kube::config::{KubeConfigOptions, Kubeconfig};
use serde::Serialize;

use crate::env::ShellEnv;
use crate::error::{Error, Result, chain};

/// Every socket read gives up after this long without data, so no request hangs on a dead connection
/// forever. Watches are closed by the server every minute (see `feed.rs`) and never get here; a
/// follow-log stream of a quiet container does, and reconnects seamlessly from its last line — hence
/// minutes, not seconds. It also bounds a mutation that waits for its answer on a dead connection; reads
/// waiting for response headers are bounded sooner, see `cluster::Endpoint`.
const READ_TIMEOUT: Duration = Duration::from_secs(300);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextInfo {
    pub name: String,
    pub cluster: String,
    pub server: Option<String>,
    pub user: Option<String>,
    pub namespace: Option<String>,
    /// Short description of the auth method, e.g. `exec: aws`, `token`, `client-cert`, `oidc`.
    pub auth: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextList {
    pub contexts: Vec<ContextInfo>,
    pub current: Option<String>,
    /// Every file searched, in order.
    pub paths: Vec<String>,
    /// Those of `paths` that exist. Empty: there is no kubeconfig at all (not an empty one).
    pub found: Vec<String>,
    /// `paths` come from the `KUBECONFIG` variable; otherwise they are the default `~/.kube/config`.
    pub from_env: bool,
}

pub struct KubeconfigStore {
    paths: Vec<PathBuf>,
    from_env: bool,
    found: Vec<PathBuf>,
    mtimes: Vec<Option<SystemTime>>,
    config: Kubeconfig,
}

impl KubeconfigStore {
    pub fn load(env: &ShellEnv) -> Result<Self> {
        let started = std::time::Instant::now();
        let (paths, from_env) = kubeconfig_paths(env);
        // Missing files are skipped, like kubectl does with a `KUBECONFIG` list.
        let found: Vec<PathBuf> = paths.iter().filter(|p| p.exists()).cloned().collect();
        let mut merged: Option<Kubeconfig> = None;
        for path in &found {
            let kc = Kubeconfig::read_from(path).map_err(|e| Error::Kubeconfig(format!("{}: {}", path.display(), chain(&e))))?;
            merged = Some(match merged {
                None => kc,
                Some(m) => m.merge(kc).map_err(|e| Error::Kubeconfig(chain(&e)))?,
            });
        }
        let config = merged.unwrap_or_default();
        tracing::info!(contexts = config.contexts.len(), files = found.len(), elapsed = ?started.elapsed(), "kubeconfig loaded");
        Ok(Self { mtimes: mtimes(&paths), paths, from_env, found, config })
    }

    /// True if any kubeconfig file was modified (or appeared/disappeared) since loading.
    pub fn is_stale(&self) -> bool {
        mtimes(&self.paths) != self.mtimes
    }

    pub fn list(&self) -> ContextList {
        let mut contexts: Vec<ContextInfo> = self
            .config
            .contexts
            .iter()
            .map(|named| {
                let ctx = named.context.as_ref();
                let cluster_name = ctx.map(|c| c.cluster.clone()).unwrap_or_default();
                let server = self.config.clusters.iter().find(|c| c.name == cluster_name).and_then(|c| c.cluster.as_ref()).and_then(|c| c.server.clone());
                let user = ctx.and_then(|c| c.user.clone());
                let auth = user
                    .as_ref()
                    .and_then(|u| self.config.auth_infos.iter().find(|a| &a.name == u))
                    .and_then(|a| a.auth_info.as_ref())
                    .map(describe_auth)
                    .unwrap_or_else(|| "none".into());
                ContextInfo { name: named.name.clone(), cluster: cluster_name, server, user, namespace: ctx.and_then(context_namespace), auth }
            })
            .collect();
        contexts.sort_by(|a, b| a.name.cmp(&b.name));
        ContextList {
            contexts,
            current: self.config.current_context.clone().filter(|c| !c.is_empty()),
            paths: self.paths.iter().map(|p| p.display().to_string()).collect(),
            found: self.found.iter().map(|p| p.display().to_string()).collect(),
            from_env: self.from_env,
        }
    }

    pub fn default_namespace(&self, context: &str) -> Option<String> {
        self.config.contexts.iter().find(|c| c.name == context).and_then(|c| c.context.as_ref()).and_then(context_namespace)
    }

    /// Builds a `kube::Config` for one context from a minimal kubeconfig (only that context, its cluster
    /// and user), with the login-shell environment injected into exec auth plugins.
    pub async fn client_config(&self, context: &str, env: &ShellEnv) -> Result<kube::Config> {
        let named = self.config.contexts.iter().find(|c| c.name == context).ok_or_else(|| Error::UnknownContext(context.into()))?;
        let ctx = named.context.as_ref().ok_or_else(|| Error::Kubeconfig(format!("context {context} is empty")))?;
        let cluster = self.config.clusters.iter().find(|c| c.name == ctx.cluster).cloned();
        let user = ctx.user.as_ref().and_then(|u| self.config.auth_infos.iter().find(|a| &a.name == u)).cloned();

        let mut mini = Kubeconfig {
            contexts: vec![named.clone()],
            clusters: cluster.into_iter().collect(),
            auth_infos: user.into_iter().collect(),
            current_context: Some(context.into()),
            ..Default::default()
        };

        let injected = env.exec_env();
        if !injected.is_empty() {
            for exec in mini.auth_infos.iter_mut().filter_map(|a| a.auth_info.as_mut()).filter_map(|a| a.exec.as_mut()) {
                let own = exec.env.take().unwrap_or_default();
                let mut vars: Vec<_> = injected.iter().filter(|v| !own.iter().any(|o| o.get("name") == v.get("name"))).cloned().collect();
                vars.extend(own);
                exec.env = Some(vars);
            }
        }

        let opts = KubeConfigOptions { context: Some(context.into()), ..Default::default() };
        let mut cfg = kube::Config::from_custom_kubeconfig(mini, &opts).await.map_err(|e| Error::Kubeconfig(chain(&e)))?;
        cfg.connect_timeout = Some(Duration::from_secs(10));
        cfg.read_timeout = Some(READ_TIMEOUT);
        // kube's own retries would send any request answered 429, 503 or 504 again — a mutation too — up to
        // 15 times, waiting as long as `Retry-After` says: a Job created behind a 504 would be created
        // twice, a delete that went through be reported as failed. Reads are sent again briefly by
        // `cluster::Endpoint`; mutations never.
        cfg.default_retry = false;
        Ok(cfg)
    }

    #[cfg(test)]
    pub(crate) fn from_yaml(yaml: &str) -> Self {
        Self { paths: Vec::new(), from_env: false, found: Vec::new(), mtimes: Vec::new(), config: Kubeconfig::from_yaml(yaml).unwrap() }
    }
}

/// Program name of an exec plugin command (`/usr/local/bin/kubelogin` → `kubelogin`): enough to
/// recognise it, without the user's paths.
pub(crate) fn plugin_name(command: &str) -> &str {
    command.rsplit(['/', '\\']).next().unwrap_or(command)
}

/// The namespace a context sets (kubectl's default for it); `namespace: ""` sets none.
fn context_namespace(ctx: &kube::config::Context) -> Option<String> {
    ctx.namespace.clone().filter(|ns| !ns.trim().is_empty())
}

/// The files to read, and whether they come from `KUBECONFIG` (rather than the default `~/.kube/config`).
fn kubeconfig_paths(env: &ShellEnv) -> (Vec<PathBuf>, bool) {
    if let Some(list) = env.var("KUBECONFIG").filter(|v| !v.trim().is_empty()) {
        let paths: Vec<PathBuf> = std::env::split_paths(&list).filter(|p| !p.as_os_str().is_empty()).collect();
        if !paths.is_empty() {
            return (paths, true);
        }
    }
    let home = env.var("HOME").or_else(|| env.var("USERPROFILE"));
    (home.map(|home| vec![PathBuf::from(home).join(".kube").join("config")]).unwrap_or_default(), false)
}

fn mtimes(paths: &[PathBuf]) -> Vec<Option<SystemTime>> {
    paths.iter().map(|p| std::fs::metadata(p).and_then(|m| m.modified()).ok()).collect()
}

fn describe_auth(a: &kube::config::AuthInfo) -> String {
    if let Some(exec) = &a.exec {
        return format!("exec: {}", plugin_name(exec.command.as_deref().unwrap_or("?")));
    }
    if let Some(p) = &a.auth_provider {
        return p.name.clone();
    }
    if a.token.is_some() || a.token_file.is_some() {
        return "token".into();
    }
    if a.client_certificate.is_some() || a.client_certificate_data.is_some() {
        return "client-cert".into();
    }
    if a.username.is_some() {
        return "basic".into();
    }
    "none".into()
}

#[cfg(test)]
mod tests {
    use super::*;

    const KUBECONFIG: &str = r#"
apiVersion: v1
kind: Config
clusters: [{name: c, cluster: {server: "https://127.0.0.1:1"}}]
users:
- name: u
  user:
    exec:
      apiVersion: client.authentication.k8s.io/v1
      command: /opt/tools/bin/kubelogin
      args: [get-token]
      interactiveMode: IfAvailable
contexts: [{name: prod-eu-z1, context: {cluster: c, user: u, namespace: payments}}]
current-context: prod-eu-z1
"#;

    #[tokio::test]
    async fn client_configs_bound_connects_and_reads_and_keep_the_exec_plugin_as_configured() {
        let store = KubeconfigStore::from_yaml(KUBECONFIG);
        let cfg = store.client_config("prod-eu-z1", &ShellEnv::default()).await.unwrap();
        assert_eq!(cfg.connect_timeout, Some(Duration::from_secs(10)));
        assert_eq!(cfg.read_timeout, Some(READ_TIMEOUT));
        assert!(!cfg.default_retry, "kube must not send mutations again on its own");
        let exec = cfg.auth_info.exec.unwrap();
        assert_eq!(exec.command.as_deref(), Some("/opt/tools/bin/kubelogin"));
        // Interactive mode is the plugin's business: passed on untouched.
        assert!(matches!(exec.interactive_mode, Some(kube::config::ExecInteractiveMode::IfAvailable)));
        assert_eq!(store.list().contexts[0].auth, "exec: kubelogin");
        assert_eq!(store.default_namespace("prod-eu-z1").as_deref(), Some("payments"));
    }

    #[test]
    fn contexts_carry_the_namespace_they_set() {
        let store = KubeconfigStore::from_yaml(
            r#"
apiVersion: v1
kind: Config
clusters: [{name: c, cluster: {server: "https://127.0.0.1:1"}}]
users: [{name: u, user: {token: API_TOKEN}}]
contexts:
- {name: prod-eu-z2, context: {cluster: c, user: u}}
- {name: prod-eu-z1, context: {cluster: c, user: u, namespace: payments}}
- {name: prod-eu-z3, context: {cluster: c, user: u, namespace: ""}}
"#,
        );
        let list = store.list();
        let ns: Vec<_> = list.contexts.iter().map(|c| (c.name.as_str(), c.namespace.as_deref())).collect();
        // Sorted by name; an empty `namespace:` sets none (like kubectl).
        assert_eq!(ns, [("prod-eu-z1", Some("payments")), ("prod-eu-z2", None), ("prod-eu-z3", None)]);
        assert_eq!(store.default_namespace("prod-eu-z3"), None);
        assert_eq!(list.current, None);
        let json = serde_json::to_value(&list).unwrap();
        assert_eq!(json["contexts"][0]["namespace"], "payments");
        assert_eq!(json["fromEnv"], false);
    }

    #[test]
    fn a_missing_kubeconfig_is_told_apart_from_an_empty_one() {
        let dir = std::env::temp_dir().join(format!("k10s-kubeconfig-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let (a, b) = (dir.join("a.yaml"), dir.join("b.yaml"));
        let list = std::env::join_paths([&a, &b]).unwrap();
        let env = ShellEnv::for_tests(&[("KUBECONFIG", list.to_str().unwrap())], false);

        // Neither file exists: nothing found, every path searched is listed.
        let store = KubeconfigStore::load(&env).unwrap();
        let listed = store.list();
        assert!(listed.contexts.is_empty() && listed.found.is_empty() && listed.from_env);
        assert_eq!(listed.paths, [a.display().to_string(), b.display().to_string()]);

        // One exists but has no contexts: found, still empty.
        std::fs::write(&b, "apiVersion: v1\nkind: Config\n").unwrap();
        let listed = KubeconfigStore::load(&env).unwrap().list();
        assert!(listed.contexts.is_empty());
        assert_eq!(listed.found, [b.display().to_string()]);

        // An invalid one is an error naming the file.
        std::fs::write(&a, "contexts: {oops").unwrap();
        let err = KubeconfigStore::load(&env).err().unwrap().to_string();
        assert!(err.contains("a.yaml"), "{err}");

        // Without KUBECONFIG: the default ~/.kube/config.
        let home = ShellEnv::for_tests(&[("KUBECONFIG", " "), ("HOME", dir.to_str().unwrap())], false);
        let listed = KubeconfigStore::load(&home).unwrap().list();
        assert!(!listed.from_env && listed.found.is_empty());
        assert_eq!(listed.paths, [dir.join(".kube").join("config").display().to_string()]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn plugin_names_drop_the_path() {
        assert_eq!(plugin_name("/usr/local/bin/aws"), "aws");
        assert_eq!(plugin_name(r"C:\tools\kubelogin.exe"), "kubelogin.exe");
        assert_eq!(plugin_name("gke-gcloud-auth-plugin"), "gke-gcloud-auth-plugin");
    }
}
