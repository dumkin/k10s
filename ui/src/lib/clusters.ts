// Multi-cluster helpers: zone/DC family detection, compact display names and stable colors.

/**
 * Detects per-zone/per-DC cluster families from context names:
 * `prod-eu-z1` / `prod-eu-z2` → base `prod-eu`, zones `z1`, `z2`.
 * Recognized suffixes: `z1`, `z01-2`, `dc2`, `az1`, `zone-a`, `eu-west-1`; in plain names also any trailing token
 * with a digit (`prod-eu-1`). Names like ARNs, URLs or `user@cluster` (with `:`, `/` or `@`) need a recognized
 * suffix: what ends them belongs to another name — every EKS ARN of a region (`arn:aws:eks:eu-west-1:…:cluster/x`)
 * would be one "zone" of `arn:aws:eks:eu-west`, `kubernetes-admin@cluster-1` and `-2` zones of one family.
 */
const ZONE_RE = /^(.+?)[-_.]((?:z|dc|az)\d+(?:[-_]\d+)?|zone[-_]?[a-z0-9]+|[a-z]{2}-[a-z]+-\d[a-z]?)$/i;
/** ARNs, URLs, `user@cluster`: names made of other names. */
const QUALIFIED = /[:/@]/;

export function zoneOf(name: string): { base: string; zone: string } | null {
  const m = ZONE_RE.exec(name);
  if (m) return { base: m[1], zone: m[2] };
  if (QUALIFIED.test(name)) return null;
  const i = Math.max(name.lastIndexOf("-"), name.lastIndexOf("_"));
  if (i > 0 && /\d/.test(name.slice(i + 1))) return { base: name.slice(0, i), zone: name.slice(i + 1) };
  return null;
}

export interface ClusterFamily {
  base: string;
  members: string[];
}

/** The zones of a family's members (`prod-eu-z1` → `z1`); a member that is not a zone keeps its name. */
export const zonesOf = (members: string[]) => members.map((m) => zoneOf(m)?.zone ?? m);

/** Zones as one short line: at most `max` of them, then how many more (`z1 z2 z3 +5`). */
export function zoneSummary(members: string[], max: number): string {
  const zones = zonesOf(members);
  return zones.length <= max ? zones.join(" ") : `${zones.slice(0, max).join(" ")} +${zones.length - max}`;
}

/** Families with at least two members, sorted by base name. */
export function families(names: string[]): ClusterFamily[] {
  const by = new Map<string, string[]>();
  for (const n of names) {
    const z = zoneOf(n);
    if (!z) continue;
    const list = by.get(z.base) ?? [];
    list.push(n);
    by.set(z.base, list);
  }
  return [...by.entries()]
    .filter(([, members]) => members.length > 1)
    .map(([base, members]) => ({ base, members: members.sort(naturalCompare) }))
    .sort((a, b) => a.base.localeCompare(b.base));
}

/**
 * Shortest readable names for a set of clusters shown side by side: the common prefix (cut at a
 * separator) is dropped — `prod-eu-z1`, `prod-eu-z2` → `z1`, `z2`.
 */
export function shortNames(names: string[]): Map<string, string> {
  const out = new Map<string, string>();
  if (names.length < 2) {
    for (const n of names) out.set(n, n);
    return out;
  }
  let prefix = names[0];
  for (const n of names) {
    let i = 0;
    while (i < prefix.length && i < n.length && prefix[i] === n[i]) i++;
    prefix = prefix.slice(0, i);
  }
  const cut = Math.max(prefix.lastIndexOf("-"), prefix.lastIndexOf("_"), prefix.lastIndexOf("."));
  const drop = cut >= 0 ? cut + 1 : 0;
  for (const n of names) out.set(n, n.slice(drop) || n);
  return out;
}

/** Distinguishable hues that work on dark and light backgrounds. */
export const CLUSTER_COLORS = ["#7c6cff", "#22b8cf", "#f59f00", "#e64980", "#40c057", "#4c6ef5", "#fd7e14", "#be4bdb", "#15aabf", "#fab005"];

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * Stable color per cluster (hash-based, so "z2 is always cyan"), with collisions among the
 * currently visible clusters resolved by probing so side-by-side clusters never share a color.
 */
export function assignColors(names: string[]): Map<string, string> {
  const used = new Set<number>();
  const out = new Map<string, string>();
  for (const n of [...names].sort()) {
    let i = hash(n) % CLUSTER_COLORS.length;
    for (let k = 0; k < CLUSTER_COLORS.length && used.has(i); k++) i = (i + 1) % CLUSTER_COLORS.length;
    used.add(i);
    out.set(n, CLUSTER_COLORS[i]);
  }
  return out;
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** Natural order: pod-2 < pod-10. */
export function naturalCompare(a: string, b: string): number {
  return collator.compare(a, b);
}
