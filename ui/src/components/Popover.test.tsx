import { render } from "solid-js/web";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { bind, installHotkeys } from "../lib/hotkeys";
import { createListNav } from "./Popover";

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
