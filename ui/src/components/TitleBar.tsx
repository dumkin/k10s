import { batch, createEffect, For, on, Show } from "solid-js";
import mark from "../assets/brand/k10s-crab.svg";
import lockupOnLight from "../assets/brand/k10s-lockup.svg";
import lockupOnDark from "../assets/brand/k10s-lockup-light.svg";
import { withKeys } from "../lib/hotkeys";
import { keyOf } from "../lib/keymap";
import { clusterColor, clusterStatus, selectedClusters, shortName } from "../state/clusters";
import { namespaces } from "../state/nav";
import { helpOpen, paletteOpen, pickerOpen, setHelpOpen, setPaletteOpen, setPickerOpen, setSettingsOpen, setThemePref, settingsOpen, themePref } from "../state/ui";
import { Boundary } from "./Boundary";
import { ClusterPicker } from "./ClusterPicker";
import { Icon } from "./Icon";
import { Kbd } from "./Kbd";
import { NamespacePicker } from "./NamespacePicker";

/** Always mounts a fresh picker — even if a previous one was torn down abnormally. */
function openPicker(which: "clusters" | "namespaces") {
  batch(() => setPickerOpen(null));
  setPickerOpen(which);
}

export function TitleBar() {
  let clusterBtn: HTMLButtonElement | undefined;
  let nsBtn: HTMLButtonElement | undefined;
  const shown = () => selectedClusters().slice(0, 3);
  const extra = () => Math.max(0, selectedClusters().length - 3);
  // ⌘K / ⌘P from inside a picker switch to the palette (and ⌘⇧C / ⌘⇧N from the palette to a picker)
  // instead of stacking two keyboard lists.
  createEffect(on(paletteOpen, (open) => open && setPickerOpen(null), { defer: true }));
  createEffect(on(pickerOpen, (picker) => picker && setPaletteOpen(false), { defer: true }));

  return (
    <header class="titlebar" data-tauri-drag-region>
      {/* Both lockups are in the DOM; the theme (data-theme on <html>) decides which one shows. */}
      <div class="brand" data-tauri-drag-region>
        <img class="lockup on-dark" src={lockupOnDark} alt="k10s" draggable={false} data-tauri-drag-region />
        <img class="lockup on-light" src={lockupOnLight} alt="k10s" draggable={false} data-tauri-drag-region />
        <img class="mark" src={mark} alt="k10s" draggable={false} data-tauri-drag-region />
      </div>

      <button
        ref={clusterBtn}
        class="picker-btn"
        classList={{ open: pickerOpen() === "clusters" }}
        onClick={() => openPicker("clusters")}
        title={withKeys("Clusters", "app.clusters")}
        aria-label={`Clusters: ${selectedClusters().join(", ") || "none selected"}`}
        aria-haspopup="dialog"
        aria-expanded={pickerOpen() === "clusters"}
        data-hint={keyOf("app.clusters")}
        data-hint-at="below"
      >
        <Icon name="layers" size={14} style={{ color: "var(--text-3)" }} />
        <span class="value">
          <Show when={selectedClusters().length} fallback={<span class="faint">Select clusters</span>}>
            <For each={shown()}>
              {(name) => (
                <span class="chip" style={{ height: "20px" }} title={name}>
                  <Show when={clusterStatus[name]?.state === "connecting"} fallback={<span class="swatch" style={{ background: clusterStatus[name]?.state === "error" ? "var(--err)" : clusterColor(name) }} />}>
                    <span class="spinner" style={{ width: "8px", height: "8px" }} />
                  </Show>
                  <span class="ellipsis" style={{ "max-width": "150px" }}>
                    {selectedClusters().length > 1 ? shortName(name) : name}
                  </span>
                </span>
              )}
            </For>
            <Show when={extra()}>
              <span class="more">+{extra()}</span>
            </Show>
          </Show>
        </span>
        <Icon name="chevron-down" size={14} />
      </button>

      <button
        ref={nsBtn}
        class="picker-btn"
        classList={{ open: pickerOpen() === "namespaces" }}
        onClick={() => openPicker("namespaces")}
        title={withKeys("Namespaces", "app.namespaces")}
        aria-label={`Namespaces: ${namespaces().join(", ") || "all"}`}
        aria-haspopup="dialog"
        aria-expanded={pickerOpen() === "namespaces"}
        data-hint={keyOf("app.namespaces")}
        data-hint-at="below"
      >
        <Icon name="namespace" size={14} style={{ color: "var(--text-3)" }} />
        <span class="value">
          <Show when={namespaces().length} fallback={<span>All namespaces</span>}>
            <span class="ellipsis" style={{ "max-width": "220px" }}>
              {namespaces().slice(0, 2).join(", ")}
            </span>
            <Show when={namespaces().length > 2}>
              <span class="more">+{namespaces().length - 2}</span>
            </Show>
          </Show>
        </span>
        <Icon name="chevron-down" size={14} />
      </button>

      <div class="spacer" data-tauri-drag-region />

      <button
        class="palette-btn"
        onClick={() => setPaletteOpen({ query: "" })}
        title={withKeys("Command palette", "app.palette")}
        aria-label="Command palette"
        aria-haspopup="dialog"
        data-hint={keyOf("app.palette")}
        data-hint-at="below"
      >
        <Icon name="search" size={14} />
        <span class="label">Jump to anything…</span>
        <Kbd id="app.palette" />
      </button>
      <button
        class="btn ghost icon"
        title={withKeys("Keyboard shortcuts", "app.help")}
        aria-label="Keyboard shortcuts"
        aria-haspopup="dialog"
        data-hint={keyOf("app.help")}
        data-hint-at="below"
        onClick={() => setHelpOpen(!helpOpen())}
      >
        <Icon name="keyboard" size={16} />
      </button>
      <button
        class="btn ghost icon"
        title={`Switch to the ${themePref() === "dark" ? "light" : "dark"} theme`}
        aria-label={`Switch to the ${themePref() === "dark" ? "light" : "dark"} theme`}
        onClick={() => setThemePref(themePref() === "dark" ? "light" : "dark")}
      >
        <Icon name={themePref() === "dark" ? "sun" : "moon"} size={15} />
      </button>
      <button
        class="btn ghost icon"
        classList={{ on: !!settingsOpen() }}
        title={withKeys("Settings", "app.settings")}
        aria-label="Settings"
        aria-haspopup="dialog"
        data-hint={keyOf("app.settings")}
        data-hint-at="below"
        onClick={() => setSettingsOpen(settingsOpen() ? false : "general")}
      >
        <Icon name="settings" size={16} />
      </button>

      <Show when={pickerOpen() === "clusters"}>
        <Boundary where="the cluster picker" silent onError={() => setPickerOpen(null)}>
          <ClusterPicker anchor={clusterBtn} onClose={() => setPickerOpen(null)} />
        </Boundary>
      </Show>
      <Show when={pickerOpen() === "namespaces"}>
        <Boundary where="the namespace picker" silent onError={() => setPickerOpen(null)}>
          <NamespacePicker anchor={nsBtn} onClose={() => setPickerOpen(null)} />
        </Boundary>
      </Show>
    </header>
  );
}
