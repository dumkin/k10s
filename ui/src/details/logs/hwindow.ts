import type { Piece } from "../../lib/logs/highlight";

// A nowrap row draws the beginning of its text only: as far as the screen's right edge, a margin on, in whole blocks.
// What is drawn stays where it is whatever the characters (tabs, CJK, emoji, any font): the text is cut on the right,
// never on the left. A row of a 7 KB line then lays out a few hundred characters instead of all of them.

/** Text is drawn in blocks of this many characters, up to the end of the window… */
export const HBLOCK = 128;
/** …which is the screen's right edge plus this many columns (a fast sideways fling's frames). */
export const H_MARGIN = 128;
/** Lines up to this long are drawn whole, in one go (as they always were). */
export const WHOLE = 3 * HBLOCK;
/** A block does not start inside a piece this short (a key, a value, a match): it starts after it. */
export const SNAP = 48;

/**
 * Where a text's blocks start (offsets in its joined pieces) and at least at which column each starts, its length, and
 * at most how many columns it takes.
 */
export interface Blocks {
  len: number;
  at: number[];
  lo: number[];
  cols: number;
}

/**
 * Columns a character takes at most: a tab up to the next stop of 4, ASCII and the Latin, Greek and Cyrillic letters
 * one, any other character of the basic plane (CJK…) two, each half of a surrogate pair (an emoji) one.
 */
function colsOf(text: string): number {
  let n = 0;
  for (let k = 0; k < text.length; k++) {
    const c = text.charCodeAt(k);
    n += c === 9 ? 4 : c <= 0x052f || (c >= 0xd800 && c <= 0xdfff) ? 1 : 2;
  }
  return n;
}

/**
 * Columns characters take at least: combining marks and joiners none, a surrogate pair's half and any character past
 * Cyrillic half (a fallback font may draw it narrower than a column), the rest one.
 */
function minColsOf(text: string, from: number, to: number): number {
  let n = 0;
  for (let k = from; k < to; k++) {
    const c = text.charCodeAt(k);
    if (c <= 0x02ff || (c >= 0x0370 && c <= 0x052f)) n++;
    else if (!((c >= 0x0300 && c <= 0x036f) || c === 0x200b || c === 0x200c || c === 0x200d || (c >= 0xfe00 && c <= 0xfe0f))) n += 0.5;
  }
  return n;
}

/** The blocks of a text in pieces: a start about every `HBLOCK` characters, moved past short pieces and surrogate pairs. */
export function blocksOf(pieces: readonly Piece[]): Blocks {
  const at = [0];
  const lo = [0];
  let pos = 0;
  let cols = 0;
  /** Columns at least before `pos`, and before the last block's start. */
  let min = 0;
  let next = HBLOCK;
  for (const p of pieces) {
    const t = p.text;
    const end = pos + t.length;
    cols += colsOf(t);
    while (next < end) {
      let b = next;
      if (next <= pos) b = pos;
      else if (t.length <= SNAP) {
        // A short piece is not split: the block starts after it.
        next = end;
        break;
      } else {
        const c = t.charCodeAt(b - pos);
        if (c >= 0xdc00 && c <= 0xdfff) b++;
        if (b >= end) {
          next = end;
          break;
        }
      }
      if (b > at[at.length - 1]) {
        at.push(b);
        lo.push(min + minColsOf(t, 0, b - pos));
      }
      next = b + HBLOCK;
    }
    min += minColsOf(t, 0, t.length);
    pos = end;
  }
  return { len: pos, at, lo, cols };
}

/**
 * Where the drawn text ends (in characters), with `c1` the column at the screen's right edge: it grows at once, and
 * shrinks only once a whole block of it is two blocks past the edge (scrolling back a little draws nothing anew).
 * `hold`: it only grows (a text selection in the rows keeps its text).
 */
export function textEnd(prev: number, c1: number, hold: boolean): number {
  const want = Math.max(WHOLE, Math.ceil((Math.max(0, c1) + H_MARGIN) / HBLOCK) * HBLOCK);
  if (want >= prev || hold) return Math.max(prev, want);
  return want <= prev - 2 * HBLOCK ? want : prev;
}
