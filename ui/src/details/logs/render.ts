import { parseAnsi } from "../../lib/ansi";
import { overlay, type Piece, tokenize } from "../../lib/logs/highlight";
import { ERROR_KEYS, type FieldValue, type Level, type Structured, TRACE_KEYS } from "../../lib/logs/parse";
import type { Line } from "../logBuffer";

// A log entry as pieces of text to show: as written (ANSI colours kept), or — "pretty" — a structured line as its
// level, message and fields, a plain one with its tokens coloured. Query matches are marked in what is shown.

export type Highlight = (text: string) => [number, number][];

export interface Head {
  /** A structured line's level, shown as a tag (it is left out of its fields). */
  tag?: Level;
  /** Pinned fields, as columns: the line's values (empty where it has none). */
  cells?: { key: string; text: string; value?: FieldValue; cls?: string }[];
  pieces: Piece[];
}

/** A field's value as text: strings as they are, unless they need quotes to read as one value. */
export function valueText(v: FieldValue): string {
  if (v === null) return "null";
  if (typeof v !== "string") return String(v);
  if (v === "") return '""';
  const flat = v.includes("\n") ? v.replace(/\r?\n/g, " ⏎ ") : v;
  return /[\s"=]/.test(flat) ? JSON.stringify(flat).replace(/\\"/g, '"') : flat;
}

function valueClass(key: string, v: FieldValue): string {
  if (ERROR_KEYS.has(key)) return "f-val f-err";
  if (TRACE_KEYS.has(key)) return "f-val f-trace";
  if (typeof v === "number") return "f-val f-num";
  if (typeof v === "boolean" || v === null) return "f-val f-kw";
  return "f-val";
}

const marked = (pieces: Piece[], hl: Highlight | undefined): Piece[] => {
  if (!hl) return pieces;
  const ranges = hl(pieces.length === 1 ? pieces[0].text : pieces.map((p) => p.text).join(""));
  return ranges.length ? overlay(pieces, ranges) : pieces;
};

function ansiPieces(text: string): Piece[] {
  return parseAnsi(text).map((s) => ({
    text: s.text,
    style: s.fg || s.bg || s.bold || s.italic || s.underline ? { color: s.fg, background: s.bg, "font-weight": s.bold ? 700 : undefined, "font-style": s.italic ? "italic" : undefined, "text-decoration": s.underline ? "underline" : undefined } : undefined,
  }));
}

/** One line of text (a head as written, or a continuation line), coloured up to `upTo` characters. */
export function textPieces(text: string, ansi: boolean, pretty: boolean, hl?: Highlight, upTo?: number): Piece[] {
  if (ansi) return marked(ansiPieces(text), hl);
  return marked(pretty ? tokenize(text, upTo) : [{ text }], hl);
}

/** The first line of an entry, coloured up to `upTo` characters. `pinned`: fields shown as columns. */
export function headOf(l: Line, s: Structured | null, pretty: boolean, pinned: readonly string[], hl?: Highlight, upTo?: number): Head {
  if (!pretty || !s || l.ansi) return { pieces: textPieces(l.text, l.ansi, pretty, hl, upTo) };
  const head: Head = { pieces: [] };
  if (s.levelKey !== undefined && l.lvl) head.tag = l.lvl;
  const skip = new Set<string>();
  if (s.msgKey) skip.add(s.msgKey);
  if (s.levelKey) skip.add(s.levelKey);
  if (s.timeKey) skip.add(s.timeKey);
  if (pinned.length) {
    head.cells = pinned.map((key) => {
      skip.add(key);
      const v = key === "msg" ? s.msg : s.fields.find(([k]) => k === key)?.[1];
      return v === undefined ? { key, text: "" } : { key, text: valueText(v), value: v, cls: valueClass(key, v) };
    });
  }
  const pieces: Piece[] = [];
  if (s.msg !== undefined) for (const p of tokenize(s.msg.includes("\n") ? s.msg.replace(/\r?\n/g, " ⏎ ") : s.msg, upTo)) pieces.push(p.cls ? p : { text: p.text, cls: "f-msg" });
  for (const [k, v] of s.fields) {
    if (skip.has(k)) continue;
    pieces.push({ text: pieces.length ? "  " : "" }, { text: k, cls: "f-key" }, { text: "=", cls: "f-eq" }, { text: valueText(v), cls: valueClass(k, v), field: k, value: v });
  }
  head.pieces = marked(pieces, hl);
  return head;
}
