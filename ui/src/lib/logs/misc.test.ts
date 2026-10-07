import { describe, expect, it } from "vitest";
import { asJsonl, asRaw, asText, clockOf, gapOf, stampOf } from "./format";
import { overlay, slicePieces, tokenize } from "./highlight";
import { histogram, LEVEL_SLOTS, stepFor, stepLabel } from "./histogram";
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
  it("chooses round buckets that fit", () => {
    expect(stepFor(60_000, 60)).toBe(2000);
    expect(stepFor(3_500_000, 120)).toBe(30_000);
    expect(stepFor(3_600_000, 120)).toBe(60_000);
    expect(stepFor(10 * 86_400_000, 100)).toBe(3 * 3_600_000);
    expect(stepFor(400 * 86_400_000, 100)).toBe(4 * 86_400_000);
    expect([stepLabel(5000), stepLabel(900_000), stepLabel(7_200_000), stepLabel(86_400_000)]).toEqual(["5s", "15m", "2h", "1d"]);
  });

  it("counts lines per bucket and level, markers apart", () => {
    const lines = [
      { key: 10_000, lvl: Level.Info },
      { key: 10_500, lvl: Level.Error },
      { key: 12_100, lvl: Level.Info },
      { key: 12_200, lvl: Level.Info, marker: true },
      { key: 19_999, lvl: Level.Warn },
    ];
    const h = histogram(lines, 10)!;
    expect(h.step).toBe(1000);
    expect(h.start).toBe(10_000);
    expect(h.n).toBe(10);
    expect(Array.from(h.totals)).toEqual([2, 0, 1, 0, 0, 0, 0, 0, 0, 1]);
    expect(h.counts[0 * LEVEL_SLOTS + Level.Error]).toBe(1);
    expect(h.max).toBe(2);
    expect(histogram([], 10)).toBeNull();
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
