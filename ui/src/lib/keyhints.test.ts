import { afterEach, describe, expect, it, vi } from "vitest";

type KeyHints = typeof import("./keyhints");

/** A fresh copy of the module as it behaves on macOS or elsewhere (`isMac` is read once, at import). */
async function load(platform: "MacIntel" | "Linux x86_64"): Promise<KeyHints & { off: () => void }> {
  vi.resetModules();
  vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
  const mod = await import("./keyhints");
  return { ...mod, off: mod.installKeyHints() };
}

let off: (() => void) | undefined;
afterEach(() => {
  off?.();
  off = undefined;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const down = (init: KeyboardEventInit) => window.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, ...init }));
const up = (init: KeyboardEventInit) => window.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, ...init }));
const META = { key: "Meta", code: "MetaLeft", metaKey: true };

describe("key hints", () => {
  it("show while ⌘ is held alone, and go when it is let go", async () => {
    vi.useFakeTimers();
    const h = await load("MacIntel");
    off = h.off;
    down(META);
    vi.advanceTimersByTime(h.HINTS_DELAY_MS - 1);
    expect(h.hintsShown()).toBe(false);
    vi.advanceTimersByTime(1);
    expect(h.hintsShown()).toBe(true);
    // Shift added (looking for ⌘⇧…): they stay.
    down({ key: "Shift", code: "ShiftLeft", metaKey: true, shiftKey: true });
    expect(h.hintsShown()).toBe(true);
    up({ key: "Meta", code: "MetaLeft" });
    expect(h.hintsShown()).toBe(false);
  });

  it("never flash for a shortcut typed quickly, and go once one is typed", async () => {
    vi.useFakeTimers();
    const h = await load("MacIntel");
    off = h.off;
    down(META);
    vi.advanceTimersByTime(100);
    down({ key: "k", code: "KeyK", metaKey: true });
    vi.advanceTimersByTime(h.HINTS_DELAY_MS * 2);
    expect(h.hintsShown()).toBe(false);
    up({ key: "Meta", code: "MetaLeft" });

    down(META);
    vi.advanceTimersByTime(h.HINTS_DELAY_MS);
    expect(h.hintsShown()).toBe(true);
    down({ key: "1", code: "Digit1", metaKey: true });
    expect(h.hintsShown()).toBe(false);
  });

  it("go when the app loses the keyboard or the mouse is used (⌘-Tab, ⌘-click)", async () => {
    vi.useFakeTimers();
    const h = await load("MacIntel");
    off = h.off;
    for (const leave of [() => window.dispatchEvent(new Event("blur")), () => window.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, metaKey: true }))]) {
      down(META);
      vi.advanceTimersByTime(h.HINTS_DELAY_MS);
      expect(h.hintsShown()).toBe(true);
      leave();
      expect(h.hintsShown()).toBe(false);
      // A pending wait is dropped too: no hints after a ⌘-click made right away.
      down(META);
      leave();
      vi.advanceTimersByTime(h.HINTS_DELAY_MS);
      expect(h.hintsShown()).toBe(false);
      up({ key: "Meta", code: "MetaLeft" });
    }
  });

  it("use Ctrl off macOS, its key repeat not restarting the wait", async () => {
    vi.useFakeTimers();
    const h = await load("Linux x86_64");
    off = h.off;
    down(META);
    vi.advanceTimersByTime(h.HINTS_DELAY_MS);
    expect(h.hintsShown()).toBe(false);
    up({ key: "Meta", code: "MetaLeft" });
    const ctrl = { key: "Control", code: "ControlLeft", ctrlKey: true };
    down(ctrl);
    vi.advanceTimersByTime(h.HINTS_DELAY_MS - 50);
    down({ ...ctrl, repeat: true });
    vi.advanceTimersByTime(50);
    expect(h.hintsShown()).toBe(true);
  });
});
