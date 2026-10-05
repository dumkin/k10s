import { type Cell, type Column, type Row, Tone } from "./backend";
import { humanDuration as span } from "./format";
import { HELM_RELEASES } from "./helm";

// "Needs attention": what is wrong across the clusters, from the rows of objects that are not fine (the engine's
// `problems` projection: failing, degraded, in progress, being deleted). Each is judged by what its table shows —
// the same status and colour — and the same trouble in several clusters makes one issue, with where it is.

/** The "Needs attention" view's key, where a resource's would be (navigation, history, the sidebar, the palette). */
export const ATTENTION = "attention";

export type Severity = "critical" | "warning" | "info";
export const SEVERITIES: Severity[] = ["critical", "warning", "info"];

/** In progress for longer than this (pending, creating, initializing), a pod is stuck. */
export const STUCK_AFTER_S = 5 * 60;
/** Not ready for longer than this after it started, a pod counts as unready (not just starting). */
export const UNREADY_AFTER_S = 2 * 60;
/** Being deleted for this long (as seen from here), an object is stuck. */
export const TERMINATING_AFTER_S = 5 * 60;
/** Warning events seen within this long count. */
export const EVENTS_WITHIN_S = 60 * 60;

type UIRow = Row & { cl: string; key: string };

/** One source of rows: a resource's problems view across the clusters. */
export interface SourceRows {
  resource: string;
  columns: Column[];
  rows: UIRow[];
}

/** One object in trouble, in one cluster. */
export interface Instance {
  cluster: string;
  /** Its resource key (where it opens). */
  resource: string;
  name: string;
  namespace?: string;
  /** Its row's key (unique across clusters). */
  key: string;
  /** Its status as its table shows it. */
  status: string;
  tone: Tone;
  /** What is known of when: how long it has been so ("for 32m"), its last restart, its creation, its start. */
  when?: When;
  /** "12 restarts", "on node-04". */
  facts: string[];
}

/** A time (unix seconds) and what it is: since when it is so, its last restart, its creation, its start. */
export interface When {
  at: number;
  how: "for" | "restarted" | "created" | "started";
}

/** One trouble — the same in every cluster it is in. */
export interface Issue {
  key: string;
  severity: Severity;
  /** The resource of what it is about (a workload whose pods fail, a node, a release…). */
  resource: string;
  /** Its kind in words: "Deployment", "Pod", "Node". */
  kind: string;
  /** What it is about: a workload's name; for nodes, "Nodes". */
  subject: string;
  namespace?: string;
  /** What is wrong: "CrashLoopBackOff", "2/3 ready", "NotReady". */
  reason: string;
  /** A sentence about it. */
  detail?: string;
  /** Objects in trouble, per cluster. */
  where: Map<string, Instance[]>;
  /** Objects in trouble in all clusters. */
  count: number;
  /** The longest it has been so (or the latest restart). */
  when?: When;
  /** Warning events: their message and how often they came. */
  message?: string;
  events?: number;
}

/** A row's cell by column id. */
export function cellOf(columns: Column[], row: Row, id: string): Cell | undefined {
  const i = columns.findIndex((c) => c.id === id);
  return i < 0 ? undefined : row.c[i];
}

const statusOf = (c: Cell | undefined): [string, Tone] | undefined => (Array.isArray(c) && typeof c[0] === "string" ? (c as [string, Tone]) : undefined);
const pairOf = (c: Cell | undefined): [number, number | null] | undefined => (Array.isArray(c) && typeof c[0] === "number" ? (c as [number, number | null]) : undefined);
const ratioOf = (c: Cell | undefined): [number, number] | undefined => (Array.isArray(c) && typeof c[0] === "number" && typeof c[1] === "number" ? (c as [number, number]) : undefined);
const numOf = (c: Cell | undefined): number | undefined => (typeof c === "number" ? c : undefined);
const textOf = (c: Cell | undefined): string | undefined => (typeof c === "string" ? c : undefined);

/** `k=v k2=v2` (label values have no spaces) as a map. */
export function parseLabels(labels: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const kv of (labels ?? "").split(" ")) {
    const i = kv.indexOf("=");
    if (i > 0) out[kv.slice(0, i)] = kv.slice(i + 1);
  }
  return out;
}

/**
 * The workload a pod belongs to, from its name and the labels its controller gives it: a Deployment's pods carry
 * `pod-template-hash` (`web-7d9f8c6b5-x2x4z`), a StatefulSet's their ordinal, a DaemonSet's a revision hash, a
 * Job's its name — and a CronJob's jobs are named after it and a time. A bare pod is its own.
 */
export function podOwner(name: string, labels: string | undefined): { resource: string; kind: string; name: string } {
  const l = parseLabels(labels);
  const hash = l["pod-template-hash"];
  if (hash) {
    const i = name.lastIndexOf(`-${hash}-`);
    if (i > 0) return { resource: "deployments.apps", kind: "Deployment", name: name.slice(0, i) };
  }
  const job = l["batch.kubernetes.io/job-name"] ?? l["job-name"];
  if (job) {
    const m = /^(.+)-(\d{8,})$/.exec(job);
    return m ? { resource: "cronjobs.batch", kind: "CronJob", name: m[1] } : { resource: "jobs.batch", kind: "Job", name: job };
  }
  if (l["statefulset.kubernetes.io/pod-name"] && /-\d+$/.test(name)) return { resource: "statefulsets.apps", kind: "StatefulSet", name: name.replace(/-\d+$/, "") };
  if (l["controller-revision-hash"] && l["pod-template-generation"] && /-[a-z0-9]{5}$/.test(name)) return { resource: "daemonsets.apps", kind: "DaemonSet", name: name.replace(/-[a-z0-9]{5}$/, "") };
  return { resource: "pods", kind: "Pod", name };
}

/** The letters Kubernetes makes generated names and hashes of (`rand.SafeEncodeString`): no vowels, no 0, 1 or 3. */
const SAFE = "bcdfghjklmnpqrstvwxz2456789";
const GENERATED = new Map<string, RegExp>();

/** `name` without a generated suffix of `min` to `max` such letters (`web-7d9f8c6b5` → `web`). */
export function stripGenerated(name: string, min: number, max: number): string {
  const k = `${min},${max}`;
  let re = GENERATED.get(k);
  if (!re) GENERATED.set(k, (re = new RegExp(`-[${SAFE}]{${min},${max}}$`)));
  return name.replace(re, "");
}

/** What one row says, before grouping: its issue (without where) and itself. */
interface Finding {
  severity: Severity;
  resource: string;
  kind: string;
  subject: string;
  reason: string;
  detail?: string;
  message?: string;
  events?: number;
  instance: Instance;
}

/** When the UI first saw an object like this (for what rows do not say: how long it has been terminating). */
export type SeenSince = (key: string) => number;

const KIND: Record<string, string> = {
  pods: "Pod",
  "deployments.apps": "Deployment",
  "statefulsets.apps": "StatefulSet",
  "daemonsets.apps": "DaemonSet",
  "jobs.batch": "Job",
  nodes: "Node",
  persistentvolumeclaims: "Volume claim",
  "horizontalpodautoscalers.autoscaling": "Autoscaler",
  [HELM_RELEASES]: "Helm release",
};

/** Words for a resource key no table above knows: `certificates.cert-manager.io` → "Certificate". */
function kindOf(resource: string): string {
  if (KIND[resource]) return KIND[resource];
  const plural = resource.split(".")[0];
  const singular = plural.endsWith("ies") ? `${plural.slice(0, -3)}y` : plural.endsWith("ses") ? plural.slice(0, -2) : plural.replace(/s$/, "");
  return singular.charAt(0).toUpperCase() + singular.slice(1);
}

function base(src: SourceRows, row: UIRow, status: string, tone: Tone, when?: When, facts: string[] = []): Instance {
  return { cluster: row.cl, resource: src.resource, name: row.n, namespace: row.ns, key: row.key, status, tone, when, facts };
}

function pod(src: SourceRows, row: UIRow, now: number, seen: SeenSince): Finding | undefined {
  const [status, tone] = statusOf(cellOf(src.columns, row, "status")) ?? ["", row.s];
  const ready = ratioOf(cellOf(src.columns, row, "ready"));
  const restarts = pairOf(cellOf(src.columns, row, "restarts"));
  const node = textOf(cellOf(src.columns, row, "node"));
  const age = now - row.t;
  const facts = [restarts?.[0] ? `${restarts[0]} restart${restarts[0] === 1 ? "" : "s"}` : "", node ? `on ${node}` : ""].filter(Boolean);
  const owner = podOwner(row.n, row.l);
  const finding = (severity: Severity, reason: string, when: When | undefined, detail?: string): Finding => ({
    severity,
    resource: owner.resource,
    kind: owner.kind,
    subject: owner.name,
    reason,
    detail,
    instance: base(src, row, status || reason, tone, when, facts),
  });
  if (row.x || status === "Terminating") {
    const since = seen(`${row.key}\nterminating`);
    return now - since >= TERMINATING_AFTER_S ? finding("warning", "Stuck terminating", { at: since, how: "for" }, "Being deleted for minutes: a finalizer, or a node that does not answer") : undefined;
  }
  if (status === "Evicted") return finding("info", "Evicted", { at: row.t, how: "created" }, "Evicted pods stay until deleted: they tell of node pressure when they were evicted");
  // A job's pod that failed: its job tries again (up to its backoff limit) — the job failing is what is critical.
  if (tone === Tone.Error && (owner.kind === "Job" || owner.kind === "CronJob") && status !== "CrashLoopBackOff" && !status.includes("ImagePull") && !status.includes("Config"))
    return finding("info", "Job pod failed", { at: row.t, how: "created" }, `${status || "Failed"}: its job retries up to its backoff limit`);
  if (tone === Tone.Error) return finding("critical", status || "Failed", restarts?.[1] ? { at: restarts[1], how: "restarted" } : { at: row.t, how: "created" });
  if (tone === Tone.Warn) {
    if (age < UNREADY_AFTER_S) return undefined;
    return finding("warning", "Not ready", { at: row.t, how: "created" }, ready ? `${ready[0]}/${ready[1]} containers ready` : undefined);
  }
  if (tone === Tone.Info) {
    if (age < STUCK_AFTER_S) return undefined;
    if (status === "SchedulingGated") return finding("info", "Scheduling gated", { at: row.t, how: "for" }, "Waits for its scheduling gates to be removed");
    const reason = status === "Pending" ? "Pending" : status === "ContainerCreating" ? "Stuck creating" : status.startsWith("Init:") || status === "PodInitializing" ? "Stuck initializing" : status || "Pending";
    return finding("warning", reason, { at: row.t, how: "for" }, `${status || "Pending"} for ${span(age)}`);
  }
  return undefined;
}

function workload(src: SourceRows, row: UIRow): Finding | undefined {
  const ready = ratioOf(cellOf(src.columns, row, "ready"));
  const kind = kindOf(src.resource);
  const ratio = ready ? `${ready[0]}/${ready[1]}` : "";
  const make = (severity: Severity, reason: string, detail?: string): Finding => ({
    severity,
    resource: src.resource,
    kind,
    subject: row.n,
    reason,
    detail,
    instance: base(src, row, ratio ? `${ratio} ready` : reason, row.s),
  });
  if (row.x) return undefined;
  if (row.s === Tone.Error) return make("critical", "Rollout stuck", `Its rollout made no progress within its deadline${ratio ? `; ${ratio} ready` : ""}`);
  if (row.s !== Tone.Warn || !ready) return undefined;
  const updated = numOf(cellOf(src.columns, row, "upToDate"));
  if (updated !== undefined && updated < ready[1]) return make("info", "Rolling out", `${updated}/${ready[1]} updated, ${ratio} ready`);
  return make("warning", `${ratio} ready`, `${ready[1] - ready[0]} of ${ready[1]} replicas not ready`);
}

function job(src: SourceRows, row: UIRow): Finding | undefined {
  const [status, tone] = statusOf(cellOf(src.columns, row, "status")) ?? ["", row.s];
  if (tone !== Tone.Error) return undefined;
  const started = pairOf(cellOf(src.columns, row, "duration"))?.[0];
  const owner = /^(.+)-(\d{8,})$/.exec(row.n);
  return {
    severity: "critical",
    resource: owner ? "cronjobs.batch" : src.resource,
    kind: owner ? "CronJob" : "Job",
    subject: owner ? owner[1] : row.n,
    reason: "Job failed",
    detail: status === "FailureTarget" ? "Failing: its pods are being stopped" : undefined,
    instance: base(src, row, status, tone, { at: started ?? row.t, how: "started" }),
  };
}

function node(src: SourceRows, row: UIRow, seen: SeenSince): Finding | undefined {
  const [status, tone] = statusOf(cellOf(src.columns, row, "status")) ?? ["", row.s];
  if (tone === Tone.Error)
    return { severity: "critical", resource: "nodes", kind: "Node", subject: "Nodes", reason: status.split(",")[0] || "NotReady", detail: "The kubelet does not report ready: pods there may be gone", instance: base(src, row, status, tone, { at: seen(`${row.key}\n${status}`), how: "for" }) };
  if (status.includes("SchedulingDisabled")) return { severity: "info", resource: "nodes", kind: "Node", subject: "Nodes", reason: "Cordoned", detail: "No new pods are scheduled there", instance: base(src, row, status, tone, { at: seen(`${row.key}\ncordoned`), how: "for" }) };
  return undefined;
}

function claim(src: SourceRows, row: UIRow, now: number): Finding | undefined {
  const [status, tone] = statusOf(cellOf(src.columns, row, "status")) ?? ["", row.s];
  const make = (severity: Severity, reason: string, detail?: string): Finding => ({ severity, resource: src.resource, kind: "Volume claim", subject: row.n, reason, detail, instance: base(src, row, status, tone, { at: row.t, how: "for" }) });
  if (status === "Pending") return now - row.t >= STUCK_AFTER_S ? make("warning", "Pending", `Not bound for ${span(now - row.t)}: no volume could be provisioned or matched`) : undefined;
  if (tone === Tone.Error) return make("critical", status || "Lost", "Its volume is gone");
  return undefined;
}

function autoscaler(src: SourceRows, row: UIRow): Finding | undefined {
  if (row.s !== Tone.Warn) return undefined;
  const max = numOf(cellOf(src.columns, row, "maxPods"));
  const replicas = numOf(cellOf(src.columns, row, "replicas"));
  const target = textOf(cellOf(src.columns, row, "reference"));
  const atMax = max !== undefined && replicas !== undefined && replicas >= max;
  return {
    severity: "warning",
    resource: src.resource,
    kind: "Autoscaler",
    subject: row.n,
    reason: atMax ? "At max replicas" : "Cannot scale",
    detail: atMax ? `${replicas}/${max} replicas${target ? ` of ${target}` : ""}: it would scale out further if it could` : `Its metrics are unavailable${target ? ` for ${target}` : ""}`,
    instance: base(src, row, atMax ? `${replicas}/${max}` : "inactive", row.s),
  };
}

function release(src: SourceRows, row: UIRow): Finding | undefined {
  const [status, tone] = statusOf(cellOf(src.columns, row, "status")) ?? ["", row.s];
  if (tone === Tone.Error) return { severity: "critical", resource: src.resource, kind: "Helm release", subject: row.n, reason: "Release failed", detail: "Its last install, upgrade or rollback failed", instance: base(src, row, status, tone) };
  if (tone === Tone.Warn && status.startsWith("pending"))
    return { severity: "warning", resource: src.resource, kind: "Helm release", subject: row.n, reason: `Stuck ${status}`, detail: "Helm refuses other operations on it until this one ends", instance: base(src, row, status, tone) };
  return undefined;
}

/** A warning event: its reason and object, grouped with the same in other clusters and of the same workload. */
function event(src: SourceRows, row: UIRow, now: number): Finding | undefined {
  if (row.s !== Tone.Warn) return undefined;
  const last = numOf(cellOf(src.columns, row, "lastSeen")) ?? row.t;
  if (now - last > EVENTS_WITHIN_S) return undefined;
  const reason = textOf(cellOf(src.columns, row, "reason")) ?? "Warning";
  const object = textOf(cellOf(src.columns, row, "object")) ?? "";
  const [kind, name] = object.includes("/") ? [object.slice(0, object.indexOf("/")), object.slice(object.indexOf("/") + 1)] : ["", object];
  // A pod's events are its workload's (`web-7d9f8c6b5-x2x4z` → `web`), a replica set's its deployment's.
  const subject = kind === "pod" ? stripGenerated(stripGenerated(name, 5, 5), 6, 10) : kind === "replicaset" ? stripGenerated(name, 6, 10) : name;
  const count = numOf(cellOf(src.columns, row, "count")) ?? 1;
  return {
    severity: "info",
    resource: src.resource,
    kind: kind ? `${kind.charAt(0).toUpperCase()}${kind.slice(1)}` : "Object",
    subject: subject || "(cluster)",
    reason,
    message: textOf(cellOf(src.columns, row, "message")),
    events: count,
    instance: base(src, row, `${count}× ${object}`, row.s, { at: last, how: "for" }),
  };
}

/** Any other resource (custom ones with a Ready or status column): its own colour says how bad. */
function other(src: SourceRows, row: UIRow): Finding | undefined {
  if (row.s !== Tone.Error && row.s !== Tone.Warn) return undefined;
  // The status column that says what is wrong: the worst of them (an Argo app's health, not its sync status).
  const BAD: Record<number, number> = { [Tone.Error]: 3, [Tone.Warn]: 2, [Tone.Info]: 1 };
  let statusCol: Column | undefined;
  let status: [string, Tone] | undefined;
  for (const c of src.columns.filter((c) => c.kind === "status")) {
    const st = statusOf(cellOf(src.columns, row, c.id));
    if (st && (BAD[st[1]] ?? 0) > (BAD[status?.[1] ?? Tone.Neutral] ?? 0)) [statusCol, status] = [c, st];
  }
  const reason = status ? `${statusCol!.title === "Ready" ? "Ready: " : ""}${status[0]}` : row.s === Tone.Error ? "Failing" : "Degraded";
  return { severity: row.s === Tone.Error ? "critical" : "warning", resource: src.resource, kind: kindOf(src.resource), subject: row.n, reason, instance: base(src, row, status?.[0] ?? reason, row.s) };
}

/** What a row says is wrong, if anything. */
export function judge(src: SourceRows, row: UIRow, now: number, seen: SeenSince): Finding | undefined {
  switch (src.resource) {
    case "pods":
      return pod(src, row, now, seen);
    case "deployments.apps":
    case "statefulsets.apps":
    case "daemonsets.apps":
      return workload(src, row);
    case "jobs.batch":
      return job(src, row);
    case "nodes":
      return node(src, row, seen);
    case "persistentvolumeclaims":
      return claim(src, row, now);
    case "horizontalpodautoscalers.autoscaling":
      return autoscaler(src, row);
    case HELM_RELEASES:
      return release(src, row);
    case "events":
    case "events.events.k8s.io":
      return event(src, row, now);
    default:
      return other(src, row);
  }
}

const RANK: Record<Severity, number> = { critical: 0, warning: 1, info: 2 };

/** What an issue says of when: the longest it has been so — but the latest restart (how recent the crashes are). */
function earlier(a: When | undefined, b: When | undefined): When | undefined {
  if (!a || !b) return a ?? b;
  if (a.how === "restarted" && b.how === "restarted") return a.at >= b.at ? a : b;
  if (a.how === "restarted" || b.how === "restarted") return a.how === "restarted" ? a : b;
  return a.at <= b.at ? a : b;
}

/**
 * The issues in `sources`: what each row says, the same trouble of the same thing in several clusters as one issue
 * (where each cluster's objects are, in `clusters` order), the worst first, then the widest.
 */
export function findIssues(sources: SourceRows[], now: number, seen: SeenSince, clusters: string[]): Issue[] {
  const byKey = new Map<string, Issue>();
  for (const src of sources)
    for (const row of src.rows) {
      const f = judge(src, row, now, seen);
      if (!f) continue;
      // Nodes and events are grouped across namespaces (nodes have none); workloads by namespace and name.
      const ns = f.resource === "nodes" ? undefined : row.ns;
      const key = [f.resource === "events" || f.resource === "events.events.k8s.io" ? `event:${f.kind}` : f.resource, ns ?? "", f.subject, f.reason].join("\n");
      let issue = byKey.get(key);
      if (!issue) {
        issue = { key, severity: f.severity, resource: f.resource, kind: f.kind, subject: f.subject, namespace: ns, reason: f.reason, detail: f.detail, where: new Map(), count: 0, message: f.message, events: 0 };
        byKey.set(key, issue);
      }
      if (RANK[f.severity] < RANK[issue.severity]) issue.severity = f.severity;
      const list = issue.where.get(row.cl) ?? [];
      list.push(f.instance);
      issue.where.set(row.cl, list);
      issue.count++;
      if (f.events) issue.events = (issue.events ?? 0) + f.events;
      issue.when = earlier(issue.when, f.instance.when);
    }
  const order = new Map(clusters.map((c, i) => [c, i]));
  for (const issue of byKey.values()) {
    issue.where = new Map([...issue.where].sort((a, b) => (order.get(a[0]) ?? 999) - (order.get(b[0]) ?? 999)));
    for (const list of issue.where.values()) list.sort((a, b) => a.name.localeCompare(b.name));
  }
  return [...byKey.values()].sort(
    (a, b) => RANK[a.severity] - RANK[b.severity] || b.where.size - a.where.size || b.count - a.count || a.subject.localeCompare(b.subject) || a.reason.localeCompare(b.reason),
  );
}

export const isEventIssue = (i: Issue) => i.resource === "events" || i.resource === "events.events.k8s.io";

/**
 * Where an issue is, against the zones of each family picked: "only in z2" when one zone of several has it, "z1, z3
 * of 4" when some do, "all 4 zones" when every one does — the difference between a broken release and a broken DC.
 * Empty for clusters picked alone. `family` gives a cluster's zone family (undefined: none), `short` its short name.
 */
export function spreadNote(issueClusters: string[], picked: string[], family: (c: string) => string | undefined, short: (c: string) => string): string {
  const families = new Map<string, string[]>();
  for (const c of picked) {
    const f = family(c);
    if (f) families.set(f, [...(families.get(f) ?? []), c]);
  }
  const notes: string[] = [];
  for (const members of families.values()) {
    if (members.length < 2) continue;
    const hit = members.filter((m) => issueClusters.includes(m));
    if (!hit.length) continue;
    if (hit.length === members.length) notes.push(`all ${members.length} zones`);
    else if (hit.length === 1) notes.push(`only in ${short(hit[0])}`);
    else notes.push(`${hit.map(short).join(", ")} of ${members.length}`);
  }
  return notes.join(" · ");
}
