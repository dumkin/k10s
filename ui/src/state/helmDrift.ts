import type { Accessor } from "solid-js";
import { type Cell, Tone } from "../lib/backend";
import { HELM_RELEASES } from "../lib/helm";
import { globalMemo } from "../lib/reactive";
import { registerExtraColumns } from "../registry/columns";
import { isMultiCluster, selectedClusters, shortName } from "./clusters";
import { resourceKey } from "./nav";
import type { UIRow } from "./view";
import { mainView } from "./views";

// Helm releases across clusters: a release installed in every zone of a cluster family should run the same chart
// everywhere. Where it does not — a zone left behind by an upgrade, a release missing in one — the table says so.

const CHART = 2;
const APP = 3;

/** The chart's version: what follows its name (`kube-prometheus-stack-65.1.0` → `65.1.0`). */
const version = (chart: string) => chart.slice(chart.lastIndexOf("-") + 1);

type ByRelease = Map<string, Map<string, [string, string]>>;

/**
 * Per release (`namespace/name`): its chart and app version in each cluster that has it. Made on first use — by
 * the table, after the views exist (a memo made as this module loads could run before them).
 */
let byReleaseMemo: Accessor<ByRelease> | undefined;
function byRelease(): ByRelease {
  byReleaseMemo ??= globalMemo(() => {
    const out: ByRelease = new Map();
    if (resourceKey() !== HELM_RELEASES || !isMultiCluster()) return out;
    for (const r of mainView.rows()) {
      const k = `${r.ns}/${r.n}`;
      let m = out.get(k);
      if (!m) out.set(k, (m = new Map()));
      m.set(r.cl, [String(r.c[CHART] ?? ""), String(r.c[APP] ?? "")]);
    }
    return out;
  });
  return byReleaseMemo();
}

/** How a release differs across the selected clusters: chart versions apart, or clusters without it; null when alike. */
export function drift(r: UIRow): Cell {
  const m = byRelease().get(`${r.ns}/${r.n}`);
  if (!m) return null;
  const charts = new Set([...m.values()].map(([c]) => c));
  if (charts.size > 1) {
    // The other versions, each with the clusters that run it: "4.11.3 in z1, z3, z4".
    const own = m.get(r.cl)?.[0] ?? "";
    const where = new Map<string, string[]>();
    for (const c of selectedClusters()) {
      const chart = m.get(c)?.[0];
      if (chart !== undefined && chart !== own) where.set(chart, [...(where.get(chart) ?? []), shortName(c)]);
    }
    return [`differs · ${[...where].map(([chart, cl]) => `${version(chart)} in ${cl.join(", ")}`).join(" · ")}`, Tone.Warn];
  }
  const missing = selectedClusters().filter((c) => !m.has(c));
  return missing.length ? [`not in ${missing.map(shortName).join(", ")}`, Tone.Info] : null;
}

registerExtraColumns(HELM_RELEASES, [
  { id: "drift", title: "Across clusters", kind: "status", width: 220, description: "The same release in the other selected clusters: chart versions apart, or clusters without it", when: isMultiCluster, cell: drift },
]);
