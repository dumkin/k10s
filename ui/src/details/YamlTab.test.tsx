import { render } from "solid-js/web";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const engine = vi.hoisted(() => ({
  getYaml: vi.fn(async (_target: unknown, _managed: boolean, reveal?: boolean): Promise<string> => (reveal ? "data:\n  password: aHVudGVyMg==\n" : "data:\n  password: '<hidden: 7 bytes>'\n")),
}));
vi.mock("../lib/backend", async (original) => ({ ...(await original<typeof import("../lib/backend")>()), backend: () => engine }));

import { Tone } from "../lib/backend";
import type { DetailProps } from "../registry/details";
import { YamlTab } from "./YamlTab";

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

const tick = () => new Promise((r) => setTimeout(r, 0));
const props = (resourceKey: string, name: string): DetailProps => ({
  row: { key: `prod-eu-z1/${name}`, cl: "prod-eu-z1", u: `uid-${name}`, n: name, ns: "shop", rv: "1", t: 0, s: Tone.Ok, c: [] },
  resourceKey,
  target: { cluster: "prod-eu-z1", resource: resourceKey, namespace: "shop", name, uid: `uid-${name}` },
});
const revealButton = () => [...document.querySelectorAll<HTMLButtonElement>(".toolbar button")].find((b) => /values/.test(b.textContent ?? ""));

function mount(p: DetailProps) {
  const root = document.createElement("div");
  document.body.append(root);
  return render(() => <YamlTab {...p} />, root);
}

describe("YamlTab", () => {
  it("shows a Secret with its values hidden until revealed, and hides them again for the next one", async () => {
    let dispose = mount(props("secrets", "db"));
    await tick();
    expect(engine.getYaml).toHaveBeenLastCalledWith(expect.objectContaining({ name: "db" }), false, false);
    expect(document.body.textContent).toContain("<hidden: 7 bytes>");
    expect(revealButton()?.textContent).toBe("Reveal values");

    revealButton()!.click();
    await tick();
    expect(engine.getYaml).toHaveBeenLastCalledWith(expect.objectContaining({ name: "db" }), false, true);
    expect(document.body.textContent).toContain("aHVudGVyMg==");
    expect(revealButton()?.textContent).toBe("Hide values");

    // Another Secret (the panel re-mounts per object): hidden again.
    dispose();
    dispose = mount(props("secrets", "api-token"));
    await tick();
    expect(engine.getYaml).toHaveBeenLastCalledWith(expect.objectContaining({ name: "api-token" }), false, false);
    expect(revealButton()?.textContent).toBe("Reveal values");
    dispose();
  });

  it("takes revealed values off screen at once on Hide, even while (or if) the hidden text does not arrive", async () => {
    const dispose = mount(props("secrets", "db"));
    await tick();
    revealButton()!.click();
    await tick();
    expect(document.body.textContent).toContain("aHVudGVyMg==");

    // Hiding again: the fetch hangs, then fails (the cluster went away).
    let fail: (e: unknown) => void = () => {};
    engine.getYaml.mockImplementationOnce(() => new Promise((_, reject) => (fail = reject)));
    revealButton()!.click();
    await tick();
    expect(revealButton()?.textContent).toBe("Reveal values");
    expect(document.body.textContent).not.toContain("aHVudGVyMg==");
    fail({ kind: "other", message: "no answer from the API server within 30s" });
    await tick();
    expect(document.body.textContent).not.toContain("aHVudGVyMg==");
    expect(document.querySelector(".error-text")?.textContent).toBe("no answer from the API server within 30s");
    dispose();
  });

  it("has nothing to reveal for other kinds", async () => {
    const dispose = mount(props("configmaps", "settings"));
    await tick();
    expect(revealButton()).toBeUndefined();
    expect(engine.getYaml).toHaveBeenLastCalledWith(expect.anything(), false, false);
    dispose();
  });
});
