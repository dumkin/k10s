import { createRoot } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UpdateInfo } from "../lib/backend";

const release: UpdateInfo = { version: "0.2.0", current: "0.1.0", date: null, notes: null, page: "https://github.com/acme/k10s/releases/tag/v0.2.0", ready: false };
const engine = vi.hoisted(() => ({
  appInfo: vi.fn(async () => ({ version: "0.1.0", os: "macos", arch: "aarch64", updates: true })),
  checkUpdate: vi.fn(),
  downloadUpdate: vi.fn(),
  installUpdate: vi.fn(async () => {}),
  openUpdateNotes: vi.fn(async () => {}),
  log: vi.fn(),
}));
vi.mock("../lib/backend", async (importOriginal) => ({ ...(await importOriginal<typeof import("../lib/backend")>()), backend: () => engine }));

import { collectCommands } from "./commands";
import { dialog, toasts } from "./ui";
import { autoUpdate, checkForUpdates, restartToUpdate, setAutoUpdate, startUpdates, UP_TO_DATE_KEY, update } from "./updates";

const titles = () => toasts().map((t) => t.title);
const palette = () => collectCommands("").map((c) => c.title);
const UP_TO_DATE = `k10s:${UP_TO_DATE_KEY}`;
const HOUR = 60 * 60_000;

let stop: (() => void) | undefined;
/** Quits k10s and starts it again (under fake timers), until its first check is due. */
async function restart() {
  stop?.();
  stop = createRoot(() => startUpdates());
  await vi.advanceTimersByTimeAsync(15_000);
}
beforeEach(async () => {
  localStorage.removeItem(UP_TO_DATE);
  engine.checkUpdate.mockResolvedValue(release);
  engine.downloadUpdate.mockResolvedValue({ ...release, ready: true });
  stop = createRoot(() => startUpdates());
  // `startUpdates` learns from the app info whether this build updates itself.
  await Promise.resolve();
  await Promise.resolve();
});
afterEach(() => {
  stop?.();
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("updates", () => {
  it("downloads a release it finds, says so once, and offers to restart into it", async () => {
    await checkForUpdates();
    expect(engine.downloadUpdate).toHaveBeenCalledTimes(1);
    expect(update()).toMatchObject({ version: "0.2.0", ready: true });
    expect(titles()).toContain("k10s 0.2.0 is ready");
    expect(palette()).toEqual(expect.arrayContaining(["Restart to update to 0.2.0", "What's new in k10s 0.2.0", "Check for updates"]));
    // Found again later: already downloaded, nothing new to say.
    engine.checkUpdate.mockResolvedValue({ ...release, ready: true });
    const before = toasts().length;
    await checkForUpdates();
    expect(engine.downloadUpdate).toHaveBeenCalledTimes(1);
    expect(toasts()).toHaveLength(before);
  });

  it("tells a check the user asked for how it went, and an automatic one only logs a failure", async () => {
    engine.checkUpdate.mockResolvedValueOnce(null);
    await checkForUpdates(true);
    expect(titles()).toContain("k10s is up to date");
    expect(update()).toBeNull();
    engine.checkUpdate.mockRejectedValueOnce({ kind: "other", message: "offline", code: null });
    await checkForUpdates();
    expect(engine.log).toHaveBeenCalledWith("warn", "update check failed: offline");
    expect(titles()).not.toContain("Could not check for updates");
  });

  it("asks before restarting into the update", async () => {
    await checkForUpdates();
    const asked = restartToUpdate();
    await Promise.resolve();
    expect(dialog()?.title).toBe("Restart to update to k10s 0.2.0?");
    dialog()!.resolve(null);
    await asked;
    expect(engine.installUpdate).not.toHaveBeenCalled();
    const confirmed = restartToUpdate();
    await Promise.resolve();
    dialog()!.resolve({});
    await confirmed;
    expect(engine.installUpdate).toHaveBeenCalledTimes(1);
  });

  it("checks by itself only while automatic checks are on", async () => {
    stop?.();
    vi.useFakeTimers();
    setAutoUpdate(false);
    stop = createRoot(() => startUpdates());
    await vi.advanceTimersByTimeAsync(60_000);
    expect(engine.checkUpdate).not.toHaveBeenCalled();
    setAutoUpdate(true);
    await vi.advanceTimersByTimeAsync(6 * 60 * 60_000);
    expect(engine.checkUpdate).toHaveBeenCalledTimes(1);
    expect(autoUpdate()).toBe(true);
  });

  it("asks by itself at most every six hours, across starts too, until it finds a release", async () => {
    stop?.();
    vi.useFakeTimers();
    engine.checkUpdate.mockResolvedValue(null);
    await restart();
    expect(engine.checkUpdate).toHaveBeenCalledTimes(1);
    // Started again an hour later: nothing to ask until six hours after that check.
    await vi.advanceTimersByTimeAsync(HOUR);
    await restart();
    expect(engine.checkUpdate).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5 * HOUR);
    expect(engine.checkUpdate).toHaveBeenCalledTimes(2);
    // A release found is forgotten with the app: every start asks again.
    engine.checkUpdate.mockResolvedValue(release);
    await vi.advanceTimersByTimeAsync(6 * HOUR);
    expect(engine.checkUpdate).toHaveBeenCalledTimes(3);
    await restart();
    expect(engine.checkUpdate).toHaveBeenCalledTimes(4);
  });

  it("asks right away when asked by hand, without putting off the automatic checks", async () => {
    stop?.();
    vi.useFakeTimers();
    engine.checkUpdate.mockResolvedValue(null);
    await restart();
    await vi.advanceTimersByTimeAsync(5 * HOUR);
    await checkForUpdates(true);
    expect(engine.checkUpdate).toHaveBeenCalledTimes(2);
    // Six hours after the automatic check, not after the one by hand.
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(engine.checkUpdate).toHaveBeenCalledTimes(3);
    // A release found by hand is asked for again at the next start.
    engine.checkUpdate.mockResolvedValue(release);
    await checkForUpdates(true);
    await restart();
    expect(engine.checkUpdate).toHaveBeenCalledTimes(5);
  });

  it("asks at start when the last check that found nothing was another version's, or is ahead of the clock", async () => {
    stop?.();
    vi.useFakeTimers();
    localStorage.setItem(UP_TO_DATE, JSON.stringify({ at: Date.now() - HOUR, version: "0.0.9" }));
    await restart();
    expect(engine.checkUpdate).toHaveBeenCalledTimes(1);
    localStorage.setItem(UP_TO_DATE, JSON.stringify({ at: Date.now() + HOUR, version: "0.1.0" }));
    await restart();
    expect(engine.checkUpdate).toHaveBeenCalledTimes(2);
  });

  it("asks when automatic checks are turned back on only if a check is due", async () => {
    stop?.();
    vi.useFakeTimers();
    engine.checkUpdate.mockResolvedValue(null);
    await restart();
    const toggle = () => void collectCommands("").find((c) => c.id === "app:update-auto")?.run({ additive: false });
    toggle();
    toggle();
    expect(autoUpdate()).toBe(true);
    expect(engine.checkUpdate).toHaveBeenCalledTimes(1);
    localStorage.removeItem(UP_TO_DATE);
    toggle();
    toggle();
    expect(engine.checkUpdate).toHaveBeenCalledTimes(2);
  });

  it("offers nothing in a build that does not update itself", async () => {
    stop?.();
    engine.appInfo.mockResolvedValueOnce({ version: "0.1.0", os: "linux", arch: "x86_64", updates: false });
    stop = createRoot(() => startUpdates());
    await Promise.resolve();
    await Promise.resolve();
    expect(palette().filter((t) => /update/i.test(t))).toEqual([]);
  });
});
