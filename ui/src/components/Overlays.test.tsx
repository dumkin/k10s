import { render } from "solid-js/web";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { installHotkeys, isMac } from "../lib/hotkeys";
import { replicasError } from "../registry/actions";
import { ask, busyToast, dialog, dismissToast, setDialog, toast, toasts } from "../state/ui";
import { DIALOG_ARM_MS, DIALOG_MAX_ITEMS, Dialog, TOAST_LEAVE_MS, Toasts } from "./Overlays";

const errors: string[] = [];
let dispose: () => void;

beforeAll(() => {
  installHotkeys();
  // Exceptions in event handlers don't reach the test; they surface here.
  window.addEventListener("error", (e) => errors.push(e.message));
});

beforeEach(() => {
  errors.length = 0;
  // The app (what the dialog puts out of reach while it is open; the dialog itself renders in a portal).
  const app = document.createElement("div");
  app.id = "root";
  const host = document.createElement("div");
  document.body.append(app, host);
  dispose = render(() => <Dialog />, host);
});

afterEach(() => {
  dialog()?.resolve(null);
  dispose();
  document.body.innerHTML = "";
});

/** The promise's value, or "pending" if it hasn't settled shortly. */
const settled = <T,>(p: Promise<T>) => Promise.race([p, new Promise<"pending">((r) => setTimeout(() => r("pending"), 50))]);
/** Keyboard confirmation only works once the dialog has been open for a moment. */
const armed = () => new Promise((r) => setTimeout(r, DIALOG_ARM_MS + 20));
const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>(".dialog button")].find((b) => b.textContent?.trim() === label)!;
/** A real mouse click (`detail` 1, 2 for the second click of a double-click); `button.click()` looks like keyboard activation (`detail` 0). */
const mouseClick = (el: Element, detail = 1) => el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail }));
const input = () => document.querySelector<HTMLInputElement>(".dialog input")!;
const press = (target: Element, key: string, init: KeyboardEventInit = {}) => {
  const e = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(e);
  return e;
};
const modEnter = (target: Element, init: KeyboardEventInit = {}) => press(target, "Enter", { ...(isMac ? { metaKey: true } : { ctrlKey: true }), ...init });
const type = (value: string) => {
  input().value = value;
  input().dispatchEvent(new InputEvent("input", { bubbles: true }));
};

describe("confirm dialog", () => {
  it("resolves with the dialog state on confirm and closes", async () => {
    const result = ask({ title: "Delete pod?", confirmLabel: "Delete", danger: true, checkbox: { label: "Force", value: false } });
    await armed();
    mouseClick(button("Delete"));
    expect(await settled(result)).toEqual({ input: "", checkbox: false });
    expect(dialog()).toBeNull();
    expect(document.querySelector(".dialog")).toBeNull();
    expect(errors).toEqual([]);
  });

  it("resolves null on cancel", async () => {
    const result = ask({ title: "Restart?", confirmLabel: "Restart" });
    mouseClick(button("Cancel"));
    expect(await settled(result)).toBeNull();
    expect(errors).toEqual([]);
  });

  it("opens destructive dialogs on Cancel and confirms them with ⌘↵", async () => {
    const result = ask({ title: "Delete pod?", confirmLabel: "Delete", danger: true });
    expect(document.activeElement).toBe(button("Cancel"));
    await armed();
    modEnter(document.activeElement!);
    expect(await settled(result)).toEqual({ input: "", checkbox: false });
  });

  it("ignores keyboard confirmation right after opening and from auto-repeat", async () => {
    const result = ask({ title: "Delete pod?", confirmLabel: "Delete", danger: true });
    // The press that opened the dialog (e.g. ⌘↵ on the previous one, or in the palette) is still down.
    modEnter(document.activeElement!);
    button("Delete").click();
    expect(await settled(result)).toBe("pending");
    await armed();
    expect(modEnter(document.activeElement!, { repeat: true }).defaultPrevented).toBe(true);
    expect(await settled(result)).toBe("pending");
    button("Delete").click();
    expect(await settled(result)).toEqual({ input: "", checkbox: false });
  });

  it("does not take the second click of the double-click that opened it as a confirmation", async () => {
    // A double-click on "Delete…" in a context menu: the first click opens the dialog, the second lands on its button.
    const result = ask({ title: "Delete payments-api?", confirmLabel: "Delete", danger: true });
    mouseClick(button("Delete"), 2);
    // A single click as quick as that is no deliberate one either.
    mouseClick(button("Delete"));
    expect(await settled(result)).toBe("pending");
    await armed();
    // However slow the double-click (macOS lets users make it seconds long), its second click never confirms.
    mouseClick(button("Delete"), 2);
    expect(await settled(result)).toBe("pending");
    mouseClick(button("Delete"));
    expect(await settled(result)).toEqual({ input: "", checkbox: false });
  });

  it("keeps Tab inside, puts the app out of reach meanwhile and gives focus back when it closes", async () => {
    const before = document.createElement("button");
    document.getElementById("root")!.append(before);
    before.focus();
    const result = ask({ title: "Scale", confirmLabel: "Scale", input: { value: "3" }, validate: replicasError });
    expect(document.getElementById("root")!.hasAttribute("inert")).toBe(true);
    expect(document.activeElement).toBe(input());
    press(input(), "Tab");
    expect(document.activeElement).toBe(button("Cancel"));
    press(button("Cancel"), "Tab");
    expect(document.activeElement).toBe(button("Scale"));
    press(button("Scale"), "Tab");
    expect(document.activeElement).toBe(input());
    press(input(), "Tab", { shiftKey: true });
    expect(document.activeElement).toBe(button("Scale"));

    press(document.activeElement!, "Escape");
    expect(await settled(result)).toBeNull();
    expect(document.getElementById("root")!.hasAttribute("inert")).toBe(false);
    expect(document.activeElement).toBe(before);
  });

  it("opens every confirmation on Cancel, destructive or not", () => {
    void ask({ title: "Run now?", confirmLabel: "Create job" });
    expect(document.activeElement).toBe(button("Cancel"));
  });

  it("swallows auto-repeated Enter and Space, lets fresh presses through", () => {
    void ask({ title: "Run now?", confirmLabel: "Create job" });
    const confirm = button("Create job");
    expect(press(confirm, "Enter", { repeat: true }).defaultPrevented).toBe(true);
    expect(press(confirm, " ", { repeat: true }).defaultPrevented).toBe(true);
    expect(press(confirm, "Enter").defaultPrevented).toBe(false);
  });

  it("blocks confirming while the input is invalid", async () => {
    const result = ask({ title: "Scale", confirmLabel: "Scale", input: { value: "" }, validate: replicasError });
    expect(document.activeElement).toBe(input());
    expect(button("Scale").disabled).toBe(true);
    await armed();

    press(input(), "Enter");
    modEnter(input());
    mouseClick(button("Scale"));
    expect(await settled(result)).toBe("pending");

    type("3,");
    expect(document.querySelector(".dlg-error")?.textContent).toMatch(/whole number/);
    press(input(), "Enter");
    expect(await settled(result)).toBe("pending");

    type("4");
    expect(button("Scale").disabled).toBe(false);
    // Default prevented: no keypress may reach whatever gets focus next (a chained dialog's button).
    expect(press(input(), "Enter").defaultPrevented).toBe(true);
    expect(await settled(result)).toEqual({ input: "4", checkbox: false });
  });

  it("cancels an open request when a new one arrives", async () => {
    const first = ask({ title: "First?", confirmLabel: "OK" });
    void ask({ title: "Second?", confirmLabel: "OK" });
    expect(await settled(first)).toBeNull();
    expect(document.querySelector(".dialog h2")?.textContent).toBe("Second?");
  });
});

describe("fields and choices", () => {
  it("start where the typing goes, block confirming while a field is empty, and resolve with what they hold", async () => {
    const result = ask({ title: "Open a shell on node-a?", fields: [{ label: "Image", value: "busybox:1.37" }, { label: "Namespace", value: "default" }], confirmLabel: "Open shell" });
    const [image, namespace] = [...document.querySelectorAll<HTMLInputElement>(".dialog .dlg-field input")];
    expect(document.activeElement).toBe(image);
    namespace.value = "  ";
    namespace.dispatchEvent(new InputEvent("input", { bubbles: true }));
    expect(button("Open shell").disabled).toBe(true);
    namespace.value = " kube-system ";
    namespace.dispatchEvent(new InputEvent("input", { bubbles: true }));
    await armed();
    press(namespace, "Enter");
    expect(await settled(result)).toEqual({ input: "", checkbox: false, fields: ["busybox:1.37", "kube-system"] });
  });

  it("picks one option with the keyboard: the default is focused, arrows move, Enter confirms", async () => {
    const result = ask({
      title: "Shell in web-1",
      choice: { label: "Container", options: [{ value: "app", label: "app" }, { value: "envoy", label: "envoy", meta: "running" }], value: "app" },
      confirmLabel: "Open",
    });
    const radios = [...document.querySelectorAll<HTMLInputElement>(".dialog input[type=radio]")];
    expect(document.activeElement).toBe(radios[0]);
    // What the browser does on ↓ in a radio group.
    radios[1].checked = true;
    radios[1].dispatchEvent(new Event("change", { bubbles: true }));
    radios[1].focus();
    await armed();
    press(radios[1], "Enter");
    expect(await settled(result)).toEqual({ input: "", checkbox: false, choice: "envoy" });
  });
});

describe("replicasError", () => {
  it("accepts whole numbers only", () => {
    for (const ok of ["0", "3", " 12 ", "10000"]) expect(replicasError(ok)).toBeNull();
    for (const bad of ["3,", "-1", "1.5", "1e3", "abc", "10001"]) expect(replicasError(bad)).toBeTruthy();
  });

  it("blocks empty input without a message", () => {
    expect(replicasError("")).toBe("");
    expect(replicasError("   ")).toBe("");
  });
});

const typeConfirmation = (value: string) => {
  const el = document.querySelector<HTMLInputElement>(".dlg-confirm input")!;
  el.value = value;
  el.dispatchEvent(new InputEvent("input", { bubbles: true }));
  return el;
};

describe("typed confirmation", () => {
  it("keeps confirming blocked until the exact text is typed, opening where the typing goes", async () => {
    const result = ask({ title: "Delete 12 pods?", confirmLabel: "Delete", danger: true, confirmText: "delete 12" });
    const field = document.querySelector<HTMLInputElement>(".dlg-confirm input")!;
    expect(document.activeElement).toBe(field);
    expect(document.querySelector(".dlg-confirm label")?.textContent).toBe("Type delete 12 to confirm");
    expect(button("Delete").disabled).toBe(true);
    await armed();

    for (const wrong of ["", "delete", "delete 1", "Delete 12", "delete 120"]) {
      typeConfirmation(wrong);
      press(field, "Enter");
      modEnter(field);
      mouseClick(button("Delete"));
      expect(button("Delete").disabled).toBe(true);
    }
    expect(await settled(result)).toBe("pending");

    typeConfirmation(" delete 12 ");
    expect(button("Delete").disabled).toBe(false);
    expect(press(field, "Enter").defaultPrevented).toBe(true);
    expect(await settled(result)).toEqual({ input: "", checkbox: false });
  });

  it("asks for it as soon as the checkbox calls for it (Force), and stops when unticked", async () => {
    const result = ask({
      title: "Delete web-0?",
      confirmLabel: "Delete",
      danger: true,
      checkbox: { label: "Force (grace period 0)", value: false },
      confirmText: (force) => (force ? "web-0" : undefined),
    });
    expect(document.querySelector(".dlg-confirm")).toBeNull();
    expect(button("Delete").disabled).toBe(false);
    expect(document.activeElement).toBe(button("Cancel"));

    // A real checkbox: Tab reaches it and Space ticks it (what `click()` stands for here).
    const force = document.querySelector<HTMLInputElement>(".dialog input[type=checkbox]")!;
    press(button("Cancel"), "Tab", { shiftKey: true });
    expect(document.activeElement).toBe(force);
    force.click();
    await Promise.resolve();
    expect(document.querySelector(".dlg-confirm")).not.toBeNull();
    expect(document.activeElement).toBe(document.querySelector(".dlg-confirm input"));
    expect(button("Delete").disabled).toBe(true);
    await armed();
    modEnter(document.activeElement!);
    expect(await settled(result)).toBe("pending");

    typeConfirmation("web-0");
    mouseClick(button("Delete"));
    expect(await settled(result)).toEqual({ input: "", checkbox: true });
  });

  it("shows how many objects each cluster gets, and lists a bounded number of them", () => {
    const items = Array.from({ length: DIALOG_MAX_ITEMS + 37 }, (_, i) => ({ label: `shop/web-${i}`, meta: "z1" }));
    void ask({
      title: "Delete 237 pods?",
      confirmLabel: "Delete",
      items,
      breakdown: [
        { label: "prod-eu-z1", count: 200 },
        { label: "prod-eu-z2", count: 37 },
      ],
    });
    expect(document.querySelector(".dlg-breakdown")?.textContent).toBe("In 2 clusters:prod-eu-z1200 objectsprod-eu-z237 objects");
    expect(document.querySelectorAll(".dlg-items > div")).toHaveLength(DIALOG_MAX_ITEMS + 1);
    expect(document.querySelector(".dlg-items")?.lastElementChild?.textContent).toBe("…and 37 more");
  });
});

describe("toasts", () => {
  let disposeToasts: () => void;
  beforeEach(() => {
    vi.useFakeTimers();
    const root = document.createElement("div");
    document.body.append(root);
    disposeToasts = render(() => <Toasts />, root);
  });
  afterEach(() => {
    for (const t of toasts()) dismissToast(t.id);
    disposeToasts();
    vi.useRealTimers();
  });
  // Toasts on screen, not the ones fading out.
  const shown = () => [...document.querySelectorAll(".toast:not(.leaving) .t-title")].map((e) => e.textContent);

  it("keeps failures until dismissed with their button; a click on the text does not close them", () => {
    toast("error", "Delete failed for 3 of 40", "z1 shop/web-0: forbidden", { sticky: true, copy: "all of it" });
    toast("success", "Deleted 37 objects");
    vi.advanceTimersByTime(60_000);
    expect(shown()).toEqual(["Delete failed for 3 of 40"]);
    document.querySelector<HTMLElement>(".toast .t-detail")!.click();
    expect(shown()).toEqual(["Delete failed for 3 of 40"]);
    document.querySelector<HTMLButtonElement>(".toast button[aria-label=Dismiss]")!.click();
    expect(shown()).toEqual([]);
  });

  it("does not let newer toasts push a failure off the screen", () => {
    toast("error", "Restart failed for web", undefined, { sticky: true });
    for (let i = 0; i < 8; i++) toast("info", `note ${i}`);
    expect(shown()).toHaveLength(5);
    expect(shown()[0]).toBe("Restart failed for web");
  });

  it("show what is running with a spinner until it ends, however long it takes", () => {
    const done = busyToast("Restarting 12 deployments…");
    for (let i = 0; i < 6; i++) toast("info", `note ${i}`);
    vi.advanceTimersByTime(105_000);
    expect(shown()).toEqual(["Restarting 12 deployments…"]);
    expect(document.querySelector(".toast.busy .spinner")).not.toBeNull();
    expect(document.querySelector(".toast.busy")?.getAttribute("role")).toBe("status");
    done();
    expect(shown()).toEqual([]);
  });

  it("pauses while hovered", () => {
    toast("info", "Copied to clipboard");
    const el = document.querySelector(".toast")!;
    vi.advanceTimersByTime(3000);
    el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    el.dispatchEvent(new MouseEvent("mouseenter"));
    vi.advanceTimersByTime(10_000);
    expect(shown()).toEqual(["Copied to clipboard"]);
    el.dispatchEvent(new MouseEvent("mouseleave"));
    vi.advanceTimersByTime(1600);
    expect(shown()).toEqual([]);
  });

  it("fade out where they were before they go, and Esc dismisses the newest when nothing else takes it", () => {
    // No dialog left open by the tests above (one would take Esc).
    setDialog(null);
    toast("info", "first");
    toast("info", "second");
    press(document.body, "Escape", { code: "Escape" });
    expect(shown()).toEqual(["first"]);
    // Still there, fading out, under the one left.
    expect([...document.querySelectorAll(".toast .t-title")].map((e) => e.textContent)).toEqual(["first", "second"]);
    vi.advanceTimersByTime(TOAST_LEAVE_MS);
    expect([...document.querySelectorAll(".toast .t-title")].map((e) => e.textContent)).toEqual(["first"]);
  });

  it("copies the full report", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    toast("error", "Delete failed for 2 of 2", "…", { sticky: true, copy: "prod-eu-z1\tshop\tweb-0\tforbidden" });
    [...document.querySelectorAll<HTMLButtonElement>(".toast button")].find((b) => b.textContent?.includes("Copy details"))!.click();
    await vi.runAllTimersAsync();
    expect(writeText).toHaveBeenCalledWith("prod-eu-z1\tshop\tweb-0\tforbidden");
    expect(document.querySelector(".toast")?.textContent).toContain("Copied");
  });
});
