import { render } from "solid-js/web";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ObjectRef, ViewBatch, ViewSpec } from "../../lib/backend";
import type { UIRow } from "../../state/view";

// The engine: objects by cluster and name, and watches of one object (pins outside the table).
const engine = vi.hoisted(() => ({
  objects: new Map<string, Record<string, unknown>>(),
  getObject: vi.fn(),
  subscribeView: vi.fn(),
}));
vi.mock("../../lib/backend", async (importOriginal) => ({ ...(await importOriginal<typeof import("../../lib/backend")>()), backend: () => engine }));

// The main table: rows the tests set, every cluster listed.
const table = vi.hoisted(() => ({ setRows: (_rows: UIRow[]) => {}, statuses: {} as Record<string, unknown> }));
vi.mock("../../state/views", async () => {
  const { createSignal } = await import("solid-js");
  const [rows, setRows] = createSignal<UIRow[]>([]);
  table.setRows = setRows;
  return { mainView: { version: () => 0, rows, rowByKey: (k: string) => rows().find((r) => r.key === k), statuses: table.statuses, columns: () => [], resolved: {}, loading: () => false } };
});

import { Tone } from "../../lib/backend";
import type { DetailProps } from "../../registry/details";
import { setSelectedClustersRaw } from "../../state/clusters";
import { clearPins, compareRows, setCompareSettings, togglePins } from "../../state/compare";
import { clearMarks, setMarked } from "../../state/nav";
import { CompareTab, sharedCut, textChange } from "./CompareTab";

const KEY = "deployments.apps";
const row = (cluster: string, name: string): UIRow => ({ key: `${cluster}/${name}`, cl: cluster, u: `${cluster}-${name}`, n: name, ns: "shop", rv: "1", t: 0, s: Tone.Ok, c: [] });
const props = (r: UIRow, resourceKey = KEY): DetailProps => ({ row: r, resourceKey, target: { cluster: r.cl, resource: resourceKey, namespace: r.ns, name: r.n, uid: r.u } });
const deploy = (name: string, image: string, zone: string) => ({
  apiVersion: "apps/v1",
  kind: "Deployment",
  metadata: { name, namespace: "shop", uid: `uid-${zone}`, resourceVersion: zone },
  spec: { replicas: 3, template: { spec: { containers: [{ name: "app", image, env: [{ name: "ZONE", value: zone }] }] } } },
  status: { readyReplicas: 3 },
});

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
  setCompareSettings({ view: "changes", layout: "auto", status: false, noise: false });
  setSelectedClustersRaw(["prod-eu-z1", "prod-eu-z2", "prod-eu-z3"]);
  for (const c of ["prod-eu-z1", "prod-eu-z2", "prod-eu-z3"]) table.statuses[`${c}|`] = { c, ns: null, state: "ready" };
  engine.objects.clear();
  engine.objects.set("prod-eu-z1/web", deploy("web", "registry.example.com/team/web:v1.4", "z1"));
  engine.objects.set("prod-eu-z2/web", deploy("web", "registry.example.com/team/web:v1.5", "z2"));
  engine.getObject.mockImplementation(async (r: ObjectRef) => {
    const o = engine.objects.get(`${r.cluster}/${r.name}`);
    if (!o) throw { kind: "api", message: `${r.name} not found`, code: 404 };
    return o;
  });
  // A watch of one object: listed at once, there or not.
  engine.subscribeView.mockImplementation((spec: ViewSpec, cb: (b: ViewBatch) => void) => {
    const c = spec.clusters[0];
    const ns = spec.namespaces[0] ?? null;
    const name = spec.fieldSelector!.replace("metadata.name=", "");
    const there = engine.objects.has(`${c}/${name}`);
    setTimeout(() => cb({ t: "batch", m: [{ t: "status", c, ns, state: "ready" }, { t: "rows", c, ns, reset: true, up: there ? [{ ...row(c, name), cl: undefined } as never] : [] }] }));
    return { close() {} };
  });
  table.setRows([row("prod-eu-z1", "web"), row("prod-eu-z2", "web")]);
  clearPins();
});
afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

const settle = () => new Promise((r) => setTimeout(r, 30));
function mount(p: DetailProps) {
  const root = document.createElement("div");
  document.body.append(root);
  dispose = render(() => <CompareTab {...p} />, root);
}
const cells = () => [...document.querySelectorAll(".cmp-table tbody tr")].map((tr) => [...tr.querySelectorAll("td")].map((td) => td.textContent));
const header = () => [...document.querySelectorAll(".cmp-table th")].map((th) => th.textContent);
const chips = () => [...document.querySelectorAll(".cmp-sides .chip")].map((c) => c.textContent);

describe("CompareTab", () => {
  it("compares an object with those of its name in the other clusters of the table, field by field", async () => {
    mount(props(row("prod-eu-z1", "web")));
    await settle();
    expect(header()).toEqual(["Field", "z1", "z2"]);
    // What they share is cut off: the tags show.
    expect(cells()).toEqual([
      ["spec.template.spec.containers[app].image", "…v1.4", "…v1.5"],
      ["spec.template.spec.containers[app].env[ZONE].value", "z1", "z2"],
    ]);
    // z3 lists the namespace without it.
    expect(chips()).toEqual(["z1", "z2", "z3not there"]);
    expect(document.querySelector(".cmp-summary")?.textContent).toBe("2 fields differ · not compared: 2 volatile");
  });

  it("reads a pinned object outside the table through a watch of it alone, and leaves the other clusters out", async () => {
    engine.objects.set("staging/web", deploy("web", "registry.example.com/team/web:v1.6", "st"));
    togglePins([{ cluster: "staging", resource: KEY, namespace: "shop", name: "web" }]);
    mount(props(row("prod-eu-z1", "web")));
    await settle();
    expect(engine.subscribeView).toHaveBeenCalledWith(expect.objectContaining({ resource: KEY, clusters: ["staging"], namespaces: ["shop"], fieldSelector: "metadata.name=web" }), expect.any(Function));
    expect(engine.getObject).toHaveBeenCalledWith(expect.objectContaining({ cluster: "staging", name: "web" }));
    expect(header()).toEqual(["Field", "z1", "staging"]);
    expect(cells()[0]).toEqual(["spec.template.spec.containers[app].image", "…v1.4", "…v1.6"]);
    // The table's other clusters: offered, not compared (z2 off).
    expect(document.querySelector(".cmp-chip.twin.off")?.textContent).toBe("z2");
  });

  it("compares the rows marked with = from the first of them only, while they are marked", async () => {
    engine.objects.set("prod-eu-z1/api", deploy("api", "registry.example.com/team/api:v3.0", "z1"));
    const marks = [row("prod-eu-z1", "web"), row("prod-eu-z1", "api")];
    table.setRows([row("prod-eu-z1", "web"), row("prod-eu-z2", "web"), row("prod-eu-z1", "api")]);
    setMarked(new Set(marks.map((r) => r.key)));
    compareRows(marks, KEY);
    mount(props(row("prod-eu-z1", "web")));
    await settle();
    expect(header()).toEqual(["Field", "web", "api"]);
    expect(cells()[0]).toEqual(["metadata.name", "web", "api"]);
    // Any other object: its own name in the other clusters, as before.
    dispose!();
    mount(props(row("prod-eu-z2", "web")));
    await settle();
    expect(header()).toEqual(["Field", "z2", "z1"]);
    // The marks cleared: so is their comparison.
    dispose!();
    clearMarks();
    mount(props(row("prod-eu-z1", "web")));
    await settle();
    expect(header()).toEqual(["Field", "z1", "z2"]);
  });

  it("hides a Secret's values but tells which differ; Reveal shows them", async () => {
    const secret = (password: string) => ({ apiVersion: "v1", kind: "Secret", metadata: { name: "db", namespace: "shop" }, data: { password: btoa(password), user: btoa("admin") } });
    engine.objects.set("prod-eu-z1/db", secret("hunter2"));
    engine.objects.set("prod-eu-z2/db", secret("swordfish"));
    table.setRows([row("prod-eu-z1", "db"), row("prod-eu-z2", "db")]);
    mount(props(row("prod-eu-z1", "db"), "secrets"));
    await settle();
    expect(cells()).toEqual([["data.password", "<hidden: 7 bytes>", "<hidden: 9 bytes>"]]);
    expect(document.body.innerHTML).not.toContain(btoa("hunter2"));
    expect(document.body.innerHTML).not.toContain("hunter2");
    const reveal = [...document.querySelectorAll<HTMLButtonElement>(".cmp .toolbar button")].find((b) => b.textContent?.includes("Reveal"))!;
    reveal.click();
    await settle();
    expect(cells()).toEqual([["data.password", "hunter2", "swordfish"]]);
  });

  it("goes from a change to the YAML of the two objects, at that field", async () => {
    mount(props(row("prod-eu-z1", "web")));
    await settle();
    (document.querySelectorAll(".cmp-table tbody tr")[1].querySelectorAll("td")[2] as HTMLElement).click();
    await settle();
    // A narrow panel: one column, the line as it was and as it is (both marked).
    const flashed = [...document.querySelectorAll(".dv-row.flash")].map((r) => r.textContent);
    expect(flashed).toEqual(["15−          value: z1", "15+          value: z2"]);
    expect(document.querySelector(".dv-count")?.textContent).toBe("2 changes");
  });

  it("says how to compare when there is nothing to compare with", async () => {
    setSelectedClustersRaw(["prod-eu-z1"]);
    table.setRows([row("prod-eu-z1", "web")]);
    mount(props(row("prod-eu-z1", "web")));
    await settle();
    expect(document.querySelector(".cmp-empty h3")?.textContent).toBe("Nothing to compare web with yet");
  });
});

describe("showing what differs", () => {
  it("cuts what values share up to their last separator", () => {
    expect(sharedCut(["registry.example.com/team/web:v1.4", "registry.example.com/team/web:v1.5"])).toBe(30);
    expect(sharedCut(["z1", "z2"])).toBe(0);
    expect(sharedCut(["a:b:c", 1])).toBe(0);
  });

  it("names a text's first line that differs, and how many more do", () => {
    expect(textChange("a: 1\nb: 2\nc: 3\n", "a: 1\nb: 5\nc: 6\n")).toEqual({ first: "b: 5", more: 1 });
    expect(textChange("a\nb\n", "a\n")).toEqual({ first: "− b", more: 0 });
  });
});
