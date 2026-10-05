import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MockBackend, maskSecret } from "./mock";

describe("maskSecret", () => {
  const secret = () => ({
    apiVersion: "v1",
    kind: "Secret",
    metadata: {
      name: "db",
      annotations: {
        "kubectl.kubernetes.io/last-applied-configuration": '{"apiVersion":"v1","kind":"Secret","stringData":{"password":"hunter2-plain"}}\n',
        team: "payments",
      },
    },
    data: { password: "c3VwZXItc2VjcmV0LXZhbHVl", user: "YWRtaW4=" },
  });

  it("replaces values by their sizes, like the engine, keys and other annotations kept", () => {
    const s = secret();
    maskSecret(s);
    expect(s.data).toEqual({ password: "<hidden: 18 bytes>", user: "<hidden: 5 bytes>" });
    expect(JSON.parse(s.metadata.annotations["kubectl.kubernetes.io/last-applied-configuration"]).stringData).toEqual({ password: "<hidden: 13 bytes>" });
    expect(s.metadata.annotations.team).toBe("payments");
  });

  it("leaves other kinds alone", () => {
    const cm = { apiVersion: "v1", kind: "ConfigMap", data: { a: "b" } };
    maskSecret(cm);
    expect(cm.data).toEqual({ a: "b" });
  });
});

describe("MockBackend settings", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("turns read-only mode off only when confirmed, never through setSettings", async () => {
    const mock = new MockBackend();
    expect((await mock.setReadOnly(true)).readOnly).toBe(true);
    expect((await mock.setSettings({ readOnly: false, feedIdleTtlSecs: 60 })).readOnly).toBe(true);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    expect((await mock.setReadOnly(false)).readOnly).toBe(true);
    confirm.mockReturnValue(true);
    expect((await mock.setReadOnly(false)).readOnly).toBe(false);
    expect(confirm).toHaveBeenCalledTimes(2);
    // Kept for the next page load, like the engine's settings file.
    await mock.setReadOnly(true);
    expect((await new MockBackend().getSettings()).readOnly).toBe(true);
  });

  it("keeps stand-ins for the app's files: settings the UI can't write, a reset that keeps read-only mode", async () => {
    const mock = new MockBackend();
    await mock.setReadOnly(true);
    await mock.setPrefs([
      { doc: "settings", key: "logs.tail", value: 500 },
      { doc: "settings", key: "readOnly", value: false },
      { doc: "state", key: "clusters", value: ["kind-a"] },
    ]);
    const files = await new MockBackend().loadPrefs();
    expect([files.settings, files.state]).toEqual([{ readOnly: true, feedIdleTtlSecs: 180, logs: { tail: 500 } }, { clusters: ["kind-a"] }]);
    // A copy: changing it changes nothing.
    (files.settings.logs as Record<string, unknown>).tail = 1;
    expect((await mock.loadPrefs()).settings.logs).toEqual({ tail: 500 });
    await mock.resetPrefs();
    const after = await new MockBackend().loadPrefs();
    expect([after.settings, after.state]).toEqual([{ readOnly: true, feedIdleTtlSecs: 180 }, {}]);
  });

  it("tells the UI about an edit of the settings file, and goes read-only when it can't be read", async () => {
    const mock = new MockBackend();
    const changes: unknown[] = [];
    mock.onSettingsChanged((c) => changes.push(c));
    mock.editSettingsFile({ theme: "light" });
    mock.editSettingsFile({}, "expected value at line 1 column 1");
    expect(changes).toEqual([
      { settings: { theme: "light" }, error: null, engine: { readOnly: false, feedIdleTtlSecs: 180 } },
      { settings: { theme: "light" }, error: "expected value at line 1 column 1", engine: { readOnly: true, feedIdleTtlSecs: 180 } },
    ]);
  });
});
