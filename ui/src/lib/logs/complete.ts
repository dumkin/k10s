import { FIELD_NAME, type Op, OPS, scanItems, tokenize, unquote, valueTerm } from "./query";

// Completing a query as it is typed: where a term's field name is typed, the fields there are; after its operator,
// that field's values.

/** What the caret is in: a field's name, or a field's value (after its operator). */
export type Spot =
  /** `from`…`to`: the name (all of it, the caret may be inside); `op`: the operator after it, if there is one. */
  | { kind: "key"; prefix: string; from: number; to: number; op: Op | null }
  /** `from`…`to`: the value (the item of a list `a,"b c"` the caret is in); `quoted`: it starts with a quote. */
  | { kind: "value"; key: string; op: Op; prefix: string; from: number; to: number; quoted: boolean; list: boolean };

/**
 * The spot of the caret in `input`. A field's name is only taken for one where it may start a term (a word of
 * name characters, or one followed by an operator). `explicit` (asked for): also between terms and after `!`.
 */
export function spotAt(input: string, caret: number, explicit = false): Spot | null {
  const tok = tokenize(input).find((t) => t.start <= caret && caret <= t.end);
  if (!tok) return explicit ? { kind: "key", prefix: "", from: caret, to: caret, op: null } : null;
  let at = tok.start;
  if (input[at] === "!") at++;
  // A regular expression or a phrase: words, not fields.
  if (caret < at || input[at] === "/" || input[at] === '"') return null;
  const name = FIELD_NAME.exec(input.slice(at, tok.end))?.[0] ?? "";
  const keyEnd = at + name.length;
  const op = OPS.find((o) => input.startsWith(o, keyEnd) && keyEnd + o.length <= tok.end) ?? null;
  if (caret <= keyEnd) {
    if (!name && !explicit) return null;
    // Other characters after the name ("a/b", "x(1)"): a word, not a field.
    if (keyEnd < tok.end && !op) return null;
    return { kind: "key", prefix: input.slice(at, caret), from: at, to: keyEnd, op };
  }
  if (!name || !op) return null;
  const start = keyEnd + op.length;
  if (caret < start) return null;
  // The item the caret is in (a list `a,"b, c"` has two).
  const items = scanItems(input.slice(start, tok.end)).spans;
  const [itemFrom, itemTo] = items.find(([, to]) => caret <= start + to)!;
  const from = start + itemFrom;
  const to = start + itemTo;
  const list = items.length > 1;
  if (input[from] === '"') {
    // What is typed of it, as the query reads it (its quote closed if still open).
    const typed = input.slice(from, caret);
    const prefix = unquote(scanItems(typed).open ? `${typed}"` : typed);
    return { kind: "value", key: name, op, prefix, from, to, quoted: true, list };
  }
  return { kind: "value", key: name, op, prefix: input.slice(from, caret), from, to, quoted: false, list };
}

/**
 * `input` with `text` taken at `spot`, and where the caret goes: after a name, its operator (`:` unless it had one)
 * — its values come next; after a value (quoted when it must be), a blank — the next term.
 */
export function applyAt(input: string, spot: Spot, text: string): { input: string; caret: number } {
  if (spot.kind === "key") {
    const insert = spot.op ? text : `${text}:`;
    return { input: input.slice(0, spot.from) + insert + input.slice(spot.to), caret: spot.from + insert.length + (spot.op?.length ?? 0) };
  }
  const value = spot.quoted ? JSON.stringify(text) : valueTerm(text);
  let out = input.slice(0, spot.from) + value + input.slice(spot.to);
  let caret = spot.from + value.length;
  if (!spot.list && caret === out.length) {
    out += " ";
    caret++;
  }
  return { input: out, caret };
}

export interface Candidate {
  text: string;
  count?: number;
  hint?: string;
}

/** Characters a word starts after, in names and values (`trace_id`, `http.status`, `web-7f9c`). */
const BOUNDARY = /[_.\-@/:\s]/;

/**
 * The candidates that contain what is typed (any case), best first: the one that is it, those that start with it,
 * those with a word that does, then the rest — each group by count (most first) when `byCount`, else as given.
 * `at`: the characters matched; `score`: the group (-1…2).
 */
export function rank<T extends Candidate>(items: readonly T[], typed: string, byCount = true, max = 50): (T & { at: number[]; score: number })[] {
  const want = typed.toLowerCase();
  const out: (T & { at: number[]; score: number; order: number })[] = [];
  items.forEach((it, order) => {
    if (!want) {
      out.push({ ...it, at: [], score: 0, order });
      return;
    }
    const hay = it.text.toLowerCase();
    let k = hay.indexOf(want);
    if (k < 0) return;
    let score = k === 0 ? (hay.length === want.length ? -1 : 0) : 2;
    // A later word that starts with it is a better match than the first place it is found.
    for (let j = k; score === 2 && j >= 0; j = hay.indexOf(want, j + 1)) {
      if (BOUNDARY.test(hay[j - 1] ?? "") || (it.text[j] !== hay[j] && it.text[j - 1] === hay[j - 1])) {
        score = 1;
        k = j;
      }
    }
    out.push({ ...it, at: Array.from({ length: want.length }, (_, n) => k + n), score, order });
  });
  out.sort((a, b) => a.score - b.score || (byCount ? (b.count ?? 0) - (a.count ?? 0) : 0) || a.order - b.order);
  return out.slice(0, max).map(({ order: _, ...rest }) => rest as T & { at: number[]; score: number });
}
