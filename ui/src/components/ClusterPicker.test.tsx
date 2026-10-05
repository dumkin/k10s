import { render } from "solid-js/web";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClusterInfo } from "../lib/backend";

const engine = vi.hoisted(() => ({ connect: vi.fn() }));
vi.mock("../lib/backend", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/backend")>()),
  backend: () => ({ connect: engine.connect, reconnect: engine.connect }),
}));

import { installHotkeys } from "../lib/hotkeys";
import { saveClusterSet, selectedClusters, setClusterStatus, setContexts, setRecentClusters, setSavedSets, setSelectedClustersRaw } from "../state/clusters";
import { ClusterPicker } from "./ClusterPicker";

const info = (context: string): ClusterInfo => ({ context, server: "https://127.0.0.1:6443", aggregatedDiscovery: true, resources: [] });
const ctx = (name: string) => ({ name, cluster: name, auth: "exec: kubelogin" });

beforeAll(() => {
  installHotkeys();
  // jsdom has no layout.
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  Element.prototype.scrollIntoView ??= () => {};
});

let dispose: (() => void) | undefined;
beforeEach(() => {
  engine.connect.mockReset().mockImplementation(async (name: string) => info(name));
  setContexts(["acme-dev", "prod-eu-z1", "prod-eu-z2", "prod-eu-z3", "stage-us"].map(ctx));
  setSelectedClustersRaw(["stage-us"]);
  setClusterStatus("stage-us", { state: "connected", info: info("stage-us") });
  setRecentClusters(["stage-us"]);
  setSavedSets([]);
});
afterEach(() => close());

function open() {
  const root = document.createElement("div");
  document.body.append(root);
  dispose = render(() => <ClusterPicker anchor={undefined} onClose={() => {}} />, root);
}
function close() {
  dispose?.();
  dispose = undefined;
  document.body.innerHTML = "";
}

/** The list as text: group headers in brackets, then rows. */
const shown = () =>
  [...document.querySelectorAll(".pop-list .pop-group, .pop-list .opt")].map((el) => (el.classList.contains("pop-group") ? `[${el.textContent}]` : (el.querySelector(".ellipsis")?.textContent ?? "")));
const row = (name: string) => [...document.querySelectorAll<HTMLButtonElement>(".pop-list .opt")].find((el) => el.querySelector(".ellipsis")?.textContent === name)!;
const highlighted = () => document.querySelector(".pop-list .opt.hl .ellipsis")?.textContent;
const key = (k: string, init: KeyboardEventInit = {}) => document.querySelector(".pop-search input")!.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init }));
const click = (el: Element) => el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }));

describe("ClusterPicker", () => {
  const before = ["[Zone groups]", "prod-eu", "[Recent]", "stage-us", "[All contexts]", "acme-dev", "prod-eu-z1", "prod-eu-z2", "prod-eu-z3"];

  it("keeps the rows in place while clusters are picked: a second click lands on the same cluster", () => {
    open();
    expect(shown()).toEqual(before);
    const rows = () => [...document.querySelectorAll(".pop-list .opt")];
    const at = rows().indexOf(row("acme-dev"));
    // Picked, it is the most recent cluster now: it stays where the pointer is all the same.
    click(rows()[at]);
    expect(selectedClusters()).toEqual(["stage-us", "acme-dev"]);
    expect(shown()).toEqual(before);
    click(rows()[at]);
    expect(selectedClusters()).toEqual(["stage-us"]);
    // A zone group: all of its zones at once, and nothing moves either.
    click(row("prod-eu"));
    expect(selectedClusters()).toEqual(["stage-us", "prod-eu-z1", "prod-eu-z2", "prod-eu-z3"]);
    expect(shown()).toEqual(before);
    expect(engine.connect.mock.calls.map(([c]) => c)).toEqual(["acme-dev", "prod-eu-z1", "prod-eu-z2", "prod-eu-z3"]);
  });

  it("keeps the keyboard highlight on the cluster it toggles", () => {
    open();
    key("ArrowDown");
    key("ArrowDown");
    key("n", { code: "KeyN", ctrlKey: true });
    expect(highlighted()).toBe("prod-eu-z1");
    key("Enter");
    expect([highlighted(), selectedClusters()]).toEqual(["prod-eu-z1", ["stage-us", "prod-eu-z1"]]);
    key("Enter");
    expect([highlighted(), selectedClusters()]).toEqual(["prod-eu-z1", ["stage-us"]]);
    key("ArrowUp");
    key("ArrowUp");
    key("ArrowUp");
    expect(highlighted()).toBe("prod-eu");
    key("Enter");
    expect([highlighted(), shown()]).toEqual(["prod-eu", before]);
  });

  it("keeps the highlight on its row when rows come before it (a set saved meanwhile)", () => {
    open();
    for (let i = 0; i < 4; i++) key("ArrowDown");
    expect(highlighted()).toBe("prod-eu-z2");
    saveClusterSet("all of prod-eu", ["prod-eu-z1", "prod-eu-z2", "prod-eu-z3"]);
    expect(shown()).toEqual(["[Saved sets]", "all of prod-eu", ...before]);
    expect(highlighted()).toBe("prod-eu-z2");
    key("Enter");
    expect(selectedClusters()).toEqual(["stage-us", "prod-eu-z2"]);
  });

  it("takes the Recent group afresh when it opens again", () => {
    open();
    click(row("acme-dev"));
    close();
    open();
    expect(shown()).toEqual(["[Zone groups]", "prod-eu", "[Recent]", "stage-us", "acme-dev", "[All contexts]", "prod-eu-z1", "prod-eu-z2", "prod-eu-z3"]);
  });

  it("filters as before, from the top", () => {
    open();
    key("ArrowDown");
    const input = document.querySelector<HTMLInputElement>(".pop-search input")!;
    input.value = "z2";
    input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    expect(shown()).toEqual(["[Contexts]", "prod-eu-z2"]);
    expect(highlighted()).toBe("prod-eu-z2");
    key("Enter");
    expect(shown()).toEqual(["[Contexts]", "prod-eu-z2"]);
    expect(selectedClusters()).toEqual(["stage-us", "prod-eu-z2"]);
  });
});
