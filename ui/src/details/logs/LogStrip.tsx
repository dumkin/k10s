import { batch, createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show, untrack } from "solid-js";
import { Icon } from "../../components/Icon";
import { count } from "../../lib/format";
import { withKeys } from "../../lib/hotkeys";
import { clockOf, gapOf } from "../../lib/logs/format";
import { type Axis, barAtX, barOf, barStart, extentOf, histogram, LEVEL_SLOTS, leftOf, maxIn, offsetAt, tapeStep, ticks, timeOf, xOfBar, xOfTime } from "../../lib/logs/histogram";
import { Level, LEVEL_NAME, LEVELS } from "../../lib/logs/parse";
import { indexAtKey, type Line } from "../logBuffer";
import type { LogCtx } from "./LogViewer";
import { behindText, histogramOpen, setHistogramOpen, utc } from "./model";
import { createPasses } from "./passes";

const H = 46;
/** The bars' height: the ticks and their times go under them (`.lhist-seen` and the rest leave them out). */
const BARS_H = 32;
/** Pixels a bar takes at least (with its gap). */
const BAR = 5;

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
      <Show when={histogramOpen() && c.roomy()}>
        <Bars ctx={c} lines={passes.lines} />
      </Show>
    </div>
  );
}

/**
 * The histogram, a tape of time (see lib/logs/histogram): bars of one width, the newest on the right. It covers the time
 * of the lines the view holds, whatever the filters show: they make the bars lower, they do not move them. Under the
 * pointer the bars hold still (their heights keep up, the bars that start meanwhile wait), so what is pointed at is
 * what is picked.
 */
function Bars(props: { ctx: LogCtx; lines: () => Line[] }) {
  const c = props.ctx;
  let canvas!: HTMLCanvasElement;
  let box!: HTMLDivElement;
  /** The strip's width (0 until it is laid out)… */
  const [w, setW] = createSignal(0);
  /** …and its left edge in the window: read as it is laid out, entered or pressed, not on every move of the pointer. */
  let left = 0;
  onMount(() => {
    const ro = new ResizeObserver(() => {
      // (A dock tab not shown is 0 wide: the bars stay as they were.)
      if (box.clientWidth > 0) setW(box.clientWidth);
      left = box.getBoundingClientRect().left;
    });
    ro.observe(box);
    onCleanup(() => ro.disconnect());
  });
  const bars = () => Math.max(1, Math.floor(w() / BAR));

  // The time the lines cover: those the buffer holds, and those it keeps for the filters while the view shows them.
  // (Worked out once a pass, when the lines are counted.)
  const timeline = createMemo<readonly [number, number] | null>(
    () => {
      props.lines();
      const buf = c.buffer();
      const held = extentOf(buf.lines);
      const kept = c.withKept() ? extentOf(buf.kept) : null;
      return held && kept ? [Math.min(held[0], kept[0]), Math.max(held[1], kept[1])] : (held ?? kept);
    },
    null,
    { equals: (a, b) => a === b || (!!a && !!b && a[0] === b[0] && a[1] === b[1]) },
  );
  /** The stream's lines (another array once the view is cleared or starts over): the step and the hold of others are not theirs. */
  const epoch = createMemo(() => (props.lines(), c.buffer().lines));
  // Paused, the lines that come are not shown: the tape stops where it was.
  const pausedLast = createMemo(on(c.pausedAt, (p) => (p === null ? null : (untrack(timeline)?.[1] ?? null))));
  const off = createMemo(() => offsetAt(timeline()?.[1] ?? Date.now(), utc()));
  /** The step the lines call for, as of the one before. */
  const free = createMemo<{ step: number; epoch: Line[] } | null>((prev) => {
    const t = timeline();
    if (!t || !w()) return null;
    const e = epoch();
    const step = tapeStep(t[0], t[1], bars(), off(), prev?.epoch === e ? prev.step : null);
    return prev?.epoch === e && prev.step === step ? prev : { step, epoch: e };
  }, null);
  /** Held under the pointer: the step, and the newest time drawn. */
  const [held, setHeld] = createSignal<{ step: number; last: number; epoch: Line[] } | null>(null);
  const holding = () => {
    const h = held();
    return h && h.epoch === epoch() ? h : null;
  };
  const step = createMemo(() => holding()?.step ?? free()?.step ?? 0);
  /** The newest time drawn (0: nothing to draw). */
  const edge = createMemo(() => {
    const t = timeline();
    return t ? Math.min(holding()?.last ?? t[1], pausedLast() ?? Infinity) : 0;
  });
  const axis = createMemo<Axis | null>(
    () => {
      const s = step();
      const t = edge();
      return s && t ? { step: s, off: off(), right: barOf(t, s, off()), bars: bars() } : null;
    },
    null,
    { equals: (a, b) => a === b || (!!a && !!b && a.step === b.step && a.off === b.off && a.right === b.right && a.bars === b.bars) },
  );
  // Counted again when the lines or the step change: not as the strip is resized, nor as the pointer comes and goes.
  const hist = createMemo(() => {
    const lines = props.lines();
    const s = step();
    const t = timeline();
    const last = edge();
    if (!s || !t || !last) return null;
    const o = off();
    return histogram(lines, s, o, barOf(t[0], s, o), barOf(last, s, o));
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
    const first = timeline()?.[0];
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
    if (!h || !a || !width) return;
    // Edges on the screen's pixels: a bar's width is a fraction of one.
    const px = (x: number) => Math.round(x * dpr) / dpr;
    const lo = leftOf(a);
    // The line under the bars starts at the first line held: before it, nothing was read (not: nothing was written).
    if (first !== undefined) {
      const x0 = px(Math.max(0, xOfBar(a, barOf(first, a.step, a.off), width)));
      g.fillStyle = pal.line;
      g.fillRect(x0, BARS_H, width - x0, 1);
    }
    const max = maxIn(h, lo, a.right);
    const gap = width / a.bars > 4 ? 1 : 0;
    if (max)
      for (let b = Math.max(lo, h.lo), end = Math.min(a.right, h.lo + h.n - 1); b <= end; b++) {
        const k = b - h.lo;
        if (!h.totals[k]) continue;
        const x0 = px(xOfBar(a, b, width));
        const bw = Math.max(1 / dpr, px(xOfBar(a, b + 1, width)) - x0 - gap);
        const t0 = barStart(b, a.step, a.off);
        const outside = range && (t0 + a.step <= range[0] || t0 >= range[1]);
        let y = BARS_H;
        for (let s = 0; s < STACK.length; s++) {
          const n = h.counts[k * LEVEL_SLOTS + STACK[s]];
          if (!n) continue;
          const bh = Math.max(1, (n / max) * (BARS_H - 3));
          g.globalAlpha = hidden.has(STACK[s]) ? 0.15 : outside ? 0.3 : 0.85;
          g.fillStyle = pal.fill[s];
          g.fillRect(x0, y - bh, bw, bh);
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
  /** Where the screen is: [left, width] in pixels. */
  const seen = createMemo<readonly [number, number] | null>(() => {
    const a = axis();
    const at = c.onScreen();
    const width = w();
    if (!a || !at || !width) return null;
    const x0 = Math.max(0, Math.min(width, xOfTime(a, at[0], width)));
    return [x0, Math.max(x0, Math.min(width, xOfTime(a, at[1], width))) - x0];
  });

  /** The pointer's x on the strip (null: not over it), and a drag over the bars (from one bar to another). */
  const [hoverX, setHoverX] = createSignal<number | null>(null);
  const [drag, setDrag] = createSignal<{ from: number; to: number; moved: boolean } | null>(null);
  /** The bar under the pointer: of the bars as they are drawn. */
  const hovered = createMemo(() => {
    const a = axis();
    const x = hoverX();
    return a && x !== null && w() ? barAtX(a, x, w()) : null;
  });
  let pending: number | null = null;
  let moved = false;
  let frame = 0;
  /** The pointer is over the strip (as its enter and leave say: a pointer captured by it stays over it). */
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
        if (d && a && pending !== null) {
          const to = barAtX(a, pending, w());
          if (to !== d.to || moved !== d.moved) setDrag({ from: d.from, to, moved });
        }
      });
    });
  };
  const xOf = (e: PointerEvent) => e.clientX - left;
  const hold = () => {
    const s = step();
    if (s && !holding()) setHeld({ step: s, last: edge(), epoch: epoch() });
  };
  const away = () => {
    cancelAnimationFrame(frame);
    frame = 0;
    batch(() => {
      setHoverX(null);
      if (!drag()) setHeld(null);
    });
  };
  /** To the first line of a bar, or the nearest shown if none of its lines is; a bar left out of the time picked shows all the time again. */
  const goTo = (b: number) => {
    const a = axis();
    if (!a) return;
    const t0 = barStart(b, a.step, a.off);
    const t1 = t0 + a.step;
    const r = c.range();
    if (r && (t1 <= r[0] || t0 >= r[1])) c.setRange(null);
    const lines = c.shown();
    const k = indexAtKey(lines, t0);
    const after = lines[k];
    const before = lines[k - 1];
    const l = after && (after.key < t1 || !before || after.key - t1 < t0 - before.key) ? after : before;
    if (!l) return;
    c.select(l);
    c.reveal(l);
  };
  let stopDrag: (() => void) | undefined;
  onCleanup(() => {
    stopDrag?.();
    cancelAnimationFrame(frame);
  });
  /** A drag ends: let go of (a click, or the time picked), or taken away (Escape, a context menu, another window). */
  const finish = (e: PointerEvent | null) => {
    stopDrag?.();
    cancelAnimationFrame(frame);
    frame = 0;
    const d = drag();
    const a = axis();
    setDrag(null);
    if (!e) {
      // (Taken away past the strip, which said so as the pointer left it: the bars move on.)
      if (!over) away();
      return;
    }
    if (!d || !a) return;
    const to = barAtX(a, xOf(e), w());
    if (moved) {
      const [from, last] = d.from <= to ? [d.from, to] : [to, d.from];
      c.setRange([barStart(from, a.step, a.off), barStart(last + 1, a.step, a.off)]);
    } else goTo(d.from);
    // Let go of away from the strip: the bars move on.
    const r = box.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX >= r.right || e.clientY < r.top || e.clientY >= r.bottom) away();
  };
  // The window hears the drag through (also past the strip). It does not end when a move says no button is held:
  // WebKit takes that from the system's state of the mouse, which events handed to the window by software leave at none.
  const down = (e: PointerEvent) => {
    const a = axis();
    if (!a || e.button !== 0 || stopDrag) return;
    left = box.getBoundingClientRect().left;
    hold();
    const from = barAtX(a, xOf(e), w());
    const x0 = e.clientX;
    moved = false;
    setDrag({ from, to: from, moved });
    try {
      box.setPointerCapture?.(e.pointerId);
    } catch {
      // (Not a pointer the page may capture: the window hears it anyway.)
    }
    const move = (ev: PointerEvent) => {
      if (Math.abs(ev.clientX - x0) > 3) moved = true;
      pointAt(xOf(ev));
    };
    const up = (ev: PointerEvent) => finish(ev);
    const cancel = () => finish(null);
    const escape = (ev: KeyboardEvent) => {
      if (ev.key !== "Escape") return;
      ev.preventDefault();
      ev.stopPropagation();
      cancel();
    };
    stopDrag = () => {
      stopDrag = undefined;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("contextmenu", cancel, true);
      window.removeEventListener("blur", cancel);
      window.removeEventListener("keydown", escape, true);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("contextmenu", cancel, true);
    window.addEventListener("blur", cancel);
    window.addEventListener("keydown", escape, true);
  };

  const tip = createMemo(() => {
    const a = axis();
    const h = hist();
    const x = hoverX();
    const d = drag();
    const b = hovered();
    if (!a || !h || x === null || b === null) return null;
    if (d) {
      if (!d.moved) return null;
      const t0 = barStart(Math.min(d.from, d.to), a.step, a.off);
      const t1 = barStart(Math.max(d.from, d.to) + 1, a.step, a.off);
      return { x, text: `${timeOf(t0, a)}–${timeOf(t1, a)} · ${gapOf(t1 - t0)}` };
    }
    const k = b - h.lo;
    const at = (l: Level) => (k >= 0 && k < h.n ? h.counts[k * LEVEL_SLOTS + l] : 0);
    const parts = STACK.filter((l) => at(l) > 0).map((l) => `${count(at(l))} ${plural(l, at(l))}`);
    const t0 = barStart(b, a.step, a.off);
    return { x, text: `${timeOf(t0, a)}–${timeOf(t0 + a.step, a)} · ${parts.length ? parts.join(", ") : "nothing"}` };
  });

  return (
    <div
      class="lhist"
      ref={box}
      onPointerEnter={(e) => {
        over = true;
        left = box.getBoundingClientRect().left;
        hold();
        pointAt(xOf(e));
      }}
      onPointerMove={(e) => {
        hold();
        pointAt(xOf(e));
      }}
      onPointerLeave={() => {
        over = false;
        away();
      }}
      onPointerDown={down}
    >
      <canvas ref={canvas} style={{ width: "100%", height: `${H}px` }} />
      <Show when={seen()}>{(at) => <div class="lhist-seen" style={{ left: `${at()[0]}px`, width: `max(2px, ${at()[1]}px)` }} />}</Show>
      <Show when={!drag() && hovered() !== null && axis()}>{(a) => <div class="lhist-hover" style={{ left: `${xOfBar(a(), hovered() ?? 0, w())}px`, width: `${w() / a().bars}px` }} />}</Show>
      <Show when={drag() && axis()}>
        {(a) => {
          const span = () => {
            const d = drag() ?? { from: 0, to: 0 };
            const x0 = xOfBar(a(), Math.min(d.from, d.to), w());
            return [x0, xOfBar(a(), Math.max(d.from, d.to) + 1, w()) - x0] as const;
          };
          return <div class="lhist-brush" style={{ left: `${span()[0]}px`, width: `${span()[1]}px` }} />;
        }}
      </Show>
      <Show when={tip()}>
        {(t) => {
          // At the pointer, to its right on the left of the strip and to its left on the right: always inside it.
          const at = () => Math.max(0, Math.min(1, t().x / (w() || 1))) * 100;
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
