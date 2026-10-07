import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { Icon, type IconName } from "../components/Icon";
import { backend, type GraphMessage, type GraphNode, type GraphRel, Tone } from "../lib/backend";
import { age } from "../lib/format";
import { HELM_RELEASES } from "../lib/helm";
import { keyed } from "../lib/hotkeys";
import { oneOf, persisted } from "../lib/persist";
import { catalogEntry } from "../registry/catalog";
import type { DetailProps } from "../registry/details";
import { reveal } from "../state/nav";
import { now } from "../state/ui";
import { type Card, type CardEdge, layout, linked, REL_WORDS } from "./relationsLayout";

// What relates to the object: a live graph (rows from traffic down to nodes, pods grouped by owner), or the same as
// a list. Cards open their object — with this tab, so the graph can be walked; ⌘[ walks back.

const [mode, setMode] = persisted("relationsMode", "graph" as "graph" | "list", oneOf("graph", "list"));

/** Where the Relations tab is: kinds whose relations the engine works out (see `relations.rs`). */
export const RELATED = new Set([
  "pods",
  "deployments.apps",
  "statefulsets.apps",
  "daemonsets.apps",
  "replicasets.apps",
  "jobs.batch",
  "cronjobs.batch",
  "services",
  "ingresses.networking.k8s.io",
  "configmaps",
  "secrets",
  "persistentvolumeclaims",
  "persistentvolumes",
  "serviceaccounts",
  "rolebindings.rbac.authorization.k8s.io",
  "roles.rbac.authorization.k8s.io",
  "horizontalpodautoscalers.autoscaling",
  "poddisruptionbudgets.policy",
  "networkpolicies.networking.k8s.io",
  "nodes",
]);

const ICONS: Record<string, IconName> = {
  [HELM_RELEASES]: "layers",
  persistentvolumes: "storage",
  "storageclasses.storage.k8s.io": "storage",
  "clusterroles.rbac.authorization.k8s.io": "lock",
};
const iconOf = (n: GraphNode): IconName => (n.resource ? (ICONS[n.resource] ?? catalogEntry(n.resource)?.icon ?? "crd") : "crd");

/** Kinds in words that fit a card ("Autoscaler", not "HorizontalPodAutoscaler"). */
const KIND_WORDS: Record<string, string> = {
  HorizontalPodAutoscaler: "Autoscaler",
  PodDisruptionBudget: "Disruption budget",
  PersistentVolumeClaim: "Volume claim",
  PersistentVolume: "Volume",
  StorageClass: "Storage class",
  NetworkPolicy: "Network policy",
  ServiceAccount: "Service account",
  RoleBinding: "Role binding",
  ClusterRole: "Cluster role",
  ConfigMap: "Config map",
  ReplicaSet: "Replica set",
  StatefulSet: "Stateful set",
  DaemonSet: "Daemon set",
  CronJob: "Cron job",
};
const kindWords = (kind: string) => KIND_WORDS[kind] ?? kind;

/** "4 ready · 1 failing" for a group's members. */
function groupSummary(members: GraphNode[]): string {
  const bad = members.filter((m) => m.tone === Tone.Error).length;
  const warn = members.filter((m) => m.tone === Tone.Warn || m.tone === Tone.Info).length;
  const ok = members.length - bad - warn;
  return [ok ? `${ok} ok` : "", warn ? `${warn} not ready` : "", bad ? `${bad} failing` : ""].filter(Boolean).join(" · ");
}

/** Edge colours by what the relation is about (see the legend). */
const REL_GROUP: Record<GraphRel, "structure" | "traffic" | "uses" | "policy" | "infra" | "access" | "release"> = {
  owns: "structure",
  selects: "traffic",
  routes: "traffic",
  tls: "traffic",
  mounts: "uses",
  env: "uses",
  pulls: "uses",
  runsAs: "uses",
  runsOn: "infra",
  bound: "infra",
  class: "infra",
  scales: "policy",
  protects: "policy",
  isolates: "policy",
  subject: "access",
  grants: "access",
  manages: "release",
};
const LEGEND: [string, string][] = [
  ["structure", "owns"],
  ["traffic", "routes, selects"],
  ["uses", "mounts, env, account"],
  ["policy", "scales, protects, isolates"],
  ["access", "binds, grants"],
  ["infra", "runs on, bound to"],
  ["release", "manages"],
];

/** Opens an object of the graph: in the table, with this tab (a Helm release with its own). */
function open(n: GraphNode, cluster: string) {
  if (!n.resource || n.missing) return;
  reveal({ cluster, resource: n.resource, namespace: n.namespace, name: n.name, tab: n.resource === HELM_RELEASES ? "release" : "relations" });
}

const toneClass = (t: Tone) => `tone-${t}`;

export function RelationsTab(props: DetailProps) {
  const [graph, setGraph] = createSignal<GraphMessage>();
  const [width, setWidth] = createSignal(600);
  const [hover, setHover] = createSignal<string | null>(null);
  const [selected, setSelected] = createSignal<string | null>(null);
  const [legend, setLegend] = createSignal(false);
  let scroller: HTMLDivElement | undefined;

  onMount(() => {
    const row = props.row;
    const sub = backend().subscribeRelations({ cluster: row.cl, resource: props.resourceKey, namespace: row.ns ?? null, name: row.n }, (g) => setGraph(g));
    onCleanup(() => sub.close());
    if (scroller) {
      // In steps, after the frame: a scroll bar coming and going must not make the layout flip back and forth.
      const measure = () => {
        const w = Math.floor((scroller?.clientWidth ?? 600) / 24) * 24;
        if (Math.abs(w - width()) >= 24) setWidth(w);
      };
      const ro = new ResizeObserver(() => requestAnimationFrame(measure));
      ro.observe(scroller);
      measure();
      onCleanup(() => ro.disconnect());
    }
  });

  const g = () => graph();
  const lay = createMemo(() => {
    const x = g();
    return x && x.nodes.length ? layout(x, width()) : undefined;
  });
  /** Cards by id, and the ids in order: cards keep their DOM node across updates, and glide to where they go. */
  const cardById = createMemo(() => new Map((lay()?.cards ?? []).map((c) => [c.id, c])));
  const cardIds = createMemo(() => (lay()?.cards ?? []).map((c) => c.id), undefined, { equals: (a, b) => a.length === b.length && a.every((x, i) => x === b[i]) });
  const focusCard = () => lay()?.cards.find((c) => c.focus);
  const hot = createMemo(() => {
    const l = lay();
    const id = hover() ?? selected();
    return l && id && cardById().has(id) ? linked(l, id) : undefined;
  });
  const missing = createMemo(() => g()?.nodes.filter((n) => n.missing && !n.optional) ?? []);
  const counts = createMemo(() => ({ objects: g()?.nodes.length ?? 0, pods: g()?.nodes.filter((n) => n.resource === "pods").length ?? 0 }));

  // The focus in view when the graph first comes (it may be wide).
  let centred = false;
  createEffect(() => {
    const f = focusCard();
    if (!f || centred || !scroller) return;
    centred = true;
    requestAnimationFrame(() => scroller && (scroller.scrollLeft = Math.max(0, f.x + f.w / 2 - scroller.clientWidth / 2)));
  });

  const select = (id: string | null) => setSelected(id);
  const selectedCard = () => (selected() ? cardById().get(selected()!) : undefined);

  /** Arrow keys: the nearest card that way. */
  const step = (dx: number, dy: number) => {
    const l = lay();
    if (!l || !l.cards.length) return;
    const from = selectedCard() ?? focusCard() ?? l.cards[0];
    if (!selectedCard()) return select(from.id);
    const cx = from.x + from.w / 2;
    const cy = from.y + from.h / 2;
    let best: Card | undefined;
    let bestScore = Infinity;
    for (const c of l.cards) {
      if (c.id === from.id) continue;
      const ddx = c.x + c.w / 2 - cx;
      const ddy = c.y + c.h / 2 - cy;
      if (dx && Math.sign(ddx) !== dx) continue;
      if (dy && Math.sign(ddy) !== dy) continue;
      if (dx && Math.abs(ddy) > c.h) continue;
      const score = dx ? Math.abs(ddx) + Math.abs(ddy) * 4 : Math.abs(ddy) + Math.abs(ddx) * 0.6;
      if (score < bestScore) [best, bestScore] = [c, score];
    }
    if (best) {
      select(best.id);
      scrollIntoView(best);
    }
  };
  const scrollIntoView = (c: Card) => {
    if (!scroller) return;
    const s = scroller;
    if (c.x < s.scrollLeft) s.scrollLeft = c.x - 12;
    else if (c.x + c.w > s.scrollLeft + s.clientWidth) s.scrollLeft = c.x + c.w - s.clientWidth + 12;
    const top = c.y;
    if (top < s.scrollTop) s.scrollTop = top - 12;
    else if (top + c.h > s.scrollTop + s.clientHeight) s.scrollTop = top + c.h - s.clientHeight + 12;
  };
  const onKey = (e: KeyboardEvent) => {
    const keys: Record<string, () => void> = {
      ArrowLeft: () => step(-1, 0),
      ArrowRight: () => step(1, 0),
      ArrowUp: () => step(0, -1),
      ArrowDown: () => step(0, 1),
      Enter: () => {
        const c = selectedCard();
        if (c?.type === "object") open(c.node!, props.row.cl);
      },
      Escape: () => select(null),
    };
    const run = keys[e.key];
    if (!run || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === "Escape" && !selected()) return;
    e.preventDefault();
    e.stopPropagation();
    run();
  };

  return (
    <div class="rel">
      <div class="toolbar">
        <div class="seg">
          <button class="btn sm ghost" classList={{ on: mode() === "graph" }} onClick={() => setMode("graph")}>
            <Icon name="relations" size={12} /> Graph
          </button>
          <button class="btn sm ghost" classList={{ on: mode() === "list" }} onClick={() => setMode("list")}>
            <Icon name="list" size={12} /> List
          </button>
        </div>
        <span class="faint rel-summary">
          <Show when={g()?.nodes.length}>
            {counts().objects} objects{counts().pods ? ` · ${counts().pods} pods` : ""}
          </Show>
        </span>
        <Show when={missing().length}>
          <button class="badge err rel-missing-badge" title={`Referred to but not there:\n${missing().map((n) => `${n.kind} ${n.name}`).join("\n")}`} onClick={() => select(missing()[0].id)}>
            {missing().length} missing
          </button>
        </Show>
        <span class="grow" />
        <Show when={g()?.loading}>
          <span class="spinner" title="Reading what relates to it" />
        </Show>
        <Show when={mode() === "graph"}>
          <button class="btn sm ghost" classList={{ on: legend() }} onClick={() => setLegend(!legend())} title="What the colours mean">
            <Icon name="info" size={12} />
          </button>
        </Show>
      </div>
      <Show when={legend() && mode() === "graph"}>
        <div class="rel-legend">
          <For each={LEGEND}>
            {([group, words]) => (
              <span class="rel-legend-item">
                <svg width="22" height="8" aria-hidden="true">
                  <path d="M1,4 L21,4" class={`rel-edge rel-g-${group}`} />
                </svg>
                {words}
              </span>
            )}
          </For>
          <span class="rel-legend-item">
            <span class="rel-legend-card missing" /> missing
          </span>
          <span class="rel-legend-item">
            <span class="rel-legend-card unknown" /> not checked (no access)
          </span>
        </div>
      </Show>
      <Show when={g()?.error}>
        <div class="section error-text">{g()!.error}</div>
      </Show>
      <Show when={!g() || (g()!.loading && !g()!.nodes.length)}>
        <div class="rel-empty">
          <span class="spinner" />
          <span class="faint">Reading what relates to {props.row.n}…</span>
        </div>
      </Show>
      <div class="rel-scroll" ref={scroller} tabIndex={0} onKeyDown={onKey} onClick={(e) => e.target === e.currentTarget && select(null)}>
        <Show when={mode() === "graph" && lay()}>
          {(l) => (
            <div class="rel-canvas" style={{ width: `${l().width}px`, height: `${l().height}px` }} onClick={(e) => e.target === e.currentTarget && select(null)}>
              <svg class="rel-edges" width={l().width} height={l().height} aria-hidden="true">
                <defs>
                  <marker id="rel-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                    <path d="M0,0 L8,4 L0,8 z" class="rel-arrow" />
                  </marker>
                </defs>
                <For each={l().edges}>
                  {(e) => (
                    <path
                      d={e.path}
                      class={`rel-edge rel-g-${REL_GROUP[e.rel]}`}
                      classList={{ hot: !!hot()?.edges.has(e.id), dim: !!hot() && !hot()!.edges.has(e.id) }}
                      marker-end="url(#rel-arrow)"
                    />
                  )}
                </For>
              </svg>
              <For each={l().edges.filter((e) => e.label && (hot()?.edges.has(e.id) || e.rel === "routes"))}>
                {(e) => <EdgeLabel e={e} />}
              </For>
              <For each={cardIds()}>
                {(id) => {
                  const c = () => cardById().get(id);
                  return (
                    <Show when={c()}>
                      {(card) => (
                        <CardView
                          card={card()}
                          cluster={props.row.cl}
                          selected={selected() === id}
                          hot={!!hot()?.cards.has(id)}
                          dim={!!hot() && !hot()!.cards.has(id)}
                          onHover={(on) => setHover(on ? id : null)}
                          onSelect={() => select(id)}
                        />
                      )}
                    </Show>
                  );
                }}
              </For>
            </div>
          )}
        </Show>
        <Show when={mode() === "list" && g()?.nodes.length}>
          <RelationsList graph={g()!} cluster={props.row.cl} />
        </Show>
      </div>
      <Show when={mode() === "graph" && selectedCard()}>{(c) => <Inspector card={c()} layout={lay()!} graph={g()!} cluster={props.row.cl} onClose={() => select(null)} />}</Show>
      <Show when={g()?.notes.length}>
        <div class="rel-notes">
          <For each={g()!.notes}>
            {(n) => (
              <div>
                <Icon name="info" size={11} /> {n}
              </div>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}

function EdgeLabel(props: { e: CardEdge }) {
  return (
    <span class="rel-label" style={{ transform: `translate(${props.e.mid[0]}px, ${props.e.mid[1]}px) translate(-50%, -50%)` }}>
      {props.e.label}
      {props.e.count > 1 ? ` ×${props.e.count}` : ""}
    </span>
  );
}

function CardView(props: { card: Card; cluster: string; selected: boolean; hot: boolean; dim: boolean; onHover: (on: boolean) => void; onSelect: () => void }) {
  const c = () => props.card;
  const n = () => c().node;
  const style = () => ({ transform: `translate(${c().x}px, ${c().y}px)`, width: `${c().w}px`, height: `${c().h}px` });
  const title = () => {
    const x = n();
    if (!x) return `${c().members.length} ${c().type}: ${groupSummary(c().members)}\nClick a square to open it`;
    const where = x.namespace ? ` in ${x.namespace}` : "";
    const state = x.missing ? (x.optional ? "\nNot there (optional: no error)" : "\nNot there: what refers to it fails") : x.unknown ? "\nNot checked: its kind could not be read" : x.status ? `\n${x.status}` : "";
    return `${kindWords(x.kind)} ${x.name}${where}${state}${x.resource && !x.missing ? "\nDouble-click or ↵ to open it" : ""}`;
  };
  return (
    <div
      class="rel-card"
      classList={{
        focus: c().focus,
        sel: props.selected,
        hot: props.hot,
        dim: props.dim,
        group: c().type !== "object",
        missing: !!n()?.missing,
        optional: !!n()?.optional,
        unknown: !!n()?.unknown,
        openable: !!n()?.resource && !n()?.missing,
      }}
      style={style()}
      title={title()}
      onMouseEnter={() => props.onHover(true)}
      onMouseLeave={() => props.onHover(false)}
      onClick={(e) => {
        e.stopPropagation();
        props.onSelect();
      }}
      onDblClick={() => n() && open(n()!, props.cluster)}
    >
      <span class={`rel-tone ${toneClass(c().tone)}`} />
      <Show
        when={n()}
        fallback={
          <div class="rel-group">
            <div class="rel-head">
              <Icon name={c().type === "pods" ? "pod" : "node"} size={12} />
              <span class="rel-kind">{c().type === "pods" ? "Pods" : "Nodes"}</span>
              <span class="rel-count">{c().members.length}</span>
              <span class="faint ellipsis rel-of">{groupSummary(c().members)}</span>
            </div>
            <div class="rel-dots">
              <For each={c().members}>
                {(m) => (
                  <button
                    class={`rel-dot ${toneClass(m.tone)}`}
                    title={`${m.name}${m.status ? ` · ${m.status}` : ""}${m.created ? ` · ${age(m.created, now())} old` : ""}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      open(m, props.cluster);
                    }}
                  />
                )}
              </For>
            </div>
          </div>
        }
      >
        {(x) => (
          <div class="rel-body">
            <div class="rel-head">
              <Icon name={iconOf(x())} size={12} />
              <span class="rel-kind">{kindWords(x().kind)}</span>
              <Show when={x().more}>
                <span class="rel-tag" title={`${x().more} more of its pods are not drawn`}>
                  +{x().more} pods
                </span>
              </Show>
            </div>
            <div class="rel-name ellipsis">{x().name}</div>
            <Show
              when={x().missing || x().unknown}
              fallback={
                <Show when={x().status}>
                  <div class={`rel-status ellipsis ${x().tone === Tone.Error || x().tone === Tone.Warn ? toneClass(x().tone) : "faint"}`}>{x().status}</div>
                </Show>
              }
            >
              <div class={`rel-status ellipsis ${x().missing && !x().optional ? "tone-3" : "faint"}`}>{x().missing ? (x().optional ? "not there (optional)" : "not there") : "not checked: no access"}</div>
            </Show>
          </div>
        )}
      </Show>
    </div>
  );
}

/** The selected card: what it is, how it relates to its neighbours, and a way to open it (or its members). */
function Inspector(props: { card: Card; layout: ReturnType<typeof layout>; graph: GraphMessage; cluster: string; onClose: () => void }) {
  const c = () => props.card;
  const ids = () => new Set(c().members.map((m) => m.id));
  const nodeById = () => new Map(props.graph.nodes.map((n) => [n.id, n]));
  const relations = createMemo(() => {
    const out: { words: string; other: GraphNode; label?: string }[] = [];
    const seen = new Set<string>();
    for (const e of props.graph.edges) {
      const outward = ids().has(e.from);
      if (!outward && !ids().has(e.to)) continue;
      const other = nodeById().get(outward ? e.to : e.from);
      if (!other || ids().has(other.id)) continue;
      const key = `${e.rel}\n${outward}\n${other.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ words: REL_WORDS[e.rel][outward ? 0 : 1], other, label: e.label });
    }
    return out.slice(0, 40);
  });
  return (
    <div class="rel-inspector">
      <div class="rel-inspector-head">
        <Show
          when={c().node}
          fallback={
            <b>
              {c().members.length} {c().type === "pods" ? "pods" : "nodes"}
            </b>
          }
        >
          {(n) => (
            <>
              <Icon name={iconOf(n())} size={13} />
              <span class="faint">{kindWords(n().kind)}</span>
              <b class="ellipsis">{n().name}</b>
              <Show when={n().namespace}>
                <span class="chip">{n().namespace}</span>
              </Show>
              <Show when={n().status}>
                <span class={`badge ${n().tone === Tone.Error ? "err" : n().tone === Tone.Warn ? "warn" : n().tone === Tone.Ok ? "ok" : ""}`}>{n().status}</span>
              </Show>
            </>
          )}
        </Show>
        <span class="grow" />
        <Show when={c().node?.resource && !c().node?.missing}>
          <button class="btn sm" onClick={() => open(c().node!, props.cluster)} title={`Open it here, with its relations (↵)${keyed("nav.back", (k) => `; ${k} comes back`)}`}>
            Open <span class="kbd">↵</span>
          </button>
        </Show>
        <button class="btn sm ghost icon" onClick={() => props.onClose()} title="Close (Esc)">
          <Icon name="x" size={12} />
        </button>
      </div>
      <Show when={c().type !== "object"}>
        <div class="rel-members">
          <For each={c().members}>
            {(m) => (
              <button class="rel-member" onClick={() => open(m, props.cluster)}>
                <span class={`dot ${toneClass(m.tone)}`} />
                <span class="ellipsis">{m.name}</span>
                <span class="faint">{m.status}</span>
              </button>
            )}
          </For>
        </div>
      </Show>
      <div class="rel-rels">
        <For each={relations()}>
          {(r) => (
            <div class="rel-rel">
              <span class="faint">{r.words}</span>
              <button class="link-btn ellipsis" disabled={!r.other.resource || r.other.missing} onClick={() => open(r.other, props.cluster)}>
                {kindWords(r.other.kind)} {r.other.name}
              </button>
              <Show when={r.label}>
                <span class="faint mono ellipsis">{r.label}</span>
              </Show>
              <Show when={r.other.missing}>
                <span class="rel-tag missing">missing</span>
              </Show>
            </div>
          )}
        </For>
      </div>
    </div>
  );
}

/** The same relations as text: the object's own, grouped by how they relate, then its app's pods. */
function RelationsList(props: { graph: GraphMessage; cluster: string }) {
  const nodeById = () => new Map(props.graph.nodes.map((n) => [n.id, n]));
  const groups = createMemo(() => {
    const by = new Map<string, { other: GraphNode; label?: string }[]>();
    const f = props.graph.focus;
    for (const e of props.graph.edges) {
      if (e.from !== f && e.to !== f) continue;
      const outward = e.from === f;
      const other = nodeById().get(outward ? e.to : e.from);
      if (!other) continue;
      const words = REL_WORDS[e.rel][outward ? 0 : 1];
      by.set(words, [...(by.get(words) ?? []), { other, label: e.label }]);
    }
    return [...by];
  });
  const pods = () => props.graph.nodes.filter((n) => n.resource === "pods" && n.id !== props.graph.focus);
  const rest = () => props.graph.nodes.filter((n) => n.id !== props.graph.focus && n.resource !== "pods" && !props.graph.edges.some((e) => (e.from === props.graph.focus && e.to === n.id) || (e.to === props.graph.focus && e.from === n.id)));
  const Item = (p: { n: GraphNode; label?: string }) => (
    <div class="rel-li">
      <span class={`dot ${toneClass(p.n.tone)}`} />
      <Icon name={iconOf(p.n)} size={12} />
      <span class="faint rel-li-kind">{kindWords(p.n.kind)}</span>
      <button class="link-btn ellipsis" disabled={!p.n.resource || p.n.missing} onClick={() => open(p.n, props.cluster)}>
        {p.n.name}
      </button>
      <Show when={p.label}>
        <span class="faint mono ellipsis">{p.label}</span>
      </Show>
      <Show when={p.n.missing}>
        <span class="rel-tag missing">{p.n.optional ? "optional · missing" : "missing"}</span>
      </Show>
      <Show when={p.n.unknown}>
        <span class="rel-tag">not checked</span>
      </Show>
      <span class="grow" />
      <span class="faint">{p.n.status}</span>
    </div>
  );
  return (
    <div class="rel-list">
      <For each={groups()}>
        {([words, items]) => (
          <section class="section">
            <h3>
              {words} · {items.length}
            </h3>
            <For each={items}>{(i) => <Item n={i.other} label={i.label} />}</For>
          </section>
        )}
      </For>
      <Show when={pods().length}>
        <section class="section">
          <h3>Pods · {pods().length}</h3>
          <For each={pods()}>{(p) => <Item n={p} />}</For>
        </section>
      </Show>
      <Show when={rest().length}>
        <section class="section">
          <h3>Further · {rest().length}</h3>
          <For each={rest()}>{(p) => <Item n={p} />}</For>
        </section>
      </Show>
    </div>
  );
}
