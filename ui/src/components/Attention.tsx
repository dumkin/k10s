import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { Tone } from "../lib/backend";
import { findIssues, isEventIssue, type Instance, type Issue, type Severity, SEVERITIES, type SourceRows, spreadNote, type When } from "../lib/attention";
import { zoneOf } from "../lib/clusters";
import { age } from "../lib/format";
import { HELM_RELEASES } from "../lib/helm";
import { type Binding, bindAll, keyLabel } from "../lib/hotkeys";
import { isError, isForbidden } from "../lib/k8s";
import { keyOf } from "../lib/keymap";
import { catalogEntry } from "../registry/catalog";
import { clusterColor, clusterStatus, discoveredResources, selectedClusters, shortName, zoneFamilyOf } from "../state/clusters";
import { focusInSidebar, modalOpen, onControl } from "../state/keyboard";
import { namespaces, reveal } from "../state/nav";
import { now } from "../state/ui";
import { createViewFeed, type FeedState, type ViewFeed } from "../state/view";
import {
  attentionCluster as onlyCluster,
  attentionExpanded as expanded,
  attentionFilter as filter,
  attentionScroll,
  attentionSeen,
  attentionSelected as selected,
  attentionSeverity as onlySeverity,
  setAttentionCluster as setOnlyCluster,
  setAttentionCount,
  setAttentionExpanded as setExpanded,
  setAttentionFilter as setFilter,
  setAttentionSelected as setSelected,
  setAttentionSeverity as setOnlySeverity,
} from "../state/attention";
import { Icon, type IconName } from "./Icon";
import { Kbd } from "./Kbd";

/**
 * What is watched for trouble: workloads, their pods, nodes, claims, autoscalers, Helm releases, a few custom
 * resources that say whether they are ready, and warning events. Each as a view of the objects that are not fine
 * only (the engine's `problems` projection): a fleet's thousands of healthy pods never reach the UI.
 */
const SOURCES = [
  "pods",
  "deployments.apps",
  "statefulsets.apps",
  "daemonsets.apps",
  "jobs.batch",
  "nodes",
  "persistentvolumeclaims",
  "horizontalpodautoscalers.autoscaling",
  HELM_RELEASES,
  "certificates.cert-manager.io",
  "applications.argoproj.io",
  "events",
];

const SEVERITY_TITLE: Record<Severity, string> = { critical: "Critical", warning: "Warnings", info: "Worth a look" };

const SOURCE_TITLE: Record<string, string> = {
  pods: "pods",
  "deployments.apps": "deployments",
  "statefulsets.apps": "stateful sets",
  "daemonsets.apps": "daemon sets",
  "jobs.batch": "jobs",
  nodes: "nodes",
  persistentvolumeclaims: "volume claims",
  "horizontalpodautoscalers.autoscaling": "autoscalers",
  [HELM_RELEASES]: "Helm releases",
  "certificates.cert-manager.io": "certificates",
  "applications.argoproj.io": "Argo CD applications",
  events: "events",
};

/** The kind of object an event is about, as a resource key (to open it with its events). */
const EVENT_OBJECTS: Record<string, string> = {
  pod: "pods",
  node: "nodes",
  deployment: "deployments.apps",
  replicaset: "replicasets.apps",
  statefulset: "statefulsets.apps",
  daemonset: "daemonsets.apps",
  job: "jobs.batch",
  cronjob: "cronjobs.batch",
  persistentvolumeclaim: "persistentvolumeclaims",
  service: "services",
  horizontalpodautoscaler: "horizontalpodautoscalers.autoscaling",
  ingress: "ingresses.networking.k8s.io",
};

function whenText(w: When | undefined, t: number): string {
  if (!w) return "";
  const a = age(w.at, t);
  return w.how === "for" ? `for ${a}` : w.how === "restarted" ? `restarted ${a} ago` : w.how === "started" ? `started ${a} ago` : `${a} old`;
}

const iconOf = (resource: string): IconName => catalogEntry(resource)?.icon ?? (resource === "events" ? "event" : "crd");

/** Where an instance opens: the object itself (a crashing pod with its logs), an event's object with its events. */
function open(i: Instance, severity: Severity) {
  if (i.resource === "events" || i.resource === "events.events.k8s.io") {
    const [kind, ...rest] = i.status.replace(/^\d+× /, "").split("/");
    const resource = EVENT_OBJECTS[kind];
    if (resource) return reveal({ cluster: i.cluster, resource, namespace: i.namespace, name: rest.join("/"), tab: "events" });
  }
  reveal({ cluster: i.cluster, resource: i.resource, namespace: i.namespace, name: i.name, tab: i.resource === "pods" && severity === "critical" ? "logs" : undefined });
}

export function AttentionView() {
  // One problems view per source the selected clusters serve; namespaces as the table has them.
  const feeds: { resource: string; feed: ViewFeed }[] = SOURCES.map((resource) => ({
    resource,
    feed: createViewFeed(() => {
      const r = discoveredResources().get(resource);
      if (!r || !selectedClusters().length) return null;
      return {
        resource,
        clusters: selectedClusters(),
        namespaces: r.namespaced ? namespaces() : [],
        // Warnings only, listed so: a busy cluster's normal events never leave it.
        fieldSelector: resource === "events" ? "type=Warning" : undefined,
        projection: resource === HELM_RELEASES ? undefined : "problems",
      };
    }),
  }));

  // Thresholds are minutes: judged again every 15 s, and whenever rows change.
  const tick = createMemo(() => Math.floor(now() / 15));
  const issues = createMemo(() => {
    tick();
    const sources: SourceRows[] = feeds.map(({ resource, feed }) => ({ resource, columns: feed.columns(), rows: feed.rows() }));
    const t = Math.floor(Date.now() / 1000);
    const touched = new Map<string, number>();
    const found = findIssues(
      sources,
      t,
      (key) => {
        const at = attentionSeen.map.get(key) ?? t;
        touched.set(key, at);
        return at;
      },
      selectedClusters(),
    );
    attentionSeen.map = touched;
    return found;
  });

  let filterInput: HTMLInputElement | undefined;
  let body: HTMLDivElement | undefined;
  /** Warning events shown before "Show all": the most frequent. */
  const EVENTS_SHOWN = 25;
  const [allEvents, setAllEvents] = createSignal(false);

  const matches = (i: Issue) => {
    const q = filter().trim().toLowerCase();
    if (onlyCluster() && !i.where.has(onlyCluster()!)) return false;
    if (!q) return true;
    return [i.subject, i.reason, i.kind, i.namespace ?? "", i.message ?? "", ...[...i.where.keys()].map(shortName)].some((s) => s.toLowerCase().includes(q));
  };
  const problems = createMemo(() => issues().filter((i) => !isEventIssue(i) && matches(i)));
  // The most frequent first: a crash-looping pod's BackOff before a one-off probe failure.
  const events = createMemo(() => issues().filter((i) => isEventIssue(i) && matches(i)).sort((a, b) => (b.events ?? 0) - (a.events ?? 0) || b.where.size - a.where.size));
  const shownEvents = createMemo(() => (allEvents() || filter() ? events() : events().slice(0, EVENTS_SHOWN)));
  const counts = createMemo(() => {
    const out: Record<Severity, number> = { critical: 0, warning: 0, info: 0 };
    for (const i of issues()) if (!isEventIssue(i)) out[i.severity]++;
    return out;
  });
  createMemo(() => setAttentionCount(counts().critical + counts().warning));
  onCleanup(() => setAttentionCount(null));
  /** What shows, in order: problems (of the severity picked), then events — what j/k step through. */
  const shown = createMemo(() => [...problems().filter((i) => !onlySeverity() || i.severity === onlySeverity()), ...(onlySeverity() ? [] : shownEvents())]);

  /** Per cluster: issues by severity, and whether it could be checked at all. */
  const perCluster = createMemo(() => {
    const out = new Map<string, Record<Severity, number>>();
    for (const c of selectedClusters()) out.set(c, { critical: 0, warning: 0, info: 0 });
    for (const i of issues()) if (!isEventIssue(i)) for (const c of i.where.keys()) out.get(c) && out.get(c)![i.severity]++;
    return out;
  });
  const statuses = createMemo(() => feeds.flatMap(({ resource, feed }) => Object.values(feed.statuses).filter((s): s is FeedState => !!s).map((s) => ({ resource, s }))));
  // Clusters still connecting have no views yet (what they serve is not known): that is loading too.
  const loading = createMemo(() => feeds.some(({ feed }) => feed.loading()) || selectedClusters().some((c) => !clusterStatus[c] || clusterStatus[c].state === "connecting"));
  /**
   * Per cluster, what it could not be checked for: no access (strict RBAC), or an error. Resources a cluster does not
   * serve (a CRD it lacks) are nothing to check there.
   */
  const unchecked = createMemo(() => {
    const by = new Map<string, { forbidden: string[]; failed: string[]; messages: string[] }>();
    for (const { resource, s } of statuses()) {
      if (!isError(s) || !discoveredResources().get(resource)?.clusters.includes(s.c)) continue;
      const e = by.get(s.c) ?? { forbidden: [], failed: [], messages: [] };
      const list = isForbidden(s) ? e.forbidden : e.failed;
      if (!list.includes(resource)) list.push(resource);
      e.messages.push(`${SOURCE_TITLE[resource] ?? resource}${s.ns ? ` in ${s.ns}` : ""}: ${s.message}`);
      by.set(s.c, e);
    }
    return [...by].map(([cluster, e]) => ({ cluster, ...e }));
  });
  const clusterTrouble = (c: string) => {
    const conn = clusterStatus[c];
    if (conn?.state === "error") return "cannot connect";
    if (conn?.state === "connecting" || !conn) return "connecting";
    const u = unchecked().find((x) => x.cluster === c);
    return u?.forbidden.includes("pods") ? "no access" : u ? "partly checked" : undefined;
  };

  const note = (i: Issue) => spreadNote([...i.where.keys()], selectedClusters(), zoneFamilyOf, (c) => zoneOf(c)?.zone ?? shortName(c));
  const toggle = (key: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const first = (i: Issue) => [...i.where.values()][0]?.[0];

  // ------------------------------------------------------------------ keyboard
  const move = (delta: number) => {
    const list = shown();
    if (!list.length) return;
    const cur = list.findIndex((i) => i.key === selected());
    const next = cur < 0 ? (delta > 0 ? 0 : list.length - 1) : Math.max(0, Math.min(list.length - 1, cur + delta));
    setSelected(list[next].key);
    document.querySelector(`[data-issue="${CSS.escape(list[next].key)}"]`)?.scrollIntoView({ block: "nearest" });
  };
  const current = () => shown().find((i) => i.key === selected());
  // Back from an object: where the list was, once it is there again.
  let restored = false;
  createEffect(() => {
    if (restored || !shown().length) return;
    restored = true;
    requestAnimationFrame(() => body && (body.scrollTop = attentionScroll.top));
  });
  onMount(() => {
    // Not while the sidebar's list has the keyboard: its keys move along it.
    const free = () => !modalOpen() && !focusInSidebar();
    onCleanup(
      bindAll(
        (
          [
          { id: "attention.down", run: () => move(1) },
          { combo: "arrowdown", run: () => move(1) },
          { id: "attention.up", run: () => move(-1) },
          { combo: "arrowup", run: () => move(-1) },
          { id: "attention.first", run: () => move(-Infinity) },
          { id: "attention.last", run: () => move(Infinity) },
          {
            combo: "enter",
            run: (e) => {
              const i = current();
              if (!i || onControl(e)) return false;
              const f = first(i);
              if (f) open(f, i.severity);
            },
          },
          {
            combo: "space",
            run: (e) => {
              const i = current();
              if (!i || onControl(e)) return false;
              toggle(i.key);
            },
          },
          { combo: "arrowright", run: () => void (current() && !expanded().has(current()!.key) && toggle(current()!.key)) },
          { combo: "arrowleft", run: () => void (current() && expanded().has(current()!.key) && toggle(current()!.key)) },
          { id: "attention.filter", run: () => filterInput?.focus() },
          {
            combo: "escape",
            inInputs: true,
            run: (e) => {
              if (e.target === filterInput) {
                if (filter()) setFilter("");
                else filterInput?.blur();
                return;
              }
              if (onlyCluster() || onlySeverity()) {
                setOnlyCluster(null);
                setOnlySeverity(null);
              } else return false;
            },
          },
          ] as Binding[]
        ).map((b) => ({ ...b, when: () => free() && (b.inInputs || !onControlFocus()) })),
      ),
    );
  });
  const onControlFocus = () => !!document.activeElement?.closest("input, textarea, select");

  const scope = () => {
    const ns = namespaces();
    return `${selectedClusters().length === 1 ? selectedClusters()[0] : `${selectedClusters().length} clusters`} · ${ns.length ? ns.join(", ") : "all namespaces"}`;
  };

  return (
    <div class="content attention">
      <div class="view-header">
        <div class="view-title">
          <Icon name="alert" size={18} />
          <h1>Needs attention</h1>
          <span class="kind" title="What is checked: the selected clusters and namespaces (as the tables)">
            {scope()}
          </span>
        </div>
        <div class="att-counts">
          <For each={SEVERITIES}>
            {(s) => (
              <button
                class={`att-count ${s}`}
                classList={{ on: onlySeverity() === s, zero: counts()[s] === 0 }}
                title={onlySeverity() === s ? "Show every severity" : `Show ${SEVERITY_TITLE[s].toLowerCase()} only`}
                onClick={() => setOnlySeverity(onlySeverity() === s ? null : s)}
              >
                <span class="att-dot" />
                {counts()[s]}
                <span class="att-count-label">{s === "info" ? "to look at" : s === "warning" ? (counts()[s] === 1 ? "warning" : "warnings") : "critical"}</span>
              </button>
            )}
          </For>
        </div>
        <div class="filter search-field" data-hint={keyOf("attention.filter")}>
          <Icon name="filter" size={13} />
          <input ref={filterInput} class="input" placeholder="Filter by name, reason, cluster" aria-label="Filter" value={filter()} onInput={(e) => setFilter(e.currentTarget.value)} spellcheck={false} />
          <Show when={filter()} fallback={<Kbd id="attention.filter" />}>
            <button class="clear" onClick={() => setFilter("")} aria-label="Clear the filter">
              <Icon name="x" size={12} />
            </button>
          </Show>
        </div>
        <span class="progress-line" classList={{ on: loading() }} role="progressbar" aria-label="Checking the clusters" aria-hidden={!loading()} />
      </div>

      <Show when={selectedClusters().length > 1}>
        <div class="att-tiles">
          <For each={selectedClusters()}>
            {(c) => {
              const n = () => perCluster().get(c) ?? { critical: 0, warning: 0, info: 0 };
              const trouble = () => clusterTrouble(c);
              const healthy = () => !trouble() && n().critical === 0 && n().warning === 0;
              return (
                <button
                  class="att-tile"
                  classList={{ on: onlyCluster() === c, critical: n().critical > 0, warning: !n().critical && n().warning > 0, healthy: healthy() }}
                  title={`${c}${trouble() ? ` — ${trouble()}` : ""}\n${onlyCluster() === c ? "Click to show every cluster" : "Click to show only this cluster"}`}
                  onClick={() => setOnlyCluster(onlyCluster() === c ? null : c)}
                >
                  <span class="att-tile-name">
                    <span class="swatch" style={{ background: clusterColor(c) }} />
                    <span class="ellipsis">{shortName(c)}</span>
                  </span>
                  <span class="att-tile-counts">
                    <Show when={!healthy()} fallback={<span class="att-ok"><Icon name="check" size={12} strokeWidth={2.4} /> {clusterStatus[c]?.state === "connected" ? "healthy" : "…"}</span>}>
                      <Show when={n().critical}>
                        <span class="c critical">{n().critical}</span>
                      </Show>
                      <Show when={n().warning}>
                        <span class="c warning">{n().warning}</span>
                      </Show>
                      <Show when={trouble()}>
                        <span class="faint att-tile-trouble">{trouble()}</span>
                      </Show>
                    </Show>
                  </span>
                </button>
              );
            }}
          </For>
        </div>
      </Show>

      <div class="att-body" ref={body} onScroll={(e) => (attentionScroll.top = e.currentTarget.scrollTop)}>
        <Show
          when={shown().length}
          fallback={
            <div class="att-empty">
              <Show when={!loading()} fallback={<span class="spinner" />}>
                <Icon name="check" size={28} strokeWidth={2} />
                <h2>{filter() || onlyCluster() || onlySeverity() ? "Nothing matches" : "Nothing needs attention"}</h2>
                <p class="faint">
                  Pods, workloads, nodes, volume claims, autoscalers and Helm releases in {scope()} are fine
                  {unchecked().length ? " — as far as they could be checked (see below)" : ""}.
                </p>
              </Show>
            </div>
          }
        >
          <For each={SEVERITIES}>
            {(sev) => {
              const list = () => problems().filter((i) => i.severity === sev && (!onlySeverity() || onlySeverity() === sev));
              return (
                <Show when={list().length}>
                  <section class="att-group">
                    <h3 class={sev}>
                      <span class="att-dot" />
                      {SEVERITY_TITLE[sev]} · {list().length}
                    </h3>
                    <For each={list()}>{(i) => <IssueRow issue={i} note={note(i)} selected={selected() === i.key} expanded={expanded().has(i.key)} onSelect={() => setSelected(i.key)} onToggle={() => toggle(i.key)} />}</For>
                  </section>
                </Show>
              );
            }}
          </For>
          <Show when={!onlySeverity() && events().length}>
            <section class="att-group">
              <h3 class="events">
                <Icon name="event" size={12} />
                Warning events in the last hour · {events().length}
              </h3>
              <For each={shownEvents()}>{(i) => <IssueRow issue={i} note={note(i)} selected={selected() === i.key} expanded={expanded().has(i.key)} onSelect={() => setSelected(i.key)} onToggle={() => toggle(i.key)} />}</For>
              <Show when={shownEvents().length < events().length}>
                <button class="btn sm ghost att-more" onClick={() => setAllEvents(true)}>
                  Show all {events().length}
                </button>
              </Show>
            </section>
          </Show>
        </Show>
        <Show when={unchecked().length}>
          <div class="att-unchecked">
            <For each={unchecked()}>
              {(u) => (
                <div title={u.messages.join("\n")}>
                  <Icon name={u.forbidden.length ? "lock" : "alert"} size={12} />
                  <span>
                    <b>{shortName(u.cluster)}</b>
                    <Show when={u.forbidden.length}>
                      {" "}
                      — no access to {u.forbidden.map((r) => SOURCE_TITLE[r] ?? r).join(", ")}
                      {u.forbidden.includes("pods") && !namespaces().length ? ": pick the namespaces you work in (its RBAC forbids listing across all of them)" : ""}
                    </Show>
                    <Show when={u.failed.length}>
                      {u.forbidden.length ? "; " : " — "}could not check {u.failed.map((r) => SOURCE_TITLE[r] ?? r).join(", ")}
                    </Show>
                  </span>
                </div>
              )}
            </For>
          </div>
        </Show>
        <div class="att-help faint">
          <Show when={keyLabel("attention.down") || keyLabel("attention.up")}>
            <Kbd id="attention.down" />
            <Kbd id="attention.up" /> move ·{" "}
          </Show>
          <span class="kbd">↵</span> open · <span class="kbd">space</span> show objects
          <Show when={keyLabel("nav.back")}>
            {(back) => (
              <>
                {" · "}
                <span class="kbd">{back()}</span> back here from an object
              </>
            )}
          </Show>
        </div>
      </div>
    </div>
  );
}

function IssueRow(props: { issue: Issue; note: string; selected: boolean; expanded: boolean; onSelect: () => void; onToggle: () => void }) {
  const i = () => props.issue;
  /** "3 pods", "2 nodes", "14×" (events). */
  const objects = () => {
    if (isEventIssue(i())) return `${i().events ?? i().count}×`;
    const word = i().resource === "nodes" ? "node" : i().where.size && [...i().where.values()][0][0]?.resource === "pods" ? "pod" : "";
    return word ? `${i().count} ${word}${i().count === 1 ? "" : "s"}` : "";
  };
  return (
    <div class="att-issue-wrap" classList={{ open: props.expanded }}>
      <div
        class={`att-issue ${i().severity}`}
        classList={{ sel: props.selected }}
        data-issue={i().key}
        onClick={() => {
          props.onSelect();
          props.onToggle();
        }}
        title={[i().detail, i().message].filter(Boolean).join("\n")}
      >
        <Icon name={props.expanded ? "chevron-down" : "chevron-right"} size={12} class="att-caret" />
        <span class="att-sev" />
        <span class="att-subject">
          <Icon name={iconOf(i().resource)} size={14} />
          <span class="att-name ellipsis">{i().subject}</span>
          <span class="att-kind faint">{i().kind}</span>
          <Show when={i().namespace}>
            <span class="chip att-ns">
              <Icon name="namespace" size={10} />
              {i().namespace}
            </span>
          </Show>
          <span class="att-reason">{i().reason}</span>
        </span>
        <span class="att-where">
          <Show when={props.note}>
            <span class="att-note" classList={{ only: props.note.startsWith("only") }} title="Where it is, against the zones of each family picked: one zone alone points at that DC, all of them at the app or its release">
              {props.note}
            </span>
          </Show>
          <For each={[...i().where.entries()]}>
            {([c, list]) => (
              <span class="att-cl" title={`${c}: ${list.map((x) => x.name).join(", ")}`}>
                <span class="swatch" style={{ background: clusterColor(c) }} />
                {shortName(c)}
                <Show when={list.length > 1}>
                  <span class="faint">×{list.length}</span>
                </Show>
              </span>
            )}
          </For>
        </span>
        <span class="att-detail faint ellipsis">{isEventIssue(i()) ? i().message : i().detail}</span>
        <span class="att-meta faint">
          {objects()}
          <Show when={i().when}>
            <span>
              {objects() ? " · " : ""}
              {whenText(i().when, now())}
            </span>
          </Show>
        </span>
      </div>
      <Show when={props.expanded}>
        <div class="att-instances">
          <For each={[...i().where.entries()].flatMap(([, list]) => list)}>
            {(x) => (
              <div class="att-inst">
                <span class="swatch" style={{ background: clusterColor(x.cluster) }} />
                <span class="att-inst-cl faint">{shortName(x.cluster)}</span>
                <button class="link-btn att-inst-name ellipsis" title={`Open ${x.name}`} onClick={() => open(x, i().severity)}>
                  {x.name}
                </button>
                <span class={`att-inst-status tone-${x.tone === Tone.Neutral ? 0 : x.tone}`}>{x.status}</span>
                <span class="faint att-inst-facts ellipsis">{[...x.facts, whenText(x.when, now())].filter(Boolean).join(" · ")}</span>
                <Show when={x.resource === "pods"}>
                  <span class="att-inst-tools">
                    <button class="btn sm ghost" title="Logs" onClick={() => reveal({ cluster: x.cluster, resource: "pods", namespace: x.namespace, name: x.name, tab: "logs" })}>
                      <Icon name="logs" size={12} />
                    </button>
                    <button class="btn sm ghost" title="Events" onClick={() => reveal({ cluster: x.cluster, resource: "pods", namespace: x.namespace, name: x.name, tab: "events" })}>
                      <Icon name="event" size={12} />
                    </button>
                  </span>
                </Show>
              </div>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}
