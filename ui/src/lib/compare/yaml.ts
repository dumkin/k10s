// How the engine writes YAML (`yaml.rs`, kubectl's style), piece by piece: keys and scalars plain where that reads back
// as the same value and double-quoted otherwise, multi-line strings as `|` blocks. Comparing objects writes them again
// line by line, so their two sides read like the YAML tab.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Json = any;

export const isMap = (v: Json): v is Record<string, Json> => v !== null && typeof v === "object" && !Array.isArray(v);
/** A map or list with something in it: written on lines of its own (empty ones are `{}` / `[]`). */
export const isNested = (v: Json) => (Array.isArray(v) ? v.length > 0 : isMap(v) && Object.keys(v).length > 0);

/** Escaped in YAML: controls (C0, DEL, C1), line and paragraph separators, the BOM, U+FFFE / U+FFFF. */
// eslint-disable-next-line no-control-regex
const ESCAPED = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\ufeff\ufffe\uffff]/;
// eslint-disable-next-line no-control-regex
const ESCAPED_IN_BLOCK = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029\ufeff\ufffe\uffff]/;

/** A string written as a `|` block: it has line breaks and nothing that must be escaped (tabs may stay). */
export const isBlock = (v: Json): v is string => typeof v === "string" && v.includes("\n") && !ESCAPED_IN_BLOCK.test(v);

const SPECIAL = new Set(["true", "false", "yes", "no", "on", "off", "y", "n", "null", "~", ".inf", "-.inf", "+.inf", ".nan", "<<", "="]);
const INDICATOR = new Set([..."-?:,[]{}#&*!|>'\"%@`"]);
const FLOAT = /^[+-]?(\d+\.?\d*([eE][+-]?\d+)?|\.\d+([eE][+-]?\d+)?)$/;

/** Numbers in any form a parser takes (hex, octal, `1_000`, `1e3`, `1:30`) and dates: plain, they would not stay strings. */
function looksNumeric(s: string): boolean {
  if (!/^[\d+.-]/.test(s)) return false;
  const t = s.replaceAll("_", "");
  const body = t.replace(/^[+-]+/, "");
  if (!/^[\d.]/.test(body)) return false;
  if (/^0[xob]/i.test(body) || FLOAT.test(t)) return true;
  if (/^\d{4}-\d/.test(s)) return true;
  return /^[\d:.eE+-]*$/.test(body) && body.split(".").length <= 2;
}

function plainSafe(s: string): boolean {
  if (!s || s.startsWith(" ") || s.endsWith(" ") || s.endsWith(":") || s.startsWith("...")) return false;
  if (INDICATOR.has(s[0])) return false;
  if (s.includes(": ") || s.includes(" #") || ESCAPED.test(s)) return false;
  return !SPECIAL.has(s.toLowerCase()) && !looksNumeric(s);
}

function quoted(s: string): string {
  let out = '"';
  for (const c of s) {
    if (c === '"') out += '\\"';
    else if (c === "\\") out += "\\\\";
    else if (c === "\n") out += "\\n";
    else if (c === "\t") out += "\\t";
    else if (c === "\r") out += "\\r";
    else if (ESCAPED.test(c)) out += `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`;
    else out += c;
  }
  return `${out}"`;
}

/** A string on one line: plain when that reads back as the same string. */
export const strText = (s: string) => (plainSafe(s) ? s : quoted(s));

/** A value written after `key: ` or `- `: anything but a nested map or list, or a block string. */
export function scalarText(v: Json): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "string") return strText(v);
  if (typeof v === "boolean" || typeof v === "number") return String(v);
  if (Array.isArray(v)) return "[]";
  return "{}";
}

/** What follows `key: ` or `- ` for a block string: `|`, its indentation (when the text starts blank) and chomping. */
export function blockHeader(s: string): string {
  const content = s.replace(/\n+$/, "");
  const trailing = s.length - content.length;
  const chomp = trailing === 0 ? "-" : trailing === 1 && content ? "" : "+";
  return `|${/^[ \t\n]/.test(s) ? "2" : ""}${chomp}`;
}

/** The lines of a block string, as written under its key (`indent`: their indentation); blank lines stay empty. */
export function blockBody(s: string, indent: string): string[] {
  const body = s.endsWith("\n") ? s.slice(0, -1) : s;
  return body.split("\n").map((l) => (l ? indent + l : ""));
}
