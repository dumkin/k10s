import { batch, createEffect, createSignal, onCleanup } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import { backend, type Cell, type MetricsMessage, type MetricsStatus } from "../lib/backend";
import { registerExtraColumns } from "../registry/columns";
import { selectedClusters } from "./clusters";
import { namespaces, resourceKey } from "./nav";
import type { UIRow } from "./view";

// CPU and memory usage from the metrics API, for the pods and nodes tables: the engine polls it while they are
// shown (every 15 s) and keeps a short history for the details. Columns are computed from the latest numbers and
// the row's own cells (a pod's requests and limits, a node's allocatable).

export interface Usage {
  cpu: number;
  mem: number;
}

const usageKey = (cluster: string, namespace: string, name: string) => `${cluster}\0${namespace}\0${name}`;

const [usage, setUsage] = createSignal<ReadonlyMap<string, Usage>>(new Map());
/** Why a cluster×namespace has no numbers (`${cluster}|${namespace}`), for the line under the table. */
const [statuses, setStatuses] = createStore<Record<string, MetricsStatus & { c: string }>>({});
/** The objects each cluster×namespace had at its latest poll: they make room for the next one's. */
const scopes = new Map<string, string[]>();

export const usageOf = (r: UIRow): Usage | undefined => usage().get(usageKey(r.cl, r.ns ?? "", r.n));

function onMessage(m: MetricsMessage) {
  const scope = `${m.c}|${m.ns ?? ""}`;
  if (m.t === "status") {
    setStatuses(scope, m.state === "ok" ? undefined! : { ...m });
    return;
  }
  const next = new Map(usage());
  for (const k of scopes.get(scope) ?? []) next.delete(k);
  const keys: string[] = [];
  for (const [ns, name, cpu, mem] of m.items) {
    const k = usageKey(m.c, ns, name);
    keys.push(k);
    next.set(k, { cpu, mem });
  }
  scopes.set(scope, keys);
  setUsage(next);
}

/** Why usage is missing, per cluster (one reason each), while the table shows pods or nodes. */
export function metricsNotices(): Record<string, string> {
  const out: Record<string, string> = {};
  if (resourceKey() !== "pods" && resourceKey() !== "nodes") return out;
  for (const s of Object.values(statuses)) if (s && s.state !== "ok") out[s.c] = `no CPU and memory usage: ${s.message}`;
  return out;
}

/** Follows the main table: while it shows pods or nodes, their usage streams in. */
export function initMetrics() {
  createEffect(() => {
    const key = resourceKey();
    const kind = key === "pods" ? "pods" : key === "nodes" ? "nodes" : null;
    const clusters = selectedClusters();
    if (!kind || !clusters.length) return;
    const spec = { kind, clusters, namespaces: kind === "pods" ? namespaces() : [] } as const;
    batch(() => {
      setStatuses(reconcile({}));
      if (kind === "nodes" || !spec.namespaces.length) scopes.clear();
    });
    const sub = backend().subscribeMetrics({ ...spec, namespaces: [...spec.namespaces] }, onMessage);
    onCleanup(() => sub.close());
  });
}

const num = (c: Cell): number | null => (typeof c === "number" ? c : null);
const share = (used: number | undefined, of: Cell): Cell => {
  const bound = num(of);
  return used === undefined || !bound ? null : (used / bound) * 100;
};

registerExtraColumns("pods", [
  { id: "cpuUsed", title: "CPU", kind: "usageCpu", width: 72, description: "CPU in use (metrics API); against the limit", cell: (r, own) => (usageOf(r) ? [usageOf(r)!.cpu, num(own(r, "cpuLimit"))] : null) },
  { id: "memUsed", title: "MEM", kind: "usageMem", width: 80, description: "Memory in use (metrics API); against the limit", cell: (r, own) => (usageOf(r) ? [usageOf(r)!.mem, num(own(r, "memLimit"))] : null) },
  { id: "cpuPctR", title: "%CPU/R", kind: "percentRequest", width: 72, hidden: true, description: "CPU in use, % of the request", cell: (r, own) => share(usageOf(r)?.cpu, own(r, "cpuRequest")) },
  { id: "cpuPctL", title: "%CPU/L", kind: "percentLimit", width: 72, hidden: true, description: "CPU in use, % of the limit", cell: (r, own) => share(usageOf(r)?.cpu, own(r, "cpuLimit")) },
  { id: "memPctR", title: "%MEM/R", kind: "percentRequest", width: 76, hidden: true, description: "Memory in use, % of the request", cell: (r, own) => share(usageOf(r)?.mem, own(r, "memRequest")) },
  { id: "memPctL", title: "%MEM/L", kind: "percentLimit", width: 76, hidden: true, description: "Memory in use, % of the limit", cell: (r, own) => share(usageOf(r)?.mem, own(r, "memLimit")) },
]);

registerExtraColumns("nodes", [
  { id: "cpuUsed", title: "CPU used", kind: "nodeCpu", width: 80, description: "CPU in use (metrics API); against the allocatable", cell: (r, own) => (usageOf(r) ? [usageOf(r)!.cpu, num(own(r, "cpu"))] : null) },
  { id: "cpuPct", title: "%CPU", kind: "percentLimit", width: 64, description: "CPU in use, % of the allocatable", cell: (r, own) => share(usageOf(r)?.cpu, own(r, "cpu")) },
  { id: "memUsed", title: "MEM used", kind: "nodeMem", width: 86, description: "Memory in use (metrics API); against the allocatable", cell: (r, own) => (usageOf(r) ? [usageOf(r)!.mem, num(own(r, "memory"))] : null) },
  { id: "memPct", title: "%MEM", kind: "percentLimit", width: 64, description: "Memory in use, % of the allocatable", cell: (r, own) => share(usageOf(r)?.mem, own(r, "memory")) },
]);
