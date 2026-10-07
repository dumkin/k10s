import { hasAnsi, stripAnsi } from "../lib/ansi";
import type { LogLine, LogTarget } from "../lib/backend";
import { follows, Level, levelOf, startsStack } from "../lib/logs/parse";

/** The buffer keeps at most this many entries… */
export const MAX_LINES = 100_000;
/** …and about this much text (UTF-16 code units, plus bookkeeping per entry); the oldest entries go first. */
export const MAX_BYTES = 64 * 1024 * 1024;
const LINE_OVERHEAD = 64;
/** An entry takes at most this many continuation lines; more start an entry of their own. */
export const MAX_MORE = 400;
/** A buffer whose lines are being read may grow to this many times its budget before those lines are dropped too. */
export const HOLD_OVER = 1.5;

/**
 * An entry of the log: a line as the container wrote it, with the lines that continue it (a stack trace) — or a
 * marker: something that happened to its stream (the container terminated, the pod was deleted).
 */
export interface Line {
  /** Source: the id of the log target. */
  i: number;
  ts: number | null;
  /** Place in the timeline: the timestamp, or for a line without one the previous line's of its source. */
  key: number;
  text: string;
  /** Length without ANSI escapes (for wrapped-height estimates). */
  width: number;
  lvl: Level;
  ansi: boolean;
  /** Absolute position in the buffer (entries dropped before it included). */
  pos: number;
  /** Arrival order: what came after a pause is told apart by it. */
  seq: number;
  /** Continuation lines (as written) and their plain lengths. */
  more?: string[];
  moreWidth?: number[];
  /** A stack trace: unindented lines that start no entry belong to it too. */
  stack?: boolean;
  /** Not a log line: what happened to the source's stream. */
  marker?: boolean;
  /** The whole entry's plain text in lower case, made on the first search that needs it. */
  lower?: string;
  /** Its pattern (see lib/logs/patterns), once asked for. */
  pat?: number;
  /** Dropped from the timeline but kept: a filter showed it (see `LogBuffer.kept`). */
  kept?: boolean;
}

/** A marker among earlier lines (see `LogBuffer.addEarlier`): after the lines of its source at `ts`. */
export interface EarlierMarker {
  i: number;
  ts: number;
  text: string;
  lvl: Level;
}

/** A filter of a buffer's entries: the same key, the same entries. */
export interface Filter {
  key: string;
  test(l: Line): boolean;
}

/** Everything. */
export const ALL: Filter = { key: "", test: () => true };

function size(l: Line): number {
  let n = l.text.length + LINE_OVERHEAD;
  if (l.more) for (const m of l.more) n += m.length + 16;
  if (l.lower !== undefined && l.lower !== l.text) n += l.lower.length;
  return n;
}

/** The entry's plain text: its lines without ANSI escapes, joined by line breaks. */
export function plainOf(l: Line): string {
  const head = l.ansi ? stripAnsi(l.text) : l.text;
  if (!l.more?.length) return head;
  return [head, ...l.more.map((m) => (hasAnsi(m) ? stripAnsi(m) : m))].join("\n");
}

/** First index whose key is greater than `key` (lines with equal keys stay in arrival order). */
function upperBound(lines: Line[], key: number): number {
  let lo = 0;
  let hi = lines.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].key <= key) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** The first index in `lines` (in buffer order) whose position is `pos` or later. */
export function indexAtPos(lines: readonly Line[], pos: number): number {
  let lo = 0;
  let hi = lines.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].pos < pos) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** The first index in `lines` (in time order) whose key is `key` or later. */
export function indexAtKey(lines: readonly Line[], key: number): number {
  let lo = 0;
  let hi = lines.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].key < key) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

interface View {
  filter: Filter;
  hits: Line[];
  /** The first absolute position changed since the hits were made. */
  stale: number;
  /** Times the hits changed (see `LogBuffer.revision`). */
  revision: number;
  /** The kept entries it shows come first (see `LogBuffer.kept`)… */
  kept: boolean;
  /** …as of the entries dropped and the kept ones gone then: those dropped since leave it, those kept since come in. */
  base: number;
  forgotten: number;
}

/** Views kept up to date at once (the lines shown, their matches, the histogram's…). */
const MAX_VIEWS = 8;

/**
 * The entries of a log stream: one timeline across all its sources (pods × containers × clusters), in timestamp
 * order, within an entry and byte budget — the oldest are dropped first, and counted.
 *
 * Batches are merged in, not sorted in: each source's lines arrive in order, so only the part of the buffer newer
 * than a batch's oldest line is touched (for live lines: nothing but the end). A line that continues the entry before
 * it (a stack trace's frames) joins that entry. Filtered views follow the buffer incrementally the same way.
 */
export class LogBuffer {
  lines: Line[] = [];
  /** Entries dropped from the timeline to stay within the budget so far (the kept ones too). */
  dropped = 0;
  bytes = 0;
  /**
   * Entries dropped from the timeline that a filter showed then, oldest first: filtered views show them too (see
   * `view`), so what a filter shows piles up while what it hides makes room. They take half the budget at most: beyond
   * it, the oldest of them go.
   */
  kept: Line[] = [];
  keptBytes = 0;
  /** What the view shows now (null: everything): entries it lets through are kept when the buffer is full. */
  keep: (() => Filter | null) | null = null;
  /**
   * The first position the view draws while it is read or paused (null: it follows the lines that come): entries
   * from it on are not dropped until the buffer holds `HOLD_OVER` times its budget, and then only as few as it takes.
   */
  hold: (() => number | null) | null = null;
  /** Lines and markers that arrived so far (`Line.seq` counts them). */
  seq = 0;
  /** Entries in the buffer per source. */
  counts: number[] = [];
  private lastKey = new Map<number, number>();
  /** Each source's last entry, and the time of its last line (for continuation lines). */
  private lastEntry = new Map<number, Line>();
  private lastTs = new Map<number, number | null>();
  private views = new Map<string, View>();
  /** Times the entries changed (the unfiltered view's revision). */
  private changes = 0;
  /** Kept entries that went so far (beyond their share of the budget). */
  private forgotten = 0;

  constructor(
    readonly maxBytes = MAX_BYTES,
    readonly maxLines = MAX_LINES,
  ) {}

  /** Adds an engine batch. */
  add(batch: LogLine[]) {
    if (!batch.length) return;
    const lines = this.lines;
    const fallback = lines.length ? lines[lines.length - 1].key : 0;
    const incoming: Line[] = [];
    // The earliest entry already in the buffer that continuation lines changed.
    let grown = Infinity;
    const one = (i: number, ts: number | null, text: string, key: number) => {
      const prev = this.line(i, ts, text, key, this.lastEntry, this.lastTs, incoming, true);
      if (prev && prev.pos >= 0) grown = Math.min(grown, prev.pos);
    };
    for (const [i, ts, text] of batch) {
      const key = ts ?? this.lastKey.get(i) ?? fallback;
      this.lastKey.set(i, key);
      // Text with line breaks (a stack trace sent as one entry) is one line per row, as `kubectl logs` shows it.
      if (!text.includes("\n")) one(i, ts, text, key);
      else for (const part of text.replace(/\r?\n$/, "").split(/\r?\n/)) one(i, ts, part, key);
    }
    if (grown !== Infinity) this.touch(grown);
    if (incoming.length) this.merge(incoming);
    this.evict();
  }

  /**
   * Adds lines written before those the buffer holds of their sources (earlier history, read after them): each
   * source's lines in order. They make entries of their own; a source's first entry held joins the last one read
   * when it continues it (a stack trace the first read began inside of is whole again). They are no arrivals: a
   * pause shows them. `markers` go after the lines of their time. None once entries were dropped (a read that ended
   * after the buffer filled up): they would go before a gap, and be the first to go.
   */
  addEarlier(batch: LogLine[], markers: readonly EarlierMarker[] = []) {
    if ((!batch.length && !markers.length) || this.dropped > 0) return;
    const incoming: Line[] = [];
    const last = new Map<number, Line>();
    const lastTs = new Map<number, number | null>();
    const lastKey = new Map<number, number>();
    for (const [i, ts, text] of batch) {
      const key = ts ?? lastKey.get(i) ?? 0;
      lastKey.set(i, key);
      if (!text.includes("\n")) this.line(i, ts, text, key, last, lastTs, incoming, false);
      else for (const part of text.replace(/\r?\n$/, "").split(/\r?\n/)) this.line(i, ts, part, key, last, lastTs, incoming, false);
    }
    // The entry a source's first entry held continues: that one (views and the selection hold on to it) becomes
    // the whole entry, and moves to its place.
    const moved: Line[] = [];
    for (const [i, head] of this.firstEntries(new Set(last.keys()))) {
      const prev = last.get(i)!;
      if (head.marker || prev.marker || (prev.more?.length ?? 0) + 1 + (head.more?.length ?? 0) > MAX_MORE) continue;
      const before = lastTs.get(i);
      const how = follows(head.ansi ? stripAnsi(head.text) : head.text, !!prev.stack, head.ts !== null && before != null ? head.ts - before : null);
      if (!how) continue;
      this.bytes -= size(prev) + size(head);
      head.more = [...(prev.more ?? []), head.text, ...(head.more ?? [])];
      head.moreWidth = [...(prev.moreWidth ?? []), head.width, ...(head.moreWidth ?? [])];
      head.text = prev.text;
      head.width = prev.width;
      head.ansi = prev.ansi;
      head.ts = prev.ts;
      head.key = prev.key;
      head.lvl = how === 2 && prev.lvl === Level.None ? Level.Error : prev.lvl;
      head.stack = prev.stack || how === 2 || head.stack;
      head.lower = undefined;
      head.pat = undefined;
      this.bytes += size(head);
      this.counts[i]--;
      incoming[incoming.lastIndexOf(prev)] = head;
      moved.push(head);
    }
    // (Each moves to a key not after its own: it goes back in with the lines merged in front of it.)
    for (const k of moved.map((l) => l.pos - this.dropped).sort((a, b) => b - a)) this.lines.splice(k, 1);
    for (const m of markers) {
      const l: Line = { i: m.i, ts: m.ts, key: m.ts, text: m.text, width: m.text.length, lvl: m.lvl, ansi: false, pos: -1, seq: -1, marker: true };
      this.bytes += size(l);
      this.counts[m.i] = (this.counts[m.i] ?? 0) + 1;
      incoming.push(l);
    }
    if (incoming.length) this.merge(incoming, true);
    this.evict();
  }

  /**
   * One line of a source: it continues the source's last entry in `last` (which is returned), or starts an entry,
   * added to `incoming` — an arrival, or (not `arrived`) an earlier line.
   */
  private line(i: number, ts: number | null, text: string, key: number, last: Map<number, Line>, lastTs: Map<number, number | null>, incoming: Line[], arrived: boolean): Line | undefined {
    const ansi = hasAnsi(text);
    const plain = ansi ? stripAnsi(text) : text;
    const prev = last.get(i);
    // The source's last entry: in this batch (no position yet), or still in the buffer.
    if (prev && !prev.marker && (prev.pos < 0 || prev.pos >= this.dropped) && (prev.more?.length ?? 0) < MAX_MORE) {
      const before = lastTs.get(i);
      const how = follows(plain, !!prev.stack, ts !== null && before != null ? ts - before : null);
      if (how) {
        this.bytes -= size(prev);
        (prev.more ??= []).push(text);
        (prev.moreWidth ??= []).push(plain.length);
        if (how === 2) prev.stack = true;
        if (how === 2 && prev.lvl === Level.None) {
          prev.lvl = Level.Error;
          // (A pattern goes with its level.)
          prev.pat = undefined;
        }
        prev.lower = undefined;
        this.bytes += size(prev);
        if (ts !== null) lastTs.set(i, ts);
        return prev;
      }
    }
    const l: Line = { i, ts, key, text, width: plain.length, lvl: levelOf(plain), ansi, pos: -1, seq: arrived ? this.seq++ : -1 };
    if (startsStack(plain)) l.stack = true;
    incoming.push(l);
    this.bytes += size(l);
    this.counts[i] = (this.counts[i] ?? 0) + 1;
    last.set(i, l);
    lastTs.set(i, ts);
    return undefined;
  }

  /** The first entry held of each of `sources` (that has one). */
  private firstEntries(sources: ReadonlySet<number>): Map<number, Line> {
    const out = new Map<number, Line>();
    if (!sources.size) return out;
    for (const l of this.lines) {
      if (!sources.has(l.i) || out.has(l.i)) continue;
      out.set(l.i, l);
      if (out.size === sources.size) break;
    }
    return out;
  }

  /** Adds a marker: what happened to a source's stream, at the time it was told (after its last line). */
  mark(i: number, text: string, lvl: Level, now = Date.now()): Line {
    const key = Math.max(now, this.lastKey.get(i) ?? 0);
    const l: Line = { i, ts: now, key, text, width: text.length, lvl, ansi: false, pos: 0, seq: this.seq++, marker: true };
    this.bytes += size(l);
    this.counts[i] = (this.counts[i] ?? 0) + 1;
    // What the stream writes next starts an entry of its own.
    this.lastEntry.set(i, l);
    this.merge([l]);
    this.evict();
    return l;
  }

  /** Merges entries in by time; `before`: in front of entries of the same time (earlier lines), else after them. */
  private merge(incoming: Line[], before = false) {
    const lines = this.lines;
    // Stable: lines of one source keep their order.
    incoming.sort((a, b) => a.key - b.key);
    const from = before ? indexAtKey(lines, incoming[0].key) : upperBound(lines, incoming[0].key);
    if (from === lines.length) {
      for (const l of incoming) lines.push(l);
    } else {
      const older = lines.splice(from);
      let a = 0;
      let b = 0;
      while (a < older.length && b < incoming.length) lines.push((before ? older[a].key < incoming[b].key : older[a].key <= incoming[b].key) ? older[a++] : incoming[b++]);
      while (a < older.length) lines.push(older[a++]);
      while (b < incoming.length) lines.push(incoming[b++]);
    }
    for (let k = from; k < lines.length; k++) lines[k].pos = this.dropped + k;
    this.touch(this.dropped + from);
  }

  /** Entries from absolute position `pos` on changed: views look at them again. */
  private touch(pos: number) {
    this.changes++;
    for (const v of this.views.values()) v.stale = Math.min(v.stale, pos);
  }

  /** Whether there is room for more lines (the buffer, held, is not about to drop what is read). */
  room(): boolean {
    return this.bytes + this.keptBytes < this.maxBytes * (HOLD_OVER - 0.05) && this.lines.length + this.kept.length < this.maxLines * (HOLD_OVER - 0.05);
  }

  private evict() {
    const lines = this.lines;
    const kept = this.kept;
    if (this.bytes + this.keptBytes <= this.maxBytes && lines.length + kept.length <= this.maxLines) return;
    // Lines being read stay, up to HOLD_OVER times the budget; beyond it, as few go as it takes (the oldest first).
    const held = this.hold?.() ?? null;
    const over = this.bytes + this.keptBytes > this.maxBytes * HOLD_OVER || lines.length + kept.length > this.maxLines * HOLD_OVER;
    if (held !== null && !over && (lines[0]?.pos ?? Infinity) >= held) return;
    const limit = held !== null && !over ? held : Infinity;
    // Down to 90%, so dropping (which moves the whole array) happens rarely. What the filter shows is kept, half the
    // budget at most (with the lower-case copies made of it since): beyond it, the oldest kept go.
    const keep = this.keep?.() ?? null;
    const share = held !== null && over ? HOLD_OVER - 0.1 : 0.9;
    const bytes = this.maxBytes * share;
    const count = Math.floor(this.maxLines * share);
    let k = 0;
    let out = 0;
    const trim = () => {
      while (out < kept.length && (this.keptBytes > this.maxBytes / 2 || kept.length - out > this.maxLines / 2)) {
        const o = kept[out++];
        o.kept = false;
        this.keptBytes -= size(o);
        this.counts[o.i]--;
      }
    };
    trim();
    while (k < lines.length - 1 && lines[k].pos < limit && (this.bytes + this.keptBytes > bytes || lines.length - k + kept.length - out > count)) {
      const l = lines[k++];
      // (The test may make its lower-case copy, which counts: its size after the test.)
      const shown = !!keep?.test(l);
      const n = size(l);
      this.bytes -= n;
      if (!shown) {
        this.counts[l.i]--;
        continue;
      }
      l.kept = true;
      kept.push(l);
      this.keptBytes += n;
      trim();
    }
    if (out) {
      kept.splice(0, out);
      this.forgotten += out;
    }
    if (k) {
      lines.splice(0, k);
      this.dropped += k;
      this.changes++;
    }
  }

  /** The entry's plain text in lower case (kept once made; it counts towards the budget). */
  lower(l: Line): string {
    if (l.lower === undefined) {
      const lower = plainOf(l).toLowerCase();
      // Text already in lower case is shared, not copied.
      l.lower = lower === l.text ? l.text : lower;
      if (l.lower !== l.text) {
        if (l.kept) this.keptBytes += lower.length;
        else this.bytes += lower.length;
      }
    }
    return l.lower;
  }

  /** The entry at an absolute position, if it is still in the buffer. */
  at(pos: number): Line | undefined {
    return this.lines[pos - this.dropped];
  }

  /**
   * The entries `filter` lets through — `withKept`: the kept ones too, before the others. Kept up to date
   * incrementally (a few views at once, the least recently read go first); do not modify. The empty filter is the
   * buffer itself (when there are no kept entries to show).
   */
  view(filter: Filter, withKept = false): Line[] {
    const kept = withKept && this.kept.length > 0;
    if (!filter.key && !kept) return this.lines;
    const key = kept ? `+${filter.key}` : filter.key;
    let v = this.views.get(key);
    if (v) {
      // Most recently read last.
      this.views.delete(key);
      this.views.set(key, v);
    } else {
      const hits = kept ? [...this.kept.filter(filter.test), ...this.lines.filter(filter.test)] : this.lines.filter(filter.test);
      v = { filter, hits, stale: Infinity, revision: 0, kept, base: this.dropped, forgotten: this.forgotten };
      this.views.set(key, v);
      if (this.views.size > MAX_VIEWS) this.views.delete(this.views.keys().next().value!);
      return v.hits;
    }
    const hits = v.hits;
    const length = hits.length;
    let matched = false;
    const base = this.dropped;
    if (v.stale !== Infinity) {
      // Entries from `stale` on were merged anew or grew: their hits go (wherever they are now), they are matched again.
      // (Kept hits stay: they were dropped before the view was last read, below any position touched since.)
      while (hits.length && hits[hits.length - 1].pos >= v.stale) hits.pop();
    }
    if (!v.kept) {
      let gone = 0;
      while (gone < hits.length && hits[gone].pos < base) gone++;
      if (gone) hits.splice(0, gone);
    } else if (v.base !== base || v.forgotten !== this.forgotten) {
      // Entries dropped meanwhile go, and the kept ones gone. Those kept before stay; those kept since come in after
      // them, as the filter lets them through (some were dropped before they were ever hits).
      let to = 0;
      let k = 0;
      for (; k < hits.length && hits[k].pos < base; k++) if (hits[k].pos < v.base && hits[k].kept) hits[to++] = hits[k];
      const rest = hits.slice(k);
      hits.length = to;
      const test = v.filter.test;
      for (let j = indexAtPos(this.kept, v.base); j < this.kept.length; j++) if (test(this.kept[j])) hits.push(this.kept[j]);
      for (const l of rest) hits.push(l);
      matched = true;
    }
    v.base = base;
    v.forgotten = this.forgotten;
    if (v.stale !== Infinity) {
      const test = v.filter.test;
      for (let k = Math.max(0, v.stale - base); k < this.lines.length; k++) {
        const l = this.lines[k];
        if (test(l)) {
          hits.push(l);
          matched = true;
        }
      }
      v.stale = Infinity;
    }
    // (Hits matched again may be the same entries, grown.)
    if (matched || hits.length !== length) v.revision++;
    return hits;
  }

  /**
   * How many times a view (as `view` returned it) changed: the same number, the same entries — to count them again
   * only when they changed. -1: not a view kept up to date.
   */
  revision(view: readonly Line[]): number {
    if (view === this.lines) return this.changes;
    for (const v of this.views.values()) if (v.hits === view) return v.revision;
    return -1;
  }

  clear() {
    this.lines = [];
    this.dropped = 0;
    this.bytes = 0;
    for (const l of this.kept) l.kept = false;
    this.kept = [];
    this.keptBytes = 0;
    this.counts = [];
    this.lastKey.clear();
    this.lastEntry.clear();
    this.lastTs.clear();
    this.views.clear();
  }
}

/** A log target with the id its lines carry; `gone`: why it is no longer streamed (its lines stay). */
export interface Source extends LogTarget {
  id: number;
  gone?: string;
}

type PodKeyed = { cluster: string; namespace: string; uid?: string };
const podKey = (cluster: string, namespace: string, pod: string, uid?: string) => `${cluster}\n${namespace}\n${pod}\n${uid ?? ""}`;
const targetKey = (t: LogTarget) => `${podKey(t.cluster, t.namespace, t.pod, t.uid)}\n${t.container}`;

/**
 * The sources of one log stream. Ids are stable: a target that comes back gets its old one. A pod re-created
 * under the same name (a StatefulSet's) has another uid: it is a new source, the deleted one's lines stay.
 */
export class Sources {
  readonly byId: Source[] = [];
  private byKey = new Map<string, Source>();
  private pods = new Set<string>();

  /**
   * Makes `targets` the streamed ones: returns them with ids. The others are marked gone, with `why(source)`
   * for those that were streamed until now.
   */
  assign(targets: LogTarget[], why: (s: Source) => string = () => "no longer streamed"): LogTarget[] {
    const wanted = new Set<Source>();
    const out = targets.map((t) => {
      const key = targetKey(t);
      let s = this.byKey.get(key);
      if (!s) {
        s = { cluster: t.cluster, namespace: t.namespace, pod: t.pod, uid: t.uid, container: t.container, id: this.byId.length };
        this.byId.push(s);
        this.byKey.set(key, s);
      }
      wanted.add(s);
      return { cluster: s.cluster, namespace: s.namespace, pod: s.pod, ...(s.uid ? { uid: s.uid } : {}), container: s.container, id: s.id };
    });
    this.pods.clear();
    for (const s of this.byId) {
      if (wanted.has(s)) {
        s.gone = undefined;
        this.pods.add(podKey(s.cluster, s.namespace, s.pod, s.uid));
      } else s.gone ??= why(s);
    }
    return out;
  }

  /** Whether some container of the pod is streamed. */
  streams(p: PodKeyed & { name: string }): boolean {
    return this.pods.has(podKey(p.cluster, p.namespace, p.name, p.uid));
  }
}

export interface PodRef {
  cluster: string;
  namespace: string;
  name: string;
  uid?: string;
  /** Finished or going away (Completed, Evicted, Terminating…): it writes no more logs. */
  done?: boolean;
  /** Creation time (unix seconds). */
  created?: number;
}

/** The key of a pod, for sets of pods (`podKeyOf(target)` matches the pod's). */
export const podKeyOf = (p: PodRef | LogTarget) => ("name" in p ? podKey(p.cluster, p.namespace, p.name, p.uid) : podKey(p.cluster, p.namespace, p.pod, p.uid));

/** Statuses (kubectl's) of pods that finished or were stopped: their containers run no more. */
const DONE = new Set(["Completed", "Succeeded", "Failed", "Evicted", "Terminating", "DeadlineExceeded", "Shutdown", "NodeShutdown", "Terminated", "UnexpectedAdmissionError", "ContainerStatusUnknown"]);

/** Whether a pod row's status says it finished (or is going away). */
export function podDone(status: string | undefined, terminating?: boolean): boolean {
  return !!terminating || (!!status && (DONE.has(status) || /^OutOf[a-z]/.test(status)));
}

const byClusterAndName = (a: PodRef, b: PodRef) => a.cluster.localeCompare(b.cluster) || a.name.localeCompare(b.name);
const newestFirst = (a: PodRef, b: PodRef) => (b.created ?? 0) - (a.created ?? 0) || a.name.localeCompare(b.name);

/**
 * Pods whose containers together (`cost(pod)` each) stay within `budget` (at least one pod), in cluster/name
 * order. Pods for which `keep` holds (already streamed) stay chosen, so a rollout does not shuffle which
 * pods are shown. The rest is filled up with running pods before finished ones, clusters taking turns (the
 * last cluster is not left out), newest pods first.
 */
export function pickPods<P extends PodRef>(pods: P[], keep: (p: P) => boolean, budget: number, cost: (p: P) => number = () => 1): P[] {
  const sorted = [...pods].sort(byClusterAndName);
  const costOf = (p: P) => Math.max(1, cost(p));
  if (sorted.reduce((n, p) => n + costOf(p), 0) <= budget) return sorted;
  const chosen = new Set<P>();
  let used = 0;
  const take = (p: P) => {
    if (chosen.size && used + costOf(p) > budget) return;
    chosen.add(p);
    used += costOf(p);
  };
  for (const p of sorted) if (keep(p)) take(p);
  for (const done of [false, true]) {
    const byCluster = new Map<string, P[]>();
    for (const p of sorted) {
      if (chosen.has(p) || !!p.done !== done) continue;
      const list = byCluster.get(p.cluster);
      if (list) list.push(p);
      else byCluster.set(p.cluster, [p]);
    }
    const lists = [...byCluster.values()].map((l) => l.sort(newestFirst));
    for (let round = 0; lists.some((l) => round < l.length); round++) for (const l of lists) if (round < l.length) take(l[round]);
  }
  return sorted.filter((p) => chosen.has(p));
}
