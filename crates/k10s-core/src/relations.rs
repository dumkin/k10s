//! Relations: what an object belongs to and what belongs to it, what it uses and what uses it — a graph around it,
//! kept live. An ingress routes to services, which select the pods a deployment's replica sets own; the pods run as a
//! service account (bound to roles) on nodes, mount config maps, secrets and claims (bound to volumes); autoscalers
//! scale the deployment, disruption budgets and network policies apply to its pods; Helm manages it all.
//!
//! The graph is built from the namespace's feeds — the same the tables lease, so what a table shows is not listed
//! again, and changes (a rollout, a pod replaced) show as they happen. It is the object's neighbourhood, not the whole
//! namespace: its own app (owners, owned, the services and ingresses in front of it, the policies on it), and what
//! that app uses — config, storage, identity, nodes — as leaves (a secret every app pulls images with does not bring
//! every app along). Looking at a config map, a claim or a service account shows what uses it.
//!
//! References to objects that are not there are drawn as missing (a pod's config map deleted): the cause of many a
//! `CreateContainerConfigError`. Where a kind could not be read (strict RBAC), references to it are unknown, not missing.

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::{broadcast, mpsc};
use tokio::task::JoinSet;

use crate::engine::Inner;
use crate::error::Error;
use crate::feed::{FeedKey, FeedLease, FeedSpec, FeedStatus, Lease};
use crate::ops;
use crate::render::util::JsonExt;
use crate::render::{self, Cell, Column, ColumnKind, Row, Tone};
use crate::view::Sink;

/// Changes within this long make one new graph.
const DEBOUNCE: Duration = Duration::from_millis(200);
/// Nodes in a graph at most: the closest ones.
const MAX_NODES: usize = 150;
/// Pods shown per owner at most (the focus and those in trouble first); the owner says how many more.
const MAX_PODS_PER_OWNER: usize = 12;

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RelationsSpec {
    pub cluster: String,
    /// The focus object's resource key (`deployments.apps`).
    pub resource: String,
    #[serde(default)]
    pub namespace: Option<String>,
    pub name: String,
}

/// Where a node goes in a drawing: rows (or columns) from traffic down to infrastructure.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Layer {
    Release,
    Traffic,
    Service,
    Policy,
    Workload,
    Replica,
    Pod,
    Config,
    Storage,
    Identity,
    Node,
}

/// How two objects are related (an edge goes from the first named to the second).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Rel {
    /// An owner (controller) and what it owns.
    Owns,
    /// A service and the pods its selector picks.
    Selects,
    /// An ingress and a service it routes to.
    Routes,
    /// An ingress and the secret with its certificate.
    Tls,
    /// A pod (template) and a config map, secret or claim it mounts.
    Mounts,
    /// A pod (template) and a config map or secret its environment comes from.
    Env,
    /// A pod (template) or service account and a secret images are pulled with.
    Pulls,
    /// A pod (template) and its service account.
    RunsAs,
    /// A pod and its node.
    RunsOn,
    /// A claim and its volume.
    Bound,
    /// A claim (or volume) and its storage class.
    Class,
    /// An autoscaler and what it scales.
    Scales,
    /// A disruption budget and the pods it protects.
    Protects,
    /// A network policy and the pods it applies to.
    Isolates,
    /// A role binding and a subject it binds (a service account).
    Subject,
    /// A role binding and the role it grants.
    Grants,
    /// A Helm release and what it made.
    Manages,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphNode {
    pub id: String,
    /// Where it opens (its resource key); none for an object only named here (an owner of a kind not read).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resource: Option<String>,
    pub kind: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub namespace: Option<String>,
    pub layer: Layer,
    pub tone: Tone,
    /// What its table says of it ("Running", "3/3").
    #[serde(skip_serializing_if = "String::is_empty")]
    pub status: String,
    /// Referred to, but not there.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub missing: bool,
    /// Every reference to it says it may be missing.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub optional: bool,
    /// Its kind could not be read: whether it is there is not known.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub unknown: bool,
    /// Of an owner: how many of its pods are left out of the graph.
    #[serde(skip_serializing_if = "is_zero")]
    pub more: usize,
    /// Of a pod: its owner's id (the drawing groups them).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub owner: Option<String>,
    /// Creation (unix seconds), 0 if unknown.
    #[serde(skip_serializing_if = "is_zero_i64")]
    pub created: i64,
}

fn is_zero(n: &usize) -> bool {
    *n == 0
}

fn is_zero_i64(n: &i64) -> bool {
    *n == 0
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct GraphEdge {
    pub from: String,
    pub to: String,
    pub rel: Rel,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Graph {
    /// The focus's id; empty when it is not there (yet).
    pub focus: String,
    pub nodes: Vec<GraphNode>,
    pub edges: Vec<GraphEdge>,
    /// What the graph may lack: kinds that could not be read, related objects left out.
    pub notes: Vec<String>,
}

/// One object of the namespace (or node), as its feed has it.
pub(crate) struct Item {
    pub resource: Arc<str>,
    pub kind: Arc<str>,
    pub row: Arc<Row>,
    pub obj: Option<Arc<Value>>,
    /// What its table says of it.
    pub status: String,
}

impl Item {
    fn id(&self) -> String {
        node_id(&self.resource, self.row.namespace.as_deref(), &self.row.name)
    }
}

fn node_id(resource: &str, namespace: Option<&str>, name: &str) -> String {
    format!("{resource}/{}/{name}", namespace.unwrap_or_default())
}

/// Where each kind is drawn, and what kind of thing it is.
fn layer_of(resource: &str) -> Layer {
    match resource {
        "helmreleases" => Layer::Release,
        "ingresses.networking.k8s.io" => Layer::Traffic,
        "services" => Layer::Service,
        "horizontalpodautoscalers.autoscaling" | "poddisruptionbudgets.policy" | "networkpolicies.networking.k8s.io" => Layer::Policy,
        "replicasets.apps" | "jobs.batch" => Layer::Replica,
        "pods" => Layer::Pod,
        "configmaps" | "secrets" => Layer::Config,
        "persistentvolumeclaims" | "persistentvolumes" | "storageclasses.storage.k8s.io" => Layer::Storage,
        "serviceaccounts" | "rolebindings.rbac.authorization.k8s.io" | "roles.rbac.authorization.k8s.io" | "clusterroles.rbac.authorization.k8s.io" => {
            Layer::Identity
        }
        "nodes" => Layer::Node,
        _ => Layer::Workload,
    }
}

/// The kinds read for a namespace's graph: what relates workloads, and what they use.
const NAMESPACE_KINDS: &[&str] = &[
    "pods",
    "replicasets.apps",
    "deployments.apps",
    "statefulsets.apps",
    "daemonsets.apps",
    "jobs.batch",
    "cronjobs.batch",
    "services",
    "ingresses.networking.k8s.io",
    "configmaps",
    "secrets",
    "persistentvolumeclaims",
    "serviceaccounts",
    "rolebindings.rbac.authorization.k8s.io",
    "roles.rbac.authorization.k8s.io",
    "horizontalpodautoscalers.autoscaling",
    "poddisruptionbudgets.policy",
    "networkpolicies.networking.k8s.io",
];

/// A kind's resource key for an owner or target reference (`apps/v1` `Deployment`), when it is one read here.
fn key_of_kind(kind: &str) -> Option<&'static str> {
    Some(match kind {
        "Pod" => "pods",
        "ReplicaSet" => "replicasets.apps",
        "Deployment" => "deployments.apps",
        "StatefulSet" => "statefulsets.apps",
        "DaemonSet" => "daemonsets.apps",
        "Job" => "jobs.batch",
        "CronJob" => "cronjobs.batch",
        "Service" => "services",
        "ConfigMap" => "configmaps",
        "Secret" => "secrets",
        "PersistentVolumeClaim" => "persistentvolumeclaims",
        "ServiceAccount" => "serviceaccounts",
        "Node" => "nodes",
        _ => return None,
    })
}

// ---------------------------------------------------------------------------------------------
// What relates to what
// ---------------------------------------------------------------------------------------------

/// `k=v k2=v2` labels of a row.
fn labels_of(row: &Row) -> HashMap<&str, &str> {
    row.labels.split(' ').filter_map(|kv| kv.split_once('=')).collect()
}

/// Whether a label selector (`matchLabels`, `matchExpressions`) picks these labels. `None` or `{}` picks all.
pub(crate) fn selects(selector: Option<&Value>, labels: &HashMap<&str, &str>) -> bool {
    let Some(sel) = selector else { return true };
    for (k, v) in sel.entries(&["matchLabels"]) {
        if labels.get(k.as_str()) != Some(&v.as_str().unwrap_or_default()) {
            return false;
        }
    }
    sel.arr(&["matchExpressions"]).iter().all(|e| {
        let key = e.str_at(&["key"]).unwrap_or_default();
        let values: Vec<&str> = e.arr(&["values"]).iter().filter_map(Value::as_str).collect();
        let have = labels.get(key);
        match e.str_at(&["operator"]).unwrap_or_default() {
            "In" => have.is_some_and(|v| values.contains(v)),
            "NotIn" => have.is_none_or(|v| !values.contains(v)),
            "Exists" => have.is_some(),
            "DoesNotExist" => have.is_none(),
            _ => false,
        }
    })
}

/// A service's selector (a plain map): none selects nothing (its endpoints are managed by hand).
fn service_selects(svc: &Value, labels: &HashMap<&str, &str>) -> bool {
    let Some(sel) = svc.at(&["spec", "selector"]).and_then(Value::as_object).filter(|m| !m.is_empty()) else { return false };
    sel.iter().all(|(k, v)| labels.get(k.as_str()) == Some(&v.as_str().unwrap_or_default()))
}

/// The pod spec of a pod or of a workload's template.
fn pod_spec<'a>(kind: &str, obj: &'a Value) -> Option<&'a Value> {
    match kind {
        "Pod" => obj.at(&["spec"]),
        "CronJob" => obj.at(&["spec", "jobTemplate", "spec", "template", "spec"]),
        _ => obj.at(&["spec", "template", "spec"]),
    }
}

/// What a pod spec refers to: config maps, secrets, claims, its service account — each with how and whether optional.
struct SpecRef {
    resource: &'static str,
    name: String,
    rel: Rel,
    label: Option<String>,
    optional: bool,
}

fn spec_refs(spec: &Value, pod_name: Option<&str>) -> Vec<SpecRef> {
    let mut out = Vec::new();
    let containers: Vec<&Value> = ["initContainers", "containers", "ephemeralContainers"].iter().flat_map(|k| spec.arr(&[k]).iter()).collect();
    let mounts_of = |volume: &str| -> Option<String> {
        let paths: Vec<&str> = containers
            .iter()
            .flat_map(|c| c.arr(&["volumeMounts"]).iter())
            .filter(|m| m.str_at(&["name"]) == Some(volume))
            .filter_map(|m| m.str_at(&["mountPath"]))
            .collect();
        match paths.as_slice() {
            [] => None,
            [one] => Some((*one).to_string()),
            [first, rest @ ..] => Some(format!("{first} +{}", rest.len())),
        }
    };
    for v in spec.arr(&["volumes"]) {
        let vol = v.str_at(&["name"]).unwrap_or_default();
        // The service account token every pod gets (with the cluster's CA): noise.
        if vol.starts_with("kube-api-access-") {
            continue;
        }
        let label = mounts_of(vol);
        let optional = |path: &[&str]| v.bool_at(path).unwrap_or(false);
        if let Some(n) = v.str_at(&["configMap", "name"]) {
            out.push(SpecRef {
                resource: "configmaps",
                name: n.into(),
                rel: Rel::Mounts,
                label: label.clone(),
                optional: optional(&["configMap", "optional"]),
            });
        }
        if let Some(n) = v.str_at(&["secret", "secretName"]) {
            out.push(SpecRef { resource: "secrets", name: n.into(), rel: Rel::Mounts, label: label.clone(), optional: optional(&["secret", "optional"]) });
        }
        if let Some(n) = v.str_at(&["persistentVolumeClaim", "claimName"]) {
            out.push(SpecRef { resource: "persistentvolumeclaims", name: n.into(), rel: Rel::Mounts, label: label.clone(), optional: false });
        }
        // A generic ephemeral volume: a claim made for the pod, named after it.
        if v.at(&["ephemeral"]).is_some()
            && let Some(pod) = pod_name
        {
            out.push(SpecRef { resource: "persistentvolumeclaims", name: format!("{pod}-{vol}"), rel: Rel::Mounts, label: label.clone(), optional: false });
        }
        for s in v.arr(&["projected", "sources"]) {
            if let Some(n) = s.str_at(&["configMap", "name"]) {
                out.push(SpecRef {
                    resource: "configmaps",
                    name: n.into(),
                    rel: Rel::Mounts,
                    label: label.clone(),
                    optional: s.bool_at(&["configMap", "optional"]).unwrap_or(false),
                });
            }
            if let Some(n) = s.str_at(&["secret", "name"]) {
                out.push(SpecRef {
                    resource: "secrets",
                    name: n.into(),
                    rel: Rel::Mounts,
                    label: label.clone(),
                    optional: s.bool_at(&["secret", "optional"]).unwrap_or(false),
                });
            }
        }
    }
    for c in &containers {
        for e in c.arr(&["env"]) {
            for (path, resource) in [(["valueFrom", "configMapKeyRef"], "configmaps"), (["valueFrom", "secretKeyRef"], "secrets")] {
                if let Some(r) = e.at(&path)
                    && let Some(n) = r.str_at(&["name"])
                {
                    out.push(SpecRef {
                        resource,
                        name: n.into(),
                        rel: Rel::Env,
                        label: e.str_at(&["name"]).map(|v| format!("env {v}")),
                        optional: r.bool_at(&["optional"]).unwrap_or(false),
                    });
                }
            }
        }
        for e in c.arr(&["envFrom"]) {
            for (key, resource) in [("configMapRef", "configmaps"), ("secretRef", "secrets")] {
                if let Some(n) = e.str_at(&[key, "name"]) {
                    out.push(SpecRef {
                        resource,
                        name: n.into(),
                        rel: Rel::Env,
                        label: Some("all keys".into()),
                        optional: e.bool_at(&[key, "optional"]).unwrap_or(false),
                    });
                }
            }
        }
    }
    for s in spec.arr(&["imagePullSecrets"]) {
        if let Some(n) = s.str_at(&["name"]) {
            out.push(SpecRef { resource: "secrets", name: n.into(), rel: Rel::Pulls, label: None, optional: false });
        }
    }
    let sa = spec.str_at(&["serviceAccountName"]).or_else(|| spec.str_at(&["serviceAccount"])).unwrap_or("default");
    out.push(SpecRef { resource: "serviceaccounts", name: sa.into(), rel: Rel::RunsAs, label: None, optional: false });
    // The same object referred to the same way twice (env from two keys of one config map): one edge.
    let mut seen = HashSet::new();
    out.retain(|r| seen.insert((r.resource, r.name.clone(), r.rel)));
    out
}

/// "shop.example.com/api" for an ingress path.
fn route_label(host: Option<&str>, path: Option<&str>) -> String {
    format!("{}{}", host.unwrap_or("*"), path.unwrap_or("/"))
}

/// Endpoints of the graph: objects of the feeds, and those only referred to (an owner of a kind not read, a node,
/// a missing config map).
struct Nodes {
    list: Vec<GraphNode>,
    by_id: HashMap<String, usize>,
    /// The item of each node, for those that are one.
    item: Vec<Option<usize>>,
}

impl Nodes {
    fn add(&mut self, node: GraphNode, item: Option<usize>) -> usize {
        if let Some(&i) = self.by_id.get(&node.id) {
            return i;
        }
        self.by_id.insert(node.id.clone(), self.list.len());
        self.list.push(node);
        self.item.push(item);
        self.list.len() - 1
    }
}

/// What may be read of each kind: all of it (its feed is ready), or not (no access, still loading).
pub(crate) type Readable = HashSet<String>;

/// A node for an object only referred to: missing when its kind was read (it is not there), unknown otherwise.
fn referred(resource: &str, kind: &str, namespace: Option<&str>, name: &str, readable: &Readable, optional: bool) -> GraphNode {
    let read = readable.contains(resource);
    GraphNode {
        id: node_id(resource, namespace, name),
        resource: Some(resource.to_string()),
        kind: kind.to_string(),
        name: name.to_string(),
        namespace: namespace.map(str::to_string),
        layer: layer_of(resource),
        tone: if read && !optional { Tone::Error } else { Tone::Neutral },
        status: String::new(),
        missing: read,
        optional,
        unknown: !read,
        more: 0,
        owner: None,
        created: 0,
    }
}

/// A node for something outside the namespace's feeds (a node, a volume, a cluster role, a Helm release, an owner of a
/// kind not read): its status where a feed elsewhere has it (`known`).
fn outside(resource: Option<&str>, kind: &str, namespace: Option<&str>, name: &str, known: Option<(Tone, String)>) -> GraphNode {
    let (tone, status) = known.unwrap_or((Tone::Neutral, String::new()));
    GraphNode {
        id: node_id(resource.unwrap_or(kind), namespace, name),
        resource: resource.map(str::to_string),
        kind: kind.to_string(),
        name: name.to_string(),
        namespace: namespace.map(str::to_string),
        layer: resource.map_or(Layer::Workload, layer_of),
        tone,
        status,
        missing: false,
        optional: false,
        unknown: false,
        more: 0,
        owner: None,
        created: 0,
    }
}

/// What to draw around `focus` (`resource`, namespace, name), from the objects of its namespace (or node).
/// `readable`: kinds whose feeds are ready; `elsewhere`: status of nodes and volumes as feeds elsewhere have them.
pub(crate) fn build(items: &[Item], focus: (&str, Option<&str>, &str), readable: &Readable, elsewhere: &HashMap<String, (Tone, String)>) -> Graph {
    let mut nodes = Nodes { list: Vec::new(), by_id: HashMap::new(), item: Vec::new() };
    let mut edges: Vec<(usize, usize, Rel, Option<String>)> = Vec::new();
    let mut by_uid: HashMap<&str, usize> = HashMap::new();
    let mut by_name: HashMap<(&str, &str), usize> = HashMap::new();
    for (i, it) in items.iter().enumerate() {
        let node = GraphNode {
            id: it.id(),
            resource: Some(it.resource.to_string()),
            kind: it.kind.to_string(),
            name: it.row.name.clone(),
            namespace: it.row.namespace.clone(),
            layer: layer_of(&it.resource),
            tone: it.row.tone,
            status: it.status.clone(),
            missing: false,
            optional: false,
            unknown: false,
            more: 0,
            owner: None,
            created: it.row.created,
        };
        let n = nodes.add(node, Some(i));
        by_uid.insert(&it.row.uid, n);
        by_name.insert((&it.resource, &it.row.name), n);
    }
    let mut optional_refs: HashMap<usize, bool> = HashMap::new();

    // Owners: by uid among the objects read; others (a Rollout owning replica sets) by name only.
    let mut owner_of: HashMap<usize, usize> = HashMap::new();
    for it in items {
        let Some(obj) = &it.obj else { continue };
        let me = by_uid[&*it.row.uid];
        for r in obj.arr(&["metadata", "ownerReferences"]) {
            let owner = match r.str_at(&["uid"]).and_then(|u| by_uid.get(u)) {
                Some(&o) => o,
                None => {
                    let kind = r.str_at(&["kind"]).unwrap_or("Owner");
                    let name = r.str_at(&["name"]).unwrap_or_default();
                    let resource = key_of_kind(kind);
                    let ns = if kind == "Node" { None } else { it.row.namespace.as_deref() };
                    let known = resource.and_then(|r| elsewhere.get(&node_id(r, ns, name)).cloned());
                    nodes.add(outside(resource, kind, ns, name, known), None)
                }
            };
            if r.bool_at(&["controller"]) == Some(true) || !owner_of.contains_key(&me) {
                owner_of.insert(me, owner);
            }
            edges.push((owner, me, Rel::Owns, None));
        }
    }
    // A pod's controller in the drawing: its owner, and that one's (a replica set's deployment).
    let pod_owners: Vec<(usize, String)> =
        owner_of.iter().filter(|(p, _)| nodes.list[**p].kind == "Pod").map(|(p, o)| (*p, nodes.list[*o].id.clone())).collect();
    for (pod, owner) in pod_owners {
        nodes.list[pod].owner = Some(owner);
    }
    let controlled = |n: usize| owner_of.contains_key(&n);

    // What pod specs use — attached to the object that declares them: a deployment's template, not each of its pods.
    for it in items {
        let Some(obj) = &it.obj else { continue };
        let me = by_uid[&*it.row.uid];
        let declares = matches!(&*it.kind, "Pod" | "ReplicaSet" | "Deployment" | "StatefulSet" | "DaemonSet" | "Job" | "CronJob");
        // Controlled by an object read here: that one's template says it.
        let inherits = owner_of.get(&me).is_some_and(|o| nodes.item[*o].is_some());
        if !declares || inherits {
            continue;
        }
        let Some(spec) = pod_spec(&it.kind, obj) else { continue };
        let ns = it.row.namespace.as_deref();
        for r in spec_refs(spec, (&*it.kind == "Pod").then_some(it.row.name.as_str())) {
            let target = match by_name.get(&(r.resource, r.name.as_str())) {
                Some(&t) => t,
                None => {
                    let kind = match r.resource {
                        "configmaps" => "ConfigMap",
                        "secrets" => "Secret",
                        "persistentvolumeclaims" => "PersistentVolumeClaim",
                        _ => "ServiceAccount",
                    };
                    let t = nodes.add(referred(r.resource, kind, ns, &r.name, readable, r.optional), None);
                    let all_optional = optional_refs.entry(t).or_insert(true);
                    *all_optional &= r.optional;
                    t
                }
            };
            edges.push((me, target, r.rel, r.label));
        }
        if &*it.kind == "Pod"
            && let Some(node) = spec.str_at(&["nodeName"])
        {
            let n = nodes.add(outside(Some("nodes"), "Node", None, node, elsewhere.get(&node_id("nodes", None, node)).cloned()), None);
            edges.push((me, n, Rel::RunsOn, None));
        }
    }
    // Nodes of controlled pods too (their specs are not read above).
    for it in items.iter().filter(|it| &*it.kind == "Pod") {
        let me = by_uid[&*it.row.uid];
        if !controlled(me) {
            continue;
        }
        let node = it.obj.as_ref().and_then(|o| o.str_at(&["spec", "nodeName"]).map(str::to_string));
        if let Some(node) = node {
            let n = nodes.add(outside(Some("nodes"), "Node", None, &node, elsewhere.get(&node_id("nodes", None, &node)).cloned()), None);
            edges.push((me, n, Rel::RunsOn, None));
        }
    }
    // A reference that is optional everywhere is no error when missing.
    for (n, all_optional) in optional_refs {
        if !all_optional && nodes.list[n].missing {
            nodes.list[n].optional = false;
            nodes.list[n].tone = Tone::Error;
        }
    }

    let pods: Vec<(usize, HashMap<&str, &str>, Option<&str>)> =
        items.iter().filter(|it| &*it.kind == "Pod").map(|it| (by_uid[&*it.row.uid], labels_of(&it.row), it.row.namespace.as_deref())).collect();
    for it in items {
        let Some(obj) = &it.obj else { continue };
        let me = by_uid[&*it.row.uid];
        let ns = it.row.namespace.as_deref();
        match &*it.kind {
            "Service" => {
                for (p, labels, pns) in &pods {
                    if *pns == ns && service_selects(obj, labels) {
                        edges.push((me, *p, Rel::Selects, None));
                    }
                }
            }
            "Ingress" => {
                let mut backends: Vec<(String, String)> = Vec::new();
                if let Some(svc) = obj.str_at(&["spec", "defaultBackend", "service", "name"]) {
                    backends.push((svc.to_string(), "default".into()));
                }
                for rule in obj.arr(&["spec", "rules"]) {
                    for path in rule.arr(&["http", "paths"]) {
                        if let Some(svc) = path.str_at(&["backend", "service", "name"]) {
                            backends.push((svc.to_string(), route_label(rule.str_at(&["host"]), path.str_at(&["path"]))));
                        }
                    }
                }
                let mut labels: HashMap<String, Vec<String>> = HashMap::new();
                for (svc, label) in backends {
                    labels.entry(svc).or_default().push(label);
                }
                for (svc, mut routes) in labels {
                    routes.sort();
                    routes.dedup();
                    let label = match routes.as_slice() {
                        [one] => one.clone(),
                        [first, rest @ ..] => format!("{first} +{}", rest.len()),
                        [] => String::new(),
                    };
                    let target = match by_name.get(&("services", svc.as_str())) {
                        Some(&t) => t,
                        None => nodes.add(referred("services", "Service", ns, &svc, readable, false), None),
                    };
                    edges.push((me, target, Rel::Routes, Some(label)));
                }
                for tls in obj.arr(&["spec", "tls"]) {
                    if let Some(secret) = tls.str_at(&["secretName"]) {
                        let target = match by_name.get(&("secrets", secret)) {
                            Some(&t) => t,
                            None => nodes.add(referred("secrets", "Secret", ns, secret, readable, false), None),
                        };
                        let hosts: Vec<&str> = tls.arr(&["hosts"]).iter().filter_map(Value::as_str).collect();
                        edges.push((me, target, Rel::Tls, (!hosts.is_empty()).then(|| hosts.join(", "))));
                    }
                }
            }
            "PersistentVolumeClaim" => {
                if let Some(pv) = obj.str_at(&["spec", "volumeName"]) {
                    let n = nodes.add(
                        outside(Some("persistentvolumes"), "PersistentVolume", None, pv, elsewhere.get(&node_id("persistentvolumes", None, pv)).cloned()),
                        None,
                    );
                    edges.push((me, n, Rel::Bound, None));
                }
                if let Some(sc) = obj.str_at(&["spec", "storageClassName"]).filter(|s| !s.is_empty()) {
                    let n = nodes.add(outside(Some("storageclasses.storage.k8s.io"), "StorageClass", None, sc, None), None);
                    edges.push((me, n, Rel::Class, None));
                }
            }
            "HorizontalPodAutoscaler" => {
                let kind = obj.str_at(&["spec", "scaleTargetRef", "kind"]).unwrap_or_default();
                let name = obj.str_at(&["spec", "scaleTargetRef", "name"]).unwrap_or_default();
                let target = match key_of_kind(kind).and_then(|r| by_name.get(&(r, name))) {
                    Some(&t) => t,
                    None => nodes.add(referred(key_of_kind(kind).unwrap_or("deployments.apps"), kind, ns, name, readable, false), None),
                };
                let range = format!("{}–{}", obj.i64_at(&["spec", "minReplicas"]).unwrap_or(1), obj.i64_at(&["spec", "maxReplicas"]).unwrap_or(0));
                edges.push((me, target, Rel::Scales, Some(range)));
            }
            "PodDisruptionBudget" => {
                let sel = obj.at(&["spec", "selector"]);
                // An empty selector protects every pod; none, none.
                if sel.is_some() {
                    for (p, labels, pns) in &pods {
                        if *pns == ns && selects(sel, labels) {
                            edges.push((me, *p, Rel::Protects, None));
                        }
                    }
                }
            }
            "NetworkPolicy" => {
                let sel = obj.at(&["spec", "podSelector"]);
                for (p, labels, pns) in &pods {
                    if *pns == ns && selects(sel, labels) {
                        edges.push((me, *p, Rel::Isolates, None));
                    }
                }
            }
            "RoleBinding" => {
                for s in obj.arr(&["subjects"]) {
                    if s.str_at(&["kind"]) != Some("ServiceAccount") || s.str_at(&["namespace"]).is_some_and(|n| Some(n) != ns) {
                        continue;
                    }
                    if let Some(&sa) = s.str_at(&["name"]).and_then(|n| by_name.get(&("serviceaccounts", n))) {
                        edges.push((me, sa, Rel::Subject, None));
                    }
                }
                let role_kind = obj.str_at(&["roleRef", "kind"]).unwrap_or("ClusterRole");
                let role = obj.str_at(&["roleRef", "name"]).unwrap_or_default();
                let target = match (role_kind, by_name.get(&("roles.rbac.authorization.k8s.io", role))) {
                    ("Role", Some(&t)) => t,
                    ("Role", None) => nodes.add(referred("roles.rbac.authorization.k8s.io", "Role", ns, role, readable, false), None),
                    _ => nodes.add(outside(Some("clusterroles.rbac.authorization.k8s.io"), "ClusterRole", None, role, None), None),
                };
                edges.push((me, target, Rel::Grants, None));
            }
            "ServiceAccount" => {
                for s in obj.arr(&["imagePullSecrets"]) {
                    if let Some(&t) = s.str_at(&["name"]).and_then(|n| by_name.get(&("secrets", n))) {
                        edges.push((me, t, Rel::Pulls, None));
                    }
                }
            }
            _ => {}
        }
        // What Helm made (top-level objects only: their own objects are owned).
        if obj.str_at(&["metadata", "labels", "app.kubernetes.io/managed-by"]) == Some("Helm")
            && obj.arr(&["metadata", "ownerReferences"]).is_empty()
            && let Some(release) = obj.str_at(&["metadata", "annotations", "meta.helm.sh/release-name"])
        {
            let rns = obj.str_at(&["metadata", "annotations", "meta.helm.sh/release-namespace"]).or(ns);
            let r = nodes.add(outside(Some("helmreleases"), "Helm release", rns, release, None), None);
            edges.push((r, me, Rel::Manages, None));
        }
    }

    let focus_id = node_id(focus.0, focus.1, focus.2);
    let Some(&focus_node) = nodes.by_id.get(&focus_id) else {
        return Graph { focus: String::new(), nodes: Vec::new(), edges: Vec::new(), notes: Vec::new() };
    };
    // A volume is looked at for its claim's sake: who uses it.
    let mut also: Vec<usize> = Vec::new();
    if focus.0 == "persistentvolumes" {
        also.extend(edges.iter().filter(|(_, to, rel, _)| *to == focus_node && *rel == Rel::Bound).map(|(from, _, _, _)| *from));
    }
    neighbourhood(nodes, edges, focus_node, &also)
}

/// Whether to follow an edge from `n` (`out`: it starts there). The focus follows everything; its app's workloads,
/// services and ingresses follow what makes the app (owners, owned, selectors, routes, the policies on them) and
/// what they use; what is used (config, storage, identity, nodes) leads no further — except storage to its volume
/// and class, and a service account to the bindings that give it its permissions.
fn follows(layer: Layer, focus: bool, rel: Rel, out: bool) -> bool {
    if focus {
        return true;
    }
    match layer {
        Layer::Workload | Layer::Replica | Layer::Pod => match rel {
            Rel::Owns => true,
            Rel::Selects | Rel::Scales | Rel::Protects | Rel::Isolates | Rel::Manages => !out,
            Rel::Mounts | Rel::Env | Rel::Pulls | Rel::RunsAs | Rel::RunsOn => out,
            _ => false,
        },
        Layer::Service => matches!((rel, out), (Rel::Selects, true) | (Rel::Routes, false) | (Rel::Manages, false)),
        Layer::Traffic => matches!((rel, out), (Rel::Routes, true) | (Rel::Tls, true) | (Rel::Manages, false)),
        Layer::Storage => out && matches!(rel, Rel::Bound | Rel::Class),
        Layer::Identity => matches!((rel, out), (Rel::Subject, false) | (Rel::Grants, true)),
        _ => false,
    }
}

/// The nodes [`follows`] reaches from `focus` (and from `also`, followed as the focus is), the closest [`MAX_NODES`];
/// pods past [`MAX_PODS_PER_OWNER`] of an owner left out.
fn neighbourhood(mut nodes: Nodes, edges: Vec<(usize, usize, Rel, Option<String>)>, focus: usize, also: &[usize]) -> Graph {
    let mut adj: Vec<Vec<(usize, bool)>> = vec![Vec::new(); nodes.list.len()];
    for (e, (from, to, _, _)) in edges.iter().enumerate() {
        adj[*from].push((e, true));
        adj[*to].push((e, false));
    }
    let mut keep: Vec<bool> = vec![false; nodes.list.len()];
    let mut order: Vec<usize> = vec![focus];
    keep[focus] = true;
    let mut queue = VecDeque::from([focus]);
    let mut left_out = HashSet::new();
    while let Some(n) = queue.pop_front() {
        let layer = nodes.list[n].layer;
        let as_focus = n == focus || also.contains(&n);
        for &(e, out) in &adj[n] {
            let (from, to, rel, _) = &edges[e];
            if !follows(layer, as_focus, *rel, out) {
                continue;
            }
            let m = if out { *to } else { *from };
            if keep[m] {
                continue;
            }
            if order.len() >= MAX_NODES {
                left_out.insert(m);
                continue;
            }
            keep[m] = true;
            order.push(m);
            queue.push_back(m);
        }
    }

    // Pods per owner: the focus and those in trouble first, then by name; the owner counts the rest.
    let mut by_owner: HashMap<String, Vec<usize>> = HashMap::new();
    for &n in &order {
        if let Some(owner) = &nodes.list[n].owner
            && n != focus
        {
            by_owner.entry(owner.clone()).or_default().push(n);
        }
    }
    let bad = |t: Tone| matches!(t, Tone::Error | Tone::Warn);
    for (owner, mut pods) in by_owner {
        if pods.len() <= MAX_PODS_PER_OWNER {
            continue;
        }
        pods.sort_by(|a, b| {
            let (x, y) = (&nodes.list[*a], &nodes.list[*b]);
            bad(y.tone).cmp(&bad(x.tone)).then_with(|| x.name.cmp(&y.name))
        });
        let hidden = pods.split_off(MAX_PODS_PER_OWNER);
        for p in &hidden {
            keep[*p] = false;
        }
        if let Some(&o) = nodes.by_id.get(&owner) {
            nodes.list[o].more = hidden.len();
        }
    }
    // What only the pods left out led to (their nodes) goes too.
    let mut linked = vec![false; nodes.list.len()];
    linked[focus] = true;
    for (from, to, _, _) in &edges {
        if keep[*from] && keep[*to] {
            linked[*from] = true;
            linked[*to] = true;
        }
    }
    let ids: Vec<usize> = order.into_iter().filter(|&n| keep[n] && linked[n]).collect();
    let kept: HashSet<usize> = ids.iter().copied().collect();
    let mut notes = Vec::new();
    if !left_out.is_empty() {
        notes.push(format!("{} more related objects are left out: the graph shows the {MAX_NODES} closest", left_out.len()));
    }
    let mut seen_edges = HashSet::new();
    let graph_edges = edges
        .iter()
        .filter(|(f, t, _, _)| kept.contains(f) && kept.contains(t))
        .filter(|(f, t, r, _)| seen_edges.insert((*f, *t, *r)))
        .map(|(f, t, rel, label)| GraphEdge { from: nodes.list[*f].id.clone(), to: nodes.list[*t].id.clone(), rel: *rel, label: label.clone() })
        .collect();
    let focus_id = nodes.list[focus].id.clone();
    let list = std::mem::take(&mut nodes.list);
    let mut out: Vec<Option<GraphNode>> = list.into_iter().map(Some).collect();
    Graph { focus: focus_id, nodes: ids.into_iter().filter_map(|n| out[n].take()).collect(), edges: graph_edges, notes }
}

// ---------------------------------------------------------------------------------------------
// The live graph
// ---------------------------------------------------------------------------------------------

/// What its table shows of a row: its first status, else its first ratio ("3/3").
fn status_text(row: &Row, columns: &[Column]) -> String {
    let at = |kind: ColumnKind| columns.iter().position(|c| c.kind == kind).and_then(|i| row.cells.get(i));
    match (at(ColumnKind::Status), at(ColumnKind::Ratio)) {
        (Some(Cell::Status(s, _)), _) => s.clone(),
        (_, Some(Cell::Ratio(a, b))) => format!("{a}/{b}"),
        _ => String::new(),
    }
}

struct Source {
    resource: Arc<str>,
    kind: Arc<str>,
    columns: Vec<Column>,
    lease: FeedLease,
}

/// Parsed objects, kept between graphs while they do not change (by uid: resource version and value).
type Parsed = HashMap<Arc<str>, (String, Arc<Value>)>;

fn send(sink: &Sink, graph: &Graph, loading: bool, error: Option<&str>) -> bool {
    let msg = serde_json::json!({ "t": "graph", "focus": graph.focus, "nodes": graph.nodes, "edges": graph.edges, "notes": graph.notes, "loading": loading, "error": error });
    sink(msg.to_string())
}

/// Leases the feeds a graph of `namespace` (or of the pods on a node) needs on `cluster`.
async fn sources(inner: &Arc<Inner>, cluster: &str, namespace: Option<&str>, node: Option<&str>) -> Result<Vec<Source>, Error> {
    let c = ops::connected(inner, cluster, false).await?;
    let mut out = Vec::new();
    let kinds: &[&str] = if node.is_some() { &["pods"] } else { NAMESPACE_KINDS };
    for key in kinds {
        let Ok(info) = c.resolve(key) else { continue };
        if !info.can("list") || !info.can("watch") {
            continue;
        }
        let ns: Option<Arc<str>> = namespace.map(Arc::from);
        let printer = c.printer_for(&info, std::slice::from_ref(&ns)).await;
        // Helm keeps every revision of a release as a secret (up to a megabyte each): never referred to by a pod, and
        // what would make listing a namespace's secrets heavy.
        let fields: Option<Arc<str>> = match (node, *key) {
            (Some(n), _) => Some(Arc::from(format!("spec.nodeName={n}"))),
            (None, "secrets") => Some(Arc::from("type!=helm.sh/release.v1")),
            _ => None,
        };
        let feed_key = FeedKey { cluster: Arc::from(cluster), resource: Arc::from(info.key.as_str()), namespace: ns, labels: None, fields };
        let renderer = printer.renderer.clone();
        let lease = inner.hub.lease_with(
            feed_key,
            || FeedSpec { client: c.client.clone(), api_resource: info.api_resource(), renderer },
            Lease { fallback: !printer.found, objects: true },
        );
        // Kept warm without their JSON (a problems view, a picker): the specs are what relations are read from.
        inner.hub.fill_json(&lease);
        out.push(Source { resource: Arc::from(info.key.as_str()), kind: Arc::from(info.kind.as_str()), columns: lease.renderer.columns().to_vec(), lease });
    }
    Ok(out)
}

/// Statuses of nodes and volumes, from feeds kept warm elsewhere (a table of nodes left a minute ago): none are leased.
fn elsewhere(inner: &Inner, cluster: &str) -> HashMap<String, (Tone, String)> {
    let mut out = HashMap::new();
    for resource in ["nodes", "persistentvolumes"] {
        let key = FeedKey { cluster: Arc::from(cluster), resource: Arc::from(resource), namespace: None, labels: None, fields: None };
        let Some(rows) = inner.hub.peek(&key) else { continue };
        let columns = render::builtin_for_key(resource).map(|r| r.columns().to_vec()).unwrap_or_default();
        for row in rows {
            out.insert(node_id(resource, None, &row.name), (row.tone, status_text(&row, &columns)));
        }
    }
    out
}

/// Streams the graph around `spec`'s object to `sink` — again whenever what it is built from changes — until cancelled.
pub(crate) async fn run(inner: Arc<Inner>, spec: RelationsSpec, sink: Sink) {
    let empty = Graph { focus: String::new(), nodes: Vec::new(), edges: Vec::new(), notes: Vec::new() };
    // A volume's graph is its claim's (its users), with the volume in it; a node's, the pods on it.
    let (namespace, node, focus_ns) = match spec.resource.as_str() {
        "nodes" => (None, Some(spec.name.clone()), None),
        "persistentvolumes" => {
            let r = crate::object::ObjectRef {
                cluster: spec.cluster.clone(),
                resource: spec.resource.clone(),
                namespace: None,
                name: spec.name.clone(),
                uid: None,
            };
            let claim = match ops::get_object(&inner, &r).await {
                Ok(json) => serde_json::from_str::<Value>(&json).ok().and_then(|v| v.str_at(&["spec", "claimRef", "namespace"]).map(str::to_string)),
                Err(e) => {
                    send(&sink, &empty, false, Some(&e.message()));
                    return;
                }
            };
            match claim {
                Some(ns) => (Some(ns), None, None),
                None => {
                    send(&sink, &empty, false, Some("the volume is not bound to a claim: nothing uses it"));
                    return;
                }
            }
        }
        _ => (spec.namespace.clone(), None, spec.namespace.clone()),
    };
    let sources = match sources(&inner, &spec.cluster, namespace.as_deref(), node.as_deref()).await {
        Ok(s) => s,
        Err(e) => {
            send(&sink, &empty, false, Some(&e.message()));
            return;
        }
    };
    let (tx, mut rx) = mpsc::unbounded_channel::<()>();
    let mut tasks = JoinSet::new();
    for s in &sources {
        let mut events = s.lease.snapshot().rx;
        let tx = tx.clone();
        tasks.spawn(async move {
            loop {
                match events.recv().await {
                    Ok(_) | Err(broadcast::error::RecvError::Lagged(_)) => {
                        if tx.send(()).is_err() {
                            return;
                        }
                    }
                    Err(broadcast::error::RecvError::Closed) => return,
                }
            }
        });
    }
    drop(tx);
    let mut parsed: Parsed = HashMap::new();
    let mut last = String::new();
    loop {
        let (graph, loading, error) = snapshot(&inner, &spec, &sources, &mut parsed, focus_ns.as_deref(), node.as_deref());
        let key = serde_json::to_string(&(&graph, loading, &error)).unwrap_or_default();
        if key != last {
            if !send(&sink, &graph, loading, error.as_deref()) {
                return;
            }
            last = key;
        }
        if rx.recv().await.is_none() {
            return;
        }
        tokio::time::sleep(DEBOUNCE).await;
        while rx.try_recv().is_ok() {}
    }
}

/// The graph as the feeds have it now, whether some are still loading, and why there is none (the object is gone).
fn snapshot(
    inner: &Inner,
    spec: &RelationsSpec,
    sources: &[Source],
    parsed: &mut Parsed,
    focus_ns: Option<&str>,
    node: Option<&str>,
) -> (Graph, bool, Option<String>) {
    let mut items = Vec::new();
    let mut readable = Readable::new();
    let mut notes = Vec::new();
    let mut loading = false;
    let mut alive = HashSet::new();
    for s in sources {
        match s.lease.status() {
            FeedStatus::Ready => {
                readable.insert(s.resource.to_string());
            }
            FeedStatus::Error { message, code, .. } => notes.push(if code == Some(403) {
                format!("No access to {}: what relates to them is not shown", plural(&s.resource))
            } else {
                format!("{} could not be read: {message}", plural(&s.resource))
            }),
            FeedStatus::Loading | FeedStatus::Connecting => loading = true,
        }
        let objects = s.lease.objects();
        if !objects.is_empty() && !s.lease.keeps_all_json() && &*s.resource != "secrets" {
            notes.push(format!("Too many {} here to read them all: some relations may be missing", plural(&s.resource)));
        }
        for (row, json) in objects {
            let obj = json.and_then(|j| {
                if let Some((rv, v)) = parsed.get(&row.uid)
                    && *rv == row.resource_version
                {
                    return Some(v.clone());
                }
                let v: Arc<Value> = Arc::new(serde_json::from_str(&j).ok()?);
                parsed.insert(row.uid.clone(), (row.resource_version.clone(), v.clone()));
                Some(v)
            });
            alive.insert(row.uid.clone());
            let status = status_text(&row, &s.columns);
            items.push(Item { resource: s.resource.clone(), kind: s.kind.clone(), row, obj, status });
        }
    }
    parsed.retain(|uid, _| alive.contains(uid));
    let mut elsewhere = elsewhere(inner, &spec.cluster);
    let mut graph = match node {
        // A node: the pods on it (with their owners); the node itself as a feed elsewhere has it.
        Some(node) => {
            let known = elsewhere.remove(&node_id("nodes", None, node));
            node_graph(&items, node, known)
        }
        None => build(&items, (&spec.resource, if spec.resource == "persistentvolumes" { None } else { focus_ns }, &spec.name), &readable, &elsewhere),
    };
    notes.append(&mut graph.notes);
    graph.notes = notes;
    let error = (graph.focus.is_empty() && !loading).then(|| format!("{} {} is not there (deleted?)", spec.resource, spec.name));
    (graph, loading, error)
}

/// A node's graph: the pods on it, each with its owner (as their references name it: owners in every namespace are
/// not read), the node itself as `known` says. Pods past [`MAX_NODES`] are left out.
fn node_graph(items: &[Item], node: &str, known: Option<(Tone, String)>) -> Graph {
    let focus = outside(Some("nodes"), "Node", None, node, known);
    let mut nodes: Vec<GraphNode> = vec![focus.clone()];
    let mut edges = Vec::new();
    let mut seen: HashSet<String> = HashSet::from([focus.id.clone()]);
    let mut pods: Vec<&Item> = items.iter().filter(|it| &*it.kind == "Pod").collect();
    pods.sort_by(|a, b| (a.row.namespace.as_deref(), &a.row.name).cmp(&(b.row.namespace.as_deref(), &b.row.name)));
    let total = pods.len();
    pods.truncate(MAX_NODES);
    for it in pods {
        let id = it.id();
        let owner = it.obj.as_ref().and_then(|o| {
            let refs = o.arr(&["metadata", "ownerReferences"]);
            refs.iter().find(|r| r.bool_at(&["controller"]) == Some(true)).or(refs.first()).cloned()
        });
        let owner_id = owner.as_ref().map(|r| {
            let kind = r.str_at(&["kind"]).unwrap_or("Owner");
            let ns = if kind == "Node" { None } else { it.row.namespace.as_deref() };
            let n = outside(key_of_kind(kind), kind, ns, r.str_at(&["name"]).unwrap_or_default(), None);
            let oid = n.id.clone();
            if seen.insert(oid.clone()) {
                nodes.push(n);
            }
            edges.push(GraphEdge { from: oid.clone(), to: id.clone(), rel: Rel::Owns, label: None });
            oid
        });
        nodes.push(GraphNode {
            id: id.clone(),
            resource: Some("pods".into()),
            kind: "Pod".into(),
            name: it.row.name.clone(),
            namespace: it.row.namespace.clone(),
            layer: Layer::Pod,
            tone: it.row.tone,
            status: it.status.clone(),
            missing: false,
            optional: false,
            unknown: false,
            more: 0,
            owner: owner_id,
            created: it.row.created,
        });
        edges.push(GraphEdge { from: id, to: focus.id.clone(), rel: Rel::RunsOn, label: None });
    }
    let notes = if total > MAX_NODES { vec![format!("{} more pods run here: the graph shows {MAX_NODES}", total - MAX_NODES)] } else { Vec::new() };
    Graph { focus: focus.id, nodes, edges, notes }
}

fn plural(resource: &str) -> String {
    match resource {
        "persistentvolumeclaims" => "volume claims".into(),
        "horizontalpodautoscalers.autoscaling" => "autoscalers".into(),
        "poddisruptionbudgets.policy" => "disruption budgets".into(),
        "networkpolicies.networking.k8s.io" => "network policies".into(),
        "rolebindings.rbac.authorization.k8s.io" => "role bindings".into(),
        "roles.rbac.authorization.k8s.io" => "roles".into(),
        "serviceaccounts" => "service accounts".into(),
        "configmaps" => "config maps".into(),
        "replicasets.apps" => "replica sets".into(),
        "statefulsets.apps" => "stateful sets".into(),
        "daemonsets.apps" => "daemon sets".into(),
        "cronjobs.batch" => "cron jobs".into(),
        other => other.split('.').next().unwrap_or(other).to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn item(resource: &str, kind: &str, obj: Value) -> Item {
        let renderer = render::builtin_for_key(resource).unwrap_or_else(render::generic);
        let row = Arc::new(render::build_row(&obj, renderer.as_ref()));
        let status = status_text(&row, renderer.columns());
        Item { resource: Arc::from(resource), kind: Arc::from(kind), row, obj: Some(Arc::new(obj)), status }
    }

    fn meta(name: &str, uid: &str, labels: Value) -> Value {
        json!({ "name": name, "namespace": "shop", "uid": uid, "resourceVersion": "1", "creationTimestamp": "2026-10-01T00:00:00Z", "labels": labels })
    }

    fn owned(mut m: Value, kind: &str, name: &str, uid: &str) -> Value {
        m["ownerReferences"] = json!([{ "apiVersion": "apps/v1", "kind": kind, "name": name, "uid": uid, "controller": true }]);
        m
    }

    fn template(sa: &str) -> Value {
        json!({
            "metadata": { "labels": { "app": "web" } },
            "spec": {
                "serviceAccountName": sa,
                "volumes": [
                    { "name": "config", "configMap": { "name": "web-config" } },
                    { "name": "creds", "secret": { "secretName": "web-creds" } },
                    { "name": "data", "persistentVolumeClaim": { "claimName": "web-data" } },
                    { "name": "kube-api-access-x1", "projected": { "sources": [{ "configMap": { "name": "kube-root-ca.crt" } }] } }
                ],
                "containers": [{
                    "name": "web",
                    "volumeMounts": [{ "name": "config", "mountPath": "/etc/app" }],
                    "env": [
                        { "name": "FLAGS", "valueFrom": { "configMapKeyRef": { "name": "feature-flags", "key": "flags", "optional": true } } },
                        { "name": "DB_PASSWORD", "valueFrom": { "secretKeyRef": { "name": "db", "key": "password" } } }
                    ],
                    "envFrom": [{ "configMapRef": { "name": "web-env" } }]
                }]
            }
        })
    }

    fn pod(name: &str, uid: &str, owner: (&str, &str), node: &str, labels: Value) -> Item {
        let mut spec = template("web")["spec"].clone();
        spec["nodeName"] = json!(node);
        item(
            "pods",
            "Pod",
            json!({ "kind": "Pod", "metadata": owned(meta(name, uid, labels), "ReplicaSet", owner.0, owner.1), "spec": spec, "status": { "phase": "Running", "containerStatuses": [{ "name": "web", "ready": true, "restartCount": 0, "state": { "running": {} } }], "conditions": [{ "type": "Ready", "status": "True" }] } }),
        )
    }

    /// A namespace with an app (`web`: ingress, service, deployment, replica set, two pods, its config, claim, account,
    /// autoscaler, budget, policy, role binding, Helm release) and another one sharing a secret.
    fn shop() -> Vec<Item> {
        let web_labels = json!({ "app": "web", "pod-template-hash": "7d9f8c6b5" });
        let mut deploy = meta("web", "d1", json!({ "app": "web", "app.kubernetes.io/managed-by": "Helm" }));
        deploy["annotations"] = json!({ "meta.helm.sh/release-name": "shop", "meta.helm.sh/release-namespace": "shop" });
        let mut other_tpl = template("default");
        other_tpl["spec"]["volumes"] = json!([{ "name": "creds", "secret": { "secretName": "web-creds" } }]);
        other_tpl["spec"]["containers"][0]["env"] = json!([]);
        other_tpl["spec"]["containers"][0]["envFrom"] = json!([]);
        vec![
            item(
                "deployments.apps",
                "Deployment",
                json!({ "kind": "Deployment", "metadata": deploy, "spec": { "replicas": 2, "selector": { "matchLabels": { "app": "web" } }, "template": template("web") }, "status": { "readyReplicas": 2, "availableReplicas": 2, "updatedReplicas": 2 } }),
            ),
            item(
                "replicasets.apps",
                "ReplicaSet",
                json!({ "kind": "ReplicaSet", "metadata": owned(meta("web-7d9f8c6b5", "r1", web_labels.clone()), "Deployment", "web", "d1"), "spec": { "replicas": 2, "template": template("web") }, "status": { "readyReplicas": 2, "replicas": 2 } }),
            ),
            pod("web-7d9f8c6b5-aaaaa", "p1", ("web-7d9f8c6b5", "r1"), "node-1", web_labels.clone()),
            pod("web-7d9f8c6b5-bbbbb", "p2", ("web-7d9f8c6b5", "r1"), "node-2", web_labels.clone()),
            item(
                "services",
                "Service",
                json!({ "kind": "Service", "metadata": meta("web", "s1", json!({})), "spec": { "selector": { "app": "web" }, "ports": [{ "port": 80 }] } }),
            ),
            item(
                "ingresses.networking.k8s.io",
                "Ingress",
                json!({ "kind": "Ingress", "metadata": meta("shop", "i1", json!({})), "spec": { "tls": [{ "hosts": ["shop.example.com"], "secretName": "shop-tls" }], "rules": [{ "host": "shop.example.com", "http": { "paths": [{ "path": "/api", "backend": { "service": { "name": "web", "port": { "number": 80 } } } }] } }] } }),
            ),
            item("configmaps", "ConfigMap", json!({ "kind": "ConfigMap", "metadata": meta("web-config", "c1", json!({})), "data": {} })),
            item("configmaps", "ConfigMap", json!({ "kind": "ConfigMap", "metadata": meta("web-env", "c2", json!({})), "data": {} })),
            item("secrets", "Secret", json!({ "kind": "Secret", "metadata": meta("web-creds", "x1", json!({})), "type": "Opaque" })),
            item("secrets", "Secret", json!({ "kind": "Secret", "metadata": meta("shop-tls", "x2", json!({})), "type": "kubernetes.io/tls" })),
            item(
                "persistentvolumeclaims",
                "PersistentVolumeClaim",
                json!({ "kind": "PersistentVolumeClaim", "metadata": meta("web-data", "v1", json!({})), "spec": { "volumeName": "pv-123", "storageClassName": "fast" }, "status": { "phase": "Bound" } }),
            ),
            item("serviceaccounts", "ServiceAccount", json!({ "kind": "ServiceAccount", "metadata": meta("web", "a1", json!({})) })),
            item("serviceaccounts", "ServiceAccount", json!({ "kind": "ServiceAccount", "metadata": meta("default", "a2", json!({})) })),
            item(
                "rolebindings.rbac.authorization.k8s.io",
                "RoleBinding",
                json!({ "kind": "RoleBinding", "metadata": meta("web-reader", "b1", json!({})), "subjects": [{ "kind": "ServiceAccount", "name": "web", "namespace": "shop" }], "roleRef": { "kind": "ClusterRole", "name": "view" } }),
            ),
            item(
                "horizontalpodautoscalers.autoscaling",
                "HorizontalPodAutoscaler",
                json!({ "kind": "HorizontalPodAutoscaler", "metadata": meta("web", "h1", json!({})), "spec": { "scaleTargetRef": { "kind": "Deployment", "name": "web" }, "minReplicas": 2, "maxReplicas": 10 } }),
            ),
            item(
                "poddisruptionbudgets.policy",
                "PodDisruptionBudget",
                json!({ "kind": "PodDisruptionBudget", "metadata": meta("web", "pdb1", json!({})), "spec": { "minAvailable": 1, "selector": { "matchLabels": { "app": "web" } } } }),
            ),
            item(
                "networkpolicies.networking.k8s.io",
                "NetworkPolicy",
                json!({ "kind": "NetworkPolicy", "metadata": meta("default-deny", "np1", json!({})), "spec": { "podSelector": {} } }),
            ),
            item(
                "deployments.apps",
                "Deployment",
                json!({ "kind": "Deployment", "metadata": meta("other", "d2", json!({ "app": "other" })), "spec": { "replicas": 1, "selector": { "matchLabels": { "app": "other" } }, "template": other_tpl }, "status": {} }),
            ),
        ]
    }

    fn readable_all() -> Readable {
        NAMESPACE_KINDS.iter().map(|k| k.to_string()).collect()
    }

    fn ids(g: &Graph) -> HashSet<&str> {
        g.nodes.iter().map(|n| n.id.as_str()).collect()
    }

    fn edge<'a>(g: &'a Graph, from: &str, to: &str) -> Option<&'a GraphEdge> {
        g.edges.iter().find(|e| e.from == from && e.to == to)
    }

    #[test]
    fn a_deployment_shows_its_app_and_what_it_uses_but_not_who_else_uses_it() {
        let g = build(&shop(), ("deployments.apps", Some("shop"), "web"), &readable_all(), &HashMap::new());
        assert_eq!(g.focus, "deployments.apps/shop/web");
        let got = ids(&g);
        for want in [
            "replicasets.apps/shop/web-7d9f8c6b5",
            "pods/shop/web-7d9f8c6b5-aaaaa",
            "pods/shop/web-7d9f8c6b5-bbbbb",
            "services/shop/web",
            "ingresses.networking.k8s.io/shop/shop",
            "secrets/shop/shop-tls",
            "configmaps/shop/web-config",
            "configmaps/shop/web-env",
            "configmaps/shop/feature-flags",
            "secrets/shop/web-creds",
            "secrets/shop/db",
            "persistentvolumeclaims/shop/web-data",
            "persistentvolumes//pv-123",
            "storageclasses.storage.k8s.io//fast",
            "serviceaccounts/shop/web",
            "rolebindings.rbac.authorization.k8s.io/shop/web-reader",
            "clusterroles.rbac.authorization.k8s.io//view",
            "horizontalpodautoscalers.autoscaling/shop/web",
            "poddisruptionbudgets.policy/shop/web",
            "networkpolicies.networking.k8s.io/shop/default-deny",
            "nodes//node-1",
            "nodes//node-2",
            "helmreleases/shop/shop",
        ] {
            assert!(got.contains(want), "{want} missing from {got:?}");
        }
        // The other app shares a secret: a leaf, it does not bring that app along.
        assert!(!got.contains("deployments.apps/shop/other"));
        // The token volume every pod gets is no relation.
        assert!(!got.iter().any(|id| id.contains("kube-root-ca")));

        let rel = |from: &str, to: &str| edge(&g, from, to).map(|e| (e.rel, e.label.clone()));
        assert_eq!(rel("deployments.apps/shop/web", "replicasets.apps/shop/web-7d9f8c6b5"), Some((Rel::Owns, None)));
        assert_eq!(rel("ingresses.networking.k8s.io/shop/shop", "services/shop/web"), Some((Rel::Routes, Some("shop.example.com/api".into()))));
        assert_eq!(rel("ingresses.networking.k8s.io/shop/shop", "secrets/shop/shop-tls"), Some((Rel::Tls, Some("shop.example.com".into()))));
        assert_eq!(rel("services/shop/web", "pods/shop/web-7d9f8c6b5-aaaaa"), Some((Rel::Selects, None)));
        // What the template uses hangs off the deployment, not off each pod.
        assert_eq!(rel("deployments.apps/shop/web", "configmaps/shop/web-config"), Some((Rel::Mounts, Some("/etc/app".into()))));
        assert_eq!(rel("deployments.apps/shop/web", "configmaps/shop/web-env"), Some((Rel::Env, Some("all keys".into()))));
        assert_eq!(rel("deployments.apps/shop/web", "serviceaccounts/shop/web"), Some((Rel::RunsAs, None)));
        assert!(edge(&g, "pods/shop/web-7d9f8c6b5-aaaaa", "configmaps/shop/web-config").is_none());
        assert_eq!(rel("pods/shop/web-7d9f8c6b5-aaaaa", "nodes//node-1"), Some((Rel::RunsOn, None)));
        assert_eq!(rel("horizontalpodautoscalers.autoscaling/shop/web", "deployments.apps/shop/web"), Some((Rel::Scales, Some("2–10".into()))));
        assert_eq!(rel("poddisruptionbudgets.policy/shop/web", "pods/shop/web-7d9f8c6b5-bbbbb"), Some((Rel::Protects, None)));
        assert_eq!(rel("networkpolicies.networking.k8s.io/shop/default-deny", "pods/shop/web-7d9f8c6b5-aaaaa"), Some((Rel::Isolates, None)));
        assert_eq!(rel("rolebindings.rbac.authorization.k8s.io/shop/web-reader", "serviceaccounts/shop/web"), Some((Rel::Subject, None)));
        assert_eq!(rel("rolebindings.rbac.authorization.k8s.io/shop/web-reader", "clusterroles.rbac.authorization.k8s.io//view"), Some((Rel::Grants, None)));
        assert_eq!(rel("persistentvolumeclaims/shop/web-data", "persistentvolumes//pv-123"), Some((Rel::Bound, None)));
        assert_eq!(rel("helmreleases/shop/shop", "deployments.apps/shop/web"), Some((Rel::Manages, None)));

        let node = |id: &str| g.nodes.iter().find(|n| n.id == id).unwrap();
        // Missing: an error unless every reference says it may be.
        assert!(node("secrets/shop/db").missing && node("secrets/shop/db").tone == Tone::Error);
        assert!(
            node("configmaps/shop/feature-flags").missing
                && node("configmaps/shop/feature-flags").optional
                && node("configmaps/shop/feature-flags").tone == Tone::Neutral
        );
        assert_eq!(node("pods/shop/web-7d9f8c6b5-aaaaa").owner.as_deref(), Some("replicasets.apps/shop/web-7d9f8c6b5"));
        assert_eq!((node("deployments.apps/shop/web").status.as_str(), node("deployments.apps/shop/web").tone), ("2/2", Tone::Ok));
        assert_eq!(node("pods/shop/web-7d9f8c6b5-aaaaa").status, "Running");
    }

    #[test]
    fn a_shared_secret_shows_every_app_that_uses_it() {
        let g = build(&shop(), ("secrets", Some("shop"), "web-creds"), &readable_all(), &HashMap::new());
        let got = ids(&g);
        assert!(got.contains("deployments.apps/shop/web") && got.contains("deployments.apps/shop/other"));
        // Each user with its app: the web pods behind it, the service in front.
        assert!(got.contains("pods/shop/web-7d9f8c6b5-aaaaa") && got.contains("services/shop/web"));
        assert_eq!(edge(&g, "deployments.apps/shop/other", "secrets/shop/web-creds").map(|e| e.rel), Some(Rel::Mounts));
    }

    #[test]
    fn a_pod_shows_its_owners_siblings_and_what_its_template_uses() {
        let g = build(&shop(), ("pods", Some("shop"), "web-7d9f8c6b5-aaaaa"), &readable_all(), &HashMap::new());
        let got = ids(&g);
        for want in [
            "replicasets.apps/shop/web-7d9f8c6b5",
            "deployments.apps/shop/web",
            "pods/shop/web-7d9f8c6b5-bbbbb",
            "services/shop/web",
            "configmaps/shop/web-config",
            "nodes//node-1",
        ] {
            assert!(got.contains(want), "{want} missing");
        }
    }

    #[test]
    fn kinds_that_could_not_be_read_make_unknown_references_not_missing_ones() {
        let mut readable = readable_all();
        readable.remove("secrets");
        let g = build(&shop(), ("deployments.apps", Some("shop"), "web"), &readable, &HashMap::new());
        let db = g.nodes.iter().find(|n| n.id == "secrets/shop/db").unwrap();
        assert!(db.unknown && !db.missing && db.tone == Tone::Neutral);
    }

    #[test]
    fn many_pods_of_one_owner_are_cut_down_those_in_trouble_kept() {
        let mut items = shop();
        let labels = json!({ "app": "web", "pod-template-hash": "7d9f8c6b5" });
        for i in 0..30 {
            items.push(pod(&format!("web-7d9f8c6b5-x{i:04}"), &format!("px{i}"), ("web-7d9f8c6b5", "r1"), "node-1", labels.clone()));
        }
        // One of them failing.
        let mut failing = pod("web-7d9f8c6b5-zzzzz", "pz", ("web-7d9f8c6b5", "r1"), "node-3", labels.clone());
        let mut row = (*failing.row).clone();
        row.tone = Tone::Error;
        failing.row = Arc::new(row);
        items.push(failing);
        let g = build(&items, ("deployments.apps", Some("shop"), "web"), &readable_all(), &HashMap::new());
        let pods: Vec<&GraphNode> = g.nodes.iter().filter(|n| n.kind == "Pod").collect();
        assert_eq!(pods.len(), MAX_PODS_PER_OWNER);
        assert!(pods.iter().any(|p| p.name == "web-7d9f8c6b5-zzzzz"), "the failing one stays");
        let rs = g.nodes.iter().find(|n| n.kind == "ReplicaSet").unwrap();
        assert_eq!(rs.more, 33 - MAX_PODS_PER_OWNER);
        // Nodes only the pods left out ran on go too; edges only between nodes kept.
        assert!(g.edges.iter().all(|e| g.nodes.iter().any(|n| n.id == e.from) && g.nodes.iter().any(|n| n.id == e.to)));
    }

    #[test]
    fn a_volume_shows_its_claim_and_who_uses_it() {
        let g = build(&shop(), ("persistentvolumes", None, "pv-123"), &readable_all(), &HashMap::new());
        assert_eq!(g.focus, "persistentvolumes//pv-123");
        let got = ids(&g);
        assert!(got.contains("persistentvolumeclaims/shop/web-data") && got.contains("deployments.apps/shop/web"));
    }

    #[test]
    fn a_node_shows_the_pods_on_it_with_their_owners() {
        let items: Vec<Item> = shop().into_iter().filter(|it| &*it.kind == "Pod").collect();
        let g = node_graph(&items, "node-1", Some((Tone::Ok, "Ready".into())));
        assert_eq!(g.focus, "nodes//node-1");
        assert_eq!(g.nodes[0].status, "Ready");
        assert!(ids(&g).contains("replicasets.apps/shop/web-7d9f8c6b5"));
        assert_eq!(edge(&g, "pods/shop/web-7d9f8c6b5-aaaaa", "nodes//node-1").map(|e| e.rel), Some(Rel::RunsOn));
    }

    #[test]
    fn selectors_match_like_the_api_server() {
        let labels: HashMap<&str, &str> = HashMap::from([("app", "web"), ("tier", "api")]);
        let sel = |v: Value| selects(Some(&v), &labels);
        assert!(sel(json!({})));
        assert!(sel(json!({ "matchLabels": { "app": "web" } })));
        assert!(!sel(json!({ "matchLabels": { "app": "db" } })));
        assert!(sel(json!({ "matchExpressions": [{ "key": "tier", "operator": "In", "values": ["api", "web"] }] })));
        assert!(!sel(json!({ "matchExpressions": [{ "key": "tier", "operator": "NotIn", "values": ["api"] }] })));
        assert!(sel(json!({ "matchExpressions": [{ "key": "zone", "operator": "DoesNotExist" }] })));
        assert!(!sel(json!({ "matchExpressions": [{ "key": "zone", "operator": "Exists" }] })));
        // A service without a selector selects nothing.
        assert!(!service_selects(&json!({ "spec": {} }), &labels));
    }
}
