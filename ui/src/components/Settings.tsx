import { createEffect, createResource, createSignal, For, type JSX, Match, on, onCleanup, onMount, Show, Switch } from "solid-js";
import { Portal } from "solid-js/web";
import mark from "../assets/brand/k10s-crab.svg";
import { FOLD_AT, FOLD_SHOW, fold, pinned, pretty, SINCES, setFold, setPinned, setPretty, setShowTs, setSince, setTail, setUtc, setWrap, showTs, since, TAILS, tail, utc, wrap } from "../details/logs/model";
import { backend, errorMessage, type PrefsDoc } from "../lib/backend";
import { age, clock, count, plural } from "../lib/format";
import { bind, isMac } from "../lib/hotkeys";
import { holdInert, restoreFocus } from "../lib/inert";
import { isValidNamespace } from "../lib/k8s";
import { clearPreferences, filesInfo, resetSetting, settingsFile } from "../lib/persist";
import { deleteClusterSet, savedSets, shortName } from "../state/clusters";
import { DEFAULT_NODE_SHELL_NAMESPACE, DEFAULT_SHELL_IMAGE, debugImage, nodeShellImage, nodeShellNamespace, setDebugImage, setNodeShellImage, setNodeShellNamespace } from "../state/dock";
import { forwardTarget, openInBrowser, pins, setOpenInBrowser, togglePin } from "../state/forwards";
import { ask, changeEngineSettings, dialog, engineSettings, now, readOnly, SETTINGS_SECTIONS, type SettingsSection, setHelpOpen, setReadOnly, setSettingsOpen, setThemePref, settingsOpen, setUiZoom, themePref, toast, uiZoom, ZOOM_STEPS, zoomBy } from "../state/ui";
import { autoUpdate, checkForUpdates, checkingForUpdates, lastChecked, restartToUpdate, setAutomaticChecks, update, updatesEnabled } from "../state/updates";
import { Icon, type IconName } from "./Icon";
import { Kbd } from "./Kbd";
import { Keys } from "./ShortcutsHelp";

// The settings window (⌘,): a section at a time, picked on the left. Every change is in effect at once and saved to
// settings.json — the Files section shows it — which can be edited by hand as well.

const BLURBS: Record<SettingsSection, string> = {
  general: "How k10s looks.",
  clusters: "What k10s may change on your clusters, and how it keeps up with them.",
  logs: "How a log opens and shows its lines. The log viewer's toolbar changes the same settings.",
  terminals: "What debug containers and node shells run.",
  forwards: "How port-forwards start, and the ones kept for later.",
  updates: "New versions of k10s, from its releases on GitHub.",
  files: "Where k10s keeps your settings, what it remembers, and its log.",
  about: "The app, its source code and its license.",
};

const isWindows = typeof navigator !== "undefined" && /Win/.test(navigator.platform || navigator.userAgent);
/** What the desktop calls showing a file in its folder. */
const REVEAL = isMac ? "Show in Finder" : isWindows ? "Show in Explorer" : "Show in folder";

export function Settings() {
  return (
    <Show when={settingsOpen()}>
      <Sheet />
    </Show>
  );
}

function Sheet() {
  const close = () => setSettingsOpen(false);
  /** The keyboard has been used here: the focus shows (opened with the mouse, the selected section is enough). */
  const [keys, setKeys] = createSignal(false);
  const active = (): SettingsSection => settingsOpen() || "general";
  const section = () => SETTINGS_SECTIONS.find((s) => s.id === active()) ?? SETTINGS_SECTIONS[0];
  let tabs!: HTMLDivElement;
  let body!: HTMLDivElement;
  const focusTab = (id: SettingsSection) => tabs.querySelector<HTMLElement>(`[data-section="${id}"]`)?.focus({ preventScroll: true });

  onMount(() => {
    // A dialog asked from here (Reset…) takes Esc first.
    onCleanup(bind({ combo: "escape", inInputs: true, priority: 200, when: () => !dialog(), run: () => void close() }));
    onCleanup(holdInert());
    onCleanup(restoreFocus());
    focusTab(active());
  });
  // A section starts at its top.
  createEffect(on(active, () => (body.scrollTop = 0), { defer: true }));

  /** ↑ ↓ Home End move through the sections, as in a list. */
  const onTabsKey = (e: KeyboardEvent) => {
    const at = SETTINGS_SECTIONS.findIndex((s) => s.id === active());
    const to = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: SETTINGS_SECTIONS.length - 1 }[e.key];
    if (to === undefined) return;
    e.preventDefault();
    const next = SETTINGS_SECTIONS[Math.max(0, Math.min(SETTINGS_SECTIONS.length - 1, to))].id;
    setSettingsOpen(next);
    focusTab(next);
  };

  return (
    <Portal>
      <div class="overlay dim" onMouseDown={close} />
      <div class="settings-sheet" classList={{ keys: keys() }} role="dialog" aria-modal="true" aria-label="Settings" onKeyDown={() => setKeys(true)} onPointerDown={() => setKeys(false)}>
        <nav class="ss-nav">
          <h2 class="ss-title">Settings</h2>
          <div class="ss-tabs" ref={tabs} role="tablist" aria-orientation="vertical" aria-label="Sections" data-own-arrows onKeyDown={onTabsKey}>
            <For each={SETTINGS_SECTIONS}>
              {(s) => (
                <button
                  type="button"
                  role="tab"
                  id={`ss-tab-${s.id}`}
                  data-section={s.id}
                  class="ss-tab"
                  classList={{ on: active() === s.id }}
                  aria-selected={active() === s.id}
                  aria-controls="ss-panel"
                  tabIndex={active() === s.id ? 0 : -1}
                  onClick={() => setSettingsOpen(s.id)}
                >
                  <Icon name={s.icon} size={15} />
                  <span class="grow">{s.title}</span>
                  <Show when={(s.id === "updates" && update()?.ready) || (s.id === "files" && filesInfo()?.settingsError)}>
                    <span class="ss-dot" classList={{ err: s.id === "files" }} />
                  </Show>
                </button>
              )}
            </For>
          </div>
          <p class="ss-nav-foot">Changes take effect at once and are saved to settings.json.</p>
        </nav>
        <section class="ss-main" id="ss-panel" role="tabpanel" aria-labelledby={`ss-tab-${active()}`}>
          <header class="ss-head">
            <h3>{section().title}</h3>
            <p>{BLURBS[active()]}</p>
          </header>
          <div class="ss-body" ref={body}>
            <Switch>
              <Match when={active() === "general"}>
                <General />
              </Match>
              <Match when={active() === "clusters"}>
                <Clusters />
              </Match>
              <Match when={active() === "logs"}>
                <Logs />
              </Match>
              <Match when={active() === "terminals"}>
                <Terminals />
              </Match>
              <Match when={active() === "forwards"}>
                <Forwards />
              </Match>
              <Match when={active() === "updates"}>
                <Updates />
              </Match>
              <Match when={active() === "files"}>
                <Files />
              </Match>
              <Match when={active() === "about"}>
                <About />
              </Match>
            </Switch>
          </div>
          {/* Last in the tab order (after the section's settings), at the top right where it is looked for. */}
          <button class="btn ghost icon ss-close" title="Close (Esc)" aria-label="Close" onClick={close}>
            <Icon name="x" size={15} />
          </button>
        </section>
      </div>
    </Portal>
  );
}

// ---------------------------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------------------------

let ids = 0;

/** Settings that belong together, on a card of their own. */
function Group(props: { title?: string; foot?: JSX.Element; children: JSX.Element }) {
  return (
    <section class="ss-group">
      <Show when={props.title}>
        <h4>{props.title}</h4>
      </Show>
      <div class="ss-card">{props.children}</div>
      <Show when={props.foot}>
        <p class="ss-foot">{props.foot}</p>
      </Show>
    </section>
  );
}

/**
 * A setting: what it is and does on the left, its control on the right — under them in a narrow window, when the
 * control is `wide`. `control` gets the id of its label.
 */
function Row(props: { label: JSX.Element; hint?: JSX.Element; mono?: boolean; wide?: boolean; control?: (labelId: string, hintId?: string) => JSX.Element; children?: JSX.Element }) {
  const id = `ss-label-${++ids}`;
  const hintId = () => (props.hint ? `${id}-hint` : undefined);
  return (
    <div class="ss-row" classList={{ wide: props.wide }}>
      <div class="ss-text">
        <div class="ss-label" classList={{ mono: props.mono }} id={id}>
          {props.label}
        </div>
        <Show when={props.hint}>
          <div class="ss-hint" id={hintId()}>
            {props.hint}
          </div>
        </Show>
      </div>
      <div class="ss-control">{props.control ? props.control(id, hintId()) : props.children}</div>
    </div>
  );
}

/** An on/off switch. */
function Toggle(props: { on: boolean; set: (on: boolean) => void; labelledBy: string; describedBy?: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      class="ss-switch"
      classList={{ on: props.on }}
      aria-checked={props.on}
      aria-labelledby={props.labelledBy}
      aria-describedby={props.describedBy}
      disabled={props.disabled}
      onClick={() => props.set(!props.on)}
    >
      <span class="ss-knob" />
    </button>
  );
}

/** One of a few options, side by side; ← → move between them. */
function Choice<T extends string>(props: { value: T; options: readonly { value: T; label: string; icon?: IconName }[]; set: (v: T) => void; labelledBy: string; describedBy?: string }) {
  let group!: HTMLDivElement;
  const onKey = (e: KeyboardEvent) => {
    const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const at = props.options.findIndex((o) => o.value === props.value);
    const next = props.options[Math.max(0, Math.min(props.options.length - 1, at + step))];
    props.set(next.value);
    group.querySelector<HTMLElement>(`[data-value="${next.value}"]`)?.focus();
  };
  return (
    <div class="seg ss-seg" ref={group} role="radiogroup" aria-labelledby={props.labelledBy} aria-describedby={props.describedBy} data-own-arrows onKeyDown={onKey}>
      <For each={props.options}>
        {(o) => (
          <button type="button" role="radio" data-value={o.value} classList={{ on: props.value === o.value }} aria-checked={props.value === o.value} tabIndex={props.value === o.value ? 0 : -1} onClick={() => props.set(o.value)}>
            <Show when={o.icon}>{(icon) => <Icon name={icon()} size={13} />}</Show>
            {o.label}
          </button>
        )}
      </For>
    </div>
  );
}

/**
 * A text setting, saved as typed; emptied, it is the default again (shown as the placeholder). What `invalid` objects
 * to is not saved. The field keeps what is typed in it; the setting shows there again — after an edit of the file, say —
 * once it isn't being typed in.
 */
function TextSetting(props: { value: string; fallback: string; set: (v: string) => void; reset: () => void; labelledBy: string; describedBy?: string; invalid?: (v: string) => string | null }) {
  const shown = () => (props.value === props.fallback ? "" : props.value);
  const [text, setText] = createSignal(shown());
  const [problem, setProblem] = createSignal<string | null>(null);
  let input!: HTMLInputElement;
  createEffect(
    on(
      shown,
      (v) => {
        // Being typed in: what is typed stays (typed out in full, the default would otherwise vanish from under the caret).
        if (document.activeElement === input) return;
        setText(v);
        setProblem(null);
      },
      { defer: true },
    ),
  );
  return (
    <div class="ss-field">
      <input
        ref={input}
        class="input mono"
        classList={{ bad: !!problem() }}
        value={text()}
        placeholder={props.fallback}
        aria-labelledby={props.labelledBy}
        aria-describedby={props.describedBy}
        aria-invalid={!!problem()}
        spellcheck={false}
        autocomplete="off"
        onInput={(e) => {
          setText(e.currentTarget.value);
          const v = e.currentTarget.value.trim();
          const why = v ? (props.invalid?.(v) ?? null) : null;
          setProblem(why);
          if (why) return;
          if (v) props.set(v);
          else props.reset();
        }}
      />
      <Show when={problem()}>
        <div class="ss-problem">{problem()}</div>
      </Show>
    </div>
  );
}

/** A list of things kept (cluster sets, pinned forwards), each with a button that drops it. */
function Item(props: { label: string; hint?: string; mono?: boolean; drop: () => void; dropLabel: string; dropIcon?: IconName }) {
  return (
    <div class="ss-row ss-item">
      <div class="ss-text">
        <div class="ss-label" classList={{ mono: props.mono }}>
          {props.label}
        </div>
        <Show when={props.hint}>
          <div class="ss-hint ellipsis">{props.hint}</div>
        </Show>
      </div>
      <button class="btn ghost icon" classList={{ on: props.dropIcon === "pin" }} title={props.dropLabel} aria-label={`${props.dropLabel}: ${props.label}`} onClick={() => props.drop()}>
        <Icon name={props.dropIcon ?? "trash"} size={14} />
      </button>
    </div>
  );
}

const Empty = (props: { children: JSX.Element }) => <div class="ss-empty">{props.children}</div>;

const failed = (what: string) => (e: unknown) => toast("error", what, errorMessage(e));

// ---------------------------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------------------------

const THEMES = [
  { value: "dark", label: "Dark", icon: "moon" },
  { value: "light", label: "Light", icon: "sun" },
  { value: "system", label: "System", icon: "contrast" },
] as const;

function General() {
  return (
    <>
      <Group title="Appearance">
        <Row label="Theme" wide hint="System follows the light or dark appearance of this computer." control={(id, hint) => <Choice value={themePref()} options={THEMES} set={setThemePref} labelledBy={id} describedBy={hint} />} />
        <Row
          label="Zoom"
          wide
          hint={
            <>
              Everything gets bigger or smaller. Anywhere: <Keys keys="mod+= mod+- mod+0" />
            </>
          }
          control={(id, hint) => (
            <div class="ss-stepper" role="group" aria-labelledby={id} aria-describedby={hint}>
              <button class="btn icon" title="Zoom out" aria-label="Zoom out" disabled={uiZoom() <= ZOOM_STEPS[0]} onClick={() => zoomBy(-1)}>
                <Icon name="minus" size={14} />
              </button>
              <span class="ss-value" aria-live="polite">
                {Math.round(uiZoom() * 100)}%
              </span>
              <button class="btn icon" title="Zoom in" aria-label="Zoom in" disabled={uiZoom() >= ZOOM_STEPS[ZOOM_STEPS.length - 1]} onClick={() => zoomBy(1)}>
                <Icon name="plus" size={14} />
              </button>
              <button class="btn ghost" disabled={uiZoom() === 1} onClick={() => setUiZoom(1)}>
                Actual size
              </button>
            </div>
          )}
        />
      </Group>
      <Group title="Keyboard">
        <Row
          label="Keyboard shortcuts"
          hint={
            <>
              Everything in k10s has a key. Hold <Keys keys="mod" /> to see the keys of what is on screen.
            </>
          }
        >
          <button
            class="btn"
            onClick={() => {
              setSettingsOpen(false);
              setHelpOpen(true);
            }}
          >
            Show all <Kbd id="app.help" />
          </button>
        </Row>
      </Group>
    </>
  );
}

/** How long a view's watches outlive it (seconds). */
const WARM = [30, 60, 180, 600, 1800];
const warmLabel = (s: number) => (s < 60 ? plural(s, "second") : plural(s / 60, "minute"));

function Clusters() {
  const warm = () => engineSettings().feedIdleTtlSecs;
  return (
    <>
      <Group title="Safety">
        <Row
          label="Read-only mode"
          hint="Deleting, scaling, restarting, cordoning, Helm rollbacks and shells in containers are off; reading, logs and port-forwards work. Turning it off asks you to confirm."
          control={(id, hint) => <Toggle on={readOnly()} set={(on) => void setReadOnly(on)} labelledBy={id} describedBy={hint} />}
        />
      </Group>
      <Group title="Watches">
        <Row
          label="Keep a view's data after leaving it"
          wide
          hint="Going back within this time is instant: the view's watches keep running meanwhile. Longer keeps more memory and API connections."
          control={(id, hint) => (
            <select class="input ss-select" aria-labelledby={id} aria-describedby={hint} value={warm()} onChange={(e) => void changeEngineSettings({ feedIdleTtlSecs: Number(e.currentTarget.value) })}>
              <For each={WARM.includes(warm()) ? WARM : [...WARM, warm()].sort((a, b) => a - b)}>{(s) => <option value={s}>{warmLabel(s)}</option>}</For>
            </select>
          )}
        />
      </Group>
      <Group
        title="Cluster sets"
        foot={
          <>
            The cluster picker (<Keys keys="mod+shift+c" />) saves the clusters picked as a set, and picks a set again.
          </>
        }
      >
        <For each={savedSets()} fallback={<Empty>No cluster sets yet.</Empty>}>
          {(set) => <Item label={set.name} hint={`${plural(set.clusters.length, "cluster")}: ${set.clusters.map(shortName).join(", ")}`} drop={() => deleteClusterSet(set.name)} dropLabel="Delete the set" />}
        </For>
      </Group>
    </>
  );
}

function Logs() {
  const history = () => (since() ? `s${since()}` : `t${tail()}`);
  const setHistory = (v: string) => {
    if (v.startsWith("s")) setSince(Number(v.slice(1)));
    else {
      setSince(0);
      setTail(Number(v.slice(1)));
    }
  };
  return (
    <>
      <Group title="Opening a log">
        <Row
          label="History to read"
          wide
          hint="The last lines of each container (with many containers, each gets a share), or a recent stretch of time. All of a log is read in the log viewer, one log at a time."
          control={(id, hint) => (
            <select class="input ss-select" aria-labelledby={id} aria-describedby={hint} value={history()} onChange={(e) => setHistory(e.currentTarget.value)}>
              <optgroup label="Lines">
                <For each={TAILS}>{(n) => <option value={`t${n}`}>Last {count(n)} lines</option>}</For>
              </optgroup>
              <optgroup label="Time">
                <For each={SINCES}>{(s) => <option value={`s${s}`}>Last {s < 3600 ? `${s / 60} min` : `${s / 3600} h`}</option>}</For>
              </optgroup>
            </select>
          )}
        />
      </Group>
      <Group title="Lines">
        <Row label="Timestamps" control={(id, hint) => <Toggle on={showTs()} set={setShowTs} labelledBy={id} describedBy={hint} />} />
        <Row label="Times in UTC" hint="Otherwise in this computer's time zone." control={(id, hint) => <Toggle on={utc()} set={setUtc} labelledBy={id} describedBy={hint} disabled={!showTs()} />} />
        <Row label="Wrap long lines" control={(id, hint) => <Toggle on={wrap()} set={setWrap} labelledBy={id} describedBy={hint} />} />
        <Row label="Structured logs" hint="JSON and logfmt lines as their level, message and fields; plain lines coloured. Off: every line as written." control={(id, hint) => <Toggle on={pretty()} set={setPretty} labelledBy={id} describedBy={hint} />} />
        <Row label="Fold long stack traces" hint={`A trace longer than ${FOLD_AT} lines shows its first ${FOLD_SHOW}, and a row that unfolds it.`} control={(id, hint) => <Toggle on={fold()} set={setFold} labelledBy={id} describedBy={hint} />} />
      </Group>
      <Group title="Fields shown as columns" foot="Show a field as a column from a line's details (x on the line), with structured logs on.">
        <Show when={pinned().length} fallback={<Empty>None.</Empty>}>
          <div class="ss-chips">
            <For each={pinned()}>
              {(field) => (
                <span class="chip mono">
                  {field}
                  <button class="ss-chip-x" title="Stop showing it as a column" aria-label={`Stop showing ${field} as a column`} onClick={() => setPinned(pinned().filter((f) => f !== field))}>
                    <Icon name="x" size={11} />
                  </button>
                </span>
              )}
            </For>
          </div>
        </Show>
      </Group>
    </>
  );
}

function Terminals() {
  return (
    <>
      <Group title="Debug containers" foot="Debug container… adds a container to a pod (it stays there) and opens a terminal in it. Its dialog offers this image, and remembers the one used.">
        <Row
          label="Image"
          wide
          hint="Needs a shell. Registries differ from cluster to cluster: pick one every cluster can pull from."
          control={(id, hint) => <TextSetting value={debugImage()} fallback={DEFAULT_SHELL_IMAGE} set={setDebugImage} reset={() => resetSetting("terminal.debugImage")} labelledBy={id} describedBy={hint} />}
        />
      </Group>
      <Group title="Node shells" foot="A shell on a node is a privileged pod that shares its namespaces, like kubectl node-shell; it is deleted when the session ends.">
        <Row label="Image" wide hint="Needs nsenter (busybox has it)." control={(id, hint) => <TextSetting value={nodeShellImage()} fallback={DEFAULT_SHELL_IMAGE} set={setNodeShellImage} reset={() => resetSetting("terminal.nodeShellImage")} labelledBy={id} describedBy={hint} />} />
        <Row
          label="Namespace for the pod"
          wide
          hint="One where you may create pods."
          control={(id, hint) => (
            <TextSetting
              value={nodeShellNamespace()}
              fallback={DEFAULT_NODE_SHELL_NAMESPACE}
              set={setNodeShellNamespace}
              reset={() => resetSetting("terminal.nodeShellNamespace")}
              labelledBy={id}
              describedBy={hint}
              invalid={(v) => (isValidNamespace(v) ? null : "Not a namespace name: lowercase letters, digits and dashes.")}
            />
          )}
        />
      </Group>
    </>
  );
}

function Forwards() {
  return (
    <>
      <Group title="Starting a forward">
        <Row label="Open in the browser" hint="A new forward opens its address in the browser. The forward dialog's checkbox is the same setting." control={(id, hint) => <Toggle on={openInBrowser()} set={setOpenInBrowser} labelledBy={id} describedBy={hint} />} />
      </Group>
      <Group title="Pinned forwards" foot="Pinned in the dock, a forward waits there to start again with a click, in a later session too.">
        <For each={pins()} fallback={<Empty>None pinned.</Empty>}>
          {(p) => <Item label={forwardTarget(p)} mono hint={`${shortName(p.cluster)} · ${p.namespace}${p.localPort ? ` · localhost:${p.localPort}` : ""}`} drop={() => togglePin(p)} dropLabel="Unpin" dropIcon="pin" />}
        </For>
      </Group>
    </>
  );
}

function Updates() {
  const [info] = createResource(() => backend().appInfo());
  const status = () => {
    const next = update();
    if (next?.ready) return { icon: "download" as const, tone: "ready", title: `k10s ${next.version} is ready`, hint: "Downloaded and verified. Restarting installs it; terminals and port-forwards close." };
    if (next) return { icon: "download" as const, tone: "busy", title: `Downloading k10s ${next.version}…`, hint: "It installs on a restart, once downloaded." };
    const at = lastChecked();
    return {
      icon: "check" as const,
      tone: at ? "ok" : "",
      title: at ? `k10s ${info()?.version ?? ""} is up to date` : `k10s ${info()?.version ?? ""}`,
      hint: checkingForUpdates() ? "Checking…" : at ? `Checked ${age(Math.floor(at / 1000), now())} ago, at ${clock(at).slice(0, 5)}.` : "Not checked yet.",
    };
  };
  return (
    <Show
      when={updatesEnabled()}
      fallback={
        <Group>
          <div class="ss-note">
            <Icon name="info" size={16} />
            <div>
              This build doesn't update itself: only the builds on GitHub Releases do. A build made from source updates by building it again.
              <Show when={info()}>{(i) => ` Running k10s ${i().version}.`}</Show>
            </div>
          </div>
        </Group>
      }
    >
      <Group>
        <div class={`ss-status ${status().tone}`}>
          <span class="ss-status-icon">
            <Show when={status().tone !== "busy" && !checkingForUpdates()} fallback={<span class="spinner" />}>
              <Icon name={status().icon} size={17} />
            </Show>
          </span>
          <div class="ss-text grow">
            <div class="ss-label">{status().title}</div>
            <div class="ss-hint">{status().hint}</div>
          </div>
          <Show when={update()?.ready} fallback={<button class="btn" disabled={checkingForUpdates() || !!update()} onClick={() => void checkForUpdates(true)}>Check now</button>}>
            <Show when={update()?.page}>
              <button class="btn ghost" onClick={() => void backend().openUpdateNotes().catch(failed("Could not open the release notes"))}>
                What's new
              </button>
            </Show>
            <button class="btn primary" onClick={() => void restartToUpdate()}>
              Restart to update
            </button>
          </Show>
        </div>
      </Group>
      <Group>
        <Row label="Check automatically" hint="At start and every six hours — but not again within six hours of a check that found nothing, restarts included. Check now works either way." control={(id, hint) => <Toggle on={autoUpdate()} set={setAutomaticChecks} labelledBy={id} describedBy={hint} />} />
      </Group>
    </Show>
  );
}

/** A file or folder k10s keeps: where it is (across the whole card), and what opens it. */
function FileRow(props: { name: string; path: string | null | undefined; children: JSX.Element }) {
  return (
    <div class="ss-file">
      <Icon name="config" size={18} />
      <div class="ss-label">{props.name}</div>
      <div class="ss-control">{props.children}</div>
      <div class="ss-path selectable">{props.path ?? "Only the desktop app keeps it."}</div>
    </div>
  );
}

/** JSON as text with its keys, strings, numbers and literals coloured. */
function JsonView(props: { value: unknown }) {
  const lines = () => JSON.stringify(props.value, null, 2).split("\n");
  const token = /("(?:[^"\\]|\\.)*")(\s*:)?|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|(true|false|null)|([{}[\],])/g;
  const render = (line: string) => {
    const out: JSX.Element[] = [];
    let last = 0;
    for (const m of line.matchAll(token)) {
      if (m.index > last) out.push(line.slice(last, m.index));
      if (m[1]) {
        out.push(<span class={m[2] ? "y-key" : "y-str"}>{m[1]}</span>);
        if (m[2]) out.push(<span class="y-punct">{m[2]}</span>);
      } else if (m[3]) out.push(<span class="y-num">{m[3]}</span>);
      else if (m[4]) out.push(<span class="y-bool">{m[4]}</span>);
      else out.push(<span class="y-punct">{m[5]}</span>);
      last = m.index + m[0].length;
    }
    if (last < line.length) out.push(line.slice(last));
    return out;
  };
  return (
    <pre class="ss-json selectable" tabIndex={0} aria-label="settings.json">
      <For each={lines()}>{(line) => <div>{render(line)}</div>}</For>
    </pre>
  );
}

function Files() {
  const [info] = createResource(() => backend().appInfo());
  const open = (doc: PrefsDoc, reveal: boolean) => void backend().openPrefsFile(doc, reveal).catch(failed(`Could not open ${doc}.json`));
  const reset = async () => {
    const ok = await ask({
      title: "Reset the settings?",
      body: "k10s forgets the settings and what it remembers — clusters and namespaces picked, cluster sets, recent ones, column widths, pinned forwards — and starts the window again. Read-only mode and the kubeconfig stay as they are.",
      confirmLabel: "Reset",
      danger: true,
    });
    if (!ok) return;
    await clearPreferences().catch(failed("Could not reset the settings"));
    location.reload();
  };
  return (
    <>
      <Group title="Settings" foot="It holds the settings you changed; the others are at their defaults. Edit it in any editor: k10s takes the changes when its window gets the focus back. A file it can't read stays as it is, for you to fix.">
        <FileRow name="settings.json" path={filesInfo()?.settingsPath}>
          <button class="btn" onClick={() => open("settings", false)}>
            Open
          </button>
          <button class="btn ghost" onClick={() => open("settings", true)}>
            {REVEAL}
          </button>
        </FileRow>
        <Show when={filesInfo()?.settingsError}>
          {(error) => (
            <div class="ss-alert" role="alert">
              <Icon name="alert-circle" size={15} />
              <div>
                <b>It can't be read:</b> {error()}. Until it is fixed, k10s runs on the default settings, in read-only mode.
              </div>
            </div>
          )}
        </Show>
        <Show when={settingsFile()}>{(file) => <JsonView value={file()} />}</Show>
      </Group>
      <Group title="What k10s remembers" foot="The clusters and namespaces picked, recent ones, column widths and sorts, the object open in the details: what the next start brings back. Not meant for editing.">
        <FileRow name="state.json" path={filesInfo()?.statePath}>
          <button class="btn ghost" onClick={() => open("state", true)}>
            {REVEAL}
          </button>
        </FileRow>
      </Group>
      <Group title="Logs" foot="The app's log, with a journal of every change made to clusters: what, where, and how it ended — never what objects hold.">
        <FileRow name="k10s.log" path={info()?.logDir}>
          <button class="btn ghost" disabled={!info()?.logDir} onClick={() => void backend().openLogDir().catch(failed("Could not open the log folder"))}>
            Open folder
          </button>
        </FileRow>
      </Group>
      <Group>
        <Row label="Reset the settings" hint="Forgets the settings and what k10s remembers, and starts the window again. Read-only mode and the kubeconfig stay.">
          <button class="btn ss-danger" onClick={() => void reset()}>
            Reset…
          </button>
        </Row>
      </Group>
    </>
  );
}

/** `macOS · arm64`, as people name them rather than as Rust does. */
function platform(os: string, arch: string): string {
  const names: Record<string, string> = { macos: "macOS", windows: "Windows", linux: "Linux", aarch64: "arm64", x86_64: "x64" };
  return `${names[os] ?? os} · ${names[arch] ?? arch}`;
}

function About() {
  const [info] = createResource(() => backend().appInfo());
  const page = (p: "home" | "issues" | "releases") => () => void backend().openProjectPage(p).catch(failed("Could not open the page"));
  return (
    <>
      <div class="ss-about">
        <img src={mark} alt="" draggable={false} />
        <div>
          <div class="ss-about-name">
            k10s <Show when={info()}>{(i) => <span class="badge">{i().version}</span>}</Show>
          </div>
          <div class="ss-hint">
            A keyboard-first Kubernetes client for fleets of clusters.
            <Show when={info()}>{(i) => ` ${platform(i().os, i().arch)}.`}</Show>
          </div>
        </div>
      </div>
      <Group>
        <Row label="Source code" hint="github.com/dumkin/k10s">
          <button class="btn ghost" onClick={page("home")}>
            Open <Icon name="external" size={13} />
          </button>
        </Row>
        <Row label="Releases" hint="Every version, with what changed.">
          <button class="btn ghost" onClick={page("releases")}>
            Open <Icon name="external" size={13} />
          </button>
        </Row>
        <Row label="Report a problem" hint="The log (Files → Logs) helps: it never holds what objects contain.">
          <button class="btn ghost" onClick={page("issues")}>
            Open <Icon name="external" size={13} />
          </button>
        </Row>
        <Row label="License" hint="GNU AGPL v3. The licenses of the libraries k10s is built with come with it, in THIRD-PARTY-NOTICES.md." />
      </Group>
    </>
  );
}
