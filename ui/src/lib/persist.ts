import { createSignal, type Signal } from "solid-js";
import type { PrefsChange, PrefsDoc, PrefsSnapshot } from "./backend/types";

// What the UI keeps between starts. In the desktop app that is two files the engine keeps
// (crates/k10s-app/src/prefs.rs): `settings` — what the user sets, in a file made to be read and edited by hand — and
// `state` — what k10s remembers by itself. A key is a path in its file: `logs.tail` is `{ "logs": { "tail": … } }`.
// Where there are no files (unit tests) values go to localStorage, one entry per key.

/**
 * Whether a stored value has the shape its key needs. Stored data is not trusted: a hand edit, another
 * version or a half-written value falls back to the default instead of breaking the app as it starts.
 */
export type Check<T> = (value: unknown) => value is T;

export const isString = (v: unknown): v is string => typeof v === "string";
export const isBoolean = (v: unknown): v is boolean => typeof v === "boolean";
/** A finite number (`1e999` parses to Infinity). */
export const isNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
export const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
export const arrayOf = <T>(item: Check<T>) => (v: unknown): v is T[] => Array.isArray(v) && v.every(item);
export const recordOf = <T>(value: Check<T>) => (v: unknown): v is Record<string, T> => isObject(v) && Object.values(v).every(value);
export const oneOf = <T extends string>(...values: T[]) => (v: unknown): v is T => (values as unknown[]).includes(v);

/** The value at `key` (`logs.tail`) in a file's JSON; undefined where there is none. */
export function getAt(doc: Record<string, unknown>, key: string): unknown {
  let at: unknown = doc;
  for (const part of key.split(".")) {
    if (!isObject(at) || !Object.hasOwn(at, part)) return undefined;
    at = at[part];
  }
  return at;
}

/** Puts `value` at `key` in a file's JSON; null or undefined removes it, and the objects that were only there for it. */
export function setAt(doc: Record<string, unknown>, key: string, value: unknown) {
  const [part, ...rest] = key.split(".");
  if (!rest.length) {
    if (value == null) delete doc[part];
    else doc[part] = value;
    return;
  }
  if (value == null) {
    const inner = doc[part];
    if (!isObject(inner)) return;
    setAt(inner, rest.join("."), value);
    if (!Object.keys(inner).length) delete doc[part];
    return;
  }
  if (!isObject(doc[part])) doc[part] = {};
  setAt(doc[part] as Record<string, unknown>, rest.join("."), value);
}

interface Store {
  read(doc: PrefsDoc, key: string): unknown;
  write(doc: PrefsDoc, key: string, value: unknown): void;
}

const PREFIX = "k10s:";

const webStorage: Store = {
  read(_, key) {
    const raw = localStorage.getItem(PREFIX + key);
    return raw == null ? undefined : JSON.parse(raw);
  },
  write: (_, key, value) => localStorage.setItem(PREFIX + key, JSON.stringify(value)),
};

/** The app's files, as read at start and changed since; what changes is sent on. */
let files: { settings: Record<string, unknown>; state: Record<string, unknown> } | null = null;
let store: Store = webStorage;
let forget: () => Promise<void> = async () => {
  for (const key of Object.keys(localStorage)) if (key.startsWith(PREFIX)) localStorage.removeItem(key);
};

export interface FilesInfo {
  settingsPath: string | null;
  statePath: string | null;
  /** Why `settings.json` can't be read: the app runs on the defaults, in read-only mode, until it is fixed. */
  settingsError: string | null;
}

const [info, setInfo] = createSignal<FilesInfo | null>(null);
/** Where the files are, and whether the settings one can be read; null where there are no files. */
export const filesInfo = info;
/** Bumped when the settings file changes, by the app or outside it. */
const [settingsRevision, bumpSettings] = createSignal(0, { equals: false });

/**
 * At most this often a batch of changes goes to the app. A dragged panel edge changes its width on every frame: only
 * the latest of each value goes, in the next batch.
 */
export const SEND_EVERY_MS = 50;

/** Changes not sent yet, the latest by file and key. */
let unsent = new Map<string, PrefsChange>();
let sending = false;
let sendBatch: (changes: PrefsChange[]) => Promise<void> = async () => {};

/**
 * Sends what changed: one batch at a time, so that the app takes them in the order they were made (its commands may
 * run side by side).
 */
async function pump() {
  while (unsent.size) {
    const batch = [...unsent.values()];
    unsent = new Map();
    const started = performance.now();
    try {
      await sendBatch(batch);
    } catch (e) {
      console.error("[k10s] could not keep the settings:", e);
    }
    const wait = SEND_EVERY_MS - (performance.now() - started);
    if (unsent.size && wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  }
  sending = false;
}

/**
 * Keeps values in the app's files from now on (`send` passes changes on, `reset` forgets them). Called before the
 * modules that read values as they load (see main.tsx).
 */
export function useFiles(snapshot: PrefsSnapshot, send: (changes: PrefsChange[]) => Promise<void>, reset: () => Promise<void>) {
  files = { settings: snapshot.settings, state: snapshot.state };
  const docs = files;
  sendBatch = send;
  store = {
    read: (doc, key) => getAt(docs[doc], key),
    write(doc, key, value) {
      setAt(docs[doc], key, value);
      unsent.set(`${doc}:${key}`, { doc, key, value: value ?? null });
      if (sending) return;
      // What else changes in the same task goes along.
      sending = true;
      queueMicrotask(() => void pump());
    },
  };
  forget = async () => {
    unsent.clear();
    await reset();
  };
  setInfo({ settingsPath: snapshot.settingsPath, statePath: snapshot.statePath, settingsError: snapshot.settingsError });
}

/** The settings file as it is now (what the settings window shows); null where there are no files. */
export function settingsFile(): Record<string, unknown> | null {
  settingsRevision();
  return files ? (JSON.parse(JSON.stringify(files.settings)) as Record<string, unknown>) : null;
}

export function load<T>(key: string, fallback: T, valid: Check<T>, doc: PrefsDoc = "state"): T {
  try {
    const value = store.read(doc, key);
    return value !== undefined && valid(value) ? value : fallback;
  } catch {
    return fallback;
  }
}

export function save(key: string, value: unknown, doc: PrefsDoc = "state") {
  try {
    store.write(doc, key, value);
    if (doc === "settings") bumpSettings(0);
  } catch {
    // storage full or unavailable: preferences are best-effort
  }
}

/** The settings signals, by key: they follow an edit of the file made outside the app. */
const followers = new Map<string, (value: unknown) => void>();

function kept<T>(doc: PrefsDoc, key: string, fallback: T, valid: Check<T>): Signal<T> {
  const [get, set] = createSignal<T>(load(key, fallback, valid, doc));
  const setAndSave = ((v: T | ((prev: T) => T)) => {
    const prev = get();
    const next = set(v as never);
    // A drag sets the same width again and again: nothing new to keep.
    if (!Object.is(next, prev)) save(key, next, doc);
    return next;
  }) as Signal<T>[1];
  if (doc === "settings") followers.set(key, (value) => set(() => (value !== undefined && valid(value) ? value : fallback)));
  return [get, setAndSave];
}

/** A value k10s remembers by itself (`state.json`): restored at start, written through. A stored value `valid` rejects is ignored. */
export function persisted<T>(key: string, fallback: T, valid: Check<T>): Signal<T> {
  return kept("state", key, fallback, valid);
}

/**
 * A setting (`settings.json`): restored at start, written through, and following the file when it is edited outside
 * the app. A stored value `valid` rejects is ignored.
 */
export function setting<T>(key: string, fallback: T, valid: Check<T>): Signal<T> {
  return kept("settings", key, fallback, valid);
}

/** Puts a setting back to its default: it leaves the file. */
export function resetSetting(key: string) {
  followers.get(key)?.(undefined);
  save(key, null, "settings");
}

/** The settings file after an edit made outside the app: every setting follows it; nothing is written back. */
export function settingsEdited(settings: Record<string, unknown>, error: string | null) {
  setInfo((i) => i && { ...i, settingsError: error });
  // A file that can't be read leaves the settings as they are.
  if (!files || error) return;
  files.settings = settings;
  for (const [key, follow] of followers) follow(getAt(settings, key));
  bumpSettings(0);
}

/** The engine's settings as it has them now: they are in the settings file too (the engine writes them itself). */
export function engineSettingsSaved(settings: object) {
  if (!files) return;
  for (const [key, value] of Object.entries(settings)) setAt(files.settings, key, value);
  bumpSettings(0);
}

/** Forgets every saved preference (the engine's settings stay): the way out when one breaks the app. */
export function clearPreferences(): Promise<void> {
  return forget();
}
