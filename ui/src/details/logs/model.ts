import { stripAnsi } from "../../lib/ansi";
import type { LogLine } from "../../lib/backend";
import { humanDuration } from "../../lib/format";
import { arrayOf, isBoolean, isNumber, isString, persisted, setting } from "../../lib/persist";
import { recentList } from "../../lib/recent";
import { registerCommands } from "../../state/commands";
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
/** Queries used lately, in any log (↑ in the query, or a click on its icon). */
export const recentQueries = recentList("logs.queries", 30);

/** The palette's way to forget them all (the menu's "Forget all" is a click). */
export function registerRecentQueryCommands(): () => void {
  return registerCommands(() =>
    recentQueries.list().length
      ? [{ id: "logs:forget-queries", title: "Forget recent log queries", section: "Logs", icon: "trash", keywords: ["history", "clear", "recent", "query", "search"], run: () => recentQueries.clear() }]
      : [],
  );
}
/** Fields shown as columns (of the lines that have them). */
export const [pinned, setPinned] = setting("logs.columns", [] as string[], arrayOf(isString));
// "All lines" is deliberately not remembered: picked once for a pod, it would pull the whole history of every
// container of every workload opened afterwards.
export const [tail, setTail] = setting("logs.tail", 1000, (v): v is number => TAILS.includes(v as number));
/** A stretch of time to read instead of a number of lines (seconds; 0: off). */
export const [since, setSince] = setting("logs.since", 0, (v): v is number => isNumber(v) && (v === 0 || SINCES.includes(v)));

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

/** Lines coming this long after they were written: the view says how far behind it is, and so does each source. */
const BEHIND_MS = 5000;
/** A source nothing came from for this long says how long ago its newest line was written. */
const QUIET_MS = 30_000;
/** The seconds the rate is of (the whole ones before this one); a source is as late as the freshest of its lines in as many… */
const WINDOW_S = 10;
/** …and the view as late as the freshest of all in the last few. */
const RECENT_S = 3;
/** Lines written up to this long before their stream was asked for count as written after it (the request's own way). */
const ASKED_SLACK_MS = 2000;

/** How late a source's lines come (ms, when late enough to tell), or, when nothing comes, how long ago its newest line was written. */
export type Lag = { behind: number } | { quiet: number };

/** "45s behind". */
export const behindText = (ms: number) => `${humanDuration(ms / 1000)} behind`;

/** How the lines of a view come (see `Arrivals.view`). */
export interface ViewMeter {
  /** Lines a second, of the last 10 whole seconds, written since their streams were asked for; null when none came. */
  rate: number | null;
  /** How long after they were written the freshest lines came (ms), when late enough to tell. */
  behind: number | null;
}

/**
 * What came in each of the last seconds: slot `second % SLOTS` holds that second's (`secs`), a slot holding an older
 * one is from a round before. A fixed few numbers, however many lines come: nothing to allocate or drop as they do.
 */
const SLOTS = WINDOW_S + 1;
const slots = () => new Float64Array(SLOTS).fill(-Infinity);
const toSecond = (ms: number) => Math.floor(ms / 1000) * 1000;

/** A source's stream, as its lines come. */
interface Stream {
  /** When it was asked for, or started again (its container restarted, it reconnected)… */
  asked: number;
  /** …and when its first lines came since: lines written before it was asked for are due then. */
  start: number | null;
  /** When its newest line was written, and when lines of it last came. */
  newest: number;
  came: number;
  /** How late its lines came in each second (see `SLOTS`): the least of those written since it was asked for, of the older ones. */
  secs: Float64Array;
  late: Float64Array;
  old: Float64Array;
  /** The batch taken in last, the newest of its lines in it, and from when they count as written since it was asked for. */
  batch: number;
  batchNewest: number;
  liveFrom: number;
}

/**
 * How the lines of a stream come: how many a second, and how late — the view's and each source's. A full view drops
 * the lines written first, of all sources: those of a source whose lines come late go first, as soon as they come
 * once they are later than the stretch of time it holds. Late is measured from how late lines come at the least (the
 * floor), so a clock that differs from this one's is no lag. A line is due once it was written; one written before
 * its stream was asked for (the history read first, what a stream started again catches up on), once that stream's
 * first lines came: reading is not lateness, old lines that keep coming are. When nothing comes, a stream held up and
 * a container that writes nothing look the same: how long ago its newest line was written is what is known.
 */
export class Arrivals {
  /**
   * How late lines came at the least. Until a line written lately came, it is the age of the newest line read first:
   * lateness, which nothing written lately can show then, takes it whole; what was written since a stream was asked
   * for, and how long ago, take it only when it is below 0 (a clock ahead of this one's).
   */
  private floor = Infinity;
  /** The sources streamed now, by id. */
  private streams: (Stream | undefined)[] = [];
  /** In each second (see `SLOTS`): the lines written since their streams were asked for, and how late the freshest came. */
  private secs = slots();
  private live = new Float64Array(SLOTS);
  private fresh = new Float64Array(SLOTS);
  private batches = 0;
  /** (The sources of the batch being taken in.) */
  private touched: Stream[] = [];
  /** The sources whose lines came, by id (also those no longer streamed). */
  private writers: boolean[] = [];

  /** Whether lines of a source came (a container that comes back "runs again", else it "started"). */
  wrote(i: number): boolean {
    return this.writers[i] === true;
  }

  /** The sources streamed from `at` on: those new to it were asked for then, those it no longer has are forgotten. */
  ask(ids: readonly number[], at: number) {
    const streams: (Stream | undefined)[] = [];
    for (const i of ids)
      streams[i] = this.streams[i] ?? {
        asked: at,
        start: null,
        newest: -Infinity,
        came: -Infinity,
        secs: slots(),
        late: new Float64Array(SLOTS),
        old: new Float64Array(SLOTS),
        batch: 0,
        batchNewest: -Infinity,
        liveFrom: at,
      };
    this.streams = streams;
  }

  /** A source's stream started (again) `at`: what it reads first was written before. */
  restart(i: number, at: number) {
    const s = this.streams[i];
    if (!s) return;
    s.asked = at;
    s.start = null;
  }

  /** A batch came `now`. */
  add(batch: readonly LogLine[], now: number) {
    // One pass over the lines. (What counts as written since a stream was asked for takes the floor as it was before the
    // batch: the batch changes it only once a line written lately came, or a clock ahead.)
    const ahead = Math.min(0, this.floor);
    const n = ++this.batches;
    const touched = this.touched;
    let newest = -Infinity;
    let live = 0;
    for (const l of batch) {
      const ts = l[1];
      if (ts !== null && ts > newest) newest = ts;
      const s = this.streams[l[0]];
      if (!s) {
        // (The last lines of a stream stopped.)
        this.writers[l[0]] = true;
        continue;
      }
      if (s.batch !== n) {
        s.batch = n;
        s.batchNewest = -Infinity;
        s.liveFrom = s.asked - ASKED_SLACK_MS - ahead;
        this.writers[l[0]] = true;
        touched.push(s);
      }
      if (ts === null) live++;
      else {
        if (ts > s.batchNewest) s.batchNewest = ts;
        if (ts >= s.liveFrom) live++;
      }
    }
    if (newest > -Infinity) this.floor = Math.min(this.floor, now - newest);
    const sec = Math.floor(now / 1000);
    const k = sec % SLOTS;
    if (this.secs[k] !== sec) {
      this.secs[k] = sec;
      this.live[k] = 0;
      this.fresh[k] = Infinity;
    }
    this.live[k] += live;
    for (const s of touched) {
      s.came = now;
      const start = (s.start ??= now);
      const ts = s.batchNewest;
      if (ts === -Infinity) continue;
      s.newest = Math.max(s.newest, ts);
      if (s.secs[k] !== sec) {
        s.secs[k] = sec;
        s.late[k] = Infinity;
        s.old[k] = Infinity;
      }
      if (ts + this.floor >= s.asked - ASKED_SLACK_MS) {
        const lag = Math.max(0, now - ts - this.floor);
        if (lag < s.late[k]) s.late[k] = lag;
        if (lag < this.fresh[k]) this.fresh[k] = lag;
      } else {
        const lag = Math.max(0, now - start);
        if (lag < s.old[k]) s.old[k] = lag;
      }
    }
    touched.length = 0;
  }

  /** How the view's lines come, at `now` (what the meter shows every second: a few numbers, however many sources). */
  view(now: number): ViewMeter {
    const sec = Math.floor(now / 1000);
    let lines = 0;
    let freshest = Infinity;
    for (let k = 0; k < SLOTS; k++) {
      const age = sec - this.secs[k];
      if (age >= 1 && age <= WINDOW_S) lines += this.live[k];
      if (age >= 0 && age < RECENT_S && this.fresh[k] < freshest) freshest = this.fresh[k];
    }
    return { rate: lines ? lines / WINDOW_S : null, behind: freshest >= BEHIND_MS && freshest < Infinity ? freshest : null };
  }

  /**
   * Each source's lag at `now`, by id; those neither late nor quiet are left out. To the second, as it is shown: a lag
   * that does not change what is shown does not change.
   */
  sources(now: number): Record<number, Lag> {
    const sec = Math.floor(now / 1000);
    const out: Record<number, Lag> = {};
    for (let i = 0; i < this.streams.length; i++) {
      const s = this.streams[i];
      if (!s || s.came === -Infinity) continue;
      // The freshest of its lines that came lately (a batch that came late once is no lag): of those written since its
      // stream was asked for, else of the old ones that keep coming.
      let late = Infinity;
      let old = Infinity;
      for (let k = 0; k < SLOTS; k++) {
        const age = sec - s.secs[k];
        if (age < 0 || age >= WINDOW_S) continue;
        if (s.late[k] < late) late = s.late[k];
        if (s.old[k] < old) old = s.old[k];
      }
      if (late === Infinity) late = old;
      if (late >= BEHIND_MS && late < Infinity) out[i] = { behind: toSecond(late) };
      else if (now - s.came >= QUIET_MS && s.newest > -Infinity) out[i] = { quiet: toSecond(now - s.newest - Math.min(0, this.floor)) };
    }
    return out;
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
