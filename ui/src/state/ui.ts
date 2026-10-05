import { createSignal } from "solid-js";
import { setAnsiTheme } from "../lib/ansi";
import { backend, errorMessage, type Settings, type SettingsChange } from "../lib/backend";
import { engineSettingsSaved, filesInfo, isNumber, oneOf, persisted, setting, settingsEdited } from "../lib/persist";

export type ThemePref = "dark" | "light" | "system";

export const [themePref, setThemePref] = setting<ThemePref>("theme", "dark", oneOf("dark", "light", "system"));

/** The page's zoom levels, as browsers step them (⌘+ / ⌘− go to the next one, ⌘0 back to 100%). */
export const ZOOM_STEPS = [0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2] as const;
/** The whole UI's zoom (readability on a large or a dense screen): the window follows it (see `initApp`). */
export const [uiZoom, setUiZoom] = setting<number>("zoom", 1, (v): v is number => (ZOOM_STEPS as readonly number[]).includes(v as number));

/** One zoom step in (`1`) or out (`-1`) from the current one. */
export function zoomBy(step: 1 | -1) {
  const at = ZOOM_STEPS.indexOf(uiZoom() as (typeof ZOOM_STEPS)[number]);
  const next = ZOOM_STEPS[Math.max(0, Math.min(ZOOM_STEPS.length - 1, (at < 0 ? ZOOM_STEPS.indexOf(1) : at) + step))];
  if (next !== uiZoom()) setUiZoom(next);
}
// Within what dragging their edges allows (see Sidebar and DetailsPanel).
export const [sidebarWidth, setSidebarWidth] = persisted("sidebarWidth", 228, (v): v is number => isNumber(v) && v >= 180 && v <= 420);
export const [detailsWidth, setDetailsWidth] = persisted("detailsWidth", 620, (v): v is number => isNumber(v) && v >= 380);
export const [paletteOpen, setPaletteOpen] = createSignal<false | { query: string }>(false);
export const [pickerOpen, setPickerOpen] = createSignal<null | "clusters" | "namespaces">(null);
/** The keyboard shortcuts sheet (`?`). */
export const [helpOpen, setHelpOpen] = createSignal(false);

/** The settings window's sections, in its order (the palette offers each). */
export const SETTINGS_SECTIONS = [
  { id: "general", title: "General", icon: "settings", keywords: ["theme", "dark", "light", "zoom", "appearance"] },
  { id: "clusters", title: "Clusters", icon: "layers", keywords: ["read-only", "safety", "cluster sets", "watches", "cache"] },
  { id: "logs", title: "Logs", icon: "logs", keywords: ["lines", "history", "timestamps", "wrap", "json", "columns"] },
  { id: "terminals", title: "Terminals", icon: "terminal", keywords: ["shell", "debug container", "node shell", "image"] },
  { id: "forwards", title: "Port-forwards", icon: "link", keywords: ["port-forward", "browser", "pinned"] },
  { id: "updates", title: "Updates", icon: "download", keywords: ["version", "release", "upgrade"] },
  { id: "files", title: "Files", icon: "braces", keywords: ["settings.json", "state.json", "logs", "folder", "reset"] },
  { id: "about", title: "About", icon: "info", keywords: ["version", "license", "github"] },
] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number]["id"];
/** The settings window (`⌘,`), open at a section; false: closed. */
export const [settingsOpen, setSettingsOpen] = createSignal<false | SettingsSection>(false);

/** Popovers open now (menus, pickers): while there is one, the keys are its own. */
const [popovers, setPopovers] = createSignal(0);
export const popoverOpen = () => popovers() > 0;
export const popoverOpened = () => setPopovers((n) => n + 1);
export const popoverClosed = () => setPopovers((n) => Math.max(0, n - 1));

/** 1-second clock driving every "age" cell; one signal for the whole app. */
export const [now, setNow] = createSignal(Math.floor(Date.now() / 1000));

export function startClock() {
  const tick = () => setNow(Math.floor(Date.now() / 1000));
  // Align ticks to wall-clock seconds so all ages flip together.
  setTimeout(() => {
    tick();
    setInterval(tick, 1000);
  }, 1000 - (Date.now() % 1000));
}

// ---------------------------------------------------------------------------------------------
// Read-only mode
// ---------------------------------------------------------------------------------------------

/**
 * The engine's settings as it has them — read-only mode among them. The engine owns them (saves them with the other
 * settings, checks read-only mode on every mutation); this is their mirror for the UI. Turning read-only mode off goes
 * through a confirmation the engine shows itself (native, out of the web view's reach).
 */
const [engineMirror, setEngineMirror] = createSignal<Settings>({ readOnly: false, feedIdleTtlSecs: 180 });
export const engineSettings = engineMirror;
export const readOnly = () => engineMirror().readOnly;

/** The engine's settings as it has them now, which its part of the settings file says too. */
export function mirrorEngineSettings(s: Settings) {
  setEngineMirror(s);
  engineSettingsSaved(s);
}

/** Reads the engine's settings. */
export async function loadSettings(): Promise<void> {
  try {
    mirrorEngineSettings(await backend().getSettings());
  } catch (e) {
    toast("error", "Could not read the settings", errorMessage(e));
  }
}

/** The engine refused a mutation as read-only: it is the source of truth, follow it. */
export function noteReadOnlyRefusal() {
  setEngineMirror((s) => ({ ...s, readOnly: true }));
}

/** Turns read-only mode on (immediately) or off (the engine asks the user first; they may keep it on). */
export async function setReadOnly(on: boolean): Promise<void> {
  try {
    const s = await backend().setReadOnly(on);
    mirrorEngineSettings(s);
    if (s.readOnly === on) toast("info", on ? "Read-only mode is on" : "Read-only mode is off", on ? "Changes (delete, scale, restart…) and shells in containers are off; reading and port-forwards work." : undefined);
  } catch (e) {
    toast("error", "Could not change read-only mode", errorMessage(e));
  }
}

/** The settings file can't be read: k10s runs on the defaults, in read-only mode, until it is fixed. */
export function reportUnreadableSettings() {
  const error = filesInfo()?.settingsError;
  if (error) toast("error", "settings.json can't be read", `${error}. Until it is fixed, k10s runs on the default settings, in read-only mode. Settings → Files opens it.`, { sticky: true });
}

/** settings.json was edited outside the app: the settings follow the file — or if it can't be read, the engine went read-only. */
export function settingsFileEdited(change: SettingsChange) {
  settingsEdited(change.settings, change.error);
  if (change.error) {
    setEngineMirror(change.engine);
    toast("error", "settings.json can't be read", `${change.error}. k10s keeps the settings it has, in read-only mode, until the file is fixed.`, { sticky: true });
  } else {
    mirrorEngineSettings(change.engine);
    toast("info", "Settings updated", "From settings.json, edited outside k10s.");
  }
}

/** Changes the engine's other settings. Read-only mode can't be turned off this way (see `setReadOnly`). */
export async function changeEngineSettings(change: Partial<Omit<Settings, "readOnly">>): Promise<void> {
  try {
    mirrorEngineSettings(await backend().setSettings({ ...engineMirror(), ...change }));
  } catch (e) {
    toast("error", "Could not change the settings", errorMessage(e));
  }
}

/** The theme put on the page last (a View Transition puts it there a moment later). */
let appliedTheme: string | undefined;

/**
 * Puts the theme on the page. A change the user asked for (`animate`) cross-fades the whole window where the web view
 * can (View Transitions); either way every colour changes at once — not each control on its own transition.
 */
export function applyTheme(pref: ThemePref, animate = false) {
  const dark = pref === "dark" || (pref === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  const theme = dark ? "dark" : "light";
  const root = document.documentElement;
  setAnsiTheme(theme);
  appliedTheme ??= root.dataset.theme;
  // The window's own colour follows (it shows before the page paints at the next start, and while it resizes).
  try {
    backend().setAppearance?.(theme);
  } catch {
    // no backend yet (or a test's stand-in): the window keeps its colour
  }
  if (appliedTheme === theme) return;
  appliedTheme = theme;
  root.classList.add("theme-switching");
  const set = () => void (root.dataset.theme = theme);
  const doc = document as Document & { startViewTransition?: (update: () => void) => unknown };
  const still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  if (animate && !still && typeof doc.startViewTransition === "function") doc.startViewTransition(set);
  else set();
  setTimeout(() => root.classList.remove("theme-switching"), 60);
}

// ---------------------------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------------------------

export interface Toast {
  id: number;
  /** `busy`: something is running (a spinner instead of an icon); it stays until that ends, see `busyToast`. */
  kind: "info" | "success" | "error" | "busy";
  title: string;
  detail?: string;
  /** Stays until dismissed (failed operations: what failed where must not vanish unread). */
  sticky?: boolean;
  /** Full report for "Copy details" (every target with its cluster and namespace). */
  copy?: string;
}

export interface ToastOptions {
  /** Milliseconds on screen (paused while hovered); ignored when `sticky`. */
  ttl?: number;
  sticky?: boolean;
  copy?: string;
}

/**
 * Toasts on screen at once: the oldest that is not sticky makes room first. A sticky one (a failure
 * report) only ever makes room for another sticky one; with nothing but those on screen, a toast that
 * goes by itself is shown on top of them (one more, briefly). One saying that something is running
 * (`busy`) neither makes room nor takes it: it goes when that ends.
 */
const MAX_TOASTS = 5;

let toastId = 0;
export const [toasts, setToasts] = createSignal<Toast[]>([]);
/** Pending auto-dismissals, and how long each toast still has (for pausing). */
const timers = new Map<number, { handle: ReturnType<typeof setTimeout>; due: number; left: number; paused?: boolean }>();

const counted = (t: Toast) => t.kind !== "busy";

export function toast(kind: Exclude<Toast["kind"], "busy">, title: string, detail?: string, opts: number | ToastOptions = {}) {
  show(kind, title, detail, opts);
}

function show(kind: Toast["kind"], title: string, detail?: string, opts: number | ToastOptions = {}): number {
  const o = typeof opts === "number" ? { ttl: opts } : opts;
  const id = ++toastId;
  setToasts((list) => {
    const next = [...list, { id, kind, title, detail, sticky: o.sticky, copy: o.copy }];
    while (next.filter(counted).length > MAX_TOASTS) {
      // Never the newcomer itself, and never a failure report for a toast that will go by itself.
      let i = next.findIndex((t, j) => counted(t) && !t.sticky && j < next.length - 1);
      if (i < 0) {
        if (!o.sticky) break;
        i = next.findIndex(counted);
      }
      const [gone] = next.splice(i, 1);
      clearTimer(gone.id);
    }
    return next;
  });
  if (!o.sticky && kind !== "busy") schedule(id, o.ttl ?? (kind === "error" ? 8000 : 3500));
  return id;
}

/**
 * Says that something is running, with a spinner, for as long as it takes: until the returned function is
 * called — when it ended, however it ended. Its result is reported on its own.
 */
export function busyToast(title: string, detail?: string): () => void {
  const id = show("busy", title, detail);
  return () => dismissToast(id);
}

function schedule(id: number, ms: number) {
  clearTimer(id);
  timers.set(id, { handle: setTimeout(() => dismissToast(id), ms), due: Date.now() + ms, left: ms });
}

function clearTimer(id: number) {
  const t = timers.get(id);
  if (t) clearTimeout(t.handle);
  timers.delete(id);
}

/** Hovered: the toast stays until the pointer leaves. */
export function pauseToast(id: number) {
  const t = timers.get(id);
  if (!t || t.paused) return;
  clearTimeout(t.handle);
  timers.set(id, { ...t, left: Math.max(0, t.due - Date.now()), paused: true });
}

/** The pointer left: the rest of its time, but long enough to move back to it. */
export function resumeToast(id: number) {
  const t = timers.get(id);
  if (t?.paused) schedule(id, Math.max(t.left, 1500));
}

export function dismissToast(id: number) {
  clearTimer(id);
  setToasts((t) => t.filter((x) => x.id !== id));
}

// ---------------------------------------------------------------------------------------------
// Confirm / prompt dialog
// ---------------------------------------------------------------------------------------------

export interface DialogRequest {
  title: string;
  body?: string;
  /** Items listed in the dialog (e.g. objects to delete). */
  items?: { label: string; meta?: string; color?: string }[];
  confirmLabel: string;
  /** Destructive (delete, scale to 0…): red confirm button and an alert icon. */
  danger?: boolean;
  /** Show a text input (prompt) with this initial value. */
  input?: { value: string; placeholder?: string; type?: "text" | "number" };
  /** Why the input is invalid, or null if it is fine. Confirming is blocked while invalid; "" blocks without a message. */
  validate?: (value: string) => string | null;
  /** Optional checkbox (e.g. "force"). */
  checkbox?: { label: string; value: boolean };
  /**
   * Labelled text fields (an image, a namespace). Confirming is blocked while one that is not `optional` is empty, or
   * while `validate` finds something wrong with one (its message is shown).
   */
  fields?: { label: string; value: string; placeholder?: string; optional?: boolean; validate?: (value: string) => string | null }[];
  /** One of several options (a container), as a list of radio buttons. */
  choice?: { label?: string; options: { value: string; label: string; meta?: string }[]; value: string };
  /**
   * Typed confirmation: confirming stays blocked until exactly this is typed (the object's name, "delete 12").
   * A function decides from the checkbox, so ticking "Force" can require it; undefined: a click is enough.
   */
  confirmText?: string | ((checkbox: boolean) => string | undefined);
  /** Where the targets are: objects per cluster, shown above the list. */
  breakdown?: { label: string; count: number; color?: string }[];
  resolve: (result: DialogResult | null) => void;
}

export interface DialogResult {
  input?: string;
  checkbox?: boolean;
  /** What the `fields` hold, in order. */
  fields?: string[];
  choice?: string;
}

export const [dialog, setDialog] = createSignal<DialogRequest | null>(null);

export function ask(req: Omit<DialogRequest, "resolve">): Promise<DialogResult | null> {
  // A new request replaces an open one, which counts as cancelled.
  dialog()?.resolve(null);
  return new Promise((resolve) => setDialog({ ...req, resolve }));
}
