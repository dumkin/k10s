import { afterEach, describe, expect, it, vi } from "vitest";
import type { LogLine, LogMessage, LogSpec } from "../../lib/backend";
import { LogBuffer, Sources } from "../logBuffer";
import { EARLIER_LINES, Earlier, SETTLE_MS, type StartedWith } from "./earlier";

// Loading earlier history in place: what each container is asked for, and what of it goes into the buffer.
const h = vi.hoisted(() => ({ reads: [] as { spec: LogSpec; send: (m: LogMessage) => void; closed: boolean }[] }));
vi.mock("../../lib/backend", async (original) => ({
  ...(await original<typeof import("../../lib/backend")>()),
  backend: () => ({
    streamLogs(spec: LogSpec, onMessage: (m: LogMessage) => void) {
      const r = { spec, send: onMessage, closed: false };
      h.reads.push(r);
      return { close: () => (r.closed = true), setTargets() {} };
    },
  }),
}));

let open: Earlier | undefined;
afterEach(() => {
  open?.close();
  open = undefined;
  h.reads.length = 0;
});

const T0 = 1_000_000_000;

/** A stream of one pod's containers that started at T0 with `with`; the history read at the start is in. */
function setup(opts: { with?: Partial<StartedWith>; restarts?: number; containers?: string[] } = {}) {
  let now = T0;
  const buffer = new LogBuffer();
  const sources = new Sources();
  sources.assign((opts.containers ?? ["app"]).map((container) => ({ cluster: "prod-eu-z1", namespace: "shop", pod: "web-1", uid: "u1", container })));
  const changes = { n: 0, loaded: 0 };
  const e = new Earlier({
    buffer,
    sources: () => sources.byId,
    startedWith: { tail: 10, since: null, previous: false, ...opts.with },
    restarts: () => opts.restarts,
    label: "pods shop/web-1",
    onChange: () => changes.n++,
    onLoaded: () => changes.loaded++,
    now: () => now,
  });
  open = e;
  /** Lines of the stream: into the buffer, and seen. */
  const stream = (lines: LogLine[]) => {
    buffer.add(lines);
    e.seen(lines);
  };
  const settle = () => {
    for (const s of sources.byId) e.streamState(s.id, "streaming");
    now += SETTLE_MS + 1;
  };
  return { e, buffer, sources, changes, stream, settle, tick: (ms: number) => (now += ms) };
}

const texts = (b: LogBuffer) => b.lines.map((l) => l.text);
/** The ten last lines of a container's log, read at the start (written before it). */
const history = (i = 0, from = T0 - 60_000): LogLine[] => Array.from({ length: 10 }, (_, k) => [i, from + k * 1000, `h${k}`]);

describe("Earlier", () => {
  it("reads what each container wrote before its first line held, up to it, and merges it in front", () => {
    const { e, buffer, stream, settle } = setup();
    const lines = history();
    lines.splice(1, 0, [0, T0 - 60_000, "h0 again"]);
    stream(lines);
    expect(e.state().phase).toBe("");
    settle();
    expect(e.state()).toEqual({ phase: "more", more: 1, previous: 0, loaded: 0 });
    e.load();
    expect(e.state().phase).toBe("loading");
    const [read] = h.reads;
    expect(read.spec).toMatchObject({ follow: false, previous: false, sinceSeconds: null });
    // As many of its last lines as reach past the 11 held, up to the first one held.
    expect(read.spec.targets).toEqual([{ cluster: "prod-eu-z1", namespace: "shop", pod: "web-1", uid: "u1", container: "app", id: 0, tailLines: 11 + EARLIER_LINES + 100, until: T0 - 60_000 }]);
    // The read goes up to the millisecond of the first line held: the lines of it held already are left out.
    read.send({ t: "state", i: 0, state: "streaming" });
    read.send({ t: "lines", l: [[0, T0 - 90_000, "e1"], [0, T0 - 60_000, "e2, written in the same millisecond"], [0, T0 - 60_000, "h0"], [0, T0 - 60_000, "h0 again"]] });
    read.send({ t: "state", i: 0, state: "ended" });
    expect(read.closed).toBe(true);
    expect(texts(buffer).slice(0, 4)).toEqual(["e1", "e2, written in the same millisecond", "h0", "h0 again"]);
    expect(buffer.lines.length).toBe(13);
    // Fewer lines than asked for: the beginning of its log (it never restarted: nothing before it).
    expect(e.state()).toEqual({ phase: "done", more: 0, previous: 0, loaded: 2 });
  });

  it("asks again from the earliest line loaded, while there is more", () => {
    const { e, buffer, stream, settle } = setup();
    stream(history());
    settle();
    e.load();
    const lines = Array.from({ length: EARLIER_LINES + 300 }, (_, k): LogLine => [0, T0 - 10_000_000 + k, `e${k}`]);
    h.reads[0].send({ t: "lines", l: lines });
    h.reads[0].send({ t: "state", i: 0, state: "ended" });
    // The latest of them as many as asked for (the margin for lines in flight read more).
    expect(buffer.lines.length).toBe(10 + EARLIER_LINES);
    expect(buffer.lines[0].text).toBe("e300");
    expect(e.state()).toEqual({ phase: "more", more: 1, previous: 0, loaded: EARLIER_LINES });
    e.load();
    expect(h.reads[1].spec.targets[0]).toMatchObject({ tailLines: 10 + EARLIER_LINES + EARLIER_LINES + 100, until: T0 - 10_000_000 + 300 });
  });

  it("goes on into the previous container's logs once the current one's were read from their beginning", () => {
    const { e, buffer, stream, settle } = setup({ restarts: 3 });
    // Fewer lines than asked for at the start: the current container's whole log.
    stream(history().slice(0, 4));
    settle();
    expect(e.state()).toEqual({ phase: "more", more: 1, previous: 1, loaded: 0 });
    e.load();
    const [read] = h.reads;
    expect(read.spec.previous).toBe(true);
    expect(read.spec.targets[0]).toMatchObject({ tailLines: EARLIER_LINES, until: T0 - 60_000 });
    read.send({ t: "lines", l: [[0, T0 - 600_000, "starting"], [0, T0 - 590_000, "fatal error: runtime: out of memory"]] });
    read.send({ t: "state", i: 0, state: "ended" });
    // The runs apart: a marker after the previous one's last line.
    expect(texts(buffer)).toEqual(["starting", "fatal error: runtime: out of memory", "container restarted", "h0", "h1", "h2", "h3"]);
    expect(buffer.lines[2].marker).toBe(true);
    // The run before that one's logs are gone.
    expect(e.state()).toEqual({ phase: "done", more: 0, previous: 0, loaded: 2 });
  });

  it("reads what is held of a container that restarted while it streamed as its previous run's", () => {
    const { e, stream, settle, tick } = setup();
    stream(history());
    settle();
    e.streamState(0, "ended");
    e.streamState(0, "streaming", true);
    tick(1000);
    stream([[0, T0 + 5000, "up again"]]);
    e.load();
    // 10 lines held of the run that ended (the line of the new run is not of it).
    expect(h.reads[0].spec).toMatchObject({ previous: true, targets: [{ tailLines: 10 + EARLIER_LINES, until: T0 - 60_000 }] });
  });

  it("says why some containers could not be read, and asks them again on the next load", () => {
    const { e, stream, settle } = setup({ containers: ["app", "proxy"] });
    stream([...history(0), ...history(1)]);
    settle();
    e.load();
    const [read] = h.reads;
    expect(read.spec.targets.map((t) => t.tailLines)).toEqual([10 + EARLIER_LINES / 2 + 100, 10 + EARLIER_LINES / 2 + 100]);
    read.send({ t: "state", i: 0, state: "error", message: 'pods "web-1" is forbidden' });
    read.send({ t: "state", i: 1, state: "ended" });
    expect(e.state()).toEqual({ phase: "more", more: 1, previous: 0, loaded: 0, error: 'pods "web-1" is forbidden' });
    e.load();
    expect(h.reads[1].spec.targets.map((t) => t.container)).toEqual(["app"]);
  });

  it("loads nothing into a view that was cleared, or that is full", () => {
    const { e, buffer, stream, settle } = setup();
    stream(history());
    settle();
    e.clear();
    e.load();
    expect(h.reads).toEqual([]);
    expect(e.state().phase).toBe("");

    const full = setup();
    full.stream(Array.from({ length: Math.floor(buffer.maxLines * 0.9) }, (_, k): LogLine => [0, T0 - 1e7 + k, "x"]));
    full.settle();
    expect(full.e.state().phase).toBe("full");
    full.e.load();
    expect(h.reads).toEqual([]);
  });
});
