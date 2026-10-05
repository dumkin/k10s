import { describe, expect, it } from "vitest";
import { closeTerminal, dockOpen, dockTab, openTerminal, setDockOpen, termStatus, termTabs, termTitle } from "./dock";

const shell = (pod: string) => ({ kind: "shell" as const, spec: { cluster: "prod-eu-z1", namespace: "shop", pod, container: "app" } });

describe("dock", () => {
  it("opens each terminal in a tab of its own, shown at once, and shows a neighbour when one closes", () => {
    setDockOpen(false);
    const a = openTerminal(shell("web-1"));
    const b = openTerminal(shell("web-2"));
    const c = openTerminal({ kind: "node", spec: { cluster: "prod-eu-z1", node: "node-a", namespace: "default", image: "busybox:1.37" } });
    expect(dockOpen()).toBe(true);
    expect(dockTab()).toBe(c);
    expect(termStatus[c]).toEqual({ state: "connecting" });
    expect(termTabs().map((t) => termTitle(t))).toEqual(["web-1/app", "web-2/app", "node node-a"]);

    // Closing the one shown shows the one that took its place (else the one before it).
    closeTerminal(c);
    expect(dockTab()).toBe(b);
    expect(termStatus[c]).toBeUndefined();
    closeTerminal(a);
    expect(dockTab()).toBe(b);
    closeTerminal(b);
    expect(termTabs()).toEqual([]);
    expect(dockTab()).toBe("forwards");
  });

  it("names a debug tab after its container once the engine said which", () => {
    const id = openTerminal({ kind: "debug", spec: { cluster: "prod-eu-z1", namespace: "shop", pod: "web-1", image: "busybox:1.37" } });
    const tab = termTabs().find((t) => t.id === id)!;
    expect(termTitle(tab)).toBe("debug web-1");
    expect(termTitle(tab, { state: "waiting", container: "debugger-x2k7q" })).toBe("debug web-1/debugger-x2k7q");
    closeTerminal(id);
  });
});
