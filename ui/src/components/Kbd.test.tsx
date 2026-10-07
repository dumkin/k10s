import { render } from "solid-js/web";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { comboLabel } from "../lib/hotkeys";
import { settingsEdited, useFiles } from "../lib/persist";
import { Kbd } from "./Kbd";

// The settings as a file edited "outside the app" (`edit`).
beforeAll(() => useFiles({ settings: {}, state: {}, settingsError: null, settingsPath: null, statePath: null }, async () => {}, async () => {}));

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  dispose = undefined;
  settingsEdited({}, null);
  document.body.innerHTML = "";
});

const edit = (keys: unknown) => settingsEdited({ keys }, null);

describe("Kbd", () => {
  it("shows a command's key as the settings give it, and nothing for none", () => {
    const root = document.body.appendChild(document.createElement("div"));
    dispose = render(() => <Kbd id="logs.wrap" />, root);
    expect(root.innerHTML).toBe('<span class="kbd">W</span>');
    edit({ logs: { wrap: "alt+w" } });
    expect(root.textContent).toBe(comboLabel("alt+w"));
    edit({ logs: { wrap: null } });
    expect(root.innerHTML).toBe("");
  });
});
