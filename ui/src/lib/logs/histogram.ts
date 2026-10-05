import type { Level } from "./parse";

// Log volume over time, by level: how many lines each stretch of time (a bucket) holds. Buckets are round lengths
// of time (1s, 5s, 1m, 15m…) so their edges read well; counted in one pass over lines in time order.

const SECOND = 1000;
/** Bucket lengths to choose from. */
export const STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200, 86400].map((s) => s * SECOND);

/** The shortest step that keeps a span of time within `maxBuckets` buckets. */
export function stepFor(spanMs: number, maxBuckets: number): number {
  const n = Math.max(1, maxBuckets);
  for (const s of STEPS) if (spanMs / s < n) return s;
  const day = STEPS[STEPS.length - 1];
  return day * Math.ceil(spanMs / n / day);
}

/** Levels counted apart (Level.None … Level.Error). */
export const LEVEL_SLOTS = 6;

export interface Histogram {
  /** Start of the first bucket (unix millis) and the length of each. */
  start: number;
  step: number;
  /** Buckets. */
  n: number;
  /** Per bucket, per level: `counts[bucket * LEVEL_SLOTS + level]`. */
  counts: Uint32Array;
  /** Lines in each bucket. */
  totals: Uint32Array;
  /** The fullest bucket. */
  max: number;
}

export interface Timed {
  /** Unix millis (a line without a timestamp has its predecessor's). */
  key: number;
  lvl: Level;
  /** Not a log line (it is not counted). */
  marker?: boolean;
}

/**
 * Counts `lines` (in time order) into at most `maxBuckets` buckets covering `from`…`to` (default: the lines' own
 * span). Null when there is nothing to count.
 */
export function histogram(lines: readonly Timed[], maxBuckets: number, from?: number, to?: number): Histogram | null {
  if (!lines.length) return null;
  const first = from ?? lines[0].key;
  const last = Math.max(to ?? lines[lines.length - 1].key, first);
  if (!first) return null;
  const step = stepFor(Math.max(last - first, SECOND), maxBuckets);
  const start = Math.floor(first / step) * step;
  const n = Math.floor((last - start) / step) + 1;
  const counts = new Uint32Array(n * LEVEL_SLOTS);
  const totals = new Uint32Array(n);
  for (const l of lines) {
    if (l.marker) continue;
    const b = Math.floor((l.key - start) / step);
    if (b < 0 || b >= n) continue;
    counts[b * LEVEL_SLOTS + l.lvl]++;
    totals[b]++;
  }
  let max = 0;
  for (let b = 0; b < n; b++) if (totals[b] > max) max = totals[b];
  return { start, step, n, counts, totals, max };
}

/** A step as words: "5s", "15m", "1h". */
export function stepLabel(step: number): string {
  const s = step / SECOND;
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${s / 60}m`;
  if (s < 86400) return `${s / 3600}h`;
  return `${s / 86400}d`;
}
