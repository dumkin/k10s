import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResourceInfo } from "../lib/backend";
import { setClusterStatus, setContexts, setSelectedClustersRaw } from "./clusters";
import {
  backTarget,
  clearHistory,
  clearNamespaceMemory,
  forgetNamespace,
  kubeconfigNamespaces,
  NAMESPACE_MEMORY_LIMIT,
  namespaceMemoryKey,
  recentNamespaces,
  rememberedNamespaces,
  rememberNamespaces,
  toggleNamespace,
  detailsOpen,
  detailsTab,
  filter,
  forwardTarget,
  goBack,
  goForward,
  HISTORY_LIMIT,
  marked,
  markTo,
  namespaces,
  navigate,
  openDetails,
  pendingReveal,
  REVEAL_TIMEOUT_MS,
  resourceKey,
  reveal,
  selectedKey,
  setDetailsOpen,
  setFilter,
  setMarked,
  setNamespaces,
  setSelectedKey,
  toggleMark,
} from "./nav";
import type { UIRow } from "./view";

beforeEach(() => {
  navigate("pods");
  setNamespaces(["payments"]);
  setFilter("");
  setSelectedKey(null);
  setDetailsOpen(false);
  clearHistory();
});

afterEach(() => vi.useRealTimers());

describe("navigation history", () => {
  it("goes back to the previous view with its filter, selection and details", () => {
    setFilter("api");
    openDetails("z1/pod-uid", "logs");
    navigate("deployments");
    expect([resourceKey(), filter(), selectedKey(), detailsOpen()]).toEqual(["deployments", "", null, false]);

    expect(goBack()).toBe(true);
    expect([resourceKey(), filter(), selectedKey(), detailsOpen(), detailsTab()]).toEqual(["pods", "api", "z1/pod-uid", true, "logs"]);
    expect(goForward()).toBe(true);
    expect(resourceKey()).toBe("deployments");
    expect(goForward()).toBe(false);
  });

  it("restores the namespaces a reveal widened, and forgets marks", () => {
    openDetails("z1/rs-uid", "overview");
    reveal({ cluster: "prod-eu-z1", resource: "pods", namespace: "ledger", name: "ledger-0" });
    expect(namespaces()).toEqual(["payments", "ledger"]);
    setMarked(new Set(["z1/a"]));
    goBack();
    expect(namespaces()).toEqual(["payments"]);
    expect(marked().size).toBe(0);
    expect(selectedKey()).toBe("z1/rs-uid");
  });

  it("a new navigation drops the forward history", () => {
    navigate("deployments");
    navigate("services");
    goBack();
    expect(forwardTarget()?.resource).toBe("services");
    navigate("nodes");
    expect(forwardTarget()).toBeUndefined();
    expect(backTarget()?.resource).toBe("deployments");
  });

  it("is bounded", () => {
    for (let i = 0; i < HISTORY_LIMIT + 20; i++) navigate(i % 2 ? "pods" : "deployments");
    let steps = 0;
    while (goBack()) steps++;
    expect(steps).toBe(HISTORY_LIMIT);
  });

  it("skips entries identical to the current view", () => {
    setSelectedKey("z1/pod-uid");
    reveal({ cluster: "prod-eu-z1", resource: "pods", namespace: "payments", name: "pod" });
    // The reveal didn't change the view (yet): there is nothing to go back to.
    expect(goBack()).toBe(false);
  });
});

describe("pending reveal", () => {
  it("is dropped when the user navigates elsewhere or goes back", () => {
    reveal({ cluster: "prod-eu-z1", resource: "nodes", name: "node-1" });
    expect(pendingReveal()?.name).toBe("node-1");
    navigate("services");
    expect(pendingReveal()).toBeNull();

    reveal({ cluster: "prod-eu-z1", resource: "nodes", name: "node-1" });
    goBack();
    expect(pendingReveal()).toBeNull();
    expect(resourceKey()).toBe("services");
  });

  it("looks for a cluster-scoped object without a namespace, whatever the link carried", () => {
    // A mirror pod's owner is its Node: the reference comes with the pod's namespace.
    const res = (plural: string, kind: string, namespaced: boolean): ResourceInfo => ({ key: plural, group: "", version: "v1", kind, plural, singular: kind.toLowerCase(), namespaced, verbs: ["list"], shortNames: [], categories: [], subresources: [] });
    setSelectedClustersRaw(["prod-eu-z1"]);
    setClusterStatus("prod-eu-z1", { state: "connected", info: { context: "prod-eu-z1", server: "https://127.0.0.1:6443", aggregatedDiscovery: true, resources: [res("pods", "Pod", true), res("nodes", "Node", false)] } });
    reveal({ cluster: "prod-eu-z1", resource: "nodes", namespace: "kube-system", name: "node-1" });
    expect([resourceKey(), pendingReveal()?.namespace, namespaces()]).toEqual(["nodes", null, ["payments"]]);
    // Namespaced ones keep theirs (and widen the selection).
    reveal({ cluster: "prod-eu-z1", resource: "pods", namespace: "kube-system", name: "etcd-node-1" });
    expect([resourceKey(), pendingReveal()?.namespace, namespaces()]).toEqual(["pods", "kube-system", ["payments", "kube-system"]]);
    setClusterStatus("prod-eu-z1", undefined!);
    setSelectedClustersRaw([]);
  });

  it("expires when the object never shows up", () => {
    vi.useFakeTimers();
    reveal({ cluster: "prod-eu-z1", resource: "nodes", name: "node-1" });
    vi.advanceTimersByTime(REVEAL_TIMEOUT_MS - 1);
    expect(pendingReveal()).not.toBeNull();
    vi.advanceTimersByTime(1);
    expect(pendingReveal()).toBeNull();
  });
});

describe("namespace memory", () => {
  const ctx = (name: string, namespace: string | null = null) => ({ name, cluster: name, auth: "token", namespace });

  beforeEach(() => {
    clearNamespaceMemory();
    setContexts([ctx("prod-eu-z1", "payments"), ctx("prod-eu-z2"), ctx("prod-eu-z3"), ctx("stage-us", "Checkout"), ctx("kind-local", "")]);
    setSelectedClustersRaw(["prod-eu-z1"]);
  });
  afterEach(() => setSelectedClustersRaw([]));

  it("remembers namespaces per cluster family, most recent first", () => {
    rememberNamespaces(["ledger"]);
    rememberNamespaces(["orders", "Billing "]);
    // The other zones of the family run the same namespaces; another cluster has its own.
    expect(rememberedNamespaces(["prod-eu-z2"])).toEqual(["orders", "billing", "ledger"]);
    expect(rememberedNamespaces(["stage-us"])).toEqual([]);
    rememberNamespaces(["web"], ["stage-us"]);
    expect(rememberedNamespaces(["prod-eu-z3", "stage-us"])).toEqual(["web", "orders", "billing", "ledger"]);
  });

  it("keeps clusters that are no zones of one family apart", () => {
    expect(["prod-eu-z1", "prod-eu-z3", "prod-eu-dc2", "prod-eu", "kind-local", "prod-us-1", "prod-us-2", "k8s-v1.28"].map(namespaceMemoryKey)).toEqual([
      "family:prod-eu",
      "family:prod-eu",
      "family:prod-eu",
      "cluster:prod-eu",
      "cluster:kind-local",
      "family:prod-us",
      "family:prod-us",
      "cluster:k8s-v1.28",
    ]);
    // A shared trailing number is no zone: EKS ARNs of one region (in any account), numbered clusters.
    const payments = "arn:aws:eks:eu-west-1:111111111111:cluster/payments";
    const billing = "arn:aws:eks:eu-west-1:222222222222:cluster/billing";
    rememberNamespaces(["ledger"], [payments]);
    rememberNamespaces(["checkout"], ["kubernetes-admin@cluster-1"]);
    rememberNamespaces(["web"], ["prod-eu"]);
    expect(rememberedNamespaces([payments])).toEqual(["ledger"]);
    expect(rememberedNamespaces([billing])).toEqual([]);
    expect(rememberedNamespaces(["kubernetes-admin@cluster-2"])).toEqual([]);
    expect(rememberedNamespaces(["prod-eu-z1"])).toEqual([]);
    forgetNamespace("ledger", [billing]);
    expect(rememberedNamespaces([payments])).toEqual(["ledger"]);
  });

  it("remembers nothing when namespaces are only picked (they are remembered once they work)", () => {
    setNamespaces(["paymnets"]);
    toggleNamespace("ledger");
    expect(namespaces()).toEqual(["paymnets", "ledger"]);
    expect(rememberedNamespaces()).toEqual([]);
  });

  it("forgets a name that is an Object.prototype key only when remembered", () => {
    forgetNamespace("constructor");
    expect(rememberedNamespaces()).toEqual([]);
    rememberNamespaces(["constructor", "ledger"]);
    forgetNamespace("constructor");
    expect(rememberedNamespaces()).toEqual(["ledger"]);
  });

  it("offers the namespaces the kubeconfig contexts set first", () => {
    rememberNamespaces(["ledger"]);
    setSelectedClustersRaw(["prod-eu-z1", "stage-us", "kind-local"]);
    expect(kubeconfigNamespaces()).toEqual(["payments", "checkout"]);
    expect(recentNamespaces()).toEqual(["payments", "checkout", "ledger"]);
  });

  it(`keeps the ${NAMESPACE_MEMORY_LIMIT} most recent per family`, () => {
    for (let i = 0; i < NAMESPACE_MEMORY_LIMIT + 5; i++) rememberNamespaces([`team-${i}`]);
    const kept = rememberedNamespaces();
    expect(kept).toHaveLength(NAMESPACE_MEMORY_LIMIT);
    expect(kept[0]).toBe(`team-${NAMESPACE_MEMORY_LIMIT + 4}`);
    expect(kept).not.toContain("team-4");
    expect(kept).toContain("team-5");
  });

  it("forgets a namespace (one that is gone) for the selected clusters only", () => {
    rememberNamespaces(["paymnets"]);
    setSelectedClustersRaw(["stage-us"]);
    rememberNamespaces(["paymnets"]);
    setSelectedClustersRaw(["prod-eu-z2"]);
    forgetNamespace("paymnets");
    expect(rememberedNamespaces(["prod-eu-z1"])).toEqual([]);
    expect(rememberedNamespaces(["stage-us"])).toEqual(["paymnets"]);
  });

  it("does not remember names that are not namespaces, or anything without clusters", () => {
    rememberNamespaces(["not_a_namespace"]);
    setSelectedClustersRaw([]);
    rememberNamespaces(["ledger"]);
    expect(rememberedNamespaces(["prod-eu-z1"])).toEqual([]);
  });
});

describe("marking with ⇧ (markTo)", () => {
  let rows: UIRow[];
  const indexOf = (key: string) => {
    const i = rows.findIndex((r) => r.key === key);
    return i < 0 ? undefined : i;
  };
  const to = (n: number) => markTo(rows, n, indexOf);
  const marks = () => [...marked()].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));

  beforeEach(() => {
    rows = Array.from({ length: 10 }, (_, i) => ({ key: `r${i}` }) as UIRow);
    setMarked(new Set<string>());
  });

  it("marks from the cursor to where it goes, unmarking on the way back, and keeps the marks made before", () => {
    setMarked(new Set(["r1"]));
    setSelectedKey("r4");
    to(6);
    expect([marks(), selectedKey()]).toEqual([["r1", "r4", "r5", "r6"], "r6"]);
    to(5);
    expect(marks()).toEqual(["r1", "r4", "r5"]);
    // Past where it started: the other way from there, r1 still marked.
    to(2);
    expect([marks(), selectedKey()]).toEqual([["r1", "r2", "r3", "r4"], "r2"]);
    // Nowhere further (the first row, again): nothing changes.
    to(0);
    const before = marked();
    to(0);
    expect(marked()).toBe(before);
  });

  it("starts again at the cursor after anything else changed the marks or moved it", () => {
    setSelectedKey("r2");
    to(4);
    toggleMark("r8");
    to(5);
    // From r4 (where the cursor was), not from r2: r2…r4 and r8 stay marked.
    expect(marks()).toEqual(["r2", "r3", "r4", "r5", "r8"]);
    setSelectedKey("r7");
    to(6);
    expect(marks()).toEqual(["r2", "r3", "r4", "r5", "r6", "r7", "r8"]);
    to(8);
    expect(marks()).toEqual(["r2", "r3", "r4", "r5", "r7", "r8"]);
  });

  it("starts at the cursor when the row it started at is gone, and at the row moved to without a cursor", () => {
    setSelectedKey("r3");
    to(5);
    rows = rows.filter((r) => r.key !== "r3");
    // r5 is at 4 now: one down from it.
    to(5);
    expect([marks(), selectedKey()]).toEqual([["r3", "r4", "r5", "r6"], "r6"]);
    setMarked(new Set<string>());
    setSelectedKey("gone");
    to(0);
    expect([marks(), selectedKey()]).toEqual([["r0"], "r0"]);
  });
});
