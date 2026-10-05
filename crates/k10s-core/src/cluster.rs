//! Cluster connections: one `kube::Client` + discovery per kubeconfig context, connected lazily,
//! de-duplicated (concurrent callers share one attempt) and independent of each other — one slow or
//! broken cluster never blocks the rest.
//!
//! Every client handed out for a context sends through that context's [`Endpoint`], so a reconnect
//! (fresh exec-plugin credentials) reaches watches and log streams that are already running. Exec auth
//! plugins are run by k10s, not kube (see `exec.rs`), and gated ([`ExecGates`]): a bounded number at once,
//! the first run of a plugin after a quiet period (and every run asking for fresh credentials) alone, each
//! with a timeout — when connecting and when renewing credentials ahead of their expiry, never inside a
//! request. A client whose cluster could not be reached is kept for the next attempt (see
//! [`Attempt::built`]), so retries while the network is down do not run the plugin again.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::time::{Duration, Instant, SystemTime};

use futures::future::{BoxFuture, Shared};
use futures::{FutureExt, StreamExt};
use kube::client::{AuthError, Body};
use kube::core::ApiResource;
use kube::{Api, Client};
use parking_lot::{Mutex, RwLock};
use serde::Serialize;
use tokio::sync::{OwnedMutexGuard, Semaphore, watch};

use crate::discovery::{self, Discovery, ResourceInfo};
use crate::error::{Error, Result, kube_message};
use crate::exec;
use crate::kubeconfig::plugin_name;
use crate::object::Obj;
use crate::render::crd::{FromCrd, PrinterColumns};
use crate::render::table::{self, Probe};
use crate::render::{self, Renderer};

/// Failed connections are not retried automatically for this long (callers get the cached error).
const RETRY_AFTER: Duration = Duration::from_secs(3);
/// One exec auth plugin run. Generous: plugins may open a browser for SSO.
const EXEC_TIMEOUT: Duration = Duration::from_secs(90);
/// Waiting for a turn to run a plugin: another run of it may be waiting for a login.
const EXEC_QUEUE_TIMEOUT: Duration = Duration::from_secs(120);
/// Exec plugin runs at once, across all clusters.
const EXEC_PARALLEL: usize = 8;
/// Runs of a plugin may go in parallel for this long after one of them succeeded (its login is fresh,
/// the rest reuse its cached token). After a quiet period — startup, wake from sleep, the next morning —
/// the first run goes alone again: its SSO session may have expired.
const EXEC_WARM_FOR: Duration = Duration::from_secs(120);
/// Version + discovery of a freshly built client.
const NETWORK_TIMEOUT: Duration = Duration::from_secs(60);
/// A read without response headers for this long fails (twice the API server's own default request
/// timeout; watches and log streams get their headers right away). Mutations are not cut off, see [`Endpoint`].
const RESPONSE_TIMEOUT: Duration = Duration::from_secs(120);
/// Requests of one cluster left hanging in the background before new ones fail right away.
const MAX_STUCK: usize = 16;
/// Reads answered 429, 503 or 504 — throttled, or an overloaded server or aggregated API — are sent again up
/// to this many times…
const READ_RETRIES: u32 = 3;
/// …after the server's `Retry-After`, at most this long, or a short backoff.
const READ_RETRY_WAIT: Duration = Duration::from_secs(10);
/// Credentials that expire (an exec plugin's token or certificate) are renewed this long before they do…
const RENEW_BEFORE: Duration = Duration::from_secs(120);
/// …and, if that failed, tried again this much later while they are still valid.
const RENEW_RETRY: Duration = Duration::from_secs(60);
/// Each request looking for a resource's printer columns: a cluster's rows wait for them, so a slow one
/// shows its rows without them instead (and its view asks again later).
const PRINTER_TIMEOUT: Duration = Duration::from_secs(8);
/// Namespaces asked at once for server-side printing's columns (listing may be forbidden in some of them).
const PROBE_PARALLEL: usize = 4;

pub struct Cluster {
    pub context: Arc<str>,
    pub client: Client,
    pub server: String,
    pub version: Option<String>,
    pub default_namespace: Option<String>,
    discovery: RwLock<Arc<Discovery>>,
    /// Printer columns found per resource key, until discovery is refreshed (see [`Cluster::printer_for`]).
    renderers: Mutex<Printers>,
}

#[derive(Default)]
struct Printers {
    found: HashMap<String, Printer>,
    /// Bumped by every discovery refresh: what a lookup started before it found is not kept.
    epoch: u64,
}

/// How a resource gets its kind-specific columns on one cluster.
#[derive(Clone)]
pub struct Printer {
    pub renderer: Arc<dyn Renderer>,
    /// Why kind-specific columns are missing, for the UI.
    pub notice: Option<Arc<str>>,
    /// They could not be found for a reason that may pass (network trouble, a timeout): worth asking again.
    pub retry: bool,
    /// What the cluster serves (kept until discovery is refreshed). Otherwise `renderer` only stands in after
    /// a failed lookup — and must not replace columns already shown (see [`crate::feed::WatchHub::lease_fallback`]).
    pub found: bool,
}

impl Printer {
    fn of(renderer: Arc<dyn Renderer>) -> Self {
        Printer { renderer, notice: None, retry: false, found: true }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClusterInfo {
    pub context: String,
    pub server: String,
    pub version: Option<String>,
    pub default_namespace: Option<String>,
    pub aggregated_discovery: bool,
    pub resources: Vec<Arc<ResourceInfo>>,
}

impl Cluster {
    pub fn discovery(&self) -> Arc<Discovery> {
        self.discovery.read().clone()
    }

    pub fn info(&self) -> ClusterInfo {
        let d = self.discovery();
        ClusterInfo {
            context: self.context.to_string(),
            server: self.server.clone(),
            version: self.version.clone(),
            default_namespace: self.default_namespace.clone(),
            aggregated_discovery: d.aggregated,
            resources: d.resources.clone(),
        }
    }

    pub async fn refresh_discovery(&self) -> Result<Arc<Discovery>> {
        let d = Arc::new(discovery::discover(&self.client).await?);
        *self.discovery.write() = d.clone();
        self.forget_printers();
        Ok(d)
    }

    pub fn resolve(&self, resource: &str) -> Result<Arc<ResourceInfo>> {
        self.discovery().resolve(resource).ok_or_else(|| Error::UnknownResource { cluster: self.context.to_string(), resource: resource.to_string() })
    }

    pub fn api(&self, info: &ResourceInfo, namespace: Option<&str>) -> Api<Obj> {
        let ar = info.api_resource();
        match namespace.filter(|_| info.namespaced) {
            Some(ns) => Api::namespaced_with(self.client.clone(), ns, &ar),
            None => Api::all_with(self.client.clone(), &ar),
        }
    }

    /// Built-in renderer, else the CRD's printer columns evaluated here, else server-side printing (the
    /// columns `kubectl get` shows, computed by the API server: needs no access to the CRD and covers
    /// aggregated APIs too), else generic. What was found is kept until discovery is refreshed (a reconnect
    /// starts over too); failures that permissions or the network may fix are not kept. `namespaces`: where
    /// the view looks (`None`: everywhere), to ask for server-side printing where listing is allowed.
    pub async fn printer_for(&self, info: &ResourceInfo, namespaces: &[Option<Arc<str>>]) -> Printer {
        if let Some(r) = render::builtin(&info.group, &info.kind) {
            return Printer::of(r);
        }
        let epoch = {
            let printers = self.renderers.lock();
            if let Some(p) = printers.found.get(&info.key) {
                return p.clone();
            }
            printers.epoch
        };
        let printer = self.find_printer(info, namespaces).await;
        let mut printers = self.renderers.lock();
        // (Discovery refreshed meanwhile: its views look again, perhaps for another version.)
        if printer.found && printers.epoch == epoch {
            printers.found.insert(info.key.clone(), printer.clone());
        }
        printer
    }

    async fn find_printer(&self, info: &ResourceInfo, namespaces: &[Option<Arc<str>>]) -> Printer {
        let mut partial: Option<Arc<dyn Renderer>> = None;
        // Why the CRD could not be read, and whether that may pass.
        let mut crd_failure: Option<(String, bool)> = None;
        if !info.group.is_empty() {
            match bounded(self.crd(&info.key)).await {
                Ok(Some(crd)) => match PrinterColumns::from_crd(&crd.raw, &info.version) {
                    FromCrd::Complete(p) => return Printer::of(Arc::new(p)),
                    FromCrd::Empty => return Printer::of(render::generic()),
                    // Server-side printing evaluates all of them; these are the fallback.
                    FromCrd::Partial(p) => partial = p.map(|p| Arc::new(p) as Arc<dyn Renderer>),
                },
                // Not a CRD: an aggregated API, or a built-in kind without a renderer here.
                Ok(None) => {}
                Err(err) => {
                    tracing::debug!(resource = %info.key, err = %kube_message(&err), "cannot read the CRD; asking for server-side printing");
                    crd_failure = Some(match api_code(&err) {
                        Some(403) => ("no access to its CustomResourceDefinition".to_string(), false),
                        _ => (format!("its CustomResourceDefinition could not be read ({})", kube_message(&err)), is_retryable(&err)),
                    });
                }
            }
        }
        let fallback = partial.unwrap_or_else(render::generic);
        match self.probe(info, namespaces).await {
            Ok(Probe::Columns(p)) => Printer::of(Arc::new(p)),
            Ok(Probe::NoColumns) => Printer::of(fallback),
            Ok(Probe::Unsupported) => {
                let retry = crd_failure.as_ref().is_some_and(|(_, retry)| *retry);
                let notice = crd_failure
                    .map(|(why, _)| Arc::from(format!("printer columns unavailable: {why}, and the API server does not print tables for {}", info.key)));
                Printer { renderer: fallback, notice, retry, found: !retry }
            }
            Err(err) => {
                tracing::debug!(resource = %info.key, err = %kube_message(&err), "server-side printing failed");
                // Forbidden lists (in every namespace the view looks at), rejected credentials, a resource not
                // served: the view's watches say so themselves.
                let quiet = matches!(api_code(&err), Some(401 | 403 | 404)) || is_auth_failure(&err);
                let notice = (!quiet).then(|| Arc::from(format!("printer columns unavailable: {}", kube_message(&err))));
                Printer { renderer: fallback, notice, retry: is_retryable(&err), found: false }
            }
        }
    }

    async fn crd(&self, name: &str) -> kube::Result<Option<Obj>> {
        let ar = ApiResource {
            group: "apiextensions.k8s.io".into(),
            version: "v1".into(),
            api_version: "apiextensions.k8s.io/v1".into(),
            kind: "CustomResourceDefinition".into(),
            plural: "customresourcedefinitions".into(),
        };
        let api: Api<Obj> = Api::all_with(self.client.clone(), &ar);
        api.get_opt(name).await
    }

    /// Server-side printing's columns for `info`, asked where the view looks: in its namespaces in order
    /// ([`PROBE_PARALLEL`] at once), until one allows listing — under strict RBAC a view across clusters
    /// often lists namespaces granted on other clusters first.
    async fn probe(&self, info: &ResourceInfo, namespaces: &[Option<Arc<str>>]) -> kube::Result<Probe> {
        let everywhere = [None];
        let scopes = if info.namespaced && !namespaces.is_empty() { namespaces } else { &everywhere[..] };
        let urls: Vec<String> = scopes.iter().map(|ns| self.api(info, ns.as_deref()).resource_url().to_string()).collect();
        let client = &self.client;
        let mut answers = futures::stream::iter(urls).map(|url| async move { bounded(table::probe(client, &url)).await }).buffered(PROBE_PARALLEL);
        let mut result = Ok(Probe::Unsupported);
        while let Some(answer) = answers.next().await {
            let forbidden = matches!(&answer, Err(e) if api_code(e) == Some(403));
            result = answer;
            if !forbidden {
                break;
            }
        }
        result
    }

    /// What a discovery refresh does to printer columns: they are looked for again (also by lookups under way).
    pub(crate) fn forget_printers(&self) {
        let mut printers = self.renderers.lock();
        printers.found.clear();
        printers.epoch += 1;
    }

    #[cfg(test)]
    pub(crate) fn for_tests(context: &str, client: Client, resources: Vec<ResourceInfo>) -> Arc<Cluster> {
        Arc::new(Cluster {
            context: Arc::from(context),
            client,
            server: "https://127.0.0.1:1".into(),
            version: None,
            default_namespace: None,
            discovery: RwLock::new(Arc::new(Discovery::new(resources, true))),
            renderers: Mutex::default(),
        })
    }
}

/// Cloneable connection failure (kube errors are not `Clone`).
#[derive(Debug, Clone)]
pub struct ConnectError {
    pub message: String,
    pub code: Option<u16>,
    /// Network trouble or a server-side error: trying again later may succeed without the user doing
    /// anything. Authentication, permission and configuration errors are not.
    pub retryable: bool,
}

impl ConnectError {
    pub fn into_error(self, context: &str) -> Error {
        Error::Connect { context: context.to_string(), message: self.message, code: self.code }
    }

    fn fatal(message: String) -> Self {
        ConnectError { message, code: None, retryable: false }
    }
}

impl From<Error> for ConnectError {
    fn from(e: Error) -> Self {
        let retryable = matches!(&e, Error::Kube(k) if is_retryable(k));
        ConnectError { message: e.message(), code: e.code(), retryable }
    }
}

/// An exec auth plugin failure, also one that happened while refreshing a token inside a request.
pub(crate) fn is_auth_failure(e: &kube::Error) -> bool {
    match e {
        kube::Error::Auth(_) => true,
        kube::Error::Service(inner) => inner.is::<AuthError>(),
        _ => false,
    }
}

fn api_code(e: &kube::Error) -> Option<u16> {
    match e {
        kube::Error::Api(s) => Some(s.code),
        _ => None,
    }
}

/// A request looking for printer columns, within [`PRINTER_TIMEOUT`] (a timeout is network trouble).
async fn bounded<T>(request: impl Future<Output = kube::Result<T>>) -> kube::Result<T> {
    tokio::time::timeout(PRINTER_TIMEOUT, request).await.unwrap_or_else(|_| Err(request_failure(format!("no answer within {}s", PRINTER_TIMEOUT.as_secs()))))
}

/// Network trouble and server-side errors are worth retrying; authentication and permission errors are not.
pub(crate) fn is_retryable(e: &kube::Error) -> bool {
    match e {
        kube::Error::Api(s) => s.code >= 500 || matches!(s.code, 408 | 429),
        e => !is_auth_failure(e),
    }
}

type ConnectFuture = Shared<BoxFuture<'static, Result<Arc<Cluster>, ConnectError>>>;

enum Slot {
    Connecting { generation: u64, fut: ConnectFuture },
    Ready { generation: u64, cluster: Arc<Cluster> },
    Failed { generation: u64, err: ConnectError, at: Instant },
}

/// A context's connection state, see [`ClusterManager::state`].
#[derive(Debug, Clone)]
pub(crate) enum ConnState {
    Connecting,
    Ready,
    Failed(ConnectError),
}

/// Published whenever any cluster's connection changes, see [`ClusterManager::changes`].
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct Changes {
    /// Bumped by every connection attempt start/finish, removal and discovery refresh.
    pub updates: u64,
    /// Bumped by [`ClusterManager::nudge`] (wake from sleep, network change): retry failures now.
    pub resyncs: u64,
}

pub struct ClusterManager {
    slots: Mutex<HashMap<String, Slot>>,
    generation: AtomicU64,
    endpoints: Mutex<HashMap<String, Arc<Endpoint>>>,
    changes: watch::Sender<Changes>,
    pub(crate) exec: ExecGates,
}

impl Default for ClusterManager {
    fn default() -> Self {
        Self {
            slots: Mutex::new(HashMap::new()),
            generation: AtomicU64::new(0),
            endpoints: Mutex::new(HashMap::new()),
            changes: watch::Sender::new(Changes::default()),
            exec: ExecGates::default(),
        }
    }
}

pub(crate) enum Joined {
    Ready(Arc<Cluster>),
    Pending(ConnectFuture),
}

impl ClusterManager {
    fn next_generation(&self) -> u64 {
        self.generation.fetch_add(1, Ordering::Relaxed) + 1
    }

    fn notify(&self) {
        self.changes.send_modify(|c| c.updates += 1);
    }

    /// Returns the connected cluster, joins an in-flight attempt, or atomically starts a new one via
    /// `start(generation)` (which must spawn the attempt and call [`ClusterManager::finish`] itself).
    pub(crate) fn join_or_start(&self, context: &str, force: bool, start: impl FnOnce(u64) -> ConnectFuture) -> Result<Joined, ConnectError> {
        let mut slots = self.slots.lock();
        match slots.get(context) {
            Some(Slot::Ready { cluster, .. }) if !force => return Ok(Joined::Ready(cluster.clone())),
            Some(Slot::Connecting { fut, .. }) => return Ok(Joined::Pending(fut.clone())),
            Some(Slot::Failed { err, at, .. }) if !force && at.elapsed() < RETRY_AFTER => return Err(err.clone()),
            _ => {}
        }
        let generation = self.next_generation();
        let fut = start(generation);
        slots.insert(context.to_string(), Slot::Connecting { generation, fut: fut.clone() });
        drop(slots);
        self.notify();
        Ok(Joined::Pending(fut))
    }

    pub fn get(&self, context: &str) -> Option<Arc<Cluster>> {
        match self.slots.lock().get(context) {
            Some(Slot::Ready { cluster, .. }) => Some(cluster.clone()),
            _ => None,
        }
    }

    /// Generation of the context's current connection (attempt) and its state; `None` if it was never
    /// connected or got disconnected. The generation changes with every attempt and discovery refresh.
    pub(crate) fn state(&self, context: &str) -> Option<(u64, ConnState)> {
        match self.slots.lock().get(context)? {
            Slot::Connecting { generation, .. } => Some((*generation, ConnState::Connecting)),
            Slot::Ready { generation, .. } => Some((*generation, ConnState::Ready)),
            Slot::Failed { generation, err, .. } => Some((*generation, ConnState::Failed(err.clone()))),
        }
    }

    /// Notifies on every connection change (see [`Changes`]).
    pub(crate) fn changes(&self) -> watch::Receiver<Changes> {
        self.changes.subscribe()
    }

    /// Discovery of a connected cluster was refreshed: views that could not resolve their resource try again.
    pub(crate) fn touch(&self, context: &str) {
        let mut slots = self.slots.lock();
        if let Some(Slot::Ready { generation, .. }) = slots.get_mut(context) {
            *generation = self.next_generation();
            drop(slots);
            self.notify();
        }
    }

    /// Asks everyone waiting for a failed cluster to retry now (after sleep or a network change).
    pub(crate) fn nudge(&self) {
        self.changes.send_modify(|c| c.resyncs += 1);
    }

    pub fn connected(&self) -> Vec<Arc<Cluster>> {
        self.slots
            .lock()
            .values()
            .filter_map(|s| match s {
                Slot::Ready { cluster, .. } => Some(cluster.clone()),
                _ => None,
            })
            .collect()
    }

    /// The context's endpoint (created on first use; it outlives reconnects).
    pub(crate) fn endpoint(&self, context: &str) -> Arc<Endpoint> {
        self.endpoints.lock().entry(context.to_string()).or_default().clone()
    }

    /// Connected contexts with their endpoints (whose credentials may be due for renewal).
    pub(crate) fn connected_endpoints(&self) -> Vec<(String, Arc<Endpoint>)> {
        let slots = self.slots.lock();
        let endpoints = self.endpoints.lock();
        slots
            .iter()
            .filter(|(_, slot)| matches!(slot, Slot::Ready { .. }))
            .filter_map(|(context, _)| Some((context.clone(), endpoints.get(context)?.clone())))
            .collect()
    }

    /// Records a finished attempt unless the slot was reset (disconnect) or superseded meanwhile. A
    /// successful one also becomes the connection behind the context's [`Endpoint`].
    pub(crate) fn finish(&self, context: &str, generation: u64, result: &Result<Arc<Cluster>, ConnectError>, session: Option<Session>) -> bool {
        let mut slots = self.slots.lock();
        if !matches!(slots.get(context), Some(Slot::Connecting { generation: g, .. }) if *g == generation) {
            return false;
        }
        let slot = match result {
            Ok(cluster) => {
                if let Some(session) = session {
                    self.endpoint(context).set(session);
                }
                Slot::Ready { generation, cluster: cluster.clone() }
            }
            Err(err) => Slot::Failed { generation, err: err.clone(), at: Instant::now() },
        };
        slots.insert(context.to_string(), slot);
        drop(slots);
        self.notify();
        true
    }

    pub fn remove(&self, context: &str) -> bool {
        let removed = self.slots.lock().remove(context).is_some();
        if removed {
            self.notify();
        }
        removed
    }

    #[cfg(test)]
    pub(crate) fn insert_ready_for_tests(&self, cluster: Arc<Cluster>) {
        let generation = self.next_generation();
        self.slots.lock().insert(cluster.context.to_string(), Slot::Ready { generation, cluster });
        self.notify();
    }

    #[cfg(test)]
    pub(crate) fn insert_failed_for_tests(&self, context: &str, err: ConnectError) {
        let generation = self.next_generation();
        self.slots.lock().insert(context.to_string(), Slot::Failed { generation, err, at: Instant::now() });
        self.notify();
    }
}

/// Text of a failure produced by k10s itself (not by kube) inside a request.
#[derive(Debug)]
struct RequestFailure(String);

impl std::fmt::Display for RequestFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for RequestFailure {}

fn request_failure(message: impl Into<String>) -> kube::Error {
    kube::Error::Service(Box::new(RequestFailure(message.into())))
}

/// The stable face of a context's connection. Every [`Client`] handed out for the context sends
/// through it, and a successful reconnect swaps the connection behind it — so watches, log streams and
/// anything else that kept a client pick up fresh credentials with their next request instead of
/// failing with the old ones forever.
///
/// It also bounds waiting: a read (GET) without response headers after [`RESPONSE_TIMEOUT`] fails, while
/// the request itself is left to finish in the background. Dropping it would be worse: a legacy auth
/// provider still refreshes its token inside requests (kube runs its command holding the token lock — exec
/// plugins never do, see [`build_client`]), and a dropped waiter makes the next request start the command
/// all over again. At most [`MAX_STUCK`] such requests linger per connection; beyond that,
/// its requests fail right away until they finish — a reconnect starts with a fresh budget. (Reads whose
/// callers stopped waiting sooner, on a timeout of their own, go on the same way but are not counted:
/// they are not known to hang, only to be slower than that caller wanted — counting them would fail a
/// slow but working cluster's requests.)
///
/// Mutations are never cut off here: how one ended must come from the API server (or a broken
/// connection), not from a timer that cannot stop it — the journal would say it failed while it may
/// still be carried out. Their callers bound how long they wait and how many are in flight (see
/// `ops::Lane`). Nor are they sent again: reads answered 429/503/504 are, briefly (see [`READ_RETRIES`]),
/// but a mutation that got such an answer may have been carried out all the same.
#[derive(Default)]
pub struct Endpoint {
    current: RwLock<Option<Arc<Conn>>>,
    response_timeout: Option<Duration>,
}

/// A client built for a context, and when the credentials it carries expire — an exec plugin's token or
/// certificate; `None`: they do not, as far as k10s can tell.
#[derive(Clone)]
pub(crate) struct Session {
    pub client: Client,
    pub expires: Option<SystemTime>,
}

impl From<Client> for Session {
    fn from(client: Client) -> Self {
        Session { client, expires: None }
    }
}

/// One connection behind an [`Endpoint`], with its own count of requests left hanging and the renewal of
/// its credentials.
struct Conn {
    client: Client,
    stuck: AtomicUsize,
    expires: Option<SystemTime>,
    /// When its credentials are due for renewal; `None` while a renewal is under way, or when there is
    /// nothing to renew (see [`Endpoint::renewal_due`]).
    renew_at: Mutex<Option<SystemTime>>,
}

impl Conn {
    fn new(session: Session, now: SystemTime) -> Self {
        let renew_at = session.expires.map(|expires| renew_time(now, expires));
        Conn { client: session.client, stuck: AtomicUsize::new(0), expires: session.expires, renew_at: Mutex::new(renew_at) }
    }
}

/// When credentials valid from `now` until `expires` are renewed: [`RENEW_BEFORE`] ahead of their expiry,
/// but not before half their life has passed — short-lived ones are not renewed over and over.
fn renew_time(now: SystemTime, expires: SystemTime) -> SystemTime {
    let half_life = now + expires.duration_since(now).unwrap_or_default() / 2;
    half_life.max(expires.checked_sub(RENEW_BEFORE).unwrap_or(now))
}

/// The claim on renewing the credentials of one connection (see [`Endpoint::renewal_due`]).
pub(crate) struct Renewal {
    endpoint: Arc<Endpoint>,
    conn: Arc<Conn>,
}

impl Renewal {
    /// Puts the renewed session behind the endpoint — unless its connection was replaced meanwhile (a
    /// reconnect brought credentials of its own). Returns whether it did.
    pub(crate) fn complete(self, session: Session) -> bool {
        let mut current = self.endpoint.current.write();
        if !current.as_ref().is_some_and(|c| Arc::ptr_eq(c, &self.conn)) {
            return false;
        }
        *current = Some(Arc::new(Conn::new(session, SystemTime::now())));
        true
    }

    /// The renewal failed: tried again after [`RENEW_RETRY`] if the credentials are still valid then. Once
    /// they expired, rejected requests renew them (see `Inner::reauthenticate`).
    pub(crate) fn failed(self, now: SystemTime) {
        let again = now + RENEW_RETRY;
        if self.conn.expires.is_some_and(|expires| again < expires) {
            *self.conn.renew_at.lock() = Some(again);
        }
    }
}

impl Endpoint {
    pub(crate) fn set(&self, session: Session) {
        *self.current.write() = Some(Arc::new(Conn::new(session, SystemTime::now())));
    }

    /// The current connection's credentials expire soon, `now`: the caller renews them (the claim is taken,
    /// asking again returns `None` until it failed). Expired ones are left to the rejected requests.
    pub(crate) fn renewal_due(self: &Arc<Self>, now: SystemTime) -> Option<Renewal> {
        let conn = self.current.read().clone()?;
        let expires = conn.expires?;
        {
            let mut renew_at = conn.renew_at.lock();
            if !renew_at.is_some_and(|at| at <= now) || now >= expires {
                return None;
            }
            *renew_at = None;
        }
        Some(Renewal { endpoint: self.clone(), conn })
    }

    /// When the current connection's credentials expire.
    #[cfg(test)]
    pub(crate) fn expires(&self) -> Option<SystemTime> {
        self.current.read().as_ref()?.expires
    }

    /// A client sending through this endpoint (cheap; any number of them share the connection).
    pub(crate) fn client(self: &Arc<Self>, default_namespace: String) -> Client {
        let endpoint = self.clone();
        let svc = tower::service_fn(move |req: http::Request<Body>| endpoint.clone().send(req));
        Client::new(svc, default_namespace)
    }

    async fn send(self: Arc<Self>, req: http::Request<Body>) -> Result<http::Response<Body>, kube::Error> {
        let conn = self.current.read().clone().ok_or_else(|| request_failure("not connected"))?;
        let timeout = self.response_timeout.unwrap_or(RESPONSE_TIMEOUT);
        if conn.stuck.load(Ordering::Acquire) >= MAX_STUCK {
            return Err(request_failure(format!(
                "{MAX_STUCK} requests got no response within {}s and are still waiting (network trouble, or an auth plugin waiting for a login)",
                timeout.as_secs()
            )));
        }
        let read = req.method() == http::Method::GET;
        let client = conn.client.clone();
        let mut call = tokio::spawn(async move { if read { send_read(&client, req).await } else { client.send(req).await } });
        if !read {
            return call.await.unwrap_or_else(|join| Err(request_failure(format!("request task failed: {join}"))));
        }
        match tokio::time::timeout(timeout, &mut call).await {
            Ok(Ok(res)) => res,
            Ok(Err(join)) => Err(request_failure(format!("request task failed: {join}"))),
            Err(_) => {
                conn.stuck.fetch_add(1, Ordering::AcqRel);
                tokio::spawn(async move {
                    let _ = call.await;
                    conn.stuck.fetch_sub(1, Ordering::AcqRel);
                });
                Err(request_failure(format!(
                    "no response from the API server within {}s (network trouble, or an auth plugin waiting for a login)",
                    timeout.as_secs()
                )))
            }
        }
    }
}

/// Sends a read, and again while it is answered 429, 503 or 504 (see [`READ_RETRIES`]). kube's own retries
/// are off (see `KubeconfigStore::client_config`): they would send mutations again too.
async fn send_read(client: &Client, req: http::Request<Body>) -> Result<http::Response<Body>, kube::Error> {
    let (parts, body) = req.into_parts();
    let mut attempt = 0;
    loop {
        // The last attempt (or a body that cannot be sent twice) takes whatever answer comes.
        let Some(copy) = body.try_clone().filter(|_| attempt < READ_RETRIES) else {
            return client.send(http::Request::from_parts(parts, body)).await;
        };
        let res = client.send(http::Request::from_parts(parts.clone(), copy)).await?;
        if !matches!(res.status().as_u16(), 429 | 503 | 504) {
            return Ok(res);
        }
        let wait = retry_after(res.headers()).map_or_else(|| read_backoff(attempt), |d| d.min(READ_RETRY_WAIT));
        tracing::debug!(status = res.status().as_u16(), path = parts.uri.path(), attempt = attempt + 1, ?wait, "read answered busy, sending it again");
        drop(res);
        tokio::time::sleep(wait).await;
        attempt += 1;
    }
}

/// `Retry-After` in seconds (the API server does not send the date form).
fn retry_after(headers: &http::HeaderMap) -> Option<Duration> {
    headers.get(http::header::RETRY_AFTER)?.to_str().ok()?.trim().parse().ok().map(Duration::from_secs)
}

/// 0.5 s, 1 s, 2 s…, ±20% so that the reads of many views do not come back in lockstep.
fn read_backoff(attempt: u32) -> Duration {
    let jitter = (SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.subsec_nanos()).unwrap_or(0) % 400) as f64 / 1000.0 + 0.8;
    Duration::from_millis(500).saturating_mul(1 << attempt.min(4)).mul_f64(jitter)
}

/// Gates exec auth plugin runs (building a client runs the plugin, see [`build_client`]).
///
/// At most [`EXEC_PARALLEL`] runs at once overall; waiting for one of those slots is not timed out (each
/// is given back within the run timeout). Per plugin command, a run goes alone — later ones wait for it —
/// unless one succeeded within [`EXEC_WARM_FOR`]: typically the run that goes alone completes an SSO
/// login, and the rest then reuse its cached token in parallel. Runs asking for fresh credentials
/// (reconnect, rejected credentials) always go alone. Callers that waited for a run that went alone take
/// its outcome: its error if it failed with the same arguments and environment (nobody starts the plugin
/// again only to fail the same way), else they go on in parallel. A run that hangs keeps its plugin's turn
/// until it really exits — it is not killed: a login that takes longer than the timeout may still complete
/// and leave its token cached for the next attempt — so a hung plugin is never started again and again;
/// callers stop waiting after a timeout either way.
pub(crate) struct ExecGates {
    slots: Arc<Semaphore>,
    plugins: Mutex<HashMap<String, Arc<PluginGate>>>,
    run_timeout: Duration,
    queue_timeout: Duration,
    warm_for: Duration,
}

impl Default for ExecGates {
    fn default() -> Self {
        Self {
            slots: Arc::new(Semaphore::new(EXEC_PARALLEL)),
            plugins: Mutex::new(HashMap::new()),
            run_timeout: EXEC_TIMEOUT,
            queue_timeout: EXEC_QUEUE_TIMEOUT,
            warm_for: EXEC_WARM_FOR,
        }
    }
}

#[derive(Default)]
struct PluginGate {
    /// Held by the run that goes alone, until its plugin exits.
    turn: Arc<tokio::sync::Mutex<()>>,
    state: Mutex<GateState>,
}

#[derive(Default)]
struct GateState {
    /// When a run last succeeded (cleared by a failure or a timeout).
    last_ok: Option<Instant>,
    /// Runs that went alone so far, and the error of the latest one if it failed (with its [`fingerprint`]).
    alone: u64,
    failure: Option<(u64, ConnectError)>,
}

impl ExecGates {
    fn gate(&self, command: &str) -> Arc<PluginGate> {
        self.plugins.lock().entry(command.to_string()).or_default().clone()
    }
}

impl PluginGate {
    /// Waits for the caller's turn to run the plugin: `Some(turn)` to run it alone (holding the turn until
    /// the plugin exits), `None` to run it in parallel. `fresh`: the caller wants new credentials.
    async fn enter(&self, invocation: u64, fresh: bool, gates: &ExecGates, name: &str) -> Result<Option<OwnedMutexGuard<()>>, ConnectError> {
        let warm = |st: &GateState| st.last_ok.is_some_and(|t| t.elapsed() < gates.warm_for);
        let before = {
            let st = self.state.lock();
            if !fresh && warm(&st) {
                return Ok(None);
            }
            st.alone
        };
        let turn = tokio::time::timeout(gates.queue_timeout, self.turn.clone().lock_owned()).await.map_err(|_| ConnectError {
            message: format!(
                "gave up waiting for auth plugin `{name}`: an earlier run of it has not finished after {}s (waiting for a login?). Run it in a terminal to see why, then reconnect",
                gates.queue_timeout.as_secs()
            ),
            code: None,
            // Waiting again starts nothing new: it is the earlier run that has to finish.
            retryable: true,
        })?;
        let st = self.state.lock();
        if st.alone != before {
            // A run went alone while this caller waited: had it the same arguments, its outcome stands for
            // this caller too.
            match &st.failure {
                Some((same, err)) if *same == invocation => return Err(err.clone()),
                Some(_) => {}
                None => return Ok(None),
            }
        }
        if !fresh && warm(&st) {
            return Ok(None);
        }
        drop(st);
        Ok(Some(turn))
    }

    fn finish(&self, invocation: u64, failure: Option<&ConnectError>, alone: bool) {
        let mut st = self.state.lock();
        st.last_ok = failure.is_none().then(Instant::now);
        if alone {
            st.alone += 1;
            st.failure = failure.map(|err| (invocation, err.clone()));
        }
    }
}

/// Identifies how a plugin is invoked — arguments, environment and, if it gets them, the cluster — without
/// keeping any of it (the environment holds the user's secrets).
fn fingerprint(config: &kube::Config, exec: &kube::config::ExecConfig) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    exec.args.hash(&mut h);
    for vars in exec.env.iter().flatten() {
        let mut pairs: Vec<_> = vars.iter().collect();
        pairs.sort_unstable();
        pairs.hash(&mut h);
    }
    exec.drop_env.hash(&mut h);
    if exec.provide_cluster_info {
        config.cluster_url.to_string().hash(&mut h);
    }
    h.finish()
}

/// Builds the client. An exec auth plugin is run first, gated by [`ExecGates`] and bounded by timeouts, and
/// kube gets the credential it returned (see `exec.rs`) — so kube never runs the plugin itself, which it
/// would do inside requests, ungated and without a timeout, whenever the credential is about to expire (the
/// engine renews it ahead of time instead, see [`Endpoint::renewal_due`]). `fresh`: new credentials are
/// wanted (the run goes alone); `env_failed`: the login-shell environment is missing (for hints).
pub(crate) async fn build_client(gates: &ExecGates, mut config: kube::Config, fresh: bool, env_failed: bool) -> Result<Session, ConnectError> {
    let Some(plugin) = exec::in_use(&config.auth_info).cloned() else {
        return Ok(build_static(config, gates.run_timeout).await?.into());
    };
    let command = plugin.command.clone().ok_or_else(|| ConnectError::fatal("the kubeconfig's exec auth plugin names no command".into()))?;
    let invocation = fingerprint(&config, &plugin);
    let name = plugin_name(&command).to_string();
    let gate = gates.gate(&command);
    let alone = gate.enter(invocation, fresh, gates, &name).await?;
    let permit = gates.slots.clone().acquire_owned().await.expect("the exec semaphore is never closed");
    let (run_gate, run_name) = (gate.clone(), name.clone());
    let run = tokio::spawn(async move {
        let res = exec::run(&plugin, &run_name, env_failed).await;
        run_gate.finish(invocation, res.as_ref().err(), alone.is_some());
        // The turn is held until the plugin really exited, even after the caller stopped waiting for it.
        drop(alone);
        res
    });
    let res = tokio::time::timeout(gates.run_timeout, run).await;
    drop(permit);
    let credential = match res {
        Ok(Ok(res)) => res?,
        Ok(Err(e)) => return Err(ConnectError::fatal(format!("auth plugin `{name}` task failed: {e}"))),
        Err(_) => {
            gate.state.lock().last_ok = None;
            return Err(ConnectError::fatal(format!(
                "auth plugin `{name}` did not finish within {}s (waiting for a login?). Run it in a terminal to see why, then reconnect",
                gates.run_timeout.as_secs()
            )));
        }
    };
    let expires = credential.expires;
    credential.apply(&mut config);
    Ok(Session { client: build_static(config, gates.run_timeout).await?, expires })
}

/// Builds a client that runs no exec plugin — although a legacy auth-provider command or a token file on a
/// stalled mount can block too, hence the blocking pool and `timeout`.
async fn build_static(config: kube::Config, timeout: Duration) -> Result<Client, ConnectError> {
    let build = tokio::task::spawn_blocking(move || Client::try_from(config));
    match tokio::time::timeout(timeout, build).await {
        // Bad certificates, keys, proxy settings…: the same configuration fails the same way again.
        Ok(Ok(res)) => res.map_err(|e| ConnectError::fatal(Error::from(e).message())),
        Ok(Err(e)) => Err(ConnectError::fatal(format!("client setup failed: {e}"))),
        Err(_) => Err(ConnectError::fatal(format!(
            "client setup did not finish within {}s (an auth provider command or a token file that does not answer?)",
            timeout.as_secs()
        ))),
    }
}

/// What a connection attempt needs.
pub(crate) struct Attempt {
    pub context: Arc<str>,
    pub config: kube::Config,
    pub default_namespace: Option<String>,
    /// The client of an earlier attempt that could not reach the cluster: checked again instead of
    /// building a new one, which would run the exec plugin again although only the network was down.
    /// Built anew if the cluster rejects it.
    pub built: Option<Session>,
    /// New credentials are wanted (Retry, Reconnect, rejected credentials): the plugin run goes alone.
    pub fresh: bool,
    /// The login-shell environment could not be imported (for error hints).
    pub env_failed: bool,
}

/// A failed attempt. `client` is kept when only reaching the cluster failed (see [`Attempt::built`]).
pub(crate) struct Failed {
    pub err: ConnectError,
    pub client: Option<Box<Session>>,
}

impl From<ConnectError> for Failed {
    fn from(err: ConnectError) -> Self {
        Failed { err, client: None }
    }
}

/// Server version and discovery of a checked client.
type Found = (Option<String>, Discovery);

/// Connects: builds the client (running the exec plugin, if any) or reuses [`Attempt::built`], and checks
/// it with version + discovery. Returns the cluster and the raw client's session, which becomes the
/// connection behind `endpoint` once the attempt is recorded (see [`ClusterManager::finish`]).
pub(crate) async fn connect(attempt: Attempt, gates: &ExecGates, endpoint: &Arc<Endpoint>) -> Result<(Arc<Cluster>, Session), Failed> {
    let Attempt { context, config, default_namespace, built, fresh, env_failed } = attempt;
    let server = config.cluster_url.to_string();
    let client_namespace = config.default_namespace.clone();
    let checked = match built {
        Some(raw) => match check(&raw.client).await {
            Ok(found) => Ok((raw, found)),
            Err(err) if err.retryable => Err(Failed { err, client: Some(Box::new(raw)) }),
            // Rejected now (the credentials expired meanwhile?): start over with new ones.
            Err(_) => build_and_check(gates, config, fresh, env_failed).await,
        },
        None => build_and_check(gates, config, fresh, env_failed).await,
    };
    let (raw, (version, discovery)) = checked?;
    let cluster = Arc::new(Cluster {
        context,
        client: endpoint.client(client_namespace),
        server,
        version,
        default_namespace,
        discovery: RwLock::new(Arc::new(discovery)),
        renderers: Mutex::default(),
    });
    Ok((cluster, raw))
}

async fn build_and_check(gates: &ExecGates, config: kube::Config, fresh: bool, env_failed: bool) -> Result<(Session, Found), Failed> {
    let raw = build_client(gates, config, fresh, env_failed).await?;
    match check(&raw.client).await {
        Ok(found) => Ok((raw, found)),
        Err(err) => {
            let client = err.retryable.then(|| Box::new(raw));
            Err(Failed { err, client })
        }
    }
}

/// Version + discovery, within [`NETWORK_TIMEOUT`].
async fn check(raw: &Client) -> Result<Found, ConnectError> {
    let probe = async {
        let (version, discovery) = tokio::join!(raw.apiserver_version(), discovery::discover(raw));
        Ok::<_, Error>((version.ok().map(|v| v.git_version), discovery?))
    };
    match tokio::time::timeout(NETWORK_TIMEOUT, probe).await {
        Ok(res) => res.map_err(ConnectError::from),
        Err(_) => Err(ConnectError {
            message: format!("no answer within {}s (is the cluster reachable? VPN?)", NETWORK_TIMEOUT.as_secs()),
            code: None,
            retryable: true,
        }),
    }
}

pub(crate) fn shared(fut: impl Future<Output = Result<Arc<Cluster>, ConnectError>> + Send + 'static) -> ConnectFuture {
    fut.boxed().shared()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A fake API server: answers every request with `status` and `body`, counting requests.
    fn server(status: u16, body: &'static str, hits: Arc<AtomicUsize>) -> Client {
        let svc = tower::service_fn(move |_req: http::Request<Body>| {
            hits.fetch_add(1, Ordering::SeqCst);
            async move {
                Ok::<_, std::convert::Infallible>(
                    http::Response::builder().status(status).header("content-type", "application/json").body(Body::from(body.as_bytes().to_vec())).unwrap(),
                )
            }
        });
        Client::new(svc, "default")
    }

    const VERSION: &str = r#"{"major":"1","minor":"33","gitVersion":"v1.33.4","gitCommit":"x","gitTreeState":"clean","buildDate":"2025-01-01T00:00:00Z","goVersion":"go1.24","compiler":"gc","platform":"linux/amd64"}"#;

    #[tokio::test]
    async fn clients_follow_the_endpoint_across_reconnects() {
        let (old, new) = (Arc::new(AtomicUsize::new(0)), Arc::new(AtomicUsize::new(0)));
        let endpoint = Arc::new(Endpoint::default());
        // Handed out before anything is connected (and kept by a watch or log stream).
        let client = endpoint.client("default".into());
        let err = client.apiserver_version().await.unwrap_err();
        assert!(err.to_string().contains("not connected"), "{err}");

        endpoint.set(server(200, VERSION, old.clone()).into());
        assert_eq!(client.apiserver_version().await.unwrap().git_version, "v1.33.4");
        // Reconnect: the same client now talks through the new connection.
        endpoint.set(server(200, VERSION, new.clone()).into());
        client.apiserver_version().await.unwrap();
        assert_eq!((old.load(Ordering::SeqCst), new.load(Ordering::SeqCst)), (1, 1));
    }

    #[tokio::test]
    async fn api_errors_pass_through_the_endpoint_unchanged() {
        let endpoint = Arc::new(Endpoint::default());
        endpoint.set(
            server(
                401,
                r#"{"kind":"Status","apiVersion":"v1","status":"Failure","message":"Unauthorized","reason":"Unauthorized","code":401}"#,
                Arc::default(),
            )
            .into(),
        );
        let err = Error::from(endpoint.client("default".into()).apiserver_version().await.unwrap_err());
        assert_eq!((err.code(), err.reason().as_deref()), (Some(401), Some("Unauthorized")));
    }

    #[tokio::test]
    async fn token_refresh_failures_stay_recognisable_through_the_endpoint() {
        let svc = tower::service_fn(|_req: http::Request<Body>| async { Err::<http::Response<Body>, _>(crate::error::tests::exec_failure()) });
        let endpoint = Arc::new(Endpoint::default());
        endpoint.set(Client::new(svc, "default").into());
        let err = endpoint.client("default".into()).apiserver_version().await.unwrap_err();
        assert!(is_auth_failure(&err) && !is_retryable(&err), "{err}");
    }

    #[tokio::test(start_paused = true)]
    async fn hanging_requests_time_out_and_linger_in_the_background_up_to_a_limit() {
        let hits = Arc::new(AtomicUsize::new(0));
        let h = hits.clone();
        let svc = tower::service_fn(move |_req: http::Request<Body>| {
            h.fetch_add(1, Ordering::SeqCst);
            std::future::pending::<Result<http::Response<Body>, std::convert::Infallible>>()
        });
        let endpoint = Arc::new(Endpoint { response_timeout: Some(Duration::from_secs(5)), ..Default::default() });
        endpoint.set(Client::new(svc, "default").into());
        let client = endpoint.client("default".into());
        for _ in 0..MAX_STUCK {
            let err = client.apiserver_version().await.unwrap_err().to_string();
            assert!(err.contains("no response from the API server within 5s"), "{err}");
        }
        let stuck = |e: &Endpoint| e.current.read().as_ref().unwrap().stuck.load(Ordering::SeqCst);
        assert_eq!(stuck(&endpoint), MAX_STUCK);
        // Beyond the limit nothing new is sent: the hanging ones are still waiting.
        let err = client.apiserver_version().await.unwrap_err().to_string();
        assert!(err.contains("are still waiting"), "{err}");
        assert_eq!(hits.load(Ordering::SeqCst), MAX_STUCK);

        // A reconnect (Retry) is not held back by the old connection's hanging requests.
        endpoint.set(server(200, VERSION, Arc::default()).into());
        assert_eq!(client.apiserver_version().await.unwrap().git_version, "v1.33.4");
        assert_eq!(stuck(&endpoint), 0);
    }

    /// A fake API server answering the n-th request (from 0) with `status(n)`, plus `Retry-After: 1` on 429s.
    fn busy_server(hits: Arc<AtomicUsize>, status: impl Fn(usize) -> u16 + Send + Sync + 'static) -> Client {
        let svc = tower::service_fn(move |_req: http::Request<Body>| {
            let code = status(hits.fetch_add(1, Ordering::SeqCst));
            async move {
                let mut res = http::Response::builder().status(code).header("content-type", "application/json");
                if code == 429 {
                    res = res.header("retry-after", "1");
                }
                let body = if code == 200 {
                    VERSION.to_string()
                } else {
                    format!(r#"{{"kind":"Status","apiVersion":"v1","status":"Failure","message":"busy","code":{code}}}"#)
                };
                Ok::<_, std::convert::Infallible>(res.body(Body::from(body.into_bytes())).unwrap())
            }
        });
        Client::new(svc, "default")
    }

    #[tokio::test(start_paused = true)]
    async fn reads_answered_busy_are_sent_again_a_few_times_and_mutations_never() {
        let hits = Arc::new(AtomicUsize::new(0));
        let endpoint = Arc::new(Endpoint::default());
        endpoint.set(busy_server(hits.clone(), |n| [503, 429, 504, 200][n.min(3)]).into());
        let client = endpoint.client("default".into());
        assert_eq!(client.apiserver_version().await.unwrap().git_version, "v1.33.4");
        assert_eq!(hits.load(Ordering::SeqCst), 4);

        // Busy for good: the last answer stands, after a few tries.
        let hits = Arc::new(AtomicUsize::new(0));
        endpoint.set(busy_server(hits.clone(), |_| 503).into());
        let err = Error::from(client.apiserver_version().await.unwrap_err());
        assert_eq!(err.code(), Some(503));
        assert_eq!(hits.load(Ordering::SeqCst), 1 + READ_RETRIES as usize);

        // A mutation answered 503 or 504 may have been carried out: never sent again.
        let hits = Arc::new(AtomicUsize::new(0));
        endpoint.set(busy_server(hits.clone(), |_| 504).into());
        let post = http::Request::post("/api/v1/namespaces/default/pods").body(Body::from(b"{}".to_vec())).unwrap();
        assert_eq!(client.send(post).await.unwrap().status(), 504);
        assert_eq!(hits.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn credentials_are_due_for_renewal_ahead_of_their_expiry_once_at_a_time() {
        let minutes = |m: u64| Duration::from_secs(m * 60);
        let endpoint = Arc::new(Endpoint::default());
        let t0 = SystemTime::now();
        // A token valid for 15 minutes (`aws eks get-token`) is renewed 2 minutes ahead.
        endpoint.set(Session { client: server(200, VERSION, Arc::default()), expires: Some(t0 + minutes(15)) });
        assert!(endpoint.renewal_due(t0 + minutes(12)).is_none());
        let renewal = endpoint.renewal_due(t0 + minutes(13)).expect("due");
        assert!(endpoint.renewal_due(t0 + minutes(13)).is_none(), "one renewal at a time");
        // It failed: again a minute later, while the token is still valid…
        renewal.failed(t0 + minutes(13));
        assert!(endpoint.renewal_due(t0 + minutes(13)).is_none());
        let renewal = endpoint.renewal_due(t0 + minutes(14)).expect("due again");
        // …but never once expired: rejected requests renew it then.
        renewal.failed(t0 + minutes(14));
        assert!(endpoint.renewal_due(t0 + minutes(16)).is_none());

        // Renewed: the endpoint carries the new session.
        endpoint.set(Session { client: server(200, VERSION, Arc::default()), expires: Some(t0 + minutes(15)) });
        let renewal = endpoint.renewal_due(t0 + minutes(13)).unwrap();
        assert!(renewal.complete(Session { client: server(200, VERSION, Arc::default()), expires: Some(t0 + minutes(30)) }));
        assert_eq!(endpoint.expires(), Some(t0 + minutes(30)));
        // A reconnect meanwhile brought credentials of its own: a late renewal does not replace them.
        let renewal = endpoint.renewal_due(t0 + minutes(28)).unwrap();
        endpoint.set(Session { client: server(200, VERSION, Arc::default()), expires: Some(t0 + minutes(45)) });
        assert!(!renewal.complete(Session { client: server(200, VERSION, Arc::default()), expires: Some(t0 + minutes(31)) }));
        assert_eq!(endpoint.expires(), Some(t0 + minutes(45)));

        // Short-lived credentials wait for half their life; those that do not expire are never renewed.
        endpoint.set(Session { client: server(200, VERSION, Arc::default()), expires: Some(t0 + Duration::from_secs(60)) });
        assert!(endpoint.renewal_due(t0 + Duration::from_secs(29)).is_none());
        assert!(endpoint.renewal_due(t0 + Duration::from_secs(31)).is_some());
        endpoint.set(server(200, VERSION, Arc::default()).into());
        assert!(endpoint.renewal_due(t0 + minutes(60 * 24)).is_none());
    }

    #[test]
    fn retryable_errors() {
        let api = |code: u16| kube::Error::Api(Box::new(kube::core::Status { code, ..Default::default() }));
        assert!(is_retryable(&api(503)) && is_retryable(&api(429)));
        assert!(!is_retryable(&api(401)) && !is_retryable(&api(403)) && !is_retryable(&api(404)));
        assert!(!is_retryable(&kube::Error::Auth(crate::error::tests::exec_failure())));
        assert!(!is_retryable(&kube::Error::Service(Box::new(crate::error::tests::exec_failure()))));
        assert!(is_retryable(&request_failure("connection refused")));
        let connect: ConnectError = Error::from(api(503)).into();
        assert!(connect.retryable);
        let config: ConnectError = Error::Kubeconfig("bad".into()).into();
        assert!(!config.retryable);
    }

    #[test]
    fn connection_changes_are_published() {
        let m = ClusterManager::default();
        let mut rx = m.changes();
        rx.borrow_and_update();
        let Ok(Joined::Pending(_)) = m.join_or_start("a", false, |_| shared(std::future::pending())) else { panic!("no attempt started") };
        assert!(rx.has_changed().unwrap());
        let (generation, state) = m.state("a").unwrap();
        assert!(matches!(state, ConnState::Connecting));
        rx.borrow_and_update();

        let err = ConnectError { message: "connection refused".into(), code: None, retryable: true };
        assert!(m.finish("a", generation, &Err(err), None));
        assert!(rx.has_changed().unwrap());
        assert!(matches!(m.state("a"), Some((g, ConnState::Failed(e))) if g == generation && e.retryable));
        // A superseded attempt changes nothing.
        assert!(!m.finish("a", generation, &Err(ConnectError::fatal("late".into())), None));

        rx.borrow_and_update();
        m.nudge();
        assert_eq!(rx.borrow_and_update().resyncs, 1);
        assert!(m.remove("a") && m.state("a").is_none());
        assert!(rx.has_changed().unwrap());
    }

    /// A kubeconfig whose user authenticates with `sh -c <script>` as exec plugin.
    async fn exec_config(script: &str) -> kube::Config {
        let yaml = format!(
            r#"
apiVersion: v1
kind: Config
clusters: [{{name: c, cluster: {{server: "https://127.0.0.1:1"}}}}]
users:
- name: u
  user:
    exec:
      apiVersion: client.authentication.k8s.io/v1
      command: sh
      args: ["-c", {script:?}]
      interactiveMode: Never
contexts: [{{name: ctx, context: {{cluster: c, user: u}}}}]
current-context: ctx
"#
        );
        let kc = kube::config::Kubeconfig::from_yaml(&yaml).unwrap();
        kube::Config::from_custom_kubeconfig(kc, &Default::default()).await.unwrap()
    }

    const CREDENTIAL: &str = r#"{"apiVersion":"client.authentication.k8s.io/v1","kind":"ExecCredential","status":{"token":"t"}}"#;

    fn ok() -> String {
        format!("echo '{CREDENTIAL}'")
    }

    fn gates(run: Duration, queue: Duration) -> ExecGates {
        ExecGates { run_timeout: run, queue_timeout: queue, ..Default::default() }
    }

    /// A file the test plugin writes `start`/`end` lines to, one per test.
    struct RunLog(std::path::PathBuf);

    impl RunLog {
        fn new(test: &str) -> Self {
            let dir = std::env::temp_dir().join(format!("k10s-exec-{}-{test}", std::process::id()));
            std::fs::create_dir_all(&dir).unwrap();
            let path = dir.join("runs");
            let _ = std::fs::remove_file(&path);
            RunLog(path)
        }

        /// A plugin script: logs its start, takes `secs`, logs its end, then runs `then`.
        fn script(&self, secs: f32, then: &str) -> String {
            format!("echo start >> '{0}'; sleep {secs}; echo end >> '{0}'; {then}", self.0.display())
        }

        fn lines(&self) -> Vec<String> {
            std::fs::read_to_string(&self.0).map(|s| s.lines().map(String::from).collect()).unwrap_or_default()
        }
    }

    impl Drop for RunLog {
        fn drop(&mut self) {
            if let Some(dir) = self.0.parent() {
                let _ = std::fs::remove_dir_all(dir);
            }
        }
    }

    /// Builds `n` clients with `script` as exec plugin at once.
    async fn batch(gates: &ExecGates, script: &str, n: usize, fresh: bool) -> Vec<Result<Session, ConnectError>> {
        let mut runs = Vec::new();
        for _ in 0..n {
            runs.push(build_client(gates, exec_config(script).await, fresh, false));
        }
        futures::future::join_all(runs).await
    }

    fn all_ok(results: Vec<Result<Session, ConnectError>>) {
        for res in results {
            assert!(res.is_ok(), "{:?}", res.err());
        }
    }

    /// One run per client (kube would run it three times: TLS identity, expiry, auth layer).
    const ONE_CLIENT_ALONE: [&str; 2] = ["start", "end"];

    #[tokio::test]
    async fn the_first_plugin_run_goes_alone_then_the_rest_in_parallel() {
        let log = RunLog::new("first");
        let gates = gates(Duration::from_secs(20), Duration::from_secs(20));
        all_ok(batch(&gates, &log.script(0.3, &ok()), 4, false).await);
        let lines = log.lines();
        assert_eq!(lines.len(), 4 * 2);
        assert_eq!(lines[..2], ONE_CLIENT_ALONE, "the first client must be done before others start: {lines:?}");
        // Once warm, the rest overlap.
        assert_eq!(lines[2..4], ["start", "start"], "{lines:?}");
    }

    #[tokio::test]
    async fn after_a_quiet_period_and_for_fresh_credentials_the_first_run_goes_alone_again() {
        let log = RunLog::new("quiet");
        let script = log.script(0.2, &ok());
        let gates = ExecGates { warm_for: Duration::from_millis(300), ..gates(Duration::from_secs(20), Duration::from_secs(20)) };
        all_ok(batch(&gates, &script, 1, false).await);
        // The plugin's login may have expired meanwhile (sleep, the next morning): one run first, then the rest.
        tokio::time::sleep(Duration::from_millis(400)).await;
        let before = log.lines().len();
        all_ok(batch(&gates, &script, 3, false).await);
        let lines = log.lines()[before..].to_vec();
        assert_eq!(lines[..2], ONE_CLIENT_ALONE, "{lines:?}");
        assert_eq!(lines[2..4], ["start", "start"], "{lines:?}");
        // Warm now, but runs asking for fresh credentials (reconnect, rejected credentials) go alone all the same.
        let before = log.lines().len();
        all_ok(batch(&gates, &script, 3, true).await);
        let lines = log.lines()[before..].to_vec();
        assert_eq!(lines[..2], ONE_CLIENT_ALONE, "{lines:?}");
        assert_eq!(lines[2..4], ["start", "start"], "{lines:?}");
    }

    #[tokio::test]
    async fn callers_waiting_for_a_failed_run_take_its_error_instead_of_running_the_plugin_again() {
        let log = RunLog::new("failed");
        let script = log.script(0.3, "echo please sign in again >&2; exit 1");
        let gates = gates(Duration::from_secs(20), Duration::from_secs(20));
        let errors: Vec<String> = batch(&gates, &script, 4, false).await.into_iter().map(|r| r.err().unwrap().message).collect();
        assert!(errors[0].contains("please sign in again (run the plugin in a terminal to see why)"), "{}", errors[0]);
        assert!(errors.iter().all(|e| *e == errors[0]), "{errors:?}");
        assert_eq!(log.lines(), ["start", "end"], "one run for all of them");
        // The next attempt (Retry) runs it again. Another context invoking the same plugin differently (other
        // arguments or environment) waits for that run, but does not take its error.
        let (again, other) = (exec_config(&script).await, exec_config(&ok()).await);
        let (again, other) = tokio::join!(build_client(&gates, again, true, false), build_client(&gates, other, false, false));
        assert!(again.is_err() && other.is_ok(), "{:?}", other.err());
        assert_eq!(log.lines().len(), 4);
    }

    #[tokio::test]
    async fn a_plugin_runs_once_per_client_and_never_inside_its_requests() {
        let log = RunLog::new("once");
        // A token about to expire: kube would run the plugin again before each request.
        let soon = crate::time::format_rfc3339(crate::time::now_unix() + 30);
        let credential =
            format!(r#"{{"apiVersion":"client.authentication.k8s.io/v1","kind":"ExecCredential","status":{{"token":"t","expirationTimestamp":"{soon}"}}}}"#);
        let script = log.script(0.0, &format!("echo '{credential}'"));
        let session = build_client(&gates(Duration::from_secs(20), Duration::from_secs(20)), exec_config(&script).await, false, false).await.unwrap();
        assert!(session.expires.is_some_and(|t| t > SystemTime::now()));
        for _ in 0..3 {
            // 127.0.0.1:1 refuses the connection; what matters is that the plugin does not run.
            assert!(session.client.apiserver_version().await.is_err());
        }
        assert_eq!(log.lines(), ONE_CLIENT_ALONE);
    }

    #[tokio::test]
    async fn waiting_for_a_free_slot_is_not_bounded_by_the_queue_timeout() {
        let gates = ExecGates { slots: Arc::new(Semaphore::new(1)), ..gates(Duration::from_secs(20), Duration::from_millis(500)) };
        let script = format!("sleep 0.3; {}", ok());
        all_ok(batch(&gates, &script, 1, false).await);
        // A big selection: clients wait for the single slot far longer than the queue timeout, and all connect.
        let started = Instant::now();
        all_ok(batch(&gates, &script, 4, false).await);
        assert!(started.elapsed() > gates.queue_timeout);
    }

    #[tokio::test]
    async fn plugin_failures_name_the_plugin() {
        let gates = gates(Duration::from_secs(20), Duration::from_secs(20));
        let mut config = exec_config("exit 1").await;
        config.auth_info.exec.as_mut().unwrap().command = Some("/nonexistent/bin/kubelogin".into());
        let err = build_client(&gates, config.clone(), false, false).await.err().unwrap();
        assert_eq!(err.message, "auth plugin `kubelogin` was not found: install it or add its folder to PATH in your shell profile, then reconnect");
        assert!(!err.retryable);
        // Not the profile's fault when the login shell environment could not be imported.
        let err = build_client(&gates, config, true, true).await.err().unwrap();
        assert!(
            err.message.starts_with("auth plugin `kubelogin` was not found: the environment of your login shell (with its PATH) could not be imported"),
            "{}",
            err.message
        );

        let err = build_client(&gates, exec_config("echo please sign in again >&2; exit 1").await, false, false).await.err().unwrap();
        assert!(
            err.message.starts_with("auth plugin `sh -c")
                && err.message.ends_with("failed (exit status: 1): please sign in again (run the plugin in a terminal to see why)"),
            "{}",
            err.message
        );
    }

    #[tokio::test]
    async fn a_hung_plugin_times_out_and_is_not_started_again_while_it_runs() {
        let gates = gates(Duration::from_secs(1), Duration::from_secs(1));
        let started = Instant::now();
        let err = build_client(&gates, exec_config("sleep 3").await, false, false).await.err().unwrap();
        assert!(err.message.starts_with("auth plugin `sh` did not finish within 1s (waiting for a login?)"), "{}", err.message);
        assert!(started.elapsed() < Duration::from_secs(3));
        // The hung run still holds the plugin's turn: the next caller gives up instead of starting a second
        // one — and may wait again later, which starts nothing either.
        let err = build_client(&gates, exec_config(&ok()).await, false, false).await.err().unwrap();
        assert!(err.message.starts_with("gave up waiting for auth plugin `sh`"), "{}", err.message);
        assert!(err.retryable);
        // Other plugins are not affected.
        let mut other = exec_config(&ok()).await;
        other.auth_info.exec.as_mut().unwrap().command = Some("/bin/sh".into());
        build_client(&gates, other, false, false).await.unwrap();
    }

    #[tokio::test]
    async fn client_setup_errors_without_a_plugin_are_not_retried() {
        let mut config = kube::Config::new("https://127.0.0.1:1".parse().unwrap());
        config.root_cert = Some(vec![b"not a certificate".to_vec()]);
        let err = build_client(&ExecGates::default(), config, false, false).await.err().unwrap();
        assert!(!err.retryable, "{}", err.message);
    }

    const UNAUTHORIZED: &str = r#"{"kind":"Status","apiVersion":"v1","status":"Failure","message":"Unauthorized","reason":"Unauthorized","code":401}"#;
    const UNAVAILABLE: &str = r#"{"kind":"Status","apiVersion":"v1","status":"Failure","message":"unavailable","reason":"ServiceUnavailable","code":503}"#;

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

    #[tokio::test]
    async fn printer_columns_are_kept_once_found_but_failures_are_not() {
        use crate::render::table::{fake, tests::definitions, tests::table};
        // Reading the CRD is forbidden (strict RBAC). Server-side printing: listing is forbidden in `a`; in `b`
        // the first answers fail (503), then it works.
        let probes = Arc::new(AtomicUsize::new(0));
        let log: fake::Log = Arc::default();
        let p = probes.clone();
        let client = fake::server(log.clone(), move |uri, accept| {
            if uri.contains("/customresourcedefinitions/") {
                return fake::Reply::status(403);
            }
            assert!(accept.contains("as=Table") && uri.contains("includeObject=None") && uri.contains("limit=1"), "{uri} {accept}");
            if uri.contains("/namespaces/a/") {
                return fake::Reply::status(403);
            }
            match p.fetch_add(1, Ordering::SeqCst) {
                0 => fake::Reply::status(503),
                _ => fake::Reply::json(table(Some(&definitions(&[("Ready", "string", 0)])), &[], "1").to_string()),
            }
        });
        let cluster = Cluster::for_tests("prod-eu-z1", client, vec![widgets()]);
        let only_a = [Some(Arc::from("a"))];
        let a_and_b = [Some(Arc::from("a")), Some(Arc::from("b"))];

        // Listing forbidden where the view looks: its watches say so; nothing is kept.
        let p = cluster.printer_for(&widgets(), &only_a).await;
        assert!(p.renderer.columns().is_empty() && p.notice.is_none() && !p.retry);
        // A transient failure: said, retried, not kept.
        let p = cluster.printer_for(&widgets(), &a_and_b).await;
        assert!(p.renderer.columns().is_empty() && p.retry);
        assert_eq!(p.notice.as_deref(), Some("printer columns unavailable: failed with 503"));
        // Then server-side printing works (in `b`): the columns are kept.
        let p = cluster.printer_for(&widgets(), &a_and_b).await;
        assert_eq!(p.renderer.columns()[0].id, "pc_ready_status");
        assert!(p.renderer.server_table().is_some() && p.notice.is_none());
        let asked = log.lock().len();
        assert!(Arc::ptr_eq(&cluster.printer_for(&widgets(), &[None]).await.renderer, &p.renderer));
        assert_eq!(log.lock().len(), asked);
        let crd_reads = log.lock().iter().filter(|(uri, _)| uri.contains("/customresourcedefinitions/widgets.example.com")).count();
        assert_eq!(crd_reads, 3, "a forbidden CRD is asked for again until columns are found");
    }

    #[tokio::test]
    async fn server_side_columns_are_asked_for_in_every_namespace_the_view_looks_at() {
        use crate::render::table::{fake, tests::definitions, tests::table};
        // Strict RBAC across DCs: the view's namespaces are those granted anywhere; here only the last one.
        let log: fake::Log = Arc::default();
        let client = fake::server(log.clone(), |uri, _| {
            if uri.contains("/customresourcedefinitions/") || !uri.contains("/namespaces/team-e/") {
                return fake::Reply::status(403);
            }
            fake::Reply::json(table(Some(&definitions(&[("Ready", "string", 0)])), &[], "1").to_string())
        });
        let cluster = Cluster::for_tests("prod-eu-z1", client, vec![widgets()]);
        let namespaces: Vec<Option<Arc<str>>> = ["team-a", "team-b", "team-c", "team-d", "team-e"].map(|n| Some(Arc::from(n))).into();
        let p = cluster.printer_for(&widgets(), &namespaces).await;
        assert_eq!(p.renderer.columns()[0].id, "pc_ready_status");
        assert!(p.found && p.notice.is_none());
    }

    #[tokio::test]
    async fn without_the_crd_and_without_server_side_printing_the_ui_is_told_why() {
        use crate::render::table::fake;
        let log: fake::Log = Arc::default();
        // An old aggregated API server that answers plain JSON whatever it is asked for.
        let client = fake::server(log.clone(), |uri, _| {
            if uri.contains("/customresourcedefinitions/") {
                fake::Reply::status(403)
            } else {
                fake::Reply::json(r#"{"kind":"WidgetList","apiVersion":"example.com/v1","metadata":{"resourceVersion":"1"},"items":[]}"#)
            }
        });
        let cluster = Cluster::for_tests("prod-eu-z1", client, vec![widgets()]);
        let p = cluster.printer_for(&widgets(), &[None]).await;
        assert!(p.renderer.columns().is_empty() && !p.retry);
        assert_eq!(
            p.notice.as_deref(),
            Some("printer columns unavailable: no access to its CustomResourceDefinition, and the API server does not print tables for widgets.example.com")
        );
        // Neither changes until discovery is refreshed (or the cluster reconnects): kept.
        let asked = log.lock().len();
        assert!(cluster.printer_for(&widgets(), &[None]).await.notice.is_some());
        assert_eq!(log.lock().len(), asked);
    }

    async fn attempt(script: &str, built: Client) -> Attempt {
        Attempt {
            context: Arc::from("prod-eu-z1"),
            config: exec_config(script).await,
            default_namespace: None,
            built: Some(built.into()),
            fresh: false,
            env_failed: false,
        }
    }

    #[tokio::test]
    async fn a_client_that_could_not_reach_its_cluster_is_reused_until_the_cluster_rejects_it() {
        let log = RunLog::new("reuse");
        let gates = gates(Duration::from_secs(20), Duration::from_secs(20));
        let endpoint = Arc::new(Endpoint::default());
        let script = log.script(0.0, &ok());
        // Still unreachable: checked again and kept, without running the plugin.
        let failed = connect(attempt(&script, server(503, UNAVAILABLE, Arc::default())).await, &gates, &endpoint).await.err().unwrap();
        assert!(failed.err.retryable && failed.client.is_some(), "{}", failed.err.message);
        assert!(log.lines().is_empty());

        // Reachable, but the credentials expired meanwhile: a new client is built (the plugin runs). Its
        // cluster (127.0.0.1:1) refuses connections, so that one is kept in turn.
        let failed = connect(attempt(&script, server(401, UNAUTHORIZED, Arc::default())).await, &gates, &endpoint).await.err().unwrap();
        assert_eq!(log.lines(), ONE_CLIENT_ALONE);
        assert!(failed.err.retryable && failed.client.is_some(), "{}", failed.err.message);
    }
}
