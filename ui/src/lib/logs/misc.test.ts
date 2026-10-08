import { describe, expect, it } from "vitest";
import { asJsonl, asRaw, asText, clockOf, gapOf, stampOf } from "./format";
import { overlay, slicePieces, tokenize } from "./highlight";
import { type Axis, barAtX, barOf, barStart, extentOf, histogram, LEVEL_SLOTS, MAX_BARS, maxIn, offsetAt, tapeStep, ticks, timeOf, xOfBar, xOfTime } from "./histogram";
import { Level } from "./parse";
import { PatternIds, patternOf, patternParts } from "./patterns";

describe("patterns", () => {
  it("masks what varies between lines of one statement", () => {
    expect(patternOf("served request in 12ms for user 42")).toBe("served request in <*> for user <*>");
    expect(patternOf("served request in 7ms for user 1093")).toBe(patternOf("served request in 12ms for user 42"));
    expect(patternOf("2026-10-04T10:42:01.123Z GET /api/v1/orders/123 from 10.0.0.12:5432")).toBe("<*> GET /api/v<*>/orders/<*> from <*>");
    expect(patternOf("job 9f8e7d6c5b4a3f2e done, trace 0b5c5d2e-7a1f-4c1e-9f0a-2b3c4d5e6f70")).toBe("job <*> done, trace <*>");
    expect(patternOf("pod web-7f9c8d6b5-x2k4q restarted")).toBe("pod <*> restarted");
    // Different statements stay apart.
    expect(patternOf("upstream payments returned 503")).not.toBe(patternOf("upstream ledger returned 503"));
    expect(patternOf("")).toBe("(empty line)");
  });

  it("gives patterns stable ids and splits them for showing", () => {
    const ids = new PatternIds();
    expect([ids.idOf("a <*>"), ids.idOf("b"), ids.idOf("a <*>")]).toEqual([0, 1, 0]);
    expect(patternParts("GET <*> took <*>")).toEqual([
      { text: "GET ", wild: false },
      { text: "<*>", wild: true },
      { text: " took ", wild: false },
      { text: "<*>", wild: true },
    ]);
  });
});

describe("histogram", () => {
  const S = 1000;
  const HOUR = 3_600_000;
  const DAY = 86_400_000;

  it("puts bars at round times from midnight, in the time zone's", () => {
    // 08:45 UTC is 14:15 at +5:30: its hour starts at 14:00 there, 08:30 UTC.
    const t = Date.UTC(2026, 9, 8, 8, 45);
    expect(barStart(barOf(t, HOUR, 5.5 * HOUR), HOUR, 5.5 * HOUR)).toBe(Date.UTC(2026, 9, 8, 8, 30));
    // At -3:00 its day starts at midnight there, 03:00 UTC.
    expect(barStart(barOf(t, DAY, -3 * HOUR), DAY, -3 * HOUR)).toBe(Date.UTC(2026, 9, 8, 3));
    expect(offsetAt(t, true)).toBe(0);
  });

  it("takes the finest step the lines fit in: coarser at once, finer only with room to spare", () => {
    // 10.5 s … 20.4 s takes 11 bars of a second (from 10 to 20), not 10.
    expect(tapeStep(10_500, 20_400, 10, 0, null)).toBe(2000);
    expect(tapeStep(10_500, 20_400, 11, 0, null)).toBe(1000);
    // Lines that outgrow the bars of 2 s: 5 s at once.
    expect(tapeStep(0, 30 * S, 10, 0, 2000)).toBe(5000);
    // 9 s fit in 10 bars of a second, but not in 3/4 of them: 2 s stay; 7 s do.
    expect(tapeStep(0, 8_999, 10, 0, 2000)).toBe(2000);
    expect(tapeStep(0, 6_999, 10, 0, 2000)).toBe(1000);
    // With no step before: the finest.
    expect(tapeStep(0, 8_999, 10, 0, null)).toBe(1000);
  });

  it("keeps its step while a full buffer's span swings by a tenth where the step would change", () => {
    // 100 bars hold 100 s at 1 s: the span goes from 101 s to 90 s and back as the oldest lines go.
    const steps = new Set<number>();
    let step: number | null = null;
    for (let k = 0; k < 50; k++) {
      step = tapeStep(1_000_000, 1_000_000 + (k % 2 ? 90_000 : 101_000), 100, 0, step);
      steps.add(step);
    }
    expect([...steps]).toEqual([2000]);
  });

  it("counts whole days past the longest step", () => {
    expect(tapeStep(0, 10 * DAY, 100, 0, null)).toBe(3 * HOUR);
    expect(tapeStep(0, 399 * DAY, 100, 0, null)).toBe(4 * DAY);
    // 400 days take 101 bars of 4 days (from 0 to 100).
    expect(tapeStep(0, 400 * DAY, 100, 0, null)).toBe(5 * DAY);
  });

  it("covers the lines from the first that has a time to the last that is no marker", () => {
    expect(
      extentOf([
        { key: 0, lvl: Level.Info },
        { key: 0, lvl: Level.Info },
        { key: 5000, lvl: Level.Info },
        { key: 9000, lvl: Level.Warn },
        { key: 60_000, lvl: Level.Info, marker: true },
      ]),
    ).toEqual([5000, 9000]);
    expect([extentOf([]), extentOf([{ key: 0, lvl: Level.Info }]), extentOf([{ key: 5000, lvl: Level.Info, marker: true }])]).toEqual([null, null, null]);
  });

  it("counts lines per bar and level, in any order, markers and lines without a time apart", () => {
    const lines = [
      // (Kept for a filter: before a late source's older lines.)
      { key: 12_100, lvl: Level.Info },
      { key: 10_000, lvl: Level.Info },
      { key: 10_500, lvl: Level.Error },
      { key: 12_200, lvl: Level.Info, marker: true },
      { key: 0, lvl: Level.Info },
      { key: 19_999, lvl: Level.Warn },
      { key: 25_000, lvl: Level.Warn },
    ];
    const h = histogram(lines, 1000, 0, 10, 19);
    expect([h.lo, h.n]).toEqual([10, 10]);
    expect(Array.from(h.totals)).toEqual([2, 0, 1, 0, 0, 0, 0, 0, 0, 1]);
    expect(h.counts[0 * LEVEL_SLOTS + Level.Error]).toBe(1);
    expect([maxIn(h, 10, 19), maxIn(h, 11, 19), maxIn(h, 30, 40)]).toEqual([2, 1, 0]);
    // The newest MAX_BARS at most.
    const wide = histogram(lines, 1, 0, 0, 30_000);
    expect([wide.lo, wide.n]).toEqual([30_000 - MAX_BARS + 1, MAX_BARS]);
  });

  it("draws bars of one width, the newest on the right: one that starts moves each a bar to the left", () => {
    const a: Axis = { step: 1000, off: 0, right: 99, bars: 100 };
    expect([xOfBar(a, 99, 600), xOfBar(a, 100, 600), xOfTime(a, 99_500, 600)]).toEqual([594, 600, 597]);
    expect([barAtX(a, 599.9, 600), barAtX(a, 594, 600), barAtX(a, 593.9, 600), barAtX(a, 0, 600)]).toEqual([99, 99, 98, 0]);
    // Off the strip: the bar at its edge.
    expect([barAtX(a, -20, 600), barAtX(a, 700, 600)]).toEqual([0, 99]);
    for (const b of [0, 37, 99]) expect(barAtX(a, xOfBar(a, b, 600) + 3, 600)).toBe(b);
    const next = { ...a, right: 100 };
    for (const b of [10, 50, 99]) expect(xOfBar(a, b, 600) - xOfBar(next, b, 600)).toBeCloseTo(6);
  });

  it("ticks at round times so far apart, saying the time of day, or the date at midnight", () => {
    // 100 bars of a second on 600 px: a second takes 6 px, ticks come every 15 s.
    const a: Axis = { step: 1000, off: 0, right: Date.UTC(2026, 9, 8, 10, 42, 30) / 1000, bars: 100 };
    expect(ticks(a, 600).map((t) => t.label)).toEqual(["10:41:00", "10:41:15", "10:41:30", "10:41:45", "10:42:00", "10:42:15", "10:42:30"]);
    expect(ticks(a, 600)[0].x).toBe(54);
    // Hours at +5:30, 6 px each: every 12 h of the time there, the date at midnight.
    const off = 5.5 * HOUR;
    const b: Axis = { step: HOUR, off, right: barOf(Date.UTC(2026, 9, 8, 12), HOUR, off), bars: 100 };
    expect(ticks(b, 600).map((t) => t.label)).toEqual(["10-05", "12:00", "10-06", "12:00", "10-07", "12:00", "10-08", "12:00"]);
    // Bars of 4 days: ticks on their edges, dates.
    const c: Axis = { step: 4 * DAY, off: 0, right: 5000, bars: 100 };
    const days = ticks(c, 600);
    expect(days.length).toBeGreaterThan(3);
    for (const t of days) expect([t.label.length, (t.t / DAY) % 4]).toEqual([5, 0]);
    for (const set of [ticks(a, 600), ticks(b, 600), days]) for (let k = 1; k < set.length; k++) expect(set[k].x - set[k - 1].x).toBeGreaterThanOrEqual(72);
  });

  it("tells a bar's time as the axis does", () => {
    const t = Date.UTC(2026, 9, 8, 8, 45, 5);
    expect(timeOf(t, { step: 1000, off: 5.5 * HOUR, right: 0, bars: 1 })).toBe("14:15:05");
    expect(timeOf(t, { step: DAY, off: 0, right: 0, bars: 1 })).toBe("10-08");
  });
});

describe("format", () => {
  const ts = Date.UTC(2026, 9, 4, 10, 42, 1, 23);
  it("writes times by hand, local or UTC", () => {
    expect(clockOf(ts, true)).toBe("10:42:01.023");
    expect(stampOf(ts, true)).toBe("2026-10-04 10:42:01.023Z");
    expect([gapOf(450), gapOf(12_000), gapOf(250_000), gapOf(7_500_000), gapOf(90_000_000)]).toEqual(["450ms", "12s", "4m 10s", "2h 5m", "1d 1h"]);
  });

  it("exports lines as shown, as written, and as JSON Lines", () => {
    const lines = [
      { i: 0, ts, text: "\x1b[31mERROR\x1b[0m boom", more: ["\tat a.b(C.java:1)"], lvl: Level.Error },
      { i: 1, ts: ts + 1, text: '{"level":"info","msg":"ok"}', lvl: Level.Info },
      { i: 0, ts: ts + 2, text: "container terminated: Error (exit code 1)", lvl: Level.Error, marker: true },
    ];
    expect(asText(lines, { timestamps: true, utc: true, label: (i) => `p${i}` })).toBe(
      "2026-10-04 10:42:01.023Z p0 ERROR boom\n\tat a.b(C.java:1)\n2026-10-04 10:42:01.024Z p1 {\"level\":\"info\",\"msg\":\"ok\"}\n2026-10-04 10:42:01.025Z p0 ── container terminated: Error (exit code 1) ──\n",
    );
    expect(asRaw(lines)).toBe('\x1b[31mERROR\x1b[0m boom\n\tat a.b(C.java:1)\n{"level":"info","msg":"ok"}\n');
    const jsonl = asJsonl(lines, (i) => ({ cluster: "c", namespace: "n", pod: `p${i}`, container: "app" }))
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(jsonl[0]).toEqual({ time: "2026-10-04T10:42:01.023Z", cluster: "c", namespace: "n", pod: "p0", container: "app", level: "error", line: "ERROR boom\n\tat a.b(C.java:1)" });
    expect(jsonl[1].json).toEqual({ level: "info", msg: "ok" });
    expect(jsonl[2]).toMatchObject({ level: "error", event: "container terminated: Error (exit code 1)" });
  });
});

describe("highlight", () => {
  it("colours tokens of plain lines", () => {
    const p = tokenize('2026-10-04T10:42:01Z ERROR user=bob took 12ms from 10.0.0.1 "quoted" true https://x.io/a');
    const of = (cls: string) => p.filter((x) => x.cls === cls).map((x) => x.text);
    expect(of("t-time")).toEqual(["2026-10-04T10:42:01Z"]);
    expect(of("t-err")).toEqual(["ERROR"]);
    expect(of("t-key")).toEqual(["user"]);
    expect(of("t-num")).toEqual(["12ms"]);
    expect(of("t-id")).toEqual(["10.0.0.1"]);
    expect(of("t-str")).toEqual(['"quoted"']);
    expect(of("t-kw")).toEqual(["true"]);
    expect(of("t-url")).toEqual(["https://x.io/a"]);
    expect(p.map((x) => x.text).join("")).toBe('2026-10-04T10:42:01Z ERROR user=bob took 12ms from 10.0.0.1 "quoted" true https://x.io/a');
  });

  it("marks matches across pieces", () => {
    const out = overlay([{ text: "abc", cls: "a" }, { text: "def" }], [[2, 4]]);
    expect(out).toEqual([
      { text: "ab", cls: "a" },
      { text: "c", cls: "a", mark: true },
      { text: "d", mark: true },
      { text: "ef" },
    ]);
    expect(overlay([{ text: "x" }], [])).toEqual([{ text: "x" }]);
  });

  it("slices pieces by offsets, keeping what each piece is", () => {
    const pieces = [{ text: "abc", cls: "a" }, { text: "def", field: "k", value: "def" }, { text: "gh", mark: true }];
    expect(slicePieces(pieces, 2, 7)).toEqual([
      { text: "c", cls: "a" },
      { text: "def", field: "k", value: "def" },
      { text: "g", mark: true },
    ]);
    // Whole pieces are the same objects; nothing past the end, nothing before the start.
    expect(slicePieces(pieces, 3, 6)[0]).toBe(pieces[1]);
    expect(slicePieces(pieces, 0, 100).map((p) => p.text).join("")).toBe("abcdefgh");
    expect(slicePieces(pieces, 8, 20)).toEqual([]);
    expect(slicePieces(pieces, 4, 4)).toEqual([]);
    // ANSI colours go with their text.
    const style = { color: "red" };
    expect(slicePieces([{ text: "abcdef", style }], 1, 3)).toEqual([{ text: "bc", style }]);
  });

  it("colours as far as the line is drawn, the rest plain", () => {
    const text = `${'"a" 12 '.repeat(20)}tail`;
    const some = tokenize(text, 14);
    expect(some.map((p) => p.text).join("")).toBe(text);
    expect(some.filter((p) => p.cls).length).toBe(4);
    expect(some[some.length - 1]).toEqual({ text: text.slice(13) });
    expect(tokenize(text).filter((p) => p.cls).length).toBe(40);
  });
});
