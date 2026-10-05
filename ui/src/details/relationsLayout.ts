import { type GraphEdge, type GraphMessage, type GraphNode, type GraphRel, Tone } from "../lib/backend";

// Where the cards of a graph of relations go: rows from what routes traffic in (top) to what everything runs on
// (bottom), each row ordered to keep edges short and straight (barycentres, as layered graph drawings do), wrapped
// to the width there is. Many pods of one owner make one card (with a dot each), so do many nodes. Pure: tested
// without a DOM.

export const CARD_W = 172;
export const CARD_H = 48;
export const GROUP_W = 204;
export const GROUP_H = 58;
const GAP_X = 18;
const GAP_Y = 46;
/** Between lines of one wrapped row. */
const GAP_LINE = 14;
const PAD = 16;

/** Pods of one owner make a card of their own from this many on. */
const GROUP_PODS = 3;
/** Nodes make one card from this many on (unless one is looked at). */
const GROUP_NODES = 4;

/** Rows, top to bottom; the second element picks the resources a layer splits into (storage: claims, then volumes). */
function rowOf(n: GraphNode): number {
  switch (n.layer) {
    case "release":
      return 0;
    case "traffic":
      return 1;
    case "service":
      return 2;
    case "policy":
      return 3;
    case "workload":
      return 4;
    case "replica":
      return 5;
    case "pod":
      return 6;
    case "config":
      return 7;
    case "storage":
      return n.resource === "persistentvolumeclaims" ? 7 : 8;
    case "identity":
      return n.resource === "serviceaccounts" ? 7 : 8;
    case "node":
      return 8;
  }
}

/** What a row holds, in words (shown beside it). */
export const ROW_TITLES = ["Release", "Traffic", "Services", "Policies", "Workloads", "Replicas", "Pods", "Uses", "Below"];

export interface Card {
  id: string;
  /** One object, or a group: an owner's pods, nodes. */
  type: "object" | "pods" | "nodes";
  /** The object (type "object"). */
  node?: GraphNode;
  /** The objects of a group. */
  members: GraphNode[];
  row: number;
  x: number;
  y: number;
  w: number;
  h: number;
  /** It is (or holds) the object looked at. */
  focus: boolean;
  /** The worst tone among what it holds. */
  tone: Tone;
}

export interface CardEdge {
  id: string;
  from: string;
  to: string;
  rel: GraphRel;
  label?: string;
  /** Edges of the graph it stands for (an owner's pods: one edge each). */
  count: number;
  /** SVG path. */
  path: string;
  /** Where its label goes. */
  mid: [number, number];
}

export interface Layout {
  cards: Card[];
  edges: CardEdge[];
  width: number;
  height: number;
  /** Where each row starts (for its title), by row index. */
  rows: { row: number; y: number }[];
}

const RANK: Record<number, number> = { [Tone.Error]: 5, [Tone.Warn]: 4, [Tone.Info]: 3, [Tone.Ok]: 2, [Tone.Neutral]: 1, [Tone.Muted]: 0 };
const worst = (nodes: GraphNode[]) => nodes.reduce<Tone>((t, n) => ((RANK[n.tone] ?? 0) > (RANK[t] ?? 0) ? n.tone : t), Tone.Muted);

/** The cards of a graph: groups made, every object on exactly one. */
function cardsOf(g: Pick<GraphMessage, "nodes" | "focus">): { cards: Card[]; cardOf: Map<string, string> } {
  const cards: Card[] = [];
  const cardOf = new Map<string, string>();
  const byOwner = new Map<string, GraphNode[]>();
  const kubeNodes = g.nodes.filter((n) => n.resource === "nodes");
  const groupNodes = kubeNodes.length >= GROUP_NODES && !kubeNodes.some((n) => n.id === g.focus);
  for (const n of g.nodes) if (n.resource === "pods" && n.owner && n.id !== g.focus) byOwner.set(n.owner, [...(byOwner.get(n.owner) ?? []), n]);
  for (const n of g.nodes) {
    if (cardOf.has(n.id)) continue;
    const pods = n.resource === "pods" && n.owner && n.id !== g.focus ? byOwner.get(n.owner)! : undefined;
    if (pods && pods.length >= GROUP_PODS) {
      const id = `pods:${n.owner}`;
      cards.push({ id, type: "pods", members: pods, row: rowOf(n), x: 0, y: 0, w: GROUP_W, h: GROUP_H, focus: false, tone: worst(pods) });
      for (const p of pods) cardOf.set(p.id, id);
      continue;
    }
    if (groupNodes && n.resource === "nodes") {
      const id = "nodes:all";
      cards.push({ id, type: "nodes", members: kubeNodes, row: rowOf(n), x: 0, y: 0, w: GROUP_W, h: GROUP_H, focus: false, tone: worst(kubeNodes) });
      for (const k of kubeNodes) cardOf.set(k.id, id);
      continue;
    }
    cards.push({ id: n.id, type: "object", node: n, members: [n], row: rowOf(n), x: 0, y: 0, w: CARD_W, h: CARD_H, focus: n.id === g.focus, tone: n.tone });
    cardOf.set(n.id, n.id);
  }
  return { cards, cardOf };
}

/** The graph's edges between cards: one per pair and kind of relation, counting those it stands for. */
function cardEdges(edges: GraphEdge[], cardOf: Map<string, string>): Omit<CardEdge, "path" | "mid">[] {
  const out = new Map<string, Omit<CardEdge, "path" | "mid">>();
  for (const e of edges) {
    const from = cardOf.get(e.from);
    const to = cardOf.get(e.to);
    if (!from || !to || from === to) continue;
    const id = `${from}\n${to}\n${e.rel}`;
    const prev = out.get(id);
    if (prev) {
      prev.count++;
      if (prev.label !== e.label) prev.label = undefined;
    } else out.set(id, { id, from, to, rel: e.rel, label: e.label, count: 1 });
  }
  return [...out.values()];
}

const kindOrder = (c: Card) => (c.type === "object" ? `${c.node!.kind}\n${c.node!.name}` : `~${c.type}\n${c.id}`);

/**
 * Orders each row by where its neighbours are (the mean of their positions), down the rows and then up, so edges run
 * short and cross little. The focus keeps its row's middle when it can.
 */
function order(rows: Map<number, Card[]>, edges: Omit<CardEdge, "path" | "mid">[]) {
  const neighbours = new Map<string, string[]>();
  for (const e of edges) {
    neighbours.set(e.from, [...(neighbours.get(e.from) ?? []), e.to]);
    neighbours.set(e.to, [...(neighbours.get(e.to) ?? []), e.from]);
  }
  const pos = new Map<string, number>();
  const place = (list: Card[]) => list.forEach((c, i) => pos.set(c.id, (i + 0.5) / list.length));
  const keys = [...rows.keys()].sort((a, b) => a - b);
  for (const k of keys) {
    rows.get(k)!.sort((a, b) => kindOrder(a).localeCompare(kindOrder(b)));
    place(rows.get(k)!);
  }
  const sweep = (rowKeys: number[], from: (other: number, mine: number) => boolean) => {
    for (const k of rowKeys) {
      const list = rows.get(k)!;
      const rowOfCard = new Map<string, number>();
      for (const [rk, cards] of rows) for (const c of cards) rowOfCard.set(c.id, rk);
      const score = new Map<string, number>();
      for (const c of list) {
        const ns = (neighbours.get(c.id) ?? []).filter((n) => from(rowOfCard.get(n) ?? k, k));
        score.set(c.id, ns.length ? ns.reduce((s, n) => s + (pos.get(n) ?? 0.5), 0) / ns.length : (pos.get(c.id) ?? 0.5));
      }
      list.sort((a, b) => score.get(a.id)! - score.get(b.id)! || kindOrder(a).localeCompare(kindOrder(b)));
      place(list);
    }
  };
  sweep(keys, (other, mine) => other < mine);
  sweep([...keys].reverse(), (other, mine) => other > mine);
  sweep(keys, (other, mine) => other !== mine);
}

/** A cubic edge between two cards: out of the bottom of the upper one into the top of the lower one. */
function route(a: Card, b: Card): { path: string; mid: [number, number] } {
  const ax = a.x + a.w / 2;
  const bx = b.x + b.w / 2;
  let [x1, y1, x2, y2] = [ax, a.y + a.h, bx, b.y];
  if (a.y > b.y) [x1, y1, x2, y2] = [ax, a.y, bx, b.y + b.h];
  if (a.y === b.y) [x1, y1, x2, y2] = [ax, a.y + a.h, bx, b.y + b.h];
  const down = a.y <= b.y;
  const dy = Math.max(22, Math.abs(y2 - y1) / 2);
  const c1 = a.y === b.y ? y1 + dy : down ? y1 + dy : y1 - dy;
  const c2 = a.y === b.y ? y2 + dy : down ? y2 - dy : y2 + dy;
  const path = `M${x1},${y1} C${x1},${c1} ${x2},${c2} ${x2},${y2}`;
  const mid: [number, number] = [(x1 + 3 * x1 + 3 * x2 + x2) / 8, (y1 + 3 * c1 + 3 * c2 + y2) / 8];
  return { path, mid };
}

/** Lays `g` out for a drawing at most `maxWidth` wide (rows wrap past it). */
export function layout(g: Pick<GraphMessage, "nodes" | "edges" | "focus">, maxWidth: number): Layout {
  const { cards, cardOf } = cardsOf(g);
  const edges = cardEdges(g.edges, cardOf);
  const rows = new Map<number, Card[]>();
  for (const c of cards) rows.set(c.row, [...(rows.get(c.row) ?? []), c]);
  order(rows, edges);

  const usable = Math.max(CARD_W + 2 * PAD, maxWidth);
  const lines: { row: number; cards: Card[]; w: number; h: number }[] = [];
  for (const k of [...rows.keys()].sort((a, b) => a - b)) {
    let line: Card[] = [];
    let w = 0;
    for (const c of rows.get(k)!) {
      if (line.length && w + GAP_X + c.w > usable - 2 * PAD) {
        lines.push({ row: k, cards: line, w, h: Math.max(...line.map((x) => x.h)) });
        line = [];
        w = 0;
      }
      w += (line.length ? GAP_X : 0) + c.w;
      line.push(c);
    }
    if (line.length) lines.push({ row: k, cards: line, w, h: Math.max(...line.map((x) => x.h)) });
  }
  const width = Math.max(usable, ...lines.map((l) => l.w + 2 * PAD));
  let y = PAD;
  const rowStarts: { row: number; y: number }[] = [];
  lines.forEach((l, i) => {
    if (i > 0) y += lines[i - 1].row === l.row ? GAP_LINE : GAP_Y;
    if (!rowStarts.some((r) => r.row === l.row)) rowStarts.push({ row: l.row, y });
    let x = (width - l.w) / 2;
    for (const c of l.cards) {
      c.x = x;
      c.y = y + (l.h - c.h) / 2;
      x += c.w + GAP_X;
    }
    y += l.h;
  });
  const byId = new Map(cards.map((c) => [c.id, c]));
  return {
    cards,
    edges: edges.map((e) => ({ ...e, ...route(byId.get(e.from)!, byId.get(e.to)!) })),
    width,
    height: y + PAD,
    rows: rowStarts,
  };
}

/** Of `id`: the cards it is linked with, and the edges between. */
export function linked(l: Layout, id: string): { cards: Set<string>; edges: Set<string> } {
  const cards = new Set([id]);
  const edges = new Set<string>();
  for (const e of l.edges)
    if (e.from === id || e.to === id) {
      edges.add(e.id);
      cards.add(e.from === id ? e.to : e.from);
    }
  return { cards, edges };
}

/** Verbs for edges, as the list and tooltips say them ("routes to", "is routed to by"). */
export const REL_WORDS: Record<GraphRel, [string, string]> = {
  owns: ["owns", "owned by"],
  selects: ["selects", "selected by"],
  routes: ["routes to", "routed to by"],
  tls: ["serves the certificate of", "certificate for"],
  mounts: ["mounts", "mounted by"],
  env: ["takes environment from", "gives environment to"],
  pulls: ["pulls images with", "image pull secret of"],
  runsAs: ["runs as", "account of"],
  runsOn: ["runs on", "runs"],
  bound: ["bound to", "bound by"],
  class: ["of class", "class of"],
  scales: ["scales", "scaled by"],
  protects: ["protects", "protected by"],
  isolates: ["applies to", "network policy"],
  subject: ["binds", "bound by"],
  grants: ["grants", "granted by"],
  manages: ["manages", "managed by"],
};
