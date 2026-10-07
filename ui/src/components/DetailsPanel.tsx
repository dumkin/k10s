import { type Accessor, createEffect, createMemo, createSignal, For, Index, on, onCleanup, onMount, Show, untrack } from "solid-js";
import { Dynamic } from "solid-js/web";
import { age } from "../lib/format";
import { type Binding, bindAll, comboLabel } from "../lib/hotkeys";
import { splitterKeyDown } from "../lib/splitter";
import { type ActionContext, actionLabel, actionsFor, actionTitle, type ResourceAction } from "../registry/actions";
import { catalogEntry } from "../registry/catalog";
import { type DetailTab, DetailReadyContext, tabsFor } from "../registry/details";
import { clusterColor } from "../state/clusters";
import { detailsHaveKeyboard, onControl } from "../state/keyboard";
import { closeDetails, currentResource, detailsFull, detailsTab, marked, objectRef, resourceKey, selectedKey, setDetailsFull, setDetailsTab } from "../state/nav";
import { detailsWidth, now, setDetailsWidth } from "../state/ui";
import type { UIRow } from "../state/view";
import { mainView } from "../state/views";
import { ActionMenuItems } from "./ActionMenu";
import { Boundary } from "./Boundary";
import { Icon } from "./Icon";
import { Popover } from "./Popover";

/**
 * Tabs open watches, log streams and reads of the object they show: when another row is selected, they wait
 * for the selection to rest this long (j/k held down passes rows by without opening anything for them).
 */
export const SETTLE_MS = 180;

/** What `j` / `k` (and ↓ / ↑) scroll the details by: two lines of logs or YAML. */
const SCROLL_STEP = 36;

/** The narrowest the panel gets beside the table; the widest is a share of the window. */
const MIN_WIDTH = 380;
const maxWidth = () => Math.max(MIN_WIDTH, Math.round(window.innerWidth * 0.78));

export function DetailsPanel() {
  const live = createMemo(() => {
    mainView.version();
    const k = selectedKey();
    return k ? mainView.rowByKey(k) : undefined;
  });
  // Keep showing an object after it was deleted (marked as such) instead of yanking the panel away — and the
  // generation of the view it was last seen in: other namespaces or clusters list everything anew.
  const [last, setLast] = createSignal<{ row: UIRow; generation: number }>();
  createEffect(() => {
    const r = live();
    if (r) setLast({ row: r, generation: untrack(mainView.generation) });
  });
  const row = createMemo(() => {
    const r = live();
    if (r) return r;
    const l = last();
    return l && l.row.key === selectedKey() ? l.row : undefined;
  });
  /**
   * Why the object shown is not in the table: gone from the view it was in (deleted), or the view changed — while
   * that reloads it may come back (`reloading`: it still shows as it was, actions included); once loaded without
   * it, it is just not in this view (other namespaces, a cluster left out).
   */
  const missing = createMemo<"deleted" | "reloading" | "elsewhere" | undefined>(() => {
    if (!row() || live()) return undefined;
    if (last()!.generation === mainView.generation()) return "deleted";
    return mainView.loading() ? "reloading" : "elsewhere";
  });
  const shown = createMemo<UIRow>((prev) => row() ?? prev!);

  const tabs = createMemo(() => tabsFor(resourceKey(), currentResource()));
  const active = createMemo(() => tabs().find((t) => t.id === detailsTab()) ?? tabs()[0]);
  const actionCtx = createMemo<ActionContext>(() => ({ resourceKey: resourceKey(), resource: currentResource(), rows: row() && (!missing() || missing() === "reloading") ? [row()!] : [] }));
  const actions = createMemo(() => actionsFor(actionCtx()).filter((a) => !["yaml", "events", "logs", "compare"].includes(a.id)));
  const kind = () => currentResource()?.kind ?? catalogEntry(resourceKey())?.title ?? resourceKey();

  // ------------------------------------------------------------------ the tabs' object
  //
  // The tabs show one object at a time: the one the panel opened with, then each one the selection rests on. While the
  // selection moves on (j / k held down), they keep showing the object they were mounted for — stepped back a little —
  // instead of going blank on every row: nothing is opened for the rows passed, and the panel does not blink.
  const objectKey = createMemo(() => row()?.key);
  const [contentKey, setContentKey] = createSignal(untrack(objectKey));
  createEffect(
    on(objectKey, (key) => {
      if (key === undefined || untrack(contentKey) === undefined || key === untrack(contentKey)) return setContentKey(key);
      const t = setTimeout(() => setContentKey(key), SETTLE_MS);
      onCleanup(() => clearTimeout(t));
    }),
  );
  /**
   * The tabs' layers: the one shown, and — once the selection rests on another object — the next one, mounted out of
   * sight until it has something to show (see `deferReady`), then swapped in at once: the panel goes from one object
   * to the next without a blank frame between them, also when the next one takes a moment to load.
   */
  const [layers, setLayers] = createSignal<Layer[]>([]);
  createEffect(
    on(contentKey, (key) => {
      if (key === undefined) return setLayers([]);
      const now = untrack(layers);
      if (now.at(-1)?.key === key) return;
      // At most the one shown stays (a next one still loading is dropped for this one).
      const keep = now.filter((l) => l.ready()).slice(-1);
      if (keep[0]?.key === key) return setLayers(keep);
      const [ready, setReady] = createSignal(keep.length === 0);
      setLayers([...keep, { key, ready, setReady }]);
    }),
  );
  // The next one is ready: the one it replaces goes — and the next object starts at the top (a tab that scrolls with
  // the panel's body would keep the previous one's place).
  let body: HTMLDivElement | undefined;
  createEffect(() => {
    const ls = layers();
    if (ls.length < 2 || !ls[ls.length - 1].ready()) return;
    setLayers([ls[ls.length - 1]]);
    if (body) body.scrollTop = 0;
  });
  // Another kind of object (history went back to another view): what the tabs showed has nothing to do with it.
  createEffect(
    on(
      resourceKey,
      () => {
        setLayers([]);
        setContentKey(undefined);
        setContentKey(untrack(objectKey));
      },
      { defer: true },
    ),
  );
  /** What the tabs show belongs to another object than the one selected (the selection moved on, or it loads). */
  const stale = () => layers().some((l) => l.ready() && l.key !== objectKey());

  // ------------------------------------------------------------------ keyboard
  let panel: HTMLElement | undefined;
  /** What the details scroll: the log, YAML or list of a tab that scrolls itself (the one shown), else the panel's body. */
  const scroller = () =>
    panel?.querySelector<HTMLElement>(".d-body > .d-layer:not(.pending) .code, .d-body > .d-layer:not(.pending) .scroller") ?? panel?.querySelector<HTMLElement>(".d-body") ?? null;
  onMount(() => {
    // Like less (and k9s's logs): while the details have the keyboard (full view, or focus in them), keys scroll them.
    const scroll =
      (to: (el: HTMLElement) => number) =>
      (e: KeyboardEvent): boolean | void => {
        const el = scroller();
        if (!el || onControl(e)) return false;
        el.scrollTop = to(el);
      };
    const down = scroll((el) => el.scrollTop + SCROLL_STEP);
    const up = scroll((el) => el.scrollTop - SCROLL_STEP);
    const pageDown = scroll((el) => el.scrollTop + el.clientHeight * 0.9);
    const pageUp = scroll((el) => el.scrollTop - el.clientHeight * 0.9);
    const top = scroll(() => 0);
    const bottom = scroll((el) => el.scrollHeight);
    const keys: [string, (e: KeyboardEvent) => boolean | void][] = [
      ["j", down],
      ["arrowdown", down],
      ["k", up],
      ["arrowup", up],
      ["pagedown", pageDown],
      ["space", pageDown],
      ["pageup", pageUp],
      ["shift+space", pageUp],
      ["g", top],
      ["home", top],
      ["shift+g", bottom],
      ["end", bottom],
    ];
    onCleanup(bindAll(keys.map(([combo, run]): Binding => ({ combo, run, when: detailsHaveKeyboard }))));
  });
  // Leaving full view hands the keyboard back to the table (focus left inside would keep it here).
  createEffect(
    on(
      detailsFull,
      (full) => {
        const active = document.activeElement as HTMLElement | null;
        if (!full && active && panel?.contains(active)) active.blur();
      },
      { defer: true },
    ),
  );

  const [resizing, setResizing] = createSignal(false);
  const startResize = (e: MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = detailsWidth();
    setResizing(true);
    const move = (ev: MouseEvent) => setDetailsWidth(Math.max(MIN_WIDTH, Math.min(maxWidth(), startW + startX - ev.clientX)));
    const up = () => {
      setResizing(false);
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };
  const resizeKeys = splitterKeyDown({ value: detailsWidth, set: setDetailsWidth, min: () => MIN_WIDTH, max: maxWidth, grow: "ArrowLeft", shrink: "ArrowRight" });

  /** ← / → (Home, End) along the tabs: to the previous / next one, which opens at once. */
  const tabKeys = (e: KeyboardEvent) => {
    const list = tabs();
    const at = list.findIndex((t) => t.id === active()?.id);
    let next: number;
    if (e.key === "ArrowRight") next = (at + 1) % list.length;
    else if (e.key === "ArrowLeft") next = (at - 1 + list.length) % list.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = list.length - 1;
    else return;
    e.preventDefault();
    setDetailsTab(list[next].id);
    queueMicrotask(() => panel?.querySelector<HTMLElement>(`#d-tab-${list[next].id}`)?.focus());
  };

  return (
    <Show when={row()}>
      {(r) => (
        <aside
          ref={panel}
          class="details"
          aria-label={`${kind()} ${r().n}`}
          // Tabs give up their keys, icons and titles as the panel narrows (CSS container queries; tooltips keep them).
          classList={{ full: detailsFull() }}
          style={detailsFull() ? undefined : { width: `${detailsWidth()}px` }}
        >
          <Show when={!detailsFull()}>
            <div
              class="resizer"
              classList={{ dragging: resizing() }}
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize the details"
              aria-valuenow={detailsWidth()}
              aria-valuemin={MIN_WIDTH}
              aria-valuemax={maxWidth()}
              tabIndex={0}
              data-own-arrows
              onMouseDown={startResize}
              onKeyDown={resizeKeys}
            />
          </Show>
          <div class="d-head">
            <div class="d-title">
              <span class="kind-icon">
                <Icon name={catalogEntry(resourceKey())?.icon ?? "crd"} size={17} />
              </span>
              <div class="grow" style={{ "min-width": 0 }}>
                <h2 class="selectable">{r().n}</h2>
                <div class="sub">
                  <span>{kind()}</span>
                  <span class="chip" title="Cluster">
                    <span class="swatch" style={{ background: clusterColor(r().cl) }} />
                    {r().cl}
                  </span>
                  <Show when={r().ns}>
                    <span class="chip">
                      <Icon name="namespace" size={11} />
                      {r().ns}
                    </span>
                  </Show>
                  <span class="faint">{age(r().t, now())}</span>
                  <Show when={missing() === "deleted"}>
                    <span class="badge err">deleted</span>
                  </Show>
                  <Show when={missing() === "elsewhere"}>
                    <span class="badge" title="The table shows other namespaces or clusters now">not in this view</span>
                  </Show>
                </div>
              </div>
              <button
                class="btn ghost icon"
                classList={{ on: detailsFull() }}
                title={detailsFull() ? `Back to the table (${comboLabel("f")} or Esc)` : `Full view — more room for logs and YAML (${comboLabel("f")})`}
                aria-label={detailsFull() ? "Back to the table" : "Full view"}
                aria-pressed={detailsFull()}
                data-hint="f"
                data-hint-at="below"
                onClick={() => setDetailsFull(!detailsFull())}
              >
                <Icon name={detailsFull() ? "minimize" : "maximize"} size={14} />
              </button>
              <button class="btn ghost icon" title="Close (Esc)" aria-label="Close the details" data-hint={detailsFull() ? undefined : "escape"} data-hint-at="below" onClick={closeDetails}>
                <Icon name="x" size={15} />
              </button>
            </div>
            <Show when={actions().length}>
              <ActionsBar actions={actions()} ctx={actionCtx()} />
            </Show>
            <div class="tabs" role="tablist" aria-label="Details" data-own-arrows onKeyDown={tabKeys}>
              <For each={tabs()}>
                {(t) => (
                  <button
                    id={`d-tab-${t.id}`}
                    class="tab"
                    role="tab"
                    aria-selected={active()?.id === t.id}
                    aria-controls="d-panel"
                    // One stop for the strip (the open tab); ← → move along it.
                    tabIndex={active()?.id === t.id ? 0 : -1}
                    classList={{ active: active()?.id === t.id }}
                    onClick={() => setDetailsTab(t.id)}
                    title={t.shortcut ? `${t.title} (${comboLabel(t.shortcut)})` : t.title}
                  >
                    <Icon name={t.icon} size={13} />
                    <span class="tab-title">{t.title}</span>
                    <Show when={t.shortcut}>
                      <span class="kbd" aria-hidden="true">
                        {t.shortcut!.toUpperCase()}
                      </span>
                    </Show>
                  </button>
                )}
              </For>
            </div>
          </div>
          <div ref={body} id="d-panel" class="d-body" classList={{ flush: !!active()?.flush, stale: stale() }} role="tabpanel" aria-labelledby={active() ? `d-tab-${active()!.id}` : undefined} aria-busy={stale()}>
            <For each={layers()}>{(layer) => <ContentLayer layer={layer} objectKey={objectKey} shown={shown} active={active} />}</For>
          </div>
        </aside>
      )}
    </Show>
  );
}

/** One object's tabs in the panel (see `layers`): `ready` once it has something to show. */
interface Layer {
  key: string;
  ready: Accessor<boolean>;
  setReady: (ready: boolean) => void;
}

/** The longest the panel waits for the next object's tab to be ready before it shows it anyway (loading). */
export const READY_WAIT_MS = 450;

function ContentLayer(p: { layer: Layer; objectKey: Accessor<string | undefined>; shown: Accessor<UIRow>; active: Accessor<DetailTab | undefined> }) {
  /**
   * The row this layer's tabs show: the selected object's while it is the one selected; once the selection moves on,
   * the one it was mounted for, kept live as long as the view lists it. Never another object's: a tab reading this
   * must not react to the rows passed (it would open a watch or a log stream for each of them).
   */
  const row = createMemo<UIRow | undefined>((prev) => {
    const k = p.layer.key;
    if (k === p.objectKey()) return p.shown();
    mainView.version();
    return mainView.rowByKey(k) ?? (prev?.key === k ? prev : undefined);
  });
  // Ready at once, unless the tab said while it was set up that it will say so (and then within READY_WAIT_MS).
  let pending = 0;
  const defer = () => {
    pending++;
    let done = false;
    return () => {
      if (done) return;
      done = true;
      if (--pending === 0) p.layer.setReady(true);
    };
  };
  onMount(() => {
    if (pending === 0) return p.layer.setReady(true);
    const t = setTimeout(() => p.layer.setReady(true), READY_WAIT_MS);
    onCleanup(() => clearTimeout(t));
  });
  // The tab: the one picked — except in a layer left behind (another object selected), which keeps the tab it shows:
  // picking another one meanwhile must not open it for an object the user has moved away from.
  const tab = createMemo<DetailTab | undefined>((prev) => (prev === undefined || p.layer.key === p.objectKey() ? p.active() : prev));
  return (
    <div class="d-layer" classList={{ pending: !p.layer.ready(), stale: p.layer.key !== p.objectKey() }} aria-hidden={p.layer.ready() ? undefined : "true"}>
      <DetailReadyContext.Provider value={defer}>
        <Show when={tab()} keyed>
          {(tab) => (
            <Boundary where={`the ${tab.title} tab`}>
              <Show when={row()}>{(r) => <Dynamic component={tab.component} row={r()} resourceKey={resourceKey()} resource={currentResource()} target={objectRef(r())} />}</Show>
            </Boundary>
          )}
        </Show>
      </DetailReadyContext.Provider>
    </div>
  );
}

/** Room the "More" button takes at the end of the bar, with the gap before it. */
const MORE_W = 26;
/** The gap between the buttons, and the room before a destructive one (its separator). */
const GAP = 2;
const DANGER_GAP = 9;

/**
 * The object's actions in one line: as many as fit, in their order, and the rest in a "More" menu at its end — the bar
 * never wraps to a second line with "Delete…" alone on it. What fits is measured: the buttons keep their widths
 * (labels don't wrap), so it is a sum against the bar's width, again whenever either changes.
 */
function ActionsBar(props: { actions: ResourceAction[]; ctx: ActionContext }) {
  let bar!: HTMLDivElement;
  let moreBtn: HTMLButtonElement | undefined;
  const [fit, setFit] = createSignal(Infinity);
  const [menuOpen, setMenuOpen] = createSignal(false);
  // Measured right after layout and before paint (a ResizeObserver's callback, an effect after the buttons changed):
  // what does not fit is never painted cut off at the edge first.
  const measure = () => {
    if (!bar?.isConnected) return;
    const buttons = [...bar.querySelectorAll<HTMLElement>(":scope > .btn[data-i]")];
    const room = bar.clientWidth;
    let used = 0;
    const ends = buttons.map((b, i) => (used += (i ? GAP : 0) + (b.classList.contains("danger-act") && i ? DANGER_GAP : 0) + b.offsetWidth));
    if (!ends.length || ends[ends.length - 1] <= room) return setFit(Infinity);
    let n = 0;
    while (n < ends.length && ends[n] + GAP + MORE_W <= room) n++;
    setFit(n);
  };
  onMount(() => {
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(bar);
    onCleanup(() => ro.disconnect());
  });
  // Labels change ("Delete 3…", a lock in read-only mode): measured again.
  createEffect(on(() => props.actions.map((a) => actionLabel(a, props.ctx) + (a.disabled ? "!" : "")).join("|"), measure));
  const hidden = createMemo(() => (fit() >= props.actions.length ? [] : props.actions.slice(fit())));
  // Everything fits again (a wider window): the menu is gone, and must not come back by itself the next time.
  createEffect(() => hidden().length || setMenuOpen(false));
  return (
    <div class="d-actions" ref={bar} role="toolbar" aria-label="Actions">
      {/* By position: the actions are made anew as the cluster answers access checks; a focused button stays. */}
      <Index each={props.actions}>
        {(a, i) => (
          <button
            class="btn sm ghost"
            data-i={i}
            // Off in read-only mode (an amber lock) or without the permission (a grey one): greyed out, its
            // tooltip says why. Not `disabled`: WebKit shows no tooltip on a disabled control — and a click does
            // nothing either way.
            classList={{ locked: !!a().disabled, rbac: a().lock === "rbac", "danger-act": !!a().danger, overflowed: i >= fit() }}
            aria-disabled={a().disabled ? "true" : undefined}
            aria-hidden={i >= fit() ? "true" : undefined}
            tabIndex={i >= fit() ? -1 : undefined}
            style={a().danger ? { color: "var(--err)" } : undefined}
            // With rows marked, the shortcut acts on the marks, not on this object: don't hint it then.
            title={a().disabled ? a().disabledReason : a().shortcut && !marked().size ? `${actionTitle(a(), props.ctx)} (${comboLabel(a().shortcut!)})` : actionTitle(a(), props.ctx)}
            // The action keys work from the table (see `tableHasKeyboard`).
            data-hint={a().shortcut && !marked().size && !a().disabled && i < fit() ? a().shortcut : undefined}
            data-hint-ctx="table"
            data-hint-at="below"
            onClick={() => !a().disabled && a().run(props.ctx)}
          >
            <Icon name={a().icon} size={12} />
            {actionLabel(a(), props.ctx)}
          </button>
        )}
      </Index>
      <Show when={hidden().length}>
        <button
          ref={moreBtn}
          class="btn sm ghost icon"
          classList={{ on: menuOpen() }}
          title={`More: ${hidden()
            .map((a) => actionLabel(a, props.ctx))
            .join(", ")}`}
          aria-label="More actions"
          aria-haspopup="menu"
          aria-expanded={menuOpen()}
          onClick={() => setMenuOpen(!menuOpen())}
        >
          <Icon name="more" size={14} />
        </button>
      </Show>
      <Show when={menuOpen() && hidden().length}>
        <Popover anchor={moreBtn} onClose={() => setMenuOpen(false)} width={240} align="right">
          <div class="menu" role="menu" aria-label="More actions">
            <ActionMenuItems actions={hidden()} ctx={props.ctx} onRun={() => setMenuOpen(false)} />
          </div>
        </Popover>
      </Show>
    </div>
  );
}
