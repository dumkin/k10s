//! Updates from GitHub Releases through the updater plugin, driven from here: the web view has no permission for
//! the plugin and asks these commands instead.
//!
//! Only builds made by the release workflow update themselves: it puts the address of the release feed and the
//! public key the packages are signed with into `plugins.updater`. Any other build (`make build`, a package built
//! by a distribution) says so in `app_info`, and the UI offers nothing.

use std::sync::Arc;
use std::time::Duration;

use k10s_core::{Error, Result};
use parking_lot::Mutex;
use serde::Serialize;
use tauri::{AppHandle, Manager, State, Url};
use tauri_plugin_updater::{Update, UpdaterExt};

/// How long asking the release feed may take.
const CHECK_TIMEOUT: Duration = Duration::from_secs(30);
/// How long downloading a package may take (they weigh 10–30 MB).
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(15 * 60);

/// The release the last check found, and its package once downloaded and verified.
#[derive(Default)]
pub struct Pending(Mutex<Option<Found>>);

#[derive(Clone)]
struct Found {
    update: Update,
    package: Option<Arc<Vec<u8>>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    version: String,
    current: String,
    /// When the release was published (Unix seconds).
    date: Option<i64>,
    notes: Option<String>,
    /// The release's page, when it comes from GitHub.
    page: Option<String>,
    /// Downloaded and its signature verified: installing it takes a restart.
    ready: bool,
}

impl UpdateInfo {
    fn of(found: &Found) -> Self {
        UpdateInfo {
            version: found.update.version.clone(),
            current: found.update.current_version.clone(),
            date: found.update.date.map(|d| d.unix_timestamp()),
            notes: found.update.body.clone().filter(|b| !b.trim().is_empty()),
            page: release_page(&found.update.download_url),
            ready: found.package.is_some(),
        }
    }
}

/// Whether this build can update itself: the release workflow gave it the feed to check and the key to verify with.
pub fn enabled(app: &AppHandle) -> bool {
    let config = app.config().plugins.0.get("updater");
    let endpoints = config.and_then(|c| c.get("endpoints")).and_then(|e| e.as_array()).is_some_and(|e| !e.is_empty());
    let pubkey = config.and_then(|c| c.get("pubkey")).and_then(|k| k.as_str()).is_some_and(|k| !k.trim().is_empty());
    endpoints && pubkey
}

/// The page of the GitHub release a package belongs to: `…/releases/download/<tag>/<file>` → `…/releases/tag/<tag>`.
fn release_page(package: &Url) -> Option<String> {
    if package.scheme() != "https" || package.host_str() != Some("github.com") {
        return None;
    }
    match package.path_segments()?.collect::<Vec<_>>().as_slice() {
        [owner, repo, "releases", "download", tag, _] => Some(format!("https://github.com/{owner}/{repo}/releases/tag/{tag}")),
        _ => None,
    }
}

fn failed(e: tauri_plugin_updater::Error) -> Error {
    Error::other(e.to_string())
}

/// Asks the release feed whether there is a newer release. A release found before keeps its downloaded package.
#[tauri::command]
pub async fn check_update(app: AppHandle, pending: State<'_, Pending>) -> Result<Option<UpdateInfo>> {
    if !enabled(&app) {
        return Err(Error::other("this build of k10s does not update itself"));
    }
    let updater = app.updater_builder().timeout(DOWNLOAD_TIMEOUT).build().map_err(failed)?;
    let update = match tokio::time::timeout(CHECK_TIMEOUT, updater.check()).await {
        Ok(update) => update.map_err(failed)?,
        Err(_) => return Err(Error::other("the release feed did not answer within 30s")),
    };
    let mut slot = pending.0.lock();
    let Some(update) = update else {
        *slot = None;
        return Ok(None);
    };
    let package = slot.take().filter(|f| f.update.version == update.version).and_then(|f| f.package);
    if package.is_none() {
        tracing::info!(current = %update.current_version, available = %update.version, "update available");
    }
    let found = Found { update, package };
    let info = UpdateInfo::of(&found);
    *slot = Some(found);
    Ok(Some(info))
}

/// Downloads the release the last check found and verifies its signature against the key built into this build.
#[tauri::command]
pub async fn download_update(pending: State<'_, Pending>) -> Result<UpdateInfo> {
    let found = pending.0.lock().clone().ok_or_else(|| Error::other("there is no update to download: check for updates first"))?;
    if found.package.is_some() {
        return Ok(UpdateInfo::of(&found));
    }
    let package = found.update.download(|_, _| {}, || {}).await.map_err(|e| {
        tracing::warn!(version = %found.update.version, err = %e, "update download failed");
        failed(e)
    })?;
    tracing::info!(version = %found.update.version, bytes = package.len(), "update downloaded and verified");
    let mut slot = pending.0.lock();
    match slot.as_mut() {
        Some(f) if f.update.version == found.update.version => {
            f.package = Some(Arc::new(package));
            Ok(UpdateInfo::of(f))
        }
        // A check found another release while this one downloaded.
        _ => Err(Error::other("another release came out meanwhile: check for updates again")),
    }
}

/// Installs the downloaded release and restarts into it. On Windows the installer takes over and closes the app.
#[tauri::command]
pub async fn install_update(app: AppHandle, pending: State<'_, Pending>) -> Result<()> {
    let found = pending.0.lock().clone().ok_or_else(|| Error::other("there is no update to install"))?;
    let package = found.package.clone().ok_or_else(|| Error::other("the update has not been downloaded yet"))?;
    if let Some(why) = std::env::current_exe().ok().and_then(|exe| unreplaceable(&exe.to_string_lossy())) {
        return Err(Error::other(why));
    }
    tracing::info!(from = %found.update.current_version, to = %found.update.version, "installing update");
    let update = found.update;
    tauri::async_runtime::spawn_blocking(move || update.install(package.as_slice()))
        .await
        .map_err(|e| Error::other(format!("the installation stopped: {e}")))?
        .map_err(|e| {
            tracing::warn!(err = %e, "update installation failed");
            failed(e)
        })?;
    // Not left to the exit: a restart from the main thread goes without one.
    app.state::<std::sync::Arc<crate::prefs::Prefs>>().flush();
    app.restart()
}

/// Why a copy of the app running from `exe` can't replace itself, if it can't: macOS runs apps opened straight from a
/// disk image, or from a quarantined download folder ("App Translocation"), from a read-only place.
fn unreplaceable(exe: &str) -> Option<&'static str> {
    if !cfg!(target_os = "macos") {
        return None;
    }
    if exe.contains("/AppTranslocation/") {
        Some("macOS runs this copy of k10s from a read-only place, so it can't update itself: move k10s to Applications, open it from there and update again")
    } else if exe.starts_with("/Volumes/") {
        Some("k10s runs from its disk image, so it can't update itself: drag it to Applications, open it from there and update again")
    } else {
        None
    }
}

/// Opens the page of the release found in the browser (only that page: the web view can't name another URL).
#[tauri::command]
pub async fn open_update_notes(pending: State<'_, Pending>) -> Result<()> {
    let page = pending.0.lock().as_ref().and_then(|f| release_page(&f.update.download_url));
    crate::commands::open_with_system(&page.ok_or_else(|| Error::other("this release has no page to open"))?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_package_on_github_leads_to_its_release_page_and_nothing_else_does() {
        let page = |url: &str| release_page(&Url::parse(url).unwrap());
        assert_eq!(
            page("https://github.com/acme/k10s/releases/download/v0.2.0/k10s.app.tar.gz").as_deref(),
            Some("https://github.com/acme/k10s/releases/tag/v0.2.0")
        );
        assert_eq!(page("https://example.com/acme/k10s/releases/download/v0.2.0/k10s.app.tar.gz"), None);
        assert_eq!(page("http://github.com/acme/k10s/releases/download/v0.2.0/k10s.app.tar.gz"), None);
        assert_eq!(page("https://github.com/acme/k10s/archive/v0.2.0.tar.gz"), None);
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn a_copy_on_a_disk_image_or_translocated_says_it_cant_update_itself() {
        assert!(unreplaceable("/Volumes/k10s/k10s.app/Contents/MacOS/k10s").is_some());
        assert!(unreplaceable("/private/var/folders/x/T/AppTranslocation/1234/d/k10s.app/Contents/MacOS/k10s").is_some());
        assert!(unreplaceable("/Applications/k10s.app/Contents/MacOS/k10s").is_none());
    }
}
