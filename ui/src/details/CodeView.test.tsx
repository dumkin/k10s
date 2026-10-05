import { render } from "solid-js/web";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { CodeView, LINE_H } from "./CodeView";

beforeAll(() => {
  // jsdom has no layout.
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  document.body.innerHTML = "";
});

describe("CodeView", () => {
  it("keeps a line's node while it is on screen: a text selection in it scrolls with it", () => {
    const root = document.createElement("div");
    document.body.append(root);
    dispose = render(() => <CodeView count={5000} renderLine={(i) => `line ${i}`} />, root);
    const view = root.querySelector<HTMLDivElement>(".code")!;
    const node = (n: number) => [...view.querySelectorAll(".ln")].find((l) => l.querySelector(".txt")?.textContent === `line ${n}`);
    // Far enough for the rendered window to move (it overscans).
    view.scrollTop = 200 * LINE_H;
    view.dispatchEvent(new Event("scroll"));
    const before = node(210)!;
    view.scrollTop = 205 * LINE_H;
    view.dispatchEvent(new Event("scroll"));
    // The same node still shows the same line (not another line in its slot).
    expect(node(210)).toBe(before);
    expect(before.querySelector(".gutter")!.textContent).toBe("211");
  });
});
