// Line-based YAML highlighter — fast enough to tokenize only the lines on screen. Values come from the
// cluster (annotations, ConfigMap data) and may be huge or hostile: lines are split by hand-written
// scans that are linear in the line length, never by backtracking regexes.

export type TokenKind = "key" | "str" | "num" | "bool" | "null" | "comment" | "punct" | "block" | "plain" | "anchor";

export interface Token {
  kind: TokenKind;
  text: string;
}

/** Same set as the regex `\s` (so lines split exactly like the old regex-based highlighter). */
function isSpace(c: number): boolean {
  return (
    c === 0x20 ||
    (c >= 0x09 && c <= 0x0d) ||
    c === 0xa0 ||
    c === 0x1680 ||
    (c >= 0x2000 && c <= 0x200a) ||
    c === 0x2028 ||
    c === 0x2029 ||
    c === 0x202f ||
    c === 0x205f ||
    c === 0x3000 ||
    c === 0xfeff
  );
}

/** Line terminators other than "\n" (which splits lines): such a line is shown unhighlighted. */
const ODD_BREAK = /[\r\u2028\u2029]/;

const COLON = 0x3a;
const HASH = 0x23;
const DQUOTE = 0x22;
const SQUOTE = 0x27;
const BACKSLASH = 0x5c;

function leadingSpace(s: string, from = 0): number {
  let i = from;
  while (i < s.length && isSpace(s.charCodeAt(i))) i++;
  return i;
}

/**
 * Index of the ":" ending a mapping key that starts at `start`, or -1. The key is a double-quoted string
 * (with escapes), a single-quoted string, or plain text up to the first ":" or "#"; the ":" must be
 * followed by whitespace or the end of the line.
 */
function keyColon(line: string, start: number): number {
  const n = line.length;
  const first = line.charCodeAt(start);
  let colon = -1;
  if (first === DQUOTE) {
    for (let j = start + 1; j < n; j++) {
      const c = line.charCodeAt(j);
      if (c === BACKSLASH) {
        if (j + 1 >= n) break;
        j++;
      } else if (c === DQUOTE) {
        colon = j + 1;
        break;
      }
    }
  } else if (first === SQUOTE) {
    const close = line.indexOf("'", start + 1);
    if (close >= 0) colon = close + 1;
  } else if (start < n && !isSpace(first) && first !== HASH && first !== COLON) {
    for (let j = start + 1; j < n; j++) {
      const c = line.charCodeAt(j);
      if (c === COLON || c === HASH) {
        colon = j;
        break;
      }
    }
  }
  if (colon < 0 || line.charCodeAt(colon) !== COLON) return -1;
  return colon + 1 === n || isSpace(line.charCodeAt(colon + 1)) ? colon : -1;
}

const BLOCK_RE = /^[|>][-+0-9]*$/;
const BOOL_RE = /^(true|false|yes|no|on|off)$/i;
const NULL_RE = /^(null|~)$/i;
const NUM_RE = /^[-+]?(\d[\d_]*(\.\d+)?([eE][-+]?\d+)?|0x[0-9a-fA-F]+|\.inf|\.nan)$/;

/** Kind of a scalar value. The regexes are anchored and unambiguous: linear on any input. */
function valueKind(value: string): TokenKind {
  if (BLOCK_RE.test(value)) return "block";
  if (BOOL_RE.test(value)) return "bool";
  if (NULL_RE.test(value)) return "null";
  if (NUM_RE.test(value)) return "num";
  const c = value.charCodeAt(0);
  if (c === 0x26 || c === 0x2a || c === 0x21) return "anchor";
  if (value === "{}" || value === "[]") return "punct";
  return "str";
}

/** Leading whitespace, the value, and a trailing comment (whitespace + "#…"). */
function scalar(text: string): Token[] {
  const out: Token[] = [];
  const a = leadingSpace(text);
  // The comment starts at the first whitespace run that is directly followed by "#".
  let p = text.length;
  for (let i = a + 1; i < text.length; i++) {
    if (text.charCodeAt(i) === HASH && isSpace(text.charCodeAt(i - 1))) {
      p = i - 1;
      while (p > a && isSpace(text.charCodeAt(p - 1))) p--;
      break;
    }
  }
  if (a > 0) out.push({ kind: "plain", text: text.slice(0, a) });
  if (p > a) {
    const value = text.slice(a, p);
    out.push({ kind: valueKind(value), text: value });
  }
  if (p < text.length) out.push({ kind: "comment", text: text.slice(p) });
  return out;
}

/** Tokenizes one line. `inBlock` marks lines inside a `|`/`>` block scalar (rendered as strings). */
export function tokenizeLine(line: string, inBlock: boolean): Token[] {
  if (inBlock) return [{ kind: "str", text: line }];
  const ws = leadingSpace(line);
  if (line.charCodeAt(ws) === HASH) return [{ kind: "comment", text: line }];
  if (ODD_BREAK.test(line)) return [{ kind: "plain", text: line }];
  const indent = line.slice(0, ws);
  const dashed = line.startsWith("- ", ws);
  // `- key: value` first, then `key: value` (a key may itself start with "-").
  for (const dash of dashed ? [true, false] : [false]) {
    const start = dash ? ws + 2 : ws;
    const colon = keyColon(line, start);
    if (colon < 0) continue;
    const out: Token[] = [];
    if (indent) out.push({ kind: "plain", text: indent });
    if (dash) out.push({ kind: "punct", text: "- " });
    out.push({ kind: "key", text: line.slice(start, colon) }, { kind: "punct", text: ":" });
    if (colon + 1 < line.length) out.push(...scalar(line.slice(colon + 1)));
    return out;
  }
  if (dashed) {
    const out: Token[] = [];
    if (indent) out.push({ kind: "plain", text: indent });
    out.push({ kind: "punct", text: "- " }, ...scalar(line.slice(ws + 2)));
    return out;
  }
  return scalar(line);
}

const isIndicatorTail = (c: number) => c === 0x2d || c === 0x2b || (c >= 0x30 && c <= 0x39);

/** Whether a line opens a block scalar: `key: |`, `key: >-`, `- |2`… (trailing whitespace allowed). */
function opensBlock(line: string): boolean {
  let e = line.length;
  while (e > 0 && isSpace(line.charCodeAt(e - 1))) e--;
  while (e > 0 && isIndicatorTail(line.charCodeAt(e - 1))) e--;
  const indicator = e - 1;
  if (indicator < 0 || (line[indicator] !== "|" && line[indicator] !== ">")) return false;
  let j = indicator;
  while (j > 0 && isSpace(line.charCodeAt(j - 1))) j--;
  if (j > 0 && line.charCodeAt(j - 1) === COLON) return true;
  // `- |`: a dash at the start of the line (after indentation), then at least one space.
  return j < indicator && j > 0 && line[j - 1] === "-" && leadingSpace(line) === j - 1;
}

/**
 * Marks which lines belong to block scalars so they can be tokenized independently later.
 * Returns an array of booleans, one per line.
 */
export function blockMask(lines: string[]): boolean[] {
  const mask = new Array<boolean>(lines.length).fill(false);
  let blockIndent = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const indent = line.length - line.trimStart().length;
    if (blockIndent >= 0) {
      if (line.trim() === "" || indent > blockIndent) {
        mask[i] = true;
        continue;
      }
      blockIndent = -1;
    }
    if (opensBlock(line)) blockIndent = indent;
  }
  return mask;
}
