import { type Accessor, createEffect, createMemo, createSignal, Match, on, Show, Switch, untrack } from "solid-js";
import { type FuzzyMatch, rank } from "../lib/fuzzy";
import { comboLabel } from "../lib/hotkeys";
import { isValidNamespace, normalizeNamespace } from "../lib/k8s";
import { ensureConnected, isMultiCluster, selectedClusters, shortName } from "../state/clusters";
import { forgetNamespace, kubeconfigNamespaces, namespaces, rememberedNamespaces, setNamespaces, toggleNamespace } from "../state/nav";
import { namespaceErrors, namespaceOptions, nsNames } from "../state/views";
import { Icon } from "./Icon";
import { createListNav, Highlight, Popover } from "./Popover";
import { VirtualList, type VirtualListHandle } from "./VirtualList";

type NsItem = {
  type: "ns";
  name: string;
  clusters: number;
  match?: FuzzyMatch;
  group: string;
  /** Remembered from earlier visits: can be forgotten (×). */
  remembered?: boolean;
  /** No selected cluster lists it (they can't list namespaces, or it is not there). */
  notListed?: boolean;
};
type Item = { type: "all" } | NsItem | { type: "custom"; name: string };
/** A list row: a group header or an item (`i` = its index among items, for keyboard navigation). */
type Line = { header: string } | { item: Item; i: number };

const ROW_H = 30;
/** Remembered namespaces that are listed anyway are shown first only up to this many (they are in the list below too). */
const RECENT_SHOWN = 10;
const NOT_LISTED = "Not listed";

const groupOf = (it: Item) => (it.type === "ns" ? it.group : it.type === "custom" ? NOT_LISTED : undefined);

export function NamespacePicker(props: { anchor: HTMLElement | undefined; onClose: () => void }) {
  const [query, setQuery] = createSignal("");
  let listEl: HTMLDivElement | undefined;
  let list: VirtualListHandle | undefined;

  const known = createMemo(() => new Set(namespaceOptions().map((o) => o.name)));
  const fromKubeconfig = createMemo(() => kubeconfigNamespaces());
  // Remembered namespaces keep the order they had when the picker opened: opening one makes it the most
  // recent, and rows must not move under the cursor (or the pointer) while picking. Forgotten ones go at
  // once; ones remembered meanwhile (a name just typed that opened) come last.
  const openedWith = untrack(() => rememberedNamespaces());
  const remembered = createMemo(() => {
    const live = rememberedNamespaces();
    const now = new Set(live);
    const before = new Set(openedWith);
    return [...openedWith.filter((n) => now.has(n)), ...live.filter((n) => !before.has(n))];
  });

  const forbidden = createMemo(() => namespaceErrors().filter((e) => e.forbidden));
  const failed = createMemo(() => namespaceErrors().filter((e) => !e.forbidden));
  /** No selected cluster lets us list namespaces (typical with strict RBAC). */
  const listingBlocked = createMemo(() => forbidden().length > 0 && forbidden().length >= selectedClusters().length);
  /** No selected cluster lists namespaces, whatever the reason: typing a name is the only way in. */
  const noListing = createMemo(() => namespaceErrors().length > 0 && namespaceErrors().length >= selectedClusters().length);
  const items = createMemo<Item[]>(() => {
    const q = normalizeNamespace(query());
    const opts = namespaceOptions();
    // Signals are read once here, not per namespace: there can be tens of thousands.
    const listedSet = known();
    const kubeconfig = fromKubeconfig();
    const memory = remembered();
    const selectedNow = namespaces();
    /** "Not in the list" means something only once the list is complete (or there is none). */
    const settled = noListing() || !nsNames.loading();
    const notListed = (name: string) => settled && !listedSet.has(name);
    // The kubeconfig's namespaces stay offered whatever is forgotten: only the others can be.
    const kubeconfigSet = new Set(kubeconfig);
    const rememberedSet = new Set(memory);
    const ns = (name: string, clusters: number, group: string, match?: FuzzyMatch): NsItem => ({
      type: "ns",
      name,
      clusters,
      match,
      group,
      remembered: rememberedSet.has(name) && !kubeconfigSet.has(name),
      notListed: notListed(name),
    });
    if (q) {
      // Namespaces the kubeconfig sets or the user typed before (when listing is forbidden) are searchable too.
      const extra = [...new Set([...kubeconfig, ...memory])].filter((n) => !listedSet.has(n));
      const pool = [...opts, ...extra.map((name) => ({ name, clusters: 0 }))];
      const ranked: Item[] = rank(q, pool, (o) => [o.name]).map(({ item, match }) => ns(item.name, item.clusters, "Namespaces", match));
      if (listedSet.has(q) || pool.some((o) => o.name === q)) return ranked;
      // An exact typed name goes first when nothing can be listed — that's the main way in.
      return noListing() ? [{ type: "custom", name: q }, ...ranked] : [...ranked, { type: "custom", name: q }];
    }
    const out: Item[] = [{ type: "all" }];
    const shown = new Set<string>();
    const counts = new Map<string, number>();
    const wanted = new Set([...kubeconfig, ...memory, ...selectedNow]);
    if (wanted.size) for (const o of opts) if (wanted.has(o.name)) counts.set(o.name, o.clusters);
    const add = (name: string, group: string) => {
      if (shown.has(name)) return;
      shown.add(name);
      out.push(ns(name, counts.get(name) ?? 0, group));
    };
    // What kubectl would use for these contexts comes first.
    for (const n of kubeconfig) add(n, "From kubeconfig");
    for (const n of memory.filter((n) => !notListed(n) && !shown.has(n)).slice(0, RECENT_SHOWN)) add(n, "Recent");
    for (const n of memory) if (notListed(n)) add(n, NOT_LISTED);
    for (const n of selectedNow) if (!listedSet.has(n)) add(n, "Selected");
    for (const o of opts) if (!shown.has(o.name)) out.push(ns(o.name, o.clusters, "Namespaces"));
    return out;
  });

  const lines = createMemo<Line[]>(() => {
    const out: Line[] = [];
    let prev: string | undefined;
    items().forEach((item, i) => {
      const g = groupOf(item);
      if (g && g !== prev) out.push({ header: g });
      prev = g;
      out.push({ item, i });
    });
    return out;
  });
  const lineOf = createMemo(() => {
    const at: number[] = [];
    lines().forEach((l, n) => {
      if ("item" in l) at[l.i] = n;
    });
    return at;
  });

  const nav = createListNav(
    () => items().length,
    () => listEl,
    (i) => list?.reveal(lineOf()[i] ?? 0),
  );
  createEffect(on(query, () => nav.reset(), { defer: true }));

  const selected = createMemo(() => new Set(namespaces()));

  const activate = (item: Item, only: boolean) => {
    if (item.type === "all") {
      setNamespaces([]);
      props.onClose();
      return;
    }
    if (item.type === "custom" && !isValidNamespace(item.name)) return;
    if (only) {
      setNamespaces([item.name]);
      props.onClose();
    } else toggleNamespace(item.name);
    if (item.type === "custom") setQuery("");
  };

  // Failures that may pass (network, timeout, expired credentials): reconnecting the clusters lists again.
  const [retrying, setRetrying] = createSignal(false);
  const retry = async () => {
    setRetrying(true);
    try {
      await Promise.all([...new Set(failed().map((e) => e.cluster))].map((c) => ensureConnected(c, true)));
    } finally {
      setRetrying(false);
    }
  };
  const clusterList = (errs: { cluster: string }[]) => errs.map((e) => shortName(e.cluster)).join(", ");

  const Row = (p: { line: Accessor<{ item: Item; i: number }> }) => {
    const item = () => p.line().item;
    const i = () => p.line().i;
    const isAll = () => item().type === "all";
    const isCustom = () => item().type === "custom";
    const name = () => {
      const it = item();
      return it.type === "all" ? "" : it.name;
    };
    const clusters = () => {
      const it = item();
      return it.type === "ns" ? it.clusters : 0;
    };
    const indices = () => {
      const it = item();
      return it.type === "ns" ? it.match?.indices : undefined;
    };
    const ns = () => {
      const it = item();
      return it.type === "ns" ? it : undefined;
    };
    /** The group header says it already. */
    const markNotListed = () => !!ns()?.notListed && ns()?.group !== NOT_LISTED;
    return (
      <button
        class="opt"
        role="option"
        aria-selected={nav.index() === i()}
        // The search field keeps the keyboard: rows are picked with ↑ ↓ and ↵ there (or clicked).
        tabIndex={-1}
        classList={{ hl: nav.index() === i() }}
        onMouseDown={(e) => e.preventDefault()}
        onMouseMove={(e) => nav.hover(i(), e)}
        onClick={(e) => activate(item(), isAll() || e.metaKey || e.ctrlKey)}
      >
        <span class="check" classList={{ on: isAll() ? namespaces().length === 0 : selected().has(name()) }}>
          <Icon name="check" size={11} strokeWidth={3} />
        </span>
        <Switch fallback={<Icon name="namespace" size={14} style={{ color: "var(--text-3)" }} />}>
          <Match when={isAll()}>
            <Icon name="globe" size={14} style={{ color: "var(--accent-text)" }} />
          </Match>
          <Match when={isCustom()}>
            <Icon name="plus" size={14} style={{ color: "var(--accent-text)" }} />
          </Match>
        </Switch>
        <span class="ellipsis grow">
          <Switch fallback={<Highlight text={name()} indices={indices()} />}>
            <Match when={isAll()}>
              <span style={{ "font-weight": 600 }}>All namespaces</span>
            </Match>
            <Match when={isCustom()}>
              <Show when={isValidNamespace(name())} fallback={<span class="faint">“{name()}” is not a valid namespace name</span>}>
                Open namespace “{name()}”
              </Show>
            </Match>
          </Switch>
        </span>
        <Show when={isAll() && nsNames.loading()}>
          <span class="spinner" style={{ "margin-left": "auto" }} />
        </Show>
        <Show when={isMultiCluster() && clusters() > 0}>
          <span class="sub" title="Clusters that have this namespace">
            {clusters()}/{selectedClusters().length}
          </span>
        </Show>
        <Show when={markNotListed()}>
          <span class="sub" title="None of the selected clusters lists it">
            not listed
          </span>
        </Show>
        <Show when={!isAll()}>
          <span class="opt-actions">
            <span
              class="btn sm ghost"
              onClick={(e) => {
                e.stopPropagation();
                activate(item(), true);
              }}
            >
              Only
            </span>
            <Show when={ns()?.remembered}>
              <span
                class="btn sm ghost icon"
                title="Forget this namespace"
                onClick={(e) => {
                  e.stopPropagation();
                  forgetNamespace(name());
                }}
              >
                <Icon name="x" size={12} />
              </span>
            </Show>
          </span>
        </Show>
      </button>
    );
  };

  return (
    <Popover anchor={props.anchor} onClose={props.onClose} width={360} maxHeight={560}>
      <div class="pop-search search-field">
        <Icon name="search" size={14} />
        <input
          class="input"
          aria-label="Namespaces"
          placeholder={noListing() ? "Type a namespace name…" : "Search or type a namespace…"}
          value={query()}
          onInput={(e) => setQuery(e.currentTarget.value)}
          onKeyDown={(e) => nav.onKeyDown(e, (i, ev) => activate(items()[i], ev.metaKey || ev.ctrlKey || ev.shiftKey))}
          ref={(el) => queueMicrotask(() => el.focus())}
        />
      </div>
      <Show when={forbidden().length}>
        <div class="ns-hint" title={forbidden().map((e) => `${e.cluster}: ${e.message}`).join("\n")}>
          <Icon name="lock" size={13} />
          <span>
            <Show
              when={listingBlocked()}
              fallback={
                <>
                  Can't list namespaces in <b>{clusterList(forbidden())}</b>
                  {noListing() ? "." : " — showing the rest."}
                </>
              }
            >
              You can't list namespaces here. <b>Type the namespace name</b> and press ↵ — once it opens, it is remembered for {isMultiCluster() ? "these clusters" : "this cluster"}.
            </Show>
          </span>
        </div>
      </Show>
      <Show when={failed().length}>
        <div class="ns-hint ns-error" style={{ background: "var(--err-soft)" }} title={failed().map((e) => `${e.cluster}: ${e.message}`).join("\n")}>
          <Icon name="alert" size={13} style={{ color: "var(--err)" }} />
          <span class="grow" style={{ "min-width": 0 }}>
            Couldn't load namespaces from <b>{clusterList(failed())}</b>.
            <span class="selectable" style={{ display: "block", "word-break": "break-word" }}>
              {failed()[0].title}: {failed()[0].message}
              {failed().length > 1 ? ` (and ${failed().length - 1} more)` : ""}
            </span>
          </span>
          <button class="btn sm" disabled={retrying()} onClick={() => void retry()} title="Reconnect and list again">
            <Show when={retrying()} fallback={<Icon name="refresh" size={12} />}>
              <span class="spinner" style={{ width: "10px", height: "10px" }} />
            </Show>
            Retry
          </button>
        </div>
      </Show>
      <VirtualList
        class="pop-list"
        items={lines()}
        rowHeight={ROW_H}
        ref={(el, handle) => {
          listEl = el;
          list = handle;
        }}
      >
        {(line) => (
          <Show when={"item" in line() && (line() as { item: Item; i: number })} fallback={<div class="pop-group">{(line() as { header: string }).header}</div>}>
            {(l) => <Row line={l} />}
          </Show>
        )}
      </VirtualList>
      <div class="pop-foot">
        <span>{namespaces().length ? `${namespaces().length} selected` : "All namespaces"}</span>
        <span class="faint">
          ↵ toggle · {comboLabel("mod+enter")} only
        </span>
        <span class="grow" />
        <Show when={namespaces().length > 0}>
          <button class="btn sm ghost" onClick={() => setNamespaces([])}>
            Clear
          </button>
        </Show>
      </div>
    </Popover>
  );
}
