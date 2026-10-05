/**
 * Small fuzzy matcher for the command palette: subsequence match with bonuses for word starts,
 * consecutive runs and prefix hits. Returns `null` when `query` is not a subsequence of `text`.
 */
export interface FuzzyMatch {
  score: number;
  /** Indices in `text` that matched, for highlighting. */
  indices: number[];
}

const SEPARATORS = new Set([" ", "-", "_", ".", "/", ":"]);

export function fuzzy(query: string, text: string): FuzzyMatch | null {
  if (!query) return { score: 0, indices: [] };
  const q = query.toLowerCase();
  const t = text.toLowerCase();

  // Fast path: a contiguous substring is always the best kind of hit. A subsequence match earns at
  // most 37 per query character, so the substring score grows with the query to stay above it.
  const at = t.indexOf(q);
  if (at >= 0) {
    const startBonus = at === 0 ? 100 : SEPARATORS.has(t[at - 1]) ? 60 : 0;
    const exact = t.length === q.length ? 50 : 0;
    return { score: 200 + 40 * q.length + startBonus + exact - at - (t.length - q.length) * 0.1, indices: Array.from({ length: q.length }, (_, i) => at + i) };
  }

  const indices: number[] = [];
  let score = 0;
  let ti = 0;
  let prev = -2;
  for (let qi = 0; qi < q.length; qi++) {
    const ch = q[qi];
    if (ch === " ") continue;
    let found = -1;
    // Prefer a word-start occurrence ahead, otherwise the next occurrence.
    for (let j = ti; j < t.length; j++) {
      if (t[j] !== ch) continue;
      if (found < 0) found = j;
      if (j === 0 || SEPARATORS.has(t[j - 1])) {
        found = j;
        break;
      }
    }
    if (found < 0) return null;
    const wordStart = found === 0 || SEPARATORS.has(t[found - 1]);
    score += 10 + (wordStart ? 15 : 0) + (found === prev + 1 ? 12 : 0) - Math.min(found - ti, 10);
    indices.push(found);
    prev = found;
    ti = found + 1;
  }
  return { score: score - t.length * 0.05, indices };
}

/** Ranks `items` by best match over the strings returned by `fields`. */
export function rank<T>(query: string, items: T[], fields: (item: T) => string[]): { item: T; match: FuzzyMatch; field: number }[] {
  const out: { item: T; match: FuzzyMatch; field: number }[] = [];
  for (const item of items) {
    let best: FuzzyMatch | null = null;
    let field = 0;
    fields(item).forEach((f, i) => {
      const m = fuzzy(query, f);
      // The primary field (index 0) wins ties so highlights land on the visible title.
      if (m && (!best || m.score > best.score + (i === 0 ? -1 : 0))) {
        best = m;
        field = i;
      }
    });
    if (best) out.push({ item, match: best, field });
  }
  return out.sort((a, b) => b.match.score - a.match.score);
}
