mod appearance;
mod commands;
mod diag;
mod logging;
mod prefs;
mod updates;

use std::sync::Arc;

use k10s_core::Engine;
use tauri::webview::PageLoadEvent;
use tauri::{Emitter, Manager, RunEvent, WebviewWindowBuilder, WindowEvent};

use crate::commands::LogDir;
use crate::diag::Diagnostics;
use crate::prefs::Prefs;

/// Event name for engine notifications (cluster connection state changes).
const ENGINE_EVENT: &str = "k10s://engine";
/// Event name for `settings.json` changed outside the app (see `prefs`).
const SETTINGS_EVENT: &str = "k10s://settings";

pub fn run() {
    let context = tauri::generate_context!();
    let log_dir = logging::log_dir(&context.config().identifier);
    let log_file = logging::init(log_dir.as_deref());
    tracing::info!(
        version = env!("CARGO_PKG_VERSION"),
        os = std::env::consts::OS,
        arch = std::env::consts::ARCH,
        pid = std::process::id(),
        log = %log_file.as_deref().map_or_else(|| "stderr only".into(), |p| p.display().to_string()),
        "k10s starting"
    );

    raise_open_file_limit();

    let engine = Engine::new(tauri::async_runtime::handle().inner().clone());
    let prefs = Prefs::load(config_dir(&context.config().identifier).as_deref());
    // Before the UI can ask for them: the read-only switch lives here, not in the web view.
    let saver = prefs.clone();
    engine.use_settings(prefs.engine_settings(), Box::new(move |settings| saver.save_engine_settings(settings)));
    let diag = Diagnostics::new();
    let look = prefs.clone();

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_window_state::Builder::default().build())
        // Native dialogs for Rust only (no permission in the capabilities): see `commands::set_read_only`.
        .plugin(tauri_plugin_dialog::init())
        // Updates, checked and installed from Rust (see `updates`): the web view has no permission for the plugin.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(updates::Pending::default())
        .manage(engine)
        .manage(diag.clone())
        .manage(LogDir(log_dir))
        .manage(prefs)
        .setup(move |app| {
            // The main window is made here, not from the config as it is: in the colour of the UI's theme and at its
            // zoom, so that it does not flash the other theme before the web view paints, nor jump from 100% once the
            // page has loaded. The page itself learns the theme before its first paint (see ui/index.html).
            let mut main = app.config().app.windows.iter().find(|w| w.label == "main").cloned().ok_or("no main window in tauri.conf.json")?;
            if let Some(color) = look.window_color() {
                main.background_color = Some(color);
            }
            let theme = format!("window.__K10S_THEME__ = {};", serde_json::Value::from(look.theme()));
            let window = WebviewWindowBuilder::from_config(app.handle(), &main)?.initialization_script(theme).build()?;
            if let Some(zoom) = look.zoom()
                && let Err(err) = window.set_zoom(zoom)
            {
                tracing::warn!(%err, zoom, "could not zoom the page");
            }
            // settings.json edited outside the app: the engine takes its settings, the UI the rest.
            let handle = app.handle().clone();
            look.on_settings_changed(move |change| {
                handle.state::<Engine>().adopt_settings(change.engine.clone());
                let _ = handle.emit(SETTINGS_EVENT, change);
            });

            let handle = app.handle().clone();
            app.state::<Engine>().on_event(move |event| {
                let _ = handle.emit(ENGINE_EVENT, event);
            });
            diag.spawn_watchdog(app.handle().clone());
            Ok(())
        })
        // Back from an editor, say: settings.json may have changed meanwhile.
        .on_window_event(|window, event| {
            if let WindowEvent::Focused(true) = event {
                window.state::<Arc<Prefs>>().check_settings_file();
            }
        })
        .on_page_load(|webview, payload| match payload.event() {
            // A (re)loaded UI starts with no subscriptions; drop whatever the previous page left behind.
            PageLoadEvent::Started => {
                tracing::info!(url = %payload.url(), "page loading");
                webview.state::<Arc<Diagnostics>>().page_reloaded();
                webview.state::<Engine>().cancel_all();
            }
            PageLoadEvent::Finished => tracing::info!("page loaded"),
        })
        .invoke_handler(tauri::generate_handler![
            commands::app_info,
            commands::list_contexts,
            commands::connect_cluster,
            commands::reconnect_cluster,
            commands::refresh_discovery,
            commands::disconnect_cluster,
            commands::resync,
            commands::subscribe_view,
            commands::stream_logs,
            commands::update_log_targets,
            commands::start_terminal,
            commands::start_debug,
            commands::start_node_shell,
            commands::terminal_input,
            commands::terminal_resize,
            commands::terminal_ack,
            commands::start_forward,
            commands::stop_forward,
            commands::subscribe_forwards,
            commands::open_forward,
            commands::subscribe_relations,
            commands::access_review,
            commands::access_rules,
            commands::subscribe_metrics,
            commands::metrics_history,
            commands::subscribe_helm,
            commands::helm_release,
            commands::helm_diff,
            commands::helm_rollback,
            commands::helm_uninstall,
            commands::unsubscribe,
            commands::get_object,
            commands::get_yaml,
            commands::delete_objects,
            commands::scale,
            commands::restart,
            commands::set_unschedulable,
            commands::set_suspend,
            commands::trigger_cronjob,
            commands::get_settings,
            commands::set_settings,
            commands::set_read_only,
            commands::stats,
            commands::log_frontend,
            commands::ui_heartbeat,
            commands::toggle_devtools,
            commands::set_appearance,
            commands::set_zoom,
            commands::open_log_dir,
            commands::open_project_page,
            commands::save_file,
            updates::check_update,
            updates::download_update,
            updates::install_update,
            updates::open_update_notes,
            prefs::prefs_load,
            prefs::prefs_set,
            prefs::prefs_reset,
            prefs::prefs_open,
        ])
        .build(context)
        .expect("error while building k10s");
    app.run(|app, event| {
        // What changed in the last moment before quitting.
        if let RunEvent::Exit = event {
            app.state::<Arc<Prefs>>().flush();
        }
    });
}

/// The folder Tauri's `app_config_dir()` resolves to (macOS: `~/Library/Application Support/<identifier>`), known
/// before the app is built: where `settings.json` and `state.json` are kept.
fn config_dir(identifier: &str) -> Option<std::path::PathBuf> {
    dirs::config_dir().map(|d| d.join(identifier))
}

/// GUI apps on macOS start with a soft limit of 256 open files, and every watch and log stream holds a
/// socket of its own (kube speaks HTTP/1.1): raise the soft limit like Go and Chromium do.
#[cfg(unix)]
fn raise_open_file_limit() {
    match open_file_limit::raise(open_file_limit::WANTED) {
        Ok((before, after)) if after > before => tracing::info!(before, after, "raised the open file limit"),
        Ok((_, now)) => tracing::info!(limit = now, "open file limit"),
        Err(err) => tracing::warn!(%err, "could not raise the open file limit"),
    }
}

#[cfg(not(unix))]
fn raise_open_file_limit() {}

#[cfg(unix)]
mod open_file_limit {
    /// Enough for hundreds of watches and log streams; also macOS' per-process maximum (`OPEN_MAX`).
    pub const WANTED: libc::rlim_t = 10_240;

    /// Raises the soft `RLIMIT_NOFILE` to `wanted`, or to the hard limit if that is lower. Never lowers
    /// it. Returns the soft limit before and after.
    pub fn raise(wanted: libc::rlim_t) -> std::io::Result<(libc::rlim_t, libc::rlim_t)> {
        let mut lim = libc::rlimit { rlim_cur: 0, rlim_max: 0 };
        // SAFETY: plain syscalls on a valid, exclusively borrowed struct.
        if unsafe { libc::getrlimit(libc::RLIMIT_NOFILE, &mut lim) } != 0 {
            return Err(std::io::Error::last_os_error());
        }
        let before = lim.rlim_cur;
        let target = wanted.min(lim.rlim_max);
        if lim.rlim_cur >= target {
            return Ok((before, before));
        }
        lim.rlim_cur = target;
        // SAFETY: as above.
        if unsafe { libc::setrlimit(libc::RLIMIT_NOFILE, &lim) } != 0 {
            return Err(std::io::Error::last_os_error());
        }
        Ok((before, target))
    }

    #[cfg(test)]
    mod tests {
        #[test]
        fn raises_the_soft_limit_up_to_the_hard_one_and_never_lowers_it() {
            let (_, now) = super::raise(super::WANTED).unwrap();
            let mut lim = libc::rlimit { rlim_cur: 0, rlim_max: 0 };
            assert_eq!(unsafe { libc::getrlimit(libc::RLIMIT_NOFILE, &mut lim) }, 0);
            assert_eq!(lim.rlim_cur, now);
            assert!(now >= super::WANTED.min(lim.rlim_max));
            // Asking for less keeps what there is.
            assert_eq!(super::raise(64).unwrap(), (now, now));
        }
    }
}
