import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const engine = vi.hoisted(() => ({
  log: vi.fn(),
  appInfo: async () => ({ version: "test" }),
  loadPrefs: vi.fn(async () => ({ settings: {}, state: {}, settingsError: null, settingsPath: null, statePath: null })),
  setPrefs: async () => {},
  resetPrefs: async () => {},
}));
vi.mock("./lib/backend", async (importOriginal) => ({ ...(await importOriginal<typeof import("./lib/backend")>()), initBackend: async () => engine, backend: () => engine }));

/** Where the stand-in app fails: as its state loads (reading a saved preference), as it is set up, or as it renders. */
type Failure = { load?: Error; init?: Error; render?: Error };

/** Runs the entry with a stand-in app failing as `fail` says, until it shows the app or why it could not start. */
async function start(fail: Failure = {}) {
  vi.resetModules();
  document.body.innerHTML = '<div id="root"></div>';
  vi.doMock("./state/app", () => {
    if (fail.load) throw fail.load;
    return {
      initApp: () => {
        if (fail.init) throw fail.init;
      },
    };
  });
  vi.doMock("./App", () => ({
    App: () => {
      if (fail.render) throw fail.render;
      const el = document.createElement("div");
      el.className = "app";
      return el;
    },
  }));
  await import("./main");
  await vi.waitFor(() => expect(document.querySelector(".app, .boot-failure")).not.toBeNull());
}

const failure = () => document.querySelector(".boot-failure .bf-error")?.textContent;

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("starting the app", () => {
  it("renders it", async () => {
    await start();
    expect(document.querySelector("#root .app")).not.toBeNull();
    expect(failure()).toBeUndefined();
  });

  it("shows what went wrong when a module throws as it loads", async () => {
    await start({ load: new TypeError("Cannot read properties of null (reading 'length')") });
    // (Vitest words the error of a module that fails this way itself.)
    expect(failure()).toBeTruthy();
    expect(document.querySelector("#root .app")).toBeNull();
  });

  it("starts on the defaults when the settings can't be read, and logs why", async () => {
    engine.loadPrefs.mockRejectedValueOnce(new Error("the engine is gone"));
    await start();
    expect(document.querySelector("#root .app")).not.toBeNull();
    expect(engine.log).toHaveBeenCalledWith("error", "could not read the settings: the engine is gone");
  });

  it("shows what went wrong when setting up or the first render throws", async () => {
    await start({ init: new Error("no clock") });
    expect(failure()).toBe("no clock");
    await start({ render: new Error("no table") });
    expect(failure()).toBe("no table");
  });
});
