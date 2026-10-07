import { createEffect, createRoot, createSignal } from "solid-js";
import { render } from "solid-js/web";
import { afterEach, describe, expect, it, vi } from "vitest";

const engine = vi.hoisted(() => ({ getObject: vi.fn() }));
vi.mock("../lib/backend", async (original) => ({ ...(await original<typeof import("../lib/backend")>()), backend: () => engine }));

import { conditionBadge, Conditions, useObject } from "./common";

afterEach(() => {
  document.body.innerHTML = "";
  engine.getObject.mockReset();
});

const settle = () => new Promise((r) => setTimeout(r, 0));

describe("useObject", () => {
  const target = { cluster: "prod-eu-z1", resource: "pods", namespace: "shop", name: "web-0", uid: "uid-web-0" };
  const pod = (rv: string, image = "web:1", restarts = 0) => ({ metadata: { name: "web-0", resourceVersion: rv }, spec: { containers: [{ name: "web", image }] }, status: { restarts } });
  /** Each read gets a new copy, as the engine's come (JSON over IPC). */
  const copy = <T,>(v: T): T => JSON.parse(JSON.stringify(v));

  function mount(version = "1") {
    const [ref, setRef] = createSignal({ ...target });
    const [rv, setRv] = createSignal(version);
    let obj!: ReturnType<typeof useObject>;
    const dispose = createRoot((dispose) => {
      obj = useObject(ref, rv);
      return dispose;
    });
    return { obj, setRef, setRv, dispose };
  }

  it("reads again when the version changes, not when the same target comes again", async () => {
    engine.getObject.mockImplementation(async () => copy(pod("1")));
    const { setRef, setRv, dispose } = mount();
    await settle();
    expect(engine.getObject).toHaveBeenCalledTimes(1);
    // The row sent again as it was: a new object, the same target.
    setRef({ ...target });
    await settle();
    expect(engine.getObject).toHaveBeenCalledTimes(1);
    setRv("2");
    await settle();
    expect(engine.getObject).toHaveBeenCalledTimes(2);
    dispose();
  });

  it("reads an object without a version again with each new row: nothing else tells that it changed", async () => {
    engine.getObject.mockImplementation(async () => copy(pod("")));
    const { setRef, dispose } = mount("");
    await settle();
    setRef({ ...target });
    await settle();
    expect(engine.getObject).toHaveBeenCalledTimes(2);
    dispose();
  });

  it("keeps what did not change of what it shows", async () => {
    let held = pod("1");
    engine.getObject.mockImplementation(async () => copy(held));
    const { obj, setRv, dispose } = mount();
    await settle();
    const first = obj.value()!;
    let runs = 0;
    const stop = createRoot((stop) => {
      createEffect(() => (obj.value(), runs++));
      return stop;
    });

    // Read again as it was (its row changed, the object not): the same object, and what reads it does not run again.
    setRv("2");
    await settle();
    expect(obj.value()).toBe(first);
    expect(runs).toBe(1);

    // It restarted: a new object, with the spec it had.
    held = pod("3", "web:1", 1);
    setRv("3");
    await settle();
    expect(obj.value()).toEqual(held);
    expect(obj.value()!.spec).toBe(first.spec);
    expect(runs).toBe(2);
    stop();
    dispose();
  });

  it("keeps it against what it shows, not against a read that came back late", async () => {
    const answers: ((v: unknown) => void)[] = [];
    engine.getObject.mockImplementation(() => new Promise((resolve) => answers.push(resolve)));
    const { obj, setRv, dispose } = mount();
    answers[0](copy(pod("1")));
    await settle();
    const shown = obj.value()!;

    // Versions 2 and 3 read; 3 answers first, then 2 (another image, rolled back since): dropped, as it is late.
    setRv("2");
    setRv("3");
    answers[2](copy(pod("3")));
    await settle();
    answers[1](copy(pod("2", "web:2")));
    await settle();
    expect(obj.value()!.metadata.resourceVersion).toBe("3");

    // The next read is kept against what shows: its spec, as before, is the one shown.
    setRv("4");
    answers[3](copy(pod("4")));
    await settle();
    expect(obj.value()!.metadata.resourceVersion).toBe("4");
    expect(obj.value()!.spec).toBe(shown.spec);
    dispose();
  });
});

describe("conditionBadge", () => {
  it("is green when a positive condition is True and red when it is False", () => {
    for (const type of ["Ready", "ContainersReady", "Initialized", "PodScheduled", "Available", "Progressing", "Complete", "Established", "NamesAccepted"]) {
      expect([type, conditionBadge(type, "True")]).toEqual([type, "ok"]);
      expect([type, conditionBadge(type, "False")]).toEqual([type, "err"]);
    }
  });

  it("is red when a negative condition is True and green when it is False", () => {
    const negative = [
      ...["MemoryPressure", "DiskPressure", "PIDPressure", "NetworkUnavailable"],
      // Deployment/ReplicaSet quota failures, Job failure policy, Pod eviction/preemption.
      ...["ReplicaFailure", "FailureTarget", "Failed", "DisruptionTarget"],
      // node-problem-detector: False on every healthy node.
      ...["KernelDeadlock", "ReadonlyFilesystem", "FrequentKubeletRestart", "FrequentContainerdRestart", "FrequentUnregisterNetDevice", "CorruptDockerOverlay2", "KubeletProblem", "ContainerRuntimeUnhealthy"],
      "NamespaceDeletionContentFailure",
    ];
    for (const type of negative) {
      expect([type, conditionBadge(type, "True")]).toEqual([type, "err"]);
      expect([type, conditionBadge(type, "False")]).toEqual([type, "ok"]);
    }
  });

  it("stays neutral for types of unknown polarity and amber for Unknown", () => {
    for (const type of ["Suspended", "Resizing", "ScalingLimited", "Reconciling", "SomethingCustom", "Frequently", "Unavailable", undefined]) {
      expect([type, conditionBadge(type, "True")]).toEqual([type, ""]);
      expect([type, conditionBadge(type, "False")]).toEqual([type, ""]);
    }
    expect(conditionBadge("Ready", "Unknown")).toBe("warn");
    expect(conditionBadge("SomethingCustom", "Unknown")).toBe("warn");
    expect(conditionBadge("Ready", undefined)).toBe("");
  });

  it("shows a PDB with no disruptions allowed in amber, like its table row", () => {
    expect(conditionBadge("DisruptionAllowed", "True")).toBe("ok");
    expect(conditionBadge("DisruptionAllowed", "False")).toBe("warn");
    expect(conditionBadge("DisruptionAllowed", "Unknown")).toBe("warn");
  });
});

describe("Conditions", () => {
  it("colours each badge by the condition's polarity", () => {
    const root = document.createElement("div");
    document.body.append(root);
    const dispose = render(
      () => (
        <Conditions
          conditions={[
            { type: "Available", status: "True" },
            { type: "ReplicaFailure", status: "True", reason: "FailedCreate" },
            { type: "KernelDeadlock", status: "False" },
            { type: "Suspended", status: "False" },
            { type: "Ready", status: "Unknown" },
          ]}
        />
      ),
      root,
    );
    const badges = [...root.querySelectorAll("tbody .badge")].map((b) => [b.textContent, [...b.classList].filter((c) => c !== "badge").join(" ")]);
    expect(badges).toEqual([
      ["True", "ok"],
      ["True", "err"],
      ["False", "ok"],
      ["False", ""],
      ["Unknown", "warn"],
    ]);
    dispose();
  });
});
