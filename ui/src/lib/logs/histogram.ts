import { clockOf, dayOf } from "./format";
import type { Level } from "./parse";

// Log volume over time, by level: how many lines each stretch of time (a bar) holds. Bars are round lengths of time
// (1s, 5s, 1m, 15m…) from midnight, so their edges read well, and they are a tape: all as wide, the newest on the
// right. A bar that starts moves the others one bar to the left; the step changes only when the lines no longer fit
// (or fit in far fewer bars again).

const SECOND = 1000;
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

/**
 * The time lines (in time order) cover: from the first that has a time to the last that is no marker (markers are
 * placed by this computer's clock, which may run ahead of the cluster's). Null when there is no such line.
 */
export function extentOf(lines: readonly Timed[]): [number, number] | null {
  // (Lines without a time before any that has one have key 0: they come first.)
  let lo = 0;
  let hi = lines.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].key < 1) lo = mid + 1;
    else hi = mid;
  }
  let last = lines.length - 1;
  while (last >= lo && lines[last].marker) last--;
  return last >= lo ? [lines[lo].key, Math.max(lines[lo].key, lines[last].key)] : null;
}

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
  /** The first bar counted (see `barOf`), how many there are, and their step and offset. */
  lo: number;
  n: number;
  step: number;
  off: number;
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
  return { lo: from, n, step, off, counts, totals };
}

/** The most lines a bar from `lo` to `hi` holds. */
export function maxIn(h: Histogram, lo: number, hi: number): number {
  let max = 0;
  for (let k = Math.max(lo, h.lo) - h.lo, end = Math.min(hi, h.lo + h.n - 1) - h.lo; k <= end; k++) if (h.totals[k] > max) max = h.totals[k];
  return max;
}

/** The bars drawn: `bars` of them across the strip, of `step` (with `off`, see `barOf`), bar `right` the last. */
export interface Axis {
  step: number;
  off: number;
  right: number;
  bars: number;
}

/** The first bar drawn. */
export const leftOf = (a: Axis) => a.right - a.bars + 1;
/** Where a bar starts on a strip `w` pixels wide. */
export const xOfBar = (a: Axis, b: number, w: number) => ((b - leftOf(a)) * w) / a.bars;
/** Where a time is on it (before 0 or past `w`: off the strip). */
export const xOfTime = (a: Axis, t: number, w: number) => (((t + a.off) / a.step - leftOf(a)) * w) / a.bars;
/** The bar at `x` (the nearest one, off the strip). */
export const barAtX = (a: Axis, x: number, w: number) => leftOf(a) + Math.max(0, Math.min(a.bars - 1, Math.floor((x / w) * a.bars)));

/** A time as the axis tells it: the time of day to the second, or the date (10-08) for bars of a day or longer. */
export const timeOf = (t: number, a: Axis) => (a.step >= DAY ? dayOf(t + a.off, true).slice(5) : clockOf(t + a.off, true).slice(0, 8));

export interface Tick {
  /** Where it is (pixels), its time, and what it says. */
  x: number;
  t: number;
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
    const local = t + a.off;
    const label = every >= DAY || local % DAY === 0 ? dayOf(local, true).slice(5) : clockOf(local, true).slice(0, every < 60 * SECOND ? 8 : 5);
    out.push({ x: xOfTime(a, t, w), t, label });
  }
  return out;
}
