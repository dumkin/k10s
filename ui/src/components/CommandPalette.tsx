import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { rank } from "../lib/fuzzy";
import { bind, comboLabel } from "../lib/hotkeys";
import { holdInert, restoreFocus } from "../lib/inert";
import { type Command, collectCommands } from "../state/commands";
import { paletteOpen, setPaletteOpen } from "../state/ui";
import { Icon } from "./Icon";
import { createListNav, Highlight } from "./Popover";

interface Result {
  cmd: Command;
  indices?: number[];
  header?: string;
  /** Listed under a section header (empty query) — no per-row section label. */
  grouped?: boolean;
}

const EMPTY_SECTIONS = ["Selection", "Navigation", "Resources", "Cluster sets", "App"];

export function CommandPalette() {
  return <Show when={paletteOpen()}>{(o) => <Palette initial={o().query} />}</Show>;
}

function Palette(props: { initial: string }) {
  // What had the keyboard before the palette took it (read before its field is focused).
  const back = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
  const [query, setQuery] = createSignal(props.initial);
  let input!: HTMLInputElement;
  let list: HTMLDivElement | undefined;
  const close = () => setPaletteOpen(false);

  const results = createMemo<Result[]>(() => {
    const q = query();
    const all = collectCommands(q);
    if (q.startsWith(":")) {
      const direct = all.filter((c) => c.section === "Command");
      const word = q.slice(1).trim().split(/\s+/)[0] ?? "";
      const rest = word ? rank(word, all.filter((c) => c.section !== "Command" && c.section !== "App"), (c) => [c.title, ...(c.keywords ?? [])]) : [];
      return [...direct.map((cmd) => ({ cmd })), ...rest.slice(0, 40).map(({ item, match, field }) => ({ cmd: item, indices: field === 0 ? match.indices : undefined }))];
    }
    if (!q.trim()) {
      const out: Result[] = [];
      for (const section of EMPTY_SECTIONS) {
        const items = all.filter((c) => c.section === section || (section === "Selection" && c.section.startsWith("Selection"))).sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
        items.forEach((cmd, i) => out.push({ cmd, header: i === 0 ? cmd.section : undefined, grouped: true }));
      }
      return out;
    }
    return rank(q.trim(), all, (c) => [c.title, ...(c.keywords ?? [])])
      .sort((a, b) => b.match.score + (b.item.priority ?? 0) * 0.5 - (a.match.score + (a.item.priority ?? 0) * 0.5))
      .slice(0, 80)
      .map(({ item, match, field }) => ({ cmd: item, indices: field === 0 ? match.indices : undefined }));
  });

  const nav = createListNav(() => results().length, () => list);
  createEffect(on(query, () => nav.reset(), { defer: true }));

  const run = (r: Result | undefined, additive: boolean) => {
    if (!r) return;
    close();
    void r.cmd.run({ additive });
  };

  onMount(() => {
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
    onCleanup(bind({ combo: "escape", inInputs: true, priority: 200, run: close }));
    // Modal: nothing behind it takes focus, clicks or a screen reader's attention while it is open. Closed, it gives
    // the keyboard back to what had it — unless what it ran took it elsewhere.
    onCleanup(holdInert());
    onCleanup(restoreFocus(back));
  });
  /** Tab and ⇧Tab move the highlight too (the field keeps the keyboard: there is nowhere else to go in the palette). */
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Tab") {
      e.preventDefault();
      nav.move(e.shiftKey ? -1 : 1);
      return;
    }
    nav.onKeyDown(e, (i, ev) => run(results()[i], ev.metaKey || ev.ctrlKey));
  };
  const optionId = (i: number) => `palette-opt-${i}`;

  return (
    <Portal>
      <div class="overlay dim" onMouseDown={close} />
      <div class="palette" role="dialog" aria-modal="true" aria-label="Command palette">
        <div class="p-input">
          <Icon name={query().startsWith(":") ? "terminal" : "search"} size={17} />
          <input
            ref={input}
            value={query()}
            placeholder="Jump to a resource, cluster, namespace or action…   (: for k9s commands)"
            role="combobox"
            aria-label="Command"
            aria-expanded="true"
            aria-controls="palette-list"
            aria-autocomplete="list"
            aria-activedescendant={results().length ? optionId(nav.index()) : undefined}
            onInput={(e) => setQuery(e.currentTarget.value)}
            onKeyDown={onKeyDown}
            spellcheck={false}
            autocomplete="off"
          />
        </div>
        <div class="p-list" ref={list} id="palette-list" role="listbox" aria-label="Results">
          <For
            each={results()}
            fallback={
              <div class="p-empty">
                <Icon name="search" size={20} />
                <b>Nothing matches “{query().trim()}”</b>
                <span>Try a resource (pods, deploy), a cluster, a namespace or an action — or : for k9s commands</span>
              </div>
            }
          >
            {(r, i) => (
              <>
                <Show when={r.header}>
                  <div class="pop-group" role="presentation">
                    <span class="ellipsis">{r.header}</span>
                  </div>
                </Show>
                <button
                  id={optionId(i())}
                  class="opt"
                  role="option"
                  aria-selected={nav.index() === i()}
                  tabIndex={-1}
                  classList={{ hl: nav.index() === i() }}
                  onMouseMove={(e) => nav.hover(i(), e)}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={(e) => run(r, e.metaKey || e.ctrlKey)}
                >
                  <Show when={r.cmd.color} fallback={<Icon name={r.cmd.icon ?? "zap"} size={15} />}>
                    <span class="swatch" style={{ background: r.cmd.color, margin: "0 4px" }} />
                  </Show>
                  <span class="ellipsis">
                    <Highlight text={r.cmd.title} indices={r.indices} />
                  </span>
                  <Show when={r.cmd.checked}>
                    <Icon name="check" size={13} style={{ color: "var(--accent-text)" }} />
                  </Show>
                  <span class="sub">
                    {r.cmd.hint ?? (r.grouped ? "" : r.cmd.section)}
                    <Show when={r.cmd.shortcut}>
                      <span class="kbd" style={{ "margin-left": "8px" }}>
                        {comboLabel(r.cmd.shortcut!)}
                      </span>
                    </Show>
                  </span>
                </button>
              </>
            )}
          </For>
        </div>
        <div class="p-foot">
          <span>
            <span class="kbd">↑↓</span> navigate
          </span>
          <span>
            <span class="kbd">↵</span> open
          </span>
          <span>
            <span class="kbd">{comboLabel("mod+enter")}</span> add to selection
          </span>
          <span>
            <span class="kbd">esc</span> close
          </span>
        </div>
      </div>
    </Portal>
  );
}
