import { describe, expect, it } from "vitest";
import type { Line } from "../logBuffer";
import { Arrivals, Structures } from "./model";

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

describe("Arrivals", () => {
  // Streams asked for at T.
  const T = 1_700_000_000_000;
  const batch = (...l: [number, number][]) => l.map(([i, ts]): [number, number, string] => [i, ts, "line"]);
  const lags = (a: Arrivals, now: number) => a.at(now).sources;

  it("says whose lines come late, by the freshest of those that came lately", () => {
    const a = new Arrivals();
    a.ask([0, 1], T);
    // For a minute, source 0's lines come as they are written, source 1's 45 s later.
    for (let s = 1; s <= 60; s++) a.add(batch([0, T + s * 1000], [1, T + s * 1000 - 45_000]), T + s * 1000);
    expect(a.at(T + 60_000)).toEqual({ rate: 2, behind: null, sources: { 1: { behind: 45_000 } } });
    // Source 1 catches up: it is not late from then on. A batch of source 0 that comes late once is no lag.
    a.add(batch([0, T + 61_000], [1, T + 61_000]), T + 61_000);
    a.add(batch([0, T + 32_000]), T + 62_000);
    expect(lags(a, T + 62_000)).toEqual({});
  });

  it("says the view is behind when even its freshest lines come late", () => {
    const a = new Arrivals();
    a.ask([0, 1], T);
    a.add(batch([0, T], [1, T]), T);
    // The app (or the cluster) falls behind: every line comes 8 s after it was written.
    for (let s = 1; s <= 20; s++) a.add(batch([0, T + s * 1000 - 8000], [1, T + s * 1000 - 8000]), T + s * 1000);
    expect(a.at(T + 20_000)).toEqual({ rate: 2, behind: 8000, sources: { 0: { behind: 8000 }, 1: { behind: 8000 } } });
  });

  it("does not count the history read first as late, nor as written lately; old lines that keep coming are late", () => {
    const a = new Arrivals();
    a.ask([0, 1], T);
    // Both histories come at once; source 0 last wrote an hour ago.
    a.add(batch([0, T - 3_600_000], [1, T]), T);
    expect(a.at(T)).toEqual({ rate: 0.1, behind: null, sources: {} });
    // Source 1's lines keep coming, 10 minutes after they were written: three minutes on, it is as late at least as the
    // freshest of them that came in the last 10 s.
    for (let s = 1; s <= 180; s++) a.add(batch([1, T + s * 1000 - 600_000]), T + s * 1000);
    expect(lags(a, T + 180_000)).toEqual({ 0: { quiet: 3_780_000 }, 1: { behind: 171_000 } });
  });

  it("takes a history read slowly as no lateness", () => {
    const a = new Arrivals();
    a.ask([0, 1], T);
    a.add(batch([0, T]), T);
    // Source 1's history (a container quiet for ten minutes) comes 6 s after it was asked for.
    a.add(batch([1, T - 600_000]), T + 6000);
    expect(lags(a, T + 6000)).toEqual({});
  });

  it("tells how long ago a quiet source last wrote, also when every source is quiet", () => {
    const a = new Arrivals();
    a.ask([0, 1], T);
    // Only histories come: one source last wrote 3 h ago, the other 2 h ago. Neither counts as written lately.
    a.add(batch([0, T - 3 * 3_600_000], [1, T - 2 * 3_600_000]), T);
    expect(a.at(T + 1000)).toEqual({ rate: null, behind: null, sources: {} });
    expect(lags(a, T + 29_999)).toEqual({});
    expect(lags(a, T + 30_000)).toEqual({ 0: { quiet: 3 * 3_600_000 + 30_000 }, 1: { quiet: 2 * 3_600_000 + 30_000 } });
  });

  it("takes what a stream started again catches up on as no lateness", () => {
    const a = new Arrivals();
    a.ask([0, 1], T);
    a.add(batch([0, T], [1, T]), T);
    // Source 1's container restarted: it wrote its first lines at T + 30 s, and its stream was read again at T + 60 s.
    a.restart(1, T + 60_000);
    a.add(batch([0, T + 60_100], [1, T + 30_000]), T + 60_100);
    expect(lags(a, T + 60_100)).toEqual({});
  });

  it("forgets the sources no longer streamed, and reads the history of one streamed again as asked for again", () => {
    const a = new Arrivals();
    a.ask([0, 1], T);
    a.add(batch([0, T], [1, T]), T);
    a.ask([0], T + 1000);
    expect(lags(a, T + 40_000)).toEqual({ 0: { quiet: 40_000 } });
    // Back ten minutes later: its history (it last wrote five minutes ago) comes at once.
    a.ask([0, 1], T + 600_000);
    a.add(batch([1, T + 300_000]), T + 600_100);
    expect(lags(a, T + 600_100)[1]).toBeUndefined();
  });

  it("tells how long ago a source's newest line was written once nothing came from it for a while", () => {
    const a = new Arrivals();
    a.ask([0], T);
    for (let s = 0; s <= 10; s++) a.add(batch([0, T + s * 1000]), T + s * 1000);
    expect(lags(a, T + 39_999)).toEqual({});
    expect(lags(a, T + 40_000)).toEqual({ 0: { quiet: 30_000 } });
  });

  it("measures late from how late lines come at the least: a clock that differs from this one's is no lag", () => {
    const a = new Arrivals();
    a.ask([0, 1], T);
    // Every line comes 2 minutes after the time it says (this machine's clock is ahead); source 1's 20 s more.
    for (let s = 1; s <= 30; s++) a.add(batch([0, T + s * 1000 - 120_000], [1, T + s * 1000 - 140_000]), T + s * 1000);
    expect(lags(a, T + 30_000)).toEqual({ 1: { behind: 20_000 } });
  });
});
