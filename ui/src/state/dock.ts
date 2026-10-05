import { batch, createSignal } from "solid-js";
import { createStore } from "solid-js/store";
import type { DebugSpec, NodeShellSpec, TermSpec, TermState } from "../lib/backend";
import { isNumber, isString, persisted, setting } from "../lib/persist";

// The dock: a panel under the table with terminals (and port-forwards) that stay open while the views above
// change — logs of one pod streaming next to a shell in another, across clusters.

/** Where a dock log tab's lines come from: a pod, or the pods a selector matches (in one or more clusters). */
export type LogSourceDef =
  | { kind: "pod"; cluster: string; namespace: string; name: string; uid?: string; containers?: string[] }
  | { kind: "selector"; clusters: string[]; namespace: string; selector: string; title?: string; containers?: string[] };

/** Logs that stream in the dock while the views above change: one object's, or of several picked together. */
export interface LogsTabSpec {
  title: string;
  /** The cluster the tab is coloured by (the first one's). */
  cluster: string;
  sources: LogSourceDef[];
  /** A container streamed in every pod; null: each pod's default container ("all": every container). */
  container: string | null;
}

/** What a dock tab runs: a terminal, or a log stream. */
export type TermTarget = { kind: "shell" | "attach"; spec: TermSpec } | { kind: "debug"; spec: DebugSpec } | { kind: "node"; spec: NodeShellSpec } | { kind: "logs"; spec: LogsTabSpec };

export interface TermTab {
  /** Local id: a tab outlives its session (an ended one can be started again in it). */
  id: number;
  target: TermTarget;
}

/** A tab's session as the tab strip shows it. */
export interface TermStatus {
  state: TermState | "ended";
  message?: string;
  /** Ended: the exit code, or that it failed. */
  code?: number;
  error?: boolean;
  /** What the session entered once known (a node shell's helper pod, a debug container). */
  pod?: string;
  container?: string;
}

export const DOCK_MIN = 120;

export const [dockOpen, setDockOpen] = createSignal(false);
/** Height the dock takes now (0 while hidden): what a full view of the details leaves it. */
export const [dockSpace, setDockSpace] = createSignal(0);
/** What debug containers and node shells run unless another image is typed: registries differ from cluster to cluster. */
export const DEFAULT_SHELL_IMAGE = "busybox:1.37";
export const DEFAULT_NODE_SHELL_NAMESPACE = "default";
export const [debugImage, setDebugImage] = setting("terminal.debugImage", DEFAULT_SHELL_IMAGE, isString);
export const [nodeShellImage, setNodeShellImage] = setting("terminal.nodeShellImage", DEFAULT_SHELL_IMAGE, isString);
export const [nodeShellNamespace, setNodeShellNamespace] = setting("terminal.nodeShellNamespace", DEFAULT_NODE_SHELL_NAMESPACE, isString);

export const [dockHeight, setDockHeight] = persisted("dockHeight", 300, (v): v is number => isNumber(v) && v >= DOCK_MIN);
export const [termTabs, setTermTabs] = createSignal<TermTab[]>([]);
/** The tab shown: a terminal's id, or the port-forwards. */
export const [dockTab, setDockTab] = createSignal<number | "forwards">("forwards");
export const [termStatus, setTermStatus] = createStore<Record<number, TermStatus>>({});

let nextId = 0;

/** Opens a new terminal tab (the dock opens on it); its session starts as the tab mounts. */
export function openTerminal(target: TermTarget): number {
  const id = ++nextId;
  batch(() => {
    setTermStatus(id, { state: "connecting" });
    setTermTabs([...termTabs(), { id, target }]);
    setDockTab(id);
    setDockOpen(true);
  });
  return id;
}

/** Opens logs in a new dock tab (the dock opens on it). */
export function openLogs(spec: LogsTabSpec): number {
  return openTerminal({ kind: "logs", spec });
}

/** Closes a terminal tab (ending its session); the tab next to it is shown, else the port-forwards. */
export function closeTerminal(id: number) {
  const tabs = termTabs();
  const at = tabs.findIndex((t) => t.id === id);
  if (at < 0) return;
  const rest = tabs.filter((t) => t.id !== id);
  batch(() => {
    setTermTabs(rest);
    if (dockTab() === id) setDockTab(rest[Math.min(at, rest.length - 1)]?.id ?? "forwards");
    setTermStatus(id, undefined!);
  });
}

/** The tab's title: what it is in, without the cluster (the tab strip shows that as a colour). */
export function termTitle(tab: TermTab, status?: TermStatus): string {
  const t = tab.target;
  switch (t.kind) {
    case "shell":
      return `${t.spec.pod}/${t.spec.container}`;
    case "attach":
      return `attach ${t.spec.pod}/${t.spec.container}`;
    case "debug":
      return `debug ${t.spec.pod}${status?.container ? `/${status.container}` : ""}`;
    case "node":
      return `node ${t.spec.node}`;
    case "logs":
      return `logs ${t.spec.title}`;
  }
}

export const termCluster = (tab: TermTab) => tab.target.spec.cluster;
