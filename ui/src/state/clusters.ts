import { HELM_RELEASES, HELM_RESOURCE } from "../lib/helm";
import { batch, createSignal } from "solid-js";
import { createStore } from "solid-js/store";
import { backend, type ClusterInfo, type ClusterState, type ContextInfo, type ContextList, errorMessage, type ResourceInfo } from "../lib/backend";
import { assignColors, type ClusterFamily, families, shortNames, zoneOf } from "../lib/clusters";
import { arrayOf, isObject, isString, persisted, setting } from "../lib/persist";
import { globalMemo } from "../lib/reactive";
import { breadcrumb } from "../lib/watchdog";

export interface ClusterStatus {
  state: ClusterState;
  version?: string;
  message?: string;
  info?: ClusterInfo;
}

export interface ClusterSet {
  name: string;
  clusters: string[];
}

export const [contexts, setContexts] = createSignal<ContextInfo[]>([]);
export const [contextsError, setContextsError] = createSignal<string | null>(null);
export const [kubeconfigPaths, setKubeconfigPaths] = createSignal<string[]>([]);
/** The last kubeconfig read that succeeded; null until the first one (which may wait for the login shell). */
const [contextList, setContextList] = createSignal<ContextList | null>(null);
const isStrings = arrayOf(isString);
const isClusterSet = (v: unknown): v is ClusterSet => isObject(v) && isString(v.name) && isStrings(v.clusters);
export const [selectedClusters, setSelectedClustersRaw] = persisted<string[]>("clusters", [], isStrings);
export const [savedSets, setSavedSets] = setting<ClusterSet[]>("clusterSets", [], arrayOf(isClusterSet));
export const [recentClusters, setRecentClusters] = persisted<string[]>("recentClusters", [], isStrings);
export const [clusterStatus, setClusterStatus] = createStore<Record<string, ClusterStatus>>({});

export const contextNames = globalMemo(() => contexts().map((c) => c.name));
export const clusterFamilies = globalMemo(() => families(contextNames()));

/** Suffixes that name a zone or DC (`z1`, `dc2`, `az1`, `zone-a`, `eu-west-1`). */
const ZONE_SUFFIX = /^(?:(?:z|dc|az)\d+(?:[-_]\d+)?|zone[-_]?[a-z0-9]+|[a-z]{2}-[a-z]+-\d[a-z]?)$/i;

/**
 * The family a cluster is one zone of (`prod-eu-z2`, `prod-eu-2` → `prod-eu`), stricter than `zoneOf`: a
 * trailing token is a zone only if it names one or is a number — `k8s-v1.28` is a version. (`zoneOf` already
 * leaves ARNs, URLs and `user@cluster` names without a zone suffix alone.)
 */
export function zoneFamilyOf(name: string): string | undefined {
  const z = zoneOf(name);
  if (!z) return undefined;
  return ZONE_SUFFIX.test(z.zone) || /^\d+$/.test(z.zone) ? z.base : undefined;
}

/** Families of clusters that are zones by name (`prod-eu-z1…z3`): what is safe to offer as one pick. */
export const zoneFamilies = globalMemo<ClusterFamily[]>(() =>
  clusterFamilies()
    .map((f) => ({ base: f.base, members: f.members.filter((m) => zoneFamilyOf(m) === f.base) }))
    .filter((f) => f.members.length > 1),
);

export const clusterShortNames = globalMemo(() => shortNames(selectedClusters()));
export const clusterColors = globalMemo(() => assignColors(selectedClusters()));
export const isMultiCluster = globalMemo(() => selectedClusters().length > 1);

export const shortName = (name: string) => clusterShortNames().get(name) ?? name;
export const clusterColor = (name: string) => clusterColors().get(name) ?? "var(--text-3)";

/** Union of resources served by the selected, connected clusters (keyed by resource key). */
export const discoveredResources = globalMemo(() => {
  const out = new Map<string, ResourceInfo & { clusters: string[] }>();
  const connected: string[] = [];
  for (const name of selectedClusters()) {
    const info = clusterStatus[name]?.info;
    if (info) connected.push(name);
    for (const r of info?.resources ?? []) {
      const prev = out.get(r.key);
      if (prev) prev.clusters.push(name);
      else out.set(r.key, { ...r, clusters: [name] });
    }
  }
  // Helm releases: every connected cluster may have some (the engine reads their records).
  if (connected.length) out.set(HELM_RELEASES, { ...HELM_RESOURCE, clusters: connected });
  return out;
});

/**
 * What the kubeconfig gave: `loading` until the first read (it may wait for the login-shell environment),
 * `error` when it could not be read or parsed, `missing` when none of the files searched exists, `empty`
 * when they hold no contexts.
 */
export type KubeconfigState =
  | { state: "loading" }
  | { state: "error"; message: string }
  | { state: "missing" | "empty"; paths: string[]; fromEnv: boolean }
  | { state: "ok" };

export const kubeconfigState = globalMemo<KubeconfigState>(
  () => {
    const error = contextsError();
    if (error) return { state: "error", message: error };
    const list = contextList();
    if (!list) return { state: "loading" };
    if (list.contexts.length) return { state: "ok" };
    // `found` is missing from engines that don't report it: then all we know is that there are no contexts.
    return { state: list.found && !list.found.length ? "missing" : "empty", paths: list.found?.length ? list.found : list.paths, fromEnv: !!list.fromEnv };
  },
  { equals: (a, b) => JSON.stringify(a) === JSON.stringify(b) },
);

/**
 * The main area shows the welcome screen instead of a table: no clusters picked yet, or the kubeconfig
 * has a problem none of the picked clusters got past (none is connected).
 */
export const needsWelcome = globalMemo(() => {
  const picked = selectedClusters();
  if (!picked.length) return true;
  const st = kubeconfigState().state;
  return st !== "ok" && st !== "loading" && !picked.some((c) => clusterStatus[c]?.state === "connected");
});

/**
 * Lists the contexts. Picks the clusters to show when none of the saved ones exist (first run): kubectl's
 * current context if there is one, otherwise none — the welcome screen asks. Connecting a context the
 * user did not choose (the alphabetically first of a hundred, possibly production) would run its auth
 * plugin and list its pods across all namespaces.
 */
export async function loadContexts() {
  try {
    const list = await backend().listContexts();
    batch(() => {
      setContexts(list.contexts);
      setKubeconfigPaths(list.paths);
      setContextList(list);
      setContextsError(null);
      // No contexts at all means the kubeconfig is missing or unreadable right now (wrong KUBECONFIG,
      // a tool rewriting it): keep the saved selection instead of wiping it.
      if (!list.contexts.length) return;
      const known = new Set(list.contexts.map((c) => c.name));
      const cur = selectedClusters();
      const kept = cur.filter((c) => known.has(c));
      const next = kept.length ? kept : list.current && known.has(list.current) ? [list.current] : [];
      // The same selection (a reload): marks, menus and the recent list stay as they are. Still connected.
      if (next.length === cur.length && next.every((c, i) => c === cur[i])) for (const c of next) void ensureConnected(c);
      else setSelectedClusters(next);
    });
  } catch (e) {
    setContextsError(errorMessage(e));
  }
}

export function setSelectedClusters(names: string[]) {
  const unique = [...new Set(names)];
  setSelectedClustersRaw(unique);
  setRecentClusters((prev) => [...unique, ...prev.filter((c) => !unique.includes(c))].slice(0, 12));
  for (const name of unique) void ensureConnected(name);
}

export function toggleCluster(name: string) {
  const cur = selectedClusters();
  if (cur.includes(name)) {
    if (cur.length > 1) setSelectedClusters(cur.filter((c) => c !== name));
  } else setSelectedClusters([...cur, name]);
}

/**
 * Connects (or with `force`, reconnects with fresh credentials) a cluster. Resolves to whether it is
 * connected now — the error itself lands in `clusterStatus`. Open tables, pickers and log streams of the
 * cluster follow a reconnect by themselves (the engine restarts their watches).
 */
export async function ensureConnected(name: string, force = false): Promise<boolean> {
  const st = clusterStatus[name];
  if (!force && (st?.state === "connected" || st?.state === "connecting") && (st.info || st.state === "connecting")) return st.state === "connected";
  setClusterStatus(name, { state: "connecting", message: undefined });
  try {
    const info = await (force ? backend().reconnect(name) : backend().connect(name));
    setClusterStatus(name, { state: "connected", info, version: info.version ?? undefined, message: undefined });
    return true;
  } catch (e) {
    setClusterStatus(name, { state: "error", message: errorMessage(e), info: undefined });
    return false;
  }
}

/**
 * Tries a failed cluster again (Retry). One that could not be connected connects again with the credentials it
 * has: a cluster that was only unreachable does not run its auth plugin again (the engine keeps its client for
 * that). A connected one, whose watches failed, reconnects: that restarts them at once — also those waiting out
 * their backoff after network trouble, and those that gave up. Expired credentials take `ensureConnected(name,
 * true)` (Reconnect). Resolves to whether it is connected now.
 */
export function retryCluster(name: string): Promise<boolean> {
  return ensureConnected(name, clusterStatus[name]?.state === "connected");
}

export async function refreshDiscovery(name: string) {
  const info = await backend().refreshDiscovery(name);
  setClusterStatus(name, { state: "connected", info, version: info.version ?? undefined });
}

export function saveClusterSet(name: string, clusters = selectedClusters()) {
  setSavedSets((sets) => [...sets.filter((s) => s.name !== name), { name, clusters }].sort((a, b) => a.name.localeCompare(b.name)));
}

export function deleteClusterSet(name: string) {
  setSavedSets((sets) => sets.filter((s) => s.name !== name));
}

export function listenEngineEvents() {
  return backend().onEngineEvent((e) => {
    if (e.type === "contexts") {
      void loadContexts();
      return;
    }
    if (e.type !== "cluster") return;
    const prev = clusterStatus[e.context];
    if (e.state === "connected") {
      // Keep the discovery info we already have; `ensureConnected` fills it in.
      setClusterStatus(e.context, { ...prev, state: "connected", version: e.version, message: undefined });
      if (!prev?.info && selectedClusters().includes(e.context)) void ensureConnected(e.context, false);
    } else {
      setClusterStatus(e.context, { ...prev, state: e.state, message: e.message, ...(e.state === "disconnected" ? { info: undefined } : {}) });
    }
  });
}

/** A clock jump this big between two ticks means the computer slept. */
const WAKE_GAP_MS = 15_000;
/** Resyncs are at most this frequent (network events come in bursts). */
const RESYNC_MIN_INTERVAL_MS = 10_000;

/**
 * Feed it a tick every second; it says when the computer just woke from sleep: the wall clock moved
 * ahead of the monotonic one (which stands still during sleep), or — where the monotonic clock keeps
 * counting through sleep — a tick came more than `gapMs` late while the page was visible (hidden
 * pages get their timers throttled, which is not sleep).
 */
export function createWakeDetector(gapMs = WAKE_GAP_MS) {
  let last: { wall: number; mono: number; visible: boolean } | undefined;
  return (wall: number, mono: number, visible: boolean): boolean => {
    const prev = last;
    last = { wall, mono, visible };
    if (!prev) return false;
    const wallGap = wall - prev.wall;
    return wallGap - (mono - prev.mono) > gapMs || (prev.visible && visible && wallGap > gapMs);
  };
}

/**
 * After sleep or a network change, watches may be dead or stale while still looking healthy: ask the
 * engine to restart them with fresh lists and to retry clusters that could not be reached.
 */
export function startWakeDetector(): () => void {
  const woke = createWakeDetector();
  let lastResync = 0;
  const resync = (why: string) => {
    const now = Date.now();
    if (now - lastResync < RESYNC_MIN_INTERVAL_MS) return;
    lastResync = now;
    breadcrumb(`resync: ${why}`);
    void backend()
      .resync()
      .catch(() => {});
  };
  const tick = () => {
    if (woke(Date.now(), performance.now(), document.visibilityState === "visible")) resync("woke from sleep");
  };
  tick();
  const timer = setInterval(tick, 1000);
  const online = () => resync("network is back");
  window.addEventListener("online", online);
  return () => {
    clearInterval(timer);
    window.removeEventListener("online", online);
  };
}
