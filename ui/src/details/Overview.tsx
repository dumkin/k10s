import { createEffect, createMemo, createSignal, For, Match, Show, Switch } from "solid-js";
import { Icon } from "../components/Icon";
import { errorMessage, Tone } from "../lib/backend";
import { age, bytes, cpu as fmtCpu, parseTime } from "../lib/format";
import { type DetailProps, deferReady } from "../registry/details";
import { discoveredResources } from "../state/clusters";
import { openInBrowser, startForward } from "../state/forwards";
import { reveal } from "../state/nav";
import { now } from "../state/ui";
import { createViewFeed } from "../state/view";
import { Conditions, CopyButton, type K8sObject, KV, Labels, Section, selectorString, TimeAgo, useObject } from "./common";
import { createRefLoader, EnvList, hasEnv, hasProbes, Probes, type RefLoader, RefLink, SchedulingSection, VolumesSection } from "./PodSpec";
import { UsageSection } from "./Usage";

function resourceKeyFor(apiVersion: string | undefined, kind: string): string | undefined {
  const group = apiVersion?.includes("/") ? apiVersion.split("/")[0] : "";
  for (const r of discoveredResources().values()) if (r.kind === kind && r.group === group) return r.key;
  return undefined;
}

export function Overview(props: DetailProps) {
  const obj = useObject(
    () => props.target,
    () => props.row.rv,
  );
  const o = () => obj.value();
  const kind = () => o()?.kind as string | undefined;
  // The panel keeps showing the previous object until this one is here (or could not be read).
  const ready = deferReady();
  createEffect(() => (o() || obj.error()) && ready());

  return (
    <Show when={o()} fallback={<Show when={obj.error()}>{(e) => <div class="section error-text">{errorMessage(e())}</div>}</Show>}>
      <Show when={kind() === "Pod" || kind() === "Node"}>
        <UsageSection row={props.row} kind={kind() === "Pod" ? "pods" : "nodes"} />
      </Show>
      <Switch>
        <Match when={kind() === "Pod"}>
          <PodSection o={o()!} cluster={props.row.cl} />
        </Match>
        <Match when={["Deployment", "StatefulSet", "DaemonSet", "ReplicaSet", "Job"].includes(kind() ?? "")}>
          <WorkloadSection o={o()!} cluster={props.row.cl} />
        </Match>
        <Match when={kind() === "Service"}>
          <ServiceSection o={o()!} cluster={props.row.cl} />
        </Match>
        <Match when={kind() === "Node"}>
          <NodeSection o={o()!} />
        </Match>
        <Match when={kind() === "ConfigMap" || kind() === "Secret"}>
          <DataSection o={o()!} secret={kind() === "Secret"} />
        </Match>
        <Match when={kind() === "Ingress"}>
          <IngressSection o={o()!} />
        </Match>
      </Switch>
      <Show when={kind() !== "Node"}>
        <Conditions conditions={o()?.status?.conditions} />
      </Show>
      <MetadataSection o={o()!} cluster={props.row.cl} />
    </Show>
  );
}

function MetadataSection(props: { o: K8sObject; cluster: string }) {
  const md = () => props.o.metadata ?? {};
  const [showAnn, setShowAnn] = createSignal(false);
  const annotations = () => Object.entries((md().annotations ?? {}) as Record<string, string>).filter(([k]) => k !== "kubectl.kubernetes.io/last-applied-configuration");
  return (
    <Section title="Metadata">
      <KV
        items={[
          ["Created", <TimeAgo time={md().creationTimestamp} />],
          ["Deleting since", md().deletionTimestamp ? <TimeAgo time={md().deletionTimestamp} /> : undefined],
          ["UID", <span class="mono">{md().uid}</span>],
          ["Resource version", <span class="mono">{md().resourceVersion}</span>],
          ["Generation", md().generation],
          [
            "Owners",
            md().ownerReferences?.length ? (
              <div class="row" style={{ "flex-wrap": "wrap" }}>
                <For each={md().ownerReferences as K8sObject[]}>
                  {(ref) => {
                    const key = resourceKeyFor(ref.apiVersion, ref.kind);
                    return (
                      <Show when={key} fallback={<span>{`${ref.kind}/${ref.name}`}</span>}>
                        <button class="link-btn" onClick={() => reveal({ cluster: props.cluster, resource: key!, namespace: md().namespace, name: ref.name })}>
                          {ref.kind}/{ref.name}
                        </button>
                      </Show>
                    );
                  }}
                </For>
              </div>
            ) : undefined,
          ],
          ["Finalizers", md().finalizers?.length ? <span class="mono">{(md().finalizers as string[]).join(", ")}</span> : undefined],
          ["Labels", <Labels labels={md().labels} />],
          [
            "Annotations",
            annotations().length ? (
              <Show
                when={showAnn()}
                fallback={
                  <button class="btn sm ghost" onClick={() => setShowAnn(true)}>
                    Show {annotations().length} annotation{annotations().length > 1 ? "s" : ""}
                  </button>
                }
              >
                <div class="cards">
                  <For each={annotations()}>
                    {([k, v]) => (
                      <div>
                        <div class="mono faint" style={{ "font-size": "10.5px" }}>
                          {k}
                        </div>
                        <div class="mono selectable" style={{ "word-break": "break-all", "white-space": "pre-wrap" }}>
                          {v}
                        </div>
                      </div>
                    )}
                  </For>
                </div>
              </Show>
            ) : undefined,
          ],
        ]}
      />
    </Section>
  );
}

// ---------------------------------------------------------------------------------------------
// Pods
// ---------------------------------------------------------------------------------------------

function containerState(st: K8sObject | undefined): { text: string; tone: Tone; detail?: string } {
  if (!st?.state) return { text: "Unknown", tone: Tone.Warn };
  const s = st.state;
  if (s.running) return { text: st.ready ? "Running" : "Running · not ready", tone: st.ready ? Tone.Ok : Tone.Warn, detail: s.running.startedAt ? `since ${s.running.startedAt}` : undefined };
  if (s.waiting) return { text: s.waiting.reason ?? "Waiting", tone: /BackOff|Err|Invalid/.test(s.waiting.reason ?? "") ? Tone.Error : Tone.Info, detail: s.waiting.message };
  if (s.terminated)
    return {
      text: `${s.terminated.reason ?? "Terminated"} (exit ${s.terminated.exitCode})`,
      tone: s.terminated.exitCode === 0 ? Tone.Muted : Tone.Error,
      detail: s.terminated.message,
    };
  return { text: "Unknown", tone: Tone.Warn };
}

const toneBadge = (t: Tone) => (t === Tone.Ok ? "ok" : t === Tone.Warn ? "warn" : t === Tone.Error ? "err" : t === Tone.Info ? "info" : "");

/** A port with a button that forwards a local port to it (⇧F opens the dialog with the options). */
function PortLink(props: { label: string; forward?: () => void }) {
  return (
    <span class="port">
      <span class="mono">{props.label}</span>
      <Show when={props.forward}>
        <button class="port-fwd" title="Forward a local port to it (⇧F: choose the local port)" onClick={() => props.forward!()}>
          <Icon name="link" size={11} />
        </button>
      </Show>
    </span>
  );
}

const isTcp = (p: K8sObject) => !p.protocol || p.protocol === "TCP";

function ContainerCard(props: { c: K8sObject; status?: K8sObject; init?: boolean; sidecar?: boolean; forward?: (port: number) => void; cluster: string; namespace: string; load: RefLoader; pod?: K8sObject }) {
  const st = () => containerState(props.status);
  const last = () => props.status?.lastState?.terminated;
  const res = () => props.c.resources ?? {};
  return (
    <div class="card">
      <div class="card-head">
        <Icon name={props.init && !props.sidecar ? "play" : "pod"} size={14} style={{ color: "var(--text-3)" }} />
        <span class="name">{props.c.name}</span>
        <Show when={props.init}>
          <span class="badge">{props.sidecar ? "sidecar" : "init"}</span>
        </Show>
        <Show when={props.status}>
          <span class={`badge ${toneBadge(st().tone)}`}>{st().text}</span>
        </Show>
        <span class="grow" />
        <Show when={(props.status?.restartCount ?? 0) > 0}>
          <span class="badge warn">{props.status!.restartCount} restarts</span>
        </Show>
      </div>
      <div class="card-head" style={{ "margin-top": "-4px" }}>
        <span class="image" title={props.c.image}>
          {props.c.image}
        </span>
      </div>
      <KV
        items={[
          ["State", st().detail],
          ["Last termination", last() ? `${last().reason ?? "Terminated"} (exit ${last().exitCode})${last().finishedAt ? ` · ${age(parseTime(last().finishedAt)!, now())} ago` : ""}` : undefined],
          [
            "Ports",
            props.c.ports?.length ? (
              <span class="ports">
                <For each={props.c.ports as K8sObject[]}>
                  {(p) => <PortLink label={`${p.name ? `${p.name}:` : ""}${p.containerPort}/${p.protocol ?? "TCP"}`} forward={props.forward && isTcp(p) ? () => props.forward!(p.containerPort) : undefined} />}
                </For>
              </span>
            ) : undefined,
          ],
          ["Requests", res().requests ? Object.entries(res().requests).map(([k, v]) => `${k} ${v}`).join(" · ") : undefined],
          ["Limits", res().limits ? Object.entries(res().limits).map(([k, v]) => `${k} ${v}`).join(" · ") : undefined],
          ["Command", props.c.command || props.c.args ? <span class="mono">{[...(props.c.command ?? []), ...(props.c.args ?? [])].join(" ")}</span> : undefined],
          ["Probes", hasProbes(props.c) ? <Probes c={props.c} /> : undefined],
          ["Env", hasEnv(props.c) ? <EnvList cluster={props.cluster} namespace={props.namespace} load={props.load} container={props.c} pod={props.pod} /> : undefined],
        ]}
      />
    </div>
  );
}

function PodSection(props: { o: K8sObject; cluster: string }) {
  const spec = () => props.o.spec ?? {};
  const status = () => props.o.status ?? {};
  const namespace = () => props.o.metadata?.namespace ?? "default";
  const load = createRefLoader(props.cluster, namespace());
  const statusOf = (name: string, init = false) => ((init ? status().initContainerStatuses : status().containerStatuses) as K8sObject[] | undefined)?.find((s) => s.name === name);
  const forward = (port: number) => void startForward({ cluster: props.cluster, namespace: namespace(), resource: "pods", name: props.o.metadata?.name, port }, openInBrowser());
  return (
    <>
      <Section title="Pod">
        <KV
          items={[
            ["Phase", status().phase],
            [
              "Node",
              spec().nodeName ? (
                <button class="link-btn" onClick={() => reveal({ cluster: props.cluster, resource: "nodes", name: spec().nodeName })}>
                  {spec().nodeName}
                </button>
              ) : (
                "not scheduled"
              ),
            ],
            ["Pod IP", status().podIP ? <span class="mono">{status().podIP}</span> : undefined],
            ["Host IP", status().hostIP ? <span class="mono">{status().hostIP}</span> : undefined],
            ["QoS class", status().qosClass],
            ["Service account", spec().serviceAccountName ? <RefLink cluster={props.cluster} resource="serviceaccounts" namespace={namespace()} name={spec().serviceAccountName} /> : undefined],
            ["Restart policy", spec().restartPolicy],
            ["Started", status().startTime ? <TimeAgo time={status().startTime} /> : undefined],
            ["Message", status().message],
          ]}
        />
      </Section>
      <Section title={`Containers · ${(spec().containers ?? []).length}`}>
        <div class="cards">
          <For each={spec().initContainers as K8sObject[] | undefined}>
            {(c) => <ContainerCard c={c} status={statusOf(c.name, true)} init sidecar={c.restartPolicy === "Always"} forward={forward} cluster={props.cluster} namespace={namespace()} load={load} pod={props.o} />}
          </For>
          <For each={spec().containers as K8sObject[] | undefined}>{(c) => <ContainerCard c={c} status={statusOf(c.name)} forward={forward} cluster={props.cluster} namespace={namespace()} load={load} pod={props.o} />}</For>
        </div>
      </Section>
      <VolumesSection spec={spec()} cluster={props.cluster} namespace={namespace()} />
      <SchedulingSection spec={spec()} />
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// Workloads
// ---------------------------------------------------------------------------------------------

export function RelatedPods(props: { cluster: string; namespace?: string; selector?: string }) {
  const feed = createViewFeed(() =>
    props.selector ? { resource: "pods", clusters: [props.cluster], namespaces: props.namespace ? [props.namespace] : [], labelSelector: props.selector } : null,
  );
  const rows = createMemo(() => [...feed.rows()].sort((a, b) => a.n.localeCompare(b.n)));
  return (
    <Section title={<>Pods · {rows().length}{feed.loading() && <span class="spinner" />}</>}>
      <Show when={rows().length} fallback={<span class="faint">{feed.loading() ? "Loading…" : "No pods match the selector"}</span>}>
        <table class="mini-table">
          <thead>
            <tr>
              <th />
              <th>Name</th>
              <th>Ready</th>
              <th>Status</th>
              <th>Restarts</th>
              <th>Node</th>
              <th>Age</th>
            </tr>
          </thead>
          <tbody>
            <For each={rows().slice(0, 200)}>
              {(r) => {
                const ready = r.c[0] as [number, number] | null;
                const st = r.c[1] as [string, Tone] | null;
                const restarts = r.c[2] as [number, number | null] | null;
                return (
                  <tr class="link" onClick={() => reveal({ cluster: r.cl, resource: "pods", namespace: r.ns, name: r.n })}>
                    <td>
                      <span class={`dot tone-${r.s}`} />
                    </td>
                    <td style={{ "font-weight": 500 }}>{r.n}</td>
                    <td>{ready ? `${ready[0]}/${ready[1]}` : ""}</td>
                    <td class={st && st[1] >= 2 ? `tone-${st[1]}` : ""}>{st?.[0]}</td>
                    <td>{restarts?.[0] ?? 0}</td>
                    <td class="faint">{(r.c[4] as string) ?? ""}</td>
                    <td class="faint">{age(r.t, now())}</td>
                  </tr>
                );
              }}
            </For>
          </tbody>
        </table>
      </Show>
    </Section>
  );
}

function WorkloadSection(props: { o: K8sObject; cluster: string }) {
  const spec = () => props.o.spec ?? {};
  const status = () => props.o.status ?? {};
  const kind = () => props.o.kind as string;
  const desired = () => (kind() === "DaemonSet" ? status().desiredNumberScheduled : kind() === "Job" ? spec().completions ?? 1 : spec().replicas ?? 1) ?? 0;
  const ready = () => (kind() === "DaemonSet" ? status().numberReady : kind() === "Job" ? status().succeeded : status().readyReplicas) ?? 0;
  const pct = () => (desired() ? Math.min(100, (ready() / desired()) * 100) : 0);
  const template = () => (spec().template?.spec ?? {}) as K8sObject;
  const containers = () => (template().containers ?? []) as K8sObject[];
  const namespace = () => props.o.metadata?.namespace ?? "default";
  const load = createRefLoader(props.cluster, namespace());
  return (
    <>
      <Section title={kind()}>
        <div class="row" style={{ "margin-bottom": "12px" }}>
          <span style={{ "font-size": "20px", "font-weight": 650, "font-variant-numeric": "tabular-nums" }}>
            {ready()}
            <span class="faint">/{desired()}</span>
          </span>
          <span class="muted">{kind() === "Job" ? "succeeded" : "ready"}</span>
          <div class="bar grow" style={{ "margin-left": "8px" }}>
            <span style={{ width: `${pct()}%`, background: ready() >= desired() ? "var(--ok)" : "var(--warn)" }} />
          </div>
        </div>
        <KV
          items={[
            ["Up-to-date", status().updatedReplicas ?? status().updatedNumberScheduled],
            ["Available", status().availableReplicas ?? status().numberAvailable],
            ["Strategy", spec().strategy?.type ?? spec().updateStrategy?.type],
            ["Selector", selectorString(spec().selector?.matchLabels) ? <span class="mono">{selectorString(spec().selector?.matchLabels)}</span> : undefined],
            ["Paused", spec().paused ? "yes" : undefined],
            ["Revision", props.o.metadata?.annotations?.["deployment.kubernetes.io/revision"]],
          ]}
        />
      </Section>
      <Show when={containers().length}>
        <Section title="Template">
          <div class="cards">
            <For each={template().initContainers as K8sObject[] | undefined}>
              {(c) => <ContainerCard c={c} init sidecar={c.restartPolicy === "Always"} cluster={props.cluster} namespace={namespace()} load={load} />}
            </For>
            <For each={containers()}>{(c) => <ContainerCard c={c} cluster={props.cluster} namespace={namespace()} load={load} />}</For>
          </div>
        </Section>
      </Show>
      <VolumesSection spec={template()} cluster={props.cluster} namespace={namespace()} />
      <SchedulingSection spec={template()} />
      <RelatedPods cluster={props.cluster} namespace={props.o.metadata?.namespace} selector={selectorString(spec().selector?.matchLabels)} />
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// Network / config / nodes
// ---------------------------------------------------------------------------------------------

function ServiceSection(props: { o: K8sObject; cluster: string }) {
  const spec = () => props.o.spec ?? {};
  const lb = () => ((props.o.status?.loadBalancer?.ingress ?? []) as K8sObject[]).map((i) => i.ip ?? i.hostname).join(", ");
  return (
    <>
      <Section title="Service">
        <KV
          items={[
            ["Type", spec().type],
            ["Cluster IP", <span class="mono">{(spec().clusterIPs ?? [spec().clusterIP]).join(", ")}</span>],
            ["External", lb() || (spec().externalIPs ?? []).join(", ") || spec().externalName],
            ["Session affinity", spec().sessionAffinity !== "None" ? spec().sessionAffinity : undefined],
            ["Selector", selectorString(spec().selector) ? <span class="mono">{selectorString(spec().selector)}</span> : undefined],
          ]}
        />
      </Section>
      <Show when={spec().ports?.length}>
        <Section title="Ports">
          <table class="mini-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Port</th>
                <th>Target</th>
                <th>Node port</th>
                <th>Protocol</th>
              </tr>
            </thead>
            <tbody>
              <For each={spec().ports as K8sObject[]}>
                {(p) => (
                  <tr>
                    <td>{p.name ?? ""}</td>
                    <td>
                      <PortLink
                        label={String(p.port)}
                        forward={isTcp(p) && spec().selector ? () => void startForward({ cluster: props.cluster, namespace: props.o.metadata?.namespace ?? "default", resource: "services", name: props.o.metadata?.name, port: p.port }, openInBrowser()) : undefined}
                      />
                    </td>
                    <td class="mono">{p.targetPort}</td>
                    <td class="mono">{p.nodePort ?? ""}</td>
                    <td>{p.protocol ?? "TCP"}</td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </Section>
      </Show>
      <Show when={selectorString(spec().selector)}>
        <RelatedPods cluster={props.cluster} namespace={props.o.metadata?.namespace} selector={selectorString(spec().selector)} />
      </Show>
    </>
  );
}

function IngressSection(props: { o: K8sObject }) {
  const rules = () =>
    ((props.o.spec?.rules ?? []) as K8sObject[]).flatMap((r) =>
      ((r.http?.paths ?? []) as K8sObject[]).map((p) => ({
        host: r.host ?? "*",
        path: p.path ?? "/",
        backend: p.backend?.service ? `${p.backend.service.name}:${p.backend.service.port?.number ?? p.backend.service.port?.name ?? ""}` : (p.backend?.resource?.name ?? ""),
      })),
    );
  return (
    <Section title="Rules">
      <table class="mini-table">
        <thead>
          <tr>
            <th>Host</th>
            <th>Path</th>
            <th>Backend</th>
          </tr>
        </thead>
        <tbody>
          <For each={rules()}>
            {(r) => (
              <tr>
                <td>{r.host}</td>
                <td class="mono">{r.path}</td>
                <td class="mono">{r.backend}</td>
              </tr>
            )}
          </For>
        </tbody>
      </table>
      <Show when={props.o.spec?.tls?.length}>
        <div style={{ "margin-top": "10px" }}>
          <KV items={[["TLS", ((props.o.spec.tls ?? []) as K8sObject[]).map((t) => `${(t.hosts ?? []).join(", ")} → ${t.secretName ?? ""}`).join("; ")]]} />
        </div>
      </Show>
    </Section>
  );
}

function NodeSection(props: { o: K8sObject }) {
  const st = () => props.o.status ?? {};
  const info = () => st().nodeInfo ?? {};
  const resources = () => Object.keys({ ...(st().capacity ?? {}), ...(st().allocatable ?? {}) }).filter((k) => !k.startsWith("hugepages"));
  const fmt = (k: string, v?: string) => {
    if (!v) return "";
    if (k === "cpu") return fmtCpu(v.endsWith("m") ? Number(v.slice(0, -1)) : Number(v) * 1000);
    if (k === "memory" || k.includes("storage")) {
      const n = Number(v.replace(/Ki$/, "")) * (v.endsWith("Ki") ? 1024 : 1);
      return Number.isFinite(n) ? bytes(n) : v;
    }
    return v;
  };
  return (
    <>
      <Conditions conditions={st().conditions} />
      <Section title="Resources">
        <table class="mini-table">
          <thead>
            <tr>
              <th>Resource</th>
              <th>Capacity</th>
              <th>Allocatable</th>
            </tr>
          </thead>
          <tbody>
            <For each={resources()}>
              {(k) => (
                <tr>
                  <td>{k}</td>
                  <td class="mono">{fmt(k, st().capacity?.[k])}</td>
                  <td class="mono">{fmt(k, st().allocatable?.[k])}</td>
                </tr>
              )}
            </For>
          </tbody>
        </table>
      </Section>
      <Section title="System">
        <KV
          items={[
            ["Addresses", ((st().addresses ?? []) as K8sObject[]).map((a) => `${a.type}: ${a.address}`).join(" · ")],
            ["Kubelet", info().kubeletVersion],
            ["OS image", info().osImage],
            ["Kernel", info().kernelVersion],
            ["Runtime", info().containerRuntimeVersion],
            ["Architecture", info().architecture],
            ["Pod CIDR", props.o.spec?.podCIDR],
            ["Taints", props.o.spec?.taints?.length ? (props.o.spec.taints as K8sObject[]).map((t) => `${t.key}${t.value ? `=${t.value}` : ""}:${t.effect}`).join(", ") : "none"],
          ]}
        />
      </Section>
    </>
  );
}

function DataSection(props: { o: K8sObject; secret: boolean }) {
  const [revealed, setRevealed] = createSignal<ReadonlySet<string>>(new Set());
  const data = () => Object.entries({ ...(props.o.data ?? {}), ...(props.o.binaryData ?? {}) }) as [string, string][];
  const decode = (v: string) => {
    try {
      return new TextDecoder().decode(Uint8Array.from(atob(v), (c) => c.charCodeAt(0)));
    } catch {
      return v;
    }
  };
  const value = (k: string, v: string) => (props.secret ? (revealed().has(k) ? decode(v) : "•".repeat(Math.min(24, Math.max(8, Math.round((v.length * 3) / 4))))) : v);
  return (
    <Section title={`Data · ${data().length}`}>
      <Show when={props.secret && props.o.type}>
        <div style={{ "margin-bottom": "10px" }}>
          <KV items={[["Type", props.o.type]]} />
        </div>
      </Show>
      <div class="cards">
        <For each={data()} fallback={<span class="faint">empty</span>}>
          {([k, v]) => (
            <div class="card">
              <div class="card-head">
                <span class="name mono">{k}</span>
                <span class="faint" style={{ "font-size": "var(--fs-xs)" }}>
                  {props.secret ? `${Math.round((v.length * 3) / 4)} bytes` : `${v.length} chars`}
                </span>
                <span class="grow" />
                <Show when={props.secret}>
                  <button
                    class="btn sm ghost"
                    onClick={() => {
                      const next = new Set(revealed());
                      if (next.has(k)) next.delete(k);
                      else next.add(k);
                      setRevealed(next);
                    }}
                  >
                    <Icon name={revealed().has(k) ? "eye-off" : "eye"} size={12} /> {revealed().has(k) ? "Hide" : "Reveal"}
                  </button>
                </Show>
                <CopyButton text={() => (props.secret ? decode(v) : v)} />
              </div>
              <pre class="mono selectable" style={{ margin: 0, "white-space": "pre-wrap", "word-break": "break-all", "max-height": "260px", overflow: "auto" }}>
                {value(k, v)}
              </pre>
            </div>
          )}
        </For>
      </div>
    </Section>
  );
}
