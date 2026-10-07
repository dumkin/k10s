import { render } from "solid-js/web";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ForwardInfo } from "../lib/backend";
import { comboLabel } from "../lib/hotkeys";
import { settingsEdited, useFiles } from "../lib/persist";
import "../registry/actions";
import { setForwards } from "../state/forwards";
import { setToasts, toasts } from "../state/ui";
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

describe("a running port-forward", () => {
  const web: ForwardInfo = { id: 1, spec: { cluster: "prod-eu-z1", namespace: "shop", resource: "services", name: "web", port: 8080 }, localPort: 8080, connections: 0, total: 0, sent: 0, received: 0, started: 0 };

  afterEach(() => {
    setForwards([]);
    setToasts([]);
    Reflect.deleteProperty(navigator, "clipboard");
  });

  it("says its URL is copied once the clipboard has it, and when the clipboard refuses it", async () => {
    const writes: string[] = [];
    let settle: { ok: () => void; refuse: (e: unknown) => void } | undefined;
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: (text: string) => (writes.push(text), new Promise<void>((ok, refuse) => (settle = { ok, refuse }))) } });
    setForwards([web]);
    const root = document.body.appendChild(document.createElement("div"));
    dispose = render(() => <ForwardsPane />, root);
    const copy = root.querySelector<HTMLButtonElement>('button[title="Copy the URL"]')!;
    copy.click();
    await Promise.resolve();
    expect([writes, toasts()]).toEqual([["http://localhost:8080"], []]);
    settle!.ok();
    await vi.waitFor(() => expect(toasts().at(-1)).toMatchObject({ kind: "success", title: "Copied to clipboard", detail: "http://localhost:8080" }));
    copy.click();
    settle!.refuse(new DOMException("The request is not allowed by the user agent or the platform in the current context.", "NotAllowedError"));
    await vi.waitFor(() => expect(toasts().at(-1)).toMatchObject({ kind: "error", title: "Could not copy" }));
  });
});
