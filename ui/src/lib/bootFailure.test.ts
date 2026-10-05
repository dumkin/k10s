import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const engine = vi.hoisted(() => ({ log: vi.fn() }));
vi.mock("./backend", async (importOriginal) => ({ ...(await importOriginal<typeof import("./backend")>()), backend: () => engine }));

import { showBootFailure } from "./bootFailure";

const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>(".boot-failure button")].find((b) => b.textContent === label)!;

beforeEach(() => {
  localStorage.clear();
  engine.log.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("showBootFailure", () => {
  it("says what went wrong instead of a blank window, and logs it", () => {
    showBootFailure(new TypeError("Cannot read properties of null (reading 'length')"), vi.fn());
    expect(document.querySelector(".boot-failure h1")?.textContent).toBe("k10s could not start");
    expect(document.querySelector(".boot-failure .bf-error")?.textContent).toBe("Cannot read properties of null (reading 'length')");
    expect(engine.log).toHaveBeenCalledWith("error", expect.stringContaining("could not start: Cannot read properties of null"));
    // A safe default under the keyboard: Enter reloads, nothing is forgotten.
    expect(document.activeElement).toBe(button("Reload"));
  });

  it("shows the message as text", () => {
    showBootFailure("<img src=x onerror=alert(1)>", vi.fn());
    expect(document.querySelector(".boot-failure img")).toBeNull();
    expect(document.querySelector(".boot-failure .bf-error")?.textContent).toBe("<img src=x onerror=alert(1)>");
  });

  it("reloads", () => {
    const reload = vi.fn();
    showBootFailure(new Error("boom"), reload);
    button("Reload").click();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("resets the saved preferences and reloads", async () => {
    for (const key of ["clusters", "namespaces", "theme", "colWidths"]) localStorage.setItem(`k10s:${key}`, "null");
    localStorage.setItem("elsewhere", "1");
    const reload = vi.fn();
    showBootFailure(new Error("boom"), reload);
    button("Reset preferences").click();
    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    expect(Object.keys(localStorage)).toEqual(["elsewhere"]);
  });

  it("works without an engine, and shows one screen at a time", () => {
    engine.log.mockImplementation(() => {
      throw new Error("backend not initialised");
    });
    showBootFailure(new Error("boom"), vi.fn());
    showBootFailure(new Error("again"), vi.fn());
    expect(document.querySelectorAll(".boot-failure")).toHaveLength(1);
    expect(document.querySelector(".boot-failure .bf-error")?.textContent).toBe("again");
  });
});
