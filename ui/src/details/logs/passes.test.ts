import { createMemo, createRoot, createSignal } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LogLine } from "../../lib/backend";
import { type Filter, LogBuffer } from "../logBuffer";
import { createPasses } from "./passes";

beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] }));
afterEach(() => vi.useRealTimers());

const errors: Filter = { key: "errors", test: (l) => l.text.startsWith("ERROR") };
const warnings: Filter = { key: "warnings", test: (l) => l.text.startsWith("WARN") };

/** A view as the log view reads it (the buffer's, again on every change), and how many passes counted it. */
function setup(wait?: () => number) {
  const b = new LogBuffer();
  const [version, setVersion] = createSignal(0);
  const [filter, setFilter] = createSignal(errors);
  return createRoot((dispose) => {
    const view = createMemo(() => (version(), b.view(filter())), undefined, { equals: false });
    const passes = createPasses(view, () => b, 400, wait);
    let n = 0;
    const counted = createMemo(() => (passes.lines(), ++n));
    const add = (...lines: LogLine[]) => {
      b.add(lines);
      setVersion((v) => v + 1);
    };
    return { add, setFilter, passes, counted, dispose };
  });
}

describe("passes over a view of the lines", () => {
  it("count lines that come at most every so often, and only when the view changed", () => {
    const p = setup();
    expect(p.counted()).toBe(1);
    p.add([0, 1, "ERROR a"]);
    vi.advanceTimersByTime(399);
    expect(p.counted()).toBe(1);
    vi.advanceTimersByTime(1);
    expect(p.counted()).toBe(2);
    // Batches meanwhile: one pass.
    p.add([0, 2, "ERROR b"]);
    p.add([0, 3, "ERROR c"]);
    vi.advanceTimersByTime(400);
    expect(p.counted()).toBe(3);
    // Lines the view leaves out (filtered out, or come while paused): none.
    p.add([0, 4, "INFO d"]);
    vi.advanceTimersByTime(1000);
    expect(p.counted()).toBe(3);
    // A while after the last pass: the next one at once (on the next turn).
    p.add([0, 5, "ERROR e"]);
    vi.advanceTimersByTime(0);
    expect(p.counted()).toBe(4);
    p.dispose();
  });

  it("count another view at once, and drop a pass that waited for the one before", () => {
    const p = setup();
    p.add([0, 1, "ERROR a"]);
    expect(p.counted()).toBe(1);
    p.setFilter(warnings);
    expect(p.counted()).toBe(2);
    vi.advanceTimersByTime(1000);
    expect(p.counted()).toBe(2);
    p.dispose();
  });

  it("do another pass when asked, and wait while told to", () => {
    let held = 0;
    const p = setup(() => held);
    p.passes.soon(16);
    vi.advanceTimersByTime(16);
    expect(p.counted()).toBe(2);
    held = 1000;
    p.add([0, 1, "ERROR a"]);
    vi.advanceTimersByTime(900);
    expect(p.counted()).toBe(2);
    held = 0;
    p.passes.release();
    vi.advanceTimersByTime(0);
    expect(p.counted()).toBe(3);
    p.dispose();
  });
});
