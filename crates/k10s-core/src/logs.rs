//! Log streaming for any number of containers across any number of clusters, merged into one
//! batched stream. Containers can be added and removed while it runs ([`crate::Engine::update_log_targets`]):
//! a workload's pods come and go during a rollout without the other streams being touched.
//!
//! Every container is followed by a task of its own that never hammers the API server. A stream that
//! ends is not reopened blindly: the container's state (from the shared pod feeds when they hold the
//! pod, else fetched) decides. A terminated or waiting container is reported as such and followed
//! again once it runs; a finished or deleted pod ends its stream for good. Failed attempts back off
//! exponentially — the backoff starts over only after a stream that delivered lines or stayed open a
//! while — a cluster that cannot be reached is waited for, rejected credentials are renewed, and after
//! sleep ([`crate::Engine::resync`]) streams reconnect. A resumed stream continues after the last line
//! seen, without duplicating lines. Lines are read with a size cap, so a container that never writes a
//! line break cannot make the engine buffer without bound, and history is bounded per subscription.
//! `previous` logs are a one-shot read.
//!
//! Earlier history of a stream that runs is a one-shot read of its own: each target with its own tail,
//! stopped at the first line written after the earliest one the UI holds (`until`) — what follows it
//! is not transferred again.

use std::collections::{HashMap, HashSet};
use std::hash::{Hash, Hasher};
use std::sync::Arc;
use std::time::Duration;

use futures::{AsyncBufRead, AsyncBufReadExt};
use k8s_openapi::api::core::v1::Pod;
use kube::Api;
use kube::api::LogParams;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::{mpsc, watch};
use tokio::task::{AbortHandle, JoinSet};
use tokio::time::Instant;

use crate::cluster::{Changes, ConnState, is_auth_failure};
use crate::engine::Inner;
use crate::error::{Error, chain};
use crate::time;
use crate::view::Sink;

/// Lines go out this soon after the first of them…
const FLUSH_EVERY: Duration = Duration::from_millis(50);
/// …or, while a log writes more than [`BUSY_RATE`] lines a second, this long after the batch before: a busy log is
/// drawn four times a second instead of twenty — the same lines, a fifth of the work for the app — and a line after
/// a pause still goes out at once.
const FLUSH_BUSY: Duration = Duration::from_millis(250);
const BUSY_RATE: f64 = 100.0;
/// A batch goes out once it holds this many lines…
const MAX_BATCH: usize = 5_000;
/// …or this much text.
const MAX_BATCH_BYTES: usize = 1024 * 1024;
/// Longer lines are cut (and marked); the rest of such a line is skipped as it arrives, never buffered.
const MAX_LINE: usize = 64 * 1024;
/// Containers one subscription streams at once; further ones are reported as not streamed.
pub const MAX_TARGETS: usize = 50;
/// History (tail) lines of all containers of a subscription together — as many as the UI keeps at most.
/// With many containers each one gets its share, also when all lines were asked for.
const HISTORY_LINES: i64 = 100_000;
/// The smallest share of history a container gets.
const MIN_TAIL: i64 = 100;
/// History of a container added to a running subscription whose pod was created after it started (a
/// rollout, a scale-up): it just started, there is little to show.
const NEW_POD_TAIL: i64 = 1_000;
/// Pods created this long before the subscription started still count as new.
const NEW_POD_SLACK_SECS: i64 = 10;
/// Retries back off exponentially from the first to the second.
const BACKOFF_BASE: Duration = Duration::from_secs(1);
const BACKOFF_MAX: Duration = Duration::from_secs(30);
/// A stream that delivered lines or stayed open this long was healthy: the backoff starts over.
const HEALTHY: Duration = Duration::from_secs(10);
/// While a container does not run, its state is checked this often in the shared pod feeds (no network)…
const POLL_FEED: Duration = Duration::from_secs(2);
/// …or fetched from the API server, backing off from the first to the second.
const POLL_GET: Duration = Duration::from_secs(5);
const POLL_GET_MAX: Duration = Duration::from_secs(30);
/// Fetching the pod to see why its stream ended gives up after this long (the network may be down).
const PROBE_TIMEOUT: Duration = Duration::from_secs(10);
/// A target still shown as streaming after its stream ended: finding out why and reconnecting are reported
/// once they took this long together (a quick success is not worth a flash of "reconnecting").
const QUIET_RECONNECT: Duration = Duration::from_secs(3);

#[derive(Debug, Clone, PartialEq, Eq, Hash, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogTarget {
    pub cluster: String,
    pub namespace: String,
    pub pod: String,
    pub container: String,
    /// The pod's uid: a pod re-created under the same name (a StatefulSet's) is another target, and the
    /// stream of the one deleted ends instead of reading the new one's logs.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub uid: Option<String>,
    /// Identifies the target in messages (`i`); defaults to its position in the list. Targets of a
    /// running stream are changed by id ([`crate::Engine::update_log_targets`]).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<usize>,
    /// This target's own history (instead of its share of the subscription's): a read of earlier history
    /// asks each container for as many of its last lines as reach back far enough.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tail_lines: Option<i64>,
    /// The read stops at the first line written after this time (unix millis): earlier history of a
    /// container whose later lines were read already. For one-shot reads (`follow: false`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub until: Option<i64>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogSpec {
    pub targets: Vec<LogTarget>,
    /// Ignored with `previous`: a terminated container's logs are read once.
    #[serde(default = "yes")]
    pub follow: bool,
    /// Per container; capped when there are many (see [`HISTORY_LINES`]). `None`: all lines.
    #[serde(default)]
    pub tail_lines: Option<i64>,
    #[serde(default)]
    pub since_seconds: Option<i64>,
    #[serde(default)]
    pub previous: bool,
    /// What is shown (`deployments.apps shop/web`), for diagnostics only: the targets of a workload's
    /// stream change while it runs.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

fn yes() -> bool {
    true
}

/// What a target's stream is doing, as reported to the UI.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum State {
    /// Connected: lines arrive as the container writes them.
    Streaming,
    /// Trying again after a failure (backing off).
    Reconnecting,
    /// The container has not started yet, or waits to restart: followed once it runs.
    Waiting,
    /// Nothing more to read: the logs were read (one-shot), the pod finished or is gone, or the container
    /// terminated — in a running pod it is followed again if it restarts.
    Ended,
    /// Retrying cannot fix it (permissions…), or the cluster cannot be used until its connection changes.
    Error,
}

enum Msg {
    Line(usize, Option<i64>, String),
    State(usize, State, Option<String>),
}

#[derive(Serialize)]
struct StateMsg<'a> {
    t: &'static str,
    i: usize,
    state: State,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<&'a str>,
}

fn state_msg(i: usize, state: State, message: Option<&str>) -> String {
    serde_json::to_string(&StateMsg { t: "state", i, state, message }).unwrap_or_default()
}

/// New targets for a running subscription (see [`run`]).
pub(crate) type Control = mpsc::UnboundedSender<Vec<LogTarget>>;

/// What every target of a subscription shares.
struct Opts {
    follow: bool,
    previous: bool,
    tail: Option<i64>,
    since_seconds: Option<i64>,
    /// When the subscription started (unix seconds), to tell new pods apart.
    started: i64,
}

/// Where a target's first read starts, and where its reading stops (see [`LogTarget::until`]).
#[derive(Debug, Clone, Copy, PartialEq)]
struct History {
    tail: Option<i64>,
    since_seconds: Option<i64>,
    until: Option<i64>,
}

/// Each target's share of [`HISTORY_LINES`]: a single one gets what was asked for.
fn tail_share(requested: Option<i64>, targets: usize) -> Option<i64> {
    if targets <= 1 {
        return requested;
    }
    let share = (HISTORY_LINES / targets as i64).max(MIN_TAIL);
    Some(requested.map_or(share, |n| n.min(share)))
}

/// Streams the logs of `spec.targets` to `sink` until cancelled; `control` replaces the targets: new ones
/// start, gone ones stop, the rest go on undisturbed.
pub(crate) async fn run(inner: Arc<Inner>, spec: LogSpec, sink: Sink, mut control: mpsc::UnboundedReceiver<Vec<LogTarget>>) {
    let opts = Arc::new(Opts {
        follow: spec.follow && !spec.previous,
        previous: spec.previous,
        tail: spec.tail_lines.filter(|n| *n >= 0),
        since_seconds: spec.since_seconds,
        started: time::now_unix(),
    });
    let (tx, mut rx) = mpsc::channel::<Msg>(8_192);
    let mut streams = Streams { inner, opts, tx, tasks: JoinSet::new(), current: HashMap::new() };
    let mut lines: Vec<(usize, Option<i64>, String)> = Vec::new();
    let mut bytes = 0usize;
    let mut states: Vec<String> = Vec::new();
    let mut deadline: Option<Instant> = None;
    let mut controlled = true;
    let mut pace = Pace::new(Instant::now());

    streams.retarget(spec.targets, true, &mut states);
    loop {
        let timer = async {
            match deadline {
                Some(d) => tokio::time::sleep_until(d).await,
                None => std::future::pending().await,
            }
        };
        let flush_now = tokio::select! {
            msg = rx.recv() => match msg {
                Some(Msg::Line(i, ts, text)) => {
                    bytes += text.len();
                    lines.push((i, ts, text));
                    deadline.get_or_insert_with(|| pace.deadline(Instant::now()));
                    lines.len() >= MAX_BATCH || bytes >= MAX_BATCH_BYTES
                }
                Some(Msg::State(i, state, message)) => {
                    states.push(state_msg(i, state, message.as_deref()));
                    true
                }
                // Never: `streams` holds a sender for the targets still to come.
                None => return,
            },
            targets = control.recv(), if controlled => match targets {
                Some(targets) => {
                    streams.retarget(targets, false, &mut states);
                    !states.is_empty()
                }
                None => {
                    controlled = false;
                    false
                }
            },
            // Finished target tasks are collected (a stopped target stays current until it is removed).
            Some(_) = streams.tasks.join_next() => false,
            _ = timer => true,
        };
        if flush_now {
            let n = lines.len();
            if !flush(&sink, &mut lines, &mut states) {
                return;
            }
            pace.flushed(Instant::now(), n);
            bytes = 0;
            deadline = None;
        }
    }
}

/// When lines go out (see [`FLUSH_BUSY`]).
struct Pace {
    /// When the last batch went out, and whether the log was busy then.
    flushed_at: Instant,
    busy: bool,
}

impl Pace {
    fn new(now: Instant) -> Self {
        Pace { flushed_at: now, busy: false }
    }

    /// When lines that start coming `now` go out.
    fn deadline(&self, now: Instant) -> Instant {
        let soon = now + FLUSH_EVERY;
        if self.busy { soon.max(self.flushed_at + FLUSH_BUSY) } else { soon }
    }

    /// `n` lines went out `now`.
    fn flushed(&mut self, now: Instant, n: usize) {
        if n == 0 {
            return;
        }
        self.busy = n as f64 / now.duration_since(self.flushed_at).max(FLUSH_EVERY).as_secs_f64() >= BUSY_RATE;
        self.flushed_at = now;
    }
}

/// The targets of a subscription, each streamed by a task of its own.
struct Streams {
    inner: Arc<Inner>,
    opts: Arc<Opts>,
    tx: mpsc::Sender<Msg>,
    tasks: JoinSet<()>,
    current: HashMap<LogTarget, AbortHandle>,
}

impl Streams {
    /// Makes `targets` the current ones: those no longer wanted stop, new ones start (up to [`MAX_TARGETS`];
    /// state messages for the rest go to `states`), unchanged ones are left alone.
    fn retarget(&mut self, targets: Vec<LogTarget>, initial: bool, states: &mut Vec<String>) {
        let mut seen = HashSet::new();
        let wanted: Vec<LogTarget> = targets
            .into_iter()
            .enumerate()
            .map(|(pos, mut t)| {
                t.id.get_or_insert(pos);
                t
            })
            .filter(|t| seen.insert(t.clone()))
            .collect();
        self.current.retain(|t, task| {
            let keep = seen.contains(t);
            if !keep {
                task.abort();
            }
            keep
        });
        let opts = &self.opts;
        let share = tail_share(opts.tail, wanted.len().min(MAX_TARGETS));
        let (mut started, mut skipped) = (0, 0);
        for t in wanted {
            if self.current.contains_key(&t) {
                continue;
            }
            let i = t.id.unwrap_or_default();
            if self.current.len() >= MAX_TARGETS {
                states.push(state_msg(i, State::Ended, Some(format!("not streamed: at most {MAX_TARGETS} containers at once").as_str())));
                skipped += 1;
                continue;
            }
            let own = t.tail_lines.filter(|n| *n >= 0);
            let mut history = History { tail: own.or(share), since_seconds: opts.since_seconds, until: t.until };
            if own.is_none() && !initial && !opts.previous && pod_is_new(&self.inner, &t, opts.started) {
                history.tail = Some(share.map_or(NEW_POD_TAIL, |n| n.min(NEW_POD_TAIL)));
            }
            let task = self.tasks.spawn(stream_one(self.inner.clone(), i, t.clone(), history, opts.clone(), self.tx.clone()));
            self.current.insert(t, task);
            started += 1;
        }
        if !initial {
            tracing::debug!(streams = self.current.len(), started, skipped, "log targets changed");
        }
    }
}

/// The pod (as the shared feeds know it) was created after the subscription started.
fn pod_is_new(inner: &Inner, t: &LogTarget, started: i64) -> bool {
    let Some(json) = inner.hub.find_object(&t.cluster, "pods", Some(&t.namespace), &t.pod, t.uid.as_deref()) else { return false };
    let Ok(pod) = serde_json::from_str::<Value>(&json) else { return false };
    pod["metadata"]["creationTimestamp"].as_str().and_then(time::unix_seconds).is_some_and(|created| created >= started - NEW_POD_SLACK_SECS)
}

#[derive(Serialize)]
struct LinesMsg<'a> {
    t: &'static str,
    /// `[target id, unix millis | null, text]`
    l: &'a [(usize, Option<i64>, String)],
}

fn flush(sink: &Sink, lines: &mut Vec<(usize, Option<i64>, String)>, states: &mut Vec<String>) -> bool {
    if !lines.is_empty() {
        let msg = serde_json::to_string(&LinesMsg { t: "lines", l: lines }).unwrap_or_default();
        lines.clear();
        if !sink(msg) {
            return false;
        }
    }
    for s in states.drain(..) {
        if !sink(s) {
            return false;
        }
    }
    true
}

/// The subscription is gone (its task was stopped): stop too.
struct Closed;

/// A target's messages. State changes only: repeating a state sends nothing.
struct Out {
    i: usize,
    tx: mpsc::Sender<Msg>,
    shown: Option<(State, Option<String>)>,
}

impl Out {
    async fn state(&mut self, state: State, message: Option<String>) -> Result<(), Closed> {
        if self.shown.as_ref().is_some_and(|(s, m)| *s == state && *m == message) {
            return Ok(());
        }
        self.shown = Some((state, message.clone()));
        self.tx.send(Msg::State(self.i, state, message)).await.map_err(|_| Closed)
    }

    fn streaming(&self) -> bool {
        matches!(self.shown, Some((State::Streaming, _)))
    }

    async fn line(&self, ts: Option<i64>, text: String) -> Result<(), Closed> {
        self.tx.send(Msg::Line(self.i, ts, text)).await.map_err(|_| Closed)
    }
}

/// Wakes a waiting stream: on a resync (wake from sleep, network change) and when its cluster's
/// connection changes (a reconnect, a failed attempt…).
struct Wake {
    changes: watch::Receiver<Changes>,
    resyncs: u64,
    open: bool,
}

/// A cluster's connection as last seen: its generation and phase.
fn connection(inner: &Inner, cluster: &str) -> Option<(u64, u8)> {
    inner.clusters.state(cluster).map(|(g, s)| {
        (
            g,
            match s {
                ConnState::Connecting => 0,
                ConnState::Ready => 1,
                ConnState::Failed(_) => 2,
            },
        )
    })
}

impl Wake {
    fn new(inner: &Inner) -> Self {
        let mut changes = inner.clusters.changes();
        let resyncs = changes.borrow_and_update().resyncs;
        Wake { changes, resyncs, open: true }
    }

    /// The next change: whether it was a resync.
    async fn next(&mut self) -> bool {
        if !self.open {
            std::future::pending::<()>().await;
        }
        if self.changes.changed().await.is_err() {
            self.open = false;
            std::future::pending::<()>().await;
        }
        let now = self.changes.borrow_and_update().resyncs;
        std::mem::replace(&mut self.resyncs, now) != now
    }

    /// Resolves at the next resync.
    async fn resync(&mut self) {
        while !self.next().await {}
    }

    /// Waits `delay` (`None`: indefinitely), cut short when `cluster`'s connection is no longer `seen` —
    /// taken before the attempt that failed, so a change while it ran is not missed — or, when there is a
    /// delay (a retry is due anyway), by a resync.
    async fn wait(&mut self, delay: Option<Duration>, inner: &Inner, cluster: &str, seen: Option<(u64, u8)>) {
        if connection(inner, cluster) != seen {
            return;
        }
        let sleep = async {
            match delay {
                Some(d) => tokio::time::sleep(d).await,
                None => std::future::pending().await,
            }
        };
        tokio::pin!(sleep);
        loop {
            tokio::select! {
                _ = &mut sleep => return,
                resync = self.next() => {
                    if (resync && delay.is_some()) || connection(inner, cluster) != seen {
                        return;
                    }
                }
            }
        }
    }
}

#[derive(Default)]
struct Backoff {
    attempt: u32,
}

impl Backoff {
    fn next(&mut self) -> Duration {
        let d = BACKOFF_BASE.saturating_mul(1 << self.attempt.min(5)).min(BACKOFF_MAX);
        self.attempt += 1;
        d
    }

    fn reset(&mut self) {
        self.attempt = 0;
    }
}

/// Where a resumed stream picks up: the API's `sinceTime` has whole seconds, so it asks for the start of
/// the second of the last line sent and skips what was sent already.
#[derive(Default)]
struct Resume {
    /// Timestamp of the last line sent, and hashes of the lines sent with exactly that timestamp.
    last: Option<(i64, u32)>,
    at_last: Vec<u64>,
    /// While a resumed stream replays the second of `last`: the lines of it still to skip.
    skip: Option<((i64, u32), Vec<u64>)>,
}

fn text_hash(text: &str) -> u64 {
    let mut h = std::collections::hash_map::DefaultHasher::new();
    text.hash(&mut h);
    h.finish()
}

impl Resume {
    /// Called before each read: where to start, `None` for the first read.
    fn since(&mut self) -> Option<jiff::Timestamp> {
        let (s, _) = self.last?;
        self.skip = self.last.map(|l| (l, self.at_last.clone()));
        jiff::Timestamp::new(s, 0).ok()
    }

    /// Whether to send a line read from the stream (`false`: it was sent before a reconnect).
    fn admit(&mut self, ts: Option<(i64, u32)>, text: &str) -> bool {
        let Some(ts) = ts else { return true };
        let hash = text_hash(text);
        if let Some((last, skip)) = &mut self.skip {
            if ts < *last {
                return false;
            }
            if ts == *last {
                if let Some(p) = skip.iter().position(|h| *h == hash) {
                    skip.swap_remove(p);
                    return false;
                }
            } else {
                self.skip = None;
            }
        }
        match self.last {
            Some(last) if ts == last => self.at_last.push(hash),
            Some(last) if ts < last => {}
            _ => {
                self.last = Some(ts);
                self.at_last.clear();
                self.at_last.push(hash);
            }
        }
        true
    }
}

/// What a container is doing, as far as its pod tells.
#[derive(Debug, PartialEq)]
enum Probe {
    /// The pod is gone.
    Gone,
    /// The pod finished (Succeeded/Failed): its containers will not run again.
    Finished {
        seen: String,
        message: String,
    },
    /// Not running: terminated, or waiting to start or restart. `seen` tells a container run (restart
    /// count, container id) and its state apart from the next one.
    Stopped {
        seen: String,
        message: String,
        waiting: bool,
    },
    Running,
    /// The pod could not be looked at.
    Unknown,
}

fn terminated_text(t: &Value) -> String {
    let reason = t["reason"].as_str().filter(|r| !r.is_empty()).unwrap_or("terminated");
    match t["exitCode"].as_i64() {
        Some(code) => format!("container terminated: {reason} (exit code {code})"),
        None => format!("container terminated: {reason}"),
    }
}

/// The state of `container` in `pod` (a Pod object as JSON).
fn probe_pod(pod: &Value, container: &str) -> Probe {
    let status = &pod["status"];
    let phase = status["phase"].as_str().unwrap_or_default();
    let finished = matches!(phase, "Succeeded" | "Failed");
    let found = ["containerStatuses", "initContainerStatuses", "ephemeralContainerStatuses"]
        .iter()
        .filter_map(|k| status[k].as_array())
        .flatten()
        .find(|c| c["name"] == container);
    let Some(cs) = found else {
        return match phase {
            _ if finished => Probe::Finished { seen: String::new(), message: format!("pod {phase}") },
            "" | "Pending" => Probe::Stopped { seen: "pending".into(), message: "waiting for the pod to start".into(), waiting: true },
            _ => Probe::Unknown,
        };
    };
    let state = &cs["state"];
    let seen = |kind: &str, reason: &str| {
        format!("{kind}/{reason}/{}/{}", cs["restartCount"].as_i64().unwrap_or_default(), cs["containerID"].as_str().unwrap_or_default())
    };
    if let Some(t) = state.get("terminated") {
        let (seen, message) = (seen("terminated", t["reason"].as_str().unwrap_or_default()), terminated_text(t));
        return if finished { Probe::Finished { seen, message } } else { Probe::Stopped { seen, message, waiting: false } };
    }
    if let Some(w) = state.get("waiting") {
        let reason = w["reason"].as_str().filter(|r| !r.is_empty()).unwrap_or("waiting");
        let message = match cs["lastState"].get("terminated") {
            Some(t) => format!("{}, waiting to restart ({reason})", terminated_text(t)),
            None => format!("waiting to start: {reason}"),
        };
        let seen = seen("waiting", reason);
        return if finished { Probe::Finished { seen, message } } else { Probe::Stopped { seen, message, waiting: true } };
    }
    if finished {
        return Probe::Finished { seen: seen("finished", ""), message: format!("pod {phase}") };
    }
    if state.get("running").is_some() { Probe::Running } else { Probe::Unknown }
}

/// Looks at the target's container in the shared pod feeds (no network); `None` if they do not hold its pod.
fn probe_feed(inner: &Inner, t: &LogTarget) -> Option<Probe> {
    let find = |uid: Option<&str>| inner.hub.find_object(&t.cluster, "pods", Some(&t.namespace), &t.pod, uid);
    let json = match t.uid.as_deref() {
        Some(uid) => match find(Some(uid)) {
            Some(json) => json,
            // Only a pod of that name with another uid: the target's was deleted (and re-created).
            None => return find(None).map(|_| Probe::Gone),
        },
        None => find(None)?,
    };
    let pod = serde_json::from_str::<Value>(&json).ok()?;
    Some(probe_pod(&pod, &t.container))
}

/// Looks at the target's container: in the shared pod feeds (free) if they hold the pod, else by getting
/// it. Also returns whether the answer came from a feed.
async fn probe(inner: &Inner, api: &Api<Pod>, t: &LogTarget) -> (Probe, bool) {
    if let Some(p) = probe_feed(inner, t) {
        return (p, true);
    }
    let p = match tokio::time::timeout(PROBE_TIMEOUT, api.get_opt(&t.pod)).await {
        // Another pod of the same name: the target's was deleted.
        Ok(Ok(Some(pod))) if t.uid.as_deref().is_some_and(|uid| pod.metadata.uid.as_deref() != Some(uid)) => Probe::Gone,
        Ok(Ok(Some(pod))) => serde_json::to_value(&pod).map_or(Probe::Unknown, |v| probe_pod(&v, &t.container)),
        Ok(Ok(None)) => Probe::Gone,
        Ok(Err(_)) | Err(_) => Probe::Unknown,
    };
    (p, false)
}

/// Rejected for its credentials: 401, or the exec plugin failed refreshing a token.
fn rejected(err: &Error) -> bool {
    match err {
        Error::Kube(kube::Error::Api(s)) => s.code == 401,
        Error::Kube(e) => is_auth_failure(e),
        _ => false,
    }
}

/// What a 400 answer to a log request means.
#[derive(Debug, PartialEq)]
enum BadRequest {
    /// `previous` was asked for, but the container never restarted (or its logs are gone).
    NoPrevious,
    /// The container does not run (yet): waiting to start, image pull failing, pod not scheduled…
    NotRunning(String),
    /// The pod has no such container (its workload's template gained one the older pods lack).
    NoSuchContainer,
    Other,
}

fn bad_request(message: &str) -> BadRequest {
    if message.contains("previous terminated container") {
        return BadRequest::NoPrevious;
    }
    if message.contains("does not have a host assigned") {
        return BadRequest::NotRunning("waiting for the pod to be scheduled".into());
    }
    // kubelet: `container "app" in pod "web-1" is waiting to start: ContainerCreating` / `… is terminated`
    for what in ["is waiting to start", "is terminated"] {
        if let Some(at) = message.find(what) {
            return BadRequest::NotRunning(message[at + 3..].to_string());
        }
    }
    // `container sidecar is not valid for pod web-1`
    if message.contains("is not valid for pod") {
        return BadRequest::NoSuchContainer;
    }
    BadRequest::Other
}

async fn stream_one(inner: Arc<Inner>, i: usize, target: LogTarget, history: History, opts: Arc<Opts>, tx: mpsc::Sender<Msg>) {
    let mut out = Out { i, tx, shown: None };
    if follow_target(&inner, &target, history, &opts, &mut out).await.is_err() {
        tracing::trace!(pod = %target.pod, container = %target.container, "log stream closed");
    }
}

async fn follow_target(inner: &Arc<Inner>, target: &LogTarget, history: History, opts: &Opts, out: &mut Out) -> Result<(), Closed> {
    // A read that stops at a time is a one-shot read.
    let follow = opts.follow && history.until.is_none();
    let mut wake = Wake::new(inner);
    let mut backoff = Backoff::default();
    let mut resume = Resume::default();
    // When the last stream ended: finding out why and reconnecting (while still shown as streaming) are
    // not reported unless they take longer than [`QUIET_RECONNECT`] together.
    let mut ended: Option<Instant> = None;
    loop {
        // The connection before the attempt: a change while it runs ends the wait after a failure at once.
        let conn = connection(inner, &target.cluster);
        let cluster = match quietly(out, ended, inner.connect(&target.cluster, false)).await? {
            Ok(c) => c,
            Err(err) => {
                // Network trouble is retried on a timer; anything else waits for the cluster to change (a
                // reconnect) rather than running its auth plugin again and again.
                let retryable = matches!(inner.clusters.state(&target.cluster), Some((_, ConnState::Failed(e))) if e.retryable);
                out.state(if retryable { State::Reconnecting } else { State::Error }, Some(err.message())).await?;
                wake.wait(retryable.then(|| backoff.next()), inner, &target.cluster, conn).await;
                continue;
            }
        };
        let api: Api<Pod> = Api::namespaced(cluster.client.clone(), &target.namespace);
        let mut lp = LogParams { container: Some(target.container.clone()), follow, previous: opts.previous, timestamps: true, ..Default::default() };
        match resume.since() {
            Some(since) => lp.since_time = Some(since),
            None => (lp.tail_lines, lp.since_seconds) = (history.tail, history.since_seconds),
        }

        // The connection the request goes out with (its credentials may be renewed while it runs).
        let conn = connection(inner, &target.cluster);
        let opened = Instant::now();
        let res = quietly(out, ended.take(), api.log_stream(&target.pod, &lp)).await?;
        let err = match res {
            Ok(reader) => {
                out.state(State::Streaming, None).await?;
                let (end, sent) = read_lines(reader, out, &mut resume, &mut wake, history.until).await?;
                ended = Some(Instant::now());
                let healthy = sent > 0 || opened.elapsed() >= HEALTHY;
                if healthy {
                    backoff.reset();
                }
                let broken = match end {
                    // The connection may be dead after sleep: reconnect right away, quietly.
                    End::Resync => continue,
                    End::Eof if !follow => {
                        out.state(State::Ended, None).await?;
                        return Ok(());
                    }
                    End::Broken(e) => {
                        tracing::debug!(pod = %target.pod, container = %target.container, e = %e, "log stream interrupted");
                        true
                    }
                    End::Eof => false,
                };
                if !follow {
                    // A one-shot read broke off: read on from where it stopped (whatever the container does now).
                    if !healthy {
                        let delay = backoff.next();
                        out.state(State::Reconnecting, None).await?;
                        wake.wait(Some(delay), inner, &target.cluster, conn).await;
                    }
                    continue;
                }
                // Why did it end? A container that does not run is not reconnected to. A broken connection
                // (the network, a read timeout) says nothing about the container: only the shared feeds are
                // asked then, not the API server — the reconnect tells soon enough.
                let (now, from_feed) = if broken {
                    probe_feed(inner, target).map_or((Probe::Unknown, false), |p| (p, true))
                } else {
                    quietly(out, ended, probe(inner, &api, target)).await?
                };
                match now {
                    Probe::Gone => {
                        out.state(State::Ended, Some("pod deleted".into())).await?;
                        return Ok(());
                    }
                    Probe::Finished { message, .. } => {
                        out.state(State::Ended, Some(message)).await?;
                        return Ok(());
                    }
                    stopped @ Probe::Stopped { .. } => {
                        if !until_running(inner, &api, target, (stopped, from_feed), backoff.next(), out, &mut wake).await? {
                            return Ok(());
                        }
                    }
                    // Still running (or unknown): the connection ended (read timeout, API server restart…).
                    // After a healthy stream reconnect right away without reporting it — a quick success is
                    // not worth a flash of "reconnecting"; else back off.
                    Probe::Running | Probe::Unknown if healthy => {}
                    Probe::Running | Probe::Unknown => {
                        let delay = backoff.next();
                        out.state(State::Reconnecting, None).await?;
                        wake.wait(Some(delay), inner, &target.cluster, conn).await;
                    }
                }
                continue;
            }
            Err(e) => Error::from(e),
        };

        let message = err.message();
        if rejected(&err) {
            out.state(State::Reconnecting, Some("credentials rejected, signing in again".into())).await?;
            if inner.reauthenticate(&target.cluster).await {
                continue;
            }
            // Not renewed here. The connection changed since the request went out: the credentials were
            // renewed under it (or are being renewed — the next attempt joins that): just try again.
            if connection(inner, &target.cluster) != conn {
                continue;
            }
            match inner.clusters.state(&target.cluster) {
                // Signing in again for another stream or a watch, begun before this request went out.
                Some((_, ConnState::Connecting)) => wake.wait(None, inner, &target.cluster, conn).await,
                Some((_, ConnState::Failed(e))) if e.retryable => {
                    out.state(State::Reconnecting, Some(e.message)).await?;
                    wake.wait(Some(backoff.next()), inner, &target.cluster, conn).await;
                }
                // Renewed a moment ago and rejected all the same, or the cluster cannot be used: wait for its
                // next (re)connect.
                _ => {
                    out.state(State::Error, Some(message)).await?;
                    wake.wait(None, inner, &target.cluster, conn).await;
                }
            }
            continue;
        }
        match err.code() {
            Some(400) => match bad_request(&message) {
                BadRequest::NoPrevious => {
                    let text = format!("no previous container: \"{}\" has not restarted, or its earlier logs are gone", target.container);
                    out.state(State::Ended, Some(text)).await?;
                    return Ok(());
                }
                BadRequest::NoSuchContainer => {
                    out.state(State::Ended, Some(format!("this pod has no container \"{}\"", target.container))).await?;
                    return Ok(());
                }
                BadRequest::NotRunning(text) if !follow => {
                    out.state(State::Ended, Some(text)).await?;
                    return Ok(());
                }
                BadRequest::NotRunning(text) => {
                    let (now, from_feed) = probe(inner, &api, target).await;
                    let now = match now {
                        // The feed has not caught up yet: trust the server.
                        Probe::Running | Probe::Unknown => Probe::Stopped { seen: String::new(), message: text, waiting: true },
                        other => other,
                    };
                    if !until_running(inner, &api, target, (now, from_feed), backoff.next(), out, &mut wake).await? {
                        return Ok(());
                    }
                }
                BadRequest::Other => {
                    out.state(State::Error, Some(message)).await?;
                    return Ok(());
                }
            },
            Some(404) => {
                out.state(State::Ended, Some(format!("pod deleted ({message})"))).await?;
                return Ok(());
            }
            // Permissions, invalid requests: retrying cannot fix them.
            Some(code) if (400..500).contains(&code) && !matches!(code, 408 | 429) => {
                out.state(State::Error, Some(message)).await?;
                return Ok(());
            }
            // Network trouble, server errors.
            _ => {
                let delay = backoff.next();
                tracing::debug!(pod = %target.pod, container = %target.container, ?delay, "log stream failed: {message}");
                out.state(State::Reconnecting, Some(message)).await?;
                wake.wait(Some(delay), inner, &target.cluster, conn).await;
            }
        }
    }
}

/// Awaits `fut`. While the target is still shown as streaming (a quiet reconnect after a healthy stream
/// ended, at `ended`), that is reported only if it takes longer than [`QUIET_RECONNECT`].
async fn quietly<T>(out: &mut Out, ended: Option<Instant>, fut: impl Future<Output = T>) -> Result<T, Closed> {
    if !out.streaming() {
        return Ok(fut.await);
    }
    let deadline = ended.unwrap_or_else(Instant::now) + QUIET_RECONNECT;
    tokio::pin!(fut);
    tokio::select! {
        res = &mut fut => Ok(res),
        _ = tokio::time::sleep_until(deadline) => {
            out.state(State::Reconnecting, None).await?;
            Ok(fut.await)
        }
    }
}

/// Waits while the container does not run, reporting why. Returns `true` to read its logs again — it
/// runs, or it ran meanwhile (restarted, maybe crashed again: its lines are read all the same) — at least
/// `min` (a backoff) after the stream ended; `false` (reported) when its pod finished or went away. `first`:
/// what the container does now, and whether that came from the shared pod feeds — they are checked often,
/// else the pod is fetched, backing off.
async fn until_running(
    inner: &Inner,
    api: &Api<Pod>,
    target: &LogTarget,
    first: (Probe, bool),
    min: Duration,
    out: &mut Out,
    wake: &mut Wake,
) -> Result<bool, Closed> {
    let since = Instant::now();
    let (mut now, mut from_feed) = first;
    let first = match &now {
        Probe::Stopped { seen, .. } => seen.clone(),
        _ => String::new(),
    };
    let ran = |seen: &str| !first.is_empty() && !seen.is_empty() && seen != first;
    let mut get = POLL_GET;
    loop {
        let ready = match &now {
            Probe::Gone => {
                out.state(State::Ended, Some("pod deleted".into())).await?;
                return Ok(false);
            }
            Probe::Finished { seen, .. } if ran(seen) => true,
            Probe::Finished { message, .. } => {
                out.state(State::Ended, Some(message.clone())).await?;
                return Ok(false);
            }
            Probe::Stopped { seen, .. } if ran(seen) => true,
            Probe::Stopped { message, waiting, .. } => {
                out.state(if *waiting { State::Waiting } else { State::Ended }, Some(message.clone())).await?;
                false
            }
            // Unknown: (re)open the stream to find out, on the backoff.
            Probe::Running | Probe::Unknown => true,
        };
        let mut delay = if from_feed {
            POLL_FEED
        } else {
            let d = get;
            get = (get * 2).min(POLL_GET_MAX);
            d
        };
        if ready {
            match min.checked_sub(since.elapsed()) {
                Some(left) if !left.is_zero() => delay = left,
                _ => return Ok(true),
            }
        }
        let seen = connection(inner, &target.cluster);
        wake.wait(Some(delay), inner, &target.cluster, seen).await;
        (now, from_feed) = probe(inner, api, target).await;
    }
}

/// How a stream ended.
enum End {
    Eof,
    Broken(String),
    Resync,
}

/// Reads and sends lines until the stream ends — or, with `until` (unix millis), until a line written after
/// it: the read ends there (the rest is not transferred). Returns how and how many lines were sent.
async fn read_lines(reader: impl AsyncBufRead, out: &Out, resume: &mut Resume, wake: &mut Wake, until: Option<i64>) -> Result<(End, usize), Closed> {
    let mut reader = std::pin::pin!(reader);
    // One wait for a resync across all lines (not a new one per line).
    let mut resync = std::pin::pin!(wake.resync());
    let mut buf = Vec::with_capacity(512);
    let mut sent = 0;
    loop {
        let next = tokio::select! {
            res = read_line(&mut reader, &mut buf, MAX_LINE) => res,
            _ = &mut resync => return Ok((End::Resync, sent)),
        };
        match next {
            Ok(None) => return Ok((End::Eof, sent)),
            Ok(Some(cut)) => {
                let (ts, text) = split_line(&buf, cut);
                let ms = ts.map(|(s, n)| s * 1000 + (n / 1_000_000) as i64);
                if let (Some(until), Some(ms)) = (until, ms)
                    && ms > until
                {
                    return Ok((End::Eof, sent));
                }
                if !resume.admit(ts, &text) {
                    continue;
                }
                out.line(ms, text).await?;
                sent += 1;
            }
            Err(e) => return Ok((End::Broken(chain(&e)), sent)),
        }
    }
}

/// Reads the next line into `buf`, without its line break (`\n` or `\r\n`). Keeps at most `max` bytes of
/// it: the rest is skipped as it arrives, never buffered. Returns how many bytes were cut, or `None` at
/// the end of the stream.
async fn read_line<R: AsyncBufRead + Unpin>(reader: &mut R, buf: &mut Vec<u8>, max: usize) -> std::io::Result<Option<usize>> {
    buf.clear();
    let mut cut = 0usize;
    // The line so far ends with `\r` (it may be the first half of a line break split between reads).
    let mut cr = false;
    let trim = |buf: &mut Vec<u8>, cut: &mut usize, cr: bool| {
        if cr {
            if *cut > 0 {
                *cut -= 1;
            } else {
                buf.pop();
            }
        }
    };
    loop {
        let chunk = reader.fill_buf().await?;
        if chunk.is_empty() {
            // A last line without a line break counts too.
            if buf.is_empty() && cut == 0 {
                return Ok(None);
            }
            trim(buf, &mut cut, cr);
            return Ok(Some(cut));
        }
        let newline = chunk.iter().position(|&b| b == b'\n');
        let part = &chunk[..newline.unwrap_or(chunk.len())];
        if let Some(&last) = part.last() {
            cr = last == b'\r';
        }
        let take = part.len().min(max.saturating_sub(buf.len()));
        buf.extend_from_slice(&part[..take]);
        cut += part.len() - take;
        let used = newline.map_or(chunk.len(), |n| n + 1);
        reader.consume_unpin(used);
        if newline.is_some() {
            trim(buf, &mut cut, cr);
            return Ok(Some(cut));
        }
    }
}

/// Splits `2024-01-01T00:00:00.123456789Z message` into the parsed timestamp and the text; a line that
/// was cut (`cut` bytes) is marked.
fn split_line(line: &[u8], cut: usize) -> (Option<(i64, u32)>, String) {
    let text = |b: &[u8]| {
        if cut == 0 {
            return String::from_utf8_lossy(b).into_owned();
        }
        // Do not leave half a character where the line was cut.
        let mut end = b.len();
        let cont = b.iter().rev().take(3).take_while(|&&c| c & 0xC0 == 0x80).count();
        if cont < b.len() {
            let lead = b[b.len() - 1 - cont];
            let width = match lead {
                0xF0.. => 4,
                0xE0.. => 3,
                0xC0.. => 2,
                _ => 1,
            };
            if width > cont + 1 {
                end = b.len() - 1 - cont;
            }
        }
        let mut s = String::from_utf8_lossy(&b[..end]).into_owned();
        s.push_str(&format!("… [{} bytes truncated]", cut + b.len() - end));
        s
    };
    if let Some(sp) = line.iter().position(|&c| c == b' ')
        && let Ok(prefix) = std::str::from_utf8(&line[..sp])
        && let Some(ts) = time::parse_rfc3339(prefix)
    {
        return (Some(ts), text(&line[sp + 1..]));
    }
    (None, text(line))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use crate::cluster::{Cluster, ConnectError};
    use parking_lot::Mutex;

    #[test]
    fn splits_timestamp_prefix() {
        let (ts, text) = split_line(b"2024-01-01T00:00:00.5Z hello world", 0);
        assert_eq!(ts, Some((1_704_067_200, 500_000_000)));
        assert_eq!(text, "hello world");
        let (ts, text) = split_line(b"no timestamp here", 0);
        assert_eq!(ts, None);
        assert_eq!(text, "no timestamp here");
        // A cut line is marked, and not cut in the middle of a character.
        let (_, text) = split_line("2024-01-01T00:00:00Z ab€".as_bytes()[..25].as_ref(), 10);
        assert_eq!(text, "ab… [12 bytes truncated]");
    }

    /// A reader that hands out the given chunks one `fill_buf` at a time.
    fn chunks(parts: &[&[u8]]) -> impl AsyncBufRead + Unpin {
        use futures::TryStreamExt;
        let parts: Vec<std::io::Result<Vec<u8>>> = parts.iter().map(|p| Ok(p.to_vec())).collect();
        futures::stream::iter(parts).into_async_read()
    }

    async fn lines_of(parts: &[&[u8]], max: usize) -> Vec<(String, usize)> {
        let mut reader = chunks(parts);
        let mut buf = Vec::new();
        let mut out = Vec::new();
        while let Some(cut) = read_line(&mut reader, &mut buf, max).await.unwrap() {
            out.push((String::from_utf8(buf.clone()).unwrap(), cut));
        }
        out
    }

    #[tokio::test]
    async fn lines_are_read_with_a_cap_and_crlf_is_a_line_break() {
        let got = lines_of(&[b"one\r\ntw", b"o\r", b"\nthree\n", b"no break at the end"], 64).await;
        assert_eq!(got, [("one".into(), 0), ("two".into(), 0), ("three".into(), 0), ("no break at the end".into(), 0)]);
        // A \r inside a line stays (progress bars), only the one before the line break goes.
        let got = lines_of(&[b"10%\r20%\r\n"], 64).await;
        assert_eq!(got, [("10%\r20%".into(), 0)]);
        // An endless line: the first bytes are kept, the rest is counted and dropped as it arrives.
        let big = vec![b'x'; 100_000];
        let got = lines_of(&[&big, &big, b"\r\nnext\n"], 1_000).await;
        assert_eq!(got, [("x".repeat(1_000), 199_000), ("next".into(), 0)]);
    }

    #[test]
    fn history_is_shared_between_many_containers() {
        assert_eq!(tail_share(None, 1), None);
        assert_eq!(tail_share(Some(20_000), 1), Some(20_000));
        assert_eq!(tail_share(Some(1_000), 10), Some(1_000));
        assert_eq!(tail_share(Some(20_000), 50), Some(2_000));
        assert_eq!(tail_share(None, 50), Some(2_000));
        assert_eq!(tail_share(None, 5_000), Some(MIN_TAIL));
    }

    #[test]
    fn resumed_streams_skip_what_was_sent() {
        let mut r = Resume::default();
        let t = |s: i64, n: u32| Some((s, n));
        assert!(r.since().is_none());
        for (ts, text) in [(t(10, 1), "a"), (t(11, 2), "b"), (t(11, 2), "c"), (None, "no ts")] {
            assert!(r.admit(ts, text));
        }
        // Reconnect: asks from the start of second 11, replays b, c and an older line, then new ones.
        assert_eq!(r.since(), jiff::Timestamp::new(11, 0).ok());
        assert!(!r.admit(t(11, 1), "older"));
        assert!(!r.admit(t(11, 2), "c"));
        assert!(!r.admit(t(11, 2), "b"));
        assert!(r.admit(t(11, 2), "d"), "same timestamp, new line");
        assert!(r.admit(t(12, 0), "e"));
        assert!(r.admit(t(12, 0), "e"), "a repeated line after the replay is a new line");
        // Reconnect again: both e lines were sent.
        r.since();
        assert!(!r.admit(t(12, 0), "e") && !r.admit(t(12, 0), "e"));
        assert!(r.admit(t(12, 0), "e"));
    }

    fn pod(phase: &str, container: Value) -> Value {
        serde_json::json!({ "metadata": { "name": "web-1" }, "status": { "phase": phase, "containerStatuses": [container] } })
    }

    #[test]
    fn container_states() {
        let running = serde_json::json!({ "name": "app", "restartCount": 0, "state": { "running": {} } });
        assert_eq!(probe_pod(&pod("Running", running.clone()), "app"), Probe::Running);
        assert_eq!(probe_pod(&pod("Running", running), "sidecar"), Probe::Unknown);
        let done = serde_json::json!({ "name": "app", "state": { "terminated": { "reason": "Completed", "exitCode": 0 } } });
        assert!(
            matches!(probe_pod(&pod("Succeeded", done), "app"), Probe::Finished { message, .. } if message == "container terminated: Completed (exit code 0)")
        );
        let crashloop = serde_json::json!({
            "name": "app", "restartCount": 4,
            "state": { "waiting": { "reason": "CrashLoopBackOff" } },
            "lastState": { "terminated": { "reason": "Error", "exitCode": 1 } },
        });
        let Probe::Stopped { message, waiting, seen } = probe_pod(&pod("Running", crashloop), "app") else { panic!() };
        assert_eq!(message, "container terminated: Error (exit code 1), waiting to restart (CrashLoopBackOff)");
        assert!(waiting && seen.contains("/4/"));
        let pending = serde_json::json!({ "metadata": {}, "status": { "phase": "Pending" } });
        assert!(matches!(probe_pod(&pending, "app"), Probe::Stopped { waiting: true, .. }));
    }

    #[test]
    fn bad_requests() {
        assert_eq!(bad_request(r#"previous terminated container "app" in pod "web-1" not found"#), BadRequest::NoPrevious);
        assert_eq!(
            bad_request(r#"container "app" in pod "web-1" is waiting to start: ContainerCreating"#),
            BadRequest::NotRunning("waiting to start: ContainerCreating".into())
        );
        assert_eq!(bad_request(r#"container "app" in pod "web-1" is terminated"#), BadRequest::NotRunning("terminated".into()));
        assert_eq!(bad_request(r#"pod web-1 does not have a host assigned"#), BadRequest::NotRunning("waiting for the pod to be scheduled".into()));
        assert_eq!(bad_request(r#"container sidecar is not valid for pod web-1"#), BadRequest::NoSuchContainer);
        assert_eq!(bad_request("a container name must be specified for pod web-1, choose one of: [app sidecar]"), BadRequest::Other);
    }

    // ------------------------------------------------------------------ a fake API server

    /// Answer to a log request.
    enum Reply {
        Status(u16, &'static str),
        /// These lines, then the end of the stream — or, `open`, a stream that stays open.
        Lines(Vec<String>, bool),
        /// These lines, then the connection breaks.
        Broken(Vec<String>),
        /// This status, once `gate` is notified.
        Gated(Arc<tokio::sync::Notify>, u16, &'static str),
        /// No answer at all.
        Hang,
    }

    struct Body {
        chunks: VecDeque<std::io::Result<bytes::Bytes>>,
        open: bool,
    }

    impl http_body::Body for Body {
        type Data = bytes::Bytes;
        type Error = std::io::Error;

        fn poll_frame(
            mut self: std::pin::Pin<&mut Self>,
            _cx: &mut std::task::Context<'_>,
        ) -> std::task::Poll<Option<Result<http_body::Frame<bytes::Bytes>, Self::Error>>> {
            match self.chunks.pop_front() {
                Some(d) => std::task::Poll::Ready(Some(d.map(http_body::Frame::data))),
                None if self.open => std::task::Poll::Pending,
                None => std::task::Poll::Ready(None),
            }
        }
    }

    type Script = Arc<dyn Fn(usize, &str) -> Reply + Send + Sync>;

    /// A fake API server for the pods of namespace `default`: `logs(n, uri)` answers the n-th log request;
    /// `pods` are what a GET of a pod (missing: 404) and a list of the namespace return (for feeds, whose
    /// watches stay open and quiet).
    #[derive(Clone)]
    struct Fake {
        logs: Arc<Mutex<Script>>,
        pods: Arc<Mutex<Vec<Value>>>,
        log_uris: Arc<Mutex<Vec<String>>>,
        /// GETs of a single pod.
        gets: Arc<AtomicUsize>,
        /// Those GETs never get an answer (the network is down).
        hang_gets: Arc<std::sync::atomic::AtomicBool>,
        version: Arc<AtomicUsize>,
    }

    impl Fake {
        fn new(logs: impl Fn(usize, &str) -> Reply + Send + Sync + 'static) -> Self {
            Fake {
                logs: Arc::new(Mutex::new(Arc::new(logs))),
                pods: Arc::default(),
                log_uris: Arc::default(),
                gets: Arc::default(),
                hang_gets: Arc::default(),
                version: Arc::default(),
            }
        }

        fn client(&self) -> kube::Client {
            let fake = self.clone();
            let svc = tower::service_fn(move |req: http::Request<kube::client::Body>| {
                let uri = req.uri().to_string();
                let path = uri.split('?').next().unwrap_or_default().to_string();
                let (mut hang, mut gate) = (false, None);
                let (status, body, open) = if path.ends_with("/log") {
                    let n = {
                        let mut uris = fake.log_uris.lock();
                        uris.push(uri.clone());
                        uris.len() - 1
                    };
                    let script = fake.logs.lock().clone();
                    match script(n, &uri) {
                        Reply::Status(code, message) => (code, vec![Ok(status_json(code, message))], false),
                        Reply::Lines(lines, open) => (200, lines.into_iter().map(|l| Ok(format!("{l}\n"))).collect(), open),
                        Reply::Broken(lines) => {
                            (200, lines.into_iter().map(|l| Ok(format!("{l}\n"))).chain([Err(std::io::Error::other("connection reset"))]).collect(), false)
                        }
                        Reply::Gated(g, code, message) => {
                            gate = Some(g);
                            (code, vec![Ok(status_json(code, message))], false)
                        }
                        Reply::Hang => {
                            hang = true;
                            (200, Vec::new(), true)
                        }
                    }
                } else if path.ends_with("/pods") {
                    if uri.contains("watch=true") {
                        (200, Vec::new(), true)
                    } else {
                        let rv = fake.version.load(Ordering::SeqCst);
                        let list = serde_json::json!({ "kind": "PodList", "apiVersion": "v1", "metadata": { "resourceVersion": rv.to_string() }, "items": *fake.pods.lock() });
                        (200, vec![Ok(list.to_string())], false)
                    }
                } else {
                    fake.gets.fetch_add(1, Ordering::SeqCst);
                    hang = fake.hang_gets.load(Ordering::SeqCst);
                    let name = path.rsplit('/').next().unwrap_or_default();
                    match fake.pods.lock().iter().find(|p| p["metadata"]["name"] == name) {
                        Some(pod) => (200, vec![Ok(pod.to_string())], false),
                        None => (404, vec![Ok(status_json(404, &format!(r#"pods \"{name}\" not found"#)))], false),
                    }
                };
                async move {
                    if let Some(gate) = gate {
                        gate.notified().await;
                    }
                    if hang {
                        std::future::pending::<()>().await;
                    }
                    Ok::<_, std::convert::Infallible>(
                        http::Response::builder()
                            .status(status)
                            .header("content-type", "application/json")
                            .body(Body { chunks: body.into_iter().map(|c| c.map(bytes::Bytes::from)).collect(), open })
                            .unwrap(),
                    )
                }
            });
            kube::Client::new(svc, "default")
        }

        fn requests(&self) -> usize {
            self.log_uris.lock().len()
        }

        fn uri(&self, n: usize) -> String {
            self.log_uris.lock()[n].clone()
        }

        /// Adds the pod, or replaces the one of its name (namespace `default`; it gets a new resourceVersion).
        fn set_pod(&self, mut pod: Value) {
            let rv = self.version.fetch_add(1, Ordering::SeqCst) + 1;
            let name = pod["metadata"]["name"].as_str().unwrap_or("web-1").to_string();
            let meta = &mut pod["metadata"];
            meta["name"] = name.clone().into();
            meta["namespace"] = "default".into();
            meta["resourceVersion"] = rv.to_string().into();
            if meta["uid"].is_null() {
                meta["uid"] = format!("uid-{name}").into();
            }
            if meta["creationTimestamp"].is_null() {
                meta["creationTimestamp"] = "2020-01-01T00:00:00Z".into();
            }
            let mut pods = self.pods.lock();
            pods.retain(|p| p["metadata"]["name"] != name.as_str());
            pods.push(pod);
        }
    }

    fn status_json(code: u16, message: &str) -> String {
        let reason = match code {
            400 => "BadRequest",
            401 => "Unauthorized",
            404 => "NotFound",
            _ => "ServiceUnavailable",
        };
        format!(r#"{{"kind":"Status","apiVersion":"v1","status":"Failure","message":"{message}","reason":"{reason}","code":{code}}}"#)
    }

    fn line(sec: i64, text: &str) -> String {
        format!("{} {text}", time::format_rfc3339(1_700_000_000 + sec).replace('Z', ".5Z"))
    }

    fn target(pod: &str, container: &str) -> LogTarget {
        LogTarget {
            cluster: "prod-eu-z1".into(),
            namespace: "default".into(),
            pod: pod.into(),
            container: container.into(),
            uid: None,
            id: None,
            tail_lines: None,
            until: None,
        }
    }

    fn connected(inner: &Arc<Inner>, fake: &Fake) {
        inner.clusters.insert_ready_for_tests(Cluster::for_tests("prod-eu-z1", fake.client(), vec![crate::testing::pods()]));
    }

    /// A shared feed of the namespace's pods (as a pods view of it would hold), once it lists them.
    async fn feed(inner: &Arc<Inner>, fake: &Fake) -> crate::feed::FeedLease {
        let key = crate::feed::FeedKey { cluster: "prod-eu-z1".into(), resource: "pods".into(), namespace: Some("default".into()), labels: None, fields: None };
        let lease = inner.hub.lease(key, || crate::feed::FeedSpec {
            client: fake.client(),
            api_resource: kube::discovery::ApiResource::erase::<Pod>(&()),
            renderer: crate::render::generic(),
        });
        refreshed(inner, fake).await;
        lease
    }

    /// Waits until the feeds hold every pod of `fake` as it is now (after `hub.resync()` re-listed them).
    async fn refreshed(inner: &Arc<Inner>, fake: &Fake) {
        let pods = fake.pods.lock().clone();
        until("the feed", || {
            pods.iter().all(|p| {
                let name = p["metadata"]["name"].as_str().unwrap();
                inner
                    .hub
                    .find_object("prod-eu-z1", "pods", Some("default"), name, None)
                    .is_some_and(|json| serde_json::from_str::<Value>(&json).unwrap()["metadata"]["resourceVersion"] == p["metadata"]["resourceVersion"])
            })
        })
        .await;
    }

    struct Run {
        out: Arc<Mutex<Vec<Value>>>,
        control: Control,
        task: tokio::task::JoinHandle<()>,
    }

    impl Drop for Run {
        fn drop(&mut self) {
            self.task.abort();
        }
    }

    impl Run {
        /// `[i, state, message]` of every state message so far.
        fn states(&self) -> Vec<(usize, String, String)> {
            let out = self.out.lock();
            out.iter()
                .filter(|m| m["t"] == "state")
                .map(|m| (m["i"].as_u64().unwrap() as usize, m["state"].as_str().unwrap().to_string(), m["message"].as_str().unwrap_or_default().to_string()))
                .collect()
        }

        fn state_names(&self) -> Vec<String> {
            self.states().into_iter().map(|(_, s, _)| s).collect()
        }

        /// Texts of every line so far.
        fn lines(&self) -> Vec<String> {
            let out = self.out.lock();
            out.iter()
                .filter(|m| m["t"] == "lines")
                .flat_map(|m| m["l"].as_array().unwrap().iter().map(|l| l[2].as_str().unwrap().to_string()).collect::<Vec<_>>())
                .collect()
        }
    }

    fn start(inner: &Arc<Inner>, spec: LogSpec) -> Run {
        let out = Arc::new(Mutex::new(Vec::new()));
        let o = out.clone();
        let sink: Sink = Arc::new(move |msg: String| {
            o.lock().push(serde_json::from_str(&msg).unwrap());
            true
        });
        let (control, rx) = mpsc::unbounded_channel();
        let task = tokio::spawn(run(inner.clone(), spec, sink, rx));
        Run { out, control, task }
    }

    fn spec(targets: Vec<LogTarget>) -> LogSpec {
        LogSpec { targets, follow: true, tail_lines: Some(1000), since_seconds: None, previous: false, label: None }
    }

    /// Waits (up to two minutes of the test's clock) until `ok()`.
    async fn until(what: &str, ok: impl Fn() -> bool) {
        for _ in 0..12_000 {
            if ok() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("timed out waiting for {what}");
    }

    fn running(restarts: i64) -> Value {
        pod("Running", serde_json::json!({ "name": "app", "restartCount": restarts, "containerID": format!("c-{restarts}"), "state": { "running": {} } }))
    }

    #[tokio::test(start_paused = true)]
    async fn previous_logs_are_read_once() {
        let inner = Inner::for_tests();
        let fake = Fake::new(|_, _| Reply::Lines(vec![line(0, "panic: boom")], false));
        connected(&inner, &fake);
        // Even when asked to follow (as older UIs did).
        let run = start(&inner, LogSpec { previous: true, ..spec(vec![target("web-1", "app")]) });
        until("ended", || run.state_names().last().is_some_and(|s| s == "ended")).await;
        tokio::time::sleep(Duration::from_secs(600)).await;
        assert_eq!(fake.requests(), 1);
        assert!(fake.uri(0).contains("previous=true") && !fake.uri(0).contains("follow"), "{}", fake.uri(0));
        assert_eq!(run.lines(), ["panic: boom"]);
        assert_eq!(run.state_names(), ["streaming", "ended"]);
    }

    #[tokio::test(start_paused = true)]
    async fn earlier_history_is_read_up_to_the_first_line_held() {
        let inner = Inner::for_tests();
        // The container's log, as a stream that stays open (it runs): ten lines, one a second.
        let fake = Fake::new(|_, _| Reply::Lines((0..10).map(|s| line(s, &format!("line {s}"))).collect(), true));
        connected(&inner, &fake);
        // The UI holds lines from the fifth on: it asks two containers for their last 3000 lines up to it.
        let held_from = (1_700_000_000 + 4) * 1000 + 500;
        let earlier = |pod: &str, id| LogTarget { id: Some(id), tail_lines: Some(3000), until: Some(held_from), ..target(pod, "app") };
        let run = start(&inner, LogSpec { tail_lines: None, ..spec(vec![earlier("web-1", 0), earlier("web-2", 1)]) });
        until("both ended", || run.state_names().iter().filter(|s| *s == "ended").count() == 2).await;
        tokio::time::sleep(Duration::from_secs(600)).await;
        // Up to the line held (it is the UI's to skip, with others of the same millisecond), not one after it,
        // though the stream stayed open; a one-shot read, never reopened.
        let mut lines = run.lines();
        lines.sort();
        let want: Vec<String> = (0..=4).flat_map(|s| [format!("line {s}"), format!("line {s}")]).collect();
        assert_eq!(lines, want);
        assert_eq!(fake.requests(), 2);
        for n in 0..2 {
            let uri = fake.uri(n);
            assert!(uri.contains("tailLines=3000") && !uri.contains("follow"), "its own tail, not a share: {uri}");
        }
    }

    #[tokio::test(start_paused = true)]
    async fn a_container_without_a_previous_one_ends_with_a_readable_message() {
        let inner = Inner::for_tests();
        let fake = Fake::new(|_, _| Reply::Status(400, r#"previous terminated container \"app\" in pod \"web-1\" not found"#));
        connected(&inner, &fake);
        let run = start(&inner, LogSpec { previous: true, ..spec(vec![target("web-1", "app")]) });
        until("ended", || !run.states().is_empty()).await;
        tokio::time::sleep(Duration::from_secs(600)).await;
        assert_eq!(fake.requests(), 1);
        assert_eq!(run.states(), [(0, "ended".into(), r#"no previous container: "app" has not restarted, or its earlier logs are gone"#.into())]);
    }

    #[tokio::test(start_paused = true)]
    async fn a_finished_container_ends_instead_of_reconnecting() {
        let inner = Inner::for_tests();
        let fake = Fake::new(|_, _| Reply::Lines(vec![line(0, "done")], false));
        fake.set_pod(pod("Succeeded", serde_json::json!({ "name": "app", "state": { "terminated": { "reason": "Completed", "exitCode": 0 } } })));
        connected(&inner, &fake);
        let run = start(&inner, spec(vec![target("web-1", "app")]));
        until("ended", || run.state_names().last().is_some_and(|s| s == "ended")).await;
        tokio::time::sleep(Duration::from_secs(600)).await;
        assert_eq!((fake.requests(), fake.gets.load(Ordering::SeqCst)), (1, 1));
        assert_eq!(run.states().last().unwrap().2, "container terminated: Completed (exit code 0)");
    }

    #[tokio::test(start_paused = true)]
    async fn a_deleted_pod_ends_its_stream() {
        let inner = Inner::for_tests();
        let fake = Fake::new(|_, _| Reply::Lines(vec![line(0, "bye")], false));
        connected(&inner, &fake);
        let run = start(&inner, spec(vec![target("web-1", "app")]));
        until("ended", || run.state_names().last().is_some_and(|s| s == "ended")).await;
        tokio::time::sleep(Duration::from_secs(600)).await;
        assert_eq!(fake.requests(), 1);
        assert_eq!(run.states().last().unwrap().2, "pod deleted");
    }

    #[tokio::test(start_paused = true)]
    async fn a_crashlooping_container_is_waited_for_and_followed_again_when_it_restarts() {
        let inner = Inner::for_tests();
        let fake = Fake::new(|n, _| {
            Reply::Lines(
                if n == 0 { vec![line(0, "starting"), line(1, "panic: boom")] } else { vec![line(1, "panic: boom"), line(30, "starting again")] },
                n > 0,
            )
        });
        fake.set_pod(pod(
            "Running",
            serde_json::json!({ "name": "app", "restartCount": 3, "containerID": "c-3", "state": { "waiting": { "reason": "CrashLoopBackOff" } }, "lastState": { "terminated": { "reason": "Error", "exitCode": 2 } } }),
        ));
        connected(&inner, &fake);
        let run = start(&inner, spec(vec![target("web-1", "app")]));
        until("waiting", || run.state_names().last().is_some_and(|s| s == "waiting")).await;
        // Five minutes of back-off: no log requests, the pod is looked at every 5…30 s.
        tokio::time::sleep(Duration::from_secs(300)).await;
        assert_eq!(fake.requests(), 1);
        let gets = fake.gets.load(Ordering::SeqCst);
        assert!((5..=15).contains(&gets), "{gets} pod reads");
        assert_eq!(run.states().last().unwrap().2, "container terminated: Error (exit code 2), waiting to restart (CrashLoopBackOff)");

        // It runs again: followed from where it left off, without repeating lines.
        fake.set_pod(running(4));
        until("streaming again", || run.state_names().last().is_some_and(|s| s == "streaming")).await;
        until("the new line", || run.lines().len() == 3).await;
        assert_eq!(run.lines(), ["starting", "panic: boom", "starting again"]);
        let uri = fake.uri(1);
        assert!(uri.contains("sinceTime=2023-11-14T22%3A13%3A21Z") && !uri.contains("tailLines"), "{uri}");
    }

    #[tokio::test(start_paused = true)]
    async fn a_container_that_restarted_between_two_looks_is_read_again() {
        let inner = Inner::for_tests();
        let fake = Fake::new(|n, _| Reply::Lines(if n == 0 { vec![line(0, "run 1")] } else { vec![line(40, "run 2: panic")] }, false));
        let crashed = |restarts: i64| {
            pod(
                "Running",
                serde_json::json!({ "name": "app", "restartCount": restarts, "containerID": format!("c-{restarts}"), "state": { "waiting": { "reason": "CrashLoopBackOff" } }, "lastState": { "terminated": { "reason": "Error", "exitCode": 1 } } }),
            )
        };
        fake.set_pod(crashed(1));
        connected(&inner, &fake);
        let run = start(&inner, spec(vec![target("web-1", "app")]));
        until("waiting", || run.state_names().last().is_some_and(|s| s == "waiting")).await;
        // It ran and crashed again between two looks: never seen running, but its lines are read.
        fake.set_pod(crashed(2));
        until("run 2", || run.lines().len() == 2).await;
        assert_eq!(run.lines(), ["run 1", "run 2: panic"]);
        until("waiting again", || run.state_names().last().is_some_and(|s| s == "waiting")).await;
        assert_eq!(fake.requests(), 2);
    }

    #[tokio::test(start_paused = true)]
    async fn streams_that_end_at_once_back_off_exponentially() {
        let inner = Inner::for_tests();
        // The pod says the container runs, but each stream ends right away without a line.
        let fake = Fake::new(|_, _| Reply::Lines(Vec::new(), false));
        fake.set_pod(running(0));
        connected(&inner, &fake);
        let run = start(&inner, spec(vec![target("web-1", "app")]));
        tokio::time::sleep(Duration::from_secs(120)).await;
        // 1 + retries after 1, 2, 4, 8, 16, 30, 30 s.
        let n = fake.requests();
        assert!((7..=9).contains(&n), "{n} requests in two minutes");
        assert!(run.state_names().contains(&"reconnecting".to_string()));
    }

    #[tokio::test(start_paused = true)]
    async fn a_healthy_stream_that_ends_reconnects_at_once_without_reporting_it() {
        let inner = Inner::for_tests();
        let fake = Fake::new(|n, _| match n {
            0 => Reply::Lines(vec![line(0, "a"), line(1, "b")], false),
            // The server replays the second asked for: b is not repeated.
            _ => Reply::Lines(vec![line(1, "b"), line(2, "c")], true),
        });
        fake.set_pod(running(0));
        connected(&inner, &fake);
        let run = start(&inner, spec(vec![target("web-1", "app")]));
        until("c", || run.lines().len() == 3).await;
        assert_eq!(run.lines(), ["a", "b", "c"]);
        assert_eq!(run.state_names(), ["streaming"], "no flash of reconnecting");
        assert!(fake.uri(0).contains("tailLines=1000") && fake.uri(0).contains("follow=true"));
        assert!(fake.uri(1).contains("sinceTime=2023-11-14T22%3A13%3A21Z"), "{}", fake.uri(1));
    }

    #[tokio::test(start_paused = true)]
    async fn a_failed_quick_reconnect_is_reported_and_retried_with_backoff() {
        let inner = Inner::for_tests();
        let fake = Fake::new(|n, _| match n {
            0 => Reply::Lines(vec![line(0, "a")], false),
            1 | 2 => Reply::Status(503, "unavailable"),
            _ => Reply::Lines(vec![line(5, "b")], true),
        });
        fake.set_pod(running(0));
        connected(&inner, &fake);
        let run = start(&inner, spec(vec![target("web-1", "app")]));
        until("b", || run.lines().len() == 2).await;
        assert_eq!(run.state_names(), ["streaming", "reconnecting", "streaming"]);
        assert_eq!(fake.requests(), 4);
    }

    #[tokio::test(start_paused = true)]
    async fn a_quiet_reconnect_that_takes_a_while_is_reported() {
        let inner = Inner::for_tests();
        let fake = Fake::new(|n, _| if n == 0 { Reply::Lines(vec![line(0, "a")], false) } else { Reply::Hang });
        fake.set_pod(running(0));
        connected(&inner, &fake);
        let run = start(&inner, spec(vec![target("web-1", "app")]));
        until("the reconnect", || fake.requests() == 2).await;
        tokio::time::sleep(QUIET_RECONNECT - Duration::from_millis(100)).await;
        assert_eq!(run.state_names(), ["streaming"]);
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert_eq!(run.state_names(), ["streaming", "reconnecting"]);
    }

    #[tokio::test(start_paused = true)]
    async fn a_container_that_is_not_running_yet_is_waited_for() {
        let inner = Inner::for_tests();
        let fake = Fake::new(|n, _| {
            if n == 0 {
                Reply::Status(400, r#"container \"app\" in pod \"web-1\" is waiting to start: ContainerCreating"#)
            } else {
                Reply::Lines(vec![line(0, "hello")], true)
            }
        });
        fake.set_pod(pod("Pending", serde_json::json!({ "name": "app", "state": { "waiting": { "reason": "ContainerCreating" } } })));
        connected(&inner, &fake);
        let run = start(&inner, spec(vec![target("web-1", "app")]));
        until("waiting", || !run.states().is_empty()).await;
        assert_eq!(run.states(), [(0, "waiting".into(), "waiting to start: ContainerCreating".into())]);
        tokio::time::sleep(Duration::from_secs(120)).await;
        assert_eq!(fake.requests(), 1);
        fake.set_pod(running(0));
        until("hello", || run.lines() == ["hello"]).await;
        assert!(fake.uri(1).contains("tailLines=1000"), "the first read starts with the tail: {}", fake.uri(1));
    }

    #[tokio::test(start_paused = true)]
    async fn a_stream_waits_for_its_cluster_to_connect() {
        let inner = Inner::for_tests();
        inner
            .clusters
            .insert_failed_for_tests("prod-eu-z1", ConnectError { message: "auth plugin `kubelogin` was not found".into(), code: None, retryable: false });
        let fake = Fake::new(|_, _| Reply::Lines(vec![line(0, "hello")], true));
        let run = start(&inner, spec(vec![target("web-1", "app")]));
        until("the error", || !run.states().is_empty()).await;
        assert_eq!(run.state_names(), ["error"]);
        // Not retried on its own (that would run the auth plugin again and again)…
        tokio::time::sleep(Duration::from_secs(600)).await;
        assert_eq!(run.state_names(), ["error"]);
        // …but as soon as the cluster connects (Retry in the UI).
        connected(&inner, &fake);
        until("hello", || run.lines() == ["hello"]).await;
        assert_eq!(run.state_names(), ["error", "streaming"]);
    }

    #[tokio::test(start_paused = true)]
    async fn rejected_credentials_are_renewed_and_the_stream_goes_on() {
        let inner = Inner::for_tests();
        let fake = Fake::new(|n, _| if n == 0 { Reply::Status(401, "Unauthorized") } else { Reply::Lines(vec![line(0, "hello")], true) });
        let client = fake.client();
        inner.fake_connect_for_tests(move |context, _| Ok((Cluster::for_tests(context, client.clone(), vec![crate::testing::pods()]), client.clone())));
        connected(&inner, &fake);
        let run = start(&inner, spec(vec![target("web-1", "app")]));
        until("hello", || run.lines() == ["hello"]).await;
        assert_eq!(run.state_names(), ["reconnecting", "streaming"]);
        assert_eq!(fake.requests(), 2);
    }

    #[tokio::test(start_paused = true)]
    async fn a_resync_reconnects_streams() {
        let inner = Inner::for_tests();
        let fake = Fake::new(|n, _| Reply::Lines(if n == 0 { vec![line(0, "a")] } else { vec![line(0, "a"), line(1, "b")] }, true));
        connected(&inner, &fake);
        let run = start(&inner, spec(vec![target("web-1", "app")]));
        until("a", || run.lines() == ["a"]).await;
        inner.clusters.nudge();
        until("b", || run.lines() == ["a", "b"]).await;
        assert_eq!(fake.requests(), 2);
        assert!(fake.uri(1).contains("sinceTime"));
        assert_eq!(run.state_names(), ["streaming"]);
    }

    #[tokio::test(start_paused = true)]
    async fn targets_are_added_and_removed_without_touching_the_others() {
        let inner = Inner::for_tests();
        let fake = Fake::new(|_, uri| {
            let pod = uri.split("/pods/").nth(1).unwrap().split('/').next().unwrap().to_string();
            Reply::Lines(vec![line(0, &format!("hello from {pod}"))], true)
        });
        connected(&inner, &fake);
        let with_id = |pod: &str, id| LogTarget { id: Some(id), ..target(pod, "app") };
        let run = start(&inner, spec(vec![with_id("web-1", 0), with_id("web-2", 1)]));
        until("both", || run.lines().len() == 2).await;

        // web-2 went away, web-3 came.
        run.control.send(vec![with_id("web-1", 0), with_id("web-3", 2)]).unwrap();
        until("web-3", || run.lines().len() == 3).await;
        tokio::time::sleep(Duration::from_secs(60)).await;
        assert_eq!(fake.requests(), 3, "web-1 was not reopened");
        assert!(fake.uri(2).contains("/web-3/"));
        let out = run.out.lock().clone();
        let last = out.iter().rev().find(|m| m["t"] == "lines").unwrap();
        assert_eq!(last["l"][0][0], 2, "lines carry the target's id");
    }

    #[tokio::test(start_paused = true)]
    async fn too_many_targets_are_reported_not_streamed() {
        let inner = Inner::for_tests();
        let fake = Fake::new(|_, _| Reply::Lines(Vec::new(), true));
        connected(&inner, &fake);
        let targets: Vec<LogTarget> = (0..MAX_TARGETS + 2).map(|n| target(&format!("web-{n}"), "app")).collect();
        let run = start(&inner, LogSpec { tail_lines: None, ..spec(targets) });
        until("all streams", || fake.requests() == MAX_TARGETS).await;
        until("the rest", || run.states().iter().filter(|(_, s, _)| s == "ended").count() == 2).await;
        let skipped: Vec<usize> = run.states().into_iter().filter(|(_, s, _)| s == "ended").map(|(i, _, _)| i).collect();
        assert_eq!(skipped, [MAX_TARGETS, MAX_TARGETS + 1]);
        // "All lines" of many containers: each gets its share.
        assert!(fake.uri(0).contains("tailLines=2000"), "{}", fake.uri(0));
    }

    #[test]
    fn a_busy_log_goes_out_four_times_a_second_and_a_line_after_a_pause_at_once() {
        let t0 = Instant::now();
        let ms = Duration::from_millis;
        let mut pace = Pace::new(t0);
        // A quiet log: 50 ms after its first line.
        assert_eq!(pace.deadline(t0 + ms(500)), t0 + ms(550));
        pace.flushed(t0 + ms(550), 2);
        assert_eq!(pace.deadline(t0 + ms(600)), t0 + ms(650));
        // 300 lines a second: 15 in 50 ms. The next batch goes out 250 ms after this one.
        pace.flushed(t0 + ms(600), 15);
        assert_eq!(pace.deadline(t0 + ms(610)), t0 + ms(850));
        pace.flushed(t0 + ms(850), 75);
        assert_eq!(pace.deadline(t0 + ms(860)), t0 + ms(1100));
        // A line after a pause: at once again (and the log is quiet from then on).
        assert_eq!(pace.deadline(t0 + ms(5_000)), t0 + ms(5_050));
        pace.flushed(t0 + ms(5_050), 1);
        assert_eq!(pace.deadline(t0 + ms(5_100)), t0 + ms(5_150));
        // State messages alone (no lines) change nothing.
        pace.flushed(t0 + ms(5_120), 0);
        assert_eq!(pace.deadline(t0 + ms(5_130)), t0 + ms(5_180));
    }

    #[tokio::test(start_paused = true)]
    async fn batches_are_bounded_by_size() {
        let inner = Inner::for_tests();
        let long = "x".repeat(60_000);
        let lines: Vec<String> = (0..60).map(|n| line(n, &long)).collect();
        let fake = Fake::new(move |_, _| Reply::Lines(lines.clone(), true));
        connected(&inner, &fake);
        let run = start(&inner, spec(vec![target("web-1", "app")]));
        until("all lines", || run.lines().len() == 60).await;
        let out = run.out.lock().clone();
        let batches: Vec<usize> = out.iter().filter(|m| m["t"] == "lines").map(|m| m["l"].as_array().unwrap().len()).collect();
        assert!(batches.len() >= 3 && batches.iter().all(|n| *n <= 18), "{batches:?}");
    }

    fn crashlooping(restarts: i64) -> Value {
        pod(
            "Running",
            serde_json::json!({ "name": "app", "restartCount": restarts, "containerID": format!("c-{restarts}"), "state": { "waiting": { "reason": "CrashLoopBackOff" } }, "lastState": { "terminated": { "reason": "Error", "exitCode": 1 } } }),
        )
    }

    #[tokio::test(start_paused = true)]
    async fn a_crashlooping_container_is_watched_in_the_feeds_without_fetching_its_pod() {
        let inner = Inner::for_tests();
        let fake = Fake::new(|n, _| Reply::Lines(if n == 0 { vec![line(0, "panic: boom")] } else { vec![line(60, "up again")] }, n > 0));
        fake.set_pod(crashlooping(3));
        connected(&inner, &fake);
        let _feed = feed(&inner, &fake).await;
        let run = start(&inner, spec(vec![target("web-1", "app")]));
        until("waiting", || run.state_names().last().is_some_and(|s| s == "waiting")).await;
        tokio::time::sleep(Duration::from_secs(300)).await;
        assert_eq!((fake.requests(), fake.gets.load(Ordering::SeqCst)), (1, 0), "no log requests, no pod reads");

        // It runs again: noticed in the feed within its poll interval (not the slower one of fetching).
        fake.set_pod(running(4));
        inner.hub.resync();
        refreshed(&inner, &fake).await;
        let noticed = Instant::now();
        until("streaming again", || fake.requests() == 2).await;
        assert!(noticed.elapsed() <= POLL_FEED, "{:?}", noticed.elapsed());
        until("the new line", || run.lines().len() == 2).await;
        assert_eq!(fake.gets.load(Ordering::SeqCst), 0);
    }

    #[tokio::test(start_paused = true)]
    async fn the_first_look_from_a_feed_is_followed_by_feed_polls() {
        let inner = Inner::for_tests();
        let fake = Fake::new(|n, _| Reply::Lines(if n == 0 { vec![line(0, "panic: boom")] } else { vec![line(60, "up again")] }, n > 0));
        fake.set_pod(crashlooping(3));
        connected(&inner, &fake);
        let _feed = feed(&inner, &fake).await;
        let run = start(&inner, spec(vec![target("web-1", "app")]));
        until("waiting", || run.state_names().last().is_some_and(|s| s == "waiting")).await;
        // Restarted right after the first look: the second look (2 s later, not 5) sees it.
        let waiting = Instant::now();
        fake.set_pod(running(4));
        inner.hub.resync();
        until("streaming again", || fake.requests() == 2).await;
        assert!(waiting.elapsed() <= POLL_FEED + Duration::from_millis(100), "{:?}", waiting.elapsed());
    }

    #[tokio::test(start_paused = true)]
    async fn a_pod_added_later_starts_with_a_small_tail() {
        let inner = Inner::for_tests();
        let fake = Fake::new(|_, _| Reply::Lines(Vec::new(), true));
        let mut new = running(0);
        new["metadata"] = serde_json::json!({ "name": "web-2", "creationTimestamp": time::now_rfc3339() });
        fake.set_pod(new);
        let mut old = running(0);
        old["metadata"]["name"] = "web-3".into();
        fake.set_pod(old);
        connected(&inner, &fake);
        let _feed = feed(&inner, &fake).await;
        let with_id = |pod: &str, id| LogTarget { id: Some(id), ..target(pod, "app") };
        let run = start(&inner, LogSpec { tail_lines: Some(5000), ..spec(vec![with_id("web-1", 0)]) });
        until("web-1", || fake.requests() == 1).await;
        run.control.send(vec![with_id("web-1", 0), with_id("web-2", 1), with_id("web-3", 2)]).unwrap();
        until("web-2 and web-3", || fake.requests() == 3).await;
        let uri = |pod: &str| (0..3).map(|n| fake.uri(n)).find(|u| u.contains(&format!("/{pod}/"))).unwrap();
        assert!(uri("web-1").contains("tailLines=5000"), "{}", uri("web-1"));
        assert!(uri("web-2").contains(&format!("tailLines={NEW_POD_TAIL}")), "a new pod: {}", uri("web-2"));
        assert!(uri("web-3").contains("tailLines=5000"), "an older pod added later: {}", uri("web-3"));
    }

    #[tokio::test(start_paused = true)]
    async fn requests_retrying_cannot_fix_end_in_an_error_without_retries() {
        let inner = Inner::for_tests();
        let fake =
            Fake::new(|_, uri| if uri.contains("/web-1/") { Reply::Status(403, r#"pods \"web-1\" is forbidden"#) } else { Reply::Status(400, "bad request") });
        connected(&inner, &fake);
        let run = start(&inner, spec(vec![target("web-1", "app"), target("web-2", "app")]));
        until("both", || run.states().len() == 2).await;
        tokio::time::sleep(Duration::from_secs(600)).await;
        assert_eq!(fake.requests(), 2);
        let mut states = run.states();
        states.sort();
        assert_eq!(states, [(0, "error".into(), r#"pods "web-1" is forbidden"#.into()), (1, "error".into(), "bad request".into())]);
    }

    #[tokio::test(start_paused = true)]
    async fn a_missing_pod_or_container_ends_the_stream() {
        let inner = Inner::for_tests();
        let fake = Fake::new(|_, uri| {
            if uri.contains("/web-1/") {
                Reply::Status(404, r#"pods \"web-1\" not found"#)
            } else {
                Reply::Status(400, "container sidecar is not valid for pod web-2")
            }
        });
        connected(&inner, &fake);
        let run = start(&inner, spec(vec![target("web-1", "app"), target("web-2", "sidecar")]));
        until("both", || run.states().len() == 2).await;
        tokio::time::sleep(Duration::from_secs(600)).await;
        assert_eq!(fake.requests(), 2);
        let mut states = run.states();
        states.sort();
        assert_eq!(
            states,
            [(0, "ended".into(), r#"pod deleted (pods "web-1" not found)"#.into()), (1, "ended".into(), r#"this pod has no container "sidecar""#.into())]
        );
    }

    #[tokio::test(start_paused = true)]
    async fn a_pod_re_created_under_the_same_name_ends_the_stream_of_the_deleted_one() {
        let inner = Inner::for_tests();
        let fake = Fake::new(|_, _| Reply::Lines(vec![line(0, "bye")], false));
        // web-1 runs — but it is another pod than the one streamed.
        let mut recreated = running(0);
        recreated["metadata"]["uid"] = "uid-2".into();
        fake.set_pod(recreated);
        connected(&inner, &fake);
        let run = start(&inner, spec(vec![LogTarget { uid: Some("uid-1".into()), ..target("web-1", "app") }]));
        until("ended", || run.state_names().last().is_some_and(|s| s == "ended")).await;
        tokio::time::sleep(Duration::from_secs(600)).await;
        assert_eq!(fake.requests(), 1);
        assert_eq!(run.states().last().unwrap().2, "pod deleted");

        // The same from the feeds: they hold only the new pod.
        let _feed = feed(&inner, &fake).await;
        let gets = fake.gets.load(Ordering::SeqCst);
        let run = start(&inner, spec(vec![LogTarget { uid: Some("uid-1".into()), ..target("web-1", "app") }]));
        until("ended", || run.state_names().last().is_some_and(|s| s == "ended")).await;
        assert_eq!((run.states().last().unwrap().2.as_str(), fake.gets.load(Ordering::SeqCst)), ("pod deleted", gets));
    }

    #[tokio::test(start_paused = true)]
    async fn a_capped_target_starts_once_a_slot_frees() {
        let inner = Inner::for_tests();
        let fake = Fake::new(|_, _| Reply::Lines(Vec::new(), true));
        connected(&inner, &fake);
        let targets: Vec<LogTarget> = (0..=MAX_TARGETS).map(|n| LogTarget { id: Some(n), ..target(&format!("web-{n}"), "app") }).collect();
        let run = start(&inner, spec(targets.clone()));
        until("all streams", || fake.requests() == MAX_TARGETS).await;
        until("the last one not streamed", || run.states().iter().any(|(i, s, _)| *i == MAX_TARGETS && s == "ended")).await;
        // The first pod went away: the last one gets its place.
        run.control.send(targets[1..].to_vec()).unwrap();
        until("the last one", || fake.requests() == MAX_TARGETS + 1).await;
        assert!(fake.uri(MAX_TARGETS).contains(&format!("/web-{MAX_TARGETS}/")));
        until("streaming", || run.states().last().is_some_and(|(i, s, _)| *i == MAX_TARGETS && s == "streaming")).await;
    }

    #[tokio::test(start_paused = true)]
    async fn a_resync_looks_at_a_waiting_container_at_once() {
        let inner = Inner::for_tests();
        let fake = Fake::new(|n, _| Reply::Lines(if n == 0 { vec![line(0, "panic: boom")] } else { Vec::new() }, n > 0));
        fake.set_pod(crashlooping(3));
        connected(&inner, &fake);
        let run = start(&inner, spec(vec![target("web-1", "app")]));
        until("waiting", || run.state_names().last().is_some_and(|s| s == "waiting")).await;
        // Backed off to long polls…
        tokio::time::sleep(Duration::from_secs(120)).await;
        let gets = fake.gets.load(Ordering::SeqCst);
        // …but after sleep the pod is looked at right away.
        fake.set_pod(running(4));
        inner.clusters.nudge();
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert_eq!(fake.gets.load(Ordering::SeqCst), gets + 1);
        until("streaming again", || fake.requests() == 2).await;
    }

    #[tokio::test(start_paused = true)]
    async fn a_broken_connection_is_reconnected_without_fetching_the_pod() {
        let inner = Inner::for_tests();
        let fake = Fake::new(|n, _| if n == 0 { Reply::Broken(vec![line(0, "a")]) } else { Reply::Lines(vec![line(1, "b")], true) });
        fake.set_pod(running(0));
        connected(&inner, &fake);
        let run = start(&inner, spec(vec![target("web-1", "app")]));
        until("b", || run.lines() == ["a", "b"]).await;
        assert_eq!(fake.gets.load(Ordering::SeqCst), 0);
        assert_eq!(run.state_names(), ["streaming"]);
    }

    #[tokio::test(start_paused = true)]
    async fn finding_out_why_a_stream_ended_counts_towards_the_quiet_reconnect() {
        let inner = Inner::for_tests();
        let fake = Fake::new(|n, _| if n == 0 { Reply::Lines(vec![line(0, "a")], false) } else { Reply::Lines(vec![line(1, "b")], true) });
        fake.set_pod(running(0));
        // The network is down: fetching the pod gets no answer.
        fake.hang_gets.store(true, Ordering::SeqCst);
        connected(&inner, &fake);
        let run = start(&inner, spec(vec![target("web-1", "app")]));
        until("a", || run.lines() == ["a"]).await;
        tokio::time::sleep(QUIET_RECONNECT + Duration::from_millis(100)).await;
        assert_eq!(run.state_names(), ["streaming", "reconnecting"], "reported after {QUIET_RECONNECT:?}, not after the fetch timed out");
        until("b", || run.lines() == ["a", "b"]).await;
        assert_eq!(run.state_names(), ["streaming", "reconnecting", "streaming"]);
    }

    /// The fake's client as a cluster connection, as the engine makes it on (re)connect.
    fn reconnects_to(inner: &Arc<Inner>, fake: &Fake) {
        let client = fake.client();
        inner.fake_connect_for_tests(move |context, _| Ok((Cluster::for_tests(context, client.clone(), vec![crate::testing::pods()]), client.clone())));
    }

    #[tokio::test(start_paused = true)]
    async fn credentials_renewed_while_a_request_ran_are_used_at_once() {
        let inner = Inner::for_tests();
        let gate = Arc::new(tokio::sync::Notify::new());
        let g = gate.clone();
        let fake = Fake::new(move |n, _| if n == 0 { Reply::Gated(g.clone(), 401, "Unauthorized") } else { Reply::Lines(vec![line(0, "hello")], true) });
        reconnects_to(&inner, &fake);
        connected(&inner, &fake);
        let run = start(&inner, spec(vec![target("web-1", "app")]));
        until("the request", || fake.requests() == 1).await;
        // A watch of the cluster was rejected too: the engine signed in again meanwhile…
        assert!(inner.reauthenticate("prod-eu-z1").await);
        // …and only then does the request (sent with the old credentials) come back rejected.
        gate.notify_one();
        until("hello", || run.lines() == ["hello"]).await;
        assert_eq!(run.state_names(), ["reconnecting", "streaming"], "never an error");
    }

    #[tokio::test(start_paused = true)]
    async fn a_rejected_request_waits_for_a_sign_in_in_progress() {
        let inner = Inner::for_tests();
        let gate = Arc::new(tokio::sync::Notify::new());
        let g = gate.clone();
        let fake = Fake::new(move |n, _| if n == 0 { Reply::Gated(g.clone(), 401, "Unauthorized") } else { Reply::Lines(vec![line(0, "hello")], true) });
        connected(&inner, &fake);
        let run = start(&inner, spec(vec![target("web-1", "app")]));
        until("the request", || fake.requests() == 1).await;
        // Signing in again (an exec plugin waiting for the browser) begins, then the request is rejected.
        let (done, signed_in) = tokio::sync::oneshot::channel::<Arc<Cluster>>();
        let mut generation = 0;
        let started = inner.clusters.join_or_start("prod-eu-z1", true, |g| {
            generation = g;
            crate::cluster::shared(async move { signed_in.await.map_err(|_| ConnectError { message: "cancelled".into(), code: None, retryable: false }) })
        });
        assert!(started.is_ok());
        gate.notify_one();
        tokio::time::sleep(Duration::from_secs(60)).await;
        assert_eq!(run.state_names(), ["reconnecting"], "not an error while signing in");
        assert_eq!(fake.requests(), 1);
        // Signed in: the stream goes on.
        let cluster = Cluster::for_tests("prod-eu-z1", fake.client(), vec![crate::testing::pods()]);
        assert!(inner.clusters.finish("prod-eu-z1", generation, &Ok(cluster.clone()), None));
        done.send(cluster).ok();
        until("hello", || run.lines() == ["hello"]).await;
        assert_eq!(run.state_names(), ["reconnecting", "streaming"]);
    }
}
