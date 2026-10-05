// The app behind a modal (a dialog, the palette, the shortcuts sheet) takes no focus, clicks or a screen reader's
// attention while one is open. Modals can overlap for a moment (the palette opens while the sheet closes, a dialog
// opens as the palette closes): the app stays inert until the last of them lets go.

let holders = 0;

/** Makes `#root` inert until the returned function is called (once; further calls do nothing). */
export function holdInert(): () => void {
  holders++;
  document.getElementById("root")?.setAttribute("inert", "");
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holders = Math.max(0, holders - 1);
    if (!holders) document.getElementById("root")?.removeAttribute("inert");
  };
}

/**
 * Remembers what has the keyboard now (or `from`); the returned function gives it back — when it closes, a modal
 * calls it: unless focus went somewhere on purpose meanwhile, it returns there.
 */
export function restoreFocus(from?: HTMLElement | null): () => void {
  const at = document.activeElement;
  const back = from !== undefined ? from : at instanceof HTMLElement && at !== document.body ? at : null;
  return () => {
    const now = document.activeElement;
    const lost = !now || now === document.body || !now.isConnected;
    if (lost && back?.isConnected) back.focus({ preventScroll: true });
  };
}
