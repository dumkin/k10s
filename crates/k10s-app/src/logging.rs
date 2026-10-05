//! Logging: a size-rotated file in the platform log folder (macOS: `~/Library/Logs/io.dumkin.k10s/`)
//! plus stderr for `tauri dev`. Writes are synchronous, so the lines written right before a crash or
//! a hang are on disk.
//!
//! `K10S_LOG` (tracing filter syntax, e.g. `debug,kube=info`) overrides both destinations.

use std::borrow::Cow;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use parking_lot::Mutex;
use tracing_subscriber::fmt::MakeWriter;
use tracing_subscriber::fmt::format::Writer;
use tracing_subscriber::fmt::time::FormatTime;
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;
use tracing_subscriber::{EnvFilter, Layer};

const FILE_NAME: &str = "k10s.log";
/// The current file is rotated at this size into `k10s.1.log` (newest) … `k10s.{KEEP}.log`.
const MAX_BYTES: u64 = 10 * 1024 * 1024;
const KEEP: usize = 5;

/// The terminal stays quiet: watch errors are shown in the UI.
const TERMINAL_FILTER: &str = "info,kube=warn,kube_runtime=error,tower=warn,hyper=warn";
/// The file is detailed for our own code (engine, IPC, UI reports) and quiet for libraries.
const FILE_FILTER: &str = "info,k10s=debug,k10s_lib=debug,k10s_core=debug,kube=warn,kube_runtime=error,tower=warn,hyper=warn,hyper_util=warn,rustls=warn";
/// kube-client logs a whole response body at warn when it cannot decode it (`client/mod.rs`): an object —
/// a Secret, say — would land in the log. The error itself reaches the engine, which reports it (sanitized),
/// so that module only gets to log errors; its TLS warnings (verification bypassed, a CA bundle that could
/// not be reloaded) carry no bodies and stay. Added to `K10S_LOG` too, unless it names `kube_client` itself.
const NO_RESPONSE_BODIES: &str = "kube_client::client=error,kube_client::client::tls=warn";
/// The journal of mutations (`k10s::audit`, see `k10s_core::ops`) is always written, whatever `K10S_LOG`
/// says — unless it names that target itself.
const AUDIT: &str = "k10s::audit=info";

/// Where logs go: the same folder Tauri's `app_log_dir()` resolves to.
pub fn log_dir(identifier: &str) -> Option<PathBuf> {
    #[cfg(target_os = "macos")]
    let dir = dirs::home_dir().map(|d| d.join("Library/Logs").join(identifier));
    #[cfg(not(target_os = "macos"))]
    let dir = dirs::data_local_dir().map(|d| d.join(identifier).join("logs"));
    dir
}

/// Installs the global subscriber and a panic hook. Returns the log file path, if the file could be opened.
pub fn init(dir: Option<&Path>) -> Option<PathBuf> {
    let env = std::env::var("K10S_LOG").ok().filter(|s| !s.trim().is_empty());
    let filter = |default: &str| make_filter(env.as_deref(), default);

    let file = dir.and_then(|d| match RollingFile::open(d) {
        Ok(f) => Some(f),
        Err(e) => {
            eprintln!("k10s: cannot write logs to {}: {e}", d.display());
            None
        }
    });
    let path = file.as_ref().map(RollingFile::path);
    let file_layer = file.map(|f| tracing_subscriber::fmt::layer().with_writer(f).with_ansi(false).with_timer(LocalTime).with_filter(filter(FILE_FILTER)));
    let terminal_layer = tracing_subscriber::fmt::layer().with_writer(|| RedactedStderr).with_timer(LocalTime).with_filter(filter(TERMINAL_FILTER));
    tracing_subscriber::registry().with(file_layer).with(terminal_layer).init();

    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        tracing::error!(target: "k10s::panic", "{info}\n{}", std::backtrace::Backtrace::force_capture());
        default_hook(info);
    }));
    path
}

/// `env` (`K10S_LOG`) if it is a valid filter, else `default` — never letting kube-client log response
/// bodies, nor leaving out the journal, unless asked to by name (see [`NO_RESPONSE_BODIES`], [`AUDIT`]).
fn make_filter(env: Option<&str>, default: &str) -> EnvFilter {
    let mut spec = env.filter(|s| EnvFilter::try_new(s).is_ok()).unwrap_or(default).to_string();
    for (named, directives) in [("kube_client", NO_RESPONSE_BODIES), ("k10s::audit", AUDIT)] {
        if !spec.contains(named) {
            spec = format!("{spec},{directives}");
        }
    }
    EnvFilter::new(spec)
}

/// Local wall-clock timestamps, so log lines match what the user saw ("it froze at 14:05").
struct LocalTime;

impl FormatTime for LocalTime {
    fn format_time(&self, w: &mut Writer<'_>) -> std::fmt::Result {
        write!(w, "{}", jiff::Zoned::now().strftime("%Y-%m-%d %H:%M:%S%.3f"))
    }
}

/// Append-only log file rotated by size.
struct RollingFile {
    dir: PathBuf,
    /// Open file and its current length.
    state: Mutex<Option<(File, u64)>>,
}

impl RollingFile {
    fn open(dir: &Path) -> io::Result<Self> {
        fs::create_dir_all(dir)?;
        let file = Self { dir: dir.to_path_buf(), state: Mutex::new(None) };
        *file.state.lock() = Some(file.open_current()?);
        Ok(file)
    }

    fn path(&self) -> PathBuf {
        self.dir.join(FILE_NAME)
    }

    fn rotated(&self, n: usize) -> PathBuf {
        self.dir.join(format!("k10s.{n}.log"))
    }

    fn open_current(&self) -> io::Result<(File, u64)> {
        let file = OpenOptions::new().create(true).append(true).open(self.path())?;
        let len = file.metadata().map(|m| m.len()).unwrap_or(0);
        Ok((file, len))
    }

    fn rotate(&self) -> io::Result<(File, u64)> {
        let _ = fs::remove_file(self.rotated(KEEP));
        for n in (1..KEEP).rev() {
            let _ = fs::rename(self.rotated(n), self.rotated(n + 1));
        }
        fs::rename(self.path(), self.rotated(1))?;
        self.open_current()
    }

    /// Writes one formatted event (the fmt layer hands over whole records).
    fn write_record(&self, buf: &[u8]) -> io::Result<()> {
        let buf = &*one_record(buf);
        let mut state = self.state.lock();
        if state.as_ref().is_some_and(|(_, len)| *len > 0 && len + buf.len() as u64 > MAX_BYTES) {
            // Close before renaming; if rotation fails, keep appending and retry after another MAX_BYTES.
            *state = None;
            *state = Some(match self.rotate() {
                Ok(f) => f,
                Err(_) => (self.open_current()?.0, 0),
            });
        }
        if state.is_none() {
            *state = Some(self.open_current()?);
        }
        let (file, len) = state.as_mut().expect("opened above");
        file.write_all(buf)?;
        *len += buf.len() as u64;
        Ok(())
    }
}

struct RecordWriter<'a>(&'a RollingFile);

impl Write for RecordWriter<'_> {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.0.write_record(buf)?;
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

impl<'a> MakeWriter<'a> for RollingFile {
    type Writer = RecordWriter<'a>;

    fn make_writer(&'a self) -> Self::Writer {
        RecordWriter(self)
    }
}

struct RedactedStderr;

impl Write for RedactedStderr {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        io::stderr().write_all(&one_record(buf))?;
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        io::stderr().flush()
    }
}

/// A record as written: [`redacted`], and [`indented`].
fn one_record(record: &[u8]) -> Cow<'_, [u8]> {
    match redacted(record) {
        Cow::Borrowed(clean) => indented(clean),
        Cow::Owned(clean) => Cow::Owned(indented(&clean).into_owned()),
    }
}

/// Line breaks inside a record (a stack trace, a multi-line error from a cluster or an admission webhook,
/// a message the web view sent) indent what follows them: only a record's first line starts at column 0,
/// so no text logged can pass for a record of its own — a `k10s::audit` line, say.
fn indented(record: &[u8]) -> Cow<'_, [u8]> {
    let body = record.strip_suffix(b"\n").unwrap_or(record);
    if !body.iter().any(|&b| b == b'\n' || b == b'\r') {
        return Cow::Borrowed(record);
    }
    let mut out = Vec::with_capacity(record.len() + 64);
    let mut bytes = body.iter().copied().peekable();
    while let Some(b) = bytes.next() {
        match b {
            b'\r' | b'\n' => {
                if b == b'\r' && bytes.peek() == Some(&b'\n') {
                    bytes.next();
                }
                out.extend_from_slice(b"\n    ");
            }
            _ => out.push(b),
        }
    }
    if body.len() < record.len() {
        out.push(b'\n');
    }
    Cow::Owned(out)
}

/// Last line of defence: the engine already sanitizes its errors, this also covers library logs and
/// any path that formats a raw kube error (exec auth failures carry the plugin's environment).
fn redacted(record: &[u8]) -> Cow<'_, [u8]> {
    let Ok(text) = std::str::from_utf8(record) else { return Cow::Borrowed(record) };
    match k10s_core::error::redact_secrets(text) {
        Cow::Borrowed(_) => Cow::Borrowed(record),
        Cow::Owned(mut clean) => {
            // Withheld details may have taken the rest of the record, line break included.
            if text.ends_with('\n') && !clean.ends_with('\n') {
                clean.push('\n');
            }
            Cow::Owned(clean.into_bytes())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rotates_by_size_and_keeps_a_bounded_history() {
        let dir = std::env::temp_dir().join(format!("k10s-log-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let log = RollingFile::open(&dir).unwrap();
        let record = vec![b'x'; (MAX_BYTES / 3) as usize];
        for _ in 0..(3 * (KEEP + 3)) {
            log.write_record(&record).unwrap();
        }
        assert!(log.path().exists());
        assert!(fs::metadata(log.path()).unwrap().len() <= MAX_BYTES);
        for n in 1..=KEEP {
            assert!(log.rotated(n).exists(), "k10s.{n}.log missing");
        }
        assert!(!log.rotated(KEEP + 1).exists());
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn records_never_carry_exec_plugin_environments() {
        let dir = std::env::temp_dir().join(format!("k10s-log-redact-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let log = RollingFile::open(&dir).unwrap();
        let failure = r#"auth exec command 'API_TOKEN="SECRET123" "kubelogin" "get-token"' failed with status exit status: 1: Output { status: ExitStatus(unix_wait_status(256)), stdout: "partial-token\n", stderr: "please sign in again\n" }"#;
        log.write_record(format!("WARN connection failed context=dc1 error=auth error: {failure}\n").as_bytes()).unwrap();
        log.write_record(format!("DEBUG err={:?}\n", format!("AuthExecRun {{ cmd: {failure:?} }}")).as_bytes()).unwrap();
        log.write_record(b"INFO next\n").unwrap();
        let written = fs::read_to_string(log.path()).unwrap();
        assert_eq!(
            written,
            "WARN connection failed context=dc1 error=auth error: exec auth plugin `kubelogin get-token` failed (exit status: 1): please sign in again\n\
             DEBUG err=\"AuthExecRun { … }\n\
             INFO next\n"
        );
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn nothing_inside_a_record_can_pass_for_a_record_of_its_own() {
        let dir = std::env::temp_dir().join(format!("k10s-log-lines-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let log = RollingFile::open(&dir).unwrap();
        // What a script in the web view could send as a "frontend error"…
        log.write_record(b"2026-10-03 15:00:00.000 ERROR k10s::ui: boom\n2026-10-03 15:00:00.001  INFO k10s::audit: mutation cluster=\"prod-eu-z1\" result=\"ok\"\r\nat x.js:1\n").unwrap();
        // …and an ordinary record after it.
        log.write_record(b"2026-10-03 15:00:01.000  INFO k10s::audit: mutation result=\"ok\"\n").unwrap();
        let written = fs::read_to_string(log.path()).unwrap();
        assert_eq!(
            written,
            "2026-10-03 15:00:00.000 ERROR k10s::ui: boom\n    2026-10-03 15:00:00.001  INFO k10s::audit: mutation cluster=\"prod-eu-z1\" result=\"ok\"\n    at x.js:1\n\
             2026-10-03 15:00:01.000  INFO k10s::audit: mutation result=\"ok\"\n"
        );
        assert_eq!(written.lines().filter(|l| !l.starts_with(' ')).count(), 2);
        // A record without a line break inside is written as it is.
        assert!(matches!(indented(b"INFO one line\n"), Cow::Borrowed(_)));
        fs::remove_dir_all(&dir).unwrap();
    }

    /// What a subscriber with `filter` writes for kube-client's dump of an undecodable body, an error of
    /// the same module tree, and an audit line.
    fn written_with(filter: EnvFilter) -> String {
        #[derive(Clone, Default)]
        struct Buf(std::sync::Arc<Mutex<Vec<u8>>>);
        impl Write for Buf {
            fn write(&mut self, b: &[u8]) -> io::Result<usize> {
                self.0.lock().extend_from_slice(b);
                Ok(b.len())
            }
            fn flush(&mut self) -> io::Result<()> {
                Ok(())
            }
        }
        let buf = Buf::default();
        let out = buf.clone();
        let subscriber =
            tracing_subscriber::registry().with(tracing_subscriber::fmt::layer().with_writer(move || out.clone()).with_ansi(false).with_filter(filter));
        tracing::subscriber::with_default(subscriber, || {
            tracing::warn!(target: "kube_client::client", "{}, {:?}", r#"{"kind":"Secret","data":{"password":"aHVudGVyMg=="}}"#, "trailing characters at line 1 column 9");
            tracing::warn!(target: "kube_client::client", "Unsuccessful data error parse: <html>secret page</html>");
            tracing::error!(target: "kube_client::client::builder", "failed with status 500 Internal Server Error");
            tracing::warn!(target: "kube_client::client::tls", "Server cert bypassed");
            tracing::info!(target: "k10s::audit", action = "delete", result = "ok", "mutation");
        });
        String::from_utf8(buf.0.lock().clone()).unwrap()
    }

    #[test]
    fn kube_client_never_writes_response_bodies_to_the_log() {
        for filter in [
            make_filter(None, FILE_FILTER),
            make_filter(None, TERMINAL_FILTER),
            make_filter(Some("trace"), FILE_FILTER),
            make_filter(Some("not a [valid filter"), FILE_FILTER),
        ] {
            let written = written_with(filter);
            assert!(!written.contains("aHVudGVyMg==") && !written.contains("secret page"), "{written}");
            assert!(written.contains("failed with status 500"), "errors still get through: {written}");
            assert!(written.contains("Server cert bypassed"), "TLS warnings too: {written}");
            assert!(written.contains("k10s::audit: mutation"), "{written}");
        }
        // The journal survives a quieter K10S_LOG.
        for env in ["warn", "error,k10s_core=debug", "off"] {
            let written = written_with(make_filter(Some(env), FILE_FILTER));
            assert!(written.contains("k10s::audit: mutation"), "{env}: {written}");
            assert!(!written.contains("aHVudGVyMg=="), "{env}: {written}");
        }
        // Naming it is honoured.
        assert!(!written_with(make_filter(Some("info,k10s::audit=off"), FILE_FILTER)).contains("k10s::audit"));
        // Asking for kube-client by name (debugging it) is honoured.
        assert!(written_with(make_filter(Some("kube_client=debug"), FILE_FILTER)).contains("aHVudGVyMg=="));
    }

    #[test]
    fn local_timestamps_have_milliseconds() {
        let mut out = String::new();
        LocalTime.format_time(&mut Writer::new(&mut out)).unwrap();
        // 2026-10-02 14:05:09.123
        assert_eq!(out.len(), 23, "{out}");
        assert_eq!(&out[19..20], ".", "{out}");
    }
}
