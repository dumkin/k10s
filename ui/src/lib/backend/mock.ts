// Dev-only fake engine: lets the UI be developed and reviewed in a plain browser (`npm run dev`)
// with realistic multi-cluster data and live updates. Never loaded inside the desktop app.

import { getAt, isObject, setAt } from "../persist";
import type { Backend, LogLevel } from "./index";
import { HELM_COLUMNS, mockReleases, releaseDetails, releaseDiff, releaseRow, rollBack } from "./mockHelm";
import { mockGraph } from "./mockRelations";
import { fakeShell } from "./mockTerminal";
import {
  type AccessCheck,
  type AccessDecision,
  type AccessRules,
  type AppInfo,
  type Cell,
  type ClusterInfo,
  type Column,
  type ContextList,
  type DebugSpec,
  type EngineEvent,
  type ForwardInfo,
  type ForwardSpec,
  type GraphMessage,
  type HelmDiff,
  type HelmRelease,
  type HubStats,
  type LogLine,
  type LogMessage,
  type LogSpec,
  type LogSubscription,
  type LogTarget,
  type MetricsHistory,
  type MetricsKind,
  type MetricsMessage,
  type MetricsSpec,
  type NodeShellSpec,
  type ObjectRef,
  type OpResult,
  type PrefsChange,
  type PrefsDoc,
  type PrefsSnapshot,
  type RelationsSpec,
  type ResourceInfo,
  type Row,
  type Settings,
  type SettingsChange,
  type Subscription,
  type TermMessage,
  type TermSession,
  type TermSpec,
  Tone,
  type UpdateInfo,
  type ViewBatch,
  type ViewMessage,
  type ViewSpec,
} from "./types";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const now = () => Math.floor(Date.now() / 1000);

let seed = 42;
function rnd() {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
}
const pick = <T,>(xs: readonly T[]) => xs[Math.floor(rnd() * xs.length)];
const hex = (n: number) => Array.from({ length: n }, () => "0123456789abcdef"[Math.floor(rnd() * 16)]).join("");
const alnum = (n: number) => Array.from({ length: n }, () => "bcdfghjklmnpqrstvwxz2456789"[Math.floor(rnd() * 27)]).join("");
const uid = () => `${hex(8)}-${hex(4)}-${hex(4)}-${hex(4)}-${hex(12)}`;

// ---------------------------------------------------------------------------------------------
// Fixture: clusters, namespaces, apps
// ---------------------------------------------------------------------------------------------

const ZONES = ["z1", "z2", "z3", "z4"];
/** `?wide`: one more zone family, of many zones with uneven names (a fleet of DCs), for layout work. */
const WIDE_FAMILY = (() => {
  try {
    return new URLSearchParams(location.search).has("wide");
  } catch {
    return false;
  }
})();
const CONTEXTS = [
  ...ZONES.map((z) => `acme-prod-apps-${z}`),
  ...ZONES.slice(0, 3).map((z) => `acme-prod-db-${z}`),
  "acme-prod-global",
  "acme-stage",
  "acme-dev",
  "kind-local",
  "legacy-onprem",
  ...(WIDE_FAMILY ? ["z1", "z2", "z3", "z7", "z12", "z31", "z104", "z256"].map((z) => `acme-prod-search-eu01-${z}`) : []),
];
const UNREACHABLE = new Set(["legacy-onprem"]);
/** Strict RBAC like many corporate clusters: no cluster-wide lists, no namespace listing. */
const RESTRICTED = (cluster: string) => cluster.startsWith("acme-prod-db");
const ALLOWED_NAMESPACES = new Set(["payments", "monitoring"]);
const forbidden = (resource: string, ns: string | null) =>
  `${resource.split(".")[0]} is forbidden: User "jane" cannot list resource "${resource.split(".")[0]}" in API group "${resource.split(".").slice(1).join(".")}" ${ns ? `in the namespace "${ns}"` : "at the cluster scope"}: no RBAC policy matched`;

/**
 * What "jane" may do (RBAC), as access reviews answer it: strict-RBAC clusters let her read her namespaces and their
 * logs; production lets app teams change their own namespaces but not nodes or kube-system, and payments is frozen
 * in z3 (read-only there: one zone of the family differs); staging, dev and kind let her do anything.
 */
function mockAllowed(cluster: string, c: AccessCheck): boolean {
  const read = ["get", "list", "watch"].includes(c.verb);
  const what = c.subresource ? `${c.resource}/${c.subresource}` : c.resource;
  if (RESTRICTED(cluster)) return !!c.namespace && ALLOWED_NAMESPACES.has(c.namespace) && ((read && c.resource !== "secrets" && !c.subresource) || what === "pods/log");
  if (!cluster.startsWith("acme-prod")) return true;
  if (read) return true;
  if (c.resource === "nodes" || c.namespace === "kube-system") return false;
  return !(cluster === "acme-prod-apps-z3" && c.namespace === "payments");
}

const APPS: Record<string, string[]> = {
  payments: ["payments-api", "payments-worker", "ledger"],
  checkout: ["checkout-web", "cart", "pricing", "promo-engine"],
  search: ["search-api", "indexer", "suggest"],
  "kube-system": ["coredns", "metrics-server", "kube-state-metrics"],
  monitoring: ["prometheus", "grafana", "alertmanager", "vector"],
  "ingress-nginx": ["ingress-nginx-controller"],
  default: ["hello-world"],
};
const BATCH_NS = "batch-jobs";
const NAMESPACES = [...Object.keys(APPS), BATCH_NS];

/**
 * Scale knob for performance work: `?ns=8000` gives every app cluster that many extra namespaces
 * (mostly shared across clusters, like per-DC clusters of one fleet) and keeps some of them changing.
 */
const EXTRA_NAMESPACES = (() => {
  try {
    return Math.min(50_000, Math.max(0, Math.floor(Number(new URLSearchParams(location.search).get("ns")) || 0)));
  } catch {
    return 0;
  }
})();
/**
 * First-run states of the welcome screen: `?kubeconfig=nocurrent` (no current-context), `missing` (no file),
 * `empty` (a file without contexts), `invalid` (a file that does not parse).
 */
const KUBECONFIG_CASE = (() => {
  try {
    return new URLSearchParams(location.search).get("kubeconfig") ?? "";
  } catch {
    return "";
  }
})();
/** `?update`: a newer release is out (the update check finds it, downloads it, and "installing" reloads the page). */
const UPDATE = (() => {
  try {
    return new URLSearchParams(location.search).has("update");
  } catch {
    return false;
  }
})();
const MOCK_RELEASE: UpdateInfo = {
  version: "0.2.0",
  current: "0.1.0-mock",
  date: Math.floor(Date.now() / 1000) - 3 * 3600,
  notes: "Edit and apply YAML with a server-side dry-run diff.",
  page: null,
  ready: false,
};
let mockDownloaded = false;
const TEAMS = ["orders", "cart", "search", "billing", "auth", "notify", "media", "geo", "promo", "users", "ledger", "chat"];
const ROLES = ["api", "worker", "cron", "gateway", "sync", "admin", "bff", "events"];
const extraNamespace = (i: number) => `${TEAMS[i % TEAMS.length]}-${ROLES[Math.floor(i / TEAMS.length) % ROLES.length]}-${i}`;
const IMAGES: Record<string, string> = {
  coredns: "registry.k8s.io/coredns/coredns:v1.11.3",
  "metrics-server": "registry.k8s.io/metrics-server/metrics-server:v0.7.2",
  prometheus: "quay.io/prometheus/prometheus:v3.1.0",
  grafana: "grafana/grafana:11.4.0",
  "ingress-nginx-controller": "registry.k8s.io/ingress-nginx/controller:v1.12.0",
};
const imageFor = (app: string) => IMAGES[app] ?? `registry.acme.dev/${app}:v${1 + Math.floor(rnd() * 3)}.${Math.floor(rnd() * 20)}.${Math.floor(rnd() * 9)}`;

const hashStr = (s: string) => [...s].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) | 0, 7) >>> 0;

/**
 * A workload as every zone of a family runs it — the same image and replicas everywhere — but for the zones that
 * drifted apart (for Compare): one left behind by an upgrade, a bad image rolled out in one zone only, one scaled up.
 */
function workloadIn(app: string, cluster: string): { image: string; replicas: number } {
  const h = hashStr(app);
  let image = IMAGES[app] ?? `registry.acme.dev/${app}:v${1 + (h % 3)}.${(h >>> 3) % 20}.${(h >>> 8) % 9}`;
  let replicas = 2 + (h % 4);
  const zone = cluster.slice(-2);
  if (app === "checkout-web" && zone === "z2") image = image.replace(/:v.*$/, ":v2.14.0-rc1");
  if (app === "pricing" && zone === "z3") image = image.replace(/\.(\d+)\.(\d+)$/, (_, minor: string) => `.${Math.max(0, Number(minor) - 1)}.0`);
  if (app === "search-api" && zone === "z3") replicas += 2;
  return { image, replicas };
}

function res(group: string, version: string, kind: string, plural: string, namespaced: boolean, shortNames: string[] = [], subresources: string[] = []): ResourceInfo {
  return {
    key: group ? `${plural}.${group}` : plural,
    group,
    version,
    kind,
    plural,
    singular: kind.toLowerCase(),
    namespaced,
    verbs: ["create", "delete", "get", "list", "patch", "update", "watch"],
    shortNames,
    categories: [],
    subresources,
  };
}

const RESOURCES: ResourceInfo[] = [
  res("", "v1", "Pod", "pods", true, ["po"], ["log", "exec", "portforward", "status"]),
  res("apps", "v1", "Deployment", "deployments", true, ["deploy"], ["scale", "status"]),
  res("apps", "v1", "StatefulSet", "statefulsets", true, ["sts"], ["scale", "status"]),
  res("apps", "v1", "DaemonSet", "daemonsets", true, ["ds"], ["status"]),
  res("apps", "v1", "ReplicaSet", "replicasets", true, ["rs"], ["scale", "status"]),
  res("batch", "v1", "Job", "jobs", true, [], ["status"]),
  res("batch", "v1", "CronJob", "cronjobs", true, ["cj"], ["status"]),
  res("", "v1", "Service", "services", true, ["svc"]),
  res("networking.k8s.io", "v1", "Ingress", "ingresses", true, ["ing"]),
  res("networking.k8s.io", "v1", "IngressClass", "ingressclasses", false),
  res("networking.k8s.io", "v1", "NetworkPolicy", "networkpolicies", true, ["netpol"]),
  res("", "v1", "Endpoints", "endpoints", true, ["ep"]),
  res("discovery.k8s.io", "v1", "EndpointSlice", "endpointslices", true),
  res("", "v1", "ConfigMap", "configmaps", true, ["cm"]),
  res("", "v1", "Secret", "secrets", true),
  res("autoscaling", "v2", "HorizontalPodAutoscaler", "horizontalpodautoscalers", true, ["hpa"]),
  res("policy", "v1", "PodDisruptionBudget", "poddisruptionbudgets", true, ["pdb"]),
  res("", "v1", "ResourceQuota", "resourcequotas", true, ["quota"]),
  res("", "v1", "LimitRange", "limitranges", true, ["limits"]),
  res("scheduling.k8s.io", "v1", "PriorityClass", "priorityclasses", false, ["pc"]),
  res("coordination.k8s.io", "v1", "Lease", "leases", true),
  res("", "v1", "PersistentVolumeClaim", "persistentvolumeclaims", true, ["pvc"]),
  res("", "v1", "PersistentVolume", "persistentvolumes", false, ["pv"]),
  res("storage.k8s.io", "v1", "StorageClass", "storageclasses", false, ["sc"]),
  res("", "v1", "ServiceAccount", "serviceaccounts", true, ["sa"]),
  res("rbac.authorization.k8s.io", "v1", "Role", "roles", true),
  res("rbac.authorization.k8s.io", "v1", "RoleBinding", "rolebindings", true),
  res("rbac.authorization.k8s.io", "v1", "ClusterRole", "clusterroles", false),
  res("rbac.authorization.k8s.io", "v1", "ClusterRoleBinding", "clusterrolebindings", false),
  res("", "v1", "Node", "nodes", false, ["no"]),
  res("", "v1", "Namespace", "namespaces", false, ["ns"]),
  res("", "v1", "Event", "events", true, ["ev"]),
  res("apiextensions.k8s.io", "v1", "CustomResourceDefinition", "customresourcedefinitions", false, ["crd", "crds"]),
  res("cert-manager.io", "v1", "Certificate", "certificates", true, ["cert", "certs"]),
  res("cert-manager.io", "v1", "ClusterIssuer", "clusterissuers", false),
  res("argoproj.io", "v1alpha1", "Application", "applications", true, ["app", "apps"]),
  res("monitoring.coreos.com", "v1", "ServiceMonitor", "servicemonitors", true, ["smon"]),
];

// Column schemas mirror `k10s-core/src/render/*.rs`.
const c = (id: string, title: string, kind: Column["kind"], width?: number, hidden?: boolean): Column => ({ id, title, kind, width, hidden });
const TEMPLATE_COLS = [c("containers", "Containers", "text", 160, true), c("images", "Images", "text", 260, true), c("selector", "Selector", "text", 220, true)];
const SCHEMAS: Record<string, Column[]> = {
  pods: [
    c("ready", "Ready", "ratio", 64),
    c("status", "Status", "status", 150),
    c("restarts", "Restarts", "restarts", 110),
    c("ip", "IP", "text", 120),
    c("node", "Node", "text", 190),
    c("qos", "QoS", "text", 90, true),
    c("containers", "Containers", "text", 160, true),
    c("images", "Images", "text", 260, true),
    c("cpuRequest", "CPU Req", "cpu", 80, true),
    c("cpuLimit", "CPU Lim", "cpu", 80, true),
    c("memRequest", "MEM Req", "bytes", 90, true),
    c("memLimit", "MEM Lim", "bytes", 90, true),
  ],
  "deployments.apps": [c("ready", "Ready", "ratio", 70), c("upToDate", "Up-to-date", "number", 90), c("available", "Available", "number", 80), ...TEMPLATE_COLS],
  "statefulsets.apps": [c("ready", "Ready", "ratio", 70), ...TEMPLATE_COLS],
  "replicasets.apps": [c("ready", "Ready", "ratio", 70), c("current", "Current", "number", 70), ...TEMPLATE_COLS],
  "jobs.batch": [c("status", "Status", "status", 110), c("completions", "Completions", "ratio", 100), c("duration", "Duration", "duration", 90), ...TEMPLATE_COLS],
  "cronjobs.batch": [
    c("schedule", "Schedule", "text", 130),
    c("timezone", "Timezone", "text", 110, true),
    c("suspend", "Suspend", "bool", 80),
    c("active", "Active", "number", 70),
    c("lastSchedule", "Last Schedule", "age", 110),
    c("containers", "Containers", "text", 160, true),
    c("images", "Images", "text", 260, true),
  ],
  services: [c("type", "Type", "text", 110), c("clusterIP", "Cluster IP", "text", 120), c("externalIP", "External IP", "status", 140), c("ports", "Ports", "text", 180), c("selector", "Selector", "text", 220, true)],
  configmaps: [c("data", "Data", "number", 70)],
  secrets: [c("type", "Type", "text", 260), c("data", "Data", "number", 70)],
  nodes: [
    c("status", "Status", "status", 170),
    c("roles", "Roles", "text", 130),
    c("version", "Version", "text", 110),
    c("internalIP", "Internal IP", "text", 120),
    c("cpu", "CPU", "cpu", 70),
    c("memory", "Memory", "bytes", 90),
    c("pods", "Pods", "number", 60, true),
    c("taints", "Taints", "number", 70),
  ],
  namespaces: [c("status", "Status", "status", 110)],
  events: [
    c("lastSeen", "Last Seen", "age", 90),
    c("type", "Type", "status", 80),
    c("reason", "Reason", "text", 150),
    c("object", "Object", "text", 240),
    c("message", "Message", "text", 480),
    c("count", "Count", "number", 60),
    c("source", "Source", "text", 160, true),
    c("firstSeen", "First Seen", "age", 90, true),
  ],
  // Printer columns: ids from name and kind (`render/crd.rs`), so they line up across clusters.
  "certificates.cert-manager.io": [c("pc_ready_status", "Ready", "status", 0), c("pc_secret_text", "Secret", "text", 0), c("pc_issuer_text", "Issuer", "text", 0, true)],
  "applications.argoproj.io": [c("pc_sync_status_status", "Sync Status", "status", 0), c("pc_health_status_status", "Health Status", "status", 0)],
};
/** Clusters that could not find a resource's printer columns, and why (the engine's `resolved` notice). */
const COLUMN_NOTICES: Record<string, Record<string, string>> = {
  "servicemonitors.monitoring.coreos.com": { "acme-stage": "printer columns unavailable: no answer within 8s" },
};

// ---------------------------------------------------------------------------------------------
// Object generation
// ---------------------------------------------------------------------------------------------

interface Item {
  row: Row;
  obj: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
}

function meta(name: string, ns: string | undefined, labels: Record<string, string> = {}, ageSecs = 0) {
  const ts = now() - ageSecs;
  return {
    name,
    ...(ns ? { namespace: ns } : {}),
    uid: uid(),
    resourceVersion: String(100000 + Math.floor(rnd() * 900000)),
    creationTimestamp: new Date(ts * 1000).toISOString().replace(/\.\d+Z$/, "Z"),
    labels,
  };
}

function rowOf(obj: Record<string, any>, cells: Cell[], tone: Tone): Row { // eslint-disable-line @typescript-eslint/no-explicit-any
  const m = obj.metadata;
  const labels = Object.entries(m.labels ?? {}).map(([k, v]) => `${k}=${v}`).join(" ");
  return { u: m.uid, n: m.name, ns: m.namespace, rv: m.resourceVersion, t: Date.parse(m.creationTimestamp) / 1000, s: tone, c: cells, l: labels || undefined };
}

const POD_STATES: [string, Tone, number][] = [
  ["Running", Tone.Ok, 80],
  ["CrashLoopBackOff", Tone.Error, 4],
  ["Pending", Tone.Info, 4],
  ["ContainerCreating", Tone.Info, 3],
  ["ImagePullBackOff", Tone.Error, 2],
  ["Error", Tone.Error, 1],
  ["Terminating", Tone.Muted, 2],
  ["Running", Tone.Warn, 4],
];
function podState(): [string, Tone] {
  const total = POD_STATES.reduce((a, s) => a + s[2], 0);
  let r = rnd() * total;
  for (const [s, t, w] of POD_STATES) if ((r -= w) <= 0) return [s, t];
  return ["Running", Tone.Ok];
}


/** A container as apps declare them: environment from values, the pod, ConfigMaps and Secrets; probes; mounts. */
function appContainer(app: string, ns: string, cluster: string, name: string, image: string) {
  if (name === "envoy")
    return {
      name,
      image,
      ports: [{ name: "admin", containerPort: 9901, protocol: "TCP" }],
      resources: { requests: { cpu: "50m", memory: "64Mi" }, limits: { cpu: "500m", memory: "256Mi" } },
      readinessProbe: { tcpSocket: { port: 9901 }, periodSeconds: 5 },
      lifecycle: { preStop: { sleep: { seconds: 5 } } },
    };
  return {
    name,
    image,
    ports: [{ name: "http", containerPort: 8080, protocol: "TCP" }],
    resources: { requests: { cpu: "250m", memory: "256Mi" }, limits: { cpu: "1", memory: "512Mi" } },
    env: [
      { name: "APP_ENV", value: "production" },
      { name: "ZONE", value: cluster.slice(-2) },
      { name: "POD_NAME", valueFrom: { fieldRef: { apiVersion: "v1", fieldPath: "metadata.name" } } },
      { name: "POD_IP", valueFrom: { fieldRef: { apiVersion: "v1", fieldPath: "status.podIP" } } },
      { name: "NODE_NAME", valueFrom: { fieldRef: { apiVersion: "v1", fieldPath: "spec.nodeName" } } },
      { name: "LOG_FORMAT", valueFrom: { configMapKeyRef: { name: `${app}-config`, key: "LOG_FORMAT" } } },
      { name: "DB_HOST", value: `${app}-db.${ns}.svc.cluster.local` },
      { name: "DB_USER", valueFrom: { secretKeyRef: { name: `${app}-credentials`, key: "username" } } },
      { name: "DB_PASSWORD", valueFrom: { secretKeyRef: { name: `${app}-credentials`, key: "password" } } },
      { name: "DATABASE_URL", value: "postgres://$(DB_HOST):5432/app?sslmode=require" },
      { name: "GOMAXPROCS", valueFrom: { resourceFieldRef: { resource: "limits.cpu" } } },
      { name: "MEMORY_LIMIT_MB", valueFrom: { resourceFieldRef: { resource: "limits.memory", divisor: "1Mi" } } },
      { name: "FEATURE_FLAGS", valueFrom: { configMapKeyRef: { name: "feature-flags", key: "flags", optional: true } } },
    ],
    envFrom: [{ configMapRef: { name: `${app}-config` } }, { prefix: "APP_", secretRef: { name: `${app}-credentials` } }],
    startupProbe: app.startsWith("payments") ? { httpGet: { path: "/healthz", port: "http", scheme: "HTTP" }, periodSeconds: 2, failureThreshold: 30 } : undefined,
    livenessProbe: { httpGet: { path: "/healthz", port: "http", scheme: "HTTP" }, initialDelaySeconds: 10, periodSeconds: 10, timeoutSeconds: 2, failureThreshold: 3 },
    readinessProbe: { httpGet: { path: "/ready", port: "http", scheme: "HTTP" }, periodSeconds: 5 },
    lifecycle: { preStop: { exec: { command: ["sh", "-c", "sleep 5"] } } },
    volumeMounts: [
      { name: "config", mountPath: "/etc/app", readOnly: true },
      { name: "tmp", mountPath: "/tmp" },
      { name: "kube-api-access", mountPath: "/var/run/secrets/kubernetes.io/serviceaccount", readOnly: true },
    ],
  };
}

/** Where an app's pods may run: spread over zones and nodes, off spot nodes, a dedicated pool for payments. */
function appScheduling(app: string, ns: string) {
  return {
    nodeSelector: { "kubernetes.io/os": "linux" },
    affinity: {
      nodeAffinity: {
        requiredDuringSchedulingIgnoredDuringExecution: { nodeSelectorTerms: [{ matchExpressions: [{ key: "kubernetes.io/arch", operator: "In", values: ["amd64", "arm64"] }, { key: "node.acme.dev/pool", operator: "NotIn", values: ["batch"] }] }] },
        preferredDuringSchedulingIgnoredDuringExecution: [{ weight: 50, preference: { matchExpressions: [{ key: "node.acme.dev/spot", operator: "DoesNotExist" }] } }],
      },
      podAntiAffinity: { preferredDuringSchedulingIgnoredDuringExecution: [{ weight: 100, podAffinityTerm: { labelSelector: { matchLabels: { app } }, topologyKey: "kubernetes.io/hostname" } }] },
    },
    topologySpreadConstraints: [{ maxSkew: 1, topologyKey: "topology.kubernetes.io/zone", whenUnsatisfiable: "ScheduleAnyway", labelSelector: { matchLabels: { app } } }],
    tolerations: [
      ...(ns === "payments" ? [{ key: "dedicated", operator: "Equal", value: "payments", effect: "NoSchedule" }] : []),
      { key: "node.kubernetes.io/not-ready", operator: "Exists", effect: "NoExecute", tolerationSeconds: 300 },
      { key: "node.kubernetes.io/unreachable", operator: "Exists", effect: "NoExecute", tolerationSeconds: 300 },
    ],
    ...(ns === "payments" ? { priorityClassName: "business-critical", priority: 1000000 } : {}),
  };
}

const appVolumes = (app: string) => [
  { name: "config", configMap: { name: `${app}-config` } },
  { name: "tmp", emptyDir: { sizeLimit: "1Gi" } },
  {
    name: "kube-api-access",
    projected: {
      sources: [
        { serviceAccountToken: { expirationSeconds: 3607, path: "token" } },
        { configMap: { name: "kube-root-ca.crt", items: [{ key: "ca.crt", path: "ca.crt" }] } },
        { downwardAPI: { items: [{ path: "namespace", fieldRef: { apiVersion: "v1", fieldPath: "metadata.namespace" } }] } },
      ],
    },
  },
];

function makePod(cluster: string, ns: string, app: string, node: string, opts: { job?: boolean; index?: number } = {}): Item {
  const hash = alnum(10);
  const name = opts.job ? `${app}-${alnum(5)}` : `${app}-${hash}-${alnum(5)}`;
  const age = Math.floor(rnd() * 86400 * (opts.job ? 0.2 : 9)) + 30;
  const containers = [{ name: app.split("-")[0], image: imageFor(app) }];
  if (rnd() < 0.3) containers.push({ name: "envoy", image: "envoyproxy/envoy:v1.32.1" });
  let [status, tone] = opts.job ? (rnd() < 0.9 ? (["Completed", Tone.Muted] as [string, Tone]) : (["Error", Tone.Error] as [string, Tone])) : podState();
  // Two troubles to tell apart in "Needs attention": a bad image rolled out in one zone only, a bad release in every zone.
  // The other zones' checkout-web stays healthy, so that Compare shows z2 alone out of step.
  if (app === "checkout-web") [status, tone] = cluster === "acme-prod-apps-z2" ? ["ImagePullBackOff", Tone.Error] : ["Running", Tone.Ok];
  if (app === "promo-engine" && cluster.startsWith("acme-prod-apps") && opts.index === 0) [status, tone] = ["CrashLoopBackOff", Tone.Error];
  const total = containers.length;
  const ready = status === "Running" ? (tone === Tone.Warn ? total - 1 : total) : 0;
  if (status === "Running" && tone === Tone.Warn && total === 1) tone = Tone.Ok;
  const restarts = status === "CrashLoopBackOff" ? 5 + Math.floor(rnd() * 40) : rnd() < 0.1 ? Math.floor(rnd() * 4) : 0;
  const lastRestart = restarts ? now() - Math.floor(rnd() * 7200) : null;
  const ip = `10.${ZONES.indexOf(cluster.slice(-2)) + 10}.${Math.floor(rnd() * 255)}.${Math.floor(rnd() * 255)}`;
  const m = meta(name, ns, opts.job ? { "job-name": app, app } : { app, "pod-template-hash": hash }, age);
  const obj = {
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      ...m,
      annotations: { "kubectl.kubernetes.io/default-container": containers[0].name, "prometheus.io/scrape": "true" },
      ownerReferences: [{ apiVersion: opts.job ? "batch/v1" : "apps/v1", kind: opts.job ? "Job" : "ReplicaSet", name: opts.job ? app : `${app}-${hash}`, uid: uid(), controller: true }],
      ...(status === "Terminating" ? { deletionTimestamp: new Date().toISOString() } : {}),
    },
    spec: {
      nodeName: node,
      serviceAccountName: app,
      restartPolicy: opts.job ? "Never" : "Always",
      containers: containers.map((ct) => appContainer(app, ns, cluster, ct.name, ct.image)),
      volumes: appVolumes(app),
      ...(opts.job ? {} : appScheduling(app, ns)),
    },
    status: {
      phase: status === "Completed" ? "Succeeded" : status === "Pending" ? "Pending" : "Running",
      podIP: ip,
      hostIP: `172.16.${Math.floor(rnd() * 16)}.${Math.floor(rnd() * 255)}`,
      qosClass: "Burstable",
      startTime: m.creationTimestamp,
      conditions: [
        { type: "Initialized", status: "True" },
        { type: "Ready", status: ready === total ? "True" : "False" },
        { type: "ContainersReady", status: ready === total ? "True" : "False" },
        { type: "PodScheduled", status: "True" },
      ],
      containerStatuses: containers.map((ct, i) => ({
        name: ct.name,
        image: ct.image,
        ready: i < ready,
        restartCount: i === 0 ? restarts : 0,
        started: status === "Running",
        state:
          status === "Running" || status === "Terminating"
            ? { running: { startedAt: m.creationTimestamp } }
            : status === "Completed"
              ? { terminated: { exitCode: 0, reason: "Completed" } }
              : status === "Error"
                ? { terminated: { exitCode: 1, reason: "Error" } }
                : { waiting: { reason: status === "Pending" ? "ContainerCreating" : status, message: status === "ImagePullBackOff" ? `Back-off pulling image "${ct.image}"` : undefined } },
        lastState: restarts && i === 0 ? { terminated: { exitCode: 137, reason: "OOMKilled", finishedAt: new Date((lastRestart ?? 0) * 1000).toISOString() } } : {},
      })),
    },
  };
  const cells: Cell[] = [
    [ready, total],
    [status, tone],
    [restarts, lastRestart],
    status === "Pending" ? null : ip,
    status === "Pending" ? null : node,
    "Burstable",
    containers.map((x) => x.name).join(","),
    containers.map((x) => x.image).join(","),
    250 * containers.length,
    1000 * containers.length,
    256 * MIB * containers.length,
    512 * MIB * containers.length,
  ];
  return { row: rowOf(obj, cells, tone), obj };
}

const MIB = 1024 * 1024;

function nodesFor(cluster: string): string[] {
  const n = cluster.startsWith("acme-prod-apps") ? 9 : cluster === "kind-local" ? 1 : 4;
  return Array.from({ length: n }, (_, i) => (cluster === "kind-local" ? "kind-control-plane" : `${cluster.replace("acme-", "")}-node-${String(i + 1).padStart(2, "0")}`));
}

function generate(cluster: string, key: string): Item[] {
  const nodes = nodesFor(cluster);
  const out: Item[] = [];
  const isApps = cluster.includes("apps") || cluster === "acme-stage" || cluster === "acme-dev";
  const namespaces = isApps ? NAMESPACES : ["default", "kube-system", "monitoring"];
  const appsOf = (ns: string) => (APPS[ns] ?? []).filter(() => true);
  switch (key) {
    case "pods":
      for (const ns of namespaces) {
        if (ns === BATCH_NS) {
          const count = cluster.startsWith("acme-prod-apps") ? 600 : 40;
          for (let i = 0; i < count; i++) out.push(makePod(cluster, ns, `report-${pick(["daily", "hourly", "export", "reindex"])}-${29384000 + i}`, pick(nodes), { job: true }));
          continue;
        }
        for (const app of appsOf(ns)) {
          const replicas = ns === "kube-system" ? 2 : 2 + Math.floor(rnd() * 4);
          for (let i = 0; i < replicas; i++) out.push(makePod(cluster, ns, app, pick(nodes), { index: i }));
        }
      }
      break;
    case "deployments.apps":
      for (const ns of namespaces)
        for (const app of appsOf(ns)) {
          rnd();
          const { image, replicas: desired } = workloadIn(app, cluster);
          const healthy = rnd() < 0.85;
          // checkout-web: the bad image of z2 alone (see makePod), one replica short there and nowhere else.
          const ready = app === "checkout-web" ? (cluster === "acme-prod-apps-z2" ? desired - 1 : desired) : healthy ? desired : desired - 1;
          const obj = {
            apiVersion: "apps/v1",
            kind: "Deployment",
            metadata: meta(app, ns, { app }, Math.floor(rnd() * 86400 * 60)),
            spec: {
              replicas: desired,
              selector: { matchLabels: { app } },
              strategy: { type: "RollingUpdate", rollingUpdate: { maxSurge: "25%", maxUnavailable: "25%" } },
              template: { metadata: { labels: { app } }, spec: { serviceAccountName: app, containers: [appContainer(app, ns, cluster, app.split("-")[0], (imageFor(app), image))], volumes: appVolumes(app), ...appScheduling(app, ns) } },
            },
            status: { replicas: desired, readyReplicas: ready, updatedReplicas: desired, availableReplicas: ready, conditions: [{ type: "Available", status: ready === desired ? "True" : "False", reason: "MinimumReplicasAvailable" }, { type: "Progressing", status: "True", reason: "NewReplicaSetAvailable" }] },
          };
          out.push({ obj, row: rowOf(obj, [[ready, desired], desired, ready, app, obj.spec.template.spec.containers[0].image, `app=${app}`], ready === desired ? Tone.Ok : Tone.Warn) });
        }
      break;
    case "statefulsets.apps":
      for (const ns of ["monitoring", "payments"]) {
        if (!namespaces.includes(ns)) continue;
        for (const app of ns === "monitoring" ? ["prometheus", "alertmanager"] : ["ledger-db"]) {
          const obj = { apiVersion: "apps/v1", kind: "StatefulSet", metadata: meta(app, ns, { app }, 86400 * 40), spec: { replicas: 3, selector: { matchLabels: { app } } }, status: { readyReplicas: 3 } };
          out.push({ obj, row: rowOf(obj, [[3, 3], app, imageFor(app), `app=${app}`], Tone.Ok) });
        }
      }
      break;
    case "replicasets.apps":
      for (const ns of namespaces)
        for (const app of appsOf(ns))
          for (let v = 0; v < 2; v++) {
            const desired = v === 0 ? 3 : 0;
            const obj = { apiVersion: "apps/v1", kind: "ReplicaSet", metadata: meta(`${app}-${alnum(10)}`, ns, { app }, 86400 * (v + 1) * 3), spec: { replicas: desired }, status: { readyReplicas: desired, replicas: desired } };
            out.push({ obj, row: rowOf(obj, [[desired, desired], desired, app, imageFor(app), `app=${app}`], desired ? Tone.Ok : Tone.Muted) });
          }
      break;
    case "jobs.batch":
      for (let i = 0; i < 25; i++) {
        const failed = rnd() < 0.1;
        const running = !failed && rnd() < 0.15;
        const start = now() - Math.floor(rnd() * 86400);
        const obj = { apiVersion: "batch/v1", kind: "Job", metadata: meta(`report-${pick(["daily", "hourly", "export"])}-${29000000 + i}`, BATCH_NS, {}, now() - start), spec: { completions: 1 }, status: {} };
        const cells: Cell[] = [failed ? ["Failed", Tone.Error] : running ? ["Running", Tone.Info] : ["Complete", Tone.Ok], [failed || running ? 0 : 1, 1], [start, running ? null : start + 30 + Math.floor(rnd() * 600)], "report", "registry.acme.dev/report:v2.1.0", null];
        out.push({ obj, row: rowOf(obj, cells, failed ? Tone.Error : running ? Tone.Info : Tone.Ok) });
      }
      break;
    case "cronjobs.batch":
      for (const [name, schedule] of [["report-daily", "0 3 * * *"], ["report-hourly", "0 * * * *"], ["export", "*/15 * * * *"], ["cleanup", "30 2 * * 0"]]) {
        const suspended = name === "cleanup";
        const obj = { apiVersion: "batch/v1", kind: "CronJob", metadata: meta(name, BATCH_NS, {}, 86400 * 90), spec: { schedule, suspend: suspended }, status: {} };
        out.push({ obj, row: rowOf(obj, [schedule, null, suspended, suspended ? 0 : Math.floor(rnd() * 2), now() - Math.floor(rnd() * 3600), "report", "registry.acme.dev/report:v2.1.0"], suspended ? Tone.Muted : Tone.Neutral) });
      }
      break;
    case "services":
      for (const ns of namespaces)
        for (const app of appsOf(ns)) {
          const lb = app === "ingress-nginx-controller";
          const obj = { apiVersion: "v1", kind: "Service", metadata: meta(app, ns, { app }, 86400 * 70), spec: { type: lb ? "LoadBalancer" : "ClusterIP", clusterIP: `10.96.${Math.floor(rnd() * 255)}.${Math.floor(rnd() * 255)}`, ports: [{ port: 80, targetPort: 8080, protocol: "TCP" }], selector: { app } } };
          out.push({ obj, row: rowOf(obj, [obj.spec.type, obj.spec.clusterIP, lb ? [`34.120.${Math.floor(rnd() * 255)}.${Math.floor(rnd() * 255)}`, Tone.Neutral] : null, lb ? "80:31080/TCP,443:31443/TCP" : "80/TCP", `app=${app}`], Tone.Neutral) });
        }
      break;
    case "configmaps":
      for (const ns of namespaces) {
        for (const app of appsOf(ns)) {
          const level = app === "cart" && cluster.endsWith("z2") ? "debug" : "info";
          const obj = { apiVersion: "v1", kind: "ConfigMap", metadata: meta(`${app}-config`, ns, { app }, 86400 * 20), data: { "config.yaml": `server:\n  port: 8080\n  zone: ${cluster.slice(-2)}\nlog:\n  level: ${level}\n`, LOG_FORMAT: "json" } };
          out.push({ obj, row: rowOf(obj, [2], Tone.Neutral) });
        }
        const root = { apiVersion: "v1", kind: "ConfigMap", metadata: meta("kube-root-ca.crt", ns, {}, 86400 * 300), data: { "ca.crt": "-----BEGIN CERTIFICATE-----\nMIIC...\n-----END CERTIFICATE-----\n" } };
        out.push({ obj: root, row: rowOf(root, [1], Tone.Neutral) });
      }
      break;
    case "secrets":
      for (const ns of namespaces)
        for (const app of appsOf(ns)) {
          const obj = { apiVersion: "v1", kind: "Secret", type: "Opaque", metadata: meta(`${app}-credentials`, ns, { app }, 86400 * 30), data: { username: btoa(app), password: btoa(alnum(16)) } };
          out.push({ obj, row: rowOf(obj, ["Opaque", 2], Tone.Neutral) });
        }
      break;
    case "nodes":
      nodes.forEach((name, i) => {
        const notReady = cluster === "acme-prod-apps-z3" && i === 4;
        const cordoned = cluster === "acme-prod-apps-z2" && i === 2;
        const role = i < (nodes.length > 3 ? 3 : 1) ? "control-plane" : "<none>";
        const obj = {
          apiVersion: "v1",
          kind: "Node",
          metadata: meta(name, undefined, { "kubernetes.io/hostname": name, "topology.kubernetes.io/zone": cluster.slice(-2), ...(role !== "<none>" ? { "node-role.kubernetes.io/control-plane": "" } : {}) }, 86400 * 120),
          spec: cordoned ? { unschedulable: true } : {},
          status: { nodeInfo: { kubeletVersion: "v1.33.4", osImage: "Ubuntu 24.04.1 LTS", containerRuntimeVersion: "containerd://2.0.2" }, addresses: [{ type: "InternalIP", address: `172.16.${i}.${10 + i}` }], allocatable: { cpu: "15800m", memory: "62Gi", pods: "110" }, conditions: [{ type: "Ready", status: notReady ? "False" : "True" }] },
        };
        const status = notReady ? "NotReady" : cordoned ? "Ready,SchedulingDisabled" : "Ready";
        const tone = notReady ? Tone.Error : cordoned ? Tone.Warn : Tone.Ok;
        out.push({ obj, row: rowOf(obj, [[status, tone], role, "v1.33.4", `172.16.${i}.${10 + i}`, 15800, 62 * 1024 ** 3, 110, role === "<none>" ? 0 : 1], tone) });
      });
      break;
    case "namespaces": {
      const names = [...namespaces, "kube-public", "kube-node-lease"];
      if (isApps) for (let i = 0; i < EXTRA_NAMESPACES; i++) if ((i + cluster.length) % 10 !== 0) names.push(extraNamespace(i));
      for (const ns of names) {
        const obj = { apiVersion: "v1", kind: "Namespace", metadata: meta(ns, undefined, { "kubernetes.io/metadata.name": ns }, 86400 * 200), status: { phase: "Active" } };
        out.push({ obj, row: rowOf(obj, [["Active", Tone.Neutral]], Tone.Neutral) });
      }
      break;
    }
    case "events":
      for (let i = 0; i < 60; i++) {
        const ns = pick(namespaces.filter((n) => n !== BATCH_NS));
        const app = pick(APPS[ns] ?? ["app"]);
        const warn = rnd() < 0.35;
        const [reason, message] = warn
          ? pick([["BackOff", "Back-off restarting failed container"], ["Unhealthy", "Readiness probe failed: HTTP probe failed with statuscode: 503"], ["FailedScheduling", "0/9 nodes are available: 3 Insufficient memory."]])
          : pick([["Pulled", `Successfully pulled image "${imageFor(app)}" in 1.2s`], ["Scheduled", `Successfully assigned ${ns}/${app}-x to node`], ["Started", "Started container"], ["ScalingReplicaSet", `Scaled up replica set ${app}-7d9f to 3`]]);
        const last = now() - Math.floor(rnd() * 3600);
        const obj = { apiVersion: "v1", kind: "Event", metadata: meta(`${app}.${hex(16)}`, ns, {}, now() - last), type: warn ? "Warning" : "Normal", reason, message, involvedObject: { kind: "Pod", name: `${app}-${alnum(10)}`, namespace: ns }, count: 1 + Math.floor(rnd() * 20) };
        out.push({ obj, row: rowOf(obj, [last, [obj.type, warn ? Tone.Warn : Tone.Neutral], reason, `pod/${obj.involvedObject.name}`, message, obj.count, "kubelet", last - 600], warn ? Tone.Warn : Tone.Neutral) });
      }
      break;
    case "certificates.cert-manager.io":
      for (const ns of ["ingress-nginx", "payments", "checkout"]) {
        if (!namespaces.includes(ns)) continue;
        const ready = rnd() < 0.8;
        const obj = { apiVersion: "cert-manager.io/v1", kind: "Certificate", metadata: meta(`${ns}-tls`, ns, {}, 86400 * 10), spec: { secretName: `${ns}-tls`, issuerRef: { name: "letsencrypt" } }, status: { conditions: [{ type: "Ready", status: ready ? "True" : "False" }] } };
        out.push({ obj, row: rowOf(obj, [[ready ? "True" : "False", ready ? Tone.Ok : Tone.Error], `${ns}-tls`, "letsencrypt"], ready ? Tone.Ok : Tone.Error) });
      }
      break;
    case "applications.argoproj.io":
      for (const app of ["payments", "checkout", "search", "monitoring"]) {
        const synced = rnd() < 0.75;
        const health = pick(["Healthy", "Healthy", "Healthy", "Progressing", "Degraded"]);
        const tone = health === "Degraded" ? Tone.Error : health === "Progressing" ? Tone.Info : synced ? Tone.Ok : Tone.Warn;
        const obj = { apiVersion: "argoproj.io/v1alpha1", kind: "Application", metadata: meta(app, "argocd", {}, 86400 * 50), spec: {}, status: {} };
        out.push({ obj, row: rowOf(obj, [[synced ? "Synced" : "OutOfSync", synced ? Tone.Ok : Tone.Warn], [health, health === "Healthy" ? Tone.Ok : health === "Degraded" ? Tone.Error : Tone.Info]], tone) });
      }
      break;
    default: {
      const info = RESOURCES.find((r) => r.key === key);
      if (!info) break;
      const count = 3 + Math.floor(rnd() * 8);
      for (let i = 0; i < count; i++) {
        const ns = info.namespaced ? pick(namespaces) : undefined;
        const obj = { apiVersion: info.group ? `${info.group}/${info.version}` : info.version, kind: info.kind, metadata: meta(`${info.singular}-${alnum(6)}`, ns, {}, Math.floor(rnd() * 86400 * 100)), spec: {} };
        out.push({ obj, row: rowOf(obj, [], Tone.Neutral) });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Mock engine
// ---------------------------------------------------------------------------------------------

/**
 * The desktop app's two files (crates/k10s-app/src/prefs.rs), kept in the browser's storage as one entry: what the
 * user sets, the engine's settings among it, and what k10s remembers.
 */
const MOCK_FILES_KEY = "k10s:mock.files";
const ENGINE_KEYS = ["readOnly", "feedIdleTtlSecs"];

type MockFiles = { settings: Record<string, unknown>; state: Record<string, unknown> };

function loadMockFiles(): MockFiles {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(MOCK_FILES_KEY) ?? "{}");
    if (isObject(saved)) return { settings: isObject(saved.settings) ? saved.settings : {}, state: isObject(saved.state) ? saved.state : {} };
  } catch {
    // the defaults
  }
  return { settings: {}, state: {} };
}

function engineSettingsOf(settings: Record<string, unknown>): Settings {
  const readOnly = getAt(settings, "readOnly");
  const ttl = getAt(settings, "feedIdleTtlSecs");
  return { readOnly: readOnly === true, feedIdleTtlSecs: typeof ttl === "number" && ttl >= 0 ? ttl : 180 };
}

const hidden = (bytes: number) => `<hidden: ${bytes} byte${bytes === 1 ? "" : "s"}>`;
const base64Bytes = (v: string) => {
  const s = v.trimEnd();
  const padding = Math.min(2, s.length - s.replace(/=+$/, "").length);
  return Math.max(0, Math.floor(s.length / 4) * 3 + Math.floor(((s.length % 4) * 3) / 4) - padding);
};

/**
 * What the engine does to a core Secret's YAML unless values are revealed: `data`/`stringData` values (also
 * inside kubectl's last-applied-configuration annotation) become their sizes; keys stay. Changes `obj`.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function maskSecret(obj: any) {
  if (obj?.kind !== "Secret" || obj?.apiVersion !== "v1") return;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const values = (o: any) => {
    for (const k of Object.keys(o?.data ?? {})) o.data[k] = hidden(typeof o.data[k] === "string" ? base64Bytes(o.data[k]) : 0);
    for (const k of Object.keys(o?.stringData ?? {})) o.stringData[k] = hidden(typeof o.stringData[k] === "string" ? new TextEncoder().encode(o.stringData[k]).length : 0);
  };
  values(obj);
  const annotations = obj.metadata?.annotations;
  const key = "kubectl.kubernetes.io/last-applied-configuration";
  if (annotations && typeof annotations[key] === "string") {
    const text: string = annotations[key];
    try {
      const last = JSON.parse(text);
      if (!last || typeof last !== "object" || Array.isArray(last)) throw new Error("not an object");
      values(last);
      annotations[key] = JSON.stringify(last) + (text.endsWith("\n") ? "\n" : "");
    } catch {
      annotations[key] = hidden(new TextEncoder().encode(text).length);
    }
  }
}

/** Rows per message at most, as the engine sends them. */
const SNAPSHOT_CHUNK = 5000;

interface ViewSub {
  spec: ViewSpec;
  key: string;
  ready: Set<string>;
  cb: (b: ViewBatch) => void;
}

export class MockBackend implements Backend {
  readonly kind = "mock" as const;
  private data = new Map<string, Map<string, Item>>(); // `${cluster}|${resource}` → uid → item
  private views = new Set<ViewSub>();
  private listeners = new Set<(e: EngineEvent) => void>();
  private connected = new Map<string, Promise<ClusterInfo>>();
  /** Contexts whose last connection attempt failed. */
  private failed = new Set<string>();
  /** The engine keeps its settings in a file; the mock in its own storage key. */
  private files = loadMockFiles();
  private settings: Settings = engineSettingsOf(this.files.settings);
  private settingsListeners = new Set<(change: SettingsChange) => void>();
  private forwards: ForwardInfo[] = [];
  private forwardListeners = new Set<(list: ForwardInfo[]) => void>();
  private nextForward = 0;

  constructor() {
    setInterval(() => this.tick(), 1200);
  }

  private items(cluster: string, key: string) {
    const k = `${cluster}|${key}`;
    let m = this.data.get(k);
    if (!m) {
      m = new Map(generate(cluster, key).map((it) => [it.row.u, it]));
      this.data.set(k, m);
    }
    return m;
  }

  private emit(e: EngineEvent) {
    for (const l of this.listeners) l(e);
  }

  async appInfo(): Promise<AppInfo> {
    return { version: "0.1.0-mock", os: "browser", arch: "wasm", updates: UPDATE };
  }

  async listContexts(): Promise<ContextList> {
    await sleep(60);
    if (KUBECONFIG_CASE === "invalid") throw { kind: "kubeconfig", message: "kubeconfig: ~/.kube/config: failed to parse kubeconfig: mapping values are not allowed in this context at line 7 column 9", code: null };
    if (KUBECONFIG_CASE === "missing" || KUBECONFIG_CASE === "empty")
      return { contexts: [], current: null, paths: ["~/.kube/config"], found: KUBECONFIG_CASE === "empty" ? ["~/.kube/config"] : [], fromEnv: false };
    return {
      // Strict-RBAC contexts name the namespace their users work in, as kubeconfigs handed out for them usually do.
      contexts: CONTEXTS.map((name) => ({ name, cluster: name, server: `https://${name}.k8s.acme.dev:6443`, user: "jane", namespace: name === "acme-dev" || RESTRICTED(name) ? "payments" : null, auth: name === "kind-local" ? "client-cert" : "exec: kubelogin" })),
      current: KUBECONFIG_CASE === "nocurrent" ? null : "acme-prod-apps-z1",
      paths: ["~/.kube/config"],
      found: ["~/.kube/config"],
      fromEnv: false,
    };
  }

  connect(context: string): Promise<ClusterInfo> {
    let p = this.connected.get(context);
    if (!p) {
      this.emit({ type: "cluster", context, state: "connecting" });
      p = (async () => {
        await sleep(250 + rnd() * 700);
        if (UNREACHABLE.has(context)) {
          const message = `dial tcp 10.200.0.12:6443: i/o timeout (is the cluster reachable?)`;
          this.emit({ type: "cluster", context, state: "error", message });
          this.connected.delete(context);
          this.failed.add(context);
          throw { kind: "connect", message, code: null };
        }
        this.failed.delete(context);
        const version = context === "kind-local" ? "v1.34.0" : "v1.33.4";
        this.emit({ type: "cluster", context, state: "connected", version });
        const crds = context.includes("apps") || context === "acme-stage";
        return {
          context,
          server: `https://${context}.k8s.acme.dev:6443`,
          version,
          defaultNamespace: null,
          aggregatedDiscovery: true,
          resources: RESOURCES.filter((r) => crds || !["cert-manager.io", "argoproj.io"].includes(r.group)),
        };
      })();
      this.connected.set(context, p);
    }
    return p;
  }
  reconnect(context: string) {
    this.connected.delete(context);
    return this.connect(context);
  }
  refreshDiscovery(context: string) {
    return this.connect(context);
  }
  async disconnect(context: string) {
    this.connected.delete(context);
    this.emit({ type: "cluster", context, state: "disconnected" });
  }
  async resync() {
    // Nothing goes stale here; like the engine, clusters that failed to connect are tried again.
    for (const context of [...this.failed]) if (!this.connected.has(context)) void this.connect(context).catch(() => {});
  }

  subscribeView(spec: ViewSpec, cb: (b: ViewBatch) => void): Subscription {
    const key = RESOURCES.find((r) => r.key === spec.resource || r.shortNames.includes(spec.resource) || r.plural === spec.resource)?.key ?? spec.resource;
    const sub: ViewSub = { spec, key, ready: new Set(), cb };
    this.views.add(sub);
    const info = RESOURCES.find((r) => r.key === key);
    const first: ViewMessage[] = [{ t: "schema", columns: SCHEMAS[key] ?? [] }];
    for (const cl of spec.clusters) first.push({ t: "status", c: cl, ns: null, state: "connecting" });
    queueMicrotask(() => cb({ t: "batch", m: first }));
    for (const cluster of spec.clusters) {
      this.connect(cluster).then(
        async (ci) => {
          const r = ci.resources.find((x) => x.key === key);
          if (!r) {
            if (this.views.has(sub)) cb({ t: "batch", m: [{ t: "status", c: cluster, ns: null, state: "error", message: `resource "${spec.resource}" is not served by cluster "${cluster}"` }] });
            return;
          }
          await sleep(80 + rnd() * 250);
          if (!this.views.has(sub)) return;
          const nsList = info?.namespaced && spec.namespaces.length ? spec.namespaces : [null];
          const msgs: ViewMessage[] = [{ t: "resolved", c: cluster, resource: r, notice: COLUMN_NOTICES[key]?.[cluster] }];
          for (const ns of nsList) {
            if (RESTRICTED(cluster) && (!ns || !ALLOWED_NAMESPACES.has(ns))) {
              msgs.push({ t: "status", c: cluster, ns, state: "error", message: forbidden(key, ns), code: 403, reason: "Forbidden", terminal: true });
              continue;
            }
            const rows = [...this.items(cluster, key).values()].filter((it) => matches(it, ns, spec) && (spec.projection !== "problems" || isProblem(it.row))).map((it) => it.row);
            // Like the engine: a big snapshot comes in chunks (`more` on all but the last), its status after them.
            for (let i = 0; i === 0 || i < rows.length; i += SNAPSHOT_CHUNK) {
              const part = rows.slice(i, i + SNAPSHOT_CHUNK);
              const more = i + SNAPSHOT_CHUNK < rows.length ? { more: true } : {};
              if (spec.projection === "names") msgs.push({ t: "names", c: cluster, ns, ...(i === 0 ? { reset: true } : {}), up: part.map((r) => r.n), ...more });
              else msgs.push({ t: "rows", c: cluster, ns, ...(i === 0 ? { reset: true } : {}), up: part, ...more });
            }
            msgs.push({ t: "status", c: cluster, ns, state: "ready" });
          }
          sub.ready.add(cluster);
          cb({ t: "batch", m: msgs });
        },
        (e) => {
          if (this.views.has(sub)) cb({ t: "batch", m: [{ t: "status", c: cluster, ns: null, state: "error", message: e.message }] });
        },
      );
    }
    return { close: () => void this.views.delete(sub) };
  }

  /** Random churn so the UI can be reviewed with live updates. */
  private tick() {
    for (const [k, items] of this.data) {
      const [cluster, key] = k.split("|");
      if (key !== "pods" && key !== "events" && key !== "deployments.apps" && !(key === "namespaces" && EXTRA_NAMESPACES)) continue;
      const changed: Item[] = [];
      const created: Item[] = [];
      const deleted: Item[] = [];
      const all = [...items.values()];
      for (let i = 0; i < Math.min(3, all.length); i++) {
        const it = pick(all);
        if (key === "pods") {
          const r = rnd();
          if (r < 0.15 && it.row.ns !== BATCH_NS) {
            items.delete(it.row.u);
            deleted.push(it);
            const app = String(it.obj.metadata.labels.app);
            const fresh = makePod(cluster, it.row.ns!, app, String(it.obj.spec.nodeName));
            items.set(fresh.row.u, fresh);
            changed.push(fresh);
            created.push(fresh);
          } else {
            const cells = [...it.row.c];
            const [count] = cells[2] as [number, number | null];
            if (r < 0.5) cells[2] = [count + 1, now()];
            const next: Item = { obj: it.obj, row: { ...it.row, c: cells, rv: String(Number(it.row.rv) + 1) } };
            items.set(it.row.u, next);
            changed.push(next);
          }
        } else if (key === "namespaces") {
          if (rnd() < 0.08 && !NAMESPACES.includes(it.row.n) && !it.row.n.startsWith("kube-")) {
            // Preview environments come and go.
            items.delete(it.row.u);
            deleted.push(it);
            const name = `preview-${alnum(6)}`;
            const obj = { apiVersion: "v1", kind: "Namespace", metadata: meta(name, undefined, { "kubernetes.io/metadata.name": name }), status: { phase: "Active" } };
            const fresh: Item = { obj, row: rowOf(obj, [["Active", Tone.Neutral]], Tone.Neutral) };
            items.set(fresh.row.u, fresh);
            changed.push(fresh);
            created.push(fresh);
          } else {
            // Labels/annotations churn: invisible to name pickers.
            const next: Item = { obj: it.obj, row: { ...it.row, rv: String(Number(it.row.rv) + 1) } };
            items.set(it.row.u, next);
            changed.push(next);
          }
        } else if (key === "events") {
          const next: Item = { obj: it.obj, row: { ...it.row, c: [now(), ...it.row.c.slice(1, 5), Number(it.row.c[5]) + 1, ...it.row.c.slice(6)], rv: String(Number(it.row.rv) + 1) } };
          items.set(it.row.u, next);
          changed.push(next);
        }
      }
      if (!changed.length && !deleted.length) continue;
      for (const sub of this.views) {
        if (sub.key !== key || !sub.ready.has(cluster) || !sub.spec.clusters.includes(cluster)) continue;
        const nsList = sub.spec.namespaces.length ? sub.spec.namespaces : [null];
        const msgs: ViewMessage[] = [];
        for (const ns of nsList) {
          if (RESTRICTED(cluster) && (!ns || !ALLOWED_NAMESPACES.has(ns))) continue;
          if (sub.spec.projection === "names") {
            const up = created.filter((it) => matches(it, ns, sub.spec)).map((it) => it.row.n);
            const del = deleted.filter((it) => matches(it, ns, sub.spec)).map((it) => it.row.n);
            if (up.length || del.length) msgs.push({ t: "names", c: cluster, ns, up, del });
            continue;
          }
          // A problems view: objects that became fine leave it (the UI ignores deletes of rows it does not have).
          const problems = sub.spec.projection === "problems";
          const up = changed.filter((it) => matches(it, ns, sub.spec) && (!problems || isProblem(it.row))).map((it) => it.row);
          const del = [...deleted, ...(problems ? changed.filter((it) => !isProblem(it.row)) : [])].filter((it) => matches(it, ns, sub.spec)).map((it) => it.row.u);
          if (up.length || del.length) msgs.push({ t: "rows", c: cluster, ns, up, del });
        }
        if (msgs.length) sub.cb({ t: "batch", m: msgs });
      }
    }
  }

  streamLogs(spec: LogSpec, cb: (m: LogMessage) => void): LogSubscription {
    let closed = false;
    // Like the engine: `previous` is a one-shot read.
    const follow = spec.follow && !spec.previous;
    const live = new Map<number, LogTarget>();
    // Containers that crash now and then (when followed): until when each is down.
    const down = new Map<number, number>();
    const started = Date.now();
    const send = (lines: LogLine[]) => lines.length && cb({ t: "lines", l: lines });
    // A read of earlier history (see `logRun`): each container's last `tailLines` lines, up to `until`.
    if (spec.targets.some((t) => t.until != null)) {
      const timer = setTimeout(
        () => {
          if (closed) return;
          spec.targets.forEach((t, pos) => {
            const i = t.id ?? pos;
            if (spec.previous && !crashy(t)) {
              cb({ t: "state", i, state: "ended", message: `no previous container: "${t.container}" has not restarted, or its earlier logs are gone` });
              return;
            }
            cb({ t: "state", i, state: "streaming" });
            const [from, to] = logRun(t, !!spec.previous);
            const total = Math.floor((to - from) / LOG_STEP) + 1;
            const lines: LogLine[] = [];
            for (let k = Math.max(0, total - (t.tailLines ?? total)); k < total; k++) {
              const ts = from + k * LOG_STEP;
              if (ts > (t.until ?? Infinity)) break;
              for (const text of logLines(t, ts)) lines.push([i, ts, text]);
            }
            for (let k = 0; k < lines.length; k += 5000) send(lines.slice(k, k + 5000));
            cb({ t: "state", i, state: "ended" });
          });
        },
        150 + rnd() * 350,
      );
      return {
        close() {
          closed = true;
          clearTimeout(timer);
        },
        setTargets() {},
      };
    }
    // New targets get their history (the tail, or the lines of `sinceSeconds`; pods that appear later — new pods,
    // like the engine tells from their creation time — a little), then live lines.
    const add = (targets: LogTarget[], initial: boolean) => {
      const fresh: [number, LogTarget][] = [];
      targets.forEach((t, pos) => {
        const id = t.id ?? pos;
        if (!live.has(id)) fresh.push([id, t]);
        live.set(id, t);
      });
      if (!fresh.length) return;
      queueMicrotask(() => {
        if (closed) return;
        const span = spec.sinceSeconds ? spec.sinceSeconds * 1000 : null;
        const wanted = initial || Date.now() - started < 5000 ? Math.min(spec.tailLines ?? (span ? span / 900 : 300), rate ? 20_000 : 2000) : 20;
        const tail = Math.max(1, Math.floor(wanted));
        const step = span ? span / tail : 900;
        const start = Date.now() - tail * step;
        for (const [i, t] of fresh) {
          if (spec.previous && !crashy(t)) {
            cb({ t: "state", i, state: "ended", message: `no previous container: "${t.container}" has not restarted, or its earlier logs are gone` });
            continue;
          }
          cb({ t: "state", i, state: "streaming" });
        }
        const lines: LogLine[] = [];
        for (let k = 0; k < tail * fresh.length; k++) {
          const [i, t] = fresh[k % fresh.length];
          if (spec.previous && !crashy(t)) continue;
          const ts = Math.round(start + Math.floor(k / fresh.length) * step + (k % fresh.length));
          for (const text of logLines(t, ts)) lines.push([i, ts, text]);
        }
        send(lines);
        if (spec.previous) for (const [i, t] of fresh) if (crashy(t)) send([[i, Date.now() - 1000, "fatal error: runtime: out of memory"]]);
        if (!follow) for (const [i] of fresh) cb({ t: "state", i, state: "ended" });
      });
    };
    add(spec.targets, true);
    // A load test: `localStorage["k10s:mock.logRate"]` lines per container per second (default: a few in all), in
    // batches as the engine sends them: every 50 ms, every 250 ms from 100 lines a second on.
    const rate = Number(localStorage.getItem("k10s:mock.logRate")) || 0;
    const every = !rate ? 400 : rate * spec.targets.length >= 100 ? 250 : 50;
    const timer = setInterval(() => {
      if (closed || !follow || !live.size) return;
      const now = Date.now();
      const ids = [...live.keys()].filter((i) => (down.get(i) ?? 0) < now);
      const lines: LogLine[] = [];
      const n = rate ? Math.round((rate * ids.length * every) / 1000) : Math.floor(rnd() * 4);
      for (let k = 0; k < n && ids.length; k++) {
        const i = ids[Math.floor(rnd() * ids.length)];
        for (const text of logLines(live.get(i)!, now)) lines.push([i, now, text]);
      }
      // Now and then a crashy container dies, waits and comes back.
      for (const i of ids) {
        const t = live.get(i)!;
        if (!crashy(t) || rnd() > every / 400 / 120 || now - started < 8000) continue;
        lines.push([i, now, "fatal error: runtime: out of memory"], [i, now, ""], [i, now, "goroutine 1 [running]:"], [i, now, "runtime.throw({0x1b2f3a0, 0x16})"], [i, now, "\t/usr/local/go/src/runtime/panic.go:1047 +0x5d"]);
        down.set(i, now + 9000);
        const message = "container terminated: OOMKilled (exit code 137)";
        setTimeout(() => !closed && cb({ t: "state", i, state: "ended", message }), 300);
        setTimeout(() => !closed && cb({ t: "state", i, state: "waiting", message: `${message}, waiting to restart (CrashLoopBackOff)` }), 2500);
        setTimeout(() => {
          if (closed || !live.has(i)) return;
          cb({ t: "state", i, state: "streaming" });
          const at = Date.now();
          send([[i, at, `${"\x1b[32mINFO\x1b[0m"}  starting ${t.container} v1.42.0 (commit 3f2a9c1)`], [i, at + 3, "level=info msg=\"listening\" addr=:8080"]]);
        }, 9000);
      }
      send(lines);
    }, every);
    return {
      close() {
        closed = true;
        clearInterval(timer);
      },
      setTargets(targets: LogTarget[]) {
        const wanted = new Set(targets.map((t, pos) => t.id ?? pos));
        for (const id of [...live.keys()]) if (!wanted.has(id)) live.delete(id);
        add(targets, false);
      },
    };
  }

  /** Why a terminal in `cluster` would be refused like the engine refuses it, if it would. */
  private terminalRefusal(cluster: string, namespace: string, sub: "exec" | "attach" | "create"): string | undefined {
    if (this.settings.readOnly) return "read-only mode is on: mutating actions are disabled";
    if (RESTRICTED(cluster)) return sub === "create" ? `pods is forbidden: User "jane" cannot create resource "pods" in API group "" in the namespace "${namespace}"` : `no permission to open a terminal in namespace "${namespace}": it takes create on pods/${sub}`;
    return undefined;
  }

  startTerminal(spec: TermSpec, cb: (m: TermMessage) => void): TermSession {
    return fakeShell(
      {
        fail: this.terminalRefusal(spec.cluster, spec.namespace, spec.attach ? "attach" : "exec"),
        user: spec.attach ? "app" : "root",
        host: spec.pod,
        banner: spec.attach ? `\x1b[2m(attached to ${spec.container}: its own process gets what you type)\x1b[0m\r\n` : undefined,
        env: { HOSTNAME: spec.pod, KUBERNETES_SERVICE_HOST: "10.96.0.1", PATH: "/usr/local/bin:/usr/bin:/bin", TERM: "xterm-256color" },
      },
      cb,
    );
  }

  startDebug(spec: DebugSpec, cb: (m: TermMessage) => void): TermSession {
    const container = `debugger-${alnum(5)}`;
    return fakeShell(
      {
        fail: this.terminalRefusal(spec.cluster, spec.namespace, "attach"),
        entered: { pod: spec.pod, container },
        steps: [["waiting", `starting ${spec.image}`, 300], ["waiting", "ContainerCreating", 900]],
        user: "root",
        host: spec.pod,
        env: { HOSTNAME: spec.pod, PATH: "/bin:/usr/bin" },
      },
      cb,
    );
  }

  startNodeShell(spec: NodeShellSpec, cb: (m: TermMessage) => void): TermSession {
    return fakeShell(
      {
        fail: this.terminalRefusal(spec.cluster, spec.namespace, "create"),
        entered: { pod: `k10s-node-shell-${alnum(5)}`, container: "shell" },
        steps: [["connecting", `creating a helper pod on ${spec.node}`, 200], ["waiting", "ContainerCreating", 700]],
        user: "root",
        host: spec.node,
        banner: "\x1b[2m(in the node's namespaces; its helper pod is deleted when this session ends)\x1b[0m\r\n",
        env: { HOSTNAME: spec.node, PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" },
      },
      cb,
    );
  }

  private forwardsChanged() {
    for (const l of this.forwardListeners) l(this.forwards.map((f) => ({ ...f })));
  }

  /** Like the engine: refused where the user may not forward, or when the local port is taken (3000 always is). */
  async startForward(spec: ForwardSpec): Promise<ForwardInfo> {
    await sleep(250);
    if (RESTRICTED(spec.cluster)) throw { kind: "other", message: `no permission to port-forward in namespace "${spec.namespace}": it takes create on pods/portforward`, code: null };
    const taken = new Set([3000, ...this.forwards.map((f) => f.localPort)]);
    const local = spec.localPort ?? (spec.port >= 1024 && !taken.has(spec.port) ? spec.port : 49152 + Math.floor(rnd() * 16000));
    if (taken.has(local)) throw { kind: "other", message: `local port ${local} is in use (another program, or another forward): pick another`, code: null };
    const pod = spec.resource === "pods" ? spec.name : `${spec.name}-${alnum(10)}-${alnum(5)}`;
    const info: ForwardInfo = { id: ++this.nextForward, spec: { ...spec, localPort: local }, localPort: local, pod, podPort: spec.resource === "services" ? 8080 : spec.port, connections: 0, total: 0, sent: 0, received: 0, started: now() };
    this.forwards = [...this.forwards, info];
    this.forwardsChanged();
    return { ...info };
  }

  async stopForward(id: number) {
    const before = this.forwards.length;
    this.forwards = this.forwards.filter((f) => f.id !== id);
    this.forwardsChanged();
    return this.forwards.length !== before;
  }

  subscribeForwards(onList: (list: ForwardInfo[]) => void): Subscription {
    this.forwardListeners.add(onList);
    queueMicrotask(() => onList(this.forwards.map((f) => ({ ...f }))));
    // Some traffic now and then, a failure once in a while.
    const timer = setInterval(() => {
      if (!this.forwards.length) return;
      const f = pick(this.forwards);
      f.connections = Math.floor(rnd() * 3);
      f.total += 1;
      f.sent += Math.floor(rnd() * 2000);
      f.received += Math.floor(rnd() * 40000);
      f.error = rnd() < 0.08 ? `nothing listens on port ${f.podPort} in the pod (connection refused)` : undefined;
      this.forwardsChanged();
    }, 1500);
    return {
      close: () => {
        clearInterval(timer);
        this.forwardListeners.delete(onList);
      },
    };
  }

  /** Like the engine: the graph once its kinds are read, then again as the objects change (pods come and go). */
  subscribeRelations(spec: RelationsSpec, onGraph: (msg: GraphMessage) => void): Subscription {
    let closed = false;
    let last = "";
    const send = () => {
      if (closed) return;
      if (RESTRICTED(spec.cluster) && !ALLOWED_NAMESPACES.has(spec.namespace ?? "")) {
        onGraph({ t: "graph", focus: "", nodes: [], edges: [], notes: [], loading: false, error: `pods is forbidden: User "jane" cannot list resource "pods" in API group "" in the namespace "${spec.namespace}"` });
        return;
      }
      const g = mockGraph(spec, (resource) => [...this.items(spec.cluster, resource).values()]);
      if (RESTRICTED(spec.cluster)) g.notes.unshift("No access to secrets: what relates to them is not shown");
      const json = JSON.stringify(g);
      if (json !== last) onGraph(g);
      last = json;
    };
    queueMicrotask(() => !closed && onGraph({ t: "graph", focus: "", nodes: [], edges: [], notes: [], loading: true }));
    const first = setTimeout(send, 250 + rnd() * 300);
    const timer = setInterval(send, 1500);
    return {
      close: () => {
        closed = true;
        clearTimeout(first);
        clearInterval(timer);
      },
    };
  }

  async accessReview(cluster: string, checks: AccessCheck[]): Promise<AccessDecision[]> {
    await sleep(60 + rnd() * 140);
    if (UNREACHABLE.has(cluster)) throw { kind: "connect", message: `dial tcp 10.200.0.12:6443: i/o timeout (is the cluster reachable?)`, code: null };
    return checks.map((c) => ({ allowed: mockAllowed(cluster, c) }));
  }

  async accessRules(cluster: string, namespace: string): Promise<AccessRules> {
    await sleep(120 + rnd() * 200);
    if (UNREACHABLE.has(cluster)) throw { kind: "connect", message: `dial tcp 10.200.0.12:6443: i/o timeout (is the cluster reachable?)`, code: null };
    const readAll = { verbs: ["get", "list", "watch"], groups: ["*"], resources: ["*"] };
    if (RESTRICTED(cluster))
      return {
        resources: ALLOWED_NAMESPACES.has(namespace)
          ? [
              { verbs: ["get", "list", "watch"], groups: ["", "apps", "batch"], resources: ["pods", "services", "configmaps", "deployments", "statefulsets", "replicasets", "jobs", "cronjobs", "events"] },
              { verbs: ["get"], groups: [""], resources: ["pods/log"] },
            ]
          : [],
        incomplete: false,
      };
    if (!cluster.startsWith("acme-prod")) return { resources: [{ verbs: ["*"], groups: ["*"], resources: ["*"] }], incomplete: false };
    const frozen = namespace === "kube-system" || (cluster === "acme-prod-apps-z3" && namespace === "payments");
    return {
      resources: frozen ? [readAll] : [readAll, { verbs: ["create", "update", "patch", "delete", "deletecollection"], groups: ["", "apps", "batch", "autoscaling", "policy", "networking.k8s.io"], resources: ["*"] }],
      // Like clusters with a webhook authorizer next to RBAC: it cannot list what it allows.
      incomplete: cluster.endsWith("z4"),
    };
  }

  async openForward(id: number) {
    const f = this.forwards.find((x) => x.id === id);
    if (f) window.open(`http://localhost:${f.localPort}/`, "_blank", "noopener");
  }

  /** Helm releases per cluster (made on first use), and the views showing them. */
  private releases = new Map<string, ReturnType<typeof mockReleases>>();
  private helmViews = new Set<{ spec: ViewSpec; cb: (b: ViewBatch) => void }>();

  private releasesOf(cluster: string) {
    let r = this.releases.get(cluster);
    if (!r) this.releases.set(cluster, (r = mockReleases(cluster)));
    return r;
  }

  private release(cluster: string, namespace: string, name: string) {
    const r = this.releasesOf(cluster).find((x) => x.namespace === namespace && x.name === name);
    if (!r) throw { kind: "other", message: `release "${name}" not found in namespace "${namespace}"`, code: null };
    return r;
  }

  /** Like the engine: a view's table; strict-RBAC clusters may not read Secrets (where Helm keeps releases). */
  subscribeHelm(spec: ViewSpec, cb: (b: ViewBatch) => void): Subscription {
    const view = { spec, cb };
    this.helmViews.add(view);
    const scopes: (string | null)[] = spec.namespaces.length ? spec.namespaces : [null];
    queueMicrotask(() => cb({ t: "batch", m: [{ t: "schema", columns: HELM_COLUMNS }, ...spec.clusters.flatMap((c) => scopes.map((ns): ViewMessage => ({ t: "status", c, ns, state: "connecting" })))] }));
    for (const cluster of spec.clusters) {
      void this.connect(cluster).then(
        async () => {
          await sleep(150 + rnd() * 300);
          if (!this.helmViews.has(view)) return;
          const m: ViewMessage[] = [];
          for (const ns of scopes) {
            if (RESTRICTED(cluster)) {
              m.push({ t: "status", c: cluster, ns, state: "error", code: 403, reason: "Forbidden", terminal: true, message: `secrets is forbidden: User "jane" cannot list resource "secrets" in API group ""${ns ? ` in the namespace "${ns}"` : " at the cluster scope"}` });
              continue;
            }
            const up = this.releasesOf(cluster).filter((r) => !ns || r.namespace === ns).map(releaseRow);
            m.push({ t: "rows", c: cluster, ns, reset: true, up }, { t: "status", c: cluster, ns, state: "ready" });
          }
          cb({ t: "batch", m });
        },
        () => {},
      );
    }
    return { close: () => void this.helmViews.delete(view) };
  }

  private helmChanged(cluster: string, namespace: string, name: string) {
    const r = this.releasesOf(cluster).find((x) => x.namespace === namespace && x.name === name);
    for (const v of this.helmViews) {
      if (!v.spec.clusters.includes(cluster) || (v.spec.namespaces.length && !v.spec.namespaces.includes(namespace))) continue;
      const ns = v.spec.namespaces.length ? namespace : null;
      v.cb({ t: "batch", m: [r ? { t: "rows", c: cluster, ns, up: [releaseRow(r)] } : { t: "rows", c: cluster, ns, del: [`${namespace}/${name}`] }] });
    }
  }

  async helmRelease(cluster: string, namespace: string, name: string): Promise<HelmRelease> {
    await sleep(120);
    return releaseDetails(this.release(cluster, namespace, name));
  }

  async helmDiff(cluster: string, namespace: string, name: string, from: number, to: number): Promise<HelmDiff> {
    await sleep(80);
    return releaseDiff(this.release(cluster, namespace, name), from, to);
  }

  async helmRollback(cluster: string, namespace: string, name: string, revision: number) {
    this.guard();
    await sleep(900);
    rollBack(this.release(cluster, namespace, name), revision);
    setTimeout(() => this.helmChanged(cluster, namespace, name), 300);
    return "Rollback was a success! Happy Helming!";
  }

  async helmUninstall(targets: ObjectRef[]): Promise<OpResult[]> {
    this.guard();
    await sleep(700);
    return targets.map((t) => {
      const list = this.releasesOf(t.cluster);
      const i = list.findIndex((r) => r.namespace === t.namespace && r.name === t.name);
      if (i >= 0) list.splice(i, 1);
      setTimeout(() => this.helmChanged(t.cluster, t.namespace ?? "", t.name), 300);
      return { target: t, ok: i >= 0, error: i >= 0 ? undefined : { kind: "other", message: `uninstall: Release not loaded: ${t.name}: release: not found`, code: null } };
    });
  }

  /** Usage samples per `cluster/kind/namespace/name`, for `metricsHistory`. */
  private usageHistory = new Map<string, [number, number, number][]>();

  /** Like the engine's polls, faster: usage of what the mock generated; none on `kind-local` (no metrics-server). */
  subscribeMetrics(spec: MetricsSpec, cb: (m: MetricsMessage) => void): Subscription {
    let closed = false;
    const namespaces: (string | null)[] = spec.kind === "nodes" || !spec.namespaces?.length ? [null] : spec.namespaces;
    const scopes: [string, string | null][] = spec.clusters.flatMap((c) => namespaces.map((ns): [string, string | null] => [c, ns]));
    const poll = () => {
      if (closed) return;
      const at = now();
      for (const [cluster, ns] of scopes) {
        if (cluster === "kind-local") {
          cb({ t: "status", c: cluster, ns, state: "unavailable", message: "the cluster serves no metrics API (metrics-server is not installed)" });
          continue;
        }
        if (RESTRICTED(cluster) && spec.kind === "nodes") {
          cb({ t: "status", c: cluster, ns, state: "forbidden", message: "no permission to read metrics" });
          continue;
        }
        const rows = [...this.items(cluster, spec.kind).values()].filter((it) => !ns || it.row.ns === ns);
        const items = rows.flatMap((it): [string, string, number, number][] => {
          if (spec.kind === "nodes") return [["", it.row.n, Math.round(2000 + rnd() * 11000), Math.round((8 + rnd() * 48) * 1024 * MIB)]];
          if (!Array.isArray(it.row.c[1]) || it.row.c[1][0] !== "Running") return [];
          const n = (it.obj.spec?.containers?.length as number) ?? 1;
          // Some pods idle far below what they ask for, some run hot.
          const load = (it.row.n.charCodeAt(it.row.n.length - 1) % 7) / 4;
          return [[it.row.ns ?? "", it.row.n, Math.round(250 * n * load * (0.7 + rnd() * 0.6) * 10) / 10, Math.round(256 * MIB * n * (0.3 + load * 0.5) * (0.9 + rnd() * 0.2))]];
        });
        for (const [itemNs, name, cpu, mem] of items) {
          const key = `${cluster}/${spec.kind}/${itemNs}/${name}`;
          const h = [...(this.usageHistory.get(key) ?? []), [at, cpu, mem] as [number, number, number]].slice(-40);
          this.usageHistory.set(key, h);
        }
        cb({ t: "status", c: cluster, ns, state: "ok" });
        cb({ t: "usage", c: cluster, ns, at, items });
      }
    };
    queueMicrotask(poll);
    const timer = setInterval(poll, 3000);
    return {
      close() {
        closed = true;
        clearInterval(timer);
      },
    };
  }

  async metricsHistory(cluster: string, kind: MetricsKind, namespace: string | null, name: string): Promise<MetricsHistory | null> {
    const samples = this.usageHistory.get(`${cluster}/${kind}/${namespace ?? ""}/${name}`);
    if (!samples) return null;
    const [, cpu, mem] = samples[samples.length - 1];
    const containers: [string, number, number][] = kind === "pods" ? [["app", Math.round(cpu * 0.8), Math.round(mem * 0.85)], ["envoy", Math.round(cpu * 0.2), Math.round(mem * 0.15)]] : [];
    return { samples, containers };
  }

  async getObject(target: ObjectRef) {
    await sleep(15);
    const it = this.find(target);
    if (!it) throw { kind: "api", message: `${target.resource} "${target.name}" not found`, code: 404 };
    return it.obj;
  }

  async getYaml(target: ObjectRef, managedFields: boolean, reveal = false) {
    const obj = structuredClone(await this.getObject(target));
    if (managedFields) obj.metadata.managedFields = [{ manager: "kube-controller-manager", operation: "Update", apiVersion: "v1", time: obj.metadata.creationTimestamp, fieldsType: "FieldsV1", fieldsV1: { "f:status": {} } }];
    if (!reveal) maskSecret(obj);
    return toYaml(obj);
  }

  async deleteObjects(targets: ObjectRef[]): Promise<OpResult[]> {
    this.guard();
    await sleep(200);
    return targets.map((target) => {
      const items = this.data.get(`${target.cluster}|${target.resource}`);
      const it = this.find(target);
      if (items && it) {
        items.delete(it.row.u);
        for (const sub of this.views)
          if (sub.key === target.resource && sub.spec.clusters.includes(target.cluster))
            sub.cb({
              t: "batch",
              m: [
                sub.spec.projection === "names"
                  ? { t: "names", c: target.cluster, ns: sub.spec.namespaces.length ? (target.namespace ?? null) : null, del: [it.row.n] }
                  : { t: "rows", c: target.cluster, ns: sub.spec.namespaces.length ? (target.namespace ?? null) : null, del: [it.row.u] },
              ],
            });
      }
      return { target, ok: !!it };
    });
  }

  private find(target: ObjectRef): Item | undefined {
    const items = this.items(target.cluster, target.resource);
    if (target.uid && items.has(target.uid)) return items.get(target.uid);
    return [...items.values()].find((it) => it.row.n === target.name && (it.row.ns ?? null) === (target.namespace ?? null));
  }

  private guard() {
    if (this.settings.readOnly) throw { kind: "readOnly", message: "read-only mode is on: mutating actions are disabled", code: null };
  }

  async scale() {
    this.guard();
    await sleep(300);
  }
  async restart() {
    this.guard();
    await sleep(300);
  }
  async setUnschedulable() {
    this.guard();
    await sleep(200);
  }
  async setSuspend() {
    this.guard();
    await sleep(200);
  }
  async triggerCronJob(target: ObjectRef) {
    this.guard();
    await sleep(300);
    return `${target.name}-manual-${hex(5)}`;
  }
  async getSettings() {
    return { ...this.settings };
  }
  /** Like the engine: read-only mode can be turned on here, not off. */
  async setSettings(s: Settings) {
    this.storeSettings({ ...s, readOnly: s.readOnly || this.settings.readOnly });
    return { ...this.settings };
  }
  /** The desktop app asks natively before turning read-only mode off; the browser mock asks with `confirm`. */
  async setReadOnly(enabled: boolean) {
    if (!enabled && this.settings.readOnly && !window.confirm("Turn off read-only mode?\n\nDelete, scale, restart, cordon, suspend, trigger, Helm rollback and uninstall will work again, and so will shells in containers.")) return { ...this.settings };
    this.storeSettings({ ...this.settings, readOnly: enabled });
    return { ...this.settings };
  }
  private storeSettings(s: Settings) {
    this.settings = s;
    Object.assign(this.files.settings, s);
    this.saveFiles();
  }
  private saveFiles() {
    try {
      localStorage.setItem(MOCK_FILES_KEY, JSON.stringify(this.files));
    } catch {
      // the mock forgets them
    }
  }
  async loadPrefs(): Promise<PrefsSnapshot> {
    const folder = "~/Library/Application Support/io.dumkin.k10s";
    return { settings: structuredClone(this.files.settings), state: structuredClone(this.files.state), settingsError: null, settingsPath: `${folder}/settings.json`, statePath: `${folder}/state.json` };
  }
  /** Like the desktop app: the engine's settings change through the engine only. */
  async setPrefs(changes: PrefsChange[]) {
    for (const { doc, key, value } of changes) if (doc === "state" || !ENGINE_KEYS.includes(key.split(".")[0])) setAt(this.files[doc], key, value);
    this.saveFiles();
  }
  async resetPrefs() {
    this.files = { settings: Object.fromEntries(Object.entries(this.files.settings).filter(([k]) => ENGINE_KEYS.includes(k))), state: {} };
    this.saveFiles();
  }
  async openPrefsFile(doc: PrefsDoc) {
    console.info(`[mock] the desktop app opens ${doc}.json here; the mock keeps it in localStorage["${MOCK_FILES_KEY}"]`);
  }
  onSettingsChanged(cb: (change: SettingsChange) => void) {
    this.settingsListeners.add(cb);
    return () => void this.settingsListeners.delete(cb);
  }
  /** Dev: settings.json edited outside the app, as the desktop app sees it when its window gets the focus back. */
  editSettingsFile(settings: Record<string, unknown>, error: string | null = null) {
    if (!error) {
      this.files.settings = structuredClone(settings);
      this.settings = engineSettingsOf(settings);
      this.saveFiles();
    } else this.settings = { ...this.settings, readOnly: true };
    for (const cb of this.settingsListeners) cb({ settings: structuredClone(this.files.settings), error, engine: { ...this.settings } });
  }
  async stats(): Promise<HubStats> {
    let objects = 0;
    for (const m of this.data.values()) objects += m.size;
    return { feeds: this.data.size, active: this.views.size, objects, jsonBytes: 0 };
  }
  onEngineEvent(cb: (e: EngineEvent) => void) {
    this.listeners.add(cb);
    return () => void this.listeners.delete(cb);
  }
  log(level: LogLevel, message: string) {
    console.warn(`[mock engine log] ${level}:`, message);
  }
  heartbeat() {}
  async toggleDevtools() {}
  async openLogDir() {}
  async openProjectPage(page: "home" | "issues" | "releases") {
    window.open(`https://github.com/dumkin/k10s${page === "home" ? "" : `/${page}`}`, "_blank", "noopener");
  }
  setAppearance() {}
  /** The browser has its own zoom (⌘+ / ⌘−); here CSS zoom stands in for the desktop app's page zoom. */
  async setZoom(scale: number) {
    (document.documentElement.style as CSSStyleDeclaration & { zoom: string }).zoom = scale === 1 ? "" : String(scale);
  }
  async saveFile(name: string, contents: string) {
    // The browser has no save dialog to ask: a download stands in for it.
    const url = URL.createObjectURL(new Blob([contents], { type: "text/plain" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    return name;
  }
  async checkUpdate(): Promise<UpdateInfo | null> {
    if (!UPDATE) throw { kind: "other", message: "this build of k10s does not update itself", code: null };
    await sleep(400);
    return { ...MOCK_RELEASE, ready: mockDownloaded };
  }
  async downloadUpdate(): Promise<UpdateInfo> {
    await sleep(1500);
    mockDownloaded = true;
    return { ...MOCK_RELEASE, ready: true };
  }
  async installUpdate(): Promise<void> {
    await sleep(300);
    location.reload();
  }
  async openUpdateNotes(): Promise<void> {
    window.open("about:blank", "_blank");
  }
}

/** What the engine's `problems` projection lets through: rows that are not fine (see `view.rs`). */
const isProblem = (r: Row) => r.s === Tone.Warn || r.s === Tone.Error || r.s === Tone.Info || !!r.x;

function matches(it: Item, ns: string | null, spec: ViewSpec) {
  if (ns && it.row.ns !== ns) return false;
  if (spec.labelSelector) {
    const want = spec.labelSelector.split(",").map((s) => s.trim());
    const have = new Set((it.row.l ?? "").split(" "));
    if (!want.every((w) => have.has(w))) return false;
  }
  if (spec.fieldSelector?.startsWith("metadata.name=")) return it.row.n === spec.fieldSelector.slice("metadata.name=".length);
  if (spec.fieldSelector === "type=Warning") return it.obj.type === "Warning";
  if (spec.fieldSelector?.startsWith("involvedObject.name=")) {
    return it.obj.involvedObject?.name?.startsWith(spec.fieldSelector.split("=")[1].split("-").slice(0, -2).join("-")) ?? false;
  }
  return true;
}

const PATHS = ["/api/v1/orders", "/api/v1/cart", "/healthz", "/api/v1/payments/authorize", "/metrics", "/api/v2/search?q=shoes", "/api/v1/orders/48213", "/readyz"];
/** Requests show up in several pods and clusters: following one of them works across them. */
const TRACES = Array.from({ length: 24 }, (_, k) => (0x5f3a91c0e2b4d6f8n + BigInt(k) * 0x9e3779b97f4a7c15n).toString(16).slice(-16).padStart(16, "0"));
const USERS = ["bob", "alice", "u-1093", "u-2210", "carol"];

function hashOf(t: LogTarget): number {
  let h = 0;
  for (const ch of t.pod + t.container) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return Math.abs(h);
}

/** A container that crashes now and then in the mock (its pod's name decides). */
function crashy(t: LogTarget): boolean {
  return hashOf(t) % 6 === 0 && t.container !== "envoy";
}

const MOCK_STARTED = Date.now();
/** Earlier history: a container's log has a line every this many millis… */
const LOG_STEP = 900;
/**
 * …from its start (half an hour to six and a half hours before the app started, its pod's name decides) until now;
 * a crashing one's previous run ended a few seconds before that, after forty minutes.
 */
function logRun(t: LogTarget, previous: boolean): [number, number] {
  const start = MOCK_STARTED - (30 + (hashOf(t) % 4) * 120) * 60_000;
  return previous ? [start - 40 * 60_000, start - 5000] : [start, Date.now()];
}

const auditShare = (() => {
  try {
    return Math.min(1, Number(localStorage.getItem("k10s:mock.logAudit")) || 0);
  } catch {
    return 0;
  }
})();
const iso = (ms: number) => new Date(ms).toISOString();
const ms = () => Math.floor(rnd() * 320);

/**
 * An audit record as a chat server writes it next to its own log, with no level: a JSON object of who and where,
 * whose event is JSON in a string, and the event itself — JSON with JSON in its strings, then pairs. Kilobytes each.
 */
function auditLines(t: LogTarget, ts: number): string[] {
  const user = `${alnum(6)}_${alnum(5)}`;
  const ip = `${10 + Math.floor(rnd() * 180)}.${Math.floor(rnd() * 250)}.${Math.floor(rnd() * 250)}.${Math.floor(rnd() * 250)}`;
  const item = { id: alnum(26), room: alnum(26), thread: alnum(26), author: alnum(26), created: ts, edited: 0, removed: 0, text: Array.from({ length: 30 + Math.floor(rnd() * 600) }, () => alnum(3 + Math.floor(rnd() * 8))).join(" "), extra: { automated: "false", files: Array.from({ length: Math.floor(rnd() * 4) }, () => ({ id: alnum(26), name: `${alnum(10)}.png`, size: Math.floor(rnd() * 900000) })) } };
  const event = { action: pick(["readItem", "readThread", "createItem", "listUsers", "markThreadRead", "listItemsSince"]), after: rnd() < 0.5 ? JSON.stringify(item) : '""', item_id: JSON.stringify(alnum(26)), before: rnd() < 0.3 ? JSON.stringify(item) : '""', user_agent: pick(["ExampleChat-iOS/2.4.0 (iPhone)", "ExampleChat-Desktop/2.4.0 Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko)", "Go-http-client/1.1"]) };
  const who = { host: t.pod, stream: "audit", user, email: `${user}@example.com`, src_ip: ip, event: JSON.stringify(event), session_id: alnum(26), request_id: alnum(26), ts: ts / 1000 };
  return [JSON.stringify(who), `${JSON.stringify(event)} src_ip=${ip} dest_ip=${ip} handler=/api/${pick(["users", "items", "rooms/members"])} trace_id=${hex(16)} span_id=${hex(16)} status=200`];
}

/** What a container writes (its kind of app decides the format): one line, or a few (a stack trace). */
function logLines(t: LogTarget, ts: number): string[] {
  // A load test of huge lines: `localStorage["k10s:mock.logAudit"]` of the lines (0…1) are audit records.
  if (auditShare && rnd() < auditShare) return auditLines(t, ts);
  const c = t.container;
  const r = rnd();
  const path = pick(PATHS);
  const trace = pick(TRACES);
  if (c === "envoy") return [`[${iso(ts)}] "${pick(["GET", "GET", "POST"])} ${path} HTTP/1.1" ${pick([200, 200, 200, 200, 304, 404, 503])} - 0 ${Math.floor(rnd() * 900)} ${ms()} ${ms()} "10.4.${Math.floor(rnd() * 9)}.${Math.floor(rnd() * 250)}" "Go-http-client/1.1" "${trace}" "${t.pod.split("-")[0]}:8080"`];
  if (c === "ingress") return [`10.0.${Math.floor(rnd() * 9)}.${Math.floor(rnd() * 250)} - - [04/Oct/2026:10:42:01 +0000] "${pick(["GET", "POST"])} ${path} HTTP/2.0" ${pick([200, 200, 200, 301, 404, 499, 502])} ${Math.floor(rnd() * 5000)} "-" "Mozilla/5.0" 512 0.0${Math.floor(rnd() * 99)} [checkout-checkout-web-80] [] 10.4.1.${Math.floor(rnd() * 250)}:8080 612 0.0${Math.floor(rnd() * 99)} 200 ${trace}`];
  if (c === "payments") {
    // Java (logback), with stack traces.
    const stamp = iso(ts).replace("T", " ").replace("Z", "");
    if (r < 0.06)
      return [
        `${stamp} ERROR [http-nio-8080-exec-${Math.floor(rnd() * 9)}] c.a.p.AuthorizeHandler - authorization failed for order ${Math.floor(rnd() * 90000)} trace=${trace}`,
        "com.acme.payments.GatewayException: upstream ledger returned 503",
        "\tat com.acme.payments.LedgerClient.post(LedgerClient.java:118)",
        "\tat com.acme.payments.AuthorizeHandler.handle(AuthorizeHandler.java:64)",
        "\tat org.springframework.web.servlet.FrameworkServlet.service(FrameworkServlet.java:897)",
        "\tat jakarta.servlet.http.HttpServlet.service(HttpServlet.java:658)",
        "\tat org.apache.catalina.core.ApplicationFilterChain.doFilter(ApplicationFilterChain.java:166)",
        "\tat org.apache.catalina.core.StandardWrapperValve.invoke(StandardWrapperValve.java:167)",
        "\tat org.apache.catalina.core.StandardContextValve.invoke(StandardContextValve.java:90)",
        "\tat org.apache.catalina.connector.CoyoteAdapter.service(CoyoteAdapter.java:340)",
        "\tat org.apache.coyote.http11.Http11Processor.service(Http11Processor.java:391)",
        "\tat org.apache.tomcat.util.net.NioEndpoint$SocketProcessor.doRun(NioEndpoint.java:1744)",
        "\tat java.base/java.lang.Thread.run(Thread.java:1583)",
        "Caused by: java.net.SocketTimeoutException: Read timed out",
        "\tat java.base/sun.nio.ch.NioSocketImpl.timedRead(NioSocketImpl.java:278)",
        "\tat java.base/java.net.Socket$SocketInputStream.read(Socket.java:1099)",
        "\t... 14 common frames omitted",
      ];
    // One zone has trouble of its own: its pods cannot reach the ledger's database.
    if (t.cluster.endsWith("z2") && r < 0.12) return [`${stamp} ERROR [http-nio-8080-exec-${Math.floor(rnd() * 9)}] c.a.p.LedgerClient - connection to ledger-db.payments.svc:5432 failed: i/o timeout after ${3000 + Math.floor(rnd() * 2000)}ms trace=${trace}`];
    if (r < 0.2) return [`${stamp} WARN  [scheduler-1] c.a.p.Reconciler - ${Math.floor(rnd() * 40)} payments pending longer than 30s`];
    return [`${stamp} INFO  [http-nio-8080-exec-${Math.floor(rnd() * 9)}] c.a.p.AuthorizeHandler - authorized order ${Math.floor(rnd() * 90000)} amount=${(rnd() * 400).toFixed(2)} EUR in ${ms()}ms trace=${trace}`];
  }
  if (c === "ledger")
    return [
      JSON.stringify({
        level: r < 0.05 ? "error" : r < 0.15 ? "warn" : r < 0.3 ? "debug" : "info",
        ts: ts / 1000,
        caller: pick(["ledger/post.go:88", "ledger/balance.go:41", "server/http.go:212"]),
        msg: r < 0.05 ? "posting rejected" : r < 0.15 ? "slow commit" : pick(["entry posted", "balance read", "request completed"]),
        trace_id: trace,
        account: `acc-${Math.floor(rnd() * 900) + 100}`,
        amount_cents: Math.floor(rnd() * 90000),
        latency_ms: r < 0.15 ? 400 + Math.floor(rnd() * 2000) : ms(),
        ...(r < 0.05 ? { error: "pq: could not serialize access due to concurrent update" } : {}),
      }),
    ];
  if (c === "cart" || c === "pricing" || c === "promo")
    return [
      JSON.stringify({
        level: r < 0.04 ? 50 : r < 0.12 ? 40 : 30,
        time: ts,
        pid: 1,
        hostname: t.pod,
        req: { method: pick(["GET", "POST"]), url: path, id: trace },
        res: { statusCode: r < 0.04 ? 500 : r < 0.12 ? 404 : 200 },
        responseTime: ms(),
        user: pick(USERS),
        msg: r < 0.04 ? "request errored" : "request completed",
      }),
    ];
  if (c === "search" || c === "suggest" || c === "indexer" || c === "grafana")
    return [`ts=${iso(ts)} level=${r < 0.04 ? "error" : r < 0.12 ? "warn" : r < 0.25 ? "debug" : "info"} caller=${pick(["query.go:77", "index.go:120", "shard.go:33"])} msg="${r < 0.04 ? "query failed" : r < 0.12 ? "shard slow" : pick(["query served", "segment merged", "cache refreshed"])}" shard=${Math.floor(rnd() * 12)} took=${ms()}ms hits=${Math.floor(rnd() * 900)} trace_id=${trace}`];
  if (c === "prometheus" || c === "alertmanager") return [`ts=${iso(ts)} caller=${pick(["head.go:1130", "compact.go:520", "notifier.go:211"])} level=${r < 0.1 ? "warn" : "info"} component=${pick(["tsdb", "rule manager", "notifier"])} msg="${r < 0.1 ? "Error on ingesting samples that are too old or are too far into the future" : pick(["Head GC completed", "write block", "Completed loading of configuration file"])}" duration=${ms()}ms`];
  if (c === "metrics" || c === "kube" || c === "coredns") {
    const d = new Date(ts);
    const klog = `${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")} ${iso(ts).slice(11, 23)}000       1`;
    if (c === "coredns") return [`[${r < 0.05 ? "ERROR" : "INFO"}] 10.4.${Math.floor(rnd() * 9)}.${Math.floor(rnd() * 250)}:${40000 + Math.floor(rnd() * 20000)} - ${Math.floor(rnd() * 65000)} "A IN ${pick(["payments-api", "ledger", "cart"])}.payments.svc.cluster.local. udp 64 false 512" ${r < 0.05 ? "SERVFAIL" : "NOERROR"} qr,aa,rd 106 0.000${Math.floor(rnd() * 900)}s`];
    return [r < 0.06 ? `E${klog} reflector.go:147] failed to list *v1.Pod: the server was unable to return a response in the time allotted` : r < 0.15 ? `W${klog} scraper.go:149] "Failed to scrape node" err="request timeout" node="node-${Math.floor(rnd() * 9)}"` : `I${klog} server.go:${Math.floor(rnd() * 300)}] "Scraped metrics" nodes=${Math.floor(rnd() * 40)} duration="${ms()}ms"`];
  }
  if (c === "vector") return [`${iso(ts)} \x1b[${r < 0.1 ? "33m WARN" : "32m INFO"}\x1b[0m \x1b[2mvector::sinks::http\x1b[0m: ${r < 0.1 ? "Retrying after error. error=Request timed out" : `Events sent. count=${Math.floor(rnd() * 500)} byte_size=${Math.floor(rnd() * 90000)}`}`];
  if (c === "hello" && r < 0.03)
    return ['ERROR:root:Unhandled exception while serving "/"', "Traceback (most recent call last):", '  File "/app/server.py", line 42, in handle', "    reply = render(request)", '  File "/app/views.py", line 7, in render', '    return TEMPLATES[request.path]', "KeyError: '/favicon.ico'"];
  // Coloured text (checkout and the rest).
  if (r < 0.45) return [JSON.stringify({ level: pick(["info", "info", "info", "debug", "warn"]), ts: iso(ts), logger: "http", msg: "request completed", method: pick(["GET", "POST"]), path, status: pick([200, 200, 201, 404, 500]), latency_ms: ms(), trace_id: trace })];
  if (r < 0.7) return [`\x1b[32mINFO\x1b[0m  [${pick(["http", "db", "cache", "worker"])}] ${pick(["served request", "cache hit ratio 0.93", "flushed 128 records", "connection pool size=20 idle=14"])} \x1b[2m(${ms()}ms)\x1b[0m`];
  if (r < 0.85) return [`\x1b[33mWARN\x1b[0m  slow query detected: SELECT * FROM orders WHERE customer_id = $1 (${200 + Math.floor(rnd() * 800)}ms)`];
  if (r < 0.97) return [`\x1b[31mERROR\x1b[0m upstream ${pick(["payments-api", "ledger", "pricing"])} returned 503: connection refused`];
  return ["panic: runtime error: index out of range [3] with length 3", "", "goroutine 42 [running]:", "main.handler(...)", "\t/src/handler.go:87 +0x1d4", "created by net/http.(*Server).Serve in goroutine 1", "\t/usr/local/go/src/net/http/server.go:3285 +0x4b4"];
}

// Minimal YAML emitter for mock objects (the real one lives in Rust).
function toYaml(v: unknown, ind = 0): string {
  const pad = " ".repeat(ind);
  const scalar = (x: unknown) => (typeof x === "string" ? (/^[\w./-][\w ./:-]*$/.test(x) && !/^(true|false|null|\d+)$/.test(x) ? x : JSON.stringify(x)) : String(x));
  if (Array.isArray(v)) {
    if (!v.length) return "[]\n";
    return v.map((x) => (x && typeof x === "object" && !Array.isArray(x) && Object.keys(x).length ? `${pad}- ${toYaml(x, ind + 2).trimStart()}` : `${pad}- ${typeof x === "object" ? toYaml(x, ind + 2).trim() : scalar(x)}\n`)).join("");
  }
  if (v && typeof v === "object") {
    const entries = Object.entries(v).filter(([, x]) => x !== undefined);
    if (!entries.length) return "{}\n";
    return entries
      .map(([k, x]) => {
        if (typeof x === "string" && x.includes("\n")) return `${pad}${k}: |\n${x.replace(/\n$/, "").split("\n").map((l) => `${pad}  ${l}`).join("\n")}\n`;
        if (Array.isArray(x)) return x.length ? `${pad}${k}:\n${toYaml(x, ind)}` : `${pad}${k}: []\n`;
        if (x && typeof x === "object") return Object.keys(x).length ? `${pad}${k}:\n${toYaml(x, ind + 2)}` : `${pad}${k}: {}\n`;
        return `${pad}${k}: ${scalar(x)}\n`;
      })
      .join("");
  }
  return `${scalar(v)}\n`;
}
