import type { FieldValue, Level } from "./parse";
import { LEVEL_NAME, levelNamed } from "./parse";

// The logs' filter language. Words must all be there (in any order, any case); "a phrase" keeps its words together;
// !word leaves lines out; /a.?regex/ is a regular expression; key:value looks into a structured line's field
// (contains), key=value is equality, key>n, key>=n, key<n, key<=n compare numbers, a,b,c lists alternatives (quoted
// ones too: "a b",c), and * is a wildcard; key: alone is a field the line has. `level`, `pod`, `container`, `cluster`
// and `namespace` work on every line. A line without the field (a plain one) is matched by the term's text instead: a
// URL (http://…) or "error:" finds what it says.
// With the regex option the whole input is one regular expression (!… inverts it).

export interface QueryOptions {
  regex?: boolean;
  matchCase?: boolean;
}

export type Op = ":" | "=" | "!=" | ">" | ">=" | "<" | "<=";

export type Term =
  | { kind: "text"; text: string; not: boolean }
  | { kind: "regex"; re: RegExp; not: boolean }
  | { kind: "field"; key: string; op: Op; values: string[]; globs: (RegExp | null)[]; raw: string; not: boolean };

/** How the input is coloured: [start, end, kind]. */
export type SpanKind = "not" | "key" | "op" | "value" | "regex" | "phrase" | "text" | "error";

export interface Query {
  input: string;
  opts: QueryOptions;
  terms: Term[];
  /** Why the input cannot be used (an invalid regular expression); it then filters nothing. */
  error?: string;
  spans: [number, number, SpanKind][];
}

/** What a query looks at in a line (see `LogBuffer` for lines). */
export interface Subject {
  /** The entry's plain text (no ANSI), its lines joined by "\n". */
  text(): string;
  /** The same, in lower case. */
  lower(): string;
  level: Level;
  /** A structured line's field (`msg` is its message, whatever its key); undefined for plain lines and missing ones. */
  field(key: string): FieldValue | undefined;
  /** Where the line comes from: pod, container, cluster, namespace. */
  source(key: "pod" | "container" | "cluster" | "namespace"): string;
}

const SOURCE_KEYS = new Set(["pod", "container", "cluster", "namespace", "ns"]);
/** A field's name, as a term starts with it. */
export const FIELD_NAME = /^[A-Za-z_@][\w.@-]*/;
/** The operators between a field and its value, the longest first. */
export const OPS = [">=", "<=", "!=", ":", "=", ">", "<"] as const;
const FIELD = /^([A-Za-z_@][\w.@-]*)(>=|<=|!=|:|=|>|<)(.+)$/s;
/** A field's name and operator with nothing after: the line has the field. */
const HAS = /^([A-Za-z_@][\w.@-]*)(>=|<=|!=|:|=|>|<)$/;
const REGEX_META = /[.*+?()[\]{}|\\^$]/;

export interface Token {
  raw: string;
  start: number;
  end: number;
}

/** Splits on blanks outside quotes; `/…/` may hold blanks when it is closed before one. */
export function tokenize(input: string): Token[] {
  const out: Token[] = [];
  const n = input.length;
  let i = 0;
  while (i < n) {
    while (i < n && /\s/.test(input[i])) i++;
    if (i >= n) break;
    const start = i;
    const body = input[i] === "!" ? i + 1 : i;
    if (input[body] === "/") {
      // A regular expression: up to a "/" followed by a blank or the end.
      let j = body + 1;
      let close = -1;
      for (; j < n; j++) {
        if (input[j] === "\\") j++;
        else if (input[j] === "/" && (j + 1 >= n || /\s/.test(input[j + 1]))) {
          close = j;
          break;
        }
      }
      if (close > body + 1) {
        out.push({ raw: input.slice(start, close + 1), start, end: close + 1 });
        i = close + 1;
        continue;
      }
    }
    let quoted = false;
    for (; i < n; i++) {
      const c = input[i];
      if (c === "\\" && quoted) i++;
      else if (c === '"') quoted = !quoted;
      else if (!quoted && /\s/.test(c)) break;
    }
    out.push({ raw: input.slice(start, Math.min(i, n)), start, end: Math.min(i, n) });
  }
  return out;
}

/** A quoted value as meant: its escapes undone (as `valueTerm` writes them; else a backslash keeps what follows it). */
export function unquote(s: string): string {
  if (s.length < 2 || !s.startsWith('"') || !s.endsWith('"')) return s;
  try {
    const v: unknown = JSON.parse(s);
    if (typeof v === "string") return v;
  } catch {
    // Typed, not JSON (`"C:\Windows"`).
  }
  return s.slice(1, -1).replace(/\\(.)/g, "$1");
}

/**
 * The items of a term's values (`a,"b, c"`: `a` and `"b, c"`): where each is, as [start, end), empty ones too, and
 * whether the last one leaves its quote open. A quote opens an item only at its start: elsewhere it is a character.
 */
export function scanItems(rest: string): { spans: [number, number][]; open: boolean } {
  const spans: [number, number][] = [];
  let from = 0;
  let quoted = false;
  for (let i = 0; i < rest.length; i++) {
    const c = rest[i];
    if (quoted) {
      if (c === "\\") i++;
      else if (c === '"') quoted = false;
    } else if (c === '"' && i === from) quoted = true;
    else if (c === ",") {
      spans.push([from, i]);
      from = i + 1;
    }
  }
  spans.push([from, rest.length]);
  return { spans, open: quoted };
}

/** A term's values as written (a quoted one with its quotes). */
const itemsOf = (rest: string) => scanItems(rest).spans.map(([from, to]) => rest.slice(from, to)).filter(Boolean);

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A value with `*` as a regular expression (anchored for equality); null without one. */
function globOf(value: string, anchored: boolean, matchCase: boolean): RegExp | null {
  if (!value.includes("*")) return null;
  const body = value.split("*").map(escapeRe).join(".*");
  return new RegExp(anchored ? `^${body}$` : body, matchCase ? "s" : "is");
}

export function parseQuery(input: string, opts: QueryOptions = {}): Query {
  const q: Query = { input, opts, terms: [], spans: [] };
  const trimmed = input.trim();
  if (!trimmed) return q;
  const flags = opts.matchCase ? "" : "i";
  if (opts.regex) {
    const lead = input.length - input.trimStart().length;
    const not = trimmed.startsWith("!") && trimmed.length > 1;
    const body = not ? trimmed.slice(1) : trimmed;
    if (not) q.spans.push([lead, lead + 1, "not"]);
    try {
      q.terms.push({ kind: "regex", re: new RegExp(body, flags), not });
      q.spans.push([lead + (not ? 1 : 0), lead + trimmed.length, "regex"]);
    } catch (e) {
      q.error = e instanceof Error ? e.message : String(e);
      q.spans.push([lead + (not ? 1 : 0), lead + trimmed.length, "error"]);
    }
    return q;
  }
  for (const t of tokenize(input)) {
    let raw = t.raw;
    let at = t.start;
    const not = raw.length > 1 && raw.startsWith("!");
    if (not) {
      q.spans.push([at, at + 1, "not"]);
      raw = raw.slice(1);
      at++;
    }
    // /regex/
    if (raw.length > 2 && raw.startsWith("/") && raw.endsWith("/") && REGEX_META.test(raw.slice(1, -1))) {
      try {
        q.terms.push({ kind: "regex", re: new RegExp(raw.slice(1, -1), flags), not });
        q.spans.push([at, t.end, "regex"]);
      } catch (e) {
        q.error = e instanceof Error ? e.message : String(e);
        q.spans.push([at, t.end, "error"]);
      }
      continue;
    }
    // "a phrase"
    if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) {
      const text = unquote(raw);
      if (text) q.terms.push({ kind: "text", text, not });
      q.spans.push([at, t.end, "phrase"]);
      continue;
    }
    const f = FIELD.exec(raw);
    if (f && !(f[2] === ":" && f[3].startsWith("//"))) {
      const [, key, op, rest] = f;
      const values = itemsOf(rest).map(unquote);
      if (values.length) {
        const anchored = op === "=" || op === "!=";
        q.terms.push({ kind: "field", key, op: op as Op, values, globs: values.map((v) => globOf(v, anchored, !!opts.matchCase)), raw, not });
        q.spans.push([at, at + key.length, "key"], [at + key.length, at + key.length + op.length, "op"], [at + key.length + op.length, t.end, "value"]);
        continue;
      }
    }
    const has = HAS.exec(raw);
    if (has) {
      q.terms.push({ kind: "field", key: has[1], op: has[2] as Op, values: [], globs: [], raw, not });
      q.spans.push([at, at + has[1].length, "key"], [at + has[1].length, t.end, "op"]);
      continue;
    }
    q.terms.push({ kind: "text", text: raw, not });
    q.spans.push([at, t.end, "text"]);
  }
  return q;
}

/** Nothing to filter by (or the input is invalid). */
export const isEmpty = (q: Query) => !q.terms.length || !!q.error;

/** A cache key: the same key, the same filter. */
export const queryKey = (q: Query) => (isEmpty(q) ? "" : `${q.opts.regex ? "r" : ""}${q.opts.matchCase ? "c" : ""}|${q.input.trim()}`);

const toNumber = (v: FieldValue | string): number | null => {
  if (typeof v === "number") return v;
  if (typeof v === "boolean" || v === null) return null;
  const n = Number(v);
  return v.trim() !== "" && Number.isFinite(n) ? n : null;
};

function compareValue(v: FieldValue | string, op: Op, want: string, glob: RegExp | null, matchCase: boolean): boolean {
  if (op === ">" || op === ">=" || op === "<" || op === "<=") {
    const a = toNumber(v);
    const b = toNumber(want);
    if (a === null || b === null) return false;
    return op === ">" ? a > b : op === ">=" ? a >= b : op === "<" ? a < b : a <= b;
  }
  const s = v === null ? "null" : String(v);
  if (glob) return glob.test(s);
  if (typeof v === "number") {
    const b = toNumber(want);
    return b !== null && v === b;
  }
  const hay = matchCase ? s : s.toLowerCase();
  const needle = matchCase ? want : want.toLowerCase();
  return op === ":" ? hay.includes(needle) : hay === needle;
}

function levelTest(level: Level, op: Op, values: string[]): boolean {
  const wanted = values.map(levelNamed);
  if (op === ">" || op === ">=" || op === "<" || op === "<=") {
    const w = wanted[0];
    if (w === undefined) return false;
    return op === ">" ? level > w : op === ">=" ? level >= w : op === "<" ? level < w : level <= w;
  }
  const hit = wanted.includes(level);
  return op === "!=" ? !hit : hit;
}

/** `inText`: what a line's text must have for it to match (in lower case), when that is known. */
function fieldTest(t: Extract<Term, { kind: "field" }>, s: Subject, matchCase: boolean, inText: string[] | null): boolean {
  const key = t.key.toLowerCase();
  if (!t.values.length) {
    // `key:` alone: the line has the field (every line has a level and a source; a plain one: it says `key:`).
    if (key === "level" || SOURCE_KEYS.has(key)) return true;
    if (!s.lower().includes(key.slice(key.lastIndexOf(".") + 1))) return false;
    if (s.field(t.key) !== undefined) return true;
    return matchCase ? s.text().includes(t.raw) : s.lower().includes(t.raw.toLowerCase());
  }
  if (key === "level") return levelTest(s.level, t.op, t.values);
  const any = (v: FieldValue | string) => {
    const negated = t.op === "!=";
    const op: Op = negated ? "=" : t.op;
    const hit = t.values.some((want, i) => compareValue(v, op, want, t.globs[i], matchCase));
    return negated ? !hit : hit;
  };
  if (SOURCE_KEYS.has(key)) {
    const v = s.source(key === "ns" ? "namespace" : (key as "pod" | "container" | "cluster" | "namespace"));
    if (key !== "cluster" || t.op === ":") return any(v);
    // A cluster goes by its context's name and by its short one: either is it.
    const negated = t.op === "!=";
    const op: Op = negated ? "=" : t.op;
    const hit = v.split(" ").some((name) => t.values.some((want, i) => compareValue(name, op, want, t.globs[i], matchCase)));
    return negated ? !hit : hit;
  }
  // Before a line is parsed for its fields: what is looked for must be in its text (it then holds for most lines).
  if (t.op === ":" || t.op === "=") {
    if (inText) {
      const lower = s.lower();
      if (!inText.some((v) => lower.includes(v))) return false;
    }
  } else if (t.op !== "!=" && !s.lower().includes(key.slice(key.lastIndexOf(".") + 1))) return false;
  const v = s.field(t.key);
  if (v !== undefined) return any(v);
  // Not a field of this line (a plain one): its message is all of it, anything else is looked for as written.
  if (key === "msg" || key === "message") return any(s.text());
  return matchCase ? s.text().includes(t.raw) : s.lower().includes(t.raw.toLowerCase());
}

/** The query as a test of a line: all terms hold (a `!` term must not). */
export function compile(q: Query): (s: Subject) => boolean {
  if (isEmpty(q)) return () => true;
  const matchCase = !!q.opts.matchCase;
  const tests = q.terms.map((t): ((s: Subject) => boolean) => {
    let test: (s: Subject) => boolean;
    if (t.kind === "text") {
      const needle = matchCase ? t.text : t.text.toLowerCase();
      test = matchCase ? (s) => s.text().includes(needle) : (s) => s.lower().includes(needle);
    } else if (t.kind === "regex") {
      const re = t.re;
      test = (s) => re.test(s.text());
    } else {
      // A value is in a line's text as it is, unless a log escapes it there (quotes, backslashes, control characters,
      // anything beyond ASCII): such values are looked for in the fields alone.
      const verbatim = !t.globs.some(Boolean) && t.values.every((v) => /^[\x20-\x7e]*$/.test(v) && !/["\\]/.test(v));
      const inText = verbatim ? t.values.map((v) => v.toLowerCase()) : null;
      test = (s) => fieldTest(t, s, matchCase, inText);
    }
    return t.not ? (s) => !test(s) : test;
  });
  // Cheap tests first: text, then regular expressions, then fields (they may parse the line).
  const rank = (t: Term) => (t.kind === "text" ? 0 : t.kind === "regex" ? 1 : 2);
  const order = q.terms.map((t, i) => [rank(t), i] as const).sort((a, b) => a[0] - b[0]);
  const sorted = order.map(([, i]) => tests[i]);
  return (s) => {
    for (const t of sorted) if (!t(s)) return false;
    return true;
  };
}

/** What a query highlights in a piece of text: [start, end) ranges, sorted and merged. */
export function highlighter(q: Query): (text: string) => [number, number][] {
  if (isEmpty(q)) return () => [];
  const matchCase = !!q.opts.matchCase;
  const needles: string[] = [];
  const res: RegExp[] = [];
  for (const t of q.terms) {
    if (t.not) continue;
    if (t.kind === "text") needles.push(matchCase ? t.text : t.text.toLowerCase());
    else if (t.kind === "regex") res.push(new RegExp(t.re.source, t.re.flags.includes("g") ? t.re.flags : `${t.re.flags}g`));
    else if ((t.op === ":" || t.op === "=") && t.key.toLowerCase() !== "level") {
      for (let i = 0; i < t.values.length; i++) if (!t.globs[i] && t.values[i].length > 1) needles.push(matchCase ? t.values[i] : t.values[i].toLowerCase());
    }
  }
  if (!needles.length && !res.length) return () => [];
  return (text) => {
    const out: [number, number][] = [];
    if (needles.length) {
      const hay = matchCase ? text : text.toLowerCase();
      for (const n of needles) {
        if (!n) continue;
        for (let at = hay.indexOf(n); at >= 0; at = hay.indexOf(n, at + n.length)) out.push([at, at + n.length]);
      }
    }
    for (const re of res) {
      re.lastIndex = 0;
      for (let m = re.exec(text), guard = 0; m && guard < 1000; m = re.exec(text), guard++) {
        if (m[0].length === 0) {
          re.lastIndex++;
          continue;
        }
        out.push([m.index, m.index + m[0].length]);
      }
    }
    if (out.length < 2) return out;
    out.sort((a, b) => a[0] - b[0]);
    const merged: [number, number][] = [out[0]];
    for (let i = 1; i < out.length; i++) {
      const last = merged[merged.length - 1];
      if (out[i][0] <= last[1]) last[1] = Math.max(last[1], out[i][1]);
      else merged.push(out[i]);
    }
    return merged;
  };
}

/** A value as a term writes it: quoted when it must be (blanks, quotes, commas, `*`, nothing at all). */
export function valueTerm(s: string): string {
  return s !== "" && !/[\s",]/.test(s) && !s.includes("*") ? s : JSON.stringify(s);
}

/** A term for a field's value, as clicking it adds it: `key=value`, quoted when it must be. */
export function fieldTerm(key: string, value: FieldValue, not = false): string {
  return `${not ? "!" : ""}${key}=${valueTerm(value === null ? "null" : String(value))}`;
}

/** A `key=value` term (`!`: left out) of the input: its values as written and as meant. */
function equalityOf(raw: string) {
  const not = raw.length > 1 && raw.startsWith("!");
  const f = FIELD.exec(not ? raw.slice(1) : raw);
  if (!f || f[2] !== "=") return null;
  const { spans, open } = scanItems(f[3]);
  const items = spans.map(([from, to]) => f[3].slice(from, to)).filter(Boolean);
  return { not, key: f[1].toLowerCase(), head: raw.slice(0, raw.length - f[3].length), items, values: items.map(unquote), open };
}

/**
 * Adds a term to the input. A value of a field the input has a term for, the same way (wanted, or left out), is one
 * more of its values (`key=a` and `key=b`: `key=a,b`, either); the same value the other way round goes (`!key=a` for
 * `key=a`). Values are told apart as the query matches them (`matchCase`).
 */
export function withTerm(input: string, term: string, matchCase = false): string {
  const trimmed = input.trim();
  if (!trimmed) return term;
  const tokens = tokenize(trimmed).map((t) => t.raw);
  if (tokens.includes(term)) return trimmed;
  const add = equalityOf(term);
  const has = (values: string[], v: string) => values.some((w) => (matchCase ? w === v : w.toLowerCase() === v.toLowerCase()));
  const out: string[] = [];
  let joined = false;
  for (const raw of tokens) {
    const t = add && equalityOf(raw);
    if (!add || !t || t.key !== add.key) out.push(raw);
    else if (t.not !== add.not) {
      const items = t.items.filter((_, i) => !has(add.values, t.values[i]));
      if (items.length === t.items.length) out.push(raw);
      else if (items.length) out.push(t.head + items.join(","));
    } else if (!joined && !t.open) {
      const more = add.items.filter((_, i) => !has(t.values, add.values[i]));
      out.push(more.length ? `${raw.replace(/,+$/, "")},${more.join(",")}` : raw);
      joined = true;
    } else out.push(raw);
  }
  if (!joined) {
    // (After a quote left open, the term would be in it: it goes before.)
    const at = out.length && tokenize(`${out[out.length - 1]} ${term}`).length < 2 ? out.length - 1 : out.length;
    out.splice(at, 0, term);
  }
  return out.join(" ");
}

/** Plain words for the query (a tooltip): `contains "a" · not "b" · status ≥ 500`. */
export function describeQuery(q: Query): string {
  if (q.error) return `Invalid regular expression: ${q.error}`;
  return q.terms
    .map((t) => {
      const no = t.not ? "not " : "";
      if (t.kind === "text") return `${t.not ? "without" : "with"} "${t.text}"`;
      if (t.kind === "regex") return `${no}matching /${t.re.source}/`;
      if (!t.values.length) return `${t.not ? "without" : "with"} ${t.key}`;
      const op = { ":": "contains", "=": "is", "!=": "is not", ">": ">", ">=": "≥", "<": "<", "<=": "≤" }[t.op];
      const key = t.key.toLowerCase() === "level" ? "level" : t.key;
      const values = key === "level" ? t.values.map((v) => {
            const l = levelNamed(v);
            return l === undefined ? v : LEVEL_NAME[l];
          }) : t.values;
      return `${no}${key} ${op} ${values.join(" or ")}`;
    })
    .join(" · ");
}
