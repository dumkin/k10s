import { afterEach, describe, expect, it, vi } from "vitest";

const engine = vi.hoisted(() => ({
  accessReview: vi.fn(async (_cluster: string, checks: { verb: string }[]) => checks.map((c) => ({ allowed: c.verb !== "delete" }))),
}));
vi.mock("../lib/backend", async (importOriginal) => ({ ...(await importOriginal<typeof import("../lib/backend")>()), backend: () => engine }));

import { accessKnown, accessNow, checkText, forgetAccess, streamVerb } from "./access";

const check = (verb: string, name?: string) => ({ verb, group: "apps", resource: "deployments", namespace: "shop", name });

afterEach(() => {
  forgetAccess();
  vi.clearAllMocks();
});

describe("access decisions", () => {
  it("asks once per cluster for what is asked together, and keeps the answers", async () => {
    const [a, b] = await Promise.all([accessNow("z1", [check("patch", "web")]), accessNow("z1", [check("delete", "web")])]);
    expect([a[0].allowed, b[0].allowed]).toEqual([true, false]);
    expect(engine.accessReview).toHaveBeenCalledTimes(1);
    expect(engine.accessReview.mock.calls[0][1]).toHaveLength(2);
    expect(accessKnown("z1", check("patch", "web"))).toEqual({ allowed: true });
    await accessNow("z1", [check("patch", "web")]);
    expect(engine.accessReview).toHaveBeenCalledTimes(1);
  });

  it("says unknown when the cluster cannot answer, or not in time", async () => {
    engine.accessReview.mockRejectedValueOnce(new Error("no network"));
    expect((await accessNow("z2", [check("patch")]))[0]).toEqual({ allowed: null });
    engine.accessReview.mockImplementationOnce(() => new Promise(() => {}));
    expect((await accessNow("z3", [check("patch")], 50))[0]).toEqual({ allowed: null });
  });

  it("knows which verb a stream into a pod takes, by Kubernetes version", () => {
    expect(streamVerb("v1.33.4+k3s1")).toBe("create");
    expect(streamVerb("v1.30.0")).toBe("create");
    expect(streamVerb("v1.29.9-eks-1234")).toBe("get");
    expect(streamVerb(undefined)).toBe("create");
  });

  it("words a check", () => {
    expect(checkText({ verb: "create", group: "", resource: "pods", subresource: "exec" })).toBe("create pods/exec");
    expect(checkText({ verb: "patch", group: "apps", resource: "deployments" })).toBe("patch deployments");
    expect(checkText({ verb: "delete", group: "cert-manager.io", resource: "certificates" })).toBe("delete certificates.cert-manager.io");
  });
});
