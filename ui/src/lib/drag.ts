/**
 * Hears a drag through, from the press that started it (`mousedown` or `pointerdown`) to its end, also past the element
 * pressed: `move` for each move of that pointer, then `end` with the event that let go of the button — or with null when
 * something takes the release from the page: a context menu (a ctrl-click on macOS), another window, the pointer
 * cancelled. Not when a move says no button is held: WebKit takes that from the system's state of the mouse, which
 * events handed to the window by software do not change. Returns what stops hearing it (no `end` then).
 */
export function trackDrag(e: MouseEvent, on: { move: (ev: MouseEvent) => void; end: (ev: MouseEvent | null) => void }): () => void {
  const [moves, ends] = e.type === "pointerdown" ? (["pointermove", "pointerup"] as const) : (["mousemove", "mouseup"] as const);
  // Another pointer's events (a second finger, a pen) are not this drag's.
  const id = e instanceof PointerEvent ? e.pointerId : undefined;
  const mine = (ev: Event) => id === undefined || !(ev instanceof PointerEvent) || ev.pointerId === id;
  const move = (ev: MouseEvent) => {
    if (mine(ev)) on.move(ev);
  };
  const up = (ev: MouseEvent) => {
    if (!mine(ev)) return;
    stop();
    on.end(ev);
  };
  const lost = (ev: Event) => {
    if (!mine(ev)) return;
    stop();
    on.end(null);
  };
  const stop = () => {
    window.removeEventListener(moves, move);
    window.removeEventListener(ends, up);
    window.removeEventListener("pointercancel", lost);
    window.removeEventListener("contextmenu", lost, true);
    window.removeEventListener("blur", lost);
  };
  window.addEventListener(moves, move);
  window.addEventListener(ends, up);
  window.addEventListener("pointercancel", lost);
  window.addEventListener("contextmenu", lost, true);
  window.addEventListener("blur", lost);
  return stop;
}
