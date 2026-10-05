import { describe, expect, it } from "vitest";
import type { LogLine, LogTarget } from "../lib/backend";
import { Level } from "../lib/logs/parse";
import { ALL, type Filter, LogBuffer, pickPods, plainOf, podDone, type PodRef, Sources } from "./logBuffer";

const containing = (b: LogBuffer, q: string): Filter => (q ? { key: q, test: (l) => b.lower(l).includes(q) } : ALL);
const texts = (b: LogBuffer, q = "") => b.view(containing(b, q)).map((l) => l.text);

describe("LogBuffer", () => {
  it("merges the lines of several sources into one timeline, keeping each source's order", () => {
    const b = new LogBuffer();
    b.add([
      [0, 1000, "a1"],
      [0, 3000, "a3"],
      [0, 5000, "a5"],
    ]);
    // The tail of a second pod arrives later and covers the same time.
    b.add([
      [1, 2000, "b2"],
      [1, 3000, "b3"],
      [1, 6000, "b6"],
    ]);
    expect(texts(b)).toEqual(["a1", "b2", "a3", "b3", "a5", "b6"]);
    // Live lines go to the end; equal timestamps keep arrival order.
    b.add([
      [1, 7000, "b7"],
      [0, 7000, "a7"],
    ]);
    expect(texts(b).slice(-2)).toEqual(["b7", "a7"]);
    // A line without a timestamp stays after the previous line of its source.
    b.add([[0, null, "a-no-ts"]]);
    expect(texts(b).slice(-3)).toEqual(["b7", "a7", "a-no-ts"]);
    expect(b.lines.map((l) => l.pos)).toEqual(b.lines.map((_, k) => k));
  });

  it("keeps text with line breaks (a stack trace sent as one) as one entry, at its time and in its place", () => {
    const b = new LogBuffer();
    b.add([
      [0, 1000, "before"],
      [1, 2000, "panic: boom\r\n\ngoroutine 1 [running]:\nmain.main()\n\tmain.go:7\n"],
      [0, 3000, "after"],
    ]);
    expect(texts(b)).toEqual(["before", "panic: boom", "after"]);
    expect(b.lines[1].more).toEqual(["", "goroutine 1 [running]:", "main.main()", "\tmain.go:7"]);
    expect(b.lines[1].lvl).toBe(Level.Error);
    // A search finds the whole entry by any of its lines.
    expect(texts(b, "main.go:7")).toEqual(["panic: boom"]);
  });

  it("joins the lines of a stack trace that come one by one to the line they belong to", () => {
    const b = new LogBuffer();
    b.add([
      [0, 1000, "2026-10-04 10:42:01.123 ERROR [main] c.a.Orders - order failed"],
      [0, 1001, "java.lang.IllegalStateException: no stock"],
      [0, 1001, "\tat com.acme.Orders.place(Orders.java:42)"],
      [1, 1001, "other pod, other story"],
      [0, 1002, "Caused by: java.io.IOException: closed"],
    ]);
    b.add([
      [0, 1002, "\t... 12 more"],
      [0, 1500, "2026-10-04 10:42:01.600 INFO  [main] c.a.Orders - next order"],
      // An indented line much later starts an entry of its own.
      [0, 9000, "   indented, but on its own"],
    ]);
    expect(texts(b)).toEqual(["2026-10-04 10:42:01.123 ERROR [main] c.a.Orders - order failed", "other pod, other story", "2026-10-04 10:42:01.600 INFO  [main] c.a.Orders - next order", "   indented, but on its own"]);
    expect(b.lines[0].more).toEqual(["java.lang.IllegalStateException: no stock", "\tat com.acme.Orders.place(Orders.java:42)", "Caused by: java.io.IOException: closed", "\t... 12 more"]);
    expect(b.counts).toEqual([3, 1]);
    // A view sees the entry again once it grew.
    expect(texts(b, "ioexception")).toEqual(["2026-10-04 10:42:01.123 ERROR [main] c.a.Orders - order failed"]);
    b.add([[0, 9000, "\tmore of the indented one"]]);
    expect(texts(b, "more of the")).toEqual(["   indented, but on its own"]);
    expect(plainOf(b.lines[3])).toBe("   indented, but on its own\n\tmore of the indented one");
  });

  it("never joins JSON lines, nor lines of another source", () => {
    const b = new LogBuffer();
    b.add([
      [0, 1000, '{"level":"error","msg":"a"}'],
      [0, 1000, '  {"level":"info","msg":"indented JSON is a line of its own"}'],
      [1, 1000, "\tat a frame of another pod's"],
    ]);
    expect(b.lines.map((l) => [l.i, l.text, l.more?.length ?? 0])).toEqual([
      [0, '{"level":"error","msg":"a"}', 0],
      [0, '  {"level":"info","msg":"indented JSON is a line of its own"}', 0],
      [1, "\tat a frame of another pod's", 0],
    ]);
  });

  it("puts markers in the timeline after their source's last line, and starts entries anew after them", () => {
    const b = new LogBuffer();
    b.add([
      [0, 1000, "working"],
      [1, 5000, "elsewhere"],
    ]);
    const m = b.mark(0, "container terminated: OOMKilled (exit code 137)", Level.Error, 2000);
    b.add([[0, 2001, "\tindented first line of the restarted container"]]);
    expect(b.lines.map((l) => l.text)).toEqual(["working", "container terminated: OOMKilled (exit code 137)", "\tindented first line of the restarted container", "elsewhere"]);
    expect(m.marker).toBe(true);
    expect(b.lines[0].more).toBeUndefined();
    expect(b.lines.map((l) => l.seq)).toEqual([0, 2, 3, 1]);
  });

  it("does not sort the whole buffer for a batch of live lines", () => {
    const b = new LogBuffer();
    const many: LogLine[] = Array.from({ length: 10_000 }, (_, k) => [k % 2, k, `l${k}`]);
    b.add(many);
    const first = b.lines[0];
    const sort = Array.prototype.sort;
    let sorted = 0;
    Array.prototype.sort = function (this: unknown[], ...args) {
      sorted += this.length;
      return sort.apply(this, args as never) as never;
    };
    try {
      b.add([
        [1, 10_000, "live"],
        [0, 10_001, "live too"],
      ]);
    } finally {
      Array.prototype.sort = sort;
    }
    expect(sorted).toBe(2);
    expect(b.lines[0]).toBe(first);
    expect(texts(b).slice(-2)).toEqual(["live", "live too"]);
  });

  it("drops the oldest lines beyond the byte budget and counts them", () => {
    const b = new LogBuffer(10_000, 1_000_000);
    for (let k = 0; k < 50; k++) b.add([[0, k, "x".repeat(1_000)]]);
    expect(b.bytes).toBeLessThanOrEqual(10_000);
    expect(b.dropped).toBeGreaterThan(0);
    expect(b.dropped + b.lines.length).toBe(50);
    // The newest are kept.
    expect(b.lines[b.lines.length - 1].ts).toBe(49);
    expect(b.lines[0].ts).toBe(b.dropped);
  });

  it("drops the oldest lines beyond the line budget", () => {
    const b = new LogBuffer(1e9, 100);
    b.add(Array.from({ length: 250 }, (_, k): LogLine => [0, k, `l${k}`]));
    expect(b.lines.length).toBeLessThanOrEqual(100);
    expect(b.dropped).toBe(250 - b.lines.length);
    expect(b.lines[b.lines.length - 1].text).toBe("l249");
  });

  it("keeps a filtered view in step with merges and drops, matching lower-cased plain text", () => {
    const b = new LogBuffer(1e9, 20);
    b.add([
      [0, 1, "ERROR one"],
      [0, 2, "ok"],
      [0, 5, "\x1b[31mError\x1b[0m five"],
    ]);
    expect(texts(b, "error")).toEqual(["ERROR one", "\x1b[31mError\x1b[0m five"]);
    // An older line of another source lands in the middle.
    b.add([
      [1, 3, "error three"],
      [1, 6, "fine"],
    ]);
    expect(texts(b, "error")).toEqual(["ERROR one", "error three", "\x1b[31mError\x1b[0m five"]);
    // Several batches before the view is read again, one reaching back to the start.
    b.add([[2, 0, "error zero"]]);
    b.add([[2, 7, "error seven"]]);
    expect(texts(b, "error")).toEqual(["error zero", "ERROR one", "error three", "\x1b[31mError\x1b[0m five", "error seven"]);
    // Dropped lines leave the view too.
    b.add(Array.from({ length: 30 }, (_, k): LogLine => [0, 10 + k, k % 10 === 0 ? `error ${k}` : `line ${k}`]));
    const expected = b.lines.filter((l) => b.lower(l).includes("error")).map((l) => l.text);
    expect(texts(b, "error")).toEqual(expected);
    expect(expected[expected.length - 1]).toBe("error 20");
    // The unfiltered view is the buffer itself.
    expect(b.view(ALL)).toBe(b.lines);
  });

  it("makes lower-case copies only when searching, and counts them", () => {
    const b = new LogBuffer();
    b.add([
      [0, 1, "Hello World"],
      [0, 2, "already lower"],
    ]);
    expect(b.lines.every((l) => l.lower === undefined)).toBe(true);
    const before = b.bytes;
    expect(texts(b, "world")).toEqual(["Hello World"]);
    expect(b.bytes).toBe(before + "hello world".length);
  });

  it("clears everything, including the dropped count", () => {
    const b = new LogBuffer(1e9, 10);
    b.add(Array.from({ length: 30 }, (_, k): LogLine => [0, k, `l${k}`]));
    expect(texts(b, "l2")).not.toHaveLength(0);
    b.clear();
    expect([b.lines.length, b.dropped, b.bytes, texts(b, "l2").length]).toEqual([0, 0, 0, 0]);
  });

  it("knows the level of each line", () => {
    const b = new LogBuffer();
    b.add([
      [0, 1, '{"level":"error","msg":"x"}'],
      [0, 2, "WARN slow"],
      [0, 3, "fine"],
      [0, 4, "level=debug msg=y"],
    ]);
    expect(b.lines.map((l) => l.lvl)).toEqual([Level.Error, Level.Warn, Level.None, Level.Debug]);
  });

  it("keeps several views up to date at once, and forgets the least recently read", () => {
    const b = new LogBuffer();
    const odd: Filter = { key: "odd", test: (l) => Number(l.text) % 2 === 1 };
    const big: Filter = { key: "big", test: (l) => Number(l.text) >= 5 };
    b.add(Array.from({ length: 8 }, (_, k): LogLine => [0, k, String(k)]));
    expect(b.view(odd).map((l) => l.text)).toEqual(["1", "3", "5", "7"]);
    expect(b.view(big).map((l) => l.text)).toEqual(["5", "6", "7"]);
    b.add([
      [1, 2, "9"],
      [1, 9, "11"],
    ]);
    expect(b.view(odd).map((l) => l.text)).toEqual(["1", "9", "3", "5", "7", "11"]);
    expect(b.view(big).map((l) => l.text)).toEqual(["9", "5", "6", "7", "11"]);
    // Pausing is a filter on arrival: what came after stays out.
    const upTo = b.seq - 1;
    b.add([[0, 20, "13"]]);
    expect(b.view({ key: `p${upTo}`, test: (l) => l.seq <= upTo && odd.test(l) }).map((l) => l.text)).toEqual(["1", "9", "3", "5", "7", "11"]);
  });

  it("counts the entries of each source as they come and go", () => {
    const b = new LogBuffer(1e9, 10);
    b.add(Array.from({ length: 30 }, (_, k): LogLine => [k % 3, k, `l${k}`]));
    expect(b.counts.reduce((a, n) => a + n, 0)).toBe(b.lines.length);
  });

  it("merges earlier history in front of what it holds, in time order, as no arrivals", () => {
    const b = new LogBuffer();
    b.add([
      [0, 3000, "a3"],
      [1, 3000, "b3"],
      [0, 5000, "a5"],
    ]);
    const errors = { key: "e", test: (l: { text: string }) => l.text.includes("!") };
    expect(b.view(errors)).toEqual([]);
    const seq = b.seq;
    // Read later: what each source wrote before (up to the millisecond of its first line held).
    b.addEarlier([
      [0, 1000, "a1"],
      [0, 3000, "a3-before!"],
      [1, 2000, "b2!"],
    ]);
    expect(texts(b)).toEqual(["a1", "b2!", "a3-before!", "a3", "b3", "a5"]);
    expect(b.lines.map((l) => l.pos)).toEqual(b.lines.map((_, k) => k));
    expect(b.counts).toEqual([4, 2]);
    // Views see them; a pause (what arrived after it waits) shows them, they are not counted as new.
    expect(b.view(errors).map((l) => l.text)).toEqual(["b2!", "a3-before!"]);
    expect(b.seq).toBe(seq);
    expect(b.lines.filter((l) => l.seq < 0).map((l) => l.text)).toEqual(["a1", "b2!", "a3-before!"]);
    // Live lines go on at the end.
    b.add([[1, 6000, "b6"]]);
    expect(texts(b).slice(-2)).toEqual(["a5", "b6"]);
  });

  it("makes a stack trace the first read began inside of whole again, keeping the entry held", () => {
    const b = new LogBuffer();
    b.add([
      [0, 1001, "\tat com.acme.Orders.place(Orders.java:42)"],
      [0, 1001, "\tat com.acme.Api.handle(Api.java:7)"],
      [1, 1001, "other pod"],
      [0, 9000, "next"],
    ]);
    const held = b.lines[0];
    b.addEarlier(
      [
        [0, 900, "earlier"],
        [0, 1000, "2026-10-04 10:42:01.000 ERROR [main] c.a.Orders - order failed"],
        [0, 1000, "java.lang.IllegalStateException: no stock"],
      ],
      [{ i: 0, ts: 950, text: "container restarted", lvl: Level.Warn }],
    );
    expect(texts(b)).toEqual(["earlier", "container restarted", "2026-10-04 10:42:01.000 ERROR [main] c.a.Orders - order failed", "other pod", "next"]);
    // The entry held (a view's, the selection's) is the whole of it now, at its time.
    expect(b.lines[2]).toBe(held);
    expect(held.ts).toBe(1000);
    expect(held.lvl).toBe(Level.Error);
    expect(held.more).toEqual(["java.lang.IllegalStateException: no stock", "\tat com.acme.Orders.place(Orders.java:42)", "\tat com.acme.Api.handle(Api.java:7)"]);
    expect(b.lines[1].marker).toBe(true);
    expect(b.counts).toEqual([4, 1]);
    expect(b.lines.map((l) => l.pos)).toEqual(b.lines.map((_, k) => k));
    // The bytes are those of what it holds.
    const again = new LogBuffer();
    again.add([...b.lines].map((l): LogLine => [l.i, l.ts, [l.text, ...(l.more ?? [])].join("\n")]));
    expect(b.bytes).toBe(again.bytes);
    expect(texts(b, "no stock")).toEqual(["2026-10-04 10:42:01.000 ERROR [main] c.a.Orders - order failed"]);
  });
});

const t = (pod: string, container = "app", cluster = "prod-eu-z1", uid = `uid-${pod}`): LogTarget => ({ cluster, namespace: "shop", pod, uid, container });

describe("Sources", () => {
  it("gives targets stable ids, marks the ones that went away and reuses ids when they come back", () => {
    const s = new Sources();
    expect(s.assign([t("web-a"), t("web-b")]).map((x) => x.id)).toEqual([0, 1]);
    // Rollout: web-a is replaced by web-c; web-b keeps its id.
    expect(s.assign([t("web-b"), t("web-c")], () => "pod deleted").map((x) => x.id)).toEqual([1, 2]);
    expect(s.byId.map((x) => x.gone)).toEqual(["pod deleted", undefined, undefined]);
    expect(s.streams({ cluster: "prod-eu-z1", namespace: "shop", name: "web-a", uid: "uid-web-a" })).toBe(false);
    expect(s.streams({ cluster: "prod-eu-z1", namespace: "shop", name: "web-c", uid: "uid-web-c" })).toBe(true);
    // The same pod is streamed again (it had been left out): its id comes back.
    expect(s.assign([t("web-a"), t("web-b")]).map((x) => x.id)).toEqual([0, 1]);
    expect(s.byId.map((x) => x.gone)).toEqual([undefined, undefined, "no longer streamed"]);
  });

  it("treats a pod re-created under the same name as a new source", () => {
    const s = new Sources();
    s.assign([t("web-0", "app", "prod-eu-z1", "uid-1")]);
    const again = s.assign([t("web-0", "app", "prod-eu-z1", "uid-2")], () => "pod deleted");
    expect(again).toEqual([{ cluster: "prod-eu-z1", namespace: "shop", pod: "web-0", uid: "uid-2", container: "app", id: 1 }]);
    expect(s.byId.map((x) => [x.uid, x.gone])).toEqual([
      ["uid-1", "pod deleted"],
      ["uid-2", undefined],
    ]);
  });
});

describe("podDone", () => {
  it("tells finished pods from running and crashing ones", () => {
    for (const status of ["Completed", "Succeeded", "Evicted", "Terminating", "OutOfmemory", "DeadlineExceeded"]) expect(podDone(status), status).toBe(true);
    for (const status of ["Running", "CrashLoopBackOff", "Error", "OOMKilled", "Pending", "ContainerCreating", "Init:0/1"]) expect(podDone(status), status).toBe(false);
    expect(podDone("Running", true)).toBe(true);
  });
});

describe("pickPods", () => {
  const pod = (name: string, cluster = "prod-eu-z1", extra: Partial<PodRef> = {}): PodRef => ({ cluster, namespace: "shop", name, ...extra });
  const names = (pods: PodRef[]) => pods.map((p) => `${p.cluster.slice(-2)}/${p.name}`);

  it("returns every pod, ordered, while within the limit", () => {
    expect(pickPods([pod("b"), pod("a", "prod-eu-z2"), pod("a")], () => false, 5).map((p) => `${p.cluster}/${p.name}`)).toEqual(["prod-eu-z1/a", "prod-eu-z1/b", "prod-eu-z2/a"]);
  });

  it("keeps the pods already streamed when there are too many, then fills up with the newest", () => {
    const pods = ["a", "b", "c", "d", "e"].map((n, k) => pod(n, "prod-eu-z1", { created: k }));
    const streamed = new Set(["a", "b"]);
    expect(pickPods(pods, (p) => streamed.has(p.name), 3).map((p) => p.name)).toEqual(["a", "b", "e"]);
    expect(pickPods(pods, () => false, 3).map((p) => p.name)).toEqual(["c", "d", "e"]);
  });

  it("lets every cluster take its turn", () => {
    const pods = ["z1", "z2", "z3"].flatMap((z) => Array.from({ length: 10 }, (_, k) => pod(`web-${k}`, `prod-eu-${z}`, { created: k })));
    const chosen = pickPods(pods, () => false, 25);
    expect(chosen).toHaveLength(25);
    for (const z of ["z1", "z2", "z3"]) expect(chosen.filter((p) => p.cluster.endsWith(z)).length, z).toBeGreaterThanOrEqual(8);
    // Newest first within a cluster.
    expect(names(chosen.filter((p) => p.cluster.endsWith("z3")))).toEqual(["z3/web-2", "z3/web-3", "z3/web-4", "z3/web-5", "z3/web-6", "z3/web-7", "z3/web-8", "z3/web-9"]);
  });

  it("prefers running pods to finished ones", () => {
    const evicted = Array.from({ length: 6 }, (_, k) => pod(`web-old-${k}`, "prod-eu-z1", { done: true, created: 100 + k }));
    const live = Array.from({ length: 4 }, (_, k) => pod(`web-new-${k}`, "prod-eu-z1", { created: k }));
    const chosen = pickPods([...evicted, ...live], () => false, 5);
    expect(chosen.filter((p) => !p.done)).toHaveLength(4);
    expect(chosen.filter((p) => p.done).map((p) => p.name)).toEqual(["web-old-5"]);
  });

  it("counts each pod's containers against the budget", () => {
    const pods = ["a", "b", "c", "d"].map((n) => pod(n));
    const containers: Record<string, number> = { a: 3, b: 1, c: 3, d: 1 };
    expect(pickPods(pods, () => false, 5, (p) => containers[p.name]).map((p) => p.name)).toEqual(["a", "b", "d"]);
    // One pod at least, even if it alone is over the budget.
    expect(pickPods([pod("big"), pod("bigger")], () => false, 2, () => 60)).toHaveLength(1);
  });
});
