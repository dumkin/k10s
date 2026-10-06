import { createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import { Icon } from "../../components/Icon";
import { count } from "../../lib/format";
import { gapOf } from "../../lib/logs/format";
import { Level, LEVEL_NAME } from "../../lib/logs/parse";
import { patternParts, type PatternIds } from "../../lib/logs/patterns";
import { clusterColor, shortName } from "../../state/clusters";
import type { Line } from "../logBuffer";
import type { LogCtx } from "./LogViewer";
import { LEVEL_COLORS } from "./model";
import { createPasses } from "./passes";

/** Patterns worked out per pass; a log of 100,000 lines takes a few passes, the view stays responsive. */
const PER_PASS = 8_000;
/** Points of each pattern's sparkline. */
const SPARK = 28;
/** Patterns listed (the rest are counted). */
const SHOWN = 300;
/** Lines that keep coming are counted at most every `EVERY` ms. */
const EVERY = 400;
/** A row pressed keeps the list still until it is released, at most this long (a release may never come). */
const HOLD = 2_000;

/**
 * A pattern listed: the same object for as long as it is listed, so its row stays the same elements (a click or a
 * hover lands on it). What it counts is the latest pass's (`Counts`).
 */
interface Row {
  id: number;
  pattern: string;
  level: Level;
}

/** A pattern's lines, as a pass counted them. */
interface Counts {
  count: number;
  first: number;
  last: number;
  clusters: Map<string, number>;
  spark: Uint32Array;
  sample: Line;
}

type Sort = "count" | "level" | "recent";

/**
 * The lines as the patterns they follow: what varies (numbers, ids, times) masked, what stays counted. The few
 * patterns of thousands of lines, which is new, which only one cluster logs; one click shows a pattern's lines or
 * hides them (health checks, noise).
 */
export function LogPatterns(props: { ctx: LogCtx }) {
  const c = props.ctx;
  const [sort, setSort] = createSignal<Sort>("count");
  // Counted again as lines come at most every EVERY ms (see `createPasses`: a filter at once, nothing while paused) —
  // and not while a row is pressed: a row moved between the press and the release (taken out and put back) loses the
  // click.
  let heldUntil = 0;
  const passes = createPasses(c.patternsBase, c.buffer, EVERY, () => heldUntil - performance.now());
  const hold = (e: PointerEvent) => {
    if (e.button === 0) heldUntil = performance.now() + HOLD;
  };
  // Released: after the click that follows (the same event), what waited is counted.
  const release = () => {
    if (!heldUntil) return;
    setTimeout(() => {
      if (!heldUntil) return;
      heldUntil = 0;
      passes.release();
    });
  };
  window.addEventListener("pointerup", release);
  window.addEventListener("pointercancel", release);
  // "5s ago" as time goes, whether lines come or not.
  const [now, setNow] = createSignal(Date.now());
  const clock = setInterval(() => setNow(Date.now()), 1000);
  onCleanup(() => {
    heldUntil = 0;
    clearInterval(clock);
    window.removeEventListener("pointerup", release);
    window.removeEventListener("pointercancel", release);
  });

  /** The rows by pattern id, of the ids they were made with (another stream numbers its patterns anew). */
  let rowsOf = new Map<number, Row>();
  let rowsIds: PatternIds | undefined;
  const data = createMemo(() => {
    const lines = passes.lines();
    const levels = c.levels();
    const range = c.range();
    const ids = c.patternIds();
    if (ids !== rowsIds) {
      rowsIds = ids;
      rowsOf = new Map();
    }
    const rows: Row[] = [];
    const counts = new Map<number, Counts>();
    let budget = PER_PASS;
    let pending = 0;
    let total = 0;
    let first = Infinity;
    let last = -Infinity;
    for (const l of lines) {
      if (l.marker || levels.has(l.lvl) || (range && (l.key < range[0] || l.key >= range[1]))) continue;
      if (l.key < first) first = l.key;
      if (l.key > last) last = l.key;
    }
    const span = Math.max(1, last - first);
    for (const l of lines) {
      if (l.marker || levels.has(l.lvl) || (range && (l.key < range[0] || l.key >= range[1]))) continue;
      let id = l.pat;
      if (id === undefined) {
        if (budget-- <= 0) {
          pending++;
          continue;
        }
        id = c.patternOf(l);
      }
      total++;
      let n = counts.get(id);
      if (!n) {
        let r = rowsOf.get(id);
        if (!r) {
          // (A pattern's key is its level and its text: `3|GET /api/<*>`.)
          const p = ids.patterns[id];
          const bar = p.indexOf("|");
          r = { id, pattern: p.slice(bar + 1), level: Number(p.slice(0, bar)) as Level };
          rowsOf.set(id, r);
        }
        rows.push(r);
        n = { count: 0, first: l.key, last: l.key, clusters: new Map(), spark: new Uint32Array(SPARK), sample: l };
        counts.set(id, n);
      }
      n.count++;
      n.last = l.key;
      n.sample = l;
      const cluster = c.sources().byId[l.i]?.cluster ?? "";
      n.clusters.set(cluster, (n.clusters.get(cluster) ?? 0) + 1);
      n.spark[Math.min(SPARK - 1, Math.floor(((l.key - first) / span) * SPARK))]++;
    }
    // Patterns of the lines not worked out yet: in the next pass, soon.
    if (pending) passes.soon(16);
    return { rows, counts, total, pending, first, last };
  });
  const sorted = createMemo(() => {
    const { rows, counts } = data();
    const n = (r: Row) => counts.get(r.id)!;
    const s = sort();
    return [...rows].sort(s === "level" ? (a, b) => b.level - a.level || n(b).count - n(a).count : s === "recent" ? (a, b) => n(b).last - n(a).last : (a, b) => n(b).count - n(a).count).slice(0, SHOWN);
  });
  const max = createMemo(() => {
    let m = 1;
    for (const n of data().counts.values()) m = Math.max(m, n.count);
    return m;
  });
  const clusters = createMemo(() => (data(), [...new Set(c.sources().byId.map((s) => s.cluster))].sort()), [], { equals: (a, b) => a.join() === b.join() });

  const show = (id: number) => {
    c.setOnly(new Set([id]));
    c.setView("lines");
  };
  const toggleHidden = (id: number) => {
    const next = new Set(c.hiddenPatterns());
    if (!next.delete(id)) next.add(id);
    c.setHiddenPatterns(next);
  };

  return (
    <div class="lpat">
      <div class="lpat-head">
        <span>
          <b>{count(data().rows.length)}</b> {data().rows.length === 1 ? "pattern" : "patterns"} in {count(data().total)} lines
          <Show when={data().pending}>
            <span class="faint"> · reading {count(data().pending)} more…</span>
          </Show>
        </span>
        <Show when={c.only().size}>
          <button class="chip" title="Show every pattern's lines" onClick={() => c.setOnly(new Set())}>
            only {c.only().size} {c.only().size === 1 ? "pattern" : "patterns"} <Icon name="x" size={10} />
          </button>
        </Show>
        <Show when={c.hiddenPatterns().size}>
          <button class="chip" title="Show the hidden patterns' lines again" onClick={() => c.setHiddenPatterns(new Set())}>
            {c.hiddenPatterns().size} hidden <Icon name="x" size={10} />
          </button>
        </Show>
        <span class="grow" />
        <select class="input" value={sort()} onChange={(e) => setSort(e.currentTarget.value as Sort)} title="Order">
          <option value="count">Most lines first</option>
          <option value="level">Errors first</option>
          <option value="recent">Latest first</option>
        </select>
      </div>
      <div class="lpat-list" onPointerDown={hold}>
        <For each={sorted()} fallback={<div class="logv-empty faint">{c.buffer().lines.length ? "No lines to group" : c.summary().text}</div>}>
          {(r) => {
            // The latest pass's numbers (a row on its way out keeps its last ones).
            const n = createMemo<Counts>((prev) => data().counts.get(r.id) ?? prev!);
            const hidden = () => c.hiddenPatterns().has(r.id);
            const only = () => c.only().has(r.id);
            const spread = () => {
              const all = clusters();
              if (all.length < 2) return null;
              const present = all.filter((cl) => n().clusters.get(cl));
              return { present, all, note: present.length === 1 ? `only ${shortName(present[0])}` : present.length === all.length ? `all ${all.length}` : present.map(shortName).join(", ") };
            };
            const spark = () => {
              const points = n().spark;
              const top = Math.max(1, ...points);
              return Array.from(points, (v, k) => `${k === 0 ? "M" : "L"}${(k * 64) / (SPARK - 1)},${16 - (v / top) * 14}`).join(" ");
            };
            return (
              <div class="lpat-row" classList={{ hidden: hidden(), only: only() }} title={`Latest: ${n().sample.text.replace(/\x1b\[[\d;]*m/g, "").slice(0, 400)}`}>
                <span class="lpat-count">
                  <span class="lpat-bar" style={{ width: `${(n().count / max()) * 100}%`, background: LEVEL_COLORS[r.level] }} />
                  <b>{count(n().count)}</b>
                </span>
                <span class="lpat-lvl" style={{ color: LEVEL_COLORS[r.level] }} title={r.level ? LEVEL_NAME[r.level] : "no level"}>
                  {r.level ? LEVEL_NAME[r.level].toUpperCase() : "·"}
                </span>
                <button class="lpat-text" onClick={() => show(r.id)} title="Show these lines">
                  <For each={patternParts(r.pattern)}>{(p) => (p.wild ? <span class="wild">{p.text}</span> : p.text)}</For>
                </button>
                <Show when={spread()}>
                  {(s) => (
                    <span class="lpat-spread" title={s().all.map((cl) => `${shortName(cl)}: ${count(n().clusters.get(cl) ?? 0)}`).join("\n")}>
                      <For each={s().all}>{(cl) => <span class="sq" style={{ background: n().clusters.get(cl) ? clusterColor(cl) : undefined }} classList={{ none: !n().clusters.get(cl) }} />}</For>
                      <span class="faint" classList={{ "tone-2": s().present.length === 1 }}>
                        {s().note}
                      </span>
                    </span>
                  )}
                </Show>
                <svg class="lpat-spark" viewBox="0 0 64 16" preserveAspectRatio="none" aria-hidden="true">
                  <path d={spark()} />
                </svg>
                <span class="lpat-age faint" title="Last seen">
                  {(() => {
                    const ago = now() - n().last;
                    return ago < 2000 ? "now" : `${gapOf(ago)} ago`;
                  })()}
                </span>
                <button class="btn sm ghost icon" title={hidden() ? "Show these lines again" : "Hide these lines (noise)"} onClick={() => toggleHidden(r.id)}>
                  <Icon name={hidden() ? "eye" : "eye-off"} size={12} />
                </button>
              </div>
            );
          }}
        </For>
        <Show when={data().rows.length > SHOWN}>
          <div class="faint lpat-more">… and {count(data().rows.length - SHOWN)} more patterns with fewer lines</div>
        </Show>
      </div>
    </div>
  );
}
