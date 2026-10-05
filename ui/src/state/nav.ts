import { batch, createSignal } from "solid-js";
import { ATTENTION } from "../lib/attention";
import { PERMISSIONS } from "../lib/permissions";
import type { ObjectRef, ResourceInfo } from "../lib/backend";
import { naturalCompare } from "../lib/clusters";
import { isMac } from "../lib/hotkeys";
import { isValidNamespace, normalizeNamespace } from "../lib/k8s";
import { arrayOf, isNumber, isString, persisted, recordOf } from "../lib/persist";
import { globalMemo } from "../lib/reactive";
import { catalogEntry, titleFor } from "../registry/catalog";
import { contexts, discoveredResources, selectedClusters, zoneFamilyOf } from "./clusters";
import type { UIRow } from "./view";

// What the main table shows and what is selected in it.

const isStrings = arrayOf(isString);

export const [resourceKey, setResourceKeyRaw] = persisted("resource", "pods", (v): v is string => isString(v) && v !== "");
/** Selected namespaces; empty = all namespaces. */
export const [namespaces, setNamespacesRaw] = persisted<string[]>("namespaces", [], isStrings);
export const [recentResources, setRecentResources] = persisted<string[]>("recentResources", [], isStrings);
export const [filter, setFilter] = createSignal("");

export const [selectedKey, setSelectedKey] = createSignal<string | null>(null);
export const [marked, setMarked] = createSignal<ReadonlySet<string>>(new Set());
export const [detailsOpen, setDetailsOpen] = createSignal(false);
export const [detailsTab, setDetailsTab] = createSignal("overview");
/** The details panel fills the window (the table stays under it): for long logs and YAML. Closing it ends this. */
export const [detailsFull, setDetailsFull] = createSignal(false);

/** Object to select once it shows up in the table (cross-navigation from details, palette…). */
export const [pendingReveal, setPendingReveal] = createSignal<{ cluster: string; namespace?: string | null; name: string; tab?: string } | null>(null);

export const currentResource = globalMemo<ResourceInfo | undefined>(() => discoveredResources().get(resourceKey()));

export function resourceTitle(key: string): string {
  if (key === ATTENTION) return "Needs attention";
  if (key === PERMISSIONS) return "My permissions";
  const entry = catalogEntry(key);
  if (entry) return entry.title;
  const r = discoveredResources().get(key);
  return r ? titleFor(r.kind) : key;
}

/** Switches the table to another resource with a clean slate (no filter, selection, marks or details). */
function switchResource(key: string) {
  batch(() => {
    setResourceKeyRaw(key);
    setFilter("");
    setSelectedKey(null);
    setMarked(new Set<string>());
    setDetailsOpen(false);
    setDetailsFull(false);
    // A reveal still waiting for its object belongs to the view being left.
    setPendingReveal(null);
  });
  setRecentResources((prev) => [key, ...prev.filter((k) => k !== key)].slice(0, 10));
}

export function navigate(key: string) {
  if (key === resourceKey()) return;
  pushHistory();
  switchResource(key);
}

/** Opens these namespaces (none = all). They are remembered once a cluster serves them (see `initViews`). */
export function setNamespaces(list: string[]) {
  setNamespacesRaw([...new Set(list.map(normalizeNamespace).filter(Boolean))]);
}

// ---------------------------------------------------------------------------------------------
// Namespace memory
// ---------------------------------------------------------------------------------------------
//
// Under strict RBAC namespaces cannot be listed, only typed: the ones that worked are remembered for the
// clusters that served them, and offered (in the namespace picker, on the "no access" screen) next to the
// namespace each cluster's kubeconfig context sets. A name is remembered once it worked, not when it is
// typed: a typo gets the same 403 as a namespace without access, and must not be offered from then on.

/** How many namespaces are remembered per cluster family (least recently used ones are forgotten first). */
export const NAMESPACE_MEMORY_LIMIT = 50;

/**
 * Where a cluster's namespaces are remembered: zones of one family (`prod-eu-z1…z3`) run the same namespaces;
 * any other cluster has its own — also `prod-eu` next to that family, and clusters whose names only look alike
 * (the EKS ARNs of one region, `kubernetes-admin@cluster-1`; see `zoneFamilyOf`).
 */
export const namespaceMemoryKey = (cluster: string) => {
  const family = zoneFamilyOf(cluster);
  return family ? `family:${family}` : `cluster:${cluster}`;
};

/** Memory key → namespace → when it last worked there (ordering only). */
type NamespaceMemory = Record<string, Record<string, number>>;

const [namespaceMemory, setNamespaceMemory] = persisted<NamespaceMemory>("namespaceMemory", {}, recordOf(recordOf(isNumber)));
const entriesIn = (m: NamespaceMemory, key: string): Record<string, number> => m[key] ?? {};

let lastStamp = 0;
const stamp = () => (lastStamp = Math.max(Date.now(), lastStamp + 1));

/** Remembers namespaces that worked on these clusters; the first one counts as the most recent. */
export function rememberNamespaces(names: string[], clusters: string[] = selectedClusters()) {
  const valid = [...new Set(names.map(normalizeNamespace))].filter(isValidNamespace);
  if (!valid.length || !clusters.length) return;
  const at = new Map<string, number>();
  for (let i = valid.length - 1; i >= 0; i--) at.set(valid[i], stamp());
  setNamespaceMemory((prev) => {
    const next: NamespaceMemory = { ...prev };
    for (const key of new Set(clusters.map(namespaceMemoryKey))) {
      const entries = { ...entriesIn(prev, key), ...Object.fromEntries(at) };
      const names = Object.keys(entries);
      next[key] = names.length <= NAMESPACE_MEMORY_LIMIT ? entries : Object.fromEntries(names.sort((a, b) => entries[b] - entries[a]).slice(0, NAMESPACE_MEMORY_LIMIT).map((n) => [n, entries[n]]));
    }
    return next;
  });
}

/** Forgets a remembered namespace (a typo, one that is gone) for these clusters. */
export function forgetNamespace(name: string, clusters: string[] = selectedClusters()) {
  setNamespaceMemory((prev) => {
    const next: NamespaceMemory = { ...prev };
    let changed = false;
    for (const key of new Set(clusters.map(namespaceMemoryKey))) {
      const entries = entriesIn(prev, key);
      // Not `Object.hasOwn` (Safari 15.4+), nor `in` (`constructor` is a valid namespace name).
      if (!Object.prototype.hasOwnProperty.call(entries, name)) continue;
      const { [name]: _, ...rest } = entries;
      if (Object.keys(rest).length) next[key] = rest;
      else delete next[key];
      changed = true;
    }
    return changed ? next : prev;
  });
}

/** Forgets every remembered namespace (tests). */
export function clearNamespaceMemory() {
  setNamespaceMemory({});
}

/** Namespaces remembered for these clusters, most recently used first. */
export function rememberedNamespaces(clusters: string[] = selectedClusters()): string[] {
  const memory = namespaceMemory();
  const last = new Map<string, number>();
  for (const key of new Set(clusters.map(namespaceMemoryKey))) {
    for (const [name, at] of Object.entries(entriesIn(memory, key))) if (at > (last.get(name) ?? -Infinity)) last.set(name, at);
  }
  return [...last].sort((a, b) => b[1] - a[1]).map(([name]) => name);
}

/** The namespaces the kubeconfig contexts of these clusters set (what kubectl would use for each). */
export function kubeconfigNamespaces(clusters: string[] = selectedClusters()): string[] {
  const out = new Set<string>();
  for (const c of clusters) {
    const ns = normalizeNamespace(contexts().find((ctx) => ctx.name === c)?.namespace ?? "");
    if (isValidNamespace(ns)) out.add(ns);
  }
  return [...out];
}

/** Namespaces to offer for the selected clusters: the ones their kubeconfig contexts set, then the remembered ones. */
export const recentNamespaces = globalMemo(() => [...new Set([...kubeconfigNamespaces(), ...rememberedNamespaces()])]);

/** How many namespaces are on number keys (1…9; 0 is all namespaces). */
export const NAMESPACE_KEYS = 9;

/**
 * Namespaces on the keys 1…9 in the table, like k9s's favorites: the ones the kubeconfig contexts set, then the
 * most recently used. The recent ones are in name order: opening one makes it the most recent, and that must not
 * move it to another key — a key keeps its namespace as long as the set stays the same.
 */
export const namespaceKeys = globalMemo(
  () => {
    const kubeconfig = kubeconfigNamespaces();
    const recent = rememberedNamespaces()
      .filter((n) => !kubeconfig.includes(n))
      .slice(0, Math.max(0, NAMESPACE_KEYS - kubeconfig.length))
      .sort(naturalCompare);
    return [...kubeconfig, ...recent].slice(0, NAMESPACE_KEYS);
  },
  { equals: (a, b) => a.length === b.length && a.every((n, i) => n === b[i]) },
);

export function toggleNamespace(ns: string) {
  const cur = namespaces();
  setNamespaces(cur.includes(ns) ? cur.filter((n) => n !== ns) : [...cur, ns]);
}

export function openDetails(key: string, tab?: string) {
  batch(() => {
    setSelectedKey(key);
    setDetailsOpen(true);
    if (tab) setDetailsTab(tab);
  });
}

export function closeDetails() {
  batch(() => {
    setDetailsOpen(false);
    setDetailsFull(false);
  });
}

/**
 * Full view of the details on / off. With the details closed, opens them in full view for the selected row
 * (false: there is none).
 */
export function toggleDetailsFull(): boolean {
  if (detailsOpen()) {
    setDetailsFull(!detailsFull());
    return true;
  }
  const key = selectedKey();
  if (!key) return false;
  batch(() => {
    openDetails(key);
    setDetailsFull(true);
  });
  return true;
}

export function toggleMark(key: string) {
  setMarked((prev) => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  });
}

export function clearMarks() {
  setMarked(new Set<string>());
}

/** Drops these rows from the marks (e.g. after an action succeeded on them). */
export function unmark(keys: Iterable<string>) {
  setMarked((prev) => {
    const next = new Set(prev);
    for (const k of keys) next.delete(k);
    return next.size === prev.size ? prev : next;
  });
}

/** How long a reveal waits for its object (it may never show up: deleted, or not listable under RBAC). */
export const REVEAL_TIMEOUT_MS = 30_000;

/**
 * Shows an object in the main table: switches resource, widens namespaces if needed, selects it. A cluster-scoped
 * object has no namespace, whatever the caller passed (an owner reference carries its dependent's: a mirror pod's
 * Node).
 */
export function reveal(target: { cluster: string; resource: string; namespace?: string | null; name: string; tab?: string }) {
  pushHistory();
  const ns = discoveredResources().get(target.resource)?.namespaced === false ? null : target.namespace;
  const want = { cluster: target.cluster, namespace: ns, name: target.name, tab: target.tab };
  batch(() => {
    if (target.resource !== resourceKey()) switchResource(target.resource);
    if (ns && namespaces().length && !namespaces().includes(ns)) setNamespaces([...namespaces(), ns]);
    setPendingReveal(want);
  });
  setTimeout(() => pendingReveal() === want && setPendingReveal(null), REVEAL_TIMEOUT_MS);
}

// ---------------------------------------------------------------------------------------------
// Back / forward
// ---------------------------------------------------------------------------------------------

/** A view the user can go back to: what the table showed and what was selected and open in it. */
export interface NavState {
  resource: string;
  namespaces: string[];
  filter: string;
  selected: string | null;
  /** Name of the selected object when the state was left (for labels). */
  selectedName?: string;
  details: boolean;
  tab: string;
}

export const HISTORY_LIMIT = 50;
/** ⌘[ / ⌘] on macOS, Alt+← / Alt+→ elsewhere (like browsers). */
export const BACK_COMBO = isMac ? "mod+[" : "alt+arrowleft";
export const FORWARD_COMBO = isMac ? "mod+]" : "alt+arrowright";
const [backStack, setBackStack] = createSignal<NavState[]>([]);
const [forwardStack, setForwardStack] = createSignal<NavState[]>([]);

/** Where "back" / "forward" would go, if anywhere. */
export const backTarget = (): NavState | undefined => backStack()[backStack().length - 1];
export const forwardTarget = (): NavState | undefined => forwardStack()[forwardStack().length - 1];

let rowName: (key: string) => string | undefined = () => undefined;
/** Lets history entries name their selected object (the table registers its row lookup). */
export function setHistoryRowName(fn: (key: string) => string | undefined) {
  rowName = fn;
}

function snapshot(): NavState {
  const selected = selectedKey();
  return {
    resource: resourceKey(),
    namespaces: namespaces(),
    filter: filter(),
    selected,
    selectedName: selected ? rowName(selected) : undefined,
    details: detailsOpen() && !!selected,
    tab: detailsTab(),
  };
}

const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
const sameState = (a: NavState, b: NavState) =>
  a.resource === b.resource && sameList(a.namespaces, b.namespaces) && a.filter === b.filter && a.selected === b.selected && a.details === b.details && (!a.details || a.tab === b.tab);

const pushBounded = (stack: NavState[], s: NavState) => (stack.length && sameState(stack[stack.length - 1], s) ? stack : [...stack, s].slice(-HISTORY_LIMIT));

/** Remembers the current view before a navigation; a new navigation forgets what was "forward". */
function pushHistory() {
  const cur = snapshot();
  batch(() => {
    setBackStack((s) => pushBounded(s, cur));
    setForwardStack([]);
  });
}

function restore(s: NavState) {
  batch(() => {
    setResourceKeyRaw(s.resource);
    if (!sameList(s.namespaces, namespaces())) setNamespacesRaw(s.namespaces);
    setFilter(s.filter);
    setMarked(new Set<string>());
    setPendingReveal(null);
    setSelectedKey(s.selected);
    setDetailsTab(s.tab);
    setDetailsOpen(s.details);
    if (!s.details) setDetailsFull(false);
  });
}

/** Steps through the history: `from` loses its top entry, `to` gains the current view. */
function step(from: () => NavState[], setFrom: (s: NavState[]) => void, setTo: (f: (s: NavState[]) => NavState[]) => void): boolean {
  const cur = snapshot();
  const stack = [...from()];
  // Entries identical to the current view (e.g. a reveal of the object already shown) are no step.
  while (stack.length && sameState(stack[stack.length - 1], cur)) stack.pop();
  const target = stack.pop();
  batch(() => {
    setFrom(stack);
    if (target) {
      setTo((s) => pushBounded(s, cur));
      restore(target);
    }
  });
  return !!target;
}

/** Back to the previous view (resource, namespaces, filter, selection, details). False if there is none. */
export const goBack = () => step(backStack, setBackStack, setForwardStack);
export const goForward = () => step(forwardStack, setForwardStack, setBackStack);

/** Forgets the history (tests). */
export function clearHistory() {
  batch(() => {
    setBackStack([]);
    setForwardStack([]);
  });
}

export function objectRef(row: UIRow, resource = resourceKey()): ObjectRef {
  return { cluster: row.cl, resource, namespace: row.ns ?? null, name: row.n, uid: row.u };
}
