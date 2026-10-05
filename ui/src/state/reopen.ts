import { createEffect, on, onCleanup } from "solid-js";
import { isObject, isString, load, save } from "../lib/persist";
import { breadcrumb } from "../lib/watchdog";
import { selectedClusters } from "./clusters";
import { detailsOpen, detailsTab, namespaces, pendingReveal, resourceKey, selectedKey, setPendingReveal } from "./nav";
import type { UIRow } from "./view";
import { mainView } from "./views";

// The object whose details were open when k10s was quit opens again at the next start, on the same tab.

/** An object open in the details, as saved for the next start. */
export interface OpenObject {
  cluster: string;
  resource: string;
  /** null: a cluster-scoped object. */
  namespace: string | null;
  name: string;
  tab: string;
}

export const OPEN_OBJECT_KEY = "openObject";
/** After the table finished loading, how long the row still gets to appear. */
export const REOPEN_GRACE_MS = 1_000;

const isName = (v: unknown): v is string => isString(v) && v !== "";
export const isOpenObject = (v: unknown): v is OpenObject =>
  isObject(v) && isName(v.cluster) && isName(v.resource) && (v.namespace === null || isName(v.namespace)) && isName(v.name) && isName(v.tab);

/** Whether the table shows the object: its resource, its cluster selected, its namespace open (none open: all are). */
export function fitsView(o: OpenObject, view: { resource: string; clusters: readonly string[]; namespaces: readonly string[] }): boolean {
  return o.resource === view.resource && view.clusters.includes(o.cluster) && (o.namespace === null || !view.namespaces.length || view.namespaces.includes(o.namespace));
}

/**
 * The object the details show: null when they are closed, undefined while its row is unknown (the view reloads) —
 * what was saved for it stays.
 */
export function openObjectOf(s: { open: boolean; key: string | null; row: Pick<UIRow, "cl" | "ns" | "n"> | undefined; resource: string; tab: string }): OpenObject | null | undefined {
  if (!s.open || !s.key) return null;
  if (!s.row) return undefined;
  return { cluster: s.row.cl, resource: s.resource, namespace: s.row.ns ?? null, name: s.row.n, tab: s.tab };
}

/** Opens what was open when k10s was quit, once its row shows up, and saves what is open from then on. After `initViews`. */
export function initReopen() {
  const saved = load<OpenObject | null>(OPEN_OBJECT_KEY, null, isOpenObject);
  // Only in the view k10s restored: unlike `reveal`, no other resource, no namespace opened for it, no history entry.
  const waiting = saved && fitsView(saved, { resource: resourceKey(), clusters: selectedClusters(), namespaces: namespaces() }) ? saved : null;
  if (waiting) {
    breadcrumb(`reopening ${waiting.resource} ${waiting.namespace ? `${waiting.namespace}/` : ""}${waiting.name} on ${waiting.tab}`);
    // `initViews` opens it once its row shows up.
    setPendingReveal(waiting);
  }
  const restoring = () => waiting !== null && pendingReveal() === waiting;

  // It may never show up (deleted meanwhile): given up once the table loaded without it. Not after a fixed time, as
  // `reveal` does: the first list of a big table can take longer.
  createEffect(
    on(mainView.loading, (loading) => {
      if (loading || !restoring()) return;
      const t = setTimeout(() => restoring() && setPendingReveal(null), REOPEN_GRACE_MS);
      onCleanup(() => clearTimeout(t));
    }),
  );

  // What the person picks meanwhile wins: the object showing up later must not take the selection from them.
  createEffect(on([selectedKey, detailsOpen], ([key, open]) => (key !== null || open) && restoring() && setPendingReveal(null), { defer: true }));

  let last = JSON.stringify(saved);
  createEffect(() => {
    // While the object is awaited, the details are closed only because it has not shown up yet.
    if (restoring()) return;
    mainView.version();
    const key = selectedKey();
    const open = openObjectOf({ open: detailsOpen(), key, row: key ? mainView.rowByKey(key) : undefined, resource: resourceKey(), tab: detailsTab() });
    if (open === undefined) return;
    const text = JSON.stringify(open);
    if (text === last) return;
    last = text;
    save(OPEN_OBJECT_KEY, open);
  });
}
