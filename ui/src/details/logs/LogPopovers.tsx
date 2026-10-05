import { createMemo, createSignal, For, Show } from "solid-js";
import { Icon } from "../../components/Icon";
import { Popover } from "../../components/Popover";
import { count } from "../../lib/format";
import { fieldTerm } from "../../lib/logs/query";
import { shortName } from "../../state/clusters";
import type { LogCtx } from "./LogViewer";
import { type FieldStat, fieldStats, numeric, pinned, quantile, togglePinned } from "./model";
import { valueText } from "./render";

const STATE_WORDS: Record<string, string> = { streaming: "live", reconnecting: "reconnecting", waiting: "waiting", ended: "ended", error: "error" };

/** The streams: each pod's containers, how they are doing, how many lines; show one alone, or hide some. */
export function LogSources(props: { ctx: LogCtx; anchor: HTMLElement; onClose: () => void }) {
  const c = props.ctx;
  const rows = createMemo(() => {
    c.version();
    const counts = c.buffer().counts;
    return c
      .sources()
      .byId.map((s) => ({ s, n: counts[s.id] ?? 0, state: c.states[s.id] }))
      .sort((a, b) => a.s.cluster.localeCompare(b.s.cluster) || a.s.pod.localeCompare(b.s.pod) || a.s.container.localeCompare(b.s.container));
  });
  const visible = (i: number) => (c.solo() !== null ? c.solo() === i : !c.hidden().has(i));
  const toggle = (i: number) => {
    if (c.solo() !== null) {
      // From "only one": every other one stays hidden, this one shows too.
      const solo = c.solo()!;
      c.setSolo(null);
      c.setHidden(new Set(c.sources().byId.map((s) => s.id).filter((id) => id !== solo && id !== i)));
      return;
    }
    const next = new Set(c.hidden());
    if (!next.delete(i)) next.add(i);
    c.setHidden(next);
  };
  return (
    <Popover anchor={props.anchor} onClose={props.onClose} width={440} maxHeight={480} align="right">
      <div class="pop-group">
        Sources · {rows().length} {rows().length === 1 ? "container" : "containers"}
        <span class="grow" />
        <Show when={c.solo() !== null || c.hidden().size > 0}>
          <button
            class="link-btn"
            onClick={() => {
              c.setSolo(null);
              c.setHidden(new Set());
            }}
          >
            Show all
          </button>
        </Show>
      </div>
      <div class="pop-list lsrc-list">
        <For each={rows()}>
          {(r) => (
            <div class="lsrc" classList={{ off: !visible(r.s.id), gone: !!r.s.gone }}>
              <button class="btn sm ghost icon" title={visible(r.s.id) ? "Hide its lines" : "Show its lines"} onClick={() => toggle(r.s.id)}>
                <Icon name={visible(r.s.id) ? "eye" : "eye-off"} size={12} />
              </button>
              <span class="swatch" style={{ background: c.color(r.s.id) }} />
              <button class="lsrc-name" title={`Only ${r.s.pod} · ${r.s.container}\n${r.s.cluster} · ${r.s.namespace}`} onClick={() => c.setSolo(c.solo() === r.s.id ? null : r.s.id)}>
                <span class="ellipsis">{r.s.pod}</span>
                <span class="faint">
                  {r.s.container}
                  {c.label(r.s.id).includes("/") || rows().some((x) => x.s.cluster !== r.s.cluster) ? ` · ${shortName(r.s.cluster)}` : ""}
                </span>
              </button>
              <span class={`lsrc-state ${r.state?.state === "error" ? "tone-err" : r.state?.state === "waiting" || r.state?.state === "reconnecting" ? "tone-warn" : ""}`} title={r.s.gone ?? r.state?.message ?? ""}>
                {r.s.gone ?? (r.state ? (r.state.message ?? STATE_WORDS[r.state.state]) : "connecting")}
              </span>
              <span class="lsrc-n faint">{count(r.n)}</span>
            </div>
          )}
        </For>
      </div>
      <div class="pop-foot">Click a name to show it alone. Lines of pods that went away stay.</div>
    </Popover>
  );
}

/** Distinct values kept per field. */
const MAX_VALUES = 200;

/** The fields of the structured lines shown: how many lines have each, their common values — as columns or filters. */
export function LogFields(props: { ctx: LogCtx; anchor: HTMLElement; onClose: () => void }) {
  const c = props.ctx;
  const [open, setOpen] = createSignal<string | null>(null);
  // The latest lines shown (a few thousand).
  const stats = createMemo(() => fieldStats(c.shown(), c.structures, 3000, MAX_VALUES));
  const top = (f: FieldStat) => [...f.values.values()].sort((a, b) => b.n - a.n).slice(0, 8);
  const numbers = (f: FieldStat) => {
    if (!numeric(f)) return null;
    const s = [...f.numbers].sort((a, b) => a - b);
    const fmt = (x: number) => (Number.isInteger(x) ? count(x) : x.toFixed(2));
    return `min ${fmt(s[0])} · median ${fmt(quantile(s, 0.5))} · p95 ${fmt(quantile(s, 0.95))} · max ${fmt(s[s.length - 1])}`;
  };
  return (
    <Popover anchor={props.anchor} onClose={props.onClose} width={420} maxHeight={560} align="right">
      <div class="pop-group">
        Fields · of the latest {count(stats().structured)} structured lines
      </div>
      <div class="pop-list lfields">
        <For each={stats().fields} fallback={<div class="opt faint">No structured lines shown</div>}>
          {(f) => (
            <div class="lfield" classList={{ open: open() === f.key }}>
              <div class="lfield-row">
                <button class="lfield-name" onClick={() => setOpen(open() === f.key ? null : f.key)}>
                  <Icon name={open() === f.key ? "chevron-down" : "chevron-right"} size={11} />
                  <span class="ellipsis">{f.key}</span>
                </button>
                <span class="lfield-cov faint" title={`${count(f.n)} of ${count(stats().structured)} lines`}>
                  {Math.round((f.n / Math.max(1, stats().structured)) * 100)}%
                </span>
                <span class="faint lfield-distinct">{f.many ? `${MAX_VALUES}+` : count(f.values.size)} values</span>
                <button class="btn sm ghost icon" classList={{ on: pinned().includes(f.key) }} title={pinned().includes(f.key) ? "Remove the column" : "Show as a column"} onClick={() => togglePinned(f.key)}>
                  <Icon name="columns" size={11} />
                </button>
              </div>
              <Show when={open() === f.key}>
                <Show when={numbers(f)}>
                  <div class="lfield-nums faint">{numbers(f)}</div>
                </Show>
                <For each={top(f)}>
                  {(v) => (
                    <div class="lfield-val">
                      <span class="lfield-bar" style={{ width: `${(v.n / f.n) * 100}%` }} />
                      <button class="lfield-v ellipsis" title={`Only lines with ${f.key} = this (⌥-click: leave them out)`} onClick={(e) => (props.onClose(), c.addTerm(fieldTerm(f.key, v.value, e.altKey)))}>
                        {valueText(v.value)}
                      </button>
                      <span class="faint">{count(v.n)}</span>
                      <button class="btn sm ghost icon" title="Leave out lines with this value" onClick={() => (props.onClose(), c.addTerm(fieldTerm(f.key, v.value, true)))}>
                        <Icon name="minus" size={11} />
                      </button>
                    </div>
                  )}
                </For>
              </Show>
            </div>
          )}
        </For>
      </div>
    </Popover>
  );
}
