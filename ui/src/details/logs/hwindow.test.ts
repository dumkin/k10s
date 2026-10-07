import { describe, expect, it } from "vitest";
import { type Piece, slicePieces } from "../../lib/logs/highlight";
import { blocksOf, HBLOCK, SNAP, textEnd, WHOLE } from "./hwindow";

const join = (ps: readonly Piece[]) => ps.map((p) => p.text).join("");

describe("blocks of a long line", () => {
  it("cut it about every HBLOCK characters, and put it back together whole", () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
    for (let run = 0; run < 200; run++) {
      const pieces: Piece[] = [];
      const n = 1 + Math.floor(rnd() * 60);
      for (let k = 0; k < n; k++) {
        const len = rnd() < 0.5 ? 1 + Math.floor(rnd() * 20) : Math.floor(rnd() * 400);
        let text = "";
        for (let c = 0; c < len; c++) text += rnd() < 0.02 ? "😀" : rnd() < 0.02 ? "界" : rnd() < 0.05 ? "ж" : String.fromCharCode(97 + Math.floor(rnd() * 26));
        pieces.push({ text, cls: k % 2 ? "t-str" : undefined });
      }
      const b = blocksOf(pieces);
      const text = join(pieces);
      expect(b.len).toBe(text.length);
      expect(b.at[0]).toBe(0);
      let whole = "";
      for (let k = 0; k < b.at.length; k++) {
        const from = b.at[k];
        const to = b.at[k + 1] ?? b.len;
        expect(to).toBeGreaterThan(from);
        // No block starts inside a surrogate pair.
        const c = text.charCodeAt(from);
        expect(c >= 0xdc00 && c <= 0xdfff).toBe(false);
        whole += join(slicePieces(pieces, from, to));
      }
      expect(whole).toBe(text);
      // Short pieces are never split.
      let pos = 0;
      for (const p of pieces) {
        if (p.text.length <= SNAP) for (const a of b.at) expect(a > pos && a < pos + p.text.length).toBe(false);
        pos += p.text.length;
      }
    }
  });

  it("count columns at most: Cyrillic one, CJK two, a tab four", () => {
    expect(blocksOf([{ text: "abc" }]).cols).toBe(3);
    expect(blocksOf([{ text: "жук" }]).cols).toBe(3);
    expect(blocksOf([{ text: "日本" }]).cols).toBe(4);
    expect(blocksOf([{ text: "a\tb" }]).cols).toBe(6);
    expect(blocksOf([{ text: "😀" }]).cols).toBe(2);
    expect(blocksOf([{ text: "x".repeat(1000) }]).at).toEqual([0, 128, 256, 384, 512, 640, 768, 896]);
    // Where blocks start, in columns at least: as many as characters for Latin text, fewer for combining marks.
    expect(blocksOf([{ text: "x".repeat(300) }]).lo).toEqual([0, 128, 256]);
    expect(blocksOf([{ text: "e\u0301".repeat(200) }]).lo).toEqual([0, 64, 128, 192]);
  });
});

describe("the end of the text drawn", () => {
  it("starts with whole short lines, grows at once and shrinks a block late", () => {
    expect(textEnd(0, 0, false)).toBe(WHOLE);
    expect(textEnd(WHOLE, 200, false)).toBe(WHOLE);
    expect(textEnd(WHOLE, 300, false)).toBe(Math.ceil((300 + 128) / HBLOCK) * HBLOCK);
    const far = textEnd(WHOLE, 2000, false);
    expect(far).toBe(2176);
    // Back a little: nothing drawn anew; far back: it shrinks.
    expect(textEnd(far, 1900, false)).toBe(far);
    expect(textEnd(far, 200, false)).toBe(WHOLE);
    // Held (a selection): it only grows.
    expect(textEnd(far, 200, true)).toBe(far);
  });
});
