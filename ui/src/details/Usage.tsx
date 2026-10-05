import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { backend, type Cell, type MetricsHistory, type MetricsKind, type MetricsStatus } from "../lib/backend";
import { bytes, cpu } from "../lib/format";
import { now } from "../state/ui";
import type { UIRow } from "../state/view";
import { mainView } from "../state/views";
import { Section } from "./common";

/** What the sparkline spans: the engine keeps ten minutes (40 samples, one per 15 s). */
const WIDTH = 168;
const HEIGHT = 30;

const num = (c: Cell | undefined): number | null => (typeof c === "number" ? c : null);

/** One of the row's own cells by column id (a pod's requests and limits, a node's allocatable). */
function own(row: UIRow, id: string): number | null {
  const i = mainView.columns().findIndex((c) => c.id === id);
  return i < 0 ? null : num(row.c[i]);
}

/**
 * Usage of a pod or node: now against what it asks for and is limited to (a node: what it can allocate), the last
 * ten minutes as a line — no other client keeps this without Prometheus — and a pod's containers. Polled by the
 * engine for as long as this shows (shared with the table when it polls the same namespace).
 */
export function UsageSection(props: { row: UIRow; kind: MetricsKind }) {
  const [status, setStatus] = createSignal<MetricsStatus>();
  const [latest, setLatest] = createSignal<{ at: number; cpu: number; mem: number }>();
  const [history, setHistory] = createSignal<MetricsHistory | null>(null);
  const ns = () => (props.kind === "pods" ? (props.row.ns ?? "") : "");

  onMount(() => {
    const row = props.row;
    const refresh = () =>
      void backend()
        .metricsHistory(row.cl, props.kind, props.kind === "pods" ? (row.ns ?? null) : null, row.n)
        .then(setHistory, () => {});
    const sub = backend().subscribeMetrics({ kind: props.kind, clusters: [row.cl], namespaces: props.kind === "pods" && row.ns ? [row.ns] : [] }, (m) => {
      if (m.t === "status") return setStatus(m.state === "ok" ? { state: "ok" } : { state: m.state, message: m.message });
      const it = m.items.find(([n, name]) => name === row.n && (props.kind === "nodes" || n === ns()));
      setLatest(it ? { at: m.at, cpu: it[2], mem: it[3] } : undefined);
      refresh();
    });
    onCleanup(() => sub.close());
  });

  const bounds = createMemo(() =>
    props.kind === "pods"
      ? { cpuReq: own(props.row, "cpuRequest"), cpuLim: own(props.row, "cpuLimit"), memReq: own(props.row, "memRequest"), memLim: own(props.row, "memLimit") }
      : { cpuReq: null, cpuLim: own(props.row, "cpu"), memReq: null, memLim: own(props.row, "memory") },
  );
  const limitWord = () => (props.kind === "pods" ? "limit" : "allocatable");

  return (
    <Section
      title={
        <>
          Usage
          <Show when={latest()}>{(l) => <span class="faint usage-age">{Math.max(0, now() - l().at)}s ago · every 15 s</span>}</Show>
        </>
      }
    >
      <Show
        when={latest()}
        fallback={
          <div class="faint usage-none">
            {status() && status()!.state !== "ok" ? `No usage: ${(status() as { message: string }).message}` : status() ? "No usage for it yet (it may not be running)" : "Reading usage…"}
          </div>
        }
      >
        {(l) => (
          <div class="usage">
            <UsageLine
              label="CPU"
              value={l().cpu}
              fmt={cpu}
              request={bounds().cpuReq}
              limit={bounds().cpuLim}
              limitWord={limitWord()}
              samples={history()?.samples.map(([t, c]) => [t, c] as [number, number]) ?? []}
            />
            <UsageLine
              label="MEM"
              value={l().mem}
              fmt={bytes}
              request={bounds().memReq}
              limit={bounds().memLim}
              limitWord={limitWord()}
              samples={history()?.samples.map(([t, , m]) => [t, m] as [number, number]) ?? []}
            />
            <Show when={props.kind === "pods" && (history()?.containers.length ?? 0) > 1}>
              <table class="mini-table usage-containers">
                <tbody>
                  <For each={history()!.containers}>
                    {([name, c, m]) => (
                      <tr>
                        <td>{name}</td>
                        <td class="mono r">{cpu(c)}</td>
                        <td class="mono r">{bytes(m)}</td>
                      </tr>
                    )}
                  </For>
                </tbody>
              </table>
            </Show>
          </div>
        )}
      </Show>
    </Section>
  );
}

function UsageLine(props: { label: string; value: number; fmt: (n: number) => string; request: number | null; limit: number | null; limitWord: string; samples: [number, number][] }) {
  const ratio = () => (props.limit ? props.value / props.limit : null);
  const tone = () => (ratio() === null ? "" : ratio()! >= 0.9 ? "err" : ratio()! >= 0.7 ? "warn" : "ok");
  const of = () =>
    [props.limit ? `of ${props.fmt(props.limit)} ${props.limitWord} (${Math.round((props.value / props.limit) * 100)}%)` : `no ${props.limitWord}`, props.request ? `${props.fmt(props.request)} requested (${Math.round((props.value / props.request) * 100)}%)` : undefined]
      .filter(Boolean)
      .join(" · ");
  return (
    <div class="usage-line">
      <span class="usage-label">{props.label}</span>
      <Sparkline samples={props.samples} request={props.request} limit={props.limit} />
      <span class={`usage-value mono ${tone() ? `tone-${tone()}` : ""}`}>{props.fmt(props.value)}</span>
      <span class="faint usage-of">{of()}</span>
    </div>
  );
}

/**
 * The last minutes as a line, scaled to the larger of what was used and what was requested: the request dashed, the
 * limit too when the line comes close to it.
 */
function Sparkline(props: { samples: [number, number][]; request: number | null; limit: number | null }) {
  const scale = () => Math.max(1e-9, ...props.samples.map(([, v]) => v), props.request ?? 0) * 1.15;
  const y = (v: number) => HEIGHT - 2 - (v / scale()) * (HEIGHT - 4);
  const points = () => {
    const s = props.samples;
    if (s.length < 2) return "";
    const t0 = s[0][0];
    const span = Math.max(1, s[s.length - 1][0] - t0);
    return s.map(([t, v]) => `${(((t - t0) / span) * (WIDTH - 2) + 1).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  };
  return (
    <svg class="sparkline" width={WIDTH} height={HEIGHT} viewBox={`0 0 ${WIDTH} ${HEIGHT}`} aria-hidden="true">
      <Show when={points()} fallback={<line x1="1" x2={WIDTH - 1} y1={HEIGHT - 2} y2={HEIGHT - 2} class="spark-base" />}>
        <polygon points={`1,${HEIGHT - 2} ${points()} ${WIDTH - 1},${HEIGHT - 2}`} class="spark-area" />
        <polyline points={points()} class="spark-line" />
      </Show>
      <Show when={props.request && props.request < scale()}>
        <line x1="1" x2={WIDTH - 1} y1={y(props.request!)} y2={y(props.request!)} class="spark-request" />
      </Show>
      <Show when={props.limit && props.limit < scale()}>
        <line x1="1" x2={WIDTH - 1} y1={y(props.limit!)} y2={y(props.limit!)} class="spark-limit" />
      </Show>
    </svg>
  );
}
