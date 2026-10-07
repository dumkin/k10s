import { render } from "solid-js/web";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Column, LogMessage, LogSpec, LogTarget } from "../lib/backend";
import { Tone } from "../lib/backend";
import type { DetailProps } from "../registry/details";
import type { UIRow } from "../state/view";
import { LogsTab } from "./LogsTab";
import { timing } from "./logs/LogViewer";

// The pods of the workload come from a signal the tests set; the engine is a recorder.
const h = vi.hoisted(() => ({
  setPods: (_rows: UIRow[]) => {},
  setColumns: (_columns: Column[]) => {},
  object: undefined as unknown,
  streams: [] as { spec: LogSpec; send: (m: LogMessage) => void; updates: LogTarget[][]; closed: boolean }[],
}));

vi.mock("../state/view", async () => {
  const { createSignal } = await import("solid-js");
  const [rows, setRows] = createSignal<UIRow[]>([]);
  const [columns, setColumns] = createSignal<Column[]>([]);
  h.setPods = setRows;
  h.setColumns = setColumns;
  return {
    createViewFeed: (spec: () => unknown) => ({ rows: () => (spec() ? rows() : []), version: () => 0, statuses: {}, resolved: {}, loading: () => false, columns, rowByKey: () => undefined }),
  };
});

const deployment = { metadata: { name: "web", namespace: "shop" }, spec: { selector: { matchLabels: { app: "web" } }, template: { spec: { containers: [{ name: "app" }] } } } };
vi.mock("./common", async (original) => ({
  ...(await original<typeof import("./common")>()),
  useObject: () => ({ value: () => h.object, loading: () => false, error: () => undefined }),
}));

vi.mock("../lib/backend", async (original) => ({
  ...(await original<typeof import("../lib/backend")>()),
  backend: () => ({
    streamLogs(spec: LogSpec, onMessage: (m: LogMessage) => void) {
      const s = { spec, send: onMessage, updates: [] as LogTarget[][], closed: false };
      h.streams.push(s);
      return {
        close: () => (s.closed = true),
        setTargets: (targets: LogTarget[]) => s.updates.push(targets),
      };
    },
  }),
}));

const pod = (name: string, uid = name): UIRow => ({ key: `prod-eu-z1/${uid}`, cl: "prod-eu-z1", u: uid, n: name, ns: "shop", rv: "1", t: 0, s: Tone.Ok, c: [] });
const row: UIRow = { key: "prod-eu-z1/web", cl: "prod-eu-z1", u: "web", n: "web", ns: "shop", rv: "1", t: 0, s: Tone.Ok, c: [] };

beforeAll(() => {
  // Every batch drawn as it comes (the view's pacing has a test of its own).
  timing.showEvery = 0;
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  HTMLCanvasElement.prototype.getContext = (() => null) as never;
});

let dispose: (() => void) | undefined;
beforeEach(() => {
  h.streams.length = 0;
  h.object = deployment;
  h.setColumns([]);
  localStorage.clear();
});
afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.innerHTML = "";
});

async function mount(of: { row: UIRow; resourceKey: string } = { row, resourceKey: "deployments.apps" }) {
  const root = document.createElement("div");
  document.body.append(root);
  const props: DetailProps = { ...of, target: { cluster: "prod-eu-z1", resource: of.resourceKey, namespace: "shop", name: of.row.n } };
  dispose = render(() => <LogsTab {...props} />, root);
  return root;
}

const tick = () => new Promise((r) => setTimeout(r, 0));
/** Log lines shown (markers apart). */
const shownLines = (root: HTMLElement) => [...root.querySelectorAll(".lines .ln:not(.marker):not(.cont):not(.fold) .txt")].map((e) => e.textContent);
const markers = (root: HTMLElement) => [...root.querySelectorAll(".lines .ln.marker .txt")].map((e) => e.textContent);
const strip = (root: HTMLElement) => root.querySelector(".lstrip-state")!;

describe("LogsTab", () => {
  it("follows pods as they come and go without restarting the stream or losing lines", async () => {
    h.setPods([pod("web-a"), pod("web-b")]);
    const root = await mount();
    await tick();
    expect(h.streams).toHaveLength(1);
    const s = h.streams[0];
    expect(s.spec).toMatchObject({ follow: true, tailLines: 1000, previous: false });
    expect(s.spec.targets.map((t) => [t.pod, t.id])).toEqual([
      ["web-a", 0],
      ["web-b", 1],
    ]);
    s.send({ t: "lines", l: [[0, 1000, "from a"], [1, 2000, "from b"]] });
    await tick();
    expect(shownLines(root)).toEqual(["from a", "from b"]);

    // Rollout: web-a goes, web-c comes. Only the targets change; the lines stay.
    h.setPods([pod("web-b"), pod("web-c")]);
    await tick();
    expect(h.streams).toHaveLength(1);
    expect(s.closed).toBe(false);
    expect(s.updates.map((u) => u.map((t) => [t.pod, t.id]))).toEqual([
      [
        ["web-b", 1],
        ["web-c", 2],
      ],
    ]);
    s.send({ t: "lines", l: [[2, 3000, "from c"]] });
    await tick();
    expect(shownLines(root)).toEqual(["from a", "from b", "from c"]);
    // Where web-a went away, the timeline says so.
    expect(markers(root)).toEqual(["pod deleted"]);
    // A late state of the stopped target does not hide that its pod is gone.
    s.send({ t: "state", i: 0, state: "streaming" });
    s.send({ t: "state", i: 1, state: "streaming" });
    s.send({ t: "state", i: 2, state: "streaming" });
    await tick();
    expect(strip(root).textContent).toContain("live · 1 ended");
  });

  it("says in Sources whose lines come late, and which pod wrote nothing for a while", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    try {
      h.setPods([pod("web-a"), pod("web-b"), pod("web-c")]);
      const root = await mount();
      await tick();
      const s = h.streams[0];
      for (const i of [0, 1, 2]) s.send({ t: "state", i, state: "streaming" });
      // web-c last wrote 5 minutes ago (its history); web-a's lines come as they are written, web-b's 45 s later.
      s.send({ t: "lines", l: [[2, Date.now() - 300_000, "from c"]] });
      for (let k = 1; k <= 60; k++) {
        vi.advanceTimersByTime(1000);
        s.send({
          t: "lines",
          l: [
            [0, Date.now(), `from a ${k}`],
            [1, Date.now() - 45_000, `from b ${k}`],
          ],
        });
      }
      vi.advanceTimersByTime(1000);
      await tick();
      root.querySelector<HTMLButtonElement>('button[title^="Sources"]')!.click();
      await tick();
      const rows = [...document.querySelectorAll(".lsrc")];
      expect(rows.map((r) => [r.querySelector(".lsrc-pod")!.textContent, r.querySelector(".lsrc-state")!.textContent])).toEqual([
        ["web-a", "live"],
        ["web-b", "45s behind"],
        ["web-c", "last line 6m1s ago"],
      ]);
      expect(rows.map((r) => r.querySelector(".lsrc-state")!.classList.contains("tone-warn"))).toEqual([false, true, false]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("starts over when what is shown changes, and does not remember All lines", async () => {
    h.setPods([pod("web-a")]);
    const root = await mount();
    await tick();
    h.streams[0].send({ t: "lines", l: [[0, 1000, "old"]] });
    const tail = root.querySelector<HTMLSelectElement>('select[title^="History to read"]')!;
    tail.value = "all";
    tail.dispatchEvent(new Event("change"));
    await tick();
    expect(h.streams).toHaveLength(2);
    expect(h.streams[0].closed).toBe(true);
    expect(h.streams[1].spec.tailLines).toBeNull();
    expect(shownLines(root)).toEqual([]);
    expect(localStorage.getItem("k10s:logs.tail")).toBeNull();

    tail.value = "t5000";
    tail.dispatchEvent(new Event("change"));
    await tick();
    expect(h.streams[2].spec.tailLines).toBe(5000);
    expect(localStorage.getItem("k10s:logs.tail")).toBe("5000");

    // A stretch of time instead of a number of lines: all of its lines (the engine shares them out).
    tail.value = "s900";
    tail.dispatchEvent(new Event("change"));
    await tick();
    expect(h.streams[3].spec).toMatchObject({ tailLines: null, sinceSeconds: 900 });
    expect(localStorage.getItem("k10s:logs.since")).toBe("900");
  });

  it("streams at most 50 containers and says so", async () => {
    h.setPods(Array.from({ length: 120 }, (_, i) => pod(`web-${String(i).padStart(3, "0")}`)));
    const root = await mount();
    await tick();
    expect(h.streams[0].spec.targets).toHaveLength(50);
    expect(strip(root).textContent).toContain("50 of 120 pods");
    // A pod that is shown goes away: its place is filled, the others stay.
    h.setPods(Array.from({ length: 120 }, (_, i) => pod(`web-${String(i).padStart(3, "0")}`)).filter((p) => p.n !== "web-010"));
    await tick();
    const update = h.streams[0].updates[0].map((t) => t.pod);
    expect(update).toHaveLength(50);
    expect(update).not.toContain("web-010");
    expect(update).toContain("web-050");
  });

  it("streams a pod re-created under the same name as a new source, keeping the old one's lines", async () => {
    h.setPods([pod("web-0", "uid-1"), pod("web-1")]);
    const root = await mount();
    await tick();
    const s = h.streams[0];
    expect(s.spec.targets.map((t) => [t.pod, t.uid, t.id])).toEqual([
      ["web-0", "uid-1", 0],
      ["web-1", "web-1", 1],
    ]);
    s.send({ t: "lines", l: [[0, 1000, "before the restart"]] });
    // Deleted and created again within one refresh: same names, another uid.
    h.setPods([pod("web-0", "uid-2"), pod("web-1")]);
    await tick();
    expect(s.updates.map((u) => u.map((t) => [t.pod, t.uid, t.id]))).toEqual([
      [
        ["web-0", "uid-2", 2],
        ["web-1", "web-1", 1],
      ],
    ]);
    s.send({ t: "state", i: 0, state: "ended", message: "pod deleted" });
    s.send({ t: "lines", l: [[2, 2000, "after the restart"]] });
    await tick();
    expect(shownLines(root)).toEqual(["before the restart", "after the restart"]);
  });

  it("streams each pod's own containers during a rollout and does not call live ones deleted", async () => {
    const columns: Column[] = [
      { id: "status", title: "Status", kind: "status" },
      { id: "containers", title: "Containers", kind: "text" },
    ];
    const withContainers = (name: string, containers: string, status = "Running"): UIRow => ({ ...pod(name), c: [[status, Tone.Ok], containers] });
    h.object = { ...deployment, spec: { ...deployment.spec, template: { spec: { containers: [{ name: "app" }, { name: "proxy" }] } } } };
    h.setColumns(columns);
    // An older pod without the new proxy container, a new one with it.
    h.setPods([withContainers("web-old", "app"), withContainers("web-new", "app,proxy")]);
    const root = await mount();
    await tick();
    const s = h.streams[0];
    expect(s.spec.targets.map((t) => `${t.pod}/${t.container}`)).toEqual(["web-new/app", "web-new/proxy", "web-old/app"]);
    // The old pod finishes and goes away: only its stream is marked deleted.
    h.setPods([withContainers("web-new", "app,proxy")]);
    await tick();
    expect(s.updates.at(-1)!.map((t) => `${t.pod}/${t.container}`)).toEqual(["web-new/app", "web-new/proxy"]);
    const summary = root.querySelector<HTMLElement>(".lstrip-state[title*='ended']")!;
    expect(summary.title).toContain("shop/web-old · app (pod deleted): ended — pod deleted");
    expect(summary.title).not.toContain("web-new · app (");
  });

  it("reads the previous container's logs once", async () => {
    const podRow: UIRow = { ...pod("web-1"), key: "prod-eu-z1/web-1" };
    h.object = { metadata: { name: "web-1", namespace: "shop" }, spec: { containers: [{ name: "app" }] } };
    const root = await mount({ row: podRow, resourceKey: "pods" });
    await tick();
    expect(h.streams[0].spec).toMatchObject({ follow: true, previous: false, targets: [{ pod: "web-1", uid: "web-1", container: "app", id: 0 }] });
    // In the menu (and on P).
    root.querySelector<HTMLButtonElement>('.toolbar button[title^="More"]')!.click();
    await tick();
    const previous = [...document.querySelectorAll<HTMLButtonElement>(".menu .opt")].find((b) => b.textContent?.includes("Previous container"))!;
    previous.click();
    await tick();
    expect(h.streams).toHaveLength(2);
    expect(h.streams[0].closed).toBe(true);
    expect(h.streams[1].spec).toMatchObject({ follow: false, previous: true });
  });
});
