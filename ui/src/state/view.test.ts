import { createRoot } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import { Tone, type ViewBatch, type ViewMessage } from "../lib/backend";

// The engine end of view subscriptions: every subscriber's callback.
const subscribers = vi.hoisted(() => [] as ((b: ViewBatch) => void)[]);
vi.mock("../lib/backend", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/backend")>()),
  backend: () => ({
    subscribeView: (_spec: unknown, cb: (b: ViewBatch) => void) => {
      subscribers.push(cb);
      return { close() {} };
    },
  }),
}));

import { createNamesFeed, createViewFeed } from "./view";

const settle = () => new Promise((r) => setTimeout(r, 20));
const send = (...m: ViewMessage[]) => subscribers[subscribers.length - 1]({ t: "batch", m });
const keys = (statuses: Record<string, unknown>) =>
  Object.entries(statuses)
    .filter(([, v]) => v)
    .map(([k]) => k)
    .sort();
const pod = { u: "uid-1", n: "payments-api", ns: "payments", rv: "1", t: 0, s: Tone.Ok, c: [] };

describe("createViewFeed", () => {
  it("drops a cluster's earlier error once its namespaces report (the cluster connected after all)", async () => {
    const feed = createRoot(() => createViewFeed(() => ({ resource: "pods", clusters: ["prod-eu-z1"], namespaces: ["payments"] })));
    send({ t: "status", c: "prod-eu-z1", ns: null, state: "error", message: 'cluster "prod-eu-z1": no answer within 60s' });
    await settle();
    expect(keys(feed.statuses)).toEqual(["prod-eu-z1|"]);

    // The engine resolves the cluster again once it is reachable.
    send({ t: "status", c: "prod-eu-z1", ns: null, state: "connecting" });
    send({ t: "rows", c: "prod-eu-z1", ns: "payments", reset: true, up: [pod] }, { t: "status", c: "prod-eu-z1", ns: "payments", state: "ready" });
    await settle();
    expect(keys(feed.statuses)).toEqual(["prod-eu-z1|payments"]);
    expect(feed.loading()).toBe(false);
    expect(feed.rows().map((r) => r.n)).toEqual(["payments-api"]);
  });

  it("also when the error is followed by namespace statuses directly", async () => {
    const feed = createRoot(() => createViewFeed(() => ({ resource: "pods", clusters: ["prod-eu-z1", "prod-eu-z2"], namespaces: ["payments"] })));
    send(
      { t: "status", c: "prod-eu-z1", ns: null, state: "error", message: "unreachable" },
      { t: "status", c: "prod-eu-z2", ns: null, state: "error", message: "unreachable" },
    );
    send({ t: "status", c: "prod-eu-z1", ns: "payments", state: "loading" });
    await settle();
    // Only the cluster that reported keeps its namespace status; the other still shows its error.
    expect(keys(feed.statuses)).toEqual(["prod-eu-z1|payments", "prod-eu-z2|"]);
  });

  it("takes the columns as the engine extends them and keeps each cluster's column notice until it resolves without one", async () => {
    const feed = createRoot(() => createViewFeed(() => ({ resource: "widgets.example.com", clusters: ["prod-eu-z1", "prod-eu-z2"], namespaces: [] })));
    const resource = { key: "widgets.example.com", group: "example.com", version: "v1", kind: "Widget", plural: "widgets", singular: "widget", namespaced: true, verbs: ["list", "watch"], shortNames: [], categories: [], subresources: [] };
    const ready = { id: "pc_ready_status", title: "Ready", kind: "status" as const };
    const issuer = { id: "pc_issuer_text", title: "Issuer", kind: "text" as const };
    const notice = "printer columns unavailable: no answer within 8s";
    send(
      { t: "schema", columns: [ready] },
      { t: "resolved", c: "prod-eu-z1", resource },
      { t: "rows", c: "prod-eu-z1", ns: null, reset: true, up: [{ ...pod, c: [["True", Tone.Ok]] }] },
      { t: "resolved", c: "prod-eu-z2", resource, notice },
    );
    await settle();
    expect({ ...feed.notices }).toEqual({ "prod-eu-z2": notice });

    // z2's columns were found after all: the engine appends them and sends z2's rows laid out on them.
    send(
      { t: "schema", columns: [ready, issuer] },
      { t: "resolved", c: "prod-eu-z2", resource },
      { t: "rows", c: "prod-eu-z2", ns: null, reset: true, up: [{ ...pod, u: "uid-2", c: [["False", Tone.Error], "ca"] }] },
    );
    await settle();
    expect(feed.columns().map((c) => c.id)).toEqual(["pc_ready_status", "pc_issuer_text"]);
    expect({ ...feed.notices }).toEqual({});
    // Rows sent before keep their cells by position; the new column is just empty for them.
    expect(feed.rows().map((r) => [r.cl, r.c[0], r.c[1] ?? null])).toEqual([
      ["prod-eu-z1", ["True", Tone.Ok], null],
      ["prod-eu-z2", ["False", Tone.Error], "ca"],
    ]);
  });

  it("keeps a snapshot that comes in chunks aside and shows it at once with its last chunk", async () => {
    const feed = createRoot(() => createViewFeed(() => ({ resource: "pods", clusters: ["prod-eu-z1"], namespaces: ["payments"] })));
    const p = (u: string) => ({ ...pod, u, n: `pod-${u}` });
    send({ t: "rows", c: "prod-eu-z1", ns: "payments", reset: true, up: [p("old")] }, { t: "status", c: "prod-eu-z1", ns: "payments", state: "ready" });
    await settle();
    const names = () => feed.rows().map((r) => r.n).sort();
    expect(names()).toEqual(["pod-old"]);
    const v = feed.version();

    // A new snapshot (the feed was replaced, the engine re-sent it): its chunks change nothing on screen…
    send({ t: "rows", c: "prod-eu-z1", ns: "payments", reset: true, up: [p("a"), p("b")], more: true });
    send({ t: "rows", c: "prod-eu-z1", ns: "payments", up: [p("c")], more: true });
    await settle();
    expect([names(), feed.version(), feed.rowByKey("prod-eu-z1/a")]).toEqual([["pod-old"], v, undefined]);
    // …until the last one: then all of it at once, in one refresh.
    send({ t: "rows", c: "prod-eu-z1", ns: "payments", up: [p("d")] }, { t: "status", c: "prod-eu-z1", ns: "payments", state: "ready" });
    await settle();
    expect(names()).toEqual(["pod-a", "pod-b", "pod-c", "pod-d"]);
    expect(feed.version()).toBe(v + 1);
    expect(feed.rowByKey("prod-eu-z1/old")).toBeUndefined();
    expect(feed.rowByKey("prod-eu-z1/c")?.cl).toBe("prod-eu-z1");

    // Changes that follow apply as usual; a snapshot replaced while still coming starts over.
    send({ t: "rows", c: "prod-eu-z1", ns: "payments", up: [{ ...p("a"), rv: "2" }], del: ["b"] });
    send({ t: "rows", c: "prod-eu-z1", ns: "payments", reset: true, up: [p("x")], more: true });
    send({ t: "rows", c: "prod-eu-z1", ns: "payments", reset: true, up: [p("y")], more: true });
    await settle();
    expect(names()).toEqual(["pod-a", "pod-c", "pod-d"]);
    expect(feed.rowByKey("prod-eu-z1/a")?.rv).toBe("2");
    send({ t: "rows", c: "prod-eu-z1", ns: "payments", up: [p("z")] });
    await settle();
    expect(names()).toEqual(["pod-y", "pod-z"]);
  });
});

describe("createNamesFeed", () => {
  it("counts names of a snapshot that comes in chunks once its last chunk is in", async () => {
    const feed = createRoot(() => createNamesFeed(() => ({ resource: "namespaces", clusters: ["prod-eu-z1", "prod-eu-z2"], namespaces: [] })));
    const names = (c: string) => [...(feed.clusters().get(c)?.keys() ?? [])].sort();
    send({ t: "names", c: "prod-eu-z2", ns: null, reset: true, up: ["payments"] });
    send({ t: "names", c: "prod-eu-z1", ns: null, reset: true, up: ["payments", "search"], more: true });
    await settle();
    feed.version();
    expect([names("prod-eu-z1"), names("prod-eu-z2")]).toEqual([[], ["payments"]]);
    send({ t: "names", c: "prod-eu-z1", ns: null, up: ["ledger"] });
    await settle();
    feed.version();
    expect(names("prod-eu-z1")).toEqual(["ledger", "payments", "search"]);
    send({ t: "names", c: "prod-eu-z1", ns: null, del: ["search"] });
    await settle();
    feed.version();
    expect(names("prod-eu-z1")).toEqual(["ledger", "payments"]);
  });
});
