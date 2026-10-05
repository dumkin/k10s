// The mock engine's graphs of relations: made from its generated objects by their app label and naming conventions
// (`payments-api` has a `payments-api` service, `payments-api-config`, `payments-api-credentials`…), as the engine would
// find them by owner references, selectors and pod specs. Dev only.

import { type GraphEdge, type GraphLayer, type GraphMessage, type GraphNode, type GraphRel, type RelationsSpec, type Row, Tone } from "./types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Obj = Record<string, any>;
export interface MockItem {
  row: Row;
  obj: Obj;
}

const LAYER: Record<string, GraphLayer> = {
  helmreleases: "release",
  "ingresses.networking.k8s.io": "traffic",
  services: "service",
  "horizontalpodautoscalers.autoscaling": "policy",
  "poddisruptionbudgets.policy": "policy",
  "networkpolicies.networking.k8s.io": "policy",
  "deployments.apps": "workload",
  "statefulsets.apps": "workload",
  "replicasets.apps": "replica",
  pods: "pod",
  configmaps: "config",
  secrets: "config",
  persistentvolumeclaims: "storage",
  persistentvolumes: "storage",
  "storageclasses.storage.k8s.io": "storage",
  serviceaccounts: "identity",
  "rolebindings.rbac.authorization.k8s.io": "identity",
  "clusterroles.rbac.authorization.k8s.io": "identity",
  nodes: "node",
};

const KIND: Record<string, string> = {
  helmreleases: "Helm release",
  "ingresses.networking.k8s.io": "Ingress",
  services: "Service",
  "horizontalpodautoscalers.autoscaling": "HorizontalPodAutoscaler",
  "poddisruptionbudgets.policy": "PodDisruptionBudget",
  "networkpolicies.networking.k8s.io": "NetworkPolicy",
  "deployments.apps": "Deployment",
  "statefulsets.apps": "StatefulSet",
  "replicasets.apps": "ReplicaSet",
  pods: "Pod",
  configmaps: "ConfigMap",
  secrets: "Secret",
  persistentvolumeclaims: "PersistentVolumeClaim",
  persistentvolumes: "PersistentVolume",
  "storageclasses.storage.k8s.io": "StorageClass",
  serviceaccounts: "ServiceAccount",
  "rolebindings.rbac.authorization.k8s.io": "RoleBinding",
  "clusterroles.rbac.authorization.k8s.io": "ClusterRole",
  nodes: "Node",
};

const CLUSTER_SCOPED = new Set(["nodes", "persistentvolumes", "storageclasses.storage.k8s.io", "clusterroles.rbac.authorization.k8s.io"]);
const id = (resource: string, ns: string | null | undefined, name: string) => `${resource}/${CLUSTER_SCOPED.has(resource) ? "" : (ns ?? "")}/${name}`;

/** Web-facing apps get an ingress in front of their service. */
const PUBLIC = /-(api|web)$|^grafana$|^search-api$/;

function statusOf(row: Row): string {
  for (const c of row.c) if (Array.isArray(c) && typeof c[0] === "string") return c[0];
  for (const c of row.c) if (Array.isArray(c) && typeof c[0] === "number" && typeof c[1] === "number") return `${c[0]}/${c[1]}`;
  return "";
}

/** The graph of `spec`'s object among `data` (resource key → its items in the cluster). */
export function mockGraph(spec: RelationsSpec, data: (resource: string) => MockItem[]): GraphMessage {
  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];
  const notes: string[] = [];
  const add = (n: Omit<GraphNode, "id" | "layer" | "kind"> & { resource: string; kind?: string }) => {
    const nid = id(n.resource, n.namespace, n.name);
    if (!nodes.has(nid)) nodes.set(nid, { ...n, id: nid, kind: n.kind ?? KIND[n.resource] ?? n.resource, layer: LAYER[n.resource] ?? "workload" });
    return nid;
  };
  const fromItem = (resource: string, it: MockItem) => add({ resource, name: it.row.n, namespace: it.row.ns, tone: it.row.s, status: statusOf(it.row), created: it.row.t });
  const link = (from: string, to: string, rel: GraphRel, label?: string) => edges.push({ from, to, rel, label });

  // The app the object belongs to, by convention.
  const find = (resource: string, name: string, ns?: string | null) => data(resource).find((it) => it.row.n === name && (it.row.ns ?? null) === (ns ?? null));
  const focusItem = find(spec.resource, spec.name, CLUSTER_SCOPED.has(spec.resource) ? null : spec.namespace);
  if (spec.resource === "nodes") return nodeGraph(spec, data);
  const ns = spec.namespace ?? "";
  let app: string | undefined = focusItem?.obj?.metadata?.labels?.app;
  if (spec.resource === "configmaps") app = spec.name.replace(/-config$/, "");
  if (spec.resource === "secrets") app = spec.name.replace(/-credentials$/, "");
  if (["services", "serviceaccounts", "horizontalpodautoscalers.autoscaling", "poddisruptionbudgets.policy", "deployments.apps", "statefulsets.apps"].includes(spec.resource)) app = spec.name;
  if (!app || !find("deployments.apps", app, ns)) {
    // Not one of the generated apps: the object alone.
    if (focusItem) {
      const f = fromItem(spec.resource, focusItem);
      return { t: "graph", focus: f, nodes: [...nodes.values()], edges, notes: ["(mock) no relations are generated for this object"], loading: false };
    }
    return { t: "graph", focus: "", nodes: [], edges: [], notes: [], loading: false, error: `${spec.resource} ${spec.name} is not there (deleted?)` };
  }

  const deploy = find("deployments.apps", app, ns)!;
  const d = fromItem("deployments.apps", deploy);
  const helm = ns === "monitoring" ? "kube-prometheus-stack" : ["payments", "checkout", "search"].includes(ns) ? ns : undefined;
  if (helm) link(add({ resource: "helmreleases", name: helm, namespace: ns, tone: Tone.Ok, status: "deployed" }), d, "manages");

  // Replica sets by pod-template-hash; the pods of each.
  const pods = data("pods").filter((p) => p.row.ns === ns && p.obj.metadata?.labels?.app === app);
  const byHash = new Map<string, MockItem[]>();
  for (const p of pods) {
    const h = p.obj.metadata.labels["pod-template-hash"] ?? "x";
    byHash.set(h, [...(byHash.get(h) ?? []), p]);
  }
  // The generated pods carry a hash each: the newest replica set gets them all, the one before none.
  const current = `${app}-${[...byHash.keys()][0] ?? "7d9f8c6b5"}`.slice(0, 63);
  const rs = add({ resource: "replicasets.apps", name: current, namespace: ns, tone: deploy.row.s, status: statusOf(deploy.row) });
  const old = add({ resource: "replicasets.apps", name: `${app}-58d4c9f7b6`, namespace: ns, tone: Tone.Muted, status: "0/0" });
  link(d, rs, "owns");
  link(d, old, "owns");
  const shown = pods.slice(0, 12);
  for (const p of shown) {
    const pid = add({ resource: "pods", name: p.row.n, namespace: ns, tone: p.row.s, status: statusOf(p.row), owner: rs, created: p.row.t });
    link(rs, pid, "owns");
    const node = p.obj.spec?.nodeName;
    if (node) link(pid, add({ resource: "nodes", name: node, tone: Tone.Ok, status: "Ready" }), "runsOn");
  }
  if (pods.length > shown.length) nodes.get(rs)!.more = pods.length - shown.length;

  // In front: the service selecting the pods, an ingress routing to it.
  const svc = find("services", app, ns);
  if (svc) {
    const s = fromItem("services", svc);
    for (const p of shown) link(s, id("pods", ns, p.row.n), "selects");
    if (PUBLIC.test(app)) {
      const ing = add({ resource: "ingresses.networking.k8s.io", name: ns, namespace: ns, tone: Tone.Neutral, status: "" });
      link(ing, s, "routes", `${ns}.acme.dev/${app.replace(/^.*-/, "")}`);
      link(ing, add({ resource: "secrets", name: `${ns}-tls`, namespace: ns, tone: Tone.Neutral, status: "kubernetes.io/tls" }), "tls", `${ns}.acme.dev`);
    }
  }
  // Policies on it.
  if (pods.length > 2) link(add({ resource: "horizontalpodautoscalers.autoscaling", name: app, namespace: ns, tone: Tone.Neutral, status: "" }), d, "scales", `2–${pods.length + 4}`);
  const pdb = add({ resource: "poddisruptionbudgets.policy", name: app, namespace: ns, tone: Tone.Ok, status: "1" });
  for (const p of shown) link(pdb, id("pods", ns, p.row.n), "protects");
  if (ns === "payments") {
    const np = add({ resource: "networkpolicies.networking.k8s.io", name: "default-deny", namespace: ns, tone: Tone.Neutral, status: "" });
    for (const p of shown) link(np, id("pods", ns, p.row.n), "isolates");
  }

  // What its template uses: config, its credentials (and a secret it names that is gone), its account and claim.
  const cm = find("configmaps", `${app}-config`, ns);
  if (cm) {
    link(d, fromItem("configmaps", cm), "mounts", "/etc/app");
    link(d, id("configmaps", ns, cm.row.n), "env", "all keys");
  }
  link(d, add({ resource: "configmaps", name: "feature-flags", namespace: ns, tone: Tone.Neutral, status: "", missing: true, optional: true }), "env", "env FEATURE_FLAGS");
  const creds = find("secrets", `${app}-credentials`, ns);
  if (creds) link(d, fromItem("secrets", creds), "env", "env DB_PASSWORD");
  if (app === "checkout-web") link(d, add({ resource: "secrets", name: "stripe-keys", namespace: ns, tone: Tone.Error, status: "", missing: true }), "env", "env STRIPE_KEY");
  link(d, add({ resource: "secrets", name: "registry-pull", namespace: ns, tone: Tone.Neutral, status: "kubernetes.io/dockerconfigjson" }), "pulls");
  const sa = add({ resource: "serviceaccounts", name: app, namespace: ns, tone: Tone.Neutral, status: "" });
  link(d, sa, "runsAs");
  const rb = add({ resource: "rolebindings.rbac.authorization.k8s.io", name: `${app}-view`, namespace: ns, tone: Tone.Neutral, status: "" });
  link(rb, sa, "subject");
  link(rb, add({ resource: "clusterroles.rbac.authorization.k8s.io", name: "view", tone: Tone.Neutral, status: "" }), "grants");
  if (ns === "monitoring" || app === "ledger") {
    const pvc = add({ resource: "persistentvolumeclaims", name: `${app}-data`, namespace: ns, tone: Tone.Ok, status: "Bound" });
    link(d, pvc, "mounts", "/var/lib/data");
    link(pvc, add({ resource: "persistentvolumes", name: `pvc-${app.length}f3a9c2e-71d4`, tone: Tone.Ok, status: "Bound" }), "bound");
    link(pvc, add({ resource: "storageclasses.storage.k8s.io", name: "fast-ssd", tone: Tone.Neutral, status: "" }), "class");
  }

  // The focus, as the generated objects call it.
  const focus = focusItem ? id(spec.resource, CLUSTER_SCOPED.has(spec.resource) ? null : ns, spec.name) : d;
  if (!nodes.has(focus) && focusItem) fromItem(spec.resource, focusItem);
  if (!nodes.has(focus)) notes.push("(mock) the object is not part of its app's generated graph");
  return { t: "graph", focus: nodes.has(focus) ? focus : d, nodes: [...nodes.values()], edges, notes, loading: false };
}

/** A node's graph: the pods on it with their owners. */
function nodeGraph(spec: RelationsSpec, data: (resource: string) => MockItem[]): GraphMessage {
  const node = data("nodes").find((n) => n.row.n === spec.name);
  const nid = id("nodes", null, spec.name);
  const nodes: GraphNode[] = [{ id: nid, resource: "nodes", kind: "Node", name: spec.name, layer: "node", tone: node?.row.s ?? Tone.Neutral, status: node ? statusOf(node.row) : "" }];
  const edges: GraphEdge[] = [];
  const owners = new Set<string>();
  for (const p of data("pods").filter((p) => p.obj.spec?.nodeName === spec.name).slice(0, 60)) {
    const ref = p.obj.metadata.ownerReferences?.[0];
    const owner = ref ? id(ref.kind === "Job" ? "jobs.batch" : "replicasets.apps", p.row.ns, ref.name) : undefined;
    if (ref && owner && !owners.has(owner)) {
      owners.add(owner);
      nodes.push({ id: owner, resource: ref.kind === "Job" ? "jobs.batch" : "replicasets.apps", kind: ref.kind, name: ref.name, namespace: p.row.ns, layer: "replica", tone: Tone.Neutral });
    }
    const pid = id("pods", p.row.ns, p.row.n);
    nodes.push({ id: pid, resource: "pods", kind: "Pod", name: p.row.n, namespace: p.row.ns, layer: "pod", tone: p.row.s, status: statusOf(p.row), owner });
    if (owner) edges.push({ from: owner, to: pid, rel: "owns" });
    edges.push({ from: pid, to: nid, rel: "runsOn" });
  }
  return { t: "graph", focus: nid, nodes, edges, notes: [], loading: false };
}
