import { createMemo, createSignal, For } from "solid-js";
import { isMultiCluster, shortName } from "../../state/clusters";
import { dockOpen, dockTab, type LogsTabSpec, setTermStatus } from "../../state/dock";
import { focusInDock, modalOpen } from "../../state/keyboard";
import { createViewFeed } from "../../state/view";
import { podsOf, samePods } from "../LogsTab";
import { LogViewer, type StreamPod } from "./LogViewer";

const DEFAULT = "__default__";
const ALL = "__all__";

/**
 * Logs in a dock tab: they stream on while the views above change — one object's, or those of pods and workloads
 * picked together (in any clusters), merged into one timeline.
 */
export function DockLogs(props: { id: number; spec: LogsTabSpec }) {
  const spec = props.spec;
  // The pods of each workload (selector), as they come and go.
  const feeds = spec.sources.flatMap((s) => (s.kind === "selector" ? [{ s, feed: createViewFeed(() => ({ resource: "pods", clusters: s.clusters, namespaces: [s.namespace], labelSelector: s.selector })) }] : []));
  const templateContainers = [...new Set(spec.sources.flatMap((s) => s.containers ?? []))];
  const pods = createMemo<StreamPod[]>(
    () => {
      const out = new Map<string, StreamPod>();
      for (const s of spec.sources) {
        if (s.kind !== "pod") continue;
        out.set(`${s.cluster}/${s.namespace}/${s.name}`, { cluster: s.cluster, namespace: s.namespace, name: s.name, uid: s.uid ?? "", containers: s.containers });
      }
      for (const { feed } of feeds) for (const p of podsOf(feed.rows(), feed.columns())) out.set(`${p.cluster}/${p.namespace}/${p.name}`, p);
      return [...out.values()].sort((a, b) => a.cluster.localeCompare(b.cluster) || a.name.localeCompare(b.name));
    },
    [],
    { equals: samePods },
  );
  const names = createMemo(() => [...new Set([...pods().flatMap((p) => p.containers ?? []), ...templateContainers])].sort());
  const [container, setContainer] = createSignal(spec.container ?? DEFAULT);
  const containersOf = (p: StreamPod) => {
    const own = p.containers?.length ? p.containers : templateContainers;
    const c = container();
    if (c === ALL) return own;
    if (c === DEFAULT) return own.slice(0, 1);
    return !p.containers?.length || p.containers.includes(c) ? [c] : [];
  };
  const clusters = createMemo(() => new Set(pods().map((p) => p.cluster)).size > 1 || isMultiCluster());
  const visible = () => dockOpen() && dockTab() === props.id;

  return (
    <div class="dock-logs">
      <LogViewer
        pods={pods}
        containersOf={containersOf}
        restart={() => container()}
        single={() => spec.sources.length === 1 && spec.sources[0].kind === "pod"}
        clusters={clusters}
        label={() => `dock: logs ${spec.title}`}
        saveName={() => `${spec.title.replace(/[^\w.-]+/g, "-")}-${shortName(spec.cluster)}`}
        hasKeyboard={() => visible() && focusInDock() && !modalOpen()}
        onSummary={(s) =>
          setTermStatus(props.id, s.tone === "err" ? { state: "ended", error: true, message: s.text } : s.tone === "ok" ? { state: "open" } : s.text === "ended" ? { state: "ended" } : { state: s.tone === "warn" ? "waiting" : "connecting", message: s.text })
        }
        controls={
          <select class="input" value={container()} onChange={(e) => setContainer(e.currentTarget.value)} title="Containers: each pod's first one, all of them, or one by name">
            <option value={DEFAULT}>Main containers</option>
            <option value={ALL}>All containers</option>
            <For each={names()}>{(n) => <option value={n}>{n}</option>}</For>
          </select>
        }
      />
    </div>
  );
}
