import { createRoot } from "solid-js";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Tone } from "../lib/backend";
import type { UIRow } from "./view";

// The main table without an engine: rows come from this map.
const rows = vi.hoisted(() => new Map<string, unknown>());
vi.mock("./view", () => ({
  createViewFeed: () => ({
    version: () => 0,
    rowByKey: (k: string) => rows.get(k),
    rows: () => [...rows.values()],
    columns: () => [],
    statuses: {},
    resolved: {},
    loading: () => false,
  }),
  createNamesFeed: () => ({ version: () => 0, clusters: () => new Map(), statuses: {}, loading: () => false }),
}));

import { clearMarks, marked, setFilter, setMarked, setNamespaces, setSelectedKey } from "./nav";
import { setHiddenClusters, toggleClusterHidden } from "./table";
import { hiddenMarkCount, initViews, namespaceListingErrors, selectionTargets } from "./views";

const row = (cl: string, n: string, ns = "payments"): UIRow => ({ key: `${cl}/${n}`, cl, u: n, n, ns, rv: "1", t: 0, s: Tone.Ok, c: [] });
const apiZ1 = row("z1", "payments-api");
const apiZ2 = row("z2", "payments-api");
const worker = row("z1", "ledger-worker", "ledger");
const names = (list: UIRow[]) => list.map((r) => r.key);

beforeAll(() => createRoot(() => initViews()));

beforeEach(() => {
  rows.clear();
  for (const r of [apiZ1, apiZ2, worker]) rows.set(r.key, r);
  setFilter("");
  setHiddenClusters(new Set<string>());
  clearMarks();
  setSelectedKey(null);
});

describe("selectionTargets", () => {
  it("acts on visible marks only; filtered-out marks are counted as hidden", () => {
    setMarked(new Set([apiZ1.key, worker.key]));
    setFilter("payments");
    expect(names(selectionTargets())).toEqual([apiZ1.key]);
    expect(hiddenMarkCount()).toBe(1);
  });

  it("ignores marks in hidden clusters", () => {
    setMarked(new Set([apiZ1.key, apiZ2.key]));
    toggleClusterHidden("z2");
    expect(names(selectionTargets())).toEqual([apiZ1.key]);
    expect(hiddenMarkCount()).toBe(1);
  });

  it("never falls back to the selected row while marks exist", () => {
    setSelectedKey(worker.key);
    setMarked(new Set([apiZ2.key]));
    toggleClusterHidden("z2");
    expect(selectionTargets()).toEqual([]);
  });

  it("uses the selected row only while it is visible", () => {
    setSelectedKey(worker.key);
    expect(names(selectionTargets())).toEqual([worker.key]);
    setFilter("payments");
    expect(selectionTargets()).toEqual([]);
  });

  it("skips marks of deleted objects", () => {
    setMarked(new Set([apiZ1.key, "z1/gone"]));
    expect(names(selectionTargets())).toEqual([apiZ1.key]);
    expect(hiddenMarkCount()).toBe(0);
  });

  it("drops marks when the namespaces change", () => {
    setMarked(new Set([apiZ1.key]));
    setNamespaces(["ledger"]);
    expect(marked().size).toBe(0);
  });
});

describe("namespaceListingErrors", () => {
  it("tells RBAC refusals from failures that may pass, one per cluster", () => {
    const errs = namespaceListingErrors([
      { c: "z1", ns: null, state: "error", message: 'namespaces is forbidden: User "jane" cannot list resource "namespaces"', code: 403, reason: "Forbidden", terminal: true },
      { c: "z2", ns: null, state: "error", message: "Unauthorized", code: 401 },
      { c: "z3", ns: null, state: "error", message: 'cluster "z3": no answer within 60s' },
      { c: "z3", ns: null, state: "error", message: "second status of the same cluster" },
      { c: "z4", ns: null, state: "ready" },
      undefined,
    ]);
    expect(errs.map((e) => [e.cluster, e.forbidden, e.title])).toEqual([
      ["z1", true, "No access"],
      ["z2", false, "Not authorized — credentials expired?"],
      ["z3", false, "Error"],
    ]);
    expect(errs[2].message).toBe('cluster "z3": no answer within 60s');
  });
});
