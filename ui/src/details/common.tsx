import { type Accessor, createResource, createSignal, For, type JSX, Show } from "solid-js";
import { Icon } from "../components/Icon";
import { backend, type ObjectRef } from "../lib/backend";
import { age, dateTime, parseTime } from "../lib/format";
import { now, toast } from "../state/ui";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type K8sObject = Record<string, any>;

type Outcome<T> = { ok: true; value: T } | { ok: false; error: unknown };

/**
 * `createResource` that never enters the error state. Solid resources re-throw their error from
 * `.latest`/`()` reads, which would escape into the render cycle; here failures are values instead,
 * and the last good value stays visible while a refresh fails (e.g. the object was just deleted).
 */
export function createSafeResource<S, T>(source: () => S | false | null | undefined, fetch: (s: S) => Promise<T>) {
  let last: T | undefined;
  const [res, { refetch }] = createResource(source, async (s): Promise<Outcome<T>> => {
    try {
      return { ok: true, value: await fetch(s) };
    } catch (error) {
      return { ok: false, error };
    }
  });
  return {
    value: (): T | undefined => {
      const r = res.latest;
      if (r?.ok) last = r.value;
      return last;
    },
    error: (): unknown => {
      const r = res.latest;
      return r && !r.ok ? r.error : undefined;
    },
    loading: () => res.loading,
    refetch,
  };
}

/** Full object for the details panel; re-fetched (from the engine's in-memory cache) when `rv` changes. */
export function useObject(target: Accessor<ObjectRef>, rv: Accessor<string>) {
  const obj = createSafeResource(
    () => ({ ...target(), rv: rv() }),
    ({ rv: _rv, ...t }) => backend().getObject(t) as Promise<K8sObject>,
  );
  return { value: obj.value, loading: () => obj.loading() && !obj.value(), error: obj.error };
}

export function Section(props: { title: JSX.Element; children: JSX.Element; actions?: JSX.Element }) {
  return (
    <section class="section">
      <h3>
        {props.title}
        <Show when={props.actions}>
          <span class="grow" />
          {props.actions}
        </Show>
      </h3>
      {props.children}
    </section>
  );
}

export function KV(props: { items: [string, JSX.Element | string | number | null | undefined][] }) {
  return (
    <dl class="kv">
      <For each={props.items.filter(([, v]) => v !== undefined && v !== null && v !== "")}>
        {([k, v]) => (
          <>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </>
        )}
      </For>
    </dl>
  );
}

export function TimeAgo(props: { time?: string | null }) {
  const t = () => parseTime(props.time);
  return (
    <Show when={t()} fallback={<span class="faint">—</span>}>
      <span title={dateTime(t()!)}>
        {age(t()!, now())} ago <span class="faint">· {dateTime(t()!)}</span>
      </span>
    </Show>
  );
}

export function Labels(props: { labels?: Record<string, string> | null; limit?: number }) {
  const [all, setAll] = createSignal(false);
  const entries = () => Object.entries(props.labels ?? {});
  const shown = () => (all() ? entries() : entries().slice(0, props.limit ?? 50));
  return (
    <Show when={entries().length} fallback={<span class="faint">none</span>}>
      <div class="labels">
        <For each={shown()}>
          {([k, v]) => (
            <span class="label-chip" title={`${k}=${v}`}>
              <span class="k">{k}</span>
              <Show when={v !== ""}>
                <span class="v">{v}</span>
              </Show>
            </span>
          )}
        </For>
        <Show when={!all() && entries().length > shown().length}>
          <button class="btn sm ghost" onClick={() => setAll(true)}>
            +{entries().length - shown().length} more
          </button>
        </Show>
      </div>
    </Show>
  );
}

/** Condition types whose `True` is the healthy state. */
const POSITIVE_CONDITIONS = new Set([
  // Pod, Deployment, Job, HPA
  "Ready", "ContainersReady", "Initialized", "PodScheduled", "PodReadyToStartContainers", "Available", "Progressing",
  "Complete", "SuccessCriteriaMet", "AbleToScale", "ScalingActive",
  // CRD, APIService, Gateway API
  "Established", "NamesAccepted", "Accepted", "Programmed", "ResolvedRefs",
]);

/** Condition types whose `True` is a problem: node pressure and node-problem-detector problems, failures. */
const NEGATIVE_CONDITIONS = new Set([
  "MemoryPressure", "DiskPressure", "PIDPressure", "NetworkUnavailable", "KernelDeadlock", "ReadonlyFilesystem",
  "ReplicaFailure", "Failed", "FailureTarget", "DisruptionTarget", "NonStructuralSchema", "Degraded", "Stalled",
]);

/** Families of negative types: node-problem-detector (`FrequentKubeletRestart`, `CorruptDockerOverlay2`,
 * `KubeletProblem`…) and the namespace-deletion failures. */
const NEGATIVE_CONDITION_PATTERN = /^(Frequent|Corrupt)[A-Z]|[a-z](Pressure|Problem|Unhealthy|Failure)$/;

/**
 * Badge colour of a condition: green when it is in its healthy state, red when not, amber for `Unknown`, and
 * neutral for types whose polarity we don't know (a Job's `Suspended`, a PVC's `Resizing`, most CRDs') — guessing from the
 * wording inverted the signal for `ReplicaFailure`, `DisruptionTarget` or node-problem-detector conditions.
 */
export function conditionBadge(type: string | undefined, status: string | undefined): "ok" | "err" | "warn" | "" {
  if (status === "Unknown") return "warn";
  if (status !== "True" && status !== "False") return "";
  const t = type ?? "";
  // A PDB at its budget is normal for a single-replica app, but it is what blocks a drain: amber, as its row.
  if (t === "DisruptionAllowed") return status === "True" ? "ok" : "warn";
  const positive = POSITIVE_CONDITIONS.has(t);
  if (!positive && !NEGATIVE_CONDITIONS.has(t) && !NEGATIVE_CONDITION_PATTERN.test(t)) return "";
  return (status === "True") === positive ? "ok" : "err";
}

export function Conditions(props: { conditions?: K8sObject[] | null }) {
  return (
    <Show when={props.conditions?.length}>
      <Section title="Conditions">
        <table class="mini-table">
          <thead>
            <tr>
              <th>Type</th>
              <th>Status</th>
              <th>Reason</th>
              <th>Last transition</th>
            </tr>
          </thead>
          <tbody>
            <For each={props.conditions}>
              {(c) => {
                return (
                  <tr>
                    <td>{c.type}</td>
                    <td>
                      <span class={`badge ${conditionBadge(c.type, c.status)}`}>{c.status}</span>
                    </td>
                    <td class="msg" title={c.message}>
                      {c.reason ?? ""}
                      <Show when={c.message}>
                        <div class="faint" style={{ "font-size": "var(--fs-xs)", "margin-top": "2px" }}>
                          {c.message}
                        </div>
                      </Show>
                    </td>
                    <td class="faint" style={{ "white-space": "nowrap" }}>
                      {c.lastTransitionTime ? `${age(parseTime(c.lastTransitionTime)!, now())} ago` : ""}
                    </td>
                  </tr>
                );
              }}
            </For>
          </tbody>
        </table>
      </Section>
    </Show>
  );
}

export function CopyButton(props: { text: () => string; label?: string }) {
  return (
    <button
      class="btn sm ghost"
      onClick={async () => {
        await navigator.clipboard.writeText(props.text());
        toast("info", "Copied to clipboard");
      }}
    >
      <Icon name="copy" size={12} /> {props.label ?? "Copy"}
    </button>
  );
}

/** Builds a `k=v,k2=v2` label selector from `matchLabels`. */
export function selectorString(matchLabels?: Record<string, string> | null): string | undefined {
  const e = Object.entries(matchLabels ?? {});
  return e.length ? e.map(([k, v]) => `${k}=${v}`).join(",") : undefined;
}

/** A LabelSelector (`matchLabels` and `matchExpressions`) as the API's label selector string. */
export function labelSelector(sel?: { matchLabels?: Record<string, string> | null; matchExpressions?: { key: string; operator: string; values?: string[] | null }[] | null } | null): string | undefined {
  const parts = Object.entries(sel?.matchLabels ?? {}).map(([k, v]) => `${k}=${v}`);
  for (const e of sel?.matchExpressions ?? []) {
    const values = (e.values ?? []).join(",");
    if (e.operator === "In") parts.push(`${e.key} in (${values})`);
    else if (e.operator === "NotIn") parts.push(`${e.key} notin (${values})`);
    else if (e.operator === "Exists") parts.push(e.key);
    else if (e.operator === "DoesNotExist") parts.push(`!${e.key}`);
  }
  return parts.length ? parts.join(",") : undefined;
}
