use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant, SystemTime};

use futures::future::BoxFuture;
use futures::{FutureExt, StreamExt};
#[cfg(test)]
use kube::Client;
use parking_lot::{Mutex, RwLock};
use serde::{Deserialize, Serialize};
use tokio::runtime::Handle;
use tokio::task::AbortHandle;

use crate::access::{self, AccessCheck, AccessDecision};
use crate::cluster::{self, Attempt, Cluster, ClusterInfo, ClusterManager, ConnState, ConnectError, Joined, Renewal, Session, is_auth_failure};
use crate::env::{self, ShellEnv};
use crate::error::{Error, Result, sanitize_error_text};
use crate::feed::{HubStats, WatchHub};
use crate::helm;
use crate::kubeconfig::{ContextList, KubeconfigStore};
use crate::logs::{self, LogSpec, LogTarget};
use crate::metrics::{self, MetricsSpec};
use crate::object::ObjectRef;
use crate::ops::{self, OpResult};
use crate::pf::{self, ForwardInfo, ForwardSpec};
use crate::relations::{self, RelationsSpec};
use crate::term::{self, DebugSpec, NodeShellSpec, TermSize, TermSpec};
use crate::view::{self, Sink, ViewSpec};

/// The first login-shell environment import (at startup).
const ENV_TIMEOUT: Duration = Duration::from_secs(8);
/// Later attempts after a failed import get more time (a cold start may have been the problem).
const ENV_RETRY_TIMEOUT: Duration = Duration::from_secs(15);
/// A failed import is retried by the next connect or kubeconfig read after this long…
const ENV_RETRY_AFTER: Duration = Duration::from_secs(60);
/// …or after this long on an explicit kubeconfig reload.
const ENV_RELOAD_RETRY_AFTER: Duration = Duration::from_secs(5);
/// Credentials rejected (401) trigger at most one reconnect per cluster within this window.
const REAUTH_COOLDOWN: Duration = Duration::from_secs(60);

/// Engine settings, saved by whoever runs the engine (see [`Engine::use_settings`]).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    /// Refuse every mutating action (delete, scale, restart, …). Turned off only by
    /// [`Engine::set_read_only`], after the user confirmed it.
    pub read_only: bool,
    /// How long an unused watch stays warm (instant back-navigation) before it is stopped.
    pub feed_idle_ttl_secs: u64,
}

impl Default for Settings {
    fn default() -> Self {
        Self { read_only: false, feed_idle_ttl_secs: 180 }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum EngineEvent {
    #[serde(rename_all = "camelCase")]
    Cluster {
        context: String,
        state: ClusterState,
        #[serde(skip_serializing_if = "Option::is_none")]
        message: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        version: Option<String>,
    },
    /// The kubeconfig in effect may have changed (the login-shell environment, with its `KUBECONFIG`,
    /// was imported after a failed attempt): list the contexts again.
    Contexts,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ClusterState {
    Connecting,
    Connected,
    Error,
    Disconnected,
}

type EventFn = Arc<dyn Fn(EngineEvent) + Send + Sync>;
type EnvLoader = Box<dyn Fn(Duration) -> BoxFuture<'static, ShellEnv> + Send + Sync>;

/// The last login-shell environment import, see [`Inner::shell_env`].
struct EnvCache {
    env: Arc<ShellEnv>,
    /// Tokio's clock, so tests can let time pass.
    at: tokio::time::Instant,
    /// Changes whenever a new import differs from the previous one.
    revision: u64,
}

pub(crate) struct Inner {
    pub rt: Handle,
    env: tokio::sync::Mutex<Option<EnvCache>>,
    load_env: EnvLoader,
    /// The parsed kubeconfig and the environment revision it was read with.
    kubeconfig: Mutex<Option<(Arc<KubeconfigStore>, u64)>>,
    pub clusters: ClusterManager,
    pub hub: WatchHub,
    tasks: Mutex<HashMap<u64, AbortHandle>>,
    /// Target updates of running log streams, by stream id (see [`Engine::update_log_targets`]).
    log_targets: Mutex<HashMap<u64, logs::Control>>,
    /// Keystrokes, resizes and acknowledgements for running terminals, by session id (see [`Engine::terminal_input`]).
    terms: Mutex<HashMap<u64, term::Controls>>,
    /// Port-forwards: the engine's, not a page's (they outlive a reload of the UI).
    pub(crate) forwards: pf::Forwards,
    /// Polls of the metrics API, shared by the views showing usage.
    pub(crate) metrics: metrics::MetricsHub,
    /// What the user may do, as asked lately (see `access.rs`).
    pub(crate) access: access::AccessCache,
    next_id: AtomicU64,
    settings: RwLock<Settings>,
    /// Where settings are saved; also held while a change is applied and saved, so what is saved last is the
    /// last change.
    settings_save: Mutex<Option<SaveSettings>>,
    /// Mutations in flight per cluster (see [`ops::PARALLEL_PER_CLUSTER`]).
    pub(crate) op_slots: ops::Slots,
    events: RwLock<Option<EventFn>>,
    /// When each cluster was last reconnected because its credentials were rejected.
    reauth: Mutex<HashMap<String, Instant>>,
    /// Per context, a client whose credentials worked but whose cluster could not be reached, and the
    /// kubeconfig it was built from: the next attempt that does not ask for fresh credentials checks it
    /// again, so the exec plugin does not run again and again while only the network is down.
    unreachable: Mutex<HashMap<String, (Session, Arc<KubeconfigStore>)>>,
    /// Replaces [`Inner::establish`] in tests.
    #[cfg(test)]
    fake_connect: Mutex<Option<FakeConnect>>,
}

#[cfg(test)]
type FakeConnect = Arc<dyn Fn(&str, &Arc<cluster::Endpoint>) -> BoxFuture<'static, Result<(Arc<Cluster>, Client), ConnectError>> + Send + Sync>;

impl Inner {
    fn new(rt: Handle, load_env: EnvLoader) -> Arc<Self> {
        let settings = Settings::default();
        Arc::new(Inner {
            hub: WatchHub::new(rt.clone(), Duration::from_secs(settings.feed_idle_ttl_secs)),
            rt,
            env: tokio::sync::Mutex::new(None),
            load_env,
            kubeconfig: Mutex::new(None),
            clusters: ClusterManager::default(),
            tasks: Mutex::new(HashMap::new()),
            log_targets: Mutex::new(HashMap::new()),
            terms: Mutex::new(HashMap::new()),
            forwards: pf::Forwards::default(),
            metrics: metrics::MetricsHub::default(),
            access: access::AccessCache::default(),
            next_id: AtomicU64::new(0),
            settings: RwLock::new(settings),
            settings_save: Mutex::new(None),
            op_slots: ops::Slots::default(),
            events: RwLock::new(None),
            reauth: Mutex::new(HashMap::new()),
            unreachable: Mutex::new(HashMap::new()),
            #[cfg(test)]
            fake_connect: Mutex::new(None),
        })
    }

    /// An engine core that never touches the user's environment: no shell import, an empty kubeconfig.
    #[cfg(test)]
    pub(crate) fn for_tests() -> Arc<Self> {
        let inner = Inner::new(Handle::current(), Box::new(|_| async { ShellEnv::default() }.boxed()));
        *inner.env.try_lock().unwrap() = Some(EnvCache { env: Arc::default(), at: tokio::time::Instant::now(), revision: 1 });
        *inner.kubeconfig.lock() = Some((Arc::new(KubeconfigStore::from_yaml("apiVersion: v1\nkind: Config\n")), 1));
        inner
    }

    #[cfg(test)]
    pub(crate) fn set_read_only_for_tests(&self, on: bool) {
        self.settings.write().read_only = on;
    }

    /// Connects (and reconnects) with `f` instead of a kubeconfig.
    #[cfg(test)]
    pub(crate) fn fake_connect_for_tests(
        &self,
        f: impl Fn(&str, &Arc<cluster::Endpoint>) -> Result<(Arc<Cluster>, Client), ConnectError> + Send + Sync + 'static,
    ) {
        *self.fake_connect.lock() =
            Some(Arc::new(move |context: &str, endpoint: &Arc<cluster::Endpoint>| futures::future::ready(f(context, endpoint)).boxed()));
    }

    /// The login-shell environment and its revision. Imported once (concurrent callers share the
    /// attempt); a failed import is not kept until restart but retried — at most every
    /// [`ENV_RETRY_AFTER`], or [`ENV_RELOAD_RETRY_AFTER`] when `reload` (an explicit kubeconfig reload).
    async fn shell_env(&self, reload: bool) -> (Arc<ShellEnv>, u64) {
        let mut cache = self.env.lock().await;
        if let Some(c) = cache.as_ref() {
            let retry_after = if reload { ENV_RELOAD_RETRY_AFTER } else { ENV_RETRY_AFTER };
            if !c.env.import_failed() || c.at.elapsed() < retry_after {
                return (c.env.clone(), c.revision);
            }
            tracing::info!("retrying the login shell environment import");
        }
        let env = Arc::new((self.load_env)(if cache.is_some() { ENV_RETRY_TIMEOUT } else { ENV_TIMEOUT }).await);
        let (revision, changed) = match cache.as_ref() {
            None => (1, false),
            Some(c) if c.env == env => (c.revision, false),
            Some(c) => (c.revision + 1, true),
        };
        *cache = Some(EnvCache { env: env.clone(), at: tokio::time::Instant::now(), revision });
        drop(cache);
        if changed {
            self.emit(EngineEvent::Contexts);
        }
        (env, revision)
    }

    pub async fn env(&self) -> Arc<ShellEnv> {
        self.shell_env(false).await.0
    }

    pub async fn kubeconfig(&self) -> Result<Arc<KubeconfigStore>> {
        self.load_kubeconfig(false).await
    }

    /// The kubeconfig, re-read when a file changed or the login-shell environment did.
    async fn load_kubeconfig(&self, reload: bool) -> Result<Arc<KubeconfigStore>> {
        let (env, revision) = self.shell_env(reload).await;
        if let Some((kc, read_with)) = self.kubeconfig.lock().clone()
            && read_with == revision
            && !kc.is_stale()
        {
            return Ok(kc);
        }
        let kc = tokio::task::spawn_blocking(move || KubeconfigStore::load(&env)).await.map_err(|e| Error::other(e.to_string()))??;
        let kc = Arc::new(kc);
        *self.kubeconfig.lock() = Some((kc.clone(), revision));
        Ok(kc)
    }

    pub fn emit(&self, event: EngineEvent) {
        if let Some(f) = self.events.read().clone() {
            f(event);
        }
    }

    pub fn guard_write(&self) -> Result<()> {
        if self.settings.read().read_only { Err(Error::ReadOnly) } else { Ok(()) }
    }

    /// Connected cluster for `context`, connecting (once, shared by all concurrent callers) if needed.
    /// A successful (re)connect restarts the cluster's active watches with the new credentials.
    pub async fn connect(self: &Arc<Self>, context: &str, force: bool) -> Result<Arc<Cluster>> {
        let joined = self.clusters.join_or_start(context, force, |generation| {
            let inner = self.clone();
            let ctx: Arc<str> = Arc::from(context);
            let handle = self.rt.spawn(async move {
                inner.emit(EngineEvent::Cluster { context: ctx.to_string(), state: ClusterState::Connecting, message: None, version: None });
                let (res, session) = match inner.establish(ctx.clone(), force).await {
                    Ok((cluster, session)) => (Ok(cluster), Some(session)),
                    Err(e) => (Err(e), None),
                };
                if inner.clusters.finish(&ctx, generation, &res, session) {
                    if res.is_ok() {
                        let restarted = inner.hub.restart_cluster(&ctx);
                        if restarted > 0 {
                            tracing::debug!(context = %ctx, restarted, "watches restarted with the new connection");
                        }
                    }
                    inner.emit(match &res {
                        Ok(c) => EngineEvent::Cluster { context: ctx.to_string(), state: ClusterState::Connected, message: None, version: c.version.clone() },
                        Err(e) => {
                            EngineEvent::Cluster { context: ctx.to_string(), state: ClusterState::Error, message: Some(e.message.clone()), version: None }
                        }
                    });
                }
                res
            });
            cluster::shared(async move {
                handle.await.unwrap_or_else(|e| Err(ConnectError { message: sanitize_error_text(&e.to_string()), code: None, retryable: false }))
            })
        });
        match joined {
            Ok(Joined::Ready(c)) => Ok(c),
            Ok(Joined::Pending(fut)) => fut.await.map_err(|e| e.into_error(context)),
            Err(e) => Err(e.into_error(context)),
        }
    }

    /// One connection attempt. `fresh`: new credentials are wanted (the exec plugin runs again).
    async fn establish(&self, context: Arc<str>, fresh: bool) -> Result<(Arc<Cluster>, Session), ConnectError> {
        #[cfg(test)]
        {
            let fake = self.fake_connect.lock().clone();
            if let Some(fake) = fake {
                return fake(&context, &self.clusters.endpoint(&context)).await.map(|(cluster, client)| (cluster, client.into()));
            }
        }
        let started = Instant::now();
        let kc = self.kubeconfig().await?;
        let env = self.env().await;
        let config = kc.client_config(&context, &env).await?;
        let endpoint = self.clusters.endpoint(&context);
        // Only with the kubeconfig it was built from: an edited one (or a newly imported environment) builds anew.
        let built = self.unreachable.lock().remove(&*context).filter(|(_, from)| !fresh && Arc::ptr_eq(from, &kc)).map(|(session, _)| session);
        let attempt =
            Attempt { context: context.clone(), config, default_namespace: kc.default_namespace(&context), built, fresh, env_failed: env.import_failed() };
        match cluster::connect(attempt, &self.clusters.exec, &endpoint).await {
            Ok((c, session)) => {
                tracing::info!(%context, version = ?c.version, resources = c.discovery().resources.len(), elapsed = ?started.elapsed(), "connected");
                Ok((c, session))
            }
            Err(failed) => {
                let e = failed.err;
                tracing::warn!(%context, error = %e.message, retryable = e.retryable, "connection failed");
                if let Some(session) = failed.client {
                    self.unreachable.lock().insert(context.to_string(), (*session, kc));
                }
                Err(e)
            }
        }
    }

    /// Credentials of `context` were rejected (HTTP 401, or its exec plugin failed while refreshing a
    /// token): reconnects once — running the exec plugin again for fresh ones — unless that was done
    /// within [`REAUTH_COOLDOWN`] or the cluster is not connected. Returns whether it reconnected.
    pub(crate) async fn reauthenticate(self: &Arc<Self>, context: &str) -> bool {
        if !matches!(self.clusters.state(context), Some((_, ConnState::Ready))) {
            return false;
        }
        {
            let mut last = self.reauth.lock();
            if last.get(context).is_some_and(|t| t.elapsed() < REAUTH_COOLDOWN) {
                return false;
            }
            last.insert(context.to_string(), Instant::now());
        }
        tracing::info!(%context, "credentials rejected, reconnecting for fresh ones");
        self.connect(context, true).await.is_ok()
    }

    /// Starts [`Inner::reauthenticate`] in the background if `err` says the credentials were rejected.
    fn reauthenticate_on(self: &Arc<Self>, context: &str, err: &Error) {
        if needs_reauth(err) {
            let inner = self.clone();
            let context = context.to_string();
            self.rt.spawn(async move {
                inner.reauthenticate(&context).await;
            });
        }
    }

    /// Credentials about to expire (an exec plugin's token or certificate) are renewed ahead of time,
    /// `now`, through the plugin gates like a connect — kube would run the plugin inside a request
    /// instead, ungated and without a timeout. Views, watches and log streams go on undisturbed: the
    /// renewed client takes their next requests. Clusters not connected renew theirs when they connect.
    pub(crate) fn renew_expiring(self: &Arc<Self>, now: SystemTime) {
        for (context, endpoint) in self.clusters.connected_endpoints() {
            if let Some(renewal) = endpoint.renewal_due(now) {
                let inner = self.clone();
                self.rt.spawn(async move { inner.renew(context, renewal).await });
            }
        }
    }

    async fn renew(&self, context: String, renewal: Renewal) {
        let session = async {
            let kc = self.kubeconfig().await?;
            let env = self.env().await;
            let config = kc.client_config(&context, &env).await?;
            cluster::build_client(&self.clusters.exec, config, false, env.import_failed()).await.map_err(|e| e.into_error(&context))
        };
        match session.await {
            Ok(session) => {
                if renewal.complete(session) {
                    tracing::debug!(%context, "credentials renewed ahead of their expiry");
                }
            }
            Err(e) => {
                tracing::warn!(%context, error = %e.message(), "credentials could not be renewed ahead of their expiry");
                renewal.failed(SystemTime::now());
            }
        }
    }

    fn track(self: &Arc<Self>, fut: impl Future<Output = ()> + Send + 'static) -> u64 {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed) + 1;
        let inner = self.clone();
        // Register before the task can finish, so its own cleanup always finds the entry.
        let mut tasks = self.tasks.lock();
        let handle = self.rt.spawn(async move {
            fut.await;
            inner.tasks.lock().remove(&id);
        });
        tasks.insert(id, handle.abort_handle());
        id
    }
}

/// The request was rejected for its credentials: 401, or the exec plugin failed refreshing a token.
fn needs_reauth(err: &Error) -> bool {
    match err {
        Error::Kube(kube::Error::Api(s)) => s.code == 401,
        Error::Kube(e) => is_auth_failure(e),
        _ => false,
    }
}

/// Where the engine's settings go when they change (the desktop app: its settings file). A change that could not be
/// saved stays in effect until the app quits.
pub type SaveSettings = Box<dyn Fn(&Settings) -> std::io::Result<()> + Send + Sync>;

/// The k10s engine. Cheap to clone; all methods are safe to call concurrently.
#[derive(Clone)]
pub struct Engine {
    inner: Arc<Inner>,
}

impl Engine {
    /// Creates the engine and starts background work (login-shell env import, idle-feed reaper).
    pub fn new(rt: Handle) -> Self {
        Self::start(Inner::new(rt, Box::new(|timeout| env::load(timeout).boxed())))
    }

    fn start(inner: Arc<Inner>) -> Self {
        let rt = inner.rt.clone();
        let weak = Arc::downgrade(&inner);
        inner.hub.on_unauthorized(move |context| {
            if let Some(inner) = weak.upgrade() {
                let context = context.to_string();
                inner.rt.clone().spawn(async move {
                    inner.reauthenticate(&context).await;
                });
            }
        });

        let warm = inner.clone();
        rt.spawn(async move {
            // Warm up: env import + kubeconfig parse happen while the UI boots.
            let _ = warm.kubeconfig().await;
        });
        let weak = Arc::downgrade(&inner);
        rt.spawn(async move {
            let mut tick = tokio::time::interval(Duration::from_secs(15));
            loop {
                tick.tick().await;
                let Some(inner) = weak.upgrade() else { return };
                let reaped = inner.hub.reap();
                if reaped > 0 {
                    tracing::debug!(reaped, "stopped idle feeds");
                }
                let polls = inner.metrics.reap();
                if polls > 0 {
                    tracing::debug!(polls, "stopped idle metrics polls");
                }
                // By the wall clock: after the computer slept, the first tick sees what expired meanwhile.
                inner.renew_expiring(SystemTime::now());
            }
        });
        Self { inner }
    }

    pub fn on_event(&self, f: impl Fn(EngineEvent) + Send + Sync + 'static) {
        *self.inner.events.write() = Some(Arc::new(f));
    }

    /// Starts from the settings saved before and hands every later change to `save`. Whoever reads them decides
    /// what a file it can't read means: read-only mode, so that the switch it may have held does not silently fall
    /// back to read-write.
    pub fn use_settings(&self, settings: Settings, save: SaveSettings) {
        let mut slot = self.inner.settings_save.lock();
        tracing::info!(read_only = settings.read_only, "settings loaded");
        *slot = Some(save);
        self.apply_settings(&settings);
    }

    pub fn settings(&self) -> Settings {
        self.inner.settings.read().clone()
    }

    /// Replaces the settings, except that read-only mode can only be turned on this way: turning it off
    /// takes [`Engine::set_read_only`]. Returns the settings in effect.
    pub fn set_settings(&self, mut settings: Settings) -> Settings {
        let save = self.inner.settings_save.lock();
        settings.read_only |= self.inner.settings.read().read_only;
        self.store_settings(save, settings)
    }

    /// Turns read-only mode on or off. Turning it off must be the user's own decision: the caller asks
    /// them first (the desktop app with a native dialog, which nothing in the web view can answer).
    pub fn set_read_only(&self, on: bool) -> Settings {
        let save = self.inner.settings_save.lock();
        let settings = Settings { read_only: on, ..self.settings() };
        self.store_settings(save, settings)
    }

    /// Settings changed outside the app — its settings file, edited by hand: taken as they are, read-only mode
    /// included (that edit is the user's own), and not saved again. Returns the settings in effect.
    pub fn adopt_settings(&self, settings: Settings) -> Settings {
        let _save = self.inner.settings_save.lock();
        let before = self.settings();
        if before != settings {
            self.apply_settings(&settings);
            if before.read_only != settings.read_only {
                tracing::info!(target: "k10s::audit", action = "read-only mode", params = if settings.read_only { "on" } else { "off" }, result = "ok", reason = "settings file edited", "settings");
            }
        }
        settings
    }

    fn store_settings(&self, save: parking_lot::MutexGuard<'_, Option<SaveSettings>>, settings: Settings) -> Settings {
        let before = self.settings();
        if before == settings {
            return settings;
        }
        self.apply_settings(&settings);
        if before.read_only != settings.read_only {
            tracing::info!(target: "k10s::audit", action = "read-only mode", params = if settings.read_only { "on" } else { "off" }, result = "ok", "settings");
        }
        if let Some(save) = save.as_ref()
            && let Err(e) = save(&settings)
        {
            // Still in effect until the app quits.
            tracing::warn!(error = %e, "the settings could not be saved");
        }
        settings
    }

    fn apply_settings(&self, settings: &Settings) {
        self.inner.hub.set_idle_ttl(Duration::from_secs(settings.feed_idle_ttl_secs));
        *self.inner.settings.write() = settings.clone();
    }

    /// Contexts of the kubeconfig, re-read if it changed. Also retries a failed login-shell environment
    /// import (which decides which kubeconfig files are used).
    pub async fn contexts(&self) -> Result<ContextList> {
        Ok(self.inner.load_kubeconfig(true).await?.list())
    }

    pub async fn connect(&self, context: &str) -> Result<ClusterInfo> {
        Ok(self.inner.connect(context, false).await?.info())
    }

    /// Reconnects from scratch: fresh credentials and discovery; open views, watches and log streams
    /// continue on the new connection.
    pub async fn reconnect(&self, context: &str) -> Result<ClusterInfo> {
        Ok(self.inner.connect(context, true).await?.info())
    }

    pub async fn refresh_discovery(&self, context: &str) -> Result<ClusterInfo> {
        let cluster = self.inner.connect(context, false).await?;
        cluster.refresh_discovery().await?;
        // Views that could not resolve their resource on this cluster (a new CRD?) try again.
        self.inner.clusters.touch(context);
        Ok(cluster.info())
    }

    pub fn disconnect(&self, context: &str) {
        self.inner.hub.drop_cluster(context);
        self.inner.unreachable.lock().remove(context);
        if self.inner.clusters.remove(context) {
            self.inner.emit(EngineEvent::Cluster { context: context.into(), state: ClusterState::Disconnected, message: None, version: None });
        }
    }

    /// After the computer slept or the network changed: watches may be silently dead or stale, so
    /// every active one starts over with a fresh list (idle ones are dropped), log streams reconnect
    /// (continuing after their last line), and clusters that could not be reached are tried again right away.
    pub fn resync(&self) {
        let restarted = self.inner.hub.resync();
        self.inner.clusters.nudge();
        tracing::info!(restarted, "resync: watches restarted, failed clusters retried");
    }

    /// Streams a multi-cluster table to `sink` until [`Engine::cancel`] is called. Returns its id.
    pub fn subscribe_view(&self, spec: ViewSpec, sink: Sink) -> u64 {
        let what = spec.describe();
        let id = self.inner.track(view::run(self.inner.clone(), spec, sink));
        tracing::debug!(id, view = %what, "view started");
        id
    }

    /// Streams logs of all targets to `sink` until cancelled. Returns its id.
    pub fn stream_logs(&self, spec: LogSpec, sink: Sink) -> u64 {
        let targets = spec.targets.len();
        let (control, updates) = tokio::sync::mpsc::unbounded_channel();
        let id = self.inner.track(logs::run(self.inner.clone(), spec, sink, updates));
        let mut controls = self.inner.log_targets.lock();
        controls.retain(|_, c| !c.is_closed());
        controls.insert(id, control);
        drop(controls);
        tracing::debug!(id, targets, "log stream started");
        id
    }

    /// Replaces the targets of log stream `id` (targets are told apart by their ids): new ones start,
    /// those not listed stop, the others stream on undisturbed — a workload's pods come and go.
    pub fn update_log_targets(&self, id: u64, targets: Vec<LogTarget>) -> Result<()> {
        let mut controls = self.inner.log_targets.lock();
        match controls.get(&id) {
            Some(control) if control.send(targets).is_ok() => Ok(()),
            _ => {
                controls.remove(&id);
                Err(Error::other(format!("log stream {id} is not running")))
            }
        }
    }

    /// Opens a terminal in a running container — a shell, or its own console with `attach` — and streams it
    /// to `sink` until its process ends or [`Engine::cancel`] is called. Returns its id: keystrokes, resizes and
    /// acknowledgements of what the UI drew go to it (see [`Engine::terminal_input`]).
    pub fn start_terminal(&self, spec: TermSpec, sink: Sink) -> u64 {
        let what = format!("{} {}/{}/{}", if spec.attach { "attach" } else { "shell" }, spec.namespace, spec.pod, spec.container);
        self.start_session(what, sink, |inner, sink, control| term::run(inner, spec, sink, control))
    }

    /// Adds a debug container to a pod and opens a terminal in it once it runs (see [`Engine::start_terminal`]).
    pub fn start_debug(&self, spec: DebugSpec, sink: Sink) -> u64 {
        let what = format!("debug {}/{} ({})", spec.namespace, spec.pod, spec.image);
        self.start_session(what, sink, |inner, sink, control| term::run_debug(inner, spec, sink, control))
    }

    /// Opens a shell on a node through a helper pod, deleted when the session ends (see [`Engine::start_terminal`]).
    pub fn start_node_shell(&self, spec: NodeShellSpec, sink: Sink) -> u64 {
        let what = format!("node shell {} ({})", spec.node, spec.image);
        self.start_session(what, sink, |inner, sink, control| term::run_node_shell(inner, spec, sink, control))
    }

    fn start_session<F: Future<Output = ()> + Send + 'static>(
        &self,
        what: String,
        sink: Sink,
        run: impl FnOnce(Arc<Inner>, Sink, tokio::sync::mpsc::UnboundedReceiver<term::Control>) -> F,
    ) -> u64 {
        let (control, updates) = tokio::sync::mpsc::unbounded_channel();
        let id = self.inner.track(run(self.inner.clone(), sink, updates));
        let mut controls = self.inner.terms.lock();
        controls.retain(|_, c| !c.is_closed());
        controls.insert(id, control);
        drop(controls);
        tracing::debug!(id, terminal = %what, "terminal started");
        id
    }

    /// Keystrokes (or pasted text) for terminal `id`.
    pub fn terminal_input(&self, id: u64, data: Vec<u8>) -> Result<()> {
        self.terminal_control(id, term::Control::Input(data))
    }

    pub fn terminal_resize(&self, id: u64, size: TermSize) -> Result<()> {
        self.terminal_control(id, term::Control::Resize(size))
    }

    /// The UI's terminal drew `bytes` more of the output: reading goes on once it caught up (see `term.rs`).
    pub fn terminal_ack(&self, id: u64, bytes: usize) -> Result<()> {
        self.terminal_control(id, term::Control::Ack(bytes))
    }

    fn terminal_control(&self, id: u64, c: term::Control) -> Result<()> {
        let mut controls = self.inner.terms.lock();
        match controls.get(&id) {
            Some(control) if control.send(c).is_ok() => Ok(()),
            _ => {
                controls.remove(&id);
                Err(Error::other(format!("terminal {id} is not open")))
            }
        }
    }

    /// Streams the graph of what relates to one object — its owners and what it owns, the services and ingresses in
    /// front of it, what it uses and what uses it — again whenever that changes, until cancelled.
    pub fn subscribe_relations(&self, spec: RelationsSpec, sink: Sink) -> u64 {
        let what = format!("relations of {} {}/{}", spec.resource, spec.namespace.as_deref().unwrap_or("-"), spec.name);
        let id = self.inner.track(relations::run(self.inner.clone(), spec, sink));
        tracing::debug!(id, %what, "relations started");
        id
    }

    /// Streams the Helm releases of `spec`'s clusters and namespaces as a table (like [`Engine::subscribe_view`]).
    pub fn subscribe_helm(&self, spec: ViewSpec, sink: Sink) -> u64 {
        self.inner.track(helm::run(self.inner.clone(), spec, sink))
    }

    /// A Helm release in full: values, manifest, notes and its history.
    pub async fn helm_release(&self, cluster: &str, namespace: &str, name: &str) -> Result<helm::Release> {
        helm::release(&self.inner, cluster, namespace, name).await
    }

    /// What changed between two revisions of a Helm release.
    pub async fn helm_diff(&self, cluster: &str, namespace: &str, name: &str, from: i64, to: i64) -> Result<helm::Diff> {
        helm::diff(&self.inner, cluster, namespace, name, from, to).await
    }

    /// `helm rollback` (the user's helm; refused in read-only mode). Its output.
    pub async fn helm_rollback(&self, cluster: &str, namespace: &str, name: &str, revision: i64) -> Result<String> {
        helm::rollback(&self.inner, cluster, namespace, name, revision).await
    }

    /// `helm uninstall` of each target, a few at a time per cluster. Results in `targets` order.
    pub async fn helm_uninstall(&self, targets: Vec<ObjectRef>) -> Result<Vec<OpResult>> {
        self.inner.guard_write()?;
        let runs = targets.into_iter().map(|t| {
            let inner = self.inner.clone();
            async move {
                let res = helm::uninstall(&inner, &t.cluster, t.namespace.as_deref().unwrap_or("default"), &t.name).await.map(drop);
                OpResult { target: t, ok: res.is_ok(), error: res.err() }
            }
        });
        Ok(futures::stream::iter(runs).buffered(4).collect().await)
    }

    /// Streams the CPU and memory usage of pods or nodes (from the metrics API, polled) until cancelled.
    pub fn subscribe_metrics(&self, spec: MetricsSpec, sink: Sink) -> u64 {
        self.inner.track(metrics::run(self.inner.clone(), spec, sink))
    }

    /// The usage of one pod or node over the last minutes, while a view polls it (none otherwise).
    pub fn metrics_history(&self, cluster: &str, kind: metrics::Kind, namespace: Option<&str>, name: &str) -> Option<metrics::History> {
        self.inner.metrics.history(cluster, kind, namespace, name)
    }

    /// Starts forwarding a local port to a pod (named, or picked behind a service or workload). Checks first that
    /// it can work — the local port free, the permission granted, a pod to forward to — and says why not.
    pub async fn start_forward(&self, spec: ForwardSpec) -> Result<ForwardInfo> {
        pf::start(&self.inner, spec).await
    }

    /// Stops a port-forward; whether there was one.
    pub fn stop_forward(&self, id: u64) -> bool {
        self.inner.forwards.stop(id)
    }

    pub fn forwards(&self) -> Vec<ForwardInfo> {
        self.inner.forwards.list()
    }

    /// Streams the list of port-forwards to `sink` (on every change, and while they carry traffic) until cancelled.
    pub fn subscribe_forwards(&self, sink: Sink) -> u64 {
        self.inner.track(pf::watch_list(self.inner.clone(), sink))
    }

    /// The local URL of port-forward `id` (`http://localhost:PORT/`).
    pub fn forward_url(&self, id: u64) -> Option<String> {
        self.inner.forwards.url(id)
    }

    /// Whether the user may do each of `checks` in `cluster` (in their order; unknown where the cluster could not say).
    pub async fn access_review(&self, cluster: &str, checks: Vec<AccessCheck>) -> Result<Vec<AccessDecision>> {
        access::review(&self.inner, cluster, checks).await
    }

    /// What the user may do in `namespace` of `cluster`, as its API server lists it.
    pub async fn access_rules(&self, cluster: &str, namespace: &str) -> Result<access::Rules> {
        access::rules(&self.inner, cluster, namespace).await
    }

    pub fn cancel(&self, id: u64) {
        self.inner.log_targets.lock().remove(&id);
        self.inner.terms.lock().remove(&id);
        if let Some(h) = self.inner.tasks.lock().remove(&id) {
            h.abort();
            tracing::debug!(id, "stream stopped");
        }
    }

    /// Cancels every view, log stream and terminal (e.g. when the UI reloads).
    pub fn cancel_all(&self) {
        self.inner.log_targets.lock().clear();
        self.inner.terms.lock().clear();
        let mut tasks = self.inner.tasks.lock();
        let n = tasks.len();
        for (_, h) in tasks.drain() {
            h.abort();
        }
        if n > 0 {
            tracing::debug!(n, "all streams stopped");
        }
    }

    /// Reads are retried once after rejected credentials were renewed (see [`Engine::renewed`]).
    pub async fn get_object(&self, r: &ObjectRef) -> Result<Arc<str>> {
        match ops::get_object(&self.inner, r).await {
            Err(e) if needs_reauth(&e) && self.renewed(&r.cluster).await => ops::get_object(&self.inner, r).await,
            res => res,
        }
    }

    /// The object as YAML; a Secret's values are hidden unless `reveal`.
    pub async fn get_yaml(&self, r: &ObjectRef, managed_fields: bool, reveal: bool) -> Result<String> {
        match ops::get_yaml(&self.inner, r, managed_fields, reveal).await {
            Err(e) if needs_reauth(&e) && self.renewed(&r.cluster).await => ops::get_yaml(&self.inner, r, managed_fields, reveal).await,
            res => res,
        }
    }

    /// Renews the rejected credentials of `context` for a read, waiting at most [`ops::CONNECT_TIMEOUT`] like
    /// any wait for a connection: a plugin waiting for a login goes on in the background (open views pick up
    /// the new connection by themselves), and the read fails with its 401 meanwhile.
    async fn renewed(&self, context: &str) -> bool {
        tokio::time::timeout(ops::CONNECT_TIMEOUT, self.inner.reauthenticate(context)).await.unwrap_or(false)
    }

    // Mutations are not retried automatically: the user sees the error, and the next attempt has
    // fresh credentials.

    pub async fn delete(&self, targets: Vec<ObjectRef>, force: bool) -> Result<Vec<OpResult>> {
        let results = ops::delete(&self.inner, targets, force).await?;
        for r in &results {
            if let Some(e) = &r.error {
                self.inner.reauthenticate_on(&r.target.cluster, e);
            }
        }
        Ok(results)
    }

    pub async fn scale(&self, r: &ObjectRef, replicas: i32) -> Result<()> {
        self.after(r, ops::scale(&self.inner, r, replicas).await)
    }

    pub async fn restart(&self, r: &ObjectRef) -> Result<()> {
        self.after(r, ops::restart(&self.inner, r).await)
    }

    pub async fn set_unschedulable(&self, r: &ObjectRef, unschedulable: bool) -> Result<()> {
        self.after(r, ops::set_unschedulable(&self.inner, r, unschedulable).await)
    }

    pub async fn set_suspend(&self, r: &ObjectRef, suspend: bool) -> Result<()> {
        self.after(r, ops::set_suspend(&self.inner, r, suspend).await)
    }

    pub async fn trigger_cronjob(&self, r: &ObjectRef) -> Result<String> {
        self.after(r, ops::trigger_cronjob(&self.inner, r).await)
    }

    fn after<T>(&self, r: &ObjectRef, res: Result<T>) -> Result<T> {
        if let Err(e) = &res {
            self.inner.reauthenticate_on(&r.cluster, e);
        }
        res
    }

    pub fn stats(&self) -> HubStats {
        self.inner.hub.stats()
    }

    pub fn connected_clusters(&self) -> Vec<String> {
        self.inner.clusters.connected().iter().map(|c| c.context.to_string()).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::{self, Reply, Server};
    use std::sync::atomic::AtomicUsize;

    /// An engine core whose login-shell import is scripted: `results[n]` is what the n-th import returns.
    fn inner_with_env(results: Vec<ShellEnv>, calls: Arc<AtomicUsize>) -> Arc<Inner> {
        let results = Arc::new(results);
        Inner::new(
            Handle::current(),
            Box::new(move |_timeout| {
                let n = calls.fetch_add(1, Ordering::SeqCst);
                let env = results[n.min(results.len() - 1)].clone();
                async move { env }.boxed()
            }),
        )
    }

    #[tokio::test(start_paused = true)]
    async fn a_failed_env_import_is_retried_later_not_kept_until_restart() {
        let calls = Arc::new(AtomicUsize::new(0));
        let ok = ShellEnv::for_tests(&[("KUBECONFIG", "/nonexistent/k10s-test-config")], false);
        let inner = inner_with_env(vec![ShellEnv::for_tests(&[], true), ok.clone()], calls.clone());
        let events = Arc::new(Mutex::new(Vec::new()));
        let e = events.clone();
        *inner.events.write() = Some(Arc::new(move |ev: EngineEvent| e.lock().push(serde_json::to_string(&ev).unwrap())));

        let (env, first) = inner.shell_env(false).await;
        assert!(env.import_failed());
        // Rate-limited: connects right after a failure do not run the shell again…
        inner.shell_env(false).await;
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        // …an explicit kubeconfig reload retries sooner, a connect after a minute.
        tokio::time::advance(ENV_RELOAD_RETRY_AFTER).await;
        inner.shell_env(false).await;
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        let (env, second) = inner.shell_env(true).await;
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        assert_eq!(*env, ok);
        assert_ne!(first, second, "the kubeconfig is re-read with the new environment");
        assert_eq!(*events.lock(), [r#"{"type":"contexts"}"#]);

        // A successful import is kept.
        tokio::time::advance(ENV_RETRY_AFTER * 2).await;
        inner.shell_env(true).await;
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }

    #[tokio::test(start_paused = true)]
    async fn a_failed_import_retried_with_the_same_outcome_changes_nothing() {
        let calls = Arc::new(AtomicUsize::new(0));
        let inner = inner_with_env(vec![ShellEnv::for_tests(&[], true)], calls.clone());
        let (_, first) = inner.shell_env(false).await;
        tokio::time::advance(ENV_RETRY_AFTER).await;
        let (_, second) = inner.shell_env(false).await;
        assert_eq!((calls.load(Ordering::SeqCst), first), (2, second));
    }

    fn offline() -> Client {
        Client::new(tower::service_fn(|_req: http::Request<kube::client::Body>| async { Err::<http::Response<kube::client::Body>, _>("offline") }), "default")
    }

    #[tokio::test]
    async fn rejected_credentials_reconnect_at_most_once_per_cooldown() {
        let inner = Inner::for_tests();
        // Not connected: nothing to renew.
        assert!(!inner.reauthenticate("prod-eu-z1").await);
        assert!(inner.reauth.lock().is_empty());

        inner.clusters.insert_ready_for_tests(Cluster::for_tests("prod-eu-z1", offline(), Vec::new()));
        // The reconnect itself fails here (the context is not in the kubeconfig), but it was attempted…
        assert!(!inner.reauthenticate("prod-eu-z1").await);
        assert!(inner.reauth.lock().contains_key("prod-eu-z1"));
        assert!(matches!(inner.clusters.state("prod-eu-z1"), Some((_, ConnState::Failed(_)))));
        // …and is not repeated within the cooldown, even once the cluster is back.
        inner.clusters.insert_ready_for_tests(Cluster::for_tests("prod-eu-z1", offline(), Vec::new()));
        assert!(!inner.reauthenticate("prod-eu-z1").await);
        assert!(matches!(inner.clusters.state("prod-eu-z1"), Some((_, ConnState::Ready))));
    }

    /// Every connect of `prod-eu-z1` hands out a new connection to `server`; the first one's credentials
    /// are rejected (401), later ones are accepted. Returns how many connects there were.
    fn connect_with_rejected_then_fresh_credentials(inner: &Inner, server: Arc<Server>) -> Arc<AtomicUsize> {
        let connects = Arc::new(AtomicUsize::new(0));
        let n = connects.clone();
        inner.fake_connect_for_tests(move |context, endpoint| {
            let rejected = n.fetch_add(1, Ordering::SeqCst) == 0;
            let raw = testing::fake(server.clone(), move |_| if rejected { Reply::Status(401) } else { Reply::Pods });
            Ok((Cluster::for_tests(context, endpoint.client("default".into()), vec![testing::pods()]), raw))
        });
        connects
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

    #[tokio::test]
    async fn a_rejected_watch_reconnects_once_and_its_view_resumes_with_the_new_credentials() {
        let inner = Inner::for_tests();
        let engine = Engine::start(inner.clone());
        let server = Arc::new(Server::default());
        let connects = connect_with_rejected_then_fresh_credentials(&inner, server.clone());
        let out = Arc::new(Mutex::new(Vec::<String>::new()));
        let o = out.clone();
        let spec = ViewSpec {
            resource: "pods".into(),
            clusters: vec!["prod-eu-z1".into()],
            namespaces: vec![],
            label_selector: None,
            field_selector: None,
            projection: Default::default(),
        };
        engine.subscribe_view(
            spec,
            Arc::new(move |msg: String| {
                o.lock().push(msg);
                true
            }),
        );
        // The list is rejected (401): the engine reconnects (the exec plugin would run again), the stopped
        // watch starts over on the new connection and the view gets its rows.
        until("the rows", || out.lock().iter().any(|m| m.contains(r#""n":"pod-1""#))).await;
        until("ready", || out.lock().last().is_some_and(|m| m.contains(r#""state":"ready""#))).await;
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert_eq!(connects.load(Ordering::SeqCst), 2);
        assert_eq!(server.lists.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn reads_rejected_for_their_credentials_are_retried_once_after_a_reconnect() {
        let inner = Inner::for_tests();
        let engine = Engine::start(inner.clone());
        let server = Arc::new(Server::default());
        let connects = connect_with_rejected_then_fresh_credentials(&inner, server.clone());
        let r = ObjectRef { cluster: "prod-eu-z1".into(), resource: "pods".into(), namespace: Some("default".into()), name: "pod-1".into(), uid: None };
        engine.get_object(&r).await.unwrap();
        assert_eq!((connects.load(Ordering::SeqCst), server.lists.load(Ordering::SeqCst)), (2, 2));
        // Within the cooldown a second rejection is not retried: the error reaches the caller.
        *inner.fake_connect.lock() = None;
        inner.clusters.insert_ready_for_tests(Cluster::for_tests("prod-eu-z1", testing::fake(server.clone(), |_| Reply::Status(401)), vec![testing::pods()]));
        let err = engine.get_yaml(&r, false, false).await.unwrap_err();
        assert_eq!(err.code(), Some(401));
        assert_eq!(server.lists.load(Ordering::SeqCst), 3);
    }

    #[tokio::test(start_paused = true)]
    async fn a_read_waits_for_renewed_credentials_no_longer_than_for_a_connection() {
        let inner = Inner::for_tests();
        let engine = Engine::start(inner.clone());
        let server = Arc::new(Server::default());
        inner.clusters.insert_ready_for_tests(Cluster::for_tests("prod-eu-z1", testing::fake(server.clone(), |_| Reply::Status(401)), vec![testing::pods()]));
        // Fresh credentials wait for a login that does not come.
        *inner.fake_connect.lock() = Some(Arc::new(|_: &str, _: &Arc<cluster::Endpoint>| futures::future::pending().boxed()));
        let r = ObjectRef { cluster: "prod-eu-z1".into(), resource: "pods".into(), namespace: Some("default".into()), name: "pod-1".into(), uid: None };
        let started = tokio::time::Instant::now();
        let err = engine.get_yaml(&r, false, false).await.unwrap_err();
        assert_eq!(err.code(), Some(401));
        assert!((ops::CONNECT_TIMEOUT..ops::CONNECT_TIMEOUT + Duration::from_secs(1)).contains(&started.elapsed()), "{:?}", started.elapsed());
        // The reconnect itself goes on.
        assert!(matches!(inner.clusters.state("prod-eu-z1"), Some((_, ConnState::Connecting))));
        assert_eq!(server.lists.load(Ordering::SeqCst), 1, "not read again");
    }

    #[tokio::test]
    async fn expiring_credentials_are_renewed_ahead_of_time_without_a_reconnect() {
        let dir = std::env::temp_dir().join(format!("k10s-renew-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let runs = dir.join("runs");
        let script = format!(
            r#"echo run >> '{}'; printf '%s' '{{"apiVersion":"client.authentication.k8s.io/v1","kind":"ExecCredential","status":{{"token":"renewed","expirationTimestamp":"2099-01-01T00:00:00Z"}}}}'"#,
            runs.display()
        );
        let yaml = format!(
            r#"
apiVersion: v1
kind: Config
clusters: [{{name: c, cluster: {{server: "https://127.0.0.1:1"}}}}]
users: [{{name: u, user: {{exec: {{apiVersion: client.authentication.k8s.io/v1, command: sh, args: ["-c", {script:?}], interactiveMode: Never}}}}}}]
contexts: [{{name: prod-eu-z1, context: {{cluster: c, user: u}}}}, {{name: prod-eu-z2, context: {{cluster: c, user: u}}}}]
"#
        );
        let inner = Inner::for_tests();
        *inner.kubeconfig.lock() = Some((Arc::new(KubeconfigStore::from_yaml(&yaml)), 1));
        inner.clusters.insert_ready_for_tests(Cluster::for_tests("prod-eu-z1", offline(), Vec::new()));
        let (generation, _) = inner.clusters.state("prod-eu-z1").unwrap();
        let now = SystemTime::now();
        let endpoint = inner.clusters.endpoint("prod-eu-z1");
        endpoint.set(Session { client: offline(), expires: Some(now + Duration::from_secs(60)) });
        // Not connected: nothing to renew there (it renews when it connects).
        inner.clusters.endpoint("prod-eu-z2").set(Session { client: offline(), expires: Some(now + Duration::from_secs(60)) });

        inner.renew_expiring(now + Duration::from_secs(10));
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert!(!runs.exists(), "not due yet");

        inner.renew_expiring(now + Duration::from_secs(45));
        let renewed = SystemTime::from(jiff::Timestamp::from_second(4_070_908_800).unwrap());
        until("the renewal", || endpoint.expires() == Some(renewed)).await;
        // One plugin run, for the connected cluster only; the cluster was not reconnected.
        assert_eq!(std::fs::read_to_string(&runs).unwrap(), "run\n");
        assert!(matches!(inner.clusters.state("prod-eu-z1"), Some((g, ConnState::Ready)) if g == generation));
        // Renewed until 2099: not due again any time soon.
        inner.renew_expiring(now + Duration::from_secs(3600));
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert_eq!(std::fs::read_to_string(&runs).unwrap(), "run\n");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn log_targets_can_be_changed_until_the_stream_is_cancelled() {
        let engine = Engine::start(Inner::for_tests());
        let spec = LogSpec { targets: Vec::new(), follow: true, tail_lines: None, since_seconds: None, previous: false, label: None };
        let id = engine.stream_logs(spec, Arc::new(|_: String| true));
        engine.update_log_targets(id, Vec::new()).unwrap();
        engine.cancel(id);
        assert!(engine.update_log_targets(id, Vec::new()).is_err());
        assert!(engine.update_log_targets(id + 1, Vec::new()).is_err());
        assert!(engine.inner.log_targets.lock().is_empty());
    }

    /// A place to save settings that keeps every version handed to it.
    fn saved_settings() -> (Arc<Mutex<Vec<Settings>>>, SaveSettings) {
        let saved = Arc::new(Mutex::new(Vec::new()));
        let into = saved.clone();
        (
            saved,
            Box::new(move |s: &Settings| {
                into.lock().push(s.clone());
                Ok(())
            }),
        )
    }

    #[tokio::test]
    async fn settings_are_saved_and_read_only_mode_is_turned_off_only_explicitly() {
        let engine = Engine::start(Inner::for_tests());
        let (saved, save) = saved_settings();
        engine.use_settings(Settings::default(), save);
        assert!(engine.inner.guard_write().is_ok());

        // Turning it on is free, and saved.
        let on = engine.set_settings(Settings { read_only: true, feed_idle_ttl_secs: 60 });
        assert!(on.read_only);
        assert!(matches!(engine.inner.guard_write(), Err(Error::ReadOnly)));
        assert_eq!(saved.lock().last(), Some(&on));

        // `set_settings` (what the web view sends) cannot turn it off; other settings still change.
        let still = engine.set_settings(Settings { read_only: false, feed_idle_ttl_secs: 90 });
        assert_eq!(still, Settings { read_only: true, feed_idle_ttl_secs: 90 });
        assert!(engine.settings().read_only);

        // Only the explicit switch does.
        assert!(!engine.set_read_only(false).read_only);
        assert!(engine.inner.guard_write().is_ok());
        assert_eq!(saved.lock().len(), 3);
        // No change, nothing to save.
        engine.set_read_only(false);
        assert_eq!(saved.lock().len(), 3);
    }

    #[tokio::test]
    async fn settings_edited_outside_the_app_are_taken_as_they_are_and_not_saved_again() {
        let engine = Engine::start(Inner::for_tests());
        let (saved, save) = saved_settings();
        engine.use_settings(Settings { read_only: true, ..Settings::default() }, save);
        assert!(matches!(engine.inner.guard_write(), Err(Error::ReadOnly)));
        // The file says read-write: the user's own edit, no dialog.
        let adopted = engine.adopt_settings(Settings { read_only: false, feed_idle_ttl_secs: 30 });
        assert_eq!(engine.settings(), adopted);
        assert!(engine.inner.guard_write().is_ok());
        assert!(saved.lock().is_empty());
    }

    #[test]
    fn what_counts_as_rejected_credentials() {
        let api = |code: u16| Error::Kube(kube::Error::Api(Box::new(kube::core::Status { code, ..Default::default() })));
        assert!(needs_reauth(&api(401)));
        assert!(!needs_reauth(&api(403)) && !needs_reauth(&api(500)));
        assert!(needs_reauth(&Error::Kube(kube::Error::Service(Box::new(crate::error::tests::exec_failure())))));
        assert!(!needs_reauth(&Error::Connect { context: "c".into(), message: "Unauthorized".into(), code: Some(401) }));
    }
}
