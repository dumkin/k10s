import { describe, expect, it } from "vitest";
import { changes, type Hide, identityKey, mergeKeys, pairDiff, pathText, type Row, secretText, strip, yamlLines } from "./diff";
import { ADD, DEL, editScript, SAME, steps } from "./myers";

const text = (obj: unknown) => `${yamlLines(obj).map((l) => l.text).join("\n")}\n`;
/** Rows as `<kind> left | right`. */
const show = (rows: Row[]) => rows.map((r) => `${r.t} ${r.l?.text ?? ""} | ${r.r?.text ?? ""}`);

describe("YAML as the engine writes it", () => {
  it("writes kubectl's style (the engine's own test, `yaml.rs`)", () => {
    const v = {
      apiVersion: "v1",
      data: { "config.yaml": "a: 1\nb: 2\n", date: "2024-01-01T00:00:00Z", empty: "", flag: "true", ip: "10.0.0.1", ver: "1.2" },
      kind: "ConfigMap",
      list: [{ name: "x", ports: [80, 443] }, "plain", ["nested"]],
      metadata: { annotations: {}, labels: { app: "web" }, name: "cfg", resourceVersion: "123" },
      n: 5,
      nil: null,
    };
    expect(text(v)).toBe(`apiVersion: v1
data:
  config.yaml: |
    a: 1
    b: 2
  date: "2024-01-01T00:00:00Z"
  empty: ""
  flag: "true"
  ip: 10.0.0.1
  ver: "1.2"
kind: ConfigMap
list:
- name: x
  ports:
  - 80
  - 443
- plain
- - nested
metadata:
  annotations: {}
  labels:
    app: web
  name: cfg
  resourceVersion: "123"
"n": 5
nil: null
`);
  });

  it("chomps and indents blocks like the engine, and quotes what would not read back", () => {
    expect(text({ a: "x\ny" })).toBe("a: |-\n  x\n  y\n");
    expect(text({ a: "x\n\n" })).toBe("a: |+\n  x\n\n");
    expect(text({ a: "  x\ny" })).toBe("a: |2-\n    x\n  y\n");
    expect(text({ l: ["\n  foo", { k: "\tx\ny" }] })).toBe("l:\n- |2-\n\n    foo\n- k: |2-\n    \tx\n    y\n");
    for (const s of ["0X1F", "1_000", "08", "1e3", ".5", "1:30", "2024-1-2T1:2:3Z", "yes", "~", "- a", "a: b", "a #b", " x", "x:", "...", "@x", "tab\there"]) expect(text({ s }), s).toMatch(/^s: "/);
    for (const s of ["1.2.3", "v1.2.3", "web-1", "10.0.0.1", "a:b", "a#b", "/etc/app", "-foo bar".slice(1)]) expect(text({ s }), s).toBe(`s: ${s}\n`);
    expect(text({ s: "a\u0001b" })).toBe('s: "a\\u0001b"\n');
  });
});

describe("edit scripts", () => {
  it("finds the shortest one and pairs what went with what came", () => {
    const ops = editScript([..."abcabba"], [..."cbabac"]);
    expect(ops.filter((o) => o !== SAME).length).toBe(5);
    // Applying it to the first gives the second.
    const a = [..."abcabba"];
    const b = [..."cbabac"];
    let i = 0;
    let j = 0;
    const out: string[] = [];
    for (const op of ops) {
      if (op === SAME) {
        expect(a[i]).toBe(b[j]);
        out.push(a[i++]), j++;
      } else if (op === DEL) i++;
      else out.push(b[j++]);
    }
    expect(out.join("")).toBe("cbabac");
    expect(steps([SAME, DEL, DEL, ADD, SAME, ADD])).toEqual([
      { t: "same", i: 0, j: 0 },
      { t: "mod", i: 1, j: 1 },
      { t: "del", i: 2 },
      { t: "same", i: 3, j: 2 },
      { t: "add", j: 3 },
    ]);
  });

  it("replaces the middle whole past the edits it may look for", () => {
    expect(editScript([..."xaaay"], [..."xbbby"], Object.is, 2)).toEqual([SAME, DEL, DEL, DEL, ADD, ADD, ADD, SAME]);
  });
});

describe("matching items of lists", () => {
  it("tells items apart by the first key each has, unique", () => {
    expect(identityKey([[{ name: "a" }, { name: "b" }], [{ name: "b" }]])).toBe("name");
    // The same volume mounted twice: by where.
    expect(
      identityKey([
        [
          { name: "config", mountPath: "/etc/a" },
          { name: "config", mountPath: "/etc/b" },
        ],
      ]),
    ).toBe("mountPath");
    expect(identityKey([[{ key: "a", effect: "x" }, { key: "a", effect: "y" }]])).toBeNull();
    expect(identityKey([["a", "b"]])).toBeNull();
  });

  it("keeps the first list's order and puts the others' keys where they were", () => {
    expect(mergeKeys([["a", "b", "c"], ["x", "a", "c", "y", "b"]])).toEqual(["x", "a", "b", "c", "y"]);
  });
});

describe("two objects side by side", () => {
  const deploy = (containers: unknown[], replicas = 3) => ({ apiVersion: "apps/v1", kind: "Deployment", spec: { replicas, template: { spec: { containers } } } });
  const app = (image: string, env: unknown[] = [{ name: "A", value: "1" }]) => ({ name: "app", image, env });

  it("lines up containers by name: one added before does not shift the other", () => {
    const d = pairDiff(deploy([app("web:1.4")]), deploy([{ name: "init", image: "busybox" }, app("web:1.5")], 4));
    expect(show(d.rows)).toEqual([
      "same apiVersion: apps/v1 | apiVersion: apps/v1",
      "same kind: Deployment | kind: Deployment",
      "same spec: | spec:",
      "mod   replicas: 3 |   replicas: 4",
      "same   template: |   template:",
      "same     spec: |     spec:",
      "same       containers: |       containers:",
      // The new container comes first on the right: it carries the first dash there.
      "add  |       - name: init",
      "add  |         image: busybox",
      "same       - name: app |       - name: app",
      "mod         image: web:1.4 |         image: web:1.5",
      "same         env: |         env:",
      "same         - name: A |         - name: A",
      'same           value: "1" |           value: "1"',
    ]);
    const image = d.rows[10];
    expect(image.l!.spans).toEqual([[21, 22]]);
    expect([image.l!.n, image.r!.n]).toEqual([9, 11]);
    expect(d.changed).toBe(4);
    expect(d.anchors.get(JSON.stringify(["spec", "template", "spec", "containers", { key: "name", id: "app" }, "image"]))).toBe(10);
  });

  it("matches env by name whatever its order, and texts line by line", () => {
    const a = { data: { "app.yaml": "server:\n  port: 8080\nlog:\n  level: info\n" }, env: [{ name: "A", value: "1" }, { name: "B", value: "2" }] };
    const b = { data: { "app.yaml": "server:\n  port: 8080\n  tls: true\nlog:\n  level: debug\n" }, env: [{ name: "B", value: "2" }, { name: "A", value: "1" }] };
    const d = pairDiff(a, b);
    expect(show(d.rows.filter((r) => r.t !== "same"))).toEqual(["add  |       tls: true", "mod       level: info |       level: debug"]);
    expect(d.rows.find((r) => r.t === "add")!.r!.block).toBe(true);
    // Line numbers count each side's own lines.
    expect(d.rows.at(-1)!.l!.n).toBe(11);
    expect(d.rows.at(-1)!.r!.n).toBe(12);
  });

  it("lines up lists of wholly different items by position (two apps, one container each)", () => {
    const d = pairDiff(deploy([{ name: "cart", image: "cart:1" }]), deploy([{ name: "web", image: "web:1" }]));
    expect(show(d.rows.filter((r) => r.t !== "same"))).toEqual(["mod       - name: cart |       - name: web", "mod         image: cart:1 |         image: web:1"]);
    const c = changes([deploy([{ name: "cart", image: "cart:1" }]), deploy([{ name: "web", image: "web:1" }])]);
    expect(c.map((x) => pathText(x.path))).toEqual(["spec.template.spec.containers[0].name", "spec.template.spec.containers[0].image"]);
  });

  it("shows a value whose type changed as one replaced by the other", () => {
    const d = pairDiff({ a: "x", b: 1 }, { a: { k: "x" }, b: 1 });
    expect(show(d.rows)).toEqual(["mod a: x | a:", "add  |   k: x", "same b: 1 | b: 1"]);
  });

  it("lines up plain lists by their items", () => {
    const d = pairDiff({ args: ["--a", "--b", "--c"] }, { args: ["--a", "--c", "--d"] });
    // Like the engine, a string starting with "-" is quoted.
    expect(show(d.rows)).toEqual(["same args: | args:", 'same - "--a" | - "--a"', 'del - "--b" | ', 'same - "--c" | - "--c"', 'add  | - "--d"']);
  });

  it("hides a Secret's values but still tells which differ", () => {
    const hide: Hide = secretText;
    const d = pairDiff({ data: { password: "aGVsbG8=", user: "YWRtaW4=" } }, { data: { password: "d29ybGQ=", user: "YWRtaW4=" } }, hide, hide);
    expect(show(d.rows)).toEqual(["same data: | data:", "mod   password: <hidden: 5 bytes> |   password: <hidden: 5 bytes>", "same   user: <hidden: 5 bytes> |   user: <hidden: 5 bytes>"]);
    // Read the same, differ: the whole value is marked.
    expect(d.rows[1].l!.spans).toEqual([[12, 29]]);
    expect(JSON.stringify(d)).not.toContain("aGVsbG8");
  });
});

describe("any number of objects", () => {
  const dep = (zone: string, image: string, replicas: number, extra?: object) => ({
    metadata: { name: "web", labels: { app: "web" } },
    spec: { replicas, template: { spec: { containers: [{ name: "app", image, env: [{ name: "ZONE", value: zone }] }, ...(extra ? [extra] : [])] } } },
    status: { readyReplicas: replicas },
  });

  it("lists each field that differs once, with every object's value", () => {
    const c = changes([dep("z1", "web:1.5", 3), dep("z2", "web:1.5", 4, { name: "envoy", image: "envoy:1" }), dep("z3", "web:1.4", 3)]);
    expect(c.map((x) => [pathText(x.path), ...x.values])).toEqual([
      ["spec.replicas", 3, 4, 3],
      ["spec.template.spec.containers[app].image", "web:1.5", "web:1.5", "web:1.4"],
      ["spec.template.spec.containers[app].env[ZONE].value", "z1", "z2", "z3"],
      // Not in every object: one change, not one per field.
      ["spec.template.spec.containers[envoy]", undefined, { name: "envoy", image: "envoy:1" }, undefined],
      ["status.readyReplicas", 3, 4, 3],
    ]);
    expect(changes([dep("z1", "a", 1), dep("z1", "a", 1)])).toEqual([]);
    expect(pathText(["metadata", "annotations", "kubectl.kubernetes.io/restartedAt"])).toBe('metadata.annotations["kubectl.kubernetes.io/restartedAt"]');
  });

  it("leaves out status and what differs anyway, unless asked", () => {
    const obj = {
      kind: "Service",
      metadata: { name: "web", uid: "u1", resourceVersion: "9", annotations: { "deployment.kubernetes.io/revision": "3" }, ownerReferences: [{ name: "o", uid: "x" }] },
      spec: { clusterIP: "10.0.0.1", ports: [{ port: 80, nodePort: 31000 }], selector: undefined },
      status: { loadBalancer: {} },
    };
    expect(strip(obj, { status: false, noise: false })).toEqual({ kind: "Service", metadata: { name: "web", ownerReferences: [{ name: "o" }] }, spec: { ports: [{ port: 80 }] } });
    expect(strip(obj, { status: true, noise: true })).toEqual({ ...obj, spec: { clusterIP: "10.0.0.1", ports: [{ port: 80, nodePort: 31000 }] } });
    // Kind-specific: a pod's cluster IP is not one the cluster picked for a Service.
    expect(strip({ kind: "Pod", spec: { clusterIP: "x" } }, { status: false, noise: false })).toEqual({ kind: "Pod", spec: { clusterIP: "x" } });
  });
});
