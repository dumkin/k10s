import { batch, createEffect, createMemo, createSignal, For, Index, Match, on, onCleanup, onMount, Show, Switch } from "solid-js";
import type { Column } from "../lib/backend";
import { type Binding, bindAll, comboLabel, isMac, withKeys } from "../lib/hotkeys";
import { isAuthFailure, isAuthFailureMessage, isError, isForbidden } from "../lib/k8s";
import { keyOf } from "../lib/keymap";
import { type ActionContext, actionKeyId, actionsFor, actionTitle, allActions } from "../registry/actions";
import { catalogEntry } from "../registry/catalog";
import { extraColumns } from "../registry/columns";
import { allDetailTabs, tabKeyId, tabsFor } from "../registry/details";
import { clusterColor, clusterStatus, ensureConnected, isMultiCluster, retryCluster, selectedClusters, shortName } from "../state/clusters";
import { type Command, registerCommands } from "../state/commands";
import { focusInSidebar, modalOpen, onControl, tableHasKeyboard } from "../state/keyboard";
import {
  clearMarks,
  closeDetails,
  currentResource,
  detailsFull,
  detailsOpen,
  filter,
  goBack,
  goForward,
  marked,
  markTo,
  NAMESPACE_KEYS,
  namespaceKeys,
  namespaces,
  openDetails,
  resourceKey,
  resourceTitle,
  selectedKey,
  setDetailsFull,
  setDetailsTab,
  setFilter,
  setHistoryRowName,
  setMarked,
  setNamespaces,
  setSelectedKey,
  toggleDetailsFull,
  toggleMark,
} from "../state/nav";
import { createTableModel, FILTER_HELP, hiddenClusters, isColumnVisible, onlyClusterShown, setColumnVisible, setHiddenClusters, soloCluster, sort, toggleClusterHidden, toggleSort } from "../state/table";
import { paletteOpen, pickerOpen, toast } from "../state/ui";
import type { UIRow } from "../state/view";
import { mainView, selection } from "../state/views";
import { ActionMenuItems } from "./ActionMenu";
import { DetailsPanel } from "./DetailsPanel";
import { Icon } from "./Icon";
import { Kbd } from "./Kbd";
import { addHintPanel } from "./KeyHints";
import { Popover } from "./Popover";
import { ResourceTable, type TableHandle } from "./ResourceTable";

export function ResourceView() {
  const model = createTableModel(mainView);
  let table: TableHandle | undefined;
  let filterInput: HTMLInputElement | undefined;
  /** Context menu; its target rows are fixed when it opens, whatever happens to the selection meanwhile. */
  const [menu, setMenu] = createSignal<{ x: number; y: number; ctx: ActionContext } | null>(null);
  const [columnsAnchor, setColumnsAnchor] = createSignal<HTMLElement>();

  const title = () => resourceTitle(resourceKey());
  const rows = model.sorted;

  const selected = createMemo(selection);
  /** Visible marked rows if any are marked, else the selected row (see `selectionTargets`). */
  const targets = () => selected().targets;
  const actionCtx = createMemo<ActionContext>(() => ({ resourceKey: resourceKey(), resource: currentResource(), rows: targets() }));
  const hiddenMarks = () => selected().hidden;

  const perCluster = createMemo(() => {
    const counts = new Map<string, number>();
    for (const r of mainView.rows()) counts.set(r.cl, (counts.get(r.cl) ?? 0) + 1);
    return counts;
  });
  /**
   * Health of one cluster in this view: connection, permissions and loading state combined. `auth`: it failed for
   * its credentials (rejected, or the auth plugin failed) — fresh ones are the way on.
   */
  const clusterState = (c: string): { state: "loading" | "ready" | "partial" | "forbidden" | "error" | "conn"; message?: string; auth?: boolean } => {
    const conn = clusterStatus[c];
    if (conn?.state === "error") return { state: "conn", message: conn.message, auth: isAuthFailureMessage(conn.message) };
    const sts = Object.values(mainView.statuses).filter((s) => s?.c === c);
    const errs = sts.filter((s) => isError(s));
    const message = errs.map((e) => `${e.ns ? `${e.ns}: ` : ""}${isError(e) ? e.message : ""}`).join("\n");
    if (sts.length && errs.length === sts.length) return { state: errs.every((e) => isForbidden(e)) ? "forbidden" : "error", message, auth: errs.some((e) => isAuthFailure(e)) };
    if (!sts.length || sts.some((s) => s.state === "connecting" || s.state === "loading")) return { state: "loading" };
    if (errs.length) return { state: "partial", message };
    return { state: "ready" };
  };
  const showStrip = () => isMultiCluster() || selectedClusters().some((c) => !["ready", "loading"].includes(clusterState(c).state));

  // ------------------------------------------------------------------ keyboard
  /** Where a move by `delta` rows goes (±Infinity: the first / last row); undefined in an empty table. */
  const moveTarget = (delta: number): number | undefined => {
    const list = rows();
    if (!list.length) return undefined;
    const cur = selectedKey() ? model.indexOf(selectedKey()!) : undefined;
    return delta === -Infinity ? 0 : delta === Infinity ? list.length - 1 : cur === undefined ? (delta > 0 ? 0 : list.length - 1) : Math.max(0, Math.min(list.length - 1, cur + delta));
  };
  const moveBy = (delta: number) => {
    const i = moveTarget(delta);
    if (i !== undefined) setSelectedKey(rows()[i].key);
  };
  /** A move with ⇧: marks the rows on the way (see `markTo`). */
  const markBy = (delta: number) => {
    const i = moveTarget(delta);
    if (i !== undefined) markTo(rows(), i, model.indexOf);
  };
  const overlayOpen = () => modalOpen() || !!menu() || !!columnsAnchor();
  // Keyboard focus in the details panel (logs, YAML, its buttons), or the panel filling the window: navigation,
  // marking and action keys must not move the selection or mark rows behind the user's back.
  const tableFocused = () => !overlayOpen() && tableHasKeyboard();

  /**
   * A cluster pill clicked (or its ⌥ key): reconnect with fresh credentials where they failed, retry a failed
   * connection, say why there is no access, else hide / show its rows.
   */
  const clusterPill = (c: string) => {
    const s = clusterState(c);
    if (s.auth) void ensureConnected(c, true);
    else if (s.state === "conn") void retryCluster(c);
    else if (s.state === "forbidden" || s.state === "error") toast(s.state === "forbidden" ? "info" : "error", `${c}: ${s.state === "forbidden" ? "no access" : "error"}`, s.message);
    else toggleClusterHidden(c);
  };
  /** The age column to sort by (`⇧A`): Events have "last seen" instead. */
  const ageColumn = () => (model.columns().some((c) => c.id === "age") ? "age" : mainView.columns().some((c) => c.id === "lastSeen") ? "lastSeen" : undefined);

  onMount(() => {
    const page = () => table?.pageSize() ?? 20;
    const base: (Binding & { anywhere?: boolean })[] = [
      { id: "table.down", run: () => moveBy(1) },
      { combo: "arrowdown", run: () => moveBy(1) },
      { id: "table.up", run: () => moveBy(-1) },
      { combo: "arrowup", run: () => moveBy(-1) },
      { combo: "pagedown", run: () => moveBy(page()) },
      { combo: "pageup", run: () => moveBy(-page()) },
      { id: "table.first", run: () => moveBy(-Infinity) },
      { combo: "home", run: () => moveBy(-Infinity) },
      { id: "table.last", run: () => moveBy(Infinity) },
      { combo: "end", run: () => moveBy(Infinity) },
      // With ⇧: marking the rows on the way, as ⇧J / ⇧K pick lines in the logs.
      { id: "table.mark-down", run: () => markBy(1) },
      { combo: "shift+arrowdown", run: () => markBy(1) },
      { id: "table.mark-up", run: () => markBy(-1) },
      { combo: "shift+arrowup", run: () => markBy(-1) },
      { combo: "shift+pagedown", run: () => markBy(page()) },
      { combo: "shift+pageup", run: () => markBy(-page()) },
      { combo: "shift+home", run: () => markBy(-Infinity) },
      { combo: "shift+end", run: () => markBy(Infinity) },
      // A focused button or link (Tab, Full Keyboard Access, a click on Linux/Windows) keeps its own Enter and Space.
      {
        combo: "enter",
        run: (e) => {
          const k = selectedKey();
          if (!k || onControl(e)) return false;
          openDetails(k);
        },
      },
      {
        combo: "space",
        run: (e) => {
          const k = selectedKey();
          if (!k || onControl(e)) return false;
          toggleMark(k);
          moveBy(1);
        },
      },
      { combo: "mod+a", run: () => setMarked(new Set(rows().map((r) => r.key))) },
      // The context menu without the mouse, as on every desktop: ⇧F10 and the menu key.
      { combo: "shift+f10", run: () => openMenuByKey() },
      { combo: "contextmenu", run: () => openMenuByKey() },
      { id: "table.filter", run: () => filterInput?.focus() },
      // ⌘F for those who don't think in k9s: the same filter, also from another field.
      { id: "table.filter-anywhere", inInputs: true, run: () => (filterInput?.focus(), filterInput?.select()) },
      // k9s: Shift+N / Shift+A sort by name / age, again for the reverse order.
      { id: "table.sort-name", run: () => toggleSort("name") },
      {
        id: "table.sort-age",
        run: () => {
          const col = ageColumn();
          if (!col) return false;
          toggleSort(col);
        },
      },
      // k9s's namespace favorites: 0 all namespaces, 1…9 the ones on number keys (see `namespaceKeys`).
      { combo: "0", run: () => setNamespaces([]) },
      ...[...Array(NAMESPACE_KEYS).keys()].map(
        (i): Binding => ({
          combo: String(i + 1),
          run: () => {
            const ns = namespaceKeys()[i];
            if (!ns) return false;
            setNamespaces([ns]);
          },
        }),
      ),
      // ⌥1…⌥9: the cluster pills, as if clicked (hide / show the cluster's rows); ⌥0 shows every cluster again.
      ...[...Array(9).keys()].map(
        (i): Binding => ({
          combo: `alt+${i + 1}`,
          when: () => showStrip(),
          run: () => {
            const c = selectedClusters()[i];
            if (!c) return false;
            clusterPill(c);
          },
        }),
      ),
      {
        combo: "alt+0",
        run: () => {
          if (!hiddenClusters().size) return false;
          setHiddenClusters(new Set<string>());
        },
      },
      // Full view of the details (k9s's logs fullscreen key): the table and sidebar go under it.
      { id: "details.full", anywhere: true, run: () => toggleDetailsFull() },
      {
        combo: "escape",
        inInputs: true,
        anywhere: true,
        run: (e) => {
          if (e.target === filterInput) {
            if (filter()) setFilter("");
            else filterInput?.blur();
            return;
          }
          // In a field, or in the sidebar's list (Esc there gives the keyboard back to the table): theirs.
          if ((e.target as HTMLElement)?.tagName === "INPUT" || focusInSidebar()) return false;
          // One level at a time: full view, then the panel, then the marks, then the filter.
          if (detailsFull()) setDetailsFull(false);
          else if (detailsOpen()) closeDetails();
          else if (marked().size) clearMarks();
          else if (filter()) setFilter("");
          else return false;
        },
      },
      {
        combo: "arrowdown",
        inInputs: true,
        run: (e) => {
          if (e.target !== filterInput) return false;
          filterInput?.blur();
          moveBy(1);
        },
      },
    ];
    // Back / forward through views (resource, namespaces, filter, selection, details): ⌘[ ⌘] on macOS,
    // Alt+← / Alt+→ elsewhere, like browsers. Mouse back/forward buttons are handled below.
    base.push({ id: "nav.back", inInputs: true, anywhere: true, run: () => void goBack() });
    base.push({ id: "nav.forward", inInputs: true, anywhere: true, run: () => void goForward() });
    // A details tab by its key: d r l e y = for objects (Overview, Relations, Logs, Events, YAML, Compare), d v m h for
    // Helm releases. Tabs that share a key go by the resource: the one it has opens.
    for (const tab of allDetailTabs()) {
      base.push({
        id: tabKeyId(tab),
        anywhere: true,
        run: () => {
          // L on several marked rows (in the table): their logs together, in the dock; = compares them — the action
          // that goes by the tab's key.
          if (tableFocused() && actionCtx().rows.length > 1) {
            const action = actionsFor(actionCtx()).find((a) => a.tab === tab.id);
            if (action) {
              void action.run(actionCtx());
              return;
            }
          }
          const k = selectedKey();
          if (!k || !tabsFor(resourceKey(), currentResource()).some((t) => t.id === tab.id)) return false;
          batch(() => {
            openDetails(k);
            setDetailsTab(tab.id);
          });
        },
      });
    }
    // Action keys (restart, scale, delete, copy…) act on the current selection. Actions that share a key go by the
    // resource: the first that applies runs.
    for (const action of allActions()) {
      if (action.tab) continue;
      base.push({
        id: actionKeyId(action),
        run: () => {
          const a = actionsFor(actionCtx()).find((x) => x.id === action.id);
          if (!a) return false;
          void a.run(actionCtx());
        },
      });
    }
    const off = bindAll(base.map(({ anywhere, ...b }) => ({ ...b, when: () => (anywhere ? !overlayOpen() : tableFocused()) && (b.when?.() ?? true) })));
    onCleanup(off);

    // Mouse buttons 4/5 (back/forward). `mouseup` is where browsers navigate; cancelling it keeps the
    // dev-mode page (and WebViews that would) from leaving the app.
    const onMouseUp = (e: MouseEvent) => {
      if (e.button !== 3 && e.button !== 4) return;
      e.preventDefault();
      if (!overlayOpen()) void (e.button === 3 ? goBack() : goForward());
    };
    window.addEventListener("mouseup", onMouseUp);
    onCleanup(() => window.removeEventListener("mouseup", onMouseUp));
    setHistoryRowName((key) => mainView.rowByKey(key)?.n);
    onCleanup(registerCommands(viewCommands));
    onCleanup(addHintPanel(() => <NamespaceKeysHint />));
  });

  /** The palette's way to what is otherwise clicked in this view: sorting, the cluster pills, full view. */
  const viewCommands = (): Command[] => {
    const out: Command[] = [];
    const cur = sort();
    for (const c of model.columns()) {
      const on = cur.col === c.id;
      out.push({
        id: `sort:${c.id}`,
        title: `Sort by ${c.title}`,
        section: "View",
        icon: "list",
        keywords: ["sort", "order", c.id],
        checked: on,
        hint: on ? (cur.desc ? "descending" : "ascending") : undefined,
        shortcut: c.id === "name" ? keyOf("table.sort-name") : c.id === ageColumn() ? keyOf("table.sort-age") : undefined,
        run: () => toggleSort(c.id),
      });
    }
    if (showStrip()) {
      selectedClusters().forEach((c, i) => {
        const hidden = hiddenClusters().has(c);
        out.push({
          id: `cluster-rows:${c}`,
          title: `${hidden ? "Show" : "Hide"} rows of ${c}`,
          section: "View",
          color: clusterColor(c),
          keywords: [shortName(c), "cluster", "rows", "hide", "show"],
          shortcut: i < 9 ? `alt+${i + 1}` : undefined,
          run: () => toggleClusterHidden(c),
        });
        // ⌘-click on the pill. Already so: "Show rows of every cluster" (below) is the way back.
        if (isMultiCluster() && !onlyClusterShown(c))
          out.push({ id: `cluster-rows-only:${c}`, title: `Show only rows of ${c}`, section: "View", color: clusterColor(c), keywords: [shortName(c), "cluster", "rows", "only", "solo"], run: () => soloCluster(c) });
      });
      if (hiddenClusters().size)
        out.push({ id: "cluster-rows:all", title: "Show rows of every cluster", section: "View", icon: "eye", keywords: ["cluster", "unhide"], shortcut: "alt+0", run: () => void setHiddenClusters(new Set<string>()) });
    }
    // Columns: shown or hidden, as in the Columns menu.
    for (const c of [...mainView.columns(), ...(extraColumns(resourceKey()) as Column[])]) {
      const shown = isColumnVisible(c);
      out.push({
        id: `column:${c.id}`,
        title: `${shown ? "Hide" : "Show"} column ${c.title}`,
        section: "View",
        icon: "columns",
        keywords: ["column", "columns", shown ? "hide" : "show", c.id],
        checked: shown,
        run: () => setColumnVisible(c.id, !shown),
      });
    }
    if (selectedKey() || marked().size)
      out.push({ id: "view:menu", title: "Actions menu", section: "View", icon: "more", keywords: ["context", "menu", "actions", "right click"], shortcut: "shift+f10", run: () => void openMenuByKey() });
    if (detailsOpen() || selectedKey())
      out.push({
        id: "details:full",
        title: detailsFull() ? "Leave full view of details" : "Full view of details",
        section: "View",
        icon: detailsFull() ? "minimize" : "maximize",
        keywords: ["maximize", "fullscreen", "expand", "logs", "yaml", "zoom"],
        shortcut: keyOf("details.full"),
        run: () => void toggleDetailsFull(),
      });
    return out;
  };

  // Right-click on a marked row acts on all visible marks; on any other row, on that row alone.
  // The menu's target is fixed; drop it once the view changes or another overlay takes over.
  createEffect(on([resourceKey, selectedClusters, namespaces, paletteOpen, pickerOpen], () => setMenu(null), { defer: true }));

  const onContextMenu = (row: UIRow, e: MouseEvent) => {
    const rows = marked().has(row.key) ? targets() : [row];
    setMenu({ x: e.clientX, y: e.clientY, ctx: { resourceKey: resourceKey(), resource: currentResource(), rows } });
  };

  /**
   * The context menu from the keyboard (⇧F10, the menu key): for what the action keys act on — the marks, else the
   * selected row — under that row (the top of the table when it is scrolled out of sight).
   */
  const openMenuByKey = () => {
    const ctx = actionCtx();
    if (!ctx.rows.length) return false;
    const sel = document.querySelector<HTMLElement>(".table .tr.sel .td.name") ?? document.querySelector<HTMLElement>(".table .tr.sel");
    const box = document.querySelector<HTMLElement>(".table .tscroll")?.getBoundingClientRect();
    const r = sel?.getBoundingClientRect();
    const visible = r && box && r.top >= box.top + 30 && r.bottom <= box.bottom;
    const at = visible ? { x: r.left + 8, y: r.bottom + 2 } : { x: (box?.left ?? 0) + 24, y: (box?.top ?? 0) + 34 };
    setMenu({ ...at, ctx });
  };
  /** What the context menu acts on, as its header says. */
  const menuTarget = (ctx: ActionContext) => (ctx.rows.length > 1 ? `${ctx.rows.length} marked ${resourceTitle(ctx.resourceKey).toLowerCase()}` : (ctx.rows[0]?.n ?? ""));

  return (
    <>
      <div class="content">
        <div class="view-header">
          <div class="view-title">
            <Icon name={catalogEntry(resourceKey())?.icon ?? "crd"} size={18} />
            <h1>{title()}</h1>
            <span class="badge" title="Rows shown / total">
              {model.sorted().length !== mainView.rows().length ? `${model.sorted().length.toLocaleString("en-US")} / ` : ""}
              {mainView.rows().length.toLocaleString("en-US")}
            </span>
            <Show when={currentResource()}>
              {(r) => (
                <span class="kind" title={r().shortNames.length ? `short names: ${r().shortNames.join(", ")}` : undefined}>
                  {r().group ? `${r().group}/` : ""}
                  {r().version}
                </span>
              )}
            </Show>
          </div>
          <div class="filter search-field" data-hint={keyOf("table.filter")} data-hint-ctx="table">
            <Icon name="filter" size={13} />
            <input
              ref={filterInput}
              class="input"
              placeholder="Filter  ·  !exclude  ·  label=value"
              aria-label="Filter"
              title={FILTER_HELP}
              value={filter()}
              onInput={(e) => setFilter(e.currentTarget.value)}
              spellcheck={false}
            />
            <Show when={filter()} fallback={<Kbd id="table.filter" />}>
              <button class="clear" onClick={() => setFilter("")} aria-label="Clear the filter">
                <Icon name="x" size={12} />
              </button>
            </Show>
          </div>
          <div class="tools">
            <Show when={marked().size}>
              <span class="badge accent" title={hiddenMarks() ? "Marked rows that are filtered out or in hidden clusters are not affected by actions" : undefined}>
                {targets().length} marked{hiddenMarks() ? ` · ${hiddenMarks()} hidden` : ""}
              </span>
              {/* By position: the actions are made anew as the clusters answer access checks; a focused button stays. */}
              <Index each={actionsFor(actionCtx()).filter((a) => a.multi)}>
                {(a) => (
                  <button
                    class="btn sm ghost"
                    // Off in read-only mode or without the permission: greyed out, a lock, its tooltip says why (not
                    // `disabled`: see DetailsPanel). Allowed on some of the marks only: the tooltip says which are left out.
                    classList={{ locked: !!a().disabled, rbac: a().lock === "rbac" }}
                    aria-disabled={a().disabled ? "true" : undefined}
                    aria-label={actionTitle(a(), actionCtx())}
                    style={a().danger ? { color: "var(--err)" } : undefined}
                    onClick={() => !a().disabled && a().run(actionCtx())}
                    title={a().disabled ? a().disabledReason : `${withKeys(actionTitle(a(), actionCtx()), actionKeyId(a()))}${a().note ? `\n${a().note}` : ""}`}
                    data-hint={a().disabled ? undefined : keyOf(actionKeyId(a()))}
                    data-hint-ctx="table"
                    data-hint-at="below"
                  >
                    <Icon name={a().icon} size={12} />
                  </button>
                )}
              </Index>
              <button
                class="btn sm ghost"
                onClick={clearMarks}
                title="Clear marks (Esc)"
                aria-label="Clear marks"
                data-hint={detailsOpen() ? undefined : "escape"}
                data-hint-ctx="table"
                data-hint-at="below"
              >
                <Icon name="x" size={12} />
              </button>
            </Show>
            <button
              class="btn ghost icon"
              classList={{ on: !!columnsAnchor() }}
              title="Columns"
              aria-label="Columns"
              aria-haspopup="menu"
              aria-expanded={!!columnsAnchor()}
              onClick={(e) => setColumnsAnchor(e.currentTarget)}
            >
              <Icon name="columns" size={15} />
            </button>
          </div>
          <span class="progress-line" classList={{ on: mainView.loading() }} role="progressbar" aria-label={`Loading ${title().toLowerCase()}`} aria-hidden={!mainView.loading()} />
        </div>

        <Show when={showStrip()}>
          <div class="cluster-strip">
            <For each={selectedClusters()}>
              {(c, i) => {
                const st = () => clusterState(c);
                const conn = () => clusterStatus[c];
                const hidden = () => hiddenClusters().has(c);
                const key = () => (i() < 9 ? `alt+${i() + 1}` : undefined);
                const title = () => {
                  const s = st();
                  const k = key() ? ` (${comboLabel(key()!)})` : "";
                  if (s.state === "conn") return `${c}: cannot connect — click to ${s.auth ? "reconnect" : "retry"}${k}\n${s.message ?? ""}`;
                  if (s.state === "forbidden") return `${c}: no access\n${s.message ?? ""}`;
                  if (s.auth) return `${c}: sign-in failed — click to reconnect${k}\n${s.message ?? ""}`;
                  if (s.state === "error" || s.state === "partial") return `${c}\n${s.message ?? ""}`;
                  return `${c}${conn()?.version ? ` · ${conn()!.version}` : ""} — click to ${hidden() ? "show" : "hide"}${k}, ${comboLabel("mod")}-click: ${onlyClusterShown(c) ? "every cluster" : "only this cluster"}`;
                };
                return (
                  <button
                    class="cluster-pill"
                    classList={{ error: st().state === "error" || st().state === "conn", forbidden: st().state === "forbidden", "hidden-rows": hidden() }}
                    aria-pressed={st().state === "ready" || st().state === "partial" || st().state === "loading" ? !hidden() : undefined}
                    title={title()}
                    data-hint={key()}
                    data-hint-ctx="table"
                    data-hint-at="below"
                    // ⌘-click (Ctrl-click off macOS): only this cluster's rows, whatever its state — again: every cluster's.
                    onClick={(e) => (e.metaKey || e.ctrlKey ? soloCluster(c) : clusterPill(c))}
                    // A Ctrl-click on macOS is a right click: a context menu comes, no click.
                    onContextMenu={(e) => {
                      if (!isMac || !e.ctrlKey) return;
                      e.preventDefault();
                      soloCluster(c);
                    }}
                  >
                    <Switch fallback={<span class="swatch" style={{ background: clusterColor(c) }} />}>
                      <Match when={st().state === "loading"}>
                        <span class="spinner" style={{ width: "9px", height: "9px" }} />
                      </Match>
                      <Match when={st().state === "forbidden"}>
                        <Icon name="lock" size={11} />
                      </Match>
                      <Match when={st().state === "error" || st().state === "conn"}>
                        <span class="swatch" style={{ background: "var(--err)" }} />
                      </Match>
                    </Switch>
                    <span class="ellipsis">{shortName(c)}</span>
                    <Switch fallback={<span class="n">{(perCluster().get(c) ?? 0).toLocaleString("en-US")}</span>}>
                      <Match when={st().state === "conn"}>
                        <Icon name="refresh" size={11} />
                      </Match>
                      <Match when={st().state === "forbidden"}>
                        <span>no access</span>
                      </Match>
                      <Match when={st().state === "error"}>
                        <span>error</span>
                      </Match>
                      <Match when={st().state === "partial"}>
                        <span class="n">{(perCluster().get(c) ?? 0).toLocaleString("en-US")}</span>
                        <Icon name="alert" size={11} class="warn-mark" />
                      </Match>
                    </Switch>
                  </button>
                );
              }}
            </For>
          </div>
        </Show>

        <ResourceTable feed={mainView} model={model} title={title()} onContextMenu={onContextMenu} ref={(h) => (table = h)} />
      </div>

      <Show when={detailsOpen()}>
        <DetailsPanel />
      </Show>

      <Show when={menu()} keyed>
        {(m) => (
          <Popover anchor={m} onClose={() => setMenu(null)} width={240}>
            <div class="menu" role="menu" aria-label={menuTarget(m.ctx)}>
              <div class="pop-group menu-target" aria-hidden="true">
                {menuTarget(m.ctx)}
              </div>
              <ActionMenuItems actions={actionsFor(m.ctx)} ctx={m.ctx} onRun={() => setMenu(null)} />
            </div>
          </Popover>
        )}
      </Show>

      <Show when={columnsAnchor()}>
        <Popover anchor={columnsAnchor()} onClose={() => setColumnsAnchor(undefined)} width={240} align="right">
          <div class="menu" role="menu" aria-label="Columns">
            <div class="pop-group" aria-hidden="true">
              Columns
            </div>
            <For each={[...mainView.columns(), ...(extraColumns(resourceKey()) as Column[])]} fallback={<div class="opt faint">No extra columns</div>}>
              {(c) => (
                <button class="opt" role="menuitemcheckbox" aria-checked={isColumnVisible(c)} onClick={() => setColumnVisible(c.id, !isColumnVisible(c))}>
                  <span class="check" classList={{ on: isColumnVisible(c) }} aria-hidden="true">
                    <Icon name="check" size={11} strokeWidth={3} />
                  </span>
                  <span>{c.title}</span>
                </button>
              )}
            </For>
          </div>
        </Popover>
      </Show>
    </>
  );
}

/**
 * Shown while ⌘ is held, in the line at the bottom: which namespace each number key opens (k9s's favorites). The
 * keys work while the table has the keyboard, and so this shows only then.
 */
function NamespaceKeysHint() {
  if (!tableHasKeyboard()) return null;
  const current = namespaces();
  const key = (k: string, name: string, on: boolean) => (
    <span class="khd-key" classList={{ on }}>
      <span class="kbd">{k}</span>
      <span class="ellipsis">{name}</span>
    </span>
  );
  return (
    <span class="khd-item" title="Number keys in the table">
      <Icon name="namespace" size={13} />
      {key("0", "all", !current.length)}
      <For each={namespaceKeys()}>{(n, i) => key(String(i() + 1), n, current.length === 1 && current[0] === n)}</For>
      <Show when={!namespaceKeys().length}>
        <span class="faint">namespaces you open get the keys 1–9</span>
      </Show>
    </span>
  );
}
