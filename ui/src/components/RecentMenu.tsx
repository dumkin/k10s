import { type Accessor, createMemo, createSignal, For, type JSX, onCleanup, onMount, Show } from "solid-js";
import { comboLabel } from "../lib/hotkeys";
import { Icon } from "./Icon";
import { createListNav, Highlight } from "./Popover";

/**
 * A field's menu of what was used in it lately (see `lib/recent`): shown on ↑ in the field or a click on its icon, never
 * by itself. The keyboard stays in the field: the field hands its keys to the menu first (`key`), and its typing narrows
 * what is shown (`typed`). What it forgets, the field must not bring back as it is left (see `forget`).
 */
export interface RecentMenu {
  shown: () => boolean;
  /**
   * Shows the entries holding what the field holds, the most recent highlighted (↑ in the field). False if none does:
   * then it stays hidden, and the key is the field's.
   */
  show: () => boolean;
  /** Shows every entry, or hides the menu (a click on the field's icon). */
  toggle: () => void;
  hide: () => void;
  /** A key pressed in the field: true if the menu took it (it is shown, and the key is one of its own). */
  key: (e: KeyboardEvent) => boolean;
  /** The field's text changed: the entries shown follow it (none left: the menu goes). */
  typed: () => void;
  /** The menu, to put under the field. */
  View: () => JSX.Element;
}

export function createRecentMenu(opts: {
  /** What was used, the most recent first (a `RecentList`'s). */
  list: Accessor<string[]>;
  /** What the field holds now. */
  text: () => string;
  /** Applies an entry picked. */
  pick: (entry: string) => void;
  /** Forgets an entry (null: every one). */
  forget: (entry: string | null) => void;
  /** What it lists: "Recent filters". */
  title: string;
  /** What it says while nothing was used yet. */
  empty: string;
}): RecentMenu {
  /** What the entries shown hold ("": every entry); null: hidden. */
  const [match, setMatch] = createSignal<string | null>(null);
  const holding = (text: string) => {
    const m = text.trim().toLowerCase();
    return opts.list().filter((e) => !m || e.toLowerCase().includes(m));
  };
  const entries = createMemo(() => {
    const m = match();
    return m === null ? [] : holding(m);
  });
  /** The list's highlight while the menu is shown (⌃N / ⌃P go to it then, see `createListNav`). */
  let nav: ReturnType<typeof createListNav> | undefined;

  const hide = () => setMatch(null);
  /** Shows what holds `text` from its first entry; false if nothing does. */
  const showFor = (text: string) => {
    if (!holding(text).length) return false;
    setMatch(text);
    nav?.reset();
    return true;
  };
  const pick = (entry: string) => {
    hide();
    opts.pick(entry);
  };
  const forget = (entry: string) => {
    opts.forget(entry);
    if (!entries().length) hide();
    else if (nav && nav.index() >= entries().length) nav.setIndex(entries().length - 1);
  };

  const key = (e: KeyboardEvent): boolean => {
    if (match() === null || e.isComposing) return false;
    const list = entries();
    const plain = !e.metaKey && !e.ctrlKey && !e.altKey;
    const at = () => list[Math.min(nav?.index() ?? 0, list.length - 1)];
    if (e.key === "Escape") hide();
    else if (!list.length || !plain) return false;
    else if (e.key === "Enter" || (e.key === "Tab" && !e.shiftKey)) pick(at());
    else if (e.key === "Backspace" && e.shiftKey) forget(at());
    else if (!e.shiftKey && ["ArrowDown", "ArrowUp", "PageDown", "PageUp"].includes(e.key)) nav?.onKeyDown(e, () => {});
    else return false;
    e.preventDefault();
    return true;
  };

  /** The menu while it is shown: its highlight lives as long as it does. */
  function Menu() {
    let box: HTMLDivElement | undefined;
    const n = createListNav(() => entries().length, () => box);
    nav = n;
    onCleanup(() => {
      if (nav === n) nav = undefined;
    });
    onMount(() => {
      // Gone once a click or the keyboard is elsewhere: also where the field loses the keyboard without a blur (made
      // inert under a dialog).
      const field = box!.parentElement;
      const away = (e: Event) => {
        if (!field?.contains(e.target as Node)) hide();
      };
      document.addEventListener("mousedown", away, true);
      document.addEventListener("focusin", away, true);
      onCleanup(() => {
        document.removeEventListener("mousedown", away, true);
        document.removeEventListener("focusin", away, true);
      });
      // A field low in the window (the dock's) gets a shorter list: all of it within the window, scrolling.
      const room = window.innerHeight - box!.getBoundingClientRect().top - 8;
      if (room < 300) box!.style.maxHeight = `${Math.max(120, room)}px`;
    });
    /** Where an entry holds what was typed (it is marked there). */
    const marked = (entry: string) => {
      const m = match()?.trim().toLowerCase();
      const at = m ? entry.toLowerCase().indexOf(m) : -1;
      return at < 0 ? undefined : Array.from({ length: m!.length }, (_, k) => at + k);
    };
    return (
      // The field keeps the keyboard: a click in the menu does not take it.
      <div ref={box} class="recent-menu" role="listbox" aria-label={opts.title} onMouseDown={(e) => e.preventDefault()}>
        <div class="pop-group">{opts.title}</div>
        <Show when={entries().length} fallback={<div class="recent-empty">{opts.empty}</div>}>
          <For each={entries()}>
            {(entry, i) => (
              <div class="opt" role="option" aria-selected={i() === n.index()} classList={{ hl: i() === n.index() }} onMouseMove={(e) => n.hover(i(), e)} onClick={() => pick(entry)}>
                <span class="recent-text ellipsis">
                  <Highlight text={entry} indices={marked(entry)} />
                </span>
                <span class="opt-actions">
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
          <div class="recent-foot">
            <span>
              {comboLabel("enter")} apply · {comboLabel("shift+backspace")} forget
            </span>
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
    shown: () => match() !== null,
    show: () => showFor(opts.text()),
    toggle: () => (match() !== null ? hide() : void setMatch("")),
    hide,
    key,
    typed: () => {
      if (match() !== null && !showFor(opts.text())) hide();
    },
    View: () => (
      <Show when={match() !== null}>
        <Menu />
      </Show>
    ),
  };
}
