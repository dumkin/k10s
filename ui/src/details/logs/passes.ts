import { type Accessor, createEffect, createMemo, createSignal, on, onCleanup } from "solid-js";
import type { Line, LogBuffer } from "../logBuffer";

/**
 * When to count a view of the lines again (their levels, their patterns…) — not for every batch that comes. The buffer
 * updates a view in place as lines come (the same array) and makes another one when the filter changes or the stream
 * starts over: that one is counted at once. Lines that come make another pass at most every `every` ms, and only when
 * the view changed since it was counted (not while paused, nor for lines the filter leaves out).
 *
 * `lines()`, read where the counting is, is the view (and marks it counted); `soon(ms)` asks for another pass (there is
 * more to do); `wait()` says how long passes wait now, `release()` that they need not wait any more.
 */
export function createPasses(view: Accessor<Line[]>, buffer: () => LogBuffer, every: number, wait: () => number = () => 0) {
  // (Another array only when the view is another one.)
  const current = createMemo(() => view());
  const [pass, setPass] = createSignal(0);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let last = 0;
  let counted: Line[] | undefined;
  let revision = -1;
  const run = () => {
    timer = undefined;
    const ms = wait();
    if (ms > 0) timer = setTimeout(run, ms);
    else setPass((n) => n + 1);
  };
  const soon = (ms: number) => {
    timer ??= setTimeout(run, ms);
  };
  createEffect(
    on(view, (v) => {
      if (v === counted && buffer().revision(v) !== revision) soon(Math.max(0, last + every - performance.now()));
    }),
  );
  onCleanup(() => {
    clearTimeout(timer);
    timer = undefined;
  });
  return {
    lines: () => {
      pass();
      const v = current();
      // Another view, counted now: a pass that waited for changes to the one before is not needed.
      if (v !== counted) {
        clearTimeout(timer);
        timer = undefined;
      }
      last = performance.now();
      counted = v;
      revision = buffer().revision(v);
      return v;
    },
    soon,
    release: () => {
      if (!timer) return;
      clearTimeout(timer);
      timer = undefined;
      soon(Math.max(0, last + every - performance.now()));
    },
  };
}
