import type { FieldValue } from "./parse";

// Colouring of plain log text: times, levels, strings, numbers, ids, URLs, keys of key=value pairs. Only the lines
// on screen are coloured, once each; one pass of one expression per line.

/** A piece of a line: its text and how it is shown. */
export interface Piece {
  text: string;
  /** A token class (`t-num`…), or classes of a structured line's parts. */
  cls?: string;
  /** Inline style (ANSI colours). */
  style?: Record<string, string | number | undefined>;
  /** A query match. */
  mark?: boolean;
  /** A structured line's field value: clicking it filters by it. */
  field?: string;
  value?: FieldValue;
}

const TOKEN = new RegExp(
  [
    // 2024-10-04T10:42:01.123Z, 2024/10/04 10:42:01, 10:42:01.123
    /(?<time>\b\d{4}[-/]\d{2}[-/]\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?|\b\d{2}:\d{2}:\d{2}(?:[.,]\d+)?\b)/.source,
    /(?<err>\b(?:ERROR|ERRO|ERR|FATAL|PANIC|CRITICAL|SEVERE|EMERG|ALERT)\b|\b(?:panic|fatal error|Exception|Error)(?=:))/.source,
    /(?<warn>\b(?:WARN|WARNING)\b)/.source,
    /(?<info>\b(?:INFO|NOTICE)\b)/.source,
    /(?<debug>\b(?:DEBUG|DEBU|TRACE|TRAC)\b)/.source,
    /(?<url>\bhttps?:\/\/[^\s"'<>)\]]+)/.source,
    /(?<str>"(?:[^"\\]|\\.){0,400}")/.source,
    /(?<key>\b[A-Za-z_][\w.-]{0,40}(?==[^=\s]))/.source,
    /(?<id>\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b|\b\d{1,3}(?:\.\d{1,3}){3}(?::\d{1,5})?\b)/.source,
    /(?<kw>\b(?:true|false|null|nil|None|undefined)\b)/.source,
    // Words (v1, web-7f9c8) are taken whole, so the digits in them are not numbers. (No lookbehind: WebKit before
    // 16.4 has none.)
    /(?<word>[A-Za-z_][\w.-]*)/.source,
    /(?<num>-?\d+(?:\.\d+)?(?:ms|µs|us|ns|s|m|h|d|[KMGT]i?B|B|%)?(?![\w.]))/.source,
  ].join("|"),
  "g",
);

const CLASS: Record<string, string> = { time: "t-time", err: "t-err", warn: "t-warn", info: "t-info", debug: "t-debug", url: "t-url", str: "t-str", key: "t-key", id: "t-id", num: "t-num", kw: "t-kw" };

/** Longer lines are coloured up to here; the rest is plain. */
const MAX = 4000;

/** `text` in coloured pieces — up to `upTo` characters (as far as it is drawn); the rest is one plain piece. */
export function tokenize(text: string, upTo = MAX): Piece[] {
  const out: Piece[] = [];
  const end = Math.min(text.length, MAX, upTo);
  const scan = end < text.length ? text.slice(0, end) : text;
  let last = 0;
  TOKEN.lastIndex = 0;
  for (let m = TOKEN.exec(scan); m; m = TOKEN.exec(scan)) {
    if (!m[0]) {
      TOKEN.lastIndex++;
      continue;
    }
    const g = m.groups!;
    let cls: string | undefined;
    for (const k in g) {
      if (g[k] !== undefined) {
        cls = CLASS[k];
        break;
      }
    }
    // Plain words stay part of the plain text around them.
    if (!cls) continue;
    if (m.index > last) out.push({ text: text.slice(last, m.index) });
    out.push({ text: m[0], cls });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out;
}

/** The pieces' text from offset `from` to `to` (in their joined text): pieces cut where the range ends inside them. */
export function slicePieces(pieces: readonly Piece[], from: number, to: number): Piece[] {
  const out: Piece[] = [];
  if (from >= to) return out;
  let pos = 0;
  for (const p of pieces) {
    if (pos >= to) break;
    const end = pos + p.text.length;
    if (end > from) out.push(pos >= from && end <= to ? p : { ...p, text: p.text.slice(Math.max(0, from - pos), Math.min(p.text.length, to - pos)) });
    pos = end;
  }
  return out;
}

/** Splits pieces at `ranges` (offsets in their joined text) and marks what the ranges cover. */
export function overlay(pieces: Piece[], ranges: [number, number][]): Piece[] {
  if (!ranges.length) return pieces;
  const out: Piece[] = [];
  let r = 0;
  let pos = 0;
  for (const p of pieces) {
    const start = pos;
    const end = pos + p.text.length;
    pos = end;
    let at = start;
    while (r < ranges.length && ranges[r][1] <= at) r++;
    if (r >= ranges.length || ranges[r][0] >= end) {
      out.push(p);
      continue;
    }
    while (at < end) {
      while (r < ranges.length && ranges[r][1] <= at) r++;
      const range = ranges[r];
      if (!range || range[0] >= end) {
        out.push({ ...p, text: p.text.slice(at - start) });
        break;
      }
      if (range[0] > at) {
        out.push({ ...p, text: p.text.slice(at - start, range[0] - start) });
        at = range[0];
      }
      const stop = Math.min(end, range[1]);
      out.push({ ...p, text: p.text.slice(at - start, stop - start), mark: true });
      at = stop;
    }
  }
  return out;
}
