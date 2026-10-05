// Global keyboard shortcuts. Combos: "mod+k" (⌘ on macOS, Ctrl elsewhere), "shift+r", "ctrl+d",
// "escape", "/", "j". Bindings are scoped by an optional `when` predicate and are ignored while
// typing in inputs unless `inInputs` is set. Off macOS there is no separate Control: "ctrl+d" means
// the same as "mod+d" (Ctrl+D), so a binding written for macOS's ⌃ still fires there.

export const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

export interface Binding {
  combo: string;
  run: (e: KeyboardEvent) => void | boolean;
  when?: () => boolean;
  inInputs?: boolean;
  /** Higher priority bindings are tried first (e.g. dialogs over the table). */
  priority?: number;
  /**
   * Also works with the keyboard in a terminal (an element marked `data-own-keys`), which otherwise gets every key —
   * Escape, ⌃C, ⌃D… belong to the program running in it. Only for keys a shell has no use for (⌘ ones on macOS).
   */
  inTerminal?: boolean;
}

const bindings = new Set<Binding>();

const MODIFIERS = ["mod", "ctrl", "meta", "alt", "shift"];
const canonicalCache = new Map<string, string>();

/** One spelling per combo: modifiers in a fixed order, and "ctrl" folded into "mod" off macOS. */
export function canonicalCombo(combo: string): string {
  let out = canonicalCache.get(combo);
  if (out !== undefined) return out;
  const parts = combo.toLowerCase().split("+");
  // "mod++" / "+": the key itself is "+".
  const key = combo.endsWith("+") ? "+" : (parts.pop() ?? "");
  const mods = new Set(parts.filter(Boolean).map((m) => (m === "ctrl" && !isMac ? "mod" : m)));
  out = [...MODIFIERS.filter((m) => mods.has(m)), key].join("+");
  canonicalCache.set(combo, out);
  return out;
}

/** US-layout characters (plain, with Shift) of physical keys, for layouts whose letters aren't Latin. */
const US_KEYS: Record<string, [string, string]> = {
  Backquote: ["`", "~"],
  Minus: ["-", "_"],
  Equal: ["=", "+"],
  BracketLeft: ["[", "{"],
  BracketRight: ["]", "}"],
  Backslash: ["\\", "|"],
  Semicolon: [";", ":"],
  Quote: ["'", '"'],
  Comma: [",", "<"],
  Period: [".", ">"],
  Slash: ["/", "?"],
  Digit1: ["1", "!"],
  Digit2: ["2", "@"],
  Digit3: ["3", "#"],
  Digit4: ["4", "$"],
  Digit5: ["5", "%"],
  Digit6: ["6", "^"],
  Digit7: ["7", "&"],
  Digit8: ["8", "*"],
  Digit9: ["9", "("],
  Digit0: ["0", ")"],
};

const LETTER = /\p{L}/u;
const LATIN = /\p{Script=Latin}/u;
/** A letter of a non-Latin script (Cyrillic, Greek…): the key's meaning comes from its position. */
const isForeignLetter = (ch: string) => ch.length === 1 && ch.charCodeAt(0) > 127 && LETTER.test(ch) && !LATIN.test(ch);

/**
 * Whether the active layout types non-Latin letters (Russian…), as seen on the last plain letter key.
 * Such layouts move punctuation too (Russian "/" types "."), so their punctuation keys also get a
 * second chance by position. Latin layouts (AZERTY, QWERTZ) are matched by the typed character only.
 */
let foreignLayout = false;

/**
 * A non-letter typed by a key that may mean its US character: any punctuation or digit while a non-Latin
 * layout is active, and always the Russian (PC) "." on the "/" key — often the first key pressed in the
 * app, before any letter showed the layout. A Latin layout typing "." there (Turkish-Q) loses nothing:
 * the typed "." is tried first, and it is bound nowhere.
 */
const positionalSymbol = (k: string, code: string) => k.length === 1 && !LETTER.test(k) && (foreignLayout || (code === "Slash" && k === "."));

/** Key names a keydown can match, best first: the typed character, then the US key at the same position. */
function keyNames(e: KeyboardEvent): string[] {
  const k = e.key ?? "";
  if (!k) return [];
  const code = e.code ?? "";
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter && k.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) foreignLayout = isForeignLetter(k);
  const typed = k === " " ? "space" : k.toLowerCase();
  const us = () => (letter ? letter[1].toLowerCase() : US_KEYS[code]?.[e.shiftKey ? 1 : 0]);
  // ⌥ on macOS types another character (⌥1 is "¡", ⌥K "˚", ⌥E a dead key): the key's US meaning comes next.
  const alt = isMac && e.altKey;
  // A Latin letter proves a Latin layout (Colemak ⌃S is on QWERTY's D), whatever was typed before.
  if (!(alt || isForeignLetter(k) || positionalSymbol(k, code))) return [typed];
  const pos = us();
  return pos && pos !== typed ? [typed, pos] : [typed];
}

/** Combos a keydown can match, best first (several only on non-Latin layouts, see `keyNames`). */
export function keyCombos(e: KeyboardEvent): string[] {
  const parts: string[] = [];
  const mod = isMac ? e.metaKey : e.ctrlKey;
  if (mod) parts.push("mod");
  if (isMac && e.ctrlKey) parts.push("ctrl");
  if (!isMac && e.metaKey) parts.push("meta");
  if (e.altKey) parts.push("alt");
  // Shift is implied by the produced character for symbols (":" "?" "G"), so only keep it for letters/named keys.
  return keyNames(e).map((key) => [...parts, ...(e.shiftKey && (/^[a-z]$/.test(key) || key.length > 1) ? ["shift"] : []), key].join("+"));
}

/** The key went to an element that takes every key for itself: a terminal. */
function inTerminal(e: KeyboardEvent): boolean {
  return !!(e.target as Element | null)?.closest?.("[data-own-keys]");
}

function isTyping(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  if (!t) return false;
  return t.isContentEditable || t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT";
}

const NAV_KEYS = new Set(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown"]);

/**
 * The arrows (Home, End, PgUp, PgDn) went to an element that moves with them by itself — a resize handle, a strip of
 * tabs, the sidebar's list (marked `data-own-arrows`): like typing, they are not the app's shortcuts there.
 */
function ownArrows(e: KeyboardEvent): boolean {
  if (!NAV_KEYS.has(e.key) || e.metaKey || e.ctrlKey || e.altKey) return false;
  return !!(e.target as Element | null)?.closest?.("[data-own-arrows]");
}

export function bind(binding: Binding): () => void {
  bindings.add(binding);
  return () => bindings.delete(binding);
}

export function bindAll(list: Binding[]): () => void {
  const offs = list.map(bind);
  return () => offs.forEach((f) => f());
}

export function installHotkeys() {
  window.addEventListener(
    "keydown",
    (e) => {
      if (e.isComposing) return;
      const combos = keyCombos(e);
      if (!combos.length) return;
      const typing = isTyping(e) || ownArrows(e);
      const owned = inTerminal(e);
      const sorted = [...bindings].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
      // The typed character wins over the key's US meaning, whatever the priorities.
      for (const combo of combos) {
        for (const b of sorted) {
          if (canonicalCombo(b.combo) !== combo) continue;
          if (typing && !b.inInputs) continue;
          if (owned && !b.inTerminal) continue;
          if (b.when && !b.when()) continue;
          if (b.run(e) === false) continue;
          e.preventDefault();
          e.stopPropagation();
          return;
        }
      }
    },
    { capture: true },
  );
}

/** Pretty label for a combo: "mod+k" → "⌘K" on macOS, "Ctrl+K" elsewhere. */
export function comboLabel(combo: string): string {
  const keys = { escape: "Esc", arrowup: "↑", arrowdown: "↓", arrowleft: "←", arrowright: "→", space: "Space", pageup: "PgUp", pagedown: "PgDn", contextmenu: "Menu", delete: "Del" };
  const map: Record<string, string> = isMac
    ? { ...keys, mod: "⌘", shift: "⇧", alt: "⌥", ctrl: "⌃", enter: "↵", backspace: "⌫" }
    : { ...keys, mod: "Ctrl", shift: "Shift", alt: "Alt", ctrl: "Ctrl", enter: "Enter", backspace: "Backspace" };
  const parts = canonicalCombo(combo)
    .split(/\+(?!$)/)
    .map((p) => map[p] ?? (p.length === 1 ? p.toUpperCase() : p[0].toUpperCase() + p.slice(1)));
  return isMac ? parts.join("") : parts.join("+");
}
