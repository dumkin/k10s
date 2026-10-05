import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { bind, comboLabel } from "../lib/hotkeys";
import { holdInert, restoreFocus } from "../lib/inert";
import { BACK_COMBO, FORWARD_COMBO, namespaceKeys } from "../state/nav";
import { helpOpen, setHelpOpen } from "../state/ui";
import { Icon } from "./Icon";

/**
 * Keys as written in the sheet: combos separated by spaces (`mod+k`, `shift+g`), `|` between alternatives,
 * `…` for a range, `hold:mod` for a key that is held.
 */
interface ShortcutRow {
  keys: string;
  text: string;
}

interface ShortcutGroup {
  title: string;
  rows: ShortcutRow[];
}

export const SHORTCUTS: ShortcutGroup[] = [
  {
    title: "Anywhere",
    rows: [
      { keys: "mod+k", text: "Command palette: resources, clusters, namespaces, actions" },
      { keys: ":", text: "k9s command: :po, :deploy payments, :ns kube-system, :ctx prod" },
      { keys: "mod+shift+c | mod+shift+n", text: "Clusters / namespaces" },
      { keys: "mod+1 … mod+9", text: "Resource of the sidebar, counted top to bottom" },
      { keys: `${BACK_COMBO} | ${FORWARD_COMBO}`, text: "Back / forward" },
      { keys: "f6 | shift+f6", text: "Next / previous area: sidebar, table, details, dock" },
      { keys: "mod+= | mod+- | mod+0", text: "Zoom in / out / back to 100% (the app opens at it next time)" },
      { keys: "hold:mod", text: "Show the keys of what is on screen" },
      { keys: "?", text: "This sheet" },
      { keys: "mod+,", text: "Settings" },
    ],
  },
  {
    title: "Table",
    rows: [
      { keys: "j k | arrowdown arrowup", text: "Next / previous row" },
      { keys: "g shift+g | pageup pagedown", text: "First / last row, page up / down" },
      { keys: "/ | mod+f", text: "Filter: foo !bar app=web" },
      { keys: "enter", text: "Details" },
      { keys: "space | mod+a", text: "Mark the row (and go down) / mark all shown" },
      { keys: "shift+n | shift+a", text: "Sort by name / age; again: the other way" },
      { keys: "0 | 1 … 9", text: "All namespaces / a namespace on its number key" },
      { keys: "alt+1 … alt+9 | alt+0", text: "Hide or show a cluster's rows / show all" },
      { keys: "shift+f10 | contextmenu", text: "Actions menu of the selection, as a right-click opens it" },
      { keys: "escape", text: "Close the details, clear marks, clear the filter — one at a time" },
    ],
  },
  {
    title: "Actions",
    rows: [
      { keys: "s | a", text: "Shell in the pod (a node: shell on it) / attach to it" },
      { keys: "shift+f", text: "Port-forward (a pod, service or workload)" },
      { keys: "shift+r | shift+s", text: "Restart / scale" },
      { keys: "ctrl+d | mod+backspace", text: "Delete" },
      { keys: "c", text: "Copy names" },
      { keys: "= | +", text: "Compare the marked rows / pin an object to compare others with" },
      { keys: "mod+enter | escape", text: "Confirm / cancel the dialog" },
    ],
  },
  {
    title: "Details",
    rows: [
      { keys: "d r l e y =", text: "Overview / Relations / Logs / Events / YAML / Compare" },
      { keys: "f", text: "Full view — and back (Esc too)" },
      { keys: "j k | g shift+g | space", text: "Scroll, in full view or with focus in the panel (logs: move the cursor)" },
      { keys: "/ | mod+f", text: "Filter the logs / find in the YAML" },
      { keys: "n | shift+n", text: "Next / previous match (logs without a query: warning or error; Compare: difference)" },
    ],
  },
  {
    title: "Logs",
    rows: [
      { keys: "j k | arrowdown arrowup", text: "Move the cursor a line (up from the first: earlier lines are read)" },
      { keys: "shift+j shift+k", text: "Pick the lines on the way (⇧-click too)" },
      { keys: "g | shift+g", text: "The first line / the last, following new ones" },
      { keys: "escape", text: "Let go of the lines picked, then of the cursor" },
      { keys: "[ | ]", text: "Previous / next warning or error" },
      { keys: "s", text: "Pause — and resume (new lines wait meanwhile)" },
      { keys: "x | enter", text: "Expand the cursor's line: its fields, time, source" },
      { keys: "c", text: "Copy the lines picked, or the cursor's" },
      { keys: "w t v h", text: "Wrap / timestamps / pretty (JSON, logfmt) / histogram" },
      { keys: "p", text: "The previous containers' logs (crashed ones)" },
      { keys: "mod+s", text: "Save the lines shown to a file" },
      { keys: "alt+c alt+r alt+f", text: "In the query: match case / regular expression / filter or find" },
      { keys: "enter tab | ctrl+space", text: "In the query: take the suggestion highlighted / suggest here" },
      { keys: "l", text: "On several marked rows: their logs together, in the dock" },
    ],
  },
  {
    title: "Terminals",
    rows: [
      { keys: "mod+j", text: "Show the dock and go to its terminal; again: hide it" },
      { keys: "mod+shift+j", text: "The same, from inside a terminal (every other key is the terminal's)" },
      { keys: "enter", text: "In a session that ended: start a new one" },
    ],
  },
  {
    title: "Palette and pickers",
    rows: [
      { keys: "arrowdown arrowup | ctrl+n ctrl+p", text: "Move" },
      { keys: "enter", text: "Choose (a cluster: add or remove it)" },
      { keys: "mod+enter", text: "Only this cluster / add to the selection" },
      { keys: "escape", text: "Close" },
    ],
  },
  {
    title: "Menus, lists and panels",
    rows: [
      { keys: "arrowdown arrowup | home end", text: "Menus: move; a letter jumps to the item starting with it" },
      { keys: "tab", text: "Into the sidebar, the details' tabs, a panel's edge — then the arrows move there" },
      { keys: "arrowleft arrowright", text: "Details tabs: the previous / next one. A panel's edge: resize it (⇧: in bigger steps)" },
      { keys: "escape", text: "Sidebar: back to the table. Otherwise: dismiss the newest notification" },
    ],
  },
];

/** Words of a row to search in: what it does and the keys as written, for "logs", "⌘K", "shift". */
const haystack = (row: ShortcutRow) =>
  `${row.text} ${row.keys
    .split(/\s+/)
    .filter((t) => t !== "|" && t !== "…")
    .map((t) => `${t} ${comboLabel(t.replace(/^hold:/, ""))}`)
    .join(" ")}`.toLowerCase();

export function Keys(props: { keys: string }) {
  return (
    <span class="sc-keys">
      <For each={props.keys.split(/\s+/)}>
        {(token) => (
          <Show when={token !== "|" && token !== "…"} fallback={<span class="sc-sep">{token === "|" ? "/" : "…"}</span>}>
            <Show when={token.startsWith("hold:")} fallback={<span class="kbd">{comboLabel(token)}</span>}>
              <span class="sc-sep">hold</span>
              <span class="kbd">{comboLabel(token.slice(5))}</span>
            </Show>
          </Show>
        )}
      </For>
    </span>
  );
}

export function ShortcutsHelp() {
  return (
    <Show when={helpOpen()}>
      <Sheet />
    </Show>
  );
}

function Sheet() {
  const close = () => setHelpOpen(false);
  const [query, setQuery] = createSignal("");
  let body!: HTMLDivElement;
  let search!: HTMLInputElement;
  /** The groups and rows that match what is typed: every word, in what a row does or in its keys. */
  const groups = createMemo(() => {
    const words = query().trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return SHORTCUTS;
    return SHORTCUTS.map((g) => ({ ...g, rows: g.rows.filter((r) => words.every((w) => haystack(r).includes(w) || g.title.toLowerCase().includes(w))) })).filter((g) => g.rows.length);
  });
  onMount(() => {
    // Esc clears what is typed first, then closes.
    onCleanup(bind({ combo: "escape", inInputs: true, priority: 200, run: () => void (query() ? setQuery("") : close()) }));
    // Modal: focus stays in the sheet; the arrows, PgUp / PgDn and Space scroll it, typing searches it. Closed, it
    // gives the keyboard back to what had it (the logs, say: their keys must keep working).
    onCleanup(holdInert());
    onCleanup(restoreFocus());
    body.focus({ preventScroll: true });
  });
  /** A letter typed while the list has the keyboard starts a search. */
  const onBodyKey = (e: KeyboardEvent) => {
    if (e.key.length !== 1 || e.metaKey || e.ctrlKey || e.altKey || e.key === " " || e.key === "?") return;
    search.focus();
  };
  return (
    <Portal>
      <div class="overlay dim" onMouseDown={close} />
      <div class="help-sheet" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts">
        <div class="hs-head">
          <Icon name="keyboard" size={17} />
          <h2>Keyboard shortcuts</h2>
          <div class="hs-search search-field">
            <Icon name="search" size={13} />
            <input
              ref={search}
              class="input"
              placeholder="Search: logs, compare, ⌘K…"
              aria-label="Search the shortcuts"
              value={query()}
              onInput={(e) => setQuery(e.currentTarget.value)}
              onKeyDown={(e) => {
                // ↓ / ↵ go down to the list (to scroll it with the keys).
                if (e.key === "ArrowDown" || e.key === "Enter") {
                  e.preventDefault();
                  body.focus({ preventScroll: true });
                }
              }}
              spellcheck={false}
              autocomplete="off"
            />
          </div>
          <button class="btn ghost icon" title="Close (Esc)" aria-label="Close" onClick={close}>
            <Icon name="x" size={15} />
          </button>
        </div>
        <div class="hs-body" ref={body} tabIndex={0} aria-label="Shortcuts" onKeyDown={onBodyKey}>
          <div class="hs-cols">
            <For each={groups()} fallback={<div class="hs-none">No shortcut matches “{query().trim()}”</div>}>
              {(group) => (
                <section class="hs-group">
                  <h3>{group.title}</h3>
                  <For each={group.rows}>
                    {(row) => (
                      <div class="hs-row">
                        <Keys keys={row.keys} />
                        <span class="hs-text">
                          {row.text}
                          {/* What the number keys open now, as k9s shows its favorite namespaces. */}
                          <Show when={row.keys.startsWith("0 ") && namespaceKeys().length}>
                            <span class="hs-live">{namespaceKeys().map((n, i) => `${i + 1} ${n}`).join(" · ")}</span>
                          </Show>
                        </span>
                      </div>
                    )}
                  </For>
                </section>
              )}
            </For>
          </div>
        </div>
        <div class="hs-foot">
          Single keys work when no field has the focus; <span class="kbd">Esc</span> leaves a field. Hold <span class="kbd">{comboLabel("mod")}</span> to see the keys of what is on screen.
        </div>
      </div>
    </Portal>
  );
}
