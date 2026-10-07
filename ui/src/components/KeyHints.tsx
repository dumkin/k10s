import { createSignal, For, type JSX, onCleanup, onMount, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { comboLabel, keyLabel } from "../lib/hotkeys";
import { hintsShown } from "../lib/keyhints";
import { detailsHaveKeyboard, tableHasKeyboard } from "../state/keyboard";

/**
 * Keys of what is on screen, while ⌘ (Ctrl elsewhere) is held. A control opts in with attributes:
 * - `data-hint="mod+shift+c"` — its shortcut (several, space-separated, show as one badge);
 * - `data-hint-at="right|left|over|below"` — where the badge goes (default: inside, at the right end);
 * - `data-hint-ctx="table|details"` — the key works only while the table / the details panel has the keyboard
 *   (see `state/keyboard`): the badge shows only then.
 * A control that can't be seen (covered by a popover, scrolled out of its list) gets no badge.
 */
export function KeyHints() {
  return (
    <Show when={hintsShown()}>
      <HintLayer />
    </Show>
  );
}

export type HintPlacement = "right" | "left" | "over" | "below";

export interface Hint {
  label: string;
  x: number;
  y: number;
  at: HintPlacement;
}

/** More to show with the badges, in the line at the bottom (the namespaces on number keys…), while registered. */
const [panels, setPanels] = createSignal<(() => JSX.Element)[]>([]);

export function addHintPanel(panel: () => JSX.Element): () => void {
  setPanels((list) => [...list, panel]);
  return () => setPanels((list) => list.filter((p) => p !== panel));
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

function place(r: DOMRect, at: HintPlacement): { x: number; y: number } {
  const midY = r.top + r.height / 2;
  switch (at) {
    case "left":
      return { x: r.left + 6, y: midY };
    case "over":
      return { x: r.left + r.width / 2, y: midY };
    case "below":
      return { x: r.left + r.width / 2, y: r.bottom + 4 };
    default:
      return { x: r.right - 6, y: midY };
  }
}

/** Badges for the hinted controls that can be seen now and whose keys work now. */
export function collectHints(): Hint[] {
  const out: Hint[] = [];
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const ctx = { table: tableHasKeyboard(), details: detailsHaveKeyboard() };
  for (const el of document.querySelectorAll<HTMLElement>("[data-hint]")) {
    const combos = el.dataset.hint?.trim();
    if (!combos) continue;
    const when = el.dataset.hintCtx;
    if ((when === "table" || when === "details") && !ctx[when]) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1 || r.bottom <= 0 || r.right <= 0 || r.top >= vh || r.left >= vw) continue;
    const hit = document.elementFromPoint?.(clamp(r.left + r.width / 2, 0, vw - 1), clamp(r.top + r.height / 2, 0, vh - 1));
    if (hit && hit !== el && !el.contains(hit)) continue;
    const at = (el.dataset.hintAt ?? "right") as HintPlacement;
    out.push({ label: combos.split(/\s+/).map(comboLabel).join(" "), at, ...place(r, at) });
  }
  return out;
}

function HintLayer() {
  const [hints, setHints] = createSignal(collectHints());
  // Scrolling or resizing with ⌘ held: badges follow their controls (once a frame).
  let frame = 0;
  const remeasure = () => {
    frame ||= requestAnimationFrame(() => {
      frame = 0;
      setHints(collectHints());
    });
  };
  onMount(() => {
    window.addEventListener("resize", remeasure);
    window.addEventListener("scroll", remeasure, { capture: true, passive: true });
    onCleanup(() => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", remeasure);
      window.removeEventListener("scroll", remeasure, { capture: true });
    });
  });
  return (
    <Portal>
      <div class="key-hints" aria-hidden="true">
        <For each={hints()}>
          {(h) => (
            <span class={`key-hint at-${h.at}`} style={{ left: `${h.x}px`, top: `${h.y}px` }}>
              {h.label}
            </span>
          )}
        </For>
        {/* Out of the way of the badges, like the key line at the bottom of k9s. */}
        <div class="key-hints-dock">
          <For each={panels()}>{(panel) => panel()}</For>
          <Show when={keyLabel("app.help")}>
            {(key) => (
              <span class="khd-item">
                <span class="kbd">{key()}</span> all keyboard shortcuts
              </span>
            )}
          </Show>
        </div>
      </div>
    </Portal>
  );
}
