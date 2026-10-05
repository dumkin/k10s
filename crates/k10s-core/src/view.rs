//! Views: one UI table = one resource across N clusters × M namespaces.
//!
//! A view leases the shared feeds it needs, fans their deltas into a single stream, coalesces them
//! (latest upsert wins, delete cancels upsert) and flushes at most every [`FLUSH_EVERY`] as one JSON
//! message. Clusters connect concurrently and independently: a slow or failing cluster only produces
//! a per-cluster status while the others stream normally — and joins in as soon as it can: when it
//! (re)connects or its discovery is refreshed, or by itself on a backoff timer for network trouble.
//! (Reconnects of clusters already shown restart their feeds in place; the view only resolves the resource
//! again, in case it is served differently now — another version, other printer columns.)
//!
//! Snapshots (a cluster joining, a feed replaced, a subscriber that fell behind) can be big — 120k rows are
//! ~65 MB of JSON, which the UI parsed in one go for half a second. No message carries more than
//! [`CHUNK_ROWS`] rows or about [`CHUNK_BYTES`]: a bigger snapshot goes out in chunks (`more` on all but the
//! last, which the UI keeps aside and shows at once), a flush every [`CHUNK_EVERY`], and the slot's changes
//! and status follow it. Changes of other slots do not wait behind it. Changes are split alike (a relist
//! deleting thousands of objects, a cold picker's names): each part is a delta of its own, the status follows
//! the last.
//!
//! Columns: clusters may serve different printer columns for the same resource (an operator upgraded in
//! one DC first, another served version). The view's columns are their union, keyed by column id (derived
//! from the column's name and kind, never its position), and each cluster's cells are laid out on it before
//! they are sent — so a column never shifts between clusters, and a cluster without it shows it empty.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::sync::{broadcast, mpsc};
use tokio::task::{AbortHandle, JoinSet};
use tokio::time::Instant;

use crate::cluster::{ConnState, ConnectError};
use crate::discovery::ResourceInfo;
use crate::engine::Inner;
use crate::error::Error;
use crate::feed::{Feed, FeedEvent, FeedKey, FeedLease, FeedSpec, FeedStatus, Lease};
use crate::render::{self, Column, Row, RowOut, Tone};

/// Upper bound on UI update latency; also the batching window (≈ 30 fps).
const FLUSH_EVERY: Duration = Duration::from_millis(33);
/// Rows per message at most (see the module docs)…
const CHUNK_ROWS: usize = 5_000;
/// …and about this many bytes (a message ends with the row that crosses it).
const CHUNK_BYTES: usize = 2 << 20;
/// What did not fit goes out this soon.
const CHUNK_EVERY: Duration = Duration::from_millis(10);
/// A view watches at most this many namespaces of a cluster…
const MAX_VIEW_NAMESPACES: usize = 100;
/// …and this many feeds (clusters × namespaces) in all; namespaces beyond report that they are not watched.
const MAX_VIEW_FEEDS: usize = 1_000;

/// How many namespaces of each of `clusters` clusters a view watches (see [`MAX_VIEW_FEEDS`]).
fn namespace_limit(clusters: usize) -> usize {
    (MAX_VIEW_FEEDS / clusters.max(1)).clamp(1, MAX_VIEW_NAMESPACES)
}

/// The status of a namespace beyond [`namespace_limit`].
fn not_watched(clusters: usize, limit: usize) -> FeedStatus {
    let message = if limit == MAX_VIEW_NAMESPACES {
        format!("not watched: a view watches at most {limit} namespaces")
    } else {
        format!("not watched: a view of {clusters} clusters watches at most {limit} namespaces of each")
    };
    FeedStatus::Error { message, code: None, reason: None, terminal: true }
}
/// First retry of a cluster that could not be reached (network trouble); doubles up to [`RETRY_MAX`].
const RETRY_BASE: Duration = Duration::from_secs(5);
const RETRY_MAX: Duration = Duration::from_secs(120);

/// Receives one serialized JSON message; returns `false` once the receiver is gone.
pub type Sink = Arc<dyn Fn(String) -> bool + Send + Sync>;

/// What a view streams for each object.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Projection {
    /// Full table rows (cells, tone, labels…).
    #[default]
    Rows,
    /// Only names, and only when the set of names changes — updates to existing objects cost
    /// nothing. For pickers over lists that reach tens of thousands of objects (the namespaces of
    /// a fleet of clusters), where full rows would flood the UI.
    Names,
    /// Rows of objects that are not fine only ([`is_problem`]): an object that becomes fine is deleted from the
    /// view, one that stops being fine added. For a fleet's "needs attention" overview, which would otherwise take
    /// every pod of every cluster to find the few failing.
    Problems,
}

/// Whether a row shows in a [`Projection::Problems`] view: failing or degraded (a warning or error tone), in
/// progress (pending, creating, a job running: the UI tells by their age whether that is too long), or being deleted.
pub fn is_problem(row: &Row) -> bool {
    matches!(row.tone, Tone::Warn | Tone::Error | Tone::Info) || row.terminating
}

/// Keeps the problems of `p` for a [`Projection::Problems`] slot: a new snapshot's (what the UI was told of starts
/// over), changes of objects that are or were problems — one that stopped being one is deleted in the UI.
fn keep_problems(slot: &mut Slot, p: &mut Pending) {
    if let Some(Snapshot::Rows(rows)) = &mut p.reset
        && p.sent == 0
    {
        rows.retain(|r| is_problem(r));
        slot.sent.clear();
        slot.sent.extend(rows.iter().map(|r| (r.uid.clone(), Arc::from(""))));
    }
    // Deleted objects the UI was never told of (they were fine) are no news to it.
    p.del.retain(|uid| slot.sent.remove(uid).is_some());
    for (uid, row) in std::mem::take(&mut p.up) {
        if is_problem(&row) {
            slot.sent.insert(uid.clone(), Arc::from(""));
            p.up.insert(uid, row);
        } else if slot.sent.remove(&uid).is_some() {
            // Fine again: out of the view.
            p.del.insert(uid);
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewSpec {
    /// Resource key (`deployments.apps`) or any name discovery resolves (`deploy`, `Deployment`).
    pub resource: String,
    pub clusters: Vec<String>,
    /// Empty = all namespaces.
    #[serde(default)]
    pub namespaces: Vec<String>,
    #[serde(default)]
    pub label_selector: Option<String>,
    #[serde(default)]
    pub field_selector: Option<String>,
    #[serde(default)]
    pub projection: Projection,
}

impl ViewSpec {
    /// Short human description for logs: `pods × 8 clusters × [payments]`.
    pub fn describe(&self) -> String {
        let clusters = match self.clusters.as_slice() {
            [one] => one.clone(),
            many => format!("{} clusters", many.len()),
        };
        let mut out = format!("{} × {clusters}", self.resource);
        if !self.namespaces.is_empty() {
            out.push_str(&format!(" × [{}]", self.namespaces.join(",")));
        }
        for sel in [&self.label_selector, &self.field_selector].into_iter().flatten().filter(|s| !s.is_empty()) {
            out.push_str(&format!(" ({sel})"));
        }
        match self.projection {
            Projection::Names => out.push_str(" [names]"),
            Projection::Problems => out.push_str(" [problems]"),
            Projection::Rows => {}
        }
        out
    }
}

enum Incoming {
    Resolved {
        cluster: Arc<str>,
        /// The cluster's connection when it was resolved.
        seen: Option<(u64, Phase)>,
        info: Arc<ResourceInfo>,
        /// Why kind-specific columns are missing, and whether asking again later may help.
        notice: Option<Arc<str>>,
        retry: bool,
        /// Their columns are those of each feed's renderer.
        leases: Vec<FeedLease>,
        /// Namespaces asked for but not watched (beyond [`namespace_limit`]).
        skipped: Vec<Arc<str>>,
    },
    Failed {
        cluster: Arc<str>,
        error: Error,
    },
    /// From the forwarder `fwd` of slot `idx` (events of a forwarder the slot replaced are dropped).
    Event {
        idx: usize,
        fwd: u64,
        event: FeedEvent,
    },
    Lagged {
        idx: usize,
        fwd: u64,
    },
}

/// What replaces a slot's rows in the UI.
enum Snapshot {
    Rows(Vec<Arc<Row>>),
    /// Names projection: the names of a snapshot of rows, being sent.
    Names(Vec<Arc<str>>),
}

impl Snapshot {
    fn len(&self) -> usize {
        match self {
            Snapshot::Rows(r) => r.len(),
            Snapshot::Names(n) => n.len(),
        }
    }
}

#[derive(Default)]
struct Pending {
    reset: Option<Snapshot>,
    /// How much of `reset` the UI was sent already (it keeps that aside until the last chunk). Changes and
    /// status wait until all of it is out.
    sent: usize,
    up: HashMap<Arc<str>, Arc<Row>>,
    del: HashSet<Arc<str>>,
    /// Names projection: name changes worked out already, not sent yet (more than one message carries).
    names: Option<NamesDelta>,
    status: Option<FeedStatus>,
}

impl Pending {
    fn is_empty(&self) -> bool {
        self.reset.is_none() && self.up.is_empty() && self.del.is_empty() && self.names.is_none() && self.status.is_none()
    }

    /// A feed's snapshot: what it has now, then its changes.
    fn snapshot(rows: Vec<Arc<Row>>, status: FeedStatus) -> Self {
        Pending { reset: Some(Snapshot::Rows(rows)), status: Some(status), ..Default::default() }
    }

    fn push(&mut self, event: FeedEvent) {
        match event {
            FeedEvent::Upsert(row) => {
                self.del.remove(&row.uid);
                self.up.insert(row.uid.clone(), row);
            }
            FeedEvent::Delete(uid) => {
                self.up.remove(&uid);
                self.del.insert(uid);
            }
            FeedEvent::Status(s) => self.status = Some(s),
        }
    }
}

#[derive(Serialize)]
struct RowsMsg<'a> {
    t: &'static str,
    c: &'a str,
    ns: Option<&'a str>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    reset: bool,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    up: Vec<RowOut<'a>>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    del: Vec<&'a str>,
}

#[derive(Serialize)]
struct NamesMsg<'a> {
    t: &'static str,
    c: &'a str,
    ns: Option<&'a str>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    reset: bool,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    up: Vec<&'a str>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    del: Vec<&'a str>,
}

#[derive(Serialize)]
struct StatusMsg<'a> {
    t: &'static str,
    c: &'a str,
    ns: Option<&'a str>,
    #[serde(flatten)]
    status: &'a FeedStatus,
}

#[derive(Serialize)]
struct SchemaMsg<'a> {
    t: &'static str,
    columns: &'a [Column],
}

#[derive(Serialize)]
struct ResolvedMsg<'a> {
    t: &'static str,
    c: &'a str,
    resource: &'a ResourceInfo,
    /// Why the cluster shows no kind-specific columns (`printer columns unavailable: …`).
    #[serde(skip_serializing_if = "Option::is_none")]
    notice: Option<&'a str>,
}

fn json(v: &impl Serialize) -> String {
    serde_json::to_string(v).unwrap_or_default()
}

fn status_msg(cluster: &str, ns: Option<&str>, status: &FeedStatus) -> String {
    json(&StatusMsg { t: "status", c: cluster, ns, status })
}

struct Slot {
    cluster: Arc<str>,
    namespace: Option<Arc<str>>,
    /// `None` once the cluster's resource resolved to another feed (see [`replace_feeds`]), until the slot
    /// shows the next feed of its cluster and namespace.
    lease: Option<FeedLease>,
    map: CellMap,
    forwarder: Option<AbortHandle>,
    /// Which forwarder is the current one (see [`Incoming::Event`]).
    fwd: u64,
    /// Names projection: uid → name of every object the UI has been told about.
    sent: HashMap<Arc<str>, Arc<str>>,
}

/// Where a feed's cells go among the view's columns (`None`: they line up), see [`Schema::merge`].
type CellMap = Option<Arc<[Option<usize>]>>;

/// The view's columns: those of its clusters, merged by column id, in order of first appearance. Only ever
/// appended to, so rows sent earlier stay aligned (a row without a later column shows it empty).
#[derive(Default)]
struct Schema(Vec<Column>);

impl Schema {
    /// Adds one cluster's columns. Returns whether the view's columns changed, and where that cluster's cells
    /// go: `map[i]` is the index of its cell for column `i` (`None` when they line up as they are).
    fn merge(&mut self, columns: &[Column]) -> (bool, CellMap) {
        let mut changed = false;
        for c in columns {
            match self.0.iter_mut().find(|u| u.id == c.id) {
                Some(u) => {
                    // Shown by default if any cluster shows it by default.
                    if u.hidden && !c.hidden {
                        u.hidden = false;
                        changed = true;
                    }
                    if u.description.is_none() && c.description.is_some() {
                        u.description = c.description.clone();
                        changed = true;
                    }
                }
                None => {
                    self.0.push(c.clone());
                    changed = true;
                }
            }
        }
        let mut map: Vec<Option<usize>> = self.0.iter().map(|u| columns.iter().position(|c| c.id == u.id)).collect();
        while map.last() == Some(&None) {
            map.pop();
        }
        let aligned = map.len() == columns.len() && map.iter().enumerate().all(|(i, j)| *j == Some(i));
        (changed, (!aligned).then(|| map.into()))
    }
}

fn same_feed(a: &FeedLease, b: &FeedLease) -> bool {
    std::ptr::eq::<Feed>(&**a, &**b)
}

/// Name additions and removals for one slot.
#[derive(Debug, Default, PartialEq)]
struct NamesDelta {
    reset: bool,
    up: Vec<Arc<str>>,
    del: Vec<Arc<str>>,
}

impl NamesDelta {
    /// Adds later changes to these (not sent yet). The UI removes a message's names before it adds its new ones
    /// and ignores removals of names it does not have, so a name added here and removed later is dropped from both:
    /// every removal left is of a name the UI was sent.
    fn merge(&mut self, later: NamesDelta) {
        if self.up.is_empty() || later.del.is_empty() {
            self.del.extend(later.del);
        } else {
            let mut unsent: HashMap<Arc<str>, usize> = HashMap::new();
            for name in &self.up {
                *unsent.entry(name.clone()).or_default() += 1;
            }
            let mut cancelled: HashMap<Arc<str>, usize> = HashMap::new();
            for name in later.del {
                match unsent.get_mut(&name) {
                    Some(n) if *n > 0 => {
                        *n -= 1;
                        *cancelled.entry(name).or_default() += 1;
                    }
                    _ => self.del.push(name),
                }
            }
            self.up.retain(|name| match cancelled.get_mut(name) {
                Some(n) if *n > 0 => {
                    *n -= 1;
                    false
                }
                _ => true,
            });
        }
        self.up.extend(later.up);
    }
}

/// Turns coalesced row changes into name changes. Updates that keep an object's name produce
/// nothing. Names are reported once per object (the UI counts them), so equal names in different
/// namespaces of a cluster-wide feed stay correct.
fn name_changes(sent: &mut HashMap<Arc<str>, Arc<str>>, p: &Pending) -> Option<NamesDelta> {
    let name_of = |row: &Row| -> Arc<str> { Arc::from(row.name.as_str()) };
    if let Some(Snapshot::Rows(rows)) = &p.reset {
        sent.clear();
        sent.extend(rows.iter().map(|r| (r.uid.clone(), name_of(r))));
        for uid in &p.del {
            sent.remove(uid);
        }
        for (uid, row) in &p.up {
            sent.insert(uid.clone(), name_of(row));
        }
        return Some(NamesDelta { reset: true, up: sent.values().cloned().collect(), del: Vec::new() });
    }
    let mut delta = NamesDelta::default();
    for uid in &p.del {
        if let Some(name) = sent.remove(uid) {
            delta.del.push(name);
        }
    }
    for (uid, row) in &p.up {
        if sent.get(uid).is_some_and(|name| **name == *row.name) {
            continue;
        }
        let name = name_of(row);
        if let Some(old) = sent.insert(uid.clone(), name.clone()) {
            delta.del.push(old);
        }
        delta.up.push(name);
    }
    (!delta.up.is_empty() || !delta.del.is_empty()).then_some(delta)
}

/// A cluster's connection as last seen by a view: its generation and phase.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Phase {
    Connecting,
    Ready,
    Failed,
}

fn observe(inner: &Inner, cluster: &str) -> (Option<(u64, Phase)>, Option<ConnectError>) {
    match inner.clusters.state(cluster) {
        None => (None, None),
        Some((g, ConnState::Connecting)) => (Some((g, Phase::Connecting)), None),
        Some((g, ConnState::Ready)) => (Some((g, Phase::Ready)), None),
        Some((g, ConnState::Failed(err))) => (Some((g, Phase::Failed)), Some(err)),
    }
}

/// Where one cluster of a view stands. `failures` counts consecutive failed resolutions (for backoff).
#[derive(Debug, PartialEq)]
enum Track {
    Resolving {
        failures: u32,
    },
    /// Shows its rows. Resolved again when its connection changes (`seen` is what it was when resolved: a
    /// reconnect or discovery refresh may bring other printer columns or another version), and at
    /// `retry_at` when its printer columns could not be found for a reason that may pass.
    Resolved {
        seen: Option<(u64, Phase)>,
        retry_at: Option<Instant>,
        failures: u32,
    },
    /// Could not resolve. Tried again when the cluster's connection changes (`seen` is what it was),
    /// and at `retry_at` when the failure was network trouble.
    Failed {
        seen: Option<(u64, Phase)>,
        retry_at: Option<Instant>,
        failures: u32,
    },
}

impl Track {
    fn retry_at(&self) -> Option<Instant> {
        match self {
            Track::Failed { retry_at, .. } | Track::Resolved { retry_at, .. } => *retry_at,
            Track::Resolving { .. } => None,
        }
    }
}

fn retry_delay(failures: u32) -> Duration {
    RETRY_BASE.saturating_mul(1 << failures.saturating_sub(1).min(5)).min(RETRY_MAX)
}

fn error_status(error: &Error, terminal: bool) -> FeedStatus {
    FeedStatus::Error { message: error.message(), code: error.code(), reason: error.reason(), terminal }
}

/// A resolution failed: the cluster-level status to show and what to wait for.
fn on_failed(inner: &Inner, cluster: &str, error: &Error, failures: u32) -> (FeedStatus, Track) {
    let (seen, failure) = observe(inner, cluster);
    // Only connection failures from network trouble retry on a timer; anything else (auth, RBAC,
    // a resource the cluster does not serve) waits for the cluster to change.
    let retryable = matches!(error, Error::Connect { .. }) && failure.is_some_and(|f| f.retryable);
    let retry_at = retryable.then(|| Instant::now() + retry_delay(failures));
    (error_status(error, !retryable), Track::Failed { seen, retry_at, failures })
}

/// A cluster's connection changed (or `resync`: the computer woke up / the network changed). Failed
/// clusters that are connected now resolve again; the others show what their connection is doing.
/// Resolved clusters that reconnected or had their discovery refreshed resolve again quietly (their rows
/// stay). Returns the clusters to resolve, and whether quietly.
fn on_change(inner: &Inner, tracks: &mut HashMap<Arc<str>, Track>, resync: bool, extra: &mut Vec<String>) -> Vec<(Arc<str>, bool)> {
    let mut resolve = Vec::new();
    for (cluster, track) in tracks.iter_mut() {
        if let Track::Resolved { seen, retry_at, failures } = track {
            let (now, _) = observe(inner, cluster);
            if now != *seen && matches!(now, Some((_, Phase::Ready))) {
                resolve.push((cluster.clone(), true));
                *track = Track::Resolving { failures: *failures };
            } else if resync && retry_at.is_some() {
                *retry_at = Some(Instant::now());
            }
            continue;
        }
        let Track::Failed { seen, retry_at, failures } = track else { continue };
        let (now, failure) = observe(inner, cluster);
        if now != *seen {
            *seen = now;
            match (now.map(|(_, p)| p), failure) {
                (Some(Phase::Ready), _) => {
                    resolve.push((cluster.clone(), false));
                    *track = Track::Resolving { failures: *failures };
                    continue;
                }
                (Some(Phase::Connecting), _) => {
                    *retry_at = None;
                    extra.push(status_msg(cluster, None, &FeedStatus::Connecting));
                }
                (Some(Phase::Failed), Some(err)) => {
                    let retryable = err.retryable;
                    *retry_at = retryable.then(|| Instant::now() + retry_delay(*failures));
                    extra.push(status_msg(cluster, None, &error_status(&err.into_error(cluster), !retryable)));
                }
                _ => {}
            }
        }
        if resync && retry_at.is_some() {
            *retry_at = Some(Instant::now());
        }
    }
    resolve
}

pub(crate) async fn run(inner: Arc<Inner>, spec: ViewSpec, sink: Sink) {
    let spec = Arc::new(spec);
    let names = spec.projection == Projection::Names;
    let (tx, mut rx) = mpsc::unbounded_channel::<Incoming>();
    let mut tasks = JoinSet::new();
    let mut slots: Vec<Slot> = Vec::new();
    let mut pending: Vec<Pending> = Vec::new();
    let mut extra: Vec<String> = Vec::new();
    let mut schema = Schema::default();
    let mut tracks: HashMap<Arc<str>, Track> = HashMap::new();
    let mut changes = inner.clusters.changes();
    let mut resyncs = changes.borrow_and_update().resyncs;
    let mut watching = true;

    // Built-in kinds have a static schema: let the UI draw headers before any cluster answers. (The names
    // projection has no columns.)
    if !names && let Some(r) = render::builtin_for_key(&spec.resource) {
        schema.merge(r.columns());
        extra.push(json(&SchemaMsg { t: "schema", columns: &schema.0 }));
    }

    let mut seen = HashSet::new();
    let clusters: Vec<&String> = spec.clusters.iter().filter(|c| seen.insert(c.as_str())).collect();
    let ns_limit = namespace_limit(clusters.len());
    for cluster in clusters {
        let cluster: Arc<str> = Arc::from(cluster.as_str());
        if inner.clusters.get(&cluster).is_none() {
            extra.push(status_msg(&cluster, None, &FeedStatus::Connecting));
        }
        tracks.insert(cluster.clone(), Track::Resolving { failures: 0 });
        tasks.spawn(resolve(inner.clone(), cluster, spec.clone(), ns_limit, tx.clone()));
    }
    let mut deadline: Option<Instant> = match flush(&sink, &mut extra, &mut slots, &mut pending, spec.projection, LIMITS) {
        Flushed::Gone => return,
        Flushed::All => None,
        Flushed::Some => Some(Instant::now() + CHUNK_EVERY),
    };
    loop {
        let timer = async {
            match deadline {
                Some(d) => tokio::time::sleep_until(d).await,
                None => std::future::pending().await,
            }
        };
        let next_retry = tracks.values().filter_map(Track::retry_at).min();
        let retry = async {
            match next_retry {
                Some(t) => tokio::time::sleep_until(t).await,
                None => std::future::pending().await,
            }
        };
        // Clusters to resolve (again), and whether quietly: their rows are shown meanwhile.
        let mut again: Vec<(Arc<str>, bool)> = Vec::new();
        tokio::select! {
            msg = rx.recv() => {
                let Some(msg) = msg else { return };
                match msg {
                    Incoming::Resolved { cluster, seen, info, notice, retry, leases, skipped } => {
                        for ns in &skipped {
                            extra.push(status_msg(&cluster, Some(ns), &not_watched(tracks.len(), ns_limit)));
                        }
                        // First data of a cluster is painted right away; batching is for churn.
                        deadline = Some(Instant::now());
                        // Printer columns that could not be found for now are asked for again, with backoff.
                        let failures = match tracks.get(&cluster) {
                            Some(Track::Resolving { failures }) if retry => failures + 1,
                            _ => u32::from(retry),
                        };
                        let retry_at = retry.then(|| Instant::now() + retry_delay(failures));
                        tracks.insert(cluster.clone(), Track::Resolved { seen, retry_at, failures });
                        // Its connection changed while it resolved (discovery refreshed, a reconnect): that change
                        // went by unseen, so it resolves again now.
                        let now = observe(&inner, &cluster).0;
                        if now != seen && matches!(now, Some((_, Phase::Ready))) {
                            again.push((cluster.clone(), true));
                            tracks.insert(cluster.clone(), Track::Resolving { failures });
                        }
                        let mut leases: Vec<(FeedLease, CellMap)> = leases.into_iter().map(|l| (l, None)).collect();
                        if !names {
                            let mut changed = false;
                            for (lease, map) in &mut leases {
                                let (c, m) = schema.merge(lease.renderer.columns());
                                changed |= c;
                                *map = m;
                            }
                            if changed {
                                extra.push(json(&SchemaMsg { t: "schema", columns: &schema.0 }));
                            }
                            extra.push(json(&ResolvedMsg { t: "resolved", c: &cluster, resource: &info, notice: notice.as_deref() }));
                        }
                        let feeds = Feeds { tasks: &mut tasks, tx: &tx, slots: &mut slots, pending: &mut pending };
                        replace_feeds(feeds, &cluster, leases, names, &mut extra);
                    }
                    Incoming::Failed { cluster, error } => {
                        if slots.iter().any(|s| s.cluster == cluster && s.lease.is_some()) {
                            // Resolving a shown cluster again failed (it is reconnecting, the resource is not
                            // served any more…): its feeds stay and report for themselves; the next change of
                            // its connection tries again.
                            tracing::debug!(%cluster, error = %error.message(), "could not resolve the view's resource again");
                            tracks.insert(cluster.clone(), Track::Resolved { seen: observe(&inner, &cluster).0, retry_at: None, failures: 0 });
                        } else {
                            let failures = match tracks.get(&cluster) {
                                Some(Track::Resolving { failures }) => failures + 1,
                                _ => 1,
                            };
                            let (status, track) = on_failed(&inner, &cluster, &error, failures);
                            extra.push(status_msg(&cluster, None, &status));
                            tracks.insert(cluster, track);
                        }
                    }
                    Incoming::Event { idx, fwd, event } => {
                        if slots[idx].fwd == fwd && slots[idx].lease.is_some() {
                            pending[idx].push(event);
                        }
                    }
                    Incoming::Lagged { idx, fwd } => {
                        let slot = &mut slots[idx];
                        if slot.fwd == fwd
                            && let Some(lease) = &slot.lease
                        {
                            let snap = lease.snapshot();
                            pending[idx] = Pending::snapshot(snap.rows, snap.status);
                            slot.fwd += 1;
                            slot.forwarder = Some(tasks.spawn(forward(idx, slot.fwd, snap.rx, tx.clone())));
                        }
                    }
                }
                let now = Instant::now();
                match deadline {
                    None => deadline = Some(now + FLUSH_EVERY),
                    // Keep flushing on schedule even under a continuous flood of events.
                    Some(d) if now >= d => {
                        deadline = match flush(&sink, &mut extra, &mut slots, &mut pending, spec.projection, LIMITS) {
                            Flushed::Gone => return,
                            Flushed::All => None,
                            Flushed::Some => Some(now + CHUNK_EVERY),
                        };
                    }
                    _ => {}
                }
            }
            changed = changes.changed(), if watching => {
                if changed.is_err() {
                    watching = false;
                    continue;
                }
                let now = *changes.borrow_and_update();
                let resync = std::mem::replace(&mut resyncs, now.resyncs) != now.resyncs;
                again = on_change(&inner, &mut tracks, resync, &mut extra);
            }
            _ = retry => {
                let now = Instant::now();
                for (cluster, track) in tracks.iter_mut() {
                    let quiet = matches!(track, Track::Resolved { .. });
                    if let Track::Failed { retry_at: Some(t), failures, .. } | Track::Resolved { retry_at: Some(t), failures, .. } = track && *t <= now {
                        // Printer columns are asked for again only while connected: resolving starts a connection
                        // attempt otherwise (with its auth plugin). Its next connection does it.
                        if quiet && !matches!(observe(&inner, cluster).0, Some((_, Phase::Ready))) {
                            *t = now + RETRY_MAX;
                            continue;
                        }
                        again.push((cluster.clone(), quiet));
                        *track = Track::Resolving { failures: *failures };
                    }
                }
            }
            _ = timer => {
                deadline = match flush(&sink, &mut extra, &mut slots, &mut pending, spec.projection, LIMITS) {
                    Flushed::Gone => return,
                    Flushed::All => None,
                    Flushed::Some => Some(Instant::now() + CHUNK_EVERY),
                };
            }
        }
        for (cluster, quiet) in again {
            if !quiet {
                extra.push(status_msg(&cluster, None, &FeedStatus::Connecting));
            }
            tasks.spawn(resolve(inner.clone(), cluster, spec.clone(), ns_limit, tx.clone()));
        }
        // Finished resolutions and forwarders are kept by the set until collected.
        while tasks.try_join_next().is_some() {}
        if !extra.is_empty() && deadline.is_none() {
            deadline = Some(Instant::now());
        }
    }
}

/// What [`replace_feeds`] works on.
struct Feeds<'a> {
    tasks: &'a mut JoinSet<()>,
    tx: &'a mpsc::UnboundedSender<Incoming>,
    slots: &'a mut Vec<Slot>,
    pending: &'a mut Vec<Pending>,
}

/// A cluster resolved (again): its feeds become `leases` (each with where its cells go among the view's
/// columns). Feeds it already shows are kept as they are; others replace them (another version or other
/// printer columns: their rows are sent anew), in the slot of the feed they replace, and rows of feeds
/// without a successor are cleared in the UI.
fn replace_feeds(f: Feeds, cluster: &Arc<str>, leases: Vec<(FeedLease, CellMap)>, names: bool, extra: &mut Vec<String>) {
    let mut old: Vec<usize> = (0..f.slots.len()).filter(|&i| f.slots[i].cluster == *cluster && f.slots[i].lease.is_some()).collect();
    let mut new = Vec::new();
    for (lease, map) in leases {
        if let Some(pos) = old.iter().position(|&i| f.slots[i].lease.as_ref().is_some_and(|l| same_feed(l, &lease))) {
            // Already shown; the extra lease is dropped.
            old.swap_remove(pos);
            continue;
        }
        new.push((lease, map));
    }
    for &i in &old {
        let slot = &mut f.slots[i];
        slot.lease = None;
        if let Some(forwarder) = slot.forwarder.take() {
            forwarder.abort();
        }
        slot.sent.clear();
        f.pending[i] = Pending::default();
    }
    for (lease, map) in new {
        let snap = lease.snapshot();
        let namespace = lease.key.namespace.clone();
        let idx = match f.slots.iter().position(|s| s.lease.is_none() && s.cluster == *cluster && s.namespace == namespace) {
            Some(idx) => idx,
            None => {
                f.slots.push(Slot { cluster: cluster.clone(), namespace, lease: None, map: None, forwarder: None, fwd: 0, sent: HashMap::new() });
                f.pending.push(Pending::default());
                f.slots.len() - 1
            }
        };
        let slot = &mut f.slots[idx];
        // Events of the forwarder this slot had may still be queued: the new one's are told apart.
        slot.fwd += 1;
        slot.forwarder = Some(f.tasks.spawn(forward(idx, slot.fwd, snap.rx, f.tx.clone())));
        (slot.lease, slot.map) = (Some(lease), map);
        slot.sent.clear();
        f.pending[idx] = Pending::snapshot(snap.rows, snap.status);
    }
    for i in old {
        let ns = f.slots[i].namespace.clone();
        if !f.slots.iter().any(|s| s.lease.is_some() && s.cluster == *cluster && s.namespace == ns) {
            extra.push(if names {
                json(&NamesMsg { t: "names", c: cluster, ns: ns.as_deref(), reset: true, up: Vec::new(), del: Vec::new() })
            } else {
                json(&RowsMsg { t: "rows", c: cluster, ns: ns.as_deref(), reset: true, up: Vec::new(), del: Vec::new() })
            });
        }
    }
}

async fn resolve(inner: Arc<Inner>, cluster: Arc<str>, spec: Arc<ViewSpec>, ns_limit: usize, tx: mpsc::UnboundedSender<Incoming>) {
    let result = async {
        let c = inner.connect(&cluster, false).await?;
        let connection = observe(&inner, &cluster).0;
        let info = c.resolve(&spec.resource)?;
        if !info.can("list") {
            return Err(Error::Unsupported(format!("{} cannot be listed", info.key)));
        }
        let mut namespaces: Vec<Option<Arc<str>>> = if !info.namespaced || spec.namespaces.is_empty() {
            vec![None]
        } else {
            let mut seen = HashSet::new();
            spec.namespaces.iter().filter(|n| seen.insert(n.as_str())).map(|n| Some(Arc::from(n.as_str()))).collect()
        };
        let skipped: Vec<Arc<str>> = namespaces.split_off(namespaces.len().min(ns_limit)).into_iter().flatten().collect();
        let printer = c.printer_for(&info, &namespaces).await;
        let renderer = printer.renderer.clone();
        let resource: Arc<str> = Arc::from(info.key.as_str());
        let labels = spec.label_selector.as_deref().filter(|s| !s.is_empty()).map(Arc::from);
        let fields = spec.field_selector.as_deref().filter(|s| !s.is_empty()).map(Arc::from);
        // Columns that could not be looked up just now (a timeout right after a reconnect…) do not replace those a
        // running feed shows: it stays, until they are found. A picker of names reads no objects (their JSON is not
        // kept for it).
        let how = Lease { fallback: !printer.found, objects: spec.projection == Projection::Rows };
        let leases: Vec<FeedLease> = namespaces
            .into_iter()
            .map(|namespace| {
                let key = FeedKey { cluster: cluster.clone(), resource: resource.clone(), namespace, labels: labels.clone(), fields: fields.clone() };
                inner.hub.lease_with(key, || FeedSpec { client: c.client.clone(), api_resource: info.api_resource(), renderer: renderer.clone() }, how)
            })
            .collect();
        // Why columns are missing, unless running feeds show some after all.
        let stand_in = leases.iter().any(|l| render::same(&l.renderer, &printer.renderer) || l.renderer.columns().is_empty());
        Ok((connection, info, printer.notice.filter(|_| stand_in), printer.retry, leases, skipped))
    }
    .await;
    let _ = tx.send(match result {
        Ok((seen, info, notice, retry, leases, skipped)) => Incoming::Resolved { cluster, seen, info, notice, retry, leases, skipped },
        Err(error) => Incoming::Failed { cluster, error },
    });
}

async fn forward(idx: usize, fwd: u64, mut rx: broadcast::Receiver<FeedEvent>, tx: mpsc::UnboundedSender<Incoming>) {
    loop {
        match rx.recv().await {
            Ok(event) => {
                if tx.send(Incoming::Event { idx, fwd, event }).is_err() {
                    return;
                }
            }
            Err(broadcast::error::RecvError::Lagged(_)) => {
                let _ = tx.send(Incoming::Lagged { idx, fwd });
                return;
            }
            Err(broadcast::error::RecvError::Closed) => return,
        }
    }
}

/// How much one message may carry, see [`CHUNK_ROWS`] and [`CHUNK_BYTES`].
#[derive(Clone, Copy)]
struct Limits {
    rows: usize,
    bytes: usize,
}

const LIMITS: Limits = Limits { rows: CHUNK_ROWS, bytes: CHUNK_BYTES };

/// What [`flush`] did.
#[derive(Debug, PartialEq)]
enum Flushed {
    /// The receiver is gone.
    Gone,
    /// Sent everything pending.
    All,
    /// Sent as much as one message carries: flush again soon.
    Some,
}

/// How [`Batch::items`] fills a message.
#[derive(Clone, Copy, PartialEq)]
enum Fill {
    /// Rows: as many as fit, counted against [`Limits::rows`].
    Rows,
    /// As many as fit (names, uids deleted).
    Bytes,
}

/// One `{"t":"batch","m":[…]}` message, written in place (no copy of its parts) and kept within `limits`.
struct Batch {
    buf: Vec<u8>,
    parts: usize,
    rows: usize,
    limits: Limits,
}

impl Batch {
    fn new(limits: Limits) -> Self {
        let mut buf = Vec::with_capacity(4096);
        buf.extend_from_slice(br#"{"t":"batch","m":["#);
        Batch { buf, parts: 0, rows: 0, limits }
    }

    /// Whether the message carries all it may.
    fn full(&self) -> bool {
        self.rows >= self.limits.rows || self.buf.len() >= self.limits.bytes
    }

    fn json(&mut self, v: &impl Serialize) {
        // Writing into a Vec cannot fail; serializing rows and strings neither.
        let _ = serde_json::to_writer(&mut self.buf, v);
    }

    /// Adds a message serialized already.
    fn raw(&mut self, part: &str) {
        if self.parts > 0 {
            self.buf.push(b',');
        }
        self.parts += 1;
        self.buf.extend_from_slice(part.as_bytes());
    }

    /// Starts a `rows`/`names` message of a slot (closed by [`Batch::close`]).
    fn open(&mut self, t: &str, c: &str, ns: Option<&str>, reset: bool) {
        self.raw(r#"{"t":"#);
        self.json(&t);
        self.buf.extend_from_slice(br#","c":"#);
        self.json(&c);
        self.buf.extend_from_slice(br#","ns":"#);
        self.json(&ns);
        if reset {
            self.buf.extend_from_slice(br#","reset":true"#);
        }
    }

    /// Writes `"key":[…]` with items `0..len` — as long as they fit (at least one). Returns how many it wrote.
    fn items<T: Serialize>(&mut self, key: &str, len: usize, fill: Fill, item: impl Fn(usize) -> T) -> usize {
        if len == 0 {
            return 0;
        }
        self.buf.extend_from_slice(b",\"");
        self.buf.extend_from_slice(key.as_bytes());
        self.buf.extend_from_slice(b"\":[");
        let mut n = 0;
        while n < len && (n == 0 || !self.full()) {
            if n > 0 {
                self.buf.push(b',');
            }
            self.json(&item(n));
            n += 1;
            if fill == Fill::Rows {
                self.rows += 1;
            }
        }
        self.buf.push(b']');
        n
    }

    fn close(&mut self, more: bool) {
        if more {
            self.buf.extend_from_slice(br#","more":true"#);
        }
        self.buf.push(b'}');
    }

    fn finish(mut self) -> Option<String> {
        if self.parts == 0 {
            return None;
        }
        self.buf.extend_from_slice(b"]}");
        // serde_json writes UTF-8.
        String::from_utf8(self.buf).ok()
    }
}

/// Writes what is pending for `slot` into `b`, as much as fits: its snapshot (the next chunk of it), then its
/// changes and status. Returns whether everything went.
fn send(b: &mut Batch, slot: &mut Slot, p: &mut Pending, projection: Projection) -> bool {
    let names = projection == Projection::Names;
    if projection == Projection::Problems {
        keep_problems(slot, p);
    }
    let (c, ns, map) = (&*slot.cluster, slot.namespace.as_deref(), slot.map.as_deref());
    if names && matches!(p.reset, Some(Snapshot::Rows(_))) {
        // A new snapshot: its names (with the changes since folded in) replace those the UI has.
        let d = name_changes(&mut slot.sent, p).unwrap_or_default();
        *p = Pending { reset: Some(Snapshot::Names(d.up)), status: p.status.take(), ..Default::default() };
    }
    if let Some(snapshot) = &p.reset {
        let (from, len) = (p.sent, snapshot.len());
        let n = match snapshot {
            Snapshot::Rows(rows) => {
                b.open("rows", c, ns, from == 0);
                b.items("up", len - from, Fill::Rows, |i| RowOut { row: &rows[from + i], map })
            }
            Snapshot::Names(names) => {
                b.open("names", c, ns, from == 0);
                b.items("up", len - from, Fill::Bytes, |i| &*names[from + i])
            }
        };
        p.sent += n;
        b.close(p.sent < len);
        if p.sent < len {
            return false;
        }
        (p.reset, p.sent) = (None, 0);
    }
    if names {
        if let Some(d) = name_changes(&mut slot.sent, p) {
            match &mut p.names {
                Some(left) => left.merge(d),
                None => p.names = Some(d),
            }
        }
        (p.up, p.del) = Default::default();
        if let Some(d) = &mut p.names {
            if b.full() {
                return false;
            }
            // A cold feed's first list comes as changes, a namespace deleted takes its objects along: as many as fit.
            b.open("names", c, ns, false);
            let n = b.items("up", d.up.len(), Fill::Bytes, |i| &*d.up[i]);
            d.up.drain(..n);
            let n = b.items("del", d.del.len(), Fill::Bytes, |i| &*d.del[i]);
            d.del.drain(..n);
            b.close(false);
            if !d.up.is_empty() || !d.del.is_empty() {
                return false;
            }
            p.names = None;
        }
    } else if !p.up.is_empty() || !p.del.is_empty() {
        if b.full() {
            return false;
        }
        let up: Vec<Arc<Row>> = p.up.drain().map(|(_, r)| r).collect();
        let del: Vec<Arc<str>> = p.del.drain().collect();
        b.open("rows", c, ns, false);
        let n = b.items("up", up.len(), Fill::Rows, |i| RowOut { row: &up[i], map });
        let m = b.items("del", del.len(), Fill::Bytes, |i| &*del[i]);
        b.close(false);
        // What did not fit stays (changes coalesce with it meanwhile).
        p.up.extend(up.into_iter().skip(n).map(|r| (r.uid.clone(), r)));
        p.del.extend(del.into_iter().skip(m));
        if !p.up.is_empty() || !p.del.is_empty() {
            return false;
        }
    }
    if let Some(status) = p.status.take() {
        b.raw(&status_msg(c, ns, &status));
    }
    true
}

/// Sends what is pending as one `{"t":"batch","m":[…]}` message, as much as `limits` let it carry: messages
/// built elsewhere, changes and statuses of slots, then the next chunk of snapshots being sent.
fn flush(sink: &Sink, extra: &mut Vec<String>, slots: &mut [Slot], pending: &mut [Pending], projection: Projection, limits: Limits) -> Flushed {
    let mut b = Batch::new(limits);
    for part in extra.drain(..) {
        b.raw(&part);
    }
    let mut all = true;
    // Live changes first: a big snapshot of one slot does not hold up the others.
    for snapshots in [false, true] {
        for (slot, p) in slots.iter_mut().zip(pending.iter_mut()) {
            if p.is_empty() || slot.lease.is_none() || p.reset.is_some() != snapshots {
                continue;
            }
            if b.full() || !send(&mut b, slot, p, projection) {
                all = false;
            }
        }
    }
    let Some(msg) = b.finish() else { return Flushed::All };
    match (sink(msg), all) {
        (false, _) => Flushed::Gone,
        (true, true) => Flushed::All,
        (true, false) => Flushed::Some,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cluster::Cluster;
    use crate::render::Tone;
    use crate::testing::{self, Reply, Server};

    fn row(uid: &str, name: &str, rv: &str) -> Arc<Row> {
        Arc::new(Row {
            uid: Arc::from(uid),
            name: name.into(),
            namespace: None,
            resource_version: rv.into(),
            created: 0,
            tone: Tone::Neutral,
            cells: Vec::new(),
            labels: String::new(),
            terminating: false,
        })
    }

    fn sorted(v: &[Arc<str>]) -> Vec<&str> {
        let mut out: Vec<&str> = v.iter().map(|s| s.as_ref()).collect();
        out.sort_unstable();
        out
    }

    #[test]
    fn names_projection_reports_membership_only() {
        let mut sent = HashMap::new();
        let mut p = Pending { reset: Some(Snapshot::Rows(vec![row("1", "payments", "1"), row("2", "search", "1")])), ..Default::default() };
        p.push(FeedEvent::Upsert(row("3", "orders", "1")));
        p.push(FeedEvent::Delete(Arc::from("2")));
        let d = name_changes(&mut sent, &p).unwrap();
        assert!(d.reset);
        assert_eq!(sorted(&d.up), ["orders", "payments"]);

        // Label/status churn on existing namespaces: nothing to send.
        let mut p = Pending::default();
        p.push(FeedEvent::Upsert(row("1", "payments", "2")));
        p.push(FeedEvent::Upsert(row("3", "orders", "7")));
        assert_eq!(name_changes(&mut sent, &p), None);

        // Deleted and re-created under the same name within one batch: both edges are reported,
        // so a counting receiver ends up with the name present.
        let mut p = Pending::default();
        p.push(FeedEvent::Delete(Arc::from("1")));
        p.push(FeedEvent::Upsert(row("4", "payments", "1")));
        let d = name_changes(&mut sent, &p).unwrap();
        assert!(!d.reset);
        assert_eq!(sorted(&d.up), ["payments"]);
        assert_eq!(sorted(&d.del), ["payments"]);

        // Deletes of unknown objects are ignored.
        let mut p = Pending::default();
        p.push(FeedEvent::Delete(Arc::from("nope")));
        assert_eq!(name_changes(&mut sent, &p), None);
    }

    #[test]
    fn describe_is_compact() {
        let spec = ViewSpec {
            resource: "pods".into(),
            clusters: vec!["a".into(), "b".into()],
            namespaces: vec!["payments".into()],
            label_selector: Some("app=web".into()),
            field_selector: None,
            projection: Projection::Rows,
        };
        assert_eq!(spec.describe(), "pods × 2 clusters × [payments] (app=web)");
        let ns = ViewSpec {
            resource: "namespaces".into(),
            clusters: vec!["dev".into()],
            namespaces: vec![],
            label_selector: None,
            field_selector: None,
            projection: Projection::Names,
        };
        assert_eq!(ns.describe(), "namespaces × dev [names]");
    }

    /// Runs a view of pods on `prod-eu-z1`, collecting what it sends.
    fn start(inner: &Arc<Inner>) -> Arc<parking_lot::Mutex<Vec<String>>> {
        let out = Arc::new(parking_lot::Mutex::new(Vec::new()));
        let o = out.clone();
        let sink: Sink = Arc::new(move |msg: String| {
            o.lock().push(msg);
            true
        });
        let spec = ViewSpec {
            resource: "pods".into(),
            clusters: vec!["prod-eu-z1".into()],
            namespaces: vec![],
            label_selector: None,
            field_selector: None,
            projection: Projection::Rows,
        };
        tokio::spawn(run(inner.clone(), spec, sink));
        out
    }

    /// Cluster-level states sent so far (`connecting`, `error`, `error/terminal`…), in order.
    fn cluster_states(out: &parking_lot::Mutex<Vec<String>>) -> Vec<String> {
        let mut states = Vec::new();
        for batch in out.lock().iter() {
            let v: serde_json::Value = serde_json::from_str(batch).unwrap();
            for m in v["m"].as_array().unwrap() {
                if m["t"] == "status" && m["ns"].is_null() {
                    let terminal = if m["terminal"] == true { "/terminal" } else { "" };
                    states.push(format!("{}{terminal}", m["state"].as_str().unwrap()));
                }
            }
        }
        states
    }

    fn has_rows(out: &parking_lot::Mutex<Vec<String>>, name: &str) -> bool {
        out.lock().iter().any(|b| b.contains(r#""t":"rows""#) && b.contains(&format!(r#""n":"{name}""#)))
    }

    async fn until(what: &str, ok: impl Fn() -> bool) {
        for _ in 0..500 {
            if ok() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("timed out waiting for {what}");
    }

    fn unreachable() -> ConnectError {
        ConnectError { message: "dial tcp 10.0.0.1:443: connection refused".into(), code: None, retryable: true }
    }

    #[tokio::test]
    async fn a_cluster_that_failed_to_connect_shows_up_once_it_connects() {
        let inner = Inner::for_tests();
        let out = start(&inner);
        // The context is unknown to the (empty) kubeconfig: a terminal failure, no timer.
        until("the error", || cluster_states(&out).last().is_some_and(|s| s == "error/terminal")).await;

        // Reconnect elsewhere (Retry in the UI, a fixed kubeconfig…): the view picks the cluster up.
        let server = Arc::new(Server::default());
        let client = testing::fake(server.clone(), |_| Reply::Pods);
        inner.clusters.insert_ready_for_tests(Cluster::for_tests("prod-eu-z1", client, vec![testing::pods()]));
        until("the rows", || has_rows(&out, "pod-0")).await;
        until("ready", || cluster_states(&out).last().is_some_and(|s| s == "ready")).await;
        // (The all-namespaces feed then reports at cluster level too: loading, ready.)
        assert_eq!(cluster_states(&out)[..3], ["connecting", "error/terminal", "connecting"]);

        // Later changes of a resolved cluster need nothing from the view (its feeds restart in place).
        inner.clusters.touch("prod-eu-z1");
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert_eq!(server.lists.load(std::sync::atomic::Ordering::SeqCst), 1);
    }

    #[tokio::test(start_paused = true)]
    async fn network_failures_are_retried_with_backoff_and_right_away_on_resync() {
        let inner = Inner::for_tests();
        inner.clusters.insert_failed_for_tests("prod-eu-z1", unreachable());
        let out = start(&inner);
        until("the error", || cluster_states(&out).len() == 2).await;
        // Not terminal: the UI shows it as retrying.
        assert_eq!(cluster_states(&out), ["connecting", "error"]);

        // Retried after 5s (the cached failure answers again: it is younger than the 3s retry guard in real time).
        tokio::time::sleep(Duration::from_millis(4900)).await;
        assert_eq!(cluster_states(&out).len(), 2);
        tokio::time::sleep(Duration::from_millis(200)).await;
        until("the retry", || cluster_states(&out).len() == 4).await;
        // Then after 10s; a resync (wake from sleep) does not wait for it.
        inner.clusters.nudge();
        until("the resync retry", || cluster_states(&out).len() == 6).await;
        assert_eq!(cluster_states(&out), ["connecting", "error", "connecting", "error", "connecting", "error"]);
    }

    #[tokio::test(start_paused = true)]
    async fn other_failures_wait_for_the_cluster_to_change() {
        let inner = Inner::for_tests();
        inner
            .clusters
            .insert_failed_for_tests("prod-eu-z1", ConnectError { message: "auth plugin `kubelogin` was not found".into(), code: None, retryable: false });
        let out = start(&inner);
        until("the error", || cluster_states(&out).len() == 2).await;
        tokio::time::sleep(Duration::from_secs(600)).await;
        inner.clusters.nudge();
        tokio::time::sleep(Duration::from_secs(1)).await;
        assert_eq!(cluster_states(&out), ["connecting", "error/terminal"]);

        // Another attempt (Retry): its progress and outcome are shown.
        inner.clusters.insert_failed_for_tests("prod-eu-z1", ConnectError { message: "still not found".into(), code: None, retryable: false });
        until("the new error", || cluster_states(&out).len() == 3).await;
        assert!(out.lock().last().unwrap().contains("still not found"));
    }

    #[test]
    fn retry_delays_grow_and_cap() {
        let delays: Vec<u64> = (1..=8).map(|n| retry_delay(n).as_secs()).collect();
        assert_eq!(delays, [5, 10, 20, 40, 80, 120, 120, 120]);
    }

    #[test]
    fn the_schema_is_a_union_that_only_grows() {
        let col = |id: &'static str, hidden: bool| Column { hidden, ..render::col(id, id, render::ColumnKind::Text) };
        let mut schema = Schema::default();
        assert_eq!(schema.merge(&[col("ready", false), col("secret", true)]), (true, None));
        // Same columns elsewhere: nothing changes, the cells line up.
        assert_eq!(schema.merge(&[col("ready", false), col("secret", true)]), (false, None));
        // A prefix lines up too (the rest is missing, shown empty).
        assert_eq!(schema.merge(&[col("ready", false)]), (false, None));
        // Another order, a new column, one shown by default here: appended, cells moved by id.
        let (changed, map) = schema.merge(&[col("issuer", false), col("secret", false)]);
        assert!(changed);
        assert_eq!(map.as_deref(), Some(&[None, Some(1), Some(0)][..]));
        let ids: Vec<(&str, bool)> = schema.0.iter().map(|c| (c.id.as_ref(), c.hidden)).collect();
        assert_eq!(ids, [("ready", false), ("secret", false), ("issuer", false)]);
        // A cluster without kind-specific columns.
        assert_eq!(schema.merge(&[]), (false, None));
    }

    use crate::render::table::{self, fake};
    use serde_json::{Value, json};
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

    fn widgets() -> ResourceInfo {
        ResourceInfo {
            key: "widgets.example.com".into(),
            group: "example.com".into(),
            version: "v1".into(),
            kind: "Widget".into(),
            plural: "widgets".into(),
            singular: "widget".into(),
            namespaced: true,
            verbs: ["get", "list", "watch"].map(String::from).to_vec(),
            short_names: Vec::new(),
            categories: Vec::new(),
            subresources: Vec::new(),
        }
    }

    fn widget(name: &str, ready: &str, secret: &str, issuer: &str) -> Value {
        json!({"apiVersion": "example.com/v1", "kind": "Widget",
               "metadata": {"name": name, "namespace": "default", "uid": format!("uid-{name}"), "resourceVersion": "10", "creationTimestamp": "2024-01-01T00:00:00Z"},
               "spec": {"secretName": secret, "issuer": issuer}, "status": {"ready": ready}})
    }

    /// The widgets CRD with these printer columns (name, type, JSONPath).
    fn crd(columns: &[(&str, &str, &str)]) -> fake::Reply {
        let columns: Vec<Value> = columns.iter().map(|(name, ty, path)| json!({"name": name, "type": ty, "jsonPath": path})).collect();
        let crd = json!({"apiVersion": "apiextensions.k8s.io/v1", "kind": "CustomResourceDefinition", "metadata": {"name": "widgets.example.com", "uid": "crd", "resourceVersion": "1"},
                         "spec": {"group": "example.com", "versions": [{"name": "v1", "served": true, "storage": true, "additionalPrinterColumns": columns}]}});
        fake::Reply::json(crd.to_string())
    }

    /// Server-side printing of widgets: these columns (name, type, field of the widget's `spec`/`status`).
    type Printed = Result<Vec<(&'static str, &'static str, &'static str)>, u16>;

    /// An API server serving `objects` as widgets: their CRD as `crd()` answers, plain lists and (idle)
    /// watches, and server-side printing as `printed(probe)` says.
    fn widget_api(
        log: fake::Log,
        objects: Vec<Value>,
        crd: impl Fn() -> fake::Reply + Send + Sync + 'static,
        printed: impl Fn(bool) -> Printed + Send + Sync + 'static,
    ) -> kube::Client {
        fake::server(log, move |uri, accept| {
            if uri.contains("/customresourcedefinitions/") {
                return crd();
            }
            let watch = uri.contains("watch=true");
            if !accept.contains("as=Table") {
                let list = json!({"kind": "WidgetList", "apiVersion": "example.com/v1", "metadata": {"resourceVersion": "10"}, "items": objects});
                return if watch { fake::Reply::events(&[]) } else { fake::Reply::json(list.to_string()) };
            }
            let probe = uri.contains("includeObject=None");
            let columns = match printed(probe) {
                Ok(columns) => columns,
                Err(code) => return fake::Reply::status(code),
            };
            if watch {
                return fake::Reply::events(&[]);
            }
            let defs = table::tests::definitions(&columns.iter().map(|(name, ty, _)| (*name, *ty, 0)).collect::<Vec<_>>());
            let rows: Vec<Value> = if probe {
                Vec::new()
            } else {
                objects
                    .iter()
                    .map(|o| {
                        let mut cells = vec![o["metadata"]["name"].clone()];
                        cells.extend(
                            columns.iter().map(|(_, _, field)| if *field == "ready" { o["status"]["ready"].clone() } else { o["spec"][*field].clone() }),
                        );
                        cells.push(json!("2024-01-01T00:00:00Z"));
                        json!({"cells": cells, "object": o})
                    })
                    .collect()
            };
            fake::Reply::json(table::tests::table(Some(&defs), &rows, "10").to_string())
        })
    }

    /// Runs a view of widgets on `clusters`, collecting what it sends.
    fn watch_widgets(inner: &Arc<Inner>, clusters: &[&str]) -> Arc<parking_lot::Mutex<Vec<String>>> {
        let out = Arc::new(parking_lot::Mutex::new(Vec::new()));
        let o = out.clone();
        let sink: Sink = Arc::new(move |msg: String| {
            o.lock().push(msg);
            true
        });
        let spec = ViewSpec {
            resource: "widgets.example.com".into(),
            clusters: clusters.iter().map(|c| c.to_string()).collect(),
            namespaces: vec![],
            label_selector: None,
            field_selector: None,
            projection: Projection::Rows,
        };
        tokio::spawn(run(inner.clone(), spec, sink));
        out
    }

    /// Messages of type `t` sent so far, in order.
    fn messages(out: &parking_lot::Mutex<Vec<String>>, t: &str) -> Vec<Value> {
        let mut found = Vec::new();
        for batch in out.lock().iter() {
            let v: Value = serde_json::from_str(batch).unwrap();
            found.extend(v["m"].as_array().unwrap().iter().filter(|m| m["t"] == t).cloned());
        }
        found
    }

    /// Ids of the view's columns, as last sent.
    fn schema(out: &parking_lot::Mutex<Vec<String>>) -> Vec<String> {
        messages(out, "schema")
            .last()
            .map(|s| s["columns"].as_array().unwrap().iter().map(|c| c["id"].as_str().unwrap().to_string()).collect())
            .unwrap_or_default()
    }

    /// The cells of the last row of `name` from `cluster`, by column id (as the UI reads them: by position
    /// among the view's columns).
    fn cells(out: &parking_lot::Mutex<Vec<String>>, cluster: &str, name: &str) -> Option<HashMap<String, Value>> {
        let row = messages(out, "rows")
            .into_iter()
            .filter(|m| m["c"] == cluster)
            .flat_map(|m| m["up"].as_array().cloned().unwrap_or_default())
            .rfind(|r| r["n"] == name)?;
        Some(schema(out).into_iter().enumerate().map(|(i, id)| (id, row["c"].get(i).cloned().unwrap_or(Value::Null))).collect())
    }

    fn connect(inner: &Inner, context: &str, client: kube::Client) -> Arc<Cluster> {
        let cluster = Cluster::for_tests(context, client, vec![widgets()]);
        inner.clusters.insert_ready_for_tests(cluster.clone());
        cluster
    }

    fn table_requests(log: &fake::Log) -> usize {
        log.lock().iter().filter(|(_, accept)| accept.contains("as=Table")).count()
    }

    #[tokio::test]
    async fn printer_columns_come_from_the_crd_when_it_can_be_read() {
        let inner = Inner::for_tests();
        let log: fake::Log = Arc::default();
        let columns = [("Ready", "string", ".status.ready"), ("Secret", "string", ".spec.secretName"), ("Age", "date", ".metadata.creationTimestamp")];
        connect(&inner, "prod-eu-z1", widget_api(log.clone(), vec![widget("w1", "True", "tls", "ca")], move || crd(&columns), |_| Err(500)));
        let out = watch_widgets(&inner, &["prod-eu-z1"]);
        until("the rows", || cells(&out, "prod-eu-z1", "w1").is_some()).await;
        assert_eq!(schema(&out), ["pc_ready_status", "pc_secret_text"]);
        let c = cells(&out, "prod-eu-z1", "w1").unwrap();
        assert_eq!((&c["pc_ready_status"], &c["pc_secret_text"]), (&json!(["True", 1]), &json!("tls")));
        assert_eq!(table_requests(&log), 0, "no server-side printing needed");
        assert!(messages(&out, "resolved")[0].get("notice").is_none());
    }

    #[tokio::test]
    async fn without_access_to_the_crd_columns_come_from_server_side_printing() {
        let inner = Inner::for_tests();
        let log: fake::Log = Arc::default();
        connect(
            &inner,
            "prod-eu-z1",
            widget_api(
                log.clone(),
                vec![widget("w1", "True", "tls", "ca")],
                || fake::Reply::status(403),
                |_| Ok(vec![("Ready", "string", "ready"), ("Issuer", "string", "issuer")]),
            ),
        );
        let out = watch_widgets(&inner, &["prod-eu-z1"]);
        until("the rows", || cells(&out, "prod-eu-z1", "w1").is_some()).await;
        assert_eq!(schema(&out), ["pc_ready_status", "pc_issuer_text"]);
        let c = cells(&out, "prod-eu-z1", "w1").unwrap();
        assert_eq!((&c["pc_ready_status"], &c["pc_issuer_text"]), (&json!(["True", 1]), &json!("ca")));
        assert!(messages(&out, "resolved")[0].get("notice").is_none());
        // Listed and watched as tables, with whole objects…
        until("the watch", || log.lock().iter().any(|(uri, _)| uri.contains("watch=true"))).await;
        let feed_requests: Vec<_> =
            log.lock().iter().filter(|(uri, _)| !uri.contains("customresourcedefinitions") && !uri.contains("includeObject=None")).cloned().collect();
        assert!(feed_requests.iter().all(|(uri, accept)| uri.contains("includeObject=Object") && accept.contains("as=Table")), "{feed_requests:?}");
        // …which the feed keeps without the printed cells.
        let json = inner.hub.find_object("prod-eu-z1", "widgets.example.com", Some("default"), "w1", None).unwrap();
        assert!(json.contains(r#""secretName":"tls""#) && !json.contains(table::CELLS), "{json}");
    }

    #[tokio::test(start_paused = true)]
    async fn printer_columns_that_could_not_be_found_for_now_are_asked_for_again() {
        let inner = Inner::for_tests();
        let log: fake::Log = Arc::default();
        let probes = Arc::new(AtomicUsize::new(0));
        let p = probes.clone();
        let printed = move |probe: bool| {
            if probe && p.fetch_add(1, Ordering::SeqCst) == 0 {
                return Err(503);
            }
            Ok(vec![("Ready", "string", "ready")])
        };
        connect(&inner, "prod-eu-z1", widget_api(log.clone(), vec![widget("w1", "False", "tls", "ca")], || fake::Reply::status(403), printed));
        let out = watch_widgets(&inner, &["prod-eu-z1"]);
        // Rows right away, without the columns: the UI is told why.
        until("the rows", || cells(&out, "prod-eu-z1", "w1").is_some()).await;
        assert!(schema(&out).is_empty());
        let notice = messages(&out, "resolved")[0]["notice"].clone();
        assert_eq!(notice, "printer columns unavailable: failed with 503");

        // Asked again after a while (5s): the columns arrive, the rows are sent anew with their cells.
        tokio::time::sleep(Duration::from_secs(4)).await;
        assert!(schema(&out).is_empty());
        until("the columns", || cells(&out, "prod-eu-z1", "w1").is_some_and(|c| c.get("pc_ready_status") == Some(&json!(["False", 3])))).await;
        assert_eq!(schema(&out), ["pc_ready_status"]);
        assert!(messages(&out, "resolved").last().unwrap().get("notice").is_none());
        // Found columns are kept: a later change of the connection resolves again without asking anything.
        let asked = log.lock().len();
        inner.clusters.touch("prod-eu-z1");
        tokio::time::sleep(Duration::from_secs(1)).await;
        assert_eq!(messages(&out, "resolved").len(), 3);
        assert_eq!(log.lock().len(), asked);
    }

    #[tokio::test]
    async fn clusters_serving_different_printer_columns_line_up() {
        let inner = Inner::for_tests();
        let log: fake::Log = Arc::default();
        // z1 is on the old operator (CRD readable); z2 on the new one, whose CRD this user may not read.
        let old = [("Ready", "string", ".status.ready"), ("Secret", "string", ".spec.secretName")];
        connect(&inner, "prod-eu-z1", widget_api(log.clone(), vec![widget("w1", "True", "tls", "ca")], move || crd(&old), |_| Err(500)));
        let new = || Ok(vec![("Issuer", "string", "issuer"), ("Ready", "string", "ready")]);
        connect(&inner, "prod-eu-z2", widget_api(log.clone(), vec![widget("w2", "False", "tls2", "ca2")], || fake::Reply::status(403), move |_| new()));
        let out = watch_widgets(&inner, &["prod-eu-z1", "prod-eu-z2"]);
        until("the rows", || cells(&out, "prod-eu-z1", "w1").is_some() && cells(&out, "prod-eu-z2", "w2").is_some()).await;
        let mut ids = schema(&out);
        ids.sort();
        assert_eq!(ids, ["pc_issuer_text", "pc_ready_status", "pc_secret_text"]);
        // Whoever answered first, every cell is under its own column.
        let (z1, z2) = (cells(&out, "prod-eu-z1", "w1").unwrap(), cells(&out, "prod-eu-z2", "w2").unwrap());
        assert_eq!([&z1["pc_ready_status"], &z1["pc_secret_text"], &z1["pc_issuer_text"]], [&json!(["True", 1]), &json!("tls"), &Value::Null]);
        assert_eq!([&z2["pc_ready_status"], &z2["pc_secret_text"], &z2["pc_issuer_text"]], [&json!(["False", 3]), &Value::Null, &json!("ca2")]);
    }

    #[tokio::test]
    async fn a_discovery_refresh_brings_new_printer_columns_to_open_views() {
        let inner = Inner::for_tests();
        let log: fake::Log = Arc::default();
        let upgraded = Arc::new(AtomicBool::new(false));
        let u = upgraded.clone();
        let crd_now = move || {
            let mut columns = vec![("Ready", "string", ".status.ready")];
            if u.load(Ordering::SeqCst) {
                columns.push(("Secret", "string", ".spec.secretName"));
            }
            crd(&columns)
        };
        let cluster = connect(&inner, "prod-eu-z1", widget_api(log.clone(), vec![widget("w1", "True", "tls", "ca")], crd_now, |_| Err(500)));
        let out = watch_widgets(&inner, &["prod-eu-z1"]);
        until("the rows", || cells(&out, "prod-eu-z1", "w1").is_some()).await;
        assert_eq!(schema(&out), ["pc_ready_status"]);

        // The operator was upgraded; the user refreshes discovery.
        upgraded.store(true, Ordering::SeqCst);
        cluster.forget_printers();
        inner.clusters.touch("prod-eu-z1");
        until("the new column", || cells(&out, "prod-eu-z1", "w1").is_some_and(|c| c.get("pc_secret_text") == Some(&json!("tls")))).await;
        assert_eq!(schema(&out), ["pc_ready_status", "pc_secret_text"]);
    }

    fn probes(log: &fake::Log) -> usize {
        log.lock().iter().filter(|(uri, _)| uri.contains("includeObject=None")).count()
    }

    /// Lists of the widgets' feeds (not probes, not watches).
    fn feed_lists(log: &fake::Log) -> usize {
        log.lock().iter().filter(|(uri, _)| uri.contains("includeObject=Object") && !uri.contains("watch=true")).count()
    }

    #[tokio::test(start_paused = true)]
    async fn columns_that_cannot_be_looked_up_again_for_now_stay_as_they_are() {
        let inner = Inner::for_tests();
        let log: fake::Log = Arc::default();
        let failing = Arc::new(AtomicBool::new(false));
        let f = failing.clone();
        let printed = move |probe: bool| if probe && f.load(Ordering::SeqCst) { Err(503) } else { Ok(vec![("Ready", "string", "ready")]) };
        let client = widget_api(log.clone(), vec![widget("w1", "True", "tls", "ca")], || fake::Reply::status(403), printed);
        connect(&inner, "prod-eu-z1", client.clone());
        let out = watch_widgets(&inner, &["prod-eu-z1"]);
        until("the columns", || cells(&out, "prod-eu-z1", "w1").is_some_and(|c| c.get("pc_ready_status") == Some(&json!(["True", 1])))).await;
        assert_eq!((probes(&log), feed_lists(&log)), (1, 1));
        let sent = out.lock().len();

        // A reconnect (fresh credentials, a wake from sleep): the new connection looks the columns up again,
        // and that fails for now.
        failing.store(true, Ordering::SeqCst);
        connect(&inner, "prod-eu-z1", client.clone());
        until("the lookup", || probes(&log) == 2).await;
        tokio::time::sleep(Duration::from_millis(500)).await;
        // The same feed goes on: no relist, its rows are not cleared, its columns stay, and nothing is missing.
        assert_eq!(feed_lists(&log), 1);
        assert!(out.lock()[sent..].iter().all(|b| !b.contains(r#""reset":true"#)), "{:?}", &out.lock()[sent..]);
        assert_eq!(schema(&out), ["pc_ready_status"]);
        assert!(messages(&out, "resolved").last().unwrap().get("notice").is_none());

        // Looked up again a little later: found, still the same feed.
        failing.store(false, Ordering::SeqCst);
        until("the retry", || probes(&log) == 3).await;
        tokio::time::sleep(Duration::from_millis(500)).await;
        assert_eq!(feed_lists(&log), 1);
        assert!(out.lock()[sent..].iter().all(|b| !b.contains(r#""reset":true"#)));
    }

    #[tokio::test]
    async fn a_discovery_refresh_while_the_resource_resolves_is_not_lost() {
        let inner = Inner::for_tests();
        let log: fake::Log = Arc::default();
        let shown: Arc<std::sync::OnceLock<Arc<Cluster>>> = Arc::default();
        let reads = Arc::new(AtomicUsize::new(0));
        let (i, c, r) = (inner.clone(), shown.clone(), reads.clone());
        let crd_now = move || {
            if r.fetch_add(1, Ordering::SeqCst) == 0 {
                // The operator was just upgraded and the user refreshes discovery while this answer is on its way.
                c.get().unwrap().forget_printers();
                i.clusters.touch("prod-eu-z1");
                return crd(&[("Ready", "string", ".status.ready")]);
            }
            crd(&[("Ready", "string", ".status.ready"), ("Secret", "string", ".spec.secretName")])
        };
        let cluster = connect(&inner, "prod-eu-z1", widget_api(log.clone(), vec![widget("w1", "True", "tls", "ca")], crd_now, |_| Err(500)));
        shown.set(cluster).ok();
        let out = watch_widgets(&inner, &["prod-eu-z1"]);
        until("the new column", || cells(&out, "prod-eu-z1", "w1").is_some_and(|c| c.get("pc_secret_text") == Some(&json!("tls")))).await;
        assert_eq!(schema(&out), ["pc_ready_status", "pc_secret_text"]);
        assert_eq!(reads.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn a_cluster_whose_feeds_are_replaced_again_and_again_keeps_its_slots() {
        let server = Arc::new(Server::default());
        let client = testing::fake(server.clone(), |_| Reply::Pods);
        let hub = crate::feed::WatchHub::new(tokio::runtime::Handle::current(), Duration::from_secs(60));
        let (tx, _rx) = mpsc::unbounded_channel();
        let (mut tasks, mut slots, mut pending, mut extra) = (JoinSet::new(), Vec::new(), Vec::new(), Vec::new());
        let cluster: Arc<str> = Arc::from("prod-eu-z1");
        let key = |ns: &str| FeedKey { cluster: cluster.clone(), resource: Arc::from("pods"), namespace: Some(Arc::from(ns)), labels: None, fields: None };
        for round in 0..4 {
            // Each round, another renderer (other printer columns): new feeds for both namespaces.
            let renderer: Arc<dyn render::Renderer> = Arc::new(render::FnRenderer { columns: Vec::new(), f: |_| (Vec::new(), render::Tone::Neutral) });
            let leases = ["a", "b"]
                .map(|ns| {
                    (
                        hub.lease(key(ns), || crate::feed::FeedSpec {
                            client: client.clone(),
                            api_resource: testing::pods().api_resource(),
                            renderer: renderer.clone(),
                        }),
                        None,
                    )
                })
                .into();
            let feeds = Feeds { tasks: &mut tasks, tx: &tx, slots: &mut slots, pending: &mut pending };
            replace_feeds(feeds, &cluster, leases, false, &mut extra);
            assert_eq!(slots.len(), 2);
            assert!(slots.iter().all(|s| s.lease.is_some() && s.fwd == round + 1));
        }
        // Rows were never cleared in between: each replacement's own reset says what the namespace has.
        assert!(extra.is_empty(), "{extra:?}");
    }

    /// What the UI makes of the messages (as `createViewFeed` / `createNamesFeed` do): rows (or names) per
    /// cluster and namespace, snapshots that come in chunks kept aside until their last one.
    #[derive(Default)]
    struct Ui {
        shown: HashMap<String, HashMap<String, Value>>,
        staged: HashMap<String, HashMap<String, Value>>,
        status: HashMap<String, String>,
        /// Most rows in one message.
        most: usize,
        /// A status came for a slot whose snapshot was half sent.
        status_while_staged: bool,
        resets: usize,
        /// Batches applied.
        messages: usize,
    }

    impl Ui {
        fn apply(&mut self, batch: &str) {
            self.messages += 1;
            let v: Value = serde_json::from_str(batch).unwrap();
            let mut rows = 0;
            for m in v["m"].as_array().unwrap() {
                let fk = format!("{}|{}", m["c"].as_str().unwrap_or_default(), m["ns"].as_str().unwrap_or_default());
                if m["t"] == "status" {
                    self.status_while_staged |= self.staged.contains_key(&fk);
                    self.status.insert(fk, m["state"].as_str().unwrap().to_string());
                    continue;
                }
                if m["t"] != "rows" && m["t"] != "names" {
                    continue;
                }
                let key = |r: &Value| if m["t"] == "rows" { r["u"].as_str().unwrap().to_string() } else { r.as_str().unwrap().to_string() };
                let up: Vec<Value> = m["up"].as_array().cloned().unwrap_or_default();
                if m["t"] == "rows" {
                    rows += up.len();
                }
                let more = m["more"] == true;
                if m["reset"] == true {
                    self.resets += 1;
                    self.staged.insert(fk.clone(), HashMap::new());
                }
                if let Some(stage) = self.staged.get_mut(&fk) {
                    assert!(m.get("del").is_none(), "no deletes within a snapshot");
                    stage.extend(up.iter().map(|r| (key(r), r.clone())));
                    if !more {
                        let rows = self.staged.remove(&fk).unwrap();
                        self.shown.insert(fk, rows);
                    }
                    continue;
                }
                assert!(!more, "{m}");
                let feed = self.shown.entry(fk).or_default();
                feed.extend(up.iter().map(|r| (key(r), r.clone())));
                for d in m["del"].as_array().cloned().unwrap_or_default() {
                    feed.remove(d.as_str().unwrap());
                }
            }
            self.most = self.most.max(rows);
        }

        fn rows(&self, fk: &str) -> Vec<String> {
            let mut out: Vec<String> = self.shown.get(fk).map(|f| f.keys().cloned().collect()).unwrap_or_default();
            out.sort();
            out
        }
    }

    fn quiet_lease(hub: &crate::feed::WatchHub, cluster: &str) -> FeedLease {
        let server = Arc::new(Server::default());
        let key = FeedKey { cluster: Arc::from(cluster), resource: Arc::from("pods"), namespace: None, labels: None, fields: None };
        hub.lease(key, || crate::feed::FeedSpec {
            client: testing::fake(server, |_| Reply::Status(403)),
            api_resource: testing::pods().api_resource(),
            renderer: render::generic(),
        })
    }

    fn slot(cluster: &str, lease: FeedLease) -> Slot {
        Slot { cluster: Arc::from(cluster), namespace: None, lease: Some(lease), map: None, forwarder: None, fwd: 0, sent: HashMap::new() }
    }

    #[test]
    fn views_watch_a_bounded_number_of_namespaces() {
        assert_eq!([1, 4, 10, 11, 107, 5000].map(namespace_limit), [100, 100, 100, 90, 9, 1]);
    }

    #[tokio::test]
    async fn namespaces_beyond_the_limit_say_they_are_not_watched() {
        let inner = Inner::for_tests();
        let server = Arc::new(Server::default());
        inner.clusters.insert_ready_for_tests(Cluster::for_tests("prod-eu-z1", testing::fake(server.clone(), |_| Reply::Pods), vec![testing::pods()]));
        let out = Arc::new(parking_lot::Mutex::new(Vec::new()));
        let o = out.clone();
        let sink: Sink = Arc::new(move |msg: String| {
            o.lock().push(msg);
            true
        });
        let namespaces: Vec<String> = (0..MAX_VIEW_NAMESPACES + 2).map(|i| format!("team-{i}")).collect();
        let spec = ViewSpec {
            resource: "pods".into(),
            clusters: vec!["prod-eu-z1".into()],
            namespaces,
            label_selector: None,
            field_selector: None,
            projection: Projection::Rows,
        };
        tokio::spawn(run(inner.clone(), spec, sink));
        until("the statuses", || messages(&out, "status").iter().filter(|m| m["state"] == "error").count() == 2).await;
        let skipped: Vec<Value> =
            messages(&out, "status").into_iter().filter(|m| m["state"] == "error").map(|m| json!([m["ns"], m["terminal"], m["message"]])).collect();
        let why = "not watched: a view watches at most 100 namespaces";
        assert_eq!(skipped, [json!(["team-100", true, why]), json!(["team-101", true, why])]);
        until("the feeds", || inner.hub.stats().feeds == MAX_VIEW_NAMESPACES).await;
    }

    #[tokio::test]
    async fn big_snapshots_go_out_in_chunks_and_changes_follow_them() {
        let hub = crate::feed::WatchHub::new(tokio::runtime::Handle::current(), Duration::from_secs(60));
        let mut slots = vec![slot("prod-eu-z1", quiet_lease(&hub, "prod-eu-z1")), slot("prod-eu-z2", quiet_lease(&hub, "prod-eu-z2"))];
        let rows: Vec<Arc<Row>> = (0..25).map(|i| row(&format!("uid-{i:02}"), &format!("pod-{i}"), "1")).collect();
        let mut z1 = Pending::snapshot(rows, FeedStatus::Ready);
        // Changes while the snapshot is on its way.
        z1.push(FeedEvent::Upsert(row("uid-03", "pod-3", "2")));
        z1.push(FeedEvent::Delete(Arc::from("uid-04")));
        let mut z2 = Pending::default();
        z2.push(FeedEvent::Upsert(row("uid-z2", "pod-z2", "1")));
        let mut pending = vec![z1, z2];

        let out = Arc::new(parking_lot::Mutex::new(Vec::new()));
        let o = out.clone();
        let sink: Sink = Arc::new(move |msg: String| {
            o.lock().push(msg);
            true
        });
        let limits = Limits { rows: 10, bytes: 1 << 20 };
        let mut extra = Vec::new();
        let mut flushes = Vec::new();
        loop {
            let f = flush(&sink, &mut extra, &mut slots, &mut pending, Projection::Rows, limits);
            flushes.push(f);
            if flushes.last() == Some(&Flushed::All) {
                break;
            }
        }
        assert_eq!(flushes, [Flushed::Some, Flushed::Some, Flushed::All]);
        let mut ui = Ui::default();
        for (i, batch) in out.lock().iter().enumerate() {
            ui.apply(batch);
            if i == 0 {
                // Live changes of the other cluster went first, and nothing of the half-sent snapshot shows.
                assert_eq!(ui.rows("prod-eu-z2|"), ["uid-z2"]);
                assert!(ui.rows("prod-eu-z1|").is_empty() && ui.staged["prod-eu-z1|"].len() == 9);
            }
        }
        assert_eq!(ui.most, 10);
        assert!(!ui.status_while_staged);
        assert_eq!(ui.status["prod-eu-z1|"], "ready");
        let shown = ui.rows("prod-eu-z1|");
        assert_eq!(shown.len(), 24);
        assert!(!shown.contains(&"uid-04".to_string()));
        assert_eq!(ui.shown["prod-eu-z1|"]["uid-03"]["rv"], "2");
        // The first chunk said `reset`, the others went on with it.
        assert_eq!(ui.resets, 1);
    }

    /// A row with this tone (and deletion mark).
    fn toned(uid: &str, rv: &str, tone: Tone, terminating: bool) -> Arc<Row> {
        let mut r = (*row(uid, uid, rv)).clone();
        (r.tone, r.terminating) = (tone, terminating);
        Arc::new(r)
    }

    #[tokio::test]
    async fn problems_projection_sends_objects_while_they_are_not_fine() {
        let hub = crate::feed::WatchHub::new(tokio::runtime::Handle::current(), Duration::from_secs(60));
        let mut slots = vec![slot("prod-eu-z1", quiet_lease(&hub, "prod-eu-z1"))];
        let snapshot = vec![
            toned("ok", "1", Tone::Ok, false),
            toned("crash", "1", Tone::Error, false),
            toned("degraded", "1", Tone::Warn, false),
            toned("pending", "1", Tone::Info, false),
            toned("done", "1", Tone::Muted, false),
            toned("deleting", "1", Tone::Muted, true),
        ];
        let mut pending = vec![Pending::snapshot(snapshot, FeedStatus::Ready)];
        let out = Arc::new(parking_lot::Mutex::new(Vec::new()));
        let o = out.clone();
        let sink: Sink = Arc::new(move |msg: String| {
            o.lock().push(msg);
            true
        });
        let mut ui = Ui::default();
        let step = |pending: &mut Vec<Pending>, slots: &mut Vec<Slot>, ui: &mut Ui| {
            while flush(&sink, &mut Vec::new(), slots, pending, Projection::Problems, LIMITS) == Flushed::Some {}
            for batch in out.lock().drain(..) {
                ui.apply(&batch);
            }
            let mut rows = ui.rows("prod-eu-z1|");
            rows.sort();
            rows
        };
        assert_eq!(step(&mut pending, &mut slots, &mut ui), ["crash", "degraded", "deleting", "pending"]);

        // Recovered: gone from the view; went bad: in it; fine before and after, or deleted unseen: no news.
        pending[0].push(FeedEvent::Upsert(toned("crash", "2", Tone::Ok, false)));
        pending[0].push(FeedEvent::Upsert(toned("ok", "2", Tone::Error, false)));
        pending[0].push(FeedEvent::Upsert(toned("done", "2", Tone::Muted, false)));
        pending[0].push(FeedEvent::Delete(Arc::from("degraded")));
        let before = ui.messages;
        assert_eq!(step(&mut pending, &mut slots, &mut ui), ["deleting", "ok", "pending"]);
        assert_eq!(ui.messages, before + 1);

        pending[0].push(FeedEvent::Upsert(toned("done", "3", Tone::Muted, false)));
        pending[0].push(FeedEvent::Delete(Arc::from("never-sent")));
        let before = ui.messages;
        assert_eq!(step(&mut pending, &mut slots, &mut ui), ["deleting", "ok", "pending"]);
        assert_eq!(ui.messages, before, "nothing to tell");
    }

    #[tokio::test]
    async fn names_of_big_snapshots_go_out_in_chunks_too() {
        let hub = crate::feed::WatchHub::new(tokio::runtime::Handle::current(), Duration::from_secs(60));
        let mut slots = vec![slot("prod-eu-z1", quiet_lease(&hub, "prod-eu-z1"))];
        let rows: Vec<Arc<Row>> = (0..1000).map(|i| row(&format!("uid-{i}"), &format!("namespace-{i:04}"), "1")).collect();
        let mut pending = vec![Pending::snapshot(rows, FeedStatus::Ready)];
        let out = Arc::new(parking_lot::Mutex::new(Vec::new()));
        let o = out.clone();
        let sink: Sink = Arc::new(move |msg: String| {
            o.lock().push(msg);
            true
        });
        let limits = Limits { rows: 10, bytes: 4096 };
        while flush(&sink, &mut Vec::new(), &mut slots, &mut pending, Projection::Names, limits) == Flushed::Some {}
        let mut ui = Ui::default();
        for batch in out.lock().iter() {
            assert!(batch.len() < 4096 + 64, "{}", batch.len());
            ui.apply(batch);
        }
        assert!(out.lock().len() >= 4, "{}", out.lock().len());
        assert_eq!(ui.rows("prod-eu-z1|").len(), 1000);
        assert!(!ui.status_while_staged);
        // Later, only names that come or go.
        pending[0].push(FeedEvent::Upsert(row("uid-1", "namespace-0001", "2")));
        pending[0].push(FeedEvent::Delete(Arc::from("uid-2")));
        assert_eq!(flush(&sink, &mut Vec::new(), &mut slots, &mut pending, Projection::Names, limits), Flushed::All);
        let last: Value = serde_json::from_str(out.lock().last().unwrap()).unwrap();
        assert_eq!(last["m"][0], json!({"t": "names", "c": "prod-eu-z1", "ns": null, "del": ["namespace-0002"]}));
    }

    #[tokio::test]
    async fn a_view_that_falls_behind_a_big_list_gets_every_row_in_chunks() {
        let inner = Inner::for_tests();
        let n = 2 * CHUNK_ROWS + 1_000;
        let items: Vec<String> =
            (0..n).map(|i| format!(r#"{{"metadata":{{"name":"pod-{i}","namespace":"default","uid":"uid-{i}","resourceVersion":"10"}}}}"#)).collect();
        let list = format!(r#"{{"kind":"PodList","apiVersion":"v1","metadata":{{"resourceVersion":"10"}},"items":[{}]}}"#, items.join(","));
        let client =
            fake::server(Arc::default(), move |uri, _| if uri.contains("watch=true") { fake::Reply::events(&[]) } else { fake::Reply::json(list.clone()) });
        inner.clusters.insert_ready_for_tests(Cluster::for_tests("prod-eu-z1", client, vec![testing::pods()]));
        let out = start(&inner);
        let ui = Arc::new(parking_lot::Mutex::new((Ui::default(), 0)));
        let applied = || {
            let mut ui = ui.lock();
            let (ui, seen) = &mut *ui;
            for batch in &out.lock()[*seen..] {
                ui.apply(batch);
            }
            *seen = out.lock().len();
            ui.status.get("prod-eu-z1|").is_some_and(|s| s == "ready") && ui.rows("prod-eu-z1|").len() == n
        };
        until("every row", applied).await;
        let ui = &ui.lock().0;
        // The list outran the view's subscription (1024 events buffered): it took the feed's rows instead.
        assert!(ui.resets >= 2, "{}", ui.resets);
        assert_eq!(ui.most, CHUNK_ROWS);
        assert!(!ui.status_while_staged);
        assert!(out.lock().iter().all(|b| b.len() < CHUNK_BYTES + 4096));
    }

    /// A sink collecting what it is sent.
    fn collect() -> (Sink, Arc<parking_lot::Mutex<Vec<String>>>) {
        let out = Arc::new(parking_lot::Mutex::new(Vec::new()));
        let o = out.clone();
        (
            Arc::new(move |msg: String| {
                o.lock().push(msg);
                true
            }),
            out,
        )
    }

    #[tokio::test]
    async fn big_deltas_go_out_in_parts_too() {
        let hub = crate::feed::WatchHub::new(tokio::runtime::Handle::current(), Duration::from_secs(60));
        let mut slots = vec![slot("prod-eu-z1", quiet_lease(&hub, "prod-eu-z1"))];
        let rows: Vec<Arc<Row>> = (0..20_000).map(|i| row(&format!("uid-{i}"), &format!("pod-{i}"), "1")).collect();
        let mut pending = vec![Pending::snapshot(rows, FeedStatus::Ready)];
        let (sink, out) = collect();
        let limits = Limits { rows: 10, bytes: 4096 };
        while flush(&sink, &mut Vec::new(), &mut slots, &mut pending, Projection::Rows, limits) == Flushed::Some {}
        let mut ui = Ui::default();
        for batch in out.lock().drain(..) {
            ui.apply(&batch);
        }
        assert_eq!(ui.rows("prod-eu-z1|").len(), 20_000);

        // The namespace was deleted (or a relist after a reconnect found them gone): 20k deletes at once, a few
        // new objects, and the feed's status.
        for i in 0..20_000 {
            pending[0].push(FeedEvent::Delete(Arc::from(format!("uid-{i}"))));
        }
        for i in 0..25 {
            pending[0].push(FeedEvent::Upsert(row(&format!("new-{i:02}"), &format!("new-{i}"), "1")));
        }
        pending[0].push(FeedEvent::Status(FeedStatus::Loading));
        while flush(&sink, &mut Vec::new(), &mut slots, &mut pending, Projection::Rows, limits) == Flushed::Some {}
        let batches = out.lock().clone();
        assert!(batches.len() > 20, "{}", batches.len());
        for (i, batch) in batches.iter().enumerate() {
            assert!(batch.len() < 4096 + 128, "{}", batch.len());
            // The status follows the last part.
            assert_eq!(batch.contains(r#""t":"status""#), i == batches.len() - 1, "{batch}");
            ui.apply(batch);
        }
        assert_eq!(ui.rows("prod-eu-z1|"), (0..25).map(|i| format!("new-{i:02}")).collect::<Vec<_>>());
        assert_eq!(ui.status["prod-eu-z1|"], "loading");
    }

    /// Applies the names messages of `batch` as `createNamesFeed` does: per name, how many objects carry it (removals
    /// first, of names it has; then additions). Returns how many removals it had to ignore.
    fn apply_names(names: &mut HashMap<String, usize>, batch: &str) -> usize {
        let v: Value = serde_json::from_str(batch).unwrap();
        let mut ignored = 0;
        for m in v["m"].as_array().unwrap().iter().filter(|m| m["t"] == "names") {
            assert!(m.get("more").is_none() || m["reset"] == true, "{m}");
            if m["reset"] == true {
                names.clear();
            }
            for d in m["del"].as_array().cloned().unwrap_or_default() {
                match names.get_mut(d.as_str().unwrap()) {
                    Some(1) => drop(names.remove(d.as_str().unwrap())),
                    Some(n) => *n -= 1,
                    None => ignored += 1,
                }
            }
            for u in m["up"].as_array().cloned().unwrap_or_default() {
                *names.entry(u.as_str().unwrap().to_string()).or_default() += 1;
            }
        }
        ignored
    }

    #[tokio::test]
    async fn name_changes_go_out_in_parts_and_none_is_removed_before_it_was_added() {
        let hub = crate::feed::WatchHub::new(tokio::runtime::Handle::current(), Duration::from_secs(60));
        let mut slots = vec![slot("prod-eu-z1", quiet_lease(&hub, "prod-eu-z1"))];
        // A cold feed: its snapshot is empty, its list comes as changes.
        let mut pending = vec![Pending::snapshot(Vec::new(), FeedStatus::Loading)];
        let (sink, out) = collect();
        let limits = Limits { rows: 10, bytes: 4096 };
        assert_eq!(flush(&sink, &mut Vec::new(), &mut slots, &mut pending, Projection::Names, limits), Flushed::All);
        let name = |i: usize| format!("namespace-{i:05}");
        for i in 0..20_000 {
            pending[0].push(FeedEvent::Upsert(row(&format!("uid-{i}"), &name(i), "1")));
        }
        assert_eq!(flush(&sink, &mut Vec::new(), &mut slots, &mut pending, Projection::Names, limits), Flushed::Some);
        // Half of them go before all were sent: some the UI has, most it was never sent (those cancel out).
        for i in (0..20_000).step_by(2) {
            pending[0].push(FeedEvent::Delete(Arc::from(format!("uid-{i}"))));
        }
        // One more object of a name the UI has.
        pending[0].push(FeedEvent::Upsert(row("uid-again", &name(1), "1")));
        pending[0].push(FeedEvent::Status(FeedStatus::Ready));
        while flush(&sink, &mut Vec::new(), &mut slots, &mut pending, Projection::Names, limits) == Flushed::Some {}
        let mut names = HashMap::new();
        let batches = out.lock().clone();
        assert!(batches.len() > 20, "{}", batches.len());
        for batch in &batches {
            assert!(batch.len() < 4096 + 64, "{}", batch.len());
            assert_eq!(apply_names(&mut names, batch), 0, "a name removed before it was added: {batch}");
        }
        assert!(batches.last().unwrap().contains(r#""state":"ready""#));
        assert_eq!(names.len(), 10_000);
        assert!(names.keys().all(|n| n.trim_start_matches("namespace-").parse::<usize>().unwrap() % 2 == 1));
        assert_eq!(names[&name(1)], 2);
    }
}
