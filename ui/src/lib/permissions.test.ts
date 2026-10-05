import { describe, expect, it } from "vitest";
import type { AccessRules } from "./backend";
import { answer } from "./permissions";

const rules = (...resources: AccessRules["resources"]): AccessRules => ({ resources, incomplete: false });

describe("what rules allow", () => {
  it("matches verbs, groups and resources like the API server, wildcards included", () => {
    const r = rules({ verbs: ["get", "list"], groups: ["apps"], resources: ["deployments"] }, { verbs: ["*"], groups: [""], resources: ["configmaps"] });
    expect(answer(r, "get", "apps", "deployments")).toBe("yes");
    expect(answer(r, "patch", "apps", "deployments")).toBe("no");
    expect(answer(r, "get", "", "deployments")).toBe("no");
    expect(answer(r, "delete", "", "configmaps")).toBe("yes");
    expect(answer(rules({ verbs: ["*"], groups: ["*"], resources: ["*"] }), "create", "batch", "jobs")).toBe("yes");
  });

  it("knows subresources: by name, all of a resource's, a subresource of any resource", () => {
    expect(answer(rules({ verbs: ["create"], groups: [""], resources: ["pods/exec"] }), "create", "", "pods", "exec")).toBe("yes");
    expect(answer(rules({ verbs: ["create"], groups: [""], resources: ["pods"] }), "create", "", "pods", "exec")).toBe("no");
    expect(answer(rules({ verbs: ["get"], groups: [""], resources: ["pods/*"] }), "get", "", "pods", "log")).toBe("yes");
    expect(answer(rules({ verbs: ["get"], groups: [""], resources: ["*/log"] }), "get", "", "pods", "log")).toBe("yes");
    // A subresource rule does not grant the resource itself.
    expect(answer(rules({ verbs: ["get"], groups: [""], resources: ["pods/log"] }), "get", "", "pods")).toBe("no");
  });

  it("says when a rule names its objects", () => {
    const named = rules({ verbs: ["patch"], groups: ["apps"], resources: ["deployments"], names: ["web"] });
    expect(answer(named, "patch", "apps", "deployments")).toBe("some");
    expect(answer({ ...named, resources: [...named.resources, { verbs: ["patch"], groups: ["apps"], resources: ["deployments"] }] }, "patch", "apps", "deployments")).toBe("yes");
  });
});
