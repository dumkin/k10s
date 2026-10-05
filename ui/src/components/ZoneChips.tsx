import { createEffect, createSignal, For, on, onCleanup, onMount, Show } from "solid-js";

/**
 * Chips on one line next to a name: as many as fit whole, then "+N" (the tooltip lists them all). A chip is
 * never cut mid-way, and the name keeps its room — the chips get what is left of the row (see `.zone-chips`).
 */
export function ZoneChips(props: { zones: string[]; title?: string }) {
  let line!: HTMLSpanElement;
  const [shown, setShown] = createSignal(props.zones.length);
  // In the next frame: showing "+N" resizes the line being observed, which inside the observer's own callback
  // is a "ResizeObserver loop" error.
  let frame = 0;
  const measure = () => {
    frame ||= requestAnimationFrame(() => {
      frame = 0;
      setShown(fitOnFirstLine(line));
    });
  };
  onMount(() => {
    // Also when "+N" appears or goes: that changes the room left for the chips.
    const ro = new ResizeObserver(measure);
    ro.observe(line);
    onCleanup(() => {
      ro.disconnect();
      cancelAnimationFrame(frame);
    });
  });
  createEffect(on(() => props.zones.join(" "), measure, { defer: true }));
  const more = () => props.zones.length - shown();

  return (
    <span class="zone-chips" title={props.title ?? props.zones.join(" ")}>
      <span class="zc-line" ref={line}>
        <For each={props.zones}>
          {(z, i) => (
            <span class="chip" style={{ visibility: i() < shown() ? undefined : "hidden" }}>
              {z}
            </span>
          )}
        </For>
      </span>
      <Show when={more() > 0}>
        <span class="chip zc-more">+{more()}</span>
      </Show>
    </span>
  );
}

/**
 * How many children of `line` fit whole on its first line. The line wraps and clips what wrapped; a first
 * child wider than the line stays on it (a flex line always takes one item), cut — it does not fit either.
 */
export function fitOnFirstLine(line: HTMLElement): number {
  const kids = [...line.children] as HTMLElement[];
  if (!kids.length) return 0;
  const top = kids[0].offsetTop;
  const width = line.clientWidth;
  let n = 0;
  for (const k of kids) {
    if (k.offsetTop !== top || k.offsetLeft + k.offsetWidth > width) break;
    n++;
  }
  return n;
}
