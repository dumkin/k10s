import { createEffect, createRoot, on, onCleanup } from "solid-js";
import { backend, errorMessage, isTauri } from "../lib/backend";
import { installGlobalErrorHandlers } from "../lib/errors";
import { bindAll, installHotkeys, isMac } from "../lib/hotkeys";
import { cycleRegion } from "../lib/regions";
import { installKeyHints } from "../lib/keyhints";
import { breadcrumb, startWatchdog } from "../lib/watchdog";
import "../details";
import { registerRecentQueryCommands } from "../details/logs/model";
import "../registry/actions";
import "../registry/helmActions";
import { registerBuiltinCommands } from "./builtinCommands";
import { ensureConnected, listenEngineEvents, loadContexts, selectedClusters, startWakeDetector } from "./clusters";
import { registerCompareCommands } from "./compare";
import { startForwardsFeed } from "./forwards";
import "./helmDrift";
import { initMetrics } from "./metrics";
import { detailsFull, detailsOpen, detailsTab, namespaces, resourceKey, selectedKey } from "./nav";
import { initReopen } from "./reopen";
import { applyTheme, dialog, helpOpen, loadSettings, paletteOpen, pickerOpen, readOnly, reportUnreadableSettings, setHelpOpen, setPaletteOpen, setPickerOpen, setSettingsOpen, setUiZoom, settingsFileEdited, settingsOpen, startClock, themePref, toast, uiZoom, zoomBy } from "./ui";
import { modalOpen } from "./keyboard";
import { startUpdates } from "./updates";
import { initViews } from "./views";

/** Wires global state, engine subscriptions and shortcuts. Call once, after the backend is ready. */
export function initApp(): () => void {
  return createRoot((dispose) => {
    if (isTauri && isMac) document.documentElement.classList.add("mac");
    installGlobalErrorHandlers();
    startWatchdog();

    // The first one is the theme the page opened with (set before the first paint, see index.html): no fade.
    let themed = false;
    createEffect(() => {
      applyTheme(themePref(), themed);
      themed = true;
    });
    // The window follows the zoom the settings hold: ⌘+ / ⌘−, the settings window, an edit of the file. (It opened at
    // it already; the browser mock zooms with CSS.)
    createEffect(
      on(uiZoom, (zoom) =>
        backend()
          .setZoom(zoom)
          .catch((e) => toast("error", "Could not zoom", errorMessage(e))),
      ),
    );
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => applyTheme(themePref(), true));
    startClock();

    listenEngineEvents();
    onCleanup(startWakeDetector());
    void loadContexts();
    createEffect(on(selectedClusters, (clusters) => clusters.forEach((c) => void ensureConnected(c))));
    // The engine owns the settings (read-only mode included); the UI mirrors them.
    void loadSettings();
    reportUnreadableSettings();
    // settings.json edited outside the app (the desktop app looks when its window gets the focus back).
    onCleanup(backend().onSettingsChanged(settingsFileEdited));
    // Port-forwards are the engine's too (a reload of the UI finds them running).
    startForwardsFeed();

    initViews();
    initReopen();
    initMetrics();
    registerBuiltinCommands();
    onCleanup(registerCompareCommands());
    onCleanup(registerRecentQueryCommands());
    onCleanup(startUpdates());

    // What the user did recently, attached to freeze reports in the log.
    const trail = <T,>(source: () => T, text: (v: T) => string) => createEffect(on(source, (v) => breadcrumb(text(v)), { defer: true }));
    trail(pickerOpen, (p) => (p ? `opened ${p} picker` : "closed picker"));
    trail(paletteOpen, (p) => (p ? "opened palette" : "closed palette"));
    trail(settingsOpen, (s) => (s ? `opened settings: ${s}` : "closed settings"));
    trail(resourceKey, (k) => `view ${k}`);
    trail(namespaces, (ns) => `namespaces [${ns.join(",") || "all"}] (${ns.length})`);
    trail(selectedClusters, (cl) => `clusters ${cl.length}: ${cl.slice(0, 4).join(",")}${cl.length > 4 ? ",…" : ""}`);
    trail(detailsOpen, (open) => (open ? `opened details of ${selectedKey() ?? "?"}` : "closed details"));
    trail(detailsTab, (tab) => `details tab ${tab}`);
    trail(readOnly, (ro) => (ro ? "read-only mode on" : "read-only mode off"));
    trail(detailsFull, (full) => (full ? "details full view" : "details side view"));

    installHotkeys();
    onCleanup(installKeyHints());
    const free = () => !dialog();
    // The palette or a picker takes over from the shortcuts sheet and the settings.
    createEffect(
      on(
        [paletteOpen, pickerOpen],
        ([palette, picker]) => {
          if (!palette && !picker) return;
          setHelpOpen(false);
          setSettingsOpen(false);
        },
        { defer: true },
      ),
    );
    bindAll([
      { id: "app.palette", inInputs: true, inTerminal: isMac, priority: 50, when: free, run: () => void setPaletteOpen(paletteOpen() ? false : { query: "" }) },
      { id: "app.palette-new", inInputs: true, inTerminal: isMac, priority: 50, when: free, run: () => void setPaletteOpen({ query: "" }) },
      { id: "app.command", priority: 50, when: () => free() && !paletteOpen(), run: () => void setPaletteOpen({ query: ":" }) },
      { id: "app.clusters", inInputs: true, inTerminal: isMac, priority: 50, when: free, run: () => void setPickerOpen("clusters") },
      { id: "app.namespaces", inInputs: true, inTerminal: isMac, priority: 50, when: free, run: () => void setPickerOpen("namespaces") },
      { id: "app.help", priority: 50, when: () => free() && !paletteOpen() && !pickerOpen() && !settingsOpen(), run: () => void setHelpOpen(!helpOpen()) },
      { id: "app.settings", inInputs: true, inTerminal: isMac, priority: 50, when: free, run: () => void setSettingsOpen(settingsOpen() ? false : "general") },
      // Zoom, as in a browser: ⌘+ (⌘= without Shift) / ⌘− / ⌘0.
      { id: "app.zoom-in", inInputs: true, inTerminal: isMac, priority: 50, run: () => zoomBy(1) },
      { id: "app.zoom-out", inInputs: true, inTerminal: isMac, priority: 50, run: () => zoomBy(-1) },
      { id: "app.zoom-reset", inInputs: true, inTerminal: isMac, priority: 50, run: () => void setUiZoom(1) },
      // The areas of the window, one after another (not from a terminal: F-keys are its programs').
      { id: "app.next-area", inInputs: true, priority: 50, when: () => !modalOpen(), run: () => cycleRegion(1) },
      { id: "app.previous-area", inInputs: true, priority: 50, when: () => !modalOpen(), run: () => cycleRegion(-1) },
    ]);

    return dispose;
  });
}
