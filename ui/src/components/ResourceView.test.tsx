import { createRoot } from "solid-js";
import { render } from "solid-js/web";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// The engine, as far as connecting clusters goes (what a cluster pill does when clicked).
const engine = vi.hoisted(() => ({ connect: vi.fn(), reconnect: vi.fn() }));
vi.mock("../lib/backend", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/backend")>()),
  backend: () => ({ connect: engine.connect, reconnect: engine.reconnect }),
}));

import { Tone } from "../lib/backend";
import type { UIRow } from "../state/view";

// The main table without an engine: rows come from a signal the tests set (the same rows for every
// resource, like a feed that has not caught up yet).
const feed = vi.hoisted(() => ({ setRows: (_rows: UIRow[]) => {} }));
vi.mock("../state/view", async () => {
  const { createSignal } = await import("solid-js");
  const [rows, setRows] = createSignal<UIRow[]>([]);
  feed.setRows = setRows;
  return {
    createViewFeed: () => ({
      version: () => 0,
      rowByKey: (k: string) => rows().find((r) => r.key === k),
      rows,
      columns: () => [],
      statuses: {},
      resolved: {},
      loading: () => false,
    }),
    createNamesFeed: () => ({ version: () => 0, clusters: () => new Map(), statuses: {}, loading: () => false }),
  };
});
// The details panel is only a place keyboard focus can be in.
vi.mock("./DetailsPanel", () => ({
  DetailsPanel: () => {
    const el = document.createElement("aside");
    el.className = "details";
    el.append(document.createElement("button"));
    return el;
  },
}));

const pods = Array.from({ length: 100 }, (_, i): UIRow => ({ key: `z1/pod-${i}`, cl: "prod-eu-z1", u: `pod-${i}`, n: `pod-${i}`, ns: "payments", rv: "1", t: 0, s: Tone.Ok, c: [] }));

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
  vi.restoreAllMocks();
});

/**
 * A fresh app (state, shortcuts) as on macOS or elsewhere, with the resource view mounted — after `before`, which may
 * register what the view takes in as it mounts (the details tabs).
 */
async function mount(platform: "MacIntel" | "Linux x86_64", before?: () => Promise<unknown>) {
  vi.resetModules();
  vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
  const hotkeys = await import("../lib/hotkeys");
  const nav = await import("../state/nav");
  const ui = await import("../state/ui");
  const views = await import("../state/views");
  const { ResourceView } = await import("./ResourceView");
  await before?.();
  hotkeys.installHotkeys();
  const disposeViews = createRoot((d) => {
    views.initViews();
    return d;
  });
  const root = document.createElement("div");
  document.body.append(root);
  const disposeView = render(() => <ResourceView />, root);
  dispose = () => {
    disposeView();
    disposeViews();
  };
  feed.setRows(pods);
  nav.navigate("pods");
  nav.setNamespaces(["payments"]);
  nav.clearHistory();
  return { nav, ui };
}

const press = (target: EventTarget, init: KeyboardEventInit) => {
  const e = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(e);
  return e;
};
const mouseUp = (button: number) => {
  const e = new MouseEvent("mouseup", { button, bubbles: true, cancelable: true });
  document.body.dispatchEvent(e);
  return e;
};

describe.each([
  ["macOS", "MacIntel", { key: "[", code: "BracketLeft", metaKey: true }, { key: "]", code: "BracketRight", metaKey: true }],
  ["Linux / Windows", "Linux x86_64", { key: "ArrowLeft", code: "ArrowLeft", altKey: true }, { key: "ArrowRight", code: "ArrowRight", altKey: true }],
] as const)("back / forward on %s", (_name, platform, back, forward) => {
  it("goes back and forward from the table, the filter and the details panel", async () => {
    const { nav } = await mount(platform);
    nav.setFilter("pod-1");
    nav.openDetails("z1/pod-1", "logs");
    nav.navigate("deployments");

    expect(press(document.body, back).defaultPrevented).toBe(true);
    expect([nav.resourceKey(), nav.filter(), nav.selectedKey(), nav.detailsOpen(), nav.detailsTab()]).toEqual(["pods", "pod-1", "z1/pod-1", true, "logs"]);
    press(document.body, forward);
    expect(nav.resourceKey()).toBe("deployments");

    // From the filter input (typing there doesn't block it).
    const input = document.querySelector<HTMLInputElement>(".filter input")!;
    input.focus();
    press(input, back);
    expect(nav.resourceKey()).toBe("pods");

    // From inside the details panel (logs, YAML…).
    const inDetails = document.querySelector<HTMLButtonElement>(".details button")!;
    inDetails.focus();
    press(inDetails, forward);
    expect(nav.resourceKey()).toBe("deployments");
  });

  it("does nothing while the palette, a picker or a dialog is open", async () => {
    const { nav, ui } = await mount(platform);
    nav.navigate("deployments");
    for (const [open, close] of [
      [() => ui.setPaletteOpen({ query: "" }), () => ui.setPaletteOpen(false)],
      [() => ui.setPickerOpen("namespaces"), () => ui.setPickerOpen(null)],
      [() => void ui.ask({ title: "Delete?", confirmLabel: "Delete" }), () => ui.dialog()?.resolve(null) ?? ui.setDialog(null)],
    ] as const) {
      open();
      expect(press(document.body, back).defaultPrevented).toBe(false);
      expect(mouseUp(3).defaultPrevented).toBe(true);
      expect(nav.resourceKey()).toBe("deployments");
      close();
      ui.setDialog(null);
    }
    press(document.body, back);
    expect(nav.resourceKey()).toBe("pods");
  });

  it("follows the mouse back / forward buttons and keeps the page from navigating", async () => {
    const { nav } = await mount(platform);
    nav.navigate("deployments");
    expect(mouseUp(3).defaultPrevented).toBe(true);
    expect(nav.resourceKey()).toBe("pods");
    expect(mouseUp(4).defaultPrevented).toBe(true);
    expect(nav.resourceKey()).toBe("deployments");
    // Other buttons are left alone.
    expect(mouseUp(0).defaultPrevented).toBe(false);
    expect(mouseUp(1).defaultPrevented).toBe(false);
    expect(nav.resourceKey()).toBe("deployments");
  });
});

describe("going back to a row that isn't loaded yet", () => {
  it("scrolls to it once it shows up", async () => {
    const { nav } = await mount("Linux x86_64");
    const scroller = document.querySelector<HTMLDivElement>(".tscroll")!;
    // Room for 10 rows under the header; jsdom does no layout.
    let top = 0;
    Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 31 + 10 * 28 });
    Object.defineProperty(scroller, "scrollTop", { configurable: true, get: () => top, set: (v: number) => (top = v) });

    nav.setSelectedKey("z1/pod-80");
    await Promise.resolve();
    const atRow80 = top;
    expect(atRow80).toBe(81 * 28 - 10 * 28);

    nav.navigate("deployments");
    feed.setRows([]);
    top = 0;
    nav.goBack();
    expect(nav.selectedKey()).toBe("z1/pod-80");
    await Promise.resolve();
    expect(top).toBe(0);

    // The pods feed catches up: the restored selection is scrolled into view.
    feed.setRows(pods);
    await Promise.resolve();
    expect(top).toBe(atRow80);
  });
});

describe("read-only mode", () => {
  const click = (el: Element) => el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }));

  it("greys out the changes in the marks toolbar and the context menu, says read-only mode did it, and runs none of them", async () => {
    const { nav, ui } = await mount("Linux x86_64");
    ui.noteReadOnlyRefusal();
    nav.setMarked(new Set(["z1/pod-1", "z1/pod-2"]));
    const reason = "Delete 2 — off in read-only mode: it changes objects in the cluster. Turn read-only mode off in the status bar (it asks to confirm) to use it.";
    const tool = (title: string) => [...document.querySelectorAll<HTMLButtonElement>(".tools button")].find((b) => b.title === title)!;
    const del = tool(reason);
    expect([del.getAttribute("aria-disabled"), del.classList.contains("locked")]).toEqual(["true", true]);
    // Enabled ones name their key; the key acts on the marks, as the toolbar does.
    expect(tool("Copy 2 names (C)").getAttribute("aria-disabled")).toBeNull();
    click(del);
    expect(ui.dialog()).toBeNull();

    // Right-click on a marked row: the menu acts on the marks.
    const row = [...document.querySelectorAll(".tr")].find((r) => r.querySelector(".name")?.textContent === "pod-2")!;
    row.querySelector(".td")!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
    const item = (label: string) => [...document.querySelectorAll<HTMLButtonElement>(".menu .opt")].find((b) => b.querySelector("span")?.textContent === label)!;
    const delItem = item("Delete 2…");
    // "read-only" where its key would be; the tooltip says what read-only mode turns off and why.
    expect([delItem.getAttribute("aria-disabled"), delItem.title, delItem.querySelector(".kbd"), delItem.querySelector(".ro-tag")?.textContent]).toEqual(["true", reason, null, "read-only"]);
    expect([item("Copy 2 names").getAttribute("aria-disabled"), item("Copy 2 names").title, item("Copy 2 names").querySelector(".ro-tag")]).toEqual([null, "", null]);
    click(delItem);
    expect(document.querySelector(".menu")).not.toBeNull();
    expect(ui.dialog()).toBeNull();
    expect(ui.toasts()).toEqual([]);
  });
});

describe("keyboard", () => {
  const key = (init: KeyboardEventInit) => press(document.body, init);

  it("opens namespaces with the number keys, like k9s's favorites (0: all of them)", async () => {
    const { nav } = await mount("MacIntel");
    const clusters = await import("../state/clusters");
    clusters.setSelectedClusters(["prod-eu-z1"]);
    nav.clearNamespaceMemory();
    nav.rememberNamespaces(["payments", "monitoring", "checkout"]);
    // In name order: opening one (the most recent now) does not move it to another key.
    expect(nav.namespaceKeys()).toEqual(["checkout", "monitoring", "payments"]);
    expect(key({ key: "2", code: "Digit2" }).defaultPrevented).toBe(true);
    expect(nav.namespaces()).toEqual(["monitoring"]);
    nav.rememberNamespaces(["monitoring"]);
    expect(nav.namespaceKeys()).toEqual(["checkout", "monitoring", "payments"]);
    key({ key: "0", code: "Digit0" });
    expect(nav.namespaces()).toEqual([]);
    // Nothing on 9: the key is left alone.
    expect(key({ key: "9", code: "Digit9" }).defaultPrevented).toBe(false);
    expect(nav.namespaces()).toEqual([]);
  });

  it("hides and shows clusters' rows with ⌥1…⌥9 (⌥0: all again)", async () => {
    await mount("MacIntel");
    const clusters = await import("../state/clusters");
    const table = await import("../state/table");
    clusters.setSelectedClusters(["prod-eu-z1", "prod-eu-z2"]);
    // Connected (a pill of a cluster that is not acts as clicked: it retries).
    for (const c of ["prod-eu-z1", "prod-eu-z2"]) clusters.setClusterStatus(c, { state: "connected", version: "v1.33.4" });
    // ⌥2 types "™" on a Mac: the key counts.
    key({ key: "™", code: "Digit2", altKey: true });
    expect([...table.hiddenClusters()]).toEqual(["prod-eu-z2"]);
    key({ key: "¡", code: "Digit1", altKey: true });
    expect([...table.hiddenClusters()]).toEqual(["prod-eu-z2", "prod-eu-z1"]);
    key({ key: "º", code: "Digit0", altKey: true });
    expect([...table.hiddenClusters()]).toEqual([]);
  });

  it("sorts by name and age with ⇧N / ⇧A, again for the other way", async () => {
    await mount("Linux x86_64");
    const table = await import("../state/table");
    key({ key: "N", code: "KeyN", shiftKey: true });
    expect(table.sort()).toEqual({ col: "name", desc: true });
    key({ key: "A", code: "KeyA", shiftKey: true });
    expect(table.sort()).toEqual({ col: "age", desc: false });
    key({ key: "A", code: "KeyA", shiftKey: true });
    expect(table.sort()).toEqual({ col: "age", desc: true });
  });

  it("fills the window with the details (f), whose keys then scroll them; Esc goes back one step at a time", async () => {
    const { nav } = await mount("MacIntel");
    nav.setSelectedKey("z1/pod-5");
    key({ key: "f", code: "KeyF" });
    expect([nav.detailsOpen(), nav.detailsFull()]).toEqual([true, true]);
    // The table is under the details: j / k are theirs, the selection stays.
    key({ key: "j", code: "KeyJ" });
    key({ key: " ", code: "Space" });
    expect([nav.selectedKey(), nav.marked().size]).toEqual(["z1/pod-5", 0]);
    key({ key: "Escape", code: "Escape" });
    expect([nav.detailsOpen(), nav.detailsFull()]).toEqual([true, false]);
    key({ key: "j", code: "KeyJ" });
    expect(nav.selectedKey()).toBe("z1/pod-6");
    // f again: full view and back.
    key({ key: "f", code: "KeyF" });
    key({ key: "f", code: "KeyF" });
    expect([nav.detailsOpen(), nav.detailsFull()]).toEqual([true, false]);
    key({ key: "Escape", code: "Escape" });
    expect(nav.detailsOpen()).toBe(false);
    // Closing the details ends full view; nothing selected: f does nothing.
    key({ key: "f", code: "KeyF" });
    nav.closeDetails();
    expect(nav.detailsFull()).toBe(false);
    nav.setSelectedKey(null);
    expect(key({ key: "f", code: "KeyF" }).defaultPrevented).toBe(false);
  });

  it("leaves Enter and Space to a focused button (Tab, Full Keyboard Access), opening and marking rows otherwise", async () => {
    const { nav } = await mount("Linux x86_64");
    nav.setSelectedKey("z1/pod-5");
    const button = document.createElement("button");
    document.body.append(button);
    button.focus();
    expect(press(button, { key: "Enter", code: "Enter" }).defaultPrevented).toBe(false);
    expect(press(button, { key: " ", code: "Space" }).defaultPrevented).toBe(false);
    expect([nav.detailsOpen(), nav.marked().size, nav.selectedKey()]).toEqual([false, 0, "z1/pod-5"]);
    button.blur();
    key({ key: " ", code: "Space" });
    expect([nav.marked().has("z1/pod-5"), nav.selectedKey()]).toEqual([true, "z1/pod-6"]);
    key({ key: "Enter", code: "Enter" });
    expect(nav.detailsOpen()).toBe(true);
  });

  it("focuses the filter with ⌘F too, from another field", async () => {
    await mount("MacIntel");
    const other = document.createElement("input");
    document.body.append(other);
    other.focus();
    press(other, { key: "f", code: "KeyF", metaKey: true });
    expect(document.activeElement).toBe(document.querySelector(".filter input"));
  });
});

describe("marking rows from the keyboard", () => {
  const key = (init: KeyboardEventInit) => press(document.body, init);
  const marks = (nav: Awaited<ReturnType<typeof mount>>["nav"]) => [...nav.marked()].map((k) => Number(k.slice("z1/pod-".length))).sort((a, b) => a - b);

  it("marks the rows on the way with ⇧J / ⇧K and ⇧↓ / ⇧↑, unmarking them on the way back", async () => {
    const { nav } = await mount("Linux x86_64");
    nav.setMarked(new Set(["z1/pod-1"]));
    nav.setSelectedKey("z1/pod-5");
    key({ key: "J", code: "KeyJ", shiftKey: true });
    // On a Russian layout too: ⇧О is on the J key.
    key({ key: "О", code: "KeyJ", shiftKey: true });
    expect([marks(nav), nav.selectedKey()]).toEqual([[1, 5, 6, 7], "z1/pod-7"]);
    key({ key: "K", code: "KeyK", shiftKey: true });
    key({ key: "ArrowUp", code: "ArrowUp", shiftKey: true });
    key({ key: "ArrowUp", code: "ArrowUp", shiftKey: true });
    expect([marks(nav), nav.selectedKey()]).toEqual([[1, 4, 5], "z1/pod-4"]);
    key({ key: "ArrowDown", code: "ArrowDown", shiftKey: true });
    expect(marks(nav)).toEqual([1, 5]);
    // A plain move leaves the marks; ⇧ marks from there on.
    key({ key: "j", code: "KeyJ" });
    key({ key: "J", code: "KeyJ", shiftKey: true });
    expect([marks(nav), nav.selectedKey()]).toEqual([[1, 5, 6, 7], "z1/pod-7"]);
    // Space unmarks one of them: ⇧K starts again from the cursor.
    key({ key: " ", code: "Space" });
    key({ key: "K", code: "KeyK", shiftKey: true });
    expect([marks(nav), nav.selectedKey()]).toEqual([[1, 5, 6, 7, 8], "z1/pod-7"]);
  });

  it("marks a page, or up to the first or the last row, with ⇧ and PgDn / PgUp, Home / End", async () => {
    const { nav } = await mount("MacIntel");
    // Room for 10 rows under the header: a page is 9.
    Object.defineProperty(document.querySelector(".tscroll")!, "clientHeight", { configurable: true, value: 31 + 10 * 28 });
    nav.setSelectedKey("z1/pod-20");
    key({ key: "PageDown", code: "PageDown", shiftKey: true });
    expect([marks(nav).length, nav.selectedKey()]).toEqual([10, "z1/pod-29"]);
    key({ key: "End", code: "End", shiftKey: true });
    expect([marks(nav).length, nav.selectedKey()]).toEqual([80, "z1/pod-99"]);
    key({ key: "Home", code: "Home", shiftKey: true });
    expect([marks(nav).length, nav.selectedKey()]).toEqual([21, "z1/pod-0"]);
    key({ key: "PageUp", code: "PageUp", shiftKey: true });
    expect(marks(nav).length).toBe(21);
  });

  it("marks with a ⇧-click from the selected row as the keys do, and goes on from there", async () => {
    const { nav } = await mount("MacIntel");
    const down = (n: number, init: MouseEventInit = {}) => {
      const row = [...document.querySelectorAll(".tr")].find((r) => r.querySelector(".name")?.textContent === `pod-${n}`)!;
      row.querySelector(".td")!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, ...init }));
    };
    down(3);
    down(6, { shiftKey: true });
    expect([marks(nav), nav.selectedKey()]).toEqual([[3, 4, 5, 6], "z1/pod-6"]);
    down(4, { shiftKey: true });
    expect([marks(nav), nav.selectedKey()]).toEqual([[3, 4], "z1/pod-4"]);
    key({ key: "J", code: "KeyJ", shiftKey: true });
    expect(marks(nav)).toEqual([3, 4, 5]);
    // ⌘-click marks one more, the cursor stays: a ⇧-click marks from the cursor again.
    down(9, { metaKey: true });
    down(7, { shiftKey: true });
    expect([marks(nav), nav.selectedKey()]).toEqual([[3, 4, 5, 6, 7, 9], "z1/pod-7"]);
  });
});

describe("the context menu", () => {
  const key = (init: KeyboardEventInit) => press(document.activeElement ?? document.body, init);
  const settle = () => new Promise((r) => setTimeout(r, 0));
  const items = () => [...document.querySelectorAll<HTMLButtonElement>(".menu .opt")];
  let copied: string[];

  beforeEach(() => {
    copied = [];
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (text: string) => void copied.push(text) } });
  });
  afterEach(() => Reflect.deleteProperty(navigator, "clipboard"));

  it("runs the key an item shows on what the menu acts on, and leaves the table alone meanwhile", async () => {
    const { nav } = await mount("Linux x86_64");
    nav.setMarked(new Set(["z1/pod-1", "z1/pod-2"]));
    nav.setSelectedKey("z1/pod-2");
    key({ key: "F10", code: "F10", shiftKey: true });
    await settle();
    const copy = items().find((b) => b.querySelector("span")?.textContent === "Copy 2 names")!;
    expect(copy.querySelector(".kbd")?.textContent).toBe("C");
    // j / k move in the menu, not in the table.
    expect(document.activeElement).toBe(items()[0]);
    key({ key: "j", code: "KeyJ" });
    expect(document.activeElement).toBe(items()[1]);
    key({ key: "k", code: "KeyK" });
    key({ key: "k", code: "KeyK" });
    expect(document.activeElement).toBe(items().at(-1));
    expect(nav.selectedKey()).toBe("z1/pod-2");
    // On a Russian layout too: "с" is on the C key.
    expect(key({ key: "с", code: "KeyC" }).defaultPrevented).toBe(true);
    await settle();
    expect([copied, document.querySelector(".menu")]).toEqual([["pod-1\npod-2"], null]);
  });

  it("acts on the row it was opened on, marks elsewhere or not", async () => {
    const { nav, ui } = await mount("MacIntel");
    nav.setMarked(new Set(["z1/pod-1", "z1/pod-2"]));
    const row = [...document.querySelectorAll(".tr")].find((r) => r.querySelector(".name")?.textContent === "pod-7")!;
    row.querySelector(".td")!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
    await settle();
    expect(document.querySelector(".menu-target")?.textContent).toBe("pod-7");
    key({ key: "c", code: "KeyC" });
    await settle();
    expect([copied, nav.marked().size]).toEqual([["pod-7"], 2]);
    expect(ui.toasts().at(-1)).toMatchObject({ kind: "success", title: "Copied name", detail: "pod-7" });
  });

  it("says so when the clipboard refuses, rather than failing unseen", async () => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: () => Promise.reject(new DOMException("The request is not allowed by the user agent or the platform in the current context.", "NotAllowedError")) } });
    const { nav, ui } = await mount("MacIntel");
    nav.setSelectedKey("z1/pod-3");
    key({ key: "F10", code: "F10", shiftKey: true });
    await settle();
    expect(document.querySelector(".menu")).not.toBeNull();
    // The menu runs the action without waiting for it, as the key does: a refusal it threw would go unhandled.
    key({ key: "c", code: "KeyC" });
    await settle();
    expect(document.querySelector(".menu")).toBeNull();
    expect(ui.toasts().map((t) => [t.kind, t.title, t.detail])).toEqual([["error", "Could not copy", "The request is not allowed by the user agent or the platform in the current context."]]);
  });
});

describe("cluster pills", () => {
  const pill = (i: number) => document.querySelectorAll<HTMLButtonElement>(".cluster-pill")[i];
  const clickPill = (i: number, init: MouseEventInit = {}) => pill(i).dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ...init }));
  const CLUSTERS = ["prod-eu-z1", "prod-eu-z2", "prod-eu-z3"];

  /** Three connected clusters (the view's rows still on their way: their pills hide and show them all the same). */
  async function threeClusters(platform: "MacIntel" | "Linux x86_64") {
    await mount(platform);
    const clusters = await import("../state/clusters");
    const table = await import("../state/table");
    clusters.setSelectedClustersRaw(CLUSTERS);
    for (const c of CLUSTERS) clusters.setClusterStatus(c, { state: "connected", version: "v1.33.4" });
    return { clusters, table };
  }

  it.each([
    ["macOS", "MacIntel", { metaKey: true }],
    ["Linux / Windows", "Linux x86_64", { ctrlKey: true }],
  ] as const)("show only their cluster's rows on a ⌘-click (%s), every cluster's on the next; a click hides or shows one", async (_name, platform, mod) => {
    const { table } = await threeClusters(platform);
    expect(pill(1).title).toMatch(/-click: only this cluster$/);
    clickPill(1, mod);
    expect([...table.hiddenClusters()]).toEqual(["prod-eu-z1", "prod-eu-z3"]);
    expect(pill(1).title).toMatch(/-click: every cluster$/);
    // Another one, hidden: only it now.
    clickPill(2, mod);
    expect([...table.hiddenClusters()]).toEqual(["prod-eu-z1", "prod-eu-z2"]);
    clickPill(2, mod);
    expect([...table.hiddenClusters()]).toEqual([]);
    clickPill(0);
    expect([...table.hiddenClusters()]).toEqual(["prod-eu-z1"]);
  });

  it("take a Ctrl-click on macOS (a right click there) for a ⌘-click, and leave right clicks alone", async () => {
    const { table } = await threeClusters("MacIntel");
    const contextMenu = (i: number, init: MouseEventInit) => {
      const e = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, ...init });
      pill(i).dispatchEvent(e);
      return e;
    };
    expect(contextMenu(2, { ctrlKey: true }).defaultPrevented).toBe(true);
    expect([...table.hiddenClusters()]).toEqual(["prod-eu-z1", "prod-eu-z2"]);
    expect(contextMenu(0, { button: 2 }).defaultPrevented).toBe(false);
    expect([...table.hiddenClusters()]).toEqual(["prod-eu-z1", "prod-eu-z2"]);
  });

  it("only show rows on a ⌘-click, without connecting a failed cluster", async () => {
    const { clusters, table } = await threeClusters("MacIntel");
    engine.connect.mockReset();
    engine.reconnect.mockReset();
    clusters.setClusterStatus("prod-eu-z1", { state: "error", message: 'cluster "prod-eu-z1": no answer within 60s (is the cluster reachable? VPN?)' });
    clickPill(0, { metaKey: true });
    expect([...table.hiddenClusters()]).toEqual(["prod-eu-z2", "prod-eu-z3"]);
    expect([engine.connect.mock.calls, engine.reconnect.mock.calls]).toEqual([[], []]);
  });

  it("try a failed connection again with the credentials it has, and get fresh ones where they failed", async () => {
    await mount("MacIntel");
    const clusters = await import("../state/clusters");
    engine.connect.mockReset().mockRejectedValue({ kind: "connect", message: "still unreachable", code: null });
    engine.reconnect.mockReset().mockRejectedValue({ kind: "connect", message: "still waiting for a login", code: null });
    clusters.setSelectedClustersRaw(["prod-eu-z1", "prod-eu-z2"]);
    clusters.setClusterStatus("prod-eu-z1", { state: "error", message: 'cluster "prod-eu-z1": no answer within 60s (is the cluster reachable? VPN?)' });
    clusters.setClusterStatus("prod-eu-z2", {
      state: "error",
      message: 'cluster "prod-eu-z2": auth plugin `kubelogin` did not finish within 90s (waiting for a login?). Run it in a terminal to see why, then reconnect',
    });
    expect(pill(0).title).toMatch(/^prod-eu-z1: cannot connect — click to retry \(⌥1\)/);
    expect(pill(1).title).toMatch(/^prod-eu-z2: cannot connect — click to reconnect \(⌥2\)/);
    pill(0).click();
    press(document.body, { key: "™", code: "Digit2", altKey: true });
    expect(engine.connect.mock.calls).toEqual([["prod-eu-z1"]]);
    expect(engine.reconnect.mock.calls).toEqual([["prod-eu-z2"]]);
  });
});

describe("keys from settings.json", () => {
  const key = (init: KeyboardEventInit) => press(document.body, init);
  let copied: string[];

  beforeEach(() => {
    copied = [];
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (text: string) => void copied.push(text) } });
  });
  afterEach(() => Reflect.deleteProperty(navigator, "clipboard"));

  /** The view with the details tabs, its settings in a file that `edit` changes "outside the app". */
  async function withFile() {
    const app = await mount("Linux x86_64", () => import("../details"));
    const persist = await import("../lib/persist");
    persist.useFiles({ settings: {}, state: {}, settingsError: null, settingsPath: null, statePath: null }, async () => {}, async () => {});
    return { ...app, edit: (keys: unknown) => persist.settingsEdited({ keys }, null) };
  }

  it("open the tabs and run the actions on the keys it gives them, from the moment it changes", async () => {
    const { nav, ui, edit } = await withFile();
    nav.setSelectedKey("z1/pod-5");
    key({ key: "y", code: "KeyY" });
    expect([nav.detailsOpen(), nav.detailsTab()]).toEqual([true, "yaml"]);
    nav.closeDetails();

    edit({ tab: { yaml: "shift+y" }, action: { "copy-name": "alt+c", delete: null } });
    expect(key({ key: "y", code: "KeyY" }).defaultPrevented).toBe(false);
    expect(nav.detailsOpen()).toBe(false);
    key({ key: "Y", code: "KeyY", shiftKey: true });
    expect([nav.detailsOpen(), nav.detailsTab()]).toEqual([true, "yaml"]);
    nav.closeDetails();
    expect(key({ key: "c", code: "KeyC" }).defaultPrevented).toBe(false);
    key({ key: "c", code: "KeyC", altKey: true });
    await Promise.resolve();
    expect(copied).toEqual(["pod-5"]);
    // No keys: delete is not asked for, by either of its own.
    expect(key({ key: "d", code: "KeyD", ctrlKey: true }).defaultPrevented).toBe(false);
    expect(key({ key: "Backspace", code: "Backspace", ctrlKey: true }).defaultPrevented).toBe(false);
    expect(ui.dialog()).toBeNull();
  });

  it("come with the tabs and actions registered after the view mounted", async () => {
    const { nav } = await withFile();
    const { registerAction } = await import("../registry/actions");
    const { registerDetailTab } = await import("../registry/details");
    const ran: string[] = [];
    registerAction({ id: "probe", title: "Probe", icon: "info", shortcut: "alt+p", applies: () => true, run: (ctx) => void ran.push(ctx.rows[0].n) });
    registerDetailTab({ id: "probe", title: "Probe", icon: "info", shortcut: "alt+t", order: 99, when: () => true, component: () => null });
    nav.setSelectedKey("z1/pod-3");
    key({ key: "p", code: "KeyP", altKey: true });
    expect(ran).toEqual(["pod-3"]);
    key({ key: "t", code: "KeyT", altKey: true });
    expect([nav.detailsOpen(), nav.detailsTab()]).toEqual([true, "probe"]);
  });

  it("run the action of a tab's key on several marked rows, and name the keys in the marks' toolbar", async () => {
    const { nav, edit } = await withFile();
    nav.setMarked(new Set(["z1/pod-1", "z1/pod-2"]));
    const tool = (title: RegExp) => [...document.querySelectorAll<HTMLButtonElement>(".tools button")].find((b) => title.test(b.title));
    expect([tool(/^Copy 2 names/)?.title, tool(/^Compare 2/)?.title]).toEqual(["Copy 2 names (C)", "Compare 2 (=)"]);

    edit({ tab: { compare: "alt+=" }, action: { "copy-name": "alt+c" } });
    expect([tool(/^Copy 2 names/)?.title, tool(/^Compare 2/)?.title]).toEqual(["Copy 2 names (Alt+C)", "Compare 2 (Alt+=)"]);
    expect(key({ key: "=", code: "Equal" }).defaultPrevented).toBe(false);
    expect(nav.detailsOpen()).toBe(false);
    // The first marked row, compared with the other.
    key({ key: "=", code: "Equal", altKey: true });
    expect([nav.detailsOpen(), nav.selectedKey(), nav.detailsTab()]).toEqual([true, "z1/pod-1", "compare"]);
  });
});
