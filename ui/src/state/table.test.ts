import { createRoot, createSignal } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Tone } from "../lib/backend";
import { registerColumnKind } from "../registry/columns";
import { setSelectedClustersRaw } from "./clusters";
import { setFilter } from "./nav";
import { cellText, createTableModel, hiddenClusters, isRowVisible, onlyClusterShown, previewColumnWidth, setColumnWidth, setHiddenClusters, soloCluster, sortRows, type TableColumn, toggleClusterHidden, toggleSort } from "./table";
import type { UIRow, ViewFeed } from "./view";

const row = (cl: string, n: string, ns = "payments"): UIRow => ({ key: `${cl}/${n}`, cl, u: n, n, ns, rv: "1", t: 0, s: Tone.Ok, c: [] });

afterEach(() => {
  setFilter("");
  setHiddenClusters(new Set<string>());
  setSelectedClustersRaw([]);
});

describe("isRowVisible", () => {
  it("follows the table filter", () => {
    const api = row("z1", "payments-api");
    const worker = row("z1", "ledger-worker", "ledger");
    setFilter("payments");
    expect(isRowVisible(api)).toBe(true);
    expect(isRowVisible(worker)).toBe(false);
    setFilter("!api");
    expect(isRowVisible(api)).toBe(false);
    expect(isRowVisible(worker)).toBe(true);
  });

  it("hides rows of hidden clusters", () => {
    const a = row("z1", "payments-api");
    const b = row("z2", "payments-api");
    toggleClusterHidden("z2");
    expect(hiddenClusters().has("z2")).toBe(true);
    expect(isRowVisible(a)).toBe(true);
    expect(isRowVisible(b)).toBe(false);
  });
});

describe("cellText", () => {
  const col = (c: Partial<TableColumn>): TableColumn => ({ id: "x", title: "X", kind: "text", width: 80, index: -1, ...c });
  const at = (seconds: number) => () => seconds;

  it("is what a cell shows, in full — a cluster's whole context name", () => {
    const r: UIRow = { ...row("prod-eu-z1", "payments-api-7d9f6c5b4-x2kqp"), t: 1_000, c: [["Running", Tone.Ok], [2, 2], "10.244.1.23"] };
    const now = at(1_000 + 3 * 86_400);
    expect(cellText(col({ special: "name" }), r, now)).toBe("payments-api-7d9f6c5b4-x2kqp");
    expect(cellText(col({ special: "namespace" }), r, now)).toBe("payments");
    expect(cellText(col({ special: "namespace" }), { ...r, ns: undefined }, now)).toBe("");
    expect(cellText(col({ special: "cluster" }), r, now)).toBe("prod-eu-z1");
    expect(cellText(col({ special: "age", kind: "age" }), r, now)).toBe("3d");
    expect(cellText(col({ special: "age", kind: "age" }), { ...r, t: 0 }, now)).toBe("");
    expect(cellText(col({ kind: "status", index: 0 }), r, now)).toBe("Running");
    expect(cellText(col({ kind: "ratio", index: 1 }), r, now)).toBe("2/2");
    expect(cellText(col({ kind: "text", index: 2 }), r, now)).toBe("10.244.1.23");
    // A cell the row doesn't have (a cluster that sent fewer columns): nothing.
    expect(cellText(col({ kind: "text", index: 9 }), r, now)).toBe("");
  });

  it("is what a computed column computes, as its kind shows it", () => {
    expect(cellText(col({ kind: "cpu", cell: () => 1_700 }), row("z1", "api"), at(0))).toBe("1.7");
    expect(cellText(col({ kind: "usageCpu", cell: () => [33, 500] }), row("z1", "api"), at(0))).toBe("33m");
  });

  it("reads the clock only for text that follows it, as the table does", () => {
    const clock = vi.fn(() => 5_000);
    const r: UIRow = { ...row("z1", "api"), t: 1_000, c: ["10.0.0.1", [1_000, null]] };
    for (const c of [col({ special: "name" }), col({ special: "namespace" }), col({ special: "cluster" }), col({ kind: "text", index: 0 })]) cellText(c, r, clock);
    expect(clock).not.toHaveBeenCalled();
    expect(cellText(col({ special: "age", kind: "age" }), r, clock)).toBe("66m");
    expect(cellText(col({ kind: "duration", index: 1 }), r, clock)).toBe("66m");
    expect(clock).toHaveBeenCalledTimes(2);
    // A kind that isn't live gets no time, in the table and here alike: what is shown is what is copied.
    registerColumnKind("test-clock", { text: (_, now) => String(now), sortKey: () => null });
    expect(cellText(col({ kind: "test-clock", index: 0 }), r, clock)).toBe("0");
  });
});

describe("soloCluster", () => {
  it("shows only one cluster's rows, again every cluster's", () => {
    setSelectedClustersRaw(["z1", "z2", "z3"]);
    soloCluster("z2");
    expect([...hiddenClusters()]).toEqual(["z1", "z3"]);
    expect(onlyClusterShown("z2")).toBe(true);
    expect([isRowVisible(row("z1", "payments-api")), isRowVisible(row("z2", "payments-api"))]).toEqual([false, true]);
    // A hidden one: now only it.
    soloCluster("z3");
    expect([...hiddenClusters()]).toEqual(["z1", "z2"]);
    soloCluster("z3");
    expect([...hiddenClusters()]).toEqual([]);
    expect(onlyClusterShown("z3")).toBe(false);
  });

  it("counts the selected clusters only", () => {
    // Hidden before it was deselected: no rows of it are shown either way, and it is let go.
    setSelectedClustersRaw(["z1", "z2"]);
    setHiddenClusters(new Set(["gone", "z1"]));
    expect(onlyClusterShown("z2")).toBe(true);
    soloCluster("z2");
    expect([...hiddenClusters()]).toEqual([]);
    setHiddenClusters(new Set(["gone"]));
    soloCluster("z1");
    expect([...hiddenClusters()]).toEqual(["z2"]);
  });
});

describe("sorting", () => {
  // Deterministic pseudo-random numbers.
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const pod = (i: number, rv = 1): UIRow => ({
    key: `z${i % 3}/uid-${i}`,
    cl: `prod-eu-z${i % 3}`,
    u: `uid-${i}`,
    n: `pod-${Math.floor(rnd() * 500)}`,
    ns: `ns-${i % 7}`,
    rv: String(rv),
    t: Math.floor(rnd() * 1000),
    s: Tone.Ok,
    c: [[["Running", "Pending", "Failed"][i % 3], Tone.Ok], Math.floor(rnd() * 5)],
  });
  const status = { id: "status", index: 0, kind: "status", desc: false };

  it("keeps the order up to date incrementally, exactly as a full sort would", () => {
    let rows = Array.from({ length: 3000 }, (_, i) => pod(i));
    for (const by of [status, { ...status, desc: true }, { id: "restarts", index: 1, kind: "number", desc: false }, { id: "name", index: -1, kind: "text", special: "name" as const, desc: true }]) {
      let sorted = sortRows(rows, by);
      for (let round = 0; round < 20; round++) {
        // Updates (new row objects), deletes and additions, as batches bring them.
        rows = rows.filter(() => rnd() > 0.01).map((r) => (rnd() < 0.02 ? { ...pod(Number(r.u.slice(4)), Number(r.rv) + 1), key: r.key, u: r.u, cl: r.cl } : r));
        for (let k = 0; k < 10; k++) rows.push(pod(3000 + round * 10 + k));
        sorted = sortRows(rows, by, sorted);
        expect(sorted.rows.map((r) => r.key)).toEqual(sortRows(rows, by).rows.map((r) => r.key));
      }
      // Nothing changed: the very same order.
      expect(sortRows([...rows], by, sorted)).toBe(sorted);
    }
  });

  it("keeps only the step it came from, not every order before it", () => {
    const rows = Array.from({ length: 100 }, (_, i) => pod(i));
    let sorted = sortRows(rows, status);
    for (let round = 0; round < 5; round++) {
      const i = round * 7;
      rows[i] = { ...rows[i], rv: String(Number(rows[i].rv) + 1) };
      sorted = sortRows([...rows], status, sorted);
    }
    // Updates under churn come many times a second: a chain of old orders would keep all their rows alive.
    expect(sorted.delta?.prev).toBeDefined();
    expect(sorted.delta?.prev.delta).toBeUndefined();
  });

  it("keeps the rows shown up to date incrementally while a filter is on", () => {
    const [rows, setRows] = createSignal(Array.from({ length: 2000 }, (_, i) => pod(i)));
    const feed = { columns: () => [{ id: "status", title: "Status", kind: "status" as const }], rows, statuses: {}, resolved: {}, notices: {}, version: () => 0, loading: () => false, rowByKey: () => undefined } as unknown as ViewFeed;
    createRoot((dispose) => {
      toggleSort("status");
      const model = createTableModel(feed);
      setFilter("pod-1");
      toggleClusterHidden("prod-eu-z2");
      const expected = () => sortRows(rows(), { id: "status", index: 0, kind: "status", desc: false }).rows.filter((r) => r.cl !== "prod-eu-z2" && r.n.includes("pod-1"));
      for (let round = 0; round < 30; round++) {
        setRows(rows().filter(() => rnd() > 0.01).map((r) => (rnd() < 0.02 ? { ...pod(Number(r.u.slice(4)), Number(r.rv) + 1), key: r.key, u: r.u, cl: r.cl } : r)).concat([pod(5000 + round)]));
        expect(model.sorted().map((r) => r.key)).toEqual(expected().map((r) => r.key));
      }
      dispose();
    });
  });

  it("computes each row's sort key once, and none while the filter changes or a column is resized", () => {
    let calls = 0;
    registerColumnKind("counted", { text: String, sortKey: (c) => (calls++, typeof c === "number" ? c : null) });
    const [rows, setRows] = createSignal(Array.from({ length: 1000 }, (_, i) => ({ ...pod(i), c: [i % 10] }) as UIRow));
    const feed = { columns: () => [{ id: "n", title: "N", kind: "counted" as const }], rows, statuses: {}, resolved: {}, notices: {}, version: () => 0, loading: () => false, rowByKey: () => undefined } as unknown as ViewFeed;
    createRoot((dispose) => {
      toggleSort("n");
      const model = createTableModel(feed);
      expect(model.sorted().length).toBe(1000);
      expect(calls).toBe(1000);
      // A batch updated 5 rows: only theirs are computed.
      setRows(rows().map((r, i) => (i < 5 ? { ...r, rv: "2" } : r)));
      expect(model.sorted().length).toBe(1000);
      expect(calls).toBe(1005);
      const before = model.sorted();
      previewColumnWidth("n", 333);
      expect(model.columns().find((c) => c.id === "n")?.width).toBe(333);
      expect(model.sorted()).toBe(before);
      setFilter("pod-1");
      expect(model.sorted().length).toBeLessThan(1000);
      expect(calls).toBe(1005);
      setColumnWidth("n", 333);
      dispose();
    });
  });
});

describe("the filter of a big table", () => {
  it("applies once typing pauses, to the table and to what actions act on alike", () => {
    vi.useFakeTimers();
    const rows = Array.from({ length: 12_000 }, (_, i) => row("z1", `pod-${i}`));
    const feed = { columns: () => [], rows: () => rows, statuses: {}, resolved: {}, notices: {}, version: () => 0, loading: () => false, rowByKey: () => undefined } as unknown as ViewFeed;
    createRoot((dispose) => {
      const model = createTableModel(feed);
      setFilter("pod-1");
      setFilter("pod-11");
      expect([model.sorted().length, isRowVisible(rows[5])]).toEqual([12_000, true]);
      vi.advanceTimersByTime(100);
      expect(model.sorted().every((r) => r.n.startsWith("pod-11"))).toBe(true);
      expect(isRowVisible(rows[5])).toBe(false);
      // Clearing it is not put off.
      setFilter("");
      expect(model.sorted().length).toBe(12_000);
      dispose();
    });
    vi.useRealTimers();
  });
});

describe("computed columns", () => {
  it("sort by what they compute, afresh when it changes though the rows did not", () => {
    const usage = new Map<string, number>([
      ["web-1", 120],
      ["web-2", 900],
      ["web-3", 40],
    ]);
    const rows = ["web-1", "web-2", "web-3"].map((n) => row("z1", n));
    const cell = (r: UIRow) => usage.get(r.n) ?? null;
    const by = { id: "cpuUsed", index: -1, kind: "cpu", desc: true, cell };
    const first = sortRows(rows, by);
    expect(first.rows.map((r) => r.n)).toEqual(["web-2", "web-1", "web-3"]);
    // The next poll: same rows, other numbers — no cached keys, the order follows.
    usage.set("web-3", 2000);
    expect(sortRows(rows, by, first).rows.map((r) => r.n)).toEqual(["web-3", "web-2", "web-1"]);
    // No number (not running, no metrics): last, whichever way.
    usage.delete("web-2");
    expect(sortRows(rows, { ...by, desc: false }).rows.map((r) => r.n)).toEqual(["web-1", "web-3", "web-2"]);
  });
});

describe("usage column kinds", async () => {
  const { columnKind } = await import("../registry/columns");
  it("show usage against its bound: a warning from 70%, an error from 90%", () => {
    const mem = columnKind("usageMem");
    expect(mem.text([512 * 1024 * 1024, 1024 * 1024 * 1024], 0)).toBe("512Mi");
    expect(mem.tone?.([512, 1024], 0)).toBeUndefined();
    expect(mem.tone?.([720, 1000], 0)).toBe(Tone.Warn);
    expect(mem.tone?.([950, 1000], 0)).toBe(Tone.Error);
    // Without a limit there is nothing to be close to.
    expect(mem.tone?.([950, null], 0)).toBeUndefined();
    expect(columnKind("usageCpu").title?.([250, 1000])).toBe("250m used of 1 limit (25%)");
    expect(columnKind("nodeCpu").title?.([2500, null])).toBe("2.5 used (no allocatable)");
  });

  it("flag percentages: near a limit, far below a request", () => {
    expect(columnKind("percentLimit").text(91.4, 0)).toBe("91%");
    expect(columnKind("percentLimit").tone?.(91.4, 0)).toBe(Tone.Error);
    expect(columnKind("percentRequest").tone?.(4, 0)).toBe(Tone.Muted);
    expect(columnKind("percentRequest").tone?.(140, 0)).toBeUndefined();
  });
});
