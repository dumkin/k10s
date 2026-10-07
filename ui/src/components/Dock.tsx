import { createEffect, createSignal, For, type JSX, lazy, Match, on, onCleanup, onMount, Show, Suspense, Switch } from "solid-js";
import { bindAll, isMac, withKeys } from "../lib/hotkeys";
import { splitterKeyDown } from "../lib/splitter";
import { clusterColor, selectedClusters, shortName } from "../state/clusters";
import { closeTerminal, DOCK_MIN, dockHeight, dockOpen, dockTab, setDockHeight, setDockOpen, setDockSpace, setDockTab, type TermTab, termCluster, termStatus, termTitle, termTabs } from "../state/dock";
import { DockLogs } from "../details/logs/DockLogs";
import { focusInDock } from "../state/keyboard";
import { Icon } from "./Icon";
import { Kbd } from "./Kbd";

// xterm.js is most of a terminal's weight: loaded with the first one, not with the app.
const TerminalView = lazy(() => import("./Terminal").then((m) => ({ default: m.TerminalView })));

/** Gives the keyboard to the dock's shown terminal (or pane). */
function focusDock() {
  const pane = document.querySelector<HTMLElement>(".dock .dock-pane.on");
  const target = pane?.querySelector<HTMLElement>(".term textarea, [tabindex], button, input") ?? pane;
  target?.focus();
}

/** Extra panes the dock shows next to its terminals (port-forwards), contributed by their features. */
export interface DockPane {
  id: "forwards";
  title: string;
  icon: "link";
  /** A count next to the title. */
  count?: () => number;
  component: () => JSX.Element;
}

const [panes, setPanes] = createSignal<DockPane[]>([]);

export function registerDockPane(pane: DockPane) {
  setPanes([...panes().filter((p) => p.id !== pane.id), pane]);
}

/**
 * The dock under the table: terminal tabs (and port-forwards). Its terminals stay mounted while it is hidden or
 * another tab is shown — a shell keeps running, and its scrollback stays.
 */
export function Dock() {
  let section!: HTMLElement;
  const [dragging, setDragging] = createSignal(false);
  const startResize = (e: PointerEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = dockHeight();
    setDragging(true);
    const move = (ev: PointerEvent) => setDockHeight(Math.min(maxHeight(), Math.max(DOCK_MIN, Math.round(startH + startY - ev.clientY))));
    const up = () => {
      setDragging(false);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  const empty = () => !termTabs().length && !panes().length;
  const maxHeight = () => Math.max(DOCK_MIN, window.innerHeight - 220);
  const resizeKeys = splitterKeyDown({ value: dockHeight, set: setDockHeight, min: () => DOCK_MIN, max: maxHeight, grow: "ArrowUp", shrink: "ArrowDown" });
  /** The tabs in the strip's order: panes first, then terminals (what ← → go along). */
  const tabIds = (): (number | "forwards")[] => [...panes().map((p) => p.id), ...termTabs().map((t) => t.id)];
  /**
   * Keys on a focused tab: ← → (Home, End) to the previous / next one, which shows at once; ⌫ or Delete closes a
   * terminal's (ending its session).
   */
  const tabKeys = (e: KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey || e.repeat || !(e.target as Element).closest(".dock-tab")) return;
    const ids = tabIds();
    const at = ids.indexOf(dockTab());
    let next: number | undefined;
    if (e.key === "ArrowRight") next = (at + 1) % ids.length;
    else if (e.key === "ArrowLeft") next = (at - 1 + ids.length) % ids.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = ids.length - 1;
    else if ((e.key === "Delete" || e.key === "Backspace") && typeof dockTab() === "number") {
      e.preventDefault();
      closeTerminal(dockTab() as number);
      queueMicrotask(() => section.querySelector<HTMLElement>(".dock-tab.on")?.focus());
      return;
    } else return;
    e.preventDefault();
    setDockTab(ids[next]);
    queueMicrotask(() => section.querySelector<HTMLElement>(".dock-tab.on")?.focus());
  };

  onMount(() => {
    // The height it really got (capped by CSS in a small window; 0 while hidden).
    const sized = new ResizeObserver(() => setDockSpace(section.offsetHeight));
    sized.observe(section);
    onCleanup(() => sized.disconnect());
    // ⌘J: show the dock (its terminal gets the keyboard), take the keyboard to it when it shows already, hide it
    // when it has the keyboard. Off macOS ⌃J is a terminal's own key: there ⌃⇧J works from inside a terminal too.
    const toggle = () => {
      if (!dockOpen()) setDockOpen(true);
      else if (!focusInDock()) focusDock();
      else {
        setDockOpen(false);
        (document.activeElement as HTMLElement | null)?.blur();
      }
    };
    onCleanup(
      bindAll([
        { id: "dock.toggle", inInputs: true, inTerminal: isMac, priority: 50, run: toggle },
        { id: "dock.toggle-from-terminal", inInputs: true, inTerminal: true, priority: 50, run: toggle },
      ]),
    );
  });

  return (
    <section ref={section} class="dock" classList={{ hidden: !dockOpen() }} style={{ height: `${dockHeight()}px` }} aria-label="Terminals">
      <div
        class="dock-resizer"
        classList={{ dragging: dragging() }}
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize the dock"
        aria-valuenow={dockHeight()}
        aria-valuemin={DOCK_MIN}
        aria-valuemax={maxHeight()}
        tabIndex={0}
        data-own-arrows
        onPointerDown={startResize}
        onKeyDown={resizeKeys}
      />
      <div class="dock-tabs" role="tablist" aria-label="Dock" data-own-arrows onKeyDown={tabKeys}>
        <For each={panes()}>
          {(p) => (
            <button
              class="dock-tab"
              role="tab"
              classList={{ on: dockTab() === p.id }}
              aria-selected={dockTab() === p.id}
              tabIndex={dockTab() === p.id ? 0 : -1}
              onClick={() => setDockTab(p.id)}
            >
              <Icon name={p.icon} size={12} />
              <span class="ellipsis">{p.title}</span>
              <Show when={p.count?.()}>
                <span class="n">{p.count!()}</span>
              </Show>
            </button>
          )}
        </For>
        <For each={termTabs()}>{(tab) => <TermTabButton tab={tab} />}</For>
        <span class="spacer" />
        <button class="btn sm ghost icon" title={withKeys("Hide", "dock.toggle")} aria-label="Hide the dock" onClick={() => setDockOpen(false)}>
          <Icon name="chevron-down" size={13} />
        </button>
      </div>
      <div class="dock-body">
        <For each={termTabs()}>
          {(tab) => (
            <div class="dock-pane" classList={{ on: dockTab() === tab.id }}>
              {tab.target.kind === "logs" ? (
                <DockLogs id={tab.id} spec={tab.target.spec} />
              ) : (
                <Suspense>
                  <TerminalView tab={tab} visible={dockOpen() && dockTab() === tab.id} />
                </Suspense>
              )}
            </div>
          )}
        </For>
        <For each={panes()}>
          {(p) => (
            <Show when={dockTab() === p.id}>
              <div class="dock-pane on">{p.component()}</div>
            </Show>
          )}
        </For>
        <Show when={empty()}>
          <div class="dock-empty faint">
            <Icon name="terminal" size={20} />
            <span>
              No terminals. <Kbd id="action.shell" /> opens a shell in the selected pod, <Kbd id="action.attach" /> attaches to it.
            </span>
          </div>
        </Show>
      </div>
    </section>
  );
}

/** Tabs name their cluster when there is a choice: terminals in several clusters, or one in a cluster not shown above. */
function clusterLabels(): boolean {
  const clusters = new Set(termTabs().map(termCluster));
  return clusters.size > 1 || selectedClusters().length > 1 || [...clusters].some((c) => !selectedClusters().includes(c));
}

function TermTabButton(props: { tab: TermTab }) {
  let button!: HTMLButtonElement;
  // The tab shown is scrolled into view (a new one opens at the end of a strip that may overflow).
  createEffect(on(dockTab, (t) => t === props.tab.id && requestAnimationFrame(() => button?.scrollIntoView({ block: "nearest", inline: "nearest" }))));
  const status = () => termStatus[props.tab.id];
  const cluster = () => termCluster(props.tab);
  const title = () => termTitle(props.tab, status());
  const tooltip = () => {
    const s = status();
    const t = props.tab.target;
    const where = `${cluster()} · ${t.kind === "node" ? t.spec.node : t.kind === "logs" ? title() : `${t.spec.namespace}/${title()}`}`;
    if (!s) return where;
    const state = s.state === "ended" ? (s.error ? `failed: ${s.message ?? ""}` : `exited${s.code != null ? ` (${s.code})` : ""}`) : `${s.state}${s.message ? `: ${s.message}` : ""}`;
    return `${where}\n${state}`;
  };
  return (
    <button
      ref={button}
      class="dock-tab"
      role="tab"
      classList={{ on: dockTab() === props.tab.id, ended: status()?.state === "ended" }}
      aria-selected={dockTab() === props.tab.id}
      tabIndex={dockTab() === props.tab.id ? 0 : -1}
      title={`${tooltip()}\n⌫ or middle click: close`}
      onClick={() => setDockTab(props.tab.id)}
      onAuxClick={(e) => e.button === 1 && closeTerminal(props.tab.id)}
    >
      <Switch fallback={props.tab.target.kind === "logs" ? <Icon name="logs" size={11} style={{ color: clusterColor(cluster()) }} /> : <span class="swatch" style={{ background: clusterColor(cluster()) }} />}>
        <Match when={status()?.state === "connecting" || status()?.state === "waiting"}>
          <span class="spinner" style={{ width: "9px", height: "9px" }} />
        </Match>
        <Match when={status()?.state === "ended" && status()?.error}>
          <span class="swatch" style={{ background: "var(--err)" }} />
        </Match>
      </Switch>
      <Show when={clusterLabels()}>
        <span class="cl">{shortName(cluster())}</span>
      </Show>
      <span class="ellipsis">{title()}</span>
      <span
        class="x"
        aria-hidden="true"
        title="Close (ends the session)"
        onClick={(e) => {
          e.stopPropagation();
          closeTerminal(props.tab.id);
        }}
      >
        <Icon name="x" size={11} />
      </span>
    </button>
  );
}
