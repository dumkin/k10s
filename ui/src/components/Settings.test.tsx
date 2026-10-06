import { render } from "solid-js/web";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const engine = vi.hoisted(() => ({
  appInfo: vi.fn(async () => ({ version: "0.1.0", os: "macos", arch: "aarch64", logDir: "/Users/me/Library/Logs/io.dumkin.k10s", updates: false })),
  openPrefsFile: vi.fn(async () => {}),
  openLogDir: vi.fn(async () => {}),
  openProjectPage: vi.fn(async () => {}),
  setPrefs: vi.fn(async () => {}),
}));
vi.mock("../lib/backend", async (importOriginal) => ({ ...(await importOriginal<typeof import("../lib/backend")>()), backend: () => engine }));

import { debugImage, nodeShellNamespace } from "../state/dock";
import { wrap } from "../details/logs/model";
import { installHotkeys } from "../lib/hotkeys";
import { useFiles } from "../lib/persist";
import { setSettingsOpen, settingsOpen, themePref } from "../state/ui";
import { Settings } from "./Settings";

beforeAll(() => installHotkeys());

let dispose: (() => void) | undefined;
beforeEach(() => {
  dispose = render(() => <Settings />, document.body.appendChild(document.createElement("div")));
});
afterEach(() => {
  dispose?.();
  setSettingsOpen(false);
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

const tabs = () => [...document.querySelectorAll(".ss-tab")].map((t) => t.textContent);
const active = () => document.querySelector(".ss-tab.on")?.textContent;
const key = (target: EventTarget, k: string) => target.dispatchEvent(new KeyboardEvent("keydown", { key: k, code: k, bubbles: true, cancelable: true }));
const row = (label: string) => [...document.querySelectorAll<HTMLElement>(".ss-row")].find((r) => r.querySelector(".ss-label")?.textContent === label)!;
const type = (input: HTMLInputElement, text: string) => {
  input.value = text;
  input.dispatchEvent(new InputEvent("input", { bubbles: true }));
};

describe("settings window", () => {
  it("opens at a section, moves between sections with the arrows, and closes with Esc", () => {
    expect(document.querySelector(".settings-sheet")).toBeNull();
    setSettingsOpen("general");
    expect(tabs()).toEqual(["General", "Clusters", "Logs", "Terminals", "Port-forwards", "Updates", "Files", "About"]);
    expect([active(), document.activeElement?.textContent]).toEqual(["General", "General"]);
    const list = document.querySelector(".ss-tabs")!;
    key(list, "ArrowDown");
    expect([settingsOpen(), document.querySelector(".ss-head h3")?.textContent, document.activeElement?.textContent]).toEqual(["clusters", "Clusters", "Clusters"]);
    key(list, "End");
    key(list, "ArrowDown");
    expect(active()).toBe("About");
    key(document.body, "Escape");
    expect([settingsOpen(), document.querySelector(".settings-sheet")]).toEqual([false, null]);
  });

  it("puts a change in effect at once and keeps it in the settings", () => {
    setSettingsOpen("logs");
    // A control is named by its label and described by its hint (screen readers say both).
    const utcSwitch = row("Times in UTC").querySelector("[role=switch]")!;
    expect(document.getElementById(utcSwitch.getAttribute("aria-labelledby")!)?.textContent).toBe("Times in UTC");
    expect(document.getElementById(utcSwitch.getAttribute("aria-describedby")!)?.textContent).toBe("Otherwise in this computer's time zone.");
    const wrapSwitch = row("Wrap long lines").querySelector<HTMLButtonElement>("[role=switch]")!;
    expect(wrapSwitch.hasAttribute("aria-describedby")).toBe(false);
    expect(wrapSwitch.getAttribute("aria-checked")).toBe("false");
    wrapSwitch.click();
    expect([wrap(), wrapSwitch.getAttribute("aria-checked"), localStorage.getItem("k10s:logs.wrap")]).toEqual([true, "true", "true"]);
    setSettingsOpen("general");
    document.querySelector<HTMLButtonElement>('[role=radio][data-value="light"]')!.click();
    expect(themePref()).toBe("light");
    // The arrows move the choice.
    key(document.querySelector('[role="radiogroup"]')!, "ArrowRight");
    expect(themePref()).toBe("system");
  });

  it("takes a text setting as typed, the default again when emptied, and not what is wrong", () => {
    setSettingsOpen("terminals");
    const [image, , namespace] = document.querySelectorAll<HTMLInputElement>(".ss-field input");
    type(image, "registry.example.com/tools/busybox:1.37");
    expect(debugImage()).toBe("registry.example.com/tools/busybox:1.37");
    type(image, "  ");
    expect([debugImage(), image.placeholder]).toEqual(["busybox:1.37", "busybox:1.37"]);
    type(namespace, "Payments_1");
    expect(nodeShellNamespace()).toBe("default");
    expect(document.querySelector(".ss-problem")?.textContent).toMatch(/Not a namespace name/);
    type(namespace, "payments");
    expect([nodeShellNamespace(), document.querySelector(".ss-problem")]).toEqual(["payments", null]);
    // Typed out in full, the default stays in the field as typed (it is the default all the same).
    image.focus();
    type(image, "busybox:1.3");
    type(image, "busybox:1.37");
    expect([image.value, debugImage()]).toEqual(["busybox:1.37", "busybox:1.37"]);
  });

  it("shows the focus once the keyboard is used, and has the close button last in the tab order", () => {
    setSettingsOpen("general");
    const sheet = document.querySelector(".settings-sheet")!;
    expect(sheet.classList.contains("keys")).toBe(false);
    key(document.querySelector(".ss-tabs")!, "ArrowDown");
    expect(sheet.classList.contains("keys")).toBe(true);
    const focusable = [...sheet.querySelectorAll<HTMLElement>("button, input, select, [tabindex]")].filter((el) => el.tabIndex >= 0 && !el.hasAttribute("disabled"));
    expect(focusable.at(-1)?.getAttribute("aria-label")).toBe("Close");
  });

  it("opens each page of the project from About", () => {
    setSettingsOpen("about");
    for (const label of ["Source code", "Releases", "Report a problem"]) row(label).querySelector("button")!.click();
    expect(engine.openProjectPage.mock.calls).toEqual([["home"], ["releases"], ["issues"]]);
  });

  it("shows where the files are and opens them; the settings file as it is, or why it can't be read", async () => {
    useFiles(
      { settings: { theme: "light", logs: { tail: 500 } }, state: {}, settingsError: "expected value at line 4 column 3", settingsPath: "/Users/me/Library/Application Support/io.dumkin.k10s/settings.json", statePath: "/Users/me/Library/Application Support/io.dumkin.k10s/state.json" },
      engine.setPrefs,
      async () => {},
    );
    setSettingsOpen("files");
    await vi.waitFor(() => expect(document.querySelectorAll(".ss-path")[2]?.textContent).toBe("/Users/me/Library/Logs/io.dumkin.k10s"));
    expect([...document.querySelectorAll(".ss-path")].map((p) => p.textContent)).toEqual([
      "/Users/me/Library/Application Support/io.dumkin.k10s/settings.json",
      "/Users/me/Library/Application Support/io.dumkin.k10s/state.json",
      "/Users/me/Library/Logs/io.dumkin.k10s",
    ]);
    expect(document.querySelector(".ss-alert")?.textContent).toMatch(/expected value at line 4 column 3/);
    expect(JSON.parse(document.querySelector(".ss-json")!.textContent!)).toEqual({ theme: "light", logs: { tail: 500 } });
    // Open and show the settings file, show the state file, open the log folder.
    const [settings, state, logs] = [...document.querySelectorAll(".ss-file")].map((f) => [...f.querySelectorAll<HTMLButtonElement>("button")]);
    expect([settings, state, logs].map((b) => b.length)).toEqual([2, 1, 1]);
    settings[0].click();
    state[0].click();
    logs[0].click();
    expect(engine.openPrefsFile.mock.calls).toEqual([
      ["settings", false],
      ["state", true],
    ]);
    expect(engine.openLogDir).toHaveBeenCalledTimes(1);
    // A setting changed meanwhile shows in the file at once.
    setSettingsOpen("logs");
    row("Wrap long lines").querySelector<HTMLButtonElement>("[role=switch]")!.click();
    setSettingsOpen("files");
    expect(JSON.parse(document.querySelector(".ss-json")!.textContent!).logs).toEqual({ tail: 500, wrap: wrap() });
    await vi.waitFor(() => expect(engine.setPrefs).toHaveBeenLastCalledWith([{ doc: "settings", key: "logs.wrap", value: wrap() }]));
  });
});
