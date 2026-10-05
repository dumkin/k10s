import { createSignal } from "solid-js";
import { backend, errorMessage, type ForwardInfo, type ForwardSpec } from "../lib/backend";
import { arrayOf, isBoolean, isNumber, isObject, isString, setting } from "../lib/persist";
import { toast } from "./ui";

// Port-forwards live in the engine (they outlive a reload of the UI): the UI shows the list it streams, and keeps
// the ones the user pinned — to start again with a click, in a later session too.

export const [forwards, setForwards] = createSignal<ForwardInfo[]>([]);

const isSpec = (v: unknown): v is ForwardSpec =>
  isObject(v) && isString(v.cluster) && isString(v.namespace) && isString(v.resource) && isString(v.name) && isNumber(v.port) && (v.localPort === undefined || isNumber(v.localPort));

/** Forwards kept for later: started from the dock, not by themselves (connecting a cluster may ask for a login). */
export const [pins, setPins] = setting<ForwardSpec[]>("portForward.pinned", [], arrayOf(isSpec));
/** Whether a new forward opens in the browser (the dialog's checkbox, as last left). */
export const [openInBrowser, setOpenInBrowser] = setting("portForward.openBrowser", false, isBoolean);

/** Same target and port (the local port aside). */
export const sameTarget = (a: ForwardSpec, b: ForwardSpec) => a.cluster === b.cluster && a.namespace === b.namespace && a.resource === b.resource && a.name === b.name && a.port === b.port;

const KIND: Record<string, string> = {
  pods: "pod",
  services: "svc",
  "deployments.apps": "deploy",
  "statefulsets.apps": "sts",
  "daemonsets.apps": "ds",
  "replicasets.apps": "rs",
};

/** `svc/web:80`, as kubectl names it. */
export const forwardTarget = (s: ForwardSpec) => `${KIND[s.resource] ?? s.resource}/${s.name}:${s.port}`;

let feed: { close(): void } | undefined;

/** Follows the engine's forwards for as long as the UI runs. */
export function startForwardsFeed() {
  feed?.close();
  feed = backend().subscribeForwards(setForwards);
}

/**
 * Starts a forward (the same target and port running already: that one is shown instead). The engine checks first that
 * it can work and says why not — the local port taken, no permission, no pod to forward to.
 */
export async function startForward(spec: ForwardSpec, open = false): Promise<ForwardInfo | undefined> {
  const running = forwards().find((f) => sameTarget(f.spec, spec) && (spec.localPort === undefined || f.localPort === spec.localPort));
  if (running) {
    toast("info", `Already forwarding localhost:${running.localPort}`, forwardTarget(running.spec));
    if (open) void openForward(running);
    return running;
  }
  try {
    const f = await backend().startForward(spec);
    toast("success", `Forwarding localhost:${f.localPort}`, `${forwardTarget(f.spec)}${f.pod && f.spec.resource !== "pods" ? ` (pod ${f.pod})` : ""}`);
    if (open) void openForward(f);
    return f;
  } catch (e) {
    toast("error", `Could not forward ${forwardTarget(spec)}`, errorMessage(e), { sticky: true, copy: `${spec.cluster}\t${spec.namespace}\t${forwardTarget(spec)}\t${errorMessage(e)}` });
    return undefined;
  }
}

export async function stopForward(f: ForwardInfo) {
  try {
    await backend().stopForward(f.id);
  } catch (e) {
    toast("error", "Could not stop the port-forward", errorMessage(e));
  }
}

export async function openForward(f: ForwardInfo) {
  try {
    await backend().openForward(f.id);
  } catch (e) {
    toast("error", "Could not open the browser", errorMessage(e));
  }
}

export const isPinned = (spec: ForwardSpec) => pins().some((p) => sameTarget(p, spec));

/** Pins a forward (with the local port it got, to get it again) or unpins it. */
export function togglePin(spec: ForwardSpec, localPort?: number) {
  if (isPinned(spec)) setPins(pins().filter((p) => !sameTarget(p, spec)));
  else setPins([...pins(), { ...spec, localPort: localPort ?? spec.localPort }]);
}

/** Pinned forwards not running now. */
export const stoppedPins = () => pins().filter((p) => !forwards().some((f) => sameTarget(f.spec, p)));

export async function startPinned() {
  for (const p of stoppedPins()) await startForward(p);
}
