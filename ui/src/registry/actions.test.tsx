import { render } from "solid-js/web";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const engine = vi.hoisted(() => ({
  scale: vi.fn(async (_target: unknown, _replicas: number): Promise<void> => {}),
  setSuspend: vi.fn(async () => {}),
  setUnschedulable: vi.fn(async (_target: unknown, _unschedulable: boolean): Promise<void> => {}),
  restart: vi.fn(async (_target: unknown): Promise<void> => {}),
  triggerCronJob: vi.fn(async (target: { name: string }): Promise<string> => `${target.name}-manual-x7k2p`),
  deleteObjects: vi.fn(async (targets: { name: string }[], _force: boolean): Promise<unknown[]> => targets.map((target) => ({ target, ok: true }))),
  setReadOnly: vi.fn(async (readOnly: boolean) => ({ readOnly, feedIdleTtlSecs: 180 })),
}));
vi.mock("../lib/backend", async (importOriginal) => ({ ...(await importOriginal<typeof import("../lib/backend")>()), backend: () => engine }));
// What the user may do, as the cluster answers: everything, unless a test says otherwise (`denied`).
const access = vi.hoisted(() => ({ denied: (_cluster: string, _check: { verb: string; resource: string; subresource?: string; namespace?: string | null; name?: string }): boolean => false }));
vi.mock("../state/access", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../state/access")>();
  const decide = (cluster: string, check: Parameters<typeof access.denied>[1]) => ({ allowed: !access.denied(cluster, check) });
  return { ...orig, accessOf: decide, accessKnown: decide, accessNow: async (cluster: string, checks: Parameters<typeof access.denied>[1][]) => checks.map((c) => decide(cluster, c)) };
});

import { DIALOG_ARM_MS, Dialog } from "../components/Overlays";
import { Tone } from "../lib/backend";
import { installHotkeys, isMac } from "../lib/hotkeys";
import { clearMarks, marked, setMarked } from "../state/nav";
import { dialog, dismissToast, noteReadOnlyRefusal, readOnly, setReadOnly, toasts } from "../state/ui";
import type { UIRow } from "../state/view";
import { type ActionContext, actionsFor, deleteConfirmText, NO_PERMISSION_HINT, READ_ONLY_HINT, TYPED_CONFIRM_OVER, typedConfirmText } from "./actions";

let dispose: () => void;

beforeAll(() => installHotkeys());

beforeEach(() => {
  vi.clearAllMocks();
  access.denied = () => false;
  const root = document.createElement("div");
  document.body.append(root);
  dispose = render(() => <Dialog />, root);
});

afterEach(async () => {
  dialog()?.resolve(null);
  clearMarks();
  for (const t of toasts()) dismissToast(t.id);
  if (readOnly()) await setReadOnly(false);
  for (const t of toasts()) dismissToast(t.id);
  dispose();
  document.body.innerHTML = "";
});

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const armed = () => tick(DIALOG_ARM_MS + 20);
const deployment = (cl: string, n: string, desired: number): UIRow => ({ key: `${cl}/${n}`, cl, u: n, n, ns: "payments", rv: "1", t: 0, s: Tone.Ok, c: [[desired, desired]] });
const ctxOf = (rows: UIRow[]): ActionContext => ({ resourceKey: "deployments.apps", rows });
const run = (id: string, ctx: ActionContext) => actionsFor(ctx).find((a) => a.id === id)!.run(ctx) as Promise<void>;
const title = () => document.querySelector(".dialog h2")?.textContent;
const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>(".dialog button")].find((b) => b.textContent?.trim() === label)!;
const mouseClick = (el: Element) => el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }));
const input = () => document.querySelector<HTMLInputElement>(".dialog input")!;
const type = (value: string) => {
  input().value = value;
  input().dispatchEvent(new InputEvent("input", { bubbles: true }));
};
const key = (k: string, init: KeyboardEventInit = {}) =>
  document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init }));
const modEnter = (init: KeyboardEventInit = {}) => key("Enter", { ...(isMac ? { metaKey: true } : { ctrlKey: true }), ...init });

describe("scale", () => {
  const pair = [deployment("prod-eu-z1", "payments-api", 3), deployment("prod-eu-z2", "payments-api", 3)];

  it("never scales on empty or invalid input", async () => {
    const done = run("scale", ctxOf([deployment("prod-eu-z1", "a", 2), deployment("prod-eu-z2", "b", 5)]));
    expect(input().value).toBe(""); // replica counts differ: nothing is prefilled
    await armed();
    for (const value of ["", "3,", "-1"]) {
      type(value);
      key("Enter");
      mouseClick(button("Scale"));
    }
    expect(title()).toMatch(/^Scale 2 /);
    mouseClick(button("Cancel"));
    await done;
    expect(engine.scale).not.toHaveBeenCalled();
  });

  it("asks again before scaling to 0, opening on Cancel", async () => {
    const done = run("scale", ctxOf(pair));
    expect(input().value).toBe("3");
    await armed();
    type("0");
    // Two clusters: typed for first.
    key("Enter");
    await tick();
    expect(title()).toMatch(/^Scale 2 /);
    typeConfirmation("scale 2");
    key("Enter");
    await tick();
    expect(title()).toMatch(/to 0\?$/);
    expect(document.activeElement).toBe(button("Cancel"));

    // Neither the Enter that confirmed the first dialog nor a held ⌘↵ confirms the second one.
    modEnter({ repeat: true });
    modEnter();
    await tick(50);
    expect(engine.scale).not.toHaveBeenCalled();

    mouseClick(button("Cancel"));
    await done;
    expect(engine.scale).not.toHaveBeenCalled();
  });

  it("scales to 0 after the second confirmation, and unmarks what succeeded", async () => {
    setMarked(new Set(pair.map((r) => r.key)));
    const done = run("scale", ctxOf(pair));
    await armed();
    type("0");
    typeConfirmation("scale 2");
    key("Enter");
    await armed();
    mouseClick(button("Scale to 0"));
    await done;
    expect(engine.scale).toHaveBeenCalledTimes(2);
    expect(engine.scale).toHaveBeenCalledWith(expect.objectContaining({ cluster: "prod-eu-z1", name: "payments-api", uid: "payments-api" }), 0);
    expect(marked().size).toBe(0);
  });

  it("scales to other values with a single confirmation", async () => {
    const done = run("scale", ctxOf([deployment("stage", "payments-api", 2)]));
    await armed();
    type("5");
    key("Enter");
    await done;
    expect(engine.scale).toHaveBeenCalledWith(expect.objectContaining({ cluster: "stage" }), 5);
    expect(toasts().at(-1)).toMatchObject({ kind: "success", title: "Scaled payments-api to 5" });
  });

  it("says what was scaled to what", async () => {
    const done = run("scale", ctxOf([deployment("stage", "web-a", 2), deployment("stage", "web-b", 2)]));
    await armed();
    type("3");
    key("Enter");
    await done;
    expect(toasts().at(-1)).toMatchObject({ kind: "success", title: "Scaled 2 objects to 3" });
  });
});

describe("changes in flight", () => {
  /** A request that is answered when the test says so. */
  function later<T = void>() {
    let resolve!: (value: T) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }
  const busy = () => toasts().filter((t) => t.kind === "busy").map((t) => t.title);
  const listed = () => [...document.querySelectorAll(".dlg-items .ellipsis")].map((el) => el.textContent);
  const [a, b, c] = ["web-a", "web-b", "web-c"].map((n) => deployment("prod-eu-z1", n, 2));

  it("say they are running until every request is answered, then report as before", async () => {
    const [first, second] = [later(), later()];
    engine.restart.mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise);
    const done = run("restart", ctxOf([a, b]));
    await armed();
    mouseClick(button("Restart"));
    await tick();
    expect(busy()).toEqual(["Restarting 2 deployments…"]);
    first.resolve();
    await tick();
    expect(busy()).toEqual(["Restarting 2 deployments…"]);
    // Up to a minute later: one cluster never answered.
    second.reject({ kind: "api", message: "no answer within 45s", code: null });
    await done;
    expect(busy()).toEqual([]);
    expect(toasts()).toMatchObject([
      { kind: "success", title: "Restarted web-a" },
      { kind: "error", title: "Restart failed for 1 of 2", detail: "prod-eu-z1 payments/web-b: no answer within 45s", sticky: true },
    ]);
  });

  it("are not sent again to the rows they are still running on", async () => {
    const pending = later();
    engine.restart.mockImplementationOnce(() => pending.promise).mockImplementationOnce(() => pending.promise);
    const done = run("restart", ctxOf([a, b]));
    await armed();
    mouseClick(button("Restart"));
    await tick();

    // ⇧R again: said at once — nothing to confirm, nothing sent.
    await run("restart", ctxOf([a, b]));
    expect(dialog()).toBeNull();
    expect(toasts().at(-1)).toMatchObject({ kind: "info", title: "Already restarting 2 deployments" });
    expect(engine.restart).toHaveBeenCalledTimes(2);

    // With another row: only that one is confirmed, and sent.
    const more = run("restart", ctxOf([b, c]));
    expect(toasts().at(-1)).toMatchObject({ kind: "info", title: "Already restarting 1 of these" });
    expect([title(), listed()]).toEqual(["Restart web-c?", ["payments/web-c"]]);
    await armed();
    mouseClick(button("Restart"));
    await more;
    expect(engine.restart).toHaveBeenCalledTimes(3);
    expect(engine.restart).toHaveBeenLastCalledWith(expect.objectContaining({ name: "web-c" }));

    // Other actions are not held up by it.
    const scale = run("scale", ctxOf([a]));
    expect(title()).toBe("Scale web-a");
    mouseClick(button("Cancel"));
    await scale;

    // Once answered, it can be sent again.
    pending.resolve();
    await done;
    const again = run("restart", ctxOf([a]));
    expect(title()).toBe("Restart web-a?");
    mouseClick(button("Cancel"));
    await again;
  });

  it("say what is being done, whatever is asked meanwhile", async () => {
    const scaling = later();
    engine.scale.mockImplementationOnce(() => scaling.promise);
    const scaled = run("scale", ctxOf([a]));
    await armed();
    type("4");
    key("Enter");
    await tick();
    expect(busy()).toEqual(["Scaling web-a to 4…"]);
    await run("scale", ctxOf([a]));
    expect([dialog(), toasts().at(-1)?.title]).toEqual([null, "Already scaling web-a"]);

    // The table shows the node cordoned before the engine answered: uncordoning it waits too.
    const cordoning = later();
    engine.setUnschedulable.mockImplementationOnce(() => cordoning.promise);
    const node = (status: string): UIRow => ({ key: "prod-eu-z1/node-1", cl: "prod-eu-z1", u: "node-1", n: "node-1", rv: "1", t: 0, s: Tone.Ok, c: [[status, Tone.Ok]] });
    const cordoned = run("cordon", { resourceKey: "nodes", rows: [node("Ready")] });
    await armed();
    mouseClick(button("Cordon"));
    await tick();
    expect(busy()).toEqual(["Scaling web-a to 4…", "Cordoning node-1…"]);
    await run("cordon", { resourceKey: "nodes", rows: [node("Ready,SchedulingDisabled")] });
    expect([dialog(), toasts().at(-1)?.title]).toEqual([null, "Already cordoning node-1"]);

    scaling.resolve();
    cordoning.resolve();
    await Promise.all([scaled, cordoned]);
    expect(busy()).toEqual([]);
  });

  it("create one job per confirmation", async () => {
    const job = later<string>();
    engine.triggerCronJob.mockImplementationOnce(() => job.promise);
    const cron: UIRow = { key: "prod-eu-z1/nightly", cl: "prod-eu-z1", u: "nightly", n: "nightly", ns: "payments", rv: "1", t: 0, s: Tone.Ok, c: ["0 3 * * *", null, false] };
    const ctx: ActionContext = { resourceKey: "cronjobs.batch", rows: [cron] };
    const done = run("trigger", ctx);
    await armed();
    mouseClick(button("Create job"));
    await tick();
    expect(busy()).toEqual(["Creating a job from nightly…"]);
    await run("trigger", ctx);
    expect([dialog(), toasts().at(-1)?.title]).toEqual([null, "Already creating a job from nightly"]);
    job.resolve("nightly-manual-x7k2p");
    await done;
    expect(busy()).toEqual([]);
    expect(toasts().at(-1)).toMatchObject({ kind: "success", title: "Job created", detail: "nightly-manual-x7k2p" });
    expect(engine.triggerCronJob).toHaveBeenCalledTimes(1);
  });

  it("stop saying so when nothing could be sent", async () => {
    engine.deleteObjects.mockRejectedValueOnce({ kind: "other", message: "engine unavailable", code: null });
    const rows = [pod("prod-eu-z1", "web-0")];
    const done = run("delete", { resourceKey: "pods", rows });
    await armed();
    mouseClick(button("Delete"));
    await done;
    expect(busy()).toEqual([]);
    expect(toasts().at(-1)).toMatchObject({ kind: "error", title: "Delete failed for web-0", sticky: true });
    // And it can be tried again.
    const again = run("delete", { resourceKey: "pods", rows });
    expect(title()).toBe("Delete web-0?");
    mouseClick(button("Cancel"));
    await again;
  });
});

describe("suspend", () => {
  it("asks before suspending", async () => {
    const cron: UIRow = { key: "prod-eu-z1/nightly", cl: "prod-eu-z1", u: "nightly", n: "nightly", ns: "payments", rv: "1", t: 0, s: Tone.Ok, c: ["0 3 * * *", null, false] };
    const done = run("suspend", { resourceKey: "cronjobs.batch", rows: [cron] });
    expect(title()).toBe("Suspend nightly?");
    expect(document.activeElement).toBe(button("Cancel"));
    mouseClick(button("Cancel"));
    await done;
    expect(engine.setSuspend).not.toHaveBeenCalled();
  });
});

const pod = (cl: string, n: string): UIRow => ({ key: `${cl}/${n}`, cl, u: `uid-${n}`, n, ns: "shop", rv: "1", t: 0, s: Tone.Ok, c: [] });
const confirmField = () => document.querySelector<HTMLInputElement>(".dlg-confirm input");
const typeConfirmation = (value: string) => {
  confirmField()!.value = value;
  confirmField()!.dispatchEvent(new InputEvent("input", { bubbles: true }));
};

describe("delete", () => {
  it("is confirmed with a click for a few ordinary objects in one cluster", async () => {
    const done = run("delete", { resourceKey: "pods", rows: [pod("prod-eu-z1", "web-0"), pod("prod-eu-z1", "web-1")] });
    expect(confirmField()).toBeNull();
    expect(document.querySelector(".dlg-breakdown")?.textContent).toBe("Inprod-eu-z12 objects");
    await armed();
    mouseClick(button("Delete"));
    await done;
    expect(engine.deleteObjects).toHaveBeenCalledWith([expect.objectContaining({ name: "web-0", uid: "uid-web-0" }), expect.objectContaining({ name: "web-1" })], false);
  });

  it("asks to type the name once Force is ticked", async () => {
    const done = run("delete", { resourceKey: "pods", rows: [pod("prod-eu-z1", "web-0")] });
    document.querySelector<HTMLInputElement>(".dialog input[type=checkbox]")!.click();
    await tick();
    expect(button("Delete").disabled).toBe(true);
    typeConfirmation("web-0");
    await armed();
    mouseClick(button("Delete"));
    await done;
    expect(engine.deleteObjects).toHaveBeenCalledWith([expect.objectContaining({ name: "web-0" })], true);
  });

  it("asks to type `delete N` for objects in several clusters, saying how many in each", async () => {
    const rows = [pod("prod-eu-z1", "web-0"), pod("prod-eu-z2", "web-0"), pod("prod-eu-z2", "web-1")];
    const done = run("delete", { resourceKey: "pods", rows });
    expect(document.querySelector(".dlg-breakdown")?.textContent).toBe("In 2 clusters:prod-eu-z11 objectprod-eu-z22 objects");
    expect(document.querySelector(".dlg-confirm label")?.textContent).toBe("Type delete 3 to confirm");
    mouseClick(button("Delete"));
    await tick();
    expect(engine.deleteObjects).not.toHaveBeenCalled();
    typeConfirmation("delete 3");
    await armed();
    mouseClick(button("Delete"));
    await done;
    expect(engine.deleteObjects).toHaveBeenCalledTimes(1);
  });

  it("asks to type for many objects and for kinds that take more with them", () => {
    const many = Array.from({ length: TYPED_CONFIRM_OVER + 1 }, (_, i) => pod("stage", `web-${i}`));
    expect(deleteConfirmText({ resourceKey: "pods", rows: many }, false)).toBe(`delete ${TYPED_CONFIRM_OVER + 1}`);
    expect(deleteConfirmText({ resourceKey: "pods", rows: many.slice(0, TYPED_CONFIRM_OVER) }, false)).toBeUndefined();
    for (const key of ["namespaces", "customresourcedefinitions.apiextensions.k8s.io", "nodes", "persistentvolumes", "persistentvolumeclaims", "clusterroles.rbac.authorization.k8s.io", "clusterrolebindings.rbac.authorization.k8s.io", "validatingwebhookconfigurations.admissionregistration.k8s.io", "mutatingwebhookconfigurations.admissionregistration.k8s.io", "apiservices.apiregistration.k8s.io", "storageclasses.storage.k8s.io"])
      expect(deleteConfirmText({ resourceKey: key, rows: [pod("stage", "shop")] }, false), key).toBe("shop");
    // No "production" guessing from context names: a single ordinary object is a click anywhere.
    expect(deleteConfirmText({ resourceKey: "pods", rows: [pod("prod-eu-z1", "web-0")] }, false)).toBeUndefined();
  });

  it("says what a namespace takes with it", () => {
    void run("delete", { resourceKey: "namespaces", rows: [pod("stage", "shop")] });
    expect(document.querySelector(".dialog p")?.textContent).toMatch(/^Everything in the namespace is deleted with it/);
    expect(document.activeElement).toBe(confirmField());
  });

  it("reports failures with cluster and namespace until dismissed, all of them in the copy", async () => {
    engine.deleteObjects.mockImplementationOnce(async (targets) =>
      targets.map((target, i) => (i === 1 ? { target, ok: true } : { target, ok: false, error: { kind: "api", message: "forbidden", code: 403 } })),
    );
    const rows = [pod("prod-eu-z1", "web-0"), pod("prod-eu-z1", "web-1"), pod("prod-eu-z2", "web-0")];
    const done = run("delete", { resourceKey: "pods", rows });
    typeConfirmation("delete 3");
    await armed();
    mouseClick(button("Delete"));
    await done;
    const [ok, failed] = toasts();
    expect(ok).toMatchObject({ kind: "success", title: "Deleted web-1" });
    expect(failed).toMatchObject({ kind: "error", title: "Delete failed for 2 of 3", sticky: true });
    expect(failed.copy).toBe("Delete failed for 2 of 3 (pods)\nprod-eu-z1\tshop\tweb-0\tforbidden\nprod-eu-z2\tshop\tweb-0\tforbidden");
  });
});

describe("typed confirmation", () => {
  const label = () => document.querySelector(".dlg-confirm label")?.textContent;
  const cron = (cl: string, n: string): UIRow => ({ key: `${cl}/${n}`, cl, u: n, n, ns: "payments", rv: "1", t: 0, s: Tone.Ok, c: ["0 3 * * *", null, false] });
  const node = (cl: string, n: string): UIRow => ({ key: `${cl}/${n}`, cl, u: n, n, rv: "1", t: 0, s: Tone.Ok, c: [["Ready", Tone.Ok]] });

  it("is asked for every change that reaches several clusters or many objects", async () => {
    const zones = ["prod-eu-z1", "prod-eu-z2", "prod-eu-z3"];
    const cases: [string, ActionContext, string][] = [
      ["restart", ctxOf(zones.map((cl) => deployment(cl, "web", 2))), "Type restart 3 to confirm"],
      ["scale", ctxOf(zones.map((cl) => deployment(cl, "web", 2))), "Type scale 3 to confirm"],
      ["cordon", { resourceKey: "nodes", rows: zones.map((cl) => node(cl, "node-1")) }, "Type cordon 3 to confirm"],
      ["suspend", { resourceKey: "cronjobs.batch", rows: zones.map((cl) => cron(cl, "nightly")) }, "Type suspend 3 to confirm"],
      ["restart", ctxOf(Array.from({ length: TYPED_CONFIRM_OVER + 1 }, (_, i) => deployment("stage", `web-${i}`, 1))), `Type restart ${TYPED_CONFIRM_OVER + 1} to confirm`],
    ];
    for (const [id, ctx, text] of cases) {
      const done = run(id, ctx);
      expect(label(), id).toBe(text);
      mouseClick(button("Cancel"));
      await done;
    }
    // A few in one cluster: a click. Context names are never read.
    expect(typedConfirmText(ctxOf(Array.from({ length: TYPED_CONFIRM_OVER }, (_, i) => deployment("prod-eu-z1", `web-${i}`, 1))), "restart")).toBeUndefined();
  });

  it("restarts in every cluster once typed", async () => {
    const rows = [deployment("prod-eu-z1", "web", 2), deployment("prod-eu-z2", "web", 2)];
    const done = run("restart", ctxOf(rows));
    await armed();
    mouseClick(button("Restart"));
    modEnter();
    await tick();
    expect(engine.restart).not.toHaveBeenCalled();
    typeConfirmation("restart 2");
    modEnter();
    await done;
    expect(engine.restart).toHaveBeenCalledTimes(2);
  });
});

describe("read-only mode", () => {
  const deploy = ctxOf([deployment("prod-eu-z1", "web", 2)]);

  it("shows mutating actions locked, with the reason, and never asks or calls the engine", async () => {
    noteReadOnlyRefusal();
    const acts = actionsFor(deploy);
    const restart = acts.find((a) => a.id === "restart")!;
    expect(restart).toMatchObject({ disabled: READ_ONLY_HINT, icon: "lock" });
    expect(typeof restart.title === "function" && restart.title(deploy)).toBe("Restart (read-only mode)");
    expect(acts.find((a) => a.id === "delete")).toMatchObject({ disabled: READ_ONLY_HINT, danger: false });
    // Reading stays available.
    expect(acts.find((a) => a.id === "yaml")?.disabled).toBeUndefined();
    expect(acts.find((a) => a.id === "copy-name")?.disabled).toBeUndefined();

    // Said to be read-only mode's doing (not missing permissions), with why the action counts as a change.
    expect(restart.disabledReason).toBe("Restart — off in read-only mode: it changes objects in the cluster. Turn read-only mode off in the status bar (it asks to confirm) to use it.");

    await restart.run(deploy);
    expect(dialog()).toBeNull();
    expect(engine.restart).not.toHaveBeenCalled();
    expect(toasts().at(-1)).toMatchObject({ title: "Read-only mode is on", detail: restart.disabledReason });
  });

  it("follows the engine when it refuses as read-only", async () => {
    engine.restart.mockRejectedValueOnce({ kind: "readOnly", message: "read-only mode is on: mutating actions are disabled", code: null });
    const done = run("restart", deploy);
    await armed();
    mouseClick(button("Restart"));
    await done;
    expect(readOnly()).toBe(true);
    expect(toasts().at(-1)).toMatchObject({ kind: "error", title: "Restart failed for web", sticky: true });
  });
});

describe("permissions (RBAC)", () => {
  const pair = [deployment("prod-eu-z1", "web", 2), deployment("prod-eu-z2", "web", 2)];
  const noPatchIn = (cluster: string) => (cl: string, c: { verb: string }) => cl === cluster && c.verb === "patch";

  it("locks an action the user may not take anywhere, says it is the cluster's RBAC, and only explains", async () => {
    access.denied = (_cl, c) => c.verb === "patch";
    const ctx = ctxOf([pair[0]]);
    const restart = actionsFor(ctx).find((a) => a.id === "restart")!;
    expect(restart).toMatchObject({ disabled: NO_PERMISSION_HINT, lock: "rbac", icon: "lock", danger: false });
    expect(restart.disabledReason).toBe("Restart — not allowed: you may not patch deployments in payments on prod-eu-z1. Permissions come from the cluster's RBAC: its admins can grant them.");
    // What the user may do stays as it was.
    expect(actionsFor(ctx).find((a) => a.id === "delete")?.disabled).toBeUndefined();

    await restart.run(ctx);
    expect(dialog()).toBeNull();
    expect(engine.restart).not.toHaveBeenCalled();
    expect(toasts().at(-1)).toMatchObject({ kind: "info", title: "No permission: Restart" });
  });

  it("acts in the clusters where it may and leaves the others out, saying so before asking", async () => {
    access.denied = noPatchIn("prod-eu-z2");
    setMarked(new Set(pair.map((r) => r.key)));
    const restart = actionsFor(ctxOf(pair)).find((a) => a.id === "restart")!;
    expect(restart.disabled).toBeUndefined();
    expect(restart.note).toBe("1 of 2 not allowed — you may not patch deployments in payments on prod-eu-z2 — they are left out");

    const done = restart.run(ctxOf(pair)) as Promise<void>;
    expect(toasts().at(-1)).toMatchObject({ title: "Left out 1 of 2: no permission", detail: "You may not patch deployments in payments on prod-eu-z2." });
    // One cluster, one object: a click confirms it.
    expect(title()).toBe("Restart web?");
    await armed();
    mouseClick(button("Restart"));
    await done;
    expect(engine.restart).toHaveBeenCalledTimes(1);
    expect(engine.restart).toHaveBeenCalledWith(expect.objectContaining({ cluster: "prod-eu-z1" }));
  });

  it("asks about the object itself where the namespace says no (roles on named objects)", () => {
    access.denied = (_cl, c) => c.verb === "patch" && !c.name;
    expect(actionsFor(ctxOf([pair[0]])).find((a) => a.id === "restart")?.disabled).toBeUndefined();
  });

  it("puts read-only mode first: no permissions are asked about then", async () => {
    await setReadOnly(true);
    access.denied = () => true;
    expect(actionsFor(ctxOf([pair[0]])).find((a) => a.id === "restart")).toMatchObject({ disabled: READ_ONLY_HINT, lock: "read-only" });
  });

  it("asks for terminals in pods the subresource they take", () => {
    const pod: UIRow = { key: "prod-eu-z1/p", cl: "prod-eu-z1", u: "p", n: "web-1", ns: "payments", rv: "1", t: 0, s: Tone.Ok, c: [] };
    const asked: string[] = [];
    access.denied = (_cl, c) => {
      asked.push(`${c.verb} ${c.resource}/${c.subresource ?? ""}`);
      return c.subresource === "exec";
    };
    const acts = actionsFor({ resourceKey: "pods", rows: [pod] });
    expect(acts.find((a) => a.id === "shell")).toMatchObject({ disabled: NO_PERMISSION_HINT, lock: "rbac" });
    expect(acts.find((a) => a.id === "attach")?.disabled).toBeUndefined();
    expect(asked).toEqual(expect.arrayContaining(["create pods/exec", "create pods/attach", "create pods/portforward", "get pods/log", "patch pods/ephemeralcontainers", "delete pods/"]));
  });
});
