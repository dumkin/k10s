import { stripAnsi } from "../ansi";
import { LEVEL_NAME, type Level } from "./parse";

// Times as log lines show them, and lines as they are copied and saved. Formatting is by hand: a log can hold
// a hundred thousand lines, and Intl formatters cost microseconds each.

const p2 = (n: number) => (n < 10 ? `0${n}` : `${n}`);
const p3 = (n: number) => (n < 10 ? `00${n}` : n < 100 ? `0${n}` : `${n}`);

/** 10:42:01.123 (local time, or UTC). */
export function clockOf(ms: number, utc: boolean): string {
  const d = new Date(ms);
  return utc
    ? `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())}.${p3(d.getUTCMilliseconds())}`
    : `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}.${p3(d.getMilliseconds())}`;
}

/** 2026-10-04 */
export function dayOf(ms: number, utc: boolean): string {
  const d = new Date(ms);
  return utc ? `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}` : `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
}

/** 2026-10-04 10:42:01.123, with "Z" in UTC. */
export function stampOf(ms: number, utc: boolean): string {
  return `${dayOf(ms, utc)} ${clockOf(ms, utc)}${utc ? "Z" : ""}`;
}

/** A gap between lines in words: 900ms, 12s, 4m 10s, 2h 5m, 3d 4h. */
export function gapOf(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${m}m ${s % 60}s` : `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d}d ${h % 24}h` : `${d}d`;
}

/** A line to copy or save: an entry with its continuation lines, or a marker (why a stream stopped…). */
export interface ExportLine {
  i: number;
  ts: number | null;
  text: string;
  more?: string[];
  lvl: Level;
  marker?: boolean;
}

export interface ExportSource {
  cluster: string;
  namespace: string;
  pod: string;
  container: string;
}

/** As shown: times, where each line comes from, the text without ANSI escapes. */
export function asText(lines: readonly ExportLine[], opts: { timestamps: boolean; utc: boolean; label?: (i: number) => string }): string {
  const out: string[] = [];
  for (const l of lines) {
    const ts = opts.timestamps ? `${l.ts !== null ? stampOf(l.ts, opts.utc) : "".padEnd(opts.utc ? 24 : 23)} ` : "";
    const label = opts.label?.(l.i);
    const prefix = `${ts}${label ? `${label} ` : ""}`;
    if (l.marker) {
      out.push(`${prefix}── ${l.text} ──`);
      continue;
    }
    out.push(`${prefix}${stripAnsi(l.text)}`);
    if (l.more) for (const m of l.more) out.push(stripAnsi(m));
  }
  return out.length ? `${out.join("\n")}\n` : "";
}

/** As the container wrote them (`kubectl logs`): no times, no markers, escapes kept. */
export function asRaw(lines: readonly ExportLine[]): string {
  const out: string[] = [];
  for (const l of lines) {
    if (l.marker) continue;
    out.push(l.text);
    if (l.more) for (const m of l.more) out.push(m);
  }
  return out.length ? `${out.join("\n")}\n` : "";
}

/**
 * One JSON object per line, for jq and friends: time (UTC), where from, level, the line — and a JSON line's object
 * as `json`. Markers are `event`s.
 */
export function asJsonl(lines: readonly ExportLine[], sourceOf: (i: number) => ExportSource | undefined): string {
  const out: string[] = [];
  for (const l of lines) {
    const src = sourceOf(l.i);
    const rec: Record<string, unknown> = { time: l.ts !== null ? new Date(l.ts).toISOString() : null, ...src, level: LEVEL_NAME[l.lvl] };
    if (l.marker) rec.event = l.text;
    else {
      const text = l.more?.length ? [l.text, ...l.more].join("\n") : l.text;
      rec.line = stripAnsi(text);
      if (!l.more?.length && text.charCodeAt(0) === 123) {
        try {
          const json = JSON.parse(text);
          if (json && typeof json === "object") rec.json = json;
        } catch {
          // Not JSON after all: the line says it all.
        }
      }
    }
    out.push(JSON.stringify(rec));
  }
  return out.length ? `${out.join("\n")}\n` : "";
}
