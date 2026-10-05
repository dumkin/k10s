import { createEffect, createMemo, createSignal, For, on, Show } from "solid-js";
import { Icon } from "../components/Icon";
import { backend, errorMessage, type HelmRelease } from "../lib/backend";
import { age, dateTime } from "../lib/format";
import { blockMask, type Token, tokenizeLine } from "../lib/yaml";
import type { DetailProps } from "../registry/details";
import { rollbackRelease } from "../registry/helmActions";
import { now } from "../state/ui";
import { CodeView } from "./CodeView";
import { CopyButton, createSafeResource, KV, Section } from "./common";

// A Helm release's details: read from its records by the engine (no helm binary), fetched again when its
// revision changes. Values may hold passwords and keys: they show once asked for, for this release only.

const statusTone = (s: string) => (s === "deployed" ? "ok" : s === "failed" ? "err" : s === "superseded" || s === "uninstalled" ? "" : "warn");

function useRelease(props: DetailProps) {
  return createSafeResource(
    () => ({ cluster: props.row.cl, namespace: props.row.ns ?? "default", name: props.row.n, revision: props.row.rv }),
    ({ cluster, namespace, name }) => backend().helmRelease(cluster, namespace, name),
  );
}

/** Lines of YAML (highlighted like the YAML tab) or of a unified diff (added, removed, hunks). */
function TextView(props: { text: string; diff?: boolean; empty: string }) {
  const lines = createMemo(() => {
    const l = props.text.split("\n");
    if (l.length && l[l.length - 1] === "") l.pop();
    return l;
  });
  const mask = createMemo(() => (props.diff ? [] : blockMask(lines())));
  const cache = createMemo(() => (lines(), new Map<number, Token[]>()));
  const tokens = (i: number) => {
    let t = cache().get(i);
    if (!t) cache().set(i, (t = tokenizeLine(lines()[i] ?? "", mask()[i])));
    return t;
  };
  const diffClass = (i: number) => {
    const l = lines()[i] ?? "";
    return l.startsWith("@@") ? "d-hunk" : l.startsWith("+++") || l.startsWith("---") ? "d-file" : l.startsWith("+") ? "d-add" : l.startsWith("-") ? "d-del" : "";
  };
  return (
    <Show when={lines().length} fallback={<div class="section faint">{props.empty}</div>}>
      <CodeView
        count={lines().length}
        gutter={!props.diff}
        lineClass={props.diff ? diffClass : undefined}
        renderLine={(i) => (props.diff ? <span>{lines()[i]}</span> : <For each={tokens(i)}>{(t) => <span class={`y-${t.kind}`}>{t.text}</span>}</For>)}
      />
    </Show>
  );
}

export function ReleaseTab(props: DetailProps) {
  const rel = useRelease(props);
  return (
    <Show when={rel.value()} fallback={<Show when={rel.error()}>{(e) => <div class="section error-text">{errorMessage(e())}</div>}</Show>}>
      {(r) => (
        <>
          <Section title="Release">
            <KV
              items={[
                ["Status", <span class={`badge ${statusTone(r().status)}`}>{r().status}</span>],
                ["Revision", r().revision],
                ["Chart", <span class="mono">{r().chart}</span>],
                ["App version", r().appVersion],
                ["Namespace", r().namespace],
                ["Installed", r().firstDeployed ? `${dateTime(r().firstDeployed!)} · ${age(r().firstDeployed!, now())} ago` : undefined],
                ["Updated", r().lastDeployed ? `${dateTime(r().lastDeployed!)} · ${age(r().lastDeployed!, now())} ago` : undefined],
                ["Description", r().description],
                ["Revisions kept", r().history.length],
              ]}
            />
          </Section>
          <Show when={r().notes.trim()}>
            <Section title="Notes" actions={<CopyButton text={() => r().notes} />}>
              <pre class="helm-notes selectable">{r().notes.trim()}</pre>
            </Section>
          </Show>
        </>
      )}
    </Show>
  );
}

export function ValuesTab(props: DetailProps) {
  const rel = useRelease(props);
  const [computed, setComputed] = createSignal(false);
  // Shown for this release only: the next one selected starts hidden again (j/k, a sticky tab).
  const [shown, setShown] = createSignal(false);
  createEffect(on(() => `${props.row.cl}/${props.row.ns}/${props.row.n}`, () => setShown(false), { defer: true }));
  const text = () => (computed() ? rel.value()?.computed : rel.value()?.values) ?? "";
  return (
    <>
      <div class="toolbar">
        <div class="seg">
          <button class="btn sm ghost" classList={{ on: !computed() }} onClick={() => setComputed(false)} title="The values given at install or upgrade">
            Given
          </button>
          <button class="btn sm ghost" classList={{ on: computed() }} onClick={() => setComputed(true)} title="Those over the chart's defaults: what the templates were rendered with">
            All (with defaults)
          </button>
        </div>
        <span class="grow" />
        <Show when={rel.loading()}>
          <span class="spinner" />
        </Show>
        <Show when={shown()}>
          <button class="btn sm ghost" onClick={() => setShown(false)} title="Hide the values again">
            <Icon name="eye-off" size={12} />
            Hide values
          </button>
          <CopyButton text={text} />
        </Show>
      </div>
      <Show when={rel.error()}>{(e) => <div class="section error-text">{errorMessage(e())}</div>}</Show>
      <Show
        when={shown()}
        fallback={
          <div class="section helm-gate">
            <p class="faint">Values often hold passwords, tokens and keys in plain text.</p>
            <button class="btn sm" onClick={() => setShown(true)}>
              <Icon name="eye" size={12} />
              Show values
            </button>
          </div>
        }
      >
        <TextView text={text()} empty={computed() ? "No values." : "No values were given: the chart's defaults are used."} />
      </Show>
    </>
  );
}

export function ManifestTab(props: DetailProps) {
  const rel = useRelease(props);
  return (
    <>
      <div class="toolbar">
        <span class="faint" style={{ "font-size": "var(--fs-xs)" }}>
          What revision {rel.value()?.revision ?? "…"} applied (hooks aside)
        </span>
        <span class="grow" />
        <Show when={rel.loading()}>
          <span class="spinner" />
        </Show>
        <CopyButton text={() => rel.value()?.manifest ?? ""} />
      </div>
      <Show when={rel.error()}>{(e) => <div class="section error-text">{errorMessage(e())}</div>}</Show>
      <TextView text={rel.value()?.manifest ?? ""} empty={rel.loading() ? "" : "The release applied nothing."} />
    </>
  );
}

export function HistoryTab(props: DetailProps) {
  const rel = useRelease(props);
  const [picked, setPicked] = createSignal<number>();
  const [what, setWhat] = createSignal<"values" | "manifest">("manifest");
  const current = () => rel.value()?.revision;
  // By default: what the latest revision changed (against the one before it).
  const base = createMemo(() => picked() ?? rel.value()?.history[1]?.revision);
  const diff = createSafeResource(
    () => {
      const r = rel.value();
      const b = base();
      return r && b !== undefined && b !== r.revision ? { r, from: b } : null;
    },
    ({ r, from }: { r: HelmRelease; from: number }) => backend().helmDiff(props.row.cl, r.namespace, r.name, from, r.revision),
  );
  return (
    <div class="helm-history">
      <div class="helm-revisions">
        <table class="mini-table">
          <thead>
            <tr>
              <th>Rev</th>
              <th>Status</th>
              <th>Chart</th>
              <th>App</th>
              <th>Updated</th>
              <th>Description</th>
              <th />
            </tr>
          </thead>
          <tbody>
            <For each={rel.value()?.history ?? []}>
              {(h) => (
                <tr classList={{ sel: base() === h.revision }} onClick={() => h.revision !== current() && setPicked(h.revision)} title={h.revision === current() ? "The current revision" : "Compare with the current revision"}>
                  <td class="mono">{h.revision}</td>
                  <td>
                    <span class={`badge ${statusTone(h.status)}`}>{h.status}</span>
                  </td>
                  <td class="mono">{h.chart}</td>
                  <td>{h.appVersion}</td>
                  <td>{h.updated ? `${age(h.updated, now())} ago` : ""}</td>
                  <td class="ellipsis" style={{ "max-width": "260px" }} title={h.description}>
                    {h.description}
                  </td>
                  <td>
                    <Show when={h.revision !== current()}>
                      <button
                        class="btn sm ghost"
                        title={`helm rollback ${rel.value()?.name} ${h.revision}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          void rollbackRelease(props.row, h.revision);
                        }}
                      >
                        <Icon name="restart" size={12} />
                        Roll back
                      </button>
                    </Show>
                  </td>
                </tr>
              )}
            </For>
          </tbody>
        </table>
      </div>
      <div class="toolbar">
        <span style={{ "font-size": "var(--fs-sm)" }}>
          <Show when={base() !== undefined} fallback={<span class="faint">One revision: nothing to compare.</span>}>
            Revision {base()} → {current()}
          </Show>
        </span>
        <div class="seg">
          <button class="btn sm ghost" classList={{ on: what() === "manifest" }} onClick={() => setWhat("manifest")}>
            Manifest
          </button>
          <button class="btn sm ghost" classList={{ on: what() === "values" }} onClick={() => setWhat("values")} title="The values given (they may hold secrets)">
            Values
          </button>
        </div>
        <span class="grow" />
        <Show when={diff.loading()}>
          <span class="spinner" />
        </Show>
      </div>
      <Show when={diff.error()}>{(e) => <div class="section error-text">{errorMessage(e())}</div>}</Show>
      <Show when={base() !== undefined}>
        <TextView text={diff.value()?.[what()] ?? ""} diff empty={diff.loading() ? "" : `No difference in the ${what()}.`} />
      </Show>
    </div>
  );
}
