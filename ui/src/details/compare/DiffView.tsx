import { createEffect, createMemo, createSignal, For, type JSX, on, onCleanup, onMount, Show } from "solid-js";
import { Icon } from "../../components/Icon";
import { type Half, type PairDiff, type Path, pathKey } from "../../lib/compare/diff";
import { bindAll } from "../../lib/hotkeys";
import { tokenizeLine } from "../../lib/yaml";
import { detailsHaveKeyboard } from "../../state/keyboard";
import { LINE_H } from "../CodeView";

/** Unchanged lines shown around a change; longer runs of them fold away. */
export const CONTEXT = 3;
const OVERSCAN = 20;

/** What is drawn on a line: a row of both sides (split), one side's line (unified), or unchanged lines folded away. */
type Item = { k: "row"; row: number } | { k: "line"; row: number; side: "l" | "r" | "both" } | { k: "fold"; from: number; to: number };

/** A line's text, highlighted as YAML, its changed part marked. */
function HalfText(props: { half?: Half }) {
  return (
    <Show when={props.half}>
      {(h) => {
        const tokens = tokenizeLine(h().text, !!h().block);
        const [s, e] = h().spans?.[0] ?? [0, 0];
        let at = 0;
        return (
          <For each={tokens}>
            {(t) => {
              const a = at;
              at += t.text.length;
              if (e <= s || at <= s || a >= e) return <span class={`y-${t.kind}`}>{t.text}</span>;
              const x = Math.max(a, s) - a;
              const y = Math.min(at, e) - a;
              return (
                <span class={`y-${t.kind}`}>
                  {t.text.slice(0, x)}
                  <mark class="dx">{t.text.slice(x, y)}</mark>
                  {t.text.slice(y)}
                </span>
              );
            }}
          </For>
        );
      }}
    </Show>
  );
}

export interface DiffViewProps {
  diff: PairDiff;
  /** Both sides next to each other, or one column (lines removed, then added). */
  split: boolean;
  left: JSX.Element;
  right: JSX.Element;
  /** Puts the left object on the right and the right one on the left. */
  onSwap?: () => void;
  /** Folds open again when this changes (other objects compared), not when the objects do. */
  pairKey: string;
  /** Scrolls to where this field starts (or the nearest field around it), unfolding it. */
  jump?: { path: Path; n: number } | null;
}

/** Two objects' YAML, lined up; unchanged lines fold away but for a few around each change. */
export function DiffView(props: DiffViewProps) {
  let el!: HTMLDivElement;
  const [top, setTop] = createSignal(0);
  const [height, setHeight] = createSignal(600);
  const [width, setWidth] = createSignal(800);
  /** Folds opened, by the row they start at. */
  const [open, setOpen] = createSignal<ReadonlySet<number>>(new Set());
  createEffect(
    on(
      () => props.pairKey,
      () => setOpen(new Set<number>()),
      { defer: true },
    ),
  );

  /** Rows, and folds of the unchanged ones far from any change. */
  const groups = createMemo(() => {
    const rows = props.diff.rows;
    const out: ({ row: number } | { fold: [number, number] })[] = [];
    for (let i = 0; i < rows.length;) {
      if (rows[i].t !== "same") {
        out.push({ row: i++ });
        continue;
      }
      let j = i;
      while (j < rows.length && rows[j].t === "same") j++;
      const head = i === 0 ? 0 : CONTEXT;
      const tail = j === rows.length ? 0 : CONTEXT;
      const from = i + head;
      if (j - i > head + tail + 1 && !open().has(from)) {
        for (let k = i; k < from; k++) out.push({ row: k });
        out.push({ fold: [from, j - tail] });
        for (let k = j - tail; k < j; k++) out.push({ row: k });
      } else for (let k = i; k < j; k++) out.push({ row: k });
      i = j;
    }
    return out;
  });

  const items = createMemo<Item[]>(() => {
    const g = groups();
    const rows = props.diff.rows;
    const out: Item[] = [];
    for (let i = 0; i < g.length;) {
      const x = g[i];
      if ("fold" in x) {
        out.push({ k: "fold", from: x.fold[0], to: x.fold[1] });
        i++;
      } else if (props.split) {
        out.push({ k: "row", row: x.row });
        i++;
      } else if (rows[x.row].t === "same") {
        out.push({ k: "line", row: x.row, side: "both" });
        i++;
      } else {
        // A run of changes: what it had, then what it has.
        const run: number[] = [];
        for (; i < g.length && !("fold" in g[i]) && rows[(g[i] as { row: number }).row].t !== "same"; i++) run.push((g[i] as { row: number }).row);
        for (const r of run) if (rows[r].l) out.push({ k: "line", row: r, side: "l" });
        for (const r of run) if (rows[r].r) out.push({ k: "line", row: r, side: "r" });
      }
    }
    return out;
  });

  const isChange = (it: Item | undefined) => !!it && it.k !== "fold" && props.diff.rows[it.row].t !== "same";
  /** Where each change starts, as items. */
  const starts = createMemo(() => {
    const out: number[] = [];
    items().forEach((it, i) => isChange(it) && !isChange(items()[i - 1]) && out.push(i));
    return out;
  });

  const start = createMemo(() => Math.max(0, Math.floor(top() / LINE_H) - OVERSCAN));
  const end = createMemo(() => Math.min(items().length, Math.ceil((top() + height()) / LINE_H) + OVERSCAN));
  const visible = createMemo(() => Array.from({ length: Math.max(0, end() - start()) }, (_, k) => start() + k));

  // Sides as wide as their longest line, or half the view each; line numbers as wide as the largest.
  const longest = createMemo(() => {
    let l = 0;
    let r = 0;
    let n = 1;
    for (const row of props.diff.rows) {
      if (row.l) ((l = Math.max(l, row.l.text.length)), (n = Math.max(n, row.l.n)));
      if (row.r) ((r = Math.max(r, row.r.text.length)), (n = Math.max(n, row.r.n)));
    }
    return { l, r, digits: String(n).length };
  });
  const style = () => {
    const w = longest();
    return {
      "--vw": `${width()}px`,
      "--gut": `${w.digits + 2}ch`,
      "--lw": `max(calc((var(--vw) - 2 * var(--gut)) / 2), ${w.l + 2}ch)`,
      "--rw": `max(calc((var(--vw) - 2 * var(--gut)) / 2), ${w.r + 2}ch)`,
      "--uw": `max(calc(var(--vw) - 2 * var(--gut) - 2ch), ${Math.max(w.l, w.r) + 2}ch)`,
    };
  };

  const scrollToItem = (i: number) => {
    const y = i * LINE_H;
    if (y < el.scrollTop || y > el.scrollTop + el.clientHeight - LINE_H * 2) el.scrollTop = Math.max(0, y - el.clientHeight / 3);
  };

  // Changes, one after another (n / N, the arrows): the one gone to is marked.
  const [current, setCurrent] = createSignal(-1);
  const go = (d: number) => {
    const s = starts();
    if (!s.length) return false;
    const at = current();
    // From where the view is when nothing was gone to yet: the first change below its top (or above it).
    let next = (at + d + s.length) % s.length;
    if (at < 0) next = d > 0 ? Math.max(0, s.findIndex((i) => i * LINE_H >= el.scrollTop)) : s.length - 1;
    setCurrent(next);
    scrollToItem(s[next]);
  };
  createEffect(on(starts, () => setCurrent(-1), { defer: true }));

  // Where a field starts: the nearest one around it that is there (an item removed on one side, a path not lined up).
  const [flash, setFlash] = createSignal<number>();
  createEffect(
    on(
      () => props.jump,
      (j) => {
        if (!j) return;
        let row: number | undefined;
        for (let n = j.path.length; n >= 0 && row === undefined; n--) row = props.diff.anchors.get(pathKey(j.path.slice(0, n)));
        if (row === undefined) return;
        const folded = groups().find((g) => "fold" in g && g.fold[0] <= row! && row! < g.fold[1]) as { fold: [number, number] } | undefined;
        if (folded) setOpen((prev) => new Set([...prev, folded.fold[0]]));
        const i = items().findIndex((it) => it.k !== "fold" && it.row === row);
        if (i < 0) return;
        el.scrollTop = Math.max(0, i * LINE_H - el.clientHeight / 3);
        setFlash(row);
        const t = setTimeout(() => setFlash(undefined), 1500);
        onCleanup(() => clearTimeout(t));
      },
    ),
  );

  onMount(() => {
    const ro = new ResizeObserver(() => {
      setHeight(el.offsetHeight);
      setWidth(el.offsetWidth);
    });
    ro.observe(el);
    onCleanup(() => ro.disconnect());
    onCleanup(
      bindAll([
        { combo: "n", when: detailsHaveKeyboard, run: () => go(1) },
        { combo: "shift+n", when: detailsHaveKeyboard, run: () => go(-1) },
      ]),
    );
  });

  const lineClass = (it: Item, i: number) => {
    if (it.k === "fold") return "dv-fold";
    const row = props.diff.rows[it.row];
    const marked = (it.row === flash() ? " flash" : "") + (starts()[current()] === i ? " current" : "");
    if (it.k === "row") return `dv-row ${row.t}${marked}`;
    return `dv-row u ${it.side === "l" ? "minus" : it.side === "r" ? "plus" : ""}${marked}`;
  };

  return (
    <div class="dv">
      <div class="dv-head">
        <span class="dv-side minus">
          <span class="dv-sign">−</span>
          {props.left}
        </span>
        <Show when={props.onSwap}>
          <button class="btn sm ghost icon dv-swap" onClick={() => props.onSwap!()} title="Swap the sides">
            <Icon name="compare" size={12} />
          </button>
        </Show>
        <span class="dv-side plus">
          <span class="dv-sign">+</span>
          {props.right}
        </span>
        <span class="grow" />
        <Show when={starts().length}>
          <span class="faint dv-count">
            {current() >= 0 ? `${current() + 1}/` : ""}
            {starts().length} change{starts().length === 1 ? "" : "s"}
          </span>
          <button class="btn sm ghost icon" onClick={() => go(-1)} title="Previous change (⇧N)" data-hint="shift+n" data-hint-ctx="details" data-hint-at="below">
            <Icon name="chevron-up" size={13} />
          </button>
          <button class="btn sm ghost icon" onClick={() => go(1)} title="Next change (N)" data-hint="n" data-hint-ctx="details" data-hint-at="below">
            <Icon name="chevron-down" size={13} />
          </button>
        </Show>
      </div>
      <div class="code dv-body" classList={{ unified: !props.split }} ref={el} tabIndex={0} style={style()} onScroll={() => setTop(el.scrollTop)}>
        <div style={{ height: `${items().length * LINE_H}px`, position: "relative" }}>
          <div class="lines" style={{ transform: `translateY(${start() * LINE_H}px)` }}>
            <For each={visible()}>
              {(i) => (
                <Show when={items()[i]} keyed>
                  {(x) => {
                    if (x.k === "fold")
                      return (
                        <div class="dv-fold" onClick={() => setOpen((prev) => new Set([...prev, x.from]))} title="Show these lines">
                          <Icon name="chevron-down" size={12} />
                          {`${x.to - x.from} unchanged line${x.to - x.from === 1 ? "" : "s"}`}
                        </div>
                      );
                    const row = props.diff.rows[x.row];
                    if (x.k === "row")
                      return (
                        <div class={lineClass(x, i)}>
                          <span class="dv-n">{row.l?.n ?? ""}</span>
                          <span class="dv-t l" classList={{ void: !row.l }}>
                            <HalfText half={row.l} />
                          </span>
                          <span class="dv-n">{row.r?.n ?? ""}</span>
                          <span class="dv-t r" classList={{ void: !row.r }}>
                            <HalfText half={row.r} />
                          </span>
                        </div>
                      );
                    return (
                      <div class={lineClass(x, i)}>
                        <span class="dv-n">{x.side !== "r" ? (row.l?.n ?? "") : ""}</span>
                        <span class="dv-n">{x.side !== "l" ? (row.r?.n ?? "") : ""}</span>
                        <span class="dv-sign">{x.side === "l" ? "−" : x.side === "r" ? "+" : ""}</span>
                        <span class="dv-t">
                          <HalfText half={x.side === "r" ? row.r : row.l} />
                        </span>
                      </div>
                    );
                  }}
                </Show>
              )}
            </For>
          </div>
        </div>
      </div>
    </div>
  );
}
