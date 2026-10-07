import { type Accessor, createMemo, createRoot, type MemoOptions } from "solid-js";

/** App-lifetime memo for module-level derived state (owned by a root that is never disposed). */
export function globalMemo<T>(fn: () => T, options?: MemoOptions<T>): Accessor<T> {
  return createRoot(() => createMemo(fn, undefined, options));
}

/**
 * `next` (a JSON value) with every part that equals `prev`'s being `prev`'s own — `prev` itself when nothing changed.
 * An object read again is a new copy even where nothing changed: with what did not change kept, what is made from it
 * (`For` rows, by reference; memos) is not made anew. An object or array is copied only once a part of it differs:
 * one that did not change costs no copy.
 */
export function keepUnchanged<T>(prev: unknown, next: T): T {
  if (prev === next || typeof prev !== "object" || typeof next !== "object" || prev === null || next === null) return next;
  if (Array.isArray(next)) return (Array.isArray(prev) ? keepItems(prev, next) : next) as T;
  return (Array.isArray(prev) ? next : keepFields(prev as Fields, next as Fields)) as T;
}

type Fields = Record<string, unknown>;

function keepItems(a: unknown[], b: unknown[]): unknown[] {
  let out: unknown[] | undefined;
  for (let i = 0; i < b.length; i++) {
    const kept = keepUnchanged(a[i], b[i]);
    if (out) out.push(kept);
    else if (i >= a.length || kept !== a[i]) {
      out = a.slice(0, i);
      out.push(kept);
    }
  }
  return out ?? (a.length === b.length ? a : a.slice(0, b.length));
}

function keepFields(a: Fields, b: Fields): Fields {
  const keys = Object.keys(b);
  let out: Fields | undefined;
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    const had = hasOwn(a, k);
    const kept = keepUnchanged(had ? a[k] : undefined, b[k]);
    if (out) put(out, k, kept);
    else if (!had || kept !== a[k]) {
      out = {};
      for (let j = 0; j < i; j++) put(out, keys[j], a[keys[j]]);
      put(out, k, kept);
    }
  }
  if (out) return out;
  // Each of `next`'s fields is `prev`'s: `prev` itself, unless it has more.
  let n = 0;
  for (const k in a) if (hasOwn(a, k)) n++;
  if (n === keys.length) return a;
  out = {};
  for (const k of keys) put(out, k, a[k]);
  return out;
}

function hasOwn(o: object, k: string): boolean {
  return Object.prototype.hasOwnProperty.call(o, k);
}

/** `o[k] = v`, as a field of its own: assigned, a `__proto__` (a ConfigMap may have that key) would set the prototype. */
function put(o: Fields, k: string, v: unknown) {
  if (k === "__proto__") Object.defineProperty(o, k, { value: v, writable: true, enumerable: true, configurable: true });
  else o[k] = v;
}
