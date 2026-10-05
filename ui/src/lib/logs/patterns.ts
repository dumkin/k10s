// Patterns: lines logged by the same statement, told apart from the values they carry. What varies between such
// lines — numbers, times, ids, addresses — is masked (`<*>`); what is left is the pattern. Thousands of lines become a
// dozen patterns with counts, so the one that is new, or only in one cluster, stands out; and one click hides the
// noise (health checks) or shows nothing but one pattern.

/** What stands for a masked value. */
export const WILDCARD = "<*>";

const MASK = new RegExp(
  [
    // Dates and times
    /\d{4}[-/]\d{2}[-/]\d{2}(?:[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?/.source,
    /\b\d{2}:\d{2}:\d{2}(?:[.,]\d+)?\b/.source,
    // UUIDs, IP addresses (with a port)
    /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/.source,
    /\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/.source,
    // Hex (hashes, addresses) and long mixed ids (pod names, tokens)
    /\b0x[0-9a-fA-F]+\b/.source,
    /\b(?=[0-9a-fA-F]*\d)[0-9a-fA-F]{8,}\b/.source,
    /\b(?=[\w-]*\d)(?=[\w-]*[A-Za-z])[\w-]{12,}\b/.source,
    // Numbers, with a unit
    /-?\d+(?:\.\d+)?(?:ms|µs|us|ns|s|m|h|[KMGT]i?B|B|%)?/.source,
  ].join("|"),
  "g",
);

/** Patterns are cut to this length: lines that agree this far are one pattern. */
const MAX = 160;

/** The pattern of a line's message (or of its plain text). */
export function patternOf(message: string): string {
  const head = message.length > 400 ? message.slice(0, 400) : message;
  let out = head.replace(MASK, WILDCARD).replace(/\s+/g, " ").trim();
  // Runs of values (a time and a duration…) are one.
  out = out.replace(/<\*>(?:[\s:,./-]*<\*>)+/g, WILDCARD);
  return out.length > MAX ? `${out.slice(0, MAX)}…` : out || "(empty line)";
}

/** Splits a pattern into its fixed text and its wildcards, for showing it. */
export function patternParts(pattern: string): { text: string; wild: boolean }[] {
  const out: { text: string; wild: boolean }[] = [];
  let at = 0;
  for (let i = pattern.indexOf(WILDCARD); i >= 0; i = pattern.indexOf(WILDCARD, at)) {
    if (i > at) out.push({ text: pattern.slice(at, i), wild: false });
    out.push({ text: WILDCARD, wild: true });
    at = i + WILDCARD.length;
  }
  if (at < pattern.length) out.push({ text: pattern.slice(at), wild: false });
  return out;
}

/** Ids of patterns, stable for the life of a log buffer: lines keep theirs (`Line.pat`). */
export class PatternIds {
  private ids = new Map<string, number>();
  readonly patterns: string[] = [];

  idOf(pattern: string): number {
    let id = this.ids.get(pattern);
    if (id === undefined) {
      id = this.patterns.length;
      this.patterns.push(pattern);
      this.ids.set(pattern, id);
    }
    return id;
  }
}
