import { batch, createSignal } from "solid-js";
import type { ObjectRef } from "../lib/backend";
import { isBoolean, isObject, oneOf, persisted } from "../lib/persist";
import { registerCommands } from "./commands";
import { marked, openDetails, setDetailsTab } from "./nav";
import type { UIRow } from "./view";

// What objects are compared with. An object's Compare tab compares it with the objects pinned (`+`, of any cluster,
// namespace or kind) and, for the first of rows marked when `=` was pressed, the others — or, with none of those, with
// the objects of the same name in the other clusters of the table.

export const COMPARE_TAB = "compare";

/** An object to compare with, wherever it is: found again by its name (one deleted and created anew is the same). */
export type CompareRef = Omit<ObjectRef, "uid">;

export const refId = (r: CompareRef) => `${r.cluster}|${r.resource}|${r.namespace ?? ""}|${r.name}`;
export const sameRef = (a: CompareRef, b: CompareRef) => refId(a) === refId(b);
export const rowRef = (row: UIRow, resource: string): CompareRef => ({ cluster: row.cl, resource, namespace: row.ns ?? null, name: row.n });

export const [pins, setPins] = createSignal<CompareRef[]>([]);

export const isPinned = (r: CompareRef) => pins().some((p) => sameRef(p, r));

/** Pins these, or unpins them if all of them are pinned already. */
export function togglePins(refs: CompareRef[]) {
  if (refs.length && refs.every(isPinned)) setPins((prev) => prev.filter((p) => !refs.some((r) => sameRef(p, r))));
  else setPins((prev) => [...prev, ...refs.filter((r) => !prev.some((p) => sameRef(p, r)))]);
}

export const clearPins = () => setPins([]);

/**
 * Rows marked when `=` was pressed: the first is compared with the others — only it, not every object like a pin, and
 * only while they stay marked.
 */
const [marking, setMarking] = createSignal<{ of: string; with: CompareRef[]; keys: string[] } | null>(null);

/** Compares the first of `rows` with the others: its Compare tab opens. */
export function compareRows(rows: UIRow[], resource: string) {
  if (!rows.length) return;
  batch(() => {
    setMarking({ of: refId(rowRef(rows[0], resource)), with: rows.slice(1).map((r) => rowRef(r, resource)), keys: rows.map((r) => r.key) });
    openDetails(rows[0].key, COMPARE_TAB);
    setDetailsTab(COMPARE_TAB);
  });
}

/** What `self` is compared with: the rows marked with it, then the pins (itself left out). */
export function comparedWith(self: CompareRef): { ref: CompareRef; marked: boolean }[] {
  const m = marking();
  const live = m && m.of === refId(self) && m.keys.every((k) => marked().has(k));
  const out = live ? m.with.map((ref) => ({ ref, marked: true })) : [];
  for (const ref of pins()) if (!out.some((o) => sameRef(o.ref, ref))) out.push({ ref, marked: false });
  return out.filter((o) => !sameRef(o.ref, self));
}

/** No longer compares with `r`: unpinned, and left out of the rows marked. */
export function unpin(r: CompareRef) {
  batch(() => {
    setPins((prev) => prev.filter((p) => !sameRef(p, r)));
    setMarking((m) => m && { ...m, with: m.with.filter((x) => !sameRef(x, r)) });
  });
}

/**
 * Objects of the same name in other clusters of the table ("twins"), and whether each cluster takes part: with
 * nothing pinned, all of them unless turned off; next to pins, none unless turned on.
 */
const [twinsOff, setTwinsOff] = createSignal<ReadonlySet<string>>(new Set());
const [twinsOn, setTwinsOn] = createSignal<ReadonlySet<string>>(new Set());

export const twinIncluded = (cluster: string, pinned: boolean) => (pinned ? twinsOn().has(cluster) : !twinsOff().has(cluster));

export function toggleTwin(cluster: string, pinned: boolean) {
  const flip = (s: ReadonlySet<string>) => {
    const next = new Set(s);
    if (!next.delete(cluster)) next.add(cluster);
    return next;
  };
  if (pinned) setTwinsOn(flip);
  else setTwinsOff(flip);
}

/** Clusters outside the table where objects are looked for by their name too (added in the Compare tab). */
export const [extraClusters, setExtraClusters] = createSignal<string[]>([]);
export const addExtraCluster = (cluster: string) => setExtraClusters((prev) => (prev.includes(cluster) ? prev : [...prev, cluster]));
export const removeExtraCluster = (cluster: string) => setExtraClusters((prev) => prev.filter((c) => c !== cluster));

export type CompareView = "changes" | "yaml";
export type CompareLayout = "auto" | "split" | "unified";

export interface CompareSettings {
  /** The fields that differ, or the YAML of two objects side by side. */
  view: CompareView;
  layout: CompareLayout;
  /** Compare `status` too. */
  status: boolean;
  /** Compare what differs between any two objects (uid, resourceVersion, addresses the cluster picked…). */
  noise: boolean;
}

const isView = oneOf<CompareView>("changes", "yaml");
const isLayout = oneOf<CompareLayout>("auto", "split", "unified");
const isSettings = (v: unknown): v is CompareSettings => isObject(v) && isView(v.view) && isLayout(v.layout) && isBoolean(v.status) && isBoolean(v.noise);

export const [compareSettings, setCompareSettings] = persisted<CompareSettings>("compare", { view: "changes", layout: "auto", status: false, noise: false }, isSettings);

export const setCompareSetting = <K extends keyof CompareSettings>(key: K, value: CompareSettings[K]) => setCompareSettings((s) => ({ ...s, [key]: value }));

/** The palette's way to unpin. */
export function registerCompareCommands(): () => void {
  return registerCommands(() => {
    const list = pins();
    const out = list.map((p) => ({
      id: `compare:unpin:${refId(p)}`,
      title: `Unpin ${p.name} (${p.cluster}) from compare`,
      section: "Compare",
      icon: "pin" as const,
      keywords: ["compare", "pin", "diff", p.cluster],
      run: () => unpin(p),
    }));
    if (list.length > 1) out.push({ id: "compare:unpin-all", title: "Unpin everything from compare", section: "Compare", icon: "pin", keywords: ["compare", "pin", "diff", "clear"], run: clearPins });
    return out;
  });
}
