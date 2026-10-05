import { describe, expect, it } from "vitest";
import { findIssues, judge, podOwner, type SourceRows, spreadNote, stripGenerated } from "./attention";
import { type Cell, type Column, Tone } from "./backend";
import { HELM_RELEASES } from "./helm";

const NOW = 1_800_000_000;
const col = (id: string, kind: Column["kind"] = "text"): Column => ({ id, title: id, kind });
const POD_COLS = [col("ready", "ratio"), col("status", "status"), col("restarts", "restarts"), col("ip"), col("node")];
const DEPLOY_COLS = [col("ready", "ratio"), col("upToDate", "number"), col("available", "number")];
const neverSeen = () => NOW;

let n = 0;
function row(cl: string, name: string, cells: Cell[], opts: { tone?: Tone; ns?: string; age?: number; labels?: string; x?: boolean } = {}) {
  n++;
  return { key: `${cl}/u${n}`, cl, u: `u${n}`, n: name, ns: opts.ns ?? "shop", rv: "1", t: NOW - (opts.age ?? 3600), s: opts.tone ?? Tone.Neutral, c: cells, l: opts.labels, x: opts.x };
}

const pod = (cl: string, name: string, status: string, tone: Tone, opts: { age?: number; restarts?: [number, number | null]; labels?: string; x?: boolean; ready?: [number, number] } = {}) =>
  row(cl, name, [opts.ready ?? [0, 1], [status, tone], opts.restarts ?? [0, null], "10.0.0.1", "node-1"], { tone, age: opts.age, labels: opts.labels ?? "app=web pod-template-hash=7d9f8c6b5", x: opts.x });

const pods = (...rows: ReturnType<typeof pod>[]): SourceRows => ({ resource: "pods", columns: POD_COLS, rows });

describe("whose a pod is", () => {
  it("finds the workload from the labels its controller sets", () => {
    expect(podOwner("web-7d9f8c6b5-x2x4z", "app=web pod-template-hash=7d9f8c6b5")).toEqual({ resource: "deployments.apps", kind: "Deployment", name: "web" });
    expect(podOwner("db-2", "app=db controller-revision-hash=db-5f statefulset.kubernetes.io/pod-name=db-2")).toEqual({ resource: "statefulsets.apps", kind: "StatefulSet", name: "db" });
    expect(podOwner("agent-k9x2p", "controller-revision-hash=6c pod-template-generation=3")).toEqual({ resource: "daemonsets.apps", kind: "DaemonSet", name: "agent" });
    expect(podOwner("export-x1y2z", "job-name=export batch.kubernetes.io/job-name=export")).toEqual({ resource: "jobs.batch", kind: "Job", name: "export" });
    expect(podOwner("report-29000000-abcde", "job-name=report-29000000")).toEqual({ resource: "cronjobs.batch", kind: "CronJob", name: "report" });
    expect(podOwner("debug", "run=debug")).toEqual({ resource: "pods", kind: "Pod", name: "debug" });
  });
});

describe("generated names", () => {
  it("strips what Kubernetes generates, not what people name", () => {
    expect(stripGenerated(stripGenerated("web-7d9f8c6b5-x2x4z", 5, 5), 6, 10)).toBe("web");
    expect(stripGenerated("payments-api-58d4c9f7b6", 6, 10)).toBe("payments-api");
    // Vowels, 0, 1 and 3 are never generated.
    expect(stripGenerated("web-server", 5, 10)).toBe("web-server");
    expect(stripGenerated("api-v1030", 5, 5)).toBe("api-v1030");
  });
});

describe("what is wrong with a pod", () => {
  const src = pods();
  it("takes failing pods as critical, with their last restart", () => {
    const f = judge(src, pod("z1", "web-7d9f8c6b5-a", "CrashLoopBackOff", Tone.Error, { restarts: [12, NOW - 120] }), NOW, neverSeen)!;
    expect(f).toMatchObject({ severity: "critical", reason: "CrashLoopBackOff", resource: "deployments.apps", subject: "web" });
    expect(f.instance).toMatchObject({ when: { at: NOW - 120, how: "restarted" }, facts: ["12 restarts", "on node-1"] });
  });

  it("gives pods time to start before calling them stuck or unready", () => {
    expect(judge(src, pod("z1", "web-7d9f8c6b5-b", "Pending", Tone.Info, { age: 60 }), NOW, neverSeen)).toBeUndefined();
    expect(judge(src, pod("z1", "web-7d9f8c6b5-b", "Pending", Tone.Info, { age: 3600 }), NOW, neverSeen)).toMatchObject({ severity: "warning", reason: "Pending", detail: "Pending for 60m" });
    expect(judge(src, pod("z1", "web-7d9f8c6b5-c", "ContainerCreating", Tone.Info, { age: 900 }), NOW, neverSeen)).toMatchObject({ reason: "Stuck creating" });
    expect(judge(src, pod("z1", "web-7d9f8c6b5-d", "Init:0/2", Tone.Info, { age: 900 }), NOW, neverSeen)).toMatchObject({ reason: "Stuck initializing" });
    expect(judge(src, pod("z1", "web-7d9f8c6b5-e", "Running", Tone.Warn, { age: 30, ready: [1, 2] }), NOW, neverSeen)).toBeUndefined();
    expect(judge(src, pod("z1", "web-7d9f8c6b5-e", "Running", Tone.Warn, { age: 600, ready: [1, 2] }), NOW, neverSeen)).toMatchObject({ severity: "warning", reason: "Not ready", detail: "1/2 containers ready" });
  });

  it("calls a pod stuck terminating only once it was seen terminating a while", () => {
    const p = pod("z1", "web-7d9f8c6b5-f", "Terminating", Tone.Muted, { x: true });
    expect(judge(src, p, NOW, () => NOW - 60)).toBeUndefined();
    expect(judge(src, p, NOW, () => NOW - 600)).toMatchObject({ severity: "warning", reason: "Stuck terminating", instance: { when: { at: NOW - 600, how: "for" } } });
  });

  it("takes evicted pods as a hint only", () => {
    expect(judge(src, pod("z1", "web-7d9f8c6b5-g", "Evicted", Tone.Error), NOW, neverSeen)).toMatchObject({ severity: "info", reason: "Evicted" });
  });
});

describe("what is wrong with other objects", () => {
  const deploys = (...rows: ReturnType<typeof row>[]): SourceRows => ({ resource: "deployments.apps", columns: DEPLOY_COLS, rows });

  it("tells a stuck rollout, a rollout in progress and replicas not ready apart", () => {
    expect(judge(deploys(), row("z1", "web", [[1, 3], 3, 1], { tone: Tone.Error }), NOW, neverSeen)).toMatchObject({ severity: "critical", reason: "Rollout stuck" });
    expect(judge(deploys(), row("z1", "web", [[2, 3], 1, 2], { tone: Tone.Warn }), NOW, neverSeen)).toMatchObject({ severity: "info", reason: "Rolling out", detail: "1/3 updated, 2/3 ready" });
    expect(judge(deploys(), row("z1", "web", [[2, 3], 3, 2], { tone: Tone.Warn }), NOW, neverSeen)).toMatchObject({ severity: "warning", reason: "2/3 ready" });
    expect(judge(deploys(), row("z1", "web", [[3, 3], 3, 3], { tone: Tone.Ok }), NOW, neverSeen)).toBeUndefined();
  });

  it("knows nodes, claims, autoscalers, jobs, releases and events", () => {
    const nodes: SourceRows = { resource: "nodes", columns: [col("status", "status")], rows: [] };
    expect(judge(nodes, row("z3", "n5", [["NotReady", Tone.Error]], { tone: Tone.Error }), NOW, neverSeen)).toMatchObject({ severity: "critical", reason: "NotReady", subject: "Nodes" });
    expect(judge(nodes, row("z3", "n2", [["Ready,SchedulingDisabled", Tone.Warn]], { tone: Tone.Warn }), NOW, neverSeen)).toMatchObject({ severity: "info", reason: "Cordoned" });

    const claims: SourceRows = { resource: "persistentvolumeclaims", columns: [col("status", "status")], rows: [] };
    expect(judge(claims, row("z1", "data", [["Pending", Tone.Warn]], { tone: Tone.Warn, age: 60 }), NOW, neverSeen)).toBeUndefined();
    expect(judge(claims, row("z1", "data", [["Pending", Tone.Warn]], { tone: Tone.Warn, age: 7200 }), NOW, neverSeen)).toMatchObject({ severity: "warning", reason: "Pending" });
    expect(judge(claims, row("z1", "data", [["Lost", Tone.Error]], { tone: Tone.Error }), NOW, neverSeen)).toMatchObject({ severity: "critical", reason: "Lost" });

    const hpa: SourceRows = { resource: "horizontalpodautoscalers.autoscaling", columns: [col("reference"), col("targets"), col("minPods", "number"), col("maxPods", "number"), col("replicas", "number")], rows: [] };
    expect(judge(hpa, row("z1", "web", ["Deployment/web", "cpu: 95%/70%", 2, 10, 10], { tone: Tone.Warn }), NOW, neverSeen)).toMatchObject({ reason: "At max replicas", detail: "10/10 replicas of Deployment/web: it would scale out further if it could" });

    const jobs: SourceRows = { resource: "jobs.batch", columns: [col("status", "status"), col("completions", "ratio"), col("duration", "duration")], rows: [] };
    expect(judge(jobs, row("z1", "report-29000000", [["Failed", Tone.Error], [0, 1], [NOW - 300, null]], { tone: Tone.Error }), NOW, neverSeen)).toMatchObject({
      severity: "critical",
      resource: "cronjobs.batch",
      subject: "report",
      instance: { when: { at: NOW - 300, how: "started" } },
    });
    expect(judge(jobs, row("z1", "export", [["Running", Tone.Info], [0, 1], [NOW - 300, null]], { tone: Tone.Info }), NOW, neverSeen)).toBeUndefined();

    const releases: SourceRows = { resource: HELM_RELEASES, columns: [col("revision", "number"), col("status", "status")], rows: [] };
    expect(judge(releases, row("z1", "web", [4, ["failed", Tone.Error]], { tone: Tone.Error }), NOW, neverSeen)).toMatchObject({ severity: "critical", reason: "Release failed" });
    expect(judge(releases, row("z1", "web", [4, ["pending-upgrade", Tone.Warn]], { tone: Tone.Warn }), NOW, neverSeen)).toMatchObject({ severity: "warning", reason: "Stuck pending-upgrade" });

    const events: SourceRows = { resource: "events", columns: [col("lastSeen", "age"), col("type", "status"), col("reason"), col("object"), col("message"), col("count", "number")], rows: [] };
    const warning = (last: number) => row("z1", "e", [last, ["Warning", Tone.Warn], "FailedMount", "pod/web-7d9f8c6b5-x2x4z", "MountVolume.SetUp failed", 4], { tone: Tone.Warn });
    expect(judge(events, warning(NOW - 120), NOW, neverSeen)).toMatchObject({ severity: "info", reason: "FailedMount", kind: "Pod", subject: "web", events: 4 });
    expect(judge(events, warning(NOW - 7200), NOW, neverSeen)).toBeUndefined();

    const certs: SourceRows = { resource: "certificates.cert-manager.io", columns: [{ id: "pc_ready_status", title: "Ready", kind: "status" }], rows: [] };
    expect(judge(certs, row("z1", "shop-tls", [["False", Tone.Error]], { tone: Tone.Error }), NOW, neverSeen)).toMatchObject({ severity: "critical", kind: "Certificate", reason: "Ready: False" });
  });
});

describe("issues across clusters", () => {
  it("makes one issue of the same trouble of one workload in several clusters, the worst and widest first", () => {
    const src = pods(
      pod("z3", "web-7d9f8c6b5-c", "CrashLoopBackOff", Tone.Error, { restarts: [3, NOW - 600] }),
      pod("z1", "web-7d9f8c6b5-a", "CrashLoopBackOff", Tone.Error, { restarts: [9, NOW - 60] }),
      pod("z1", "web-7d9f8c6b5-b", "CrashLoopBackOff", Tone.Error, { restarts: [1, NOW - 30] }),
      pod("z2", "api-5c4b3a291-d", "ImagePullBackOff", Tone.Error, { labels: "app=api pod-template-hash=5c4b3a291" }),
      pod("z2", "api-5c4b3a291-e", "Running", Tone.Warn, { age: 900, ready: [0, 1], labels: "app=api pod-template-hash=5c4b3a291" }),
    );
    const issues = findIssues([src], NOW, neverSeen, ["z1", "z2", "z3"]);
    expect(issues.map((i) => `${i.severity} ${i.subject} ${i.reason} ${[...i.where.keys()].join(",")} ${i.count}`)).toEqual([
      "critical web CrashLoopBackOff z1,z3 3",
      "critical api ImagePullBackOff z2 1",
      "warning api Not ready z2 1",
    ]);
    // The latest restart: how recent the crashes are.
    expect(issues[0].when).toEqual({ at: NOW - 30, how: "restarted" });
    expect(issues[0].where.get("z1")!.map((i) => i.name)).toEqual(["web-7d9f8c6b5-a", "web-7d9f8c6b5-b"]);
  });

  it("says where an issue is against the zones picked", () => {
    const family = (c: string) => (c.startsWith("apps-") ? "apps" : c.startsWith("db-") ? "db" : undefined);
    const short = (c: string) => c.split("-")[1];
    const picked = ["apps-z1", "apps-z2", "apps-z3", "apps-z4", "db-z1", "db-z2", "dev"];
    expect(spreadNote(["apps-z2"], picked, family, short)).toBe("only in z2");
    expect(spreadNote(["apps-z1", "apps-z3"], picked, family, short)).toBe("z1, z3 of 4");
    expect(spreadNote(["apps-z1", "apps-z2", "apps-z3", "apps-z4"], picked, family, short)).toBe("all 4 zones");
    expect(spreadNote(["apps-z2", "db-z1", "db-z2"], picked, family, short)).toBe("only in z2 · all 2 zones");
    expect(spreadNote(["dev"], picked, family, short)).toBe("");
    expect(spreadNote(["apps-z1"], ["apps-z1"], family, short)).toBe("");
  });
});
