import { render } from "solid-js/web";
import { afterEach, describe, expect, it } from "vitest";
import { conditionBadge, Conditions } from "./common";

afterEach(() => {
  document.body.innerHTML = "";
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
