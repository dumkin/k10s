import { render } from "solid-js/web";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { LogMessage, LogSpec, LogTarget } from "../../lib/backend";
import { Tone } from "../../lib/backend";
import { installHotkeys } from "../../lib/hotkeys";
import type { DetailProps } from "../../registry/details";
import type { UIRow } from "../../state/view";
import { LogsTab } from "../LogsTab";
import { timing } from "./LogViewer";
import { setFilterMode, setFold, setPinned, setPretty } from "./model";

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
beforeAll(() => {
  // Every batch drawn as it comes (but in the test of the pacing itself).
  timing.showEvery = 0;
  globalThis.ResizeObserver ??= class {
    observe() {}
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
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: (t: string) => (copied.push(t), Promise.resolve()) } });
  installHotkeys();
});
afterAll(() => {
  delete (HTMLElement.prototype as { clientHeight?: number }).clientHeight;
  delete (HTMLElement.prototype as { scrollHeight?: number }).scrollHeight;
  delete (HTMLElement.prototype as { scrollTop?: number }).scrollTop;
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
    timing.showEvery = 100;
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
