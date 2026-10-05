import { afterEach, describe, expect, it, vi } from "vitest";
import { closeDetails, openDetails, setDetailsFull } from "../state/nav";
import { collectHints } from "./KeyHints";

afterEach(() => {
  closeDetails();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

/** A hinted control at `x, y` (jsdom has no layout: its box is made up). */
function control(attrs: Record<string, string>, box = { x: 100, y: 100, w: 80, h: 24 }, parent: HTMLElement = document.body) {
  const el = document.createElement("button");
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  el.getBoundingClientRect = () => new DOMRect(box.x, box.y, box.w, box.h);
  parent.append(el);
  return el;
}

describe("collectHints", () => {
  it("badges the controls with keys, where they ask for it", () => {
    control({ "data-hint": "mod+shift+c" });
    control({ "data-hint": "f", "data-hint-at": "below" }, { x: 300, y: 10, w: 26, h: 26 });
    control({ "data-hint": "" });
    control({ "data-hint": "mod+1" }, { x: 0, y: 0, w: 0, h: 0 });
    const hints = collectHints();
    expect(hints.map((h) => h.label)).toEqual([expect.stringMatching(/^(⌘⇧C|Ctrl\+Shift\+C)$/), "F"]);
    // Inside at the right end by default; centred under the control when asked.
    expect([hints[0].at, hints[0].x, hints[0].y]).toEqual(["right", 174, 112]);
    expect([hints[1].at, hints[1].x, hints[1].y]).toEqual(["below", 313, 40]);
  });

  it("skips controls that can't be seen: covered by a popover, or out of the window", () => {
    const covered = control({ "data-hint": "j" });
    const shown = control({ "data-hint": "k" }, { x: 10, y: 300, w: 80, h: 24 });
    control({ "data-hint": "g" }, { x: 10, y: window.innerHeight + 20, w: 80, h: 24 });
    const inner = document.createElement("span");
    shown.append(inner);
    const backdrop = document.createElement("div");
    document.body.append(backdrop);
    document.elementFromPoint = (_x: number, y: number) => (y < 200 ? backdrop : inner);
    try {
      expect(collectHints().map((h) => h.label)).toEqual(["K"]);
      expect(covered.isConnected).toBe(true);
    } finally {
      delete (document as { elementFromPoint?: unknown }).elementFromPoint;
    }
  });

  it("shows a key only while the part of the app it works in has the keyboard", () => {
    control({ "data-hint": "/", "data-hint-ctx": "table" });
    control({ "data-hint": "w", "data-hint-ctx": "details" });
    control({ "data-hint": "mod+k" });
    const labels = () => collectHints().map((h) => h.label);
    expect(labels()).toEqual(["/", expect.stringMatching(/K$/)]);
    // The details fill the window: their keys, not the table's.
    openDetails("z1/pod-1");
    setDetailsFull(true);
    expect(labels()).toEqual(["W", expect.stringMatching(/K$/)]);
    // Side by side again, with focus in the panel: the same.
    setDetailsFull(false);
    const panel = document.createElement("aside");
    panel.className = "details";
    const field = document.createElement("button");
    panel.append(field);
    document.body.append(panel);
    field.focus();
    expect(labels()).toEqual(["W", expect.stringMatching(/K$/)]);
  });
});
