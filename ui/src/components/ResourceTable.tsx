import { type Accessor, batch, createEffect, createMemo, createSignal, For, Index, Match, on, onCleanup, onMount, Show, type Signal, Switch, untrack } from "solid-js";
import { age } from "../lib/format";
import { errorTitle, isAuthFailure, isAuthFailureMessage, isError, isForbidden, isValidNamespace, normalizeNamespace } from "../lib/k8s";
import { columnKind } from "../registry/columns";
import { metricsNotices } from "../state/metrics";
import { clusterColor, clusterStatus, contexts, ensureConnected, retryCluster, selectedClusters, shortName } from "../state/clusters";
import {
  backTarget,
  currentResource,
  filter,
  forgetNamespace,
  goBack,
  kubeconfigNamespaces,
  marked,
  markTo,
  namespaces,
  openDetails,
  REVEAL_TIMEOUT_MS,
  rememberedNamespaces,
  resourceTitle,
  selectedKey,
  setFilter,
  setNamespaces,
  setSelectedKey,
  toggleMark,
} from "../state/nav";
import { previewColumnWidth, setColumnWidth, sort, type TableColumn, type TableModel, toggleSort } from "../state/table";
import { dialog, now, paletteOpen, pickerOpen } from "../state/ui";
import type { FeedState, UIRow, ViewFeed } from "../state/view";
import { Icon } from "./Icon";

export const ROW_H = 28;
const HEAD_H = 31;
const OVERSCAN = 6;
const DOT_COL = 26;

export interface TableHandle {
  scrollToIndex(i: number): void;
  pageSize(): number;
}

export function ResourceTable(props: {
  feed: ViewFeed;
  model: TableModel;
  title: string;
  onContextMenu: (row: UIRow, e: MouseEvent) => void;
  ref?: (h: TableHandle) => void;
}) {
  let scroller!: HTMLDivElement;
  const [scrollTop, setScrollTop] = createSignal(0);
  const [viewport, setViewport] = createSignal(800);

  const rows = props.model.sorted;
  const cols = props.model.columns;
  const total = () => rows().length;
  const start = createMemo(() => Math.max(0, Math.floor(scrollTop() / ROW_H) - OVERSCAN));
  const end = createMemo(() => Math.min(total(), Math.ceil((scrollTop() + viewport() - HEAD_H) / ROW_H) + OVERSCAN));
  const windowRows = createMemo(() => rows().slice(start(), end()));

  const grid = createMemo(() => `${DOT_COL}px ${cols().map((c) => (c.flex ? `minmax(${c.width}px, 1fr)` : `${c.width}px`)).join(" ")}`);
  const minWidth = createMemo(() => DOT_COL + cols().reduce((n, c) => n + c.width, 0));

  const scrollToIndex = (i: number) => {
    if (!scroller) return;
    const top = i * ROW_H;
    const viewH = scroller.clientHeight - HEAD_H;
    if (top < scroller.scrollTop) scroller.scrollTop = top;
    else if (top + ROW_H > scroller.scrollTop + viewH) scroller.scrollTop = top + ROW_H - viewH;
  };

  onMount(() => {
    const ro = new ResizeObserver(() => setViewport(scroller.clientHeight));
    ro.observe(scroller);
    onCleanup(() => ro.disconnect());
    props.ref?.({ scrollToIndex, pageSize: () => Math.max(1, Math.floor((scroller.clientHeight - HEAD_H) / ROW_H) - 1) });
  });

  // Keep the selected row visible when it changes (keyboard navigation, reveal, back…). A row that
  // isn't loaded yet (going back to another resource) is scrolled to once it shows up.
  let scrollPending: { key: string; until: number } | null = null;
  createEffect(
    on(selectedKey, (key) => {
      scrollPending = null;
      if (!key) return;
      const i = untrack(() => props.model.indexOf(key));
      if (i !== undefined) queueMicrotask(() => scrollToIndex(i));
      else scrollPending = { key, until: Date.now() + REVEAL_TIMEOUT_MS };
    }),
  );
  createEffect(
    on(rows, () => {
      if (!scrollPending) return;
      const i = props.model.indexOf(scrollPending.key);
      if (i === undefined && Date.now() < scrollPending.until) return;
      scrollPending = null;
      if (i !== undefined) queueMicrotask(() => scrollToIndex(i));
    }),
  );

  const indexFromEvent = (e: MouseEvent): number | undefined => {
    const el = (e.target as HTMLElement).closest<HTMLElement>("[data-i]");
    return el ? Number(el.dataset.i) : undefined;
  };
  const rowFromEvent = (e: MouseEvent): UIRow | undefined => {
    const i = indexFromEvent(e);
    return i === undefined ? undefined : rows()[i];
  };

  const onMouseDown = (e: MouseEvent) => {
    const i = indexFromEvent(e);
    const row = i === undefined ? undefined : rows()[i];
    if (e.button !== 0 || i === undefined || !row) return;
    if (e.metaKey || e.ctrlKey) toggleMark(row.key);
    // The rows from the selected one to this one, as ⇧J / ⇧K mark them (and go on from here).
    else if (e.shiftKey) markTo(rows(), i, props.model.indexOf);
    else setSelectedKey(row.key);
  };

  const startResize = (e: MouseEvent, col: TableColumn) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startW = col.width;
    let width: number | null = null;
    let frame = 0;
    // The new width shows at most once a frame, and is saved once, when the drag ends.
    const move = (ev: MouseEvent) => {
      width = Math.max(48, startW + ev.clientX - startX);
      frame ||= requestAnimationFrame(() => {
        frame = 0;
        if (width !== null) previewColumnWidth(col.id, width);
      });
    };
    const up = () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      if (width !== null) setColumnWidth(col.id, width);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  return (
    <div class="table">
      <div
        class="tscroll"
        ref={scroller}
        tabIndex={-1}
        role="grid"
        aria-label={props.title}
        aria-rowcount={total() + 1}
        aria-colcount={cols().length + 1}
        aria-multiselectable="true"
        onScroll={() => setScrollTop(scroller.scrollTop)}
        style={{ "--grid": grid(), "--grid-min": `${minWidth()}px` }}
      >
        <div class="thead" role="row" aria-rowindex={1}>
          <div class="th" role="columnheader" aria-label="Status" />
          <For each={cols()}>
            {(c) => (
              <div
                class="th"
                role="columnheader"
                aria-sort={sort().col === c.id ? (sort().desc ? "descending" : "ascending") : "none"}
                classList={{ sorted: sort().col === c.id, r: c.align === "right" }}
                onClick={() => toggleSort(c.id)}
                title={c.description ?? c.title}
              >
                <span class="ellipsis">{c.title}</span>
                <Show when={sort().col === c.id}>
                  <Icon name={sort().desc ? "chevron-down" : "chevron-up"} size={11} strokeWidth={2.4} />
                </Show>
                <span class="col-resize" onMouseDown={(e) => startResize(e, c)} onClick={(e) => e.stopPropagation()} />
              </div>
            )}
          </For>
        </div>
        <div
          class="tbody"
          role="rowgroup"
          style={{ height: `${total() * ROW_H}px` }}
          onMouseDown={onMouseDown}
          onDblClick={(e) => {
            const row = rowFromEvent(e);
            if (row) openDetails(row.key);
          }}
          onContextMenu={(e) => {
            const row = rowFromEvent(e);
            if (!row) return;
            e.preventDefault();
            if (!marked().has(row.key)) setSelectedKey(row.key);
            props.onContextMenu(row, e);
          }}
        >
          <div class="rows" style={{ transform: `translateY(${start() * ROW_H}px)` }}>
            <Index each={windowRows()}>{(row, i) => <RowView row={row} index={() => start() + i} cols={cols} />}</Index>
          </div>
        </div>
      </div>
      <ColumnNotices feed={props.feed} />
      <TableOverlay feed={props.feed} model={props.model} title={props.title} />
    </div>
  );
}

/**
 * Why kind-specific columns are missing on some clusters (the engine found no printer columns there), grouped
 * by reason: an empty column then reads as "unknown here", not as "empty".
 */
function ColumnNotices(p: { feed: ViewFeed }) {
  const groups = createMemo(() => {
    const by = new Map<string, string[]>();
    // The engine's (printer columns), and why usage is missing (metrics), each grouped by reason.
    for (const notices of [p.feed.notices ?? {}, metricsNotices()]) for (const [cluster, message] of Object.entries(notices)) if (message) by.set(message, [...(by.get(message) ?? []), cluster]);
    return [...by].map(([message, clusters]) => ({ message, clusters: clusters.sort() }));
  });
  return (
    <Show when={groups().length}>
      <div
        class="columns-notice selectable"
        role="status"
        style={{
          flex: "none",
          display: "flex",
          "flex-direction": "column",
          gap: "2px",
          padding: "5px 10px",
          "border-top": "1px solid var(--border)",
          background: "var(--bg-panel)",
          color: "var(--text-3)",
          "font-size": "var(--fs-xs)",
        }}
      >
        <For each={groups()}>
          {(g) => (
            <div style={{ display: "flex", "align-items": "center", gap: "6px", "min-width": "0" }} title={`${g.clusters.join(", ")}: ${g.message}`}>
              <Icon name="info" size={12} />
              <b style={{ color: "var(--text-2)", "font-weight": "600" }}>{g.clusters.map(shortName).join(", ")}</b>
              <span class="ellipsis">{g.message}</span>
            </div>
          )}
        </For>
      </div>
    </Show>
  );
}

function RowView(p: { row: Accessor<UIRow>; index: Accessor<number>; cols: Accessor<TableColumn[]> }) {
  return (
    <div
      class="tr"
      role="row"
      aria-rowindex={p.index() + 2}
      aria-selected={selectedKey() === p.row().key || marked().has(p.row().key)}
      data-i={p.index()}
      classList={{ sel: selectedKey() === p.row().key, mark: marked().has(p.row().key), terminating: !!p.row().x }}
    >
      <div class="td c-status" role="gridcell">
        <span class={`dot tone-${p.row().s}`} />
      </div>
      <For each={p.cols()}>{(col) => <CellView col={col} row={p.row} />}</For>
    </div>
  );
}

function CellView(p: { col: TableColumn; row: Accessor<UIRow> }) {
  const c = p.col;
  switch (c.special) {
    case "name":
      return (
        <div class="td name" role="gridcell" title={p.row().n}>
          {p.row().n}
        </div>
      );
    case "namespace":
      return (
        <div class="td ns" role="gridcell">
          {p.row().ns ?? ""}
        </div>
      );
    case "cluster":
      return (
        <div class="td" role="gridcell" title={p.row().cl}>
          <span class="cl">
            <span class="swatch" style={{ background: clusterColor(p.row().cl) }} />
            {shortName(p.row().cl)}
          </span>
        </div>
      );
    case "age":
      return (
        <div class="td r faint-cell" role="gridcell">
          {age(p.row().t, now())}
        </div>
      );
  }
  const def = columnKind(c.kind);
  const cell = () => (c.cell ? c.cell(p.row()) : (p.row().c[c.index] ?? null));
  const t = def.live ? () => now() : () => 0;
  const text = () => def.text(cell(), t());
  const tone = () => def.tone?.(cell(), t());
  if (def.dot) {
    return (
      <div class="td st" role="gridcell" title={text()}>
        <Show when={text()} fallback={<span class="faint">—</span>}>
          <span class={`dot tone-${tone() ?? 0}`} />
          <span class={`ellipsis ${tone() === 2 || tone() === 3 || tone() === 4 ? `tone-${tone()}` : ""}`}>{text()}</span>
        </Show>
      </div>
    );
  }
  return (
    <div
      role="gridcell"
      class={`td ${c.align === "right" ? "r" : ""} ${tone() !== undefined ? `tone-${tone()}` : ""}`}
      classList={{ "empty-cell": text() === "" }}
      title={def.title ? def.title(cell()) : c.kind === "text" || c.kind === "labels" ? text() : undefined}
    >
      {text()}
    </div>
  );
}

function TableOverlay(p: { feed: ViewFeed; model: TableModel; title: string }) {
  const empty = () => p.model.sorted().length === 0;
  const statuses = createMemo(() => Object.values(p.feed.statuses).filter(Boolean));
  const errors = createMemo(() => statuses().filter((s) => isError(s)));
  /** Every cluster that answered only with errors (nothing loading or ready). */
  const allFailed = () => {
    const by = new Map<string, boolean>();
    for (const s of statuses()) by.set(s.c, (by.get(s.c) ?? true) && s.state === "error");
    return by.size > 0 && [...by.values()].every(Boolean);
  };
  /** Clusters that refused every list (403): at cluster scope, or in every namespace open. */
  const forbidden = createMemo(() => {
    const by = new Map<string, boolean>();
    for (const s of statuses()) by.set(s.c, (by.get(s.c) ?? true) && isForbidden(s));
    return new Set([...by].flatMap(([c, all]) => (all ? [c] : [])));
  });
  /** What failed on the other clusters. */
  const others = createMemo(() => errors().filter((e) => !forbidden().has(e.c)));
  /** The other clusters that have not answered yet (and failed nowhere). */
  const waiting = createMemo(() => {
    const failed = new Set(others().map((e) => e.c));
    return [...new Set(statuses().flatMap((s) => ((s.state === "connecting" || s.state === "loading") && !failed.has(s.c) ? [s.c] : [])))];
  });
  /**
   * The "no access" screen: some cluster may not list here and no cluster has rows. Also while others are still
   * loading — an unreachable one takes up to a minute to fail — and when they failed otherwise: listed below it.
   */
  const noAccess = () => forbidden().size > 0 && p.feed.rows().length === 0;
  // What was typed on the "no access" screen: it is mounted again whenever the view reloads (a reconnect, a
  // cluster toggled in the picker), and must not lose it.
  const draft = createSignal("");
  // Avoid flashing the empty state during sub-100ms switches.
  const [settled, setSettled] = createSignal(false);
  createEffect(
    on(
      () => p.feed.loading(),
      (loading) => {
        if (loading) {
          setSettled(false);
          const t = setTimeout(() => setSettled(true), 120);
          onCleanup(() => clearTimeout(t));
        } else setSettled(true);
      },
    ),
  );

  return (
    <Show when={empty() && settled()}>
      <div class="table-empty">
        <Switch
          fallback={
            <>
              <span class="empty-icon">
                <Icon name="search" size={22} />
              </span>
              <h3>No {p.title.toLowerCase()} here</h3>
              <p>Nothing matches in the selected clusters and namespaces.</p>
            </>
          }
        >
          <Match when={noAccess()}>
            <AccessCta
              title={p.title}
              errors={errors().filter((e) => forbidden().has(e.c))}
              others={others()}
              waiting={waiting()}
              partial={forbidden().size < new Set(statuses().map((s) => s.c)).size}
              draft={draft}
            />
          </Match>
          <Match when={p.feed.loading() && !allFailed()}>
            <div style={{ position: "absolute", inset: "0", "pointer-events": "none" }}>
              <For each={Array.from({ length: 12 })}>
                {(_, i) => (
                  <div class="skeleton-row" style={{ opacity: 1 - i() * 0.07 }}>
                    <span style={{ width: "8px", "border-radius": "50%" }} />
                    <span style={{ width: `${180 + ((i() * 37) % 120)}px` }} />
                    <span style={{ width: "60px" }} />
                    <span style={{ width: "90px" }} />
                    <span style={{ width: "50px", "margin-left": "auto" }} />
                  </div>
                )}
              </For>
            </div>
          </Match>
          <Match when={allFailed()}>
            <span class="empty-icon err">
              <Icon name="alert" size={22} />
            </span>
            <h3>Could not load {p.title.toLowerCase()}</h3>
            <ErrorList errors={errors()} />
            <NextSteps errors={errors()} />
          </Match>
          <Match when={filter()}>
            <span class="empty-icon">
              <Icon name="filter" size={22} />
            </span>
            <h3>No matches for “{filter()}”</h3>
            <button class="btn" onClick={() => batch(() => setFilter(""))}>
              Clear filter
            </button>
          </Match>
        </Switch>
      </div>
    </Show>
  );
}

function ErrorList(p: { errors: FeedState[] }) {
  return (
    <div class="error-list">
      <For each={p.errors.slice(0, 8)}>
        {(e) => (
          <div class="selectable">
            <span class="swatch" style={{ background: clusterColor(e.c) }} />
            <b>{shortName(e.c)}</b>
            {e.ns ? <span class="faint"> / {e.ns}</span> : null}
            <span class="faint"> — </span>
            {isError(e) ? `${errorTitle(e)}: ${e.message}` : ""}
          </div>
        )}
      </For>
      <Show when={p.errors.length > 8}>
        <div class="faint">…and {p.errors.length - 8} more</div>
      </Show>
    </div>
  );
}

/** Clusters by their short names, at most `max` of them: "z1, z2 and 3 more". */
function clusterNames(list: string[], max: number): string {
  const names = list.slice(0, max).map(shortName).join(", ");
  return list.length > max ? `${names} and ${list.length - max} more` : names;
}

/**
 * The way on from failures that may pass: Retry (see `retryCluster`), and Reconnect where credentials were
 * rejected or could not be had — fresh ones are what is missing then, and only Reconnect runs the auth plugin
 * again. Nothing for "no access" (403): trying again changes nothing there.
 */
function NextSteps(p: { errors: FeedState[] }) {
  const clusters = createMemo(() => {
    const reconnect = new Set<string>();
    const retry = new Set<string>();
    for (const e of p.errors) {
      if (isForbidden(e)) continue;
      // A connection refused for its credentials is the cluster's error in the view, as the engine words it.
      if (isAuthFailure(e) || isAuthFailureMessage(clusterStatus[e.c]?.message)) reconnect.add(e.c);
      else retry.add(e.c);
    }
    return { reconnect: [...reconnect], retry: [...retry].filter((c) => !reconnect.has(c)) };
  });
  const [busy, setBusy] = createSignal<"reconnect" | "retry" | null>(null);
  const run = async (which: "reconnect" | "retry") => {
    setBusy(which);
    try {
      await Promise.all(clusters()[which].map((c) => (which === "reconnect" ? ensureConnected(c, true) : retryCluster(c))));
    } finally {
      setBusy(null);
    }
  };
  const names = (list: string[]) => clusterNames(list, 10);
  const icon = (which: "reconnect" | "retry") => (
    <Show when={busy() === which} fallback={<Icon name={which === "reconnect" ? "user" : "refresh"} size={13} />}>
      <span class="spinner" style={{ width: "11px", height: "11px" }} />
    </Show>
  );
  return (
    <Show when={clusters().reconnect.length || clusters().retry.length}>
      <div class="cta-actions">
        <Show when={clusters().reconnect.length}>
          <button class="btn" disabled={!!busy()} title={`Sign in to ${names(clusters().reconnect)} again: fresh credentials from the kubeconfig's auth plugin`} onClick={() => void run("reconnect")}>
            {icon("reconnect")}
            Reconnect
          </button>
        </Show>
        <Show when={clusters().retry.length}>
          <button class="btn" disabled={!!busy()} title={`Try ${names(clusters().retry)} again`} onClick={() => void run("retry")}>
            {icon("retry")}
            Retry
          </button>
        </Show>
      </div>
    </Show>
  );
}

/**
 * Focuses `el` unless something else has the keyboard: the palette, a picker or a dialog (toggling clusters in
 * the picker reloads the view, and the "no access" screen comes back with each answer), or a field outside the
 * table (the filter). Keystrokes meant for those must never land in the namespace field, where Return opens one.
 */
function focusIfFree(el: HTMLElement) {
  if (paletteOpen() || pickerOpen() || dialog()) return;
  const active = document.activeElement;
  if (active && active !== document.body && !active.closest(".table")) return;
  el.focus();
}

/** Remembered namespaces offered on the "no access" screen (the namespace picker has them all). */
const REMEMBERED_SHOWN = 10;

/**
 * Shown when a cluster refuses the request (403) and no cluster has rows. Strict-RBAC setups usually forbid
 * listing across namespaces (and listing namespaces at all), so the fix is to name a namespace directly: the ones
 * the kubeconfig contexts set (what kubectl would use) are offered, and apart from them the ones that worked
 * before, which can be forgotten (×). `errors` are the refusals; the other clusters' failures (`others`, with
 * their Retry) and the clusters still loading (`waiting`) are listed below. `partial`: not every cluster refused.
 */
function AccessCta(p: { title: string; errors: FeedState[]; others: FeedState[]; waiting: string[]; partial: boolean; draft: Signal<string> }) {
  const [value, setValue] = p.draft;
  const ns = () => normalizeNamespace(value());
  const valid = () => isValidNamespace(ns());
  const namespaced = () => currentResource()?.namespaced !== false;
  const fromKubeconfig = createMemo(() => kubeconfigNamespaces().filter((n) => !namespaces().includes(n)));
  const remembered = createMemo(() => {
    const skip = new Set([...kubeconfigNamespaces(), ...namespaces()]);
    return rememberedNamespaces().filter((n) => !skip.has(n)).slice(0, REMEMBERED_SHOWN);
  });
  /** Which selected contexts set the namespace, for its tooltip. */
  const setBy = (n: string) => {
    const selected = new Set(selectedClusters());
    const by = contexts().filter((c) => selected.has(c.name) && normalizeNamespace(c.namespace ?? "") === n);
    return `Set by the kubeconfig context${by.length > 1 ? "s" : ""} ${by.map((c) => c.name).join(", ")}`;
  };
  const clusters = () => [...new Set(p.errors.map((e) => e.c))];
  const open = (n: string) => setNamespaces([n]);
  const what = () => p.title.toLowerCase();

  return (
    <div class="access-cta">
      <div class="cta-icon">
        <Icon name="lock" size={20} />
      </div>
      <h3>
        <Show when={namespaced()} fallback={<>No permission to list {what()}</>}>
          <Show when={namespaces().length} fallback={<>No cluster-wide access to {what()}</>}>
            No access to {what()} in {namespaces().join(", ")}
          </Show>
        </Show>
        {p.partial ? ` on ${clusterNames(clusters(), 3)}` : ""}
      </h3>
      <p>
        <Show
          when={namespaced()}
          fallback={
            <>
              Your role doesn't allow listing {what()} in {clusters().length > 1 ? `${clusters().length} clusters` : shortName(clusters()[0] ?? "")}.
            </>
          }
        >
          <Show when={namespaces().length} fallback={<>Your role can't list {what()} across all namespaces. Open a namespace you have access to:</>}>
            Check the name, or open another namespace:
          </Show>
        </Show>
      </p>
      <Show when={namespaced()}>
        <form
          class="cta-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (valid()) open(ns());
          }}
        >
          <div class="search-field grow">
            <Icon name="namespace" size={13} />
            <input
              class="input"
              placeholder="namespace name"
              value={value()}
              onInput={(e) => setValue(e.currentTarget.value)}
              // Esc gives the keyboard back to the app's keys (0…9, ⌘1…, the palette's ":").
              onKeyDown={(e) => e.key === "Escape" && e.currentTarget.blur()}
              ref={(el) => queueMicrotask(() => focusIfFree(el))}
              spellcheck={false}
            />
          </div>
          <button class="btn primary" type="submit" disabled={!valid()}>
            Open
          </button>
        </form>
        <Show when={value() && !valid()}>
          <span class="faint" style={{ "font-size": "var(--fs-xs)" }}>
            Lowercase letters, digits and “-” only
          </span>
        </Show>
        <Show when={fromKubeconfig().length}>
          <div class="cta-recent cta-kubeconfig">
            <span class="faint">From kubeconfig:</span>
            <For each={fromKubeconfig()}>
              {(n) => (
                <button class="chip" title={setBy(n)} onClick={() => open(n)}>
                  <Icon name="config" size={11} />
                  {n}
                </button>
              )}
            </For>
          </div>
        </Show>
        <Show when={remembered().length}>
          <div class="cta-recent cta-remembered">
            <span class="faint">Recent:</span>
            <For each={remembered()}>
              {(n) => (
                <span class="chip removable">
                  <button class="chip-open" title="Opened here before" onClick={() => open(n)}>
                    {n}
                  </button>
                  <button class="chip-x" title={`Forget ${n}`} aria-label={`Forget ${n}`} onClick={() => forgetNamespace(n)}>
                    <Icon name="x" size={10} />
                  </button>
                </span>
              )}
            </For>
          </div>
        </Show>
      </Show>
      <details class="cta-details">
        <summary>Details from {clusters().length > 1 ? `${clusters().length} clusters` : "the cluster"}</summary>
        <ErrorList errors={p.errors} />
      </details>
      <Show when={p.others.length}>
        <div class="cta-others">
          <ErrorList errors={p.others} />
          <NextSteps errors={p.others} />
        </div>
      </Show>
      <Show when={p.waiting.length}>
        <span class="cta-waiting faint">
          <span class="spinner" style={{ width: "10px", height: "10px" }} />
          Waiting for {clusterNames(p.waiting, 5)}…
        </span>
      </Show>
      {/* Followed a link here (Node of a pod, owner…) and may not list this: the way back. */}
      <Show when={backTarget()}>
        {(b) => (
          <button class="btn" onClick={() => goBack()}>
            ← Back to {resourceTitle(b().resource).toLowerCase()}
            {b().selectedName ? ` · ${b().selectedName}` : ""}
          </button>
        )}
      </Show>
    </div>
  );
}
