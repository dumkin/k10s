import { batch, createEffect, createMemo, createRoot, createSignal, onCleanup } from "solid-js";
import { render } from "solid-js/web";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Tone } from "../lib/backend";
import type { UIRow } from "../state/view";

// The engine: only read-only mode is switched (the tests turn it off again).
const engine = vi.hoisted(() => ({ setReadOnly: vi.fn(async (readOnly: boolean) => ({ readOnly, feedIdleTtlSecs: 180 })) }));
vi.mock("../lib/backend", async (importOriginal) => ({ ...(await importOriginal<typeof import("../lib/backend")>()), backend: () => engine }));

// The main table without an engine: rows, the view's generation and whether it loads come from signals.
const feed = vi.hoisted(() => ({ setRows: (_rows: UIRow[]) => {}, setGeneration: (_g: number) => {}, setLoading: (_l: boolean) => {} }));
vi.mock("../state/view", async () => {
  const { createSignal } = await import("solid-js");
  const [rows, setRows] = createSignal<UIRow[]>([]);
  const [generation, setGeneration] = createSignal(0);
  const [loading, setLoading] = createSignal(false);
  Object.assign(feed, { setRows, setGeneration, setLoading });
  return {
    createViewFeed: () => ({
      version: () => 0,
      generation,
      rowByKey: (k: string) => rows().find((r) => r.key === k),
      rows,
      columns: () => [],
      statuses: {},
      resolved: {},
      notices: {},
      loading,
    }),
    createNamesFeed: () => ({ version: () => 0, clusters: () => new Map(), statuses: {}, loading: () => false }),
  };
});

import { installHotkeys } from "../lib/hotkeys";
import { deferReady, registerDetailTab } from "../registry/details";
import { closeDetails, detailsFull, openDetails, selectedKey, setDetailsFull, setDetailsTab, setSelectedKey } from "../state/nav";
import { dialog, dismissToast, noteReadOnlyRefusal, setReadOnly, toasts } from "../state/ui";
import { initViews } from "../state/views";
import { DetailsPanel, READY_WAIT_MS, SETTLE_MS } from "./DetailsPanel";

const pods = Array.from({ length: 20 }, (_, i): UIRow => ({ key: `z1/pod-${i}`, cl: "prod-eu-z1", u: `pod-${i}`, n: `pod-${i}`, ns: "payments", rv: "1", t: 0, s: Tone.Ok, c: [] }));

// A tab that records what it was mounted for (the real ones open watches and log streams).
const mounted: string[] = [];
const live = new Set<string>();
// Rows its computations saw, as a watch's spec or a fetch derived from `row` would (they open one for each).
const seen: string[] = [];

beforeAll(() => {
  installHotkeys();
  createRoot(() => initViews());
  registerDetailTab({
    id: "probe",
    title: "Probe",
    icon: "info",
    order: -1,
    when: () => true,
    component: (p) => {
      const key = p.row.key;
      mounted.push(key);
      live.add(key);
      createMemo(() => seen.push(p.row.key));
      onCleanup(() => live.delete(key));
      return <div class="probe">{p.row.n}</div>;
    },
  });
});

let dispose: (() => void) | undefined;
beforeEach(() => {
  vi.useFakeTimers();
  feed.setRows(pods);
  feed.setGeneration(0);
  feed.setLoading(false);
  mounted.length = 0;
  seen.length = 0;
});
afterEach(() => {
  dispose?.();
  dispose = undefined;
  closeDetails();
  vi.useRealTimers();
  document.body.innerHTML = "";
});

function mount() {
  const root = document.createElement("div");
  document.body.append(root);
  dispose = render(() => <DetailsPanel />, root);
}

const title = () => document.querySelector(".details h2")?.textContent;
const probe = () => document.querySelector(".probe")?.textContent ?? null;
const stale = () => !!document.querySelector(".d-body.stale");

describe("DetailsPanel", () => {
  it("shows the object it opens with right away", () => {
    openDetails("z1/pod-3");
    mount();
    expect([title(), probe()]).toEqual(["pod-3", "pod-3"]);
    expect(mounted).toEqual(["z1/pod-3"]);
  });

  it("mounts tabs only for the row the selection rests on (j/k held down opens nothing for the rows passed)", () => {
    openDetails("z1/pod-0");
    mount();
    for (let i = 1; i <= 8; i++) {
      setSelectedKey(`z1/pod-${i}`);
      vi.advanceTimersByTime(SETTLE_MS / 4);
      // The header follows at once; the tab keeps showing the row left (stepped back, not blank), nothing is opened
      // for the new one yet.
      expect([title(), probe(), stale()]).toEqual([`pod-${i}`, "pod-0", true]);
    }
    expect([...live]).toEqual(["z1/pod-0"]);
    vi.advanceTimersByTime(SETTLE_MS);
    expect([probe(), stale()]).toEqual(["pod-8", false]);
    expect(mounted).toEqual(["z1/pod-0", "z1/pod-8"]);
    expect([...live]).toEqual(["z1/pod-8"]);
    // The tab left never saw the rows passed (it would have opened a watch for each of them).
    expect(seen).toEqual(["z1/pod-0", "z1/pod-8"]);
  });

  it("keeps the previous object up until the next one's tab has something to show (at most a moment)", () => {
    const [loaded, setLoaded] = createSignal(new Set<string>());
    registerDetailTab({
      id: "slow",
      title: "Slow",
      icon: "info",
      order: -2,
      when: () => true,
      component: (p) => {
        const ready = deferReady();
        createEffect(() => loaded().has(p.row.key) && ready());
        return <div class="slow">{loaded().has(p.row.key) ? p.row.n : ""}</div>;
      },
    });
    try {
      setLoaded(new Set(["z1/pod-0"]));
      openDetails("z1/pod-0");
      mount();
      const slow = () => [...document.querySelectorAll(".d-layer:not(.pending) .slow")].map((e) => e.textContent);
      expect(slow()).toEqual(["pod-0"]);
      setSelectedKey("z1/pod-1");
      vi.advanceTimersByTime(SETTLE_MS);
      // pod-1's tab is mounted (loading, out of sight); pod-0's stays shown, stepped back.
      expect([slow(), document.querySelectorAll(".d-layer.pending .slow").length, stale()]).toEqual([["pod-0"], 1, true]);
      setLoaded(new Set(["z1/pod-0", "z1/pod-1"]));
      expect([slow(), document.querySelectorAll(".d-layer").length, stale()]).toEqual([["pod-1"], 1, false]);
      // One that never says it is ready shows anyway, after a moment.
      setSelectedKey("z1/pod-2");
      vi.advanceTimersByTime(SETTLE_MS);
      expect(slow()).toEqual(["pod-1"]);
      vi.advanceTimersByTime(READY_WAIT_MS);
      expect(slow()).toEqual([""]);
    } finally {
      registerDetailTab({ id: "slow", title: "Slow", icon: "info", order: -2, when: () => false, component: () => null });
    }
  });

  it("picking another tab while the next object loads: no wait for the tab given up, nothing opened for the object left", () => {
    const quick: string[] = [];
    registerDetailTab({
      id: "slow",
      title: "Slow",
      icon: "info",
      order: -2,
      when: () => true,
      component: (p) => {
        const ready = deferReady();
        createEffect(() => p.row.key === "z1/pod-0" && ready());
        return <div class="slow">{p.row.n}</div>;
      },
    });
    registerDetailTab({
      id: "quick",
      title: "Quick",
      icon: "info",
      order: 50,
      when: () => true,
      component: (p) => {
        quick.push(p.row.key);
        return <div class="quick">{p.row.n}</div>;
      },
    });
    try {
      openDetails("z1/pod-0");
      mount();
      setSelectedKey("z1/pod-1");
      vi.advanceTimersByTime(SETTLE_MS);
      // pod-1's Slow never says it is ready; the user picks Quick meanwhile.
      expect(document.querySelectorAll(".d-layer.pending").length).toBe(1);
      setDetailsTab("quick");
      const shown = () => [...document.querySelectorAll(".d-layer:not(.pending)")].map((l) => l.textContent);
      expect([shown(), quick, stale()]).toEqual([["pod-1"], ["z1/pod-1"], false]);
    } finally {
      for (const id of ["slow", "quick"]) registerDetailTab({ id, title: id, icon: "info", order: 99, when: () => false, component: () => null });
      setDetailsTab("overview");
    }
  });

  it("follows changes of the object it shows, also while the selection is elsewhere, and keeps it when the selection comes back", () => {
    openDetails("z1/pod-0");
    mount();
    feed.setRows(pods.map((r) => (r.key === "z1/pod-0" ? { ...r, rv: "2" } : r)));
    expect(seen).toEqual(["z1/pod-0", "z1/pod-0"]);
    // pod-1 and straight back: nothing opens for pod-1, and pod-0's tab stays as it is.
    setSelectedKey("z1/pod-1");
    vi.advanceTimersByTime(SETTLE_MS / 4);
    expect([probe(), stale()]).toEqual(["pod-0", true]);
    feed.setRows(pods.map((r) => (r.key === "z1/pod-0" ? { ...r, rv: "3", n: "pod-0 (3)" } : r)));
    expect(probe()).toBe("pod-0 (3)");
    setSelectedKey("z1/pod-0");
    expect([probe(), stale()]).toEqual(["pod-0 (3)", false]);
    vi.advanceTimersByTime(SETTLE_MS);
    expect([probe(), mounted]).toEqual(["pod-0 (3)", ["z1/pod-0"]]);
    expect(seen).toEqual(["z1/pod-0", "z1/pod-0", "z1/pod-0"]);
  });

  it("tells an object deleted from one the view no longer lists, and keeps its actions while the view reloads", () => {
    const badges = () => [...document.querySelectorAll(".details .sub .badge")].map((b) => b.textContent);
    const actions = () => document.querySelectorAll(".d-actions button").length;
    openDetails("z1/pod-3");
    mount();
    expect([badges(), actions() > 0]).toEqual([[], true]);

    // Other namespaces picked: everything is listed anew. Until that is done, pod-3 may come back.
    batch(() => {
      feed.setGeneration(1);
      feed.setLoading(true);
      feed.setRows([]);
    });
    expect([title(), badges(), actions() > 0]).toEqual(["pod-3", [], true]);
    // It did not: not deleted, just not in this view.
    batch(() => {
      feed.setLoading(false);
      feed.setRows(pods.filter((r) => r.key !== "z1/pod-3"));
    });
    expect([title(), badges(), actions()]).toEqual(["pod-3", ["not in this view"], 0]);

    // Back in a later view; then deleted from it.
    feed.setGeneration(2);
    feed.setRows(pods);
    expect([badges(), actions() > 0]).toEqual([[], true]);
    feed.setRows(pods.filter((r) => r.key !== "z1/pod-3"));
    expect([title(), badges(), actions()]).toEqual(["pod-3", ["deleted"], 0]);
  });

  it("greys out the actions read-only mode disables, says on hover that read-only mode did it, and clicking them does nothing", async () => {
    noteReadOnlyRefusal();
    openDetails("z1/pod-3");
    mount();
    const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>(".d-actions button")].find((b) => b.textContent === label)!;
    const del = button("Delete…");
    // aria-disabled, not disabled: WebKit shows no tooltip on a disabled control.
    expect([del.disabled, del.getAttribute("aria-disabled"), del.classList.contains("locked")]).toEqual([false, "true", true]);
    expect(del.title).toBe("Delete — off in read-only mode: it changes objects in the cluster. Turn read-only mode off in the status bar (it asks to confirm) to use it.");
    expect(button("Shell").title).toBe("Shell — off in read-only mode: a shell can change anything in the container. Turn read-only mode off in the status bar (it asks to confirm) to use it.");
    expect(button("Copy name").getAttribute("aria-disabled")).toBeNull();
    del.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }));
    expect(dialog()).toBeNull();
    expect(toasts()).toEqual([]);

    await setReadOnly(false);
    expect([button("Delete…").getAttribute("aria-disabled"), button("Delete…").classList.contains("locked"), button("Delete…").title]).toEqual([null, false, expect.stringMatching(/^Delete… \(.+\)$/)]);
    for (const t of toasts()) dismissToast(t.id);
  });

  it("fills the window in full view, where j / k, g / G and Space scroll it", () => {
    openDetails("z1/pod-3");
    mount();
    const panel = document.querySelector<HTMLElement>(".details")!;
    expect([panel.classList.contains("full"), !!panel.querySelector(".resizer")]).toEqual([false, true]);
    // The full view button (f).
    panel.querySelector<HTMLButtonElement>('button[data-hint="f"]')!.click();
    expect([detailsFull(), panel.classList.contains("full"), !!panel.querySelector(".resizer"), panel.style.width]).toEqual([true, true, false, ""]);

    // jsdom does no layout: a body 1000px tall with room for 300px.
    const body = panel.querySelector<HTMLElement>(".d-body")!;
    let top = 0;
    Object.defineProperties(body, {
      scrollTop: { configurable: true, get: () => top, set: (v: number) => (top = Math.max(0, Math.min(700, v))) },
      scrollHeight: { configurable: true, value: 1000 },
      clientHeight: { configurable: true, value: 300 },
    });
    const press = (init: KeyboardEventInit) => document.body.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
    press({ key: "j", code: "KeyJ" });
    press({ key: "j", code: "KeyJ" });
    expect(top).toBe(72);
    press({ key: "k", code: "KeyK" });
    expect(top).toBe(36);
    press({ key: "G", code: "KeyG", shiftKey: true });
    expect(top).toBe(700);
    press({ key: "g", code: "KeyG" });
    press({ key: " ", code: "Space" });
    expect(top).toBe(270);
    // The table's keys do nothing meanwhile: the selection is where it was.
    expect(selectedKey()).toBe("z1/pod-3");

    // Side by side again, the keys are the table's (focus is not in the panel).
    setDetailsFull(false);
    press({ key: "j", code: "KeyJ" });
    expect(top).toBe(270);
  });
});
