// Pod specs in words: probes and lifecycle hooks, the environment a container gets (with where each value comes from),
// and what decides where a pod may run. Pure functions over object JSON, for the details panel.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type K = any;

const SUFFIX: Record<string, number> = {
  "": 1,
  n: 1e-9,
  u: 1e-6,
  m: 1e-3,
  k: 1e3,
  M: 1e6,
  G: 1e9,
  T: 1e12,
  P: 1e15,
  E: 1e18,
  Ki: 1024,
  Mi: 1024 ** 2,
  Gi: 1024 ** 3,
  Ti: 1024 ** 4,
  Pi: 1024 ** 5,
  Ei: 1024 ** 6,
};

/** A quantity ("250m", "1.5", "512Mi", "1e3") in plain units (cores, bytes); NaN when it is none. */
export function parseQuantity(q: string | number | null | undefined): number {
  if (q === null || q === undefined) return NaN;
  if (typeof q === "number") return q;
  const m = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)([a-zA-Z]*)$/.exec(q.trim());
  const mult = m ? SUFFIX[m[2]] : undefined;
  return m && mult !== undefined ? Number(m[1]) * mult : NaN;
}

// ---------------------------------------------------------------------------------------------
// Probes and lifecycle hooks
// ---------------------------------------------------------------------------------------------

/** A port as the spec names it: a number, or a name with the number it stands for among `ports` ("http (8080)"). */
function portText(port: unknown, ports?: K[]): string {
  if (typeof port === "string" && !/^\d+$/.test(port)) {
    const n = ports?.find((p) => p.name === port)?.containerPort;
    return n ? `${port} (${n})` : port;
  }
  return String(port ?? "");
}

/** What a probe or hook does: "HTTP GET :8080/healthz", "TCP :5432", "exec: pg_isready", "gRPC :9090", "sleep 5s". */
export function handlerText(h: K, ports?: K[]): string {
  if (!h) return "";
  if (h.httpGet) {
    const g = h.httpGet;
    const headers = g.httpHeaders?.length ? ` (+${g.httpHeaders.length} header${g.httpHeaders.length > 1 ? "s" : ""})` : "";
    return `${String(g.scheme ?? "HTTP").toUpperCase()} GET ${g.host ?? ""}:${portText(g.port, ports)}${g.path ?? "/"}${headers}`;
  }
  if (h.tcpSocket) return `TCP ${h.tcpSocket.host ?? ""}:${portText(h.tcpSocket.port, ports)}`;
  if (h.grpc) return `gRPC :${h.grpc.port}${h.grpc.service ? ` (${h.grpc.service})` : ""}`;
  if (h.exec) return `exec: ${(h.exec.command ?? []).join(" ")}`;
  if (h.sleep) return `sleep ${h.sleep.seconds}s`;
  return "?";
}

export type ProbeKind = "startup" | "liveness" | "readiness";

export interface ProbeInfo {
  kind: ProbeKind;
  /** "HTTP GET :8080/healthz" */
  check: string;
  /** "every 10s · timeout 1s · 3 failures" */
  timing: string;
  /** kubectl describe's line: `http-get http://:8080/healthz delay=0s timeout=1s period=10s #success=1 #failure=3`. */
  detail: string;
}

/** The probes a container has, startup first (it runs before the others), with the API's defaults filled in. */
export function probesOf(c: K): ProbeInfo[] {
  const out: ProbeInfo[] = [];
  for (const kind of ["startup", "liveness", "readiness"] as const) {
    const p = c?.[`${kind}Probe`];
    if (!p) continue;
    const delay = p.initialDelaySeconds ?? 0;
    const period = p.periodSeconds ?? 10;
    const timeout = p.timeoutSeconds ?? 1;
    const success = p.successThreshold ?? 1;
    const failure = p.failureThreshold ?? 3;
    const parts = [`every ${period}s`, `timeout ${timeout}s`, `${failure} failure${failure === 1 ? "" : "s"}`];
    if (delay) parts.push(`after ${delay}s`);
    if (success > 1) parts.push(`${success} successes`);
    // How long a slow start may take before the container is restarted.
    if (kind === "startup") parts.push(`≤${delay + failure * period}s to start`);
    const check = handlerText(p, c.ports);
    const g = p.httpGet;
    const describe = g
      ? `http-get ${String(g.scheme ?? "HTTP").toLowerCase()}://${g.host ?? ""}:${g.port}${g.path ?? "/"}`
      : p.tcpSocket
        ? `tcp-socket ${p.tcpSocket.host ?? ""}:${p.tcpSocket.port}`
        : p.grpc
          ? `grpc <pod>:${p.grpc.port} ${p.grpc.service ?? ""}`.trimEnd()
          : `exec [${(p.exec?.command ?? []).join(" ")}]`;
    out.push({ kind, check, timing: parts.join(" · "), detail: `${describe} delay=${delay}s timeout=${timeout}s period=${period}s #success=${success} #failure=${failure}` });
  }
  return out;
}

/** postStart / preStop hooks: "preStop: sleep 5s". */
export function lifecycleOf(c: K): string[] {
  const l = c?.lifecycle;
  if (!l) return [];
  return (["postStart", "preStop"] as const).filter((k) => l[k]).map((k) => `${k}: ${handlerText(l[k], c.ports)}`);
}

// ---------------------------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------------------------

export type EnvSource =
  | { kind: "value" }
  | { kind: "configMap" | "secret"; name: string; key: string; optional: boolean }
  | { kind: "field"; path: string }
  | { kind: "resource"; resource: string; container?: string; divisor?: string };

export interface EnvVar {
  name: string;
  /** As written in the spec (`$(VAR)` references unexpanded); for `value` sources only. */
  value?: string;
  source: EnvSource;
}

/** `envFrom`: every key of a ConfigMap or Secret, as variables named `prefix + key`. */
export interface EnvFrom {
  kind: "configMap" | "secret";
  name: string;
  prefix: string;
  optional: boolean;
}

/** A container's `env` and `envFrom`, in their order. */
export function envOf(c: K): { vars: EnvVar[]; from: EnvFrom[] } {
  const vars: EnvVar[] = ((c?.env ?? []) as K[]).map((e): EnvVar => {
    const f = e.valueFrom;
    if (!f) return { name: e.name, value: e.value ?? "", source: { kind: "value" } };
    if (f.configMapKeyRef) return { name: e.name, source: { kind: "configMap", name: f.configMapKeyRef.name ?? "", key: f.configMapKeyRef.key ?? "", optional: !!f.configMapKeyRef.optional } };
    if (f.secretKeyRef) return { name: e.name, source: { kind: "secret", name: f.secretKeyRef.name ?? "", key: f.secretKeyRef.key ?? "", optional: !!f.secretKeyRef.optional } };
    if (f.fieldRef) return { name: e.name, source: { kind: "field", path: f.fieldRef.fieldPath ?? "" } };
    if (f.resourceFieldRef) return { name: e.name, source: { kind: "resource", resource: f.resourceFieldRef.resource ?? "", container: f.resourceFieldRef.containerName, divisor: f.resourceFieldRef.divisor } };
    return { name: e.name, value: "", source: { kind: "value" } };
  });
  const from: EnvFrom[] = ((c?.envFrom ?? []) as K[]).flatMap((s): EnvFrom[] => {
    const ref = s.configMapRef ?? s.secretRef;
    if (!ref) return [];
    return [{ kind: s.configMapRef ? "configMap" : "secret", name: ref.name ?? "", prefix: s.prefix ?? "", optional: !!ref.optional }];
  });
  return { vars, from };
}

/** What a `fieldRef` gives in this pod (the kubelet's downward API), if the pod says. */
export function fieldValue(pod: K, path: string): string | undefined {
  const m = /^metadata\.(labels|annotations)\['(.*)'\]$/.exec(path);
  if (m) return pod?.metadata?.[m[1]]?.[m[2]];
  const ips = (list: K[] | undefined) => list?.map((x) => x.ip).join(",");
  switch (path) {
    case "metadata.name":
      return pod?.metadata?.name;
    case "metadata.namespace":
      return pod?.metadata?.namespace;
    case "metadata.uid":
      return pod?.metadata?.uid;
    case "spec.nodeName":
      return pod?.spec?.nodeName;
    case "spec.serviceAccountName":
      return pod?.spec?.serviceAccountName;
    case "status.hostIP":
      return pod?.status?.hostIP;
    case "status.hostIPs":
      return ips(pod?.status?.hostIPs);
    case "status.podIP":
      return pod?.status?.podIP;
    case "status.podIPs":
      return ips(pod?.status?.podIPs);
    default:
      return undefined;
  }
}

/**
 * What a `resourceFieldRef` gives: the container's request or limit divided by `divisor`, rounded up — as the kubelet
 * computes it ("250m" CPU is 1 with the default divisor 1). Undefined for a limit that is not set (then it is the
 * node's allocatable, which the pod does not say).
 */
export function resourceFieldValue(container: K, resource: string, divisor?: string): string | undefined {
  const dot = resource.indexOf(".");
  const raw = dot > 0 ? container?.resources?.[resource.slice(0, dot)]?.[resource.slice(dot + 1)] : undefined;
  const v = parseQuantity(raw);
  const d = divisor === undefined ? 1 : parseQuantity(divisor);
  if (!Number.isFinite(v) || !Number.isFinite(d) || d <= 0) return undefined;
  // Exact for millicores and bytes: no floating-point noise like 0.30000000000000004.
  return String(Math.ceil(Math.round((v / d) * 1e9) / 1e9));
}

/**
 * Kubernetes' `$(VAR)` expansion in env values, commands and args: a reference to a variable defined before it is
 * replaced, `$$` is a literal `$`, anything else stays as written (an unknown variable too).
 */
export function expandVars(value: string, lookup: (name: string) => string | undefined): string {
  let out = "";
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch !== "$" || i + 1 >= value.length) {
      out += ch;
      continue;
    }
    const next = value[i + 1];
    if (next === "$") {
      out += "$";
      i++;
    } else if (next === "(") {
      const end = value.indexOf(")", i + 2);
      if (end < 0) {
        out += value.slice(i);
        break;
      }
      const v = lookup(value.slice(i + 2, end));
      out += v ?? value.slice(i, end + 1);
      i = end;
    } else out += ch;
  }
  return out;
}

/** Names `envFrom` keys may become: what the kubelet accepts (it skips others, with an event). */
export const isEnvName = (name: string) => /^[-._a-zA-Z][-._a-zA-Z0-9]*$/.test(name);

// ---------------------------------------------------------------------------------------------
// Scheduling
// ---------------------------------------------------------------------------------------------

/** A selector requirement: "zone in (z1, z2)", "arch = arm64", "gpu exists", "no spot". */
export function requirementText(e: K): string {
  const values: string[] = e?.values ?? [];
  switch (e?.operator) {
    case "In":
      return values.length === 1 ? `${e.key} = ${values[0]}` : `${e.key} in (${values.join(", ")})`;
    case "NotIn":
      return values.length === 1 ? `${e.key} ≠ ${values[0]}` : `${e.key} not in (${values.join(", ")})`;
    case "Exists":
      return `${e.key} exists`;
    case "DoesNotExist":
      return `no ${e.key}`;
    case "Gt":
      return `${e.key} > ${values[0]}`;
    case "Lt":
      return `${e.key} < ${values[0]}`;
    default:
      return `${e?.key} ${e?.operator} ${values.join(", ")}`;
  }
}

/** A node selector term: its requirements, all of which must hold. */
export function nodeTermText(term: K): string {
  const parts = [...((term?.matchExpressions ?? []) as K[]), ...((term?.matchFields ?? []) as K[])].map(requirementText);
  return parts.length ? parts.join(" and ") : "any node";
}

/** A label selector: "app=web, tier in (api, worker)"; "every pod" when it is empty. */
export function selectorText(sel: K): string {
  if (!sel) return "no pods";
  const parts = [...Object.entries((sel.matchLabels ?? {}) as Record<string, string>).map(([k, v]) => `${k}=${v}`), ...((sel.matchExpressions ?? []) as K[]).map(requirementText)];
  return parts.length ? parts.join(", ") : "every pod";
}

/** A topology key in words: "node", "zone", "region", else the key. */
export function topologyText(key: string | undefined): string {
  switch (key) {
    case "kubernetes.io/hostname":
      return "node";
    case "topology.kubernetes.io/zone":
    case "failure-domain.beta.kubernetes.io/zone":
      return "zone";
    case "topology.kubernetes.io/region":
    case "failure-domain.beta.kubernetes.io/region":
      return "region";
    default:
      return key ?? "?";
  }
}

/** Where the pods a pod-affinity term counts are looked for. */
function namespacesText(term: K): string {
  if (term?.namespaceSelector) return Object.keys(term.namespaceSelector).length ? ` in namespaces ${selectorText(term.namespaceSelector)}` : " in any namespace";
  return term?.namespaces?.length ? ` in ${term.namespaces.join(", ")}` : "";
}

/** "on a node with pods app=cache", or for anti-affinity "not on a node with pods app=web". */
export function podAffinityText(term: K, anti: boolean): string {
  const where = topologyText(term?.topologyKey);
  const place = where === "node" ? "on a node" : where === "zone" || where === "region" ? `in a ${where}` : `in the same ${where}`;
  const keys = term?.matchLabelKeys?.length ? ` (same ${term.matchLabelKeys.join(", ")})` : "";
  return `${anti ? "not " : ""}${place} with pods ${selectorText(term?.labelSelector)}${namespacesText(term)}${keys}`;
}

export interface AffinityRule {
  /** Required (`requiredDuringScheduling…`), or preferred with a weight. */
  required: boolean;
  weight?: number;
  text: string;
  /** What the rule is called when it is neither ("best effort" spreading). */
  label?: string;
}

/** Node affinity, pod affinity and anti-affinity of a pod spec, each rule in words. */
export function affinityOf(spec: K): { node: AffinityRule[]; pod: AffinityRule[]; antiPod: AffinityRule[] } {
  const a = spec?.affinity ?? {};
  const node: AffinityRule[] = [];
  const required = a.nodeAffinity?.requiredDuringSchedulingIgnoredDuringExecution?.nodeSelectorTerms as K[] | undefined;
  // Terms are alternatives: one of them must hold.
  if (required?.length) node.push({ required: true, text: required.map(nodeTermText).join("  or  ") });
  for (const p of (a.nodeAffinity?.preferredDuringSchedulingIgnoredDuringExecution ?? []) as K[]) node.push({ required: false, weight: p.weight, text: nodeTermText(p.preference) });
  const podRules = (aff: K, anti: boolean): AffinityRule[] => [
    ...((aff?.requiredDuringSchedulingIgnoredDuringExecution ?? []) as K[]).map((t) => ({ required: true, text: podAffinityText(t, anti) })),
    ...((aff?.preferredDuringSchedulingIgnoredDuringExecution ?? []) as K[]).map((p) => ({ required: false, weight: p.weight, text: podAffinityText(p.podAffinityTerm, anti) })),
  ];
  return { node, pod: podRules(a.podAffinity, false), antiPod: podRules(a.podAntiAffinity, true) };
}

/** The tolerations every pod gets from admission (not-ready and unreachable nodes, 300s): noise, unless changed. */
export function isDefaultToleration(t: K): boolean {
  return (
    (t?.key === "node.kubernetes.io/not-ready" || t?.key === "node.kubernetes.io/unreachable") && t.operator === "Exists" && t.effect === "NoExecute" && t.tolerationSeconds === 300
  );
}

/** "dedicated=gpu:NoSchedule", "node.kubernetes.io/unreachable:NoExecute for 300s", "every taint". */
export function tolerationText(t: K): string {
  if (!t?.key && t?.operator === "Exists") return t.effect ? `every ${t.effect} taint` : "every taint";
  const what = t.operator === "Exists" ? `${t.key}` : `${t.key}=${t.value ?? ""}`;
  const effect = t.effect ? `:${t.effect}` : " (any effect)";
  return `${what}${effect}${t.tolerationSeconds !== undefined && t.tolerationSeconds !== null ? ` for ${t.tolerationSeconds}s` : ""}`;
}

/** A topology spread constraint: "at most 1 apart across zones, pods app=web (required)". */
export function spreadText(c: K): string {
  const where = topologyText(c?.topologyKey);
  const across = where === "node" || where === "zone" || where === "region" ? `${where}s` : where;
  const extra = [c?.minDomains ? `at least ${c.minDomains} ${across}` : "", c?.matchLabelKeys?.length ? `same ${c.matchLabelKeys.join(", ")}` : ""].filter(Boolean);
  return `at most ${c?.maxSkew ?? 1} apart across ${across}, pods ${selectorText(c?.labelSelector)}${extra.length ? ` (${extra.join(", ")})` : ""}`;
}
