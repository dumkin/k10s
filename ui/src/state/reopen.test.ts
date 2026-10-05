import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Tone } from "../lib/backend";
import { REVEAL_TIMEOUT_MS } from "./nav";
import { fitsView, isOpenObject, OPEN_OBJECT_KEY, type OpenObject, openObjectOf, REOPEN_GRACE_MS } from "./reopen";
import type { UIRow } from "./view";

// The main table without an engine: its rows and whether it still loads, as the tests set them. Rows are looked up in a
// plain map, as in the real feed: only `version` says they changed.
const feed = vi.hoisted(() => ({ setRows: (_rows: UIRow[]) => {}, setLoading: (_loading: boolean) => {} }));
vi.mock("./view", async () => {
  const { createSignal } = await import("solid-js");
  const [version, setVersion] = createSignal(0);
  const [loading, setLoading] = createSignal(true);
  let index = new Map<string, UIRow>();
  Object.assign(feed, {
    setRows: (rows: UIRow[]) => {
      index = new Map(rows.map((r) => [r.key, r]));
      setVersion((v) => v + 1);
    },
    setLoading,
  });
  return {
    createViewFeed: () => ({ version, rowByKey: (k: string) => index.get(k), rows: () => (version(), [...index.values()]), columns: () => [], statuses: {}, resolved: {}, notices: {}, loading }),
    createNamesFeed: () => ({ version: () => 0, clusters: () => new Map(), statuses: {}, loading: () => false }),
  };
});

const KEY = `k10s:${OPEN_OBJECT_KEY}`;
/** What was open when k10s was quit: a pod's log. */
const logs: OpenObject = { cluster: "prod-eu-z1", resource: "pods", namespace: "payments", name: "payments-api-0", tab: "logs" };
const row = (n: string, ns: string | null = null, cl = "prod-eu-z1"): UIRow => ({ key: `${cl}/${n}`, cl, u: n, n, ns: ns ?? undefined, rv: "1", t: 0, s: Tone.Ok, c: [] });
const api = row("payments-api-0", "payments");
const worker = row("payments-worker-0", "payments");
const saved = () => JSON.parse(localStorage.getItem(KEY) ?? "null") as OpenObject | null;

let dispose: (() => void) | undefined;

/**
 * Starts the app's state as k10s starts after a quit: the table restored to `view` (pods of prod-eu-z1 in payments
 * unless said otherwise), still loading, with `open` saved as what was open.
 */
async function start(open?: OpenObject, view: { resource?: string; clusters?: string[]; namespaces?: string[] } = {}) {
  dispose?.();
  // The mocked feed outlives `resetModules`.
  feed.setRows([]);
  feed.setLoading(true);
  localStorage.setItem("k10s:resource", JSON.stringify(view.resource ?? "pods"));
  localStorage.setItem("k10s:clusters", JSON.stringify(view.clusters ?? ["prod-eu-z1"]));
  localStorage.setItem("k10s:namespaces", JSON.stringify(view.namespaces ?? ["payments"]));
  if (open) localStorage.setItem(KEY, JSON.stringify(open));
  vi.resetModules();
  const { createRoot } = await import("solid-js");
  const nav = await import("./nav");
  const views = await import("./views");
  const reopen = await import("./reopen");
  createRoot((d) => {
    dispose = d;
    views.initViews();
    reopen.initReopen();
  });
  return nav;
}

beforeEach(() => localStorage.clear());
afterEach(() => {
  dispose?.();
  dispose = undefined;
  vi.useRealTimers();
});

describe("reopening what was open", () => {
  it("opens the saved object on its tab once its row shows up", async () => {
    const nav = await start(logs);
    feed.setRows([worker]);
    expect(nav.detailsOpen()).toBe(false);
    feed.setRows([worker, api]);
    expect([nav.detailsOpen(), nav.selectedKey(), nav.detailsTab()]).toEqual([true, api.key, "logs"]);
    expect(saved()).toEqual(logs);
    // Where k10s started is no step back.
    expect(nav.backTarget()).toBeUndefined();
  });

  it("waits as long as the table loads, and a moment more", async () => {
    vi.useFakeTimers();
    const nav = await start(logs);
    // The first list of a big table may take longer than a reveal waits.
    vi.advanceTimersByTime(REVEAL_TIMEOUT_MS * 2);
    feed.setRows([worker]);
    feed.setLoading(false);
    vi.advanceTimersByTime(REOPEN_GRACE_MS - 1);
    feed.setRows([worker, api]);
    expect([nav.detailsOpen(), nav.selectedKey(), nav.detailsTab()]).toEqual([true, api.key, "logs"]);
  });

  it("keeps the saved object while waiting for it: the details are closed only because it has not shown up", async () => {
    const nav = await start(logs);
    feed.setRows([worker]);
    expect(nav.detailsOpen()).toBe(false);
    expect(localStorage.getItem(KEY)).toBe(JSON.stringify(logs));
  });

  it("gives up once the table loaded without it", async () => {
    vi.useFakeTimers();
    const nav = await start(logs);
    feed.setRows([worker]);
    feed.setLoading(false);
    vi.advanceTimersByTime(REOPEN_GRACE_MS - 1);
    expect(nav.pendingReveal()).not.toBeNull();
    expect(saved()).toEqual(logs);
    vi.advanceTimersByTime(1);
    expect(nav.pendingReveal()).toBeNull();
    // Nothing is open now.
    expect(localStorage.getItem(KEY)).toBe("null");
    feed.setRows([worker, api]);
    expect(nav.detailsOpen()).toBe(false);
  });

  it("leaves the view as restored when the object belongs to another one", async () => {
    for (const open of [{ ...logs, resource: "deployments" }, { ...logs, cluster: "prod-eu-z2" }, { ...logs, namespace: "ledger" }]) {
      const nav = await start(open);
      // Even when a row like it is listed.
      feed.setRows([row(open.name, open.namespace, open.cluster)]);
      expect([nav.resourceKey(), nav.namespaces(), nav.pendingReveal(), nav.selectedKey(), nav.detailsOpen()], JSON.stringify(open)).toEqual(["pods", ["payments"], null, null, false]);
    }
  });

  it("reopens a cluster-scoped object whatever namespaces are open", async () => {
    const node: OpenObject = { cluster: "prod-eu-z1", resource: "nodes", namespace: null, name: "node-1", tab: "yaml" };
    const nav = await start(node, { resource: "nodes" });
    feed.setRows([row("node-1")]);
    expect([nav.detailsOpen(), nav.selectedKey(), nav.detailsTab(), nav.namespaces()]).toEqual([true, "prod-eu-z1/node-1", "yaml", ["payments"]]);
  });

  it("gives way to what the person picks while waiting", async () => {
    const nav = await start(logs);
    feed.setRows([worker]);
    nav.setSelectedKey(worker.key);
    expect(nav.pendingReveal()).toBeNull();
    // The object showing up later takes nothing from them.
    feed.setRows([worker, api]);
    expect([nav.selectedKey(), nav.detailsOpen()]).toEqual([worker.key, false]);
  });

  it("is cancelled by going to another view", async () => {
    const nav = await start(logs);
    nav.navigate("deployments");
    expect(nav.pendingReveal()).toBeNull();
    nav.goBack();
    feed.setRows([api]);
    expect(nav.detailsOpen()).toBe(false);
  });

  it("ignores a stored value of the wrong shape", async () => {
    const { tab: _, ...noTab } = logs;
    for (const raw of ["null", "{}", "[]", '"x"', "0", JSON.stringify(noTab), JSON.stringify({ ...logs, namespace: 3 }), JSON.stringify({ ...logs, name: "" }), "not json"]) {
      localStorage.setItem(KEY, raw);
      const nav = await start();
      feed.setRows([api]);
      expect([nav.pendingReveal(), nav.detailsOpen()], raw).toEqual([null, false]);
    }
  });
});

describe("saving what is open", () => {
  it("saves what the person opens, the tab they switch to, and nothing once they close it", async () => {
    const nav = await start();
    feed.setRows([api, worker]);
    nav.openDetails(worker.key);
    expect(saved()).toEqual({ ...logs, name: worker.n, tab: "overview" });
    nav.setDetailsTab("logs");
    // ↓ with the details open: the next row's.
    nav.setSelectedKey(api.key);
    expect(saved()).toEqual(logs);
    nav.closeDetails();
    expect(localStorage.getItem(KEY)).toBe("null");
  });

  it("keeps what was saved while the open row is not listed (the view reloads)", async () => {
    const nav = await start();
    feed.setRows([api]);
    nav.openDetails(api.key, "logs");
    // Other namespaces, a reconnect: every row goes, and comes back from new lists.
    feed.setRows([]);
    nav.setDetailsTab("events");
    expect(saved()).toEqual(logs);
    feed.setRows([api]);
    expect(saved()).toEqual({ ...logs, tab: "events" });
  });
});

describe("the saved object", () => {
  it("has the shape of an open object", () => {
    expect(isOpenObject(logs)).toBe(true);
    expect(isOpenObject({ ...logs, resource: "nodes", namespace: null })).toBe(true);
    const { namespace: _, ...noNamespace } = logs;
    for (const v of [null, "x", [], {}, noNamespace, { ...logs, cluster: "" }, { ...logs, namespace: "" }, { ...logs, namespace: 3 }, { ...logs, name: null }, { ...logs, tab: 1 }]) {
      expect(isOpenObject(v), JSON.stringify(v)).toBe(false);
    }
  });

  it("fits the view that shows it", () => {
    const view = { resource: "pods", clusters: ["prod-eu-z1", "prod-eu-z2"], namespaces: ["payments"] };
    expect(fitsView(logs, view)).toBe(true);
    expect(fitsView(logs, { ...view, namespaces: [] })).toBe(true);
    expect(fitsView({ ...logs, resource: "nodes", namespace: null }, { ...view, resource: "nodes" })).toBe(true);
    expect(fitsView({ ...logs, resource: "deployments" }, view)).toBe(false);
    expect(fitsView({ ...logs, cluster: "stage-us" }, view)).toBe(false);
    expect(fitsView({ ...logs, namespace: "ledger" }, view)).toBe(false);
  });

  it("is what the details show", () => {
    const shown = { open: true, key: api.key, row: api, resource: "pods", tab: "logs" };
    expect(openObjectOf(shown)).toEqual(logs);
    expect(openObjectOf({ ...shown, key: "prod-eu-z1/node-1", row: row("node-1"), resource: "nodes" })).toEqual({ cluster: "prod-eu-z1", resource: "nodes", namespace: null, name: "node-1", tab: "logs" });
    expect(openObjectOf({ ...shown, open: false })).toBeNull();
    expect(openObjectOf({ ...shown, key: null, row: undefined })).toBeNull();
    // Selected, but not listed (the view reloads): unknown.
    expect(openObjectOf({ ...shown, row: undefined })).toBeUndefined();
  });
});
