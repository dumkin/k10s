import { type Accessor, createEffect, createMemo, createSignal, For, type JSX, on, onCleanup, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { type Binding, bindAll, comboLabel } from "../lib/hotkeys";
import { Icon, type IconName } from "./Icon";
import { Highlight } from "./Popover";

/** How tall and how wide the menu may get, and how far from the field and the window's edges it keeps. */
const MAX_HEIGHT = 300;
const MAX_WIDTH = 440;
const GAP = 5;
const MARGIN = 8;
/** Less room than this under the field (and more over it): the menu opens upwards. */
const ROOM_BELOW = 160;
/** The menu's keys go first while it is shown: before the table's and the logs' (0), after dialogs (300). */
const PRIORITY = 150;

let menus = 0;
/** What is typed in a field, as a search: literally, in any case. */
const literal = (s: string) => new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");

export interface RecentMenuOptions {
  /** The field: the menu opens under it, and it keeps the keyboard. */
  input: () => HTMLInputElement | undefined;
  /** The box the menu lines up with (the field's), and on which side. */
  anchor: () => HTMLElement | undefined;
  align: "left" | "right";
  /** What was used in the field, the most recent first. */
  list: Accessor<string[]>;
  /** What the field holds. */
  text: Accessor<string>;
  /** Applies an entry picked. */
  pick: (entry: string) => void;
  /** Forgets an entry (null: every one). */
  forget: (entry: string | null) => void;
  /** What it lists: "Recent filters". */
  title: string;
  /** What it says while nothing was used yet. */
  empty: string;
  /** The menu is shown: the field puts away its own suggestions. */
  onShow?: () => void;
}

/**
 * A field's menu of what was used in it lately (see `lib/recent`): shown on ↑ in the field (the entries holding what it
 * holds; with none, all of them) or a click on its icon (all of them), never by itself. The keyboard stays in the field:
 * while the menu is shown its keys come first (↑ ↓ PgUp PgDn ⌃N ⌃P, ↵ Tab, Esc, ⇧⌫), and typing narrows it. It floats
 * over the window like a popover, so no card it opens in cuts it off.
 */
export function createRecentMenu(opts: RecentMenuOptions) {
  const listId = `recent-${++menus}`;
  /** Which entries are shown: those holding what the field holds, or all of them; null: hidden. */
  const [mode, setMode] = createSignal<"match" | "all" | null>(null);
  /** The entry highlighted. */
  const [index, setIndex] = createSignal(0);
  /** The highlight was put there on purpose (by the keys, by the pointer) since the last thing typed: ⇧⌫ forgets it. */
  let picked = false;
  let list: HTMLDivElement | undefined;

  const search = createMemo(() => {
    const t = opts.text().trim();
    return mode() === "match" && t ? literal(t) : null;
  });
  /** The entries shown: not the one the field holds already. */
  const entries = createMemo(() => {
    if (!mode()) return [];
    const t = opts.text().trim();
    const re = search();
    return opts.list().filter((e) => e !== t && (!re || re.test(e)));
  });

  const hide = () => setMode(null);
  const show = (m: "match" | "all") => {
    setIndex(0);
    picked = true;
    setMode(m);
    opts.onShow?.();
  };
  const pick = (entry: string) => {
    hide();
    opts.pick(entry);
  };
  const forget = (entry: string) => {
    opts.forget(entry);
    if (!entries().length) hide();
    else setIndex((i) => Math.min(i, entries().length - 1));
  };
  const move = (by: number) => {
    const n = entries().length;
    if (!n) return false;
    setIndex((i) => Math.max(0, Math.min(n - 1, i + by)));
    picked = true;
    queueMicrotask(() => list?.querySelector(".opt.hl")?.scrollIntoView?.({ block: "nearest" }));
  };

  // Typing narrows what is shown (from all of them to those holding it): with none left, the menu goes.
  createEffect(
    on(
      opts.text,
      () => {
        if (!mode()) return;
        picked = false;
        setMode("match");
        if (!entries().length) return hide();
        setIndex(0);
        if (list?.scrollTop) list.scrollTop = 0;
      },
      { defer: true },
    ),
  );

  /** A key in the field while the menu is hidden: a plain ↑ shows it. True: it took the key. */
  const keyDown = (e: KeyboardEvent) => {
    if (mode() || e.key !== "ArrowUp" || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || e.isComposing || e.keyCode === 229) return false;
    const t = opts.text().trim();
    const others = opts.list().filter((x) => x !== t);
    if (!others.length) return false;
    const re = t ? literal(t) : null;
    // Those holding what is typed; with none (a whole query standing in the field), all of them, as a shell's ↑ goes back.
    show(!re || others.some((x) => re.test(x)) ? "match" : "all");
    e.preventDefault();
    return true;
  };

  /** Under the field and within the window; over it where there is no room under it (a dock's field, low in the window). */
  const place = (): JSX.CSSProperties => {
    const r = opts.anchor()?.getBoundingClientRect();
    if (!r) return {};
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const below = vh - r.bottom - GAP - MARGIN;
    const above = r.top - GAP - MARGIN;
    const up = below < ROOM_BELOW && above > below;
    const right = opts.align === "right";
    const width = Math.max(0, Math.min(MAX_WIDTH, right ? r.right - MARGIN : vw - Math.max(MARGIN, r.left) - MARGIN));
    const style: JSX.CSSProperties = {
      "max-width": `${width}px`,
      "min-width": `${Math.min(width, Math.max(240, r.width))}px`,
      "max-height": `${Math.max(0, Math.min(MAX_HEIGHT, up ? above : below))}px`,
      "transform-origin": up ? "bottom center" : "top center",
    };
    if (up) style.bottom = `${vh - r.top + GAP}px`;
    else style.top = `${r.bottom + GAP}px`;
    if (right) style.right = `${Math.max(MARGIN, vw - r.right)}px`;
    else style.left = `${Math.max(MARGIN, r.left)}px`;
    return style;
  };

  function Menu() {
    let box!: HTMLDivElement;
    const field = opts.input();
    const own = () => document.activeElement === field;
    const take = (e: KeyboardEvent) => {
      // WebKit sends the ↵ that ends an IME composition after the composition (keyCode 229): it is the composition's.
      if (!entries().length || e.keyCode === 229) return false;
      pick(entries()[index()]);
    };
    const keys: Binding[] = [
      { combo: "arrowdown", run: () => move(1) },
      { combo: "arrowup", run: () => move(-1) },
      { combo: "ctrl+n", run: () => move(1) },
      { combo: "ctrl+p", run: () => move(-1) },
      { combo: "pagedown", run: () => move(8) },
      { combo: "pageup", run: () => move(-8) },
      { combo: "enter", run: take },
      { combo: "tab", run: take },
      { combo: "escape", run: () => void hide() },
      {
        combo: "shift+backspace",
        // Only for an entry highlighted on purpose: typing with ⇧ held (capitals, `!`) then ⌫ edits the text.
        run: () => {
          if (!picked || !entries().length) return false;
          forget(entries()[index()]);
        },
      },
    ];
    onCleanup(bindAll(keys.map((b) => ({ ...b, inInputs: true, priority: PRIORITY, when: own }))));

    // Gone once a click or the keyboard is elsewhere, or the field lost the keyboard (to another window too).
    const away = (e: Event) => {
      const t = e.target as Node;
      if (!box.contains(t) && !opts.anchor()?.contains(t)) hide();
    };
    const [style, setStyle] = createSignal(place());
    const replace = () => setStyle(place());
    document.addEventListener("mousedown", away, true);
    document.addEventListener("focusin", away, true);
    field?.addEventListener("blur", hide);
    window.addEventListener("resize", replace);
    onCleanup(() => {
      document.removeEventListener("mousedown", away, true);
      document.removeEventListener("focusin", away, true);
      field?.removeEventListener("blur", hide);
      window.removeEventListener("resize", replace);
    });

    /** Where an entry holds what is typed: marked there. */
    const marked = (entry: string) => {
      const m = search()?.exec(entry);
      return m ? Array.from({ length: m[0].length }, (_, k) => m.index + k) : undefined;
    };

    return (
      // The field keeps the keyboard: a click in the menu does not take it.
      <div ref={box} class="popover recent-menu" style={style()} onMouseDown={(e) => e.preventDefault()}>
        <div class="pop-group" aria-hidden="true">
          {opts.title}
        </div>
        <Show
          when={entries().length}
          fallback={
            <div class="pop-list">
              <div class="opt faint">{opts.empty}</div>
            </div>
          }
        >
          <div ref={list} id={listId} class="pop-list" role="listbox" aria-label={opts.title}>
            <For each={entries()}>
              {(entry, i) => (
                <div
                  id={`${listId}-${i()}`}
                  class="opt"
                  role="option"
                  aria-selected={i() === index()}
                  classList={{ hl: i() === index() }}
                  title={entry}
                  // A real move of the pointer, not the list scrolling under it.
                  onMouseMove={(e) => {
                    if (!e.movementX && !e.movementY) return;
                    setIndex(i());
                    picked = true;
                  }}
                  onClick={() => {
                    pick(entry);
                    swallowSecondClick();
                  }}
                >
                  <span class="recent-text ellipsis">
                    <Highlight text={entry} indices={marked(entry)} />
                  </span>
                  <span class="opt-actions" aria-hidden="true">
                    <span
                      class="btn sm ghost icon"
                      title={`Forget it (${comboLabel("shift+backspace")})`}
                      onClick={(e) => {
                        e.stopPropagation();
                        forget(entry);
                      }}
                    >
                      <Icon name="x" size={11} />
                    </span>
                  </span>
                </div>
              )}
            </For>
          </div>
          <div class="pop-foot">
            <span>
              {comboLabel("enter")} apply · {comboLabel("shift+backspace")} forget
            </span>
            <span class="grow" />
            <button
              class="btn sm ghost"
              onClick={() => {
                opts.forget(null);
                hide();
              }}
            >
              Forget all
            </button>
          </div>
        </Show>
      </div>
    );
  }

  return {
    shown: () => mode() !== null,
    keyDown,
    hide,
    /** For the field's ARIA: the list it controls, and the entry highlighted in it. */
    listId,
    activeId: () => (mode() && entries().length ? `${listId}-${index()}` : undefined),
    /** The field's icon: a click shows every entry, or hides the menu; the field keeps (or gets) the keyboard. */
    Button: (p: { icon: IconName; size: number }) => (
      <button
        class="recent-btn"
        tabIndex={-1}
        title={`${opts.title} (${comboLabel("arrowup")})`}
        aria-label={opts.title}
        aria-haspopup="listbox"
        aria-expanded={mode() !== null}
        onMouseDown={(e) => {
          e.preventDefault();
          opts.input()?.focus();
          if (mode()) hide();
          else show("all");
        }}
      >
        <Icon name={p.icon} size={p.size} />
        <Icon name="chevron-down" size={Math.round(p.size * 0.7)} strokeWidth={2.2} />
      </button>
    ),
    /** The menu, floating over the window (it may go anywhere in the field's component). */
    View: () => (
      <Show when={mode()}>
        <Portal>
          <Menu />
        </Portal>
      </Show>
    ),
  };
}

/**
 * An entry picked with a click takes the menu away from under the pointer: the second click of a double click would land
 * on what was under it (a row of the table, whose details it would open). It is not passed on.
 */
function swallowSecondClick() {
  const types = ["mousedown", "mouseup", "click", "dblclick"] as const;
  const stop = (e: MouseEvent) => {
    if (e.detail < 2) {
      if (e.type === "mousedown") done();
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    if (e.type === "dblclick") done();
  };
  // Past the system's double-click interval a press is a new click anyway.
  const timer = setTimeout(() => done(), 1500);
  const done = () => {
    clearTimeout(timer);
    for (const t of types) window.removeEventListener(t, stop, true);
  };
  for (const t of types) window.addEventListener(t, stop, true);
}
