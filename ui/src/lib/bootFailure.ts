import { backend, errorMessage } from "./backend";
import { clearPreferences } from "./persist";

// Nothing from `state/` or the components here: whatever broke the start may be any of them.

const reloadPage = () => location.reload();

/** Forgets the saved preferences (not read-only mode: the engine's) and starts again. */
export async function resetPreferences(reload = reloadPage) {
  try {
    await clearPreferences();
  } catch (e) {
    console.error("[k10s] could not reset the preferences:", e);
  }
  reload();
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(label: string, className: string, onClick: () => void): HTMLButtonElement {
  const b = el("button", className, label);
  b.type = "button";
  b.addEventListener("click", onClick);
  return b;
}

/**
 * The app could not start — a module threw as it loaded (a saved preference of the wrong shape, say) or the first
 * render did: instead of a blank window, what went wrong and the ways out. Plain DOM, styled by app.css only: the
 * window's CSP allows no inline scripts.
 */
export function showBootFailure(err: unknown, reload = reloadPage) {
  console.error("[k10s] could not start:", err);
  try {
    backend().log("error", `could not start: ${err instanceof Error && err.stack ? `${err.message}\n${err.stack}` : errorMessage(err)}`);
  } catch {
    // no engine to tell
  }
  document.querySelector(".boot-failure")?.remove();
  const screen = el("div", "boot boot-failure");
  screen.setAttribute("role", "alert");
  const box = el("div", "bf-box");
  const again = button("Reload", "btn primary", reload);
  const actions = el("div", "bf-actions");
  actions.append(button("Reset preferences", "btn", () => void resetPreferences(reload)), again);
  box.append(
    el("h1", "", "k10s could not start"),
    el("p", "bf-error selectable", errorMessage(err)),
    el("p", "", "A saved preference may be broken. Reset preferences forgets the settings and what k10s remembers — selected clusters, cluster sets, recent namespaces, column widths, the theme — and reloads. The kubeconfig and read-only mode stay as they are."),
    actions,
  );
  screen.append(box);
  document.body.append(screen);
  again.focus();
}
