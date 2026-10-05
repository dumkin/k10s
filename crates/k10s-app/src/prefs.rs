//! What k10s keeps between starts: two JSON files in its config folder (macOS: `~/Library/Application
//! Support/<identifier>`, Linux: `~/.config/<identifier>`, Windows: `%APPDATA%\<identifier>`). Logs are kept apart
//! (see `logging`).
//!
//! - `settings.json` holds what the user set: the engine's settings (read-only mode…) and the UI's (the theme, the
//!   zoom, the log viewer's defaults…). It is made to be read and edited by hand: an edit made elsewhere is taken
//!   when the window gets the focus back. A file that can't be read stays as it is, for the user to fix, and k10s
//!   runs on the defaults meanwhile — in read-only mode, as the switch it may hold must not fall back to read-write.
//! - `state.json` holds what k10s remembers by itself: the clusters and namespaces picked, recent ones, column
//!   widths…
//!
//! The web view gets both at start (`prefs_load`) and sends what it changes (`prefs_set`). A file is written a moment
//! after a change, with whatever else changed meanwhile, and when the app quits. The engine's settings can't be
//! written that way: they change through the engine, read-only mode only after a native confirmation
//! (`commands::set_read_only`).

use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use k10s_core::{Error, Result, Settings};
use parking_lot::{Condvar, Mutex};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use tauri::State;
use tauri::window::Color;

use crate::appearance;

/// One of the two files.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Doc {
    Settings,
    State,
}

/// The engine's settings in `settings.json` (see `Settings`): the web view can't write them.
const ENGINE_KEYS: [&str; 2] = ["readOnly", "feedIdleTtlSecs"];

/// How long after a change its file is written: what changes meanwhile goes in the same write.
const WRITE_DELAY: Duration = Duration::from_millis(500);

/// A value the web view keeps at `key` in a file (see `Prefs::set`).
#[derive(Debug, Deserialize)]
pub struct Change {
    doc: Doc,
    key: String,
    value: Value,
}

/// What `settings.json` holds after an edit made outside the app.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsChange {
    pub settings: Map<String, Value>,
    /// Why it can't be read: the UI keeps what it has, and the engine goes read-only.
    pub error: Option<String>,
    /// The engine's settings it holds.
    pub engine: Settings,
}

/// Both files, as the web view gets them at start.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    settings: Map<String, Value>,
    state: Map<String, Value>,
    /// Why `settings.json` can't be read.
    settings_error: Option<String>,
    settings_path: Option<String>,
    state_path: Option<String>,
}

type Listener = Arc<dyn Fn(&SettingsChange) + Send + Sync>;

pub struct Prefs {
    settings: Mutex<File>,
    state: Mutex<File>,
    /// A file has changes to write: the writer waits for this.
    pending: Mutex<bool>,
    wake: Condvar,
    on_change: Mutex<Option<Listener>>,
}

/// A file and what it holds.
struct File {
    path: Option<PathBuf>,
    data: Map<String, Value>,
    /// The file's content when it was last read or written: anything else found there was written by someone else.
    seen: Option<Vec<u8>>,
    /// Why the file can't be read. It is not written over meanwhile: an edit that went wrong stays, to be fixed.
    error: Option<String>,
    /// Changed since it was last written.
    dirty: bool,
}

impl File {
    fn open(path: Option<PathBuf>) -> File {
        let mut file = File { path, data: Map::new(), seen: None, error: None, dirty: false };
        file.reread();
        file
    }

    /// Reads the file again when it changed since it was last read or written, and returns whether it did. What it
    /// holds then replaces what is here, changes not written yet included; a file that can't be read leaves it.
    fn reread(&mut self) -> bool {
        let Some(path) = &self.path else { return false };
        let (seen, read) = match std::fs::read(path) {
            Ok(bytes) => {
                let read = parse(&bytes);
                (Some(bytes), read)
            }
            // None (any more): the defaults.
            Err(e) if e.kind() == ErrorKind::NotFound => (None, Ok(Map::new())),
            Err(e) => (None, Err(e.to_string())),
        };
        let error = read.as_ref().err().cloned();
        if seen == self.seen && error == self.error {
            return false;
        }
        self.seen = seen;
        self.error = error;
        if let Ok(data) = read {
            self.data = data;
            self.dirty = false;
        }
        true
    }

    /// Writes what changed: whole or not at all (a temporary file renamed over it).
    fn write(&mut self) -> std::io::Result<()> {
        if !self.dirty {
            return Ok(());
        }
        let Some(path) = &self.path else {
            self.dirty = false;
            return Ok(());
        };
        if let Some(error) = &self.error {
            return Err(std::io::Error::other(format!("{} is not written over while it can't be read ({error})", path.display())));
        }
        let mut bytes = serde_json::to_vec_pretty(&self.data)?;
        bytes.push(b'\n');
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, &bytes)?;
        std::fs::rename(&tmp, path)?;
        self.seen = Some(bytes);
        self.dirty = false;
        Ok(())
    }

    fn path_text(&self) -> Option<String> {
        self.path.as_ref().map(|p| p.display().to_string())
    }
}

/// A file's JSON: an object. Empty is fine (`{}`), so is a file just made in an editor.
fn parse(bytes: &[u8]) -> std::result::Result<Map<String, Value>, String> {
    if bytes.trim_ascii().is_empty() {
        return Ok(Map::new());
    }
    match serde_json::from_slice::<Value>(bytes) {
        Ok(Value::Object(data)) => Ok(data),
        Ok(_) => Err("this is not a JSON object ({ … })".into()),
        Err(e) => Err(e.to_string()),
    }
}

/// The engine's settings as `settings.json` has them: the defaults for what it lacks, and read-only mode when the file
/// can't be read or holds something else than a setting where one goes.
fn engine_settings(file: &File) -> Settings {
    if file.error.is_some() {
        return Settings { read_only: true, ..Settings::default() };
    }
    let own: Map<String, Value> = ENGINE_KEYS.iter().filter_map(|&k| file.data.get(k).map(|v| (k.to_string(), v.clone()))).collect();
    serde_json::from_value(Value::Object(own)).unwrap_or_else(|e| {
        tracing::warn!(error = %e, "the engine's settings in settings.json are not valid: read-only mode");
        Settings { read_only: true, ..Settings::default() }
    })
}

fn change_of(file: &File) -> SettingsChange {
    SettingsChange { settings: file.data.clone(), error: file.error.clone(), engine: engine_settings(file) }
}

/// A key as the web view names it, `logs.tail`: the path to it in the file.
fn key_path(key: &str) -> std::result::Result<Vec<&str>, String> {
    let path: Vec<&str> = key.split('.').collect();
    if key.len() > 200 || path.iter().any(|p| p.is_empty()) {
        return Err(format!("not a key: {key:?}"));
    }
    Ok(path)
}

/// Puts `value` at `path` (`null` removes what is there, and the objects that were only there for it). Returns
/// whether anything changed.
fn set_path(data: &mut Map<String, Value>, path: &[&str], value: Value) -> bool {
    let Some((&key, rest)) = path.split_first() else { return false };
    if rest.is_empty() {
        return if value.is_null() {
            data.remove(key).is_some()
        } else if data.get(key) == Some(&value) {
            false
        } else {
            data.insert(key.to_string(), value);
            true
        };
    }
    if value.is_null() {
        let Some(Value::Object(inner)) = data.get_mut(key) else { return false };
        let changed = set_path(inner, rest, value);
        if inner.is_empty() {
            data.remove(key);
        }
        return changed;
    }
    let inner = data.entry(key).or_insert_with(|| Value::Object(Map::new()));
    if !inner.is_object() {
        *inner = Value::Object(Map::new());
    }
    set_path(inner.as_object_mut().expect("an object"), rest, value)
}

impl Prefs {
    /// Reads both files from `dir`; `None`: there's nowhere to keep them, and the app runs on the defaults.
    pub fn load(dir: Option<&Path>) -> Arc<Prefs> {
        let open = |name: &str| File::open(dir.map(|d| d.join(name)));
        let settings = open("settings.json");
        let mut state = open("state.json");
        match (&settings.path, &settings.error) {
            (Some(path), Some(error)) => {
                tracing::warn!(path = %path.display(), %error, "the settings can't be read: running on the defaults, in read-only mode, until the file is fixed")
            }
            (Some(path), None) => tracing::info!(path = %path.display(), "settings loaded"),
            (None, _) => tracing::warn!("no config folder: settings and state are not saved"),
        }
        // Not meant for editing: what can't be read is forgotten, and written over.
        if let Some(error) = state.error.take() {
            tracing::warn!(%error, "the remembered state can't be read: starting afresh");
        }
        let prefs = Arc::new(Prefs {
            settings: Mutex::new(settings),
            state: Mutex::new(state),
            pending: Mutex::new(false),
            wake: Condvar::new(),
            on_change: Mutex::new(None),
        });
        Prefs::spawn_writer(&prefs);
        prefs
    }

    fn file(&self, doc: Doc) -> &Mutex<File> {
        match doc {
            Doc::Settings => &self.settings,
            Doc::State => &self.state,
        }
    }

    /// Writes files a moment after they change, on a thread of its own (the files are small; the main thread must
    /// never wait for a disk).
    fn spawn_writer(prefs: &Arc<Prefs>) {
        let weak = Arc::downgrade(prefs);
        let spawned = std::thread::Builder::new().name("k10s-prefs".into()).spawn(move || {
            while let Some(prefs) = weak.upgrade() {
                let due = {
                    let mut pending = prefs.pending.lock();
                    if !*pending {
                        // Woken by a change, and now and then to see whether the app is still there.
                        prefs.wake.wait_for(&mut pending, Duration::from_secs(10));
                    }
                    std::mem::take(&mut *pending)
                };
                if due {
                    std::thread::sleep(WRITE_DELAY);
                    prefs.flush();
                }
            }
        });
        if let Err(e) = spawned {
            tracing::warn!(error = %e, "no thread to save settings with: they are saved when the app quits");
        }
    }

    fn schedule(&self) {
        *self.pending.lock() = true;
        self.wake.notify_one();
    }

    /// Writes what changed, now.
    pub fn flush(&self) {
        for doc in [Doc::Settings, Doc::State] {
            let changed = {
                let mut file = self.file(doc).lock();
                // An edit made outside the app meanwhile wins over what was not written yet.
                let changed = doc == Doc::Settings && file.dirty && file.reread();
                if let Err(e) = file.write() {
                    tracing::warn!(error = %e, "could not save {doc:?}");
                }
                changed.then(|| change_of(&file))
            };
            if let Some(change) = changed {
                self.notify(&change);
            }
        }
    }

    /// Takes an edit made to `settings.json` outside the app, if there is one.
    pub fn check_settings_file(&self) {
        let change = {
            let mut file = self.settings.lock();
            file.reread().then(|| change_of(&file))
        };
        if let Some(change) = change {
            self.notify(&change);
        }
    }

    /// Called when `settings.json` changed outside the app (see `check_settings_file`).
    pub fn on_settings_changed(&self, f: impl Fn(&SettingsChange) + Send + Sync + 'static) {
        *self.on_change.lock() = Some(Arc::new(f));
    }

    fn notify(&self, change: &SettingsChange) {
        match &change.error {
            Some(error) => tracing::warn!(%error, "settings.json was changed outside the app and can't be read: read-only mode until it is fixed"),
            None => tracing::info!(read_only = change.engine.read_only, "settings.json was changed outside the app"),
        }
        let listener = self.on_change.lock().clone();
        if let Some(listener) = listener {
            listener(change);
        }
    }

    pub fn snapshot(&self) -> Snapshot {
        let settings = self.settings.lock();
        let state = self.state.lock();
        Snapshot {
            settings: settings.data.clone(),
            state: state.data.clone(),
            settings_error: settings.error.clone(),
            settings_path: settings.path_text(),
            state_path: state.path_text(),
        }
    }

    /// A change the web view made: `key` is a path in the file (`logs.tail`), and `null` removes what is there. Not
    /// the engine's settings: those change through the engine.
    pub fn set(&self, doc: Doc, key: &str, value: Value) -> std::result::Result<(), String> {
        let path = key_path(key)?;
        if doc == Doc::Settings && ENGINE_KEYS.contains(&path[0]) {
            return Err(format!("{key} is the engine's setting: it changes through the engine"));
        }
        let mut file = self.file(doc).lock();
        if set_path(&mut file.data, &path, value) {
            file.dirty = true;
            drop(file);
            self.schedule();
        }
        Ok(())
    }

    /// Changes the web view made, in the order it made them (it sends one batch at a time: commands run side by side).
    /// One that is refused doesn't stop the others.
    pub fn set_all(&self, changes: Vec<Change>) -> std::result::Result<(), String> {
        let refused: Vec<String> = changes.into_iter().filter_map(|c| self.set(c.doc, &c.key, c.value).err()).collect();
        if refused.is_empty() { Ok(()) } else { Err(refused.join("; ")) }
    }

    pub fn engine_settings(&self) -> Settings {
        engine_settings(&self.settings.lock())
    }

    /// Puts the engine's settings in `settings.json` and writes it at once: read-only mode must not be lost to a
    /// crash.
    pub fn save_engine_settings(&self, settings: &Settings) -> std::io::Result<()> {
        let mut file = self.settings.lock();
        if let Value::Object(own) = serde_json::to_value(settings)? {
            for (key, value) in own {
                if file.data.get(&key) != Some(&value) {
                    file.data.insert(key, value);
                    file.dirty = true;
                }
            }
        }
        file.write()
    }

    /// Forgets what the UI kept: all of `state.json`, and of `settings.json` all but the engine's settings (read-only
    /// mode stays as it is). A `settings.json` that can't be read is left alone.
    pub fn reset(&self) {
        {
            let mut file = self.settings.lock();
            if file.error.is_none() {
                file.data.retain(|k, _| ENGINE_KEYS.contains(&k.as_str()));
                file.dirty = true;
            }
        }
        {
            let mut file = self.state.lock();
            file.data.clear();
            file.dirty = true;
        }
        self.flush();
    }

    /// The theme the settings ask for: `dark`, `light` or `system`.
    pub fn theme(&self) -> &'static str {
        match self.settings.lock().data.get("theme").and_then(Value::as_str) {
            Some("light") => "light",
            Some("system") => "system",
            _ => "dark",
        }
    }

    /// The theme the UI shows now (`dark` or `light`): with `system`, the window opens in its colour next time.
    pub fn remember_shown_theme(&self, theme: &str) {
        let _ = self.set(Doc::State, "shownTheme", Value::String(theme.to_string()));
    }

    /// The colour the window opens in: the theme's, or with `system` the one the UI showed last.
    pub fn window_color(&self) -> Option<Color> {
        match self.theme() {
            "system" => self.state.lock().data.get("shownTheme").and_then(Value::as_str).and_then(appearance::color),
            theme => appearance::color(theme),
        }
    }

    /// The zoom the page opens at (none at 100%).
    pub fn zoom(&self) -> Option<f64> {
        self.settings.lock().data.get("zoom").and_then(Value::as_f64).and_then(appearance::zoom_to_apply)
    }

    /// Where a file is, written out first if it isn't there yet (to open it in an editor).
    fn path_to_open(&self, doc: Doc) -> Result<PathBuf> {
        let mut file = self.file(doc).lock();
        let path = file.path.clone().ok_or_else(|| Error::other("there is no config folder to keep files in"))?;
        if !path.exists() && file.error.is_none() {
            file.dirty = true;
            file.write().map_err(|e| Error::other(format!("{}: {e}", path.display())))?;
        }
        Ok(path)
    }
}

#[tauri::command]
pub async fn prefs_load(prefs: State<'_, Arc<Prefs>>) -> Result<Snapshot> {
    Ok(prefs.snapshot())
}

#[tauri::command]
pub async fn prefs_set(prefs: State<'_, Arc<Prefs>>, changes: Vec<Change>) -> Result<()> {
    prefs.set_all(changes).map_err(Error::other)
}

/// Forgets what the UI kept (see `Prefs::reset`): "Reset preferences" when the app could not start.
#[tauri::command]
pub async fn prefs_reset(prefs: State<'_, Arc<Prefs>>) -> Result<()> {
    prefs.reset();
    Ok(())
}

/// Opens a file in the app the desktop opens it with (an editor), or shows it in Finder / Explorer / the file manager.
#[tauri::command]
pub async fn prefs_open(prefs: State<'_, Arc<Prefs>>, doc: Doc, reveal: bool) -> Result<()> {
    let path = prefs.path_to_open(doc)?;
    if reveal { crate::commands::reveal_with_system(&path) } else { crate::commands::open_file_with_system(&path).await }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Dir(PathBuf);

    impl Dir {
        fn new(name: &str) -> Dir {
            let dir = std::env::temp_dir().join(format!("k10s-prefs-{name}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            Dir(dir)
        }

        fn file(&self, name: &str) -> PathBuf {
            self.0.join(name)
        }

        fn read(&self, name: &str) -> Value {
            serde_json::from_slice(&std::fs::read(self.file(name)).unwrap()).unwrap()
        }
    }

    impl Drop for Dir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn changes(prefs: &Prefs) -> Arc<Mutex<Vec<SettingsChange>>> {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let into = seen.clone();
        prefs.on_settings_changed(move |c| into.lock().push(c.clone()));
        seen
    }

    #[test]
    fn keeps_what_the_ui_sets_in_two_files_nested_by_key() {
        let dir = Dir::new("set");
        let prefs = Prefs::load(Some(&dir.0));
        // Nothing yet: the defaults, read-write.
        assert_eq!(prefs.engine_settings(), Settings::default());
        prefs.set(Doc::Settings, "logs.tail", 500.into()).unwrap();
        prefs.set(Doc::Settings, "theme", "light".into()).unwrap();
        prefs.set(Doc::State, "clusters", serde_json::json!(["kind-a"])).unwrap();
        prefs.flush();
        assert_eq!(dir.read("settings.json"), serde_json::json!({ "logs": { "tail": 500 }, "theme": "light" }));
        assert_eq!(dir.read("state.json"), serde_json::json!({ "clusters": ["kind-a"] }));
        // `null` removes, along with what was only there for it.
        prefs.set(Doc::Settings, "logs.tail", Value::Null).unwrap();
        prefs.flush();
        assert_eq!(dir.read("settings.json"), serde_json::json!({ "theme": "light" }));
        // The next start reads them.
        let again = Prefs::load(Some(&dir.0));
        assert_eq!(again.snapshot().state["clusters"], serde_json::json!(["kind-a"]));
        assert_eq!((again.theme(), again.window_color()), ("light", Some(appearance::LIGHT)));
        assert!(prefs.set(Doc::Settings, "logs..tail", 1.into()).is_err());
    }

    #[test]
    fn takes_a_batch_in_its_order_and_keeps_what_it_can() {
        let dir = Dir::new("batch");
        let prefs = Prefs::load(Some(&dir.0));
        let changes: Vec<Change> = serde_json::from_value(serde_json::json!([
            { "doc": "state", "key": "sidebarWidth", "value": 240 },
            { "doc": "settings", "key": "readOnly", "value": false },
            { "doc": "state", "key": "sidebarWidth", "value": 260 },
            { "doc": "settings", "key": "logs.wrap", "value": true },
        ]))
        .unwrap();
        let refused = prefs.set_all(changes).unwrap_err();
        assert!(refused.contains("readOnly"), "{refused}");
        prefs.flush();
        assert_eq!(dir.read("state.json"), serde_json::json!({ "sidebarWidth": 260 }));
        assert_eq!(dir.read("settings.json"), serde_json::json!({ "logs": { "wrap": true } }));
    }

    #[test]
    fn the_engine_settings_change_only_through_the_engine_and_are_written_at_once() {
        let dir = Dir::new("engine");
        let prefs = Prefs::load(Some(&dir.0));
        assert!(prefs.set(Doc::Settings, "readOnly", false.into()).is_err());
        assert!(prefs.set(Doc::Settings, "feedIdleTtlSecs.x", 1.into()).is_err());
        prefs.save_engine_settings(&Settings { read_only: true, feed_idle_ttl_secs: 60 }).unwrap();
        // No flush: already on disk.
        assert_eq!(dir.read("settings.json"), serde_json::json!({ "readOnly": true, "feedIdleTtlSecs": 60 }));
        assert_eq!(Prefs::load(Some(&dir.0)).engine_settings(), Settings { read_only: true, feed_idle_ttl_secs: 60 });
        // Something else where a setting goes: read-only mode.
        std::fs::write(dir.file("settings.json"), r#"{ "readOnly": "no" }"#).unwrap();
        assert!(Prefs::load(Some(&dir.0)).engine_settings().read_only);
        // Keys it doesn't know (a newer version's) are kept.
        std::fs::write(dir.file("settings.json"), r#"{ "readOnly": false, "somethingNew": 1 }"#).unwrap();
        let prefs = Prefs::load(Some(&dir.0));
        prefs.set(Doc::Settings, "theme", "light".into()).unwrap();
        prefs.flush();
        assert_eq!(dir.read("settings.json")["somethingNew"], 1);
    }

    #[test]
    fn a_settings_file_that_cant_be_read_starts_read_only_and_is_not_written_over() {
        let dir = Dir::new("broken");
        let broken = "{ \"theme\": \"light\", \"readOnly\": fals }";
        std::fs::write(dir.file("settings.json"), broken).unwrap();
        let prefs = Prefs::load(Some(&dir.0));
        assert!(prefs.engine_settings().read_only);
        assert!(prefs.snapshot().settings_error.unwrap().contains("line 1"));
        prefs.set(Doc::Settings, "zoom", 1.25.into()).unwrap();
        assert!(prefs.save_engine_settings(&Settings::default()).is_err());
        prefs.reset();
        prefs.flush();
        assert_eq!(std::fs::read_to_string(dir.file("settings.json")).unwrap(), broken);
        // Fixed: taken, and said so.
        let seen = changes(&prefs);
        std::fs::write(dir.file("settings.json"), r#"{ "theme": "light", "readOnly": false }"#).unwrap();
        prefs.check_settings_file();
        let change = seen.lock().pop().expect("a change");
        assert_eq!((change.error, change.engine.read_only, change.settings["theme"].as_str()), (None, false, Some("light")));
        // A state file that can't be read is not for the user to fix: started afresh, and written over.
        std::fs::write(dir.file("state.json"), "[").unwrap();
        let prefs = Prefs::load(Some(&dir.0));
        prefs.set(Doc::State, "resource", "pods".into()).unwrap();
        prefs.flush();
        assert_eq!(dir.read("state.json"), serde_json::json!({ "resource": "pods" }));
    }

    #[test]
    fn takes_an_edit_made_elsewhere_but_not_its_own_writes() {
        let dir = Dir::new("edited");
        let prefs = Prefs::load(Some(&dir.0));
        let seen = changes(&prefs);
        prefs.set(Doc::Settings, "theme", "light".into()).unwrap();
        prefs.flush();
        prefs.check_settings_file();
        assert!(seen.lock().is_empty());

        std::fs::write(dir.file("settings.json"), r#"{ "theme": "dark", "readOnly": true }"#).unwrap();
        prefs.check_settings_file();
        prefs.check_settings_file();
        assert_eq!(seen.lock().len(), 1);
        assert_eq!(prefs.theme(), "dark");
        assert!(seen.lock()[0].engine.read_only);

        // Broken by an edit: said so, read-only; what the UI had stays.
        std::fs::write(dir.file("settings.json"), "{").unwrap();
        prefs.check_settings_file();
        let change = seen.lock().pop().unwrap();
        assert!(change.error.is_some() && change.engine.read_only);
        assert_eq!(prefs.theme(), "dark");

        // An edit made while a change waits to be written wins over it.
        std::fs::write(dir.file("settings.json"), r#"{ "zoom": 1.5 }"#).unwrap();
        prefs.check_settings_file();
        prefs.set(Doc::Settings, "theme", "light".into()).unwrap();
        std::fs::write(dir.file("settings.json"), r#"{ "zoom": 2 }"#).unwrap();
        prefs.flush();
        assert_eq!(dir.read("settings.json"), serde_json::json!({ "zoom": 2 }));
        assert_eq!(prefs.zoom(), Some(2.0));
        assert_eq!(seen.lock().last().unwrap().settings["zoom"], 2);

        // Deleted: the defaults.
        std::fs::remove_file(dir.file("settings.json")).unwrap();
        prefs.check_settings_file();
        assert_eq!((prefs.theme(), prefs.zoom()), ("dark", None));
    }

    #[test]
    fn a_reset_forgets_what_the_ui_kept_but_not_read_only_mode() {
        let dir = Dir::new("reset");
        let prefs = Prefs::load(Some(&dir.0));
        prefs.save_engine_settings(&Settings { read_only: true, ..Settings::default() }).unwrap();
        prefs.set(Doc::Settings, "theme", "light".into()).unwrap();
        prefs.set(Doc::State, "clusters", serde_json::json!(["kind-a"])).unwrap();
        prefs.reset();
        assert_eq!(dir.read("settings.json"), serde_json::json!({ "readOnly": true, "feedIdleTtlSecs": 180 }));
        assert_eq!(dir.read("state.json"), serde_json::json!({}));
    }

    #[test]
    fn the_window_opens_in_the_theme_and_zoom_the_ui_had() {
        let dir = Dir::new("look");
        let prefs = Prefs::load(Some(&dir.0));
        assert_eq!((prefs.theme(), prefs.window_color(), prefs.zoom()), ("dark", Some(appearance::DARK), None));
        // With the system's theme: the one shown last.
        prefs.set(Doc::Settings, "theme", "system".into()).unwrap();
        assert_eq!(prefs.window_color(), None);
        prefs.remember_shown_theme("light");
        assert_eq!(prefs.window_color(), Some(appearance::LIGHT));
        prefs.set(Doc::Settings, "zoom", 1.25.into()).unwrap();
        assert_eq!(prefs.zoom(), Some(1.25));
        prefs.set(Doc::Settings, "zoom", 1.into()).unwrap();
        assert_eq!(prefs.zoom(), None);
        // Nowhere to keep them: the defaults, and no error.
        let nowhere = Prefs::load(None);
        nowhere.set(Doc::Settings, "theme", "light".into()).unwrap();
        nowhere.flush();
        assert_eq!(nowhere.theme(), "light");
    }

    #[test]
    fn writes_by_itself_a_moment_after_a_change() {
        let dir = Dir::new("later");
        let prefs = Prefs::load(Some(&dir.0));
        prefs.set(Doc::State, "resource", "nodes".into()).unwrap();
        assert!(!dir.file("state.json").exists());
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while !dir.file("state.json").exists() {
            assert!(std::time::Instant::now() < deadline, "not written");
            std::thread::sleep(Duration::from_millis(20));
        }
        assert_eq!(dir.read("state.json"), serde_json::json!({ "resource": "nodes" }));
    }
}
