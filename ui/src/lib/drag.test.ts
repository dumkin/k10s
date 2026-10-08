import { describe, expect, it } from "vitest";
import { trackDrag } from "./drag";

/** A drag from a press with pointer 3: what it heard. */
function pressed() {
  const heard: string[] = [];
  const stop = trackDrag(new PointerEvent("pointerdown", { pointerId: 3, clientX: 10 }), {
    move: (e) => heard.push(`move ${e.clientX}`),
    end: (e) => heard.push(e ? `end ${e.clientX}` : "taken away"),
  });
  return { heard, stop };
}

describe("trackDrag", () => {
  it("hears the moves of the pointer that pressed, past the element too, until it lets go", () => {
    const d = pressed();
    // (A move that says no button is held: events handed to the window by software.)
    window.dispatchEvent(new PointerEvent("pointermove", { pointerId: 3, clientX: 20, buttons: 0 }));
    // Another pointer's (a second finger): not this drag's.
    window.dispatchEvent(new PointerEvent("pointermove", { pointerId: 4, clientX: 99 }));
    window.dispatchEvent(new PointerEvent("pointerup", { pointerId: 4, clientX: 99 }));
    window.dispatchEvent(new PointerEvent("pointerup", { pointerId: 3, clientX: 30 }));
    window.dispatchEvent(new PointerEvent("pointermove", { pointerId: 3, clientX: 40 }));
    expect(d.heard).toEqual(["move 20", "end 30"]);
  });

  it.each([
    ["a context menu", () => window.dispatchEvent(new MouseEvent("contextmenu"))],
    ["the window losing the focus", () => window.dispatchEvent(new FocusEvent("blur"))],
    ["the pointer cancelled", () => window.dispatchEvent(new PointerEvent("pointercancel", { pointerId: 3 }))],
  ])("ends with nothing let go of when %s takes the release from the page", (_, takeRelease) => {
    const d = pressed();
    takeRelease();
    window.dispatchEvent(new PointerEvent("pointerup", { pointerId: 3, clientX: 30 }));
    expect(d.heard).toEqual(["taken away"]);
  });

  it("hears nothing more once stopped, and does not end", () => {
    const d = pressed();
    d.stop();
    window.dispatchEvent(new PointerEvent("pointermove", { pointerId: 3, clientX: 20 }));
    window.dispatchEvent(new PointerEvent("pointerup", { pointerId: 3, clientX: 30 }));
    expect(d.heard).toEqual([]);
  });
});
