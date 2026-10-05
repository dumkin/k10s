import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LogTarget } from "./types";

// `invoke` is a recorder whose answers the tests resolve one by one.
const h = vi.hoisted(() => ({
  calls: [] as { cmd: string; args: Record<string, unknown>; resolve: (v: unknown) => void }[],
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: Record<string, unknown> = {}) => new Promise((resolve) => h.calls.push({ cmd, args, resolve })),
  Channel: class {
    onmessage: (m: unknown) => void = () => {};
  },
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));

const { disarmNativeDialogs, TauriBackend } = await import("./tauri");

const target = (pod: string, id: number): LogTarget => ({ cluster: "prod-eu-z1", namespace: "shop", pod, container: "app", id });
const updates = () => h.calls.filter((c) => c.cmd === "update_log_targets");
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  h.calls.length = 0;
});

describe("TauriBackend.streamLogs", () => {
  it("sends target updates in order, one at a time, the latest only, once the stream has its id", async () => {
    const sub = new TauriBackend().streamLogs({ targets: [target("web-a", 0)], follow: true }, () => {});
    expect(h.calls.map((c) => c.cmd)).toEqual(["stream_logs"]);
    // Before the id arrives: nothing goes out, and only the latest list will.
    sub.setTargets([target("web-b", 1)]);
    sub.setTargets([target("web-c", 2)]);
    await flush();
    expect(updates()).toHaveLength(0);
    h.calls[0].resolve(7);
    await flush();
    expect(updates().map((c) => [c.args.id, (c.args.targets as LogTarget[]).map((t) => t.pod)])).toEqual([[7, ["web-c"]]]);

    // While that one is in flight, two more: the second replaces the first.
    sub.setTargets([target("web-d", 3)]);
    sub.setTargets([target("web-e", 4)]);
    await flush();
    expect(updates()).toHaveLength(1);
    updates()[0].resolve(undefined);
    await flush();
    expect(updates().map((c) => (c.args.targets as LogTarget[])[0].pod)).toEqual(["web-c", "web-e"]);

    // Closed: no more updates, the stream is stopped.
    updates()[1].resolve(undefined);
    sub.close();
    sub.setTargets([target("web-f", 5)]);
    await flush();
    expect(updates()).toHaveLength(2);
    expect(h.calls.at(-1)).toMatchObject({ cmd: "unsubscribe", args: { id: 7 } });
  });
});

describe("TauriBackend.startTerminal", () => {
  const spec = { cluster: "prod-eu-z1", namespace: "shop", pod: "web-1", container: "app" };
  const inputs = () => h.calls.filter((c) => c.cmd === "terminal_input");

  it("sends keystrokes in order, one call at a time, what was typed meanwhile together", async () => {
    const term = new TauriBackend().startTerminal(spec, () => {});
    expect(h.calls.map((c) => c.cmd)).toEqual(["start_terminal"]);
    // Typed and resized before the session has its id: held until it has.
    term.input("l");
    term.input("s");
    term.resize({ cols: 120, rows: 40 });
    await flush();
    expect(inputs()).toHaveLength(0);
    h.calls[0].resolve(9);
    await flush();
    expect(h.calls.find((c) => c.cmd === "terminal_resize")?.args).toEqual({ id: 9, cols: 120, rows: 40 });
    expect(inputs().map((c) => c.args)).toEqual([{ id: 9, data: "ls", binary: false }]);

    // While that call is in flight: Enter, then a mouse report (binary input goes in a call of its own).
    term.input("\r");
    term.input("\x1b[M ab", true);
    await flush();
    expect(inputs()).toHaveLength(1);
    inputs()[0].resolve(undefined);
    await flush();
    expect(inputs().map((c) => c.args.data)).toEqual(["ls", "\r"]);
    inputs()[1].resolve(undefined);
    await flush();
    expect(inputs()[2].args).toEqual({ id: 9, data: "\x1b[M ab", binary: true });

    // Acknowledgements go out at once; nothing after closing.
    term.ack(4096);
    expect(h.calls.at(-1)).toMatchObject({ cmd: "terminal_ack", args: { id: 9, bytes: 4096 } });
    inputs()[2].resolve(undefined);
    term.close();
    term.input("x");
    await flush();
    expect(inputs()).toHaveLength(3);
    expect(h.calls.at(-1)).toMatchObject({ cmd: "unsubscribe", args: { id: 9 } });
  });

  it("starts debug containers and node shells with their own commands", () => {
    const b = new TauriBackend();
    b.startDebug({ ...spec, image: "busybox:1.37", target: "app" }, () => {});
    expect(h.calls.at(-1)).toMatchObject({ cmd: "start_debug", args: { spec: { image: "busybox:1.37", target: "app" } } });
    b.startNodeShell({ cluster: "prod-eu-z1", node: "node-a", namespace: "default", image: "busybox:1.37" }, () => {});
    expect(h.calls.at(-1)).toMatchObject({ cmd: "start_node_shell", args: { spec: { node: "node-a", namespace: "default" } } });
  });
});

describe("TauriBackend settings and YAML", () => {
  it("asks the engine to turn read-only mode on or off, and returns what is in effect", async () => {
    const res = new TauriBackend().setReadOnly(false);
    expect(h.calls.at(-1)).toMatchObject({ cmd: "set_read_only", args: { enabled: false } });
    h.calls.at(-1)!.resolve({ readOnly: true, feedIdleTtlSecs: 180 });
    expect(await res).toEqual({ readOnly: true, feedIdleTtlSecs: 180 });
  });

  it("hides Secret values unless asked to reveal them", () => {
    const b = new TauriBackend();
    const target = { cluster: "prod-eu-z1", resource: "secrets", namespace: "shop", name: "db" };
    void b.getYaml(target, false);
    expect(h.calls.at(-1)).toMatchObject({ cmd: "get_yaml", args: { target, managedFields: false, reveal: false } });
    void b.getYaml(target, true, true);
    expect(h.calls.at(-1)).toMatchObject({ cmd: "get_yaml", args: { managedFields: true, reveal: true } });
  });
});

describe("native dialogs", () => {
  it("refuse in the desktop app, where the dialog plugin makes confirm() a Promise (always truthy)", () => {
    const w = { confirm: async () => true, alert: () => {} } as unknown as Pick<Window, "confirm" | "alert">;
    disarmNativeDialogs(w);
    expect(w.confirm("Delete 12 pods?")).toBe(false);
  });

  it("are not used anywhere but in the browser mock", () => {
    const sources = import.meta.glob<string>(["/src/**/*.{ts,tsx}", "!/src/**/*.test.{ts,tsx}"], { query: "?raw", import: "default", eager: true });
    expect(Object.keys(sources).length).toBeGreaterThan(20);
    const uses = Object.entries(sources)
      .filter(([path, text]) => !path.endsWith("/lib/backend/mock.ts") && /(?<![\w.$])(?:window\.)?(?:confirm|alert|prompt)\(/.test(text))
      .map(([path]) => path);
    expect(uses).toEqual([]);
  });
});

describe("TauriBackend.loadPrefs", () => {
  it("takes the answer index.html asked for as the page started to load, once; then asks anew", async () => {
    const early = Promise.resolve({ settings: { theme: "light" }, state: {}, settingsError: null, settingsPath: null, statePath: null });
    (window as { __K10S_PREFS__?: unknown }).__K10S_PREFS__ = early;
    const backend = new TauriBackend();
    expect(await backend.loadPrefs()).toMatchObject({ settings: { theme: "light" } });
    expect(h.calls).toHaveLength(0);
    expect("__K10S_PREFS__" in window).toBe(false);
    const again = backend.loadPrefs();
    expect(h.calls.map((c) => c.cmd)).toEqual(["prefs_load"]);
    h.calls[0].resolve({ settings: {}, state: {}, settingsError: null, settingsPath: null, statePath: null });
    expect(await again).toMatchObject({ settings: {} });
  });
});
