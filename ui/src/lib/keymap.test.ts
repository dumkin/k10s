import { createRoot, createEffect } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PrefsSnapshot } from "./backend";

afterEach(() => vi.restoreAllMocks());

/**
 * A fresh keymap, as on macOS or elsewhere, started from a settings file with `settings` in it: its module and the
 * preferences' (to edit the file "outside the app").
 */
async function start(settings: Record<string, unknown> = {}, platform: "MacIntel" | "Linux x86_64" = "Linux x86_64") {
  vi.resetModules();
  vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
  const persist = await import("./persist");
  const snapshot: PrefsSnapshot = { settings, state: {}, settingsError: null, settingsPath: "/home/me/.config/io.dumkin.k10s/settings.json", statePath: null };
  persist.useFiles(snapshot, async () => {}, async () => {});
  return { keymap: await import("./keymap"), persist };
}

describe("parseCombo", () => {
  it("writes a key as the code writes keys, whatever the case, spaces or names of the modifiers", async () => {
    const { keymap } = await start();
    const parse = keymap.parseCombo;
    expect(["w", "W", "shift+g", "Shift+G", " mod + k ", "Cmd+Shift+K", "shift+cmd+k", "Control+D", "option+1", "opt+w"].map(parse)).toEqual([
      "w",
      "w",
      "shift+g",
      "shift+g",
      "mod+k",
      "mod+shift+k",
      "mod+shift+k",
      "ctrl+d",
      "alt+1",
      "alt+w",
    ]);
    // Keys with names, and the shorter names people write.
    expect(["Escape", "esc", "F6", "shift+f6", "PageDown", "pgdn", "Left", "alt+ArrowLeft", "space", "shift+space", "mod+Backspace", "Return"].map(parse)).toEqual([
      "escape",
      "escape",
      "f6",
      "shift+f6",
      "pagedown",
      "pagedown",
      "arrowleft",
      "alt+arrowleft",
      "space",
      "shift+space",
      "mod+backspace",
      "enter",
    ]);
    // "+" is a key of its own.
    expect(["+", "mod++", "mod+=", "?", ":", "/", "[", "ж"].map(parse)).toEqual(["+", "mod++", "mod+=", "?", ":", "/", "[", "ж"]);
  });

  it("refuses what no key press makes", async () => {
    const { keymap } = await start();
    // No key, a word that is no key, a modifier that isn't one, Shift with a symbol ("?" is Shift and "/").
    for (const text of ["", " ", "mod+", "++", "shift", "wrap", "hyper+k", "mod+shift", "shift+/", "shift+1", "constructor", "toString+k", "__proto__"]) expect(keymap.parseCombo(text), text).toBeUndefined();
  });
});

describe("the keys of commands", () => {
  it("are their own unless the settings give them others", async () => {
    const { keymap } = await start();
    expect([keymap.keysOf("logs.wrap"), keymap.keysOf("app.zoom-in"), keymap.keyOf("app.palette")]).toEqual([["w"], ["mod+=", "mod++"], "mod+k"]);
    // No such command: no keys.
    expect([keymap.keysOf("logs.nope"), keymap.keyOf("nope")]).toEqual([[], undefined]);
    expect(keymap.keyCommand("table.down")).toMatchObject({ scope: "table", defaults: ["j"] });
  });

  it("go back and forward as browsers do on each platform", async () => {
    const mac = await start({}, "MacIntel");
    expect([mac.keymap.keyOf("nav.back"), mac.keymap.keyOf("nav.forward")]).toEqual(["mod+[", "mod+]"]);
    const linux = await start({}, "Linux x86_64");
    expect([linux.keymap.keyOf("nav.back"), linux.keymap.keyOf("nav.forward")]).toEqual(["alt+arrowleft", "alt+arrowright"]);
  });

  it("come from settings.json: a key, a list of them, or none", async () => {
    const { keymap } = await start({
      keys: {
        logs: { wrap: "Alt+W", find: ["mod+f", "ctrl+/", "MOD+F"] },
        table: { down: null, up: [] },
        action: { delete: "mod+backspace" },
      },
    });
    expect(keymap.keysOf("logs.wrap")).toEqual(["alt+w"]);
    // Once each.
    expect(keymap.keysOf("logs.find")).toEqual(["mod+f", "ctrl+/"]);
    // None: the command keeps no key at all.
    expect([keymap.keysOf("table.down"), keymap.keyOf("table.up")]).toEqual([[], undefined]);
    // A command that comes later (an action's) gets what the settings give it too.
    expect(keymap.keysOf("action.delete")).toEqual([]);
    keymap.registerKeyCommand({ id: "action.delete", scope: "table", title: "Delete", defaults: ["ctrl+d"] });
    expect(keymap.keysOf("action.delete")).toEqual(["mod+backspace"]);
    // Others keep their own.
    expect(keymap.keysOf("logs.pause")).toEqual(["s"]);
  });

  it("leave out what isn't keys, each command on its own", async () => {
    const { keymap } = await start({
      keys: {
        logs: { wrap: 5, pause: "shift+/", copy: ["c", "nope"], expand: { key: "x" }, pretty: true, find: [null], save: "mod+e" },
        table: "j",
        yaml: null,
        attention: ["j"],
      },
    });
    expect(["logs.wrap", "logs.pause", "logs.copy", "logs.expand", "logs.pretty", "logs.find", "table.down", "yaml.find", "attention.down"].map(keymap.keysOf)).toEqual([
      ["w"],
      ["s"],
      ["c"],
      ["x"],
      ["v"],
      ["/", "mod+f"],
      ["j"],
      ["/", "mod+f"],
      ["j"],
    ]);
    // What makes sense next to it stays.
    expect(keymap.keysOf("logs.save")).toEqual(["mod+e"]);
  });

  it("whatever the file holds", async () => {
    for (const keys of [null, "x", 1, [], ["logs"], { logs: null }, { logs: [] }, { constructor: { prototype: "x" } }, { __proto__: { wrap: "q" } }]) {
      const { keymap } = await start({ keys });
      expect(keymap.keysOf("logs.wrap"), JSON.stringify(keys)).toEqual(["w"]);
    }
  });

  it("follow an edit of settings.json made while the app runs, and change only when a key does", async () => {
    const { keymap, persist } = await start({ theme: "dark", keys: { logs: { wrap: "alt+w" } } });
    const seen: (readonly string[])[] = [];
    const changes = vi.fn();
    const dispose = createRoot((d) => {
      createEffect(() => seen.push(keymap.keysOf("logs.wrap")));
      createEffect(() => changes(keymap.keymap()));
      return d;
    });
    persist.settingsEdited({ theme: "light", keys: { logs: { wrap: "alt+w" } } }, null);
    persist.settingsEdited({ theme: "light", keys: { logs: { wrap: ["ctrl+w", "w"] } } }, null);
    persist.settingsEdited({ theme: "light", keys: { logs: { wrap: null } } }, null);
    // Taken out of the file: its own key again.
    persist.settingsEdited({ theme: "light" }, null);
    // A file that can't be read leaves the keys as they are.
    persist.settingsEdited({}, "expected value at line 3 column 9");
    expect(seen).toEqual([["alt+w"], ["ctrl+w", "w"], [], ["w"]]);
    expect(changes).toHaveBeenCalledTimes(4);
    dispose();
  });
});

describe("the commands of tabs and actions", () => {
  it("come with the tabs and the actions, with their keys; an action that opens a tab goes by the tab's key", async () => {
    const { keymap } = await start({ keys: { action: { "copy-name": "y" }, tab: { yaml: "shift+y" } } });
    await import("../details");
    const { actionKeyId, allActions } = await import("../registry/actions");
    await import("../registry/helmActions");
    expect(["tab.overview", "tab.logs", "tab.compare", "tab.values"].map(keymap.keysOf)).toEqual([["d"], ["l"], ["="], ["v"]]);
    expect(keymap.keyCommand("tab.logs")).toMatchObject({ scope: "details", title: "Logs tab" });
    expect(["action.shell", "action.delete", "action.helm-uninstall", "action.cordon"].map(keymap.keysOf)).toEqual([["s"], ["ctrl+d", "mod+backspace"], ["ctrl+d"], []]);
    // What it is called on one object, without "…".
    expect(["action.delete", "action.cordon", "action.compare-pin"].map((id) => keymap.keyCommand(id)?.title)).toEqual(["Delete", "Cordon", "Pin to compare"]);
    // The settings' keys.
    expect([keymap.keysOf("action.copy-name"), keymap.keysOf("tab.yaml")]).toEqual([["y"], ["shift+y"]]);
    const action = (id: string) => allActions().find((a) => a.id === id)!;
    expect(["logs", "yaml", "compare", "delete"].map((id) => actionKeyId(action(id)))).toEqual(["tab.logs", "tab.yaml", "tab.compare", "action.delete"]);
    expect([keymap.keyCommand("action.logs"), keymap.keyCommand("action.yaml")]).toEqual([undefined, undefined]);
  });
});

describe("the keyboard docs", () => {
  it("name every command, in the row of its group", async () => {
    const { keymap } = await start();
    await import("../details");
    await import("../registry/actions");
    await import("../registry/helmActions");
    // Read from disk, as `ansi.test.ts` reads its CSS.
    const [nodeFs, nodeUrl] = ["node:fs", "node:url"];
    const fs = (await import(/* @vite-ignore */ nodeFs)) as { readFileSync(path: string, encoding: "utf8"): string };
    const { fileURLToPath } = (await import(/* @vite-ignore */ nodeUrl)) as { fileURLToPath(url: string): string };
    const here = import.meta.url;
    const doc = fs.readFileSync(fileURLToPath(new URL("../../../docs/keyboard.md", here).href), "utf8");
    const groups = new Map([...doc.matchAll(/^\| `([a-z]+)` \| (.+) \|$/gm)].map((m) => [m[1], m[2]]));
    const undocumented = keymap
      .keyCommands()
      .map((c) => c.id)
      .filter((id) => !groups.get(id.slice(0, id.indexOf(".")))?.includes(`\`${id.slice(id.indexOf(".") + 1)}\``));
    expect(undocumented).toEqual([]);
  });
});
