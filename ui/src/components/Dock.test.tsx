import { render } from "solid-js/web";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { settingsEdited, useFiles } from "../lib/persist";
import "../registry/actions";
import { Dock } from "./Dock";

beforeAll(() => {
  // jsdom has no layout.
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  // The settings as a file edited "outside the app" (`edit`).
  useFiles({ settings: {}, state: {}, settingsError: null, settingsPath: null, statePath: null }, async () => {}, async () => {});
});

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  settingsEdited({}, null);
  document.body.innerHTML = "";
});

const edit = (keys: unknown) => settingsEdited({ keys }, null);

describe("the dock without terminals", () => {
  it("says the keys that open one, and reads whole without those taken away", () => {
    const dock = document.body.appendChild(document.createElement("div"));
    dispose = render(() => <Dock />, dock);
    const terminals = () => dock.querySelector(".dock-empty span")?.textContent?.replace(/\s+/g, " ").trim();
    expect(terminals()).toBe("No terminals. S opens a shell in the selected pod, A attaches to it.");
    edit({ action: { shell: null } });
    expect(terminals()).toBe("No terminals. A attaches to the selected pod.");
    edit({ action: { attach: [] } });
    expect(terminals()).toBe("No terminals. S opens a shell in the selected pod.");
    edit({ action: { shell: null, attach: null } });
    expect(terminals()).toBe("No terminals.");
  });
});
