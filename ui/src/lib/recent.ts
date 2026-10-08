import type { Accessor } from "solid-js";
import { arrayOf, isString, persisted } from "./persist";

// Filters and queries used lately: a field offers them again (↑ in it, or a click on its icon, see RecentMenu).

/**
 * How long a filter must have stood before it is cleared to count as used: long enough to look at what it shows. One
 * typed and dropped at once (a typo) is not remembered; ↵ or the keyboard leaving the field remember it at once.
 */
export const KEPT_MS = 1500;

/** What was used lately: the most recent first, each once, kept between starts. */
export interface RecentList {
  list: Accessor<string[]>;
  /**
   * Puts it first (trimmed; a single character is not worth keeping). `chosen`: when the user chose the text standing in
   * the field, typed or picked it (see `moment`): one forgotten since — that entry, or all of them — is not brought back
   * by the field still holding it.
   */
  remember(text: string, chosen?: number): void;
  forget(text: string): void;
  clear(): void;
}

/** When things happen here, in order: what was chosen, forgotten. (Not the clock: it may go back.) */
let moments = 0;
export const moment = () => ++moments;

/** A list kept in state.json at `key`, of `limit` entries at most (the oldest go first). */
export function recentList(key: string, limit: number): RecentList {
  const [list, setList] = persisted<string[]>(key, [], arrayOf(isString));
  /** When an entry was forgotten, and when all of them were (in this run: fields hold their text no longer). */
  const forgotten = new Map<string, number>();
  let cleared = -Infinity;
  return {
    list,
    remember(text, chosen = moment()) {
      const s = text.trim();
      if (s.length < 2 || chosen < cleared || chosen < (forgotten.get(s) ?? -Infinity)) return;
      // Leaving the field remembers what it holds: often what was just picked or remembered on ↵.
      if (list()[0] !== s) setList([s, ...list().filter((x) => x !== s)].slice(0, limit));
    },
    forget(text) {
      forgotten.set(text, moment());
      if (list().includes(text)) setList(list().filter((x) => x !== text));
    },
    clear() {
      cleared = moment();
      forgotten.clear();
      setList([]);
    },
  };
}

/**
 * How a field's text is used, for its `RecentList`: when the text took its place and when the user chose it, so that a
 * text cleared at once (a typo) or one that showed nothing is not remembered, and one forgotten while it stands in the
 * field is not brought back.
 */
export interface RecentUse {
  /** The field holds a text the user typed or picked. */
  changed(): void;
  /** …or one put back from history: the user chose it before, and it is new to the screen. */
  restored(): void;
  /** It was used: ↵, the keyboard left the field, it was picked. */
  used(text: string): void;
  /** It goes (cleared, another view's took its place): remembered if it stood long enough to be looked at, and showed something. */
  dropped(text: string, showed: boolean): void;
}

export function recentUse(recent: RecentList): RecentUse {
  /** When the text took its place (the clock: how long it stood), and when the user chose it (see `moment`). */
  let since = Date.now();
  let chosen = moment();
  return {
    changed() {
      since = Date.now();
      chosen = moment();
    },
    restored() {
      since = Date.now();
      chosen = -Infinity;
    },
    used: (text) => recent.remember(text, chosen),
    dropped(text, showed) {
      if (showed && Date.now() - since >= KEPT_MS) recent.remember(text, chosen);
    },
  };
}
