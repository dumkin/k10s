import { describe, expect, it } from "vitest";
import { type GraphEdge, type GraphNode, Tone } from "../lib/backend";
import { CARD_W, layout, linked } from "./relationsLayout";

const node = (id: string, layer: GraphNode["layer"], extra: Partial<GraphNode> = {}): GraphNode => ({ id, kind: id.split("/")[0], name: id.split("/").pop()!, layer, tone: Tone.Ok, resource: id.split("/")[0], ...extra });
const edge = (from: string, to: string, rel: GraphEdge["rel"], label?: string): GraphEdge => ({ from, to, rel, label });

function app(pods: number) {
  const nodes: GraphNode[] = [
    node("ingresses.networking.k8s.io/shop/shop", "traffic"),
    node("services/shop/web", "service"),
    node("deployments.apps/shop/web", "workload"),
    node("replicasets.apps/shop/web-1", "replica"),
    node("configmaps/shop/web-config", "config"),
    node("secrets/shop/db", "config", { missing: true, tone: Tone.Error }),
    node("nodes//n1", "node"),
  ];
  const edges: GraphEdge[] = [
    edge("ingresses.networking.k8s.io/shop/shop", "services/shop/web", "routes", "shop/api"),
    edge("deployments.apps/shop/web", "replicasets.apps/shop/web-1", "owns"),
    edge("deployments.apps/shop/web", "configmaps/shop/web-config", "mounts", "/etc/app"),
    edge("deployments.apps/shop/web", "secrets/shop/db", "env"),
  ];
  for (let i = 0; i < pods; i++) {
    const id = `pods/shop/web-1-${i}`;
    nodes.push(node(id, "pod", { owner: "replicasets.apps/shop/web-1", tone: i === 0 ? Tone.Error : Tone.Ok }));
    edges.push(edge("replicasets.apps/shop/web-1", id, "owns"), edge("services/shop/web", id, "selects"), edge(id, "nodes//n1", "runsOn"));
  }
  return { nodes, edges, focus: "deployments.apps/shop/web" };
}

describe("relations layout", () => {
  it("puts rows from traffic down to nodes, no two cards on top of each other", () => {
    const l = layout(app(2), 900);
    const y = (id: string) => l.cards.find((c) => c.id === id)!.y;
    expect(y("ingresses.networking.k8s.io/shop/shop")).toBeLessThan(y("services/shop/web"));
    expect(y("services/shop/web")).toBeLessThan(y("deployments.apps/shop/web"));
    expect(y("deployments.apps/shop/web")).toBeLessThan(y("replicasets.apps/shop/web-1"));
    expect(y("replicasets.apps/shop/web-1")).toBeLessThan(y("pods/shop/web-1-0"));
    expect(y("pods/shop/web-1-0")).toBeLessThan(y("configmaps/shop/web-config"));
    expect(y("configmaps/shop/web-config")).toBeLessThan(y("nodes//n1"));
    for (const a of l.cards)
      for (const b of l.cards) {
        if (a === b) continue;
        const apart = a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
        expect(apart, `${a.id} overlaps ${b.id}`).toBe(true);
      }
    expect(l.cards.find((c) => c.focus)?.id).toBe("deployments.apps/shop/web");
  });

  it("makes one card of an owner's many pods, its edges one each (counting them)", () => {
    const l = layout(app(5), 900);
    const pods = l.cards.find((c) => c.type === "pods")!;
    expect(pods.members).toHaveLength(5);
    // The worst of them shows.
    expect(pods.tone).toBe(Tone.Error);
    const selects = l.edges.filter((e) => e.rel === "selects");
    expect(selects).toHaveLength(1);
    expect(selects[0]).toMatchObject({ from: "services/shop/web", to: pods.id, count: 5 });
    // Few pods stay cards of their own.
    expect(layout(app(2), 900).cards.filter((c) => c.type === "pods")).toHaveLength(0);
  });

  it("keeps the pod looked at out of its group", () => {
    const g = { ...app(5), focus: "pods/shop/web-1-3" };
    const l = layout(g, 900);
    expect(l.cards.find((c) => c.focus)?.id).toBe("pods/shop/web-1-3");
    expect(l.cards.find((c) => c.type === "pods")!.members.map((m) => m.id)).not.toContain("pods/shop/web-1-3");
  });

  it("wraps rows wider than the room there is", () => {
    const nodes = [node("deployments.apps/shop/web", "workload"), ...Array.from({ length: 9 }, (_, i) => node(`configmaps/shop/c${i}`, "config"))];
    const edges = nodes.slice(1).map((n) => edge("deployments.apps/shop/web", n.id, "mounts"));
    const l = layout({ nodes, edges, focus: nodes[0].id }, CARD_W * 4);
    const ys = new Set(l.cards.filter((c) => c.id.startsWith("configmaps")).map((c) => c.y));
    expect(ys.size).toBeGreaterThan(1);
    expect(Math.max(...l.cards.map((c) => c.x + c.w))).toBeLessThanOrEqual(l.width);
  });

  it("finds what a card is linked with", () => {
    const l = layout(app(1), 900);
    const { cards, edges } = linked(l, "deployments.apps/shop/web");
    expect([...cards].sort()).toEqual(["configmaps/shop/web-config", "deployments.apps/shop/web", "replicasets.apps/shop/web-1", "secrets/shop/db"]);
    expect(edges.size).toBe(3);
  });
});
