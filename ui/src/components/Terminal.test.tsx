import { render } from "solid-js/web";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// xterm.js and its fit addon, as far as fitting goes: the box holds the cells the test says.
const xterm = vi.hoisted(() => ({ cells: { cols: 80, rows: 24 }, resizes: [] as [number, number][] }));
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    options = {};
    loadAddon(addon: { activate(term: unknown): void }) {
      addon.activate(this);
    }
    open() {}
    focus() {}
    write() {}
    dispose() {}
    onData() {}
    onBinary() {}
    onResize() {}
    resize(cols: number, rows: number) {
      xterm.resizes.push([cols, rows]);
      this.cols = cols;
      this.rows = rows;
    }
  },
}));
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    term!: { cols: number; rows: number; resize(cols: number, rows: number): void };
    activate(term: this["term"]) {
      this.term = term;
    }
    proposeDimensions() {
      return { ...xterm.cells };
    }
    fit() {
      const { cols, rows } = this.proposeDimensions();
      if (cols !== this.term.cols || rows !== this.term.rows) this.term.resize(cols, rows);
    }
  },
}));
vi.mock("../lib/backend", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/backend")>()),
  backend: () => ({ startTerminal: () => ({ input() {}, resize() {}, ack() {}, close() {} }) }),
}));

import { TerminalView } from "./Terminal";

/** The terminal's box observer (jsdom has no layout): its callback, until it is disconnected. */
let observed: (() => void) | undefined;
let dispose: (() => void) | undefined;
beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        observed = callback;
      }
      observe() {}
      disconnect() {
        observed = undefined;
      }
    },
  );
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(800);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(300);
});
afterEach(() => {
  dispose?.();
  dispose = undefined;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
  xterm.cells = { cols: 80, rows: 24 };
  xterm.resizes = [];
  document.body.innerHTML = "";
});

describe("TerminalView", () => {
  it("takes another height at once, and other columns once the box's width has stayed for a moment", () => {
    vi.useFakeTimers();
    const root = document.createElement("div");
    document.body.append(root);
    dispose = render(() => <TerminalView tab={{ id: 1, target: { kind: "shell", spec: { cluster: "prod-eu-z1", namespace: "shop", pod: "web-1", container: "app" } } }} visible={false} />, root);
    const boxResized = (cols: number, rows: number) => {
      xterm.cells = { cols, rows };
      observed!();
    };
    boxResized(80, 30);
    expect(xterm.resizes).toEqual([[80, 30]]);
    // The width moves on (an edge dragged): the columns wait for it to stay, and then take where it stopped.
    boxResized(70, 30);
    vi.advanceTimersByTime(80);
    boxResized(60, 30);
    vi.advanceTimersByTime(80);
    expect(xterm.resizes).toEqual([[80, 30]]);
    vi.advanceTimersByTime(20);
    expect(xterm.resizes).toEqual([
      [80, 30],
      [60, 30],
    ]);
    // Closed while it waits: nothing is fitted after.
    boxResized(50, 30);
    dispose();
    dispose = undefined;
    vi.advanceTimersByTime(200);
    expect([xterm.resizes.length, observed]).toEqual([2, undefined]);
  });
});
