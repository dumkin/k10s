import { render } from "solid-js/web";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { comboLabel, installHotkeys } from "../lib/hotkeys";
import { keyCommand } from "../lib/keymap";
import { settingsEdited, useFiles } from "../lib/persist";
import "../details";
import "../registry/actions";
import "../registry/helmActions";
import { helpOpen, setHelpOpen } from "../state/ui";
import { Keys, SHORTCUTS, ShortcutsHelp } from "./ShortcutsHelp";

beforeAll(() => installHotkeys());

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  setHelpOpen(false);
  document.body.innerHTML = "";
});

describe("keyboard shortcuts sheet", () => {
  it("opens, lists the keys by where they work, and closes with Esc", () => {
    dispose = render(() => <ShortcutsHelp />, document.body.appendChild(document.createElement("div")));
    expect(document.querySelector(".help-sheet")).toBeNull();
    setHelpOpen(true);
    const groups = [...document.querySelectorAll(".hs-group h3")].map((h) => h.textContent);
    expect(groups).toEqual(["Anywhere", "Table", "Actions", "Details", "Logs", "Terminals", "Palette and pickers", "Menus, lists and panels"]);
    expect(document.querySelector(".hs-row")?.textContent).toMatch(/Command palette/);
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true }));
    expect([helpOpen(), document.querySelector(".help-sheet")]).toEqual([false, null]);
  });

  it("finds rows by what they do and by their keys; Esc clears the search, then closes", () => {
    dispose = render(() => <ShortcutsHelp />, document.body.appendChild(document.createElement("div")));
    setHelpOpen(true);
    const search = document.querySelector<HTMLInputElement>(".hs-search input")!;
    const type = (text: string) => {
      search.value = text;
      search.dispatchEvent(new InputEvent("input", { bubbles: true }));
    };
    const rows = () => [...document.querySelectorAll(".hs-row .hs-text")].map((t) => t.textContent);
    type("pause");
    expect(rows()).toEqual(["Pause — and resume (new lines wait meanwhile)"]);
    type("shift+f10");
    expect(rows()).toEqual(["Actions menu of the selection, as a right-click opens it"]);
    type("no such thing");
    expect(document.querySelector(".hs-none")?.textContent).toMatch(/No shortcut matches/);
    const esc = () => search.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true }));
    esc();
    expect([helpOpen(), search.value]).toEqual([true, ""]);
    esc();
    expect(helpOpen()).toBe(false);
  });

  it("writes keys as they are pressed: alternatives, ranges, held keys", () => {
    const root = document.body.appendChild(document.createElement("div"));
    dispose = render(() => <Keys keys="j k | arrowdown … 9 hold:shift" />, root);
    const parts = [...root.querySelectorAll(".sc-keys > span")].map((s) => `${s.className}:${s.textContent}`);
    expect(parts).toEqual(["kbd:J", "kbd:K", "sc-sep:/", "kbd:↓", "sc-sep:…", "kbd:9", "sc-sep:hold", expect.stringMatching(/^kbd:(⇧|Shift)$/)]);
  });
});

describe("the keys of commands in the sheet", () => {
  it("are those of commands that exist", () => {
    const named = SHORTCUTS.flatMap((g) => g.rows.flatMap((r) => r.keys.split(/\s+/).filter((t) => t.startsWith("@")).map((t) => t.slice(1))));
    expect(named.length).toBeGreaterThan(50);
    expect(named.filter((id) => !keyCommand(id))).toEqual([]);
  });

  it("follow settings.json as it changes: shown, and found by search", () => {
    useFiles({ settings: {}, state: {}, settingsError: null, settingsPath: null, statePath: null }, async () => {}, async () => {});
    dispose = render(() => <ShortcutsHelp />, document.body.appendChild(document.createElement("div")));
    setHelpOpen(true);
    const keys = (text: string) => {
      const row = [...document.querySelectorAll(".hs-row")].find((r) => r.querySelector(".hs-text")?.textContent?.startsWith(text));
      return [...(row?.querySelectorAll(".sc-keys > span") ?? [])].map((k) => k.textContent);
    };
    const label = comboLabel;
    // A row of several commands shows the first key of each; a row of one command, all of its keys.
    expect(keys("Wrap / timestamps")).toEqual(["W", "T", "V", "H"]);
    expect(keys("Delete")).toEqual([label("ctrl+d"), "/", label("mod+backspace")]);
    settingsEdited({ keys: { logs: { wrap: ["alt+w", "w"], timestamps: null }, action: { delete: "mod+backspace" } } }, null);
    expect(keys("Wrap / timestamps")).toEqual([label("alt+w"), "—", "V", "H"]);
    expect(keys("Delete")).toEqual([label("mod+backspace")]);
    const search = document.querySelector<HTMLInputElement>(".hs-search input")!;
    search.value = "alt+w";
    search.dispatchEvent(new InputEvent("input", { bubbles: true }));
    expect([...document.querySelectorAll(".hs-row .hs-text")].map((t) => t.textContent)).toEqual(["Wrap / timestamps / pretty (JSON, logfmt) / histogram"]);
    settingsEdited({}, null);
    expect(document.querySelector(".hs-none")?.textContent).toMatch(/No shortcut matches/);
  });
});
