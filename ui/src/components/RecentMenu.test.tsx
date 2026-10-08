import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { installHotkeys } from "../lib/hotkeys";
import { createRecentMenu } from "./RecentMenu";

// The menu on its own: where it opens, and its keys (the fields' own tests: ResourceView, LogViewer).

beforeAll(() => {
  installHotkeys();
  // jsdom does not scroll: the highlight is shown by doing nothing.
  Element.prototype.scrollIntoView ??= () => {};
});

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

/** A field whose box is laid out at `rect` (jsdom lays nothing out; its window is 1024 × 768). */
function field(rect: Partial<DOMRect>, align: "left" | "right" = "left") {
  const [list] = createSignal(["timeout", "level>=warn", "!healthz"]);
  const [text] = createSignal("");
  const picked: string[] = [];
  let input!: HTMLInputElement;
  let box!: HTMLDivElement;
  const root = document.createElement("div");
  document.body.append(root);
  dispose = render(() => {
    const menu = createRecentMenu({ input: () => input, anchor: () => box, align, list, text, pick: (e) => void picked.push(e), forget: () => {}, title: "Recent queries", empty: "Nothing yet" });
    return (
      <div ref={box}>
        <menu.Button icon="search" size={12} />
        <input ref={input} onKeyDown={(e) => menu.keyDown(e)} />
        <menu.View />
      </div>
    );
  }, root);
  vi.spyOn(box, "getBoundingClientRect").mockReturnValue({ x: 0, y: 0, left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}), ...rect });
  input.focus();
  const press = (init: KeyboardEventInit) => {
    const e = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
    input.dispatchEvent(e);
    return e;
  };
  return { press, picked };
}

const style = () => document.querySelector<HTMLElement>(".recent-menu")!.style;

describe("recent menu", () => {
  it("floats under its field, within the window, and over it where there is no room under it", () => {
    let f = field({ left: 100, right: 500, width: 400, top: 50, bottom: 74 });
    f.press({ key: "ArrowUp" });
    expect([style().top, style().bottom, style().left, style().maxHeight, style().minWidth]).toEqual(["79px", "", "100px", "300px", "400px"]);
    dispose?.();
    // A dock's field, low in the window: over it.
    f = field({ left: 100, right: 500, width: 400, top: 700, bottom: 724 });
    f.press({ key: "ArrowUp" });
    expect([style().top, style().bottom, style().maxHeight]).toEqual(["", "73px", "300px"]);
    dispose?.();
    // Lined up with the field's right edge, never past the window's left one.
    f = field({ left: 50, right: 200, width: 150, top: 50, bottom: 74 }, "right");
    f.press({ key: "ArrowUp" });
    expect([style().right, style().maxWidth, style().minWidth]).toEqual(["824px", "192px", "192px"]);
  });

  it("takes its keys while it is shown, ⌃N and ⌃P too, and leaves them to the field once it is gone", () => {
    const f = field({ left: 100, right: 500, width: 400, top: 50, bottom: 74 });
    const highlighted = () => document.querySelector(".recent-menu .opt.hl")?.textContent;
    expect(f.press({ key: "ArrowDown" }).defaultPrevented).toBe(false);
    f.press({ key: "ArrowUp" });
    expect(highlighted()).toBe("timeout");
    f.press({ key: "n", code: "KeyN", ctrlKey: true });
    f.press({ key: "ArrowDown" });
    expect(highlighted()).toBe("!healthz");
    f.press({ key: "p", code: "KeyP", ctrlKey: true });
    expect(f.press({ key: "Enter" }).defaultPrevented).toBe(true);
    expect([f.picked, document.querySelector(".recent-menu")]).toEqual([["level>=warn"], null]);
    expect(f.press({ key: "Enter" }).defaultPrevented).toBe(false);
  });
});
