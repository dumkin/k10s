import { batch, createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { Icon } from "../../components/Icon";
import { trackDrag } from "../../lib/drag";
import { count } from "../../lib/format";
import { bind, withKeys } from "../../lib/hotkeys";
import { clockOf, gapOf } from "../../lib/logs/format";
import { type Axis, barAtX, barOf, type Histogram, histogram, LEVEL_SLOTS, leftOf, maxIn, nearestIn, offsetAt, outside, spanTime, spanX, tapeStep, ticks, timeOf, xOfBar, xOfTime } from "../../lib/logs/histogram";
import { Level, LEVEL_NAME, LEVELS } from "../../lib/logs/parse";
import type { Line } from "../logBuffer";
import type { LogCtx } from "./LogViewer";
import { behindText, histogramOpen, setHistogramOpen, utc } from "./model";
import { createPasses } from "./passes";

const H = 46;
/** The bars' height: the ticks and their times go under them (the marks over the bars are as high). */
const BARS_H = 32;
/** Pixels a bar takes at least (with its gap). */
const BAR = 5;
/**
 * A pointer resting on the bars holds them this long after it last moved; then they go on (it is not reading them: the
 * keys took over, another app did). A drag holds them until it ends. (Tests: less.)
 */
export const hover = { holdMs: 3000 };

const LEVEL_VAR: Record<Level, string> = {
  [Level.Error]: "--err",
  [Level.Warn]: "--warn",
  [Level.Info]: "--log-info",
  [Level.Debug]: "--log-debug",
  [Level.Trace]: "--log-trace",
  [Level.None]: "--log-other",
};
/** The histogram's bars: warnings and errors in their colours, the quieter levels calm so that those stand out. */
const BAR_VAR: Record<Level, string> = {
  [Level.Error]: "--err-dot",
  [Level.Warn]: "--warn-dot",
  [Level.Info]: "--hist-info",
  [Level.Debug]: "--hist-debug",
  [Level.Trace]: "--hist-debug",
  [Level.None]: "--hist-other",
};
/** Stacked from the bottom: errors first, they matter most. */
const STACK: Level[] = [5, 4, 3, 2, 1, 0];

const plural = (l: Level, n: number) => (l === Level.None ? "other" : l === Level.Error ? (n === 1 ? "error" : "errors") : l === Level.Warn ? (n === 1 ? "warning" : "warnings") : LEVEL_NAME[l]);

/**
 * Under the toolbar: lines per level (each a filter), the stream's state and rate, and the histogram of the log's
 * volume over time — hover for counts, click to go there, drag to keep only that stretch of time.
 */
export function LogStrip(props: { ctx: LogCtx }) {
  const c = props.ctx;
  // Recounted at most a few times a second: a busy stream adds lines every 50 ms.
  const passes = createPasses(c.base, c.buffer, 250);

  const counts = createMemo(() => {
    const n = new Array<number>(LEVEL_SLOTS).fill(0);
    for (const l of passes.lines()) if (!l.marker) n[l.lvl]++;
    return n;
  });
  // The stream the lines are of: another one once the view is cleared or starts over — the histogram starts afresh.
  let streamLines: Line[] | undefined;
  const stream = createMemo<number>((n) => {
    c.version();
    const lines = c.buffer().lines;
    if (lines === streamLines) return n;
    streamLines = lines;
    return n + 1;
  }, 0);
  const memory: StepMemory = { stream: 0, step: null };

  const rate = c.rate;

  const toggleLevel = (l: Level, e: MouseEvent) => {
    const cur = c.levels();
    if (e.altKey || e.shiftKey) {
      // Only this level (again: all of them).
      const others = LEVELS.filter((x) => x !== l);
      const solo = others.every((x) => cur.has(x)) && !cur.has(l);
      c.setLevels(solo ? new Set() : new Set(others));
      return;
    }
    const next = new Set(cur);
    if (!next.delete(l)) next.add(l);
    c.setLevels(next);
  };
  const tone = () => c.summary().tone;

  return (
    <div class="lstrip">
      <div class="lstrip-head">
        <For each={LEVELS.filter((l) => counts()[l] > 0)}>
          {(l) => (
            <button class="lchip" classList={{ off: c.levels().has(l) }} style={{ "--c": `var(${l === Level.Error || l === Level.Warn ? BAR_VAR[l] : l === Level.Info ? "--info-dot" : LEVEL_VAR[l]})` }} title={`${c.levels().has(l) ? "Show" : "Hide"} ${plural(l, 2)} — ⇧-click: only ${plural(l, 2)}`} onClick={(e) => toggleLevel(l, e)}>
              <span class="lchip-dot" />
              {count(counts()[l])} {plural(l, counts()[l])}
            </button>
          )}
        </For>
        <Show when={c.range()}>
          {(r) => (
            <span class="chip range-chip" title="Only lines from this stretch of time (picked in the histogram)">
              <Icon name="clock" size={11} />
              {clockOf(r()[0], utc()).slice(0, 8)} – {clockOf(r()[1], utc()).slice(0, 8)}
              <button class="x" title="All the time" onClick={() => c.setRange(null)}>
                <Icon name="x" size={10} />
              </button>
            </span>
          )}
        </Show>
        <span class="grow" />
        <span class="lstrip-state" title={c.summary().detail || c.summary().text}>
          {/* (Not pulsing: an animation runs at the display's rate for as long as a log is open, quiet or not.) */}
          <span class={`dot ${tone() === "ok" ? "tone-1" : tone() === "warn" ? "tone-2" : tone() === "err" ? "tone-3" : ""}`} />
          <span class="ellipsis">{c.summary().text}</span>
          <Show when={rate()}>
            <span class="faint">· {rate()! >= 1 ? `${rate()! >= 100 ? Math.round(rate()!) : rate()!.toFixed(1)}/s` : `${Math.round(rate()! * 60)}/min`}</span>
          </Show>
          <Show when={c.behind()}>
            <span class="tone-warn" title="The newest lines come this long after they were written: the cluster, the network or the app cannot keep up with the log">
              · {behindText(c.behind()!)}
            </span>
          </Show>
          <Show when={!c.single()}>
            <span class="faint">
              {" · "}
              <Show when={c.selectionCount().pods < c.selectionCount().total} fallback={`${c.selectionCount().total} pods`}>
                <span class="tone-2" title="Logs of at most 50 containers are streamed at once: pods already shown stay, running pods (the newest, from every cluster) are preferred to finished ones">
                  {c.selectionCount().pods} of {c.selectionCount().total} pods
                </span>
              </Show>
            </span>
          </Show>
        </span>
        <button
          class="btn sm ghost icon"
          classList={{ on: histogramOpen() && c.roomy() }}
          title={!c.roomy() ? "The histogram shows when there is more room" : withKeys(histogramOpen() ? "Hide the histogram" : "Show the histogram of lines over time", "logs.histogram")}
          onClick={() => setHistogramOpen(!histogramOpen())}
        >
          <Icon name="bars" size={12} />
        </button>
      </div>
      <Show when={histogramOpen() && c.roomy() && stream()} keyed>
        {(n) => <Bars ctx={c} lines={passes.lines} stream={n} memory={memory} />}
      </Show>
    </div>
  );
}

/** The histogram's step while its bars are hidden (a dock tab not shown, a view too short): shown again, they go on with it. */
interface StepMemory {
  stream: number;
  step: number | null;
}

/**
 * The histogram, a tape of time (see lib/logs/histogram): bars of one width, the newest on the right. It covers the time
 * of the lines the view holds (see `LogBuffer.extent`), whatever the filters let through: they make the bars lower, they
 * do not move them. Under the pointer the bars hold still (their heights keep up, the bars that start meanwhile wait),
 * so what is pointed at is what is picked. One stream's: another one (the view cleared, started over) gets its own.
 */
function Bars(props: { ctx: LogCtx; lines: () => Line[]; stream: number; memory: StepMemory }) {
  const c = props.ctx;
  let canvas!: HTMLCanvasElement;
  let box!: HTMLDivElement;
  /** The strip's width (0 until it is laid out)… */
  const [w, setW] = createSignal(0);
  /** …and its left edge in the window: read as it is laid out, entered or pressed, not on every move of the pointer. */
  let left = 0;
  onMount(() => {
    const ro = new ResizeObserver(() => {
      // (Not laid out, 0 wide: the bars stay as they were.)
      if (box.clientWidth > 0) setW(box.clientWidth);
      left = box.getBoundingClientRect().left;
    });
    ro.observe(box);
    onCleanup(() => ro.disconnect());
  });
  const bars = () => Math.max(1, Math.floor(w() / BAR));

  // As lines come (not only those the filters let through), and when the filters or a pause change what is shown.
  const timeline = createMemo(() => (c.version(), c.buffer().extent(c.withKept(), c.pausedAt())), null, {
    equals: (a, b) => a === b || (!!a && !!b && a[0] === b[0] && a[1] === b[1]),
  });
  const off = createMemo(() => offsetAt(timeline()?.[1] ?? Date.now(), utc()));
  /** The step the lines call for, as of the one before. */
  const free = createMemo<number | null>((prev) => {
    const t = timeline();
    return t && w() ? tapeStep(t[0], t[1], bars(), off(), prev) : prev;
  }, props.memory.stream === props.stream ? props.memory.step : null);
  createEffect(() => {
    props.memory.stream = props.stream;
    props.memory.step = free();
  });
  /** Held while the pointer is over the bars or drags: the step, the offset and the newest time drawn. */
  const [held, setHeld] = createSignal<{ step: number; off: number; last: number } | null>(null);
  const axis = createMemo<Axis | null>(
    () => {
      const h = held();
      const t = timeline();
      const step = h?.step ?? free();
      if (!t || !step) return null;
      const o = h?.off ?? off();
      return { step, off: o, right: barOf(h?.last ?? t[1], step, o), bars: bars(), utc: utc() };
    },
    null,
    { equals: (a, b) => a === b || (!!a && !!b && a.step === b.step && a.off === b.off && a.right === b.right && a.bars === b.bars && a.utc === b.utc) },
  );
  /** The bars counted: all the lines' (those a hold keeps past the right edge are counted already when it ends). */
  const counted = createMemo(
    () => {
      const a = axis();
      const t = timeline();
      return a && t ? { step: a.step, off: a.off, lo: barOf(t[0], a.step, a.off), hi: barOf(t[1], a.step, a.off) } : null;
    },
    null,
    { equals: (a, b) => a === b || (!!a && !!b && a.step === b.step && a.off === b.off && a.lo === b.lo && a.hi === b.hi) },
  );
  // Counted again when the lines or those bars change: not as the strip is resized, nor as the pointer comes and goes.
  const hist = createMemo(() => {
    const b = counted();
    return b && histogram(props.lines(), b.step, b.off, b.lo, b.hi);
  });

  // The bars are drawn again when they change (at most a few times a second), not as the screen moves over them:
  // that is a marker of its own (below). Colours are read once per theme — reading them makes the browser work out
  // the styles of the whole page, which a log that streams changes all the time.
  const [theme, setTheme] = createSignal(document.documentElement.dataset.theme);
  onMount(() => {
    const mo = new MutationObserver(() => setTheme(document.documentElement.dataset.theme));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    onCleanup(() => mo.disconnect());
  });
  let palette: { theme: string | undefined; fill: string[]; text: string; line: string; font: string } | undefined;
  createEffect(() => {
    const h = hist();
    const a = axis();
    const width = w();
    const t = theme();
    const hidden = c.levels();
    const range = c.range();
    // (The first bar's, not the first line's time: that moves with every line that comes.)
    const first = counted()?.lo;
    let pal = palette;
    if (!pal || pal.theme !== t) {
      const css = getComputedStyle(canvas);
      const v = (name: string, or: string) => css.getPropertyValue(name).trim() || or;
      pal = palette = {
        theme: t,
        fill: STACK.map((l) => v(BAR_VAR[l], v(LEVEL_VAR[l], "#888"))),
        text: v("--text-3", "#888"),
        line: v("--border-strong", "rgba(128, 128, 128, 0.3)"),
        font: `${v("--fs-xs", "11px")} ${css.fontFamily}`,
      };
    }
    const dpr = window.devicePixelRatio || 1;
    // (Setting a canvas's size clears it and makes it anew, even to the same size.)
    const cw = Math.round(width * dpr);
    const ch = Math.round(H * dpr);
    if (canvas.width !== cw || canvas.height !== ch) {
      canvas.width = cw;
      canvas.height = ch;
    }
    const g = canvas.getContext("2d");
    if (!g) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, width, H);
    if (!h || !a || first === undefined) return;
    // Edges on the screen's pixels: a bar's width is a fraction of one.
    const px = (x: number) => Math.round(x * dpr) / dpr;
    const lo = leftOf(a);
    // The line under the bars starts at the first line held: before it, nothing was read (not: nothing was written).
    const x0 = px(Math.max(0, xOfBar(a, first, width)));
    g.fillStyle = pal.line;
    g.fillRect(x0, BARS_H, width - x0, 1);
    const max = maxIn(h, lo, a.right);
    const gap = width / a.bars > 4 ? 1 : 0;
    if (max)
      for (let b = Math.max(lo, h.lo), end = Math.min(a.right, h.lo + h.n - 1); b <= end; b++) {
        const k = b - h.lo;
        if (!h.totals[k]) continue;
        const left = px(xOfBar(a, b, width));
        const bw = Math.max(1 / dpr, px(xOfBar(a, b + 1, width)) - left - gap);
        const [t0, t1] = spanTime(a, b, b);
        const out = outside(range, t0, t1);
        let y = BARS_H;
        for (let s = 0; s < STACK.length; s++) {
          const n = h.counts[k * LEVEL_SLOTS + STACK[s]];
          if (!n) continue;
          const bh = Math.max(1, (n / max) * (BARS_H - 3));
          g.globalAlpha = hidden.has(STACK[s]) ? 0.15 : out ? 0.3 : 0.85;
          g.fillStyle = pal.fill[s];
          g.fillRect(left, y - bh, bw, bh);
          y -= bh;
        }
      }
    g.globalAlpha = 1;
    // The ticks, and their times under them.
    g.font = pal.font;
    g.textAlign = "center";
    g.textBaseline = "alphabetic";
    for (const tick of ticks(a, width)) {
      const x = px(tick.x);
      g.fillStyle = pal.line;
      g.fillRect(x, BARS_H + 1, 1, 3);
      const half = g.measureText(tick.label).width / 2;
      g.fillStyle = pal.text;
      g.fillText(tick.label, Math.max(half, Math.min(width - half, x)), H - 1);
    }
  });

  /** The pointer's x on the strip (null: not over it), and a drag over the bars (from one bar to another). */
  const [hoverX, setHoverX] = createSignal<number | null>(null);
  const [drag, setDrag] = createSignal<{ from: number; to: number; moved: boolean } | null>(null);
  /** The bar under the pointer: of the bars as they are drawn. */
  const hovered = createMemo(() => {
    const a = axis();
    const x = hoverX();
    return a && x !== null ? barAtX(a, x, w()) : null;
  });
  /** Where the screen is, the bar lit and the bars a drag goes over: [left, width] in pixels. */
  const seen = createMemo(() => {
    const a = axis();
    const at = c.onScreen();
    if (!a || !at) return null;
    // (Past the right edge, while the bars are held: at it, 2 px wide.)
    const x0 = Math.max(0, Math.min(w() - 2, xOfTime(a, at[0], w())));
    return [x0, Math.max(x0, Math.min(w(), xOfTime(a, at[1], w()))) - x0] as const;
  });
  const lit = createMemo(() => {
    const a = axis();
    const b = hovered();
    return a && b !== null && !drag() ? spanX(a, b, b, w()) : null;
  });
  const brush = createMemo(() => {
    const a = axis();
    const d = drag();
    return a && d ? spanX(a, d.from, d.to, w()) : null;
  });
  const tip = createMemo(() => {
    const a = axis();
    const h = hist();
    const x = hoverX();
    const d = drag();
    const b = hovered();
    if (!a || !h || x === null || b === null || d?.moved === false) return null;
    const [t0, t1] = d ? spanTime(a, d.from, d.to) : spanTime(a, b, b);
    return { x, text: `${timeOf(t0, a)}–${timeOf(t1, a)} · ${d ? gapOf(t1 - t0) : levelsIn(h, b)}` };
  });

  let pending = 0;
  let frame = 0;
  /** The pointer is over the strip, as its enter and leave say. */
  let over = false;
  /** Moves show once a frame: they come faster, and WebKit lays the page out before each one that follows a change. */
  const pointAt = (x: number) => {
    pending = x;
    frame ||= requestAnimationFrame(() => {
      frame = 0;
      const a = axis();
      const d = drag();
      batch(() => {
        setHoverX(pending);
        if (a && d) {
          const to = barAtX(a, pending, w());
          if (to !== d.to) setDrag({ ...d, to });
        }
      });
    });
  };
  let resting: ReturnType<typeof setTimeout> | undefined;
  /** The pointer moved, or pressed: the bars hold still — for a while once it rests. */
  const hold = () => {
    clearTimeout(resting);
    resting = setTimeout(() => !drag() && setHeld(null), hover.holdMs);
    const a = axis();
    const t = timeline();
    if (a && t && !held()) setHeld({ step: a.step, off: a.off, last: t[1] });
  };
  const away = () => {
    cancelAnimationFrame(frame);
    frame = 0;
    clearTimeout(resting);
    batch(() => {
      setHoverX(null);
      if (!drag()) setHeld(null);
    });
  };
  /**
   * To the first line of a bar, or the nearest shown if none of its lines is. A bar outside the time picked shows all the
   * time again — but one of lines kept for the filters, which no view shows without a filter, gets its own time picked.
   */
  const goTo = (a: Axis, b: number) => {
    const [t0, t1] = spanTime(a, b, b);
    if (outside(c.range(), t0, t1)) {
      const first = nearestIn(c.base(), t0, t1);
      batch(() => {
        c.setRange(null);
        if (first?.kept && first.key >= t0 && first.key < t1 && !c.withKept()) c.setRange([t0, t1]);
      });
    }
    const l = nearestIn(c.shown(), t0, t1);
    if (l) c.select(l, true);
  };
  let stopDrag: (() => void) | undefined;
  onCleanup(() => {
    stopDrag?.();
    cancelAnimationFrame(frame);
    clearTimeout(resting);
  });
  /** A drag ends: let go of (a click, or the time picked), or taken away (Escape, a context menu, another window). */
  const finish = (e: MouseEvent | null) => {
    stopDrag?.();
    cancelAnimationFrame(frame);
    frame = 0;
    const d = drag();
    const a = axis();
    setDrag(null);
    if (d && a && e) {
      const to = barAtX(a, e.clientX - left, w());
      if (d.moved) c.setRange(spanTime(a, d.from, to));
      else goTo(a, d.from);
    }
    // Let go of, or taken away, past the strip: the bars move on (over it, once the pointer rests a while).
    if (!over) away();
    else hold();
  };
  const down = (e: PointerEvent) => {
    const a = axis();
    if (!a || e.button !== 0 || stopDrag) return;
    // (Nothing gets selected on the way, and the keys stay where they were: with the lines.)
    e.preventDefault();
    left = box.getBoundingClientRect().left;
    hold();
    const from = barAtX(a, e.clientX - left, w());
    const x0 = e.clientX;
    setDrag({ from, to: from, moved: false });
    const stopTracking = trackDrag(e, {
      move: (ev) => {
        if (drag()?.moved === false && Math.abs(ev.clientX - x0) > 3) setDrag((d) => d && { ...d, moved: true });
        pointAt(ev.clientX - left);
      },
      end: finish,
    });
    // Escape takes the drag back, before what Escape does elsewhere (it would close the details the log is in).
    const unbind = bind({ combo: "escape", inInputs: true, priority: 400, run: () => finish(null) });
    stopDrag = () => {
      stopDrag = undefined;
      stopTracking();
      unbind();
    };
  };

  return (
    <div
      class="lhist"
      ref={box}
      onPointerEnter={(e) => {
        over = true;
        left = box.getBoundingClientRect().left;
        hold();
        pointAt(e.clientX - left);
      }}
      onPointerMove={(e) => {
        hold();
        pointAt(e.clientX - left);
      }}
      onPointerLeave={() => {
        over = false;
        away();
      }}
      onPointerDown={down}
    >
      <canvas ref={canvas} style={{ width: "100%", height: `${H}px` }} />
      <Show when={seen()}>{(r) => <div class="lhist-seen" style={{ left: `${r()[0]}px`, width: `max(2px, ${r()[1]}px)`, height: `${BARS_H}px` }} />}</Show>
      <Show when={lit()}>{(r) => <div class="lhist-hover" style={{ left: `${r()[0]}px`, width: `${r()[1]}px`, height: `${BARS_H}px` }} />}</Show>
      <Show when={brush()}>{(r) => <div class="lhist-brush" style={{ left: `${r()[0]}px`, width: `${r()[1]}px`, height: `${BARS_H}px` }} />}</Show>
      <Show when={tip()}>
        {(t) => {
          // At the pointer, to its right on the left of the strip and to its left on the right: always inside it.
          const at = () => Math.max(0, Math.min(1, t().x / w())) * 100;
          return (
            <div class="lhist-tip" style={{ left: `${at()}%`, transform: `translateX(-${at()}%)` }}>
              {t().text}
            </div>
          );
        }}
      </Show>
    </div>
  );
}

/** A bar's lines by level ("120 info, 3 errors"), or "nothing". */
function levelsIn(h: Histogram, b: number): string {
  const k = b - h.lo;
  const at = (l: Level) => (k >= 0 && k < h.n ? h.counts[k * LEVEL_SLOTS + l] : 0);
  const parts = STACK.filter((l) => at(l) > 0).map((l) => `${count(at(l))} ${plural(l, at(l))}`);
  return parts.length ? parts.join(", ") : "nothing";
}
