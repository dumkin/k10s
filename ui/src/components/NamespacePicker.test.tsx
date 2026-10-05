import { render } from "solid-js/web";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { NamespaceListingError, NamespaceOption } from "../state/views";

// The engine: only connects and reconnects (the picker's Retry) are looked at.
const engine = vi.hoisted(() => ({ connect: vi.fn(), reconnect: vi.fn() }));
vi.mock("../lib/backend", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/backend")>()),
  backend: () => ({ connect: engine.connect, reconnect: engine.reconnect }),
}));

// The namespace listing of the selected clusters, as the tests set it.
const listing = vi.hoisted(() => ({ setOptions: (_o: NamespaceOption[]) => {}, setErrors: (_e: NamespaceListingError[]) => {}, setLoading: (_l: boolean) => {} }));
vi.mock("../state/views", async () => {
  const { createSignal } = await import("solid-js");
  const [options, setOptions] = createSignal<NamespaceOption[]>([]);
  const [errors, setErrors] = createSignal<NamespaceListingError[]>([]);
  const [loading, setLoading] = createSignal(false);
  Object.assign(listing, { setOptions, setErrors, setLoading });
  return {
    namespaceOptions: options,
    namespaceErrors: errors,
    nsNames: { version: () => 0, clusters: () => new Map(), statuses: {}, loading },
  };
});

import { setClusterStatus, setContexts, setSelectedClustersRaw } from "../state/clusters";
import { clearNamespaceMemory, namespaces, rememberNamespaces, setNamespaces } from "../state/nav";
import { NamespacePicker } from "./NamespacePicker";

const forbidden = (cluster: string): NamespaceListingError => ({ cluster, forbidden: true, title: "No access", message: `namespaces is forbidden: User "jane" cannot list resource "namespaces" at the cluster scope` });

beforeAll(() => {
  // jsdom has no layout.
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

let dispose: (() => void) | undefined;
beforeEach(() => {
  clearNamespaceMemory();
  setContexts([{ name: "prod-eu-z1", cluster: "prod-eu-z1", auth: "exec: kubelogin", namespace: "payments" }]);
  setSelectedClustersRaw(["prod-eu-z1"]);
  // Opened on another day (on this cluster).
  rememberNamespaces(["orders"]);
  rememberNamespaces(["ledger"]);
  setNamespaces([]);
  listing.setOptions([]);
  listing.setErrors([]);
  listing.setLoading(false);
  engine.connect.mockReset();
  engine.reconnect.mockReset();
});
afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.innerHTML = "";
  setSelectedClustersRaw([]);
});

function open() {
  const root = document.createElement("div");
  document.body.append(root);
  dispose = render(() => <NamespacePicker anchor={undefined} onClose={() => {}} />, root);
}

/** The list as text: group headers in brackets, then rows. */
const shown = () =>
  [...document.querySelectorAll(".pop-list .pop-group, .pop-list .opt")].map((el) =>
    el.classList.contains("pop-group") ? `[${el.textContent}]` : (el.querySelector(".ellipsis")?.textContent ?? ""),
  );
const hint = () => document.querySelector(".ns-hint")?.textContent ?? "";

describe("NamespacePicker under strict RBAC", () => {
  it("offers the kubeconfig's namespace first, then the remembered ones as not listed", () => {
    listing.setErrors([forbidden("prod-eu-z1")]);
    open();
    expect(shown()).toEqual(["All namespaces", "[From kubeconfig]", "payments", "[Not listed]", "ledger", "orders"]);
    expect(hint()).toContain("You can't list namespaces here");
    expect(document.querySelector("input")!.placeholder).toBe("Type a namespace name…");
    expect(document.body.textContent).not.toContain("Retry");
  });

  it("forgets a remembered namespace with ×, not the kubeconfig's", () => {
    listing.setErrors([forbidden("prod-eu-z1")]);
    open();
    const rows = [...document.querySelectorAll(".pop-list .opt")];
    const forget = (name: string) => rows.find((r) => r.querySelector(".ellipsis")?.textContent === name)?.querySelector<HTMLElement>("[title='Forget this namespace']");
    expect(forget("payments")).toBeNull();
    forget("ledger")!.click();
    expect(shown()).toEqual(["All namespaces", "[From kubeconfig]", "payments", "[Not listed]", "orders"]);
    // Opening it again remembers it again.
    rememberNamespaces(["ledger"]);
    expect(shown()).toContain("ledger");
  });

  it("keeps the rows in place while toggling them", () => {
    rememberNamespaces(["billing"]);
    listing.setErrors([forbidden("prod-eu-z1")]);
    open();
    const before = ["All namespaces", "[From kubeconfig]", "payments", "[Not listed]", "billing", "ledger", "orders"];
    expect(shown()).toEqual(before);
    const input = document.querySelector("input")!;
    const key = (k: string) => input.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));
    // To "orders" and ↵, twice: the same row is opened and closed again, wherever the memory puts it meanwhile.
    for (let i = 0; i < 4; i++) key("ArrowDown");
    key("Enter");
    rememberNamespaces(["orders"]);
    expect(namespaces()).toEqual(["orders"]);
    expect(shown()).toEqual(before);
    key("Enter");
    expect(namespaces()).toEqual([]);
  });

  it("finds remembered namespaces when typing, and offers a new name first", async () => {
    listing.setErrors([forbidden("prod-eu-z1")]);
    open();
    const input = document.querySelector("input")!;
    input.value = "led";
    input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    expect(shown()).toEqual(["[Not listed]", "Open namespace “led”", "[Namespaces]", "ledger"]);
    expect(document.querySelector(".pop-list .opt:last-child .sub")?.textContent).toBe("not listed");
  });
});

describe("NamespacePicker when listing fails for another reason", () => {
  it("shows the error with a retry instead of the RBAC hint", async () => {
    listing.setErrors([{ cluster: "prod-eu-z1", forbidden: false, title: "Error", message: 'cluster "prod-eu-z1": no answer within 60s' }]);
    open();
    expect(hint()).toContain("Couldn't load namespaces from prod-eu-z1");
    expect(hint()).toContain("no answer within 60s");
    expect(document.body.textContent).not.toContain("You can't list namespaces");
    // Connected (the listing failed, not the connection): Retry must reconnect, not just make sure it is connected.
    const info = { context: "prod-eu-z1", server: "", aggregatedDiscovery: true, resources: [] };
    setClusterStatus("prod-eu-z1", { state: "connected", info });
    engine.reconnect.mockResolvedValue(info);
    [...document.querySelectorAll<HTMLButtonElement>(".ns-hint button")].find((b) => b.textContent?.includes("Retry"))!.click();
    expect(engine.reconnect).toHaveBeenCalledWith("prod-eu-z1");
    expect(engine.connect).not.toHaveBeenCalled();
  });

  it("marks remembered namespaces a working listing doesn't have", () => {
    listing.setOptions([
      { name: "kube-system", clusters: 1 },
      { name: "ledger", clusters: 1 },
      { name: "payments", clusters: 1 },
    ]);
    open();
    expect(shown()).toEqual(["All namespaces", "[From kubeconfig]", "payments", "[Recent]", "ledger", "[Not listed]", "orders", "[Namespaces]", "kube-system"]);
    expect(hint()).toBe("");
  });

  it("doesn't call anything 'not listed' while the listing is still loading", () => {
    listing.setLoading(true);
    open();
    expect(shown()).toEqual(["All namespaces", "[From kubeconfig]", "payments", "[Recent]", "ledger", "orders"]);
  });
});
