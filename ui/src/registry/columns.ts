import { type Cell, Tone } from "../lib/backend";
import { age, bytes, cpu, humanDuration } from "../lib/format";
import type { UIRow } from "../state/view";

/**
 * How each column kind (sent by the engine) is displayed and sorted. Register new kinds with
 * `registerColumnKind` — e.g. a metrics plugin could add `cpuUsage` cells.
 */
export interface ColumnKindDef {
  text(cell: Cell, now: number): string;
  tone?(cell: Cell, now: number): Tone | undefined;
  sortKey(cell: Cell): number | string | null;
  align?: "right";
  /** Render a status dot before the text. */
  dot?: boolean;
  /** Text depends on the current time (re-rendered every second). */
  live?: boolean;
  /** A tooltip for the cell. */
  title?(cell: Cell): string | undefined;
}

/** Usage against what bounds it (`[used, bound]`): 70% of it is a warning, 90% an error. */
function usageTone(c: Cell): Tone | undefined {
  const p = pair(c);
  if (!p || !p[1]) return undefined;
  const ratio = p[0] / p[1];
  return ratio >= 0.9 ? Tone.Error : ratio >= 0.7 ? Tone.Warn : undefined;
}

function usageTitle(fmt: (n: number) => string, bound: string) {
  return (c: Cell) => {
    const p = pair(c);
    if (!p) return undefined;
    return p[1] ? `${fmt(p[0])} used of ${fmt(p[1])} ${bound} (${Math.round((p[0] / p[1]) * 100)}%)` : `${fmt(p[0])} used (no ${bound})`;
  };
}

const percent = (c: Cell) => (typeof c === "number" ? `${Math.round(c)}%` : "");

const str = (c: Cell): string => (c == null ? "" : Array.isArray(c) ? String(c[0]) : String(c));
const num = (c: Cell): number | null => (typeof c === "number" ? c : null);
const pair = (c: Cell): [number, number | null] | null => (Array.isArray(c) && typeof c[0] === "number" ? (c as [number, number | null]) : null);

const KINDS: Record<string, ColumnKindDef> = {
  text: { text: str, sortKey: str },
  labels: { text: str, sortKey: str },
  number: { text: (c) => (c == null ? "" : String(c)), sortKey: num, align: "right" },
  bool: {
    text: (c) => (c == null ? "" : c ? "true" : "false"),
    tone: (c) => (c ? Tone.Info : Tone.Muted),
    sortKey: (c) => (c ? 1 : 0),
  },
  status: {
    text: str,
    tone: (c) => (Array.isArray(c) ? (c[1] as Tone) : undefined),
    sortKey: str,
    dot: true,
  },
  ratio: {
    text: (c) => {
      const p = pair(c);
      return p ? `${p[0]}/${p[1]}` : "";
    },
    tone: (c) => {
      const p = pair(c);
      if (!p) return undefined;
      const [a, b] = p as [number, number];
      return b === 0 ? Tone.Muted : a < b ? Tone.Warn : undefined;
    },
    sortKey: (c) => {
      const p = pair(c);
      if (!p) return null;
      const [a, b] = p as [number, number];
      return (b ? a / b : 1) * 1e6 + b;
    },
  },
  restarts: {
    text: (c, now) => {
      const p = pair(c);
      if (!p) return "";
      const [n, last] = p;
      return n && last ? `${n} (${age(last, now)} ago)` : String(n);
    },
    tone: (c, now) => {
      const p = pair(c);
      if (!p || !p[0]) return Tone.Muted;
      return p[1] && now - p[1] < 3600 ? Tone.Warn : undefined;
    },
    sortKey: (c) => pair(c)?.[0] ?? null,
    live: true,
  },
  age: {
    text: (c, now) => (typeof c === "number" ? age(c, now) : ""),
    sortKey: (c) => (typeof c === "number" ? -c : null),
    live: true,
  },
  duration: {
    text: (c, now) => {
      const p = pair(c);
      return p ? humanDuration((p[1] ?? now) - p[0]) : "";
    },
    sortKey: (c) => {
      const p = pair(c);
      return p ? (p[1] ?? Date.now() / 1000) - p[0] : null;
    },
    live: true,
  },
  bytes: { text: (c) => bytes(num(c)), sortKey: num, align: "right" },
  cpu: { text: (c) => cpu(num(c)), sortKey: num, align: "right" },
  // Usage from the metrics API: `[used, bound]`, the bound being a pod's limit or a node's allocatable.
  usageCpu: { text: (c) => cpu(pair(c)?.[0]), tone: usageTone, sortKey: (c) => pair(c)?.[0] ?? null, align: "right", title: usageTitle(cpu, "limit") },
  usageMem: { text: (c) => bytes(pair(c)?.[0]), tone: usageTone, sortKey: (c) => pair(c)?.[0] ?? null, align: "right", title: usageTitle(bytes, "limit") },
  nodeCpu: { text: (c) => cpu(pair(c)?.[0]), tone: usageTone, sortKey: (c) => pair(c)?.[0] ?? null, align: "right", title: usageTitle(cpu, "allocatable") },
  nodeMem: { text: (c) => bytes(pair(c)?.[0]), tone: usageTone, sortKey: (c) => pair(c)?.[0] ?? null, align: "right", title: usageTitle(bytes, "allocatable") },
  // Of a limit (or a node's allocatable): close to it is a warning, then an error.
  percentLimit: { text: percent, tone: (c) => (typeof c === "number" ? (c >= 90 ? Tone.Error : c >= 70 ? Tone.Warn : undefined) : undefined), sortKey: num, align: "right" },
  // Of a request: far below it, the request may be too big.
  percentRequest: { text: percent, tone: (c) => (typeof c === "number" && c < 10 ? Tone.Muted : undefined), sortKey: num, align: "right" },
};

export function columnKind(kind: string): ColumnKindDef {
  return KINDS[kind] ?? KINDS.text;
}

export function registerColumnKind(kind: string, def: ColumnKindDef) {
  KINDS[kind] = def;
}

/**
 * A column computed in the UI, from something besides the row's own cells (usage from the metrics API). `own`
 * reads one of the row's cells by its column id (requests and limits, a node's allocatable).
 */
export interface ExtraColumn {
  id: string;
  title: string;
  kind: string;
  width?: number;
  hidden?: boolean;
  description?: string;
  /** Only while this holds (several clusters selected…). */
  when?: () => boolean;
  cell(row: UIRow, own: (row: UIRow, id: string) => Cell): Cell;
}

const extras = new Map<string, ExtraColumn[]>();

/** Adds computed columns to the tables of a resource (by key: `pods`, `nodes`). */
export function registerExtraColumns(resourceKey: string, cols: ExtraColumn[]) {
  extras.set(resourceKey, [...(extras.get(resourceKey) ?? []).filter((c) => !cols.some((n) => n.id === c.id)), ...cols]);
}

export function extraColumns(resourceKey: string): ExtraColumn[] {
  return extras.get(resourceKey) ?? [];
}
