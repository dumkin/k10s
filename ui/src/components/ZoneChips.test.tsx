import { describe, expect, it } from "vitest";
import { fitOnFirstLine } from "./ZoneChips";

/** A wrapping line `width` wide holding chips of these widths, laid out as the browser would (4px gaps). */
function line(width: number, chips: number[]) {
  const el = document.createElement("span");
  Object.defineProperty(el, "clientWidth", { value: width });
  let x = 0;
  let y = 0;
  chips.forEach((w, i) => {
    if (i > 0 && x + w > width) {
      x = 0;
      y += 22;
    }
    const chip = document.createElement("span");
    Object.defineProperties(chip, { offsetLeft: { value: x }, offsetTop: { value: y }, offsetWidth: { value: w } });
    el.append(chip);
    x += w + 4;
  });
  return el;
}

describe("fitOnFirstLine", () => {
  it("counts the chips that fit whole on the first line", () => {
    expect(fitOnFirstLine(line(200, [30, 30, 30]))).toBe(3);
    // 30 + 4 + 30 + 4 + 40 = 108: the 50 wide one goes to the next line, and so do the rest.
    expect(fitOnFirstLine(line(140, [30, 30, 40, 50, 30]))).toBe(3);
    expect(fitOnFirstLine(line(200, []))).toBe(0);
  });

  it("does not count a first chip wider than the line (it stays there, cut)", () => {
    expect(fitOnFirstLine(line(24, [30, 30]))).toBe(0);
  });
});
