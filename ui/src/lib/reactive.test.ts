import { describe, expect, it } from "vitest";
import { keepUnchanged } from "./reactive";

const copy = <T>(v: T): T => JSON.parse(JSON.stringify(v));

describe("keepUnchanged", () => {
  const pod = {
    metadata: { name: "web-0", labels: { app: "web" }, resourceVersion: "1" },
    spec: { containers: [{ name: "web", env: [{ name: "A", value: "1" }] }, { name: "envoy" }] },
    status: { phase: "Running", containerStatuses: [{ name: "web", restartCount: 0 }, { name: "envoy", restartCount: 0 }] },
  };

  it("gives the old value back when the new copy is equal", () => {
    expect(keepUnchanged(pod, copy(pod))).toBe(pod);
  });

  it("keeps the parts that did not change, and gives the new ones", () => {
    const next = copy(pod);
    next.metadata.resourceVersion = "2";
    next.status.containerStatuses[0].restartCount = 1;
    const kept = keepUnchanged(pod, next);
    expect(kept).toEqual(next);
    expect(kept).not.toBe(pod);
    expect(kept.spec).toBe(pod.spec);
    expect(kept.metadata).not.toBe(pod.metadata);
    expect(kept.metadata.labels).toBe(pod.metadata.labels);
    expect(kept.status.containerStatuses).not.toBe(pod.status.containerStatuses);
    expect(kept.status.containerStatuses[0]).not.toBe(pod.status.containerStatuses[0]);
    expect(kept.status.containerStatuses[1]).toBe(pod.status.containerStatuses[1]);
  });

  it("sees keys and items added or taken away", () => {
    const added = copy(pod) as typeof pod & { spec: { nodeName?: string } };
    added.spec.nodeName = "node-1";
    expect(keepUnchanged(pod, added).spec).not.toBe(pod.spec);
    expect(keepUnchanged(pod, added)).toEqual(added);

    const fewer = copy(pod);
    fewer.spec.containers.pop();
    expect(keepUnchanged(pod, fewer).spec.containers).toEqual([pod.spec.containers[0]]);
    expect(keepUnchanged(pod, fewer).spec.containers[0]).toBe(pod.spec.containers[0]);

    // A key now undefined is not the key gone, nor the other way round.
    expect(keepUnchanged({ a: 1 }, { a: 1, b: undefined })).toEqual({ a: 1, b: undefined });
    expect(keepUnchanged({ a: 1, b: undefined }, { a: 1 })).toEqual({ a: 1 });
  });

  it("keeps the items of an array that did not change, and the array itself when none did", () => {
    const prev = { items: [{ n: 1 }, { n: 2 }, null] };
    expect(keepUnchanged(prev, copy(prev))).toBe(prev);
    const longer = keepUnchanged(prev, { items: [{ n: 1 }, { n: 2 }, null, { n: 4 }] });
    expect(longer.items).toEqual([{ n: 1 }, { n: 2 }, null, { n: 4 }]);
    expect(longer.items[1]).toBe(prev.items[1]);
    const shorter = keepUnchanged(prev, { items: [{ n: 1 }] });
    expect(shorter.items).toEqual([{ n: 1 }]);
    expect(shorter.items[0]).toBe(prev.items[0]);
    // An item more that is null is still an item more.
    expect(keepUnchanged([1], [1, null])).toEqual([1, null]);
  });

  it("keeps a field named __proto__ as a field, never as the prototype", () => {
    // A ConfigMap may have that key; a custom resource, that field.
    const kept = keepUnchanged(JSON.parse('{"data":{"__proto__":"x","a":"1"}}'), JSON.parse('{"data":{"__proto__":"x","a":"2"}}'));
    expect(Object.keys(kept.data)).toEqual(["__proto__", "a"]);
    expect(Object.getPrototypeOf(kept.data)).toBe(Object.prototype);

    const added = keepUnchanged(JSON.parse('{"spec":{"a":1}}'), JSON.parse('{"spec":{"a":1,"__proto__":{"admin":true}}}'));
    expect(Object.keys(added.spec)).toEqual(["a", "__proto__"]);
    expect(added.spec.admin).toBeUndefined();
  });

  it("takes the new value where the kind of value changed", () => {
    expect(keepUnchanged({ a: [1] }, { a: { 0: 1 } }).a).toEqual({ 0: 1 });
    expect(keepUnchanged({ a: { b: 1 } }, { a: null }).a).toBeNull();
    expect(keepUnchanged({ a: "1" }, { a: 1 }).a).toBe(1);
    expect(keepUnchanged(undefined, pod)).toBe(pod);
  });
});
