import { createMemo, createResource, createSignal, For, type JSX, Show } from "solid-js";
import { Icon } from "../components/Icon";
import { backend, errorMessage, toError } from "../lib/backend";
import {
  type AffinityRule,
  affinityOf,
  type EnvFrom,
  type EnvVar,
  envOf,
  expandVars,
  fieldValue,
  isDefaultToleration,
  isEnvName,
  lifecycleOf,
  probesOf,
  resourceFieldValue,
  spreadText,
  tolerationText,
} from "../lib/podspec";
import { reveal } from "../state/nav";
import { copyText } from "../state/ui";
import { type K8sObject, KV, Labels, Section } from "./common";

// What a pod spec says, readably: a container's probes and environment (values from ConfigMaps and Secrets filled in,
// Secrets only once asked for), its volumes and where they are mounted, and what decides where the pod may run.

/**
 * ConfigMaps and Secrets the environment and volumes of one object refer to: each read once while its details show.
 * A Secret is read only when one of its values is to be shown.
 */
export type RefLoader = (resource: "configmaps" | "secrets", name: string) => Promise<K8sObject>;

export function createRefLoader(cluster: string, namespace: string): RefLoader {
  const cache = new Map<string, Promise<K8sObject>>();
  return (resource, name) => {
    const key = `${resource}/${name}`;
    let p = cache.get(key);
    if (!p) cache.set(key, (p = backend().getObject({ cluster, resource, namespace, name }) as Promise<K8sObject>));
    return p;
  };
}

const decode = (v: string) => {
  try {
    return new TextDecoder().decode(Uint8Array.from(atob(v), (c) => c.charCodeAt(0)));
  } catch {
    return v;
  }
};

/** A link to an object the spec names; it opens in the table with its details. */
export function RefLink(props: { cluster: string; resource: string; namespace?: string | null; name: string; label?: string; title?: string }) {
  return (
    <button class="link-btn ref-link" title={props.title ?? `Open ${props.label ?? props.name}`} onClick={() => reveal({ cluster: props.cluster, resource: props.resource, namespace: props.namespace, name: props.name })}>
      {props.label ?? props.name}
    </button>
  );
}

// ---------------------------------------------------------------------------------------------
// Probes
// ---------------------------------------------------------------------------------------------

export function Probes(props: { c: K8sObject }) {
  const probes = createMemo(() => probesOf(props.c));
  const hooks = createMemo(() => lifecycleOf(props.c));
  return (
    <div class="probes">
      <For each={probes()}>
        {(p) => (
          <div class="probe" title={p.detail}>
            <span class={`probe-kind ${p.kind}`}>{p.kind}</span>
            <span class="mono probe-check">{p.check}</span>
            <span class="faint probe-timing">{p.timing}</span>
          </div>
        )}
      </For>
      <For each={hooks()}>
        {(h) => (
          <div class="probe" title={h}>
            <span class="probe-kind hook">{h.slice(0, h.indexOf(":"))}</span>
            <span class="mono probe-check">{h.slice(h.indexOf(":") + 2)}</span>
          </div>
        )}
      </For>
    </div>
  );
}

/** Whether a container has probes or hooks to show. */
export const hasProbes = (c: K8sObject) => probesOf(c).length > 0 || lifecycleOf(c).length > 0;

// ---------------------------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------------------------

/** How many variables show before "Show all". */
const ENV_SHOWN = 8;

type Loaded = { ok: true; obj: K8sObject } | { ok: false; error: unknown };

/** One referenced ConfigMap or Secret, read when asked (`when`). */
function useRef(load: RefLoader, resource: () => "configmaps" | "secrets", name: () => string, when: () => boolean) {
  const [res] = createResource(
    () => (when() ? { resource: resource(), name: name() } : false),
    ({ resource, name }) => load(resource, name).then((obj): Loaded => ({ ok: true, obj }), (error): Loaded => ({ ok: false, error })),
  );
  return res;
}

/** Why a referenced object gave no value: not there (optional or not), no access, or another error. */
function Missing(props: { error: unknown; optional: boolean; what: string }) {
  const e = () => toError(props.error);
  return (
    <Show
      when={e().code === 404}
      fallback={
        <span class="faint" title={errorMessage(props.error)}>
          {e().code === 403 ? "no access" : "could not read"}
        </span>
      }
    >
      <Show when={props.optional} fallback={<span class="env-missing">{props.what} not found</span>}>
        <span class="faint">not set ({props.what} not found, optional)</span>
      </Show>
    </Show>
  );
}

interface EnvCtx {
  cluster: string;
  namespace: string;
  load: RefLoader;
  /** The pod whose values `fieldRef`s give; none for a workload's template. */
  pod?: K8sObject;
  container: K8sObject;
}

/** A value, one line, the whole of it on hover; a secret one hidden until revealed. */
function Value(props: { text: string; raw?: string }) {
  const expanded = () => props.raw !== undefined && props.raw !== props.text;
  return (
    <span class="env-value mono" title={expanded() ? `${props.text}\n\nas written: ${props.raw}` : props.text}>
      {props.text === "" ? <span class="faint">""</span> : props.text}
      <Show when={expanded()}>
        <span class="env-expanded" title={`as written: ${props.raw}`}>
          $()
        </span>
      </Show>
    </span>
  );
}

function SecretValue(props: { ctx: EnvCtx; name: string; key: string; optional: boolean }) {
  const [shown, setShown] = createSignal(false);
  const res = useRef(props.ctx.load, () => "secrets", () => props.name, shown);
  const value = () => {
    const r = res();
    if (!r?.ok) return undefined;
    const v = (r.obj.data ?? {})[props.key];
    return v === undefined ? null : decode(v);
  };
  return (
    <span class="env-secret">
      <Show when={shown() && res()} fallback={<span class="env-dots">••••••••</span>}>
        {(r) => (
          <Show when={r().ok} fallback={<Missing error={(r() as { error: unknown }).error} optional={props.optional} what={`secret ${props.name}`} />}>
            <Show when={value() !== null} fallback={<span class={props.optional ? "faint" : "env-missing"}>key {props.key} not in the secret</span>}>
              <Value text={value()!} />
            </Show>
          </Show>
        )}
      </Show>
      <button class="env-eye" title={shown() ? "Hide" : "Show the value (reads the Secret)"} onClick={() => setShown(!shown())}>
        <Icon name={shown() ? "eye-off" : "eye"} size={12} />
      </button>
    </span>
  );
}

function ConfigMapValue(props: { ctx: EnvCtx; name: string; key: string; optional: boolean }) {
  const res = useRef(props.ctx.load, () => "configmaps", () => props.name, () => true);
  return (
    <Show when={res()} fallback={<span class="faint">…</span>}>
      {(r) => (
        <Show when={r().ok} fallback={<Missing error={(r() as { error: unknown }).error} optional={props.optional} what={`configmap ${props.name}`} />}>
          {(() => {
            const obj = (r() as { obj: K8sObject }).obj;
            const v = obj.data?.[props.key] ?? (obj.binaryData?.[props.key] !== undefined ? "<binary>" : undefined);
            return (
              <Show when={v !== undefined} fallback={<span class={props.optional ? "faint" : "env-missing"}>key {props.key} not in the configmap</span>}>
                <Value text={v!} />
              </Show>
            );
          })()}
        </Show>
      )}
    </Show>
  );
}

function Source(props: { ctx: EnvCtx; v: EnvVar }) {
  const s = () => props.v.source;
  return (
    <Show when={s().kind !== "value"}>
      {(() => {
        const src = s();
        if (src.kind === "configMap" || src.kind === "secret")
          return (
            <span class="env-src">
              <Icon name={src.kind === "secret" ? "secret" : "config"} size={11} />
              <RefLink cluster={props.ctx.cluster} resource={src.kind === "secret" ? "secrets" : "configmaps"} namespace={props.ctx.namespace} name={src.name} />
              <span class="faint">· {src.key}</span>
            </span>
          );
        if (src.kind === "field")
          return (
            <span class="env-src faint" title="From the pod itself (downward API)">
              <Icon name="pod" size={11} />
              {src.path}
            </span>
          );
        if (src.kind === "resource")
          return (
            <span class="env-src faint" title={`The container's ${src.resource}${src.divisor ? `, in units of ${src.divisor}` : ""}`}>
              <Icon name="gauge" size={11} />
              {src.resource}
              {src.divisor ? ` / ${src.divisor}` : ""}
            </span>
          );
        return null;
      })()}
    </Show>
  );
}

/** Values of plain variables with `$(VAR)` references expanded (from those defined before them, as Kubernetes does). */
function plainValues(vars: EnvVar[], ctx: EnvCtx): Map<string, string> {
  const known = new Map<string, string>();
  const out = new Map<string, string>();
  for (const v of vars) {
    let value: string | undefined;
    if (v.source.kind === "value") value = expandVars(v.value ?? "", (n) => known.get(n));
    else if (v.source.kind === "field" && ctx.pod) value = fieldValue(ctx.pod, v.source.path);
    else if (v.source.kind === "resource") value = resourceFieldValue(findContainer(ctx, v.source.container), v.source.resource, v.source.divisor);
    if (value !== undefined) {
      known.set(v.name, value);
      out.set(v.name, value);
    } else known.delete(v.name);
  }
  return out;
}

function findContainer(ctx: EnvCtx, name: string | undefined): K8sObject {
  if (!name || name === ctx.container.name) return ctx.container;
  const spec = ctx.pod?.spec;
  return ((spec?.containers ?? []) as K8sObject[]).find((c) => c.name === name) ?? ctx.container;
}

function VarRow(props: { ctx: EnvCtx; v: EnvVar; values: Map<string, string> }) {
  const src = () => props.v.source;
  return (
    <div class="env-row">
      <span class="env-name mono" title={props.v.name}>
        {props.v.name}
      </span>
      <span class="env-val">
        {(() => {
          const s = src();
          if (s.kind === "value") return <Value text={props.values.get(props.v.name) ?? props.v.value ?? ""} raw={props.v.value} />;
          if (s.kind === "configMap") return <ConfigMapValue ctx={props.ctx} name={s.name} key={s.key} optional={s.optional} />;
          if (s.kind === "secret") return <SecretValue ctx={props.ctx} name={s.name} key={s.key} optional={s.optional} />;
          const v = props.values.get(props.v.name);
          if (v !== undefined) return <Value text={v} />;
          if (s.kind === "resource") return <span class="faint">{s.resource.startsWith("limits.") ? "the node's allocatable (no limit set)" : "not set"}</span>;
          return <span class="faint">{props.ctx.pod ? "not set" : "set in each pod"}</span>;
        })()}
      </span>
      <Source ctx={props.ctx} v={props.v} />
    </div>
  );
}

/** An `envFrom` source: its keys as the variables they become, those `env` overrides struck through. */
function FromGroup(props: { ctx: EnvCtx; from: EnvFrom; overridden: Set<string> }) {
  const secret = () => props.from.kind === "secret";
  const [shown, setShown] = createSignal(false);
  const res = useRef(props.ctx.load, () => (secret() ? "secrets" : "configmaps"), () => props.from.name, () => !secret() || shown());
  const keys = createMemo(() => {
    const r = res();
    if (!r?.ok) return [];
    return Object.keys({ ...(r.obj.data ?? {}), ...(r.obj.binaryData ?? {}) });
  });
  const value = (k: string) => {
    const r = res();
    if (!r?.ok) return "";
    const v = r.obj.data?.[k];
    return v === undefined ? "<binary>" : secret() ? decode(v) : v;
  };
  return (
    <div class="env-from">
      <div class="env-from-head">
        <Icon name={secret() ? "secret" : "config"} size={11} />
        <span class="faint">all keys of</span>
        <RefLink cluster={props.ctx.cluster} resource={secret() ? "secrets" : "configmaps"} namespace={props.ctx.namespace} name={props.from.name} />
        <Show when={props.from.prefix}>
          <span class="faint">
            as <span class="mono">{props.from.prefix}…</span>
          </span>
        </Show>
        <Show when={props.from.optional}>
          <span class="faint">(optional)</span>
        </Show>
        <span class="grow" />
        <Show when={secret()}>
          <button class="env-eye" title={shown() ? "Hide" : "Show the keys and values (reads the Secret)"} onClick={() => setShown(!shown())}>
            <Icon name={shown() ? "eye-off" : "eye"} size={12} />
          </button>
        </Show>
      </div>
      <Show when={res()} fallback={<Show when={!secret()}>{<span class="faint env-pad">…</span>}</Show>}>
        {(r) => (
          <Show when={r().ok} fallback={<span class="env-pad"><Missing error={(r() as { error: unknown }).error} optional={props.from.optional} what={`${secret() ? "secret" : "configmap"} ${props.from.name}`} /></span>}>
            <For each={keys()} fallback={<span class="faint env-pad">no keys</span>}>
              {(k) => {
                const name = `${props.from.prefix}${k}`;
                const valid = isEnvName(name);
                return (
                  <div class="env-row" classList={{ overridden: props.overridden.has(name) || !valid }}>
                    <span class="env-name mono" title={!valid ? `${name}: not a valid variable name, skipped` : props.overridden.has(name) ? `${name}: set by env below, which wins` : name}>
                      {name}
                    </span>
                    <span class="env-val">
                      <Value text={value(k)} />
                    </span>
                    <span class="env-src faint">{!valid ? "skipped" : props.overridden.has(name) ? "overridden" : ""}</span>
                  </div>
                );
              }}
            </For>
          </Show>
        )}
      </Show>
    </div>
  );
}

/**
 * A container's environment: each variable with its value — expanded `$(VAR)` references, ConfigMap keys, the pod's
 * own fields, its resources — and where it comes from (links to the ConfigMap or Secret). Secret values stay hidden
 * until revealed one by one; `envFrom` sources list the variables they give.
 */
export function EnvList(props: { cluster: string; namespace: string; load: RefLoader; container: K8sObject; pod?: K8sObject }) {
  const env = createMemo(() => envOf(props.container));
  const ctx = (): EnvCtx => ({ cluster: props.cluster, namespace: props.namespace, load: props.load, pod: props.pod, container: props.container });
  const values = createMemo(() => plainValues(env().vars, ctx()));
  const [all, setAll] = createSignal(false);
  const shown = () => (all() ? env().vars : env().vars.slice(0, ENV_SHOWN));
  const overridden = createMemo(() => new Set(env().vars.map((v) => v.name)));
  const copy = () => {
    const text = env()
      .vars.map((v) => `${v.name}=${values().get(v.name) ?? (v.source.kind === "value" ? v.value : `<${v.source.kind === "configMap" || v.source.kind === "secret" ? `${v.source.kind} ${v.source.name}/${v.source.key}` : v.source.kind}>`)}`)
      .join("\n");
    return copyText(text, "Copied to clipboard", "Secret values are left out.");
  };
  return (
    <div class="env">
      <For each={shown()}>{(v) => <VarRow ctx={ctx()} v={v} values={values()} />}</For>
      <div class="env-tools">
        <Show when={!all() && env().vars.length > ENV_SHOWN}>
          <button class="btn sm ghost" onClick={() => setAll(true)}>
            Show {env().vars.length - ENV_SHOWN} more
          </button>
        </Show>
        <Show when={env().vars.length}>
          <button class="btn sm ghost" onClick={() => void copy()} title="Copy as NAME=value lines (secret values left out)">
            <Icon name="copy" size={11} /> Copy
          </button>
        </Show>
      </div>
      <For each={env().from}>{(f) => <FromGroup ctx={ctx()} from={f} overridden={overridden()} />}</For>
    </div>
  );
}

export const hasEnv = (c: K8sObject) => (c.env?.length ?? 0) > 0 || (c.envFrom?.length ?? 0) > 0;

// ---------------------------------------------------------------------------------------------
// Volumes
// ---------------------------------------------------------------------------------------------

/** What a volume is and what it points at: a link for ConfigMaps, Secrets and claims. */
function VolumeSource(props: { v: K8sObject; cluster: string; namespace: string }) {
  const link = (resource: string, name: string | undefined, icon: "config" | "secret" | "volume") =>
    name ? (
      <span class="env-src">
        <Icon name={icon} size={11} />
        <RefLink cluster={props.cluster} resource={resource} namespace={props.namespace} name={name} />
      </span>
    ) : null;
  const v = props.v;
  if (v.configMap) return link("configmaps", v.configMap.name, "config");
  if (v.secret) return link("secrets", v.secret.secretName, "secret");
  if (v.persistentVolumeClaim) return link("persistentvolumeclaims", v.persistentVolumeClaim.claimName, "volume");
  if (v.projected) {
    const sources = (v.projected.sources ?? []) as K8sObject[];
    return (
      <span class="vol-sources">
        <For each={sources}>
          {(s) =>
            s.configMap ? (
              link("configmaps", s.configMap.name, "config")
            ) : s.secret ? (
              link("secrets", s.secret.name, "secret")
            ) : (
              <span class="faint">{s.serviceAccountToken ? "token" : s.downwardAPI ? "pod fields" : s.clusterTrustBundle ? "trust bundle" : Object.keys(s)[0]}</span>
            )
          }
        </For>
      </span>
    );
  }
  if (v.emptyDir) return <span class="faint">{[v.emptyDir.medium === "Memory" ? "in memory" : "", v.emptyDir.sizeLimit ? `≤ ${v.emptyDir.sizeLimit}` : ""].filter(Boolean).join(", ") || "empty"}</span>;
  if (v.hostPath) return <span class="mono">{v.hostPath.path}</span>;
  if (v.ephemeral) return <span class="faint">a claim per pod{v.ephemeral.volumeClaimTemplate?.spec?.storageClassName ? ` (${v.ephemeral.volumeClaimTemplate.spec.storageClassName})` : ""}</span>;
  if (v.csi) return <span class="mono">{v.csi.driver}</span>;
  if (v.nfs) return <span class="mono">{`${v.nfs.server}:${v.nfs.path}`}</span>;
  return null;
}

/** A pod's (or template's) volumes, with where each container mounts them. */
export function VolumesSection(props: { spec: K8sObject; cluster: string; namespace: string }) {
  const volumes = () => (props.spec.volumes ?? []) as K8sObject[];
  const mounts = createMemo(() => {
    const out = new Map<string, string[]>();
    const containers = [...((props.spec.initContainers ?? []) as K8sObject[]), ...((props.spec.containers ?? []) as K8sObject[])];
    for (const c of containers)
      for (const m of (c.volumeMounts ?? []) as K8sObject[]) {
        const list = out.get(m.name) ?? [];
        list.push(`${containers.length > 1 ? `${c.name}: ` : ""}${m.mountPath}${m.subPath ? ` (${m.subPath})` : ""}${m.readOnly ? " ro" : ""}`);
        out.set(m.name, list);
      }
    return out;
  });
  return (
    <Show when={volumes().length}>
      <Section title={`Volumes · ${volumes().length}`}>
        <table class="mini-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Type</th>
              <th>Source</th>
              <th>Mounted at</th>
            </tr>
          </thead>
          <tbody>
            <For each={volumes()}>
              {(v) => (
                <tr>
                  <td>{v.name}</td>
                  <td class="faint">{Object.keys(v).find((k) => k !== "name") ?? ""}</td>
                  <td>
                    <VolumeSource v={v} cluster={props.cluster} namespace={props.namespace} />
                  </td>
                  <td class="mono vol-mounts">
                    <For each={mounts().get(v.name) ?? []} fallback={<span class="faint">not mounted</span>}>
                      {(m) => <div>{m}</div>}
                    </For>
                  </td>
                </tr>
              )}
            </For>
          </tbody>
        </table>
      </Section>
    </Show>
  );
}

// ---------------------------------------------------------------------------------------------
// Scheduling
// ---------------------------------------------------------------------------------------------

function Rules(props: { rules: AffinityRule[] }) {
  return (
    <div class="rules">
      <For each={props.rules}>
        {(r) => (
          <div class="rule">
            <span
              class={`rule-kind ${r.required ? "required" : ""}`}
              title={r.required ? "Must hold for the pod to be scheduled" : r.label ? "Followed when it can be: the pod is scheduled anyway" : `Preferred, with weight ${r.weight ?? 1} of 100`}
            >
              {r.required ? "required" : (r.label ?? `prefer ${r.weight ?? 1}`)}
            </span>
            <span class="mono rule-text">{r.text}</span>
          </div>
        )}
      </For>
    </div>
  );
}

/**
 * What decides where the pod runs: node selector, node and pod (anti-)affinity, topology spread, tolerations — the
 * defaults every pod gets folded away — priority, and host namespaces it shares.
 */
export function SchedulingSection(props: { spec: K8sObject; title?: string }) {
  const spec = () => props.spec ?? {};
  const affinity = createMemo(() => affinityOf(spec()));
  const tolerations = () => (spec().tolerations ?? []) as K8sObject[];
  const own = createMemo(() => tolerations().filter((t) => !isDefaultToleration(t)));
  const defaults = createMemo(() => tolerations().filter(isDefaultToleration));
  const spread = () => (spec().topologySpreadConstraints ?? []) as K8sObject[];
  const host = () => [spec().hostNetwork && "network", spec().hostPID && "processes", spec().hostIPC && "IPC"].filter(Boolean) as string[];
  const items = (): [string, JSX.Element | string | number | null | undefined][] => [
    ["Node selector", Object.keys(spec().nodeSelector ?? {}).length ? <Labels labels={spec().nodeSelector} /> : undefined],
    ["Node affinity", affinity().node.length ? <Rules rules={affinity().node} /> : undefined],
    ["Pod affinity", affinity().pod.length ? <Rules rules={affinity().pod} /> : undefined],
    ["Anti-affinity", affinity().antiPod.length ? <Rules rules={affinity().antiPod} /> : undefined],
    [
      "Spread",
      spread().length ? (
        <Rules rules={spread().map((c) => ({ required: c.whenUnsatisfiable !== "ScheduleAnyway", label: "best effort", text: spreadText(c) }))} />
      ) : undefined,
    ],
    [
      "Tolerations",
      tolerations().length ? (
        <span class="tolerations">
          <For each={own()}>{(t) => <span class="label-chip"><span class="v">{tolerationText(t)}</span></span>}</For>
          <Show when={defaults().length}>
            <span class="faint" title={defaults().map(tolerationText).join("\n")}>
              {own().length ? "+ " : ""}
              {defaults().length} default{defaults().length > 1 ? "s" : ""} (not-ready, unreachable nodes: 300s)
            </span>
          </Show>
        </span>
      ) : undefined,
    ],
    ["Priority", spec().priorityClassName ? `${spec().priorityClassName}${spec().priority !== undefined ? ` (${spec().priority})` : ""}${spec().preemptionPolicy === "Never" ? " · never preempts" : ""}` : undefined],
    ["Scheduler", spec().schedulerName && spec().schedulerName !== "default-scheduler" ? spec().schedulerName : undefined],
    ["Runtime class", spec().runtimeClassName],
    ["Shares the host's", host().length ? <span class="badge warn">{host().join(", ")}</span> : undefined],
  ];
  const any = () => items().some(([, v]) => v !== undefined && v !== null && v !== "");
  return (
    <Show when={any()}>
      <Section title={props.title ?? "Scheduling"}>
        <KV items={items()} />
      </Section>
    </Show>
  );
}
