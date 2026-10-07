import { afterEach, describe, expect, it, vi } from "vitest";
import { type SplitterDragSpec, splitterDrag } from "./splitter";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  document.body.innerHTML = "";
});

/** A handle that drags a 300px panel (200…500), and what the drag showed and set. */
function handle(spec: Partial<SplitterDragSpec> = {}) {
  vi.useFakeTimers();
  const el = document.createElement("div");
  document.body.append(el);
  let size = 300;
  const shown: number[] = [];
  const set: number[] = [];
  const drag = splitterDrag({
    value: () => size,
    set: (v) => set.push((size = v)),
    preview: (v) => shown.push(v),
    min: () => 200,
    max: () => 500,
    grow: "ArrowRight",
    ...spec,
  });
  el.addEventListener("mousedown", drag);
  el.addEventListener("pointerdown", drag);
  const take = (x: number, y = 0, init: MouseEventInit = {}) => el.dispatchEvent(new MouseEvent("mousedown", { clientX: x, clientY: y, cancelable: true, ...init }));
  const move = (x: number, y = 0, buttons = 1) => window.dispatchEvent(new MouseEvent("mousemove", { clientX: x, clientY: y, buttons }));
  const letGo = () => window.dispatchEvent(new MouseEvent("mouseup"));
  return { el, shown, set, take, move, letGo };
}

describe("splitterDrag", () => {
  it("follows the pointer from where it took the handle, within the bounds, at most once a frame", () => {
    const h = handle();
    const frames = vi.spyOn(window, "requestAnimationFrame");
    h.take(100);
    expect(h.el.classList.contains("dragging")).toBe(true);
    for (let x = 101; x <= 120; x++) h.move(x);
    expect([frames.mock.calls.length, h.shown]).toEqual([1, []]);
    vi.advanceTimersToNextFrame();
    expect(h.shown).toEqual([320]);
    h.move(1000);
    vi.advanceTimersToNextFrame();
    h.move(-1000);
    vi.advanceTimersToNextFrame();
    expect(h.shown).toEqual([320, 500, 200]);
    expect(h.set).toEqual([]);
    h.letGo();
    expect([h.set, h.el.classList.contains("dragging")]).toEqual([[200], false]);
    // Let go: moves are not the drag's any more.
    h.move(400);
    vi.advanceTimersToNextFrame();
    expect([h.shown, h.set]).toEqual([[320, 500, 200], [200]]);
  });

  it("grows the way the handle's arrow key does", () => {
    const left = handle({ grow: "ArrowLeft" });
    left.take(100);
    left.move(70);
    left.letGo();
    const up = handle({ grow: "ArrowUp" });
    up.take(0, 100);
    up.move(0, 70);
    up.letGo();
    const down = handle({ grow: "ArrowDown" });
    down.take(0, 100);
    down.move(0, 70);
    down.letGo();
    expect([left.set, up.set, down.set]).toEqual([[330], [330], [270]]);
  });

  it("sets nothing for a click, and the last size at once when let go before its frame", () => {
    const h = handle();
    h.take(100);
    h.letGo();
    expect(h.set).toEqual([]);
    h.take(100);
    h.move(110);
    h.letGo();
    expect(h.set).toEqual([310]);
    vi.advanceTimersToNextFrame();
    expect(h.shown).toEqual([]);
  });

  it("takes the primary button only, and leaves the others theirs", () => {
    const h = handle();
    const notPrevented = h.take(100, 0, { button: 2 });
    expect([notPrevented, h.el.classList.contains("dragging")]).toEqual([true, false]);
    h.move(150, 0, 2);
    vi.advanceTimersToNextFrame();
    h.letGo();
    expect([h.shown, h.set]).toEqual([[], []]);
  });

  // A native context menu takes the release of its own (a ctrl-click on macOS starts a drag, then opens one), and
  // another window may take the focus mid-drag.
  it.each([
    ["a context menu", () => window.dispatchEvent(new MouseEvent("contextmenu"))],
    ["the window losing the focus", () => window.dispatchEvent(new FocusEvent("blur"))],
  ])("ends with %s, which takes the release from the page", (_, takeRelease) => {
    const h = handle();
    h.take(100);
    h.move(110);
    vi.advanceTimersToNextFrame();
    takeRelease();
    expect([h.set, h.el.classList.contains("dragging")]).toEqual([[310], false]);
    h.move(200);
    vi.advanceTimersToNextFrame();
    expect([h.shown, h.set]).toEqual([[310], [310]]);
  });

  it("goes on through moves that say no button is held (events handed to the window by software)", () => {
    const h = handle();
    h.take(100);
    h.move(120, 0, 0);
    vi.advanceTimersToNextFrame();
    h.letGo();
    expect([h.shown, h.set]).toEqual([[320], [320]]);
  });

  it("follows pointer events when taken by one", () => {
    const h = handle({ grow: "ArrowUp" });
    h.el.dispatchEvent(new PointerEvent("pointerdown", { clientY: 100, cancelable: true }));
    window.dispatchEvent(new PointerEvent("pointermove", { clientY: 60, buttons: 1 }));
    vi.advanceTimersToNextFrame();
    window.dispatchEvent(new PointerEvent("pointerup"));
    expect([h.shown, h.set]).toEqual([[340], [340]]);
  });

  it("shows each frame's size with `set` when there is no preview", () => {
    const h = handle({ preview: undefined });
    h.take(100);
    h.move(120);
    vi.advanceTimersToNextFrame();
    h.move(130);
    vi.advanceTimersToNextFrame();
    h.letGo();
    expect(h.set).toEqual([320, 330, 330]);
  });
});
