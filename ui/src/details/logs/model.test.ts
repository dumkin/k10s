import { describe, expect, it } from "vitest";
import type { Line } from "../logBuffer";
import { Structures } from "./model";

const line = (text: string): Line => ({ i: 0, ts: 0, key: 0, text, width: text.length, lvl: 0, ansi: false, pos: 0, seq: 0 });

describe("Structures", () => {
  it("keeps the parses of so many lines, and of so much text, the oldest going first", () => {
    const few = new Structures(10, 1e9);
    const lines = Array.from({ length: 30 }, (_, k) => line(`{"k":${k}}`));
    for (const l of lines) few.get(l);
    expect(few.get(lines[29])).toEqual({ kind: "json", fields: [["k", 29]] });
    const big = `{"v":"${"x".repeat(1000)}"}`;
    const small = new Structures(1000, 5000);
    const huge = Array.from({ length: 20 }, () => line(big));
    for (const l of huge) small.get(l);
    // At most five of them held (a tenth goes at a time): the first one is parsed anew, the same as before.
    const first = small.get(huge[0]);
    expect(first?.fields[0][0]).toBe("v");
    expect((small as unknown as { chars: number }).chars).toBeLessThanOrEqual(5000 + big.length);
  });
});
