import { render } from "solid-js/web";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { bind, installHotkeys } from "../lib/hotkeys";
import { createListNav, Popover } from "./Popover";

beforeAll(() => installHotkeys());

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  document.body.innerHTML = "";
});

/** Mounts a 10-item keyboard list and returns its highlight. */
function mountList(start = 5) {
  let nav!: ReturnType<typeof createListNav>;
  const root = document.createElement("div");
  document.body.append(root);
  dispose = render(() => {
    nav = createListNav(() => 10, () => root);
    nav.setIndex(start);
    return <input />;
  }, root);
  return () => nav.index();
}

const press = (init: KeyboardEventInit) => document.querySelector("input")!.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));

describe("createListNav", () => {
  it("moves with ⌃N / ⌃P, even where Ctrl+P is the palette shortcut (Linux, Windows)", () => {
    const opened: string[] = [];
    const off = bind({ combo: "mod+p", inInputs: true, priority: 50, run: () => void opened.push("palette") });
    const index = mountList();
    press({ key: "p", code: "KeyP", ctrlKey: true });
    expect(index()).toBe(4);
    press({ key: "n", code: "KeyN", ctrlKey: true });
    press({ key: "т", code: "KeyN", ctrlKey: true });
    expect(index()).toBe(6);
    expect(opened).toEqual([]);
    off();
  });

  it("releases ⌃P when the list closes", () => {
    const opened: string[] = [];
    const off = bind({ combo: "ctrl+p", inInputs: true, run: () => void opened.push("other") });
    mountList();
    dispose?.();
    dispose = undefined;
    document.body.append(document.createElement("input"));
    press({ key: "p", code: "KeyP", ctrlKey: true });
    expect(opened).toEqual(["other"]);
    off();
  });
});

describe("a menu", () => {
  it("runs the item whose key is pressed, moves with j / k, and jumps to an item by its first letter otherwise", async () => {
    const ran: string[] = [];
    const root = document.createElement("div");
    document.body.append(root);
    dispose = render(
      () => (
        <Popover anchor={{ x: 0, y: 0 }} onClose={() => ran.push("closed")}>
          <div class="menu" role="menu">
            <button class="opt" data-key="w" onClick={() => ran.push("wrap")}>
              <span>Wrap lines</span>
            </button>
            <button class="opt" onClick={() => ran.push("timestamps")}>
              <span>Timestamps</span>
            </button>
            <button class="opt" data-key="mod+s" onClick={() => ran.push("save")}>
              <span>Save shown lines…</span>
            </button>
          </div>
        </Popover>
      ),
      root,
    );
    await Promise.resolve();
    const items = [...document.querySelectorAll<HTMLButtonElement>(".menu .opt")];
    const key = (init: KeyboardEventInit) => {
      const e = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
      (document.activeElement ?? document.body).dispatchEvent(e);
      return e;
    };
    expect(document.activeElement).toBe(items[0]);
    key({ key: "t", code: "KeyT" });
    expect(document.activeElement).toBe(items[1]);
    key({ key: "j", code: "KeyJ" });
    expect(document.activeElement).toBe(items[2]);
    key({ key: "k", code: "KeyK" });
    expect(document.activeElement).toBe(items[1]);
    expect(ran).toEqual([]);
    expect(key({ key: "w", code: "KeyW" }).defaultPrevented).toBe(true);
    expect(key({ key: "s", code: "KeyS", ctrlKey: true }).defaultPrevented).toBe(true);
    expect(ran).toEqual(["wrap", "save"]);
  });
});
