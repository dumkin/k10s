import { createRoot } from "solid-js";
import { render } from "solid-js/web";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UIRow } from "../state/view";

// The main table's feed, for the row count next to the resource shown.
vi.mock("../state/view", async () => {
  const { createSignal } = await import("solid-js");
  const [rows] = createSignal<UIRow[]>([]);
  return {
    createViewFeed: () => ({ version: () => 0, rowByKey: () => undefined, rows, columns: () => [], statuses: {}, resolved: {}, loading: () => false }),
    createNamesFeed: () => ({ version: () => 0, clusters: () => new Map(), statuses: {}, loading: () => false }),
  };
});

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.innerHTML = "";
  localStorage.clear();
  vi.restoreAllMocks();
});

async function mount() {
  vi.resetModules();
  vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
  const hotkeys = await import("../lib/hotkeys");
  const nav = await import("../state/nav");
  const views = await import("../state/views");
  const { Sidebar } = await import("./Sidebar");
  hotkeys.installHotkeys();
  const disposeViews = createRoot((d) => {
    views.initViews();
    return d;
  });
  const root = document.createElement("div");
  document.body.append(root);
  const disposeView = render(() => <Sidebar />, root);
  dispose = () => {
    disposeView();
    disposeViews();
  };
  return { nav };
}

const cmd = (n: number, target: EventTarget = document.body) => {
  const e = new KeyboardEvent("keydown", { key: String(n), code: `Digit${n}`, metaKey: true, bubbles: true, cancelable: true });
  target.dispatchEvent(e);
  return e;
};
const hints = () => [...document.querySelectorAll<HTMLElement>(".sb-item[data-hint]")].map((b) => `${b.dataset.hint} ${b.querySelector(".ellipsis")?.textContent}`);

describe("sidebar quick keys", () => {
  it("puts the first nine items shown on ⌘1…⌘9, top to bottom", async () => {
    const { nav } = await mount();
    expect(hints()).toEqual([
      "mod+1 Needs attention",
      "mod+2 Nodes",
      "mod+3 Namespaces",
      "mod+4 Events",
      "mod+5 Pods",
      "mod+6 Deployments",
      "mod+7 StatefulSets",
      "mod+8 DaemonSets",
      "mod+9 ReplicaSets",
    ]);
    expect(cmd(6).defaultPrevented).toBe(true);
    expect(nav.resourceKey()).toBe("deployments.apps");

    // A section folded: its items are not shown, and the numbers go to the next ones.
    [...document.querySelectorAll<HTMLButtonElement>(".sb-head")].find((h) => h.textContent?.includes("Cluster"))!.click();
    expect(hints().slice(0, 2)).toEqual(["mod+1 Needs attention", "mod+2 Pods"]);
    cmd(2);
    expect(nav.resourceKey()).toBe("pods");
    cmd(1);
    expect(nav.resourceKey()).toBe("attention");
  });

  it("numbers what the filter leaves, and ↵ in the filter opens the first", async () => {
    const { nav } = await mount();
    const input = document.querySelector<HTMLInputElement>(".sb-filter input")!;
    input.focus();
    input.value = "set";
    input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    expect(hints()).toEqual(["mod+1 StatefulSets", "mod+2 DaemonSets", "mod+3 ReplicaSets"]);
    // Works from the field too.
    cmd(2, input);
    expect(nav.resourceKey()).toBe("daemonsets.apps");
    expect(cmd(4, input).defaultPrevented).toBe(false);
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    expect([nav.resourceKey(), input.value, document.activeElement === input]).toEqual(["statefulsets.apps", "", false]);
  });

  it("clears the filter with Esc, then leaves it", async () => {
    await mount();
    const input = document.querySelector<HTMLInputElement>(".sb-filter input")!;
    input.focus();
    input.value = "pod";
    input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    const esc = () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    esc();
    expect([input.value, document.activeElement === input]).toEqual(["", true]);
    esc();
    expect(document.activeElement === input).toBe(false);
  });
});
