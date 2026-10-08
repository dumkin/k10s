import { trackDrag } from "./drag";

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

/** A drag of the handle: the keys' spec (but `shrink`), and what shows the size while it moves. */
export interface SplitterDragSpec extends Omit<SplitterSpec, "shrink"> {
  /** Shows the size while the handle moves (by default `set`); `set` takes the last one when the drag ends. */
  preview?: (v: number) => void;
}

/**
 * Drags a resize handle, from a `mousedown` or `pointerdown` on it with the primary button: the size follows the
 * pointer from where it took the handle, within the bounds, and shows at most once a frame — mouse events come faster
 * than frames, and WebKit lays the window out before each one when something changed since. The drag ends when the
 * button is let go, or with what takes the release from the page (see `trackDrag`); the size then is the one set. The
 * handle has `.dragging` meanwhile.
 */
export function splitterDrag(spec: SplitterDragSpec) {
  return (e: MouseEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const handle = e.currentTarget as HTMLElement;
    const vertical = spec.grow === "ArrowUp" || spec.grow === "ArrowDown";
    const sign = spec.grow === "ArrowRight" || spec.grow === "ArrowDown" ? 1 : -1;
    const along = (ev: MouseEvent) => (vertical ? ev.clientY : ev.clientX);
    const from = along(e);
    const start = spec.value();
    const show = spec.preview ?? spec.set;
    let size = start;
    let moved = false;
    let frame = 0;
    handle.classList.add("dragging");
    trackDrag(e, {
      move: (ev) => {
        size = Math.round(Math.max(spec.min(), Math.min(spec.max(), start + sign * (along(ev) - from))));
        moved = true;
        frame ||= requestAnimationFrame(() => {
          frame = 0;
          show(size);
        });
      },
      end: () => {
        cancelAnimationFrame(frame);
        handle.classList.remove("dragging");
        if (moved) spec.set(size);
      },
    });
  };
}
