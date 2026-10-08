import { render } from "solid-js/web";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { LogMessage, LogSpec, LogTarget } from "../../lib/backend";
import { Tone } from "../../lib/backend";
import { installHotkeys } from "../../lib/hotkeys";
import type { DetailProps } from "../../registry/details";
import { setToasts, toasts } from "../../state/ui";
import type { UIRow } from "../../state/view";
import { LogsTab } from "../LogsTab";
import { hover } from "./LogStrip";
import { budget, timing } from "./LogViewer";
import { setFilterMode, setFold, setPinned, setPretty, setUtc } from "./model";

// The log view as a whole: a pod's stream (the engine is a recorder), what the filters and the keys do to it.
const h = vi.hoisted(() => ({
  streams: [] as { spec: LogSpec; send: (m: LogMessage) => void; updates: LogTarget[][]; closed: boolean }[],
}));

vi.mock("../../state/view", () => ({
  createViewFeed: () => ({ rows: () => [], version: () => 0, statuses: {}, resolved: {}, loading: () => false, columns: () => [], rowByKey: () => undefined }),
}));
vi.mock("../common", async (original) => ({
  ...(await original<typeof import("../common")>()),
  useObject: () => ({ value: () => ({ metadata: { name: "web-1", namespace: "shop" }, spec: { containers: [{ name: "app" }] } }), loading: () => false, error: () => undefined }),
}));
vi.mock("../../lib/backend", async (original) => ({
  ...(await original<typeof import("../../lib/backend")>()),
  backend: () => ({
    streamLogs(spec: LogSpec, onMessage: (m: LogMessage) => void) {
      const s = { spec, send: onMessage, updates: [] as LogTarget[][], closed: false };
      h.streams.push(s);
      return { close: () => (s.closed = true), setTargets: (t: LogTarget[]) => s.updates.push(t) };
    },
  }),
}));

const row: UIRow = { key: "prod-eu-z1/web-1", cl: "prod-eu-z1", u: "uid-1", n: "web-1", ns: "shop", rv: "1", t: 0, s: Tone.Ok, c: [] };

const copied: string[] = [];
const observed = new WeakMap<Element, ResizeObserverCallback[]>();
/** The box is laid out `h` high (0: not shown, a dock tab hidden) and 800 wide; its observers are told. */
const resize = (el: HTMLElement, h: number) => {
  Object.defineProperty(el, "offsetHeight", { configurable: true, value: h });
  Object.defineProperty(el, "offsetWidth", { configurable: true, value: h ? 800 : 0 });
  for (const cb of observed.get(el) ?? []) cb([], undefined as never);
};
beforeAll(() => {
  // Every batch drawn as it comes (but in the tests of the pacing itself), gestures or not.
  timing.showEvery = 0;
  timing.hold = 0;
  // Boxes are measured when a test says so (`resize`): jsdom lays nothing out.
  globalThis.ResizeObserver = class {
    constructor(private readonly cb: ResizeObserverCallback) {}
    observe(el: Element) {
      observed.set(el, [...(observed.get(el) ?? []), this.cb]);
    }
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  HTMLCanvasElement.prototype.getContext = (() => null) as never;
  // The lines' screen: 20 lines high, and it scrolls as a browser's does (jsdom lays nothing out): over the height of
  // what it holds, within it.
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains("logs") ? 360 : 0;
    },
  });
  const tops = new WeakMap<HTMLElement, number>();
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains("logs") ? Math.max(this.clientHeight, Number.parseFloat((this.firstElementChild as HTMLElement | null)?.style.height ?? "") || 0) : 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "scrollTop", {
    configurable: true,
    get(this: HTMLElement) {
      return tops.get(this) ?? 0;
    },
    set(this: HTMLElement, v: number) {
      tops.set(this, Math.max(0, Math.min(v, this.scrollHeight - this.clientHeight)));
    },
  });
  // Sideways: 800 wide, as wide as what the content says (its sizer's min-width, a `ch` being 7 px).
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains("logs") ? 800 : 0;
    },
  });
  const lefts = new WeakMap<HTMLElement, number>();
  const widthOf = (el: HTMLElement) => {
    const m = /calc\((\d+)ch \+ (\d+)px\)/.exec((el.firstElementChild as HTMLElement | null)?.style.minWidth ?? "");
    return m ? Number(m[1]) * 7 + Number(m[2]) : 0;
  };
  Object.defineProperty(HTMLElement.prototype, "scrollWidth", {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains("logs") ? Math.max(this.clientWidth, widthOf(this)) : 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "scrollLeft", {
    configurable: true,
    get(this: HTMLElement) {
      return lefts.get(this) ?? 0;
    },
    set(this: HTMLElement, v: number) {
      lefts.set(this, Math.max(0, Math.min(v, this.scrollWidth - this.clientWidth)));
    },
  });
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: (t: string) => (copied.push(t), Promise.resolve()) } });
  installHotkeys();
});
afterAll(() => {
  delete (HTMLElement.prototype as { clientHeight?: number }).clientHeight;
  delete (HTMLElement.prototype as { scrollHeight?: number }).scrollHeight;
  delete (HTMLElement.prototype as { scrollTop?: number }).scrollTop;
  delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth;
  delete (HTMLElement.prototype as { scrollWidth?: number }).scrollWidth;
  delete (HTMLElement.prototype as { scrollLeft?: number }).scrollLeft;
});

let dispose: (() => void) | undefined;
beforeEach(() => {
  h.streams.length = 0;
  copied.length = 0;
  localStorage.clear();
});
afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.innerHTML = "";
  setFilterMode(true);
  setPretty(true);
  setFold(true);
  setPinned([]);
  setToasts([]);
});

const tick = () => new Promise((r) => setTimeout(r, 0));

/** The view of one pod, inside the details (whose keys it then has: focus is in it). */
async function mount() {
  const root = document.createElement("div");
  root.className = "details";
  document.body.append(root);
  const props: DetailProps = { row, resourceKey: "pods", target: { cluster: "prod-eu-z1", resource: "pods", namespace: "shop", name: "web-1" } };
  dispose = render(() => <LogsTab {...props} />, root);
  await tick();
  const s = h.streams[0];
  s.send({ t: "state", i: 0, state: "streaming" });
  return { root, s };
}

const lines = (root: HTMLElement) => [...root.querySelectorAll(".lines .ln:not(.marker):not(.cont):not(.fold) .txt")].map((e) => e.textContent);
const query = async (root: HTMLElement, text: string) => {
  const input = root.querySelector<HTMLInputElement>(".lq-input")!;
  input.value = text;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await tick();
};
const key = async (root: HTMLElement, k: string, opts: KeyboardEventInit = {}) => {
  root.querySelector<HTMLElement>(".code.logs")!.focus();
  document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, ...opts }));
  await tick();
};

describe("log view", () => {
  it("draws a stream that keeps coming at most ten times a second, its first lines at once", async () => {
    // (However long drawing takes here: exactly every 100 ms.)
    timing.showEvery = 100;
    timing.maxEvery = 100;
    try {
      const { root, s } = await mount();
      s.send({ t: "lines", l: [[0, 1000, "first"]] });
      await tick();
      expect(lines(root)).toEqual(["first"]);
      // Within the 100 ms: they wait (outside the buffer: what it holds is what is drawn)…
      s.send({ t: "lines", l: [[0, 1001, "second"]] });
      s.send({ t: "lines", l: [[0, 1002, "third"]] });
      await tick();
      expect(lines(root)).toEqual(["first"]);
      // …and are drawn together when it is over; a state message brings them in before it.
      await new Promise((r) => setTimeout(r, 120));
      expect(lines(root)).toEqual(["first", "second", "third"]);
      s.send({ t: "lines", l: [[0, 1003, "fourth"]] });
      s.send({ t: "state", i: 0, state: "ended", message: "container terminated: Completed (exit code 0)" });
      await tick();
      expect(lines(root)).toEqual(["first", "second", "third", "fourth"]);
    } finally {
      timing.showEvery = 0;
      timing.maxEvery = 1000;
    }
  });

  it("filters by words, exclusions and fields, and finds instead when asked", async () => {
    const { root, s } = await mount();
    s.send({
      t: "lines",
      l: [
        [0, 1000, "GET /healthz 200"],
        [0, 2000, "GET /api/orders 200"],
        [0, 3000, '{"level":"error","msg":"payment failed","status":503}'],
        [0, 4000, "POST /api/orders 500"],
      ],
    });
    await tick();
    await query(root, "!healthz /orders \\d+/");
    expect(lines(root)).toEqual(["GET /api/orders 200", "POST /api/orders 500"]);
    expect(root.querySelector(".logv-filtered")!.textContent).toContain("Showing 2 of 4");
    await query(root, "status>=500");
    expect(lines(root)).toHaveLength(1);
    expect(root.querySelector(".lines .ln .txt")!.textContent).toContain("payment failed");

    // Finding: every line stays, the matches are marked, N goes from one to the next.
    setFilterMode(false);
    await query(root, "orders");
    expect(lines(root)).toHaveLength(4);
    expect([...root.querySelectorAll(".lines mark")].map((m) => m.textContent)).toEqual(["orders", "orders"]);
    expect(root.querySelector(".lq-count")!.textContent).toBe("2 found");
    await key(root, "n");
    expect(root.querySelector(".lines .ln.sel .txt")!.textContent).toBe("GET /api/orders 200");
    expect(root.querySelector(".lq-count")!.textContent).toBe("1 of 2");
    await key(root, "n");
    expect(root.querySelector(".lines .ln.sel .txt")!.textContent).toBe("POST /api/orders 500");
    await key(root, "N", { shiftKey: true });
    expect(root.querySelector(".lines .ln.sel .txt")!.textContent).toBe("GET /api/orders 200");
  });

  it("counts lines per level and hides a level at a click", async () => {
    const { root, s } = await mount();
    s.send({
      t: "lines",
      l: [
        [0, 1000, "INFO a"],
        [0, 2000, "ERROR b"],
        [0, 3000, "WARN c"],
        [0, 4000, "ERROR d"],
      ],
    });
    await new Promise((r) => setTimeout(r, 300));
    const chips = () => [...root.querySelectorAll<HTMLButtonElement>(".lchip")];
    expect(chips().map((c) => c.textContent)).toEqual(["2 errors", "1 warning", "1 info"]);
    chips()[2].click();
    await tick();
    expect(lines(root)).toEqual(["ERROR b", "WARN c", "ERROR d"]);
    // ⇧-click: that level alone.
    chips()[0].dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true }));
    await tick();
    expect(lines(root)).toEqual(["ERROR b", "ERROR d"]);
  });

  it("counts the levels again a few times a second, not for every batch", async () => {
    const { root, s } = await mount();
    const chips = () => [...root.querySelectorAll(".lchip")].map((c) => c.textContent);
    s.send({ t: "lines", l: [[0, 1000, "ERROR a"]] });
    await new Promise((r) => setTimeout(r, 300));
    expect(chips()).toEqual(["1 error"]);
    s.send({ t: "lines", l: [[0, 2000, "ERROR b"], [0, 3000, "WARN c"]] });
    expect(chips()).toEqual(["1 error"]);
    await new Promise((r) => setTimeout(r, 300));
    expect(chips()).toEqual(["2 errors", "1 warning"]);
  });

  it("marks in the timeline where a container terminated and where it ran again", async () => {
    const { root, s } = await mount();
    s.send({ t: "lines", l: [[0, Date.now() - 5000, "working"]] });
    s.send({ t: "state", i: 0, state: "ended", message: "container terminated: OOMKilled (exit code 137)" });
    s.send({ t: "state", i: 0, state: "waiting", message: "container terminated: OOMKilled (exit code 137), waiting to restart (CrashLoopBackOff)" });
    s.send({ t: "state", i: 0, state: "streaming" });
    await tick();
    const marks = [...root.querySelectorAll(".lines .ln.marker")];
    expect(marks.map((m) => m.querySelector(".txt")!.textContent?.trim())).toEqual(["container terminated: OOMKilled (exit code 137)", "container terminated: OOMKilled (exit code 137), waiting to restart (CrashLoopBackOff)", "running again"]);
    expect(marks[0].classList.contains("lvl-5")).toBe(true);
  });

  it("shows structured lines as level, message and fields; a value clicked filters by it", async () => {
    const { root, s } = await mount();
    s.send({
      t: "lines",
      l: [
        [0, 1000, '{"level":"warn","msg":"slow commit","trace_id":"abc123","latency_ms":2205}'],
        [0, 2000, '{"level":"info","msg":"entry posted","trace_id":"def456","latency_ms":12}'],
      ],
    });
    await tick();
    const first = root.querySelector(".lines .ln")!;
    expect(first.querySelector(".tag")!.textContent).toBe("WARN");
    expect(first.querySelector(".txt")!.textContent).toBe("slow commit  trace_id=abc123  latency_ms=2205");
    first.querySelector<HTMLElement>(".f-trace")!.click();
    await tick();
    const follow = [...document.querySelectorAll<HTMLButtonElement>(".menu .opt")].find((b) => b.textContent?.includes("across pods"))!;
    follow.click();
    await tick();
    expect(root.querySelector<HTMLInputElement>(".lq-input")!.value).toBe("trace_id=abc123");
    expect(lines(root)).toHaveLength(1);
    // As written: the raw line.
    setPretty(false);
    await tick();
    expect(root.querySelector(".lines .ln .txt")!.textContent).toBe('{"level":"warn","msg":"slow commit","trace_id":"abc123","latency_ms":2205}');
  });

  it("adds a value clicked to the query: one more left out, one more wanted", async () => {
    const { root, s } = await mount();
    const paths = ["/healthz", "/metrics", "/api/orders", "/api/users"];
    s.send({ t: "lines", l: paths.map((p, k): [number, number, string] => [0, 1000 + k, `{"level":"info","msg":"request","path":"${p}"}`]) });
    await tick();
    const pick = async (path: string, option: string) => {
      const line = [...root.querySelectorAll(".lines .ln")].find((l) => l.querySelector(".txt")?.textContent === `request  path=${path}`)!;
      line.querySelector<HTMLElement>(".f-click")!.click();
      await tick();
      [...document.querySelectorAll<HTMLButtonElement>(".menu .opt")].find((b) => b.textContent?.includes(option))!.click();
      await tick();
    };
    const input = root.querySelector<HTMLInputElement>(".lq-input")!;
    await pick("/healthz", "Leave out");
    await pick("/metrics", "Leave out");
    expect(input.value).toBe("!path=/healthz,/metrics");
    expect(lines(root)).toEqual(["request  path=/api/orders", "request  path=/api/users"]);
    // Finding (every line stays): a value wanted is one more of those the query wants.
    setFilterMode(false);
    await query(root, "path=/api/orders");
    await pick("/api/users", "Show lines with this value");
    expect(input.value).toBe("path=/api/orders,/api/users");
    expect(lines(root)).toEqual(["request  path=/api/orders", "request  path=/api/users"]);
  });

  it("keeps the lines a filter shows when the view is full: they pile up, the rest makes room", async () => {
    const was = { ...budget };
    budget.lines = 100;
    try {
      const { root, s } = await mount();
      await query(root, "error");
      for (let k = 0; k < 6; k++) {
        s.send({ t: "lines", l: Array.from({ length: 50 }, (_, j): [number, number, string] => [0, 1000 + k * 50 + j, (k * 50 + j) % 10 ? `line ${k * 50 + j}` : `ERROR ${k * 50 + j}`]) });
        await tick();
      }
      const header = () => root.querySelector(".logv-filtered")!.textContent;
      const note = () => root.querySelector(".ln-note")!.textContent;
      // All 30 errors, though the view holds 100 lines.
      expect(header()).toMatch(/Showing 30 of \d+/);
      expect(note()).toMatch(/^… \d+ earlier lines dropped, \d+ that a filter showed were kept/);
      const el = root.querySelector<HTMLElement>(".code.logs")!;
      el.dispatchEvent(new Event("wheel"));
      el.scrollTop = 0;
      el.dispatchEvent(new Event("scroll"));
      await tick();
      expect(lines(root).slice(0, 3)).toEqual(["ERROR 0", "ERROR 10", "ERROR 20"]);
      // Unfiltered: the latest lines, as before; the kept ones wait for a filter.
      await query(root, "");
      expect(note()).toMatch(/; \d+ of them that a filter showed are kept, shown while filtering$/);
      expect(lines(root)).not.toContain("ERROR 0");
      await query(root, "error");
      expect(header()).toMatch(/Showing 30 of/);
    } finally {
      Object.assign(budget, was);
    }
  });

  it("pauses: what comes meanwhile waits, and is counted", async () => {
    const { root, s } = await mount();
    s.send({ t: "lines", l: [[0, 1000, "before"]] });
    await tick();
    await key(root, "s");
    s.send({ t: "lines", l: [[0, 2000, "during 1"], [0, 3000, "during 2"]] });
    await tick();
    expect(lines(root)).toEqual(["before"]);
    expect(root.querySelector(".follow-btn")!.textContent).toContain("Resume · 2 new");
    await key(root, "s");
    expect(lines(root)).toEqual(["before", "during 1", "during 2"]);
  });

  it("counts the lines by pattern in rows that stay as lines come: a click on one lands", async () => {
    const { root, s } = await mount();
    const at = Date.now() - 60_000;
    const get = (k: number): [number, number, string] => [0, at + k, `GET /api/orders/${k} 200`];
    s.send({ t: "lines", l: [get(1), get(2), [0, at + 3, "ERROR payment 77 failed"]] });
    await tick();
    root.querySelector<HTMLButtonElement>(".seg button:nth-child(2)")!.click();
    await tick();
    const rows = () => [...root.querySelectorAll<HTMLElement>(".lpat-row")];
    const listed = () => rows().map((r) => `${r.querySelector(".lpat-count b")!.textContent} ${r.querySelector(".lpat-text")!.textContent}`);
    expect(listed()).toEqual(["2 GET /api/orders/<*>", "1 ERROR payment <*> failed"]);
    const [row, other] = rows();
    const text = row.querySelector<HTMLElement>(".lpat-text")!;

    // More lines (of these patterns, of a new one): counted in the same rows, a new row for the new pattern.
    s.send({ t: "lines", l: [get(4), get(5), get(6), [0, at + 7, "WARN slow commit 2205ms"]] });
    await new Promise((r) => setTimeout(r, 450));
    expect(listed()).toEqual(["5 GET /api/orders/<*>", "1 ERROR payment <*> failed", "1 WARN slow commit <*>"]);
    expect(rows()[0]).toBe(row);
    expect(rows()[1]).toBe(other);
    expect(text.isConnected).toBe(true);

    // Paused: the patterns stay as they were; resumed, what came meanwhile is counted at once.
    const pause = root.querySelector<HTMLButtonElement>('.logv-bar [data-hint="s"]')!;
    pause.click();
    s.send({ t: "lines", l: [get(8), get(9)] });
    await new Promise((r) => setTimeout(r, 450));
    expect(listed()[0]).toBe("5 GET /api/orders/<*>");
    pause.click();
    await tick();
    expect(listed()[0]).toBe("7 GET /api/orders/<*>");
    expect(rows()[0]).toBe(row);

    // A row pressed does not move (nor change) until it is released: the click lands on it.
    const order = root.querySelector<HTMLSelectElement>(".lpat-head select")!;
    order.value = "recent";
    order.dispatchEvent(new Event("change", { bubbles: true }));
    await tick();
    expect(listed()).toEqual(["7 GET /api/orders/<*>", "1 WARN slow commit <*>", "1 ERROR payment <*> failed"]);
    const pressed = rows()[2].querySelector<HTMLElement>(".lpat-text")!;
    pressed.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
    s.send({ t: "lines", l: [[0, at + 10, "ERROR payment 78 failed"]] });
    await new Promise((r) => setTimeout(r, 450));
    expect(listed()).toEqual(["7 GET /api/orders/<*>", "1 WARN slow commit <*>", "1 ERROR payment <*> failed"]);
    pressed.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, button: 0 }));
    await new Promise((r) => setTimeout(r, 450));
    expect(listed()).toEqual(["2 ERROR payment <*> failed", "7 GET /api/orders/<*>", "1 WARN slow commit <*>"]);
    expect(pressed.isConnected).toBe(true);

    // Its text clicked: the lines of that pattern alone.
    text.click();
    await tick();
    expect(lines(root)).toEqual([1, 2, 4, 5, 6, 8, 9].map((k) => `GET /api/orders/${k} 200`));
  });

  it("shows a pattern at the level its lines have now: a stack trace's frame that came later makes it an error", async () => {
    const { root, s } = await mount();
    s.send({ t: "lines", l: [[0, 1000, "payment failed for order 42"]] });
    await tick();
    root.querySelector<HTMLButtonElement>(".seg button:nth-child(2)")!.click();
    await tick();
    const rows = () => [...root.querySelectorAll(".lpat-row")].map((r) => `${r.querySelector(".lpat-lvl")!.textContent} ${r.querySelector(".lpat-text")!.textContent}`);
    expect(rows()).toEqual(["· payment failed for order <*>"]);
    s.send({ t: "lines", l: [[0, 1001, "\tat com.acme.Orders.place(Orders.java:42)"]] });
    await new Promise((r) => setTimeout(r, 450));
    expect(rows()).toEqual(["ERROR payment failed for order <*>"]);
  });

  it("moves a cursor over the lines with the keys, picks several with ⇧ and copies them", async () => {
    const { root, s } = await mount();
    s.send({ t: "lines", l: Array.from({ length: 60 }, (_, k): [number, number, string] => [0, 1000 + k, `line ${k}`]) });
    await tick();
    const el = root.querySelector<HTMLElement>(".code.logs")!;
    const cursor = () => root.querySelector(".lines .ln.sel .txt")?.textContent;
    // It follows new lines (the screen is at the bottom): scrolled up to the first ones.
    el.dispatchEvent(new Event("wheel"));
    el.scrollTop = 0;
    el.dispatchEvent(new Event("scroll"));
    await tick();
    // Down: from the first line on screen; up from the last (the screen holds 20).
    await key(root, "j");
    expect(cursor()).toBe("line 0");
    await key(root, "ArrowDown");
    await key(root, "j");
    expect(cursor()).toBe("line 2");
    await key(root, "k");
    expect(cursor()).toBe("line 1");
    await key(root, "Escape");
    expect(cursor()).toBeUndefined();
    await key(root, "k");
    expect(cursor()).toBe("line 19");
    // Past the screen's edge: scrolled as little as it takes.
    await key(root, "j");
    expect(cursor()).toBe("line 20");
    expect(el.scrollTop).toBe(18);
    // ⇧: the lines on the way are picked; C copies them.
    await key(root, "J", { shiftKey: true });
    await key(root, "ArrowDown", { shiftKey: true });
    expect([...root.querySelectorAll(".lines .ln.inspan .txt")].map((e) => e.textContent)).toEqual(["line 20", "line 21", "line 22"]);
    await key(root, "c");
    expect(copied.at(-1)!.trimEnd().split("\n").map((l) => l.slice(l.indexOf("line ")))).toEqual(["line 20", "line 21", "line 22"]);
    expect(toasts().at(-1)).toMatchObject({ kind: "success", title: "Copied 3 entries" });
    // Esc: the lines picked, then the cursor; ⇧G follows new lines again.
    await key(root, "Escape");
    expect(root.querySelectorAll(".lines .ln.inspan")).toHaveLength(0);
    expect(cursor()).toBe("line 22");
    await key(root, "G", { shiftKey: true });
    expect(cursor()).toBeUndefined();
    expect(root.querySelector(".follow-btn")).toBeNull();
  });

  it("reads earlier lines in place once scrolled up to the top; the stream goes on", async () => {
    let clock = Date.now();
    const now = vi.spyOn(Date, "now").mockImplementation(() => clock);
    try {
      const { root, s } = await mount();
      // The history read at the start: as many lines as asked for, there may be more.
      const start = clock - 3_600_000;
      s.send({ t: "lines", l: Array.from({ length: 1000 }, (_, k): [number, number, string] => [0, start + k * 1000, `old ${k}`]) });
      clock += 4000;
      s.send({ t: "lines", l: [[0, clock, "live"]] });
      await tick();
      expect(root.querySelector(".ln-earlier")!.textContent).toContain("Load earlier lines");
      const el = root.querySelector<HTMLElement>(".code.logs")!;
      const scroll = (top: number, user: boolean) => {
        if (user) el.dispatchEvent(new Event("wheel"));
        el.scrollTop = top;
        el.dispatchEvent(new Event("scroll"));
      };
      // Content that shrank under the screen (a filter) is not scrolling up.
      scroll(200, false);
      scroll(0, false);
      await tick();
      expect(h.streams).toHaveLength(1);
      scroll(200, true);
      scroll(0, true);
      await tick();
      expect(root.querySelector(".ln-earlier")!.textContent).toContain("Reading earlier lines");
      const read = h.streams[1];
      expect(read.spec).toMatchObject({ follow: false, previous: false });
      // The lines held, 5,000 earlier ones and a margin for lines in flight — up to the first line held.
      expect(read.spec.targets).toEqual([{ cluster: "prod-eu-z1", namespace: "shop", pod: "web-1", uid: "uid-1", container: "app", id: 0, tailLines: 1001 + 5000 + 100, until: start }]);
      read.send({ t: "lines", l: [[0, start - 5000, "earlier 1"], [0, start - 4000, "earlier 2"]] });
      read.send({ t: "state", i: 0, state: "ended" });
      await tick();
      expect(lines(root).slice(0, 3)).toEqual(["earlier 1", "earlier 2", "old 0"]);
      // Fewer than asked for: the beginning of its log (the pod never restarted).
      expect(root.querySelector(".ln-earlier")!.textContent).toContain("Beginning of the log");
      expect(h.streams[0].closed).toBe(false);
    } finally {
      now.mockRestore();
    }
  });

  it("suggests fields as their names are typed, then their values; Enter takes the one highlighted", async () => {
    const { root, s } = await mount();
    s.send({
      t: "lines",
      l: [
        [0, 1000, '{"level":"warn","msg":"slow commit","trace_id":"abc123","latency_ms":2205}'],
        [0, 2000, '{"level":"info","msg":"entry posted","trace_id":"def456","latency_ms":12}'],
        [0, 3000, '{"level":"error","msg":"posting rejected","trace_id":"abc123","latency_ms":40}'],
      ],
    });
    await tick();
    const input = root.querySelector<HTMLInputElement>(".lq-input")!;
    input.focus();
    // (Typing is in the field: Enter that applies the query leaves it.)
    const type = async (text: string) => {
      input.focus();
      input.value = text;
      input.setSelectionRange(text.length, text.length);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await tick();
    };
    const press = async (k: string, opts: KeyboardEventInit = {}) => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, ...opts }));
      await tick();
    };
    const offered = () => [...root.querySelectorAll(".lq-sg .opt .lq-sg-text")].map((e) => e.textContent);
    const highlighted = () => root.querySelector(".lq-sg .opt.hl .lq-sg-text")?.textContent;
    // The best match of what is typed is highlighted: Enter takes it.
    await type("tra");
    expect(offered()).toEqual(["trace_id"]);
    expect(highlighted()).toBe("trace_id");
    await press("Enter");
    expect(input.value).toBe("trace_id:");
    // Its values, the most common first — none highlighted yet: Enter applies the query (lines with the field).
    expect(offered()).toEqual(["abc123", "def456"]);
    expect(highlighted()).toBeUndefined();
    await press("Enter");
    expect(input.value).toBe("trace_id:");
    expect(root.querySelector(".lq-sg")).toBeNull();
    expect(document.activeElement).not.toBe(input);
    expect(lines(root)).toHaveLength(3);
    // Typed: the first that matches; picked with the keys: that one.
    await type("trace_id:d");
    expect(highlighted()).toBe("def456");
    await press("Enter");
    expect(input.value).toBe("trace_id:def456 ");
    expect(root.querySelector(".lq-sg")).toBeNull();
    expect(lines(root)).toHaveLength(1);
    await type("trace_id:");
    await press("ArrowDown");
    await press("ArrowDown");
    expect(highlighted()).toBe("def456");
    await press("Tab");
    expect(input.value).toBe("trace_id:def456 ");
    // Levels, from the worst; a number compared: where its values are.
    await type("level:");
    expect(offered()).toEqual(["error", "warn", "info"]);
    await type("latency_ms>");
    expect([...root.querySelectorAll(".lq-sg .opt")].map((o) => o.textContent)).toEqual(["40median", "2205p90", "12min"]);
    // Esc closes them, what is typed stays; a value typed whole is not suggested, nor are plain words.
    await type("level:er");
    await press("Escape");
    expect(root.querySelector(".lq-sg")).toBeNull();
    expect(input.value).toBe("level:er");
    await type("trace_id:abc123");
    expect(root.querySelector(".lq-sg")).toBeNull();
    await type("timeout");
    expect(root.querySelector(".lq-sg")).toBeNull();
  });

  it("copies a field's value, from its menu or the line's details, and the line as JSON, and says what it copied", async () => {
    const { root, s } = await mount();
    s.send({ t: "lines", l: [[0, 1000, '{"level":"warn","msg":"slow commit","trace_id":"abc123","latency_ms":2205}']] });
    await tick();
    const click = async (el: Element | null | undefined) => {
      (el as HTMLElement).click();
      await tick();
    };
    const byText = (sel: string, text: string) => [...document.querySelectorAll(sel)].find((b) => b.textContent?.trim() === text);
    await click(root.querySelector(".lines .ln .f-trace"));
    await click(byText(".menu .opt", "Copy the value"));
    expect(copied).toEqual(["abc123"]);
    expect(toasts().at(-1)).toMatchObject({ kind: "success", title: "Copied trace_id", detail: "abc123" });
    await click(root.querySelector(".lines .ln .ln-x"));
    const latency = [...root.querySelectorAll(".ld-field")].find((f) => f.querySelector(".ld-key")?.textContent === "latency_ms");
    await click(latency?.querySelector('button[title="Copy the value"]'));
    expect([copied.at(-1), toasts().at(-1)?.title, toasts().at(-1)?.detail]).toEqual(["2205", "Copied latency_ms", "2205"]);
    await click(byText(".ld-actions button", "Copy JSON"));
    expect(JSON.parse(copied.at(-1)!)).toEqual({ level: "warn", msg: "slow commit", trace_id: "abc123", latency_ms: 2205 });
    expect(toasts().at(-1)).toMatchObject({ kind: "success", title: "Copied JSON", detail: undefined });
  });

  it("folds a long stack trace into its first lines, and unfolds it", async () => {
    const { root, s } = await mount();
    const frames = Array.from({ length: 30 }, (_, k) => `\tat com.acme.F${k}.run(F.java:${k})`);
    s.send({ t: "lines", l: [[0, 1000, "ERROR boom"], [0, 1000, "java.lang.IllegalStateException: x"], ...frames.map((f): [number, number, string] => [0, 1001, f])] });
    await tick();
    expect(root.querySelectorAll(".lines .ln.cont")).toHaveLength(6);
    const fold = root.querySelector<HTMLElement>(".lines .ln.fold")!;
    expect(fold.textContent).toContain("25 more lines");
    fold.click();
    await tick();
    expect(root.querySelectorAll(".lines .ln.cont")).toHaveLength(31);
  });
});

describe("log view under a flood of lines", () => {
  let clock = 1000;
  const batchOf = (n: number, text = (k: number) => `line ${k}`): [number, number, string][] => Array.from({ length: n }, () => [0, ++clock, text(clock)]);
  const scroller = (root: HTMLElement) => root.querySelector<HTMLElement>(".code.logs")!;
  /** The line drawn at the top of the screen. */
  const atTop = (root: HTMLElement) => {
    const el = scroller(root);
    const box = el.querySelector<HTMLElement>(".lines")!;
    const y = Number(/translateY\(([\d.]+)px\)/.exec(box.style.transform)![1]);
    const rows = [...box.querySelectorAll<HTMLElement>(":scope > .ln")];
    return rows[Math.floor((el.scrollTop - y) / 18)];
  };
  /** The user scrolls: a wheel, the box moves, its scroll event comes. */
  const scrollTo = (el: HTMLElement, top: number) => {
    el.dispatchEvent(new WheelEvent("wheel", { deltaY: top < el.scrollTop ? -100 : 100, bubbles: true }));
    el.scrollTop = top;
    el.dispatchEvent(new Event("scroll"));
  };

  it("stops following on a wheel up before lines that come can pull the view back down", async () => {
    const { root, s } = await mount();
    s.send({ t: "lines", l: batchOf(200) });
    await tick();
    const el = scroller(root);
    const bottom = el.scrollTop;
    expect(bottom).toBe(el.scrollHeight - 360);
    // The box moved up (scrolling runs ahead of the page); its scroll event has not come yet when lines do.
    el.dispatchEvent(new WheelEvent("wheel", { deltaY: -120, bubbles: true }));
    el.scrollTop = bottom - 120;
    s.send({ t: "lines", l: batchOf(5) });
    await tick();
    expect(el.scrollTop).toBe(bottom - 120);
    el.dispatchEvent(new Event("scroll"));
    await tick();
    expect(el.scrollTop).toBe(bottom - 120);
    expect(root.querySelector(".follow-btn")).not.toBeNull();
  });

  it("keeps the place read when lines come, also before the view was told it scrolled", async () => {
    const { root, s } = await mount();
    s.send({ t: "lines", l: batchOf(400) });
    await tick();
    const el = scroller(root);
    scrollTo(el, 2000);
    await tick();
    expect(root.querySelector(".follow-btn")).not.toBeNull();
    const writes: number[] = [];
    const desc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollTop")!;
    Object.defineProperty(el, "scrollTop", { configurable: true, get: () => desc.get!.call(el), set: (v: number) => (writes.push(v), desc.set!.call(el, v)) });
    // On to 2300 (no scroll event yet), then lines at the end: nothing scrolls the view back.
    el.dispatchEvent(new WheelEvent("wheel", { deltaY: -100, bubbles: true }));
    desc.set!.call(el, 2300);
    s.send({ t: "lines", l: batchOf(3) });
    await tick();
    expect(el.scrollTop).toBe(2300);
    expect(writes).toEqual([]);
  });

  it("stays put while paused", async () => {
    const { root, s } = await mount();
    s.send({ t: "lines", l: batchOf(200) });
    await tick();
    await key(root, "s");
    const el = scroller(root);
    scrollTo(el, 100);
    await tick();
    const row = atTop(root);
    s.send({ t: "lines", l: batchOf(50) });
    await tick();
    expect(el.scrollTop).toBe(100);
    expect(atTop(root)).toBe(row);
    // Resumed: at the bottom, following.
    await key(root, "s");
    expect(el.scrollTop).toBe(el.scrollHeight - 360);
  });

  it("keeps what is read on screen, with its rows, as the oldest lines are dropped", async () => {
    const was = { ...budget };
    budget.lines = 300;
    try {
      const { root, s } = await mount();
      s.send({ t: "lines", l: batchOf(250) });
      await tick();
      const el = scroller(root);
      scrollTo(el, 100 * 18);
      await tick();
      const row = atTop(root);
      const text = row.textContent;
      // Past the budget: lines before what is drawn go, the screen moves with what it shows.
      s.send({ t: "lines", l: batchOf(80) });
      await tick();
      expect(root.querySelector(".ln-note")!.textContent).toMatch(/^… \d+ earlier lines dropped/);
      expect(row.isConnected).toBe(true);
      expect(atTop(root)).toBe(row);
      expect(atTop(root).textContent).toBe(text);
      // Held up to one and a half times the budget; beyond it, the line read goes too, and the view stays on lines.
      for (let k = 0; k < 10; k++) s.send({ t: "lines", l: batchOf(40) });
      await tick();
      expect(lines(root).length).toBeGreaterThan(0);
      expect(root.querySelector(".logv-empty")).toBeNull();
    } finally {
      Object.assign(budget, was);
    }
  });

  it("keeps the lines on screen while paused, and says how many it could not keep", async () => {
    const was = { ...budget };
    budget.lines = 300;
    try {
      const { root, s } = await mount();
      s.send({ t: "lines", l: batchOf(200) });
      await tick();
      await key(root, "s");
      const shown = lines(root);
      for (let k = 0; k < 10; k++) s.send({ t: "lines", l: batchOf(50) });
      await tick();
      expect(lines(root)).toEqual(shown);
      await key(root, "s");
      expect(root.querySelector(".lines .ln.marker")!.textContent).toMatch(/[\d,]+ lines not kept while paused/);
    } finally {
      Object.assign(budget, was);
    }
  });

  it("draws the beginning of a huge line, more of it as the view scrolls sideways, and copies all of it", async () => {
    const { root, s } = await mount();
    const huge = `start ${"x".repeat(10_000)} end`;
    s.send({ t: "lines", l: [[0, 1000, "short line"], [0, 1001, huge]] });
    await tick();
    const el = scroller(root);
    const txt = () => root.querySelectorAll<HTMLElement>(".lines .ln .txt")[1];
    expect(txt().classList.contains("cut")).toBe(true);
    expect(txt().textContent!.length).toBeLessThan(600);
    expect(huge.startsWith(txt().textContent!)).toBe(true);
    // Short lines are drawn whole, as they were.
    expect(root.querySelector(".lines .ln .txt")!.textContent).toBe("short line");
    expect(root.querySelector(".lines .ln .txt")!.querySelector(".blk")).toBeNull();
    // As wide as the line: scrolled sideways, more of it is drawn after what was (the same nodes).
    const width = el.scrollWidth;
    expect(width).toBeGreaterThan(10_000 * 7);
    const first = txt().querySelector(".blk");
    el.scrollLeft = 3000;
    el.dispatchEvent(new Event("scroll"));
    await tick();
    expect(txt().textContent!.length).toBeGreaterThan(3000 / 7);
    expect(txt().querySelector(".blk")).toBe(first);
    // Lines that come do not make it narrower, nor move it back.
    s.send({ t: "lines", l: batchOf(30) });
    await tick();
    expect(el.scrollWidth).toBe(width);
    expect(el.scrollLeft).toBe(3000);
    // Selected from its 6th character on: the copy is the rest of the line, not just what is drawn.
    const range = document.createRange();
    const start = txt().querySelector(".blk")!.firstChild!;
    range.setStart(start.nodeType === 3 ? start : start.firstChild!, 6);
    range.setEnd(txt(), txt().childNodes.length);
    getSelection()!.removeAllRanges();
    getSelection()!.addRange(range);
    const data = new Map<string, string>();
    const copy = new Event("copy", { bubbles: true, cancelable: true });
    Object.defineProperty(copy, "clipboardData", { value: { setData: (k: string, v: string) => data.set(k, v) } });
    txt().dispatchEvent(copy);
    expect(copy.defaultPrevented).toBe(true);
    expect(data.get("text/plain")).toBe(huge.slice(6));
    getSelection()!.removeAllRanges();
  });

  it("listens to the wheel without being passive (a wheel up is handled before the view moves)", async () => {
    const add = vi.spyOn(HTMLElement.prototype, "addEventListener");
    try {
      await mount();
      expect(add.mock.calls.some(([type, , opts]) => type === "wheel" && typeof opts === "object" && opts.passive === false)).toBe(true);
    } finally {
      add.mockRestore();
    }
  });

  it("holds lines back while the user scrolls what they read, and shows them once the gesture ends", async () => {
    timing.hold = 1000;
    try {
      const { root, s } = await mount();
      s.send({ t: "lines", l: batchOf(200) });
      await tick();
      const el = scroller(root);
      scrollTo(el, 1000);
      await tick();
      const height = el.scrollHeight;
      // Still scrolling: the lines wait (the content does not change under the gesture)…
      el.dispatchEvent(new WheelEvent("wheel", { deltaY: 100, bubbles: true }));
      s.send({ t: "lines", l: batchOf(5, (k) => `late ${k}`) });
      await tick();
      expect(el.scrollHeight).toBe(height);
      // …and come in once it ended.
      await new Promise((r) => setTimeout(r, 250));
      expect(el.scrollHeight).toBe(height + 5 * 18);
      expect(el.scrollTop).toBe(1000);
    } finally {
      timing.hold = 0;
    }
  });

  it("keeps following when a wheel up cannot scroll (all the lines fit)", async () => {
    const { root, s } = await mount();
    s.send({ t: "lines", l: batchOf(5) });
    await tick();
    const el = scroller(root);
    el.dispatchEvent(new WheelEvent("wheel", { deltaY: -40, bubbles: true }));
    s.send({ t: "lines", l: batchOf(60) });
    await tick();
    expect(root.querySelector(".follow-btn")).toBeNull();
    expect(el.scrollTop).toBe(el.scrollHeight - 360);
  });

  it("holds what a hidden view shows (a dock tab not shown) as lines keep coming", async () => {
    const was = { ...budget };
    budget.lines = 300;
    try {
      const { root, s } = await mount();
      const el = scroller(root);
      resize(el, 360);
      s.send({ t: "lines", l: batchOf(200) });
      await tick();
      // Read in the middle, then the tab is hidden: nothing is drawn meanwhile.
      scrollTo(el, 1800);
      await tick();
      const read = atTop(root).textContent;
      resize(el, 0);
      await tick();
      expect(root.querySelectorAll(".lines .ln")).toHaveLength(0);
      for (let k = 0; k < 6; k++) s.send({ t: "lines", l: batchOf(20) });
      await tick();
      // Shown again: the same line on top, as if it had been on screen all along.
      resize(el, 360);
      await tick();
      expect(atTop(root).textContent).toBe(read);
      // Paused and hidden: the lines on screen stay, those beyond the room are counted.
      await key(root, "s");
      const paused = atTop(root).textContent;
      resize(el, 0);
      for (let k = 0; k < 20; k++) s.send({ t: "lines", l: batchOf(20) });
      await tick();
      resize(el, 360);
      await tick();
      expect(atTop(root).textContent).toBe(paused);
      expect(root.querySelector(".logv-empty")).toBeNull();
      await key(root, "s");
      expect(root.querySelector(".lines .ln.marker")?.textContent).toMatch(/lines not kept while paused/);
    } finally {
      Object.assign(budget, was);
    }
  });

  it("reads earlier lines when a page up reaches the top", async () => {
    let now = Date.now();
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      const { root, s } = await mount();
      const start = now - 3_600_000;
      s.send({ t: "lines", l: Array.from({ length: 1000 }, (_, k): [number, number, string] => [0, start + k * 1000, `old ${k}`]) });
      now += 4000;
      s.send({ t: "lines", l: [[0, now, "live"]] });
      await tick();
      expect(root.querySelector(".ln-earlier")!.textContent).toContain("Load earlier lines");
      const el = scroller(root);
      scrollTo(el, 300);
      await tick();
      await key(root, "PageUp");
      expect(el.scrollTop).toBe(0);
      expect(h.streams).toHaveLength(2);
    } finally {
      clock.mockRestore();
    }
  });

  it("says so when more came than it keeps, even of the lines being read", async () => {
    const was = { ...budget };
    budget.lines = 300;
    try {
      const { root, s } = await mount();
      s.send({ t: "lines", l: batchOf(250) });
      await tick();
      const el = scroller(root);
      scrollTo(el, 20 * 18);
      await tick();
      for (let k = 0; k < 10; k++) s.send({ t: "lines", l: batchOf(40) });
      await tick();
      expect(root.querySelector(".ln-note")!.textContent).toMatch(/the lines you were reading were dropped/);
      expect(el.scrollTop).toBe(0);
      expect(lines(root).length).toBeGreaterThan(0);
    } finally {
      Object.assign(budget, was);
    }
  });

  it("is no wider than the screen when its lines fit", async () => {
    const { root, s } = await mount();
    s.send({ t: "lines", l: batchOf(30) });
    await tick();
    const el = scroller(root);
    expect(el.scrollWidth).toBe(el.clientWidth);
  });
});

describe("log histogram", () => {
  beforeAll(() => setUtc(true));
  afterAll(() => setUtc(false));
  /** Lines counted again (a pass, every 250 ms at most). */
  const pass = () => new Promise((r) => setTimeout(r, 300));
  const frame = () => new Promise((r) => requestAnimationFrame(() => r(undefined)));
  /** The strip laid out `w` px wide at the window's left edge (bars of 5 px: 120 at 600 px). */
  const widen = (box: HTMLElement, w: number) => {
    Object.defineProperty(box, "clientWidth", { configurable: true, value: w });
    box.getBoundingClientRect = () => ({ left: 0, top: 0, right: w, bottom: 46, width: w, height: 46, x: 0, y: 0, toJSON: () => ({}) });
    resize(box, 46);
  };
  const strip = (root: HTMLElement, w = 600) => {
    const box = root.querySelector<HTMLElement>(".lhist")!;
    widen(box, w);
    return box;
  };
  /** The log view laid out `h` high (0: a dock tab not shown). */
  const tall = (view: HTMLElement, h: number) => {
    Object.defineProperty(view, "clientHeight", { configurable: true, value: h });
    resize(view, h);
  };
  /** The pointer at x (moves say no button is held, as events handed to WebKit by software do). */
  const point = async (box: HTMLElement, type: string, x: number) => {
    box.dispatchEvent(new PointerEvent(type, { clientX: x, clientY: 20, button: 0, buttons: 0, bubbles: type !== "pointerenter" && type !== "pointerleave" }));
    await frame();
  };
  const click = async (box: HTMLElement, x: number) => {
    await point(box, "pointerdown", x);
    await point(box, "pointerup", x);
  };
  const drag = async (box: HTMLElement, from: number, to: number) => {
    await point(box, "pointerdown", from);
    await point(box, "pointermove", to);
    await point(box, "pointerup", to);
  };
  const tip = (root: HTMLElement) => root.querySelector(".lhist-tip")?.textContent;
  const selected = (root: HTMLElement) => root.querySelector(".lines .ln.sel .txt")?.textContent;
  /** A line a second from 00:10:00 (`from` on): bars of a second, the 100th line's on the right. */
  const second = (k: number, text = `INFO line ${k}`): [number, number, string] => [0, 600_000 + k * 1000, text];

  it("holds still under the pointer: the bar pointed at stays, whatever comes, until the pointer leaves", async () => {
    const { root, s } = await mount();
    s.send({ t: "lines", l: Array.from({ length: 100 }, (_, k) => second(k)) });
    await pass();
    const box = strip(root);
    // 00:10:20 is the 40th of the 120 bars (00:09:40 … 00:11:39).
    await point(box, "pointerenter", 202);
    expect(tip(root)).toBe("00:10:20–00:10:21 · 1 info");
    expect(root.querySelector<HTMLElement>(".lhist-hover")!.style.left).toBe("200px");
    // More lines, that the bars no longer fit, and a query: the bar stays.
    s.send({ t: "lines", l: Array.from({ length: 31 }, (_, k) => second(120 + k)) });
    await query(root, "line");
    await pass();
    expect(tip(root)).toBe("00:10:20–00:10:21 · 1 info");
    expect(root.querySelector<HTMLElement>(".lhist-hover")!.style.left).toBe("200px");
    await click(box, 202);
    expect(selected(root)).toBe("INFO line 20");
    // Away and back: the bars caught up (bars of 2 s now), another one is there.
    await point(box, "pointerleave", 202);
    await point(box, "pointerenter", 202);
    expect(tip(root)).toBe("00:09:52–00:09:54 · nothing");
  });

  it("picks the bars a drag goes over, though lines come meanwhile", async () => {
    const { root, s } = await mount();
    s.send({ t: "lines", l: Array.from({ length: 100 }, (_, k) => second(k)) });
    await pass();
    const box = strip(root);
    await point(box, "pointerenter", 202);
    await point(box, "pointerdown", 202);
    await point(box, "pointermove", 252);
    s.send({ t: "lines", l: Array.from({ length: 31 }, (_, k) => second(120 + k)) });
    await pass();
    const brush = root.querySelector<HTMLElement>(".lhist-brush")!;
    expect([brush.style.left, brush.style.width]).toEqual(["200px", "55px"]);
    expect(tip(root)).toBe("00:10:20–00:10:31 · 11s");
    await point(box, "pointerup", 252);
    expect(root.querySelector(".range-chip")!.textContent).toContain("00:10:20 – 00:10:31");
    expect(lines(root)).toEqual(Array.from({ length: 11 }, (_, k) => `INFO line ${20 + k}`));
  });

  it("takes a drag back on Escape: nothing is picked, and past the strip the bars move on", async () => {
    const { root, s } = await mount();
    s.send({ t: "lines", l: Array.from({ length: 100 }, (_, k) => second(k)) });
    await pass();
    const box = strip(root);
    await point(box, "pointerenter", 202);
    await point(box, "pointerdown", 202);
    await point(box, "pointermove", 252);
    expect(root.querySelector(".lhist-brush")).not.toBeNull();
    await point(box, "pointerleave", 700);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await frame();
    expect([root.querySelector(".lhist-brush"), root.querySelector(".lhist-tip"), root.querySelector(".range-chip")]).toEqual([null, null, null]);
    // The bars caught up: the newest is 3 s later, so is the bar there.
    s.send({ t: "lines", l: [second(101), second(102)] });
    await pass();
    await point(box, "pointerenter", 202);
    expect(tip(root)).toBe("00:10:23–00:10:24 · 1 info");
  });

  it("takes a drag back on Escape and leaves what Escape does elsewhere alone: the line picked stays", async () => {
    const { root, s } = await mount();
    s.send({ t: "lines", l: Array.from({ length: 100 }, (_, k) => second(k)) });
    await pass();
    const box = strip(root);
    await point(box, "pointerenter", 202);
    await click(box, 202);
    expect(selected(root)).toBe("INFO line 20");
    await point(box, "pointerdown", 202);
    await point(box, "pointermove", 252);
    const lines = root.querySelector<HTMLElement>(".code.logs")!;
    lines.focus();
    lines.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await frame();
    expect([root.querySelector(".lhist-brush"), selected(root)]).toEqual([null, "INFO line 20"]);
    // The release that follows ends no drag: nothing is picked.
    await point(box, "pointerup", 252);
    expect(root.querySelector(".range-chip")).toBeNull();
  });

  it("stops while paused, shown again and filtered meanwhile: its bars end with the lines shown", async () => {
    const { root, s } = await mount();
    s.send({ t: "lines", l: Array.from({ length: 100 }, (_, k) => second(k, `${k % 2 ? "WARN" : "INFO"} line ${k}`)) });
    await pass();
    await key(root, "s");
    // 5 minutes of lines, which wait while paused.
    s.send({ t: "lines", l: Array.from({ length: 100 }, (_, k): [number, number, string] => [0, 700_000 + k * 3000, `INFO later ${k}`]) });
    await pass();
    // Hidden and shown again (as a dock tab is), then a level hidden.
    await key(root, "h");
    await key(root, "h");
    root.querySelector<HTMLButtonElement>(".lchip")!.click();
    await pass();
    const box = strip(root);
    await point(box, "pointerenter", 597);
    expect(tip(root)).toBe("00:11:39–00:11:40 · 1 warning");
  });

  it("keeps its step while hidden: shown again, its bars are as they were", async () => {
    const { root, s } = await mount();
    s.send({ t: "lines", l: Array.from({ length: 131 }, (_, k) => second(k)) });
    await pass();
    // 600 px: bars of 2 s. At 700 px a second would do, but not with room to spare: 2 s stay.
    const box = strip(root);
    widen(box, 700);
    await point(box, "pointerenter", 202);
    expect(tip(root)).toBe("00:08:52–00:08:54 · nothing");
    await point(box, "pointerleave", 202);
    // A dock tab not shown is 0 high: the bars go, then come back.
    const view = root.querySelector<HTMLElement>(".logv")!;
    tall(view, 0);
    expect(root.querySelector(".lhist")).toBeNull();
    tall(view, 500);
    await point(strip(root, 700), "pointerenter", 202);
    expect(tip(root)).toBe("00:08:52–00:08:54 · nothing");
  });

  it("moves on as lines come that the filters leave out: they lower the bars, they do not hold them", async () => {
    const { root, s } = await mount();
    s.send({ t: "lines", l: Array.from({ length: 100 }, (_, k) => second(k, `INFO alpha ${k}`)) });
    await pass();
    await query(root, "alpha");
    s.send({ t: "lines", l: Array.from({ length: 10 }, (_, k) => second(100 + k, `INFO beta ${k}`)) });
    await pass();
    await point(strip(root), "pointerenter", 597);
    expect(tip(root)).toBe("00:11:49–00:11:50 · nothing");
  });

  it("keeps a range, its own, for a click on a bar of lines kept for a filter: without one they are not shown", async () => {
    const was = { ...budget };
    budget.lines = 50;
    try {
      const { root, s } = await mount();
      s.send({ t: "lines", l: Array.from({ length: 40 }, (_, k) => second(k, `INFO a ${k}`)) });
      await pass();
      // 00:10:05 … 00:10:16 picked; then the oldest lines go, those it shows are kept.
      let box = strip(root);
      await point(box, "pointerenter", 427);
      await drag(box, 427, 482);
      expect(root.querySelector(".range-chip")!.textContent).toContain("00:10:05 – 00:10:17");
      await point(box, "pointerleave", 482);
      s.send({ t: "lines", l: Array.from({ length: 40 }, (_, k) => second(40 + k, `INFO b ${k}`)) });
      await pass();
      // Another stretch picked, among the newest lines; then a click on 00:10:10, one of the kept, outside it.
      box = strip(root);
      await point(box, "pointerenter", 527);
      await drag(box, 527, 557);
      expect(root.querySelector(".range-chip")!.textContent).toContain("00:11:05 – 00:11:12");
      await click(box, 252);
      expect([root.querySelector(".range-chip")!.textContent, selected(root)]).toEqual([expect.stringContaining("00:10:10 – 00:10:11"), "INFO a 10"]);
    } finally {
      Object.assign(budget, was);
    }
  });

  it("lets the bars go on once the pointer rests on them a while; held, the screen's place stays on them", async () => {
    const was = hover.holdMs;
    try {
      const { root, s } = await mount();
      s.send({ t: "lines", l: Array.from({ length: 100 }, (_, k) => second(k)) });
      await pass();
      const box = strip(root);
      await point(box, "pointerenter", 597);
      s.send({ t: "lines", l: Array.from({ length: 31 }, (_, k) => second(100 + k)) });
      await pass();
      // Held: the newest bars wait. The screen follows the lines past the right edge: its place shows at that edge.
      expect(tip(root)).toBe("00:11:39–00:11:40 · 1 info");
      expect(root.querySelector<HTMLElement>(".lhist-seen")!.style.left).toBe("598px");
      // Once the pointer rests a while (not being read), the bars go on: the newest is under it (bars of 2 s now).
      hover.holdMs = 50;
      await point(box, "pointermove", 597);
      await new Promise((r) => setTimeout(r, 100));
      expect(tip(root)).toBe("00:12:10–00:12:12 · 1 info");
    } finally {
      hover.holdMs = was;
    }
  });

  it("shows all the time again for a click on a bar left out of the time picked; an empty bar goes to the nearest line", async () => {
    const { root, s } = await mount();
    // 00:10:00 … 00:10:09, then 00:10:40 … 00:10:49: bars of a second, from 00:08:50 on.
    s.send({ t: "lines", l: [...Array.from({ length: 10 }, (_, k) => second(k, `INFO a${k}`)), ...Array.from({ length: 10 }, (_, k) => second(40 + k, `INFO b${k}`))] });
    await pass();
    const box = strip(root);
    await point(box, "pointerenter", 552);
    await point(box, "pointerdown", 552);
    await point(box, "pointermove", 597);
    await point(box, "pointerup", 597);
    expect(lines(root)).toEqual(Array.from({ length: 10 }, (_, k) => `INFO b${k}`));
    await click(box, 377);
    expect(root.querySelector(".range-chip")).toBeNull();
    expect(selected(root)).toBe("INFO a5");
    // 00:10:30: nothing there; 00:10:40 is nearer than 00:10:09.
    await click(box, 502);
    expect(selected(root)).toBe("INFO b0");
  });
});
