import { changedSpans, editScript, steps } from "./myers";
import { blockBody, blockHeader, isBlock, isMap, isNested, type Json, scalarText, strText } from "./yaml";

// Comparing Kubernetes objects field by field, not line by line: lists of named things (containers, env, ports,
// volumes, conditions) are matched by their names, so an item moved or added elsewhere does not shift every line after
// it; keys are compared whatever their order. Two objects come out as their YAML side by side, lined up; any number
// of them as the fields where they differ.

/** A step into an object: a key of a map, or an item of a list — by the value of its identity key, else its index. */
export type Seg = string | number | { key: string; id: string };
export type Path = readonly Seg[];

export const pathKey = (p: Path) => JSON.stringify(p);

/** `spec.template.spec.containers[app].env[LOG_LEVEL].value`, `metadata.annotations["kubectl.kubernetes.io/restartedAt"]` */
export function pathText(p: Path): string {
  let out = "";
  for (const s of p) {
    if (typeof s === "number") out += `[${s}]`;
    else if (typeof s === "object") out += `[${s.id}]`;
    else if (/^[A-Za-z_$][\w$-]*$/.test(s)) out += out ? `.${s}` : s;
    else out += `[${JSON.stringify(s)}]`;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// What is compared
// ---------------------------------------------------------------------------------------------

export interface CompareOptions {
  /** Compare `status` too (what the cluster reports, not what was asked for). */
  status: boolean;
  /** Compare what differs between any two objects, however alike: identity, bookkeeping, what the cluster assigned. */
  noise: boolean;
}

const ANY = "*";

/** Fields of {@link CompareOptions.noise}; `kinds`: only in objects of these kinds. */
export const NOISE: { path: string[]; kinds?: string[] }[] = [
  { path: ["metadata", "uid"] },
  { path: ["metadata", "resourceVersion"] },
  { path: ["metadata", "generation"] },
  { path: ["metadata", "creationTimestamp"] },
  { path: ["metadata", "managedFields"] },
  { path: ["metadata", "selfLink"] },
  { path: ["metadata", "ownerReferences", ANY, "uid"] },
  // A copy of what was applied (the fields compared anyway), and how many rollouts there were.
  { path: ["metadata", "annotations", "kubectl.kubernetes.io/last-applied-configuration"] },
  { path: ["metadata", "annotations", "deployment.kubernetes.io/revision"] },
  // Addresses and ports the cluster picked.
  { path: ["spec", "clusterIP"], kinds: ["Service"] },
  { path: ["spec", "clusterIPs"], kinds: ["Service"] },
  { path: ["spec", "ports", ANY, "nodePort"], kinds: ["Service"] },
  { path: ["spec", "healthCheckNodePort"], kinds: ["Service"] },
  { path: ["spec", "claimRef", "uid"], kinds: ["PersistentVolume"] },
  { path: ["spec", "claimRef", "resourceVersion"], kinds: ["PersistentVolume"] },
];

/**
 * A copy of `obj` with what `o` leaves out taken out — and maps emptied by that (annotations that were only a
 * revision) with it. Keys whose value is `undefined` are not there.
 */
export function strip(obj: Json, o: CompareOptions): Json {
  const kind = isMap(obj) && typeof obj.kind === "string" ? obj.kind : "";
  const drop = o.noise ? [] : NOISE.filter((n) => !n.kinds || n.kinds.includes(kind)).map((n) => n.path);
  if (!o.status) drop.push(["status"]);
  const copy = (v: Json, pats: string[][], depth: number): Json => {
    if (Array.isArray(v)) {
      const next = pats.filter((p) => p[depth] === ANY);
      return v.map((x) => copy(x, next, depth + 1));
    }
    if (!isMap(v)) return v;
    const out: Record<string, Json> = {};
    for (const k of Object.keys(v)) {
      if (v[k] === undefined) continue;
      const next = pats.filter((p) => p[depth] === k || p[depth] === ANY);
      if (next.some((p) => p.length === depth + 1)) continue;
      const c = copy(v[k], next, depth + 1);
      // Emptied by what was left out of it: gone too.
      if (next.length && isMap(c) && !Object.keys(c).length && isNested(v[k])) continue;
      out[k] = c;
    }
    return out;
  };
  return copy(obj, drop, 0);
}

// ---------------------------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------------------------

const LAST_APPLIED = "kubectl.kubernetes.io/last-applied-configuration";

export const isSecret = (o: Json) => isMap(o) && o.kind === "Secret" && o.apiVersion === "v1";

const hidden = (n: number) => `<hidden: ${n} byte${n === 1 ? "" : "s"}>`;
const utf8Len = (s: string) => new TextEncoder().encode(s).length;

/** Decoded length of a base64 value (what `data` holds). */
function base64Len(s: string): number {
  const t = s.trimEnd();
  const padding = Math.min(2, t.length - t.replace(/=+$/, "").length);
  return Math.max(0, Math.floor(t.length / 4) * 3 + Math.floor(((t.length % 4) * 3) / 4) - padding);
}

/**
 * What a Secret's value at `path` shows while values are hidden — its size, as the YAML tab shows it — or undefined
 * where there is no value: `data`, `stringData`, and the copy of both in `last-applied-configuration`.
 */
export function secretText(path: Path, v: Json): string | undefined {
  if (typeof v !== "string") return undefined;
  if (path.length === 2 && path[0] === "data") return hidden(base64Len(v));
  if (path.length === 2 && path[0] === "stringData") return hidden(utf8Len(v));
  if (path.length === 3 && path[0] === "metadata" && path[1] === "annotations" && path[2] === LAST_APPLIED) return hidden(utf8Len(v));
  return undefined;
}

/** How a value shows instead of itself at a path, if it does (a Secret's values, hidden). */
export type Hide = (path: Path, v: Json) => string | undefined;

// ---------------------------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------------------------

const keysOf = (m: Record<string, Json>) => Object.keys(m).filter((k) => m[k] !== undefined);

export function deepEqual(a: Json, b: Json): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((x, i) => deepEqual(x, b[i]));
  }
  const ka = keysOf(a);
  if (ka.length !== keysOf(b).length) return false;
  return ka.every((k) => b[k] !== undefined && deepEqual(a[k], b[k]));
}

/** JSON with keys in order: the same for equal values, whatever the order of their keys. */
const canonical = (v: Json) => JSON.stringify(v, (_, x) => (isMap(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x)) ?? "undefined";

/** Keys items of a list are told apart by, best first: the first every item has, each a different value. */
const ID_KEYS = ["name", "type", "containerPort", "port", "mountPath", "devicePath", "key", "ip", "topologyKey", "path", "uid"];

/** The key every item of every list has, a scalar of its own in each (containers by `name`, conditions by `type`). */
export function identityKey(lists: readonly Json[][]): string | null {
  for (const k of ID_KEYS) {
    const ok = lists.every((list) => {
      const seen = new Set<string>();
      for (const x of list) {
        const v = isMap(x) ? x[k] : undefined;
        if (v === undefined || v === null || typeof v === "object") return false;
        const s = String(v);
        if (seen.has(s)) return false;
        seen.add(s);
      }
      return true;
    });
    if (ok) return k;
  }
  return null;
}

/**
 * {@link identityKey}, if the lists have an item in common by it: lists of wholly different items (the one container
 * of two different apps, each named after its app) are better lined up by position.
 */
function matchKey(lists: readonly Json[][]): string | null {
  const id = identityKey(lists);
  if (!id) return null;
  const sets = lists.map((list) => new Set(list.map((x) => String(x[id]))));
  return [...sets[0]].some((v) => sets.every((set) => set.has(v))) ? id : null;
}

/** All keys, in the first list's order; one the first lacks follows the key it follows in its own list. */
export function mergeKeys(lists: readonly (readonly string[])[]): string[] {
  let out = [...(lists[0] ?? [])];
  for (const list of lists.slice(1)) {
    const have = new Set(out);
    if (list.every((k) => have.has(k))) continue;
    const after = new Map<string | null, string[]>();
    let prev: string | null = null;
    for (const k of list) {
      if (have.has(k)) prev = k;
      else {
        have.add(k);
        after.set(prev, [...(after.get(prev) ?? []), k]);
      }
    }
    const merged = [...(after.get(null) ?? [])];
    for (const k of out) merged.push(k, ...(after.get(k) ?? []));
    out = merged;
  }
  return out;
}

const isScalarItem = (v: Json) => !isNested(v) && !isBlock(v);

// ---------------------------------------------------------------------------------------------
// Any number of objects: the fields where they differ
// ---------------------------------------------------------------------------------------------

/** A field whose value is not the same in every object: `values[i]` in the i-th, undefined where it is not set. */
export interface Change {
  path: Path;
  values: Json[];
}

/**
 * Where `objs` differ, field by field in document order. A map or list that is not in every object is one change, not
 * one per field in it; so is a list of plain values (`args`, `finalizers`).
 */
export function changes(objs: readonly Json[]): Change[] {
  const out: Change[] = [];
  const walk = (vals: Json[], path: Path) => {
    if (vals.every((v) => deepEqual(v, vals[0]))) return;
    if (vals.every((v) => isMap(v) && isNested(v))) {
      for (const k of mergeKeys(vals.map(keysOf))) walk(vals.map((v) => v[k]), [...path, k]);
      return;
    }
    if (vals.every((v) => Array.isArray(v) && v.length) && !vals.every((v) => v.every(isScalarItem))) {
      const id = matchKey(vals);
      if (id) {
        const byId = vals.map((list: Json[]) => new Map(list.map((x) => [String(x[id]), x])));
        for (const v of mergeKeys(vals.map((list: Json[]) => list.map((x) => String(x[id]))))) walk(byId.map((m) => m.get(v)), [...path, { key: id, id: v }]);
      } else {
        const n = Math.max(...vals.map((list: Json[]) => list.length));
        for (let i = 0; i < n; i++) walk(vals.map((list: Json[]) => list[i]), [...path, i]);
      }
      return;
    }
    out.push({ path, values: vals });
  };
  walk([...objs], []);
  return out;
}

// ---------------------------------------------------------------------------------------------
// Two objects: their YAML side by side
// ---------------------------------------------------------------------------------------------

/** A line of YAML; `block`: inside a `|` block (shown as a string). */
export interface YLine {
  text: string;
  block?: boolean;
}

const sp = (n: number) => " ".repeat(n);

/** Writes values as YAML lines like the engine does (see `yaml.ts`), `hide` taking the place of some. */
class Writer {
  constructor(private readonly hide?: Hide) {}

  hidden(path: Path, v: Json): string | undefined {
    return this.hide?.(path, v);
  }

  /** `key: value` at `ind` (`lead`: what precedes the key on its line, `- ` for the first of a list item). */
  entry(key: string, v: Json, path: Path, ind: number, lead: string): YLine[] {
    const k = strText(key);
    const h = this.hidden(path, v);
    if (h !== undefined) return [{ text: `${lead}${k}: ${h}` }];
    if (isMap(v) && isNested(v)) return [{ text: `${lead}${k}:` }, ...this.map(v, path, ind + 2, sp(ind + 2))];
    // kubectl style: a list under a key is not indented further.
    if (Array.isArray(v) && v.length) return [{ text: `${lead}${k}:` }, ...this.seq(v, path, ind, sp(ind))];
    if (isBlock(v)) return [{ text: `${lead}${k}: ${blockHeader(v)}` }, ...blockBody(v, sp(ind + 2)).map((text) => ({ text, block: true }))];
    return [{ text: `${lead}${k}: ${scalarText(v)}` }];
  }

  /** An item of a list at `ind`; `lead`: what precedes its `-`. */
  item(v: Json, path: Path, ind: number, lead: string): YLine[] {
    const h = this.hidden(path, v);
    if (h !== undefined) return [{ text: `${lead}- ${h}` }];
    if (isMap(v) && isNested(v)) return this.map(v, path, ind + 2, `${lead}- `);
    if (Array.isArray(v) && v.length) return this.seq(v, path, ind + 2, `${lead}- `);
    if (isBlock(v)) return [{ text: `${lead}- ${blockHeader(v)}` }, ...blockBody(v, sp(ind + 2)).map((text) => ({ text, block: true }))];
    return [{ text: `${lead}- ${scalarText(v)}` }];
  }

  map(m: Record<string, Json>, path: Path, ind: number, lead: string): YLine[] {
    const out: YLine[] = [];
    for (const k of keysOf(m)) out.push(...this.entry(k, m[k], [...path, k], ind, out.length ? sp(ind) : lead));
    return out;
  }

  seq(list: Json[], path: Path, ind: number, lead: string): YLine[] {
    const out: YLine[] = [];
    list.forEach((v, i) => out.push(...this.item(v, [...path, i], ind, i ? sp(ind) : lead)));
    return out;
  }

  /** A whole document. */
  doc(v: Json): YLine[] {
    if (isMap(v) && isNested(v)) return this.map(v, [], 0, "");
    if (Array.isArray(v) && v.length) return this.seq(v, [], 0, "");
    return [{ text: typeof v === "string" ? strText(v) : scalarText(v) }];
  }
}

/** `obj` as the engine writes it, line by line. */
export const yamlLines = (obj: Json, hide?: Hide) => new Writer(hide).doc(obj);

/** One side of a row: its line, the line's number on that side, and where it differs from the other side's. */
export interface Half {
  text: string;
  n: number;
  block?: boolean;
  spans?: [number, number][];
}

/** `same` on both sides; `mod`: changed; `del` / `add`: only on the left / right. */
export type RowKind = "same" | "mod" | "del" | "add";

export interface Row {
  t: RowKind;
  l?: Half;
  r?: Half;
}

export interface PairDiff {
  rows: Row[];
  /** Where each field starts (its first row), by {@link pathKey}. */
  anchors: Map<string, number>;
  /** Rows that differ. */
  changed: number;
}

class Pair {
  readonly rows: Row[] = [];
  readonly anchors = new Map<string, number>();
  private ln = 0;
  private rn = 0;
  constructor(
    private readonly wa: Writer,
    private readonly wb: Writer,
  ) {}

  private half(y: YLine, left: boolean, spans?: [number, number][]): Half {
    const h: Half = { text: y.text, n: left ? ++this.ln : ++this.rn };
    if (y.block) h.block = true;
    if (spans) h.spans = spans;
    return h;
  }

  anchor(path: Path) {
    const k = pathKey(path);
    if (!this.anchors.has(k)) this.anchors.set(k, this.rows.length);
  }

  same(ls: YLine[], rs: YLine[]) {
    for (let i = 0; i < Math.max(ls.length, rs.length); i++) {
      if (ls[i] && rs[i]) this.rows.push({ t: "same", l: this.half(ls[i], true), r: this.half(rs[i], false) });
      else if (ls[i]) this.del([ls[i]]);
      else this.add([rs[i]]);
    }
  }

  del(ls: YLine[]) {
    for (const l of ls) this.rows.push({ t: "del", l: this.half(l, true) });
  }

  add(rs: YLine[]) {
    for (const r of rs) this.rows.push({ t: "add", r: this.half(r, false) });
  }

  /** A changed line; `va` / `vb`: where its value starts, marked whole when it reads the same (hidden values). */
  mod(l: YLine, r: YLine, va?: number, vb?: number) {
    if (l.text === r.text && va === undefined) return this.same([l], [r]);
    let [sa, sb] = changedSpans(l.text, r.text);
    if (l.text === r.text) [sa, sb] = [[va!, l.text.length], [vb!, r.text.length]];
    this.rows.push({ t: "mod", l: this.half(l, true, [sa]), r: this.half(r, false, [sb]) });
  }

  /** What replaced what, line for line. */
  replace(ls: YLine[], rs: YLine[]) {
    const n = Math.min(ls.length, rs.length);
    for (let i = 0; i < n; i++) this.mod(ls[i], rs[i]);
    this.del(ls.slice(n));
    this.add(rs.slice(n));
  }

  /** Lines of two texts (blocks), matched. */
  lines(ls: string[], rs: string[]) {
    for (const s of steps(editScript(ls, rs))) {
      if (s.t === "same") this.same([{ text: ls[s.i], block: true }], [{ text: rs[s.j], block: true }]);
      else if (s.t === "mod") this.mod({ text: ls[s.i], block: true }, { text: rs[s.j], block: true });
      else if (s.t === "del") this.del([{ text: ls[s.i], block: true }]);
      else this.add([{ text: rs[s.j], block: true }]);
    }
  }

  /** `key: a` against `key: b`. */
  entry(key: string, a: Json, b: Json, path: Path, ind: number, la: string, lb: string) {
    this.anchor(path);
    if (deepEqual(a, b)) return this.same(this.wa.entry(key, a, path, ind, la), this.wb.entry(key, b, path, ind, lb));
    const k = strText(key);
    if (isMap(a) && isMap(b) && isNested(a) && isNested(b)) {
      this.same([{ text: `${la}${k}:` }], [{ text: `${lb}${k}:` }]);
      return this.map(a, b, path, ind + 2, sp(ind + 2), sp(ind + 2));
    }
    if (Array.isArray(a) && Array.isArray(b) && a.length && b.length) {
      this.same([{ text: `${la}${k}:` }], [{ text: `${lb}${k}:` }]);
      return this.seq(a, b, path, ind, sp(ind), sp(ind));
    }
    const ha = this.wa.hidden(path, a);
    const hb = this.wb.hidden(path, b);
    if (ha === undefined && hb === undefined && isBlock(a) && isBlock(b)) {
      this.mod({ text: `${la}${k}: ${blockHeader(a)}` }, { text: `${lb}${k}: ${blockHeader(b)}` });
      return this.lines(blockBody(a, sp(ind + 2)), blockBody(b, sp(ind + 2)));
    }
    if ((ha !== undefined || isScalarItem(a)) && (hb !== undefined || isScalarItem(b)))
      return this.mod({ text: `${la}${k}: ${ha ?? scalarText(a)}` }, { text: `${lb}${k}: ${hb ?? scalarText(b)}` }, la.length + k.length + 2, lb.length + k.length + 2);
    this.replace(this.wa.entry(key, a, path, ind, la), this.wb.entry(key, b, path, ind, lb));
  }

  /** An item of a list against another (`la` / `lb`: what precedes their `-`). */
  item(a: Json, b: Json, path: Path, ind: number, la: string, lb: string) {
    this.anchor(path);
    if (deepEqual(a, b)) return this.same(this.wa.item(a, path, ind, la), this.wb.item(b, path, ind, lb));
    if (isMap(a) && isMap(b) && isNested(a) && isNested(b)) return this.map(a, b, path, ind + 2, `${la}- `, `${lb}- `);
    if (Array.isArray(a) && Array.isArray(b) && a.length && b.length) return this.seq(a, b, path, ind + 2, `${la}- `, `${lb}- `);
    const ha = this.wa.hidden(path, a);
    const hb = this.wb.hidden(path, b);
    if (ha === undefined && hb === undefined && isBlock(a) && isBlock(b)) {
      this.mod({ text: `${la}- ${blockHeader(a)}` }, { text: `${lb}- ${blockHeader(b)}` });
      return this.lines(blockBody(a, sp(ind + 2)), blockBody(b, sp(ind + 2)));
    }
    if ((ha !== undefined || isScalarItem(a)) && (hb !== undefined || isScalarItem(b)))
      return this.mod({ text: `${la}- ${ha ?? scalarText(a)}` }, { text: `${lb}- ${hb ?? scalarText(b)}` }, la.length + 2, lb.length + 2);
    this.replace(this.wa.item(a, path, ind, la), this.wb.item(b, path, ind, lb));
  }

  map(a: Record<string, Json>, b: Record<string, Json>, path: Path, ind: number, la: string, lb: string) {
    for (const k of mergeKeys([keysOf(a), keysOf(b)])) {
      const p = [...path, k];
      const inA = a[k] !== undefined;
      const inB = b[k] !== undefined;
      if (inA && inB) {
        this.entry(k, a[k], b[k], p, ind, la, lb);
        la = lb = sp(ind);
      } else if (inA) {
        this.anchor(p);
        this.del(this.wa.entry(k, a[k], p, ind, la));
        la = sp(ind);
      } else {
        this.anchor(p);
        this.add(this.wb.entry(k, b[k], p, ind, lb));
        lb = sp(ind);
      }
    }
  }

  seq(a: Json[], b: Json[], path: Path, ind: number, la: string, lb: string) {
    // The first item on each side takes the lead (`- ` of the item this list is in), the others are indented.
    let firstA = true;
    let firstB = true;
    const leadA = () => (firstA ? ((firstA = false), la) : sp(ind));
    const leadB = () => (firstB ? ((firstB = false), lb) : sp(ind));
    const id = matchKey([a, b]);
    if (id) {
      const ia = new Map(a.map((x) => [String(x[id]), x]));
      const ib = new Map(b.map((x) => [String(x[id]), x]));
      for (const v of mergeKeys([[...ia.keys()], [...ib.keys()]])) {
        const p = [...path, { key: id, id: v }];
        const x = ia.get(v);
        const y = ib.get(v);
        if (x !== undefined && y !== undefined) this.item(x, y, p, ind, leadA(), leadB());
        else if (x !== undefined) {
          this.anchor(p);
          this.del(this.wa.item(x, p, ind, leadA()));
        } else {
          this.anchor(p);
          this.add(this.wb.item(y, p, ind, leadB()));
        }
      }
      return;
    }
    // Plain values by their text; anything else by its content: what is in both stays lined up.
    const keyOf = a.every(isScalarItem) && b.every(isScalarItem) ? scalarText : canonical;
    for (const s of steps(editScript(a.map(keyOf), b.map(keyOf)))) {
      if (s.t === "same") {
        this.anchor([...path, s.i]);
        this.same(this.wa.item(a[s.i], [...path, s.i], ind, leadA()), this.wb.item(b[s.j], [...path, s.j], ind, leadB()));
      } else if (s.t === "mod") this.item(a[s.i], b[s.j], [...path, s.i], ind, leadA(), leadB());
      else if (s.t === "del") {
        this.anchor([...path, s.i]);
        this.del(this.wa.item(a[s.i], [...path, s.i], ind, leadA()));
      } else {
        this.anchor([...path, s.j]);
        this.add(this.wb.item(b[s.j], [...path, s.j], ind, leadB()));
      }
    }
  }

  doc(a: Json, b: Json) {
    if (isMap(a) && isMap(b) && isNested(a) && isNested(b)) return this.map(a, b, [], 0, "", "");
    if (Array.isArray(a) && Array.isArray(b) && a.length && b.length) return this.seq(a, b, [], 0, "", "");
    if (deepEqual(a, b)) return this.same(this.wa.doc(a), this.wb.doc(b));
    this.replace(this.wa.doc(a), this.wb.doc(b));
  }
}

/** `a` and `b` as YAML, side by side: every line of each, lined up with the other's where they match. */
export function pairDiff(a: Json, b: Json, hideA?: Hide, hideB?: Hide): PairDiff {
  const p = new Pair(new Writer(hideA), new Writer(hideB));
  p.doc(a, b);
  return { rows: p.rows, anchors: p.anchors, changed: p.rows.reduce((n, r) => n + (r.t === "same" ? 0 : 1), 0) };
}
