import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FeedState } from "./view";

// The feeds of the main table and of the namespace listing, without an engine: statuses and names as the tests set them.
const feeds = vi.hoisted(() => ({
  setMain: (_k: string, _s: FeedState | undefined) => {},
  setListing: (_k: string, _s: FeedState | undefined) => {},
  setNames: (_c: string, _names: string[]) => {},
  reset: () => {},
}));
vi.mock("./view", async (importOriginal) => {
  const { createSignal } = await import("solid-js");
  const { createStore, reconcile } = await import("solid-js/store");
  const [main, setMain] = createStore<Record<string, FeedState>>({});
  const [listing, setListing] = createStore<Record<string, FeedState>>({});
  const [version, setVersion] = createSignal(0);
  const names = new Map<string, Map<string, number>>();
  Object.assign(feeds, {
    setMain: (k: string, s: FeedState | undefined) => setMain(k, s!),
    setListing: (k: string, s: FeedState | undefined) => setListing(k, s!),
    setNames: (c: string, list: string[]) => {
      names.set(c, new Map(list.map((n) => [n, 1])));
      setVersion((v) => v + 1);
    },
    reset: () => {
      setMain(reconcile({}));
      setListing(reconcile({}));
      names.clear();
    },
  });
  return {
    ...(await importOriginal<typeof import("./view")>()),
    createViewFeed: () => ({ version: () => 0, rowByKey: () => undefined, rows: () => [], columns: () => [], statuses: main, resolved: {}, notices: {}, loading: () => false }),
    createNamesFeed: () => ({ version, clusters: () => names, statuses: listing, loading: () => false }),
  };
});

beforeEach(() => {
  localStorage.clear();
  vi.resetModules();
  // The mocked module outlives `resetModules`.
  feeds.reset();
});

describe("namespace memory", () => {
  it("survives a stored value of the wrong shape", async () => {
    localStorage.setItem("k10s:namespaceMemory", JSON.stringify(["payments"]));
    const nav = await import("./nav");
    expect(nav.rememberedNamespaces(["prod-eu-z1"])).toEqual([]);
    nav.rememberNamespaces(["orders"], ["prod-eu-z1"]);
    expect(nav.rememberedNamespaces(["prod-eu-z1"])).toEqual(["orders"]);
  });
});

describe("remembering namespaces that worked", () => {
  const forbidden = (c: string, ns: string | null = null): FeedState => ({ c, ns, state: "error", code: 403, message: "forbidden" });
  const ready = (c: string, ns: string | null = null): FeedState => ({ c, ns, state: "ready" });

  // The views of earlier tests would still follow the (shared) mocked feeds.
  let dispose: (() => void) | undefined;
  afterEach(() => {
    dispose?.();
    dispose = undefined;
  });

  async function app(clusters: string[]) {
    const { createRoot } = await import("solid-js");
    const { setSelectedClustersRaw } = await import("./clusters");
    const nav = await import("./nav");
    const views = await import("./views");
    setSelectedClustersRaw(clusters);
    createRoot((d) => {
      dispose = d;
      views.initViews();
    });
    return nav;
  }

  it("remembers a namespace once a cluster that can't list namespaces served it, not a typo it refused", async () => {
    const nav = await app(["prod-eu-z1", "stage-us"]);
    nav.setNamespaces(["payments", "paymnets"]);
    expect(nav.rememberedNamespaces(["prod-eu-z1", "stage-us"])).toEqual([]);

    // Neither cluster may list namespaces (strict RBAC): what they serve decides.
    feeds.setListing("prod-eu-z1|", forbidden("prod-eu-z1"));
    feeds.setListing("stage-us|", forbidden("stage-us"));
    feeds.setMain("prod-eu-z1|payments", ready("prod-eu-z1", "payments"));
    feeds.setMain("prod-eu-z1|paymnets", forbidden("prod-eu-z1", "paymnets"));
    feeds.setMain("stage-us|payments", forbidden("stage-us", "payments"));
    expect(nav.rememberedNamespaces(["prod-eu-z2"])).toEqual(["payments"]);
    // Only for the cluster (family) that served it.
    expect(nav.rememberedNamespaces(["stage-us"])).toEqual([]);
  });

  it("waits for the namespace listing, and trusts it over a feed that answered", async () => {
    const nav = await app(["prod-eu-z1"]);
    nav.setNamespaces(["payments", "paymnets"]);
    // A cluster-wide role lists pods in a namespace that doesn't exist: nothing, no 403.
    feeds.setMain("prod-eu-z1|payments", ready("prod-eu-z1", "payments"));
    feeds.setMain("prod-eu-z1|paymnets", ready("prod-eu-z1", "paymnets"));
    expect(nav.rememberedNamespaces(["prod-eu-z1"])).toEqual([]);
    feeds.setNames("prod-eu-z1", ["kube-system", "payments"]);
    feeds.setListing("prod-eu-z1|", ready("prod-eu-z1"));
    expect(nav.rememberedNamespaces(["prod-eu-z1"])).toEqual(["payments"]);
  });

  it("makes a namespace opened next to others the most recent, without stamping them again", async () => {
    const nav = await app(["prod-eu-z1"]);
    feeds.setNames("prod-eu-z1", ["billing", "ledger", "orders"]);
    feeds.setListing("prod-eu-z1|", ready("prod-eu-z1"));
    nav.setNamespaces(["orders", "ledger"]);
    expect(nav.rememberedNamespaces()).toEqual(["ledger", "orders"]);
    nav.toggleNamespace("billing");
    expect(nav.rememberedNamespaces()).toEqual(["billing", "ledger", "orders"]);
    // Closed and opened again: the most recent again.
    nav.toggleNamespace("orders");
    expect(nav.rememberedNamespaces()).toEqual(["billing", "ledger", "orders"]);
    nav.toggleNamespace("orders");
    expect(nav.rememberedNamespaces()).toEqual(["orders", "billing", "ledger"]);
  });
});
