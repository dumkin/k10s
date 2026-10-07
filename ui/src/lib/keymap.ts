import { createSignal } from "solid-js";
import { isObject, setting } from "./persist";
import { isMac } from "./platform";
import { globalMemo } from "./reactive";

// The keys of the app's commands. Each command has keys of its own, and settings.json may give it others: the command
// `logs.wrap` is `"keys": { "logs": { "wrap": "alt+w" } }` there — a key, a list of them, or `null` (or `[]`) for none.
// The app follows an edit of the file at once: the shortcuts, their sheet, the hints and the tooltips.
//
// A key is written as the code writes it (see `lib/hotkeys`): "mod+k" is ⌘K on macOS and Ctrl+K elsewhere, "ctrl+d" is
// ⌃D (Ctrl+D off macOS), then "alt", "shift", and a character or a key's name ("/", "f6", "escape", "arrowleft"). The
// settings may write it more loosely ("Cmd+Shift+K"); what is not a key leaves the command its own keys.
//
// Not every key is a command's: the arrows, PgUp / PgDn, Home / End, Enter, Esc, Space, Tab, ⇧F10, ⌘C, ⌘A, the number
// keys, and the keys of menus, pickers, dialogs and the palette stay as they are (bound with a `combo`, not an `id`).

/**
 * Where a command's keys work — and so whose keys they can clash with:
 * - `global`: anywhere in the window;
 * - `dock`: anywhere too, a terminal included (where every other key is the terminal's);
 * - `table`: while the table has the keyboard;
 * - `details`: while the details panel has it — and the table, for the keys of the tabs and of full view;
 * - `logs`, `yaml`, `diff`: while the logs (in the details or in the dock), the YAML or the Compare tab's diff has it,
 *   before the `details` keys;
 * - `attention`: in the Needs attention view (it has no table).
 */
export type KeyScope = "global" | "dock" | "table" | "details" | "logs" | "yaml" | "diff" | "attention";

export interface KeyCommand {
  /** `group.name`: settings.json keeps its keys at `keys.group.name`. */
  id: string;
  scope: KeyScope;
  /** What it does, for a list of the keys. */
  title: string;
  /** Its own keys; the first is the one shown where there is room for one. */
  defaults: readonly string[];
}

const NONE: readonly string[] = [];

/** The app's own commands; the details tabs (`tab.*`) and the actions (`action.*`) come with their registries. */
const BUILTIN = [
  { id: "app.palette", scope: "global", title: "Command palette (again: close it)", defaults: ["mod+k"] },
  { id: "app.palette-new", scope: "global", title: "Command palette, with nothing typed", defaults: ["mod+p"] },
  { id: "app.command", scope: "global", title: "k9s command (the palette, from “:”)", defaults: [":"] },
  { id: "app.clusters", scope: "global", title: "Clusters", defaults: ["mod+shift+c"] },
  { id: "app.namespaces", scope: "global", title: "Namespaces", defaults: ["mod+shift+n"] },
  { id: "app.help", scope: "global", title: "Keyboard shortcuts", defaults: ["?"] },
  { id: "app.settings", scope: "global", title: "Settings", defaults: ["mod+,"] },
  // ⌘= is ⌘+ without Shift (a US keyboard); other layouts have a key of its own for "+".
  { id: "app.zoom-in", scope: "global", title: "Zoom in", defaults: ["mod+=", "mod++"] },
  { id: "app.zoom-out", scope: "global", title: "Zoom out", defaults: ["mod+-"] },
  { id: "app.zoom-reset", scope: "global", title: "Actual size (100%)", defaults: ["mod+0"] },
  { id: "app.next-area", scope: "global", title: "Next area: sidebar, table, details, dock", defaults: ["f6"] },
  { id: "app.previous-area", scope: "global", title: "Previous area", defaults: ["shift+f6"] },
  // As browsers have them.
  { id: "nav.back", scope: "global", title: "Back", defaults: [isMac ? "mod+[" : "alt+arrowleft"] },
  { id: "nav.forward", scope: "global", title: "Forward", defaults: [isMac ? "mod+]" : "alt+arrowright"] },
  { id: "dock.toggle", scope: "dock", title: "Terminals: show the dock and go to it; again: hide it", defaults: ["mod+j"] },
  // Off macOS Ctrl+J is the terminal's (a newline).
  { id: "dock.toggle-from-terminal", scope: "dock", title: "Terminals, from inside a terminal", defaults: ["mod+shift+j"] },

  { id: "table.down", scope: "table", title: "Next row", defaults: ["j"] },
  { id: "table.up", scope: "table", title: "Previous row", defaults: ["k"] },
  { id: "table.first", scope: "table", title: "First row", defaults: ["g"] },
  { id: "table.last", scope: "table", title: "Last row", defaults: ["shift+g"] },
  { id: "table.mark-down", scope: "table", title: "Mark the row and the next one", defaults: ["shift+j"] },
  { id: "table.mark-up", scope: "table", title: "Mark the row and the previous one", defaults: ["shift+k"] },
  { id: "table.filter", scope: "table", title: "Filter", defaults: ["/"] },
  { id: "table.filter-anywhere", scope: "table", title: "Filter, from any field", defaults: ["mod+f"] },
  { id: "table.sort-name", scope: "table", title: "Sort by name", defaults: ["shift+n"] },
  { id: "table.sort-age", scope: "table", title: "Sort by age", defaults: ["shift+a"] },

  { id: "details.full", scope: "details", title: "Full view of the details", defaults: ["f"] },
  { id: "details.down", scope: "details", title: "Scroll down", defaults: ["j"] },
  { id: "details.up", scope: "details", title: "Scroll up", defaults: ["k"] },
  { id: "details.top", scope: "details", title: "Scroll to the top", defaults: ["g"] },
  { id: "details.bottom", scope: "details", title: "Scroll to the bottom", defaults: ["shift+g"] },

  { id: "logs.find", scope: "logs", title: "Filter or find in the lines", defaults: ["/", "mod+f"] },
  { id: "logs.down", scope: "logs", title: "Next line", defaults: ["j"] },
  { id: "logs.up", scope: "logs", title: "Previous line", defaults: ["k"] },
  { id: "logs.pick-down", scope: "logs", title: "Pick the line and the next one", defaults: ["shift+j"] },
  { id: "logs.pick-up", scope: "logs", title: "Pick the line and the previous one", defaults: ["shift+k"] },
  { id: "logs.first", scope: "logs", title: "First line", defaults: ["g"] },
  { id: "logs.last", scope: "logs", title: "Last line, following new ones", defaults: ["shift+g"] },
  { id: "logs.next-match", scope: "logs", title: "Next match (no query: warning or error)", defaults: ["n"] },
  { id: "logs.previous-match", scope: "logs", title: "Previous match", defaults: ["shift+n"] },
  { id: "logs.next-problem", scope: "logs", title: "Next warning or error", defaults: ["]"] },
  { id: "logs.previous-problem", scope: "logs", title: "Previous warning or error", defaults: ["["] },
  { id: "logs.pause", scope: "logs", title: "Pause — and resume", defaults: ["s"] },
  { id: "logs.expand", scope: "logs", title: "Expand the line", defaults: ["x"] },
  { id: "logs.copy", scope: "logs", title: "Copy the lines picked, or the line", defaults: ["c"] },
  { id: "logs.save", scope: "logs", title: "Save the lines shown", defaults: ["mod+s"] },
  { id: "logs.wrap", scope: "logs", title: "Wrap lines", defaults: ["w"] },
  { id: "logs.timestamps", scope: "logs", title: "Timestamps", defaults: ["t"] },
  { id: "logs.pretty", scope: "logs", title: "Pretty structured lines", defaults: ["v"] },
  { id: "logs.histogram", scope: "logs", title: "Histogram", defaults: ["h"] },
  { id: "logs.previous-containers", scope: "logs", title: "The previous containers' logs", defaults: ["p"] },

  { id: "yaml.find", scope: "yaml", title: "Find in the YAML", defaults: ["/", "mod+f"] },
  { id: "yaml.next-match", scope: "yaml", title: "Next match", defaults: ["n"] },
  { id: "yaml.previous-match", scope: "yaml", title: "Previous match", defaults: ["shift+n"] },

  { id: "diff.next-change", scope: "diff", title: "Next difference", defaults: ["n"] },
  { id: "diff.previous-change", scope: "diff", title: "Previous difference", defaults: ["shift+n"] },

  { id: "attention.down", scope: "attention", title: "Next problem", defaults: ["j"] },
  { id: "attention.up", scope: "attention", title: "Previous problem", defaults: ["k"] },
  { id: "attention.first", scope: "attention", title: "First problem", defaults: ["g"] },
  { id: "attention.last", scope: "attention", title: "Last problem", defaults: ["shift+g"] },
  { id: "attention.filter", scope: "attention", title: "Filter", defaults: ["/"] },
] as const satisfies readonly KeyCommand[];

/** A command's id: one of the app's own (a typo doesn't compile), a details tab's (`tab.logs`), an action's (`action.delete`). */
export type KeyId = (typeof BUILTIN)[number]["id"] | `tab.${string}` | `action.${string}`;

/** The commands by id. A tab's or an action's comes when it is registered (a plugin's may come late). */
const commands = new Map<string, KeyCommand>(BUILTIN.map((c) => [c.id, c]));
const [registered, setRegistered] = createSignal(0);

/** Adds a command (or replaces the one with its id): its keys are bound and shown by its id. */
export function registerKeyCommand(command: KeyCommand) {
  commands.set(command.id, command);
  setRegistered((n) => n + 1);
}

/** A command by its id. */
export function keyCommand(id: string): KeyCommand | undefined {
  registered();
  return commands.get(id);
}

/** Every command, in the order they came. */
export function keyCommands(): KeyCommand[] {
  registered();
  return [...commands.values()];
}

// ---------------------------------------------------------------------------------------------
// Keys as the settings write them
// ---------------------------------------------------------------------------------------------

/** In the order a key is written with them (`lib/hotkeys` writes keydowns so too). */
export const MODIFIERS: readonly string[] = ["mod", "ctrl", "meta", "alt", "shift"];
/** The modifiers by the names the settings may give them ("meta" is the Windows / Super key, off macOS). */
const MODIFIER_NAMES: Record<string, string> = { mod: "mod", cmd: "mod", command: "mod", ctrl: "ctrl", control: "ctrl", meta: "meta", alt: "alt", option: "alt", opt: "alt", shift: "shift" };
/** Keys with a name, as a keydown names them (`KeyboardEvent.key` in lowercase; " " is "space"). */
const NAMED_KEYS = new Set([
  "escape",
  "enter",
  "tab",
  "space",
  "backspace",
  "delete",
  "insert",
  "home",
  "end",
  "pageup",
  "pagedown",
  "arrowup",
  "arrowdown",
  "arrowleft",
  "arrowright",
  "contextmenu",
  ...Array.from({ length: 24 }, (_, i) => `f${i + 1}`),
]);
/** Shorter names people write for some of them. */
const KEY_ALIASES: Record<string, string> = { esc: "escape", return: "enter", del: "delete", up: "arrowup", down: "arrowdown", left: "arrowleft", right: "arrowright", pgup: "pageup", pgdn: "pagedown" };

/**
 * A key as settings.json writes it, written as the code writes keys ("Cmd+Shift+K" → "mod+shift+k"); undefined for
 * what no key press makes: a name that is no key or modifier, no key at all ("mod+"), Shift with a symbol (a press of
 * Shift and "/" is "?").
 */
export function parseCombo(text: string): string | undefined {
  const parts = text.toLowerCase().split("+").map((p) => p.trim());
  let key = parts.pop() ?? "";
  // "+" is a key too: "mod++" splits into "mod", "" and "".
  if (!key && parts.length && !parts[parts.length - 1]) {
    parts.pop();
    key = "+";
  }
  if (Object.hasOwn(KEY_ALIASES, key)) key = KEY_ALIASES[key];
  if (!NAMED_KEYS.has(key) && [...key].length !== 1) return undefined;
  const mods = new Set<string>();
  for (const p of parts) {
    if (!Object.hasOwn(MODIFIER_NAMES, p)) return undefined;
    mods.add(MODIFIER_NAMES[p]);
  }
  if (mods.has("shift") && !NAMED_KEYS.has(key) && !/^[a-z]$/.test(key)) return undefined;
  return [...MODIFIERS.filter((m) => mods.has(m)), key].join("+");
}

/** The keys of one command in the settings: a key, a list of them, or none (`null`, `[]`). Undefined if any isn't one. */
function keysFrom(value: unknown): readonly string[] | undefined {
  if (value === null) return NONE;
  const list = typeof value === "string" ? [value] : Array.isArray(value) ? value : undefined;
  if (!list) return undefined;
  const out: string[] = [];
  for (const item of list) {
    const combo = typeof item === "string" ? parseCombo(item) : undefined;
    if (!combo) return undefined;
    if (!out.includes(combo)) out.push(combo);
  }
  return out;
}

/** The keys the settings give commands, by id: `keys.group.name` is the command `group.name`. Bad entries are left out. */
function givenKeys(stored: Record<string, unknown>): Map<string, readonly string[]> {
  const out = new Map<string, readonly string[]>();
  for (const [group, names] of Object.entries(stored)) {
    if (!isObject(names)) continue;
    for (const [name, value] of Object.entries(names)) {
      const keys = keysFrom(value);
      if (keys) out.set(`${group}.${name}`, keys);
    }
  }
  return out;
}

/** What settings.json says about keys, as it says it: taken entry by entry (see `givenKeys`). */
const [stored] = setting<Record<string, unknown>>("keys", {}, isObject);

const sameKeys = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((k, i) => k === b[i]);

/**
 * Every command's keys now, by id: the settings', else its own. A new map only when some command's keys change (what
 * `lib/hotkeys` sorts its bindings by).
 */
export const keymap = globalMemo(
  (): ReadonlyMap<string, readonly string[]> => {
    registered();
    const given = givenKeys(stored());
    return new Map([...commands.values()].map((c) => [c.id, given.get(c.id) ?? c.defaults]));
  },
  { equals: (a, b) => a.size === b.size && [...a].every(([id, keys]) => b.has(id) && sameKeys(keys, b.get(id)!)) },
);

/** A command's keys now (reactive); none where the settings took them away, or for no such command. */
export const keysOf = (id: KeyId): readonly string[] => keymap().get(id) ?? NONE;

/** The first of a command's keys: the one shown where there is room for one. */
export const keyOf = (id: KeyId): string | undefined => keysOf(id)[0];
