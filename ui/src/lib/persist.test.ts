import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrefsChange, PrefsSnapshot } from "./backend";
import { arrayOf, clearPreferences, getAt, isBoolean, isNumber, isString, load, oneOf, persisted, recordOf, setAt } from "./persist";

beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

describe("load", () => {
  const isStrings = arrayOf(isString);

  it("returns what was saved when it has the right shape", () => {
    localStorage.setItem("k10s:clusters", JSON.stringify(["prod-eu-z1", "prod-eu-z2"]));
    expect(load("clusters", [], isStrings)).toEqual(["prod-eu-z1", "prod-eu-z2"]);
  });

  it("falls back to the default for anything else", () => {
    expect(load("clusters", ["kind-local"], isStrings)).toEqual(["kind-local"]);
    for (const raw of ["null", "{}", '"prod-eu-z1"', "[null]", '["prod-eu-z1", 3]', "not json", ""]) {
      localStorage.setItem("k10s:clusters", raw);
      expect(load("clusters", [], isStrings), raw).toEqual([]);
    }
  });

  it("falls back when storage can't be read", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("denied", "SecurityError");
    });
    expect(load("theme", "dark", oneOf("dark", "light"))).toBe("dark");
  });
});

describe("checks", () => {
  it("tell the shapes apart", () => {
    const widths = recordOf(recordOf(isNumber));
    expect(widths({ pods: { name: 280 } })).toBe(true);
    expect(widths({ pods: { name: "280" } })).toBe(false);
    expect(widths({ pods: [280] })).toBe(false);
    expect(widths([])).toBe(false);
    expect(widths(null)).toBe(false);
    // JSON has no Infinity, but `1e999` parses to it.
    expect(isNumber(JSON.parse("1e999"))).toBe(false);
    expect(oneOf("dark", "light", "system")("system")).toBe(true);
    expect(oneOf("dark", "light", "system")("blue")).toBe(false);
  });
});

describe("persisted", () => {
  it("keeps the default over a stored value of the wrong shape, and saves what is set", () => {
    localStorage.setItem("k10s:sidebarCollapsed", JSON.stringify(["access"]));
    const [collapsed, setCollapsed] = persisted<Record<string, boolean>>("sidebarCollapsed", { admin: true }, recordOf((v): v is boolean => typeof v === "boolean"));
    expect(collapsed()).toEqual({ admin: true });
    setCollapsed((prev) => ({ ...prev, access: true }));
    expect(JSON.parse(localStorage.getItem("k10s:sidebarCollapsed")!)).toEqual({ admin: true, access: true });
  });
});

describe("clearPreferences", () => {
  it("forgets every saved preference, and nothing else", async () => {
    localStorage.setItem("k10s:clusters", "null");
    localStorage.setItem("k10s:theme", '"light"');
    localStorage.setItem("other-app:theme", '"light"');
    await clearPreferences();
    expect(Object.keys(localStorage)).toEqual(["other-app:theme"]);
  });
});

describe("paths in a file", () => {
  it("nest by the dots of a key, and removing one takes what was only there for it", () => {
    const doc: Record<string, unknown> = { theme: "dark" };
    setAt(doc, "logs.tail", 500);
    setAt(doc, "logs.wrap", true);
    expect(doc).toEqual({ theme: "dark", logs: { tail: 500, wrap: true } });
    expect([getAt(doc, "logs.tail"), getAt(doc, "logs.nope"), getAt(doc, "theme.x"), getAt(doc, "constructor")]).toEqual([500, undefined, undefined, undefined]);
    setAt(doc, "logs.tail", null);
    expect(doc).toEqual({ theme: "dark", logs: { wrap: true } });
    setAt(doc, "logs.wrap", undefined);
    expect(doc).toEqual({ theme: "dark" });
    // Something else where an object goes is replaced.
    setAt(doc, "theme.x", 1);
    expect(doc).toEqual({ theme: { x: 1 } });
  });
});

describe("the app's files", () => {
  const snapshot = (settings: Record<string, unknown> = {}, state: Record<string, unknown> = {}): PrefsSnapshot => ({
    settings,
    state,
    settingsError: null,
    settingsPath: "/home/me/.config/io.dumkin.k10s/settings.json",
    statePath: "/home/me/.config/io.dumkin.k10s/state.json",
  });

  /**
   * A fresh copy of the module keeping its values in files from `snap`, and the batches it sends: each one waits until
   * `arrived()` says the app has it, unless `instant`.
   */
  async function withFiles(snap: PrefsSnapshot, instant = true) {
    vi.resetModules();
    const persist = await import("./persist");
    const batches: PrefsChange[][] = [];
    const waiting: (() => void)[] = [];
    const reset = vi.fn(async () => {});
    persist.useFiles(snap, (batch) => (batches.push(batch), instant ? Promise.resolve() : new Promise<void>((done) => waiting.push(done))), reset);
    const arrived = () => waiting.shift()?.();
    const sent = () => batches.flat().map((c) => [c.doc, c.key, c.value]);
    return { persist, batches, sent, arrived, reset };
  }

  it("reads settings and state from their files, and sends what changes", async () => {
    const { persist, sent } = await withFiles(snapshot({ logs: { tail: 500 } }, { clusters: ["kind-a"] }));
    const [tail, setTail] = persist.setting("logs.tail", 1000, isNumber);
    const [clusters, setClusters] = persist.persisted("clusters", [] as string[], arrayOf(isString));
    expect([tail(), clusters()]).toEqual([500, ["kind-a"]]);
    setTail(5000);
    setClusters(["kind-b"]);
    persist.save("openObject", null);
    expect(sent()).toEqual([]);
    await Promise.resolve();
    expect(sent()).toEqual([
      ["settings", "logs.tail", 5000],
      ["state", "clusters", ["kind-b"]],
      ["state", "openObject", null],
    ]);
    expect(persist.settingsFile()).toEqual({ logs: { tail: 5000 } });
    // Nothing goes to the web view's own storage.
    expect(localStorage.length).toBe(0);
  });

  it("follows an edit of the settings file made outside the app, without writing it back", async () => {
    const { persist, sent } = await withFiles(snapshot({ theme: "light", logs: { wrap: true } }));
    const [theme] = persist.setting("theme", "dark", oneOf("dark", "light", "system"));
    const [wrap] = persist.setting("logs.wrap", false, isBoolean);
    persist.settingsEdited({ theme: "system" }, null);
    expect([theme(), wrap()]).toEqual(["system", false]);
    expect(persist.settingsFile()).toEqual({ theme: "system" });
    // Broken: the settings stay as they are, and the error is said.
    persist.settingsEdited({}, "expected value at line 1 column 2");
    expect(theme()).toBe("system");
    expect(persist.filesInfo()?.settingsError).toBe("expected value at line 1 column 2");
    persist.settingsEdited({ theme: "sepia" }, null);
    expect([theme(), persist.filesInfo()?.settingsError]).toEqual(["dark", null]);
    await Promise.resolve();
    expect(sent()).toEqual([]);
  });

  it("sends one batch at a time, in order, with the latest value of each, and no more often than it must", async () => {
    vi.useFakeTimers();
    try {
      const { persist, batches, arrived } = await withFiles(snapshot(), false);
      const [, setWidth] = persist.persisted("sidebarWidth", 228, isNumber);
      // A drag: one batch with where it got to in this task.
      setWidth(240);
      setWidth(250);
      await vi.advanceTimersByTimeAsync(0);
      expect(batches).toEqual([[{ doc: "state", key: "sidebarWidth", value: 250 }]]);
      // While that one is on its way, the next ones wait, and only the latest goes.
      setWidth(260);
      setWidth(270);
      persist.save("resource", "nodes");
      await vi.advanceTimersByTimeAsync(100);
      expect(batches).toHaveLength(1);
      arrived();
      await vi.advanceTimersByTimeAsync(persist.SEND_EVERY_MS);
      expect(batches[1]).toEqual([
        { doc: "state", key: "sidebarWidth", value: 270 },
        { doc: "state", key: "resource", value: "nodes" },
      ]);
      // A reset drops what was not sent yet.
      setWidth(300);
      await persist.clearPreferences();
      arrived();
      await vi.advanceTimersByTimeAsync(persist.SEND_EVERY_MS * 2);
      expect(batches).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("spaces batches out also when the app takes each at once", async () => {
    vi.useFakeTimers();
    try {
      const { persist, batches } = await withFiles(snapshot());
      const [, setWidth] = persist.persisted("sidebarWidth", 228, isNumber);
      // A drag, a frame at a time: the first width goes at once, the next ones wait for their turn.
      setWidth(240);
      await vi.advanceTimersByTimeAsync(16);
      setWidth(250);
      await vi.advanceTimersByTimeAsync(16);
      setWidth(260);
      expect(batches).toEqual([[{ doc: "state", key: "sidebarWidth", value: 240 }]]);
      await vi.advanceTimersByTimeAsync(persist.SEND_EVERY_MS);
      expect(batches).toEqual([[{ doc: "state", key: "sidebarWidth", value: 240 }], [{ doc: "state", key: "sidebarWidth", value: 260 }]]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows the engine's settings in the file, and resets through the app", async () => {
    const { persist, reset } = await withFiles(snapshot({ theme: "light" }));
    persist.engineSettingsSaved({ readOnly: true, feedIdleTtlSecs: 180 });
    expect(persist.settingsFile()).toEqual({ theme: "light", readOnly: true, feedIdleTtlSecs: 180 });
    await persist.clearPreferences();
    expect(reset).toHaveBeenCalledTimes(1);
  });
});

describe("starting with whatever is in storage", () => {
  /** Imports what reads saved preferences as it loads: the app's state and its components. */
  const loadApp = async () => {
    vi.resetModules();
    await import("../App");
    await import("../state/app");
    return { clusters: await import("../state/clusters"), nav: await import("../state/nav"), table: await import("../state/table"), ui: await import("../state/ui") };
  };

  it("never fails to load: a stored value of the wrong shape is the default", async () => {
    const read = vi.spyOn(Storage.prototype, "getItem");
    await loadApp();
    const keys = [...new Set(read.mock.calls.map(([key]) => key))].filter((key) => key.startsWith("k10s:"));
    read.mockRestore();
    // Values like these left the window blank: "Cannot read properties of null (reading 'length')".
    expect(keys).toEqual(expect.arrayContaining(["k10s:clusters", "k10s:namespaces", "k10s:namespaceMemory", "k10s:colWidths", "k10s:theme", "k10s:logs.tail"]));

    for (const raw of ["null", "{}", "[]", '"x"', "0", "true", "[null]", '{"a":null}', '{"a":{"b":null}}', "1e999", "not json"]) {
      for (const key of keys) localStorage.setItem(key, raw);
      const { clusters, nav, table, ui } = await loadApp();
      expect([clusters.selectedClusters(), clusters.savedSets(), clusters.recentClusters()], raw).toEqual([[], [], []]);
      expect([...clusters.clusterShortNames()], raw).toEqual([]);
      expect([nav.resourceKey(), nav.namespaces(), nav.recentNamespaces(), nav.namespaceKeys()], raw).toEqual([raw === '"x"' ? "x" : "pods", [], [], []]);
      expect(table.sort(), raw).toEqual({ col: "name", desc: false });
      expect([ui.themePref(), ui.sidebarWidth(), ui.detailsWidth()], raw).toEqual(["dark", 228, 620]);
    }
  });
});
