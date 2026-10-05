//! Resource usage from the metrics API (`metrics.k8s.io`, served by metrics-server or prometheus-adapter): CPU and
//! memory of pods and nodes while a view shows them, with a short history per object for the details.
//!
//! The API cannot be watched: it is polled every [`INTERVAL`] (metrics-server's own resolution — asking more often
//! gets the same numbers). A poll is shared, one per cluster, kind and namespace however many views ask, and stays
//! warm for [`IDLE`] after the last one left: going back and forth keeps the history, which no other client keeps
//! (they show the number of the moment; charts need Prometheus). Under strict RBAC metrics are read where the
//! view looks (its namespaces); a refusal (403) or a cluster without the metrics API is said once and not asked
//! again until [`RECHECK`] passed.

use std::collections::{HashMap, VecDeque};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use kube::Api;
use kube::api::ListParams;
use kube::core::{ApiResource, DynamicObject};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::watch;
use tokio::task::AbortHandle;

use crate::engine::Inner;
use crate::error::Error;
use crate::ops;
use crate::render::util::parse_quantity;
use crate::time;
use crate::view::Sink;

/// How often usage is read.
const INTERVAL: Duration = Duration::from_secs(15);
/// A poll nobody looks at any more stops after this long.
const IDLE: Duration = Duration::from_secs(180);
/// Samples kept per object: ten minutes.
const HISTORY: usize = 40;
/// A cluster without the metrics API, or one that refused, is asked again after this long.
const RECHECK: Duration = Duration::from_secs(300);
/// One read of the metrics API.
const READ_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Pods,
    Nodes,
}

/// Usage of `kind` in these clusters and namespaces (empty: all; nodes have none).
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MetricsSpec {
    pub kind: Kind,
    pub clusters: Vec<String>,
    #[serde(default)]
    pub namespaces: Vec<String>,
}

/// One object's usage over time: `[unix seconds, CPU millicores, memory bytes]`, oldest first, and the latest
/// usage of each of its containers (pods).
#[derive(Debug, Clone, Default, Serialize)]
pub struct History {
    pub samples: Vec<(i64, f64, f64)>,
    pub containers: Vec<(String, f64, f64)>,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct Key {
    cluster: String,
    kind: Kind,
    namespace: Option<String>,
}

/// What a poll found last.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "lowercase", tag = "state")]
enum Status {
    Ok,
    /// The cluster does not serve the metrics API (no metrics-server).
    Unavailable {
        message: String,
    },
    /// The user may not read metrics here.
    Forbidden {
        message: String,
    },
    Error {
        message: String,
    },
}

#[derive(Default)]
struct Data {
    status: Option<Status>,
    /// The latest poll: when, and `(namespace, name, cpu, memory)` per object.
    at: i64,
    items: Vec<(String, String, f64, f64)>,
    /// By `namespace/name`.
    history: HashMap<String, VecDeque<(i64, f64, f64)>>,
    containers: HashMap<String, Vec<(String, f64, f64)>>,
}

struct Poller {
    key: Key,
    data: Mutex<Data>,
    /// Bumped after every poll.
    version: watch::Sender<u64>,
    leases: AtomicUsize,
    idle_since: Mutex<Option<Instant>>,
    task: Mutex<Option<AbortHandle>>,
}

/// The engine's polls.
#[derive(Default)]
pub(crate) struct MetricsHub {
    pollers: Mutex<HashMap<Key, Arc<Poller>>>,
}

/// A subscription's hold on a poll: it runs while held, and stays warm a while after.
struct Lease(Arc<Poller>);

impl Drop for Lease {
    fn drop(&mut self) {
        if self.0.leases.fetch_sub(1, Ordering::AcqRel) == 1 {
            *self.0.idle_since.lock() = Some(Instant::now());
        }
    }
}

impl MetricsHub {
    fn lease(&self, inner: &Arc<Inner>, key: Key) -> Lease {
        let mut pollers = self.pollers.lock();
        let poller = pollers
            .entry(key.clone())
            .or_insert_with(|| {
                let p = Arc::new(Poller {
                    key,
                    data: Mutex::default(),
                    version: watch::Sender::new(0),
                    leases: AtomicUsize::new(0),
                    idle_since: Mutex::new(None),
                    task: Mutex::new(None),
                });
                let task = inner.rt.spawn(poll_loop(Arc::downgrade(inner), p.clone()));
                *p.task.lock() = Some(task.abort_handle());
                p
            })
            .clone();
        poller.leases.fetch_add(1, Ordering::AcqRel);
        *poller.idle_since.lock() = None;
        Lease(poller)
    }

    /// Stops polls nobody looked at for [`IDLE`]. Returns how many.
    pub(crate) fn reap(&self) -> usize {
        let mut pollers = self.pollers.lock();
        let before = pollers.len();
        pollers.retain(|_, p| {
            let idle = p.leases.load(Ordering::Acquire) == 0 && p.idle_since.lock().is_some_and(|t| t.elapsed() >= IDLE);
            if idle && let Some(task) = p.task.lock().take() {
                task.abort();
            }
            !idle
        });
        before - pollers.len()
    }

    /// The history of one object, from the polls that hold it (its namespace's, or one over all namespaces).
    pub(crate) fn history(&self, cluster: &str, kind: Kind, namespace: Option<&str>, name: &str) -> Option<History> {
        let id = object_id(namespace.unwrap_or_default(), name);
        let pollers: Vec<Arc<Poller>> = self
            .pollers
            .lock()
            .values()
            .filter(|p| p.key.cluster == cluster && p.key.kind == kind && (p.key.namespace.is_none() || p.key.namespace.as_deref() == namespace))
            .cloned()
            .collect();
        pollers.iter().find_map(|p| {
            let d = p.data.lock();
            let samples = d.history.get(&id)?;
            Some(History { samples: samples.iter().copied().collect(), containers: d.containers.get(&id).cloned().unwrap_or_default() })
        })
    }
}

fn object_id(namespace: &str, name: &str) -> String {
    format!("{namespace}/{name}")
}

/// The metrics API's resource for `kind`.
fn api_resource(kind: Kind) -> ApiResource {
    let (k, plural) = match kind {
        Kind::Pods => ("PodMetrics", "pods"),
        Kind::Nodes => ("NodeMetrics", "nodes"),
    };
    ApiResource {
        group: "metrics.k8s.io".into(),
        version: "v1beta1".into(),
        api_version: "metrics.k8s.io/v1beta1".into(),
        kind: k.into(),
        plural: plural.into(),
    }
}

/// Reads usage until stopped: every [`INTERVAL`], or after [`RECHECK`] when it cannot be had here.
async fn poll_loop(inner: std::sync::Weak<Inner>, p: Arc<Poller>) {
    loop {
        let Some(strong) = inner.upgrade() else { return };
        let status = match poll(&strong, &p.key).await {
            Ok((at, items, containers)) => {
                record(&p, at, items, containers);
                Status::Ok
            }
            Err(status) => status,
        };
        drop(strong);
        let wait = if matches!(status, Status::Unavailable { .. } | Status::Forbidden { .. }) { RECHECK } else { INTERVAL };
        if status != Status::Ok {
            tracing::debug!(cluster = %p.key.cluster, kind = ?p.key.kind, namespace = ?p.key.namespace, ?status, "no metrics");
        }
        p.data.lock().status = Some(status);
        p.version.send_modify(|v| *v += 1);
        tokio::time::sleep(wait).await;
    }
}

type Polled = (i64, Vec<(String, String, f64, f64)>, HashMap<String, Vec<(String, f64, f64)>>);

/// One read of the metrics API for `key`: each object's total CPU (millicores) and memory (bytes), and for pods
/// each container's.
async fn poll(inner: &Arc<Inner>, key: &Key) -> Result<Polled, Status> {
    let cluster = ops::connected(inner, &key.cluster, false).await.map_err(|e| Status::Error { message: e.message() })?;
    let ar = api_resource(key.kind);
    if cluster.discovery().resolve(&format!("{}.metrics.k8s.io", ar.plural)).is_none() {
        return Err(Status::Unavailable { message: "the cluster serves no metrics API (metrics-server is not installed)".into() });
    }
    let api: Api<DynamicObject> = match (&key.namespace, key.kind) {
        (Some(ns), Kind::Pods) => Api::namespaced_with(cluster.client.clone(), ns, &ar),
        _ => Api::all_with(cluster.client.clone(), &ar),
    };
    let list = match tokio::time::timeout(READ_TIMEOUT, api.list(&ListParams::default())).await {
        Ok(Ok(list)) => list,
        Ok(Err(e)) => {
            let e = Error::from(e);
            return Err(match e.code() {
                Some(403) => Status::Forbidden {
                    message: format!("no permission to read metrics{}", key.namespace.as_ref().map(|ns| format!(" in namespace \"{ns}\"")).unwrap_or_default()),
                },
                // The APIService is there, its backend (metrics-server) is not answering.
                Some(503) => Status::Error { message: format!("the metrics API is not answering: {}", e.message()) },
                _ => Status::Error { message: e.message() },
            });
        }
        Err(_) => return Err(Status::Error { message: format!("no answer from the metrics API within {}s", READ_TIMEOUT.as_secs()) }),
    };
    let at = time::now_unix();
    let mut items = Vec::with_capacity(list.items.len());
    let mut containers = HashMap::new();
    for obj in list.items {
        let name = obj.metadata.name.clone().unwrap_or_default();
        let namespace = obj.metadata.namespace.clone().unwrap_or_default();
        let (cpu, mem, per) = usage_of(&obj.data, key.kind);
        if key.kind == Kind::Pods {
            containers.insert(object_id(&namespace, &name), per);
        }
        items.push((namespace, name, cpu, mem));
    }
    Ok((at, items, containers))
}

/// CPU (millicores) and memory (bytes) of one metrics object: a node's `usage`, or the sum over a pod's
/// `containers[].usage` (and each container's).
fn usage_of(data: &Value, kind: Kind) -> (f64, f64, Vec<(String, f64, f64)>) {
    // A tenth of a millicore and whole bytes: what anyone reads of them (metrics-server reports nanocores).
    let read = |usage: &Value| {
        let q = |k: &str| usage.get(k).and_then(Value::as_str).and_then(parse_quantity).unwrap_or(0.0);
        ((q("cpu") * 10_000.0).round() / 10.0, q("memory").round())
    };
    match kind {
        Kind::Nodes => {
            let (cpu, mem) = read(&data["usage"]);
            (cpu, mem, Vec::new())
        }
        Kind::Pods => {
            let per: Vec<(String, f64, f64)> = data["containers"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|c| {
                    let (cpu, mem) = read(&c["usage"]);
                    (c["name"].as_str().unwrap_or_default().to_string(), cpu, mem)
                })
                .collect();
            let (cpu, mem) = per.iter().fold((0.0, 0.0), |(a, b), (_, c, m)| (a + c, b + m));
            (cpu, mem, per)
        }
    }
}

/// Keeps a poll's results: the latest numbers, and a sample more in each object's history (objects gone from
/// the cluster leave it).
fn record(p: &Poller, at: i64, items: Vec<(String, String, f64, f64)>, containers: HashMap<String, Vec<(String, f64, f64)>>) {
    let mut d = p.data.lock();
    let mut seen = std::collections::HashSet::with_capacity(items.len());
    for (ns, name, cpu, mem) in &items {
        let id = object_id(ns, name);
        let h = d.history.entry(id.clone()).or_default();
        // metrics-server's resolution is coarser than a restarted poll: one sample per timestamp.
        if h.back().is_none_or(|(t, _, _)| *t < at) {
            h.push_back((at, *cpu, *mem));
            while h.len() > HISTORY {
                h.pop_front();
            }
        }
        seen.insert(id);
    }
    d.history.retain(|id, _| seen.contains(id));
    d.at = at;
    d.items = items;
    d.containers = containers;
}

#[derive(Serialize)]
struct UsageMsg<'a> {
    t: &'static str,
    c: &'a str,
    ns: Option<&'a str>,
    at: i64,
    /// `[namespace, name, CPU millicores, memory bytes]`
    items: &'a [(String, String, f64, f64)],
}

#[derive(Serialize)]
struct StatusMsg<'a> {
    t: &'static str,
    c: &'a str,
    ns: Option<&'a str>,
    #[serde(flatten)]
    status: &'a Status,
}

/// Streams the usage of `spec`'s objects to `sink` — every poll's result for each of its clusters and namespaces,
/// and why there is none — until cancelled.
pub(crate) async fn run(inner: Arc<Inner>, spec: MetricsSpec, sink: Sink) {
    let namespaces: Vec<Option<String>> =
        if spec.kind == Kind::Nodes || spec.namespaces.is_empty() { vec![None] } else { spec.namespaces.iter().cloned().map(Some).collect() };
    let leases: Vec<Lease> = spec
        .clusters
        .iter()
        .flat_map(|c| namespaces.iter().map(move |ns| Key { cluster: c.clone(), kind: spec.kind, namespace: ns.clone() }))
        .map(|key| inner.metrics.lease(&inner, key))
        .collect();
    let mut versions: Vec<watch::Receiver<u64>> = leases.iter().map(|l| l.0.version.subscribe()).collect();
    // What is there already (a warm poll), then every new poll.
    for (lease, rx) in leases.iter().zip(versions.iter_mut()) {
        rx.borrow_and_update();
        if !send(&sink, &lease.0) {
            return;
        }
    }
    loop {
        let changed = futures::future::select_all(versions.iter_mut().map(|rx| Box::pin(rx.changed())));
        let (res, i, _) = changed.await;
        if res.is_err() {
            return;
        }
        versions[i].borrow_and_update();
        if !send(&sink, &leases[i].0) {
            return;
        }
    }
}

fn send(sink: &Sink, p: &Poller) -> bool {
    let d = p.data.lock();
    let Some(status) = &d.status else { return true };
    let (c, ns) = (p.key.cluster.as_str(), p.key.namespace.as_deref());
    let mut ok = sink(serde_json::to_string(&StatusMsg { t: "status", c, ns, status }).unwrap_or_default());
    if ok && *status == Status::Ok {
        ok = sink(serde_json::to_string(&UsageMsg { t: "usage", c, ns, at: d.at, items: &d.items }).unwrap_or_default());
    }
    ok
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn usage_is_summed_over_a_pods_containers_in_millicores_and_bytes() {
        let pod = json!({ "containers": [
            { "name": "app", "usage": { "cpu": "250m", "memory": "128Mi" } },
            { "name": "envoy", "usage": { "cpu": "12345678n", "memory": "64Ki" } },
        ] });
        let (cpu, mem, per) = usage_of(&pod, Kind::Pods);
        assert_eq!(cpu, 262.3);
        assert_eq!(mem, 128.0 * 1024.0 * 1024.0 + 64.0 * 1024.0);
        assert_eq!(per.iter().map(|(n, _, _)| n.as_str()).collect::<Vec<_>>(), ["app", "envoy"]);
        let node = json!({ "usage": { "cpu": "2", "memory": "4Gi" } });
        let (cpu, mem, per) = usage_of(&node, Kind::Nodes);
        assert_eq!((cpu, mem, per.len()), (2000.0, 4.0 * 1024.0 * 1024.0 * 1024.0, 0));
    }

    fn poller() -> Poller {
        Poller {
            key: Key { cluster: "c".into(), kind: Kind::Pods, namespace: None },
            data: Mutex::default(),
            version: watch::Sender::new(0),
            leases: AtomicUsize::new(0),
            idle_since: Mutex::new(None),
            task: Mutex::new(None),
        }
    }

    /// A cluster whose API server answers metrics lists with `reply(path)`: (status, body).
    fn cluster(inner: &Inner, served: bool, reply: impl Fn(&str) -> (u16, String) + Send + Sync + 'static) {
        let svc = tower::service_fn(move |req: http::Request<kube::client::Body>| {
            let (status, body) = reply(req.uri().path());
            async move {
                Ok::<_, std::convert::Infallible>(
                    http::Response::builder()
                        .status(status)
                        .header("content-type", "application/json")
                        .body(kube::client::Body::from(body.into_bytes()))
                        .unwrap(),
                )
            }
        });
        let mut resources = vec![crate::testing::pods()];
        if served {
            resources.push(crate::discovery::ResourceInfo {
                key: "pods.metrics.k8s.io".into(),
                group: "metrics.k8s.io".into(),
                version: "v1beta1".into(),
                kind: "PodMetrics".into(),
                plural: "pods".into(),
                singular: "".into(),
                namespaced: true,
                verbs: vec!["get".into(), "list".into()],
                short_names: vec![],
                categories: vec![],
                subresources: vec![],
            });
        }
        inner.clusters.insert_ready_for_tests(crate::cluster::Cluster::for_tests("prod-eu-z1", kube::Client::new(svc, "default"), resources));
    }

    async fn messages(inner: Arc<Inner>, namespaces: &[&str]) -> Vec<Value> {
        let got = Arc::new(Mutex::new(Vec::new()));
        let g = got.clone();
        let sink: Sink = Arc::new(move |m: String| {
            g.lock().push(serde_json::from_str::<Value>(&m).unwrap());
            true
        });
        let spec = MetricsSpec { kind: Kind::Pods, clusters: vec!["prod-eu-z1".into()], namespaces: namespaces.iter().map(|s| s.to_string()).collect() };
        let task = tokio::spawn(run(inner, spec, sink));
        for _ in 0..200 {
            if got.lock().len() >= 2 || got.lock().iter().any(|m| m["state"] != "ok" && m["t"] == "status") {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        task.abort();
        got.lock().clone()
    }

    #[tokio::test]
    async fn a_view_gets_each_polls_usage_and_the_history_is_kept() {
        let inner = Inner::for_tests();
        cluster(&inner, true, |path| {
            assert_eq!(path, "/apis/metrics.k8s.io/v1beta1/namespaces/shop/pods");
            (200, r#"{"kind":"PodMetricsList","apiVersion":"metrics.k8s.io/v1beta1","metadata":{},"items":[{"metadata":{"name":"web-1","namespace":"shop"},"timestamp":"2026-10-03T10:00:00Z","window":"15s","containers":[{"name":"app","usage":{"cpu":"125m","memory":"64Mi"}}]}]}"#.into())
        });
        let got = messages(inner.clone(), &["shop"]).await;
        assert_eq!(got[0], json!({ "t": "status", "c": "prod-eu-z1", "ns": "shop", "state": "ok" }));
        assert_eq!(got[1]["items"], json!([["shop", "web-1", 125.0, 67108864.0]]));
        let h = inner.metrics.history("prod-eu-z1", Kind::Pods, Some("shop"), "web-1").unwrap();
        assert_eq!((h.samples.len(), h.containers), (1, vec![("app".to_string(), 125.0, 67108864.0)]));
        // Another namespace's object is not in this poll.
        assert!(inner.metrics.history("prod-eu-z1", Kind::Pods, Some("other"), "web-1").is_none());
    }

    #[tokio::test]
    async fn a_refusal_or_a_cluster_without_the_metrics_api_is_said_once() {
        let inner = Inner::for_tests();
        cluster(&inner, true, |_| {
            (403, r#"{"kind":"Status","apiVersion":"v1","status":"Failure","message":"forbidden","reason":"Forbidden","code":403}"#.into())
        });
        let got = messages(inner, &["shop"]).await;
        assert_eq!(
            got,
            [json!({ "t": "status", "c": "prod-eu-z1", "ns": "shop", "state": "forbidden", "message": "no permission to read metrics in namespace \"shop\"" })]
        );

        let inner = Inner::for_tests();
        cluster(&inner, false, |_| panic!("not asked"));
        let got = messages(inner, &[]).await;
        assert_eq!(got[0]["state"], "unavailable");
        assert_eq!(got[0]["ns"], Value::Null);
    }

    #[test]
    fn history_keeps_the_latest_samples_of_objects_still_there() {
        let p = poller();
        let item = |name: &str, cpu: f64| ("shop".to_string(), name.to_string(), cpu, 1.0);
        for t in 0..(HISTORY as i64 + 5) {
            record(&p, t * 15, vec![item("web-1", t as f64), item("web-2", 1.0)], HashMap::new());
        }
        // The same timestamp again (a poll restarted before metrics-server moved on): no second sample.
        record(&p, (HISTORY as i64 + 4) * 15, vec![item("web-1", 99.0), item("web-2", 1.0)], HashMap::new());
        let d = p.data.lock();
        let h = &d.history["shop/web-1"];
        assert_eq!(h.len(), HISTORY);
        assert_eq!(h.front().unwrap().1, 5.0);
        assert_eq!(h.back().unwrap().1, (HISTORY + 4) as f64);
        drop(d);
        // web-2 is gone: its history goes too.
        record(&p, 10_000, vec![item("web-1", 1.0)], HashMap::new());
        assert!(!p.data.lock().history.contains_key("shop/web-2"));
    }
}
