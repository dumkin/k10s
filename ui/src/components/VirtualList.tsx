import { type Accessor, createMemo, createSignal, Index, type JSX, onCleanup, onMount } from "solid-js";

export interface VirtualListHandle {
  /** Scrolls just enough to show row `i`. */
  reveal(i: number): void;
}

const OVERSCAN = 8;
/** Vertical padding inside the scroll area (matches `.pop-list`). */
const PAD = 4;

/**
 * Fixed-row-height virtualized list for pickers: only the visible rows (plus a few) exist in the DOM
 * and their nodes are reused while scrolling, so a list of 50 000 namespaces opens and updates as
 * fast as a list of 50. Rows get their item and absolute index as accessors (nodes are reused).
 */
export function VirtualList<T>(props: {
  items: readonly T[];
  rowHeight: number;
  class?: string;
  ref?: (el: HTMLDivElement, handle: VirtualListHandle) => void;
  children: (item: Accessor<T>, index: Accessor<number>) => JSX.Element;
}) {
  let el!: HTMLDivElement;
  const [scrollTop, setScrollTop] = createSignal(0);
  const [height, setHeight] = createSignal(560);
  const start = createMemo(() => Math.max(0, Math.floor((scrollTop() - PAD) / props.rowHeight) - OVERSCAN));
  const end = createMemo(() => Math.min(props.items.length, Math.ceil((scrollTop() + height()) / props.rowHeight) + OVERSCAN));
  const visible = createMemo(() => props.items.slice(start(), end()));

  const handle: VirtualListHandle = {
    reveal(i) {
      const top = PAD + i * props.rowHeight;
      if (top - PAD < el.scrollTop) el.scrollTop = top - PAD;
      else if (top + props.rowHeight + PAD > el.scrollTop + el.clientHeight) el.scrollTop = top + props.rowHeight + PAD - el.clientHeight;
      setScrollTop(el.scrollTop);
    },
  };

  onMount(() => {
    const ro = new ResizeObserver(() => setHeight(el.clientHeight));
    ro.observe(el);
    onCleanup(() => ro.disconnect());
    props.ref?.(el, handle);
  });

  return (
    <div class={`vlist ${props.class ?? ""}`} ref={el} onScroll={() => setScrollTop(el.scrollTop)}>
      <div style={{ height: `${props.items.length * props.rowHeight + 2 * PAD}px`, position: "relative" }}>
        <div style={{ transform: `translateY(${PAD + start() * props.rowHeight}px)` }}>
          <Index each={visible()}>{(item, i) => props.children(item, () => start() + i)}</Index>
        </div>
      </div>
    </div>
  );
}
