import { type Accessor, batch, createEffect, createMemo, on, untrack } from "solid-js";
import { ATTENTION } from "../lib/attention";
import { PERMISSIONS } from "../lib/permissions";
import { errorTitle, isError, isForbidden } from "../lib/k8s";
import { selectedClusters } from "./clusters";
import { clearMarks, currentResource, marked, namespaces, openDetails, pendingReveal, rememberNamespaces, resourceKey, selectedKey, setPendingReveal } from "./nav";
import { rowVisibility } from "./table";
import { createNamesFeed, createViewFeed, type FeedState, type NamesFeed, type UIRow, type ViewFeed } from "./view";

// App-wide feeds: the main table and the namespace names used by the namespace picker and palette.

export interface NamespaceOption {
  name: string;
  /** How many of the selected clusters have it. */
  clusters: number;
}

/** Why a cluster shows no namespaces in the picker. */
export interface NamespaceListingError {
  cluster: string;
  message: string;
  /** Short title: "No access", "Not authorized — credentials expired?", "Error"… */
  title: string;
  /**
   * 403: the user's role may not list namespaces there (strict RBAC) — typing names is the way in.
   * Anything else (no network, a timeout, expired credentials) may pass: worth a retry, not an RBAC hint.
   */
  forbidden: boolean;
}

export let mainView!: ViewFeed;
export let nsNames!: NamesFeed;
export let namespaceErrors!: Accessor<NamespaceListingError[]>;

/** One error per cluster that failed to list namespaces (its cluster-level status or its feed's). */
export function namespaceListingErrors(statuses: Iterable<FeedState | undefined>): NamespaceListingError[] {
  const by = new Map<string, NamespaceListingError>();
  for (const s of statuses) {
    if (!isError(s) || by.has(s.c)) continue;
    by.set(s.c, { cluster: s.c, message: s.message, title: errorTitle(s), forbidden: isForbidden(s) });
  }
  return [...by.values()];
}

/** Natural-order key: digit runs zero-padded ("ns-9" < "ns-10"). Namespace names are lowercase already. */
const natKeys = new Map<string, string>();
function natKey(name: string): string {
  let k = natKeys.get(name);
  if (k === undefined) {
    k = name.replace(/\d+/g, (d) => d.padStart(12, "0"));
    if (natKeys.size > 200_000) natKeys.clear();
    natKeys.set(name, k);
  }
  return k;
}

/**
 * What actions apply to: the marked rows if any are marked, else the selected row — in both cases only
 * rows visible in the table. A mark on a filtered-out row (or one in a hidden cluster) is never acted on.
 */
export const selectionTargets = (): UIRow[] => selection().targets;

/** Marked rows that exist but are filtered out or in a hidden cluster. */
export const hiddenMarkCount = (): number => selection().hidden;

/** `selectionTargets` and `hiddenMarkCount` in one pass over the marks (there can be tens of thousands). */
export function selection(): { targets: UIRow[]; hidden: number } {
  mainView.version();
  const m = marked();
  const visible = rowVisibility();
  if (m.size) {
    const targets: UIRow[] = [];
    let hidden = 0;
    for (const k of m) {
      const r = mainView.rowByKey(k);
      if (!r) continue;
      if (visible(r)) targets.push(r);
      else hidden++;
    }
    return { targets, hidden };
  }
  const k = selectedKey();
  const r = k ? mainView.rowByKey(k) : undefined;
  return { targets: r && visible(r) ? [r] : [], hidden: 0 };
}

/**
 * Remembers the open namespaces (for the namespace picker and the "no access" screen) once they worked on a
 * cluster: its namespace listing has them or — when it may not list namespaces — the main table listed
 * something there. Not while they are only typed: under strict RBAC a typo gets the same 403 as a namespace
 * without access, and would be offered from then on. Each namespace is remembered for the clusters that
 * served it, once while it stays open: one picked next to it becomes the most recent without the others
 * being stamped again (and moving in the picker). Closed and opened again, it is the most recent again.
 */
function rememberWorkingNamespaces() {
  const pair = (c: string, ns: string) => `${c}\n${ns}`;
  let done = new Set<string>();
  createEffect(() => {
    const open = namespaces();
    const clusters = selectedClusters();
    if (!open.length || !clusters.length) {
      done = new Set();
      return;
    }
    nsNames.version();
    const listed = nsNames.clusters();
    const listing = new Map<string, FeedState["state"]>();
    for (const s of Object.values(nsNames.statuses)) if (s && s.ns === null) listing.set(s.c, s.state);
    const served = new Set<string>();
    for (const s of Object.values(mainView.statuses)) if (s?.state === "ready" && s.ns !== null) served.add(pair(s.c, s.ns));
    const wanted = new Set<string>();
    const fresh = new Map<string, string[]>();
    for (const ns of open) {
      for (const c of clusters) {
        const k = pair(c, ns);
        wanted.add(k);
        if (done.has(k)) continue;
        // A working listing decides: a name it lacks is no namespace there, even if listing pods "in" it returned
        // nothing instead of a 403 (cluster-wide roles). Without one, what the cluster served does. Until the
        // listing has answered, neither.
        const works = listing.get(c) === "ready" ? !!listed.get(c)?.has(ns) : listing.get(c) === "error" && served.has(k);
        if (!works) continue;
        done.add(k);
        fresh.set(ns, [...(fresh.get(ns) ?? []), c]);
      }
    }
    done = new Set([...done].filter((k) => wanted.has(k)));
    // In the order they were opened: the last one is the most recent.
    if (fresh.size) untrack(() => fresh.forEach((cs, ns) => rememberNamespaces([ns], cs)));
  });
}

let optionsCache: { version: number; options: NamespaceOption[] } | undefined;

/**
 * Namespaces of the selected clusters, merged and naturally sorted. Computed on demand (only while a
 * picker or the palette shows them) and cached until the set of names changes — fleets have tens of
 * thousands of namespaces, and nothing should pay for them in the background.
 */
export function namespaceOptions(): NamespaceOption[] {
  const version = nsNames.version();
  if (optionsCache?.version === version) return optionsCache.options;
  const count = new Map<string, number>();
  for (const names of nsNames.clusters().values()) for (const name of names.keys()) count.set(name, (count.get(name) ?? 0) + 1);
  const options = Array.from(count, ([name, clusters]) => ({ name, clusters, key: natKey(name) }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .map(({ name, clusters }) => ({ name, clusters }));
  optionsCache = { version, options };
  return options;
}

export function initViews() {
  // "Needs attention" and "My permissions" are no tables: they have views of their own.
  mainView = createViewFeed(() =>
    resourceKey() === ATTENTION || resourceKey() === PERMISSIONS
      ? null
      : {
          resource: resourceKey(),
          clusters: selectedClusters(),
          namespaces: currentResource()?.namespaced === false ? [] : namespaces(),
        },
  );

  nsNames = createNamesFeed(() => ({ resource: "namespaces", clusters: selectedClusters(), namespaces: [] }));

  namespaceErrors = createMemo(() => namespaceListingErrors(Object.values(nsNames.statuses)));

  // Marks belong to what is on screen: other clusters or namespaces mean other rows (like `navigate`).
  createEffect(on([selectedClusters, namespaces], () => clearMarks(), { defer: true }));

  rememberWorkingNamespaces();

  // Cross-navigation: select an object as soon as it shows up in the main table.
  createEffect(() => {
    const want = pendingReveal();
    if (!want) return;
    const row = mainView.rows().find((r) => r.cl === want.cluster && r.n === want.name && (r.ns ?? null) === (want.namespace ?? null));
    if (row) {
      batch(() => {
        openDetails(row.key, want.tab);
        setPendingReveal(null);
      });
    }
  });
}
