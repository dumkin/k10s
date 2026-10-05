import { ATTENTION } from "../lib/attention";
import { PERMISSIONS } from "../lib/permissions";
import { untrack } from "solid-js";
import { backend, errorMessage, isTauri } from "../lib/backend";
import { zoneSummary } from "../lib/clusters";
import { comboLabel, isMac } from "../lib/hotkeys";
import { normalizeNamespace } from "../lib/k8s";
import { type ActionContext, actionLabel, actionsFor } from "../registry/actions";
import { CATALOG, catalogEntry, isCatalogued, isHiddenGroup, titleFor } from "../registry/catalog";
import {
  clusterColor,
  clusterFamilies,
  clusterStatus,
  contexts,
  discoveredResources,
  ensureConnected,
  kubeconfigState,
  loadContexts,
  refreshDiscovery,
  savedSets,
  selectedClusters,
  setSelectedClusters,
  shortName,
  toggleCluster,
} from "./clusters";
import { type Command, registerCommands } from "./commands";
import {
  BACK_COMBO,
  backTarget,
  currentResource,
  FORWARD_COMBO,
  forwardTarget,
  goBack,
  goForward,
  kubeconfigNamespaces,
  type NavState,
  namespaces,
  navigate,
  recentNamespaces,
  recentResources,
  resourceKey,
  resourceTitle,
  setNamespaces,
  toggleNamespace,
} from "./nav";
import { readOnly, SETTINGS_SECTIONS, setHelpOpen, setReadOnly, setSettingsOpen, setThemePref, setUiZoom, themePref, toast, uiZoom, zoomBy } from "./ui";
import { namespaceErrors, namespaceOptions, selectionTargets } from "./views";

/** k9s users type `:pulses` for its health view; this is ours. */
const ATTENTION_WORDS = ["attention", "pulse", "pulses", "problems", "health", "overview", "broken", "failing"];

function resourceCommands(): Command[] {
  const recent = recentResources();
  const out: Command[] = [
    {
      id: `res:${ATTENTION}`,
      title: "Needs attention",
      section: "Resources",
      icon: "alert",
      keywords: ATTENTION_WORDS,
      hint: ":pulse",
      priority: 10 - Math.min(recent.indexOf(ATTENTION) >= 0 ? recent.indexOf(ATTENTION) : 10, 10),
      run: () => navigate(ATTENTION),
    },
  ];
  for (const section of CATALOG)
    for (const e of section.entries) {
      const r = discoveredResources().get(e.key);
      out.push({
        id: `res:${e.key}`,
        title: e.title,
        section: "Resources",
        icon: e.icon,
        keywords: e.key === PERMISSIONS ? ["can", "can-i", "rbac", "access", "allowed", "permissions"] : [e.key, ...(r?.shortNames ?? []), r?.kind ?? ""],
        hint: r?.shortNames.length ? `:${r.shortNames[0]}` : undefined,
        priority: 10 - Math.min(recent.indexOf(e.key) >= 0 ? recent.indexOf(e.key) : 10, 10),
        run: () => navigate(e.key),
      });
    }
  for (const r of discoveredResources().values()) {
    if (isCatalogued(r.key) || !r.group || isHiddenGroup(r.group) || !r.verbs.includes("list")) continue;
    out.push({
      id: `res:${r.key}`,
      title: titleFor(r.kind),
      section: "Custom resources",
      icon: "crd",
      keywords: [r.key, r.kind, r.group, ...r.shortNames],
      hint: r.group,
      run: () => navigate(r.key),
    });
  }
  return out;
}

function clusterCommands(): Command[] {
  const selected = new Set(selectedClusters());
  const out: Command[] = savedSets().map((s) => ({
    id: `set:${s.name}`,
    title: s.name,
    section: "Cluster sets",
    icon: "star" as const,
    hint: `${s.clusters.length} clusters`,
    run: () => setSelectedClusters(s.clusters),
  }));
  for (const f of clusterFamilies())
    out.push({
      id: `fam:${f.base}`,
      title: `${f.base} · all zones`,
      section: "Cluster sets",
      icon: "layers",
      keywords: f.members,
      // A family of many zones must not squeeze its name out of the row.
      hint: zoneSummary(f.members, 6),
      run: ({ additive }) => setSelectedClusters(additive ? [...selectedClusters(), ...f.members] : f.members),
    });
  for (const c of contexts())
    out.push({
      id: `ctx:${c.name}`,
      title: c.name,
      section: "Clusters",
      icon: "layers",
      keywords: [c.cluster, c.server ?? ""],
      color: selected.has(c.name) ? clusterColor(c.name) : undefined,
      checked: selected.has(c.name),
      hint: selected.has(c.name) ? "selected" : `${comboLabel("mod+enter")} to add`,
      run: ({ additive }) => (additive ? toggleCluster(c.name) : setSelectedClusters([c.name])),
    });
  return out;
}

function namespaceCommands(query: string): Command[] {
  const selected = new Set(namespaces());
  const all: Command = { id: "ns:*", title: "All namespaces", section: "Namespaces", icon: "globe", checked: selected.size === 0, run: () => setNamespaces([]) };
  // The empty palette doesn't list namespaces; a fleet can have tens of thousands of them.
  if (!query.trim()) return [all];
  return [
    all,
    ...namespaceOptions().map((o) => ({
      id: `ns:${o.name}`,
      title: o.name,
      section: "Namespaces",
      icon: "namespace" as const,
      checked: selected.has(o.name),
      hint: selected.has(o.name) ? "selected" : undefined,
      run: ({ additive }: { additive: boolean }) => (additive ? toggleNamespace(o.name) : setNamespaces([o.name])),
    })),
  ];
}

function actionCommands(): Command[] {
  // Untracked: the palette must not recompute on every table update; it is rebuilt each time it opens.
  const ctx: ActionContext = { resourceKey: resourceKey(), resource: currentResource(), rows: untrack(selectionTargets) };
  const what = ctx.rows.length > 1 ? `${ctx.rows.length} selected` : ctx.rows[0]?.n;
  return actionsFor(ctx).map((a) => ({
    id: `act:${a.id}`,
    // Disabled ones (read-only mode) say why in the hint, not in a longer title; run, they only explain.
    title: actionLabel(a, ctx),
    section: what ? `Selection · ${what}` : "Selection",
    icon: a.icon,
    hint: a.disabled,
    shortcut: a.shortcut,
    priority: a.disabled ? 0 : 20,
    run: () => a.run(ctx),
  }));
}

/** Says an action on every selected cluster worked — or on which ones it did not, and why. */
function reportPerCluster(done: string, what: string, failed: (readonly [string, string])[]) {
  if (failed.length) toast("error", `Could not ${what} ${failed.map(([c]) => shortName(c)).join(", ")}`, failed.map(([c, message]) => `${shortName(c)}: ${message}`).join("\n"));
  else toast("success", done);
}

/** Reads the kubeconfig again and says how that went: the welcome screen shows it, a table does not. */
async function reloadKubeconfig() {
  await loadContexts();
  const st = kubeconfigState();
  const n = contexts().length;
  if (st.state === "ok") toast("success", `Kubeconfig reloaded: ${n} context${n === 1 ? "" : "s"}`);
  else if (st.state === "error") toast("error", "Can't read the kubeconfig", st.message);
  else if (st.state === "missing") toast("error", "No kubeconfig found", `Searched${st.fromEnv ? " (from KUBECONFIG)" : ""}: ${st.paths.join(", ")}`);
  else if (st.state === "empty") toast("error", "No contexts in the kubeconfig", `Read: ${st.paths.join(", ")}`);
}

/** `:ns` completions offered at most. */
const NS_COMPLETIONS = 12;

/**
 * `:ns` completions where a selected cluster may not list namespaces (strict RBAC): the namespaces its
 * kubeconfig context sets and the ones that worked before — the names known without listing.
 */
function namespaceCompletions(arg: string): Command[] {
  if (!namespaceErrors().some((e) => e.forbidden)) return [];
  const q = normalizeNamespace(arg);
  const fromKubeconfig = new Set(kubeconfigNamespaces());
  return recentNamespaces()
    .filter((n) => n !== q && n.includes(q))
    .slice(0, NS_COMPLETIONS)
    .map((n) => ({
      id: `colon:ns:${n}`,
      title: `Namespace ${n}`,
      section: "Command",
      icon: "namespace" as const,
      hint: fromKubeconfig.has(n) ? "from kubeconfig" : "recent",
      checked: namespaces().includes(n),
      priority: 90,
      run: ({ additive }: { additive: boolean }) => (additive ? toggleNamespace(n) : setNamespaces([n])),
    }));
}

/** "Back" / "Forward" through the views, named after where they lead. */
function historyCommands(): Command[] {
  const where = (s: NavState) => `${resourceTitle(s.resource)}${s.selectedName ? ` · ${s.selectedName}` : ""}`;
  const out: Command[] = [];
  const back = backTarget();
  const fwd = forwardTarget();
  if (back) out.push({ id: "nav:back", title: `Back to ${where(back)}`, section: "Navigation", icon: "clock", keywords: ["back", "previous", "history"], shortcut: BACK_COMBO, priority: 1, run: () => void goBack() });
  if (fwd) out.push({ id: "nav:forward", title: `Forward to ${where(fwd)}`, section: "Navigation", icon: "chevron-right", keywords: ["forward", "next", "history"], shortcut: FORWARD_COMBO, run: () => void goForward() });
  return out;
}

function appCommands(): Command[] {
  return [
    { id: "app:settings", title: "Settings", section: "App", icon: "settings", keywords: ["preferences", "options", "config"], shortcut: "mod+,", priority: 1, run: () => void setSettingsOpen("general") },
    // Each section on its own, found by searching ("logs settings", "updates"); an empty palette lists only the above.
    ...SETTINGS_SECTIONS.filter((s) => s.id !== "general").map(
      (s): Command => ({ id: `app:settings-${s.id}`, title: `Settings: ${s.title}`, section: "Settings", icon: s.icon, keywords: ["preferences", "options", ...s.keywords], run: () => void setSettingsOpen(s.id) }),
    ),
    { id: "app:shortcuts", title: "Keyboard shortcuts", section: "App", icon: "keyboard", keywords: ["help", "keys", "hotkeys", "cheatsheet", "k9s"], shortcut: "?", run: () => void setHelpOpen(true) },
    { id: "app:theme", title: `Switch to ${themePref() === "dark" ? "light" : "dark"} theme`, section: "App", icon: themePref() === "dark" ? "sun" : "moon", run: () => void setThemePref(themePref() === "dark" ? "light" : "dark") },
    // Zoom: the level now in the hint (the window opens at it next time).
    { id: "app:zoom-in", title: "Zoom in", section: "App", icon: "plus", keywords: ["bigger", "larger", "font", "text size", "scale"], hint: `${Math.round(uiZoom() * 100)}%`, shortcut: "mod+=", run: () => zoomBy(1) },
    { id: "app:zoom-out", title: "Zoom out", section: "App", icon: "minus", keywords: ["smaller", "font", "text size", "scale"], hint: `${Math.round(uiZoom() * 100)}%`, shortcut: "mod+-", run: () => zoomBy(-1) },
    { id: "app:zoom-reset", title: "Actual size (100%)", section: "App", icon: "search", keywords: ["zoom", "reset", "font", "text size", "scale"], shortcut: "mod+0", run: () => void setUiZoom(1) },
    {
      id: "app:readonly",
      // Turning it off asks again, natively (the engine owns the switch).
      title: readOnly() ? "Turn off read-only mode…" : "Turn on read-only mode",
      section: "App",
      icon: "lock",
      keywords: ["safe", "protect", "read-only", "readonly", "lock"],
      hint: readOnly() ? "on" : "off",
      run: () => setReadOnly(!readOnly()),
    },
    {
      id: "app:reconnect",
      title: "Reconnect selected clusters",
      section: "App",
      icon: "refresh",
      keywords: ["refresh", "credentials", "token"],
      run: async () => {
        const clusters = selectedClusters();
        // Never throws: a failure lands in the cluster's status (the strip shows it).
        const ok = await Promise.all(clusters.map((c) => ensureConnected(c, true)));
        reportPerCluster("Reconnected", "reconnect", clusters.flatMap((c, i) => (ok[i] ? [] : [[c, clusterStatus[c]?.message ?? "not connected"] as const])));
      },
    },
    {
      id: "app:discovery",
      title: "Refresh API discovery (new CRDs)",
      section: "App",
      icon: "crd",
      run: async () => {
        const clusters = selectedClusters();
        const failed = await Promise.all(clusters.map((c) => refreshDiscovery(c).then(() => null, (e: unknown) => [c, errorMessage(e)] as const)));
        reportPerCluster("Discovery refreshed", "refresh discovery of", failed.filter((f) => f !== null));
      },
    },
    { id: "app:kubeconfig", title: "Reload kubeconfig", section: "App", icon: "config", keywords: ["contexts", "KUBECONFIG"], run: reloadKubeconfig },
    {
      id: "app:stats",
      title: "Show engine stats",
      section: "App",
      icon: "gauge",
      run: async () => {
        const s = await backend().stats();
        toast("info", "Engine", `${s.feeds} watches (${s.active} active) · ${s.objects.toLocaleString("en-US")} objects cached`);
      },
    },
    ...(isTauri
      ? [
          {
            id: "app:settings-file",
            title: "Open settings.json",
            section: "App",
            icon: "braces",
            keywords: ["settings", "preferences", "config", "edit", "json"],
            run: () => backend().openPrefsFile("settings", false).catch((e) => toast("error", "Could not open settings.json", errorMessage(e))),
          } satisfies Command,
          {
            id: "app:logs",
            title: "Open log folder",
            section: "App",
            icon: "logs",
            keywords: ["debug", "diagnostics", "troubleshoot"],
            run: () => backend().openLogDir().catch((e) => toast("error", "Cannot open the log folder", errorMessage(e))),
          } satisfies Command,
          {
            id: "app:devtools",
            title: "Toggle developer tools",
            section: "App",
            icon: "code",
            // WebKit's inspector shortcut on macOS; WebView2 and WebKitGTK use Ctrl+Shift+I.
            shortcut: isMac ? "mod+alt+i" : "ctrl+shift+i",
            keywords: ["inspector", "debug", "console", "web inspector"],
            run: () => backend().toggleDevtools().catch((e) => toast("error", "Developer tools are unavailable", errorMessage(e))),
          } satisfies Command,
        ]
      : []),
  ];
}

/** k9s-style `:` commands: `:po`, `:deploy`, `:ns kube-system`, `:ctx prod`. */
function colonCommands(query: string): Command[] {
  if (!query.startsWith(":")) return [];
  const [cmd, ...rest] = query.slice(1).trim().split(/\s+/);
  const arg = rest.join(" ");
  if (!cmd) return [];
  const out: Command[] = [];
  if (cmd === "ns" || cmd === "namespace") {
    if (arg) out.push({ id: `colon:ns:${arg}`, title: `Namespace ${arg}`, section: "Command", icon: "namespace", priority: 100, run: () => setNamespaces([arg]) });
    out.push(...namespaceCompletions(arg));
  }
  if ((cmd === "ctx" || cmd === "context") && arg) {
    const matches = contexts().filter((c) => c.name.includes(arg));
    if (matches.length)
      out.push({
        id: `colon:ctx:${arg}`,
        title: matches.length === 1 ? `Switch to ${matches[0].name}` : `Show ${matches.length} clusters matching “${arg}”`,
        section: "Command",
        icon: "layers",
        priority: 100,
        run: () => setSelectedClusters(matches.map((c) => c.name)),
      });
  }
  if (ATTENTION_WORDS.includes(cmd)) out.push({ id: "colon:attention", title: "Go to Needs attention", section: "Command", icon: "alert", priority: 100, run: () => navigate(ATTENTION) });
  // k9s's `:can`.
  if (cmd === "can" || cmd === "permissions" || cmd === "rbac") out.push({ id: "colon:permissions", title: "Go to My permissions", section: "Command", icon: "user", priority: 100, run: () => navigate(PERMISSIONS) });
  const res = [...discoveredResources().values()].find((r) => r.plural === cmd || r.singular === cmd || r.shortNames.includes(cmd) || r.kind.toLowerCase() === cmd || r.key === cmd);
  if (res) {
    out.push({
      id: `colon:res:${res.key}`,
      title: `Go to ${catalogEntry(res.key)?.title ?? titleFor(res.kind)}${arg ? ` in ${arg}` : ""}`,
      section: "Command",
      icon: catalogEntry(res.key)?.icon ?? "crd",
      priority: 100,
      run: () => {
        navigate(res.key);
        if (arg) setNamespaces([arg]);
      },
    });
  }
  return out;
}

export function registerBuiltinCommands() {
  registerCommands(colonCommands);
  registerCommands(actionCommands);
  registerCommands(historyCommands);
  registerCommands(resourceCommands);
  registerCommands(clusterCommands);
  registerCommands(namespaceCommands);
  registerCommands(appCommands);
}
