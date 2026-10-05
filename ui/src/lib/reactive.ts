import { type Accessor, createMemo, createRoot, type MemoOptions } from "solid-js";

/** App-lifetime memo for module-level derived state (owned by a root that is never disposed). */
export function globalMemo<T>(fn: () => T, options?: MemoOptions<T>): Accessor<T> {
  return createRoot(() => createMemo(fn, undefined, options));
}
