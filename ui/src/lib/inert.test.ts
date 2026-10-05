import { afterEach, describe, expect, it } from "vitest";
import { holdInert, restoreFocus } from "./inert";

afterEach(() => {
  document.body.innerHTML = "";
});

describe("holdInert", () => {
  it("keeps the app inert until the last overlapping modal lets go, and lets each go once", () => {
    const root = document.body.appendChild(document.createElement("div"));
    root.id = "root";
    const inert = () => root.hasAttribute("inert");
    // The palette opens while the shortcuts sheet is still closing.
    const sheet = holdInert();
    const palette = holdInert();
    sheet();
    expect(inert()).toBe(true);
    sheet();
    expect(inert()).toBe(true);
    palette();
    expect(inert()).toBe(false);
  });
});

describe("restoreFocus", () => {
  it("gives the keyboard back to what had it when a modal closes — unless it went somewhere on purpose", () => {
    const logs = document.body.appendChild(document.createElement("div"));
    logs.tabIndex = 0;
    const field = document.body.appendChild(document.createElement("input"));
    logs.focus();
    let release = restoreFocus();
    field.focus();
    field.remove();
    release();
    expect(document.activeElement).toBe(logs);
    // Something the modal ran took the keyboard (a terminal, a dialog's field): it keeps it.
    release = restoreFocus();
    const other = document.body.appendChild(document.createElement("input"));
    other.focus();
    release();
    expect(document.activeElement).toBe(other);
  });
});
