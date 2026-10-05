//! Port-forwards: a local port (on 127.0.0.1, and ::1 when it can be had) forwarding to a port of a pod — named
//! directly, or picked among the ready pods of a service or workload, like `kubectl port-forward svc/…`.
//!
//! They belong to the engine, not to a page of the UI: they run until stopped (a reload of the UI finds them still
//! there). Each local connection opens a stream of its own through the cluster's endpoint, so a forward lives
//! through what breaks `kubectl port-forward`:
//! - credentials renewed or replaced (a reconnect) — the next connection uses the new ones, and one rejected for
//!   its credentials renews them and tries again;
//! - sleep and network changes — the listener stays, the next connection opens a new stream;
//! - a pod replaced (a rollout, an eviction) — a service's or workload's forward picks another ready pod when
//!   connecting to the one it used fails; a pod named directly is followed by name (a StatefulSet's is re-created
//!   under it).
//!
//! Starting one checks first what kubectl only finds out later: that the local port is free, that the user may
//! forward there (`create` on `pods/portforward`), and that there is a pod to forward to. Forwarding changes
//! nothing in the cluster: it works in read-only mode, like reading.

use std::io;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::task::{Context, Poll};
use std::time::Duration;

use k8s_openapi::api::authorization::v1::{ResourceAttributes, SelfSubjectAccessReview, SelfSubjectAccessReviewSpec};
use k8s_openapi::api::core::v1::Pod;
use kube::Api;
use kube::api::{ListParams, PostParams};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::watch;
use tokio::task::{AbortHandle, JoinSet};

use crate::cluster::{Cluster, is_auth_failure};
use crate::engine::Inner;
use crate::error::{Error, Result};
use crate::ops;
use crate::time;
use crate::view::Sink;

/// Opening a stream to the pod (the API server reaching the node's kubelet).
const OPEN_TIMEOUT: Duration = Duration::from_secs(30);
/// Local connections of one forward at once; more wait to be accepted.
const MAX_CONNECTIONS: usize = 256;
/// While a forward carries traffic, its subscribers hear about it this often (counters move).
const TRAFFIC_EVERY: Duration = Duration::from_secs(1);
/// Kinds whose pods are picked through their selector.
const WORKLOADS: [&str; 4] = ["deployments.apps", "statefulsets.apps", "daemonsets.apps", "replicasets.apps"];

/// What to forward to.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForwardSpec {
    pub cluster: String,
    pub namespace: String,
    /// `pods`, `services`, or a workload (`deployments.apps`, `statefulsets.apps`, `daemonsets.apps`, `replicasets.apps`).
    pub resource: String,
    pub name: String,
    /// The pod's port — or for a service, the service's port (its target port on the pod is looked up).
    pub port: u16,
    /// The local port; none: the same as `port` when that is free and not privileged, else one the system picks.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub local_port: Option<u16>,
}

/// A running forward, as the UI shows it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForwardInfo {
    pub id: u64,
    pub spec: ForwardSpec,
    /// Where it listens (127.0.0.1, and ::1 when it could be had).
    pub local_port: u16,
    /// The pod and port connections go to now (none yet, or after a failure until the next connection).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pod: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pod_port: Option<u16>,
    /// Local connections open now, and so far.
    pub connections: usize,
    pub total: u64,
    /// Bytes from local clients to the pod, and back.
    pub sent: u64,
    pub received: u64,
    /// Why the latest connection failed (cleared by one that worked).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// Unix seconds.
    pub started: i64,
}

/// One running forward.
pub(crate) struct Forward {
    id: u64,
    spec: ForwardSpec,
    local_port: u16,
    started: i64,
    /// Where connections go now; cleared when connecting there failed (the next connection looks again).
    target: Mutex<Option<(String, u16)>>,
    error: Mutex<Option<String>>,
    connections: AtomicUsize,
    total: AtomicU64,
    sent: Arc<AtomicU64>,
    received: Arc<AtomicU64>,
    task: Mutex<Option<AbortHandle>>,
    /// Tells subscribers that something changed (see [`Forwards::changed`]).
    changed: watch::Sender<u64>,
}

impl Forward {
    fn info(&self) -> ForwardInfo {
        let target = self.target.lock().clone();
        ForwardInfo {
            id: self.id,
            spec: self.spec.clone(),
            local_port: self.local_port,
            pod: target.as_ref().map(|(p, _)| p.clone()),
            pod_port: target.map(|(_, p)| p),
            connections: self.connections.load(Ordering::Relaxed),
            total: self.total.load(Ordering::Relaxed),
            sent: self.sent.load(Ordering::Relaxed),
            received: self.received.load(Ordering::Relaxed),
            error: self.error.lock().clone(),
            started: self.started,
        }
    }

    fn touch(&self) {
        self.changed.send_modify(|v| *v += 1);
    }

    fn opened(&self) {
        self.connections.fetch_add(1, Ordering::Relaxed);
        self.total.fetch_add(1, Ordering::Relaxed);
        self.touch();
    }

    fn closed(&self, res: Result<(), String>) {
        self.connections.fetch_sub(1, Ordering::Relaxed);
        match res {
            Ok(()) => *self.error.lock() = None,
            Err(why) => {
                tracing::debug!(id = self.id, name = %self.spec.name, port = self.spec.port, "port-forward connection failed: {why}");
                *self.error.lock() = Some(why);
            }
        }
        self.touch();
    }
}

/// The engine's forwards.
pub(crate) struct Forwards {
    list: Mutex<Vec<Arc<Forward>>>,
    next: AtomicU64,
    changed: watch::Sender<u64>,
}

impl Default for Forwards {
    fn default() -> Self {
        Forwards { list: Mutex::new(Vec::new()), next: AtomicU64::new(0), changed: watch::Sender::new(0) }
    }
}

impl Forwards {
    pub(crate) fn list(&self) -> Vec<ForwardInfo> {
        self.list.lock().iter().map(|f| f.info()).collect()
    }

    /// Stops forward `id` (its listener and connections); whether there was one.
    pub(crate) fn stop(&self, id: u64) -> bool {
        let gone = {
            let mut list = self.list.lock();
            let at = list.iter().position(|f| f.id == id);
            at.map(|i| list.remove(i))
        };
        let Some(f) = gone else { return false };
        if let Some(task) = f.task.lock().take() {
            task.abort();
        }
        tracing::info!(id, cluster = %f.spec.cluster, namespace = %f.spec.namespace, resource = %f.spec.resource, name = %f.spec.name, port = f.spec.port, local = f.local_port, "port-forward stopped");
        self.changed.send_modify(|v| *v += 1);
        true
    }

    /// The local URL of forward `id`.
    pub(crate) fn url(&self, id: u64) -> Option<String> {
        self.list.lock().iter().find(|f| f.id == id).map(|f| format!("http://localhost:{}/", f.local_port))
    }
}

/// Starts a forward: checks it can work (local port, permission, a pod to forward to), then listens.
pub(crate) async fn start(inner: &Arc<Inner>, mut spec: ForwardSpec) -> Result<ForwardInfo> {
    let cluster = ops::connected(inner, &spec.cluster, false).await?;
    allowed(&cluster, &spec.namespace).await?;
    let first = resolve(&cluster, &spec).await.map_err(Error::Other)?;
    let (listeners, local_port) = bind(spec.local_port, spec.port).await?;
    spec.local_port = Some(local_port);
    let forwards = &inner.forwards;
    let id = forwards.next.fetch_add(1, Ordering::Relaxed) + 1;
    let fwd = Arc::new(Forward {
        id,
        spec,
        local_port,
        started: time::now_unix(),
        target: Mutex::new(Some(first)),
        error: Mutex::new(None),
        connections: AtomicUsize::new(0),
        total: AtomicU64::new(0),
        sent: Arc::default(),
        received: Arc::default(),
        task: Mutex::new(None),
        changed: forwards.changed.clone(),
    });
    let task = inner.rt.spawn(serve(inner.clone(), fwd.clone(), listeners));
    *fwd.task.lock() = Some(task.abort_handle());
    let s = &fwd.spec;
    tracing::info!(id, cluster = %s.cluster, namespace = %s.namespace, resource = %s.resource, name = %s.name, port = s.port, local = local_port, "port-forward started");
    forwards.list.lock().push(fwd.clone());
    fwd.touch();
    Ok(fwd.info())
}

/// Streams every forward (the whole list) to `sink`: at once, on every change, and every [`TRAFFIC_EVERY`] while
/// one carries traffic. Ends when the sink is gone.
pub(crate) async fn watch_list(inner: Arc<Inner>, sink: Sink) {
    let mut changed = inner.forwards.changed.subscribe();
    loop {
        let list = inner.forwards.list();
        let busy = list.iter().any(|f| f.connections > 0);
        let json = serde_json::to_string(&serde_json::json!({ "t": "forwards", "list": list })).unwrap_or_default();
        if !sink(json) {
            return;
        }
        let tick = async { if busy { tokio::time::sleep(TRAFFIC_EVERY).await } else { std::future::pending().await } };
        tokio::select! {
            res = changed.changed() => if res.is_err() { return },
            _ = tick => {}
        }
        // Several changes at once (a burst of connections) make one message.
        tokio::time::sleep(Duration::from_millis(100)).await;
        changed.borrow_and_update();
    }
}

/// Binds the local port: `wanted`, else `remote` when it is not privileged, else one the system picks. On
/// 127.0.0.1, and on ::1 too when that port is free there.
async fn bind(wanted: Option<u16>, remote: u16) -> Result<(Vec<TcpListener>, u16)> {
    let (v4, port) = match wanted {
        Some(port) => (TcpListener::bind(("127.0.0.1", port)).await.map_err(|e| bind_error(port, &e))?, port),
        None => {
            let preferred = if remote >= 1024 { TcpListener::bind(("127.0.0.1", remote)).await.ok() } else { None };
            let l = match preferred {
                Some(l) => l,
                None => TcpListener::bind(("127.0.0.1", 0)).await.map_err(|e| bind_error(0, &e))?,
            };
            let port = l.local_addr().map_err(|e| Error::other(e.to_string()))?.port();
            (l, port)
        }
    };
    let mut listeners = vec![v4];
    // `localhost` may mean ::1 first: listen there too when possible (a browser falls back to 127.0.0.1 otherwise).
    if let Ok(v6) = TcpListener::bind(("::1", port)).await {
        listeners.push(v6);
    }
    Ok((listeners, port))
}

fn bind_error(port: u16, e: &io::Error) -> Error {
    match e.kind() {
        io::ErrorKind::AddrInUse => Error::other(format!("local port {port} is in use (another program, or another forward): pick another")),
        io::ErrorKind::PermissionDenied => Error::other(format!("local port {port} needs privileges: pick one above 1023")),
        _ => Error::other(format!("cannot listen on local port {port}: {e}")),
    }
}

/// Refuses a forward the user may not open (`create` on `pods/portforward`) — what the API server would refuse at
/// the first connection only. A review that cannot be asked for says nothing: the connection will tell.
async fn allowed(cluster: &Cluster, namespace: &str) -> Result<()> {
    let verb = crate::access::stream_verb(cluster.version.as_deref());
    let review = SelfSubjectAccessReview {
        spec: SelfSubjectAccessReviewSpec {
            resource_attributes: Some(ResourceAttributes {
                namespace: Some(namespace.to_string()),
                verb: Some(verb.into()),
                resource: Some("pods".into()),
                subresource: Some("portforward".into()),
                ..Default::default()
            }),
            ..Default::default()
        },
        ..Default::default()
    };
    let api: Api<SelfSubjectAccessReview> = Api::all(cluster.client.clone());
    match tokio::time::timeout(ops::READ_TIMEOUT, api.create(&PostParams::default(), &review)).await {
        Ok(Ok(r)) if r.status.as_ref().is_some_and(|s| !s.allowed) => {
            Err(Error::other(format!("no permission to port-forward in namespace \"{namespace}\": it takes {verb} on pods/portforward")))
        }
        _ => Ok(()),
    }
}

/// Where connections go: the pod and its port. A service's target port (a number, or a name looked up among the
/// pod's container ports) on one of the pods its selector picks; a workload's port on one of its pods.
async fn resolve(cluster: &Cluster, spec: &ForwardSpec) -> Result<(String, u16), String> {
    match spec.resource.as_str() {
        "pods" => Ok((spec.name.clone(), spec.port)),
        "services" => {
            let svc = get(cluster, "services", &spec.namespace, &spec.name).await?;
            let selector = svc.pointer("/spec/selector").and_then(Value::as_object).filter(|s| !s.is_empty()).ok_or_else(|| {
                format!("service \"{}\" selects no pods (its endpoints are kept by something else): forward to one of its pods instead", spec.name)
            })?;
            let selector = selector.iter().map(|(k, v)| format!("{k}={}", v.as_str().unwrap_or_default())).collect::<Vec<_>>().join(",");
            let port = svc
                .pointer("/spec/ports")
                .and_then(Value::as_array)
                .and_then(|ps| ps.iter().find(|p| p["port"].as_u64() == Some(spec.port as u64)))
                .ok_or_else(|| format!("service \"{}\" has no port {}", spec.name, spec.port))?;
            let pod = pick_pod(cluster, &spec.namespace, &selector, &format!("service \"{}\"", spec.name)).await?;
            let name = pod.pointer("/metadata/name").and_then(Value::as_str).unwrap_or_default().to_string();
            let target = match &port["targetPort"] {
                Value::Number(n) => {
                    n.as_u64().and_then(|n| u16::try_from(n).ok()).ok_or_else(|| format!("service \"{}\" has an invalid target port", spec.name))?
                }
                Value::String(named) => container_port(&pod, named)
                    .ok_or_else(|| format!("pod \"{name}\" has no port named \"{named}\" (the target port of service \"{}\")", spec.name))?,
                _ => spec.port,
            };
            Ok((name, target))
        }
        workload if WORKLOADS.contains(&workload) => {
            let obj = get(cluster, workload, &spec.namespace, &spec.name).await?;
            let selector =
                obj.pointer("/spec/selector").and_then(selector_string).ok_or_else(|| format!("{} \"{}\" has no pod selector", workload, spec.name))?;
            let pod = pick_pod(cluster, &spec.namespace, &selector, &format!("\"{}\"", spec.name)).await?;
            Ok((pod.pointer("/metadata/name").and_then(Value::as_str).unwrap_or_default().to_string(), spec.port))
        }
        other => Err(format!("cannot forward to {other}: forward to a pod, a service or a workload")),
    }
}

async fn get(cluster: &Cluster, resource: &str, namespace: &str, name: &str) -> Result<Value, String> {
    let info = cluster.resolve(resource).map_err(|e| e.message())?;
    match tokio::time::timeout(ops::READ_TIMEOUT, cluster.api(&info, Some(namespace)).get(name)).await {
        Ok(Ok(obj)) => Ok(obj.raw),
        Ok(Err(e)) => Err(Error::from(e).message()),
        Err(_) => Err(format!("no answer from the API server within {}s", ops::READ_TIMEOUT.as_secs())),
    }
}

/// A ready pod matching `selector`: running, Ready, not being deleted — the oldest such one (it stays put the
/// longest), as kubectl picks the first of its sorted list.
async fn pick_pod(cluster: &Cluster, namespace: &str, selector: &str, of: &str) -> Result<Value, String> {
    let api: Api<Pod> = Api::namespaced(cluster.client.clone(), namespace);
    let pods = match tokio::time::timeout(ops::READ_TIMEOUT, api.list(&ListParams::default().labels(selector))).await {
        Ok(Ok(list)) => list.items,
        Ok(Err(e)) => return Err(Error::from(e).message()),
        Err(_) => return Err(format!("no answer from the API server within {}s", ops::READ_TIMEOUT.as_secs())),
    };
    let total = pods.len();
    let ready = pods
        .into_iter()
        .filter_map(|p| serde_json::to_value(&p).ok())
        .filter(|p| p.pointer("/metadata/deletionTimestamp").is_none() && p.pointer("/status/phase").and_then(Value::as_str) == Some("Running") && is_ready(p))
        .min_by(|a, b| {
            let created = |p: &Value| p.pointer("/metadata/creationTimestamp").and_then(Value::as_str).unwrap_or_default().to_string();
            created(a).cmp(&created(b))
        });
    ready.ok_or_else(|| if total == 0 { format!("no pods behind {of}") } else { format!("no ready pod behind {of} ({total} not ready)") })
}

fn is_ready(pod: &Value) -> bool {
    pod.pointer("/status/conditions").and_then(Value::as_array).is_some_and(|cs| cs.iter().any(|c| c["type"] == "Ready" && c["status"] == "True"))
}

/// The number of a container port named `name`.
fn container_port(pod: &Value, name: &str) -> Option<u16> {
    pod.pointer("/spec/containers")?
        .as_array()?
        .iter()
        .flat_map(|c| c["ports"].as_array().into_iter().flatten())
        .find(|p| p["name"] == name)
        .and_then(|p| p["containerPort"].as_u64())
        .and_then(|n| u16::try_from(n).ok())
}

/// A label selector (`matchLabels` and `matchExpressions`) in the form `kubectl -l` and list requests take.
pub(crate) fn selector_string(selector: &Value) -> Option<String> {
    let mut terms: Vec<String> = selector
        .get("matchLabels")
        .and_then(Value::as_object)
        .map(|m| m.iter().map(|(k, v)| format!("{k}={}", v.as_str().unwrap_or_default())).collect())
        .unwrap_or_default();
    for e in selector.get("matchExpressions").and_then(Value::as_array).into_iter().flatten() {
        let key = e["key"].as_str()?;
        let values = || e["values"].as_array().map(|vs| vs.iter().filter_map(Value::as_str).collect::<Vec<_>>().join(",")).unwrap_or_default();
        terms.push(match e["operator"].as_str()? {
            "In" => format!("{key} in ({})", values()),
            "NotIn" => format!("{key} notin ({})", values()),
            "Exists" => key.to_string(),
            "DoesNotExist" => format!("!{key}"),
            _ => return None,
        });
    }
    (!terms.is_empty()).then(|| terms.join(","))
}

/// Accepts local connections until the forward is stopped (aborting this task drops its connections too).
async fn serve(inner: Arc<Inner>, fwd: Arc<Forward>, listeners: Vec<TcpListener>) {
    let mut conns = JoinSet::new();
    loop {
        let accept = futures::future::select_all(listeners.iter().map(|l| Box::pin(l.accept())));
        tokio::select! {
            (accepted, _, _) = accept, if conns.len() < MAX_CONNECTIONS => match accepted {
                Ok((stream, _)) => {
                    let _ = stream.set_nodelay(true);
                    conns.spawn(connection(inner.clone(), fwd.clone(), stream));
                }
                // Out of file descriptors and the like: try again shortly rather than spin.
                Err(e) => {
                    *fwd.error.lock() = Some(format!("cannot accept connections: {e}"));
                    fwd.touch();
                    tokio::time::sleep(Duration::from_millis(250)).await;
                }
            },
            Some(_) = conns.join_next() => {}
        }
    }
}

async fn connection(inner: Arc<Inner>, fwd: Arc<Forward>, tcp: TcpStream) {
    fwd.opened();
    let tcp = Counted { inner: tcp, read: fwd.sent.clone(), written: fwd.received.clone() };
    let res = forward_one(&inner, &fwd, tcp).await;
    fwd.closed(res);
}

/// Carries one local connection to the pod. A connection that could not reach where the forward went so far looks
/// again (another pod of a service or workload, or the same name re-created) and tries once more; credentials
/// rejected are renewed first.
async fn forward_one(inner: &Arc<Inner>, fwd: &Forward, mut tcp: Counted) -> Result<(), String> {
    let spec = &fwd.spec;
    let mut retried = false;
    loop {
        let cluster = ops::connected(inner, &spec.cluster, false).await.map_err(|e| e.message())?;
        let cached = fwd.target.lock().clone();
        let (pod, port) = match cached {
            Some(t) => t,
            None => {
                let t = resolve(&cluster, spec).await?;
                *fwd.target.lock() = Some(t.clone());
                fwd.touch();
                t
            }
        };
        let api: Api<Pod> = Api::namespaced(cluster.client.clone(), &spec.namespace);
        let opened = match tokio::time::timeout(OPEN_TIMEOUT, api.portforward(&pod, &[port])).await {
            Ok(res) => res.map_err(Error::from),
            Err(_) => Err(Error::other(format!("pod \"{pod}\" could not be reached within {}s", OPEN_TIMEOUT.as_secs()))),
        };
        let mut pf = match opened {
            Ok(pf) => pf,
            Err(err) => {
                let code = upgrade_code(&err);
                if retried {
                    return Err(open_failure(&err, code, &pod, &spec.namespace, crate::access::stream_verb(cluster.version.as_deref())));
                }
                retried = true;
                if code == Some(401) || matches!(&err, Error::Kube(e) if is_auth_failure(e)) {
                    inner.reauthenticate(&spec.cluster).await;
                } else if code == Some(403) {
                    return Err(open_failure(&err, code, &pod, &spec.namespace, crate::access::stream_verb(cluster.version.as_deref())));
                } else {
                    // The pod may be gone: look for where to go again.
                    *fwd.target.lock() = None;
                }
                continue;
            }
        };
        let (Some(mut upstream), Some(failure)) = (pf.take_stream(port), pf.take_error(port)) else {
            pf.abort();
            return Err("the stream has no port".into());
        };
        // Until either side closes — or the kubelet says forwarding failed (nothing listens on the port…).
        let res = tokio::select! {
            copied = tokio::io::copy_bidirectional(&mut tcp, &mut upstream) => copied.map(drop).map_err(|e| format!("connection broke: {e}")),
            Some(why) = failure => Err(simplify(&why, port)),
        };
        pf.abort();
        return res;
    }
}

/// The status code the API server answered the stream's opening with (kube keeps nothing else of it).
fn upgrade_code(err: &Error) -> Option<u16> {
    match err {
        Error::Kube(kube::Error::UpgradeConnection(kube::client::UpgradeConnectionError::ProtocolSwitch(code))) => Some(code.as_u16()),
        _ => err.code(),
    }
}

fn open_failure(err: &Error, code: Option<u16>, pod: &str, namespace: &str, verb: &str) -> String {
    match code {
        Some(401) => "credentials rejected: reconnect the cluster".into(),
        Some(403) => format!("no permission to port-forward in namespace \"{namespace}\": it takes {verb} on pods/portforward"),
        Some(404) => format!("pod \"{pod}\" not found"),
        Some(400) => format!("pod \"{pod}\" is not running"),
        Some(c @ 500..) => format!("the API server could not reach the node's kubelet (HTTP {c})"),
        _ => err.message(),
    }
}

/// The kubelet's `error forwarding port 5432 to pod 1f3c…, uid : failed to execute portforward in network namespace
/// "/var/run/netns/cni-…": failed to connect to localhost:5432 inside namespace "…", IPv4: dial tcp4 127.0.0.1:5432:
/// connect: connection refused IPv6 …` in a few words.
fn simplify(message: &str, port: u16) -> String {
    if message.contains("connection refused") {
        return format!("nothing listens on port {port} in the pod (connection refused)");
    }
    message.to_string()
}

/// A connection that counts the bytes read from it and written to it.
struct Counted {
    inner: TcpStream,
    read: Arc<AtomicU64>,
    written: Arc<AtomicU64>,
}

impl AsyncRead for Counted {
    fn poll_read(mut self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &mut ReadBuf<'_>) -> Poll<io::Result<()>> {
        let before = buf.filled().len();
        let res = Pin::new(&mut self.inner).poll_read(cx, buf);
        if res.is_ready() {
            self.read.fetch_add((buf.filled().len() - before) as u64, Ordering::Relaxed);
        }
        res
    }
}

impl AsyncWrite for Counted {
    fn poll_write(mut self: Pin<&mut Self>, cx: &mut Context<'_>, data: &[u8]) -> Poll<io::Result<usize>> {
        let res = Pin::new(&mut self.inner).poll_write(cx, data);
        if let Poll::Ready(Ok(n)) = res {
            self.written.fetch_add(n as u64, Ordering::Relaxed);
        }
        res
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.inner).poll_flush(cx)
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.inner).poll_shutdown(cx)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::collections::BTreeMap;

    fn labels(m: &[(&str, &str)]) -> BTreeMap<String, String> {
        m.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    #[test]
    fn selectors_read_like_kubectl_l() {
        assert_eq!(selector_string(&json!({ "matchLabels": labels(&[("app", "web"), ("tier", "fe")]) })).as_deref(), Some("app=web,tier=fe"));
        let expr = json!({
            "matchLabels": { "app": "web" },
            "matchExpressions": [
                { "key": "env", "operator": "In", "values": ["prod", "stage"] },
                { "key": "canary", "operator": "DoesNotExist" },
                { "key": "zone", "operator": "Exists" },
                { "key": "team", "operator": "NotIn", "values": ["x"] },
            ],
        });
        assert_eq!(selector_string(&expr).as_deref(), Some("app=web,env in (prod,stage),!canary,zone,team notin (x)"));
        assert_eq!(selector_string(&json!({})), None);
        assert_eq!(selector_string(&json!({ "matchExpressions": [{ "key": "a", "operator": "Weird" }] })), None);
    }

    #[test]
    fn named_target_ports_are_looked_up_among_the_containers() {
        let pod = json!({ "spec": { "containers": [{ "name": "app", "ports": [{ "name": "http", "containerPort": 8080 }] }, { "name": "metrics", "ports": [{ "name": "prom", "containerPort": 9090 }] }] } });
        assert_eq!(container_port(&pod, "http"), Some(8080));
        assert_eq!(container_port(&pod, "prom"), Some(9090));
        assert_eq!(container_port(&pod, "grpc"), None);
    }

    #[test]
    fn readiness_comes_from_the_ready_condition() {
        assert!(is_ready(&json!({ "status": { "conditions": [{ "type": "Ready", "status": "True" }] } })));
        assert!(!is_ready(&json!({ "status": { "conditions": [{ "type": "Ready", "status": "False" }] } })));
        assert!(!is_ready(&json!({ "status": {} })));
    }

    #[test]
    fn the_kubelets_refusal_says_what_matters() {
        let raw = r#"error forwarding port 5432 to pod 1f3c, uid : failed to execute portforward in network namespace "/var/run/netns/cni-1": failed to connect to localhost:5432 inside namespace "1f3c", IPv4: dial tcp4 127.0.0.1:5432: connect: connection refused IPv6 dial tcp6: address localhost: no suitable address"#;
        assert_eq!(simplify(raw, 5432), "nothing listens on port 5432 in the pod (connection refused)");
        assert_eq!(simplify("something else", 80), "something else");
    }

    #[tokio::test]
    async fn the_local_port_is_the_remote_one_when_free_else_any_and_a_taken_one_is_refused() {
        // A remote port above 1023 that is free locally is taken as is. Tests running alongside bind ports too and
        // may take the probed one before `bind` does: probe again then.
        let (ls, free) = 'probe: {
            for _ in 0..20 {
                let probe = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
                let free = probe.local_addr().unwrap().port();
                drop(probe);
                let (ls, port) = bind(None, free).await.unwrap();
                if port == free {
                    break 'probe (ls, free);
                }
            }
            panic!("a free remote port was never taken as is");
        };
        // Taken now: asking for it again fails with words; leaving it to the engine picks another.
        let err = bind(Some(free), 80).await.unwrap_err();
        assert!(err.message().contains(&format!("local port {free} is in use")), "{}", err.message());
        let (_, other) = bind(None, free).await.unwrap();
        assert_ne!(other, free);
        // Privileged remote ports are not tried locally.
        let (_, any) = bind(None, 80).await.unwrap();
        assert_ne!(any, 80);
        drop(ls);
    }
}
