import { createSignal } from "solid-js";
import { isMac } from "./hotkeys";

// Holding the shortcut modifier alone (⌘ on macOS, Ctrl elsewhere) shows the keys of what is on screen: each
// control marked with `data-hint="<combo>"` gets a badge (see `KeyHints`). Pressing any other key is a shortcut
// being typed, and the hints never show (or go away).

/** How long the modifier is held alone before the hints show: a quick ⌘K never flashes them. */
export const HINTS_DELAY_MS = 450;

export const [hintsShown, setHintsShown] = createSignal(false);

const MODIFIER_KEYS = new Set(["Shift", "Alt", "Control", "Meta", "CapsLock", "Fn", "FnLock", "Hyper", "Super", "OS", "AltGraph"]);

/** Starts watching the modifier. Returns the teardown. */
export function installKeyHints(): () => void {
  const modifier = isMac ? "Meta" : "Control";
  let timer: ReturnType<typeof setTimeout> | undefined;
  const hide = () => {
    clearTimeout(timer);
    timer = undefined;
    if (hintsShown()) setHintsShown(false);
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === modifier) {
      // Off macOS a held Ctrl repeats: the first press starts the wait, repeats don't restart it.
      if (!e.repeat && timer === undefined && !hintsShown())
        timer = setTimeout(() => {
          timer = undefined;
          setHintsShown(true);
        }, HINTS_DELAY_MS);
      return;
    }
    // Shift or ⌥ held with it: still looking (⌘⇧C…). Anything else is a shortcut being typed.
    if (!MODIFIER_KEYS.has(e.key)) hide();
  };
  const onKeyUp = (e: KeyboardEvent) => {
    if (e.key === modifier) hide();
  };
  // ⌘-click marks rows; ⌘-Tab leaves the app without a keyup ever arriving.
  const onVisibility = () => document.visibilityState !== "visible" && hide();
  window.addEventListener("keydown", onKeyDown, { capture: true });
  window.addEventListener("keyup", onKeyUp, { capture: true });
  window.addEventListener("mousedown", hide, { capture: true });
  window.addEventListener("blur", hide);
  document.addEventListener("visibilitychange", onVisibility);
  return () => {
    hide();
    window.removeEventListener("keydown", onKeyDown, { capture: true });
    window.removeEventListener("keyup", onKeyUp, { capture: true });
    window.removeEventListener("mousedown", hide, { capture: true });
    window.removeEventListener("blur", hide);
    document.removeEventListener("visibilitychange", onVisibility);
  };
}
