// The shortest edit script between two sequences (Myers, "An O(ND) Difference Algorithm"): lines of a text, items of a
// list. What both start and end with is taken off first; past `maxD` edits the middle counts as replaced whole, so a
// huge, wholly different text costs no more than a small one.

export const SAME = 0;
export const DEL = 1;
export const ADD = 2;
/** `SAME`: in both; `DEL`: only in the first sequence; `ADD`: only in the second. */
export type Op = typeof SAME | typeof DEL | typeof ADD;

/** Edits are cheap to find up to this many: the work and memory grow with their square. */
export const MAX_EDITS = 1500;

/** Turns `a` into `b`, in order. */
export function editScript<T>(a: readonly T[], b: readonly T[], eq: (x: T, y: T) => boolean = Object.is, maxD = MAX_EDITS): Op[] {
  let p = 0;
  while (p < a.length && p < b.length && eq(a[p], b[p])) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && eq(a[a.length - 1 - s], b[b.length - 1 - s])) s++;
  const mid = middle(a.length - p - s, b.length - p - s, (i, j) => eq(a[p + i], b[p + j]), maxD);
  const out = new Array<Op>(p).fill(SAME);
  for (const op of mid) out.push(op);
  for (let k = 0; k < s; k++) out.push(SAME);
  return out;
}

function middle(n: number, m: number, eq: (i: number, j: number) => boolean, maxD: number): Op[] {
  if (!n) return new Array<Op>(m).fill(ADD);
  if (!m) return new Array<Op>(n).fill(DEL);
  // trace[d][(k + d) / 2]: how far (x) the furthest path with d edits reaches on diagonal k = x - y.
  const trace: Int32Array[] = [];
  let found = -1;
  for (let d = 0; d <= Math.min(n + m, maxD) && found < 0; d++) {
    const v = new Int32Array(d + 1);
    const prev = trace[d - 1];
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (d === 0) x = 0;
      else if (k === -d || (k !== d && prev[(k + d - 2) >> 1] < prev[(k + d) >> 1])) x = prev[(k + d) >> 1];
      else x = prev[(k + d - 2) >> 1] + 1;
      let y = x - k;
      while (x < n && y < m && eq(x, y)) {
        x++;
        y++;
      }
      v[(k + d) >> 1] = x;
      if (x >= n && y >= m) {
        found = d;
        break;
      }
    }
    trace.push(v);
  }
  if (found < 0) return [...new Array<Op>(n).fill(DEL), ...new Array<Op>(m).fill(ADD)];
  const ops: Op[] = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d--) {
    const prev = trace[d - 1];
    const k = x - y;
    // Down: an item of `b` came in (x stays); right: one of `a` went.
    const down = k === -d || (k !== d && prev[(k + d - 2) >> 1] < prev[(k + d) >> 1]);
    const pk = down ? k + 1 : k - 1;
    const px = prev[(pk + d - 1) >> 1];
    const sx = down ? px : px + 1;
    while (x > sx) {
      ops.push(SAME);
      x--;
      y--;
    }
    ops.push(down ? ADD : DEL);
    x = px;
    y = px - pk;
  }
  for (; x > 0; x--) ops.push(SAME);
  return ops.reverse();
}

/** One step of a script, paired up for side by side: `i` in the first sequence, `j` in the second. */
export type Step = { t: "same" | "mod"; i: number; j: number } | { t: "del"; i: number } | { t: "add"; j: number };

/**
 * The steps of `ops`: between items in both, the ones that went and came are paired as changed ones (as many as there
 * are of both), the rest left on their own.
 */
export function steps(ops: readonly Op[]): Step[] {
  const out: Step[] = [];
  let i = 0;
  let j = 0;
  for (let k = 0; k < ops.length; ) {
    if (ops[k] === SAME) {
      out.push({ t: "same", i: i++, j: j++ });
      k++;
      continue;
    }
    const dels: number[] = [];
    const adds: number[] = [];
    for (; k < ops.length && ops[k] !== SAME; k++) {
      if (ops[k] === DEL) dels.push(i++);
      else adds.push(j++);
    }
    const n = Math.min(dels.length, adds.length);
    for (let q = 0; q < n; q++) out.push({ t: "mod", i: dels[q], j: adds[q] });
    for (let q = n; q < dels.length; q++) out.push({ t: "del", i: dels[q] });
    for (let q = n; q < adds.length; q++) out.push({ t: "add", j: adds[q] });
  }
  return out;
}

/** Where two lines differ: from the first character that is not common to both to the last one, in each. */
export function changedSpans(a: string, b: string): [[number, number], [number, number]] {
  let p = 0;
  const n = Math.min(a.length, b.length);
  while (p < n && a.charCodeAt(p) === b.charCodeAt(p)) p++;
  let s = 0;
  while (s < n - p && a.charCodeAt(a.length - 1 - s) === b.charCodeAt(b.length - 1 - s)) s++;
  return [
    [p, a.length - s],
    [p, b.length - s],
  ];
}
