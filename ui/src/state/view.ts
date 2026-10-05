import { HELM_RELEASES } from "../lib/helm";
import { type Accessor, batch, createMemo, createSignal, onCleanup, untrack } from "solid-js";
import { createStore, reconcile, type SetStoreFunction } from "solid-js/store";
import { backend, type Column, type FeedStatus, type ResourceInfo, type Row, type ViewBatch, type ViewMessage, type ViewSpec } from "../lib/backend";
import { breadcrumb } from "../lib/watchdog";

/** A row tagged with its cluster. `key` is unique across clusters. */
export interface UIRow extends Row {
  cl: string;
  key: string;
}

export type FeedState = FeedStatus & { c: string; ns: string | null };

export interface ViewFeed {
  columns: Accessor<Column[]>;
  /** All rows across clusters/namespaces (new array whenever data changes). */
  rows: Accessor<UIRow[]>;
  /** Per cluster×namespace feed state, plus cluster-level states under `${cluster}|`. */
  statuses: Record<string, FeedState>;
  /** Resource info as resolved by each cluster. */
  resolved: Record<string, ResourceInfo>;
  /**
   * Per cluster, why it shows no kind-specific columns (the engine could find no printer columns for the
   * resource there: no access to its CustomResourceDefinition and no server-side printing, a timeout…).
   */
  notices: Record<string, string>;
  /** Increments whenever rows changed (at most as often as the UI can afford, see `createRefresher`). */
  version: Accessor<number>;
  /**
   * Increments whenever the view itself changes (resource, clusters, namespaces): all rows go and come back
   * from new lists. A row missing in the same generation was deleted; across one, it may just not be listed.
   */
  generation: Accessor<number>;
  /** True until every requested cluster reported ready or error. */
  loading: Accessor<boolean>;
  rowByKey(key: string): UIRow | undefined;
}

export const feedKey = (cluster: string, ns: string | null | undefined) => `${cluster}|${ns ?? ""}`;
export const rowKey = (cluster: string, uid: string) => `${cluster}/${uid}`;

function specEquals(a: ViewSpec | null, b: ViewSpec | null) {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.resource === b.resource &&
    a.labelSelector === b.labelSelector &&
    a.fieldSelector === b.fieldSelector &&
    a.projection === b.projection &&
    a.clusters.join("\n") === b.clusters.join("\n") &&
    a.namespaces.join("\n") === b.namespaces.join("\n")
  );
}

const describe = (s: ViewSpec) => `${s.resource} × ${s.clusters.length === 1 ? s.clusters[0] : `${s.clusters.length} clusters`}${s.namespaces.length ? ` × [${s.namespaces.join(",")}]` : ""}`;

/** Refreshes slower than this leave a breadcrumb for freeze reports. */
const SLOW_REFRESH_MS = 80;
/** Upper bound on how long data may wait to be shown when refreshes are expensive. */
const MAX_REFRESH_WAIT_MS = 1000;
/** From this many rows on, a table refreshes at most every {@link BIG_TABLE_GAP_MS}. */
const BIG_TABLE_ROWS = 5_000;
/**
 * Every refresh of a table walks all its rows (sorting, filtering), so a big one under a stream of updates
 * would spend a core on refreshing up to 30 times a second. Four times a second still looks live, at a
 * fraction of the CPU (and battery).
 */
const BIG_TABLE_GAP_MS = 250;

/**
 * Turns "data changed" into version bumps. Everything derived from a feed (sorting, filtering, the
 * table DOM) recomputes once per bump, so bumps are coalesced and spaced by what the previous one
 * cost: an update flood can never keep the main thread busy — clicks, scrolling and pickers stay
 * responsive, and the table refreshes as often as the machine can afford (instantly when cheap; big
 * tables at most four times a second).
 */
function createRefresher(bump: () => void, label: () => string, size: () => number = () => 0) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cost = 0;
  let doneAt = 0;
  const run = () => {
    timer = undefined;
    const started = performance.now();
    bump();
    doneAt = performance.now();
    cost = doneAt - started;
    if (cost > SLOW_REFRESH_MS) breadcrumb(`slow refresh ${Math.round(cost)}ms: ${label()}`);
  };
  return {
    schedule() {
      if (timer !== undefined) return;
      const gap = Math.max(cost * 2, size() >= BIG_TABLE_ROWS ? BIG_TABLE_GAP_MS : 0);
      const wait = Math.min(MAX_REFRESH_WAIT_MS, gap) - (performance.now() - doneAt);
      timer = setTimeout(run, Math.max(0, wait));
    },
    /** Bumps right away (spec changes: the old data must disappear now). */
    now() {
      if (timer !== undefined) clearTimeout(timer);
      run();
    },
    cancel() {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    },
  };
}

function applyStatus(statuses: Record<string, FeedState>, setStatuses: SetStoreFunction<Record<string, FeedState>>, m: Extract<ViewMessage, { t: "status" }>) {
  const { t: _t, ...status } = m;
  setStatuses(feedKey(m.c, m.ns), status as FeedState);
  // A namespace feed's status supersedes the cluster-level placeholder: "connecting", or the error of an
  // earlier attempt (the cluster was unreachable, then connected — the engine resolves it again).
  const ck = feedKey(m.c, null);
  if (m.ns !== null && (statuses[ck]?.state === "connecting" || statuses[ck]?.state === "error")) setStatuses(ck, undefined!);
}

function createLoading(spec: Accessor<ViewSpec | null>, statuses: Record<string, FeedState>, version: Accessor<number>) {
  return createMemo(() => {
    version();
    const s = spec();
    if (!s) return false;
    return s.clusters.some((c) => {
      const states = Object.values(statuses).filter((st) => st && st.c === c);
      return states.length === 0 || states.some((st) => st.state === "connecting" || st.state === "loading");
    });
  });
}

/**
 * Subscribes to a multi-cluster view and keeps its rows. Rows live in plain Maps (no per-row
 * reactivity); a single version signal drives derived memos, so 10k-row tables stay cheap.
 * Must be called inside a reactive owner; re-subscribes whenever `spec()` changes.
 */
export function createViewFeed(spec: Accessor<ViewSpec | null>): ViewFeed {
  const stableSpec = createMemo(spec, null, { equals: specEquals });
  const [columns, setColumns] = createSignal<Column[]>([], { equals: false });
  const [version, setVersion] = createSignal(0);
  const [generation, setGeneration] = createSignal(0);
  const [statuses, setStatuses] = createStore<Record<string, FeedState>>({});
  const [resolved, setResolved] = createStore<Record<string, ResourceInfo>>({});
  const [notices, setNotices] = createStore<Record<string, string>>({});
  let feeds = new Map<string, Map<string, UIRow>>();
  let index = new Map<string, UIRow>();
  // Snapshots too big for one message come in chunks: they are kept aside here and replace the feed's rows
  // with their last chunk, so the table never shows half of one (and refreshes once for all of it).
  let staged = new Map<string, Map<string, UIRow>>();
  // Statuses, schema and resolution wait for the next refresh, so the UI never sees "ready"
  // before the rows that came with it (no flash of an empty table).
  let meta: ViewMessage[] = [];
  const refresh = createRefresher(
    () =>
      batch(() => {
        for (const m of meta) {
          // The engine sends the view's columns again when a cluster adds some (their union, only ever appended
          // to): rows keep their cells by position among them.
          if (m.t === "schema") setColumns(m.columns);
          else if (m.t === "resolved") {
            setResolved(m.c, m.resource);
            // A cluster resolved again (columns found after all, discovery refreshed) may drop its notice.
            setNotices(m.c, m.notice ?? undefined!);
          }
          else if (m.t === "status") applyStatus(statuses, setStatuses, m);
        }
        meta = [];
        setVersion((v) => v + 1);
      }),
    () => {
      const s = untrack(stableSpec);
      return s ? `${describe(s)} (${index.size} rows)` : "";
    },
    () => index.size,
  );
  onCleanup(() => refresh.cancel());

  const apply = (b: ViewBatch) => {
    let changed = false;
    for (const m of b.m) {
      if (m.t !== "rows") {
        meta.push(m);
        changed = true;
        continue;
      }
      const fk = feedKey(m.c, m.ns);
      // A snapshot in chunks: the first says `reset`, all but the last `more`, nothing else of this feed comes
      // in between. (A new snapshot replaces one still coming.)
      const stage = m.reset ? (m.more ? new Map<string, UIRow>() : undefined) : staged.get(fk);
      if (m.reset) staged.delete(fk);
      if (stage) {
        for (const r of (m.up ?? []) as UIRow[]) {
          r.cl = m.c;
          r.key = rowKey(m.c, r.u);
          stage.set(r.u, r);
        }
        if (m.more) {
          staged.set(fk, stage);
          continue;
        }
        staged.delete(fk);
      }
      let feed = feeds.get(fk);
      if (!feed) {
        feed = new Map();
        feeds.set(fk, feed);
      }
      if (m.reset || stage) {
        for (const r of feed.values()) index.delete(r.key);
        feed.clear();
      }
      if (stage) {
        feeds.set(fk, (feed = stage));
        for (const r of stage.values()) index.set(r.key, r);
      } else if (m.up)
        for (const r of m.up as UIRow[]) {
          r.cl = m.c;
          r.key = rowKey(m.c, r.u);
          feed.set(r.u, r);
          index.set(r.key, r);
        }
      if (m.del)
        for (const uid of m.del) {
          feed.delete(uid);
          index.delete(rowKey(m.c, uid));
        }
      if (stage && stage.size > 5000) breadcrumb(`received ${stage.size} rows from ${m.c}`);
      changed = true;
    }
    if (changed) refresh.schedule();
  };

  createMemo(() => {
    const s = stableSpec();
    untrack(() => {
      feeds = new Map();
      index = new Map();
      staged = new Map();
      meta = [];
      batch(() => {
        setColumns([]);
        setStatuses(reconcile({}));
        setResolved(reconcile({}));
        setNotices(reconcile({}));
        setGeneration((g) => g + 1);
        refresh.now();
      });
    });
    if (!s || !s.clusters.length) return;
    // Helm releases come from the engine's own reader of their records, as a table like any other.
    const sub = s.resource === HELM_RELEASES ? backend().subscribeHelm(s, apply) : backend().subscribeView(s, apply);
    onCleanup(() => sub.close());
  });

  const rows = createMemo(() => {
    version();
    const out: UIRow[] = [];
    for (const f of feeds.values()) for (const r of f.values()) out.push(r);
    return out;
  });

  return { columns, rows, statuses, resolved, notices, version, generation, loading: createLoading(stableSpec, statuses, version), rowByKey: (k) => index.get(k) };
}

export interface NamesFeed {
  /** Increments whenever the set of names of any cluster changed. */
  version: Accessor<number>;
  /** Names per cluster, with how many objects carry each name. Live maps: read after `version()`. */
  clusters(): ReadonlyMap<string, ReadonlyMap<string, number>>;
  /** Per cluster×namespace feed state, plus cluster-level states under `${cluster}|`. */
  statuses: Record<string, FeedState>;
  loading: Accessor<boolean>;
}

/**
 * Object names of a resource across clusters (`projection: "names"`): the engine only sends names
 * that appear or disappear, so a fleet with tens of thousands of namespaces costs the UI nothing
 * while they churn. Must be called inside a reactive owner.
 */
export function createNamesFeed(spec: Accessor<ViewSpec | null>): NamesFeed {
  const stableSpec = createMemo(
    () => {
      const s = spec();
      return s && { ...s, projection: "names" as const };
    },
    null,
    { equals: specEquals },
  );
  const [version, setVersion] = createSignal(0);
  const [statuses, setStatuses] = createStore<Record<string, FeedState>>({});
  let feeds = new Map<string, Map<string, number>>();
  let byCluster = new Map<string, Map<string, number>>();
  // Names of snapshots that come in chunks, until their last one (as rows, see `createViewFeed`).
  let staged = new Map<string, string[]>();
  let pendingStatuses: Extract<ViewMessage, { t: "status" }>[] = [];
  const refresh = createRefresher(
    () =>
      batch(() => {
        for (const m of pendingStatuses) applyStatus(statuses, setStatuses, m);
        pendingStatuses = [];
        setVersion((v) => v + 1);
      }),
    () => {
      const s = untrack(stableSpec);
      return s ? `${describe(s)} names` : "";
    },
  );
  onCleanup(() => refresh.cancel());

  const add = (m: Map<string, number>, name: string, delta: number) => {
    const n = (m.get(name) ?? 0) + delta;
    if (n > 0) m.set(name, n);
    else m.delete(name);
  };

  const apply = (b: ViewBatch) => {
    let changed = false;
    for (const m of b.m) {
      if (m.t === "status") {
        pendingStatuses.push(m);
        changed = true;
      }
      if (m.t !== "names") continue;
      const fk = feedKey(m.c, m.ns);
      const stage = m.reset ? (m.more ? [] : undefined) : staged.get(fk);
      if (m.reset) staged.delete(fk);
      if (stage) {
        for (const name of m.up ?? []) stage.push(name);
        if (m.more) {
          staged.set(fk, stage);
          continue;
        }
        staged.delete(fk);
      }
      let feed = feeds.get(fk);
      if (!feed) feeds.set(fk, (feed = new Map()));
      let cluster = byCluster.get(m.c);
      if (!cluster) byCluster.set(m.c, (cluster = new Map()));
      if (m.reset || stage) {
        for (const [name, n] of feed) add(cluster, name, -n);
        feed.clear();
      }
      if (m.del)
        for (const name of m.del) {
          if (!feed.has(name)) continue;
          add(feed, name, -1);
          add(cluster, name, -1);
        }
      for (const name of stage ?? m.up ?? []) {
        add(feed, name, 1);
        add(cluster, name, 1);
      }
      changed = true;
    }
    if (changed) refresh.schedule();
  };

  createMemo(() => {
    const s = stableSpec();
    untrack(() => {
      feeds = new Map();
      byCluster = new Map();
      staged = new Map();
      pendingStatuses = [];
      batch(() => {
        setStatuses(reconcile({}));
        refresh.now();
      });
    });
    if (!s || !s.clusters.length) return;
    const sub = backend().subscribeView(s, apply);
    onCleanup(() => sub.close());
  });

  return { version, clusters: () => byCluster, statuses, loading: createLoading(stableSpec, statuses, version) };
}
