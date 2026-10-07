import { render } from "solid-js/web";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { comboLabel } from "../lib/hotkeys";
import { settingsEdited, useFiles } from "../lib/persist";
import { paletteOpen, pickerOpen, setPaletteOpen, setPickerOpen } from "../state/ui";
import { TitleBar } from "./TitleBar";

// The pickers' own content doesn't matter here, only which keyboard list is open.
vi.mock("./ClusterPicker", () => ({ ClusterPicker: () => document.createElement("div") }));
vi.mock("./NamespacePicker", () => ({ NamespacePicker: () => document.createElement("div") }));

let dispose: () => void;
beforeEach(() => {
  const root = document.createElement("div");
  document.body.append(root);
  dispose = render(() => <TitleBar />, root);
});

afterEach(() => {
  dispose();
  setPaletteOpen(false);
  setPickerOpen(null);
  document.body.innerHTML = "";
});

describe("TitleBar", () => {
  it("closes a picker when the palette opens (⌘K / ⌘P from inside the picker)", () => {
    setPickerOpen("clusters");
    expect(document.querySelector(".picker-btn.open")).not.toBeNull();
    setPaletteOpen({ query: "" });
    expect(pickerOpen()).toBeNull();
    expect(document.querySelector(".picker-btn.open")).toBeNull();
  });

  it("closes the palette when a picker opens (⌘⇧C / ⌘⇧N from the palette)", () => {
    setPaletteOpen({ query: ":" });
    setPickerOpen("namespaces");
    expect(paletteOpen()).toBe(false);
    expect(pickerOpen()).toBe("namespaces");
    // Switching pickers keeps one open.
    setPickerOpen("clusters");
    expect(pickerOpen()).toBe("clusters");
  });

  it("opens a picker from its button", () => {
    setPaletteOpen({ query: "" });
    document.querySelectorAll<HTMLButtonElement>(".picker-btn")[1].click();
    expect([pickerOpen(), paletteOpen()]).toEqual(["namespaces", false]);
  });

  it("names the keys settings.json gives, in tooltips, hints and key caps, as the file changes", () => {
    useFiles({ settings: {}, state: {}, settingsError: null, settingsPath: null, statePath: null }, async () => {}, async () => {});
    const palette = document.querySelector<HTMLButtonElement>(".palette-btn")!;
    const clusters = document.querySelectorAll<HTMLButtonElement>(".picker-btn")[0];
    const shown = (b: HTMLButtonElement) => [b.dataset.hint, b.title, b.querySelector(".kbd")?.textContent];
    expect(shown(palette)).toEqual(["mod+k", `Command palette (${comboLabel("mod+k")})`, comboLabel("mod+k")]);
    expect(shown(clusters)).toEqual(["mod+shift+c", `Clusters (${comboLabel("mod+shift+c")})`, undefined]);
    settingsEdited({ keys: { app: { palette: ["alt+p", "mod+k"], clusters: null } } }, null);
    expect(shown(palette)).toEqual(["alt+p", `Command palette (${comboLabel("alt+p")})`, comboLabel("alt+p")]);
    // No key: none is named.
    expect(shown(clusters)).toEqual([undefined, "Clusters", undefined]);
    settingsEdited({}, null);
    expect(shown(palette)).toEqual(["mod+k", `Command palette (${comboLabel("mod+k")})`, comboLabel("mod+k")]);
  });
});
