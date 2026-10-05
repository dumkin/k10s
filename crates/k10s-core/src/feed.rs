//! Shared watch feeds — k10s' informers.
//!
//! A [`Feed`] is one kube watch (cluster × resource × namespace × selectors) that keeps rendered rows
//! (and, while it is small, compact object JSON) in memory and broadcasts deltas. Any number of views
//! lease the same feed; when the last lease is dropped the feed stays warm for an idle TTL, so jumping
//! back to a recently visited view is instant (no re-list, no network).
//!
//! Watches heal themselves: the server closes every watch after [`WATCH_TIMEOUT_SECS`] (a dead
//! connection is noticed within about a minute), a failed watch starts over with a fresh list (so the
//! feed reports `Ready` again once it works), a 401 asks the engine for new credentials (see
//! [`WatchHub::on_unauthorized`]), and feeds restart in place — keeping their rows until the new list
//! replaces them — on reconnect ([`WatchHub::restart_cluster`]) and after sleep ([`WatchHub::resync`]).
//!
//! A feed whose renderer prints server-side ([`Renderer::server_table`]) watches tables instead of plain
//! objects ([`table::watcher`]): the API server computes its cells, the feed keeps the objects all the same.
//!
//! Memory: a typical pod is ~6.6 KB of JSON against ~1 KB of row (`memory_per_object` below). A feed keeps the
//! JSON of its objects (details open instantly, log streams read container states for free) only while a view
//! showing rows leases it (not while idle, nor for a picker that shows names only), while it is small
//! ([`JSON_MAX_OBJECTS`], [`JSON_MAX_BYTES`]), and while all feeds together keep at most [`JSON_BUDGET`] — feeds
//! with selectors (one object's events, a workload's pods: what log streams read) aside, they are small and
//! short-lived. Otherwise it keeps rows, plus the JSON of the few objects looked up lately ([`PINS`]); the others
//! are fetched when asked for. Secrets never keep theirs (their values stay out of memory unless opened).
//! Idle feeds stop after the configured TTL — those of one object's details (selectors) much sooner — and
//! those idle the longest stop early while more than [`MAX_IDLE_FEEDS`] are idle or they take more than
//! [`IDLE_MAX_BYTES`] (checked by [`WatchHub::reap`], so a view coming back finds its feeds before that).

use std::collections::{HashMap, HashSet, VecDeque};
use std::ops::Deref;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Weak};
use std::time::{Duration, Instant};

use futures::StreamExt;
use futures::stream::BoxStream;
use kube::core::ApiResource;
use kube::runtime::watcher;
use kube::{Api, Client};
use parking_lot::{Mutex, RwLock};
use serde::Serialize;
use tokio::runtime::Handle;
use tokio::sync::broadcast;
use tokio::task::AbortHandle;

use crate::cluster::is_auth_failure;
use crate::error::{chain, kube_message};
use crate::object::Obj;
use crate::render::{self, Cell, Renderer, Row, build_row, table};

/// Broadcast buffer per feed, allocated up front (see [`FEED_BYTES`]). A consumer that falls behind
/// re-snapshots instead of blocking the watch (see `view`).
const BROADCAST_CAPACITY: usize = 1024;
/// What a feed takes before it holds anything: its broadcast buffer (an event and the slot's bookkeeping a
/// slot), ~100 KB.
const FEED_BYTES: usize = BROADCAST_CAPACITY * (std::mem::size_of::<FeedEvent>() + 32);
/// Feeds keep object JSON while they hold at most this many objects…
const JSON_MAX_OBJECTS: usize = 2_000;
/// …and at most this much of it. Beyond either, they keep rows only (for good: until they stop).
const JSON_MAX_BYTES: usize = 16 << 20;
/// Object JSON all feeds without selectors keep together, at most (~10k typical pods): a feed that grows
/// beyond it keeps rows only, until a view leases it again with a quarter of it free. Strict RBAC makes views of
/// many small per-namespace feeds, each far below the per-feed bounds.
const JSON_BUDGET: usize = 64 << 20;
/// Objects of a feed without JSON that were looked up lately (the details panel's, log targets): their JSON
/// is kept from their next change on.
const PINS: usize = 16;
/// Feeds with selectors serve one object's details (its events, a workload's pods): when the panel moves
/// on, they stop this soon (at the next reap), whatever the configured TTL.
const SELECTOR_IDLE_TTL: Duration = Duration::from_secs(15);
/// At most this many idle feeds stay warm (each keeps a watch open; a view has up to 1000)…
const MAX_IDLE_FEEDS: usize = 1_000;
/// …taking at most this much memory in all ([`Feed::footprint`]; ~130k typical pods' rows, idle feeds keep no
/// JSON). Those idle the longest stop first.
const IDLE_MAX_BYTES: usize = 128 << 20;
/// The server ends each watch after this long and the watcher resumes it from the last resourceVersion
/// (no re-list). kube gives up on a watch that stays silent 5s longer — a half-open connection after
/// sleep or a VPN switch — so stale data is noticed within about a minute, not five.
const WATCH_TIMEOUT_SECS: u32 = 55;
/// A feed that worked for this long before failing retries quickly again (backoff starts over).
const HEALTHY_RESET: Duration = Duration::from_secs(30);

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct FeedKey {
    pub cluster: Arc<str>,
    pub resource: Arc<str>,
    pub namespace: Option<Arc<str>>,
    pub labels: Option<Arc<str>>,
    pub fields: Option<Arc<str>>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "state", rename_all = "lowercase")]
pub enum FeedStatus {
    Connecting,
    Loading,
    Ready,
    Error {
        message: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        code: Option<u16>,
        /// API `reason` (`Forbidden`, `Unauthorized`, `NotFound`…), when the server gave one.
        #[serde(skip_serializing_if = "Option::is_none")]
        reason: Option<String>,
        /// The watch gave up (permission/auth/not-found errors are not retried).
        #[serde(skip_serializing_if = "std::ops::Not::not")]
        terminal: bool,
    },
}

#[derive(Clone, Debug)]
pub enum FeedEvent {
    Upsert(Arc<Row>),
    Delete(Arc<str>),
    Status(FeedStatus),
}

struct Entry {
    row: Arc<Row>,
    /// The object, see [`State::keeps_json`].
    json: Option<Arc<str>>,
}

/// How much of its objects' JSON a feed keeps.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
enum Lean {
    /// All of it.
    No,
    /// That of `pins` only, for now: no view shows the feed's rows (it is idle, or serves a picker of names), or
    /// [`JSON_BUDGET`] was spent when it grew. A view leasing it again with room left lifts that: its objects get
    /// their JSON back as they change.
    ForNow,
    /// That of `pins` only, until the feed stops: it grew too big, or holds secrets.
    ForGood,
}

/// Object JSON kept by the feeds that count toward [`JSON_BUDGET`] (those without selectors).
struct Budget {
    used: AtomicUsize,
    limit: AtomicUsize,
}

impl Default for Budget {
    fn default() -> Self {
        Budget { used: AtomicUsize::new(0), limit: AtomicUsize::new(JSON_BUDGET) }
    }
}

impl Budget {
    fn spent(&self) -> bool {
        self.used.load(Ordering::Relaxed) > self.limit.load(Ordering::Relaxed)
    }

    /// Enough is free for a feed to keep JSON again (a quarter: feeds do not flip back and forth at the limit).
    fn has_room(&self) -> bool {
        self.used.load(Ordering::Relaxed) < self.limit.load(Ordering::Relaxed) / 4 * 3
    }
}

/// What a feed keeps an object under: its uid, or for an object without one (some aggregated APIs serve
/// such) a synthetic `namespace/name` — the same for its upserts and its delete.
fn entry_key(obj: &Obj) -> Arc<str> {
    if obj.uid().is_empty() { Arc::from(format!("{}/{}", obj.namespace().unwrap_or_default(), obj.name())) } else { Arc::from(obj.uid()) }
}

/// About what a row takes in memory: the row and its strings and cells, and its entry in a feed (`Arc`s, key).
fn row_size(row: &Row) -> usize {
    let cells: usize = row
        .cells
        .iter()
        .map(|c| match c {
            Cell::Text(s) | Cell::Status(s, _) => s.capacity(),
            _ => 0,
        })
        .sum();
    let strings =
        row.uid.len() + row.name.capacity() + row.namespace.as_ref().map_or(0, String::capacity) + row.resource_version.capacity() + row.labels.capacity();
    2 * 16 + std::mem::size_of::<(Arc<str>, Entry)>() + std::mem::size_of::<Row>() + strings + row.cells.capacity() * std::mem::size_of::<Cell>() + cells
}

struct State {
    entries: HashMap<Arc<str>, Entry>,
    status: FeedStatus,
    /// Id of the current watch task; changes made by an older (restarted) one are ignored.
    run: u64,
    /// Total length of the JSON kept…
    json_bytes: usize,
    /// …and about what the rows take ([`row_size`]).
    row_bytes: usize,
    lean: Lean,
    /// Uids looked up lately (least recent first), see [`PINS`].
    pins: VecDeque<Arc<str>>,
    /// Leases of views that show rows (whose objects' details may be asked for).
    readers: usize,
    /// What the JSON kept counts toward (`None` for feeds with selectors).
    budget: Option<Arc<Budget>>,
}

impl State {
    fn keeps_json(&self, uid: &str) -> bool {
        self.lean == Lean::No || self.pins.iter().any(|p| **p == *uid)
    }

    fn add_json(&mut self, n: usize) {
        self.json_bytes += n;
        if let Some(b) = &self.budget {
            b.used.fetch_add(n, Ordering::Relaxed);
        }
    }

    fn sub_json(&mut self, n: usize) {
        self.json_bytes -= n;
        if let Some(b) = &self.budget {
            b.used.fetch_sub(n, Ordering::Relaxed);
        }
    }

    fn insert(&mut self, uid: Arc<str>, entry: Entry) {
        self.add_json(entry.json.as_ref().map_or(0, |j| j.len()));
        self.row_bytes += row_size(&entry.row);
        if let Some(old) = self.entries.insert(uid, entry) {
            self.sub_json(old.json.map_or(0, |j| j.len()));
            self.row_bytes -= row_size(&old.row);
        }
        if self.lean < Lean::ForGood && (self.entries.len() > JSON_MAX_OBJECTS || self.json_bytes > JSON_MAX_BYTES) {
            self.thin(Lean::ForGood);
        } else if self.lean == Lean::No && self.budget.as_ref().is_some_and(|b| b.spent()) {
            self.thin(Lean::ForNow);
        }
    }

    fn remove(&mut self, uid: &str) -> Option<Arc<str>> {
        let (uid, e) = self.entries.remove_entry(uid)?;
        self.sub_json(e.json.map_or(0, |j| j.len()));
        self.row_bytes -= row_size(&e.row);
        Some(uid)
    }

    /// Keeps the JSON of `pins` only from now on, for now or for good.
    fn thin(&mut self, lean: Lean) {
        self.lean = self.lean.max(lean);
        if self.json_bytes == 0 {
            return;
        }
        let mut freed = 0;
        for (uid, e) in self.entries.iter_mut() {
            if e.json.is_some() && !self.pins.contains(uid) {
                freed += e.json.take().map_or(0, |j| j.len());
            }
        }
        self.sub_json(freed);
    }

    /// A view showing rows leased the feed: it keeps its objects' JSON again, unless it must not.
    fn add_reader(&mut self) {
        self.readers += 1;
        if self.lean == Lean::ForNow && self.budget.as_ref().is_none_or(|b| b.has_room()) {
            self.lean = Lean::No;
        }
    }

    /// Such a view let go of it: with none left, nobody reads its objects, and it keeps none.
    fn remove_reader(&mut self) {
        self.readers -= 1;
        if self.readers == 0 {
            self.pins.clear();
            self.thin(Lean::ForNow);
        }
    }

    /// `uid` was looked up: its JSON is kept from now on, the least recent pin's no more.
    fn pin(&mut self, uid: &Arc<str>) {
        if let Some(i) = self.pins.iter().position(|p| p == uid) {
            let p = self.pins.remove(i).expect("found");
            self.pins.push_back(p);
            return;
        }
        self.pins.push_back(uid.clone());
        if self.pins.len() > PINS
            && let Some(old) = self.pins.pop_front()
            && let Some(json) = self.entries.get_mut(&old).and_then(|e| e.json.take())
        {
            self.sub_json(json.len());
        }
    }
}

pub struct Feed {
    pub key: FeedKey,
    pub renderer: Arc<dyn Renderer>,
    state: Mutex<State>,
    tx: broadcast::Sender<FeedEvent>,
    leases: AtomicUsize,
    idle_since: Mutex<Option<Instant>>,
    task: Mutex<Option<AbortHandle>>,
    /// Set when the watch task stopped for good (terminal error); such feeds are restarted on the next
    /// lease and on reconnect.
    finished: AtomicBool,
    api: Api<Obj>,
    config: watcher::Config,
    api_resource: ApiResource,
    hooks: Arc<Hooks>,
}

pub struct Snapshot {
    pub rows: Vec<Arc<Row>>,
    pub status: FeedStatus,
    pub rx: broadcast::Receiver<FeedEvent>,
}

/// Everything needed to start the watch behind a feed.
pub struct FeedSpec {
    pub client: Client,
    pub api_resource: ApiResource,
    pub renderer: Arc<dyn Renderer>,
}

impl Feed {
    /// A feed for `key`, its watch not started yet (see [`Feed::spawn_watch`]).
    fn new(key: FeedKey, spec: FeedSpec, hooks: Arc<Hooks>) -> Arc<Feed> {
        let (tx, _) = broadcast::channel(BROADCAST_CAPACITY);
        let api: Api<Obj> = match &key.namespace {
            Some(ns) => Api::namespaced_with(spec.client, ns, &spec.api_resource),
            None => Api::all_with(spec.client, &spec.api_resource),
        };
        // Lists come in pages, consistent reads, parsed as they stream in (see `crate::list`).
        let mut config = watcher::Config::default().timeout(WATCH_TIMEOUT_SECS);
        if let Some(l) = &key.labels {
            config = config.labels(l);
        }
        if let Some(f) = &key.fields {
            config = config.fields(f);
        }
        // Secrets keep no JSON: their values stay out of memory unless someone opens one. Others do once a view
        // showing rows leases them.
        let lean = if &*key.resource == "secrets" { Lean::ForGood } else { Lean::ForNow };
        let budget = (key.labels.is_none() && key.fields.is_none()).then(|| hooks.json.clone());
        let state = State {
            entries: HashMap::new(),
            status: FeedStatus::Loading,
            run: 0,
            json_bytes: 0,
            row_bytes: 0,
            lean,
            pins: VecDeque::new(),
            readers: 0,
            budget,
        };
        Arc::new(Feed {
            key,
            renderer: spec.renderer,
            state: Mutex::new(state),
            tx,
            leases: AtomicUsize::new(0),
            idle_since: Mutex::new(None),
            task: Mutex::new(None),
            finished: AtomicBool::new(false),
            api,
            config,
            api_resource: spec.api_resource,
            hooks,
        })
    }

    /// A view's claim on the feed; `reads`: it shows rows (see [`Lease::objects`]).
    fn acquire(self: &Arc<Self>, reads: bool) -> FeedLease {
        self.leases.fetch_add(1, Ordering::AcqRel);
        *self.idle_since.lock() = None;
        if reads {
            self.state.lock().add_reader();
        }
        FeedLease { feed: self.clone(), reads }
    }

    /// About what the feed takes in memory: its buffer, rows and JSON.
    fn footprint(&self) -> usize {
        let st = self.state.lock();
        FEED_BYTES + st.row_bytes + st.json_bytes
    }

    /// (Re)starts the watch task. Rows stay until the new list replaces them; `reload` reports the
    /// feed as loading meanwhile (its data may be stale).
    fn spawn_watch(self: &Arc<Self>, rt: &Handle, reload: bool) {
        // Held throughout, so concurrent restarts cannot leave an older task running.
        let mut task = self.task.lock();
        let run = {
            let mut st = self.state.lock();
            st.run += 1;
            self.finished.store(false, Ordering::Release);
            if reload {
                Self::set_status_locked(&mut st, &self.tx, FeedStatus::Loading);
            }
            st.run
        };
        let handle = rt.spawn(watch(Arc::downgrade(self), run));
        if let Some(old) = task.replace(handle.abort_handle()) {
            old.abort();
        }
    }

    /// Current rows + status, and a receiver positioned exactly after them.
    pub fn snapshot(&self) -> Snapshot {
        let st = self.state.lock();
        Snapshot { rows: st.entries.values().map(|e| e.row.clone()).collect(), status: st.status.clone(), rx: self.tx.subscribe() }
    }

    pub fn status(&self) -> FeedStatus {
        self.state.lock().status.clone()
    }

    pub fn len(&self) -> usize {
        self.state.lock().entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Length of the object JSON kept.
    pub fn json_bytes(&self) -> usize {
        self.state.lock().json_bytes
    }

    /// Cached JSON of one object, by uid (fast) or namespace/name. A feed that keeps rows only has the JSON
    /// of objects looked up lately: it keeps this one's from its next change on.
    pub fn object_json(&self, uid: Option<&str>, name: &str, namespace: Option<&str>) -> Option<Arc<str>> {
        let mut st = self.state.lock();
        let (uid, json) = match uid {
            Some(uid) => st.entries.get_key_value(uid).map(|(k, e)| (k.clone(), e.json.clone()))?,
            None => st.entries.iter().find(|(_, e)| e.row.name == name && e.row.namespace.as_deref() == namespace).map(|(k, e)| (k.clone(), e.json.clone()))?,
        };
        if st.lean != Lean::No {
            st.pin(&uid);
        }
        json
    }

    /// Every object it holds: its row, and its JSON where the feed keeps it (see the module docs).
    pub fn objects(&self) -> Vec<(Arc<Row>, Option<Arc<str>>)> {
        self.state.lock().entries.values().map(|e| (e.row.clone(), e.json.clone())).collect()
    }

    /// Whether the feed keeps the JSON of all its objects (not of a few looked up lately only).
    pub fn keeps_all_json(&self) -> bool {
        self.state.lock().lean == Lean::No
    }

    /// Whether it keeps every object's JSON from now on but lacks some: it was kept warm by a view that needed none
    /// (a picker, a problems view), and gets them back only as objects change.
    fn lacks_json(&self) -> bool {
        let st = self.state.lock();
        st.lean == Lean::No && st.entries.values().any(|e| e.json.is_none())
    }

    /// Whether the feed holds an object of that name.
    fn holds(&self, name: &str, namespace: Option<&str>) -> bool {
        self.state.lock().entries.values().any(|e| e.row.name == name && e.row.namespace.as_deref() == namespace)
    }

    /// How long the feed has been idle (no lease), if it is.
    fn idle_for(&self) -> Option<Duration> {
        if self.leases.load(Ordering::Acquire) > 0 {
            return None;
        }
        self.idle_since.lock().map(|t| t.elapsed())
    }

    /// How long the feed stays warm once idle, given the configured `ttl`.
    fn idle_ttl(&self, ttl: Duration) -> Duration {
        if self.key.labels.is_some() || self.key.fields.is_some() { ttl.min(SELECTOR_IDLE_TTL) } else { ttl }
    }

    fn apply(&self, run: u64, mut obj: Obj, ar: &ApiResource, seen: Option<&mut HashSet<Arc<str>>>) {
        let uid = entry_key(&obj);
        if let Some(seen) = seen {
            seen.insert(uid.clone());
        }
        // Re-lists replay unchanged objects; skip them before doing any work — unless the feed now keeps the JSON it
        // lacks (see [`WatchHub::fill_json`]).
        let keep_json = {
            let st = self.state.lock();
            let keep = st.keeps_json(&uid);
            if let Some(e) = st.entries.get(&uid)
                && !e.row.resource_version.is_empty()
                && e.row.resource_version == obj.resource_version()
                && (e.json.is_some() || !keep)
            {
                return;
            }
            keep
        };
        if obj.truncated() {
            let k = &self.key;
            tracing::debug!(cluster = %k.cluster, resource = %k.resource, namespace = obj.namespace(), name = obj.name(), "object nested more than {} levels deep: deeper values left out", crate::object::MAX_DEPTH);
        }

        obj.ensure_type_meta(ar);
        let mut row = build_row(&obj.raw, self.renderer.as_ref());
        row.uid = uid.clone();
        // Cells printed by the API server came attached to the object: rendered now, not kept.
        if self.renderer.server_table().is_some()
            && let Some(m) = obj.raw.as_object_mut()
        {
            m.remove(table::CELLS);
        }
        let json: Option<Arc<str>> = keep_json.then(|| serde_json::to_string(&obj.raw).unwrap_or_default().into());
        let row = Arc::new(row);

        let mut st = self.state.lock();
        if st.run != run {
            return;
        }
        // (The feed may have stopped keeping JSON meanwhile.)
        let json = json.filter(|_| st.keeps_json(&uid));
        st.insert(uid, Entry { row: row.clone(), json });
        // Sending under the lock keeps broadcast order consistent with snapshots.
        let _ = self.tx.send(FeedEvent::Upsert(row));
    }

    fn delete(&self, run: u64, obj: &Obj) {
        let uid = entry_key(obj);
        let mut st = self.state.lock();
        if st.run != run {
            return;
        }
        if let Some(uid) = st.remove(&uid) {
            let _ = self.tx.send(FeedEvent::Delete(uid));
        }
    }

    fn finish_init(&self, run: u64, seen: HashSet<Arc<str>>) {
        let mut st = self.state.lock();
        if st.run != run {
            return;
        }
        let stale: Vec<Arc<str>> = st.entries.keys().filter(|k| !seen.contains(*k)).cloned().collect();
        for uid in stale {
            st.remove(&uid);
            let _ = self.tx.send(FeedEvent::Delete(uid));
        }
        Self::set_status_locked(&mut st, &self.tx, FeedStatus::Ready);
    }

    /// Sets the status of watch `run`; with `stop`, also marks the feed as finished. Returns false if
    /// that watch was replaced meanwhile (nothing changed).
    fn set_status(&self, run: u64, status: FeedStatus, stop: bool) -> bool {
        let mut st = self.state.lock();
        if st.run != run {
            return false;
        }
        Self::set_status_locked(&mut st, &self.tx, status);
        if stop {
            self.finished.store(true, Ordering::Release);
        }
        true
    }

    fn set_status_locked(st: &mut State, tx: &broadcast::Sender<FeedEvent>, status: FeedStatus) {
        if st.status != status {
            st.status = status.clone();
            let _ = tx.send(FeedEvent::Status(status));
        }
    }

    /// Whether this feed serves the resource as `spec` describes it: the same version, rendered alike.
    fn serves(&self, spec: &FeedSpec) -> bool {
        spec.api_resource == self.api_resource && render::same(&spec.renderer, &self.renderer)
    }
}

impl Drop for Feed {
    fn drop(&mut self) {
        if let Some(task) = self.task.get_mut().take() {
            task.abort();
        }
        let st = self.state.get_mut();
        let kept = st.json_bytes;
        st.sub_json(kept);
    }
}

type ClusterFn = Arc<dyn Fn(&str) + Send + Sync>;

/// Hub-wide state the watch tasks consult.
#[derive(Default)]
struct Hooks {
    /// Told when a watch is rejected for its credentials.
    unauthorized: RwLock<Option<ClusterFn>>,
    /// Per cluster, bumped whenever its credentials were renewed (see [`WatchHub::restart_cluster`]).
    renewals: Mutex<HashMap<Arc<str>, u64>>,
    /// See [`JSON_BUDGET`].
    json: Arc<Budget>,
}

impl Hooks {
    fn renewal(&self, cluster: &str) -> u64 {
        self.renewals.lock().get(cluster).copied().unwrap_or(0)
    }

    fn report_unauthorized(&self, cluster: &str) {
        let handler = self.unauthorized.read().clone();
        if let Some(f) = handler {
            f(cluster);
        }
    }
}

enum Failure {
    /// Worth retrying (network, server errors…).
    Transient,
    /// Retrying cannot fix it (permissions, not found…).
    Terminal,
    /// The credentials were rejected (401) or could not be refreshed (exec plugin failure).
    Unauthorized,
}

/// Errors that retrying cannot fix: the watch stops and the feed reports a terminal error.
/// (Hammering a 403 every second is noisy, pointless and shows up in API-server audit logs.)
/// 401 is handled separately: new credentials can fix it.
fn is_terminal(code: Option<u16>) -> bool {
    matches!(code, Some(400 | 403 | 404 | 405 | 406 | 415 | 422))
}

/// The API server's answer could not be decoded. Over TLS that is what was sent, not the network: the same
/// list fails the same way however often it is fetched again (and kube logs the whole page each time).
fn undecodable(err: &watcher::Error) -> bool {
    match err {
        watcher::Error::InitialListFailed(e) | watcher::Error::WatchStartFailed(e) | watcher::Error::WatchFailed(e) => {
            matches!(e, kube::Error::SerdeError(_) | kube::Error::FromUtf8(_))
        }
        _ => false,
    }
}

fn classify(err: &watcher::Error, code: Option<u16>) -> Failure {
    let auth = match err {
        watcher::Error::InitialListFailed(e) | watcher::Error::WatchStartFailed(e) | watcher::Error::WatchFailed(e) => is_auth_failure(e),
        _ => false,
    };
    if auth || code == Some(401) {
        Failure::Unauthorized
    } else if is_terminal(code) || undecodable(err) {
        Failure::Terminal
    } else {
        Failure::Transient
    }
}

/// Exponential backoff with jitter. Unlike kube-runtime's `default_backoff`, it is not reset by the
/// `Init` event the watcher emits before every (re)list — only by a feed that stayed healthy a while.
#[derive(Default)]
struct Backoff {
    attempt: u32,
}

impl Backoff {
    const BASE: Duration = Duration::from_millis(800);
    const MAX: Duration = Duration::from_secs(60);

    fn next(&mut self) -> Duration {
        let exp = Self::BASE.saturating_mul(1u32 << self.attempt.min(7)).min(Self::MAX);
        self.attempt += 1;
        // ±20% jitter so many failing feeds do not retry in lockstep.
        let jitter = (std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.subsec_nanos()).unwrap_or(0) % 400) as f64 / 1000.0 + 0.8;
        exp.mul_f64(jitter)
    }

    fn reset(&mut self) {
        self.attempt = 0;
    }
}

/// The watch task of one feed (`run` identifies it, see [`Feed::spawn_watch`]). After a transient
/// error it backs off and starts over with a fresh watcher: the new list ends with `InitDone`, so the
/// feed reports `Ready` again — kube's own resumption could go back to watching without any event.
async fn watch(feed: Weak<Feed>, run: u64) {
    let Some((api, config, ar, hooks, cluster, layout)) = feed.upgrade().map(|f| {
        (f.api.clone(), f.config.clone(), f.api_resource.clone(), f.hooks.clone(), f.key.cluster.clone(), f.renderer.server_table().map(|t| t.layout()))
    }) else {
        return;
    };
    let mut backoff = Backoff::default();
    let mut healthy_since: Option<Instant> = None;
    loop {
        let renewal = hooks.renewal(&cluster);
        let delay = {
            let mut stream: BoxStream<'static, Result<watcher::Event<Obj>, watcher::Error>> =
                crate::watch::watcher(api.clone(), config.clone(), layout.clone()).boxed();
            let mut seen: Option<HashSet<Arc<str>>> = None;
            loop {
                let Some(event) = stream.next().await else { return };
                let Some(feed) = feed.upgrade() else { return };
                match event {
                    Ok(watcher::Event::Init) => seen = Some(HashSet::with_capacity(feed.len())),
                    Ok(watcher::Event::InitApply(obj)) => feed.apply(run, obj, &ar, seen.as_mut()),
                    Ok(watcher::Event::InitDone) => {
                        feed.finish_init(run, seen.take().unwrap_or_default());
                        healthy_since = Some(Instant::now());
                    }
                    Ok(watcher::Event::Apply(obj)) => feed.apply(run, obj, &ar, None),
                    Ok(watcher::Event::Delete(obj)) => feed.delete(run, &obj),
                    Err(err) => {
                        let (mut message, code, reason) = describe(&err);
                        let failure = classify(&err, code);
                        let unauthorized = matches!(failure, Failure::Unauthorized);
                        let k = &feed.key;
                        if undecodable(&err) {
                            message = format!(
                                "could not decode the {} the API server sent ({message}); tried again when the cluster reconnects or the view is opened again",
                                k.resource
                            );
                        }
                        match failure {
                            // Credentials were renewed while this watch was starting: retry with them.
                            Failure::Unauthorized if hooks.renewal(&cluster) != renewal => break Duration::ZERO,
                            Failure::Unauthorized | Failure::Terminal => {
                                let status = FeedStatus::Error { message: message.clone(), code, reason, terminal: true };
                                if feed.set_status(run, status, true) {
                                    tracing::info!(cluster = %k.cluster, resource = %k.resource, namespace = ?k.namespace, ?code, "watch stopped: {message}");
                                    if unauthorized {
                                        hooks.report_unauthorized(&cluster);
                                    }
                                }
                                return;
                            }
                            Failure::Transient => {
                                feed.set_status(run, FeedStatus::Error { message: message.clone(), code, reason, terminal: false }, false);
                                if healthy_since.take().is_some_and(|t| t.elapsed() >= HEALTHY_RESET) {
                                    backoff.reset();
                                }
                                let delay = backoff.next();
                                tracing::debug!(cluster = %k.cluster, resource = %k.resource, ?delay, "watch error, retrying: {message}");
                                break delay;
                            }
                        }
                    }
                }
            }
            // The stream (and its connection) and the feed are dropped here: nothing is kept alive while sleeping.
        };
        tokio::time::sleep(delay).await;
    }
}

fn describe(err: &watcher::Error) -> (String, Option<u16>, Option<String>) {
    let from_status = |s: &kube::core::Status| ((s.code != 0).then_some(s.code), (!s.reason.is_empty()).then(|| s.reason.clone()));
    match err {
        watcher::Error::InitialListFailed(e) | watcher::Error::WatchStartFailed(e) | watcher::Error::WatchFailed(e) => {
            let (code, reason) = match e {
                kube::Error::Api(s) => from_status(s),
                _ => (None, None),
            };
            (kube_message(e), code, reason)
        }
        watcher::Error::WatchError(status) => {
            let (code, reason) = from_status(status);
            (status.message.clone(), code, reason)
        }
        other => (chain(other), None, None),
    }
}

/// A view's claim on a feed. Dropping it starts the feed's idle timer.
pub struct FeedLease {
    feed: Arc<Feed>,
    reads: bool,
}

impl Deref for FeedLease {
    type Target = Feed;
    fn deref(&self) -> &Feed {
        &self.feed
    }
}

impl Drop for FeedLease {
    fn drop(&mut self) {
        if self.reads {
            self.feed.state.lock().remove_reader();
        }
        if self.feed.leases.fetch_sub(1, Ordering::AcqRel) == 1 {
            *self.feed.idle_since.lock() = Some(Instant::now());
        }
    }
}

/// How a view leases a feed.
#[derive(Clone, Copy, Debug)]
pub struct Lease {
    /// Its renderer only stands in for printer columns that could not be found for now, see
    /// [`WatchHub::lease_fallback`].
    pub fallback: bool,
    /// It shows rows, whose objects' details may be asked for — not just names: the feed keeps their JSON.
    pub objects: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HubStats {
    pub feeds: usize,
    pub active: usize,
    pub objects: usize,
    /// Object JSON kept by the feeds, in bytes.
    pub json_bytes: usize,
}

pub struct WatchHub {
    rt: Handle,
    feeds: Mutex<HashMap<FeedKey, Arc<Feed>>>,
    idle_ttl: Mutex<Duration>,
    hooks: Arc<Hooks>,
}

impl WatchHub {
    pub fn new(rt: Handle, idle_ttl: Duration) -> Self {
        Self { rt, feeds: Mutex::new(HashMap::new()), idle_ttl: Mutex::new(idle_ttl), hooks: Arc::default() }
    }

    pub fn set_idle_ttl(&self, ttl: Duration) {
        *self.idle_ttl.lock() = ttl;
    }

    /// `f(cluster)` is called (from a watch task) when a watch of `cluster` was rejected for its
    /// credentials and stopped. Once new ones are in place, [`WatchHub::restart_cluster`] resumes it.
    pub fn on_unauthorized(&self, f: impl Fn(&str) + Send + Sync + 'static) {
        *self.hooks.unauthorized.write() = Some(Arc::new(f));
    }

    /// Leases the feed for `key` for a view showing rows, starting its watch with `spec()` if it is not running yet.
    pub fn lease(&self, key: FeedKey, spec: impl FnOnce() -> FeedSpec) -> FeedLease {
        self.lease_with(key, spec, Lease { fallback: false, objects: true })
    }

    /// [`WatchHub::lease`] for a renderer that only stands in for printer columns that could not be found
    /// for now (see [`crate::cluster::Printer::found`]): a feed already watching the same version serves,
    /// whatever it renders — a passing failure neither replaces columns shown (by this view or another) nor
    /// costs a relist.
    pub fn lease_fallback(&self, key: FeedKey, spec: impl FnOnce() -> FeedSpec) -> FeedLease {
        self.lease_with(key, spec, Lease { fallback: true, objects: true })
    }

    /// Leases the feed for `key` as `how` says, starting its watch with `spec()` if it is not running yet.
    pub fn lease_with(&self, key: FeedKey, spec: impl FnOnce() -> FeedSpec, how: Lease) -> FeedLease {
        let mut feeds = self.feeds.lock();
        let spec = spec();
        let (feed, new) = match feeds.get(&key).cloned() {
            Some(feed) if feed.serves(&spec) || (how.fallback && feed.api_resource == spec.api_resource) => (feed, false),
            // New, or the resource is served differently now (another version, other printer columns after
            // a discovery refresh or reconnect): a new feed. Views still holding the old one keep it until
            // they resolve the resource again.
            _ => {
                let feed = Feed::new(key.clone(), spec, self.hooks.clone());
                feeds.insert(key, feed.clone());
                (feed, true)
            }
        };
        // Leased before its watch starts: it knows from the first object whether to keep their JSON.
        let lease = feed.acquire(how.objects);
        if new {
            feed.spawn_watch(&self.rt, false);
        } else if feed.finished.load(Ordering::Acquire) {
            // A feed that gave up (e.g. 403) gets one fresh attempt when a view asks for it again —
            // permissions may have been granted meanwhile. In place, so every view holding it benefits.
            feed.spawn_watch(&self.rt, true);
        }
        lease
    }

    /// For a reader that needs every object's JSON now (the graph of relations reads their specs): a feed that lacks some
    /// lists its objects again. Its rows stay meanwhile, and its status (no "loading" flash).
    pub fn fill_json(&self, lease: &FeedLease) {
        if lease.feed.lacks_json() {
            lease.feed.spawn_watch(&self.rt, false);
        }
    }

    /// Drops idle feeds whose TTL expired, then those idle the longest while more than [`MAX_IDLE_FEEDS`] are
    /// idle or they take more than [`IDLE_MAX_BYTES`]. Returns how many were stopped. (Only here, not as feeds
    /// start: a view coming back leases its feeds one by one, and would push the others out first.)
    pub fn reap(&self) -> usize {
        let ttl = *self.idle_ttl.lock();
        let mut feeds = self.feeds.lock();
        let before = feeds.len();
        feeds.retain(|_, f| f.idle_for().is_none_or(|idle| idle < f.idle_ttl(ttl)));
        evict_idle(&mut feeds, MAX_IDLE_FEEDS, IDLE_MAX_BYTES);
        before - feeds.len()
    }

    /// The cluster got new credentials (reconnect): its active watches start over — including those
    /// that stopped on an error — keeping their rows until the new list replaces them. Idle feeds are
    /// dropped. Returns how many watches were restarted.
    pub fn restart_cluster(&self, cluster: &str) -> usize {
        *self.hooks.renewals.lock().entry(Arc::from(cluster)).or_default() += 1;
        self.restart_where(|k| &*k.cluster == cluster, true)
    }

    /// After sleep or a network change, watches may be dead or stale: active ones start over with a
    /// fresh list (those that gave up stay stopped), idle ones are dropped. Returns how many restarted.
    pub fn resync(&self) -> usize {
        self.restart_where(|_| true, false)
    }

    fn restart_where(&self, matches: impl Fn(&FeedKey) -> bool, stopped_too: bool) -> usize {
        let mut feeds = self.feeds.lock();
        let mut restarted = 0;
        feeds.retain(|key, feed| {
            if !matches(key) {
                return true;
            }
            if feed.leases.load(Ordering::Acquire) == 0 {
                return false;
            }
            if stopped_too || !feed.finished.load(Ordering::Acquire) {
                feed.spawn_watch(&self.rt, true);
                restarted += 1;
            }
            true
        });
        restarted
    }

    /// Forgets every feed of a cluster (on disconnect). Active views keep their leases.
    pub fn drop_cluster(&self, cluster: &str) {
        self.feeds.lock().retain(|k, _| &*k.cluster != cluster);
    }

    /// The rows of a running feed for `key` — kept warm by a view or recently left — without leasing it (nor starting one).
    pub fn peek(&self, key: &FeedKey) -> Option<Vec<Arc<Row>>> {
        let feed = self.feeds.lock().get(key).cloned()?;
        (feed.status() == FeedStatus::Ready).then(|| feed.snapshot().rows)
    }

    pub fn find_object(&self, cluster: &str, resource: &str, namespace: Option<&str>, name: &str, uid: Option<&str>) -> Option<Arc<str>> {
        let feeds: Vec<Arc<Feed>> = self
            .feeds
            .lock()
            .iter()
            .filter(|(k, _)| &*k.cluster == cluster && &*k.resource == resource && (k.namespace.is_none() || k.namespace.as_deref() == namespace))
            .map(|(_, f)| f.clone())
            .collect();
        feeds.iter().find_map(|f| f.object_json(uid, name, namespace))
    }

    /// The object as a feed of the cluster that holds it lists it — a list of one, by name — or `None` if no feed
    /// holds it (or it is gone). For details of an object a feed keeps no JSON of, where RBAC grants `list` and
    /// `watch` but not `get`: the feed proves the first two. The feed keeps the JSON while the object is
    /// unchanged, as it would from its next change on. With `managed_fields`, the object keeps its
    /// `metadata.managedFields` (and the feed keeps nothing: its JSON never has them).
    pub async fn list_object(
        &self,
        cluster: &str,
        resource: &str,
        namespace: Option<&str>,
        name: &str,
        managed_fields: bool,
    ) -> Option<kube::Result<Arc<str>>> {
        let feeds: Vec<Arc<Feed>> = self
            .feeds
            .lock()
            .iter()
            .filter(|(k, _)| &*k.cluster == cluster && &*k.resource == resource && (k.namespace.is_none() || k.namespace.as_deref() == namespace))
            .map(|(_, f)| f.clone())
            .collect();
        let feed = feeds.into_iter().find(|f| f.holds(name, namespace))?;
        let mut fields = format!("metadata.name={name}");
        if feed.key.namespace.is_none()
            && let Some(ns) = namespace
        {
            fields.push_str(&format!(",metadata.namespace={ns}"));
        }
        if let Some(f) = &feed.key.fields {
            fields = format!("{f},{fields}");
        }
        let mut params = kube::api::ListParams::default().fields(&fields);
        if let Some(l) = &feed.key.labels {
            params = params.labels(l);
        }
        if managed_fields {
            // `Obj` leaves them out while parsing: listed as the full objects instead.
            let api: Api<kube::core::DynamicObject> = match &feed.key.namespace {
                Some(ns) => Api::namespaced_with(feed.api.clone().into_client(), ns, &feed.api_resource),
                None => Api::all_with(feed.api.clone().into_client(), &feed.api_resource),
            };
            let list = match api.list(&params).await {
                Ok(list) => list,
                Err(e) => return Some(Err(e)),
            };
            let found = list.items.into_iter().find(|o| o.metadata.name.as_deref() == Some(name) && o.metadata.namespace.as_deref() == namespace)?;
            let mut obj = Obj::from_value(serde_json::to_value(found).unwrap_or_default(), true);
            obj.ensure_type_meta(&feed.api_resource);
            return Some(Ok(serde_json::to_string(&obj.raw).unwrap_or_default().into()));
        }
        let list = match feed.api.list(&params).await {
            Ok(list) => list,
            Err(e) => return Some(Err(e)),
        };
        let mut obj = list.items.into_iter().find(|o| o.name() == name && o.namespace() == namespace)?;
        obj.ensure_type_meta(&feed.api_resource);
        let json: Arc<str> = serde_json::to_string(&obj.raw).unwrap_or_default().into();
        let mut st = feed.state.lock();
        if st.keeps_json(obj.uid())
            && let Some(e) = st.entries.get_mut(obj.uid())
            && e.json.is_none()
            && e.row.resource_version == obj.resource_version()
        {
            e.json = Some(json.clone());
            st.add_json(json.len());
        }
        Some(Ok(json))
    }

    pub fn stats(&self) -> HubStats {
        let feeds = self.feeds.lock();
        HubStats {
            feeds: feeds.len(),
            active: feeds.values().filter(|f| f.leases.load(Ordering::Acquire) > 0).count(),
            objects: feeds.values().map(|f| f.len()).sum(),
            json_bytes: feeds.values().map(|f| f.json_bytes()).sum(),
        }
    }
}

/// Stops the feeds idle the longest while more than `max` are idle or they take more than `bytes` in all.
fn evict_idle(feeds: &mut HashMap<FeedKey, Arc<Feed>>, max: usize, bytes: usize) {
    let mut idle: Vec<(Duration, usize, FeedKey)> = feeds.iter().filter_map(|(k, f)| f.idle_for().map(|d| (d, f.footprint(), k.clone()))).collect();
    let (mut count, mut total) = (idle.len(), idle.iter().map(|(_, b, _)| b).sum::<usize>());
    if count <= max && total <= bytes {
        return;
    }
    idle.sort_unstable_by_key(|(idle, _, _)| std::cmp::Reverse(*idle));
    for (_, size, key) in idle {
        if count <= max && total <= bytes {
            break;
        }
        feeds.remove(&key);
        (count, total) = (count - 1, total - size);
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::render;
    use crate::testing::{Reply, Server, fake};
    use std::sync::atomic::AtomicUsize;

    /// A fake API server answering every request with `status`.
    fn client_answering(status: u16, hits: Arc<AtomicUsize>) -> Client {
        let svc = tower::service_fn(move |_req: http::Request<kube::client::Body>| {
            hits.fetch_add(1, Ordering::SeqCst);
            async move {
                let body =
                    format!(r#"{{"kind":"Status","apiVersion":"v1","status":"Failure","message":"pods is forbidden","reason":"Forbidden","code":{status}}}"#);
                Ok::<_, std::convert::Infallible>(
                    http::Response::builder()
                        .status(status)
                        .header("content-type", "application/json")
                        .body(kube::client::Body::from(body.into_bytes()))
                        .unwrap(),
                )
            }
        });
        Client::new(svc, "default")
    }

    fn pods() -> ApiResource {
        ApiResource { group: "".into(), version: "v1".into(), api_version: "v1".into(), kind: "Pod".into(), plural: "pods".into() }
    }

    fn key() -> FeedKey {
        FeedKey { cluster: "test".into(), resource: "pods".into(), namespace: None, labels: None, fields: None }
    }

    async fn wait_for_error(lease: &FeedLease) -> FeedStatus {
        for _ in 0..200 {
            let st = lease.status();
            if matches!(st, FeedStatus::Error { .. }) {
                return st;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("feed never reported an error");
    }

    #[tokio::test]
    async fn forbidden_watch_stops_instead_of_retrying() {
        let hits = Arc::new(AtomicUsize::new(0));
        let hub = WatchHub::new(Handle::current(), Duration::from_secs(60));
        let lease = hub.lease(key(), || FeedSpec { client: client_answering(403, hits.clone()), api_resource: pods(), renderer: render::generic() });
        let st = wait_for_error(&lease).await;
        assert!(matches!(&st, FeedStatus::Error { code: Some(403), terminal: true, reason: Some(r), .. } if r == "Forbidden"), "{st:?}");
        tokio::time::sleep(Duration::from_millis(1500)).await;
        assert_eq!(hits.load(Ordering::SeqCst), 1, "a 403 must not be retried");

        // Leasing again (e.g. user came back to the view) gives it exactly one fresh attempt.
        drop(lease);
        let again = hub.lease(key(), || FeedSpec { client: client_answering(403, hits.clone()), api_resource: pods(), renderer: render::generic() });
        wait_for_error(&again).await;
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert_eq!(hits.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn transient_errors_back_off() {
        let hits = Arc::new(AtomicUsize::new(0));
        let hub = WatchHub::new(Handle::current(), Duration::from_secs(60));
        let lease = hub.lease(key(), || FeedSpec { client: client_answering(500, hits.clone()), api_resource: pods(), renderer: render::generic() });
        let st = wait_for_error(&lease).await;
        assert!(matches!(st, FeedStatus::Error { terminal: false, .. }), "{st:?}");
        // 0.8s, 1.6s, 3.2s… → at most 3 attempts in 2.5s (kube's default backoff would do ~3 per second here).
        tokio::time::sleep(Duration::from_millis(2500)).await;
        let n = hits.load(Ordering::SeqCst);
        assert!((2..=3).contains(&n), "expected backoff, got {n} requests");
    }

    #[tokio::test]
    async fn exec_auth_failures_reach_the_ui_sanitized() {
        use crate::error::tests::{EXEC_FAILURE, exec_failure};
        // A token refresh failing inside a request, as kube's auth layer reports it.
        let svc = tower::service_fn(|_req: http::Request<kube::client::Body>| async { Err::<http::Response<kube::client::Body>, _>(exec_failure()) });
        let hub = WatchHub::new(Handle::current(), Duration::from_secs(60));
        let lease = hub.lease(key(), || FeedSpec { client: Client::new(svc, "default"), api_resource: pods(), renderer: render::generic() });
        let st = wait_for_error(&lease).await;
        assert!(matches!(&st, FeedStatus::Error { message, .. } if *message == format!("ServiceError: {EXEC_FAILURE}")), "{st:?}");
    }

    #[test]
    fn backoff_grows_and_caps() {
        let mut b = Backoff { attempt: 0 };
        let first = b.next();
        let second = b.next();
        assert!(first >= Duration::from_millis(600) && first <= Duration::from_millis(1000));
        assert!(second > first);
        for _ in 0..20 {
            assert!(b.next() <= Backoff::MAX.mul_f64(1.2));
        }
    }

    async fn wait_for(lease: &FeedLease, what: &str, ok: impl Fn(&FeedStatus) -> bool) -> FeedStatus {
        for _ in 0..500 {
            let st = lease.status();
            if ok(&st) {
                return st;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("feed never became {what}: {:?}", lease.status());
    }

    fn names(lease: &FeedLease) -> Vec<String> {
        let mut out: Vec<String> = lease.snapshot().rows.iter().map(|r| r.name.clone()).collect();
        out.sort();
        out
    }

    #[tokio::test]
    async fn a_feed_reports_ready_again_after_a_transient_error() {
        let server = Arc::new(Server::default());
        let hub = WatchHub::new(Handle::current(), Duration::from_secs(60));
        let client = fake(server.clone(), |n| if n == 0 { Reply::Status(503) } else { Reply::Pods });
        let lease = hub.lease(key(), || FeedSpec { client, api_resource: pods(), renderer: render::generic() });
        let st = wait_for_error(&lease).await;
        assert!(matches!(st, FeedStatus::Error { code: Some(503), terminal: false, .. }), "{st:?}");
        wait_for(&lease, "ready", |s| *s == FeedStatus::Ready).await;
        assert_eq!(names(&lease), ["pod-1"]);
        // The server closes every watch after a minute, so a dead connection is noticed quickly.
        assert!(server.uris.lock().iter().any(|u| u.contains("watch=true") && u.contains("timeoutSeconds=55")), "{:?}", server.uris.lock());
    }

    #[tokio::test]
    async fn unauthorized_watches_ask_for_new_credentials_once_and_resume_after_renewal() {
        let server = Arc::new(Server::default());
        let renewed = Arc::new(AtomicBool::new(false));
        let asked = Arc::new(Mutex::new(Vec::<String>::new()));
        let hub = WatchHub::new(Handle::current(), Duration::from_secs(60));
        let a = asked.clone();
        hub.on_unauthorized(move |cluster| a.lock().push(cluster.to_string()));
        let r = renewed.clone();
        let client = fake(server.clone(), move |_| if r.load(Ordering::SeqCst) { Reply::Pods } else { Reply::Status(401) });
        let lease = hub.lease(key(), || FeedSpec { client, api_resource: pods(), renderer: render::generic() });
        let st = wait_for_error(&lease).await;
        assert!(matches!(st, FeedStatus::Error { code: Some(401), terminal: true, .. }), "{st:?}");
        tokio::time::sleep(Duration::from_millis(1200)).await;
        assert_eq!(server.lists.load(Ordering::SeqCst), 1, "a 401 is not retried with the same credentials");
        assert_eq!(*asked.lock(), ["test"]);

        // The engine reconnected (fresh token): the stopped watch starts over and keeps going.
        renewed.store(true, Ordering::SeqCst);
        assert_eq!(hub.restart_cluster("test"), 1);
        wait_for(&lease, "ready", |s| *s == FeedStatus::Ready).await;
        assert_eq!(names(&lease), ["pod-1"]);
        assert_eq!(asked.lock().len(), 1);
    }

    #[tokio::test]
    async fn resync_relists_active_feeds_keeps_their_rows_and_drops_idle_ones() {
        let server = Arc::new(Server::default());
        let hub = WatchHub::new(Handle::current(), Duration::from_secs(60));
        let client = fake(server.clone(), |_| Reply::Pods);
        let active = hub.lease(key(), || FeedSpec { client: client.clone(), api_resource: pods(), renderer: render::generic() });
        let other = FeedKey { namespace: Some("kube-system".into()), ..key() };
        let idle = hub.lease(other, || FeedSpec { client: client.clone(), api_resource: pods(), renderer: render::generic() });
        wait_for(&active, "ready", |s| *s == FeedStatus::Ready).await;
        wait_for(&idle, "ready", |s| *s == FeedStatus::Ready).await;
        drop(idle);
        let mut rx = active.snapshot().rx;
        assert_eq!(hub.resync(), 1);
        assert_eq!(hub.stats().feeds, 1);
        // Loading while the fresh list runs; the old rows stay until it replaces them.
        assert!(matches!(rx.recv().await.unwrap(), FeedEvent::Status(FeedStatus::Loading)));
        assert_eq!(active.len(), 1);
        wait_for(&active, "ready", |s| *s == FeedStatus::Ready).await;
        assert_eq!(server.lists.load(Ordering::SeqCst), 3);
        assert_eq!(active.len(), 1, "the re-list replaced the old pod: {:?}", names(&active));
    }

    #[tokio::test]
    async fn a_feed_that_gave_up_starts_over_with_the_resource_as_discovery_serves_it_now() {
        let widgets = |version: &str| ApiResource {
            group: "example.com".into(),
            version: version.into(),
            api_version: format!("example.com/{version}"),
            kind: "Widget".into(),
            plural: "widgets".into(),
        };
        let server = Arc::new(Server::default());
        let client = fake(server.clone(), |n| if n == 0 { Reply::Status(404) } else { Reply::Pods });
        let hub = WatchHub::new(Handle::current(), Duration::from_secs(60));
        let lease = hub.lease(key(), || FeedSpec { client: client.clone(), api_resource: widgets("v1beta1"), renderer: render::generic() });
        let st = wait_for_error(&lease).await;
        assert!(matches!(st, FeedStatus::Error { code: Some(404), terminal: true, .. }), "{st:?}");
        drop(lease);
        // The CRD now serves v1 (the user refreshed discovery): the next lease watches that, not v1beta1 again.
        let lease = hub.lease(key(), || FeedSpec { client: client.clone(), api_resource: widgets("v1"), renderer: render::generic() });
        wait_for(&lease, "ready", |s| *s == FeedStatus::Ready).await;
        assert!(server.uris.lock().last().unwrap().contains("/apis/example.com/v1/widgets"), "{:?}", server.uris.lock());
        assert_eq!(hub.stats().feeds, 1);
    }

    #[tokio::test]
    async fn a_running_feed_is_shared_while_the_resource_renders_alike_and_replaced_when_not() {
        use crate::render::crd::{FromCrd, PrinterColumns};
        let printer = |columns: &[&str]| -> Arc<dyn Renderer> {
            let defs: Vec<serde_json::Value> =
                columns.iter().map(|c| serde_json::json!({"name": c, "type": "string", "jsonPath": format!(".status.{c}")})).collect();
            let crd = serde_json::json!({"spec": {"versions": [{"name": "v1", "additionalPrinterColumns": defs}]}});
            match PrinterColumns::from_crd(&crd, "v1") {
                FromCrd::Complete(p) => Arc::new(p),
                _ => unreachable!(),
            }
        };
        let server = Arc::new(Server::default());
        let client = fake(server.clone(), |_| Reply::Pods);
        let hub = WatchHub::new(Handle::current(), Duration::from_secs(60));
        let first = hub.lease(key(), || FeedSpec { client: client.clone(), api_resource: pods(), renderer: printer(&["ready"]) });
        wait_for(&first, "ready", |s| *s == FeedStatus::Ready).await;
        // Printer columns found again (a reconnect): the same definitions in another renderer — the same feed.
        let again = hub.lease(key(), || FeedSpec { client: client.clone(), api_resource: pods(), renderer: printer(&["ready"]) });
        assert!(std::ptr::eq::<Feed>(&*first, &*again));
        // Other columns now (the CRD changed, discovery was refreshed): a new feed; the old one serves whoever
        // still holds it until they move over.
        let changed = hub.lease(key(), || FeedSpec { client: client.clone(), api_resource: pods(), renderer: printer(&["ready", "secret"]) });
        assert!(!std::ptr::eq::<Feed>(&*first, &*changed));
        wait_for(&changed, "ready", |s| *s == FeedStatus::Ready).await;
        assert_eq!(changed.renderer.columns().len(), 2);
        assert_eq!((server.lists.load(Ordering::SeqCst), hub.stats().feeds), (2, 1));
    }

    #[tokio::test]
    async fn a_stand_in_renderer_takes_the_running_feed_of_the_same_version() {
        use crate::render::crd::{FromCrd, PrinterColumns};
        let crd = serde_json::json!({"spec": {"versions": [{"name": "v1", "additionalPrinterColumns": [{"name": "Ready", "type": "string", "jsonPath": ".status.ready"}]}]}});
        let FromCrd::Complete(columns) = PrinterColumns::from_crd(&crd, "v1") else { unreachable!() };
        let columns: Arc<dyn Renderer> = Arc::new(columns);
        let server = Arc::new(Server::default());
        let client = fake(server.clone(), |_| Reply::Pods);
        let hub = WatchHub::new(Handle::current(), Duration::from_secs(60));
        let shown = hub.lease(key(), || FeedSpec { client: client.clone(), api_resource: pods(), renderer: columns.clone() });
        wait_for(&shown, "ready", |s| *s == FeedStatus::Ready).await;
        // Its columns could not be looked up again just now (a timeout after a reconnect): the feed stays.
        let again = hub.lease_fallback(key(), || FeedSpec { client: client.clone(), api_resource: pods(), renderer: render::generic() });
        assert!(std::ptr::eq::<Feed>(&*shown, &*again) && again.renderer.columns().len() == 1);
        // Another version is another feed, whatever renders it.
        let other = ApiResource { version: "v2".into(), api_version: "v2".into(), ..pods() };
        let moved = hub.lease_fallback(key(), || FeedSpec { client: client.clone(), api_resource: other, renderer: render::generic() });
        assert!(!std::ptr::eq::<Feed>(&*shown, &*moved));
        wait_for(&moved, "ready", |s| *s == FeedStatus::Ready).await;
        assert_eq!(server.lists.load(Ordering::SeqCst), 2);
    }

    /// A pod as a Deployment's replica set creates it: two containers, the usual probes, mounts and status.
    pub(crate) fn typical_pod(i: usize) -> serde_json::Value {
        let env: Vec<serde_json::Value> = (0..10).map(|n| serde_json::json!({"name": format!("APP_SETTING_{n}"), "value": format!("value-{n}-{i}")})).collect();
        let container = |name: &str, image: &str| {
            serde_json::json!({
                "name": name, "image": image, "imagePullPolicy": "IfNotPresent", "args": ["--port=8080", "--log-format=json", "--config=/etc/app/config.yaml"],
                "env": env, "ports": [{"name": "http", "containerPort": 8080, "protocol": "TCP"}, {"name": "metrics", "containerPort": 9090, "protocol": "TCP"}],
                "resources": {"limits": {"cpu": "1", "memory": "1Gi"}, "requests": {"cpu": "250m", "memory": "512Mi"}},
                "livenessProbe": {"httpGet": {"path": "/healthz", "port": "http", "scheme": "HTTP"}, "initialDelaySeconds": 10, "periodSeconds": 10, "timeoutSeconds": 1, "successThreshold": 1, "failureThreshold": 3},
                "readinessProbe": {"httpGet": {"path": "/ready", "port": "http", "scheme": "HTTP"}, "periodSeconds": 5, "timeoutSeconds": 1, "successThreshold": 1, "failureThreshold": 3},
                "volumeMounts": [{"name": "config", "mountPath": "/etc/app", "readOnly": true}, {"name": "tmp", "mountPath": "/tmp"}, {"name": "kube-api-access-x7k2p", "mountPath": "/var/run/secrets/kubernetes.io/serviceaccount", "readOnly": true}],
                "securityContext": {"allowPrivilegeEscalation": false, "readOnlyRootFilesystem": true, "runAsNonRoot": true, "capabilities": {"drop": ["ALL"]}},
                "terminationMessagePath": "/dev/termination-log", "terminationMessagePolicy": "File"
            })
        };
        let conditions = ["PodReadyToStartContainers", "Initialized", "Ready", "ContainersReady", "PodScheduled"]
            .map(|t| serde_json::json!({"type": t, "status": "True", "lastProbeTime": null, "lastTransitionTime": "2024-05-01T10:00:06Z"}));
        let status = |name: &str, image: &str| {
            serde_json::json!({"name": name, "image": image, "imageID": format!("docker.io/library/{image}@sha256:{:064x}", i), "containerID": format!("containerd://{:064x}", i * 7 + 1),
                               "ready": true, "started": true, "restartCount": 0, "state": {"running": {"startedAt": "2024-05-01T10:00:05Z"}}, "lastState": {}})
        };
        serde_json::json!({
            "apiVersion": "v1", "kind": "Pod",
            "metadata": {
                "name": format!("payments-api-7d9f8b6c5d-{i:05}"), "generateName": "payments-api-7d9f8b6c5d-", "namespace": "payments", "uid": format!("2c5ea4c0-4067-11e9-8bad-{i:012}"),
                "resourceVersion": format!("{}", 184_467_000 + i), "creationTimestamp": "2024-05-01T10:00:00Z",
                "labels": {"app.kubernetes.io/name": "payments-api", "app.kubernetes.io/instance": "payments", "app.kubernetes.io/version": "1.42.0", "app.kubernetes.io/part-of": "payments", "pod-template-hash": "7d9f8b6c5d", "team": "payments"},
                "annotations": {"checksum/config": format!("{:064x}", i), "prometheus.io/scrape": "true", "prometheus.io/port": "9090", "kubectl.kubernetes.io/restartedAt": "2024-05-01T09:59:58Z"},
                "ownerReferences": [{"apiVersion": "apps/v1", "kind": "ReplicaSet", "name": "payments-api-7d9f8b6c5d", "uid": "1b4f6a10-4067-11e9-8bad-0242ac110002", "controller": true, "blockOwnerDeletion": true}],
                "managedFields": [{"manager": "kube-controller-manager", "operation": "Update", "apiVersion": "v1", "time": "2024-05-01T10:00:00Z", "fieldsType": "FieldsV1", "fieldsV1": {"f:metadata": {"f:labels": {}}, "f:spec": {"f:containers": {}}}}]
            },
            "spec": {
                "containers": [container("api", "payments-api:1.42.0"), container("proxy", "envoy:1.30.1")],
                "volumes": [{"name": "config", "configMap": {"name": "payments-api", "defaultMode": 420}}, {"name": "tmp", "emptyDir": {}},
                            {"name": "kube-api-access-x7k2p", "projected": {"defaultMode": 420, "sources": [{"serviceAccountToken": {"expirationSeconds": 3607, "path": "token"}}, {"configMap": {"name": "kube-root-ca.crt", "items": [{"key": "ca.crt", "path": "ca.crt"}]}}, {"downwardAPI": {"items": [{"path": "namespace", "fieldRef": {"apiVersion": "v1", "fieldPath": "metadata.namespace"}}]}}]}}],
                "restartPolicy": "Always", "terminationGracePeriodSeconds": 30, "dnsPolicy": "ClusterFirst", "serviceAccountName": "payments-api", "serviceAccount": "payments-api",
                "nodeName": format!("node-{:03}.prod-eu-z1.example.com", i % 200), "securityContext": {"fsGroup": 2000}, "schedulerName": "default-scheduler", "priority": 0, "enableServiceLinks": true, "preemptionPolicy": "PreemptLowerPriority",
                "tolerations": [{"key": "node.kubernetes.io/not-ready", "operator": "Exists", "effect": "NoExecute", "tolerationSeconds": 300}, {"key": "node.kubernetes.io/unreachable", "operator": "Exists", "effect": "NoExecute", "tolerationSeconds": 300}]
            },
            "status": {
                "phase": "Running", "hostIP": "10.12.3.4", "podIP": format!("10.244.{}.{}", i / 250 % 250, i % 250), "podIPs": [{"ip": format!("10.244.{}.{}", i / 250 % 250, i % 250)}], "startTime": "2024-05-01T10:00:00Z", "qosClass": "Burstable",
                "conditions": conditions,
                "containerStatuses": [status("api", "payments-api:1.42.0"), status("proxy", "envoy:1.30.1")]
            }
        })
    }

    /// What one object costs a feed: its row always, its JSON while the feed keeps that.
    #[test]
    fn memory_per_object() {
        let pod: Obj = serde_json::from_value(typical_pod(1)).unwrap();
        let json = serde_json::to_string(&pod.raw).unwrap().len();
        let row = build_row(&pod.raw, render::builtin_for_key("pods").unwrap().as_ref());
        let (row, wire) = (row_size(&row), serde_json::to_string(&row).unwrap().len());
        let ns: Obj = serde_json::from_value(serde_json::json!({"apiVersion": "v1", "kind": "Namespace", "metadata": {"name": "payments", "uid": "3f1c2d4e-4067-11e9-8bad-0242ac110002", "resourceVersion": "184467001",
            "creationTimestamp": "2024-05-01T10:00:00Z", "labels": {"kubernetes.io/metadata.name": "payments", "team": "payments"}}, "spec": {"finalizers": ["kubernetes"]}, "status": {"phase": "Active"}})).unwrap();
        let ns_json = serde_json::to_string(&ns.raw).unwrap().len();
        let ns_row = row_size(&build_row(&ns.raw, render::builtin_for_key("namespaces").unwrap().as_ref()));
        eprintln!(
            "typical pod: {json} B of JSON (managedFields dropped), row ≈ {row} B in memory, {wire} B on the wire; namespace: {ns_json} B of JSON, row ≈ {ns_row} B; a feed's buffer: {} KB",
            FEED_BYTES >> 10
        );
        eprintln!(
            "30k pods: {} MB of JSON vs {} MB of rows; JSON budget: {} pods; idle feeds: {}k pods' rows",
            (json * 30_000) >> 20,
            (row * 30_000) >> 20,
            JSON_BUDGET / json,
            IDLE_MAX_BYTES / row / 1000
        );
        assert!((5_000..12_000).contains(&json), "{json}");
        assert!(row < 2_000 && json > 4 * row, "{json} vs {row}");
        // The bounds keep a feed's JSON to what a few thousand objects like it need, all feeds' to ~10k of them.
        assert!(JSON_MAX_OBJECTS * json < 2 * JSON_MAX_BYTES);
        assert!((8_000..12_000).contains(&(JSON_BUDGET / json)));
        // Idle feeds: a view of a thousand small namespaces fits, and so does one of ~100k pods.
        assert!(MAX_IDLE_FEEDS * FEED_BYTES < IDLE_MAX_BYTES && IDLE_MAX_BYTES / row > 100_000);
        assert!((64 << 10..160 << 10).contains(&FEED_BYTES), "{FEED_BYTES}");
    }

    /// What [`quiet_feed`] watches with.
    fn quiet() -> FeedSpec {
        FeedSpec { client: client_answering(403, Arc::default()), api_resource: pods(), renderer: render::builtin_for_key("pods").unwrap() }
    }

    /// A feed whose watch stopped (403), so tests apply objects to it directly.
    async fn quiet_feed(hub: &WatchHub, key: FeedKey) -> FeedLease {
        let lease = hub.lease(key, quiet);
        wait_for_error(&lease).await;
        lease
    }

    fn apply_pods(feed: &Feed, objects: impl IntoIterator<Item = serde_json::Value>) {
        let run = feed.state.lock().run;
        for o in objects {
            feed.apply(run, serde_json::from_value(o).unwrap(), &pods(), None);
        }
    }

    fn pod(i: usize, rv: &str) -> serde_json::Value {
        serde_json::json!({"metadata": {"name": format!("pod-{i}"), "namespace": "default", "uid": format!("uid-{i}"), "resourceVersion": rv}, "spec": {"nodeName": "node-1"}})
    }

    #[tokio::test]
    async fn rows_of_objects_without_a_uid_go_away_when_they_are_deleted() {
        let hub = WatchHub::new(Handle::current(), Duration::from_secs(60));
        let lease = quiet_feed(&hub, key()).await;
        let mut events = lease.tx.subscribe();
        let no_uid = serde_json::json!({"metadata": {"name": "pod-x", "namespace": "default", "resourceVersion": "1"}});
        apply_pods(&lease, [no_uid.clone(), pod(1, "1")]);
        assert_eq!(names(&lease), ["pod-1", "pod-x"]);
        let run = lease.state.lock().run;
        lease.delete(run, &serde_json::from_value(no_uid).unwrap());
        assert_eq!(names(&lease), ["pod-1"]);
        let deleted: Vec<String> = std::iter::from_fn(|| events.try_recv().ok())
            .filter_map(|e| match e {
                FeedEvent::Delete(uid) => Some(uid.to_string()),
                _ => None,
            })
            .collect();
        assert_eq!(deleted, ["default/pod-x"]);
    }

    #[tokio::test]
    async fn small_feeds_keep_object_json() {
        let hub = WatchHub::new(Handle::current(), Duration::from_secs(60));
        let lease = quiet_feed(&hub, key()).await;
        apply_pods(&lease, (0..10).map(|i| pod(i, "1")));
        let json = hub.find_object("test", "pods", Some("default"), "pod-3", None).unwrap();
        assert!(json.contains(r#""uid":"uid-3""#) && json.contains(r#""kind":"Pod""#), "{json}");
        assert_eq!(hub.stats().json_bytes, lease.json_bytes());
        assert!(lease.json_bytes() > 10 * 100);
    }

    #[tokio::test]
    async fn big_feeds_keep_rows_and_the_json_of_objects_looked_up() {
        let hub = WatchHub::new(Handle::current(), Duration::from_secs(60));
        let lease = quiet_feed(&hub, key()).await;
        apply_pods(&lease, (0..JSON_MAX_OBJECTS + 500).map(|i| pod(i, "1")));
        assert_eq!((lease.len(), lease.json_bytes()), (JSON_MAX_OBJECTS + 500, 0));
        // Not kept: fetched by the caller. From the object's next change on, the feed has it.
        assert_eq!(hub.find_object("test", "pods", Some("default"), "pod-7", Some("uid-7")), None);
        apply_pods(&lease, [pod(7, "2"), pod(8, "2")]);
        let json = hub.find_object("test", "pods", Some("default"), "pod-7", Some("uid-7")).unwrap();
        assert!(json.contains(r#""resourceVersion":"2""#));
        assert_eq!(hub.find_object("test", "pods", Some("default"), "pod-8", None), None, "not looked up before");
        // Only the latest few lookups are kept.
        for i in 100..100 + PINS {
            hub.find_object("test", "pods", Some("default"), &format!("pod-{i}"), None);
        }
        assert_eq!(lease.json_bytes(), 0, "pod-7 was looked up longest ago");
        apply_pods(&lease, (100..100 + PINS).map(|i| pod(i, "2")));
        assert!(hub.find_object("test", "pods", Some("default"), &format!("pod-{}", 100 + PINS - 1), None).is_some());
        assert!(lease.json_bytes() < PINS * 200, "{}", lease.json_bytes());
    }

    #[tokio::test]
    async fn feeds_holding_much_json_keep_rows_only() {
        let hub = WatchHub::new(Handle::current(), Duration::from_secs(60));
        let lease = quiet_feed(&hub, key()).await;
        let mut big = pod(0, "1");
        big["spec"]["blob"] = serde_json::json!("x".repeat(JSON_MAX_BYTES / 4));
        apply_pods(
            &lease,
            (0..3).map(|i| {
                let mut p = big.clone();
                p["metadata"]["uid"] = serde_json::json!(format!("uid-{i}"));
                p
            }),
        );
        assert!(lease.json_bytes() > JSON_MAX_BYTES / 2);
        apply_pods(
            &lease,
            [
                {
                    let mut p = big.clone();
                    p["metadata"]["uid"] = serde_json::json!("uid-3");
                    p
                },
                {
                    let mut p = big;
                    p["metadata"]["uid"] = serde_json::json!("uid-4");
                    p
                },
            ],
        );
        assert_eq!(lease.json_bytes(), 0);
    }

    #[tokio::test]
    async fn secrets_keep_no_json_until_looked_up() {
        let hub = WatchHub::new(Handle::current(), Duration::from_secs(60));
        let secrets = quiet_feed(&hub, FeedKey { resource: "secrets".into(), ..key() }).await;
        apply_pods(&secrets, [pod(1, "1")]);
        assert_eq!(secrets.json_bytes(), 0);
        assert_eq!(hub.find_object("test", "secrets", Some("default"), "pod-1", Some("uid-1")), None);
        apply_pods(&secrets, [pod(1, "2")]);
        assert!(hub.find_object("test", "secrets", Some("default"), "pod-1", Some("uid-1")).is_some());
    }

    fn idle_for(lease: FeedLease, how_long: Duration) {
        let feed = lease.feed.clone();
        drop(lease);
        *feed.idle_since.lock() = Some(Instant::now() - how_long);
    }

    #[tokio::test]
    async fn feeds_of_details_stop_soon_after_they_are_left() {
        let hub = WatchHub::new(Handle::current(), Duration::from_secs(180));
        let events = quiet_feed(&hub, FeedKey { resource: "events".into(), fields: Some("involvedObject.uid=uid-1".into()), ..key() }).await;
        let related = quiet_feed(&hub, FeedKey { labels: Some("app=web".into()), ..key() }).await;
        let main = quiet_feed(&hub, key()).await;
        idle_for(events, SELECTOR_IDLE_TTL + Duration::from_secs(1));
        idle_for(related, SELECTOR_IDLE_TTL - Duration::from_secs(5));
        idle_for(main, SELECTOR_IDLE_TTL + Duration::from_secs(60));
        assert_eq!(hub.reap(), 1);
        let left: HashSet<Option<Arc<str>>> = hub.feeds.lock().keys().map(|k| k.labels.clone()).collect();
        assert_eq!(left, HashSet::from([Some(Arc::from("app=web")), None]));
    }

    fn ns(i: usize) -> FeedKey {
        FeedKey { namespace: Some(format!("ns-{i}").into()), ..key() }
    }

    #[tokio::test]
    async fn idle_feeds_beyond_so_many_or_so_much_memory_stop_first_left_first() {
        let hub = WatchHub::new(Handle::current(), Duration::from_secs(3600));
        let active = quiet_feed(&hub, ns(0)).await;
        apply_pods(&active, (0..100).map(|i| pod(i, "1")));
        for i in 1..=8 {
            // ns-1 was left first (idle the longest).
            idle_for(quiet_feed(&hub, ns(i)).await, Duration::from_secs(1000 - i as u64));
        }
        let left = |hub: &WatchHub| -> Vec<usize> { (0..=8).filter(|&i| hub.feeds.lock().contains_key(&ns(i))).collect() };
        // At most 6 idle: the two left first stop. (Active feeds never do, whatever they take.)
        evict_idle(&mut hub.feeds.lock(), 6, usize::MAX);
        assert_eq!(left(&hub), [0, 3, 4, 5, 6, 7, 8]);
        // A feed left a while ago holds many rows: it stops, and so do those left before it, until the rest fit.
        let big = hub.lease(ns(5), quiet);
        apply_pods(&big, (0..2_000).map(|i| pod(i, "1")));
        idle_for(big, Duration::from_secs(1000 - 5));
        let small = hub.feeds.lock()[&ns(8)].footprint();
        assert!(hub.feeds.lock()[&ns(5)].footprint() > 2_000 * 200 + small);
        evict_idle(&mut hub.feeds.lock(), 6, 4 * small);
        assert_eq!(left(&hub), [0, 6, 7, 8]);
        drop(active);
    }

    /// Leases a feed of each of `keys` (a view of that many namespaces), all listing once they are new.
    fn view_of(hub: &WatchHub, client: &Client, keys: impl Iterator<Item = FeedKey>) -> Vec<FeedLease> {
        keys.map(|k| hub.lease(k, || FeedSpec { client: client.clone(), api_resource: pods(), renderer: render::generic() })).collect()
    }

    #[tokio::test]
    async fn a_view_left_for_another_and_back_finds_its_feeds_warm() {
        let server = Arc::new(Server::default());
        let client = fake(server.clone(), |_| Reply::Pods);
        let hub = WatchHub::new(Handle::current(), Duration::from_secs(180));
        let lists = || server.lists.load(Ordering::SeqCst);
        // Two views of 80 namespaces each (4 DCs × 20 namespaces), as strict RBAC makes them.
        let a = || (0..80).map(ns);
        let b = || (100..180).map(ns);
        let view_a = view_of(&hub, &client, a());
        until(|| hub.stats().objects == 80).await;
        // The UI closes a view before it opens the next one: B's feeds start while A's are idle.
        drop(view_a);
        let view_b = view_of(&hub, &client, b());
        until(|| hub.stats().objects == 160).await;
        hub.reap();
        assert_eq!(lists(), 160);
        // Back to A: its feeds are leased one by one (a cap applied as feeds start would push them out first).
        drop(view_b);
        let back = view_of(&hub, &client, a());
        hub.reap();
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert_eq!(lists(), 160, "no feed of A listed again");
        assert_eq!(hub.stats().feeds, 160);
        drop(back);
    }

    async fn until(ok: impl Fn() -> bool) {
        for _ in 0..500 {
            if ok() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("timed out");
    }

    #[tokio::test]
    async fn only_feeds_of_views_showing_rows_keep_json() {
        let hub = WatchHub::new(Handle::current(), Duration::from_secs(60));
        let lease = quiet_feed(&hub, key()).await;
        apply_pods(&lease, (0..10).map(|i| pod(i, "1")));
        assert!(lease.json_bytes() > 0);
        // Left (idle): its rows stay warm, their JSON goes.
        let feed = lease.feed.clone();
        drop(lease);
        assert_eq!((feed.len(), feed.json_bytes(), hub.hooks.json.used.load(Ordering::Relaxed)), (10, 0, 0));
        assert_eq!(hub.find_object("test", "pods", Some("default"), "pod-3", None), None);
        // Back: objects get their JSON again as they change.
        let back = hub.lease(key(), quiet);
        apply_pods(&back, [pod(3, "2")]);
        assert!(hub.find_object("test", "pods", Some("default"), "pod-3", None).is_some());
        assert_eq!(hub.find_object("test", "pods", Some("default"), "pod-4", None), None);
        drop(back);

        // A picker of names keeps none.
        let names = hub.lease_with(ns(1), quiet, Lease { fallback: false, objects: false });
        wait_for_error(&names).await;
        apply_pods(&names, (0..10).map(|i| pod(i, "1")));
        assert_eq!((names.len(), names.json_bytes()), (10, 0));
        // Until a view shows its rows too.
        let rows = hub.lease(ns(1), quiet);
        apply_pods(&rows, [pod(1, "2")]);
        assert!(rows.json_bytes() > 0);
    }

    #[tokio::test]
    async fn all_feeds_together_keep_a_bounded_amount_of_json() {
        let hub = WatchHub::new(Handle::current(), Duration::from_secs(60));
        let one = serde_json::to_string(&pod(0, "1")).unwrap().len() + 40;
        let budget = 1_000 * one;
        hub.hooks.json.limit.store(budget, Ordering::Relaxed);
        // 30 namespaces of 200 pods each: each far below a feed's own bounds, 6× the budget together.
        let mut leases = Vec::new();
        for i in 0..30 {
            let lease = quiet_feed(&hub, ns(i)).await;
            apply_pods(&lease, (0..200).map(|p| pod(i * 1_000 + p, "1")));
            leases.push(lease);
        }
        let stats = hub.stats();
        assert_eq!(stats.objects, 6_000);
        assert!(stats.json_bytes <= budget + 2 * one && stats.json_bytes > budget / 2, "{} of {budget}", stats.json_bytes);
        assert_eq!(stats.json_bytes, hub.hooks.json.used.load(Ordering::Relaxed));
        // Objects without JSON are fetched (and kept from their next change on, see `pin`).
        let missing = (0..30).filter(|i| hub.find_object("test", "pods", Some(&format!("ns-{i}")), "", Some(&format!("uid-{}", i * 1_000))).is_none()).count();
        assert!(missing > 20, "{missing}");
        // Details of one object (selectors) are not held back by the others.
        let events = quiet_feed(&hub, FeedKey { fields: Some("involvedObject.uid=uid-1".into()), ..ns(99) }).await;
        apply_pods(&events, (0..10).map(|p| pod(99_000 + p, "1")));
        assert!(events.json_bytes() > 0);
        // A view leaving gives the budget back; the next one keeps JSON again.
        leases.clear();
        assert_eq!(hub.hooks.json.used.load(Ordering::Relaxed), 0);
        let again = hub.lease(ns(7), quiet);
        apply_pods(&again, [pod(7_000, "2")]);
        assert!(again.json_bytes() > 0);
    }

    #[tokio::test]
    async fn details_of_an_object_a_feed_keeps_no_json_of_can_come_from_a_list_of_one() {
        use crate::render::table::fake;
        let log: fake::Log = Arc::default();
        let secret = |rv: &str| serde_json::json!({"metadata": {"name": "tls", "namespace": "default", "uid": "uid-tls", "resourceVersion": rv}, "data": {"tls.crt": "eA=="}});
        let item = secret("10").to_string();
        let client = fake::server(log.clone(), move |uri, _| {
            if uri.contains("watch=true") {
                fake::Reply::events(&[])
            } else if uri.contains("fieldSelector=metadata.name%3Dtls%2Cmetadata.namespace%3Ddefault") || !uri.contains("fieldSelector") {
                fake::Reply::json(pod_list(std::slice::from_ref(&item)))
            } else {
                fake::Reply::status(400)
            }
        });
        let hub = WatchHub::new(Handle::current(), Duration::from_secs(60));
        let secrets = FeedKey { resource: "secrets".into(), ..key() };
        let lease = hub.lease(secrets, || FeedSpec { client, api_resource: pods(), renderer: render::generic() });
        wait_for(&lease, "ready", |s| *s == FeedStatus::Ready).await;
        assert_eq!(hub.find_object("test", "secrets", Some("default"), "tls", None), None);
        assert!(hub.list_object("test", "secrets", Some("other"), "tls", false).await.is_none(), "no feed holds it");
        let json = hub.list_object("test", "secrets", Some("default"), "tls", false).await.unwrap().unwrap();
        assert!(json.contains(r#""tls.crt":"eA==""#) && json.contains(r#""kind":"Pod""#), "{json}");
        assert!(log.lock().iter().all(|(uri, _)| !uri.contains("/secrets/tls")), "no get");
        // Kept while it is the version the feed shows (it was looked up just before).
        assert_eq!(hub.find_object("test", "secrets", Some("default"), "tls", None), Some(json));
    }

    fn pod_list(items: &[String]) -> String {
        format!(r#"{{"kind":"PodList","apiVersion":"v1","metadata":{{"resourceVersion":"10"}},"items":[{}]}}"#, items.join(","))
    }

    #[tokio::test]
    async fn an_object_nested_too_deeply_does_not_fail_its_list() {
        use crate::render::table::fake;
        let deep = format!(
            r#"{{"metadata":{{"name":"deep","namespace":"default","uid":"uid-deep","resourceVersion":"10"}},"spec":{{"values":{}1{}}}}}"#,
            r#"{"a":"#.repeat(5_000),
            "}".repeat(5_000)
        );
        let list = pod_list(&[pod(1, "10").to_string(), deep, pod(2, "10").to_string()]);
        let log: fake::Log = Arc::default();
        let client =
            fake::server(log.clone(), move |uri, _| if uri.contains("watch=true") { fake::Reply::events(&[]) } else { fake::Reply::json(list.clone()) });
        let hub = WatchHub::new(Handle::current(), Duration::from_secs(60));
        let lease = hub.lease(key(), || FeedSpec { client, api_resource: pods(), renderer: render::builtin_for_key("pods").unwrap() });
        wait_for(&lease, "ready", |s| *s == FeedStatus::Ready).await;
        assert_eq!(names(&lease), ["deep", "pod-1", "pod-2"]);
        let json = hub.find_object("test", "pods", Some("default"), "deep", None).unwrap();
        assert!(json.contains(crate::object::TOO_DEEP) && json.len() < 2_000, "{json}");
    }

    #[tokio::test]
    async fn a_reader_needing_every_spec_gets_them_listed_again() {
        use crate::render::table::fake;
        let list = pod_list(&[pod(1, "10").to_string(), pod(2, "10").to_string()]);
        let log: fake::Log = Arc::default();
        let client =
            fake::server(log.clone(), move |uri, _| if uri.contains("watch=true") { fake::Reply::events(&[]) } else { fake::Reply::json(list.clone()) });
        let hub = WatchHub::new(Handle::current(), Duration::from_secs(60));
        let spec = || FeedSpec { client: client.clone(), api_resource: pods(), renderer: render::builtin_for_key("pods").unwrap() };
        // Warm from a view that needed no JSON (a problems view)…
        let first = hub.lease_with(key(), spec, Lease { fallback: false, objects: false });
        wait_for(&first, "ready", |s| *s == FeedStatus::Ready).await;
        assert!(first.objects().iter().all(|(_, json)| json.is_none()));
        // …then one that reads every spec: the objects are listed again, their rows stay meanwhile.
        let lists = log.lock().iter().filter(|(u, _)| !u.contains("watch=true")).count();
        let reader = hub.lease_with(key(), spec, Lease { fallback: false, objects: true });
        hub.fill_json(&reader);
        assert_eq!(names(&reader), ["pod-1", "pod-2"]);
        for _ in 0..200 {
            if reader.objects().iter().all(|(_, json)| json.is_some()) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert!(reader.objects().iter().all(|(_, json)| json.is_some()), "every object has its JSON");
        assert_eq!(log.lock().iter().filter(|(u, _)| !u.contains("watch=true")).count(), lists + 1);
        // Nothing lacking: nothing listed again.
        hub.fill_json(&reader);
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert_eq!(log.lock().iter().filter(|(u, _)| !u.contains("watch=true")).count(), lists + 1);
    }

    #[tokio::test]
    async fn an_answer_that_cannot_be_decoded_stops_the_watch() {
        use crate::render::table::fake;
        let log: fake::Log = Arc::default();
        let client = fake::server(log.clone(), |_, _| {
            fake::Reply::json(r#"{"kind":"PodList","apiVersion":"v1","metadata":{"resourceVersion":"10"},"items":{"not":"a list"}}"#)
        });
        let hub = WatchHub::new(Handle::current(), Duration::from_secs(60));
        let lease = hub.lease(key(), || FeedSpec { client, api_resource: pods(), renderer: render::generic() });
        let st = wait_for_error(&lease).await;
        let FeedStatus::Error { message, terminal: true, code: None, .. } = &st else { panic!("{st:?}") };
        assert!(message.starts_with("could not decode the pods the API server sent (") && message.contains("invalid type"), "{message}");
        tokio::time::sleep(Duration::from_millis(1500)).await;
        assert_eq!(log.lock().len(), 1, "not listed again and again");
        // Another try when the view is opened again.
        drop(lease);
        let _again = hub.lease(key(), || FeedSpec {
            client: fake::server(log.clone(), |_, _| fake::Reply::status(500)),
            api_resource: pods(),
            renderer: render::generic(),
        });
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert_eq!(log.lock().len(), 2);
    }

    #[tokio::test]
    async fn resync_leaves_watches_that_gave_up_alone() {
        let hits = Arc::new(AtomicUsize::new(0));
        let hub = WatchHub::new(Handle::current(), Duration::from_secs(60));
        let lease = hub.lease(key(), || FeedSpec { client: client_answering(403, hits.clone()), api_resource: pods(), renderer: render::generic() });
        wait_for_error(&lease).await;
        assert_eq!(hub.resync(), 0);
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert_eq!(hits.load(Ordering::SeqCst), 1);
    }
}
