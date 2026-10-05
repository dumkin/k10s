import { createEffect, createMemo, createSignal, For, on, onCleanup, Show } from "solid-js";
import { Icon } from "../../components/Icon";
import { count } from "../../lib/format";
import { gapOf } from "../../lib/logs/format";
import { Level, LEVEL_NAME } from "../../lib/logs/parse";
import { patternParts } from "../../lib/logs/patterns";
import { clusterColor, shortName } from "../../state/clusters";
import type { Line } from "../logBuffer";
import type { LogCtx } from "./LogViewer";
import { LEVEL_COLORS } from "./model";

/** Patterns worked out per pass; a log of 100,000 lines takes a few passes, the view stays responsive. */
const PER_PASS = 8_000;
/** Points of each pattern's sparkline. */
const SPARK = 28;
/** Patterns listed (the rest are counted). */
const SHOWN = 300;

interface Row {
  id: number;
  pattern: string;
  level: Level;
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
  const [tick, setTick] = createSignal(0);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastRun = 0;
  const schedule = (ms: number) => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      lastRun = performance.now();
      setTick((t) => t + 1);
    }, ms);
  };
  createEffect(on([c.patternsBase, c.levels, c.range], () => schedule(Math.max(0, lastRun + 400 - performance.now()))));
  onCleanup(() => clearTimeout(timer));

  const data = createMemo(() => {
    tick();
    const lines = c.patternsBase();
    const levels = c.levels();
    const range = c.range();
    const rows = new Map<number, Row>();
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
      let r = rows.get(id);
      if (!r) {
        const p = c.patternIds().patterns[id];
        r = { id, pattern: p.slice(p.indexOf("|") + 1), level: l.lvl, count: 0, first: l.key, last: l.key, clusters: new Map(), spark: new Uint32Array(SPARK), sample: l };
        rows.set(id, r);
      }
      r.count++;
      r.last = l.key;
      r.sample = l;
      const cluster = c.sources().byId[l.i]?.cluster ?? "";
      r.clusters.set(cluster, (r.clusters.get(cluster) ?? 0) + 1);
      r.spark[Math.min(SPARK - 1, Math.floor(((l.key - first) / span) * SPARK))]++;
    }
    // Patterns of the lines not worked out yet: in the next pass, soon.
    if (pending) schedule(16);
    return { rows: [...rows.values()], total, pending, first, last };
  });
  const sorted = createMemo(() => {
    const rows = [...data().rows];
    const s = sort();
    rows.sort(s === "level" ? (a, b) => b.level - a.level || b.count - a.count : s === "recent" ? (a, b) => b.last - a.last : (a, b) => b.count - a.count);
    return rows.slice(0, SHOWN);
  });
  const max = createMemo(() => data().rows.reduce((m, r) => Math.max(m, r.count), 1));
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
      <div class="lpat-list">
        <For each={sorted()} fallback={<div class="logv-empty faint">{c.buffer().lines.length ? "No lines to group" : c.summary().text}</div>}>
          {(r) => {
            const hidden = () => c.hiddenPatterns().has(r.id);
            const only = () => c.only().has(r.id);
            const spread = () => {
              const all = clusters();
              if (all.length < 2) return null;
              const present = all.filter((cl) => r.clusters.get(cl));
              return { present, all, note: present.length === 1 ? `only ${shortName(present[0])}` : present.length === all.length ? `all ${all.length}` : present.map(shortName).join(", ") };
            };
            const spark = () => {
              const top = Math.max(1, ...r.spark);
              return Array.from(r.spark, (n, k) => `${k === 0 ? "M" : "L"}${(k * 64) / (SPARK - 1)},${16 - (n / top) * 14}`).join(" ");
            };
            return (
              <div class="lpat-row" classList={{ hidden: hidden(), only: only() }} title={`Latest: ${r.sample.text.replace(/\x1b\[[\d;]*m/g, "").slice(0, 400)}`}>
                <span class="lpat-count">
                  <span class="lpat-bar" style={{ width: `${(r.count / max()) * 100}%`, background: LEVEL_COLORS[r.level] }} />
                  <b>{count(r.count)}</b>
                </span>
                <span class="lpat-lvl" style={{ color: LEVEL_COLORS[r.level] }} title={r.level ? LEVEL_NAME[r.level] : "no level"}>
                  {r.level ? LEVEL_NAME[r.level].toUpperCase() : "·"}
                </span>
                <button class="lpat-text" onClick={() => show(r.id)} title="Show these lines">
                  <For each={patternParts(r.pattern)}>{(p) => (p.wild ? <span class="wild">{p.text}</span> : p.text)}</For>
                </button>
                <Show when={spread()}>
                  {(s) => (
                    <span class="lpat-spread" title={s().all.map((cl) => `${shortName(cl)}: ${count(r.clusters.get(cl) ?? 0)}`).join("\n")}>
                      <For each={s().all}>{(cl) => <span class="sq" style={{ background: r.clusters.get(cl) ? clusterColor(cl) : undefined }} classList={{ none: !r.clusters.get(cl) }} />}</For>
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
                    const ago = Date.now() - r.last;
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
