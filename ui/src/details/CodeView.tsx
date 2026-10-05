import { createMemo, createSignal, For, type JSX, onCleanup, onMount } from "solid-js";

export const LINE_H = 18;
const OVERSCAN = 20;

/** Fixed-line-height virtualized text view (YAML, JSON…). Only on-screen lines exist in the DOM. */
export function CodeView(props: {
  count: number;
  renderLine: (i: number) => JSX.Element;
  gutter?: boolean;
  lineClass?: (i: number) => string;
  ref?: (api: { scrollToLine(i: number): void }) => void;
}) {
  let el!: HTMLDivElement;
  const [top, setTop] = createSignal(0);
  const [height, setHeight] = createSignal(600);
  const start = createMemo(() => Math.max(0, Math.floor(top() / LINE_H) - OVERSCAN));
  const end = createMemo(() => Math.min(props.count, Math.ceil((top() + height()) / LINE_H) + OVERSCAN));
  const indices = createMemo(() => Array.from({ length: Math.max(0, end() - start()) }, (_, k) => start() + k));

  onMount(() => {
    const ro = new ResizeObserver(() => setHeight(el.clientHeight));
    ro.observe(el);
    onCleanup(() => ro.disconnect());
    props.ref?.({
      scrollToLine(i) {
        const y = i * LINE_H;
        if (y < el.scrollTop || y > el.scrollTop + el.clientHeight - LINE_H * 2) el.scrollTop = Math.max(0, y - el.clientHeight / 3);
      },
    });
  });

  return (
    <div class="code" ref={el} tabIndex={0} onScroll={() => setTop(el.scrollTop)}>
      <div style={{ height: `${props.count * LINE_H}px`, position: "relative" }}>
        <div class="lines" style={{ transform: `translateY(${start() * LINE_H}px)` }}>
          {/* Keyed by line number, not by slot: a node stays with its line as it scrolls, and so does a text selection in it. */}
          <For each={indices()}>
            {(i) => (
              <div class={`ln ${props.lineClass?.(i) ?? ""}`}>
                {props.gutter !== false && <span class="gutter">{i + 1}</span>}
                <span class="txt">{props.renderLine(i)}</span>
              </div>
            )}
          </For>
        </div>
      </div>
    </div>
  );
}
