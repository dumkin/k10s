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
import { bindAll, comboLabel } from "../../lib/hotkeys";
import { shortName } from "../../state/clusters";
import { onControl } from "../../state/keyboard";
import { toast } from "../../state/ui";
import { indexAtPos, type Line, LogBuffer, MAX_BYTES, MAX_LINES, pickPods, type PodRef, podKeyOf, type Source, Sources } from "../logBuffer";
import { Earlier, type EarlierState } from "./earlier";
import { LogFields, LogSources } from "./LogPopovers";
import { LogLines, type LinesHandle } from "./LogLines";
import { LogPatterns } from "./LogPatterns";
import { LogStrip } from "./LogStrip";
import {
  buildFilters,
  type FilterState,
  FOLD_AT,
  filterMode,
  fold,
  histogramOpen,
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
/** Lines that keep coming are shown at most every `showEvery` ms; the first after a pause at once. (Tests: 0.) */
export const timing = { showEvery: 100 };
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
  /** Scrolls a line into view (set by the lines). */
  reveal: (l: Line) => void;
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
    return b;
  };
  let buffer = newBuffer();
  let sources = new Sources();
  /** Live lines as they arrived: [when, how many]; the last 10 s of them make the rate. */
  const arrivals: [number, number][] = [];
  const [rate, setRate] = createSignal<number | null>(null);
  const meter = setInterval(() => {
    const from = Date.now() - 10_000;
    while (arrivals.length && arrivals[0][0] < from) arrivals.shift();
    const n = arrivals.reduce((sum, [, k]) => sum + k, 0);
    setRate(n ? n / 10 : null);
  }, 1000);
  onCleanup(() => clearInterval(meter));
  let patternIds = new PatternIds();
  const structures = new Structures();
  const [version, setVersion] = createSignal(0);
  const [states, setStates] = createStore<Record<number, SourceState>>({});
  /** This stream's earlier history (see `Earlier`); `earlierTick` says it changed. */
  let earlier: Earlier | undefined;
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
      });
      earlier = undefined;
      if (!s) return;
      const logSpec: LogSpec = { targets: srcs.assign(untrack(selection).targets), follow: !s.previous, tailLines: s.tail, sinceSeconds: s.since, previous: s.previous, label: untrack(props.label) };
      // The state each target was last in: changes after the first become markers in the timeline.
      const last = new Map<number, LogState>();
      /** Targets that wrote lines already (a container that comes back "runs again", else it "started"). */
      const wrote = new Set<number>();
      const restartsOf = (src: Source) => untrack(props.pods).find((p) => podKeyOf(p) === podKeyOf(src))?.restarts;
      const early = (earlier = new Earlier({
        buffer: buf,
        sources: () => srcs.byId,
        startedWith: { tail: s.tail, since: s.since, previous: s.previous },
        restarts: restartsOf,
        label: logSpec.label ?? "",
        onChange: () => setEarlierTick((n) => n + 1),
        onLoaded: () => {
          // (An entry a stack trace's beginning joined has another head: its parsed fields are not its own.)
          structures.clear();
          setVersion((v) => v + 1);
        },
      }));
      onCleanup(() => early.close());
      // Lines are drawn at most every `timing.showEvery` ms, not on every batch that comes (the engine sends a log that
      // writes often every 50 ms, a busy one every 250): the same lines for half the drawing, and a log that writes now
      // and then shows each of its lines at once. Batches wait outside the buffer meanwhile: what the buffer holds is
      // always what is drawn (lines added under a screen drawn without them would look like a scroll away from them).
      let waiting: LogLine[][] = [];
      let shownAt = -Infinity;
      let showTimer: ReturnType<typeof setTimeout> | undefined;
      const show = () => {
        clearTimeout(showTimer);
        showTimer = undefined;
        if (!waiting.length) return;
        shownAt = performance.now();
        for (const lines of waiting) buf.add(lines);
        waiting = [];
        setVersion((v) => v + 1);
      };
      onCleanup(() => clearTimeout(showTimer));
      const sub = backend().streamLogs(logSpec, (m) => {
        if (m.t === "state") {
          // A late message of a target that was stopped: its source keeps why ("pod deleted").
          if (srcs.byId[m.i]?.gone) return;
          // What came before it is in the log before what it marks.
          show();
          const before = last.get(m.i);
          last.set(m.i, m.state);
          setStates(m.i, { state: m.state, message: m.message });
          const restarted = m.state === "streaming" && (before === "waiting" || before === "ended");
          early.streamState(m.i, m.state, restarted && wrote.has(m.i));
          if ((m.message && m.state !== "reconnecting") || restarted) {
            buf.mark(m.i, restarted ? (wrote.has(m.i) ? "running again" : "started") : m.message!, markerLevel(m.state, m.message ?? ""));
            setVersion((v) => v + 1);
          }
          return;
        }
        for (const l of m.l) wrote.add(l[0]);
        waiting.push(m.l);
        early.seen(m.l);
        // Live lines (written in the last half minute): what the rate counts.
        const recent = Date.now() - 30_000;
        let live = 0;
        for (const l of m.l) if (l[1] === null || l[1] >= recent) live++;
        if (live) arrivals.push([Date.now(), live]);
        const wait = shownAt + timing.showEvery - performance.now();
        if (wait <= 0) show();
        else showTimer ??= setTimeout(show, wait);
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
    const pod = props.single() ? "" : t.pod.replace(/^.*-([a-z0-9]{5})$/, "…$1");
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
    const el = lines?.scroller();
    if (!el) return;
    setFollow(false);
    lines!.byUser();
    el.scrollTop = 0;
    const first = shown()[0];
    if (selected() && first) select(first);
  };
  const toggle = (set: Accessor<ReadonlySet<Line>>, put: (s: ReadonlySet<Line>) => void) => (l: Line) => {
    const next = new Set(set());
    if (!next.delete(l)) next.add(l);
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
    void navigator.clipboard.writeText(textOf(ls, as)).then(
      () => toast("success", `Copied ${plural(ls.length, ls.length === 1 && !ls[0].more ? "line" : "entry", "entries")}`),
      (e) => toast("error", "Could not copy", errorMessage(e)),
    );
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
    if (!on) lines?.toBottom();
  };
  onMount(() => {
    const keys: { combo: string; run: (e: KeyboardEvent) => boolean | void; inInputs?: boolean }[] = [
      { combo: "/", run: focusQuery },
      { combo: "mod+f", inInputs: true, run: focusQuery },
      { combo: "w", run: () => setWrap(!wrap()) },
      { combo: "t", run: () => setShowTs(!showTs()) },
      { combo: "p", run: () => setPrevious(!previous()) },
      { combo: "v", run: () => setPretty(!pretty()) },
      { combo: "h", run: () => setHistogramOpen(!histogramOpen()) },
      { combo: "s", run: () => setPaused(pausedAt() === null) },
      { combo: "n", run: () => jump(1) },
      { combo: "shift+n", run: () => jump(-1) },
      { combo: "]", run: () => jump(1, true) },
      { combo: "[", run: () => jump(-1, true) },
      { combo: "x", run: () => (selected() ? toggleExpanded(selected()!) : false) },
      { combo: "enter", run: (e) => (selected() && !onControl(e) ? toggleExpanded(selected()!) : false) },
      { combo: "c", run: copyPicked },
      // ⌘C copies text selected with the mouse, else the lines picked.
      { combo: "mod+c", run: () => (window.getSelection()?.isCollapsed === false ? false : copyPicked()) },
      { combo: "mod+s", inInputs: true, run: () => void save("text") },
    ];
    // The cursor's keys (before the details' scrolling ones). Keys a focused control has a use for stay its own.
    const own = (run: () => void) => (e: KeyboardEvent) => (onControl(e) ? false : run());
    const cursor: typeof keys = [
      { combo: "j", run: () => move(1) },
      { combo: "arrowdown", run: own(() => move(1)) },
      { combo: "k", run: () => move(-1) },
      { combo: "arrowup", run: own(() => move(-1)) },
      { combo: "shift+j", run: () => move(1, true) },
      { combo: "shift+arrowdown", run: own(() => move(1, true)) },
      { combo: "shift+k", run: () => move(-1, true) },
      { combo: "shift+arrowup", run: own(() => move(-1, true)) },
      { combo: "pagedown", run: own(() => page(1)) },
      { combo: "space", run: own(() => page(1)) },
      { combo: "pageup", run: own(() => page(-1)) },
      { combo: "shift+space", run: own(() => page(-1)) },
      { combo: "g", run: toFirst },
      { combo: "home", run: own(toFirst) },
      { combo: "shift+g", run: followNew },
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
    reveal: (l) => lines?.reveal(l),
    copyLines,
    summary,
    selectionCount: () => ({ pods: selection().pods, total: selection().total, targets: selection().targets.length }),
    single: props.single,
    earlier: earlierState,
    loadEarlier: () => earlier?.load(),
    rate: () => (pausedAt() === null ? rate() : null),
    setView,
    roomy,
  };

  const menuItems = createMemo((): (MenuItem | null)[] => [
    { label: "Previous container", hint: "p", on: previous(), title: "Logs of the containers before their last restart (crashed ones)", run: () => setPrevious(!previous()) },
    ...(props.menu?.() ?? []),
    null,
    { label: "Timestamps", hint: "t", on: showTs(), run: () => setShowTs(!showTs()) },
    { label: "Wrap lines", hint: "w", on: wrap(), run: () => setWrap(!wrap()) },
    { label: "Pretty structured lines", hint: "v", on: pretty(), title: "JSON and logfmt lines as level, message and fields; plain lines coloured", run: () => setPretty(!pretty()) },
    { label: "Fold long stack traces", on: fold(), run: () => setFold(!fold()) },
    { label: "Times in UTC", on: utc(), run: () => setUtc(!utc()) },
    { label: "Histogram", hint: "h", on: histogramOpen(), run: () => setHistogramOpen(!histogramOpen()) },
    null,
    { label: "Copy shown lines", icon: "copy", run: () => copyLines(shown(), "text") },
    { label: "Copy shown lines as JSON Lines", icon: "copy", run: () => copyLines(shown(), "jsonl") },
    { label: "Save shown lines…", icon: "download", hint: "mod+s", run: () => void save("text") },
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
          title={pausedAt() !== null ? "Resume (S): show the lines that came meanwhile" : "Pause (S): stop showing new lines (they are kept)"}
          data-hint="s"
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
        <button class="btn sm ghost icon opt-wide" classList={{ on: showTs() }} onClick={() => setShowTs(!showTs())} title="Timestamps (T)" data-hint="t" data-hint-ctx="details" data-hint-at="below">
          <Icon name="clock" size={12} />
        </button>
        <button class="btn sm ghost icon opt-wide" classList={{ on: wrap() }} onClick={() => setWrap(!wrap())} title="Wrap lines (W)" data-hint="w" data-hint-ctx="details" data-hint-at="below">
          <Icon name="wrap" size={12} />
        </button>
        <button class="btn sm ghost icon opt-wide" classList={{ on: pretty() }} onClick={() => setPretty(!pretty())} title="Pretty (V): JSON and logfmt lines as level, message and fields; plain lines coloured. Off: as written" data-hint="v" data-hint-ctx="details" data-hint-at="below">
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

