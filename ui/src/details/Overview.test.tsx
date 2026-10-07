import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { afterEach, describe, expect, it, vi } from "vitest";

// The engine: each read is a new copy of what it holds, as the desktop app's (JSON over IPC).
const engine = vi.hoisted(() => {
  const objects = new Map<string, unknown>();
  return {
    objects,
    getObject: vi.fn(async (t: { resource: string; name: string }) => JSON.parse(JSON.stringify(objects.get(`${t.resource}/${t.name}`) ?? null))),
  };
});
vi.mock("../lib/backend", async (original) => ({ ...(await original<typeof import("../lib/backend")>()), backend: () => engine }));
// Usage polls the metrics API: not what these tests are about.
vi.mock("./Usage", () => ({ UsageSection: () => null }));

import { Tone } from "../lib/backend";
import { setNow } from "../state/ui";
import type { UIRow } from "../state/view";
import { Overview } from "./Overview";

afterEach(() => {
  document.body.innerHTML = "";
  engine.objects.clear();
  vi.clearAllMocks();
});

/** When the container last ended (unix seconds). */
const ENDED = Date.parse("2026-10-07T10:00:00Z") / 1000;

/**
 * A pod whose container was OOM-killed `restarts` times: a password from a Secret and twelve variables of its own,
 * the rest from a ConfigMap; more labels than show at first, and an annotation.
 */
const pod = (restarts: number, rv = String(restarts)) => ({
  apiVersion: "v1",
  kind: "Pod",
  metadata: {
    name: "web-0",
    namespace: "shop",
    uid: "uid-web-0",
    resourceVersion: rv,
    labels: Object.fromEntries(Array.from({ length: 52 }, (_, i) => [`label-${i}`, "x"])),
    annotations: { "example.com/note": "a note" },
  },
  spec: {
    containers: [
      {
        name: "web",
        image: "registry.example.com/web:1.4",
        env: [{ name: "DB_PASSWORD", valueFrom: { secretKeyRef: { name: "web-db", key: "password" } } }, ...Array.from({ length: 12 }, (_, i) => ({ name: `VAR_${i}`, value: `value-${i}` }))],
        envFrom: [{ configMapRef: { name: "web-config" } }],
      },
    ],
  },
  status: {
    phase: "Running",
    containerStatuses: [
      {
        name: "web",
        ready: true,
        restartCount: restarts,
        state: { running: { startedAt: new Date(ENDED * 1000).toISOString() } },
        lastState: { terminated: { exitCode: 137, reason: "OOMKilled", finishedAt: new Date(ENDED * 1000).toISOString() } },
      },
    ],
  },
});

const configMap = { apiVersion: "v1", kind: "ConfigMap", metadata: { name: "web-config", namespace: "shop" }, data: Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`KEY_${i}`, `from-config-${i}`])) };
const secret = { apiVersion: "v1", kind: "Secret", metadata: { name: "web-db", namespace: "shop" }, data: { password: btoa("hunter2") } };

const settle = () => new Promise((r) => setTimeout(r, 0));

function mount() {
  engine.objects.set("pods/web-0", pod(1));
  engine.objects.set("configmaps/web-config", configMap);
  engine.objects.set("secrets/web-db", secret);
  const [row, setRow] = createSignal<UIRow>({ key: "prod-eu-z1/uid-web-0", cl: "prod-eu-z1", u: "uid-web-0", n: "web-0", ns: "shop", rv: "1", t: ENDED - 86400, s: Tone.Ok, c: [] });
  const root = document.createElement("div");
  document.body.append(root);
  const dispose = render(() => <Overview row={row()} resourceKey="pods" target={{ cluster: "prod-eu-z1", resource: "pods", namespace: "shop", name: "web-0", uid: "uid-web-0" }} />, root);
  /** The pod as the engine holds it now, read again as its row brings a new version. */
  const update = async (next: ReturnType<typeof pod>) => {
    engine.objects.set("pods/web-0", next);
    setRow({ ...row(), rv: next.metadata.resourceVersion });
    await settle();
  };
  return { root, update, dispose };
}

const env = (root: HTMLElement) => root.querySelector<HTMLElement>(".env");
/** Variables of the container's own shown, and keys of the ConfigMap. */
const shown = (root: HTMLElement) => [root.querySelectorAll(".env > .env-row").length, root.querySelectorAll(".env-from .env-row").length];
const password = (root: HTMLElement) => root.querySelector(".env-secret")?.textContent;
const value = (root: HTMLElement, name: string) => [...root.querySelectorAll(".kv dt")].find((dt) => dt.textContent === name)?.nextElementSibling as HTMLElement | undefined;
const podReads = () => engine.getObject.mock.calls.filter(([t]) => t.resource === "pods").length;

/** Opens what the environment folds: "Show 5 more", and the password. */
async function openEnv(root: HTMLElement) {
  [...root.querySelectorAll<HTMLButtonElement>(".env-tools button")].find((b) => /more/.test(b.textContent ?? ""))!.click();
  root.querySelector<HTMLButtonElement>(".env-secret .env-eye")!.click();
  await settle();
  expect(shown(root)).toEqual([13, 30]);
  expect(password(root)).toBe("hunter2");
}

describe("Overview of a pod", () => {
  it("keeps a container's environment while the clock ticks: the age of its last termination goes on", async () => {
    setNow(ENDED + 45);
    const { root, dispose } = mount();
    await settle();
    expect(value(root, "Last termination")?.textContent).toBe("OOMKilled (exit 137) · 45s ago");
    await openEnv(root);

    // Each second: the age follows, the environment is the same one, where it was, as it was opened.
    const before = env(root)!;
    const dd = before.parentElement;
    for (let s = 46; s < 50; s++) {
      setNow(ENDED + s);
      await settle();
      expect(value(root, "Last termination")?.textContent).toBe(`OOMKilled (exit 137) · ${s}s ago`);
      expect(env(root)).toBe(before);
      expect(before.parentElement).toBe(dd);
      expect(shown(root)).toEqual([13, 30]);
      expect(password(root)).toBe("hunter2");
    }
    dispose();
  });

  it("keeps a container's card as it was when the pod is read again", async () => {
    setNow(ENDED + 45);
    const { root, update, dispose } = mount();
    await settle();
    await openEnv(root);
    const before = env(root)!;
    const dd = before.parentElement;
    const termination = value(root, "Last termination")!.firstElementChild;

    // A new version with the container as it was: nothing of its card is made again.
    await update(pod(1, "2"));
    expect(podReads()).toBe(2);
    expect(value(root, "Last termination")!.firstElementChild).toBe(termination);
    expect(env(root)).toBe(before);
    expect(before.parentElement).toBe(dd);

    // It restarted: its status follows, its environment stays where it was, as it was opened.
    await update(pod(2, "3"));
    expect(root.querySelector(".card-head .badge.warn")?.textContent).toBe("2 restarts");
    expect(env(root)).toBe(before);
    expect(before.parentElement).toBe(dd);
    expect(shown(root)).toEqual([13, 30]);
    expect(password(root)).toBe("hunter2");
    dispose();
  });

  it("leaves the age out of the last termination when its end cannot be read", async () => {
    const { root, update, dispose } = mount();
    await settle();
    const odd = pod(2);
    odd.status.containerStatuses[0].lastState.terminated.finishedAt = "not a time";
    await update(odd);
    expect(value(root, "Last termination")?.textContent).toBe("OOMKilled (exit 137)");
    dispose();
  });

  it("keeps the labels and annotations as they were opened when the pod is read again", async () => {
    const { root, update, dispose } = mount();
    await settle();
    const labels = () => value(root, "Labels")!.querySelectorAll(".label-chip").length;
    expect(labels()).toBe(50);
    [...value(root, "Labels")!.querySelectorAll("button")].find((b) => b.textContent === "+2 more")!.click();
    value(root, "Annotations")!.querySelector("button")!.click();
    const note = value(root, "Annotations")!.querySelector(".selectable");
    expect(labels()).toBe(52);
    expect(note?.textContent).toBe("a note");

    await update(pod(2));
    expect(labels()).toBe(52);
    expect(value(root, "Annotations")!.querySelector(".selectable")).toBe(note);
    dispose();
  });
});
