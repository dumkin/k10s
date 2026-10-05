import { render } from "solid-js/web";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClusterInfo, ContextList } from "../lib/backend";

const engine = vi.hoisted(() => ({ listContexts: vi.fn(), connect: vi.fn() }));
vi.mock("../lib/backend", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/backend")>()),
  backend: () => ({ listContexts: engine.listContexts, connect: engine.connect, reconnect: engine.connect }),
}));

const info = (context: string): ClusterInfo => ({ context, server: "https://127.0.0.1:6443", aggregatedDiscovery: true, resources: [] });
const ctx = (name: string) => ({ name, cluster: name, auth: "exec: kubelogin" });
const kubeconfig = (list: Partial<ContextList>): ContextList => ({ contexts: [], current: null, paths: ["/home/me/.kube/config"], found: ["/home/me/.kube/config"], ...list });

let dispose: (() => void) | undefined;
beforeEach(() => {
  localStorage.clear();
  vi.resetModules();
  engine.listContexts.mockReset();
  engine.connect.mockReset().mockImplementation(async (name: string) => info(name));
});
afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.innerHTML = "";
});

/** A fresh app state with the welcome screen mounted. */
async function mount() {
  const clusters = await import("../state/clusters");
  const ui = await import("../state/ui");
  const { Welcome } = await import("./Welcome");
  const root = document.createElement("div");
  document.body.append(root);
  dispose = render(() => <Welcome />, root);
  return { root, clusters, ui };
}
const button = (root: HTMLElement, text: string) => [...root.querySelectorAll("button")].find((b) => b.textContent?.includes(text));

describe("Welcome", () => {
  it("waits for the kubeconfig (the login shell may take seconds)", async () => {
    const { root } = await mount();
    expect(root.textContent).toContain("Reading kubeconfig…");
  });

  it("lists the files searched when there is no kubeconfig, and reloads", async () => {
    const { root, clusters } = await mount();
    engine.listContexts.mockResolvedValue(kubeconfig({ paths: ["/work/a.yaml", "/work/b.yaml"], found: [], fromEnv: true }));
    await clusters.loadContexts();
    expect(root.querySelector("h3")?.textContent).toBe("No kubeconfig found");
    expect(root.textContent).toContain("Searched (from KUBECONFIG):");
    expect(root.textContent).toContain("/work/a.yaml");
    expect(root.textContent).toContain("/work/b.yaml");

    engine.listContexts.mockResolvedValue(kubeconfig({ contexts: [ctx("acme-dev")] }));
    button(root, "Reload kubeconfig")!.click();
    await vi.waitFor(() => expect(root.querySelector("h3")?.textContent).toBe("Pick the clusters to look at"));
    expect(engine.connect).not.toHaveBeenCalled();
  });

  it("tells a kubeconfig without contexts and an unreadable one apart", async () => {
    const { root, clusters } = await mount();
    engine.listContexts.mockResolvedValue(kubeconfig({}));
    await clusters.loadContexts();
    expect(root.querySelector("h3")?.textContent).toBe("No contexts in the kubeconfig");
    expect(root.textContent).toContain("/home/me/.kube/config");

    engine.listContexts.mockRejectedValue({ kind: "kubeconfig", message: "kubeconfig: /home/me/.kube/config: did not find expected key", code: null });
    await clusters.loadContexts();
    expect(root.querySelector("h3")?.textContent).toBe("Can't read the kubeconfig");
    expect(root.querySelector(".error-text")?.textContent).toBe("kubeconfig: /home/me/.kube/config: did not find expected key");
  });

  it("asks for clusters on a first run without a current-context, offering zone groups", async () => {
    const { root, clusters, ui } = await mount();
    const unrelated = ["arn:aws:eks:eu-west-1:111111111111:cluster/payments", "arn:aws:eks:eu-west-1:222222222222:cluster/billing", "kubernetes-admin@cluster-1", "kubernetes-admin@cluster-2"];
    engine.listContexts.mockResolvedValue(kubeconfig({ contexts: [ctx("acme-dev"), ctx("prod-eu-z1"), ctx("prod-eu-z2"), ctx("prod-eu-z3"), ...unrelated.map(ctx)] }));
    await clusters.loadContexts();
    expect(clusters.selectedClusters()).toEqual([]);
    expect(engine.connect).not.toHaveBeenCalled();
    expect(root.textContent).toContain("Nothing is connected until you pick");

    button(root, "Select clusters")!.click();
    expect(ui.pickerOpen()).toBe("clusters");

    // Names that only share a trailing number are no zone group: one click would connect them all.
    const chips = [...root.querySelectorAll(".chip")].map((b) => b.textContent);
    expect(chips).toEqual(["prod-eu · z1 z2 z3"]);

    button(root, "prod-eu · z1 z2 z3")!.click();
    expect(clusters.selectedClusters()).toEqual(["prod-eu-z1", "prod-eu-z2", "prod-eu-z3"]);
    expect(clusters.needsWelcome()).toBe(false);
  });
});
