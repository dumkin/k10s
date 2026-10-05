import { type Column, type HelmDiff, type HelmRelease, type HelmRevision, type Row, Tone } from "./types";

// Helm releases for the browser mock: a few per cluster, the same across a zone family but not quite (one lags a
// chart version behind, one failed an upgrade), with histories to diff and roll back.

export const HELM_COLUMNS: Column[] = [
  { id: "revision", title: "Revision", kind: "number", width: 80 },
  { id: "status", title: "Status", kind: "status", width: 130 },
  { id: "chart", title: "Chart", kind: "text", width: 220 },
  { id: "appVersion", title: "App Version", kind: "text", width: 120 },
  { id: "updated", title: "Updated", kind: "age", width: 100 },
  { id: "description", title: "Description", kind: "text", width: 280, hidden: true },
];

interface MockRelease {
  name: string;
  namespace: string;
  history: (HelmRevision & { values: string; manifest: string })[];
}

const day = 86_400;

function revisions(name: string, chart: string, versions: string[], app: (v: string) => string, last: string, created: number): MockRelease["history"] {
  const out: MockRelease["history"] = versions.map((v, i) => {
    const latest = i === versions.length - 1;
    return {
      revision: i + 1,
      status: latest ? last : "superseded",
      chart: `${chart}-${v}`,
      appVersion: app(v),
      updated: created + i * 3 * day,
      description: i === 0 ? "Install complete" : latest && last === "failed" ? `Upgrade "${name}" failed: context deadline exceeded` : "Upgrade complete",
      values: `image:\n  tag: ${app(v)}\nreplicaCount: ${2 + (i % 3)}\nresources:\n  requests:\n    cpu: ${100 + i * 50}m\n    memory: 256Mi\n`,
      manifest: `---\n# Source: ${chart}/templates/deployment.yaml\napiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: ${name}\n  labels:\n    helm.sh/chart: ${chart}-${v}\n    app.kubernetes.io/version: "${app(v)}"\nspec:\n  replicas: ${2 + (i % 3)}\n  template:\n    spec:\n      containers:\n        - name: ${name}\n          image: "registry.acme.dev/${name}:${app(v)}"\n          resources:\n            requests:\n              cpu: ${100 + i * 50}m\n              memory: 256Mi\n`,
    };
  });
  return out.reverse();
}

/** The releases of a cluster: its zone (the last characters) decides what lags behind. */
export function mockReleases(cluster: string): MockRelease[] {
  const zone = cluster.slice(-2);
  const created = Math.floor(Date.now() / 1000) - 60 * day;
  const lag = zone === "z2";
  return [
    { name: "ingress-nginx", namespace: "ingress-nginx", history: revisions("ingress-nginx", "ingress-nginx", ["4.10.1", "4.11.0", "4.11.2", ...(lag ? [] : ["4.11.3"])], (v) => `1.${v.split(".")[1]}.${v.split(".")[2]}`, "deployed", created) },
    { name: "cert-manager", namespace: "cert-manager", history: revisions("cert-manager", "cert-manager", ["v1.15.3", "v1.16.0", "v1.16.1"], (v) => v, "deployed", created) },
    {
      name: "kube-prometheus-stack",
      namespace: "monitoring",
      history: revisions("kube-prometheus-stack", "kube-prometheus-stack", ["62.7.0", "64.0.0", "65.1.0"], (v) => `v0.${70 + Number(v.split(".")[0]) - 60}.1`, zone === "z3" ? "failed" : "deployed", created),
    },
    { name: "payments-api", namespace: "payments", history: revisions("payments-api", "payments-api", ["2.3.0", "2.3.4", "2.4.0", ...(lag ? [] : ["2.4.1"])], (v) => v, "deployed", created) },
    { name: "redis", namespace: "checkout", history: revisions("redis", "redis", ["20.1.0", "20.2.1"], (v) => (v === "20.2.1" ? "7.4.1" : "7.4.0"), "deployed", created) },
    { name: "loki", namespace: "monitoring", history: revisions("loki", "loki", ["6.16.0", "6.18.0"], (v) => (v === "6.18.0" ? "3.2.0" : "3.1.1"), zone === "z4" ? "pending-upgrade" : "deployed", created) },
  ];
}

const tone = (status: string) => (status === "deployed" ? Tone.Ok : status === "failed" ? Tone.Error : status === "superseded" ? Tone.Muted : Tone.Warn);

export function releaseRow(r: MockRelease): Row {
  const cur = r.history[0];
  const first = r.history[r.history.length - 1];
  return {
    u: `${r.namespace}/${r.name}`,
    n: r.name,
    ns: r.namespace,
    rv: String(cur.revision),
    t: first.updated ?? 0,
    s: tone(cur.status),
    c: [cur.revision, [cur.status, tone(cur.status)], cur.chart, cur.appVersion, cur.updated ?? null, cur.description],
  };
}

export function releaseDetails(r: MockRelease): HelmRelease {
  const cur = r.history[0];
  return {
    name: r.name,
    namespace: r.namespace,
    revision: cur.revision,
    status: cur.status,
    chart: cur.chart,
    appVersion: cur.appVersion,
    description: cur.description,
    firstDeployed: r.history[r.history.length - 1].updated,
    lastDeployed: cur.updated,
    notes: `${r.name} is installed.\n\nGet its status with:\n  kubectl --namespace ${r.namespace} get pods -l "app.kubernetes.io/instance=${r.name}"\n`,
    values: cur.values,
    computed: `${cur.values}nodeSelector: {}\ntolerations: []\naffinity: {}\nservice:\n  type: ClusterIP\n  port: 80\n`,
    manifest: cur.manifest,
    history: r.history.map(({ values: _v, manifest: _m, ...h }) => h),
  };
}

/** A line diff good enough for the mock: lines gone, then lines added, in one hunk. */
function unified(a: string, b: string, from: number, to: number): string {
  if (a === b) return "";
  const al = a.split("\n");
  const bl = b.split("\n");
  const removed = al.filter((l) => !bl.includes(l)).map((l) => `-${l}`);
  const added = bl.filter((l) => !al.includes(l)).map((l) => `+${l}`);
  return [`--- revision ${from}`, `+++ revision ${to}`, `@@ -1,${al.length} +1,${bl.length} @@`, ...removed, ...added, ""].join("\n");
}

export function releaseDiff(r: MockRelease, from: number, to: number): HelmDiff {
  const pick = (rev: number) => {
    const h = r.history.find((x) => x.revision === rev);
    if (!h) throw { kind: "other", message: `revision ${rev} of "${r.name}" is not kept any more`, code: null };
    return h;
  };
  const a = pick(from);
  const b = pick(to);
  return { values: unified(a.values, b.values, from, to), manifest: unified(a.manifest, b.manifest, from, to) };
}

/** `helm rollback`: a new revision with the old one's chart and values. */
export function rollBack(r: MockRelease, revision: number) {
  const to = r.history.find((h) => h.revision === revision);
  if (!to) throw { kind: "other", message: `release has no revision ${revision}`, code: null };
  for (const h of r.history) if (h.status === "deployed" || h.status === "failed") h.status = "superseded";
  r.history.unshift({ ...to, revision: r.history[0].revision + 1, status: "deployed", updated: Math.floor(Date.now() / 1000), description: `Rollback to ${revision}` });
}
