import { afterEach, describe, expect, it, vi } from "vitest";

type Hotkeys = typeof import("./hotkeys");

/** A fresh copy of the module as it behaves on macOS or elsewhere (`isMac` is read once, at import). */
async function load(platform: "MacIntel" | "Linux x86_64"): Promise<Hotkeys> {
  vi.resetModules();
  vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
  return import("./hotkeys");
}

afterEach(() => vi.restoreAllMocks());

const key = (init: KeyboardEventInit) => new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });

describe("keyCombos", () => {
  it("matches Latin layouts by the typed character", async () => {
    const { keyCombos } = await load("MacIntel");
    expect(keyCombos(key({ key: "j", code: "KeyJ" }))).toEqual(["j"]);
    expect(keyCombos(key({ key: "R", code: "KeyR", shiftKey: true }))).toEqual(["shift+r"]);
    expect(keyCombos(key({ key: ":", code: "Semicolon", shiftKey: true }))).toEqual([":"]);
    expect(keyCombos(key({ key: "k", code: "KeyK", metaKey: true }))).toEqual(["mod+k"]);
    expect(keyCombos(key({ key: "Enter", code: "Enter", metaKey: true }))).toEqual(["mod+enter"]);
    expect(keyCombos(key({ key: " ", code: "Space" }))).toEqual(["space"]);
    // AZERTY: the key at QWERTY's A types "q"; QWERTZ: the key at QWERTY's Y types "z". The character counts.
    expect(keyCombos(key({ key: "q", code: "KeyA" }))).toEqual(["q"]);
    expect(keyCombos(key({ key: "z", code: "KeyY" }))).toEqual(["z"]);
    // Latin letters with diacritics (German "ö") don't make the key mean something else.
    expect(keyCombos(key({ key: "Ö", code: "Semicolon", shiftKey: true }))).toEqual(["ö"]);
  });

  it("falls back to the key position on non-Latin layouts (Russian)", async () => {
    const { keyCombos } = await load("MacIntel");
    expect(keyCombos(key({ key: "о", code: "KeyJ" }))).toEqual(["о", "j"]);
    expect(keyCombos(key({ key: "л", code: "KeyK" }))).toEqual(["л", "k"]);
    expect(keyCombos(key({ key: "К", code: "KeyR", shiftKey: true }))).toEqual(["к", "shift+r"]);
    expect(keyCombos(key({ key: "П", code: "KeyG", shiftKey: true }))).toEqual(["п", "shift+g"]);
    expect(keyCombos(key({ key: "ф", code: "KeyA", metaKey: true }))).toEqual(["mod+ф", "mod+a"]);
    // Shift+Ж is where ":" is on a US keyboard (k9s muscle memory); "х" is "[".
    expect(keyCombos(key({ key: "Ж", code: "Semicolon", shiftKey: true }))).toEqual(["ж", ":"]);
    expect(keyCombos(key({ key: "х", code: "BracketLeft", metaKey: true }))).toEqual(["mod+х", "mod+["]);
  });

  it("maps punctuation by position while a non-Latin layout is active, the typed character first", async () => {
    const { keyCombos } = await load("Linux x86_64");
    // Russian (PC) types "." on the "/" key: "/" works even before a letter key showed the layout.
    expect(keyCombos(key({ key: ".", code: "Slash" }))).toEqual([".", "/"]);
    expect(keyCombos(key({ key: "-", code: "Minus" }))).toEqual(["-"]);
    keyCombos(key({ key: "о", code: "KeyJ" }));
    expect(keyCombos(key({ key: ".", code: "Slash" }))).toEqual([".", "/"]);
    // Russian (PC) ":" is Shift+6: the typed ":" comes first.
    expect(keyCombos(key({ key: ":", code: "Digit6", shiftKey: true }))).toEqual([":", "^"]);
    expect(keyCombos(key({ key: "Escape", code: "Escape" }))).toEqual(["escape"]);
    // Back on a Latin layout: punctuation means what it types again.
    keyCombos(key({ key: "j", code: "KeyJ" }));
    expect(keyCombos(key({ key: "-", code: "Slash" }))).toEqual(["-"]);
  });

  it("matches Latin letters by the typed character even after a non-Latin layout was used", async () => {
    // Russian, then Colemak / Dvorak: their ⌃S / ⌃E sit on QWERTY's D, which must not become ⌃D (delete).
    const linux = await load("Linux x86_64");
    linux.keyCombos(key({ key: "о", code: "KeyJ" }));
    expect(linux.keyCombos(key({ key: "s", code: "KeyD", ctrlKey: true }))).toEqual(["mod+s"]);
    expect(linux.keyCombos(key({ key: "e", code: "KeyD", ctrlKey: true }))).toEqual(["mod+e"]);
    expect(linux.keyCombos(key({ key: "ф", code: "KeyA", ctrlKey: true }))).toEqual(["mod+ф", "mod+a"]);
    const mac = await load("MacIntel");
    mac.keyCombos(key({ key: "о", code: "KeyJ" }));
    expect(mac.keyCombos(key({ key: "s", code: "KeyD", ctrlKey: true }))).toEqual(["ctrl+s"]);
    expect(mac.keyCombos(key({ key: "r", code: "KeyP", metaKey: true }))).toEqual(["mod+r"]);
    // Punctuation still maps by position while the layout is known to be non-Latin.
    expect(mac.keyCombos(key({ key: ":", code: "Digit6", shiftKey: true }))).toEqual([":", "^"]);
  });

  it("folds Ctrl into mod off macOS and keeps them apart on macOS", async () => {
    const linux = await load("Linux x86_64");
    expect(linux.keyCombos(key({ key: "d", code: "KeyD", ctrlKey: true }))).toEqual(["mod+d"]);
    expect(linux.keyCombos(key({ key: "в", code: "KeyD", ctrlKey: true }))).toEqual(["mod+в", "mod+d"]);
    expect(linux.canonicalCombo("ctrl+d")).toBe("mod+d");
    expect(linux.canonicalCombo("shift+mod+alt+i")).toBe("mod+alt+shift+i");
    const mac = await load("MacIntel");
    expect(mac.keyCombos(key({ key: "d", code: "KeyD", ctrlKey: true }))).toEqual(["ctrl+d"]);
    expect(mac.canonicalCombo("ctrl+d")).toBe("ctrl+d");
  });

  it("matches ⌥ combos on macOS by the key, whatever ⌥ types there", async () => {
    const mac = await load("MacIntel");
    // ⌥1 types "¡", ⌥K "˚", ⌥E is a dead key (on a Russian layout too: the key's place counts).
    expect(mac.keyCombos(key({ key: "¡", code: "Digit1", altKey: true }))).toEqual(["alt+¡", "alt+1"]);
    expect(mac.keyCombos(key({ key: "º", code: "Digit0", altKey: true }))).toEqual(["alt+º", "alt+0"]);
    expect(mac.keyCombos(key({ key: "˚", code: "KeyK", altKey: true }))).toEqual(["alt+˚", "alt+k"]);
    expect(mac.keyCombos(key({ key: "Dead", code: "KeyE", altKey: true }))).toEqual(["alt+dead", "alt+e"]);
    expect(mac.keyCombos(key({ key: "ArrowLeft", code: "ArrowLeft", altKey: true }))).toEqual(["alt+arrowleft"]);
    // Elsewhere Alt+1 types "1".
    const linux = await load("Linux x86_64");
    expect(linux.keyCombos(key({ key: "1", code: "Digit1", altKey: true }))).toEqual(["alt+1"]);
  });

  it("ignores keydowns without a key (autofill)", async () => {
    const { keyCombos } = await load("MacIntel");
    expect(keyCombos(new KeyboardEvent("keydown"))).toEqual([]);
  });
});

describe("installHotkeys", () => {
  it("fires ctrl+… bindings with Ctrl off macOS, and hotkeys on a Russian layout", async () => {
    const { bindAll, installHotkeys } = await load("Linux x86_64");
    const fired: string[] = [];
    installHotkeys();
    const off = bindAll(["ctrl+d", "shift+r", "/", "j"].map((combo) => ({ combo, run: () => void fired.push(combo) })));
    const press = (init: KeyboardEventInit) => {
      const e = key(init);
      document.body.dispatchEvent(e);
      return e;
    };
    expect(press({ key: "d", code: "KeyD", ctrlKey: true }).defaultPrevented).toBe(true);
    press({ key: "К", code: "KeyR", shiftKey: true });
    press({ key: ".", code: "Slash" });
    press({ key: "о", code: "KeyJ" });
    expect(fired).toEqual(["ctrl+d", "shift+r", "/", "j"]);
    off();
  });

  it("tries the bindings of a combo by priority, then in the order they were bound, also as they come and go", async () => {
    const { bind, installHotkeys } = await load("MacIntel");
    const fired: string[] = [];
    installHotkeys();
    const tried = (name: string, handles = true) => () => (fired.push(name), handles);
    const offs = [
      bind({ combo: "escape", run: tried("first") }),
      bind({ combo: "escape", priority: 10, run: tried("declines", false) }),
      bind({ combo: "escape", run: tried("second") }),
      bind({ combo: "mod+escape", priority: 100, run: tried("other combo") }),
    ];
    const esc = () => document.body.dispatchEvent(key({ key: "Escape", code: "Escape" }));
    esc();
    expect(fired).toEqual(["declines", "first"]);
    offs[0]();
    esc();
    const offLate = bind({ combo: "escape", priority: 5, run: tried("late") });
    esc();
    expect(fired).toEqual(["declines", "first", "declines", "second", "declines", "late"]);
    [...offs, offLate].forEach((off) => off());
  });

  it("prefers the typed character over the key position", async () => {
    const { bindAll, installHotkeys } = await load("Linux x86_64");
    const fired: string[] = [];
    installHotkeys();
    const off = bindAll([
      { combo: "/", priority: 100, run: () => void fired.push("/") },
      { combo: ".", run: () => void fired.push(".") },
    ]);
    document.body.dispatchEvent(key({ key: "о", code: "KeyJ" }));
    document.body.dispatchEvent(key({ key: ".", code: "Slash" }));
    expect(fired).toEqual(["."]);
    off();
  });
});

describe("terminals", () => {
  it("get every key but those meant to work there too", async () => {
    const { bindAll, installHotkeys } = await load("MacIntel");
    const fired: string[] = [];
    installHotkeys();
    const off = bindAll([
      { combo: "escape", inInputs: true, run: () => void fired.push("escape") },
      { combo: "j", run: () => void fired.push("j") },
      { combo: "mod+k", inInputs: true, inTerminal: true, run: () => void fired.push("mod+k") },
    ]);
    const term = document.createElement("div");
    term.dataset.ownKeys = "";
    const input = document.createElement("textarea");
    term.append(input);
    document.body.append(term);
    const press = (init: KeyboardEventInit) => {
      const e = key(init);
      input.dispatchEvent(e);
      return e;
    };
    // Escape belongs to vi, j to the shell: left alone (not even default-prevented).
    expect(press({ key: "Escape", code: "Escape" }).defaultPrevented).toBe(false);
    expect(press({ key: "j", code: "KeyJ" }).defaultPrevented).toBe(false);
    expect(fired).toEqual([]);
    // ⌘K is no terminal key: the palette opens.
    expect(press({ key: "k", code: "KeyK", metaKey: true }).defaultPrevented).toBe(true);
    expect(fired).toEqual(["mod+k"]);
    // Outside the terminal everything works as before.
    document.body.dispatchEvent(key({ key: "Escape", code: "Escape" }));
    expect(fired).toEqual(["mod+k", "escape"]);
    term.remove();
    off();
  });
});

describe("comboLabel", () => {
  it("labels combos for the platform", async () => {
    const mac = await load("MacIntel");
    expect(mac.comboLabel("mod+shift+c")).toBe("⌘⇧C");
    expect(mac.comboLabel("ctrl+d")).toBe("⌃D");
    expect(mac.comboLabel("mod+[")).toBe("⌘[");
    const linux = await load("Linux x86_64");
    expect(linux.comboLabel("ctrl+d")).toBe("Ctrl+D");
    expect(linux.comboLabel("mod+shift+c")).toBe("Ctrl+Shift+C");
    expect(linux.comboLabel("alt+arrowleft")).toBe("Alt+←");
    expect(linux.comboLabel("mod++")).toBe("Ctrl++");
    expect([mac.comboLabel("alt+1"), mac.comboLabel("pagedown"), linux.comboLabel("alt+1")]).toEqual(["⌥1", "PgDn", "Alt+1"]);
  });
});
