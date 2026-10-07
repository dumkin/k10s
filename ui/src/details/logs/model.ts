import { stripAnsi } from "../../lib/ansi";
import { arrayOf, isBoolean, isNumber, isString, persisted, setting } from "../../lib/persist";
import { type FieldValue, Level, structure, type Structured } from "../../lib/logs/parse";
import { patternOf, PatternIds } from "../../lib/logs/patterns";
import { compile, isEmpty, type Query, queryKey, type Subject } from "../../lib/logs/query";
import { type Filter, type Line, type LogBuffer, plainOf, type Source } from "../logBuffer";

// What every log view shares: its settings (remembered), how a line is looked into (its fields, its pattern) and
// how the filters combine into the views the buffer keeps up to date.

export const LINE_H = 18;
/** A stack trace longer than this many lines is folded (while folding is on)… */
export const FOLD_AT = 12;
/** …to this many of its lines and a row that unfolds it. */
export const FOLD_SHOW = 6;
/** A gap this long between two lines is marked between them. */
export const GAP_MS = 60_000;

/** History to read: the last lines of each container, or the lines of a recent stretch of time. */
export const TAILS = [100, 500, 1000, 5000, 20000];
export const SINCES = [60, 300, 900, 1800, 3600, 3 * 3600, 6 * 3600, 12 * 3600, 24 * 3600];

export const [showTs, setShowTs] = setting("logs.timestamps", true, isBoolean);
export const [wrap, setWrap] = setting("logs.wrap", false, isBoolean);
export const [utc, setUtc] = setting("logs.utc", false, isBoolean);
/** Structured lines (JSON, logfmt) as their level, message and fields; plain lines coloured. Off: as written. */
export const [pretty, setPretty] = setting("logs.pretty", true, isBoolean);
export const [fold, setFold] = setting("logs.fold", true, isBoolean);
export const [histogramOpen, setHistogramOpen] = persisted("logs.histogram", true, isBoolean);
export const [matchCase, setMatchCase] = persisted("logs.matchCase", false, isBoolean);
export const [regexMode, setRegexMode] = persisted("logs.regex", false, isBoolean);
/** The query hides the lines it does not match (else it finds them: all lines stay, matches are highlighted). */
export const [filterMode, setFilterMode] = persisted("logs.filterMode", true, isBoolean);
export const [queryHistory, setQueryHistory] = persisted("logs.queries", [] as string[], arrayOf(isString));
/** Fields shown as columns (of the lines that have them). */
export const [pinned, setPinned] = setting("logs.columns", [] as string[], arrayOf(isString));
// "All lines" is deliberately not remembered: picked once for a pod, it would pull the whole history of every
// container of every workload opened afterwards.
export const [tail, setTail] = setting("logs.tail", 1000, (v): v is number => TAILS.includes(v as number));
/** A stretch of time to read instead of a number of lines (seconds; 0: off). */
export const [since, setSince] = setting("logs.since", 0, (v): v is number => isNumber(v) && (v === 0 || SINCES.includes(v)));

/** Remembers a query (most recent first, without repeats). */
export function rememberQuery(q: string) {
  const s = q.trim();
  if (!s) return;
  setQueryHistory([s, ...queryHistory().filter((x) => x !== s)].slice(0, 30));
}

export function togglePinned(key: string) {
  setPinned(pinned().includes(key) ? pinned().filter((k) => k !== key) : [...pinned(), key]);
}

/** Text of the structured lines kept parsed at most. */
const PARSED_CHARS = 16_000_000;

/**
 * Parsed structured lines, the most recent few thousand, and no more text than `maxChars` of them (parsing again is
 * cheaper than keeping them all: a few thousand lines of kilobytes each would keep their parsed fields in memory long
 * after the buffer dropped them).
 */
export class Structures {
  /** Each line's parse, and how much text it was parsed from. */
  private map = new Map<Line, [Structured | null, number]>();
  private chars = 0;
  constructor(
    private readonly max = 20_000,
    private readonly maxChars = PARSED_CHARS,
  ) {}

  get(l: Line): Structured | null {
    const hit = this.map.get(l);
    if (hit !== undefined) return hit[0];
    const s = l.marker ? null : structure(l.ansi ? stripAnsi(l.text) : l.text);
    this.map.set(l, [s, l.text.length]);
    this.chars += l.text.length;
    if (this.map.size > this.max || this.chars > this.maxChars) {
      // The oldest go, a tenth at a time.
      let n = Math.max(1, Math.floor(this.map.size / 10));
      for (const [k, [, len]] of this.map) {
        this.map.delete(k);
        this.chars -= len;
        if (--n <= 0 && this.map.size <= this.max && this.chars <= this.maxChars) break;
      }
    }
    return s;
  }

  clear() {
    this.map.clear();
    this.chars = 0;
  }
}

export interface FieldStat {
  key: string;
  /** Lines that have it. */
  n: number;
  /** Its values (at most `maxValues`), how many lines have each. */
  values: Map<string, { value: FieldValue; n: number }>;
  /** More distinct values than are kept. */
  many: boolean;
  numbers: number[];
}

/**
 * The fields of the latest `sample` structured lines of `lines` (their time aside): how many lines have each, its
 * values. Most common first. No more of them than half the text kept parsed: counted again, they are not parsed again.
 */
export function fieldStats(lines: readonly Line[], structures: Structures, sample = 3000, maxValues = 200): { structured: number; fields: FieldStat[] } {
  const fields = new Map<string, FieldStat>();
  let structured = 0;
  let chars = 0;
  for (let k = lines.length - 1, n = 0; k >= 0 && n < sample && chars < PARSED_CHARS / 2; k--, n++) {
    chars += lines[k].text.length;
    const s = structures.get(lines[k]);
    if (!s) continue;
    structured++;
    for (const [key, value] of s.fields) {
      if (key === s.timeKey) continue;
      let f = fields.get(key);
      if (!f) fields.set(key, (f = { key, n: 0, values: new Map(), many: false, numbers: [] }));
      f.n++;
      if (typeof value === "number") f.numbers.push(value);
      const text = value === null ? "null" : String(value);
      const v = f.values.get(text);
      if (v) v.n++;
      else if (f.values.size < maxValues) f.values.set(text, { value, n: 1 });
      else f.many = true;
    }
  }
  return { structured, fields: [...fields.values()].sort((a, b) => b.n - a.n || a.key.localeCompare(b.key)) };
}

/** Whether a field's values are numbers (nearly all of them, and a few). */
export const numeric = (f: FieldStat) => f.numbers.length >= f.n * 0.8 && f.numbers.length >= 3;

/** A quantile of numbers sorted. */
export const quantile = (sorted: readonly number[], p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];

/** A structured line's field: `msg` (and `message`) is its message, whatever its key. */
export function fieldOf(s: Structured | null, key: string): FieldValue | undefined {
  if (!s) return undefined;
  if ((key === "msg" || key === "message") && s.msg !== undefined) return s.msg;
  for (const [k, v] of s.fields) if (k === key) return v;
  const lower = key.toLowerCase();
  for (const [k, v] of s.fields) if (k.toLowerCase() === lower) return v;
  return undefined;
}

/** The message a line's pattern is made of: a structured line's message (with its level), else its first line. */
export function messageOf(l: Line, s: Structured | null): string {
  if (s?.msg !== undefined) return s.msg;
  if (s) return `{${s.fields.map(([k]) => k).slice(0, 8).join(", ")}}`;
  return l.ansi ? stripAnsi(l.text) : l.text;
}

/** The pattern of an entry (kept on it). */
export function patternIdOf(l: Line, ids: PatternIds, structures: Structures): number {
  if (l.pat === undefined) l.pat = ids.idOf(`${l.lvl}|${patternOf(messageOf(l, structures.get(l)))}`);
  return l.pat;
}

/** A line as a query sees it. One object for all lines: it is pointed at each in turn (no allocation per test). */
export class LineSubject implements Subject {
  l!: Line;
  constructor(
    private readonly buffer: () => LogBuffer,
    private readonly structures: Structures,
    private readonly sourceOf: (i: number) => Source | undefined,
    private readonly clusterName: (c: string) => string,
  ) {}

  text() {
    return plainOf(this.l);
  }
  lower() {
    return this.buffer().lower(this.l);
  }
  get level() {
    return this.l.lvl;
  }
  field(key: string) {
    return fieldOf(this.structures.get(this.l), key);
  }
  source(key: "pod" | "container" | "cluster" | "namespace") {
    const s = this.sourceOf(this.l.i);
    if (!s) return "";
    if (key === "pod") return s.pod;
    if (key === "container") return s.container;
    if (key === "namespace") return s.namespace;
    return `${s.cluster} ${this.clusterName(s.cluster)}`;
  }
}

/** What the lines are filtered by, beyond the query. */
export interface FilterState {
  query: Query;
  /** The query filters (else it finds). */
  filters: boolean;
  /** Levels hidden. */
  levels: ReadonlySet<Level>;
  /** Sources hidden, and the one shown alone. */
  hidden: ReadonlySet<number>;
  solo: number | null;
  /** A stretch of time picked in the histogram: [from, to) unix millis. */
  range: readonly [number, number] | null;
  /** Patterns shown alone (if any) and patterns hidden. */
  only: ReadonlySet<number>;
  hiddenPatterns: ReadonlySet<number>;
  /** Paused: what arrived after this `seq` waits. */
  pausedAt: number | null;
}

/** The filters of a log's views (see `buildFilters`). */
export interface Filters {
  patterns: Filter;
  base: Filter;
  shown: Filter;
  matches: Filter | null;
  keep: Filter | null;
  queryOn: boolean;
}

/**
 * The views a log shows, from the widest to the narrowest:
 * - `patterns`: what the patterns are counted over (all but the patterns', the levels' and the time's filters —
 *   those apply as they are counted);
 * - `base`: what the histogram and the level counts show (the levels and the time are picked there);
 * - `shown`: the lines shown;
 * - `matches`: the lines shown that the query finds (finding, not filtering), else null;
 * - `keep`: what is shown, a pause aside — what the buffer keeps when it drops the rest (null: everything is shown).
 * Markers (a container terminated…) are not matched by queries or patterns: they stay with their source's lines.
 */
export function buildFilters(st: FilterState, subject: LineSubject, patternId: (l: Line) => number): Filters {
  const q = st.query;
  const qKey = queryKey(q);
  const qTest = compile(q);
  const lineMatches = (l: Line) => {
    subject.l = l;
    return qTest(subject);
  };
  const sourceKey = st.solo !== null ? `solo${st.solo}` : st.hidden.size ? `hide${[...st.hidden].join(",")}` : "";
  const sourceOk = (l: Line) => (st.solo !== null ? l.i === st.solo : !st.hidden.has(l.i));
  const queryFilters = st.filters && qKey !== "";
  const pausedAt = st.pausedAt;

  const patternsKey = `p${pausedAt ?? ""}|${sourceKey}|${queryFilters ? qKey : ""}`;
  const patterns: Filter = {
    key: patternsKey === "p||" ? "" : patternsKey,
    test: (l) => (pausedAt === null || l.seq <= pausedAt) && sourceOk(l) && (!queryFilters || l.marker === true || lineMatches(l)),
  };
  const patternsOn = st.only.size > 0 || st.hiddenPatterns.size > 0;
  const patKey = st.only.size ? `only${[...st.only].join(",")}` : st.hiddenPatterns.size ? `hidep${[...st.hiddenPatterns].join(",")}` : "";
  const patternOk = (l: Line) => {
    if (l.marker) return true;
    const id = patternId(l);
    return st.only.size ? st.only.has(id) : !st.hiddenPatterns.has(id);
  };
  const base: Filter = patternsOn ? { key: `${patterns.key}|${patKey}`, test: (l) => patterns.test(l) && patternOk(l) } : patterns;

  const levelsOn = st.levels.size > 0;
  const range = st.range;
  const shownKey = `${levelsOn ? `l${[...st.levels].sort().join("")}` : ""}${range ? `t${range[0]}-${range[1]}` : ""}`;
  const shown: Filter = shownKey
    ? { key: `${base.key}|${shownKey}`, test: (l) => (!levelsOn || !st.levels.has(l.lvl)) && (!range || (l.key >= range[0] && l.key < range[1])) && base.test(l) }
    : base;

  const matches: Filter | null = !st.filters && qKey !== "" ? { key: `${shown.key}|m${qKey}`, test: (l) => !l.marker && shown.test(l) && lineMatches(l) } : null;
  // What the filters show, a pause aside (null: everything): the buffer keeps it when it drops the rest.
  const keep: Filter | null = pausedAt === null ? (shown.key ? shown : null) : buildFilters({ ...st, pausedAt: null }, subject, patternId).keep;
  return { patterns, base, shown, matches, keep, queryOn: !isEmpty(q) };
}

export const LEVEL_COLORS: Record<Level, string> = {
  [Level.None]: "var(--log-other)",
  [Level.Trace]: "var(--log-trace)",
  [Level.Debug]: "var(--log-debug)",
  [Level.Info]: "var(--log-info)",
  [Level.Warn]: "var(--warn)",
  [Level.Error]: "var(--err)",
};
