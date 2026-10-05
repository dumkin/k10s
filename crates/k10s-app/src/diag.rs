//! Diagnostics for "the UI froze" reports.
//!
//! The web UI sends a heartbeat every second. A watchdog thread (independent of the async runtime
//! and of the app's main thread) notices when heartbeats stop while the page is visible and logs
//! what was going on: IPC traffic per stream over the last seconds, whether the app's main
//! (event loop) thread still runs, and the engine's load. It logs again when the UI recovers.

use std::collections::{HashMap, VecDeque};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant};

use k10s_core::Engine;
use parking_lot::Mutex;
use tauri::{AppHandle, Manager};

/// Silence (while the page is visible) that counts as a freeze.
const STALL_AFTER_MS: u64 = 5_000;
/// While frozen, repeat the report this often.
const REPEAT_MS: u64 = 30_000;
/// Seconds of traffic history included in a report.
const WINDOW_SECS: usize = 10;
/// The main-thread probe is considered stuck after this long.
const MAIN_STUCK_MS: u64 = 3_000;

struct Stream {
    what: String,
    msgs: u64,
    bytes: u64,
}

pub struct Diagnostics {
    epoch: Instant,
    /// ms since `epoch` of the last UI heartbeat; 0 = no page up yet.
    ui_beat: AtomicU64,
    /// Hidden pages (minimized, another Space) get their timers throttled: silence is expected.
    ui_hidden: AtomicBool,
    /// ms since `epoch` when the probe last ran on the app's main thread.
    main_beat: AtomicU64,
    /// Open channel streams by channel id.
    streams: Mutex<HashMap<u32, Stream>>,
}

impl Diagnostics {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            epoch: Instant::now(),
            ui_beat: AtomicU64::new(0),
            ui_hidden: AtomicBool::new(false),
            main_beat: AtomicU64::new(0),
            streams: Mutex::new(HashMap::new()),
        })
    }

    fn now_ms(&self) -> u64 {
        // Never 0, which means "no heartbeat yet".
        self.epoch.elapsed().as_millis() as u64 + 1
    }

    pub fn heartbeat(&self, visible: bool) {
        self.ui_hidden.store(!visible, Ordering::Relaxed);
        self.ui_beat.store(self.now_ms(), Ordering::Relaxed);
    }

    /// A (re)loading page sends no heartbeats until it has booted.
    pub fn page_reloaded(&self) {
        self.ui_beat.store(0, Ordering::Relaxed);
    }

    /// Starts accounting for a channel stream; it ends when the token (owned by the sink) is dropped.
    pub fn open_stream(self: &Arc<Self>, id: u32, what: String) -> StreamToken {
        self.streams.lock().insert(id, Stream { what, msgs: 0, bytes: 0 });
        StreamToken { diag: self.clone(), id }
    }

    fn counters(&self) -> HashMap<u32, (u64, u64)> {
        self.streams.lock().iter().map(|(id, s)| (*id, (s.msgs, s.bytes))).collect()
    }

    /// `"412 msgs, 38.2 MB in 10s; top: namespaces × 8 clusters 37.9 MB/390, …"`
    fn traffic(&self, old: &HashMap<u32, (u64, u64)>, new: &HashMap<u32, (u64, u64)>, secs: usize) -> String {
        let streams = self.streams.lock();
        let mut rows: Vec<(u64, u64, &str)> = new
            .iter()
            .map(|(id, (m, b))| {
                let (m0, b0) = old.get(id).copied().unwrap_or_default();
                (b.saturating_sub(b0), m.saturating_sub(m0), streams.get(id).map_or("?", |s| s.what.as_str()))
            })
            .filter(|(_, msgs, _)| *msgs > 0)
            .collect();
        rows.sort_unstable_by_key(|r| std::cmp::Reverse(r.0));
        let (bytes, msgs) = rows.iter().fold((0, 0), |(b, m), r| (b + r.0, m + r.1));
        let top: Vec<String> = rows.iter().take(3).map(|(b, m, what)| format!("{what} {}/{m}", human(*b))).collect();
        format!(
            "{msgs} msgs, {} in {secs}s across {} open streams{}{}",
            human(bytes),
            streams.len(),
            if top.is_empty() { "" } else { "; top: " },
            top.join(", ")
        )
    }

    pub fn spawn_watchdog(self: &Arc<Self>, app: AppHandle) {
        let diag = self.clone();
        let spawned = std::thread::Builder::new().name("k10s-watchdog".into()).spawn(move || diag.watch(app));
        if let Err(e) = spawned {
            tracing::warn!("UI watchdog not started: {e}");
        }
    }

    fn watch(self: Arc<Self>, app: AppHandle) {
        let mut history: VecDeque<HashMap<u32, (u64, u64)>> = VecDeque::with_capacity(WINDOW_SECS + 1);
        let mut minute = self.counters();
        let mut ticks = 0u32;
        // Heartbeat time before the current freeze, and when it was last reported.
        let mut stalled: Option<u64> = None;
        let mut reported = 0u64;
        loop {
            std::thread::sleep(Duration::from_secs(1));
            let probe = self.clone();
            let _ = app.run_on_main_thread(move || probe.main_beat.store(probe.now_ms(), Ordering::Relaxed));

            let counters = self.counters();
            ticks += 1;
            if ticks.is_multiple_of(60) {
                tracing::debug!(target: "k10s::ipc", "{}", self.traffic(&minute, &counters, 60));
                minute = counters.clone();
            }
            history.push_back(counters);
            if history.len() > WINDOW_SECS + 1 {
                history.pop_front();
            }

            let now = self.now_ms();
            let beat = self.ui_beat.load(Ordering::Relaxed);
            if beat == 0 || self.ui_hidden.load(Ordering::Relaxed) {
                stalled = None;
                continue;
            }
            let silent = now.saturating_sub(beat);
            if silent >= STALL_AFTER_MS {
                let first = stalled.is_none();
                if first || now - reported >= REPEAT_MS {
                    stalled.get_or_insert(beat);
                    reported = now;
                    let main_lag = now.saturating_sub(self.main_beat.load(Ordering::Relaxed));
                    let main = if main_lag > MAIN_STUCK_MS { format!("BLOCKED for {}s", main_lag / 1000) } else { "ok".into() };
                    let engine = app.try_state::<Engine>().map(|e| e.stats());
                    let traffic = match (history.front(), history.back()) {
                        (Some(old), Some(new)) => self.traffic(old, new, history.len() - 1),
                        _ => String::new(),
                    };
                    tracing::warn!(
                        "UI is not responding{}: no heartbeat for {}s · app main thread: {main} · engine: {} · IPC: {traffic}",
                        if first { "" } else { " (still)" },
                        silent / 1000,
                        engine.map_or_else(|| "?".into(), |s| format!("{} watches ({} active), {} objects", s.feeds, s.active, s.objects)),
                    );
                }
            } else if let Some(since) = stalled.take() {
                tracing::warn!("UI is responding again after {}s", (beat.saturating_sub(since)) / 1000);
            }
        }
    }
}

/// Counts what a stream sends; removes the stream from accounting when dropped.
pub struct StreamToken {
    diag: Arc<Diagnostics>,
    id: u32,
}

impl StreamToken {
    pub fn record(&self, bytes: usize) {
        if let Some(s) = self.diag.streams.lock().get_mut(&self.id) {
            s.msgs += 1;
            s.bytes += bytes as u64;
        }
    }
}

impl Drop for StreamToken {
    fn drop(&mut self) {
        self.diag.streams.lock().remove(&self.id);
    }
}

fn human(bytes: u64) -> String {
    match bytes {
        b if b >= 1 << 20 => format!("{:.1} MB", b as f64 / (1u64 << 20) as f64),
        b if b >= 1 << 10 => format!("{:.0} KB", b as f64 / 1024.0),
        b => format!("{b} B"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn traffic_report_ranks_streams_by_bytes() {
        let diag = Diagnostics::new();
        let a = diag.open_stream(1, "pods × dev".into());
        let b = diag.open_stream(2, "namespaces × 8 clusters [names]".into());
        let before = diag.counters();
        a.record(100);
        for _ in 0..3 {
            b.record(2 << 20);
        }
        let report = diag.traffic(&before, &diag.counters(), 10);
        assert_eq!(report, "4 msgs, 6.0 MB in 10s across 2 open streams; top: namespaces × 8 clusters [names] 6.0 MB/3, pods × dev 100 B/1");
        drop(b);
        assert_eq!(diag.counters().len(), 1);
    }
}
