import { backend, type LogLine, type LogMessage, type LogSubscription, type LogTarget } from "../../lib/backend";
import { Level } from "../../lib/logs/parse";
import type { EarlierMarker, LogBuffer, Source } from "../logBuffer";

// Earlier history of a log that streams, read in place — the stream goes on, nothing starts over. Each container is
// asked for as many of its last lines as reach back past the earliest one held, and the read stops there (the
// engine's `LogTarget.until`): what follows is not transferred again. Once a container's run was read from its
// beginning, the run before it comes next: the previous container's logs, which the kubelet keeps for one restart.

/** Lines read per load, the containers that have more together (each one at least `MIN_SHARE`). */
export const EARLIER_LINES = 5_000;
const MIN_SHARE = 100;
/** A container's history read at the start comes in first: earlier lines are read once it had this long. */
export const SETTLE_MS = 3_000;
/** A load waits this long at most for a container. */
const LOAD_TIMEOUT_MS = 30_000;
/** The engine's history per subscription (its `HISTORY_LINES`), shared by the containers. */
const HISTORY_LINES = 100_000;
/** Lines written but not here yet push a read's start later: its margin is a few seconds' worth of them… */
const IN_FLIGHT_SECONDS = 5;
/** …as the last this many seconds tell. */
const RATE_SECONDS = 10;

export type EarlierPhase =
  /** Nothing to tell (history read at the start still coming in, or the view was cleared). */
  | ""
  /** Some container may have earlier lines. */
  | "more"
  | "loading"
  /** Each container's log was read from its beginning (of the earliest run whose logs are kept). */
  | "done"
  /** The view holds as many lines as it can. */
  | "full";

export interface EarlierState {
  phase: EarlierPhase;
  /** Containers that have more… */
  more: number;
  /** …and of them, those whose earlier lines are their previous run's. */
  previous: number;
  /** Lines loaded so far. */
  loaded: number;
  /** Why the last load could not read some containers. */
  error?: string;
}

/** What the stream read when it started. */
export interface StartedWith {
  /** Lines per container; null: all of them. */
  tail: number | null;
  /** A stretch of time instead (seconds): whether there are earlier lines is not known. */
  since: number | null;
  /** The previous containers' logs (crashed ones). */
  previous: boolean;
}

interface Track {
  /** How many runs back the earliest line held is: 0 the run the stream reads, 1 the one before it. */
  run: number;
  /** Lines held of that run (a read of its last lines skips them). */
  held: number;
  /** The earliest line held: its time, and the texts of the lines held of exactly that millisecond. */
  first: number | null;
  atFirst: string[];
  /** All lines held so far are of that millisecond. */
  firstOpen: boolean;
  /** Lines of its history read at the start (written before the stream started). */
  history: number;
  /** When its stream started (or told why it does not stream: waiting, ended). */
  since: number | null;
  /** Whether its history read at the start was all of its run's log was looked at. */
  decided: boolean;
  /** The beginning of a run was reached: a marker goes after the last line of the run before it. */
  crossed: boolean;
  /** Nothing earlier to read. */
  done: boolean;
  /** Live lines per second, the last few seconds: [second, count]. */
  live: [number, number][];
}

export interface EarlierOptions {
  buffer: LogBuffer;
  sources: () => readonly Source[];
  startedWith: StartedWith;
  /** The restarts of a source's pod, if known: the run before the current one has logs only after a restart. */
  restarts: (s: Source) => number | undefined;
  /** What is shown, for diagnostics. */
  label: string;
  /** Something changed (`state()` may say something else). */
  onChange: () => void;
  /** Earlier lines are about to go into the buffer (the screen holds on to what it shows). */
  beforeLoad?: () => void;
  /** Earlier lines went into the buffer. */
  onLoaded: () => void;
  now?: () => number;
}

interface Result {
  lines: LogLine[];
  end?: { error: boolean; message?: string };
}

export class Earlier {
  private tracks = new Map<number, Track>();
  private subs: LogSubscription[] = [];
  private timers: ReturnType<typeof setTimeout>[] = [];
  private loadTimer: ReturnType<typeof setTimeout> | undefined;
  private loading = false;
  private cleared = false;
  private closed = false;
  private loaded = 0;
  private error: string | undefined;
  private readonly started: number;
  private readonly now: () => number;

  constructor(private readonly o: EarlierOptions) {
    this.now = o.now ?? Date.now;
    this.started = this.now();
  }

  private track(i: number): Track {
    let t = this.tracks.get(i);
    if (!t) this.tracks.set(i, (t = { run: 0, held: 0, first: null, atFirst: [], firstOpen: false, history: 0, since: null, decided: false, crossed: false, done: false, live: [] }));
    return t;
  }

  /** Lines that came in the stream: its history read at the start, then live ones (each source's in order). */
  seen(batch: readonly LogLine[]) {
    const now = this.now();
    const second = Math.floor(now / 1000);
    // Written before the stream started: history (with a little slack for clocks).
    const before = this.started - 2000;
    for (const [i, ts, text] of batch) {
      const t = this.track(i);
      if (ts !== null) {
        if (t.first === null) {
          t.first = ts;
          t.atFirst = [text];
          t.firstOpen = true;
        } else if (t.firstOpen && ts === t.first) t.atFirst.push(text);
        else t.firstOpen = false;
        if (ts < before) t.history++;
        else {
          const last = t.live[t.live.length - 1];
          if (last?.[0] === second) last[1]++;
          else {
            t.live.push([second, 1]);
            while (t.live[0][0] <= second - RATE_SECONDS) t.live.shift();
          }
        }
      }
      if (t.run === 0) t.held++;
    }
  }

  /**
   * A container's stream changed state. `restarted`: it runs again — what is held of it is its previous run's now
   * (and the run before that one's logs are gone).
   */
  streamState(i: number, state: string, restarted = false) {
    const t = this.track(i);
    if (t.since === null && state !== "error" && state !== "reconnecting") {
      t.since = this.now();
      // Its history read at the start is in by then: whether there is more can be told.
      this.timers.push(setTimeout(() => this.changed(), SETTLE_MS + 50));
    }
    if (restarted && t.first !== null) {
      // (What is held of it stays held of that run; live lines are the new run's.)
      t.run++;
      t.firstOpen = false;
      if (!this.readable(t.run)) t.done = true;
      this.changed();
    }
  }

  /** The view was emptied: what it held is not loaded again. */
  clear() {
    this.cleared = true;
    this.cancel();
    this.changed();
  }

  close() {
    this.closed = true;
    this.cancel();
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
  }

  private cancel() {
    for (const s of this.subs) s.close();
    this.subs = [];
    clearTimeout(this.loadTimer);
    this.loading = false;
  }

  private changed() {
    if (!this.closed) this.o.onChange();
  }

  /** A run so many back can be read: the stream's own, and (as the previous container's) the one before it. */
  private readable(run: number) {
    return this.o.startedWith.previous ? run === 0 : run <= 1;
  }

  /** Lines that still fit in the buffer. */
  private room(): number {
    const b = this.o.buffer;
    if (b.dropped > 0) return 0;
    const avg = b.lines.length ? b.bytes / b.lines.length : 200;
    return Math.max(0, Math.min(Math.floor(b.maxLines * 0.9) - b.lines.length, Math.floor((b.maxBytes * 0.9 - b.bytes) / Math.max(avg, 1))));
  }

  /** Its history read at the start was all of its run's log: fewer lines than its share of what was asked for. */
  private completeAtStart(t: Track): boolean {
    const w = this.o.startedWith;
    if (w.since !== null) return false;
    const n = this.o.sources().length;
    const share = n <= 1 ? w.tail : Math.min(w.tail ?? Infinity, Math.max(100, Math.floor(HISTORY_LINES / n)));
    return share === null || t.history < share * 0.9;
  }

  /** The beginning of a container's run was reached: the run before it is next, if its logs are kept. */
  private cross(i: number, t: Track) {
    t.run++;
    t.held = 0;
    t.atFirst = [];
    t.firstOpen = false;
    const src = this.o.sources()[i];
    // The run before the stream's own has logs after a restart only (its pod tells).
    const kept = this.readable(t.run) && (t.run > 1 || this.o.startedWith.previous || (!!src && (this.o.restarts(src) ?? 0) > 0));
    t.crossed = kept;
    t.done = !kept;
  }

  /** Containers whose earlier lines can be loaded now, and whether some are still settling. */
  private candidates(now: number): { ready: [number, Track][]; settling: boolean } {
    const ready: [number, Track][] = [];
    let settling = false;
    const sources = this.o.sources();
    for (const [i, t] of this.tracks) {
      const src = sources[i];
      if (!src || src.gone || t.done) continue;
      if (t.since === null || now - t.since < SETTLE_MS) {
        settling = true;
        continue;
      }
      if (!t.decided) {
        t.decided = true;
        if (t.run === 0 && this.completeAtStart(t)) this.cross(i, t);
        if (t.done) continue;
      }
      ready.push([i, t]);
    }
    return { ready, settling };
  }

  state(): EarlierState {
    if (this.cleared) return { phase: "", more: 0, previous: 0, loaded: this.loaded };
    if (this.loading) return { phase: "loading", more: 0, previous: 0, loaded: this.loaded };
    const { ready, settling } = this.candidates(this.now());
    const previous = ready.filter(([, t]) => t.crossed).length;
    const phase: EarlierPhase = ready.length ? (this.room() < MIN_SHARE ? "full" : "more") : settling || !this.tracks.size ? "" : "done";
    return { phase, more: ready.length, previous, loaded: this.loaded, ...(this.error ? { error: this.error } : {}) };
  }

  /** Lines a container writes in `IN_FLIGHT_SECONDS`, as the last seconds tell. */
  private inFlight(t: Track, now: number): number {
    const from = Math.floor(now / 1000) - RATE_SECONDS;
    let n = 0;
    for (const [s, k] of t.live) if (s > from) n += k;
    return Math.ceil((n * IN_FLIGHT_SECONDS) / RATE_SECONDS);
  }

  /** Reads earlier lines of every container that has them (a share of `EARLIER_LINES` each). */
  load() {
    if (this.loading || this.closed || this.cleared) return;
    const now = this.now();
    const { ready } = this.candidates(now);
    const room = this.room();
    if (!ready.length || room < MIN_SHARE) return;
    const share = Math.max(MIN_SHARE, Math.floor(Math.min(EARLIER_LINES, room) / ready.length));
    const sources = this.o.sources();
    const groups = new Map<boolean, LogTarget[]>();
    for (const [i, t] of ready) {
      const src = sources[i];
      const previous = this.o.startedWith.previous || t.run === 1;
      // (A run that ended writes nothing more.)
      const margin = previous ? 0 : Math.max(100, this.inFlight(t, now));
      const target: LogTarget = { cluster: src.cluster, namespace: src.namespace, pod: src.pod, ...(src.uid ? { uid: src.uid } : {}), container: src.container, id: i, tailLines: t.held + share + margin, until: t.first ?? now };
      const list = groups.get(previous);
      if (list) list.push(target);
      else groups.set(previous, [target]);
    }
    this.loading = true;
    this.error = undefined;
    const results = new Map<number, Result>(ready.map(([i]) => [i, { lines: [] }]));
    let open = ready.length;
    const end = (i: number, e: NonNullable<Result["end"]>) => {
      const r = results.get(i);
      if (!r || r.end) return;
      r.end = e;
      if (--open === 0) this.finish(ready, results, share);
    };
    for (const [previous, targets] of groups) {
      const sub = backend().streamLogs({ targets, follow: false, tailLines: null, sinceSeconds: null, previous, label: `${this.o.label} (earlier)` }, (m: LogMessage) => {
        if (this.closed || this.cleared) return;
        if (m.t === "lines") {
          for (const l of m.l) results.get(l[0])?.lines.push(l);
          return;
        }
        if (m.state === "ended") end(m.i, { error: false, message: m.message });
        else if (m.state === "error") end(m.i, { error: true, message: m.message ?? "error" });
      });
      this.subs.push(sub);
    }
    this.loadTimer = setTimeout(() => {
      for (const [i] of ready) end(i, { error: true, message: "no answer in time" });
    }, LOAD_TIMEOUT_MS);
    this.changed();
  }

  private finish(ready: [number, Track][], results: Map<number, Result>, share: number) {
    this.cancel();
    const batch: LogLine[] = [];
    const markers: EarlierMarker[] = [];
    const errors = new Set<string>();
    for (const [i, t] of ready) {
      const r = results.get(i)!;
      if (r.end?.error) {
        errors.add(r.end.message ?? "error");
        continue;
      }
      let lines = r.lines;
      // The read went up to the millisecond of the first line held: lines of it that are held already go.
      if (t.held > 0 && t.first !== null && t.atFirst.length) {
        const have = new Map<string, number>();
        for (const s of t.atFirst) have.set(s, (have.get(s) ?? 0) + 1);
        let k = lines.length;
        while (k > 0 && lines[k - 1][1] === t.first && (have.get(lines[k - 1][2]) ?? 0) > 0) {
          have.set(lines[k - 1][2], have.get(lines[k - 1][2])! - 1);
          k--;
        }
        lines = lines.slice(0, k);
      }
      // The margin read more than asked for (when fewer lines were in flight): the latest of them are kept.
      const got = lines.length;
      if (got > share) lines = lines.slice(got - share);
      const n = lines.length;
      if (n) {
        for (const l of lines) batch.push(l);
        if (t.crossed) {
          markers.push({ i, ts: lines[n - 1][1] ?? t.first ?? 0, text: "container restarted", lvl: Level.Warn });
          t.crossed = false;
        }
        t.held += n;
        this.loaded += n;
        t.first = lines[0][1] ?? t.first;
        t.atFirst = [];
        for (const l of lines) {
          if (l[1] !== t.first) break;
          t.atFirst.push(l[2]);
        }
        t.firstOpen = false;
      }
      // Fewer lines than asked for: the run's log was read from its beginning (or it cannot be read: why is told).
      if (r.end?.message || got < share) this.cross(i, t);
    }
    if (batch.length || markers.length) {
      this.o.beforeLoad?.();
      this.o.buffer.addEarlier(batch, markers);
      this.o.onLoaded();
    }
    this.error = errors.size ? [...errors].join("; ") : undefined;
    this.changed();
  }
}
