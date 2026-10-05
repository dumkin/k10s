import { type Accessor, createComputed, createMemo, createRoot, createSignal, onCleanup, untrack } from "solid-js";
import type { Cell, Column } from "../lib/backend";
import { isBoolean, isNumber, isObject, isString, persisted, recordOf } from "../lib/persist";
import { globalMemo } from "../lib/reactive";
import { columnKind, extraColumns } from "../registry/columns";
import { isMultiCluster } from "./clusters";
import { currentResource, filter, namespaces, resourceKey } from "./nav";
import type { UIRow, ViewFeed } from "./view";

export type Special = "cluster" | "name" | "namespace" | "age";

export interface TableColumn {
  id: string;
  title: string;
  kind: string;
  width: number;
  /** Index into `row.c`, or -1 for built-in columns. */
  index: number;
  special?: Special;
  align?: "right";
  description?: string;
  flex?: boolean;
  /** A computed column's cell (see `ExtraColumn`): it reads other state (usage), not the row's cells. */
  cell?: (row: UIRow) => Cell;
}

export interface SortState {
  col: string;
  desc: boolean;
}

const DEFAULT_WIDTH: Record<string, number> = { number: 80, bool: 80, ratio: 70, age: 80, duration: 90, bytes: 90, cpu: 70, status: 130, restarts: 100, text: 160, labels: 260 };
const DEFAULT_SORT: Record<string, SortState> = {
  events: { col: "lastSeen", desc: false },
  "events.events.k8s.io": { col: "lastSeen", desc: false },
};

const isSortState = (v: unknown): v is SortState => isObject(v) && isString(v.col) && isBoolean(v.desc);

// Per resource key: column id → width / shown.
const [widths, setWidths] = persisted<Record<string, Record<string, number>>>("colWidths", {}, recordOf(recordOf(isNumber)));
const [visibility, setVisibility] = persisted<Record<string, Record<string, boolean>>>("colVisibility", {}, recordOf(recordOf(isBoolean)));
const [sorts, setSorts] = persisted<Record<string, SortState>>("sorts", {}, recordOf(isSortState));
/** Clusters temporarily hidden from the table (toggled from the cluster strip). */
export const [hiddenClusters, setHiddenClusters] = createSignal<ReadonlySet<string>>(new Set());
/** A column being resized: its width shows as it changes, and is saved once (see `setColumnWidth`). */
const [resizing, setResizing] = createSignal<{ col: string; width: number } | null>(null);

/** Shows `col` at `width` while it is being resized, without saving it. */
export function previewColumnWidth(col: string, width: number) {
  setResizing({ col, width: Math.round(width) });
}

export function setColumnWidth(col: string, width: number) {
  const key = resourceKey();
  setResizing(null);
  setWidths({ ...widths(), [key]: { ...widths()[key], [col]: Math.round(width) } });
}

export function setColumnVisible(col: string, visible: boolean) {
  const key = resourceKey();
  setVisibility({ ...visibility(), [key]: { ...visibility()[key], [col]: visible } });
}

export function isColumnVisible(col: Column): boolean {
  return visibility()[resourceKey()]?.[col.id] ?? !col.hidden;
}

export const sort: Accessor<SortState> = () => sorts()[resourceKey()] ?? DEFAULT_SORT[resourceKey()] ?? { col: "name", desc: false };

export function toggleSort(col: string) {
  const cur = sort();
  setSorts({ ...sorts(), [resourceKey()]: cur.col === col ? { col, desc: !cur.desc } : { col, desc: false } });
}

export function toggleClusterHidden(cluster: string) {
  const next = new Set(hiddenClusters());
  if (next.has(cluster)) next.delete(cluster);
  else next.add(cluster);
  setHiddenClusters(next);
}

/** Natural-order sort key: lower-cased, digit runs zero-padded ("pod-9" < "pod-10"). */
function natKey(s: string): string {
  return s.toLowerCase().replace(/\d+/g, (d) => d.padStart(12, "0"));
}

// Rows are immutable and replaced on update, so per-object caches stay valid and unchanged rows
// never recompute their sort keys between batches.
const nameKeys = new WeakMap<UIRow, string>();
function nameKey(r: UIRow): string {
  let k = nameKeys.get(r);
  if (k === undefined) nameKeys.set(r, (k = natKey(r.n)));
  return k;
}

const hayCache = new WeakMap<UIRow, string>();
function haystack(r: UIRow): string {
  let h = hayCache.get(r);
  if (h === undefined) {
    const parts = [r.n, r.ns ?? "", r.cl, r.l ?? ""];
    for (const c of r.c) {
      if (typeof c === "string") parts.push(c);
      else if (Array.isArray(c) && typeof c[0] === "string") parts.push(c[0]);
    }
    h = parts.join(" ").toLowerCase();
    hayCache.set(r, h);
  }
  return h;
}

/** Tables at least this big filter once typing pauses for `FILTER_DEBOUNCE_MS` (each keystroke scans every row). */
const FILTER_DEBOUNCE_ROWS = 10_000;
const FILTER_DEBOUNCE_MS = 100;
const [bigTable, setBigTable] = createSignal(false);

/**
 * The filter in effect: `filter()` itself, or for a big table what it was when typing paused. The table and
 * `isRowVisible` (what actions act on) both use it, so actions always target what is on screen.
 */
const shownFilter = createRoot(() => {
  const [shown, setShown] = createSignal(filter());
  let timer: ReturnType<typeof setTimeout> | undefined;
  createComputed(() => {
    const q = filter();
    clearTimeout(timer);
    // Clearing the filter is never put off.
    if (!q || !untrack(bigTable)) setShown(q);
    else timer = setTimeout(() => setShown(q), FILTER_DEBOUNCE_MS);
  });
  return shown;
});

const rowFilter = globalMemo(() => compileFilter(shownFilter()));

/**
 * Whether a row is shown in the main table: it passes the filter and its cluster isn't hidden.
 * Actions only ever target visible rows — marks on filtered-out rows stay, but are not acted on.
 */
export function isRowVisible(r: UIRow): boolean {
  if (hiddenClusters().has(r.cl)) return false;
  const f = rowFilter();
  return !f || f(r);
}

/** Labels of a row (`r.l` is "k=v k2=v2": label keys and values never contain spaces or "="). */
const labelCache = new WeakMap<UIRow, Map<string, string>>();
function labelsOf(r: UIRow): Map<string, string> {
  let m = labelCache.get(r);
  if (m === undefined) {
    m = new Map();
    for (const kv of (r.l ?? "").split(" ")) {
      const eq = kv.indexOf("=");
      if (eq > 0) m.set(kv.slice(0, eq), kv.slice(eq + 1));
    }
    labelCache.set(r, m);
  }
  return m;
}

/** `key=value`, `key==value`, `key!=value` with label-shaped key and value: a label selector term. */
const LABEL_TERM = /^([A-Za-z0-9][-A-Za-z0-9_./]*)(!=|==|=)([-A-Za-z0-9_.]*)$/;

/**
 * A label selector: one `key=value` term, or several joined by commas as `kubectl -l` takes them
 * (`app=web,tier=frontend`: all must hold). Null if any part is not a label term. Empty parts are
 * skipped, so `app=web,` keeps matching while the next one is typed.
 */
function labelSelector(t: string): ((r: UIRow) => boolean) | null {
  const tests: ((r: UIRow) => boolean)[] = [];
  for (const part of t.split(",")) {
    if (!part) continue;
    const m = LABEL_TERM.exec(part);
    if (!m) return null;
    const [, key, op, value] = m;
    tests.push(op === "!=" ? (r) => labelsOf(r).get(key) !== value : (r) => labelsOf(r).get(key) === value);
  }
  if (tests.length <= 1) return tests[0] ?? null;
  return (r) => tests.every((x) => x(r));
}

export const FILTER_HELP = [
  "foo bar — rows containing both (name, namespace, cluster, labels, columns)",
  "!foo — rows without foo",
  "app=web — label app is exactly web (like kubectl -l)",
  "app!=web — label app is missing or not web",
  "app=web,tier=fe — both labels, kubectl -l syntax",
  '"a=b" — plain text search for a=b',
].join("\n");

/**
 * The table filter, terms separated by spaces, all must match:
 * - `foo` matches name, namespace, cluster, labels and text cells (substring, case-insensitive);
 * - `key=value` / `key!=value` match labels exactly, like `kubectl -l` (`app=web` is not `app=web-canary`),
 *   and so do comma-joined selectors (`app=web,tier=frontend`);
 * - `!term` negates any term (`!a=b,c=d`: not both); `"a=b"` is a plain substring search.
 */
export function compileFilter(q: string): ((r: UIRow) => boolean) | null {
  const tests: ((r: UIRow) => boolean)[] = [];
  for (const raw of q.trim().split(/\s+/)) {
    // A lone "!" is a term being typed: it filters nothing yet.
    if (!raw || raw === "!") continue;
    const neg = raw.startsWith("!");
    let t = neg ? raw.slice(1) : raw;
    let test: (r: UIRow) => boolean;
    const label = labelSelector(t);
    if (label) {
      test = label;
    } else {
      if (t.length > 2 && t.startsWith('"') && t.endsWith('"')) t = t.slice(1, -1);
      const needle = t.toLowerCase();
      test = (r) => haystack(r).includes(needle);
    }
    tests.push(neg ? (r) => !test(r) : test);
  }
  if (!tests.length) return null;
  return (r) => {
    for (const t of tests) if (!t(r)) return false;
    return true;
  };
}

type SortKey = number | string | null;

/** What the table is sorted by: a column's identity and kind — never its width (a resize sorts nothing). */
interface SortBy {
  id: string;
  /** Index into `row.c` (-1: a built-in column, or a column the table does not have: by name then). */
  index: number;
  kind: string;
  special?: Special;
  desc: boolean;
  /** A computed column's cell. */
  cell?: (row: UIRow) => Cell;
}

const sameSort = (a: SortBy, b: SortBy) => a.id === b.id && a.index === b.index && a.kind === b.kind && a.special === b.special && a.desc === b.desc && a.cell === b.cell;

/** Live kinds whose sort key does not change with time (others, like durations of running things, do). */
const STABLE_LIVE_KINDS = new Set(["age", "restarts"]);

// Sort keys per column and row: rows are immutable (an update is a new row), so a key is computed once per
// row, not once per sort.
const keyCaches = new Map<string, WeakMap<UIRow, SortKey>>();
function cached(sig: string, key: (r: UIRow) => SortKey): (r: UIRow) => SortKey {
  let cache = keyCaches.get(sig);
  if (!cache) {
    if (keyCaches.size > 200) keyCaches.clear();
    keyCaches.set(sig, (cache = new WeakMap()));
  }
  const c = cache;
  return (r) => {
    let k = c.get(r);
    if (k === undefined) c.set(r, (k = key(r)));
    return k;
  };
}

/** The sort key of rows for `by` (null: by name only), and whether it stays the same as time passes. */
function sortKeyOf(by: SortBy): { key: ((r: UIRow) => SortKey) | null; stable: boolean } {
  switch (by.special) {
    case "name":
      return { key: null, stable: true };
    case "cluster":
      return { key: (r) => r.cl, stable: true };
    case "namespace":
      return { key: cached("\0namespace", (r) => natKey(r.ns ?? "")), stable: true };
    case "age":
      return { key: (r) => -r.t, stable: true };
  }
  if (by.cell) {
    // Its values change without the rows changing (usage): no cached keys, a fresh sort whenever they do — what it
    // reads is a dependency of the sort.
    const cell = by.cell;
    const def = columnKind(by.kind);
    return {
      key: (r) => {
        const k = def.sortKey(cell(r));
        return typeof k === "string" ? natKey(k) : k;
      },
      stable: false,
    };
  }
  if (by.index < 0) return { key: null, stable: true };
  const def = columnKind(by.kind);
  const key = (r: UIRow): SortKey => {
    const k = def.sortKey(r.c[by.index] ?? null);
    return typeof k === "string" ? natKey(k) : k;
  };
  if (def.live && !STABLE_LIVE_KINDS.has(by.kind)) return { key, stable: false };
  return { key: cached(`${by.id}\0${by.index}\0${by.kind}`, key), stable: true };
}

/**
 * Orders rows by key, then name, cluster, namespace and row key — a total order, so sorting all rows and
 * inserting a few into sorted ones agree.
 */
function ordering(desc: boolean, byName: boolean) {
  const dir = desc ? -1 : 1;
  const nameDir = byName ? dir : 1;
  return (ka: SortKey, na: string, a: UIRow, kb: SortKey, nb: string, b: UIRow): number => {
    if (ka !== kb) {
      if (ka === null) return 1;
      if (kb === null) return -1;
      return (ka < kb ? -1 : 1) * dir;
    }
    if (na !== nb) return (na < nb ? -1 : 1) * nameDir;
    if (a.cl !== b.cl) return a.cl < b.cl ? -1 : 1;
    const sa = a.ns ?? "";
    const sb = b.ns ?? "";
    if (sa !== sb) return sa < sb ? -1 : 1;
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  };
}

/** All rows in order, and what that order was computed for (to update it incrementally). */
export interface Sorted {
  by: SortBy;
  rows: UIRow[];
  set: Set<UIRow>;
  /** The order of rows. */
  cmp: (a: UIRow, b: UIRow) => number;
  /** How this order came from `prev` (unless it was sorted afresh): rows `added` (in order), rows `removed`. */
  delta?: { prev: Sorted; added: UIRow[]; removed: UIRow[] };
}

/** Inserts `added` (in order) into `sorted`: a binary search each, one pass of copying. */
function insertSorted(sorted: UIRow[], added: UIRow[], cmp: (a: UIRow, b: UIRow) => number): UIRow[] {
  const out: UIRow[] = [];
  let i = 0;
  for (const a of added) {
    let lo = i;
    let hi = sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (cmp(sorted[mid], a) <= 0) lo = mid + 1;
      else hi = mid;
    }
    while (i < lo) out.push(sorted[i++]);
    out.push(a);
  }
  while (i < sorted.length) out.push(sorted[i++]);
  return out;
}

/**
 * Sorts all rows of `rows` for `by`. When only a few rows changed since `prev` (the usual update), the
 * previous order is kept and they are taken out and put in place; else, a full sort with cached keys.
 */
export function sortRows(rows: UIRow[], by: SortBy, prev?: Sorted): Sorted {
  const { key, stable } = sortKeyOf(by);
  const cmpParts = ordering(by.desc, !by.special && by.index < 0 ? true : by.special === "name");
  const cmp = prev && sameSort(prev.by, by) ? prev.cmp : (a: UIRow, b: UIRow) => cmpParts(key ? key(a) : null, nameKey(a), a, key ? key(b) : null, nameKey(b), b);
  if (prev && stable && sameSort(prev.by, by)) {
    const added: UIRow[] = [];
    for (const r of rows) if (!prev.set.has(r)) added.push(r);
    const gone = prev.rows.length - (rows.length - added.length);
    if (!added.length && !gone) return prev;
    if (added.length <= Math.max(256, rows.length >> 3)) {
      const set = new Set(rows);
      const removed: UIRow[] = [];
      const kept = gone ? prev.rows.filter((r) => set.has(r) || (removed.push(r), false)) : prev.rows;
      added.sort(cmp);
      // Only one step back is ever looked at (`visible` below). Without this, every order would keep the one
      // before it, and with it all its rows: a table under a stream of updates grew by megabytes a second.
      prev.delta = undefined;
      return { by, rows: added.length ? insertSorted(kept, added, cmp) : kept, set, cmp, delta: { prev, added, removed } };
    }
  }
  const decorated = rows.map((r) => ({ k: key ? key(r) : null, n: nameKey(r), r }));
  decorated.sort((a, b) => cmpParts(a.k, a.n, a.r, b.k, b.n, b.r));
  return { by, rows: decorated.map((d) => d.r), set: new Set(rows), cmp };
}

/** Rows shown (filtered, in order), and what they were computed from. */
interface Visible {
  rows: UIRow[];
  from: Sorted;
  f: ((r: UIRow) => boolean) | null;
  hidden: ReadonlySet<string>;
}

const sameColumn = (a: TableColumn, b: TableColumn) =>
  a.id === b.id &&
  a.title === b.title &&
  a.kind === b.kind &&
  a.width === b.width &&
  a.index === b.index &&
  a.special === b.special &&
  a.align === b.align &&
  a.description === b.description &&
  a.flex === b.flex &&
  a.cell === b.cell;

export function createTableModel(feed: ViewFeed) {
  /** Built-in columns the table shows besides the cluster's. */
  const specials = createMemo(() => {
    const res = currentResource();
    return {
      cluster: isMultiCluster(),
      namespace: res?.namespaced !== false && namespaces().length !== 1,
      age: !feed.columns().some((c) => c.kind === "age" && c.id === "lastSeen"),
    };
  });

  /** Computed columns of this resource, with the row's own cells they read found by column id. */
  const extras = createMemo(() => {
    const at = new Map(feed.columns().map((c, i) => [c.id, i]));
    const own = (r: UIRow, id: string): Cell => {
      const i = at.get(id);
      return i === undefined ? null : (r.c[i] ?? null);
    };
    return extraColumns(resourceKey())
      .filter((x) => x.when?.() ?? true)
      .map((x) => ({ def: x, compute: (r: UIRow) => x.cell(r, own) }));
  });

  const columns = createMemo<TableColumn[]>((prev) => {
    const key = resourceKey();
    const w = { ...widths()[key] };
    const live = resizing();
    if (live) w[live.col] = live.width;
    const sp = specials();
    const out: TableColumn[] = [];
    if (sp.cluster) out.push({ id: "cluster", title: "Cluster", kind: "text", width: w.cluster ?? 110, index: -1, special: "cluster" });
    out.push({ id: "name", title: "Name", kind: "text", width: w.name ?? 280, index: -1, special: "name", flex: true });
    if (sp.namespace) out.push({ id: "namespace", title: "Namespace", kind: "text", width: w.namespace ?? 150, index: -1, special: "namespace" });
    feed.columns().forEach((c, index) => {
      if (!isColumnVisible(c)) return;
      out.push({
        id: c.id,
        title: c.title,
        kind: c.kind,
        index,
        width: w[c.id] ?? (c.width || DEFAULT_WIDTH[c.kind] || 120),
        align: columnKind(c.kind).align,
        description: c.description,
      });
    });
    for (const { def, compute } of extras()) {
      if (!isColumnVisible(def as Column)) continue;
      out.push({ id: def.id, title: def.title, kind: def.kind, index: -1, width: w[def.id] ?? (def.width || DEFAULT_WIDTH[def.kind] || 80), align: columnKind(def.kind).align, description: def.description, cell: compute });
    }
    if (sp.age) out.push({ id: "age", title: "Age", kind: "age", width: w.age ?? 72, index: -1, special: "age", align: "right" });
    // Unchanged columns keep their objects: the table re-creates cells only of a column that changed (the one
    // being resized), and nothing at all when none did.
    const before = new Map(prev.map((c) => [c.id, c]));
    const shared = out.map((c) => {
      const p = before.get(c.id);
      return p && sameColumn(p, c) ? p : c;
    });
    return shared.length === prev.length && shared.every((c, i) => c === prev[i]) ? prev : shared;
  }, []);

  const sortBy = createMemo<SortBy>(
    () => {
      const { col, desc } = sort();
      const sp = specials();
      // As shown: cluster, name and namespace first, then the resource's columns (hidden ones too), then age.
      if (col === "name" || (col === "cluster" && sp.cluster) || (col === "namespace" && sp.namespace)) return { id: col, index: -1, kind: "text", special: col, desc };
      const index = feed.columns().findIndex((x) => x.id === col);
      if (index >= 0) return { id: col, index, kind: feed.columns()[index].kind, desc };
      if (col === "age" && sp.age) return { id: col, index: -1, kind: "age", special: "age", desc };
      const extra = extras().find((x) => x.def.id === col);
      if (extra) return { id: col, index: -1, kind: extra.def.kind, desc, cell: extra.compute };
      return { id: col, index: -1, kind: "", desc };
    },
    { id: "", index: -1, kind: "", desc: false },
    { equals: sameSort },
  );

  // Filtering this view waits for typing to pause when it is big (see `shownFilter`).
  createComputed(() => setBigTable(feed.rows().length >= FILTER_DEBOUNCE_ROWS));
  onCleanup(() => setBigTable(false));

  /** Every row, in order. Filtering takes rows out of it: no sort when the filter changes. */
  const ordered = createMemo<Sorted | undefined>((prev) => sortRows(feed.rows(), sortBy(), prev));

  /** The rows shown, in order: as rows change, only the changed ones are filtered and put in place. */
  const visible = createMemo<Visible | undefined>((prev) => {
    const o = ordered()!;
    const f = rowFilter();
    const hidden = hiddenClusters();
    if (!f && !hidden.size) return { rows: o.rows, from: o, f, hidden };
    const shows = (r: UIRow) => !hidden.has(r.cl) && (!f || f(r));
    if (prev && prev.f === f && prev.hidden === hidden && o.delta?.prev === prev.from) {
      const gone = new Set(o.delta.removed);
      const kept = gone.size ? prev.rows.filter((r) => !gone.has(r)) : prev.rows;
      const added = o.delta.added.filter(shows);
      const rows = added.length ? insertSorted(kept, added, o.cmp) : kept.length === prev.rows.length ? prev.rows : kept;
      return { rows, from: o, f, hidden };
    }
    return { rows: o.rows.filter(shows), from: o, f, hidden };
  });
  const sorted = createMemo(() => visible()!.rows);

  /** Position of a row in the sorted list (linear scan: only needed on navigation, not per batch). */
  const indexOf = (key: string): number | undefined => {
    const i = sorted().findIndex((r) => r.key === key);
    return i < 0 ? undefined : i;
  };

  return { columns, filtered: sorted, sorted, indexOf };
}

export type TableModel = ReturnType<typeof createTableModel>;
