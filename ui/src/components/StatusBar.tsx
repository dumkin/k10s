import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { backend, type HubStats, isTauri } from "../lib/backend";
import { comboLabel } from "../lib/hotkeys";
import { clusterColor, clusterStatus, selectedClusters, shortName } from "../state/clusters";
import { clearPins, pins } from "../state/compare";
import { dockOpen, dockTab, setDockOpen, setDockTab, termTabs } from "../state/dock";
import { forwards } from "../state/forwards";
import { ATTENTION } from "../lib/attention";
import { PERMISSIONS } from "../lib/permissions";
import { attentionCount } from "../state/attention";
import { resourceKey, resourceTitle } from "../state/nav";
import { readOnly, setPickerOpen, setReadOnly } from "../state/ui";
import { restartToUpdate, update } from "../state/updates";
import { mainView } from "../state/views";
import { Icon } from "./Icon";

export function StatusBar(props: { version: string }) {
  const [stats, setStats] = createSignal<HubStats>();
  onMount(() => {
    const poll = () => backend().stats().then(setStats, () => {});
    poll();
    const t = setInterval(poll, 4000);
    onCleanup(() => clearInterval(t));
  });

  return (
    <footer class="statusbar">
      <For each={selectedClusters().slice(0, 8)}>
        {(c) => {
          const st = () => clusterStatus[c];
          return (
            <button class="item" onClick={() => setPickerOpen("clusters")} title={`${c}${st()?.version ? ` · ${st()!.version}` : ""}${st()?.message ? `\n${st()!.message}` : ""}`}>
              <span
                class={`dot ${st()?.state === "connected" ? "" : st()?.state === "error" ? "tone-3" : "pulse"}`}
                style={st()?.state === "connected" ? { background: clusterColor(c), opacity: 1 } : undefined}
              />
              {selectedClusters().length > 1 ? shortName(c) : c}
            </button>
          );
        }}
      </For>
      <Show when={selectedClusters().length > 8}>
        <span class="item">+{selectedClusters().length - 8}</span>
      </Show>
      <span class="sep" />
      <span class="item">
        <Show
          when={resourceKey() === ATTENTION}
          fallback={resourceKey() === PERMISSIONS ? "permissions" : `${mainView.rows().length.toLocaleString("en-US")} ${resourceTitle(resourceKey()).toLowerCase()}`}
        >
          {attentionCount() ?? 0} need{attentionCount() === 1 ? "s" : ""} attention
        </Show>
      </span>
      <Show when={stats()}>
        {(s) => (
          <span class="item" title="Live watches (active) · objects cached in the engine">
            <Icon name="zap" size={11} />
            {s().feeds} watches ({s().active} active) · {s().objects.toLocaleString("en-US")} objects
          </span>
        )}
      </Show>
      <Show when={termTabs().length}>
        <button
          class="item"
          title={`Terminals (${comboLabel("mod+j")})`}
          onClick={() => {
            const open = dockOpen() && dockTab() !== "forwards";
            if (!open) setDockTab(termTabs().at(-1)!.id);
            setDockOpen(!open);
          }}
        >
          <Icon name="terminal" size={11} />
          {termTabs().length}
        </button>
      </Show>
      <Show when={forwards().length}>
        <button
          class="item"
          title={forwards()
            .map((f) => `localhost:${f.localPort}`)
            .join(", ")}
          onClick={() => {
            const open = dockOpen() && dockTab() === "forwards";
            setDockTab("forwards");
            setDockOpen(!open);
          }}
        >
          <Icon name="link" size={11} />
          {forwards().length} {forwards().length === 1 ? "forward" : "forwards"}
        </button>
      </Show>
      <Show when={pins().length}>
        <span
          class="item pins"
          title={`Pinned to compare (+): ${pins()
            .map((p) => `${p.name} in ${p.cluster}`)
            .join(", ")}. The Compare tab (=) of any other object compares it with ${pins().length > 1 ? "them" : "it"}.`}
        >
          <Icon name="pin" size={11} />
          {pins().length === 1 ? `${pins()[0].name} · ${shortName(pins()[0].cluster)}` : `${pins().length} pinned`}
          <button class="pins-x" onClick={clearPins} title="Unpin" aria-label="Unpin">
            <Icon name="x" size={10} />
          </button>
        </span>
      </Show>
      <Show when={update()?.ready && update()}>
        {(u) => (
          <button class="item update" onClick={() => void restartToUpdate()} title={`k10s ${u().version} is downloaded and verified. Click to restart into it.`}>
            <Icon name="download" size={11} />
            Update to {u().version}
          </button>
        )}
      </Show>
      <Show
        when={readOnly()}
        fallback={
          <button class="item" onClick={() => void setReadOnly(true)} title="Changes are allowed (delete, scale, restart…). Click to turn read-only mode on.">
            read-write
          </button>
        }
      >
        <button
          class="item ro"
          onClick={() => void setReadOnly(false)}
          title="Read-only mode: changes are off — delete, scale, restart, cordon, suspend, trigger, Helm rollback and uninstall — and so are shells in containers (they can change anything there). Reading, logs and port-forwards work. Click to turn it off (asks to confirm)."
          aria-label="Read-only mode is on"
        >
          <span class="badge warn" style={{ gap: "4px" }}>
            <Icon name="lock" size={11} />
            READ-ONLY
          </span>
        </button>
      </Show>
      <Show when={!isTauri}>
        <span class="badge warn" title="Running in a browser with simulated clusters">
          mock data
        </span>
      </Show>
      <span class="item">
        <span class="kbd">{comboLabel("mod+k")}</span>
      </span>
      <span class="item">v{props.version}</span>
    </footer>
  );
}
