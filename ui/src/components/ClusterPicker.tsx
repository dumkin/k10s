import { createEffect, createMemo, createSignal, For, Match, on, Show, Switch, untrack } from "solid-js";
import type { ContextInfo } from "../lib/backend";
import { assignColors, type ClusterFamily, zonesOf } from "../lib/clusters";
import { type FuzzyMatch, rank } from "../lib/fuzzy";
import { comboLabel } from "../lib/hotkeys";
import {
  type ClusterSet,
  clusterFamilies,
  clusterStatus,
  contexts,
  contextsError,
  deleteClusterSet,
  ensureConnected,
  kubeconfigPaths,
  recentClusters,
  saveClusterSet,
  savedSets,
  selectedClusters,
  setSelectedClusters,
  toggleCluster,
} from "../state/clusters";
import { ask } from "../state/ui";
import { Icon } from "./Icon";
import { createListNav, Highlight, Popover } from "./Popover";
import { ZoneChips } from "./ZoneChips";

type Item =
  | { type: "set"; set: ClusterSet }
  | { type: "family"; family: ClusterFamily }
  | { type: "ctx"; ctx: ContextInfo; match?: FuzzyMatch; group?: string };

/** Tells rows apart across changes of the list (a context is in it once). */
const itemKey = (it: Item) => (it.type === "set" ? `set:${it.set.name}` : it.type === "family" ? `family:${it.family.base}` : `ctx:${it.ctx.name}`);

export function ClusterPicker(props: { anchor: HTMLElement | undefined; onClose: () => void }) {
  const [query, setQuery] = createSignal("");
  let list: HTMLDivElement | undefined;
  // The Recent group as it was when the picker opened: picking a cluster makes it the most recent, and rows must
  // not move under the pointer (or the keyboard highlight) while picking — the next click would land on another
  // cluster and connect it, auth plugin and all. It is up to date again the next time the picker opens.
  const openedWith = untrack(recentClusters);

  const items = createMemo<Item[]>(() => {
    const q = query().trim();
    const all = contexts();
    if (q) {
      const fams = clusterFamilies().filter((f) => f.base.toLowerCase().includes(q.toLowerCase()));
      const ctxs = rank(q, all, (c) => [c.name, c.cluster, c.server ?? ""]).map(({ item, match, field }) => ({ type: "ctx" as const, ctx: item, match: field === 0 ? match : undefined }));
      return [...fams.map((family) => ({ type: "family" as const, family })), ...ctxs];
    }
    const out: Item[] = savedSets().map((set) => ({ type: "set" as const, set }));
    out.push(...clusterFamilies().map((family) => ({ type: "family" as const, family })));
    const byName = new Map(all.map((c) => [c.name, c]));
    const recent = openedWith.filter((n) => byName.has(n));
    for (const n of recent) out.push({ type: "ctx", ctx: byName.get(n)!, group: "Recent" });
    for (const c of all) if (!recent.includes(c.name)) out.push({ type: "ctx", ctx: c, group: "All contexts" });
    return out;
  });

  const nav = createListNav(() => items().length, () => list);
  // A new query starts at the top. Otherwise the highlight stays on its row when rows come or go around it (a set
  // saved or deleted, the kubeconfig read again): ↵ must not toggle the cluster that moved into its place.
  createEffect(
    on([query, items], ([q, now], prev) => {
      if (!prev) return;
      const [before, was] = prev;
      if (q !== before) return nav.reset();
      const at = was[nav.index()];
      const i = at ? now.findIndex((it) => itemKey(it) === itemKey(at)) : -1;
      if (i >= 0) nav.setIndex(i);
    }),
  );

  const selected = createMemo(() => new Set(selectedClusters()));
  const colors = createMemo(() => assignColors(selectedClusters()));

  const activate = (item: Item, only: boolean) => {
    switch (item.type) {
      case "set":
        setSelectedClusters(item.set.clusters);
        props.onClose();
        break;
      case "family": {
        const members = item.family.members;
        const allIn = members.every((m) => selected().has(m));
        if (only) setSelectedClusters(members);
        else if (allIn) {
          const rest = selectedClusters().filter((c) => !members.includes(c));
          setSelectedClusters(rest.length ? rest : [members[0]]);
        } else setSelectedClusters([...selectedClusters(), ...members]);
        break;
      }
      case "ctx":
        if (only) {
          setSelectedClusters([item.ctx.name]);
          props.onClose();
        } else toggleCluster(item.ctx.name);
        break;
    }
  };

  const saveSet = async () => {
    const res = await ask({
      title: "Save cluster set",
      body: `Saves the ${selectedClusters().length} selected clusters under a name for one-click switching.`,
      confirmLabel: "Save",
      input: { value: "", placeholder: "e.g. prod apps · all DCs" },
    });
    const name = res?.input?.trim();
    if (name) saveClusterSet(name);
  };

  const groupHeader = (i: number) => {
    const it = items()[i];
    const prev = items()[i - 1];
    const label = it.type === "set" ? "Saved sets" : it.type === "family" ? "Zone groups" : it.group ?? (query() ? "Contexts" : undefined);
    const prevLabel = !prev ? undefined : prev.type === "set" ? "Saved sets" : prev.type === "family" ? "Zone groups" : prev.group ?? (query() ? "Contexts" : undefined);
    return label !== prevLabel ? label : undefined;
  };

  return (
    <Popover anchor={props.anchor} onClose={props.onClose} width={460} maxHeight={600}>
      <div class="pop-search search-field">
        <Icon name="search" size={14} />
        <input
          class="input"
          aria-label="Clusters"
          placeholder={`Search ${contexts().length} contexts…`}
          value={query()}
          onInput={(e) => setQuery(e.currentTarget.value)}
          onKeyDown={(e) => nav.onKeyDown(e, (i, ev) => activate(items()[i], ev.metaKey || ev.ctrlKey || ev.shiftKey))}
          ref={(el) => queueMicrotask(() => el.focus())}
        />
      </div>
      <div class="pop-list" ref={list}>
        <Show when={contextsError()}>
          <div class="opt" style={{ color: "var(--err)" }}>
            <Icon name="alert" size={15} />
            <span class="selectable">{contextsError()}</span>
          </div>
        </Show>
        <Show when={!contextsError() && contexts().length === 0}>
          <div class="opt faint">No contexts found in {kubeconfigPaths().join(", ") || "~/.kube/config"}</div>
        </Show>
        <For each={items()}>
          {(item, i) => (
            <>
              <Show when={groupHeader(i())}>{(label) => <div class="pop-group">{label()}</div>}</Show>
              <Switch>
                <Match when={item.type === "set" && item}>
                  {(it) => (
                    <button class="opt" role="option" aria-selected={nav.index() === i()} tabIndex={-1} classList={{ hl: nav.index() === i() }} onMouseDown={(e) => e.preventDefault()} onMouseMove={(e) => nav.hover(i(), e)} onClick={() => activate(it(), true)}>
                      <Icon name="star" size={14} style={{ color: "var(--warn)" }} />
                      <span class="ellipsis">{it().set.name}</span>
                      <span class="sub">{it().set.clusters.length} clusters</span>
                      <span class="opt-actions">
                        <span
                          class="btn sm ghost icon"
                          title="Delete set"
                          onClick={(e) => {
                            e.stopPropagation();
                            deleteClusterSet(it().set.name);
                          }}
                        >
                          <Icon name="trash" size={12} />
                        </span>
                      </span>
                    </button>
                  )}
                </Match>
                <Match when={item.type === "family" && item}>
                  {(it) => {
                    const members = () => it().family.members;
                    const count = () => members().filter((m) => selected().has(m)).length;
                    return (
                      <button class="opt" role="option" aria-selected={nav.index() === i()} tabIndex={-1} classList={{ hl: nav.index() === i() }} onMouseDown={(e) => e.preventDefault()} onMouseMove={(e) => nav.hover(i(), e)} onClick={(e) => activate(it(), e.metaKey || e.ctrlKey)}>
                        <span class="check" classList={{ on: count() === members().length }}>
                          <Show when={count() > 0}>
                            <Icon name={count() === members().length ? "check" : "minus"} size={11} strokeWidth={3} />
                          </Show>
                        </span>
                        <Icon name="layers" size={14} style={{ color: "var(--accent-text)" }} />
                        <span class="ellipsis family-name" title={it().family.base}>
                          {it().family.base}
                        </span>
                        <ZoneChips zones={zonesOf(members())} title={members().join("\n")} />
                        <span class="opt-actions">
                          <span
                            class="btn sm ghost"
                            onClick={(e) => {
                              e.stopPropagation();
                              activate(it(), true);
                            }}
                          >
                            Only
                          </span>
                        </span>
                      </button>
                    );
                  }}
                </Match>
                <Match when={item.type === "ctx" && item}>
                  {(it) => {
                    const name = () => it().ctx.name;
                    const on = () => selected().has(name());
                    const st = () => clusterStatus[name()];
                    return (
                      <button class="opt" role="option" aria-selected={nav.index() === i()} tabIndex={-1} classList={{ hl: nav.index() === i() }} onMouseDown={(e) => e.preventDefault()} onMouseMove={(e) => nav.hover(i(), e)} onClick={(e) => activate(it(), e.metaKey || e.ctrlKey)}>
                        <span class="check" classList={{ on: on() }}>
                          <Icon name="check" size={11} strokeWidth={3} />
                        </span>
                        <span class="swatch" style={{ background: on() ? colors().get(name()) : "transparent" }} />
                        <span class="ellipsis grow">
                          <Highlight text={name()} indices={it().match?.indices} />
                        </span>
                        <Switch>
                          <Match when={st()?.state === "connecting"}>
                            <span class="spinner" />
                          </Match>
                          <Match when={st()?.state === "error"}>
                            <span class="badge err" title={st()?.message}>
                              error
                            </span>
                          </Match>
                          <Match when={st()?.state === "connected"}>
                            <span class="sub">{st()?.version}</span>
                          </Match>
                          <Match when={true}>
                            <span class="sub">{it().ctx.auth}</span>
                          </Match>
                        </Switch>
                        <span class="opt-actions">
                          <Show when={st()?.state === "error"}>
                            <span
                              class="btn sm ghost icon"
                              title="Retry"
                              onClick={(e) => {
                                e.stopPropagation();
                                void ensureConnected(name(), true);
                              }}
                            >
                              <Icon name="refresh" size={12} />
                            </span>
                          </Show>
                          <span
                            class="btn sm ghost"
                            onClick={(e) => {
                              e.stopPropagation();
                              activate(it(), true);
                            }}
                          >
                            Only
                          </span>
                        </span>
                      </button>
                    );
                  }}
                </Match>
              </Switch>
            </>
          )}
        </For>
      </div>
      <div class="pop-foot">
        <span>
          <b style={{ color: "var(--text)" }}>{selectedClusters().length}</b> selected
        </span>
        <span class="faint">
          ↵ toggle · {comboLabel("mod+enter")} only
        </span>
        <span class="grow" />
        <button class="btn sm ghost" onClick={saveSet} disabled={selectedClusters().length < 2}>
          <Icon name="star" size={12} /> Save set
        </button>
      </div>
    </Popover>
  );
}
