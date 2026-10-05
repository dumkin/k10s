import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClusterInfo, EngineEvent } from "../lib/backend";

// The engine, as far as cluster connections go.
const engine = vi.hoisted(() => ({
  connect: vi.fn(),
  reconnect: vi.fn(),
  listContexts: vi.fn(),
  resync: vi.fn(async () => {}),
  listeners: [] as ((e: EngineEvent) => void)[],
}));
vi.mock("../lib/backend", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/backend")>()),
  backend: () => ({
    connect: engine.connect,
    reconnect: engine.reconnect,
    listContexts: engine.listContexts,
    resync: engine.resync,
    onEngineEvent: (cb: (e: EngineEvent) => void) => {
      engine.listeners.push(cb);
      return () => {};
    },
  }),
}));

import {
  clusterStatus,
  createWakeDetector,
  ensureConnected,
  kubeconfigState,
  listenEngineEvents,
  loadContexts,
  needsWelcome,
  selectedClusters,
  setSelectedClustersRaw,
  startWakeDetector,
} from "./clusters";

const info = (context: string): ClusterInfo => ({ context, server: "https://127.0.0.1:6443", version: "v1.33.4", aggregatedDiscovery: true, resources: [] });

beforeEach(() => {
  vi.clearAllMocks();
  engine.listeners.length = 0;
});

describe("createWakeDetector", () => {
  it("sees sleep as the wall clock running ahead of the monotonic one", () => {
    const woke = createWakeDetector();
    expect(woke(0, 0, true)).toBe(false);
    expect(woke(1_000, 1_000, true)).toBe(false);
    // Lid closed for an hour: the monotonic clock stood still.
    expect(woke(3_601_000, 2_000, false)).toBe(true);
    expect(woke(3_602_000, 3_000, false)).toBe(false);
  });

  it("ignores throttled timers of a hidden page, but not a late tick of a visible one", () => {
    const woke = createWakeDetector();
    woke(0, 0, false);
    // Hidden (minimized): timers fire a minute apart, both clocks agree — not sleep.
    expect(woke(60_000, 60_000, false)).toBe(false);
    expect(woke(61_000, 61_000, true)).toBe(false);
    // Visible, and a tick 20s late on both clocks (platforms whose monotonic clock counts sleep).
    expect(woke(81_000, 81_000, true)).toBe(true);
  });
});

describe("startWakeDetector", () => {
  afterEach(() => vi.useRealTimers());

  it("asks the engine to resync after sleep and when the network is back, at most every 10s", () => {
    vi.useFakeTimers();
    const stop = startWakeDetector();
    vi.advanceTimersByTime(3_000);
    expect(engine.resync).not.toHaveBeenCalled();

    vi.setSystemTime(Date.now() + 3_600_000);
    vi.advanceTimersByTime(1_000);
    expect(engine.resync).toHaveBeenCalledTimes(1);

    // A burst of network events right after: one resync is enough.
    window.dispatchEvent(new Event("online"));
    expect(engine.resync).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() + 11_000);
    vi.advanceTimersByTime(1_000);
    window.dispatchEvent(new Event("online"));
    expect(engine.resync).toHaveBeenCalledTimes(2);

    stop();
    window.dispatchEvent(new Event("online"));
    vi.setSystemTime(Date.now() + 3_600_000);
    vi.advanceTimersByTime(5_000);
    expect(engine.resync).toHaveBeenCalledTimes(2);
  });
});

describe("ensureConnected", () => {
  it("says whether the cluster is connected, keeping the error in clusterStatus", async () => {
    engine.reconnect.mockRejectedValueOnce({ kind: "connect", message: 'cluster "prod-eu-z1": no answer within 60s', code: null });
    expect(await ensureConnected("prod-eu-z1", true)).toBe(false);
    expect(clusterStatus["prod-eu-z1"]).toMatchObject({ state: "error", message: 'cluster "prod-eu-z1": no answer within 60s' });

    engine.reconnect.mockResolvedValueOnce(info("prod-eu-z1"));
    expect(await ensureConnected("prod-eu-z1", true)).toBe(true);
    expect(clusterStatus["prod-eu-z1"]).toMatchObject({ state: "connected", version: "v1.33.4" });
    // Already connected: nothing to do.
    expect(await ensureConnected("prod-eu-z1")).toBe(true);
    expect(engine.connect).not.toHaveBeenCalled();
  });
});

describe("listenEngineEvents", () => {
  it("lists the contexts again when the kubeconfig in effect may have changed", async () => {
    engine.listContexts.mockResolvedValue({ contexts: [], paths: ["/home/me/.kube/config"] });
    listenEngineEvents();
    engine.listeners.forEach((l) => l({ type: "contexts" }));
    expect(engine.listContexts).toHaveBeenCalledTimes(1);
  });

  it("tracks reconnects the engine starts by itself (expired credentials)", () => {
    listenEngineEvents();
    engine.listeners.forEach((l) => l({ type: "cluster", context: "prod-eu-z2", state: "connecting" }));
    expect(clusterStatus["prod-eu-z2"]?.state).toBe("connecting");
    engine.listeners.forEach((l) => l({ type: "cluster", context: "prod-eu-z2", state: "connected", version: "v1.33.4" }));
    expect(clusterStatus["prod-eu-z2"]).toMatchObject({ state: "connected", version: "v1.33.4" });
  });
});

describe("loadContexts", () => {
  const ctx = (name: string, namespace: string | null = null) => ({ name, cluster: name, auth: "exec: kubelogin", namespace });
  const paths = ["/home/me/.kube/config"];

  beforeEach(() => {
    setSelectedClustersRaw([]);
    engine.connect.mockImplementation(async (name: string) => info(name));
  });

  it("connects nothing on a first run without a current-context: the welcome screen asks", async () => {
    // Sorted by name, like the engine lists them: the first one is no better a guess than any other.
    engine.listContexts.mockResolvedValue({ contexts: [ctx("acme-dev"), ctx("prod-eu-z1"), ctx("prod-eu-z2")], current: null, paths, found: paths });
    await loadContexts();
    expect(selectedClusters()).toEqual([]);
    expect(engine.connect).not.toHaveBeenCalled();
    expect(kubeconfigState()).toEqual({ state: "ok" });
    expect(needsWelcome()).toBe(true);
  });

  it("picks kubectl's current context on a first run", async () => {
    engine.listContexts.mockResolvedValue({ contexts: [ctx("acme-dev"), ctx("prod-eu-z3", "payments")], current: "prod-eu-z3", paths, found: paths });
    await loadContexts();
    expect(selectedClusters()).toEqual(["prod-eu-z3"]);
    expect(engine.connect).toHaveBeenCalledWith("prod-eu-z3");
    expect(needsWelcome()).toBe(false);
  });

  it("keeps the saved clusters that still exist, and asks again when none does", async () => {
    setSelectedClustersRaw(["stage-eu-z1", "gone"]);
    engine.listContexts.mockResolvedValue({ contexts: [ctx("stage-eu-z1"), ctx("stage-eu-z2")], current: "stage-eu-z2", paths, found: paths });
    await loadContexts();
    expect(selectedClusters()).toEqual(["stage-eu-z1"]);

    setSelectedClustersRaw(["gone"]);
    engine.listContexts.mockResolvedValue({ contexts: [ctx("stage-eu-z1")], current: null, paths, found: paths });
    await loadContexts();
    expect(selectedClusters()).toEqual([]);
  });

  it("leaves an unchanged selection as it is on a reload (marks and menus stay), and still connects it", async () => {
    setSelectedClustersRaw(["acme-dev-z1", "acme-dev-z2"]);
    const before = selectedClusters();
    engine.listContexts.mockResolvedValue({ contexts: [ctx("acme-dev-z1"), ctx("acme-dev-z2"), ctx("acme-dev-z3")], current: "acme-dev-z3", paths, found: paths });
    await loadContexts();
    expect(selectedClusters()).toBe(before);
    expect(engine.connect.mock.calls.map(([c]) => c)).toEqual(["acme-dev-z1", "acme-dev-z2"]);
  });

  it("tells a missing kubeconfig from an empty or unreadable one", async () => {
    engine.listContexts.mockResolvedValueOnce({ contexts: [], current: null, paths: ["/a.yaml", "/b.yaml"], found: [], fromEnv: true });
    await loadContexts();
    expect(kubeconfigState()).toEqual({ state: "missing", paths: ["/a.yaml", "/b.yaml"], fromEnv: true });

    engine.listContexts.mockResolvedValueOnce({ contexts: [], current: null, paths: ["/a.yaml", "/b.yaml"], found: ["/b.yaml"], fromEnv: true });
    await loadContexts();
    expect(kubeconfigState()).toEqual({ state: "empty", paths: ["/b.yaml"], fromEnv: true });

    engine.listContexts.mockRejectedValueOnce({ kind: "kubeconfig", message: "kubeconfig: /b.yaml: did not find expected key", code: null });
    await loadContexts();
    expect(kubeconfigState()).toEqual({ state: "error", message: "kubeconfig: /b.yaml: did not find expected key" });
  });

  it("shows the kubeconfig problem instead of a table only while none of the saved clusters is connected", async () => {
    // KUBECONFIG pointing elsewhere for a moment: the saved selection is kept, not wiped.
    setSelectedClustersRaw(["dev-z7"]);
    engine.listContexts.mockResolvedValue({ contexts: [], current: null, paths, found: [] });
    await loadContexts();
    expect(selectedClusters()).toEqual(["dev-z7"]);
    expect(needsWelcome()).toBe(true);
    // The engine still had it connected (an earlier kubeconfig): its table stays.
    engine.connect.mockResolvedValueOnce(info("dev-z7"));
    await ensureConnected("dev-z7");
    expect(needsWelcome()).toBe(false);
  });
});
