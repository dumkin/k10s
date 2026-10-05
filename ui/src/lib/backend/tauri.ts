import { Channel, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { Backend, LogLevel } from "./index";
import type {
  AccessCheck,
  AccessDecision,
  AccessRules,
  AppInfo,
  ClusterInfo,
  ContextList,
  DebugSpec,
  EngineEvent,
  ForwardInfo,
  ForwardSpec,
  ForwardsMessage,
  GraphMessage,
  HelmDiff,
  HelmRelease,
  HubStats,
  LogMessage,
  LogSpec,
  LogSubscription,
  LogTarget,
  MetricsHistory,
  MetricsKind,
  MetricsMessage,
  MetricsSpec,
  NodeShellSpec,
  ObjectRef,
  OpResult,
  PrefsChange,
  PrefsDoc,
  PrefsSnapshot,
  RelationsSpec,
  Settings,
  SettingsChange,
  Subscription,
  TermMessage,
  TermSession,
  TermSize,
  TermSpec,
  UpdateInfo,
  ViewBatch,
  ViewSpec,
} from "./types";

/**
 * Opens a channel-backed stream; the id arrives asynchronously, so closing early is handled too.
 * `onOpen` gets the id once it is known (unless closed before).
 */
function stream<T>(command: string, args: Record<string, unknown>, onMessage: (msg: T) => void, onOpen?: (id: number) => void): Subscription {
  const channel = new Channel<T>();
  // Tauri's Channel advances its message index only after the handler returns: a single throw
  // would park every later message forever. Never let an exception escape.
  channel.onmessage = (msg) => {
    try {
      onMessage(msg);
    } catch (e) {
      console.error(`[k10s] ${command} handler failed`, e);
      void invoke("log_frontend", { level: "error", message: `${command} handler: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}` }).catch(() => {});
    }
  };
  let id: number | null = null;
  let closed = false;
  invoke<number>(command, { ...args, channel }).then(
    (sid) => {
      id = sid;
      if (closed) void invoke("unsubscribe", { id: sid });
      else onOpen?.(sid);
    },
    (e) => console.error(`${command} failed`, e),
  );
  return {
    close() {
      if (closed) return;
      closed = true;
      channel.onmessage = () => {};
      if (id !== null) void invoke("unsubscribe", { id });
    },
  };
}

/**
 * A terminal session: keystrokes go out one call at a time, in order — the engine handles calls concurrently, so
 * two in flight could swap — and what is typed meanwhile goes out together with the next call. Nothing is sent
 * before the session has its id; keystrokes typed until then follow right after.
 */
function terminal(command: string, args: Record<string, unknown>, onMessage: (msg: TermMessage) => void): TermSession {
  let id: number | null = null;
  let closed = false;
  let sending = false;
  /** Typed while a call was in flight: text, or binary input (never mixed in one call). */
  let queued: { data: string; binary: boolean }[] = [];
  let size: TermSize | null = null;
  const flush = () => {
    if (id === null || sending || closed || !queued.length) return;
    const first = queued[0];
    let n = 1;
    while (n < queued.length && queued[n].binary === first.binary) n++;
    const data = queued
      .splice(0, n)
      .map((q) => q.data)
      .join("");
    sending = true;
    invoke<void>("terminal_input", { id, data, binary: first.binary })
      .catch(() => {})
      .finally(() => {
        sending = false;
        flush();
      });
  };
  const sub = stream<TermMessage>(command, args, onMessage, (sid) => {
    id = sid;
    if (size) void invoke("terminal_resize", { id, ...size }).catch(() => {});
    flush();
  });
  return {
    close() {
      closed = true;
      queued = [];
      sub.close();
    },
    input(data: string, binary = false) {
      if (closed) return;
      queued.push({ data, binary });
      flush();
    },
    resize(s: TermSize) {
      size = s;
      if (id !== null && !closed) void invoke("terminal_resize", { id, ...s }).catch(() => {});
    },
    ack(bytes: number) {
      if (id !== null && !closed) void invoke("terminal_ack", { id, bytes }).catch(() => {});
    },
  };
}

/**
 * The dialog plugin (the engine shows its read-only confirmation with it, natively) replaces the web view's
 * `window.confirm` with an async function — a Promise, always truthy, so code guarded by it would always go
 * ahead — and `window.alert` with a call the app does not allow. Dialogs here go through `ask` (state/ui):
 * these two are made to refuse, so a stray use can never confirm anything.
 */
export function disarmNativeDialogs(w: Pick<Window, "confirm" | "alert"> = window) {
  w.confirm = () => false;
  w.alert = () => {};
}

export class TauriBackend implements Backend {
  readonly kind = "tauri" as const;

  appInfo() {
    return invoke<AppInfo>("app_info");
  }
  listContexts() {
    return invoke<ContextList>("list_contexts");
  }
  connect(context: string) {
    return invoke<ClusterInfo>("connect_cluster", { context });
  }
  reconnect(context: string) {
    return invoke<ClusterInfo>("reconnect_cluster", { context });
  }
  refreshDiscovery(context: string) {
    return invoke<ClusterInfo>("refresh_discovery", { context });
  }
  disconnect(context: string) {
    return invoke<void>("disconnect_cluster", { context });
  }
  resync() {
    return invoke<void>("resync");
  }
  subscribeView(spec: ViewSpec, onBatch: (batch: ViewBatch) => void) {
    return stream<ViewBatch>("subscribe_view", { spec }, onBatch);
  }
  streamLogs(spec: LogSpec, onMessage: (msg: LogMessage) => void): LogSubscription {
    // Target updates go out one at a time, in order (the latest wins), and only once the stream has its id.
    let id: number | null = null;
    let sending = false;
    let next: LogTarget[] | null = null;
    let closed = false;
    const send = () => {
      if (id === null || sending || closed || !next) return;
      const targets = next;
      next = null;
      sending = true;
      invoke<void>("update_log_targets", { id, targets })
        .catch((e) => console.error("update_log_targets failed", e))
        .finally(() => {
          sending = false;
          send();
        });
    };
    const sub = stream<LogMessage>("stream_logs", { spec }, onMessage, (sid) => {
      id = sid;
      send();
    });
    return {
      close() {
        closed = true;
        sub.close();
      },
      setTargets(targets: LogTarget[]) {
        next = targets;
        send();
      },
    };
  }
  startTerminal(spec: TermSpec, onMessage: (msg: TermMessage) => void) {
    return terminal("start_terminal", { spec }, onMessage);
  }
  startDebug(spec: DebugSpec, onMessage: (msg: TermMessage) => void) {
    return terminal("start_debug", { spec }, onMessage);
  }
  startNodeShell(spec: NodeShellSpec, onMessage: (msg: TermMessage) => void) {
    return terminal("start_node_shell", { spec }, onMessage);
  }
  startForward(spec: ForwardSpec) {
    return invoke<ForwardInfo>("start_forward", { spec });
  }
  stopForward(id: number) {
    return invoke<boolean>("stop_forward", { id });
  }
  subscribeForwards(onList: (list: ForwardInfo[]) => void) {
    return stream<ForwardsMessage>("subscribe_forwards", {}, (m) => onList(m.list));
  }
  openForward(id: number) {
    return invoke<void>("open_forward", { id });
  }
  subscribeRelations(spec: RelationsSpec, onGraph: (msg: GraphMessage) => void) {
    return stream<GraphMessage>("subscribe_relations", { spec }, onGraph);
  }
  accessReview(cluster: string, checks: AccessCheck[]) {
    return invoke<AccessDecision[]>("access_review", { cluster, checks });
  }
  accessRules(cluster: string, namespace: string) {
    return invoke<AccessRules>("access_rules", { cluster, namespace });
  }
  subscribeHelm(spec: ViewSpec, onBatch: (batch: ViewBatch) => void) {
    return stream<ViewBatch>("subscribe_helm", { spec }, onBatch);
  }
  helmRelease(cluster: string, namespace: string, name: string) {
    return invoke<HelmRelease>("helm_release", { cluster, namespace, name });
  }
  helmDiff(cluster: string, namespace: string, name: string, from: number, to: number) {
    return invoke<HelmDiff>("helm_diff", { cluster, namespace, name, from, to });
  }
  helmRollback(cluster: string, namespace: string, name: string, revision: number) {
    return invoke<string>("helm_rollback", { cluster, namespace, name, revision });
  }
  helmUninstall(targets: ObjectRef[]) {
    return invoke<OpResult[]>("helm_uninstall", { targets });
  }
  subscribeMetrics(spec: MetricsSpec, onMessage: (msg: MetricsMessage) => void) {
    return stream<MetricsMessage>("subscribe_metrics", { spec }, onMessage);
  }
  metricsHistory(cluster: string, kind: MetricsKind, namespace: string | null, name: string) {
    return invoke<MetricsHistory | null>("metrics_history", { cluster, kind, namespace, name });
  }
  getObject(target: ObjectRef) {
    return invoke("get_object", { target });
  }
  getYaml(target: ObjectRef, managedFields: boolean, reveal = false) {
    return invoke<string>("get_yaml", { target, managedFields, reveal });
  }
  deleteObjects(targets: ObjectRef[], force: boolean) {
    return invoke<OpResult[]>("delete_objects", { targets, force });
  }
  scale(target: ObjectRef, replicas: number) {
    return invoke<void>("scale", { target, replicas });
  }
  restart(target: ObjectRef) {
    return invoke<void>("restart", { target });
  }
  setUnschedulable(target: ObjectRef, unschedulable: boolean) {
    return invoke<void>("set_unschedulable", { target, unschedulable });
  }
  setSuspend(target: ObjectRef, suspend: boolean) {
    return invoke<void>("set_suspend", { target, suspend });
  }
  triggerCronJob(target: ObjectRef) {
    return invoke<string>("trigger_cronjob", { target });
  }
  getSettings() {
    return invoke<Settings>("get_settings");
  }
  setSettings(settings: Settings) {
    return invoke<Settings>("set_settings", { settings });
  }
  setReadOnly(enabled: boolean) {
    return invoke<Settings>("set_read_only", { enabled });
  }
  /** The answer to what index.html asked for as the page started to load; later on (a reload of the page), anew. */
  loadPrefs() {
    const w = window as { __K10S_PREFS__?: Promise<PrefsSnapshot> };
    const early = w.__K10S_PREFS__;
    delete w.__K10S_PREFS__;
    return early ?? invoke<PrefsSnapshot>("prefs_load");
  }
  setPrefs(changes: PrefsChange[]) {
    return invoke<void>("prefs_set", { changes });
  }
  resetPrefs() {
    return invoke<void>("prefs_reset");
  }
  openPrefsFile(doc: PrefsDoc, reveal: boolean) {
    return invoke<void>("prefs_open", { doc, reveal });
  }
  onSettingsChanged(cb: (change: SettingsChange) => void) {
    const unlisten = listen<SettingsChange>("k10s://settings", (e) => cb(e.payload));
    return () => void unlisten.then((f) => f());
  }
  stats() {
    return invoke<HubStats>("stats");
  }
  onEngineEvent(cb: (event: EngineEvent) => void) {
    const unlisten = listen<EngineEvent>("k10s://engine", (e) => {
      try {
        cb(e.payload);
      } catch (err) {
        console.error("[k10s] engine event handler failed", err);
      }
    });
    return () => void unlisten.then((f) => f());
  }
  log(level: LogLevel, message: string) {
    void invoke("log_frontend", { level, message }).catch(() => {});
  }
  heartbeat(visible: boolean) {
    void invoke("ui_heartbeat", { visible }).catch(() => {});
  }
  toggleDevtools() {
    return invoke<void>("toggle_devtools");
  }
  openLogDir() {
    return invoke<void>("open_log_dir");
  }
  openProjectPage(page: "home" | "issues" | "releases") {
    return invoke<void>("open_project_page", { page });
  }
  setAppearance(theme: "dark" | "light") {
    void invoke("set_appearance", { theme }).catch(() => {});
  }
  setZoom(scale: number) {
    return invoke<void>("set_zoom", { zoom: scale });
  }
  saveFile(name: string, contents: string) {
    return invoke<string | null>("save_file", { name, contents });
  }
  checkUpdate() {
    return invoke<UpdateInfo | null>("check_update");
  }
  downloadUpdate() {
    return invoke<UpdateInfo>("download_update");
  }
  installUpdate() {
    return invoke<void>("install_update");
  }
  openUpdateNotes() {
    return invoke<void>("open_update_notes");
  }
}
