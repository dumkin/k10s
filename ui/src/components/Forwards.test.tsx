import { render } from "solid-js/web";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { comboLabel } from "../lib/hotkeys";
import { settingsEdited, useFiles } from "../lib/persist";
import "../registry/actions";
import { ForwardsPane } from "./Forwards";

// The settings as a file edited "outside the app".
beforeAll(() => useFiles({ settings: {}, state: {}, settingsError: null, settingsPath: null, statePath: null }, async () => {}, async () => {}));

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  settingsEdited({}, null);
  document.body.innerHTML = "";
});

describe("the port-forwards pane without forwards", () => {
  it("says the keys that make one, and reads whole without those taken away", () => {
    const root = document.body.appendChild(document.createElement("div"));
    dispose = render(() => <ForwardsPane />, root);
    const hint = () => root.querySelector(".dock-empty span")?.textContent?.replace(/\s+/g, " ").trim();
    expect(hint()).toBe(`No port-forwards: ${comboLabel("shift+f")} on a pod, service or workload forwards one of its ports (pinned ones wait here to start again). S opens a shell in a pod.`);
    settingsEdited({ keys: { action: { "port-forward": null, shell: "alt+s" } } }, null);
    expect(hint()).toBe(`No port-forwards (pinned ones wait here to start again). ${comboLabel("alt+s")} opens a shell in a pod.`);
  });
});
