import { createEffect, createMemo, createSignal, For, Index, type JSX, Match, on, onCleanup, onMount, Show, Switch } from "solid-js";
import { Icon } from "../../components/Icon";
import { Kbd } from "../../components/Kbd";
import { Popover } from "../../components/Popover";
import { count } from "../../lib/format";
import { withKeys } from "../../lib/hotkeys";
import { keyOf } from "../../lib/keymap";
import { clockOf, dayOf, gapOf, stampOf } from "../../lib/logs/format";
import type { Piece } from "../../lib/logs/highlight";
import { type FieldValue, jsonOf, LEVEL_NAME, LEVEL_TAG, TRACE_KEYS } from "../../lib/logs/parse";
import { fieldTerm } from "../../lib/logs/query";
import { indexAtPos, type Line } from "../logBuffer";
import type { LogCtx } from "./LogViewer";
import { FOLD_AT, FOLD_SHOW, fold, GAP_MS, LINE_H, pinned, pretty, showTs, togglePinned, utc, wrap } from "./model";
import { headOf, textPieces, valueText } from "./render";

const OVERSCAN = 30;
/** Above the screen while following new lines (the screen is at the bottom: nothing below it). */
const FOLLOW_OVERSCAN = 5;

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
  toBottom(): void;
  scroller(): HTMLElement | undefined;
  /** The line at the top of the screen. */
  top(): Line | undefined;
  /** The first and the last line wholly on screen (partly, when none is whole). */
  onScreen(): readonly [Line, Line] | null;
  /** Whether some of a line is on screen. */
  visible(l: Line): boolean;
  /** The next scrolling is the user's (a key): up at the top, earlier lines are read. */
  byUser(): void;
  /** Scrolls a page; returns the line then where `at` was on screen (null when it was not on screen). */
  page(dir: 1 | -1, at: Line | null): Line | null;
}

interface Layout {
  lines: Line[];
  /** Offsets of the lines (null: every line one row high). */
  off: Float64Array | null;
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

export function LogLines(props: { ctx: LogCtx; ref: (h: LinesHandle) => void }) {
  const c = props.ctx;
  let el!: HTMLDivElement;
  const [top, setTop] = createSignal(0);
  const [height, setHeight] = createSignal(600);
  const [width, setWidth] = createSignal(800);
  const [charW, setCharW] = createSignal(7);
  /** Heights of expanded lines' details, as measured. */
  const [measured, setMeasured] = createSignal<ReadonlyMap<Line, number>>(new Map());

  onMount(() => {
    // The box with its scroll bars: which lines are drawn must not depend on a scroll bar that the widest line drawn
    // brings (it would come and go every frame).
    const ro = new ResizeObserver(() => {
      setHeight(el.offsetHeight);
      setWidth(el.offsetWidth);
    });
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
  /** Pinned fields some shown line has, with the width of their column (in characters). */
  const columns = createMemo(() => {
    if (!pretty() || !pinned().length) return [];
    c.version();
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
    return pinned()
      .filter((k) => widths.has(k))
      .map((key) => {
        const w = widths.get(key)!.sort((a, b) => a - b);
        const p90 = w[Math.floor(w.length * 0.9)] ?? 0;
        return { key, w: Math.max(3, Math.min(32, Math.max(key.length, p90))), num: (numbers.get(key) ?? 0) >= w.length * 0.8 };
      });
  });
  const pinnedKeys = createMemo(() => columns().map((x) => x.key));
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
  // Following, the screen is at the bottom: the lines drawn are those there, not those where it was before the new ones
  // came (drawn, then thrown away as it scrolls down), and only a few above it. A busy log draws each of its lines that
  // reaches the screen, and those that come and go between two drawings not at all.
  const following = () => c.follow() && c.pausedAt() === null;
  const linesTop = () => Math.max(0, (following() ? Math.max(0, totalHeight() - height()) : top()) - headH());
  const startIndex = createMemo(() => Math.max(0, indexAt(layout(), linesTop()) - (following() ? FOLLOW_OVERSCAN : OVERSCAN)));
  const endIndex = createMemo(() => {
    const L = layout();
    const n = L.lines.length;
    if (!n) return 0;
    return Math.min(n, indexAt(L, linesTop() + height()) + 1 + OVERSCAN);
  });
  const windowLines = createMemo(() => layout().lines.slice(startIndex(), endIndex()));
  const offsetTop = () => headH() + offsetOf(layout(), startIndex());

  // ------------------------------------------------------------------ following, keeping the place
  // The line the screen is anchored to: as lines come and go above it (merged in, dropped, filtered), it stays where
  // it was on screen. The selected line, when on screen; else the top one.
  let anchor: { line: Line; delta: number } | null = null;
  const takeAnchor = () => {
    const L = layout();
    if (!L.lines.length) return (anchor = null);
    const y = el.scrollTop - headH();
    const sel = c.selected();
    if (sel) {
      const k = indexAtPos(L.lines, sel.pos);
      if (L.lines[k] === sel) {
        const at = offsetOf(L, k);
        if (at >= y && at < y + el.clientHeight - LINE_H) return (anchor = { line: sel, delta: y - at });
      }
    }
    const k = indexAt(L, Math.max(0, y));
    anchor = { line: L.lines[k], delta: y - offsetOf(L, k) };
  };
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
  createEffect(
    on(layout, (L) => {
      if (c.follow()) {
        // At once, not in the next frame: the lines that came are drawn where they are seen, in one frame (scrolled in
        // a frame later, they were drawn below the screen first, then the screen showed the bottom without them).
        el.scrollTop = el.scrollHeight;
        report();
        return;
      }
      if (anchor) {
        const k = indexAtPos(L.lines, anchor.line.pos);
        const exact = L.lines[k] === anchor.line;
        const want = headH() + offsetOf(L, Math.min(k, L.lines.length)) + (exact ? anchor.delta : 0);
        if (Math.abs(el.scrollTop - want) > 1) el.scrollTop = want;
        setTop(el.scrollTop);
      }
      report();
    }),
  );
  createEffect(on([wrap, pretty, showTs], () => c.follow() && requestAnimationFrame(() => (el.scrollTop = el.scrollHeight)), { defer: true }));
  // A line picked is what the screen holds on to (a filter cleared shows what was around it, it stays put).
  createEffect(on(c.selected, () => takeAnchor(), { defer: true }));
  let lastTop = 0;
  // Scrolling to follow the cursor does not start following new lines (at the bottom): the line is being read.
  let quietUntil = 0;
  // The user scrolls (wheel, scroll bar, keys) — content that shrank under the screen (a filter) does not.
  let userAt = 0;
  let pressed = false;
  const byUser = () => (userAt = performance.now());
  const released = () => (pressed = false);
  window.addEventListener("pointerup", released);
  onCleanup(() => window.removeEventListener("pointerup", released));
  const onScroll = () => {
    // Scrolled up to the top: earlier lines are read (and come in above what is on screen).
    const user = pressed || performance.now() - userAt < 400;
    if (user && el.scrollTop < lastTop && el.scrollTop <= LINE_H && c.earlier().phase === "more") c.loadEarlier();
    lastTop = el.scrollTop;
    setTop(el.scrollTop);
    const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 24;
    if (atBottom !== c.follow() && c.pausedAt() === null && performance.now() > quietUntil) c.setFollow(atBottom);
    takeAnchor();
    report();
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
  const scrollTo = (y: number) => {
    quietUntil = performance.now() + 150;
    byUser();
    el.scrollTop = Math.max(0, y);
    setTop(el.scrollTop);
    takeAnchor();
  };

  props.ref({
    reveal(l) {
      const at = placeOf(l)?.top;
      if (at === undefined) return;
      c.setFollow(false);
      if (at < el.scrollTop || at + LINE_H > el.scrollTop + el.clientHeight) el.scrollTop = Math.max(0, at - el.clientHeight / 3);
      setTop(el.scrollTop);
      takeAnchor();
    },
    keepVisible(l) {
      const p = placeOf(l);
      if (!p) return;
      const v = screen();
      const pinnedH = v.top - el.scrollTop;
      if (p.top < v.top) scrollTo(p.top - pinnedH);
      else if (p.bottom > v.bottom) scrollTo(Math.min(p.top - pinnedH, p.bottom - el.clientHeight));
      else takeAnchor();
    },
    toBottom() {
      requestAnimationFrame(() => (el.scrollTop = el.scrollHeight));
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
    byUser,
    page(dir, at) {
      const p = at ? placeOf(at) : null;
      const v = screen();
      const was = p && p.bottom > v.top && p.top < v.bottom ? p.top - el.scrollTop : null;
      if (dir < 0) c.setFollow(false);
      scrollTo(el.scrollTop + dir * Math.max(LINE_H, (v.bottom - v.top) * 0.9));
      if (was === null) return null;
      const L = layout();
      return L.lines.length ? L.lines[indexAt(L, Math.max(0, el.scrollTop + was - headH()))] : null;
    },
  });

  // ------------------------------------------------------------------ menus
  const [valueMenu, setValueMenu] = createSignal<{ x: number; y: number; key: string; value: FieldValue } | null>(null);
  const [lineMenu, setLineMenu] = createSignal<{ x: number; y: number; line: Line } | null>(null);
  const onValue = (e: MouseEvent, key: string, value: FieldValue) => {
    e.stopPropagation();
    if (!window.getSelection()?.isCollapsed) return;
    setValueMenu({ x: e.clientX, y: e.clientY + 8, key, value });
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

  function Entry(p: { l: Line; prev: () => Line | undefined }) {
    const l = p.l;
    const gap = () => gapBefore(l, p.prev());
    if (l.marker) {
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
    const head = createMemo(() => headOf(l, s(), pretty(), pinnedKeys(), c.hl()));
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
          <button class="ln-x" title={withKeys(isOpen() ? "Collapse" : "Expand: fields, time, source", "logs.expand")} onClick={() => c.toggleExpanded(l)} />
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
          <span class="txt">
            <Pieces pieces={head().pieces} onValue={onValue} />
          </span>
        </div>
        <For each={more()}>
          {(text) => (
            <div class={`ln cont lvl-${l.lvl}`} classList={{ sel: c.selected() === l, inspan: inSpan(l) }} onMouseDown={noShiftSelect} onClick={(e) => clickLine(l, e)}>
              <span class="ln-x" />
              <Prefix l={l} cont />
              <span class="txt">
                <Pieces pieces={textPieces(text, text.includes("\x1b"), pretty(), c.hl())} />
              </span>
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
      // Opened near the bottom: shown whole.
      requestAnimationFrame(() => {
        const r = box.getBoundingClientRect();
        const view = el.getBoundingClientRect();
        if (r.bottom > view.bottom) el.scrollTop += Math.min(r.bottom - view.bottom + 8, r.top - view.top - LINE_H * 2);
      });
      const ro = new ResizeObserver(() => {
        const h = box.offsetHeight;
        if (measured().get(l) !== h) setMeasured(new Map(measured()).set(l, h));
      });
      ro.observe(box);
      onCleanup(() => {
        ro.disconnect();
        const next = new Map(measured());
        next.delete(l);
        setMeasured(next);
      });
    });
    const src = () => c.sources().byId[l.i];
    const s = () => c.structures.get(l);
    const json = createMemo(() => (s()?.kind === "json" ? jsonOf(l.ansi ? l.text.replace(/\x1b\[[\d;]*m/g, "") : l.text) : null));
    const pattern = () => c.patternOf(l);
    const unfoldedHere = () => !foldsOf(l);
    return (
      <div class="ln-detail" ref={box}>
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
                  <span class={`ld-val ${typeof value === "number" ? "f-num" : typeof value === "boolean" || value === null ? "f-kw" : ""}`}>
                    {value === null ? "null" : String(value)}
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
                    <button class="btn sm ghost icon" title="Copy the value" onClick={() => void navigator.clipboard.writeText(value === null ? "null" : String(value))}>
                      <Icon name="copy" size={11} />
                    </button>
                  </span>
                </div>
              )}
            </For>
          </div>
        </Show>
        <Show when={!s()}>
          <pre class="ld-text">{[l.text, ...(l.more ?? [])].join("\n").replace(/\x1b\[[\d;]*m/g, "")}</pre>
        </Show>
        <div class="ld-actions">
          <button class="btn sm ghost" onClick={() => c.copyLines([l], "text")}>
            <Icon name="copy" size={11} /> Copy
          </button>
          <Show when={json()}>
            <button class="btn sm ghost" onClick={() => void navigator.clipboard.writeText(JSON.stringify(json(), null, 2))}>
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
        ref={el}
        tabIndex={0}
        onScroll={onScroll}
        onWheel={byUser}
        onTouchMove={byUser}
        onPointerDown={() => {
          pressed = true;
          byUser();
        }}
      >
        {/* (A flow root: the columns' header's margin stays inside, the rows' offsets are the content's.) */}
        <div style={{ height: `${totalHeight()}px`, position: "relative", display: "flow-root" }}>
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
          <div class="lines" style={{ transform: `translateY(${offsetTop()}px)`, ...(wrap() ? { right: "0" } : {}) }}>
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
              <button class="opt" role="menuitem" onClick={() => (setValueMenu(null), void navigator.clipboard.writeText(m.value === null ? "null" : String(m.value)))}>
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
