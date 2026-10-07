import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { Icon } from "../../components/Icon";
import { count } from "../../lib/format";
import { withKeys } from "../../lib/hotkeys";
import { clockOf, gapOf } from "../../lib/logs/format";
import { histogram, type Histogram, LEVEL_SLOTS, stepLabel } from "../../lib/logs/histogram";
import { Level, LEVEL_NAME, LEVELS } from "../../lib/logs/parse";
import { indexAtKey } from "../logBuffer";
import type { LogCtx } from "./LogViewer";
import { histogramOpen, setHistogramOpen, utc } from "./model";
import { createPasses } from "./passes";

const H = 46;
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

  const [width, setWidth] = createSignal(600);
  const counts = createMemo(() => {
    const n = new Array<number>(LEVEL_SLOTS).fill(0);
    for (const l of passes.lines()) if (!l.marker) n[l.lvl]++;
    return n;
  });
  // (Only while it is shown: a memo is worked out whether it is read or not.)
  const hist = createMemo<Histogram | null>(() => (histogramOpen() && c.roomy() ? histogram(passes.lines(), Math.floor(width() / BAR)) : null));

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
        <Bars ctx={c} hist={hist} onWidth={setWidth} />
      </Show>
    </div>
  );
}

function Bars(props: { ctx: LogCtx; hist: () => Histogram | null; onWidth: (w: number) => void }) {
  const c = props.ctx;
  let canvas!: HTMLCanvasElement;
  let box!: HTMLDivElement;
  const [w, setW] = createSignal(600);
  const [hover, setHover] = createSignal<{ b: number; x: number } | null>(null);
  const [drag, setDrag] = createSignal<{ from: number; to: number } | null>(null);
  onMount(() => {
    const ro = new ResizeObserver(() => {
      setW(box.clientWidth);
      props.onWidth(box.clientWidth);
    });
    ro.observe(box);
    onCleanup(() => ro.disconnect());
  });

  /** The bucket under x (pixels in the canvas). */
  const bucketAt = (h: Histogram, x: number) => Math.max(0, Math.min(h.n - 1, Math.floor((x / w()) * h.n)));

  // The bars are drawn again when they change (at most a few times a second), not as the screen moves over them:
  // that is a marker of its own (below). Colours are read once per theme — reading them makes the browser work out
  // the styles of the whole page, which a log that streams changes all the time.
  const [theme, setTheme] = createSignal(document.documentElement.dataset.theme);
  onMount(() => {
    const mo = new MutationObserver(() => setTheme(document.documentElement.dataset.theme));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    onCleanup(() => mo.disconnect());
  });
  let palette: { theme: string | undefined; fill: string[] } | undefined;
  createEffect(() => {
    const h = props.hist();
    const t = theme();
    const css = palette?.theme === t ? null : getComputedStyle(canvas);
    const pal = css ? (palette = { theme: t, fill: STACK.map((l) => css.getPropertyValue(BAR_VAR[l]).trim() || css.getPropertyValue(LEVEL_VAR[l]).trim() || "#888") }) : palette!;
    const width = w();
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
    if (!h || !h.max) return;
    const fill = pal.fill;
    const bw = width / h.n;
    const gap = bw > 4 ? 1 : 0;
    const hidden = c.levels();
    const range = c.range();
    for (let b = 0; b < h.n; b++) {
      let y = H;
      const t0 = h.start + b * h.step;
      const outside = range && (t0 + h.step <= range[0] || t0 >= range[1]);
      for (let s = 0; s < STACK.length; s++) {
        const l = STACK[s];
        const n = h.counts[b * LEVEL_SLOTS + l];
        if (!n) continue;
        const bh = Math.max(1, (n / h.max) * (H - 4));
        g.globalAlpha = hidden.has(l) ? 0.15 : outside ? 0.3 : 0.85;
        g.fillStyle = fill[s];
        g.fillRect(b * bw + gap / 2, y - bh, Math.max(1, bw - gap), bh);
        y -= bh;
      }
    }
    g.globalAlpha = 1;
  });
  /** Where the screen is, as a share of the width: [left, width]. */
  const seen = createMemo<readonly [number, number] | null>(() => {
    const h = props.hist();
    const at = c.onScreen();
    if (!h || !h.max || !at) return null;
    const span = h.n * h.step;
    const x0 = Math.max(0, Math.min(1, (at[0] - h.start) / span));
    const x1 = Math.max(x0, Math.min(1, (at[1] - h.start) / span));
    return [x0, x1 - x0];
  });

  const tip = createMemo(() => {
    const h = props.hist();
    const at = hover();
    if (!h || !at) return null;
    const t0 = h.start + at.b * h.step;
    const parts = STACK.filter((l) => h.counts[at.b * LEVEL_SLOTS + l] > 0).map((l) => `${count(h.counts[at.b * LEVEL_SLOTS + l])} ${plural(l, h.counts[at.b * LEVEL_SLOTS + l])}`);
    return { x: at.x, text: `${clockOf(t0, utc()).slice(0, 8)} +${stepLabel(h.step)} · ${parts.length ? parts.join(", ") : "nothing"}` };
  });

  const down = (e: PointerEvent) => {
    const h = props.hist();
    if (!h || e.button !== 0) return;
    const rect = canvas.getBoundingClientRect();
    const b0 = bucketAt(h, e.clientX - rect.left);
    setDrag({ from: b0, to: b0 });
    const move = (ev: PointerEvent) => setDrag({ from: b0, to: bucketAt(h, ev.clientX - rect.left) });
    const up = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      const d = drag();
      setDrag(null);
      if (!d) return;
      const moved = Math.abs(ev.clientX - e.clientX) > 3;
      if (!moved) {
        // A click: to the first line of that stretch of time.
        const lines = c.shown();
        const k = indexAtKey(lines, h.start + b0 * h.step);
        const l = lines[Math.min(k, lines.length - 1)];
        if (l) {
          c.select(l);
          c.reveal(l);
        }
        return;
      }
      const [a, b] = d.from <= d.to ? [d.from, d.to] : [d.to, d.from];
      c.setRange([h.start + a * h.step, h.start + (b + 1) * h.step]);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const spanText = () => {
    const h = props.hist();
    return h ? `${gapOf(h.n * h.step)} · ${stepLabel(h.step)} bars` : "";
  };

  return (
    <div class="lhist" ref={box} title={spanText()}>
      <canvas
        ref={canvas}
        style={{ width: "100%", height: `${H}px` }}
        onPointerDown={down}
        onPointerMove={(e) => {
          const h = props.hist();
          if (!h) return;
          const x = e.clientX - canvas.getBoundingClientRect().left;
          setHover({ b: bucketAt(h, x), x });
        }}
        onPointerLeave={() => setHover(null)}
      />
      <Show when={seen()}>
        {(at) => <div class="lhist-seen" style={{ left: `${at()[0] * 100}%`, width: `max(2px, ${at()[1] * 100}%)` }} />}
      </Show>
      <Show when={drag()}>
        {(d) => {
          const h = props.hist()!;
          const a = () => Math.min(d().from, d().to);
          const b = () => Math.max(d().from, d().to);
          return <div class="lhist-brush" style={{ left: `${(a() / h.n) * 100}%`, width: `${((b() - a() + 1) / h.n) * 100}%` }} />;
        }}
      </Show>
      <Show when={tip() && !drag()}>
        <div class="lhist-tip" style={{ left: `${Math.min(tip()!.x, w() - 220)}px` }}>
          {tip()!.text}
        </div>
      </Show>
    </div>
  );
}
