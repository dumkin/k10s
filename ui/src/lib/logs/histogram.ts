import { clockOf, dayOf } from "./format";
import type { Level } from "./parse";

// Log volume over time, by level: how many lines each stretch of time (a bar) holds. Bars are round lengths of time
// (1s, 5s, 1m, 15m…) from midnight, so their edges read well, and they are a tape: all as wide, the newest on the
// right. A bar that starts moves the others one bar to the left; the step changes only when the lines no longer fit
// (or fit in far fewer bars again). Bars are cut by one time zone offset, the newest line's: across a change to or
// from summer time, those before it are an hour off midnight — what they say is each moment's own time.

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const DAY = 86_400 * SECOND;
/** Bar lengths to choose from (longer ones: whole days). */
export const STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200, 86400].map((s) => s * SECOND);
/** Bars counted at most: a fine step held while the lines reach far back counts the newest of them. */
export const MAX_BARS = 4096;
/** A finer step is taken once the lines fit in this share of the bars (a full buffer's span swings by a tenth). */
const FINER = 0.75;
/** How far apart ticks may be: round lengths of time (else a multiple of the step). */
const TICKS = [...STEPS, 2 * DAY, 7 * DAY, 14 * DAY, 30 * DAY];

/** Levels counted apart (Level.None … Level.Error). */
export const LEVEL_SLOTS = 6;

export interface Timed {
  /** Unix millis (a line without a timestamp has its predecessor's; 0: there was none before it either). */
  key: number;
  lvl: Level;
  /** Not a log line (it is not counted). */
  marker?: boolean;
}

/** The time zone's offset at a time (millis to add to UTC); 0 in UTC. */
export const offsetAt = (t: number, utc: boolean) => (utc ? 0 : -new Date(t).getTimezoneOffset() * 60_000);
/** The bar a time falls in: bars of `step` from midnight, `off` being the time zone's offset. */
export const barOf = (t: number, step: number, off: number) => Math.floor((t + off) / step);
/** When a bar starts. */
export const barStart = (b: number, step: number, off: number) => b * step - off;

/** How many bars of `step` the time from `first` to `last` takes. */
const barsOf = (first: number, last: number, step: number, off: number) => barOf(last, step, off) - barOf(first, step, off) + 1;

/** The finest step in which the time from `first` to `last` takes at most `bars` bars. */
function finest(first: number, last: number, bars: number, off: number): number {
  for (const s of STEPS) if (barsOf(first, last, s, off) <= bars) return s;
  for (let d = Math.max(2, Math.floor((last - first) / DAY / bars)); ; d++) if (barsOf(first, last, d * DAY, off) <= bars) return d * DAY;
}

/**
 * The step of `bars` bars for lines from `first` to `last`: the finest they fit in. Coarser at once when they no
 * longer fit in `prev`'s bars; finer than `prev` only once they fit in 3/4 of them, so that the span of a full buffer,
 * which swings by a tenth as its oldest lines go, does not flip it back and forth.
 */
export function tapeStep(first: number, last: number, bars: number, off: number, prev: number | null): number {
  const n = Math.max(1, bars);
  const step = finest(first, last, n, off);
  if (prev === null || step >= prev || barsOf(first, last, prev, off) > n) return step;
  return Math.min(prev, finest(first, last, Math.max(1, Math.floor(n * FINER)), off));
}

export interface Histogram {
  /** The first bar counted (see `barOf`), and how many there are. */
  lo: number;
  n: number;
  /** Per bar, per level: `counts[(bar - lo) * LEVEL_SLOTS + level]`. */
  counts: Uint32Array;
  /** Lines in each bar. */
  totals: Uint32Array;
}

/**
 * Counts lines into bars `lo`…`hi` of `step` (the newest `MAX_BARS` of them). The lines may be in any order (those a
 * filter kept come before those held, and a late source's may be older than them); markers and lines without a time
 * are not counted.
 */
export function histogram(lines: readonly Timed[], step: number, off: number, lo: number, hi: number): Histogram {
  const from = Math.max(lo, hi - MAX_BARS + 1);
  const n = Math.max(0, hi - from + 1);
  const counts = new Uint32Array(n * LEVEL_SLOTS);
  const totals = new Uint32Array(n);
  for (const l of lines) {
    if (l.marker || l.key < 1) continue;
    const b = barOf(l.key, step, off) - from;
    if (b < 0 || b >= n) continue;
    counts[b * LEVEL_SLOTS + l.lvl]++;
    totals[b]++;
  }
  return { lo: from, n, counts, totals };
}

/** The most lines a bar from `lo` to `hi` holds. */
export function maxIn(h: Histogram, lo: number, hi: number): number {
  let max = 0;
  for (let k = Math.max(lo, h.lo) - h.lo, end = Math.min(hi, h.lo + h.n - 1) - h.lo; k <= end; k++) if (h.totals[k] > max) max = h.totals[k];
  return max;
}

/**
 * The line to go to for a stretch of time `t0`…`t1`: its first, else the nearest (the one before it on a tie). In any
 * order, as views are (see `histogram`).
 */
export function nearestIn<T extends Timed>(lines: readonly T[], t0: number, t1: number): T | undefined {
  let best: T | undefined;
  let far = Infinity;
  for (const l of lines) {
    const d = l.key < t0 ? t0 - l.key : l.key >= t1 ? l.key - t1 + 1 : 0;
    if (d < far || (d === 0 && far === 0 && l.key < best!.key)) {
      best = l;
      far = d;
    }
  }
  return best;
}

/**
 * The bars drawn: `bars` of them across the strip, of `step` (with `off`, see `barOf`), bar `right` the last. Times
 * are told in UTC or local time (`utc`).
 */
export interface Axis {
  step: number;
  off: number;
  right: number;
  bars: number;
  utc: boolean;
}

/** The first bar drawn. */
export const leftOf = (a: Axis) => a.right - a.bars + 1;
/** Where a bar starts on a strip `w` pixels wide (a fraction of a bar: that far into it). */
export const xOfBar = (a: Axis, b: number, w: number) => ((b - leftOf(a)) * w) / a.bars;
/** Where a time is on it (before 0 or past `w`: off the strip). */
export const xOfTime = (a: Axis, t: number, w: number) => xOfBar(a, (t + a.off) / a.step, w);
/** The bar at `x` (the nearest one, off the strip). */
export const barAtX = (a: Axis, x: number, w: number) => leftOf(a) + Math.max(0, Math.min(a.bars - 1, Math.floor((x / w) * a.bars)));
/** Bars `from`…`to` (either way round): where they are on the strip, [left, width]… */
export const spanX = (a: Axis, from: number, to: number, w: number) => {
  const x0 = xOfBar(a, Math.min(from, to), w);
  return [x0, xOfBar(a, Math.max(from, to) + 1, w) - x0] as const;
};
/** …and the time they cover, [from, to). */
export const spanTime = (a: Axis, from: number, to: number) => [barStart(Math.min(from, to), a.step, a.off), barStart(Math.max(from, to) + 1, a.step, a.off)] as const;
/** Whether a stretch of time lies wholly outside a range. */
export const outside = (range: readonly [number, number] | null, t0: number, t1: number) => !!range && (t1 <= range[0] || t0 >= range[1]);

/** A bar's date, as the axis cuts days (10-08). */
const dateOf = (t: number, a: Axis) => dayOf(t + a.off, true).slice(5);
/** A time of day, as the lines and the range picked tell it (10:42, or 10:42:05 with seconds). */
const clockAt = (t: number, a: Axis, seconds: boolean) => clockOf(t, a.utc).slice(0, seconds ? 8 : 5);

/** A time as the axis tells it: the time of day to the second, or the date for bars of a day or longer. */
export const timeOf = (t: number, a: Axis) => (a.step >= DAY ? dateOf(t, a) : clockAt(t, a, true));

export interface Tick {
  /** Where it is (pixels), and what it says. */
  x: number;
  label: string;
}

/**
 * The axis's ticks: at round times on the edges of bars (every 15 s, 5 min, 6 h…), at least `minPx` apart. They say the
 * time of day (to the second when less than a minute apart), and the date at midnight and when a day or more apart.
 */
export function ticks(a: Axis, w: number, minPx = 72): Tick[] {
  if (w <= 0) return [];
  const pxPerMs = w / a.bars / a.step;
  const every = TICKS.find((t) => t % a.step === 0 && t * pxPerMs >= minPx) ?? a.step * Math.ceil(minPx / (a.step * pxPerMs));
  const from = barStart(leftOf(a), a.step, a.off);
  const to = barStart(a.right + 1, a.step, a.off);
  const out: Tick[] = [];
  for (let t = Math.ceil((from + a.off) / every) * every - a.off; t < to; t += every) {
    const date = every >= DAY || (t + a.off) % DAY === 0;
    out.push({ x: xOfTime(a, t, w), label: date ? dateOf(t, a) : clockAt(t, a, every < MINUTE) });
  }
  return out;
}
