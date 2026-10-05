/**
 * The keys of a resize handle (a window splitter, as WAI-ARIA has it): the arrows along its axis move it 16px (64px
 * with ⇧), Home / End to the smallest and the largest size. `grow` / `shrink` name the arrow keys that make the
 * panel it sizes larger and smaller — the details panel on the right grows with ←, the sidebar with →.
 */
export interface SplitterSpec {
  value: () => number;
  set: (v: number) => void;
  min: () => number;
  max: () => number;
  grow: "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown";
  shrink: "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown";
}

export const SPLITTER_STEP = 16;

export function splitterKeyDown(spec: SplitterSpec) {
  return (e: KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const step = e.shiftKey ? SPLITTER_STEP * 4 : SPLITTER_STEP;
    let next: number;
    if (e.key === spec.grow) next = spec.value() + step;
    else if (e.key === spec.shrink) next = spec.value() - step;
    else if (e.key === "Home") next = spec.min();
    else if (e.key === "End") next = spec.max();
    else return;
    e.preventDefault();
    spec.set(Math.round(Math.max(spec.min(), Math.min(spec.max(), next))));
  };
}
