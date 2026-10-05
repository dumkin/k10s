import { toast } from "../state/ui";
import { backend } from "./backend";
import { recentBreadcrumbs } from "./watchdog";

let lastToast = 0;

function describe(err: unknown): string {
  if (err instanceof Error) return err.stack ? `${err.message}\n${err.stack}` : err.message;
  if (err && typeof err === "object") {
    try {
      return JSON.stringify(err);
    } catch {
      return String(err);
    }
  }
  return String(err);
}

/**
 * Single sink for unexpected frontend errors: devtools console, a (rate-limited) toast, and the
 * app log (log file + the terminal running `tauri dev`), with the user's recent steps attached.
 */
export function reportError(err: unknown, where: string) {
  const text = describe(err);
  console.error(`[k10s] ${where}:`, err);
  try {
    const recent = recentBreadcrumbs(10_000);
    backend().log("error", `${where}: ${text}${recent ? `\nRecent: ${recent}` : ""}`);
  } catch {
    // backend not ready yet
  }
  const now = Date.now();
  if (now - lastToast > 4000) {
    lastToast = now;
    toast("error", `Unexpected error in ${where}`, text.split("\n")[0].slice(0, 300));
  }
}

export function installGlobalErrorHandlers() {
  window.addEventListener("error", (e) => reportError(e.error ?? e.message, "window"));
  window.addEventListener("unhandledrejection", (e) => reportError(e.reason, "async task"));
}
