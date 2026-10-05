import { createSignal } from "solid-js";
import { backend, errorMessage, type UpdateInfo } from "../lib/backend";
import { comboLabel } from "../lib/hotkeys";
import { isBoolean, isNumber, isObject, isString, load, save, setting } from "../lib/persist";
import { type Command, registerCommands } from "./commands";
import { ask, busyToast, toast } from "./ui";

/** Whether k10s looks for a new release by itself (on start and every six hours). Checking by hand works either way. */
export const [autoUpdate, setAutoUpdate] = setting<boolean>("autoUpdate", true, isBoolean);

/** A newer release than the one running: found, then downloaded and verified (`ready`). */
const [found, setFound] = createSignal<UpdateInfo | null>(null);
export const update = found;

/** This build updates itself (only builds made by the release workflow do). */
const [enabled, setEnabled] = createSignal(false);
export const updatesEnabled = enabled;
let current = "";

/** After start, once the clusters had their turn; then again every six hours. */
const FIRST_CHECK_MS = 15_000;
const CHECK_EVERY_MS = 6 * 60 * 60_000;

/**
 * The last automatic check, if it found nothing newer than `version`: for CHECK_EVERY_MS after it, that version
 * doesn't ask by itself, not even at start. A release found is forgotten with the app, so finding one drops this and
 * every start asks again; a check by hand that finds nothing leaves it as it is.
 */
interface UpToDate {
  at: number;
  version: string;
}
export const UP_TO_DATE_KEY = "upToDate";
const isUpToDate = (v: unknown): v is UpToDate => isObject(v) && isNumber(v.at) && isString(v.version);

/** How long until the next automatic check: 0 when it is due. */
function untilDue(): number {
  const last = load<UpToDate | null>(UP_TO_DATE_KEY, null, isUpToDate);
  if (!last || last.version !== current) return 0;
  // A check ahead of the clock (it was set back) proves nothing.
  const age = Date.now() - last.at;
  return age >= 0 && age < CHECK_EVERY_MS ? CHECK_EVERY_MS - age : 0;
}

const [checking, setChecking] = createSignal(false);
/** A check is under way (by hand or by itself). */
export const checkingForUpdates = checking;
/** When a check last got an answer: in this session, or the last automatic one before it. */
const [checked, setChecked] = createSignal<number | null>(null);
export const lastChecked = checked;
/** The version the user was told about (once per version). */
let announced: string | null = null;

/**
 * Looks for a newer release and downloads it, so that installing it takes only a restart. A check the user asked for
 * (`manual`) says how it went; an automatic one only logs a failure (offline is no news).
 */
export async function checkForUpdates(manual = false): Promise<void> {
  if (checking()) {
    if (manual) toast("info", "Already checking for updates");
    return;
  }
  setChecking(true);
  const started = Date.now();
  const done = manual ? busyToast("Checking for updates…") : () => {};
  try {
    let next = await backend().checkUpdate();
    setFound(next);
    setChecked(started);
    if (next) save(UP_TO_DATE_KEY, null);
    else if (!manual) save(UP_TO_DATE_KEY, { at: started, version: current } satisfies UpToDate);
    if (!next) {
      if (manual) toast("success", "k10s is up to date", `You have the latest version, ${current}.`);
      return;
    }
    if (!next.ready) {
      next = await backend().downloadUpdate();
      setFound(next);
    }
    if (manual || announced !== next.version) {
      announced = next.version;
      toast("info", `k10s ${next.version} is ready`, `Restart to update: click it in the status bar, or ${comboLabel("mod+k")} → Restart to update.`, { ttl: 10_000 });
    }
  } catch (e) {
    if (manual) toast("error", "Could not check for updates", errorMessage(e));
    else backend().log("warn", `update check failed: ${errorMessage(e)}`);
  } finally {
    setChecking(false);
    done();
  }
}

/** Turns the automatic checks on or off; turned on, it checks now if a check is due. */
export function setAutomaticChecks(on: boolean) {
  setAutoUpdate(on);
  if (on && !untilDue()) void checkForUpdates();
}

/** Asks first: the restart closes terminals and port-forwards. */
export async function restartToUpdate(): Promise<void> {
  const next = found();
  if (!next?.ready) return;
  const ok = await ask({
    title: `Restart to update to k10s ${next.version}?`,
    body: "k10s closes its terminals and port-forwards, installs the update and opens again. Your clusters, views and settings stay as they are.",
    confirmLabel: "Restart and update",
  });
  if (!ok) return;
  const done = busyToast(`Installing k10s ${next.version}…`);
  try {
    await backend().installUpdate();
  } catch (e) {
    toast("error", "Could not install the update", errorMessage(e), { sticky: true });
  } finally {
    done();
  }
}

function openNotes() {
  backend()
    .openUpdateNotes()
    .catch((e) => toast("error", "Could not open the release notes", errorMessage(e)));
}

function updateCommands(): Command[] {
  if (!enabled()) return [];
  const next = found();
  const out: Command[] = [
    {
      id: "app:update-check",
      title: "Check for updates",
      section: "App",
      icon: "download",
      keywords: ["update", "upgrade", "new version", "release"],
      hint: current,
      run: () => checkForUpdates(true),
    },
    {
      id: "app:update-auto",
      title: autoUpdate() ? "Turn off automatic update checks" : "Turn on automatic update checks",
      section: "App",
      icon: "refresh",
      keywords: ["update", "upgrade", "privacy", "network"],
      hint: autoUpdate() ? "on" : "off",
      run: () => {
        const on = !autoUpdate();
        setAutomaticChecks(on);
        toast("info", on ? "Automatic update checks are on" : "Automatic update checks are off", on ? undefined : `${comboLabel("mod+k")} → Check for updates still works.`);
      },
    },
  ];
  if (next?.ready) out.unshift({ id: "app:update-restart", title: `Restart to update to ${next.version}`, section: "App", icon: "restart", keywords: ["update", "upgrade", "install"], priority: 5, run: restartToUpdate });
  if (next?.page) out.push({ id: "app:update-notes", title: `What's new in k10s ${next.version}`, section: "App", icon: "external", keywords: ["release notes", "changelog", "update"], run: openNotes });
  return out;
}

/** Starts the automatic checks (when this build can update) and the palette's update commands. */
export function startUpdates(): () => void {
  const unregister = registerCommands(updateCommands);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const tick = () => {
    if (stopped) return;
    const wait = untilDue();
    if (!wait && autoUpdate()) void checkForUpdates();
    timer = setTimeout(tick, wait || CHECK_EVERY_MS);
  };
  void backend()
    .appInfo()
    .then((info) => {
      current = info.version;
      const last = load<UpToDate | null>(UP_TO_DATE_KEY, null, isUpToDate);
      if (last?.version === current) setChecked(last.at);
      setEnabled(!!info.updates);
      if (info.updates && !stopped) timer = setTimeout(tick, FIRST_CHECK_MS);
    })
    .catch(() => {});
  return () => {
    stopped = true;
    clearTimeout(timer);
    unregister();
  };
}
