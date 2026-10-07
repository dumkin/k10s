import { describe, expect, it } from "vitest";
import type { Line } from "../logBuffer";
import { Lags, Structures } from "./model";

const line = (text: string): Line => ({ i: 0, ts: 0, key: 0, text, width: text.length, lvl: 0, ansi: false, pos: 0, seq: 0 });

describe("Structures", () => {
  it("keeps the parses of so many lines, and of so much text, the oldest going first", () => {
    const few = new Structures(10, 1e9);
    const lines = Array.from({ length: 30 }, (_, k) => line(`{"k":${k}}`));
    for (const l of lines) few.get(l);
    expect(few.get(lines[29])).toEqual({ kind: "json", fields: [["k", 29]] });
    const big = `{"v":"${"x".repeat(1000)}"}`;
    const small = new Structures(1000, 5000);
    const huge = Array.from({ length: 20 }, () => line(big));
    for (const l of huge) small.get(l);
    // At most five of them held (a tenth goes at a time): the first one is parsed anew, the same as before.
    const first = small.get(huge[0]);
    expect(first?.fields[0][0]).toBe("v");
    expect((small as unknown as { chars: number }).chars).toBeLessThanOrEqual(5000 + big.length);
  });
});

describe("Lags", () => {
  // A stream asked for at T.
  const T = 1_700_000_000_000;
  const batch = (...l: [number, number][]) => l.map(([i, ts]): [number, number, string] => [i, ts, "line"]);

  it("says whose lines come late, by the freshest of those that came lately", () => {
    const lags = new Lags();
    lags.ask([0, 1], T);
    // For a minute, source 0's lines come as they are written, source 1's 45 s later.
    for (let s = 1; s <= 60; s++) lags.add(batch([0, T + s * 1000], [1, T + s * 1000 - 45_000]), T + s * 1000, 0);
    expect(lags.at(T + 60_000)).toEqual({ 1: { behind: 45_000 } });
    // Source 1 catches up: it is not late from then on. A batch of source 0 that comes late once is no lag.
    lags.add(batch([0, T + 61_000], [1, T + 61_000]), T + 61_000, 0);
    lags.add(batch([0, T + 32_000]), T + 62_000, 0);
    expect(lags.at(T + 62_000)).toEqual({});
  });

  it("counts lines written before the stream was asked for as due then: the history read first is not late, more of it coming on is", () => {
    const lags = new Lags();
    lags.ask([0, 1], T);
    // Both histories come at once; source 0 last wrote an hour ago.
    lags.add(batch([0, T - 3_600_000], [1, T]), T + 100, 0);
    expect(lags.at(T + 100)).toEqual({});
    // Source 1's lines keep coming, 10 minutes after they were written: three minutes on, it is as late at least as the
    // freshest of them that came in the last 10 s.
    for (let s = 1; s <= 180; s++) lags.add(batch([1, T + s * 1000 - 600_000]), T + s * 1000, 0);
    expect(lags.at(T + 180_000)).toEqual({ 0: { quiet: 3_780_000 }, 1: { behind: 170_000 } });
  });

  it("reads the history of a source streamed again as asked for again", () => {
    const lags = new Lags();
    lags.ask([0], T);
    lags.add(batch([0, T]), T, 0);
    lags.ask([], T + 1000);
    // Back ten minutes later: its history (it last wrote five minutes ago) comes at once.
    lags.ask([0], T + 600_000);
    lags.add(batch([0, T + 300_000]), T + 600_100, 0);
    expect(lags.at(T + 600_100)).toEqual({});
  });

  it("tells how long ago a source's newest line was written once nothing came from it for a while", () => {
    const lags = new Lags();
    lags.ask([0], T);
    for (let s = 0; s <= 10; s++) lags.add(batch([0, T + s * 1000]), T + s * 1000, 0);
    expect(lags.at(T + 39_999)).toEqual({});
    expect(lags.at(T + 40_000)).toEqual({ 0: { quiet: 30_000 } });
  });

  it("measures late from how late lines come at the least: a clock that differs from this one's is no lag", () => {
    const lags = new Lags();
    lags.ask([0, 1], T);
    // Every line comes 2 minutes after the time it says (this machine's clock is ahead); source 1's 20 s more.
    for (let s = 1; s <= 30; s++) lags.add(batch([0, T + s * 1000 - 120_000], [1, T + s * 1000 - 140_000]), T + s * 1000, 120_000);
    expect(lags.at(T + 30_000)).toEqual({ 1: { behind: 20_000 } });
  });
});
