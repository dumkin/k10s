import { Show } from "solid-js";
import { AttentionView } from "./components/Attention";
import { PermissionsView } from "./components/Permissions";
import { Boundary } from "./components/Boundary";
import { CommandPalette } from "./components/CommandPalette";
import { Dock } from "./components/Dock";
import "./components/Forwards";
import { KeyHints } from "./components/KeyHints";
import { Dialog, Toasts } from "./components/Overlays";
import { ResourceView } from "./components/ResourceView";
import { Settings } from "./components/Settings";
import { ShortcutsHelp } from "./components/ShortcutsHelp";
import { Sidebar } from "./components/Sidebar";
import { StatusBar } from "./components/StatusBar";
import { TitleBar } from "./components/TitleBar";
import { Welcome } from "./components/Welcome";
import { ATTENTION } from "./lib/attention";
import { PERMISSIONS } from "./lib/permissions";
import { needsWelcome } from "./state/clusters";
import { resourceKey } from "./state/nav";
import { dockSpace } from "./state/dock";
import { setHelpOpen, setPaletteOpen, setSettingsOpen, sidebarWidth } from "./state/ui";

export function App(props: { version: string }) {
  return (
    // `--dock-space`: room the dock takes under the table (a full view of the details stays above it).
    <div class="app" style={{ "--sidebar-w": `${sidebarWidth()}px`, "--dock-space": `${dockSpace()}px` }}>
      <Boundary where="the title bar">
        <TitleBar />
      </Boundary>
      <Boundary where="the sidebar">
        <Sidebar />
      </Boundary>
      <div class="workspace">
        <main class="main">
          <Boundary where="the resource view">
            {/* Nothing picked yet (first run), or a kubeconfig none of the picked clusters got past. */}
            <Show when={!needsWelcome()} fallback={<Welcome />}>
              <Show when={resourceKey() !== ATTENTION} fallback={<AttentionView />}>
                <Show when={resourceKey() !== PERMISSIONS} fallback={<PermissionsView />}>
                  <ResourceView />
                </Show>
              </Show>
            </Show>
          </Boundary>
        </main>
        <Boundary where="the terminals">
          <Dock />
        </Boundary>
      </div>
      <Boundary where="the status bar">
        <StatusBar version={props.version} />
      </Boundary>
      <Boundary where="the command palette" silent onError={() => setPaletteOpen(false)}>
        <CommandPalette />
      </Boundary>
      <Boundary where="the keyboard shortcuts" silent onError={() => setHelpOpen(false)}>
        <ShortcutsHelp />
      </Boundary>
      <Boundary where="the settings" silent onError={() => setSettingsOpen(false)}>
        <Settings />
      </Boundary>
      <Dialog />
      <Toasts />
      <Boundary where="the key hints" silent>
        <KeyHints />
      </Boundary>
    </div>
  );
}
