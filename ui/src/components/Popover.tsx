import { createSignal, getOwner, type JSX, onCleanup, onMount } from "solid-js";
import { Portal } from "solid-js/web";
import { bind, bindAll, canonicalCombo, keyCombos } from "../lib/hotkeys";
import { popoverClosed, popoverOpened } from "../state/ui";

export interface PopoverProps {
  /** Element to anchor below, or a point (context menus). */
  anchor: HTMLElement | { x: number; y: number } | undefined;
  onClose: () => void;
  width?: number;
  maxHeight?: number;
  align?: "left" | "right";
  class?: string;
  children: JSX.Element;
}

/** The items of a menu in the popover, in order: what ↑ / ↓ go through. */
const menuItems = (box: HTMLElement) => [...box.querySelectorAll<HTMLElement>(".menu .opt:not(:disabled)")];

/**
 * A menu's keys, while focus is on one of its items: the key an item shows (its `data-key`) runs it, as a click does —
 * while a menu is open the keys are its own, and act on what it is for; ↑ / ↓ (j / k) go round the items, Home / End
 * to the first and the last, another letter to the next item starting with it, Tab leaves (closing the menu, as menus
 * do). ↵ and Space are the items' own (they are buttons).
 */
function menuKeys(box: HTMLElement, e: KeyboardEvent, close: () => void) {
  const items = menuItems(box);
  const at = items.indexOf(document.activeElement as HTMLElement);
  if (at < 0) return;
  const combos = keyCombos(e);
  for (const combo of combos) {
    const item = items.find((el) => el.dataset.key && canonicalCombo(el.dataset.key) === combo);
    if (item) {
      e.preventDefault();
      item.click();
      return;
    }
  }
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const go = (i: number) => {
    e.preventDefault();
    items[(i + items.length) % items.length]?.focus();
  };
  if (e.key === "ArrowDown" || combos.includes("j")) go(at + 1);
  else if (e.key === "ArrowUp" || combos.includes("k")) go(at - 1);
  else if (e.key === "Home" || e.key === "PageUp") go(0);
  else if (e.key === "End" || e.key === "PageDown") go(items.length - 1);
  else if (e.key === "Tab") {
    e.preventDefault();
    close();
  } else if (e.key.length === 1 && /\S/.test(e.key)) {
    const ch = e.key.toLowerCase();
    const label = (el: HTMLElement) => (el.textContent ?? "").trim().toLowerCase();
    for (let step = 1; step <= items.length; step++) {
      const i = (at + step) % items.length;
      if (label(items[i]).startsWith(ch)) return go(i);
    }
  }
}

export function Popover(props: PopoverProps) {
  let box!: HTMLDivElement;
  const width = () => props.width ?? 320;
  const position = () => {
    const a = props.anchor;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = 8;
    let top = 8;
    if (a instanceof HTMLElement) {
      const r = a.getBoundingClientRect();
      top = r.bottom + 6;
      left = props.align === "right" ? r.right - width() : r.left;
    } else if (a) {
      top = a.y;
      left = a.x;
    }
    left = Math.max(8, Math.min(left, vw - width() - 8));
    const maxHeight = Math.min(props.maxHeight ?? 520, vh - top - 12);
    return { top: `${top}px`, left: `${left}px`, width: `${width()}px`, "max-height": `${Math.max(maxHeight, 160)}px` };
  };

  onMount(() => {
    const off = bind({ combo: "escape", run: () => props.onClose(), inInputs: true, priority: 100 });
    onCleanup(off);
    // While it is open the keys are its own: the table and the details behind it don't move (see `modalOpen`).
    popoverOpened();
    onCleanup(popoverClosed);
    // A menu takes the keyboard at once, on its first item (a picker's search field takes it by itself). Whatever
    // had it before gets it back when the popover closes: the keys of the logs, say, must keep working.
    const back = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
    queueMicrotask(() => {
      if (!box.isConnected || box.contains(document.activeElement)) return;
      menuItems(box)[0]?.focus({ preventScroll: true });
    });
    onCleanup(() => {
      const at = document.activeElement;
      const lost = !at || at === document.body || !at.isConnected || box.contains(at);
      if (lost && back?.isConnected) back.focus({ preventScroll: true });
    });
  });

  return (
    <Portal>
      <div class="overlay" onMouseDown={() => props.onClose()} onContextMenu={(e) => (e.preventDefault(), props.onClose())} />
      <div ref={box} class={`popover ${props.class ?? ""}`} style={position()} onKeyDown={(e) => menuKeys(box, e, props.onClose)}>
        {props.children}
      </div>
    </Portal>
  );
}

/** Open keyboard lists, innermost last: ⌃N/⌃P move the highlight of the last one. */
const openLists: { move(delta: number): void }[] = [];
let offListKeys: (() => void) | undefined;

/**
 * Emacs-style ⌃N/⌃P in lists. They are global bindings rather than input handlers: off macOS Ctrl is
 * the shortcut modifier, and Ctrl+P (open the palette) would otherwise fire first.
 */
function trackList(list: { move(delta: number): void }) {
  openLists.push(list);
  offListKeys ??= bindAll(
    ([["ctrl+n", 1], ["ctrl+p", -1]] as const).map(([combo, delta]) => ({ combo, inInputs: true, priority: 150, run: () => openLists[openLists.length - 1]?.move(delta) })),
  );
  return () => {
    openLists.splice(openLists.indexOf(list), 1);
    if (!openLists.length) {
      offListKeys?.();
      offListKeys = undefined;
    }
  };
}

/**
 * Keyboard-navigable list state: ↑/↓/⌃N/⌃P/PgUp/PgDn move (and scroll the highlight into view), Enter activates.
 * Mouse hover only highlights — it never scrolls. WebKit fires synthetic `mousemove`s while a list
 * scrolls under a resting cursor; if hover scrolled too, hover → scroll → hover would loop forever.
 * Virtualized lists pass `reveal` (the highlighted row may not be in the DOM yet).
 */
export function createListNav(count: () => number, container: () => HTMLElement | undefined, reveal?: (i: number) => void) {
  const [index, setIndex] = createSignal(0);
  const clamp = (i: number) => Math.max(0, Math.min(i, count() - 1));
  const moveTo = (i: number) => {
    const next = clamp(i);
    setIndex(next);
    if (reveal) reveal(next);
    else queueMicrotask(() => container()?.querySelector(".opt.hl")?.scrollIntoView({ block: "nearest" }));
  };
  if (getOwner()) onCleanup(trackList({ move: (delta) => moveTo(index() + delta) }));
  const onKeyDown = (e: KeyboardEvent, activate: (i: number, e: KeyboardEvent) => void) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      moveTo(index() + 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      moveTo(index() - 1);
    } else if (e.key === "PageDown") {
      e.preventDefault();
      moveTo(index() + 8);
    } else if (e.key === "PageUp") {
      e.preventDefault();
      moveTo(index() - 8);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (count() > 0) activate(clamp(index()), e);
    }
  };
  /** Highlight on real pointer movement only. */
  const hover = (i: number, e: MouseEvent) => {
    if (e.movementX === 0 && e.movementY === 0) return;
    if (index() !== i) setIndex(i);
  };
  /** Back to the first item (e.g. when the query changes). */
  const reset = () => {
    setIndex(0);
    const c = container();
    if (c) c.scrollTop = 0;
  };
  /** Moves the highlight by `delta` rows (and shows it). */
  const move = (delta: number) => moveTo(index() + delta);
  return { index, setIndex, hover, reset, onKeyDown, move };
}

/** Renders `text` with matched character indices wrapped in <mark>. */
export function Highlight(props: { text: string; indices?: number[] }) {
  return (
    <>
      {(() => {
        const idx = props.indices;
        if (!idx || !idx.length) return props.text;
        const set = new Set(idx);
        const out: JSX.Element[] = [];
        let buf = "";
        let inMark = false;
        for (let i = 0; i < props.text.length; i++) {
          const m = set.has(i);
          if (m !== inMark) {
            if (buf) out.push(inMark ? <mark>{buf}</mark> : buf);
            buf = "";
            inMark = m;
          }
          buf += props.text[i];
        }
        if (buf) out.push(inMark ? <mark>{buf}</mark> : buf);
        return out;
      })()}
    </>
  );
}
