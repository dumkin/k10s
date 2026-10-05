import { createRoot } from "solid-js";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { type ContextList, Tone } from "../lib/backend";
import type { FeedState, UIRow } from "./view";

// The engine: kubeconfig reads, connects, deletes and the read-only switch are looked at.
const engine = vi.hoisted(() => ({
  listContexts: vi.fn(),
  connect: vi.fn(async (context: string) => ({ context, server: "https://127.0.0.1:6443", aggregatedDiscovery: true, resources: [] })),
  refreshDiscovery: vi.fn(async (context: string) => ({ context, server: "https://127.0.0.1:6443", aggregatedDiscovery: true, resources: [] })),
  deleteObjects: vi.fn(async () => []),
  setReadOnly: vi.fn(async (readOnly: boolean) => ({ readOnly, feedIdleTtlSecs: 180 })),
}));
vi.mock("../lib/backend", async (importOriginal) => ({ ...(await importOriginal<typeof import("../lib/backend")>()), backend: () => ({ ...engine, reconnect: engine.connect }) }));

// The main table and the namespace listing without an engine: rows and listing statuses as the tests set them.
const feeds = vi.hoisted(() => ({ setRows: (_rows: UIRow[]) => {}, setListing: (_key: string, _s: FeedState | undefined) => {} }));
vi.mock("./view", async (importOriginal) => {
  const { createSignal } = await import("solid-js");
  const { createStore } = await import("solid-js/store");
  const [rows, setRows] = createSignal<UIRow[]>([]);
  const [listing, setListing] = createStore<Record<string, FeedState>>({});
  Object.assign(feeds, { setRows, setListing: (k: string, s: FeedState | undefined) => setListing(k, s!) });
  return {
    ...(await importOriginal<typeof import("./view")>()),
    createViewFeed: () => ({ version: () => 0, rowByKey: (k: string) => rows().find((r) => r.key === k), rows, columns: () => [], statuses: {}, resolved: {}, notices: {}, loading: () => false }),
    createNamesFeed: () => ({ version: () => 0, clusters: () => new Map(), statuses: listing, loading: () => false }),
  };
});

import { registerBuiltinCommands } from "./builtinCommands";
import { setContexts, setSelectedClustersRaw, shortName } from "./clusters";
import { type Command, collectCommands } from "./commands";
import { clearNamespaceMemory, namespaces, rememberNamespaces, setNamespaces, setSelectedKey } from "./nav";
import { dialog, dismissToast, noteReadOnlyRefusal, readOnly, setReadOnly, toasts } from "./ui";
import { initViews } from "./views";

const ctx = (name: string, namespace?: string) => ({ name, cluster: name, auth: "exec: kubelogin", namespace });
const kubeconfig = (list: Partial<ContextList>): ContextList => ({ contexts: [], current: null, paths: ["/home/me/.kube/config"], found: ["/home/me/.kube/config"], ...list });
const command = (id: string, query = "") => collectCommands(query).find((c) => c.id === id)!;
const run = (c: Command) => c.run({ additive: false });
const lastToast = () => toasts().at(-1);

beforeAll(() => {
  registerBuiltinCommands();
  createRoot(() => initViews());
});

beforeEach(() => {
  vi.clearAllMocks();
  setContexts([ctx("prod-eu-z1", "payments")]);
  setSelectedClustersRaw(["prod-eu-z1"]);
  clearNamespaceMemory();
  setNamespaces([]);
});

afterEach(async () => {
  if (readOnly()) await setReadOnly(false);
  for (const t of toasts()) dismissToast(t.id);
  feeds.setRows([]);
  feeds.setListing("prod-eu-z1|", undefined);
});

describe("palette", () => {
  it("lists the actions read-only mode disables with why, and running one only explains", async () => {
    const pod: UIRow = { key: "z1/web-0", cl: "prod-eu-z1", u: "web-0", n: "web-0", ns: "payments", rv: "1", t: 0, s: Tone.Ok, c: [] };
    feeds.setRows([pod]);
    setSelectedKey(pod.key);
    noteReadOnlyRefusal();
    const del = command("act:delete");
    expect([del.title, del.hint, del.section]).toEqual(["Delete…", "read-only mode", "Selection · web-0"]);
    await run(del);
    expect(dialog()).toBeNull();
    expect(engine.deleteObjects).not.toHaveBeenCalled();
    expect(lastToast()?.title).toBe("Read-only mode is on");
    // Reading stays as it was.
    expect(command("act:copy-name").hint).toBeUndefined();
  });

  it("says how reloading the kubeconfig went", async () => {
    engine.listContexts.mockResolvedValueOnce(kubeconfig({ contexts: [ctx("prod-eu-z1"), ctx("prod-eu-z2")] }));
    await run(command("app:kubeconfig"));
    expect(lastToast()).toMatchObject({ kind: "success", title: "Kubeconfig reloaded: 2 contexts" });

    engine.listContexts.mockRejectedValueOnce({ kind: "kubeconfig", message: "kubeconfig: invalid YAML at line 3", code: null });
    await run(command("app:kubeconfig"));
    expect(lastToast()).toMatchObject({ kind: "error", title: "Can't read the kubeconfig", detail: "kubeconfig: invalid YAML at line 3" });

    engine.listContexts.mockResolvedValueOnce(kubeconfig({ paths: ["/work/a.yaml"], found: [], fromEnv: true }));
    await run(command("app:kubeconfig"));
    expect(lastToast()).toMatchObject({ kind: "error", title: "No kubeconfig found", detail: "Searched (from KUBECONFIG): /work/a.yaml" });
  });

  it("says on which clusters reconnecting or refreshing discovery failed, and why", async () => {
    setContexts([ctx("prod-eu-z1"), ctx("prod-eu-z2"), ctx("prod-eu-z3")]);
    setSelectedClustersRaw(["prod-eu-z1", "prod-eu-z2", "prod-eu-z3"]);
    const down = { kind: "connect", message: "no answer within 60s (is the cluster reachable? VPN?)", code: null };
    const connect = engine.connect.getMockImplementation()!;
    engine.connect.mockImplementation(async (context: string) => (context === "prod-eu-z1" ? connect(context) : Promise.reject(down)));
    await run(command("app:reconnect"));
    const [z2, z3] = [shortName("prod-eu-z2"), shortName("prod-eu-z3")];
    expect(lastToast()).toMatchObject({ kind: "error", title: `Could not reconnect ${z2}, ${z3}`, detail: `${z2}: ${down.message}\n${z3}: ${down.message}` });

    engine.connect.mockImplementation(connect);
    await run(command("app:reconnect"));
    expect(lastToast()).toMatchObject({ kind: "success", title: "Reconnected" });

    const refresh = engine.refreshDiscovery.getMockImplementation()!;
    engine.refreshDiscovery.mockImplementation(async (context: string) => (context === "prod-eu-z2" ? Promise.reject({ kind: "api", message: "the server has asked for the client to provide credentials", code: 401 }) : refresh(context)));
    await run(command("app:discovery"));
    expect(lastToast()).toMatchObject({ kind: "error", title: `Could not refresh discovery of ${z2}`, detail: `${z2}: the server has asked for the client to provide credentials` });
    engine.refreshDiscovery.mockImplementation(refresh);
    await run(command("app:discovery"));
    expect(lastToast()).toMatchObject({ kind: "success", title: "Discovery refreshed" });
  });

  it("completes :ns with the kubeconfig's and remembered namespaces where namespaces can't be listed", async () => {
    rememberNamespaces(["ledger"]);
    rememberNamespaces(["payroll"]);
    const ns = (query: string) => collectCommands(query).filter((c) => c.id.startsWith("colon:ns:"));
    // Listing works: what is typed, as typed (the listed names are searched without `:`).
    expect(ns(":ns pay").map((c) => c.title)).toEqual(["Namespace pay"]);

    feeds.setListing("prod-eu-z1|", { state: "error", code: 403, reason: "Forbidden", terminal: true, message: 'namespaces is forbidden: User "jane" cannot list resource "namespaces"', c: "prod-eu-z1", ns: null });
    expect(ns(":ns pay").map((c) => [c.title, c.hint])).toEqual([
      ["Namespace pay", undefined],
      ["Namespace payments", "from kubeconfig"],
      ["Namespace payroll", "recent"],
    ]);
    expect(ns(":ns ").map((c) => c.title)).toEqual(["Namespace payments", "Namespace payroll", "Namespace ledger"]);
    await run(ns(":namespace led")[1]);
    expect(namespaces()).toEqual(["ledger"]);
  });

  it("offers zone families, not clusters whose names only end alike", () => {
    setContexts(
      [
        "prod-eu-z1",
        "prod-eu-z2",
        "prod-eu-z3",
        "arn:aws:eks:eu-west-1:111111111111:cluster/payments",
        "arn:aws:eks:eu-west-1:222222222222:cluster/orders",
        "kubernetes-admin@cluster-1",
        "kubernetes-admin@cluster-2",
      ].map((n) => ctx(n)),
    );
    const sets = collectCommands("").filter((c) => c.section === "Cluster sets");
    expect(sets.map((c) => [c.title, c.hint])).toEqual([["prod-eu · all zones", "z1 z2 z3"]]);
  });
});
