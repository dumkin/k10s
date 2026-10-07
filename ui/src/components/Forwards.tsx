import { For, Show } from "solid-js";
import type { ForwardInfo, ForwardSpec } from "../lib/backend";
import { bytes, plural } from "../lib/format";
import { keyLabel } from "../lib/hotkeys";
import { clusterColor, shortName } from "../state/clusters";
import { forwards, forwardTarget, isPinned, openForward, startForward, startPinned, stopForward, stoppedPins, togglePin } from "../state/forwards";
import { toast } from "../state/ui";
import { registerDockPane } from "./Dock";
import { Icon } from "./Icon";

/** The dock's port-forwards: running ones with their traffic, and pinned ones to start again. */
export function ForwardsPane() {
  const empty = () => !forwards().length && !stoppedPins().length;
  return (
    <div class="forwards">
      <Show when={!empty()} fallback={<Hint />}>
        <Show when={stoppedPins().length > 1}>
          <div class="fw-bar">
            <button class="btn sm ghost" onClick={() => void startPinned()}>
              <Icon name="play" size={12} />
              Start {plural(stoppedPins().length, "pinned forward")}
            </button>
          </div>
        </Show>
        <div class="fw-list">
          <For each={forwards()}>{(f) => <RunningRow f={f} />}</For>
          <For each={stoppedPins()}>{(p) => <PinnedRow spec={p} />}</For>
        </div>
      </Show>
    </div>
  );
}

function Hint() {
  return (
    <div class="dock-empty faint">
      <Icon name="link" size={20} />
      <span>
        No port-forwards
        <Show when={keyLabel("action.port-forward")} fallback=" ">
          {(forward) => (
            <>
              : <span class="kbd">{forward()}</span> on a pod, service or workload forwards one of its ports{" "}
            </>
          )}
        </Show>
        (pinned ones wait here to start again).
        <Show when={keyLabel("action.shell")}>
          {(shell) => (
            <>
              {" "}
              <span class="kbd">{shell()}</span> opens a shell in a pod.
            </>
          )}
        </Show>
      </span>
    </div>
  );
}

function Where(props: { spec: ForwardSpec }) {
  return (
    <span class="fw-where">
      <span class="swatch" style={{ background: clusterColor(props.spec.cluster) }} />
      <span class="faint">{shortName(props.spec.cluster)}</span>
      <span class="faint">{props.spec.namespace}</span>
    </span>
  );
}

function RunningRow(props: { f: ForwardInfo }) {
  const f = () => props.f;
  const url = () => `http://localhost:${f().localPort}`;
  const state = () => (f().error ? "err" : f().connections ? "ok" : "idle");
  const via = () => (f().pod && f().spec.resource !== "pods" ? `pod ${f().pod}:${f().podPort}` : undefined);
  return (
    <div class="fw-row" classList={{ failing: !!f().error }}>
      <span class={`fw-dot ${state()}`} title={f().error ? "The latest connection failed" : f().connections ? "Carrying traffic" : "Listening"} />
      <button class="fw-local mono" title={`Open ${url()} in the browser`} onClick={() => void openForward(f())}>
        localhost:{f().localPort}
      </button>
      <Icon name="chevron-right" size={12} class="faint" />
      <span class="fw-target mono ellipsis" title={via() ? `Connections go to ${via()} now` : undefined}>
        {forwardTarget(f().spec)}
      </span>
      <Show when={via()}>
        <span class="faint ellipsis fw-via">{via()}</span>
      </Show>
      <Where spec={f().spec} />
      <span class="fw-traffic faint" title={`${plural(f().total, "connection")} so far`}>
        <Show when={f().connections}>
          <span>{plural(f().connections, "connection")} · </span>
        </Show>
        ↑ {bytes(f().sent)} ↓ {bytes(f().received)}
      </span>
      <span class="fw-actions">
        <button class="btn sm ghost icon" title={`Open ${url()} in the browser`} onClick={() => void openForward(f())}>
          <Icon name="external" size={12} />
        </button>
        <button
          class="btn sm ghost icon"
          title="Copy the URL"
          onClick={() => {
            void navigator.clipboard.writeText(url());
            toast("info", "Copied to clipboard", url());
          }}
        >
          <Icon name="copy" size={12} />
        </button>
        <button class="btn sm ghost icon" classList={{ on: isPinned(f().spec) }} title={isPinned(f().spec) ? "Unpin" : "Pin: keep it here to start again later"} onClick={() => togglePin(f().spec, f().localPort)}>
          <Icon name="star" size={12} />
        </button>
        <button class="btn sm ghost icon" title="Stop" onClick={() => void stopForward(f())}>
          <Icon name="x" size={12} />
        </button>
      </span>
      <Show when={f().error}>
        <div class="fw-error">{f().error}</div>
      </Show>
    </div>
  );
}

function PinnedRow(props: { spec: ForwardSpec }) {
  return (
    <div class="fw-row stopped">
      <span class="fw-dot" title="Pinned, not running" />
      <span class="fw-local mono faint">localhost:{props.spec.localPort ?? "auto"}</span>
      <Icon name="chevron-right" size={12} class="faint" />
      <span class="fw-target mono ellipsis">{forwardTarget(props.spec)}</span>
      <Where spec={props.spec} />
      <span class="fw-traffic faint">stopped</span>
      <span class="fw-actions">
        <button class="btn sm ghost" title="Start forwarding again" onClick={() => void startForward(props.spec)}>
          <Icon name="play" size={12} />
          Start
        </button>
        <button class="btn sm ghost icon on" title="Unpin" onClick={() => togglePin(props.spec)}>
          <Icon name="star" size={12} />
        </button>
      </span>
    </div>
  );
}

registerDockPane({ id: "forwards", title: "Port forwards", icon: "link", count: () => forwards().length, component: () => <ForwardsPane /> });
