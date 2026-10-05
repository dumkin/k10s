import { type Candidate, rank, type Spot } from "../../lib/logs/complete";
import { LEVEL_NAME, LEVELS } from "../../lib/logs/parse";
import { shortName } from "../../state/clusters";
import type { Source } from "../logBuffer";
import type { LogCtx } from "./LogViewer";
import { type FieldStat, fieldStats, numeric, quantile } from "./model";

// What the query field suggests: the fields of the lines held (the latest few thousand, whatever is filtered — a
// query being typed filters them) with their values, and the sources the lines come from.

/** Lines looked at: the latest of the buffer. */
const SAMPLE = 5000;
/** Distinct values kept per field. */
const MAX_VALUES = 300;

export interface Suggestion extends Candidate {
  /** Characters of `text` matching what is typed… */
  at: number[];
  /** …and how: -1 it is what is typed, 0 it starts with it, 1 a word in it does, 2 it is somewhere in it. */
  score: number;
}

const COMPARE = new Set([">", ">=", "<", "<="]);
const pct = (x: number) => (x >= 0.995 ? "all" : x < 0.01 ? "<1%" : `${Math.round(x * 100)}%`);

/** The fields and values to suggest, as the buffer holds them now. */
export class Catalog {
  private readonly fields: Map<string, FieldStat>;
  private readonly keys: Candidate[];
  private readonly sourceValues: Record<"pod" | "container" | "cluster" | "ns", Candidate[]>;
  private readonly levels: number[];

  constructor(c: LogCtx) {
    const buffer = c.buffer();
    const stats = fieldStats(buffer.lines, c.structures, SAMPLE, MAX_VALUES);
    this.fields = new Map(stats.fields.map((f) => [f.key.toLowerCase(), f]));
    this.levels = [0, 0, 0, 0, 0, 0];
    for (const l of buffer.lines) if (!l.marker) this.levels[l.lvl]++;
    const total = buffer.lines.length;

    const sources = c.sources().byId;
    const tally = (of: (s: Source) => string, hint?: (s: Source) => string): Candidate[] => {
      const m = new Map<string, Candidate>();
      for (const s of sources) {
        const text = of(s);
        const it = m.get(text) ?? { text, count: 0, hint: hint?.(s) };
        it.count! += buffer.counts[s.id] ?? 0;
        m.set(text, it);
      }
      return [...m.values()];
    };
    this.sourceValues = {
      pod: tally((s) => s.pod),
      container: tally((s) => s.container),
      cluster: tally(
        (s) => shortName(s.cluster),
        (s) => (shortName(s.cluster) !== s.cluster ? s.cluster : ""),
      ),
      ns: tally((s) => s.namespace),
    };
    const several = (k: keyof Catalog["sourceValues"], what: string): Candidate[] => (this.sourceValues[k].length > 1 ? [{ text: k, count: total, hint: `${this.sourceValues[k].length} ${what}` }] : []);
    const seen = new Set<string>();
    // (A field named like one of every line, `level`, `msg`: that one.)
    this.keys = [
      { text: "level", count: total, hint: "every line's" },
      ...several("pod", "pods"),
      ...several("container", "containers"),
      ...several("cluster", "clusters"),
      ...several("ns", "namespaces"),
      ...(stats.structured ? [{ text: "msg", count: stats.structured, hint: "the message" }] : []),
      ...stats.fields.map((f) => ({ text: f.key, count: f.n, hint: `${numeric(f) ? "number · " : ""}${pct(f.n / stats.structured)}` })),
    ].filter((k) => !seen.has(k.text.toLowerCase()) && !!seen.add(k.text.toLowerCase()));
  }

  /** Suggestions for the spot the caret is in (best first). */
  at(spot: Spot): Suggestion[] {
    if (spot.kind === "key") return rank(this.keys, spot.prefix);
    const key = spot.key.toLowerCase();
    const compare = COMPARE.has(spot.op);
    if (key === "level") {
      // In their order, from the worst; comparing: every level, else those the lines have.
      const levels = LEVELS.filter((l) => compare || this.levels[l] > 0).map((l) => ({ text: LEVEL_NAME[l], count: this.levels[l] }));
      return rank(levels, spot.prefix, false);
    }
    const source = key === "namespace" ? "ns" : key;
    if (source === "pod" || source === "container" || source === "cluster" || source === "ns") return rank(this.sourceValues[source], spot.prefix);
    const f = this.fields.get(key);
    if (!f) return [];
    if (compare) {
      if (!numeric(f)) return [];
      // Comparing a number: where its values are (the median, the slowest tenth, hundredth…).
      const s = [...f.numbers].sort((a, b) => a - b);
      const marks: [string, number][] = [
        ["median", quantile(s, 0.5)],
        ["p90", quantile(s, 0.9)],
        ["p99", quantile(s, 0.99)],
        ["max", s[s.length - 1]],
        ["min", s[0]],
      ];
      const seen = new Set<number>();
      const out = marks.filter(([, v]) => !seen.has(v) && !!seen.add(v)).map(([hint, v]) => ({ text: String(v), hint }));
      return rank(out, spot.prefix, false);
    }
    const values = [...f.values.values()].map((v) => ({ text: v.value === null ? "null" : String(v.value), count: v.n }));
    return rank(values, spot.prefix);
  }
}
