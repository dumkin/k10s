import { createEffect, createMemo, createSignal, For, Show } from "solid-js";
import { Icon } from "../components/Icon";
import type { DetailProps } from "../registry/details";
import { isMultiCluster, selectedClusters, shortName } from "../state/clusters";
import { openLogs } from "../state/dock";
import { detailsHaveKeyboard, focusInDock } from "../state/keyboard";
import { createViewFeed } from "../state/view";
import { type K8sObject, labelSelector, selectorString, useObject } from "./common";
import { podDone } from "./logBuffer";
import { LogViewer, type StreamPod } from "./logs/LogViewer";

const ALL = "__all__";

type FeedRow = { cl: string; ns?: string | null; n: string; u: string; t: number; x?: boolean; c: unknown[] };

/** The pods of a pods feed's rows, with their own containers (they may differ from the template's during a rollout). */
export function podsOf(rows: readonly FeedRow[], columns: readonly { id: string }[]): StreamPod[] {
  const at = (id: string) => columns.findIndex((c) => c.id === id);
  const [statusAt, containersAt, restartsAt] = [at("status"), at("containers"), at("restarts")];
  return rows.map((r) => {
    const st = statusAt >= 0 ? r.c[statusAt] : null;
    const cs = containersAt >= 0 ? r.c[containersAt] : null;
    // `[count, last restart]`
    const rs = restartsAt >= 0 ? r.c[restartsAt] : null;
    return {
      cluster: r.cl,
      namespace: r.ns ?? "",
      name: r.n,
      uid: r.u,
      created: r.t,
      done: podDone(Array.isArray(st) && typeof st[0] === "string" ? st[0] : undefined, r.x),
      containers: typeof cs === "string" && cs ? cs.split(",") : undefined,
      restarts: Array.isArray(rs) && typeof rs[0] === "number" ? rs[0] : undefined,
    };
  });
}

/** Pods are told apart by uid: one re-created under the same name (a StatefulSet's) is another pod. */
export const samePods = (a: StreamPod[], b: StreamPod[]) =>
  a.length === b.length &&
  a.every((p, i) => p.uid === b[i].uid && p.cluster === b[i].cluster && p.name === b[i].name && p.done === b[i].done && p.restarts === b[i].restarts && p.containers?.join() === b[i].containers?.join());

export function LogsTab(props: DetailProps) {
  const isPod = () => props.resourceKey === "pods";
  const obj = useObject(
    () => props.target,
    () => props.row.rv,
  );
  const podSpec = createMemo<K8sObject | undefined>(() => {
    const o = obj.value();
    if (!o) return undefined;
    return isPod() ? o.spec : (o.spec?.template?.spec ?? o.spec?.jobTemplate?.spec?.template?.spec);
  });
  const mainContainers = createMemo(() => ((podSpec()?.containers ?? []) as K8sObject[]).map((c) => c.name as string), [], { equals: (a, b) => a.join() === b.join() });
  const initContainers = createMemo(() => ((podSpec()?.initContainers ?? []) as K8sObject[]).map((c) => c.name as string), [], { equals: (a, b) => a.join() === b.join() });

  const [container, setContainer] = createSignal<string | null>(null);
  // Default: kubectl's default-container annotation, else the first container. Without a pod template (a service):
  // every pod's own containers.
  createEffect(() => {
    if (container() !== null) return;
    if (!mainContainers().length) {
      if (obj.value() && !podSpec()) setContainer(ALL);
      return;
    }
    const preferred = obj.value()?.metadata?.annotations?.["kubectl.kubernetes.io/default-container"];
    setContainer(mainContainers().length === 1 ? mainContainers()[0] : mainContainers().includes(preferred) ? preferred : ALL);
  });
  const [allClusters, setAllClusters] = createSignal(false);

  // Workloads: stream every pod matching the selector (optionally in all selected clusters).
  const selector = createMemo(() => {
    if (isPod()) return undefined;
    const spec = obj.value()?.spec;
    // A service selects by a plain map; workloads by a LabelSelector.
    return props.resourceKey === "services" ? selectorString(spec?.selector) : labelSelector(spec?.selector ?? spec?.jobTemplate?.spec?.selector);
  });
  const clusters = () => (allClusters() ? selectedClusters() : [props.row.cl]);
  const pods = createViewFeed(() => (!isPod() && selector() ? { resource: "pods", clusters: clusters(), namespaces: props.row.ns ? [props.row.ns] : [], labelSelector: selector() } : null));
  const podList = createMemo<StreamPod[]>(
    () => {
      if (isPod()) {
        const st = obj.value()?.status;
        const restarts = st ? ([...(st.containerStatuses ?? []), ...(st.initContainerStatuses ?? [])] as K8sObject[]).reduce((n, c) => n + (Number(c.restartCount) || 0), 0) : undefined;
        return [{ cluster: props.row.cl, namespace: props.row.ns ?? "", name: props.row.n, uid: props.row.u, created: props.row.t, restarts }];
      }
      return podsOf(pods.rows(), pods.columns());
    },
    [],
    { equals: samePods },
  );

  // "All containers": each pod's own, else the template's.
  const containersOf = (p: StreamPod) => {
    const c = container();
    return c !== ALL && c !== null ? [c] : p.containers?.length ? p.containers : mainContainers();
  };
  const restart = createMemo(() => (container() === null ? null : `${container()}\n${clusters().join("\n")}`));
  const where = () => `${props.row.ns ? `${props.row.ns}/` : ""}${props.row.n}`;

  return (
    <LogViewer
      pods={podList}
      containersOf={containersOf}
      restart={restart}
      single={isPod}
      clusters={() => isMultiCluster() && allClusters()}
      label={() => `${props.row.cl}: ${props.resourceKey} ${where()}`}
      saveName={() => `${props.row.n}-${shortName(props.row.cl)}`}
      hasKeyboard={() => detailsHaveKeyboard() && !focusInDock()}
      controls={
        <>
          <Show when={mainContainers().length + initContainers().length > 1}>
            <select class="input" value={container() ?? ""} onChange={(e) => setContainer(e.currentTarget.value)} title="Container">
              <option value={ALL}>All containers</option>
              <For each={mainContainers()}>{(c) => <option value={c}>{c}</option>}</For>
              <For each={initContainers()}>{(c) => <option value={c}>init: {c}</option>}</For>
            </select>
          </Show>
          <Show when={!isPod() && isMultiCluster()}>
            <button class="btn sm ghost" classList={{ on: allClusters() }} onClick={() => setAllClusters(!allClusters())} title="Stream the same workload from every selected cluster">
              <Icon name="layers" size={12} />
              <span class="lbl-wide">All clusters</span>
            </button>
          </Show>
        </>
      }
      menu={() => [
        {
          label: "Open in the dock",
          icon: "dock",
          title: "Keep these logs streaming under the table while you look at other things",
          run: () =>
            openLogs({
              title: props.row.n,
              cluster: props.row.cl,
              sources: isPod()
                ? [{ kind: "pod", cluster: props.row.cl, namespace: props.row.ns ?? "", name: props.row.n, uid: props.row.u, containers: [...mainContainers(), ...initContainers()] }]
                : [{ kind: "selector", clusters: clusters(), namespace: props.row.ns ?? "", selector: selector() ?? "", containers: mainContainers() }],
              container: container() === ALL ? null : container(),
            }),
        },
      ]}
    />
  );
}
