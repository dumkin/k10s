import { type Accessor, createRoot, createSignal } from "solid-js";
import { render } from "solid-js/web";
import { createStore } from "solid-js/store";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// The engine, as far as the Retry and Reconnect of error screens go.
const engine = vi.hoisted(() => ({ connect: vi.fn(), reconnect: vi.fn() }));
vi.mock("../lib/backend", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/backend")>()),
  backend: () => ({ connect: engine.connect, reconnect: engine.reconnect }),
}));

import { type ClusterInfo, type Column, Tone } from "../lib/backend";
import { setClusterStatus, setContexts, setSelectedClustersRaw } from "../state/clusters";
import { clearMarks, clearNamespaceMemory, closeDetails, detailsOpen, marked, namespaces, rememberedNamespaces, rememberNamespaces, selectedKey, setNamespaces, setSelectedKey } from "../state/nav";
import { cellText, createTableModel, type TableModel } from "../state/table";
import { now, setPickerOpen, setToasts, toasts } from "../state/ui";
import type { FeedState, UIRow, ViewFeed } from "../state/view";
import { ResourceTable } from "./ResourceTable";

beforeAll(() => {
  // jsdom has no layout.
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.innerHTML = "";
});

const READY: Column = { id: "pc_ready_status", title: "Ready", kind: "status" };

function mount(notices: Record<string, string>, rows: ViewFeed["rows"] = () => [], statuses: Record<string, FeedState> = {}, loading: Accessor<boolean> = () => false, columns: Column[] = [READY]): TableModel {
  let model!: TableModel;
  const feed: ViewFeed = {
    columns: () => columns,
    rows,
    statuses,
    resolved: {},
    notices,
    version: () => 0,
    generation: () => 0,
    loading,
    rowByKey: () => undefined,
  };
  const root = document.createElement("div");
  document.body.append(root);
  dispose = createRoot((d) => {
    model = createTableModel(feed);
    const unmount = render(() => <ResourceTable feed={feed} model={model} title="Widgets" onContextMenu={() => {}} />, root);
    return () => {
      unmount();
      d();
    };
  });
  return model;
}

describe("ResourceTable", () => {
  it("says on which clusters printer columns are missing, and why", () => {
    const why = "printer columns unavailable: no access to its CustomResourceDefinition, and the API server does not print tables for widgets.example.com";
    mount({ "prod-eu-z3": why, "prod-eu-z1": why, "prod-eu-z2": "printer columns unavailable: no answer within 8s" });
    const lines = [...document.querySelectorAll(".columns-notice > div")].map((el) => el.textContent);
    expect(lines).toEqual([`prod-eu-z1, prod-eu-z3${why}`, "prod-eu-z2printer columns unavailable: no answer within 8s"]);
  });

  it("shows nothing when every cluster has its columns", () => {
    mount({});
    expect(document.querySelector(".columns-notice")).toBeNull();
    expect([...document.querySelectorAll(".th")].map((el) => el.textContent)).toContain("Ready");
  });

  it("resizes a column live, at most once a frame, without sorting again, and saves the width once", () => {
    vi.useFakeTimers();
    try {
      const save = vi.spyOn(Storage.prototype, "setItem");
      const rows = Array.from({ length: 50 }, (_, i) => ({ key: `z1/w-${i}`, cl: "prod-eu-z1", u: `w-${i}`, n: `w-${i}`, ns: "default", rv: "1", t: 0, s: Tone.Ok, c: [[i % 2 ? "True" : "False", Tone.Ok]] }) as never);
      const model = mount({}, () => rows);
      const sorted = model.sorted();
      const width = () => model.columns().find((c) => c.id === "pc_ready_status")!.width;
      const start = width();
      const handle = [...document.querySelectorAll(".th")].find((el) => el.textContent === "Ready")!.querySelector(".col-resize")!;
      handle.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, clientX: 500 }));
      for (let x = 501; x <= 540; x++) window.dispatchEvent(new MouseEvent("mousemove", { clientX: x, buttons: 1 }));
      expect(width()).toBe(start);
      vi.advanceTimersToNextFrame();
      expect(width()).toBe(start + 40);
      window.dispatchEvent(new MouseEvent("mousemove", { clientX: 560, buttons: 1 }));
      window.dispatchEvent(new MouseEvent("mouseup", { clientX: 560 }));
      vi.advanceTimersByTime(100);
      expect(width()).toBe(start + 60);
      expect(model.sorted()).toBe(sorted);
      expect(save.mock.calls.filter(([key]) => key === "k10s:colWidths")).toHaveLength(1);
      save.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("⌥-click on a cell", () => {
  const rows: UIRow[] = [
    { key: "z1/payments-api-7d9f6c5b4-x2kqp", cl: "prod-eu-z1", u: "a", n: "payments-api-7d9f6c5b4-x2kqp", ns: "payments", rv: "1", t: 0, s: Tone.Ok, c: [["Running", Tone.Ok]] },
    { key: "z1/payments-worker", cl: "prod-eu-z1", u: "w", n: "payments-worker", ns: "payments", rv: "1", t: 0, s: Tone.Ok, c: [null] },
  ];
  // The clipboard's stand-in writes at once (inside the click), so what was copied is known right after it.
  let copied: string[] = [];
  const cell = (row: number, col: string) => document.querySelectorAll(".tr")[row].querySelector(`[data-col="${col}"]`)!;
  /** Dispatches a mouse event; false when its default action was prevented. */
  const mouse = (type: string, el: Element, init: MouseEventInit = {}) => el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, ...init }));
  const key = (type: string, init: KeyboardEventInit, target: EventTarget = window) => target.dispatchEvent(new KeyboardEvent(type, { bubbles: true, ...init }));
  const copyCells = () => document.querySelector(".table")!.classList.contains("copy-cells");

  beforeEach(() => {
    copied = [];
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (text: string) => void copied.push(text) } });
  });
  afterEach(() => {
    Reflect.deleteProperty(navigator, "clipboard");
    setSelectedKey(null);
    clearMarks();
    closeDetails();
    setToasts([]);
  });

  it("copies the cell's text and does nothing else: the selection, the marks, the focus and the details stay", async () => {
    mount({}, () => rows);
    expect(mouse("mousedown", cell(0, "pc_ready_status"), { altKey: true })).toBe(false);
    expect(copied).toEqual(["Running"]);
    await vi.waitFor(() => expect(toasts().at(-1)).toMatchObject({ kind: "success", title: "Copied Ready", detail: "Running" }));
    mouse("mousedown", cell(0, "name"), { altKey: true });
    expect(copied).toEqual(["Running", "payments-api-7d9f6c5b4-x2kqp"]);
    expect(selectedKey()).toBeNull();
    expect(marked().size).toBe(0);
    expect(detailsOpen()).toBe(false);
  });

  it("copies once on a double ⌥-click, which opens nothing; a press of the same run on another row's cell copies it", () => {
    mount({}, () => rows);
    mouse("mousedown", cell(0, "name"), { altKey: true, detail: 1 });
    mouse("mousedown", cell(0, "name"), { altKey: true, detail: 2 });
    mouse("dblclick", cell(0, "name"), { altKey: true, detail: 2 });
    expect(copied).toEqual(["payments-api-7d9f6c5b4-x2kqp"]);
    expect(detailsOpen()).toBe(false);
    // The rows scrolled under a pointer that stayed put: the next press is the run's third, on another row.
    mouse("mousedown", cell(1, "name"), { altKey: true, detail: 3 });
    expect(copied).toEqual(["payments-api-7d9f6c5b4-x2kqp", "payments-worker"]);
  });

  it("goes by what the presses of a run of clicks did, not by the keys of its last one", () => {
    mount({}, () => rows);
    // A click, then a ⌥-click on the same spot, which WebKitGTK counts as the second of a double click: it copies…
    mouse("mousedown", cell(0, "name"), { detail: 1 });
    mouse("mousedown", cell(0, "name"), { altKey: true, detail: 2 });
    mouse("dblclick", cell(0, "name"), { altKey: true, detail: 2 });
    expect(copied).toEqual(["payments-api-7d9f6c5b4-x2kqp"]);
    expect(detailsOpen()).toBe(false);
    // …and a ⌥-click, then a click: the click selects, and no details open.
    mouse("mousedown", cell(1, "name"), { altKey: true, detail: 1 });
    mouse("mousedown", cell(1, "name"), { detail: 2 });
    mouse("dblclick", cell(1, "name"), { detail: 2 });
    expect(selectedKey()).toBe("z1/payments-worker");
    expect(detailsOpen()).toBe(false);
    // A double click without ⌥ still opens them.
    mouse("mousedown", cell(0, "name"), { detail: 1 });
    mouse("mousedown", cell(0, "name"), { detail: 2 });
    mouse("dblclick", cell(0, "name"), { detail: 2 });
    expect(detailsOpen()).toBe(true);
  });

  it("copies nothing where there is nothing to copy, which isn't shown as copyable, and is no plain click there either", () => {
    mount({}, () => rows);
    // An empty cell is a dash, of every kind.
    expect(cell(1, "pc_ready_status").classList.contains("empty-cell")).toBe(true);
    expect(cell(0, "pc_ready_status").classList.contains("empty-cell")).toBe(false);
    expect(cell(0, "age").classList.contains("empty-cell")).toBe(true);
    expect(mouse("mousedown", cell(1, "pc_ready_status"), { altKey: true })).toBe(false);
    expect(mouse("mousedown", document.querySelectorAll(".tr")[1].querySelector(".c-status")!, { altKey: true })).toBe(false);
    mouse("dblclick", cell(1, "pc_ready_status"), { altKey: true });
    expect(copied).toEqual([]);
    expect(toasts()).toEqual([]);
    expect(selectedKey()).toBeNull();
    expect(detailsOpen()).toBe(false);
  });

  it("leaves ⌥ with ⇧, ⌘ or Ctrl (AltGr too) to the clicks they are", () => {
    mount({}, () => rows);
    mouse("mousedown", cell(1, "name"), { altKey: true, metaKey: true });
    expect(marked().has("z1/payments-worker")).toBe(true);
    mouse("mousedown", cell(1, "name"), { altKey: true, ctrlKey: true });
    expect(marked().has("z1/payments-worker")).toBe(false);
    mouse("mousedown", cell(0, "name"), { altKey: true, shiftKey: true });
    expect(selectedKey()).toBe("z1/payments-api-7d9f6c5b4-x2kqp");
    expect(copied).toEqual([]);
  });

  it("shows at most 120 characters of what it copied, whole ones, and says when the clipboard refuses", async () => {
    const long = `${"a".repeat(118)}🚀${"b".repeat(10)}`;
    mount({}, () => [{ ...rows[0], key: "z1/long", n: long }]);
    mouse("mousedown", cell(0, "name"), { altKey: true });
    expect(copied).toEqual([long]);
    await vi.waitFor(() => expect(toasts().at(-1)).toMatchObject({ kind: "success", title: "Copied Name", detail: `${"a".repeat(118)}🚀…` }));
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: () => Promise.reject(new Error("Write permission denied.")) } });
    mouse("mousedown", cell(0, "name"), { altKey: true });
    await vi.waitFor(() => expect(toasts().at(-1)).toMatchObject({ kind: "error", title: "Could not copy" }));
    expect(toasts().at(-1)?.detail).toContain("Write permission denied");
  });

  it("shows each cell's text, which is what ⌥-click copies", () => {
    const ago = now() - 600;
    const columns: Column[] = [READY, { id: "pc_restarts", title: "Restarts", kind: "restarts" }, { id: "pc_ip", title: "IP", kind: "text" }, { id: "pc_cpu", title: "CPU", kind: "cpu" }, { id: "pc_jobs", title: "Completions", kind: "ratio" }];
    const row: UIRow = { ...rows[0], c: [["Running", Tone.Ok], [2, ago], "10.244.1.23", 1_700, [1, 2]] };
    const model = mount({}, () => [row], {}, () => false, columns);
    const cells = [...document.querySelectorAll<HTMLElement>(".tr .td[data-col]")];
    expect(cells.map((el) => el.dataset.col)).toEqual(model.columns().map((c) => c.id));
    for (const [i, c] of model.columns().entries()) {
      expect(cells[i].textContent).toBe(cellText(c, row, now));
      mouse("mousedown", cells[i], { altKey: true });
    }
    expect(copied).toEqual(["payments-api-7d9f6c5b4-x2kqp", "payments", "Running", "2 (10m ago)", "10.244.1.23", "1.7", "1/2"]);
  });

  it("shows that cells copy while ⌥ alone is held, not while it types", () => {
    mount({}, () => rows);
    key("keydown", { key: "Alt", altKey: true });
    expect(copyCells()).toBe(true);
    key("keyup", { key: "Alt" });
    expect(copyCells()).toBe(false);
    // With ⌘ it's another shortcut.
    key("keydown", { key: "Alt", altKey: true, metaKey: true });
    expect(copyCells()).toBe(false);
    // ⌥ in a field (or a terminal) types — characters, on macOS.
    const field = document.body.appendChild(document.createElement("input"));
    key("keydown", { key: "Alt", altKey: true }, field);
    expect(copyCells()).toBe(false);
    // Leaving the window, or hiding it, no keyup comes.
    key("keydown", { key: "Alt", altKey: true });
    window.dispatchEvent(new Event("blur"));
    expect(copyCells()).toBe(false);
    key("keydown", { key: "Alt", altKey: true });
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    try {
      document.dispatchEvent(new Event("visibilitychange"));
    } finally {
      Reflect.deleteProperty(document, "visibilityState");
    }
    expect(copyCells()).toBe(false);
    // The mouse says so too: ⌥ went down while another window had the keyboard.
    mouse("mousemove", cell(0, "name"), { altKey: true });
    expect(copyCells()).toBe(true);
    mouse("mousemove", cell(0, "name"));
    expect(copyCells()).toBe(false);
  });
});

describe("the no access screen", () => {
  const forbidden = (c: string, ns: string): FeedState => ({ state: "error", code: 403, reason: "Forbidden", terminal: true, message: `widgets is forbidden: User "jane" cannot list resource "widgets" in the namespace "${ns}"`, c, ns });

  afterEach(() => {
    clearNamespaceMemory();
    setNamespaces([]);
    setSelectedClustersRaw([]);
    setContexts([]);
    setPickerOpen(null);
  });

  it("offers the kubeconfig's namespaces apart from the remembered ones, which can be forgotten", () => {
    setContexts([
      { name: "prod-eu-z1", cluster: "prod-eu-z1", auth: "exec: kubelogin", namespace: "payments" },
      { name: "prod-eu-z2", cluster: "prod-eu-z2", auth: "exec: kubelogin", namespace: "orders" },
      { name: "stage-us", cluster: "stage-us", auth: "exec: kubelogin", namespace: "sandbox" },
    ]);
    setSelectedClustersRaw(["prod-eu-z1", "prod-eu-z2"]);
    clearNamespaceMemory();
    for (const n of ["ledger", "payments", "checkout"]) rememberNamespaces([n]);
    setNamespaces(["billing"]);
    mount({}, () => [], { "prod-eu-z1|billing": forbidden("prod-eu-z1", "billing"), "prod-eu-z2|billing": forbidden("prod-eu-z2", "billing") });

    expect(document.querySelector(".access-cta h3")?.textContent).toBe("No access to widgets in billing");
    const fromKubeconfig = () => [...document.querySelectorAll<HTMLButtonElement>(".cta-kubeconfig .chip")];
    const remembered = () => [...document.querySelectorAll<HTMLElement>(".cta-remembered .chip")].map((c) => c.querySelector(".chip-open")!.textContent);
    expect(document.querySelector(".cta-kubeconfig .faint")?.textContent).toBe("From kubeconfig:");
    expect(fromKubeconfig().map((c) => [c.textContent, c.title])).toEqual([
      ["payments", "Set by the kubeconfig context prod-eu-z1"],
      ["orders", "Set by the kubeconfig context prod-eu-z2"],
    ]);
    // Most recent first; what the kubeconfig sets is not repeated (and can't be forgotten).
    expect(remembered()).toEqual(["checkout", "ledger"]);

    document.querySelector<HTMLButtonElement>('.cta-remembered .chip-x[aria-label="Forget ledger"]')!.click();
    expect(remembered()).toEqual(["checkout"]);
    expect(rememberedNamespaces()).toEqual(["checkout", "payments"]);

    document.querySelector<HTMLButtonElement>(".cta-remembered .chip-open")!.click();
    expect(namespaces()).toEqual(["checkout"]);
  });

  it("takes the keyboard only when nothing else has it, and keeps what was typed when the view reloads", async () => {
    const settle = () => new Promise((r) => setTimeout(r, 0));
    const [loading, setLoading] = createSignal(false);
    const reload = async () => {
      setLoading(true);
      setLoading(false);
      await settle();
    };
    const field = () => document.querySelector<HTMLInputElement>(".cta-form input")!;
    // The cluster picker is open (its search has the keyboard) while the view lists: the screen comes up behind it.
    const search = document.createElement("input");
    document.body.append(search);
    search.focus();
    setPickerOpen("clusters");
    mount({}, () => [], { "prod-eu-z1|": { ...forbidden("prod-eu-z1", ""), ns: null } }, loading);
    await settle();
    expect(document.querySelector(".access-cta h3")?.textContent).toBe("No cluster-wide access to widgets");
    expect(document.activeElement).toBe(search);
    // Toggling another cluster reloads the view: still the picker's.
    await reload();
    expect(document.activeElement).toBe(search);

    // Nothing else has the keyboard: the namespace field takes it.
    setPickerOpen(null);
    search.blur();
    await reload();
    expect(document.activeElement).toBe(field());
    field().value = "ledger";
    field().dispatchEvent(new InputEvent("input", { bubbles: true }));
    // A reconnect reloads the view: what was typed stays.
    await reload();
    expect([field().value, document.activeElement]).toEqual(["ledger", field()]);

    // Typing in a field outside the table (the filter): a reload leaves the keyboard there.
    search.focus();
    await reload();
    expect(document.activeElement).toBe(search);
    expect(namespaces()).toEqual([]);
  });
});

describe("error screens", () => {
  const info = (context: string): ClusterInfo => ({ context, server: "https://127.0.0.1:6443", aggregatedDiscovery: true, resources: [] });
  const failure = (c: string, message: string, more: { code?: number; reason?: string } = {}): FeedState => ({ state: "error", message, ...more, c, ns: null });
  const clusterScope = (c: string) => failure(c, 'widgets is forbidden: User "jane" cannot list resource "widgets" in API group "example.com" at the cluster scope', { code: 403, reason: "Forbidden" });
  const timeout = (c: string) => `cluster "${c}": dial tcp 10.200.0.12:6443: i/o timeout (is the cluster reachable?)`;
  const unreachable = (c: string) => failure(c, timeout(c));
  const clusters = ["acme-prod-db-z1", "acme-prod-db-z2", "legacy-onprem", "acme-stage"];
  const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>(".table-empty button")].find((b) => b.textContent?.trim() === label);
  const heading = () => document.querySelector(".table-empty h3")?.textContent;

  beforeEach(() => {
    engine.connect.mockReset().mockImplementation(async (c: string) => info(c));
    engine.reconnect.mockReset().mockImplementation(async (c: string) => info(c));
    setContexts(clusters.map((name) => ({ name, cluster: name, auth: "exec: kubelogin", namespace: name.startsWith("acme-prod-db") ? "payments" : null })));
    setSelectedClustersRaw(["acme-prod-db-z1", "legacy-onprem"]);
    setClusterStatus("acme-prod-db-z1", { state: "connected", info: info("acme-prod-db-z1") });
    // Unreachable: its connection failed.
    setClusterStatus("legacy-onprem", { state: "error", message: timeout("legacy-onprem") });
  });
  afterEach(() => {
    for (const c of clusters) setClusterStatus(c, undefined!);
    clearNamespaceMemory();
    setNamespaces([]);
    setSelectedClustersRaw([]);
    setContexts([]);
    vi.useRealTimers();
  });

  it("offers a namespace when one cluster may not list across namespaces and another failed otherwise, with its Retry", async () => {
    mount({}, () => [], { "acme-prod-db-z1|": clusterScope("acme-prod-db-z1"), "legacy-onprem|": unreachable("legacy-onprem") });
    expect(heading()).toBe("No cluster-wide access to widgets on acme-prod-db-z1");
    expect(document.querySelector(".cta-form input")).not.toBeNull();
    expect(document.querySelector(".cta-kubeconfig .chip")?.textContent).toBe("payments");
    // The refusal is in the details; what may pass is in sight, with the way on.
    expect(document.querySelector(".cta-details")?.textContent).toContain("at the cluster scope");
    expect(document.querySelector(".cta-details")?.textContent).not.toContain("legacy-onprem");
    expect(document.querySelector(".cta-others")?.textContent).toContain('legacy-onprem — Error: cluster "legacy-onprem": dial tcp');
    expect(button("Reconnect")).toBeUndefined();
    button("Retry")!.click();
    // Only unreachable: tried again with the credentials it has, without running its auth plugin again.
    await vi.waitFor(() => expect(button("Retry")?.disabled).toBe(false));
    expect(engine.connect.mock.calls).toEqual([["legacy-onprem"]]);
    expect(engine.reconnect).not.toHaveBeenCalled();
  });

  it("offers it while other clusters still load, until one of them has rows", () => {
    vi.useFakeTimers();
    const [statuses, setStatuses] = createStore<Record<string, FeedState>>({
      "acme-prod-db-z1|": clusterScope("acme-prod-db-z1"),
      "legacy-onprem|": { state: "connecting", c: "legacy-onprem", ns: null },
    });
    const [rows, setRows] = createSignal<ReturnType<ViewFeed["rows"]>>([]);
    mount({}, rows, statuses, () => true);
    vi.advanceTimersByTime(120);
    expect(heading()).toBe("No cluster-wide access to widgets on acme-prod-db-z1");
    expect(document.querySelector(".cta-waiting")?.textContent).toBe("Waiting for legacy-onprem…");
    setStatuses("legacy-onprem|", unreachable("legacy-onprem"));
    expect(document.querySelector(".cta-waiting")).toBeNull();
    expect(button("Retry")).toBeDefined();
    setRows([{ key: "legacy-onprem/w-1", cl: "legacy-onprem", u: "w-1", n: "w-1", ns: "default", rv: "1", t: 0, s: Tone.Ok, c: [["True", Tone.Ok]] }]);
    expect(document.querySelector(".table-empty")).toBeNull();
  });

  it("is as it was when every cluster may not list across namespaces", () => {
    setSelectedClustersRaw(["acme-prod-db-z1", "acme-prod-db-z2"]);
    mount({}, () => [], { "acme-prod-db-z1|": clusterScope("acme-prod-db-z1"), "acme-prod-db-z2|": clusterScope("acme-prod-db-z2") });
    expect(heading()).toBe("No cluster-wide access to widgets");
    expect(document.querySelector(".cta-others, .cta-waiting, .cta-actions")).toBeNull();
  });

  it("says what could not be loaded, with Reconnect where credentials failed and Retry for the rest", async () => {
    setSelectedClustersRaw(["acme-prod-db-z1", "legacy-onprem", "acme-stage"]);
    setClusterStatus("acme-stage", { state: "connected", info: info("acme-stage") });
    mount({}, () => [], {
      "acme-prod-db-z1|": failure("acme-prod-db-z1", "Unauthorized: credentials are missing or expired (Unauthorized)", { code: 401, reason: "Unauthorized" }),
      "legacy-onprem|": unreachable("legacy-onprem"),
      "acme-stage|": failure("acme-stage", "the server is currently unable to handle the request", { code: 503 }),
    });
    expect(heading()).toBe("Could not load widgets");
    expect(document.querySelector(".error-list")?.textContent).toContain("acme-prod-db-z1 — Not authorized — credentials expired?: Unauthorized");
    expect([button("Reconnect")?.title, button("Retry")?.title]).toEqual([
      "Sign in to acme-prod-db-z1 again: fresh credentials from the kubeconfig's auth plugin",
      "Try legacy-onprem, acme-stage again",
    ]);

    button("Reconnect")!.click();
    expect([button("Reconnect")!.disabled, button("Retry")!.disabled]).toEqual([true, true]);
    await vi.waitFor(() => expect(button("Retry")!.disabled).toBe(false));
    expect(engine.reconnect.mock.calls).toEqual([["acme-prod-db-z1"]]);

    button("Retry")!.click();
    await vi.waitFor(() => expect(button("Retry")!.disabled).toBe(false));
    // The unreachable one connects again as it was; the connected one reconnects, which restarts its watches now.
    expect(engine.connect.mock.calls).toEqual([["legacy-onprem"]]);
    expect(engine.reconnect.mock.calls).toEqual([["acme-prod-db-z1"], ["acme-stage"]]);
  });

  it("offers Reconnect for a connection that failed for its credentials", () => {
    const message = 'cluster "legacy-onprem": auth plugin `kubelogin` did not finish within 90s (waiting for a login?). Run it in a terminal to see why, then reconnect';
    setClusterStatus("legacy-onprem", { state: "error", message });
    mount({}, () => [], { "legacy-onprem|": failure("legacy-onprem", message) });
    expect(document.querySelector(".error-list")?.textContent).toContain("legacy-onprem — Sign-in failed: ");
    expect([button("Reconnect"), button("Retry")].map((b) => !!b)).toEqual([true, false]);
    button("Reconnect")!.click();
    expect(engine.reconnect.mock.calls).toEqual([["legacy-onprem"]]);
  });
});
