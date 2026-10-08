import { type Accessor, batch, createEffect, createMemo, createSignal, For, type JSX, on, onCleanup, onMount, Show, untrack } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import { Icon, type IconName } from "../../components/Icon";
import { Popover } from "../../components/Popover";
import { backend, errorMessage, type LogLine, type LogSpec, type LogState, type LogTarget } from "../../lib/backend";
import { CLUSTER_COLORS } from "../../lib/clusters";
import { count, plural } from "../../lib/format";
import { asJsonl, asText, type ExportLine } from "../../lib/logs/format";
import type { Level } from "../../lib/logs/parse";
import { PatternIds } from "../../lib/logs/patterns";
import { highlighter, parseQuery, withTerm } from "../../lib/logs/query";
import { type Binding, bindAll, comboLabel, withKeys } from "../../lib/hotkeys";
import { keyOf } from "../../lib/keymap";
import { shortName } from "../../state/clusters";
import { onControl } from "../../state/keyboard";
import { copyText, toast } from "../../state/ui";
import { HOLD_OVER, indexAtPos, type Line, LogBuffer, MAX_BYTES, MAX_LINES, pickPods, type PodRef, podKeyOf, podLabel, type Source, Sources } from "../logBuffer";
import { Earlier, type EarlierState } from "./earlier";
import { LogFields, LogSources } from "./LogPopovers";
import { LogLines, type LinesHandle } from "./LogLines";
import { LogPatterns } from "./LogPatterns";
import { LogStrip } from "./LogStrip";
import {
  Arrivals,
  buildFilters,
  type FilterState,
  FOLD_AT,
  filterMode,
  fold,
  histogramOpen,
  type Lag,
  LineSubject,
  patternIdOf,
  pretty,
  regexMode,
  matchCase,
  rememberQuery,
  setFold,
  setHistogramOpen,
  setFilterMode,
  setPretty,
  setShowTs,
  setSince,
  setTail,
  setUtc,
  setWrap,
  showTs,
  since,
  SINCES,
  Structures,
  tail,
  TAILS,
  utc,
  wrap,
} from "./model";
import { QueryField } from "./QueryField";
import type { Highlight } from "./render";

/** Containers streamed at once (the engine's limit too); a workload with more pods shows some of them. */
export const MAX_TARGETS = 50;
/** A log this big is filtered once typing pauses, not on every key. */
const BIG_LOG = 30_000;
/**
 * Lines that keep coming are shown at most every `showEvery` ms (the first after a quiet spell at once), and further
 * apart the more the last showing cost, up to `maxEvery`; while the user scrolls the lines read, they wait for the
 * gesture to end, `hold` ms at most. (Tests: 0.)
 */
export const timing = { showEvery: 100, maxEvery: 1000, hold: 1000 };
/** A log not on screen (a dock tab not shown) takes in its lines once a second. */
const HIDDEN_EVERY = 1000;
/** A press in the lines (text being selected) holds new lines this long at most… */
const PRESS_HOLD_MS = 10_000;
/** …or until this much text waits. */
const HOLD_BYTES = 16 * 1024 * 1024;
/** What a view's buffer holds at most. (Tests: less.) */
export const budget = { bytes: MAX_BYTES, lines: MAX_LINES };

/**
 * A pod to stream: `containers` are its own (they may differ from the template's during a rollout); `restarts`
 * (if known) tell whether its previous containers' logs are there to read.
 */
export type StreamPod = PodRef & { uid: string; containers?: string[]; restarts?: number };

export type SourceState = { state: LogState; message?: string };

export interface MenuItem {
  label: string;
  icon?: IconName;
  /** A setting: checked or not. */
  on?: boolean;
  hint?: string;
  title?: string;
  run: () => void;
}

export interface LogViewerProps {
  /** Pods whose logs may be streamed (a workload's come and go). */
  pods: Accessor<StreamPod[]>;
  /** The containers of a pod to stream. */
  containersOf: (p: StreamPod) => string[];
  /** Changing it starts over: a new stream, an empty buffer. Null: not ready yet. */
  restart: Accessor<string | null>;
  /** One pod: its lines are not labelled with it. */
  single: Accessor<boolean>;
  /** Pods of several clusters may stream: lines are labelled with theirs. */
  clusters: Accessor<boolean>;
  /** What is shown, for diagnostics. */
  label: Accessor<string>;
  /** The name a saved file starts with. */
  saveName: Accessor<string>;
  /** Controls at the start of the toolbar (the container picker). */
  controls?: JSX.Element;
  /** Items of its own for the menu ("All clusters", "Open in the dock"). */
  menu?: Accessor<MenuItem[]>;
  hasKeyboard: Accessor<boolean>;
  /** Told how the stream is doing (a dock tab shows it). */
  onSummary?: (s: Summary) => void;
}

export interface Summary {
  tone: "ok" | "warn" | "err" | "";
  text: string;
  detail: string;
}

/** What the parts of a log view share. */
export interface LogCtx {
  buffer: () => LogBuffer;
  sources: () => Sources;
  version: Accessor<number>;
  structures: Structures;
  patternIds: () => PatternIds;
  patternOf: (l: Line) => number;
  /** The views (see `buildFilters`). */
  shown: Accessor<Line[]>;
  base: Accessor<Line[]>;
  patternsBase: Accessor<Line[]>;
  matches: Accessor<Line[] | null>;
  /** The views show the entries the buffer kept for the filters (see `LogBuffer.kept`). */
  withKept: Accessor<boolean>;
  hl: Accessor<Highlight | undefined>;
  queryOn: Accessor<boolean>;
  /** The cursor: the line picked (by a click, the keys, a jump). */
  selected: Accessor<Line | null>;
  select: (l: Line | null, reveal?: boolean) => void;
  /** Lines picked together, from the cursor to another line (⇧J/⇧K, ⇧-click): positions, ends included. */
  spanned: Accessor<readonly [number, number] | null>;
  /** The lines picked together, as shown. */
  spanLines: () => Line[];
  /** Picks the lines from the cursor to this one. */
  extendTo: (l: Line) => void;
  /** Back to following new lines (nothing picked). */
  followNew: () => void;
  expanded: Accessor<ReadonlySet<Line>>;
  toggleExpanded: (l: Line) => void;
  unfolded: Accessor<ReadonlySet<Line>>;
  toggleFold: (l: Line) => void;
  label: (i: number) => string;
  title: (i: number) => string;
  color: (i: number) => string;
  labelWidth: Accessor<number>;
  multiSource: Accessor<boolean>;
  follow: Accessor<boolean>;
  setFollow: (on: boolean) => void;
  pausedAt: Accessor<number | null>;
  setPaused: (on: boolean) => void;
  states: Record<number, SourceState>;
  levels: Accessor<ReadonlySet<Level>>;
  setLevels: (s: ReadonlySet<Level>) => void;
  hidden: Accessor<ReadonlySet<number>>;
  setHidden: (s: ReadonlySet<number>) => void;
  solo: Accessor<number | null>;
  setSolo: (i: number | null) => void;
  range: Accessor<readonly [number, number] | null>;
  setRange: (r: readonly [number, number] | null) => void;
  only: Accessor<ReadonlySet<number>>;
  setOnly: (s: ReadonlySet<number>) => void;
  hiddenPatterns: Accessor<ReadonlySet<number>>;
  setHiddenPatterns: (s: ReadonlySet<number>) => void;
  filtersOn: Accessor<boolean>;
  clearFilters: () => void;
  /** Adds a term to the query (a field value clicked). */
  addTerm: (term: string) => void;
  /** Keys of the first and last line on screen (the histogram shows where they are). */
  onScreen: Accessor<readonly [number, number] | null>;
  setOnScreen: (r: readonly [number, number] | null) => void;
  copyLines: (lines: readonly Line[], as: "text" | "jsonl") => void;
  summary: Accessor<Summary>;
  selectionCount: Accessor<{ pods: number; total: number; targets: number }>;
  single: Accessor<boolean>;
  /** Earlier lines: whether there are more, being read… */
  earlier: Accessor<EarlierState>;
  /** Reads earlier lines in place (the stream goes on). */
  loadEarlier: () => void;
  /** Live lines per second (the last 10 s), null when none come. */
  rate: Accessor<number | null>;
  /** How long after they were written the newest lines came (ms), when that is long enough to tell; else null. */
  behind: Accessor<number | null>;
  /** How late a source's lines come, or how long it has been quiet (see `Arrivals`). */
  lag: (i: number) => Lag | undefined;
  /** Lines held back may come in now (the pointer was released, the view is on screen again). */
  flush: () => void;
  /** Whether the line was just expanded by the user (once: it is then scrolled into view). */
  takeOpened: (l: Line) => boolean;
  setView: (v: "lines" | "patterns") => void;
  /** Tall enough for the histogram. */
  roomy: Accessor<boolean>;
}

/** What a marker says about a stream that stopped or started again, and how bad it is. */
function markerLevel(state: LogState, message: string): Level {
  if (state === "error" || /exit code [1-9]|OOMKilled|Error\b|failed|CrashLoopBackOff|ImagePull|ErrImage/.test(message)) return 5;
  if (state === "waiting" || state === "reconnecting") return 4;
  return 3;
}

export function LogViewer(props: LogViewerProps) {
  const [previous, setPrevious] = createSignal(false);
  const [allLines, setAllLines] = createSignal(false);
  const [queryText, setQueryText] = createSignal("");
  const [follow, setFollow] = createSignal(true);
  const [pausedAt, setPausedAt] = createSignal<number | null>(null);
  const [levels, setLevels] = createSignal<ReadonlySet<Level>>(new Set());
  const [hidden, setHidden] = createSignal<ReadonlySet<number>>(new Set());
  const [solo, setSolo] = createSignal<number | null>(null);
  const [range, setRange] = createSignal<readonly [number, number] | null>(null);
  const [only, setOnly] = createSignal<ReadonlySet<number>>(new Set());
  const [hiddenPatterns, setHiddenPatterns] = createSignal<ReadonlySet<number>>(new Set());
  const [selected, setSelected] = createSignal<Line | null>(null);
  /** The other end of the lines picked together (the cursor is one end). */
  const [spanFrom, setSpanFrom] = createSignal<Line | null>(null);
  const [expanded, setExpanded] = createSignal<ReadonlySet<Line>>(new Set());
  const [unfolded, setUnfolded] = createSignal<ReadonlySet<Line>>(new Set());
  const [onScreen, setOnScreen] = createSignal<readonly [number, number] | null>(null);
  /** Lines, or the patterns they follow (each log view starts with its lines). */
  const [view, setView] = createSignal<"lines" | "patterns">("lines");
  /** Tall enough for the histogram (a short dock tab keeps its room for lines). */
  const [roomy, setRoomy] = createSignal(true);

  // What is streamed: changing it starts over (new stream, empty buffer). Pods coming and going does not.
  const spec = createMemo(
    () => {
      const r = props.restart();
      if (r === null) return null;
      const s = since();
      return { r, tail: s || allLines() ? null : tail(), since: s || null, previous: previous() };
    },
    null,
    { equals: (a, b) => JSON.stringify(a) === JSON.stringify(b) },
  );

  // A full buffer keeps what the filters show (see `LogBuffer.kept`).
  const newBuffer = () => {
    const b = new LogBuffer(budget.bytes, budget.lines);
    b.keep = () => untrack(() => filters().keep);
    // The lines being read (or paused on) are not dropped from under the screen (see `LogBuffer.hold`).
    // (The patterns shown instead of the lines: a pause holds what the buffer has.)
    b.hold = () => (lines ? lines.holdPos() : untrack(pausedAt) !== null ? b.dropped : null);
    return b;
  };
  let buffer = newBuffer();
  let sources = new Sources();
  /** How the stream's lines come: how many a second, how late (see `Arrivals`). */
  let arrivals = new Arrivals();
  const [rate, setRate] = createSignal<number | null>(null);
  const [behind, setBehind] = createSignal<number | null>(null);
  const [lags, setLags] = createStore<Record<number, Lag>>({});
  const meter = setInterval(() => {
    const now = Date.now();
    const v = arrivals.view(now);
    batch(() => {
      setRate(v.rate);
      setBehind(v.behind);
      // Each source's, while Sources shows them.
      if (sourcesAt()) setLags(reconcile(arrivals.sources(now)));
    });
  }, 1000);
  onCleanup(() => clearInterval(meter));
  let patternIds = new PatternIds();
  const structures = new Structures();
  const [version, setVersion] = createSignal(0);
  const [states, setStates] = createStore<Record<number, SourceState>>({});
  /** This stream's earlier history (see `Earlier`); `earlierTick` says it changed. */
  let earlier: Earlier | undefined;
  /** The stream's: lines held back go in; markers for lines not kept while paused. */
  let flush = () => {};
  let resumed = () => {};
  const [earlierTick, setEarlierTick] = createSignal(0);

  // Pods × containers, at most MAX_TARGETS containers; pods already streamed stay chosen.
  const selection = createMemo(
    () => {
      const all = props.pods();
      if (spec() === null) return { targets: [] as LogTarget[], pods: 0, total: all.length };
      const chosen = pickPods(all, (p) => sources.streams(p), MAX_TARGETS, (p) => props.containersOf(p).length);
      // (A pod picked without its uid is streamed by name: an empty uid would be "another pod".)
      const targets = chosen.flatMap((p) => props.containersOf(p).map((n): LogTarget => ({ cluster: p.cluster, namespace: p.namespace, pod: p.name, ...(p.uid ? { uid: p.uid } : {}), container: n })));
      return { targets, pods: chosen.length, total: all.length };
    },
    undefined,
    {
      equals: (a, b) =>
        !!a &&
        a.total === b.total &&
        a.pods === b.pods &&
        a.targets.length === b.targets.length &&
        a.targets.every((t, i) => t.uid === b.targets[i].uid && t.cluster === b.targets[i].cluster && t.pod === b.targets[i].pod && t.container === b.targets[i].container && t.namespace === b.targets[i].namespace),
    },
  );

  createEffect(
    on(spec, (s) => {
      // This stream's own buffer and sources: a late message of the previous stream cannot reach the new ones.
      const buf = (buffer = newBuffer());
      const srcs = (sources = new Sources());
      patternIds = new PatternIds();
      structures.clear();
      batch(() => {
        setVersion((v) => v + 1);
        setStates(reconcile({}));
        setFollow(true);
        setPausedAt(null);
        setSelected(null);
        setSpanFrom(null);
        setExpanded(new Set<Line>());
        setUnfolded(new Set<Line>());
        setHidden(new Set<number>());
        setSolo(null);
        setRange(null);
        setOnly(new Set<number>());
        setHiddenPatterns(new Set<number>());
        setRate(null);
        setBehind(null);
        setLags(reconcile({}));
      });
      earlier = undefined;
      const arr = (arrivals = new Arrivals());
      if (!s) return;
      const logSpec: LogSpec = { targets: srcs.assign(untrack(selection).targets), follow: !s.previous, tailLines: s.tail, sinceSeconds: s.since, previous: s.previous, label: untrack(props.label) };
      // The state each target was last in: changes after the first become markers in the timeline.
      const last = new Map<number, LogState>();
      const restartsOf = (src: Source) => untrack(props.pods).find((p) => podKeyOf(p) === podKeyOf(src))?.restarts;
      const early = (earlier = new Earlier({
        buffer: buf,
        sources: () => srcs.byId,
        startedWith: { tail: s.tail, since: s.since, previous: s.previous },
        restarts: restartsOf,
        label: logSpec.label ?? "",
        onChange: () => setEarlierTick((n) => n + 1),
        beforeLoad: () => lines?.sync(),
        onLoaded: () => {
          // (An entry a stack trace's beginning joined has another head: its parsed fields are not its own.)
          structures.clear();
          setVersion((v) => v + 1);
        },
      }));
      onCleanup(() => early.close());
      // Lines are drawn at most every `timing.showEvery` ms, not on every batch that comes (the engine sends a log that
      // writes often every 50 ms, a busy one every 250): the same lines for half the drawing, and a log that writes now
      // and then shows each of its lines at once. Showing them costs what drawing them does: the more it cost, the
      // longer until the next time — a flood of huge lines cannot keep the main thread busy, and scrolling stays
      // smooth. Batches wait outside the buffer meanwhile: what the buffer holds is always what is drawn (lines added
      // under a screen drawn without them would look like a scroll away from them). While the user scrolls what they
      // read, or selects text, lines wait for them to stop: nothing moves under a gesture.
      let waiting: LogLine[][] = [];
      let waitingBytes = 0;
      let firstWaitAt = 0;
      let doneAt = -Infinity;
      let cost = 0;
      let showTimer: ReturnType<typeof setTimeout> | undefined;
      /** Lines not taken in while paused (the buffer full), per source, and the time of the first: a marker on resume. */
      const skipped = new Map<number, { n: number; from: number }>();
      const every = () => (timing.showEvery ? Math.min(timing.maxEvery, Math.max(timing.showEvery, cost * 2, lines?.shown() === false ? HIDDEN_EVERY : 0)) : 0);
      /** Changes the lines (the screen holds on to what it shows), timed. */
      const commit = (change: () => void) => {
        lines?.sync();
        const t0 = performance.now();
        change();
        setVersion((v) => v + 1);
        doneAt = performance.now();
        cost = Math.max(doneAt - t0, cost * 0.75);
      };
      const take = (batch: LogLine[]) => {
        // Paused with the buffer full: the lines shown stay, those that come are counted, not kept.
        if (pausedAt() === null || buf.room()) return buf.add(batch);
        for (const [i, ts] of batch) {
          const gap = skipped.get(i);
          if (gap) gap.n++;
          else skipped.set(i, { n: 1, from: ts ?? Date.now() });
        }
      };
      const show = () => {
        clearTimeout(showTimer);
        showTimer = undefined;
        if (!waiting.length) return;
        const all = waiting;
        waiting = [];
        waitingBytes = 0;
        firstWaitAt = 0;
        commit(() => {
          for (const b of all) take(b);
        });
      };
      const schedule = () => {
        if (!waiting.length) return;
        if (showTimer !== undefined) {
          // (Held back, more than enough text waits: it goes in at the usual pace.)
          if (waitingBytes < HOLD_BYTES) return;
          clearTimeout(showTimer);
          showTimer = undefined;
        }
        const now = performance.now();
        firstWaitAt ||= now;
        let at = doneAt + every();
        const busy = timing.hold ? (lines?.busyUntil() ?? 0) : 0;
        if (busy > now && waitingBytes < HOLD_BYTES) at = Math.max(at, Math.min(busy, firstWaitAt + (busy === Infinity ? PRESS_HOLD_MS : timing.hold)));
        if (at <= now) show();
        else
          showTimer = setTimeout(() => {
            showTimer = undefined;
            schedule();
          }, at - now);
      };
      flush = () => {
        clearTimeout(showTimer);
        showTimer = undefined;
        schedule();
      };
      resumed = () => {
        if (!skipped.size) return;
        const room = buf.lines.length + buf.kept.length >= buf.maxLines * (HOLD_OVER - 0.05) ? `${count(Math.round(buf.maxLines * HOLD_OVER))} lines` : `${Math.round((buf.maxBytes * HOLD_OVER) / 1024 / 1024)} MB`;
        // Each where its gap began: after the last line kept of its source, before those that came since.
        commit(() => {
          for (const [i, gap] of skipped) buf.mark(i, `${count(gap.n)} lines not kept while paused (a paused view keeps up to ${room})`, 4, gap.from);
        });
        skipped.clear();
      };
      onCleanup(() => {
        clearTimeout(showTimer);
        flush = () => {};
        resumed = () => {};
      });
      arr.ask(logSpec.targets.map((t) => t.id!), Date.now());
      const sub = backend().streamLogs(logSpec, (m) => {
        if (m.t === "state") {
          // A late message of a target that was stopped: its source keeps why ("pod deleted").
          if (srcs.byId[m.i]?.gone) return;
          // What came before it is in the log before what it marks.
          show();
          const before = last.get(m.i);
          last.set(m.i, m.state);
          setStates(m.i, { state: m.state, message: m.message });
          // What a stream that starts (again) reads first was written before: catching up is not being late.
          if (m.state === "streaming" && before !== "streaming") arr.restart(m.i, Date.now());
          const restarted = m.state === "streaming" && (before === "waiting" || before === "ended");
          early.streamState(m.i, m.state, restarted && arr.wrote(m.i));
          if ((m.message && m.state !== "reconnecting") || restarted) commit(() => buf.mark(m.i, restarted ? (arr.wrote(m.i) ? "running again" : "started") : m.message!, markerLevel(m.state, m.message ?? "")));
          return;
        }
        for (const l of m.l) waitingBytes += l[2].length;
        waiting.push(m.l);
        early.seen(m.l);
        arr.add(m.l, Date.now());
        schedule();
      });
      onCleanup(() => sub.close());
      // Pods come and go (rollout, scale, eviction): only their streams start and stop, and the lines of pods that
      // went away stay. `gone`: ids whose state says why they stopped (ours, not the engine's).
      const gone = new Set<number>();
      createEffect(
        on(
          selection,
          (sel) => {
            const listed = new Set(props.pods().map(podKeyOf));
            const targets = srcs.assign(sel.targets, (src) => (listed.has(podKeyOf(src)) ? "no longer streamed" : "pod deleted"));
            arr.ask(targets.map((t) => t.id!), Date.now());
            show();
            batch(() => {
              for (const src of srcs.byId) {
                if (src.gone && !gone.has(src.id)) {
                  gone.add(src.id);
                  setStates(src.id, { state: "ended", message: src.gone });
                  buf.mark(src.id, src.gone, 3);
                  setVersion((v) => v + 1);
                } else if (!src.gone && gone.delete(src.id)) setStates(src.id, undefined!);
              }
            });
            sub.setTargets(targets);
          },
          { defer: true },
        ),
      );
    }),
  );

  // ------------------------------------------------------------------ labels
  const multiSource = () => sources.byId.length > 1 || selection().targets.length > 1;
  /** Sources shown of those streamed: "5" or "2/5". */
  const sourceCount = () => {
    version();
    const all = sources.byId.length;
    const shownCount = solo() !== null ? 1 : all - hidden().size;
    return shownCount === all ? `${all}` : `${shownCount}/${all}`;
  };
  const manyContainers = createMemo(() => (version(), new Set(sources.byId.map((t) => t.container)).size > 1));
  const label = (i: number) => {
    const t = sources.byId[i];
    if (!t) return "";
    const pod = props.single() ? "" : podLabel(t.pod);
    return [props.clusters() ? shortName(t.cluster) : "", pod, manyContainers() ? t.container : ""].filter(Boolean).join("/");
  };
  const title = (i: number) => {
    const t = sources.byId[i];
    return t ? `${t.cluster} · ${t.namespace}/${t.pod} · ${t.container}${t.gone ? ` (${t.gone})` : ""}` : "";
  };
  const color = (i: number) => CLUSTER_COLORS[i % CLUSTER_COLORS.length];
  const labelWidth = createMemo(() => {
    version();
    let w = 0;
    for (let i = 0; i < sources.byId.length; i++) w = Math.max(w, label(i).length);
    return Math.min(w, 28);
  });

  // ------------------------------------------------------------------ filters
  // What is typed is coloured at once; a big log is filtered by it once typing pauses (each pass reads every line).
  const [applied, setApplied] = createSignal("");
  let typing: ReturnType<typeof setTimeout> | undefined;
  createEffect(
    on(queryText, (t) => {
      clearTimeout(typing);
      if (!t.trim() || buffer.lines.length < BIG_LOG) setApplied(t);
      else typing = setTimeout(() => setApplied(t), 150);
    }),
  );
  onCleanup(() => clearTimeout(typing));
  const typed = createMemo(() => parseQuery(queryText(), { regex: regexMode(), matchCase: matchCase() }));
  const query = createMemo(() => parseQuery(applied(), { regex: regexMode(), matchCase: matchCase() }));
  const subject = new LineSubject(
    () => buffer,
    structures,
    (i) => sources.byId[i],
    (c) => shortName(c),
  );
  const patternOf = (l: Line) => patternIdOf(l, patternIds, structures);
  const filters = createMemo(() => {
    const st: FilterState = { query: query(), filters: filterMode(), levels: levels(), hidden: hidden(), solo: solo(), range: range(), only: only(), hiddenPatterns: hiddenPatterns(), pausedAt: pausedAt() };
    return buildFilters(st, subject, patternOf);
  });
  // The buffer's views mutate in place: these memos say "changed" on every read of a new version. Filtered, they show
  // the entries the buffer kept as well.
  const withKept = () => filters().keep !== null;
  const patternsBase = createMemo(() => (version(), buffer.view(filters().patterns, withKept())), undefined, { equals: false });
  const base = createMemo(() => (version(), buffer.view(filters().base, withKept())), undefined, { equals: false });
  const shown = createMemo(() => (version(), buffer.view(filters().shown, withKept())), undefined, { equals: false });
  const matches = createMemo(() => {
    version();
    const f = filters().matches;
    return f ? buffer.view(f, withKept()) : null;
  }, undefined, { equals: false });
  const hl = createMemo<Highlight | undefined>(() => (filters().queryOn ? highlighter(query()) : undefined));
  const filtersOn = createMemo(() => (filterMode() && filters().queryOn) || levels().size > 0 || hidden().size > 0 || solo() !== null || range() !== null || only().size > 0 || hiddenPatterns().size > 0);
  const clearFilters = () =>
    batch(() => {
      if (filterMode()) setQueryText("");
      setLevels(new Set<Level>());
      setHidden(new Set<number>());
      setSolo(null);
      setRange(null);
      setOnly(new Set<number>());
      setHiddenPatterns(new Set<number>());
    });

  // ------------------------------------------------------------------ stream summary
  const summary = createMemo<Summary>(() => {
    const entries = Object.entries(states).filter((e): e is [string, SourceState] => !!e[1]);
    const lbl = (id: string) => (entries.length > 1 ? `${label(Number(id)) || sources.byId[Number(id)]?.container}: ` : "");
    const detail = entries.map(([id, s]) => `${title(Number(id))}: ${s.state}${s.message ? ` — ${s.message}` : ""}`).join("\n");
    const find = (state: LogState) => entries.find(([, s]) => s.state === state);
    const err = find("error");
    if (err) return { tone: "err", text: `${lbl(err[0])}${err[1].message ?? "error"}`, detail };
    if (find("reconnecting")) return { tone: "warn", text: "reconnecting…", detail };
    const ended = entries.filter(([, s]) => s.state === "ended").length;
    const endedNote = ended && entries.length > 1 ? ` · ${ended} ended` : "";
    if (pausedAt() !== null) return { tone: "warn", text: `paused${endedNote}`, detail };
    if (find("streaming")) return { tone: "ok", text: `live${endedNote}`, detail };
    const waiting = find("waiting");
    if (waiting) return { tone: "warn", text: `${lbl(waiting[0])}${waiting[1].message ?? "waiting"}`, detail };
    if (entries.length && ended === entries.length) {
      const one = entries.length === 1 ? entries[0][1].message : undefined;
      return { tone: "", text: one ?? "ended", detail };
    }
    return { tone: "", text: selection().targets.length ? "connecting…" : "waiting for pods…", detail };
  });
  createEffect(() => props.onSummary?.(summary()));

  // ------------------------------------------------------------------ the cursor, expansion, folding
  let lines: LinesHandle | undefined;
  /** The line the user expanded last, until its details are drawn (they scroll themselves into view then). */
  let opened: Line | null = null;
  // A line picked is being read: new lines no longer move it off screen.
  const select = (l: Line | null, reveal = false) => {
    batch(() => {
      setSelected(l);
      setSpanFrom(null);
      if (l) setFollow(false);
    });
    if (l && reveal) lines?.reveal(l);
  };
  const spanned = createMemo<readonly [number, number] | null>(
    () => {
      // (Positions change as earlier lines come in front.)
      version();
      const a = spanFrom();
      const b = selected();
      return a && b && a !== b ? [Math.min(a.pos, b.pos), Math.max(a.pos, b.pos)] : null;
    },
    null,
    { equals: (a, b) => a === b || (!!a && !!b && a[0] === b[0] && a[1] === b[1]) },
  );
  const spanLines = () => {
    const r = spanned();
    if (!r) return [];
    const pool = shown();
    return pool.slice(indexAtPos(pool, r[0]), indexAtPos(pool, r[1] + 1));
  };
  const extendTo = (l: Line) =>
    batch(() => {
      setSpanFrom(spanFrom() ?? selected() ?? l);
      setSelected(l);
      setFollow(false);
    });
  const followNew = () => {
    batch(() => {
      setSelected(null);
      setSpanFrom(null);
      setFollow(true);
    });
    lines?.toBottom();
  };
  /**
   * Moves the cursor a line (`extend`: picking the lines on its way). Without one on screen it starts there: down
   * from the first line on screen, up from the last. Up from the first line, earlier lines are read.
   */
  const move = (dir: 1 | -1, extend = false) => {
    const pool = shown();
    if (!pool.length || !lines) return;
    const sel = selected();
    const k = sel ? indexAtPos(pool, sel.pos) : -1;
    let at: number;
    if (sel && pool[k] === sel && (extend || lines.visible(sel))) at = k + dir;
    else {
      const edge = lines.onScreen();
      at = edge ? indexAtPos(pool, edge[dir > 0 ? 0 : 1].pos) : dir > 0 ? 0 : pool.length - 1;
    }
    if (at < 0 && earlierState().phase === "more") earlier?.load();
    const l = pool[Math.max(0, Math.min(pool.length - 1, at))];
    batch(() => {
      setSpanFrom(extend ? (spanFrom() ?? sel ?? l) : null);
      setSelected(l);
      setFollow(false);
    });
    lines.keepVisible(l);
  };
  /** A page down or up: the cursor (on screen) keeps its place on it. */
  const page = (dir: 1 | -1) => {
    const l = lines?.page(dir, selected());
    if (l)
      batch(() => {
        setSpanFrom(null);
        setSelected(l);
      });
  };
  /** The first line (the cursor too, if there is one): earlier lines are read when there are more. */
  const toFirst = () => {
    if (!lines) return;
    lines.toTop();
    const first = shown()[0];
    if (selected() && first) select(first);
  };
  const toggle = (set: Accessor<ReadonlySet<Line>>, put: (s: ReadonlySet<Line>) => void) => (l: Line) => {
    const next = new Set(set());
    if (!next.delete(l)) {
      next.add(l);
      if (set === expanded) opened = l;
    }
    batch(() => {
      // Opening a line selects it and keeps it where it is.
      if (selected() !== l) setSelected(l);
      setFollow(false);
      put(next);
    });
  };
  const toggleExpanded = toggle(expanded, setExpanded);
  const toggleFold = toggle(unfolded, setUnfolded);

  // n / N: the next match — or, with nothing to match, the next warning or error ([ / ] always those).
  const jump = (dir: 1 | -1, problemsOnly = false) => {
    const m = problemsOnly ? null : matches();
    const pool = m ?? shown();
    if (!pool.length) return;
    const want = m || (!problemsOnly && filters().queryOn) ? null : (l: Line) => l.lvl >= 4 && !l.marker;
    // From the selected line, else from the top of the screen (which counts itself).
    const sel = selected();
    const top = lines?.top();
    let at = sel ? indexAtPos(pool, dir > 0 ? sel.pos + 1 : sel.pos) : indexAtPos(pool, top?.pos ?? (dir > 0 ? 0 : Infinity));
    if (dir < 0) at--;
    for (let n = 0; n < pool.length; n++, at += dir) {
      const l = pool[((at % pool.length) + pool.length) % pool.length];
      if (want && !want(l)) continue;
      setFollow(false);
      if (fold() && l.more && l.more.length > FOLD_AT && !unfolded().has(l)) setUnfolded(new Set(unfolded()).add(l));
      select(l, true);
      return;
    }
  };

  // ------------------------------------------------------------------ copy, save
  const exportLines = (ls: readonly Line[]): ExportLine[] => ls.map((l) => ({ i: l.i, ts: l.ts, text: l.text, more: l.more, lvl: l.lvl, marker: l.marker }));
  const sourceOf = (i: number) => {
    const s = sources.byId[i];
    return s ? { cluster: s.cluster, namespace: s.namespace, pod: s.pod, container: s.container } : undefined;
  };
  const textOf = (ls: readonly Line[], as: "text" | "jsonl") =>
    as === "jsonl" ? asJsonl(exportLines(ls), sourceOf) : asText(exportLines(ls), { timestamps: showTs(), utc: utc(), label: multiSource() ? (i) => label(i).padEnd(labelWidth()) : undefined });
  const copyLines = (ls: readonly Line[], as: "text" | "jsonl") => {
    void copyText(textOf(ls, as), `Copied ${plural(ls.length, ls.length === 1 && !ls[0].more ? "line" : "entry", "entries")}`);
  };
  /** Copies the lines picked together, else the cursor's line. */
  const copyPicked = () => {
    const span = spanLines();
    if (span.length) copyLines(span, "text");
    else if (selected()) copyLines([selected()!], "text");
    else return false;
  };
  const save = async (as: "text" | "jsonl") => {
    const ls = shown();
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    const name = `${props.saveName()}-${stamp}.${as === "jsonl" ? "jsonl" : "log"}`;
    try {
      const path = await backend().saveFile(name, textOf(ls, as));
      if (path) toast("success", `Saved ${plural(ls.length, "entry", "entries")}`, path);
    } catch (e) {
      toast("error", "Could not save the logs", errorMessage(e));
    }
  };

  // ------------------------------------------------------------------ keyboard
  let queryEl: HTMLInputElement | undefined;
  const focusQuery = () => {
    queryEl?.focus();
    queryEl?.select();
  };
  const setPaused = (on: boolean) => {
    batch(() => {
      setPausedAt(on ? buffer.seq - 1 : null);
      if (!on) setFollow(true);
    });
    // Paused, the screen holds on to what it shows (it no longer follows the lines that come).
    if (on) lines?.anchorHere();
    if (!on) {
      resumed();
      lines?.toBottom();
    }
  };
  onMount(() => {
    const keys: Binding[] = [
      { id: "logs.find", inInputs: true, run: focusQuery },
      { id: "logs.wrap", run: () => setWrap(!wrap()) },
      { id: "logs.timestamps", run: () => setShowTs(!showTs()) },
      { id: "logs.previous-containers", run: () => setPrevious(!previous()) },
      { id: "logs.pretty", run: () => setPretty(!pretty()) },
      { id: "logs.histogram", run: () => setHistogramOpen(!histogramOpen()) },
      { id: "logs.pause", run: () => setPaused(pausedAt() === null) },
      { id: "logs.next-match", run: () => jump(1) },
      { id: "logs.previous-match", run: () => jump(-1) },
      { id: "logs.next-problem", run: () => jump(1, true) },
      { id: "logs.previous-problem", run: () => jump(-1, true) },
      { id: "logs.expand", run: () => (selected() ? toggleExpanded(selected()!) : false) },
      { combo: "enter", run: (e) => (selected() && !onControl(e) ? toggleExpanded(selected()!) : false) },
      { id: "logs.copy", run: copyPicked },
      // ⌘C copies text selected with the mouse, else the lines picked.
      { combo: "mod+c", run: () => (window.getSelection()?.isCollapsed === false ? false : copyPicked()) },
      { id: "logs.save", inInputs: true, run: () => void save("text") },
    ];
    // The cursor's keys (before the details' scrolling ones). Keys a focused control has a use for stay its own.
    const own = (run: () => void) => (e: KeyboardEvent) => (onControl(e) ? false : run());
    const cursor: Binding[] = [
      { id: "logs.down", run: () => move(1) },
      { combo: "arrowdown", run: own(() => move(1)) },
      { id: "logs.up", run: () => move(-1) },
      { combo: "arrowup", run: own(() => move(-1)) },
      { id: "logs.pick-down", run: () => move(1, true) },
      { combo: "shift+arrowdown", run: own(() => move(1, true)) },
      { id: "logs.pick-up", run: () => move(-1, true) },
      { combo: "shift+arrowup", run: own(() => move(-1, true)) },
      { combo: "pagedown", run: own(() => page(1)) },
      { combo: "space", run: own(() => page(1)) },
      { combo: "pageup", run: own(() => page(-1)) },
      { combo: "shift+space", run: own(() => page(-1)) },
      { id: "logs.first", run: toFirst },
      { combo: "home", run: own(toFirst) },
      { id: "logs.last", run: followNew },
      { combo: "end", run: own(followNew) },
      {
        combo: "escape",
        run: () => {
          if (spanFrom()) setSpanFrom(null);
          else if (selected()) setSelected(null);
          else return false;
        },
      },
    ];
    onCleanup(
      bindAll([
        ...keys.map((b) => ({ ...b, when: props.hasKeyboard })),
        ...cursor.map((b) => ({ ...b, priority: 10, when: () => props.hasKeyboard() && view() === "lines" })),
      ]),
    );
  });

  const earlierState = createMemo<EarlierState>(
    () => {
      version();
      earlierTick();
      return earlier?.state() ?? { phase: "", more: 0, previous: 0, loaded: 0 };
    },
    { phase: "", more: 0, previous: 0, loaded: 0 },
    { equals: (a, b) => a.phase === b.phase && a.more === b.more && a.previous === b.previous && a.loaded === b.loaded && a.error === b.error },
  );

  // ------------------------------------------------------------------ toolbar
  const history = () => (since() ? `s${since()}` : allLines() ? "all" : `t${tail()}`);
  const setHistory = (v: string) =>
    batch(() => {
      if (v.startsWith("s")) {
        setSince(Number(v.slice(1)));
        setAllLines(false);
      } else {
        setSince(0);
        setAllLines(v === "all");
        if (v.startsWith("t")) setTail(Number(v.slice(1)));
      }
    });
  const [menuAt, setMenuAt] = createSignal<HTMLElement>();
  const [sourcesAt, setSourcesAt] = createSignal<HTMLElement>();
  // Sources shows each source's lag as it opens (and the meter keeps it up while it is open).
  createEffect(
    on(sourcesAt, (at) => {
      if (at) setLags(reconcile(arrivals.sources(Date.now())));
    }),
  );
  const [fieldsAt, setFieldsAt] = createSignal<HTMLElement>();
  // Whether there are structured lines (once seen, until the stream starts over).
  let seenStructured = false;
  createEffect(on(spec, () => (seenStructured = false)));
  const structuredSeen = createMemo(() => {
    version();
    if (seenStructured) return true;
    const list = buffer.lines;
    for (let k = list.length - 1, n = 0; k >= 0 && n < 200; k--, n++) if (structures.get(list[k])) return (seenStructured = true);
    return false;
  });

  const ctx: LogCtx = {
    buffer: () => buffer,
    sources: () => sources,
    version,
    structures,
    patternIds: () => patternIds,
    patternOf,
    shown,
    base,
    patternsBase,
    matches,
    withKept,
    hl,
    queryOn: () => filters().queryOn,
    selected,
    select,
    spanned,
    spanLines,
    extendTo,
    followNew,
    expanded,
    toggleExpanded,
    unfolded,
    toggleFold,
    label,
    title,
    color,
    labelWidth,
    multiSource,
    follow,
    setFollow,
    pausedAt,
    setPaused,
    states,
    levels,
    setLevels,
    hidden,
    setHidden,
    solo,
    setSolo,
    range,
    setRange,
    only,
    setOnly,
    hiddenPatterns,
    setHiddenPatterns,
    filtersOn,
    clearFilters,
    addTerm: (term) => {
      batch(() => {
        setQueryText(withTerm(queryText(), term, matchCase()));
        // Clicking a value filters by it: finding would leave every line shown.
        setFilterMode(true);
      });
      rememberQuery(queryText());
    },
    onScreen,
    setOnScreen,
    copyLines,
    summary,
    selectionCount: () => ({ pods: selection().pods, total: selection().total, targets: selection().targets.length }),
    single: props.single,
    earlier: earlierState,
    loadEarlier: () => earlier?.load(),
    rate: () => (pausedAt() === null ? rate() : null),
    behind: () => (pausedAt() === null ? behind() : null),
    lag: (i) => lags[i],
    flush: () => flush(),
    takeOpened: (l) => {
      if (opened !== l) return false;
      opened = null;
      return true;
    },
    setView,
    roomy,
  };

  const menuItems = createMemo((): (MenuItem | null)[] => [
    { label: "Previous container", hint: keyOf("logs.previous-containers"), on: previous(), title: "Logs of the containers before their last restart (crashed ones)", run: () => setPrevious(!previous()) },
    ...(props.menu?.() ?? []),
    null,
    { label: "Timestamps", hint: keyOf("logs.timestamps"), on: showTs(), run: () => setShowTs(!showTs()) },
    { label: "Wrap lines", hint: keyOf("logs.wrap"), on: wrap(), run: () => setWrap(!wrap()) },
    { label: "Pretty structured lines", hint: keyOf("logs.pretty"), on: pretty(), title: "JSON and logfmt lines as level, message and fields; plain lines coloured", run: () => setPretty(!pretty()) },
    { label: "Fold long stack traces", on: fold(), run: () => setFold(!fold()) },
    { label: "Times in UTC", on: utc(), run: () => setUtc(!utc()) },
    { label: "Histogram", hint: keyOf("logs.histogram"), on: histogramOpen(), run: () => setHistogramOpen(!histogramOpen()) },
    null,
    { label: "Copy shown lines", icon: "copy", run: () => copyLines(shown(), "text") },
    { label: "Copy shown lines as JSON Lines", icon: "copy", run: () => copyLines(shown(), "jsonl") },
    { label: "Save shown lines…", icon: "download", hint: keyOf("logs.save"), run: () => void save("text") },
    { label: "Save as JSON Lines…", icon: "download", run: () => void save("jsonl") },
    null,
    {
      label: "Clear",
      icon: "trash",
      title: "Empty the view (new lines keep coming)",
      run: () => {
        buffer.clear();
        structures.clear();
        earlier?.clear();
        batch(() => {
          setSelected(null);
          setSpanFrom(null);
          setVersion((v) => v + 1);
        });
      },
    },
  ]);

  let root!: HTMLDivElement;
  onMount(() => {
    const ro = new ResizeObserver(() => setRoomy(root.clientHeight >= 380));
    ro.observe(root);
    onCleanup(() => ro.disconnect());
  });

  return (
    <div class="logv" ref={root}>
      <div class="toolbar logv-bar">
        {props.controls}
        <select class="input" value={history()} onChange={(e) => setHistory(e.currentTarget.value)} title="History to read: the last lines of each container (with many containers, each gets a share), or a recent stretch of time">
          <optgroup label="Lines">
            <For each={TAILS}>{(n) => <option value={`t${n}`}>Last {count(n)} lines</option>}</For>
            <option value="all">All lines</option>
          </optgroup>
          <optgroup label="Time">
            <For each={SINCES}>{(s) => <option value={`s${s}`}>Last {s < 3600 ? `${s / 60} min` : `${s / 3600} h`}</option>}</For>
          </optgroup>
        </select>
        <QueryField
          ctx={ctx}
          query={typed}
          text={queryText}
          setText={setQueryText}
          ref={(el) => (queryEl = el)}
          jump={jump}
          flush={() => {
            clearTimeout(typing);
            setApplied(queryText());
          }}
        />
        <button
          class="btn sm ghost icon"
          classList={{ on: pausedAt() !== null }}
          title={pausedAt() !== null ? `${withKeys("Resume", "logs.pause")}: show the lines that came meanwhile` : `${withKeys("Pause", "logs.pause")}: stop showing new lines (they are kept)`}
          data-hint={keyOf("logs.pause")}
          data-hint-ctx="details"
          data-hint-at="below"
          onClick={() => setPaused(pausedAt() === null)}
        >
          <Icon name={pausedAt() !== null ? "play" : "pause"} size={12} />
        </button>
        <div class="seg" role="tablist" title="Lines, or the patterns they follow">
          <button role="tab" classList={{ on: view() === "lines" }} aria-selected={view() === "lines"} onClick={() => setView("lines")}>
            <Icon name="logs" size={12} />
            <span class="seg-label">Lines</span>
          </button>
          <button role="tab" classList={{ on: view() === "patterns" }} aria-selected={view() === "patterns"} onClick={() => setView("patterns")} title="Patterns: lines grouped by what stays the same between them, counted">
            <Icon name="patterns" size={12} />
            <span class="seg-label">Patterns</span>
          </button>
        </div>
        <Show when={multiSource()}>
          <button class="btn sm ghost" classList={{ on: hidden().size > 0 || solo() !== null }} title="Sources: pods and containers, their state; show or hide them" onClick={(e) => setSourcesAt(e.currentTarget)}>
            <Icon name="layers" size={12} />
            <span class="lbl-wide">{sourceCount()}</span>
          </button>
        </Show>
        <Show when={structuredSeen()}>
          <button class="btn sm ghost" title="Fields of the structured lines: their values, as columns or filters" onClick={(e) => setFieldsAt(e.currentTarget)}>
            <Icon name="columns" size={12} />
            <span class="lbl-wide">Fields</span>
          </button>
        </Show>
        <span class="sep opt-wide" />
        <button
          class="btn sm ghost icon opt-wide"
          classList={{ on: showTs() }}
          onClick={() => setShowTs(!showTs())}
          title={withKeys("Timestamps", "logs.timestamps")}
          data-hint={keyOf("logs.timestamps")}
          data-hint-ctx="details"
          data-hint-at="below"
        >
          <Icon name="clock" size={12} />
        </button>
        <button class="btn sm ghost icon opt-wide" classList={{ on: wrap() }} onClick={() => setWrap(!wrap())} title={withKeys("Wrap lines", "logs.wrap")} data-hint={keyOf("logs.wrap")} data-hint-ctx="details" data-hint-at="below">
          <Icon name="wrap" size={12} />
        </button>
        <button
          class="btn sm ghost icon opt-wide"
          classList={{ on: pretty() }}
          onClick={() => setPretty(!pretty())}
          title={`${withKeys("Pretty", "logs.pretty")}: JSON and logfmt lines as level, message and fields; plain lines coloured. Off: as written`}
          data-hint={keyOf("logs.pretty")}
          data-hint-ctx="details"
          data-hint-at="below"
        >
          <Icon name="braces" size={12} />
        </button>
        <button class="btn sm ghost icon" classList={{ on: previous() }} title="More: previous container, display, copy, save" onClick={(e) => setMenuAt(e.currentTarget)}>
          <Icon name="more" size={13} />
        </button>
      </div>
      <LogStrip ctx={ctx} />
      <Show when={view() === "lines"} fallback={<LogPatterns ctx={ctx} />}>
        <LogLines ctx={ctx} ref={(h) => (lines = h)} />
      </Show>
      <Show when={menuAt()}>
        <Popover anchor={menuAt()} onClose={() => setMenuAt(undefined)} width={270} align="right">
          <div class="menu" role="menu" aria-label="Log view">
            <For each={menuItems()}>
              {(item) =>
                item ? (
                  <button
                    class="opt"
                    role={item.on !== undefined ? "menuitemcheckbox" : "menuitem"}
                    aria-checked={item.on !== undefined ? item.on : undefined}
                    title={item.title}
                    data-key={item.hint}
                    onClick={() => {
                      setMenuAt(undefined);
                      item.run();
                    }}
                  >
                    <Show when={item.on !== undefined} fallback={<Icon name={item.icon ?? "logs"} size={13} />}>
                      <span class="check" classList={{ on: item.on }}>
                        <Icon name="check" size={11} strokeWidth={3} />
                      </span>
                    </Show>
                    <span>{item.label}</span>
                    <Show when={item.hint}>
                      <span class="kbd">{comboLabel(item.hint!)}</span>
                    </Show>
                  </button>
                ) : (
                  <div class="menu-sep" role="separator" />
                )
              }
            </For>
          </div>
        </Popover>
      </Show>
      <Show when={sourcesAt()}>
        <LogSources ctx={ctx} anchor={sourcesAt()!} onClose={() => setSourcesAt(undefined)} />
      </Show>
      <Show when={fieldsAt()}>
        <LogFields ctx={ctx} anchor={fieldsAt()!} onClose={() => setFieldsAt(undefined)} />
      </Show>
    </div>
  );
}

