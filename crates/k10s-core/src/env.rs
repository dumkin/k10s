//! Login-shell environment import.
//!
//! GUI apps on macOS/Linux start with a minimal environment (`PATH=/usr/bin:/bin:…`, no `KUBECONFIG`),
//! so kubeconfig exec plugins (`aws`, `gke-gcloud-auth-plugin`, `kubelogin`…) would not be found.
//! We ask the user's login shell for its environment in the background, and inject it into exec-plugin
//! invocations — without mutating the process environment (which is unsound once threads run). A failed
//! import is retried later by the engine (see `Inner::shell_env`), not kept until restart.

use std::collections::HashMap;
use std::time::Duration;

#[cfg(any(unix, test))]
const BEGIN: &str = "__K10S_ENV_BEGIN__";
#[cfg(any(unix, test))]
const END: &str = "__K10S_ENV_END__";

/// Variables that describe the shell session itself and must not leak into child processes.
const SKIP: &[&str] = &["PWD", "OLDPWD", "SHLVL", "_", "PS1", "PS2", "TERM", "TERM_PROGRAM", "TERM_PROGRAM_VERSION", "TERM_SESSION_ID", "COLUMNS", "LINES"];

#[derive(Default, Clone, PartialEq, Eq)]
pub struct ShellEnv {
    /// Variables imported from the login shell (empty when the import was skipped or failed).
    imported: HashMap<String, String>,
    /// The import was attempted and failed (timeout, broken profile…): worth retrying.
    failed: bool,
}

/// Names only: the values are the user's tokens and keys.
impl std::fmt::Debug for ShellEnv {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let mut names: Vec<_> = self.imported.keys().collect();
        names.sort();
        f.debug_struct("ShellEnv").field("imported", &names).field("failed", &self.failed).finish()
    }
}

impl ShellEnv {
    /// Value from the login shell, falling back to the process environment.
    pub fn var(&self, key: &str) -> Option<String> {
        self.imported.get(key).cloned().or_else(|| std::env::var(key).ok())
    }

    pub fn is_imported(&self) -> bool {
        !self.imported.is_empty()
    }

    /// The app was launched from a GUI but its login shell environment could not be imported.
    pub fn import_failed(&self) -> bool {
        self.failed
    }

    /// `name`/`value` pairs (kubeconfig `exec.env` format) for every imported variable that differs
    /// from the process environment.
    pub fn exec_env(&self) -> Vec<HashMap<String, String>> {
        self.imported
            .iter()
            .filter(|(k, v)| !SKIP.contains(&k.as_str()) && std::env::var(k).ok().as_deref() != Some(v.as_str()))
            .map(|(k, v)| HashMap::from([("name".to_string(), k.clone()), ("value".to_string(), v.clone())]))
            .collect()
    }
}

/// Whether the process looks like it was launched from a GUI (Finder/Dock/launcher) rather than a terminal.
pub fn launched_from_gui() -> bool {
    match std::env::var("K10S_IMPORT_SHELL_ENV").as_deref() {
        Ok("1") | Ok("true") => return true,
        Ok("0") | Ok("false") => return false,
        _ => {}
    }
    cfg!(unix) && std::env::var_os("TERM").is_none()
}

/// Imports the login shell environment if the app was launched from a GUI; otherwise returns an empty env.
pub async fn load(timeout: Duration) -> ShellEnv {
    if !launched_from_gui() {
        return ShellEnv::default();
    }
    let started = std::time::Instant::now();
    match import(timeout).await {
        Ok(imported) => {
            tracing::info!(vars = imported.len(), elapsed = ?started.elapsed(), "imported login shell environment");
            ShellEnv { imported, failed: false }
        }
        Err(err) => {
            tracing::warn!(%err, "could not import login shell environment (will retry)");
            ShellEnv { imported: HashMap::new(), failed: true }
        }
    }
}

#[cfg(unix)]
async fn import(timeout: Duration) -> Result<HashMap<String, String>, String> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let script = format!("printf '%s' '{BEGIN}'; env -0; printf '%s' '{END}'");
    let child = tokio::process::Command::new(&shell)
        .args(["-l", "-i", "-c", &script])
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true)
        .output();
    let out = tokio::time::timeout(timeout, child)
        .await
        .map_err(|_| format!("{shell} did not answer within {timeout:?}"))?
        .map_err(|e| format!("failed to run {shell}: {e}"))?;
    let stdout = String::from_utf8_lossy(&out.stdout);
    parse(&stdout).ok_or_else(|| "shell output had no environment markers".to_string())
}

#[cfg(not(unix))]
async fn import(_timeout: Duration) -> Result<HashMap<String, String>, String> {
    Ok(HashMap::new())
}

#[cfg(any(unix, test))]
fn parse(out: &str) -> Option<HashMap<String, String>> {
    let start = out.find(BEGIN)? + BEGIN.len();
    let end = start + out[start..].find(END)?;
    Some(
        out[start..end]
            .split('\0')
            .filter_map(|kv| kv.split_once('='))
            .filter(|(k, _)| !k.is_empty() && !k.contains(char::is_whitespace))
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect(),
    )
}

#[cfg(test)]
impl ShellEnv {
    pub(crate) fn for_tests(vars: &[(&str, &str)], failed: bool) -> Self {
        ShellEnv { imported: vars.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(), failed }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_between_markers_ignoring_shell_noise() {
        let out = format!("Last login: today\n{BEGIN}PATH=/opt/bin:/usr/bin\0KUBECONFIG=/a:/b\0MULTI=x=y\0{END}bye");
        let env = parse(&out).unwrap();
        assert_eq!(env["PATH"], "/opt/bin:/usr/bin");
        assert_eq!(env["KUBECONFIG"], "/a:/b");
        assert_eq!(env["MULTI"], "x=y");
    }
}
