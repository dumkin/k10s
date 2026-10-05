import { backend } from "./backend";

// UI health for "the app froze" reports:
// - a heartbeat to the engine's watchdog, which logs (to the log file) when the page stops
//   responding — even if it never recovers;
// - a main-thread stall detector that logs blocks of a second or more once they end;
// - breadcrumbs (what the user and the feeds were doing) attached to both kinds of reports.

const MAX_CRUMBS = 40;
const crumbs: { at: number; text: string }[] = [];

/** Remembers a notable UI event (opened a picker, switched view, slow refresh…) for stall reports. */
export function breadcrumb(text: string) {
  crumbs.push({ at: performance.now(), text });
  if (crumbs.length > MAX_CRUMBS) crumbs.shift();
}

/** `-1.2s opened namespaces picker; -0.4s slow refresh: …` — events of the last `windowMs`. */
export function recentBreadcrumbs(windowMs = 30_000): string {
  const now = performance.now();
  return crumbs
    .filter((c) => now - c.at < windowMs)
    .map((c) => `-${((now - c.at) / 1000).toFixed(1)}s ${c.text}`)
    .join("; ");
}

const TICK_MS = 250;
const STALL_MS = 1000;

export function startWatchdog() {
  let last = performance.now();
  setInterval(() => {
    const now = performance.now();
    const blocked = now - last - TICK_MS;
    last = now;
    if (blocked >= STALL_MS && document.visibilityState === "visible") {
      const msg = `UI main thread was blocked for ${(blocked / 1000).toFixed(1)}s. Recent: ${recentBreadcrumbs() || "nothing notable"}`;
      console.warn(`[k10s] ${msg}`);
      backend().log("warn", msg);
    }
  }, TICK_MS);

  const beat = () => backend().heartbeat(document.visibilityState === "visible");
  setInterval(beat, 1000);
  document.addEventListener("visibilitychange", () => {
    // Hidden pages get their timers throttled; that gap is not a stall.
    last = performance.now();
    beat();
  });
  beat();
}
