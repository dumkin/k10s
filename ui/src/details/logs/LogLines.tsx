import { batch, createComputed, createEffect, createMemo, createRenderEffect, createSignal, For, Index, type JSX, Match, on, onCleanup, onMount, Show, Switch, untrack } from "solid-js";
import { Icon } from "../../components/Icon";
import { Kbd } from "../../components/Kbd";
import { Popover } from "../../components/Popover";
import { count } from "../../lib/format";
import { withKeys } from "../../lib/hotkeys";
import { keyOf } from "../../lib/keymap";
import { clockOf, dayOf, gapOf, stampOf } from "../../lib/logs/format";
import { type Piece, slicePieces } from "../../lib/logs/highlight";
import { type FieldValue, jsonOf, LEVEL_NAME, LEVEL_TAG, TRACE_KEYS } from "../../lib/logs/parse";
import { fieldTerm } from "../../lib/logs/query";
import { copyText } from "../../state/ui";
import { indexAtPos, type Line, plainOf } from "../logBuffer";
import { blocksOf, textEnd, WHOLE } from "./hwindow";
import type { LogCtx } from "./LogViewer";
import { FOLD_AT, FOLD_SHOW, fold, GAP_MS, LINE_H, pinned, pretty, showTs, togglePinned, utc, wrap } from "./model";
import { headOf, textPieces, valueText } from "./render";

/** Rows drawn off screen, in pixels: ahead of the way the view scrolls at least this much (or a screen)… */
const AHEAD_MIN_PX = 400;
/** …while following, only this much above the bottom screen (a wheel up draws more before the screen moves)… */
const FOLLOW_ABOVE_PX = 160;
/** …and at most this much text on each side (a screen of 7 KB lines must not lay out megabytes). */
const CHAR_BUDGET = 60_000;
/** The way the view scrolled counts this long after it last moved. */
const LEAD_MS = 200;
/** A wheel gesture goes on this long after its last event (its momentum's events come closer than this). */
const GESTURE_MS = 150;
/** Upward wheel events this soon after following was asked for (a gesture's momentum) do not stop it. */
const FOLLOW_GRACE_MS = 250;
/** A row's width besides its columns: its padding, the expand button, the text's padding, the time's rule (px). */
const ROW_EXTRA = 54;
/** Lines drawn up to here are coloured as they come (the rest of a line once the view is scrolled that far). */
const TOKEN_UPTO = 1024;
/** A value of an expanded line longer than this shows its beginning, and the rest on a click. */
const VALUE_SHOWN = 600;
/** An expanded plain line shows this much of its text. */
const TEXT_SHOWN = 16_384;

/** A structured line's own time (unix seconds or millis, or text) in millis; null if it is none. */
function timeOf(v: FieldValue): number | null {
  if (typeof v === "number") return v > 1e14 ? v / 1000 : v > 1e11 ? v : v > 1e8 ? v * 1000 : null;
  if (typeof v !== "string") return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
}

export interface LinesHandle {
  /** Scrolls a line into view (to a third of the height when it is off screen). */
  reveal(l: Line): void;
  /** Scrolls as little as it takes to show a line whole (its top, when it is taller than the screen). */
  keepVisible(l: Line): void;
  /** Back at the bottom (following is on). */
  toBottom(): void;
  /** The first line on top (earlier lines are read when there are more). */
  toTop(): void;
  scroller(): HTMLElement | undefined;
  /** The line at the top of the screen. */
  top(): Line | undefined;
  /** The first and the last line wholly on screen (partly, when none is whole). */
  onScreen(): readonly [Line, Line] | null;
  /** Whether some of a line is on screen. */
  visible(l: Line): boolean;
  /** Scrolls a page; returns the line then where `at` was on screen (null when it was not on screen). */
  page(dir: 1 | -1, at: Line | null): Line | null;
  /** Before the lines change: the screen holds on to the line it shows now, where the view is now. */
  sync(): void;
  /** The screen holds on to what it shows now (it stopped following: a pause). */
  anchorHere(): void;
  /** Until when new lines had better wait (Infinity: while the pointer is down; 0: they need not). */
  busyUntil(): number;
  /** Whether the lines are on screen at all (a dock tab not shown is not). */
  shown(): boolean;
  /** While the view is read (not following), the first position drawn: the buffer keeps it and what follows. */
  holdPos(): number | null;
}

interface Layout {
  lines: Line[];
  /** Offsets of the lines (null: every line one row high). */
  off: Float64Array | null;
}

/** Where the screen is: a line, and how far below its top the screen's top is. */
interface Place {
  line: Line;
  delta: number;
}

const offsetOf = (L: Layout, i: number) => (L.off ? L.off[i] : i * LINE_H);
const totalOf = (L: Layout) => offsetOf(L, L.lines.length);

/** The line at `y` (an offset into the lines). */
function indexAt(L: Layout, y: number): number {
  if (!L.off) return Math.max(0, Math.min(L.lines.length - 1, Math.floor(y / LINE_H)));
  const o = L.off;
  let lo = 0;
  let hi = L.lines.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (o[mid + 1] <= y) lo = mid + 1;
    else hi = mid;
  }
  return Math.min(lo, L.lines.length - 1);
}

const sameNumbers = (a: readonly number[], b: readonly number[]) => a.length === b.length && a.every((x, k) => x === b[k]);

/** A row's whole text, for copying what a selection covers of rows that draw only some of it. */
const fullText = new WeakMap<Element, () => string>();

/** The text of `range` within `node`. */
function textWithin(range: Range, node: Node): string {
  const r = document.createRange();
  r.selectNodeContents(node);
  if (range.compareBoundaryPoints(Range.START_TO_START, r) > 0) r.setStart(range.startContainer, range.startOffset);
  if (range.compareBoundaryPoints(Range.END_TO_END, r) < 0) r.setEnd(range.endContainer, range.endOffset);
  return r.toString();
}

/** Characters from the start of `node` to a boundary inside it. */
function offsetWithin(node: Node, container: Node, offset: number): number {
  const r = document.createRange();
  r.selectNodeContents(node);
  r.setEnd(container, offset);
  return r.toString().length;
}

/** A value's hint, put on it when the pointer first comes over it (not made for every value of every line drawn). */
const valueTitle = (p: Piece, e: MouseEvent) => {
  const el = e.currentTarget as HTMLElement;
  if (!el.title) el.title = `${p.field} — click to filter by it`;
};

/**
 * Pieces of text as spans: matches marked, structured values clickable. A line's pieces do not change (a new highlight
 * makes new ones): they are drawn as they are, not kept reactive one by one — a busy log draws hundreds a second.
 */
export function Pieces(props: { pieces: Piece[]; onValue?: (e: MouseEvent, key: string, value: FieldValue) => void }): JSX.Element {
  const click = (p: Piece, e: MouseEvent) => props.onValue?.(e, p.field!, p.value ?? null);
  return (
    <>
      {props.pieces.map((p) => {
        if (p.field !== undefined && props.onValue) {
          return (
            <span class={`${p.cls ?? ""} f-click${p.mark ? " mark" : ""}`} onClick={[click, p]} onMouseOver={[valueTitle, p]}>
              {p.text}
            </span>
          );
        }
        if (p.mark) return <mark class={p.cls} style={p.style}>{p.text}</mark>;
        if (p.cls || p.style) return <span class={p.cls} style={p.style}>{p.text}</span>;
        return p.text;
      })}
    </>
  );
}

/** Text that may be huge (a value of an expanded line): its beginning, and the rest on a click. */
function LongText(p: { text: string; max: number }) {
  const [all, setAll] = createSignal(false);
  return (
    <Show when={!all() && p.text.length > p.max} fallback={p.text}>
      {p.text.slice(0, p.max)}
      <button class="link-btn ld-more" onClick={() => setAll(true)}>
        … show all · {count(p.text.length)} characters
      </button>
    </Show>
  );
}

export function LogLines(props: { ctx: LogCtx; ref: (h: LinesHandle | undefined) => void }) {
  const c = props.ctx;
  let el!: HTMLDivElement;
  /** Where the view is scrolled to, as last known (the scroller's own, at its last scroll event or write). */
  const [top, setTop] = createSignal(0);
  const [left, setLeft] = createSignal(0);
  const [height, setHeight] = createSignal(600);
  const [width, setWidth] = createSignal(800);
  const [charW, setCharW] = createSignal(7);
  /** Heights of expanded lines' details, as measured. */
  const [measured, setMeasured] = createSignal<ReadonlyMap<Line, number>>(new Map());

  onMount(() => {
    // The box with its scroll bars: which lines are drawn does not depend on a scroll bar coming and going. A box
    // of no height (a dock tab not shown) draws nothing.
    const ro = new ResizeObserver(() =>
      batch(() => {
        setHeight(el.offsetHeight);
        setWidth(el.offsetWidth);
      }),
    );
    ro.observe(el);
    onCleanup(() => ro.disconnect());
    const ctx2d = document.createElement("canvas").getContext("2d");
    if (ctx2d) {
      ctx2d.font = getComputedStyle(el).font;
      setCharW(ctx2d.measureText("0123456789").width / 10 || 7);
    }
  });

  // ------------------------------------------------------------------ columns
  const multiDay = createMemo(() => {
    const v = c.shown();
    const first = v.find((l) => l.ts !== null)?.ts;
    const last = v.length ? v[v.length - 1].ts : null;
    return first != null && last != null && dayOf(first, utc()) !== dayOf(last, utc());
  });
  const tsChars = () => (showTs() ? (multiDay() ? 23 : 12) + 2 : 0);
  const srcChars = () => (c.multiSource() ? c.labelWidth() + 2 : 0);
  type Column = { key: string; w: number; num: boolean };
  // Pinned fields some shown line has, with the width of their column (in characters). A column, once seen, stays,
  // and only gets wider: rows are not drawn again as lines come.
  let seen = new Map<string, Column>();
  let seenIn = c.buffer();
  createComputed(on(pinned, () => (seen = new Map()), { defer: true }));
  const columns = createMemo<Column[]>(
    () => {
      if (!pretty() || !pinned().length) return [];
      c.version();
      if (c.buffer() !== seenIn) {
        seenIn = c.buffer();
        seen = new Map();
      }
      const v = c.shown();
      const widths = new Map<string, number[]>();
      const numbers = new Map<string, number>();
      for (let k = v.length - 1, n = 0; k >= 0 && n < 400; k--, n++) {
        const s = c.structures.get(v[k]);
        if (!s) continue;
        for (const key of pinned()) {
          const val = key === "msg" ? s.msg : s.fields.find(([f]) => f === key)?.[1];
          if (val === undefined) continue;
          let w = widths.get(key);
          if (!w) widths.set(key, (w = []));
          w.push(valueText(val).length);
          if (typeof val === "number") numbers.set(key, (numbers.get(key) ?? 0) + 1);
        }
      }
      for (const [key, w] of widths) {
        w.sort((a, b) => a - b);
        const p90 = w[Math.floor(w.length * 0.9)] ?? 0;
        const col = { key, w: Math.max(3, Math.min(32, Math.max(key.length, p90))), num: (numbers.get(key) ?? 0) >= w.length * 0.8 };
        const was = seen.get(key);
        seen.set(key, was ? { key, w: Math.max(was.w, col.w), num: was.num } : col);
      }
      return pinned().flatMap((k) => seen.get(k) ?? []);
    },
    [],
    { equals: (a, b) => a.length === b.length && a.every((x, k) => x.key === b[k].key && x.w === b[k].w && x.num === b[k].num) },
  );
  const pinnedKeys = createMemo(() => columns().map((x) => x.key), [], { equals: (a, b) => a.length === b.length && a.every((x, k) => x === b[k]) });
  /** The tooltips of a line's expand button, with the key of `logs.expand`: the same for every line, made once. */
  const expandTitles = createMemo(() => ({ open: withKeys("Collapse", "logs.expand"), closed: withKeys("Expand: fields, time, source", "logs.expand") }));
  const colChars = () => columns().reduce((n, x) => n + x.w + 2, 0) + (pretty() ? 6 : 0);
  /** Characters of text a wrapped row holds. */
  const cols = createMemo(() => Math.max(20, Math.floor((width() - 40) / charW()) - tsChars() - srcChars() - colChars()));

  // ------------------------------------------------------------------ layout
  const foldsOf = (l: Line) => fold() && (l.more?.length ?? 0) > FOLD_AT && !c.unfolded().has(l);
  const layout = createMemo<Layout>(() => {
    const lines = c.shown();
    const wrapCols = wrap() ? cols() : 0;
    const expanded = c.expanded();
    const meas = measured();
    const unfolded = c.unfolded();
    const folding = fold();
    let uniform = !wrapCols && !expanded.size;
    if (uniform) for (const l of lines) if (l.more) { uniform = false; break; }
    if (uniform) return { lines, off: null };
    const n = lines.length;
    const off = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) {
      const l = lines[i];
      const more = l.more?.length ?? 0;
      const folded = folding && more > FOLD_AT && !unfolded.has(l);
      const shownMore = folded ? FOLD_SHOW : more;
      let rows: number;
      if (!wrapCols) rows = 1 + shownMore;
      else {
        rows = Math.max(1, Math.ceil(l.width / wrapCols));
        for (let k = 0; k < shownMore; k++) rows += Math.max(1, Math.ceil(l.moreWidth![k] / wrapCols));
      }
      if (folded) rows++;
      let h = rows * LINE_H;
      if (expanded.has(l)) h += meas.get(l) ?? 160;
      off[i + 1] = off[i] + h;
    }
    return { lines, off };
  });

  /** Rows above the lines: the dropped lines' note or the earlier lines' row, the pinned columns' header. */
  const dropped = createMemo(() => (c.version(), c.buffer().dropped));
  const kept = createMemo(() => (c.version(), c.buffer().kept.length));
  /** How many were dropped — and kept, of what the filters showed: filtered views show those. */
  const droppedNote = () => {
    const b = c.buffer();
    const room = `the view keeps the latest ${count(b.maxLines)} lines, up to ${Math.round(b.maxBytes / 1024 / 1024)} MB`;
    if (readDropped()) return `… the lines you were reading were dropped: more came than the view keeps (${room})`;
    const k = kept();
    if (!k) return `… ${count(dropped())} earlier lines dropped (${room})`;
    if (!c.filtersOn()) return `… ${count(dropped())} earlier lines dropped (${room}); ${count(k)} of them that a filter showed are kept, shown while filtering`;
    const gone = dropped() - k;
    return gone ? `… ${count(gone)} earlier lines dropped, ${count(k)} that a filter showed were kept (${room})` : `… ${count(k)} earlier lines that a filter showed were kept (${room})`;
  };
  const earlierRow = () => {
    const e = c.earlier();
    return e.phase === "more" || e.phase === "loading" || e.phase === "full" || (e.phase === "done" && e.loaded > 0);
  };
  const note = () => dropped() > 0 || earlierRow();
  const headH = () => (note() ? LINE_H : 0) + (columns().length ? LINE_H : 0);
  const totalHeight = () => headH() + totalOf(layout()) + LINE_H;

  // ------------------------------------------------------------------ where the screen is
  // One place decides where the view is: at the bottom while following, else where the line it holds on to (the
  // anchor) is now. The lines drawn are worked out from it once, and one effect scrolls the box there — lines that
  // come, go (dropped) or are merged in above the screen do not move what is read, and are not drawn twice.
  const following = () => c.follow() && c.pausedAt() === null;
  const shownBox = () => height() > 0;
  const [anchor, setAnchor] = createSignal<Place | null>(null, { equals: false });
  /** Whether the line the screen held on to was dropped (more came than the buffer keeps, even held). */
  const gone = (p: Place) => !p.line.kept && p.line.pos < c.buffer().dropped;
  const readDropped = () => {
    if (following()) return false;
    const a = anchor();
    return !!a && (c.version(), gone(a));
  };
  /** The way the view scrolls (-1 up, 1 down, 0 still): more rows are drawn ahead of it. */
  const [lead, setLead] = createSignal<-1 | 0 | 1>(0);
  let leadTimer: ReturnType<typeof setTimeout> | undefined;
  const lean = (d: -1 | 1) => {
    setLead(d);
    clearTimeout(leadTimer);
    leadTimer = setTimeout(() => setLead(0), LEAD_MS);
  };
  onCleanup(() => clearTimeout(leadTimer));

  /** The place at `y` (a scroll offset): the selected line when it is wholly on screen, else the line at the top. */
  const placeAt = (y: number): Place | null => {
    const L = untrack(layout);
    if (!L.lines.length) return null;
    const at = y - untrack(headH);
    const sel = untrack(c.selected);
    if (sel) {
      const k = indexAtPos(L.lines, sel.pos);
      if (L.lines[k] === sel) {
        const o = offsetOf(L, k);
        if (o >= at && o < at + el.clientHeight - LINE_H) return { line: sel, delta: at - o };
      }
    }
    const k = indexAt(L, Math.max(0, at));
    return { line: L.lines[k], delta: at - offsetOf(L, k) };
  };
  /** Where a place is in a layout (a line gone: where it was, among those left; dropped: the top, which says so). */
  const offsetOfPlace = (L: Layout, p: Place, h: number) => {
    if (gone(p)) return 0;
    const k = indexAtPos(L.lines, p.line.pos);
    return h + offsetOf(L, Math.min(k, L.lines.length)) + (L.lines[k] === p.line ? p.delta : 0);
  };
  const viewTop = createMemo(() => {
    if (!shownBox()) return 0;
    if (following()) return Math.max(0, totalHeight() - height());
    const a = anchor();
    return a ? offsetOfPlace(layout(), a, headH()) : top();
  });
  const linesTop = () => Math.max(0, viewTop() - headH());

  /** The scroll offset the view itself set last (its scroll event is not the user's). */
  let expectY = Number.NaN;
  /** The scroll offset at the last scroll event: which way the view went. */
  let lastY = 0;
  let gestureUntil = 0;
  let keyUntil = 0;
  let graceUntil = 0;
  let pressed = false;
  /** The screen holds on to what is at `y` now. */
  const here = (y: number) =>
    batch(() => {
      setTop(y);
      setAnchor(placeAt(y));
    });
  /** Before the layout changes: where the view is now (it may have scrolled since its last scroll event). */
  const sync = () => {
    if (!el || !shownBox() || following()) return;
    if (Math.abs(el.scrollTop - untrack(top)) > 0.5) here(el.scrollTop);
  };
  /** At the bottom: the lines that came are drawn in this frame, where they are seen. */
  const pin = () => {
    el.scrollTop = el.scrollHeight;
    lastY = expectY = el.scrollTop;
    here(lastY);
    report();
  };
  /** Moved up to the top by a key: earlier lines are read (as scrolling there does). */
  const earlierIfTop = (was: number) => el.scrollTop < was && el.scrollTop <= LINE_H && c.earlier().phase === "more" && c.loadEarlier();
  /** Scrolls to `y` for a key or a click (a line picked, a page, the first line). */
  const jump = (y: number) => {
    el.scrollTop = Math.max(0, y);
    lastY = expectY = el.scrollTop;
    here(expectY);
    report();
  };
  // The one writer of the vertical scroll position.
  createEffect(
    // (While following, each change of the lines pins it anew: the place held when it stops is never stale.)
    on([viewTop, following, () => following() && layout()], ([y, f]) => {
      if (!shownBox()) return;
      if (f) return pin();
      if (Math.abs(el.scrollTop - y) <= 1) return;
      el.scrollTop = y;
      lastY = expectY = el.scrollTop;
      // (Clamped — the content got shorter than the place: the screen holds on to where it ended up.)
      if (Math.abs(expectY - y) > 1) here(expectY);
      else setTop(expectY);
      report();
    }),
  );
  // A line picked is what the screen holds on to (a filter cleared shows what was around it, it stays put).
  createEffect(on(c.selected, () => !following() && here(el.scrollTop), { defer: true }));
  // Shown again (a dock tab picked): the lines that waited meanwhile come in now, not at the hidden view's pace.
  createEffect(on(shownBox, (shown) => shown && c.flush(), { defer: true }));

  // ------------------------------------------------------------------ sideways
  // A nowrap row draws its text up to the screen's right edge and a margin on (see hwindow). The content is as wide
  // as the widest line the view drew since it started (it never gets narrower: the box never scrolls back by itself).
  const prefixCols = () => tsChars() + srcChars() + colChars();
  /** Where a row's text starts at the earliest (px). */
  const textX = () => 20 + (tsChars() + srcChars()) * charW();
  /** A text selection is being made, or is held, in the rows: what is drawn of them only grows. */
  const [selecting, setSelecting] = createSignal(false);
  const updateSelecting = () => {
    const sel = window.getSelection();
    setSelecting(pressed || (!!sel && !sel.isCollapsed && !!sel.anchorNode && el.contains(sel.anchorNode)));
  };
  onMount(() => {
    document.addEventListener("selectionchange", updateSelecting);
    onCleanup(() => document.removeEventListener("selectionchange", updateSelecting));
  });
  const hEnd = createMemo<number>((prev) => (wrap() ? Number.POSITIVE_INFINITY : textEnd(prev, Math.ceil((left() + width() - textX()) / charW()), selecting())), WHOLE);
  /** How much of a line is coloured: what is drawn while following and reading; all of it once scrolled that far. */
  const tokenUpTo = createMemo<number>((prev) => (selecting() ? prev : Math.max(prev, hEnd() <= TOKEN_UPTO ? TOKEN_UPTO : Number.POSITIVE_INFINITY)), TOKEN_UPTO);
  const [textCols, setTextCols] = createSignal(0);
  /** What a row's width depends on besides its text (pretty, time, sources, columns, wrapping) and the lines' start. */
  const widthKey = createMemo(() => `${pretty()}|${showTs()}|${srcChars()}|${colChars()}|${wrap()}|${!layout().lines.length}`);
  let noted = "";
  let widest = 0;
  /** A row's text takes `n` columns: the content gets as wide (anew when the key changed: no narrower than the screen). */
  const noteCols = (n: number) => {
    const k = untrack(widthKey);
    if (k !== noted) {
      noted = k;
      // (Scrolled sideways: never narrower than what is on screen, the box does not scroll back by itself.)
      widest = el?.scrollLeft ? Math.max(0, Math.ceil((el.scrollLeft + el.clientWidth - ROW_EXTRA) / charW()) - untrack(prefixCols)) : 0;
      setTextCols(widest);
    }
    if (n > widest) setTextCols((widest = n));
  };
  createEffect(on(widthKey, () => noteCols(0), { defer: true }));
  // The note above the lines is as wide as the content gets (its end can be scrolled to).
  createRenderEffect(() => {
    widthKey();
    if (note()) noteCols(droppedNote().length + 4);
  });
  const contentWidth = () => (wrap() ? undefined : `calc(${prefixCols() + textCols()}ch + ${ROW_EXTRA}px)`);

  // ------------------------------------------------------------------ the rows drawn
  // Off-screen rows are counted in pixels, more of them ahead of the way the view scrolls, and in characters: a
  // screen of huge lines (or of an unfolded stack trace) does not lay out megabytes it may never show.
  const band = createMemo(() => {
    const vp = height();
    if (following()) return { above: Math.min(FOLLOW_ABOVE_PX, vp / 4), below: 0 };
    const ahead = Math.max(AHEAD_MIN_PX, vp);
    const d = lead();
    return d < 0 ? { above: ahead, below: vp / 2 } : d > 0 ? { above: vp / 2, below: ahead } : { above: vp * 0.75, below: vp * 0.75 };
  });
  /** About how many characters a line's rows draw. */
  const drawnChars = (l: Line, end: number) => {
    let n = Math.min(l.width, end);
    const more = l.more ? (foldsOf(l) ? FOLD_SHOW : l.more.length) : 0;
    for (let k = 0; k < more; k++) n += Math.min(l.moreWidth![k], end);
    return n;
  };
  const range = createMemo<readonly [number, number]>(
    () => {
      const L = layout();
      const n = L.lines.length;
      if (!n || !shownBox()) return [0, 0];
      const y0 = linesTop();
      const b = band();
      const end = hEnd();
      let s = indexAt(L, y0);
      let e = Math.min(n, indexAt(L, y0 + height()) + 1);
      for (let px = 0, chars = 0; s > 0 && px < b.above && chars < CHAR_BUDGET; ) {
        s--;
        px += offsetOf(L, s + 1) - offsetOf(L, s);
        chars += drawnChars(L.lines[s], end);
      }
      for (let px = 0, chars = 0; e < n && px < b.below && chars < CHAR_BUDGET; e++) {
        px += offsetOf(L, e + 1) - offsetOf(L, e);
        chars += drawnChars(L.lines[e], end);
      }
      return [s, e];
    },
    [0, 0],
    { equals: (a, b) => a[0] === b[0] && a[1] === b[1] },
  );
  const startIndex = () => range()[0];
  const windowLines = createMemo(() => layout().lines.slice(range()[0], range()[1]));
  const offsetTop = () => headH() + offsetOf(layout(), startIndex());

  // ------------------------------------------------------------------ the user scrolls
  const onScroll = () => {
    const y = el.scrollTop;
    const now = performance.now();
    const ours = Math.abs(y - expectY) < 1;
    expectY = Number.NaN;
    const user = !ours && (pressed || now < gestureUntil || now < keyUntil);
    // Scrolled up to the top: earlier lines are read (and come in above what is on screen).
    if (user && y < lastY && y <= LINE_H && c.earlier().phase === "more") c.loadEarlier();
    batch(() => {
      if (el.scrollLeft !== untrack(left)) setLeft(el.scrollLeft);
      if (!ours) here(y);
      if (y !== lastY) lean(y < lastY ? -1 : 1);
      // Up from the bottom stops following, down to it starts it again: the content getting shorter under the
      // screen (a filter) moves the view up while it is at the bottom, which is neither.
      if (!ours && c.pausedAt() === null) {
        const atBottom = y + el.clientHeight >= el.scrollHeight - 24;
        if (following() && y < lastY - 1 && !atBottom && now > graceUntil) c.setFollow(false);
        else if (!following() && y > lastY && atBottom) c.setFollow(true);
      }
    });
    lastY = y;
    report();
  };
  // Not passive: the first wheel event of a gesture is handled before the view moves, so a wheel up stops following
  // before the next lines can pin the view to the bottom again (it never cancels anything).
  const onWheel = (e: WheelEvent) => {
    const now = performance.now();
    gestureUntil = now + GESTURE_MS;
    if (following() && e.deltaY < 0 && el.scrollTop > 0 && Math.abs(e.deltaY) >= Math.abs(e.deltaX) && now > graceUntil)
      batch(() => {
        here(el.scrollTop);
        lean(-1);
        c.setFollow(false);
      });
  };
  const onPointerDown = (e: PointerEvent) => {
    // (Only a primary press selects text; a context menu takes the release of its own.)
    if (e.button === 0) {
      pressed = true;
      updateSelecting();
    }
    // The scroll bar: dragging it reads.
    if (e.target === el && e.offsetX >= el.clientWidth && following())
      batch(() => {
        here(el.scrollTop);
        c.setFollow(false);
      });
  };
  const released = () => {
    if (!pressed) return;
    pressed = false;
    // Text selected while following: the screen stays on it.
    const sel = window.getSelection();
    if (following() && sel && !sel.isCollapsed && sel.anchorNode && el.contains(sel.anchorNode))
      batch(() => {
        here(el.scrollTop);
        c.setFollow(false);
      });
    updateSelecting();
    c.flush();
  };
  // A release the page never sees (a native menu, a drag of the text selected) is told by what follows it.
  const stillPressed = (e: PointerEvent) => pressed && e.buttons === 0 && released();
  window.addEventListener("pointerup", released);
  window.addEventListener("pointercancel", released);
  window.addEventListener("blur", released);
  window.addEventListener("contextmenu", released, true);
  window.addEventListener("dragend", released, true);
  window.addEventListener("pointermove", stillPressed);
  onMount(() => {
    el.addEventListener("wheel", onWheel, { passive: false });
    onCleanup(() => el.removeEventListener("wheel", onWheel));
  });
  onCleanup(() => {
    window.removeEventListener("pointerup", released);
    window.removeEventListener("pointercancel", released);
    window.removeEventListener("blur", released);
    window.removeEventListener("contextmenu", released, true);
    window.removeEventListener("dragend", released, true);
    window.removeEventListener("pointermove", stillPressed);
  });

  let rafTop = 0;
  const report = () => {
    if (rafTop) return;
    rafTop = requestAnimationFrame(() => {
      rafTop = 0;
      const L = layout();
      if (!L.lines.length) return c.setOnScreen(null);
      const y = el.scrollTop - headH();
      const a = L.lines[indexAt(L, Math.max(0, y))];
      const b = L.lines[indexAt(L, Math.max(0, y + el.clientHeight - 1))];
      c.setOnScreen([a.key, b.key]);
    });
  };
  onCleanup(() => cancelAnimationFrame(rafTop));

  // Copying: rows that draw only the beginning of their line copy all of what the selection covers of it.
  const onCopy = (e: ClipboardEvent) => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount || !e.clipboardData) return;
    const range = sel.getRangeAt(0);
    const cut = [...el.querySelectorAll(".lines .txt.cut")];
    if (!cut.some((t) => range.intersectsNode(t))) return;
    const parts: string[] = [];
    for (const node of el.querySelectorAll(".lines > .ln, .lines > .ln-detail")) {
      if (!range.intersectsNode(node)) continue;
      if (node.classList.contains("ln-detail")) {
        // An expanded line: all of it, the line as written; some of it, its fields as key and whole value (not the
        // buttons and labels around them).
        const box = document.createRange();
        box.selectNodeContents(node);
        const whole = fullText.get(node);
        if (whole && range.compareBoundaryPoints(Range.START_TO_START, box) <= 0 && range.compareBoundaryPoints(Range.END_TO_END, box) >= 0) {
          parts.push(whole());
          continue;
        }
        const out: string[] = [];
        for (const f of node.querySelectorAll(".ld-field")) {
          if (!range.intersectsNode(f)) continue;
          const val = f.querySelector(".ld-val");
          out.push(`${f.querySelector(".ld-key")?.textContent ?? ""}\t${val ? (fullText.get(val)?.() ?? val.textContent) : ""}`);
        }
        const pre = node.querySelector(".ld-text");
        if (pre && range.intersectsNode(pre)) out.push(fullText.get(pre)?.() ?? textWithin(range, pre));
        if (out.length) parts.push(out.join("\n"));
        continue;
      }
      const out: string[] = [];
      for (const cell of node.querySelectorAll(".cell")) if (range.intersectsNode(cell)) out.push(textWithin(range, cell));
      const txt = node.querySelector(".txt");
      const whole = txt ? fullText.get(txt) : undefined;
      if (txt && range.intersectsNode(txt)) {
        if (whole && txt.classList.contains("cut")) {
          const text = whole();
          const from = txt.contains(range.startContainer) ? offsetWithin(txt, range.startContainer, range.startOffset) : 0;
          let to = txt.contains(range.endContainer) ? offsetWithin(txt, range.endContainer, range.endOffset) : text.length;
          // To the end of what is drawn: to the end of the line.
          if (to >= (txt.textContent ?? "").length) to = text.length;
          out.push(text.slice(from, to));
        } else out.push(textWithin(range, txt));
      }
      parts.push(out.join(" "));
    }
    e.clipboardData.setData("text/plain", parts.join("\n"));
    e.preventDefault();
  };

  /** Where a line is (offsets into the scrolled content), if it is shown. */
  const placeOf = (l: Line) => {
    const L = layout();
    const k = indexAtPos(L.lines, l.pos);
    if (L.lines[k] !== l) return null;
    return { top: headH() + offsetOf(L, k), bottom: headH() + offsetOf(L, k + 1) };
  };
  /** The part of the content on screen (below the pinned columns' header, which stays on top). */
  const screen = () => ({ top: el.scrollTop + (columns().length ? LINE_H : 0), bottom: el.scrollTop + el.clientHeight });

  props.ref({
    reveal(l) {
      const at = placeOf(l)?.top;
      if (at === undefined) return;
      batch(() => {
        c.setFollow(false);
        if (at < el.scrollTop || at + LINE_H > el.scrollTop + el.clientHeight) jump(at - el.clientHeight / 3);
        else here(el.scrollTop);
      });
    },
    keepVisible(l) {
      const p = placeOf(l);
      if (!p) return;
      const v = screen();
      const was = el.scrollTop;
      const pinnedH = v.top - el.scrollTop;
      if (p.top < v.top) jump(p.top - pinnedH);
      else if (p.bottom > v.bottom) jump(Math.min(p.top - pinnedH, p.bottom - el.clientHeight));
      else here(el.scrollTop);
      earlierIfTop(was);
    },
    toBottom() {
      graceUntil = performance.now() + FOLLOW_GRACE_MS;
      if (following() && shownBox()) pin();
    },
    toTop() {
      const was = el.scrollTop;
      batch(() => {
        c.setFollow(false);
        jump(0);
      });
      earlierIfTop(was);
    },
    scroller: () => el,
    top() {
      const L = layout();
      return L.lines.length ? L.lines[indexAt(L, Math.max(0, el.scrollTop - headH()))] : undefined;
    },
    onScreen() {
      const L = layout();
      const n = L.lines.length;
      if (!n) return null;
      const v = screen();
      let a = indexAt(L, Math.max(0, v.top - headH()));
      if (headH() + offsetOf(L, a) < v.top - 0.5 && a + 1 < n && headH() + offsetOf(L, a + 1) < v.bottom) a++;
      let b = indexAt(L, Math.max(0, v.bottom - 1 - headH()));
      if (headH() + offsetOf(L, b + 1) > v.bottom + 0.5 && b > a) b--;
      return [L.lines[a], L.lines[Math.max(a, b)]];
    },
    visible(l) {
      const p = placeOf(l);
      const v = screen();
      return !!p && p.bottom > v.top && p.top < v.bottom;
    },
    page(dir, at) {
      const p = at ? placeOf(at) : null;
      const v = screen();
      const was = p && p.bottom > v.top && p.top < v.bottom ? p.top - el.scrollTop : null;
      const y0 = el.scrollTop;
      batch(() => {
        if (dir < 0) c.setFollow(false);
        jump(el.scrollTop + dir * Math.max(LINE_H, (v.bottom - v.top) * 0.9));
      });
      earlierIfTop(y0);
      if (was === null) return null;
      const L = layout();
      return L.lines.length ? L.lines[indexAt(L, Math.max(0, el.scrollTop + was - headH()))] : null;
    },
    sync,
    anchorHere: () => el && shownBox() && !following() && here(el.scrollTop),
    busyUntil: () => (pressed ? Number.POSITIVE_INFINITY : following() ? 0 : gestureUntil),
    shown: () => shownBox(),
    holdPos() {
      if (following()) return null;
      // Not drawn (a dock tab not shown): what the screen holds on to.
      const first = windowLines()[0] ?? untrack(anchor)?.line;
      return first ? Math.max(first.pos, c.buffer().dropped) : null;
    },
  });
  onCleanup(() => props.ref(undefined));

  // ------------------------------------------------------------------ menus
  const [valueMenu, setValueMenu] = createSignal<{ x: number; y: number; key: string; value: FieldValue } | null>(null);
  const [lineMenu, setLineMenu] = createSignal<{ x: number; y: number; line: Line } | null>(null);
  const onValue = (e: MouseEvent, key: string, value: FieldValue) => {
    e.stopPropagation();
    if (!window.getSelection()?.isCollapsed) return;
    setValueMenu({ x: e.clientX, y: e.clientY + 8, key, value });
  };
  /** Copies a field's value as it is (a string unquoted). */
  const copyValue = (key: string, value: FieldValue) => {
    const text = value === null ? "null" : String(value);
    void copyText(text, `Copied ${key}`, text);
  };
  const clickLine = (l: Line, e: MouseEvent) => {
    // Selecting text is not clicking a line.
    if (!window.getSelection()?.isCollapsed) return;
    if ((e.target as HTMLElement).closest("button, a")) return;
    // ⇧-click: the lines from the one picked to this one.
    if (e.shiftKey && c.selected()) c.extendTo(l);
    else c.select(c.selected() === l && !c.spanned() ? null : l);
  };
  /** ⇧ picks lines: it does not stretch a text selection. */
  const noShiftSelect = (e: MouseEvent) => e.shiftKey && e.preventDefault();

  // ------------------------------------------------------------------ rows
  const gapBefore = (l: Line, prev: Line | undefined) => (prev && l.ts !== null && prev.ts !== null && l.ts - prev.ts >= GAP_MS ? gapOf(l.ts - prev.ts) : undefined);
  const tsText = (l: Line) => (l.ts === null ? "" : multiDay() ? stampOf(l.ts, utc()) : clockOf(l.ts, utc()));
  const tsTitle = (l: Line) => (l.ts === null ? "No timestamp" : `${stampOf(l.ts, false)} local\n${stampOf(l.ts, true)}`);

  /** Among the lines picked together (the cursor's own row is marked as the cursor). */
  const inSpan = (l: Line) => {
    const r = c.spanned();
    return !!r && l.pos >= r[0] && l.pos <= r[1];
  };

  /** The time's hint (both clocks), put on it when the pointer first comes over it. */
  const tsHover = (l: Line, e: MouseEvent) => {
    const el = e.currentTarget as HTMLElement;
    if (!el.title) el.title = tsTitle(l);
  };

  const Prefix = (p: { l: Line; cont?: boolean }) => (
    <>
      <Show when={showTs()}>
        <span class="ts" style={{ width: `${tsChars()}ch` }} onMouseOver={p.cont ? undefined : [tsHover, p.l]}>
          {p.cont ? "" : tsText(p.l)}
        </span>
      </Show>
      <Show when={c.multiSource()}>
        <span class="src" style={{ width: `${srcChars()}ch`, color: c.color(p.l.i), opacity: c.sources().byId[p.l.i]?.gone ? 0.6 : undefined }} title={c.title(p.l.i)}>
          {p.cont ? "" : c.label(p.l.i)}
        </span>
      </Show>
    </>
  );

  /** A row's text: whole when it is short, else in blocks, drawn as far as the screen (and a margin) reaches. */
  function RowText(p: { pieces: Piece[]; onValue?: (e: MouseEvent, key: string, value: FieldValue) => void }) {
    const pieces = createMemo(() => p.pieces);
    const b = createMemo(() => blocksOf(pieces()));
    createRenderEffect(() => {
      widthKey();
      noteCols(b().cols);
    });
    const long = () => b().len > WHOLE;
    // Blocks keyed by their index: those drawn stay (and a text selection in them) as more are drawn after them.
    const drawn = createMemo(
      () => {
        const g = b();
        const end = hEnd();
        const out: number[] = [];
        // (By the column a block starts at at least: text narrower than a column a character is drawn far enough.)
        for (let k = 0; k < g.at.length && g.lo[k] < end; k++) out.push(k);
        return out;
      },
      [],
      { equals: sameNumbers },
    );
    return (
      <span class="txt" classList={{ cut: long() && drawn().length < b().at.length }} ref={(t) => fullText.set(t, () => pieces().map((x) => x.text).join(""))}>
        <Show when={long()} fallback={<Pieces pieces={pieces()} onValue={p.onValue} />}>
          <For each={drawn()}>
            {(k) => (
              <span class="blk">
                <Pieces pieces={slicePieces(pieces(), b().at[k], b().at[k + 1] ?? b().len)} onValue={p.onValue} />
              </span>
            )}
          </For>
        </Show>
      </span>
    );
  }

  // Heights of lines no longer expanded are forgotten (a line out of the rows drawn keeps its own).
  createEffect(
    on(
      c.expanded,
      (ex) => {
        const m = measured();
        if ([...m.keys()].every((l) => ex.has(l))) return;
        const next = new Map<Line, number>();
        for (const [l, h] of m) if (ex.has(l)) next.set(l, h);
        batch(() => {
          sync();
          setMeasured(next);
        });
      },
      { defer: true },
    ),
  );

  function Entry(p: { l: Line; prev: () => Line | undefined }) {
    const l = p.l;
    const gap = () => gapBefore(l, p.prev());
    if (l.marker) {
      // (Its icon and text in the UI's font: narrower than as many columns.)
      createRenderEffect(() => {
        widthKey();
        noteCols(l.text.length + 3);
      });
      return (
        <div class={`ln marker lvl-${l.lvl}`} classList={{ sel: c.selected() === l, inspan: inSpan(l), gap: !!gap() }} data-gap={gap()} onMouseDown={noShiftSelect} onClick={(e) => clickLine(l, e)}>
          <Prefix l={l} />
          <span class="txt">
            <Icon name={l.lvl >= 5 ? "alert-circle" : l.text === "running again" || l.text === "started" ? "play" : "info"} size={11} />
            {l.text}
          </span>
        </div>
      );
    }
    const s = () => (pretty() ? c.structures.get(l) : null);
    const head = createMemo(() => headOf(l, s(), pretty(), pinnedKeys(), c.hl(), tokenUpTo()));
    const folded = () => foldsOf(l);
    const more = () => {
      const m = l.more;
      if (!m) return [];
      return folded() ? m.slice(0, FOLD_SHOW) : m;
    };
    const isOpen = () => c.expanded().has(l);
    return (
      <>
        <div
          class={`ln lvl-${l.lvl}${c.selected() === l ? " sel" : ""}${inSpan(l) ? " inspan" : ""}${isOpen() ? " open" : ""}${gap() ? " gap" : ""}`}
          data-gap={gap()}
          onMouseDown={noShiftSelect}
          onClick={(e) => clickLine(l, e)}
          onContextMenu={(e) => {
            e.preventDefault();
            // Lines picked together stay picked (the menu copies them).
            if (!inSpan(l)) c.select(l);
            setLineMenu({ x: e.clientX, y: e.clientY, line: l });
          }}
        >
          {/* (Its chevron is drawn by CSS: an icon in every line drawn adds up in a busy log.) */}
          <button class="ln-x" title={isOpen() ? expandTitles().open : expandTitles().closed} onClick={() => c.toggleExpanded(l)} />
          <Prefix l={l} />
          <Show when={pretty() && (columns().length > 0 || head().tag !== undefined || s() !== null)}>
            <span class={`tag lvl-${head().tag ?? 0}`}>{head().tag ? LEVEL_TAG[head().tag!] : ""}</span>
          </Show>
          <Show when={head().cells}>
            <Index each={columns()}>
              {(col, k) => {
                const cell = () => head().cells?.[k];
                return (
                  <span class={`cell ${cell()?.cls ?? ""}`} classList={{ num: col().num }} style={{ width: `${col().w}ch` }} title={cell()?.text ? `${col().key}: ${cell()!.text}` : col().key}>
                    {cell()?.text ?? ""}
                  </span>
                );
              }}
            </Index>
          </Show>
          <RowText pieces={head().pieces} onValue={onValue} />
        </div>
        <For each={more()}>
          {(text) => (
            <div class={`ln cont lvl-${l.lvl}`} classList={{ sel: c.selected() === l, inspan: inSpan(l) }} onMouseDown={noShiftSelect} onClick={(e) => clickLine(l, e)}>
              <span class="ln-x" />
              <Prefix l={l} cont />
              <RowText pieces={textPieces(text, text.includes("\x1b"), pretty(), c.hl(), tokenUpTo())} />
            </div>
          )}
        </For>
        <Show when={folded()}>
          <div class={`ln fold lvl-${l.lvl}`} onClick={() => c.toggleFold(l)} title="Show the whole stack trace">
            <span class="ln-x" />
            <Prefix l={l} cont />
            <span class="txt">
              <Icon name="chevron-down" size={10} /> {count(l.more!.length - FOLD_SHOW)} more lines
            </span>
          </div>
        </Show>
        <Show when={isOpen()}>
          <Detail l={l} />
        </Show>
      </>
    );
  }

  /** An expanded line: when, where from, its fields — each one a filter away. */
  function Detail(p: { l: Line }) {
    const l = p.l;
    let box!: HTMLDivElement;
    onMount(() => {
      // Opened near the bottom: shown whole (when it is opened, not each time it is drawn again).
      if (c.takeOpened(l))
        requestAnimationFrame(() => {
          const r = box.getBoundingClientRect();
          const view = el.getBoundingClientRect();
          if (r.bottom > view.bottom) jump(el.scrollTop + Math.min(r.bottom - view.bottom + 8, r.top - view.top - LINE_H * 2));
        });
      const ro = new ResizeObserver(() => {
        const h = box.offsetHeight;
        if (!h || measured().get(l) === h) return;
        // What is on screen stays there: a line above it that grew moves the view down with it.
        batch(() => {
          sync();
          setMeasured(new Map(measured()).set(l, h));
        });
      });
      ro.observe(box);
      onCleanup(() => ro.disconnect());
    });
    const src = () => c.sources().byId[l.i];
    const s = () => c.structures.get(l);
    const json = createMemo(() => (s()?.kind === "json" ? jsonOf(l.ansi ? l.text.replace(/\x1b\[[\d;]*m/g, "") : l.text) : null));
    const pattern = () => c.patternOf(l);
    const unfoldedHere = () => !foldsOf(l);
    return (
      <div
        class="ln-detail"
        ref={(e) => {
          box = e;
          fullText.set(e, () => plainOf(l));
        }}
      >
        <div class="ld-meta">
          <Show when={l.ts !== null}>
            <span title="Local time / UTC">
              <Icon name="clock" size={11} /> {stampOf(l.ts!, false)} <span class="faint">· {stampOf(l.ts!, true)}</span>
            </span>
          </Show>
          <Show when={src()}>
            <span class="ld-src" title={c.title(l.i)}>
              <span class="swatch" style={{ background: c.color(l.i) }} />
              {src()!.namespace}/{src()!.pod} <span class="faint">· {src()!.container}</span>
            </span>
          </Show>
          <span class={`tag lvl-${l.lvl}`}>{l.lvl ? LEVEL_NAME[l.lvl] : "no level"}</span>
        </div>
        <Show when={s()}>
          <div class="ld-fields">
            <For each={s()!.fields}>
              {([key, value]) => (
                <div class="ld-field">
                  <span class="ld-key" title={key}>
                    {key}
                  </span>
                  <span class={`ld-val ${typeof value === "number" ? "f-num" : typeof value === "boolean" || value === null ? "f-kw" : ""}`} ref={(e) => fullText.set(e, () => (value === null ? "null" : String(value)))}>
                    <LongText text={value === null ? "null" : String(value)} max={VALUE_SHOWN} />
                    <Show when={key === s()!.timeKey && timeOf(value)}>
                      {(ms) => <span class="faint"> · {stampOf(ms(), utc())}</span>}
                    </Show>
                  </span>
                  <span class="ld-acts">
                    <button class="btn sm ghost icon" title={`Show lines with ${key} = this`} onClick={() => c.addTerm(fieldTerm(key, value))}>
                      <Icon name="plus" size={11} />
                    </button>
                    <button class="btn sm ghost icon" title={`Leave out lines with ${key} = this`} onClick={() => c.addTerm(fieldTerm(key, value, true))}>
                      <Icon name="minus" size={11} />
                    </button>
                    <button class="btn sm ghost icon" classList={{ on: pinned().includes(key) }} title={pinned().includes(key) ? `Stop showing ${key} as a column` : `Show ${key} as a column`} onClick={() => togglePinned(key)}>
                      <Icon name="columns" size={11} />
                    </button>
                    <button class="btn sm ghost icon" title="Copy the value" onClick={() => copyValue(key, value)}>
                      <Icon name="copy" size={11} />
                    </button>
                  </span>
                </div>
              )}
            </For>
          </div>
        </Show>
        <Show when={!s()}>
          <pre class="ld-text" ref={(e) => fullText.set(e, () => plainOf(l))}>
            <LongText text={[l.text, ...(l.more ?? [])].join("\n").replace(/\x1b\[[\d;]*m/g, "")} max={TEXT_SHOWN} />
          </pre>
        </Show>
        <div class="ld-actions">
          <button class="btn sm ghost" onClick={() => c.copyLines([l], "text")}>
            <Icon name="copy" size={11} /> Copy
          </button>
          <Show when={json()}>
            <button class="btn sm ghost" onClick={() => void copyText(JSON.stringify(json(), null, 2), "Copied JSON")}>
              <Icon name="braces" size={11} /> Copy JSON
            </button>
          </Show>
          <button class="btn sm ghost" title="Only lines that follow the same pattern" onClick={() => c.setOnly(new Set([pattern()]))}>
            <Icon name="patterns" size={11} /> Lines like this
          </button>
          <button class="btn sm ghost" title="Hide lines that follow the same pattern (noise)" onClick={() => c.setHiddenPatterns(new Set(c.hiddenPatterns()).add(pattern()))}>
            <Icon name="eye-off" size={11} /> Hide lines like this
          </button>
          <Show when={c.multiSource()}>
            <button class="btn sm ghost" onClick={() => c.setSolo(c.solo() === l.i ? null : l.i)}>
              <Icon name="layers" size={11} /> {c.solo() === l.i ? "All sources" : "Only this source"}
            </button>
          </Show>
          <Show when={(l.more?.length ?? 0) > FOLD_AT && fold()}>
            <button class="btn sm ghost" onClick={() => c.toggleFold(l)}>
              {unfoldedHere() ? "Fold the stack trace" : "Unfold the stack trace"}
            </button>
          </Show>
        </div>
      </div>
    );
  }

  const empty = () => !layout().lines.length;
  return (
    <>
      <Show when={c.filtersOn()}>
        <div class="logv-filtered">
          <Icon name="filter" size={11} />
          <span>
            Showing {count(c.shown().length)} of {count((c.version(), c.buffer().lines.length + c.buffer().kept.length))}
          </span>
          <button class="link-btn" onClick={() => c.clearFilters()}>
            Clear filters
          </button>
        </div>
      </Show>
      <div
        class={`code logs ${wrap() ? "wrap" : "nowrap"}`}
        classList={{ pretty: pretty() }}
        style={{ "--text-x": `${textX()}px` }}
        ref={el}
        tabIndex={0}
        onScroll={onScroll}
        onTouchMove={() => (gestureUntil = performance.now() + GESTURE_MS)}
        onKeyDown={() => (keyUntil = performance.now() + 400)}
        onPointerDown={onPointerDown}
        onCopy={onCopy}
      >
        {/* (A flow root: the columns' header's margin stays inside, the rows' offsets are the content's.) */}
        <div style={{ height: `${totalHeight()}px`, "min-width": contentWidth(), position: "relative", display: "flow-root" }}>
          <Show when={dropped() > 0}>
            <div class="ln faint ln-note" style={{ position: "absolute", left: "0", right: "0", top: "0" }} title={kept() ? "When the view is full, what the filters show is kept (half of the view at most) and what they hide makes room" : undefined}>
              {droppedNote()}
            </div>
          </Show>
          <Show when={!dropped() && earlierRow()}>
            <div class="ln ln-note ln-more ln-earlier" style={{ position: "absolute", left: "0", right: "0", top: "0" }}>
              <Switch>
                <Match when={c.earlier().phase === "loading"}>
                  <span class="spinner" />
                  <span class="faint">Reading earlier lines…</span>
                </Match>
                <Match when={c.earlier().phase === "more"}>
                  <button
                    class="link-btn"
                    onClick={() => c.loadEarlier()}
                    title="Read the lines written before these, in place: the stream goes on (scrolling up to here reads them too). Past the beginning of a container's run come its previous container's lines"
                  >
                    <Icon name="arrow-up" size={11} />
                    {c.earlier().previous === c.earlier().more ? `Load the previous ${c.multiSource() ? "containers'" : "container's"} lines` : "Load earlier lines"}
                  </button>
                  <Show when={c.earlier().loaded}>
                    <span class="faint">· {count(c.earlier().loaded)} loaded</span>
                  </Show>
                  <Show when={c.earlier().error}>
                    <span class="tone-err ellipsis" title={c.earlier().error}>
                      · not read: {c.earlier().error}
                    </span>
                  </Show>
                </Match>
                <Match when={c.earlier().phase === "full"}>
                  <span class="faint">The view holds as many lines as it can: earlier ones are not loaded</span>
                </Match>
                <Match when={c.earlier().phase === "done"}>
                  <span class="faint">Beginning of the {c.multiSource() ? "logs" : "log"}</span>
                </Match>
              </Switch>
            </div>
          </Show>
          <Show when={columns().length}>
            <div class="ln lhead" style={{ "margin-top": note() ? `${LINE_H}px` : undefined }}>
              <span class="ln-x" />
              <Show when={showTs()}>
                <span class="ts" style={{ width: `${tsChars()}ch` }}>
                  time
                </span>
              </Show>
              <Show when={c.multiSource()}>
                <span class="src" style={{ width: `${srcChars()}ch` }}>
                  source
                </span>
              </Show>
              <span class="tag">level</span>
              <For each={columns()}>
                {(col) => (
                  <span class="cell" classList={{ num: col.num }} style={{ width: `${col.w}ch` }} title={`${col.key} — click to remove the column`} onClick={() => togglePinned(col.key)}>
                    {col.key}
                  </span>
                )}
              </For>
              <span class="txt">message</span>
            </div>
          </Show>
          <div class="lines" style={{ transform: `translateY(${offsetTop()}px)` }}>
            {/* Keyed by line, not by slot: a node stays with its line as it scrolls, and so does a text selection in it. */}
            <For each={windowLines()}>{(l, k) => <Entry l={l} prev={() => layout().lines[startIndex() + k() - 1]} />}</For>
          </div>
        </div>
        <Show when={empty()}>
          <div class="logv-empty">
            <Show when={c.buffer().lines.length} fallback={<span class={`faint ${c.summary().tone === "err" ? "tone-err" : ""}`}>{c.summary().text}</span>}>
              <span class="faint">No lines match</span>
              <button class="btn sm" onClick={() => c.clearFilters()}>
                Clear filters
              </button>
            </Show>
          </div>
        </Show>
      </div>
      <Show when={c.pausedAt() !== null}>
        <button class="btn primary follow-btn" title={`${withKeys("Resume", "logs.pause")}: show the lines that came meanwhile`} onClick={() => c.setPaused(false)}>
          <Icon name="play" size={12} /> Resume · {count(Math.max(0, (c.version(), c.buffer().seq - 1 - c.pausedAt()!)))} new
        </button>
      </Show>
      <Show when={c.pausedAt() === null && !c.follow()}>
        <button
          class="btn primary follow-btn"
          title={withKeys("Follow new lines", "logs.last")}
          data-hint={keyOf("logs.last")}
          data-hint-ctx="details"
          data-hint-at="left"
          onClick={() => c.followNew()}
        >
          <Icon name="arrow-down" size={13} /> Follow
        </button>
      </Show>
      <Show when={valueMenu()} keyed>
        {(m) => (
          <Popover anchor={{ x: m.x, y: m.y }} onClose={() => setValueMenu(null)} width={260}>
            <div class="menu" role="menu">
              <div class="pop-group menu-target">
                {m.key} = {valueText(m.value)}
              </div>
              <button class="opt" role="menuitem" onClick={() => (setValueMenu(null), c.addTerm(fieldTerm(m.key, m.value)))}>
                <Icon name="plus" size={13} />
                <span>{TRACE_KEYS.has(m.key) ? "Follow it across pods and clusters" : "Show lines with this value"}</span>
              </button>
              <button class="opt" role="menuitem" onClick={() => (setValueMenu(null), c.addTerm(fieldTerm(m.key, m.value, true)))}>
                <Icon name="minus" size={13} />
                <span>Leave out lines with it</span>
              </button>
              <button class="opt" role="menuitem" onClick={() => (setValueMenu(null), togglePinned(m.key))}>
                <Icon name="columns" size={13} />
                <span>{pinned().includes(m.key) ? `Remove the ${m.key} column` : `Show ${m.key} as a column`}</span>
              </button>
              <button class="opt" role="menuitem" onClick={() => (setValueMenu(null), copyValue(m.key, m.value))}>
                <Icon name="copy" size={13} />
                <span>Copy the value</span>
              </button>
            </div>
          </Popover>
        )}
      </Show>
      <Show when={lineMenu()} keyed>
        {(m) => (
          <Popover anchor={{ x: m.x, y: m.y }} onClose={() => setLineMenu(null)} width={250}>
            <div class="menu" role="menu">
              <Show
                when={inSpan(m.line) && c.spanLines().length > 1}
                fallback={
                  <button class="opt" role="menuitem" data-key={keyOf("logs.copy")} onClick={() => (setLineMenu(null), c.copyLines([m.line], "text"))}>
                    <Icon name="copy" size={13} />
                    <span>Copy the line</span>
                    <Kbd id="logs.copy" />
                  </button>
                }
              >
                <button class="opt" role="menuitem" data-key={keyOf("logs.copy")} onClick={() => (setLineMenu(null), c.copyLines(c.spanLines(), "text"))}>
                  <Icon name="copy" size={13} />
                  <span>Copy the {count(c.spanLines().length)} lines picked</span>
                  <Kbd id="logs.copy" />
                </button>
              </Show>
              <button class="opt" role="menuitem" data-key={keyOf("logs.expand")} onClick={() => (setLineMenu(null), c.toggleExpanded(m.line))}>
                <Icon name="chevron-right" size={13} />
                <span>{c.expanded().has(m.line) ? "Collapse" : "Expand"}</span>
                <Kbd id="logs.expand" />
              </button>
              <div class="menu-sep" />
              <button class="opt" role="menuitem" onClick={() => (setLineMenu(null), c.setOnly(new Set([c.patternOf(m.line)])))}>
                <Icon name="patterns" size={13} />
                <span>Only lines like this</span>
              </button>
              <button class="opt" role="menuitem" onClick={() => (setLineMenu(null), c.setHiddenPatterns(new Set(c.hiddenPatterns()).add(c.patternOf(m.line))))}>
                <Icon name="eye-off" size={13} />
                <span>Hide lines like this</span>
              </button>
              <Show when={c.multiSource()}>
                <div class="menu-sep" />
                <button class="opt" role="menuitem" onClick={() => (setLineMenu(null), c.setSolo(c.solo() === m.line.i ? null : m.line.i))}>
                  <Icon name="layers" size={13} />
                  <span>{c.solo() === m.line.i ? "Show all sources" : `Only ${c.label(m.line.i) || "this source"}`}</span>
                </button>
                <button
                  class="opt"
                  onClick={() => {
                    setLineMenu(null);
                    c.setSolo(null);
                    c.setHidden(new Set(c.hidden()).add(m.line.i));
                  }}
                >
                  <Icon name="eye-off" size={13} />
                  <span>Hide {c.label(m.line.i) || "this source"}</span>
                </button>
              </Show>
            </div>
          </Popover>
        )}
      </Show>
    </>
  );
}
