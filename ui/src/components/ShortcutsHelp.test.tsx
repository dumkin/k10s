import { render } from "solid-js/web";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { installHotkeys } from "../lib/hotkeys";
import { helpOpen, setHelpOpen } from "../state/ui";
import { Keys, ShortcutsHelp } from "./ShortcutsHelp";

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
