import type { Accessor } from "solid-js";
import { arrayOf, isString, persisted } from "./persist";

// Filters and queries used lately: a field offers them again (↑ in it, or a click on its icon, see RecentMenu).

/**
 * How long a filter must have stood before it is cleared or replaced to count as used: long enough to look at what it
 * shows. One typed and dropped at once (a typo) is not remembered; leaving the field or Enter remembers it at once.
 */
export const KEPT_MS = 1500;

/** What was used lately: the most recent first, each once, kept between starts. */
export interface RecentList {
  list: Accessor<string[]>;
  /** Puts it first (trimmed); a single character is not worth keeping. */
  remember(text: string): void;
  forget(text: string): void;
  clear(): void;
}

/** A list kept in state.json at `key`, of `limit` entries at most (the oldest go first). */
export function recentList(key: string, limit: number): RecentList {
  const [list, setList] = persisted<string[]>(key, [], arrayOf(isString));
  return {
    list,
    remember(text) {
      const s = text.trim();
      // Leaving the field remembers what it holds: often what was just picked or remembered on Enter.
      if (s.length < 2 || list()[0] === s) return;
      setList([s, ...list().filter((x) => x !== s)].slice(0, limit));
    },
    forget(text) {
      if (list().includes(text)) setList(list().filter((x) => x !== text));
    },
    clear: () => setList([]),
  };
}
