import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const engine = vi.hoisted(() => ({
  settings: { readOnly: false, feedIdleTtlSecs: 180 },
  getSettings: vi.fn(async (): Promise<{ readOnly: boolean; feedIdleTtlSecs: number }> => ({ ...engine.settings })),
  /** Like the engine: on is free; off is up to the user, who keeps it on here unless `confirms`. */
  confirms: false,
  setReadOnly: vi.fn(async (on: boolean) => {
    if (on || engine.confirms) engine.settings = { ...engine.settings, readOnly: on };
    return { ...engine.settings };
  }),
  setZoom: vi.fn(async (_scale: number) => {}),
}));
vi.mock("../lib/backend", async (importOriginal) => ({ ...(await importOriginal<typeof import("../lib/backend")>()), backend: () => engine }));

const { busyToast, copyText, loadSettings, readOnly, setReadOnly, setUiZoom, toast, toasts, dismissToast, uiZoom, zoomBy, ZOOM_STEPS } = await import("./ui");

beforeEach(() => {
  vi.clearAllMocks();
  engine.settings = { readOnly: false, feedIdleTtlSecs: 180 };
  engine.confirms = false;
  localStorage.clear();
  for (const t of toasts()) dismissToast(t.id);
});

describe("read-only mode", () => {
  it("mirrors the engine", async () => {
    engine.settings.readOnly = true;
    await loadSettings();
    expect(readOnly()).toBe(true);
  });

  it("says so when the engine can't be asked", async () => {
    engine.getSettings.mockRejectedValueOnce({ kind: "other", message: "engine unavailable" });
    await loadSettings();
    expect(toasts().at(-1)).toMatchObject({ kind: "error", title: "Could not read the settings" });
  });

  it("stays on when the user keeps it on in the engine's confirmation", async () => {
    await setReadOnly(true);
    expect(readOnly()).toBe(true);
    await setReadOnly(false);
    expect(engine.setReadOnly).toHaveBeenLastCalledWith(false);
    expect(readOnly()).toBe(true);
    engine.confirms = true;
    await setReadOnly(false);
    expect(readOnly()).toBe(false);
  });
});

describe("settings.json edited outside the app", () => {
  it("mirrors the engine's settings and says so; a file that can't be read leaves read-only mode on and is reported", async () => {
    const { settingsFileEdited } = await import("./ui");
    settingsFileEdited({ settings: { theme: "dark" }, error: null, engine: { readOnly: false, feedIdleTtlSecs: 60 } });
    expect([readOnly(), toasts().at(-1)?.title]).toEqual([false, "Settings updated"]);
    settingsFileEdited({ settings: {}, error: "expected value at line 2 column 1", engine: { readOnly: true, feedIdleTtlSecs: 60 } });
    expect(readOnly()).toBe(true);
    expect(toasts().at(-1)).toMatchObject({ kind: "error", title: "settings.json can't be read", sticky: true });
    expect(toasts().at(-1)?.detail).toMatch(/line 2 column 1/);
  });
});

describe("toasts", () => {
  it("never push an unread failure report off screen for a toast that goes by itself", () => {
    for (let i = 0; i < 5; i++) toast("error", `failed ${i}`, undefined, { sticky: true });
    toast("info", "Copied to clipboard");
    expect(toasts().map((t) => t.title)).toEqual(["failed 0", "failed 1", "failed 2", "failed 3", "failed 4", "Copied to clipboard"]);
    // More of them replace each other, not the reports.
    toast("success", "Restarted web");
    expect(toasts().map((t) => t.title)).toEqual(["failed 0", "failed 1", "failed 2", "failed 3", "failed 4", "Restarted web"]);
    // A new report makes room by dropping what goes by itself first, then the oldest report.
    toast("error", "failed 5", undefined, { sticky: true });
    expect(toasts().map((t) => t.title)).toEqual(["failed 1", "failed 2", "failed 3", "failed 4", "failed 5"]);
  });

  it("let the oldest that goes by itself make room first", () => {
    toast("info", "a");
    toast("error", "failed", undefined, { sticky: true });
    for (const t of ["b", "c", "d", "e"]) toast("info", t);
    expect(toasts().map((t) => t.title)).toEqual(["failed", "b", "c", "d", "e"]);
  });

  it("keep saying what is running beside the others, without pushing a failure report off screen", () => {
    for (let i = 0; i < 5; i++) toast("error", `failed ${i}`, undefined, { sticky: true });
    const done = busyToast("Deleting web-0…");
    expect(toasts().map((t) => t.title)).toEqual(["failed 0", "failed 1", "failed 2", "failed 3", "failed 4", "Deleting web-0…"]);
    // Neither does a new report push it off.
    toast("error", "failed 5", undefined, { sticky: true });
    expect(toasts().map((t) => t.title)).toEqual(["failed 1", "failed 2", "failed 3", "failed 4", "Deleting web-0…", "failed 5"]);
    done();
    expect(toasts().map((t) => t.title)).toEqual(["failed 1", "failed 2", "failed 3", "failed 4", "failed 5"]);
  });
});

describe("copying", () => {
  const clipboard = (writeText: (text: string) => Promise<void>) => Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  afterEach(() => Reflect.deleteProperty(navigator, "clipboard"));

  it("says what it copied, at most 120 characters of it, whole ones: the clipboard gets all of it", async () => {
    const copied: string[] = [];
    clipboard(async (text) => void copied.push(text));
    const long = `${"a".repeat(118)}🚀${"b".repeat(10)}`;
    await copyText(long, "Copied name", long);
    expect(copied).toEqual([long]);
    expect(toasts().at(-1)).toMatchObject({ kind: "success", title: "Copied name", detail: `${"a".repeat(118)}🚀…` });
    // 120 characters in 240 UTF-16 units: all of them.
    await copyText("web-0", "Copied name", "🚀".repeat(120));
    expect(toasts().at(-1)?.detail).toBe("🚀".repeat(120));
    await copyText("apiVersion: v1", "Copied to clipboard");
    expect(toasts().at(-1)).toMatchObject({ kind: "success", title: "Copied to clipboard", detail: undefined });
  });

  it("says when the clipboard refuses, and why, instead of failing", async () => {
    clipboard(() => Promise.reject(new DOMException("The request is not allowed by the user agent or the platform in the current context.", "NotAllowedError")));
    await expect(copyText("web-0", "Copied name", "web-0")).resolves.toBeUndefined();
    expect(toasts().at(-1)).toMatchObject({ kind: "error", title: "Could not copy", detail: "The request is not allowed by the user agent or the platform in the current context." });
    // No clipboard at all (a page that is not a secure context).
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
    await expect(copyText("web-0", "Copied name", "web-0")).resolves.toBeUndefined();
    expect(toasts().map((t) => [t.kind, t.title])).toEqual([
      ["error", "Could not copy"],
      ["error", "Could not copy"],
    ]);
  });
});

describe("zoom", () => {
  it("steps through the levels a browser has, stops at the ends, and goes back to 100%", () => {
    setUiZoom(1);
    zoomBy(1);
    zoomBy(1);
    expect(uiZoom()).toBe(1.25);
    for (let i = 0; i < 20; i++) zoomBy(1);
    expect(uiZoom()).toBe(ZOOM_STEPS.at(-1));
    for (let i = 0; i < 20; i++) zoomBy(-1);
    expect(uiZoom()).toBe(ZOOM_STEPS[0]);
    setUiZoom(1);
    expect(uiZoom()).toBe(1);
  });
});
