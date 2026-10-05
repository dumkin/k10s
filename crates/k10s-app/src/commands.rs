//! IPC surface. Commands are thin: all logic lives in `k10s-core`.
//! Streaming commands take a `Channel` and receive pre-serialized JSON, so payloads are encoded once.
//!
//! Every command touching the engine is `async`: Tauri runs sync commands on the main (UI) thread,
//! and nothing that takes engine locks should ever be able to stall window event handling.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use k10s_core::access::Rules;
use k10s_core::cluster::ClusterInfo;
use k10s_core::feed::HubStats;
use k10s_core::helm::{Diff, Release};
use k10s_core::kubeconfig::ContextList;
use k10s_core::metrics::{History, Kind};
use k10s_core::ops::OpResult;
use k10s_core::{
    AccessCheck, AccessDecision, DebugSpec, Engine, ForwardInfo, ForwardSpec, LogSpec, LogTarget, MetricsSpec, NodeShellSpec, ObjectRef, RelationsSpec, Result,
    Settings, Sink, TermSize, TermSpec, ViewSpec,
};
use serde::Serialize;
use tauri::ipc::{Channel, InvokeResponseBody, Response};
use tauri::{AppHandle, State, WebviewWindow};

use crate::diag::Diagnostics;
use crate::prefs::Prefs;

/// Where log files are written (`None` if the folder could not be determined).
pub struct LogDir(pub Option<PathBuf>);

/// Channel-backed sink whose traffic is accounted for (see [`Diagnostics`]).
fn sink(diag: &Arc<Diagnostics>, channel: Channel, what: String) -> Sink {
    let token = diag.open_stream(channel.id(), what);
    Arc::new(move |json: String| {
        token.record(json.len());
        channel.send(InvokeResponseBody::Json(json)).is_ok()
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    version: &'static str,
    os: &'static str,
    arch: &'static str,
    log_dir: Option<String>,
    /// This build updates itself (see `updates`).
    updates: bool,
}

#[tauri::command]
pub fn app_info(app: AppHandle, log_dir: State<'_, LogDir>) -> AppInfo {
    AppInfo {
        version: env!("CARGO_PKG_VERSION"),
        os: std::env::consts::OS,
        arch: std::env::consts::ARCH,
        log_dir: log_dir.0.as_ref().map(|d| d.display().to_string()),
        updates: crate::updates::enabled(&app),
    }
}

#[tauri::command]
pub async fn list_contexts(engine: State<'_, Engine>) -> Result<ContextList> {
    engine.contexts().await
}

#[tauri::command]
pub async fn connect_cluster(engine: State<'_, Engine>, context: String) -> Result<ClusterInfo> {
    engine.connect(&context).await
}

#[tauri::command]
pub async fn reconnect_cluster(engine: State<'_, Engine>, context: String) -> Result<ClusterInfo> {
    engine.reconnect(&context).await
}

#[tauri::command]
pub async fn refresh_discovery(engine: State<'_, Engine>, context: String) -> Result<ClusterInfo> {
    engine.refresh_discovery(&context).await
}

#[tauri::command]
pub async fn disconnect_cluster(engine: State<'_, Engine>, context: String) -> Result<()> {
    engine.disconnect(&context);
    Ok(())
}

/// The UI noticed the computer slept (or the network changed): restart watches, retry failed clusters.
#[tauri::command]
pub async fn resync(engine: State<'_, Engine>) -> Result<()> {
    engine.resync();
    Ok(())
}

#[tauri::command]
pub async fn subscribe_view(engine: State<'_, Engine>, diag: State<'_, Arc<Diagnostics>>, spec: ViewSpec, channel: Channel) -> Result<u64> {
    let what = spec.describe();
    Ok(engine.subscribe_view(spec, sink(&diag, channel, what)))
}

#[tauri::command]
pub async fn stream_logs(engine: State<'_, Engine>, diag: State<'_, Arc<Diagnostics>>, spec: LogSpec, channel: Channel) -> Result<u64> {
    // A workload's targets change while it streams (it often starts with none): name what is shown.
    let what = match (&spec.label, spec.targets.as_slice()) {
        (Some(label), _) => format!("logs {label}"),
        (None, [one, ..]) => format!("logs {}/{}", one.pod, one.container),
        (None, []) => "logs".to_string(),
    };
    Ok(engine.stream_logs(spec, sink(&diag, channel, what)))
}

/// Replaces the targets of a running log stream: a workload's pods came or went. Unchanged targets
/// stream on, so the UI keeps its lines.
#[tauri::command]
pub async fn update_log_targets(engine: State<'_, Engine>, id: u64, targets: Vec<LogTarget>) -> Result<()> {
    engine.update_log_targets(id, targets)
}

/// Opens a terminal in a running container (a shell, or its console with `attach`).
#[tauri::command]
pub async fn start_terminal(engine: State<'_, Engine>, diag: State<'_, Arc<Diagnostics>>, spec: TermSpec, channel: Channel) -> Result<u64> {
    let what = format!("terminal {}/{}/{}", spec.namespace, spec.pod, spec.container);
    Ok(engine.start_terminal(spec, sink(&diag, channel, what)))
}

/// Adds a debug container to a pod and opens a terminal in it.
#[tauri::command]
pub async fn start_debug(engine: State<'_, Engine>, diag: State<'_, Arc<Diagnostics>>, spec: DebugSpec, channel: Channel) -> Result<u64> {
    let what = format!("debug {}/{}", spec.namespace, spec.pod);
    Ok(engine.start_debug(spec, sink(&diag, channel, what)))
}

/// Opens a shell on a node through a helper pod (deleted when the session ends).
#[tauri::command]
pub async fn start_node_shell(engine: State<'_, Engine>, diag: State<'_, Arc<Diagnostics>>, spec: NodeShellSpec, channel: Channel) -> Result<u64> {
    let what = format!("node shell {}", spec.node);
    Ok(engine.start_node_shell(spec, sink(&diag, channel, what)))
}

/// Keystrokes for a terminal. `binary`: each character is one byte (xterm.js's binary input: mouse reports).
#[tauri::command]
pub async fn terminal_input(engine: State<'_, Engine>, id: u64, data: String, binary: Option<bool>) -> Result<()> {
    let bytes = if binary.unwrap_or(false) { data.chars().map(|c| c as u32 as u8).collect() } else { data.into_bytes() };
    engine.terminal_input(id, bytes)
}

#[tauri::command]
pub async fn terminal_resize(engine: State<'_, Engine>, id: u64, cols: u16, rows: u16) -> Result<()> {
    engine.terminal_resize(id, TermSize { cols, rows })
}

/// The terminal drew `bytes` more of the output (flow control, see `k10s_core::term`).
#[tauri::command]
pub async fn terminal_ack(engine: State<'_, Engine>, id: u64, bytes: usize) -> Result<()> {
    engine.terminal_ack(id, bytes)
}

/// Helm releases of these clusters and namespaces, as a view's table.
#[tauri::command]
pub async fn subscribe_helm(engine: State<'_, Engine>, diag: State<'_, Arc<Diagnostics>>, spec: ViewSpec, channel: Channel) -> Result<u64> {
    let what = format!("helm releases in {} clusters", spec.clusters.len());
    Ok(engine.subscribe_helm(spec, sink(&diag, channel, what)))
}

#[tauri::command]
pub async fn helm_release(engine: State<'_, Engine>, cluster: String, namespace: String, name: String) -> Result<Release> {
    engine.helm_release(&cluster, &namespace, &name).await
}

#[tauri::command]
pub async fn helm_diff(engine: State<'_, Engine>, cluster: String, namespace: String, name: String, from: i64, to: i64) -> Result<Diff> {
    engine.helm_diff(&cluster, &namespace, &name, from, to).await
}

/// `helm rollback` with the user's helm (refused in read-only mode).
#[tauri::command]
pub async fn helm_rollback(engine: State<'_, Engine>, cluster: String, namespace: String, name: String, revision: i64) -> Result<String> {
    engine.helm_rollback(&cluster, &namespace, &name, revision).await
}

/// `helm uninstall` of each target (refused in read-only mode).
#[tauri::command]
pub async fn helm_uninstall(engine: State<'_, Engine>, targets: Vec<ObjectRef>) -> Result<Vec<OpResult>> {
    engine.helm_uninstall(targets).await
}

/// CPU and memory usage of pods or nodes (the metrics API, polled), as a stream.
#[tauri::command]
pub async fn subscribe_metrics(engine: State<'_, Engine>, diag: State<'_, Arc<Diagnostics>>, spec: MetricsSpec, channel: Channel) -> Result<u64> {
    let what = format!("metrics {:?} in {} clusters", spec.kind, spec.clusters.len());
    Ok(engine.subscribe_metrics(spec, sink(&diag, channel, what)))
}

/// The usage of one pod or node over the last minutes (while a view polls it).
#[tauri::command]
pub async fn metrics_history(engine: State<'_, Engine>, cluster: String, kind: Kind, namespace: Option<String>, name: String) -> Result<Option<History>> {
    Ok(engine.metrics_history(&cluster, kind, namespace.as_deref(), &name))
}

/// Starts a port-forward (checked first: the local port, the permission, a pod to forward to).
#[tauri::command]
pub async fn start_forward(engine: State<'_, Engine>, spec: ForwardSpec) -> Result<ForwardInfo> {
    engine.start_forward(spec).await
}

#[tauri::command]
pub async fn stop_forward(engine: State<'_, Engine>, id: u64) -> Result<bool> {
    Ok(engine.stop_forward(id))
}

/// The port-forwards, as a stream: on every change, and while they carry traffic.
#[tauri::command]
pub async fn subscribe_forwards(engine: State<'_, Engine>, diag: State<'_, Arc<Diagnostics>>, channel: Channel) -> Result<u64> {
    Ok(engine.subscribe_forwards(sink(&diag, channel, "port-forwards".into())))
}

/// Opens a port-forward's local URL in the default browser — only that: the web view names a forward, not a URL.
#[tauri::command]
pub async fn open_forward(engine: State<'_, Engine>, id: u64) -> Result<()> {
    let url = engine.forward_url(id).ok_or_else(|| k10s_core::Error::other(format!("port-forward {id} is not running")))?;
    open_with_system(&url)
}

/// Streams the graph around one object (what relates to it), live.
#[tauri::command]
pub async fn subscribe_relations(engine: State<'_, Engine>, diag: State<'_, Arc<Diagnostics>>, spec: RelationsSpec, channel: Channel) -> Result<u64> {
    let what = format!("relations {}/{}", spec.resource, spec.name);
    Ok(engine.subscribe_relations(spec, sink(&diag, channel, what)))
}

/// Whether the user may do each of `checks` in `cluster`: actions say so before they are confirmed.
#[tauri::command]
pub async fn access_review(engine: State<'_, Engine>, cluster: String, checks: Vec<AccessCheck>) -> Result<Vec<AccessDecision>> {
    engine.access_review(&cluster, checks).await
}

/// What the user may do in a namespace of `cluster` (`kubectl auth can-i --list`).
#[tauri::command]
pub async fn access_rules(engine: State<'_, Engine>, cluster: String, namespace: String) -> Result<Rules> {
    engine.access_rules(&cluster, &namespace).await
}

/// Stops a view, log stream or terminal.
#[tauri::command]
pub async fn unsubscribe(engine: State<'_, Engine>, id: u64) -> Result<()> {
    engine.cancel(id);
    Ok(())
}

#[tauri::command]
pub async fn get_object(engine: State<'_, Engine>, target: ObjectRef) -> Result<Response> {
    let json = engine.get_object(&target).await?;
    Ok(Response::new(json.to_string()))
}

/// A Secret's values are hidden unless `reveal` (an explicit "Reveal values" in the UI).
#[tauri::command]
pub async fn get_yaml(engine: State<'_, Engine>, target: ObjectRef, managed_fields: bool, reveal: Option<bool>) -> Result<String> {
    engine.get_yaml(&target, managed_fields, reveal.unwrap_or(false)).await
}

#[tauri::command]
pub async fn delete_objects(engine: State<'_, Engine>, targets: Vec<ObjectRef>, force: bool) -> Result<Vec<OpResult>> {
    engine.delete(targets, force).await
}

#[tauri::command]
pub async fn scale(engine: State<'_, Engine>, target: ObjectRef, replicas: i32) -> Result<()> {
    engine.scale(&target, replicas).await
}

#[tauri::command]
pub async fn restart(engine: State<'_, Engine>, target: ObjectRef) -> Result<()> {
    engine.restart(&target).await
}

#[tauri::command]
pub async fn set_unschedulable(engine: State<'_, Engine>, target: ObjectRef, unschedulable: bool) -> Result<()> {
    engine.set_unschedulable(&target, unschedulable).await
}

#[tauri::command]
pub async fn set_suspend(engine: State<'_, Engine>, target: ObjectRef, suspend: bool) -> Result<()> {
    engine.set_suspend(&target, suspend).await
}

#[tauri::command]
pub async fn trigger_cronjob(engine: State<'_, Engine>, target: ObjectRef) -> Result<String> {
    engine.trigger_cronjob(&target).await
}

#[tauri::command]
pub async fn get_settings(engine: State<'_, Engine>) -> Result<Settings> {
    Ok(engine.settings())
}

/// Changes settings and returns those in effect. Read-only mode can be turned on here, not off: that
/// takes `set_read_only`.
#[tauri::command]
pub async fn set_settings(engine: State<'_, Engine>, settings: Settings) -> Result<Settings> {
    Ok(engine.set_settings(settings))
}

/// Turns read-only mode on — or off, once the user confirmed it in a native dialog. Nothing running in
/// the web view can answer that dialog, so a script there cannot switch the protection off by itself, nor
/// keep putting the dialog in front of the user until a stray Return lands (see [`ConfirmGate`]).
/// Returns the settings in effect (still read-only when the user kept it).
#[tauri::command]
pub async fn set_read_only(window: WebviewWindow, engine: State<'_, Engine>, enabled: bool) -> Result<Settings> {
    match plan_read_only(enabled, engine.settings().read_only, &READ_WRITE, Instant::now()) {
        Plan::TurnOn => Ok(engine.set_read_only(true)),
        Plan::Keep => Ok(engine.settings()),
        Plan::Refuse(skip) => {
            tracing::info!(target: "k10s::audit", action = "read-only mode", params = "off", result = "ignored", reason = skip.reason(), "settings");
            Err(k10s_core::Error::other(skip.message()))
        }
        Plan::Ask(asking) => {
            if !confirm_read_write(&window).await {
                asking.declined(Instant::now());
                tracing::info!(target: "k10s::audit", action = "read-only mode", params = "off", result = "declined", "settings");
                return Ok(engine.settings());
            }
            drop(asking);
            // The only place read-only mode is ever written off.
            Ok(engine.set_read_only(false))
        }
    }
}

/// Turning read-only mode off asks first: one dialog at a time, and none for a while after a "no".
static READ_WRITE: ConfirmGate = ConfirmGate::new(DECLINED_COOLDOWN);

/// After the user kept read-only mode on, requests to turn it off are refused for this long without asking.
const DECLINED_COOLDOWN: Duration = Duration::from_secs(10);

/// What a `set_read_only(enabled)` request does.
enum Plan<'a> {
    TurnOn,
    /// Nothing to write: it is off already. (Writing "off" here could undo a "turn on" that landed
    /// meanwhile, with no dialog.)
    Keep,
    Refuse(Skip),
    Ask(Asking<'a>),
}

fn plan_read_only(enabled: bool, read_only: bool, gate: &ConfirmGate, now: Instant) -> Plan<'_> {
    if enabled {
        return Plan::TurnOn;
    }
    if !read_only {
        return Plan::Keep;
    }
    match gate.begin(now) {
        Ok(asking) => Plan::Ask(asking),
        Err(skip) => Plan::Refuse(skip),
    }
}

/// Whether a request to turn read-only mode off may ask the user now.
struct ConfirmGate {
    cooldown: Duration,
    state: parking_lot::Mutex<GateState>,
}

struct GateState {
    /// A confirmation is on screen.
    open: bool,
    declined_at: Option<Instant>,
}

#[derive(Debug, PartialEq)]
enum Skip {
    AlreadyAsking,
    JustDeclined,
}

impl Skip {
    fn reason(&self) -> &'static str {
        match self {
            Skip::AlreadyAsking => "a confirmation is already open",
            Skip::JustDeclined => "the user kept it on moments ago",
        }
    }

    fn message(&self) -> &'static str {
        match self {
            Skip::AlreadyAsking => "Read-only mode stays on: a confirmation to turn it off is already open.",
            Skip::JustDeclined => "Read-only mode stays on: you chose to keep it a moment ago. Try again in a few seconds.",
        }
    }
}

impl ConfirmGate {
    const fn new(cooldown: Duration) -> Self {
        Self { cooldown, state: parking_lot::Mutex::new(GateState { open: false, declined_at: None }) }
    }

    fn begin(&self, now: Instant) -> std::result::Result<Asking<'_>, Skip> {
        let mut s = self.state.lock();
        if s.open {
            return Err(Skip::AlreadyAsking);
        }
        if s.declined_at.is_some_and(|at| now.saturating_duration_since(at) < self.cooldown) {
            return Err(Skip::JustDeclined);
        }
        s.open = true;
        Ok(Asking(self))
    }
}

/// The confirmation's turn; it ends when this is dropped.
struct Asking<'a>(&'a ConfirmGate);

impl Asking<'_> {
    /// Kept on (or the dialog could not be shown): no new dialog for a while.
    fn declined(self, now: Instant) {
        self.0.state.lock().declined_at = Some(now);
    }
}

impl Drop for Asking<'_> {
    fn drop(&mut self) {
        self.0.state.lock().open = false;
    }
}

/// Asks, natively, whether read-only mode may be turned off. `false` when kept, closed or unavailable.
async fn confirm_read_write(window: &WebviewWindow) -> bool {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind, MessageDialogResult};

    const TURN_OFF: &str = "Turn Off";
    let (tx, rx) = tokio::sync::oneshot::channel();
    window
        .dialog()
        .message("Delete, scale, restart, cordon, suspend, trigger, Helm rollback and uninstall will work again, and so will shells in containers, in every cluster of your kubeconfig. Changes still ask before they are made.")
        .title("Turn off read-only mode?")
        .kind(MessageDialogKind::Warning)
        // The first button is the default (Return), and one titled "Cancel" answers Escape (NSAlert): both
        // keep read-only mode. Only a deliberate click on "Turn Off" turns it off.
        .buttons(MessageDialogButtons::YesNoCancelCustom("Keep Read-Only".into(), TURN_OFF.into(), "Cancel".into()))
        .parent(window)
        .show_with_result(move |pressed| {
            let _ = tx.send(matches!(pressed, MessageDialogResult::Custom(ref label) if label == TURN_OFF));
        });
    // The dialog could not be shown at all (the sender is dropped): keep read-only mode.
    rx.await.unwrap_or(false)
}

#[tauri::command]
pub async fn stats(engine: State<'_, Engine>) -> Result<HubStats> {
    Ok(engine.stats())
}

/// Frontend reports (errors, main-thread stalls) land in the same log as the engine's. Their text is the web
/// view's: lines after the first are indented by the log writer, so it cannot forge records (see `logging.rs`).
#[tauri::command]
pub fn log_frontend(level: Option<String>, message: String) {
    match level.as_deref() {
        Some("warn") => tracing::warn!(target: "k10s::ui", "{message}"),
        Some("info") => tracing::info!(target: "k10s::ui", "{message}"),
        Some("debug") => tracing::debug!(target: "k10s::ui", "{message}"),
        _ => tracing::error!(target: "k10s::ui", "{message}"),
    }
}

/// Sent by the UI every second; runs on the main thread, so it also stops when that thread is stuck.
#[tauri::command]
pub fn ui_heartbeat(diag: State<'_, Arc<Diagnostics>>, visible: bool) {
    diag.heartbeat(visible);
}

#[tauri::command]
pub fn toggle_devtools(window: WebviewWindow) {
    if window.is_devtools_open() {
        window.close_devtools();
    } else {
        window.open_devtools();
    }
}

/// The UI's theme now (`dark` or `light`): the window takes its colour (seen while it resizes), and opens in it next
/// time when the settings follow the system's theme.
#[tauri::command]
pub fn set_appearance(window: WebviewWindow, prefs: State<'_, Arc<Prefs>>, theme: String) -> Result<()> {
    let color = crate::appearance::color(&theme).ok_or_else(|| k10s_core::Error::other(format!("unknown theme {theme:?}")))?;
    if let Err(err) = window.set_background_color(Some(color)) {
        tracing::debug!(%err, "could not set the window's colour");
    }
    prefs.remember_shown_theme(&theme);
    Ok(())
}

/// Zooms the page (WebKit's page zoom: everything scales and lays out anew, as a browser's zoom does). The UI keeps
/// the zoom in its settings, and the window opens at it next time.
#[tauri::command]
pub fn set_zoom(window: WebviewWindow, zoom: f64) -> Result<()> {
    if !zoom.is_finite() {
        return Err(k10s_core::Error::other("not a zoom"));
    }
    let zoom = crate::appearance::clamp_zoom(zoom);
    window.set_zoom(zoom).map_err(|err| k10s_core::Error::other(format!("could not zoom the page: {err}")))
}

/// A page of the project: the web view may open these in the browser, not any address.
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ProjectPage {
    Home,
    Issues,
    Releases,
}

/// Opens a page of the project in the browser (the repository its bundle names as its homepage).
#[tauri::command]
pub async fn open_project_page(app: AppHandle, page: ProjectPage) -> Result<()> {
    let home = app.config().bundle.homepage.clone().ok_or_else(|| k10s_core::Error::other("the build names no homepage"))?;
    let url = match page {
        ProjectPage::Home => home,
        ProjectPage::Issues => format!("{home}/issues"),
        ProjectPage::Releases => format!("{home}/releases"),
    };
    open_with_system(&url)
}

/// Opens the log folder in Finder / Explorer / the file manager.
#[tauri::command]
pub async fn open_log_dir(log_dir: State<'_, LogDir>) -> Result<()> {
    let dir = log_dir.0.clone().ok_or_else(|| k10s_core::Error::other("the log folder is unknown"))?;
    open_with_system(&dir.display().to_string())
}

/// Saves text from the web view (logs) to a file the user picks in a native save dialog. The web view only suggests
/// a name: where the file goes is the user's choice, in a dialog nothing in the web view can answer.
#[tauri::command]
pub async fn save_file(window: WebviewWindow, name: String, contents: String) -> Result<Option<String>> {
    use tauri_plugin_dialog::DialogExt;

    let (tx, rx) = tokio::sync::oneshot::channel();
    window.dialog().file().set_file_name(suggested_name(&name)).set_parent(&window).save_file(move |path| {
        let _ = tx.send(path);
    });
    // Cancelled (or the dialog could not be shown: the sender is dropped).
    let Some(path) = rx.await.ok().flatten() else { return Ok(None) };
    let path = path.into_path().map_err(|e| k10s_core::Error::other(format!("not a file path: {e}")))?;
    tokio::fs::write(&path, contents).await.map_err(|e| k10s_core::Error::other(format!("{}: {e}", path.display())))?;
    Ok(Some(path.display().to_string()))
}

/// A file name to suggest: no folders, no control characters, not empty.
fn suggested_name(name: &str) -> String {
    let clean: String = name.chars().map(|c| if matches!(c, '/' | '\\' | ':') || c.is_control() { '-' } else { c }).collect();
    let clean = clean.trim_matches(|c: char| c == '.' || c.is_whitespace());
    if clean.is_empty() { "logs.log".into() } else { clean.chars().take(200).collect() }
}

/// Opens a folder or URL the way the desktop does (Finder / Explorer / the default browser).
pub(crate) fn open_with_system(what: &str) -> Result<()> {
    let opener = if cfg!(target_os = "macos") {
        "open"
    } else if cfg!(windows) {
        "explorer"
    } else {
        "xdg-open"
    };
    std::process::Command::new(opener).arg(what).spawn().map_err(|e| k10s_core::Error::other(format!("{opener} {what}: {e}")))?;
    Ok(())
}

/// Opens a file in the app the desktop opens its kind with. On macOS, a kind no app is set for (`open` fails then) opens
/// in the default text editor.
pub(crate) async fn open_file_with_system(path: &std::path::Path) -> Result<()> {
    if cfg!(target_os = "macos") {
        let opened = tokio::process::Command::new("open").arg(path).status().await.is_ok_and(|s| s.success());
        if opened {
            return Ok(());
        }
        let status = tokio::process::Command::new("open").arg("-t").arg(path).status().await;
        return match status {
            Ok(s) if s.success() => Ok(()),
            Ok(s) => Err(k10s_core::Error::other(format!("could not open {}: open -t exited with {s}", path.display()))),
            Err(e) => Err(k10s_core::Error::other(format!("could not open {}: {e}", path.display()))),
        };
    }
    open_with_system(&path.display().to_string())
}

/// Shows a file in Finder / Explorer, picked; elsewhere, opens its folder in the file manager.
pub(crate) fn reveal_with_system(path: &std::path::Path) -> Result<()> {
    let spawned = if cfg!(target_os = "macos") {
        std::process::Command::new("open").arg("-R").arg(path).spawn()
    } else if cfg!(windows) {
        std::process::Command::new("explorer").arg(format!("/select,{}", path.display())).spawn()
    } else {
        return open_with_system(&path.parent().unwrap_or(path).display().to_string());
    };
    spawned.map_err(|e| k10s_core::Error::other(format!("could not show {}: {e}", path.display())))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn suggested_file_names_stay_in_the_folder_picked() {
        assert_eq!(suggested_name("web-z1-2026-10-04.log"), "web-z1-2026-10-04.log");
        assert_eq!(suggested_name("../../etc/passwd"), "-..-etc-passwd");
        assert_eq!(suggested_name("a\\b:c\nd"), "a-b-c-d");
        assert_eq!(suggested_name(" .. "), "logs.log");
    }

    #[test]
    fn read_only_mode_is_written_off_only_after_a_dialog_one_at_a_time_and_not_again_right_after_a_no() {
        let gate = ConfirmGate::new(DECLINED_COOLDOWN);
        let t0 = Instant::now();
        assert!(matches!(plan_read_only(true, false, &gate, t0), Plan::TurnOn));
        // Off already: nothing is written (a concurrent "turn on" must survive).
        assert!(matches!(plan_read_only(false, false, &gate, t0), Plan::Keep));

        let Plan::Ask(asking) = plan_read_only(false, true, &gate, t0) else { panic!("asks") };
        // A second request while the dialog is open is refused, not stacked.
        assert!(matches!(plan_read_only(false, true, &gate, t0), Plan::Refuse(Skip::AlreadyAsking)));
        // Turning it on stays free meanwhile.
        assert!(matches!(plan_read_only(true, true, &gate, t0), Plan::TurnOn));
        asking.declined(t0);

        // Right after a "no", a script cannot put the dialog back up.
        assert!(matches!(plan_read_only(false, true, &gate, t0 + Duration::from_secs(9)), Plan::Refuse(Skip::JustDeclined)));
        let later = t0 + DECLINED_COOLDOWN;
        let Plan::Ask(asking) = plan_read_only(false, true, &gate, later) else { panic!("asks again later") };
        // Confirmed (dropped without declining): the next request may ask at once.
        drop(asking);
        assert!(matches!(plan_read_only(false, true, &gate, later), Plan::Ask(_)));
    }
}
