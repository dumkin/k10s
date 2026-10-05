import { describe, expect, it } from "vitest";
import { families, zoneOf } from "./clusters";

/** EKS contexts as `aws eks update-kubeconfig` names them: one region, several accounts and clusters. */
const eks = ["arn:aws:eks:eu-west-1:111111111111:cluster/payments", "arn:aws:eks:eu-west-1:222222222222:cluster/orders", "arn:aws:eks:eu-west-1:111111111111:cluster/ledger-2"];

describe("zone families", () => {
  it("groups per-DC names", () => {
    expect(families(["prod-eu-z2", "prod-eu-z1", "prod-eu-z3", "prod-eu-z01-2", "stage-us"])).toEqual([{ base: "prod-eu", members: ["prod-eu-z1", "prod-eu-z01-2", "prod-eu-z2", "prod-eu-z3"] }]);
    expect(families(["prod-eu-1", "prod-eu-2", "acme-dc1", "acme-dc2", "acme-zone-a", "edge_az1", "edge_az2"])).toEqual([
      { base: "acme", members: ["acme-dc1", "acme-dc2", "acme-zone-a"] },
      { base: "edge", members: ["edge_az1", "edge_az2"] },
      { base: "prod-eu", members: ["prod-eu-1", "prod-eu-2"] },
    ]);
    expect(zoneOf("prod-eu-z2")).toEqual({ base: "prod-eu", zone: "z2" });
    expect(zoneOf("prod-eu-2")).toEqual({ base: "prod-eu", zone: "2" });
  });

  it("does not merge ARNs, URLs or user@cluster names because of a trailing number", () => {
    const names = [...eks, "https://api-1.acme.example:6443", "https://api-2.acme.example:6443", "kubernetes-admin@cluster-1", "kubernetes-admin@cluster-2"];
    for (const n of names) expect(zoneOf(n), n).toBeNull();
    expect(families(names)).toEqual([]);
    // A zone named as such still makes one, whatever the name is made of.
    const zoned = ["arn:aws:eks:eu-west-1:111111111111:cluster/payments-z1", "arn:aws:eks:eu-west-1:111111111111:cluster/payments-z2", "admin@prod-eu-z1", "admin@prod-eu-z2"];
    expect(families([...names, ...zoned])).toEqual([
      { base: "admin@prod-eu", members: ["admin@prod-eu-z1", "admin@prod-eu-z2"] },
      { base: "arn:aws:eks:eu-west-1:111111111111:cluster/payments", members: zoned.slice(0, 2) },
    ]);
  });
});
