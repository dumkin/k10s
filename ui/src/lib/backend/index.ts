import type {
  AccessCheck,
  AccessDecision,
  AccessRules,
  AppInfo,
  BackendError,
  ClusterInfo,
  ContextList,
  DebugSpec,
  EngineEvent,
  ForwardInfo,
  ForwardSpec,
  GraphMessage,
  HelmDiff,
  HelmRelease,
  HubStats,
  LogMessage,
  LogSpec,
  LogSubscription,
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
  TermSpec,
  UpdateInfo,
  ViewBatch,
  ViewSpec,
} from "./types";
import { disarmNativeDialogs, TauriBackend } from "./tauri";

export * from "./types";

/**
 * Everything the UI needs from the engine. The Tauri implementation talks to `k10s-core`;
 * the mock implementation (browser-only, dev) lets the UI be developed without a cluster.
 */
export interface Backend {
  readonly kind: "tauri" | "mock";
  appInfo(): Promise<AppInfo>;
  listContexts(): Promise<ContextList>;
  connect(context: string): Promise<ClusterInfo>;
  reconnect(context: string): Promise<ClusterInfo>;
  refreshDiscovery(context: string): Promise<ClusterInfo>;
  disconnect(context: string): Promise<void>;
  /** After sleep or a network change: restart every live watch with a fresh list, retry failed clusters. */
  resync(): Promise<void>;
  subscribeView(spec: ViewSpec, onBatch: (batch: ViewBatch) => void): Subscription;
  /** Streams logs; `setTargets` on the result changes the targets without restarting the others. */
  streamLogs(spec: LogSpec, onMessage: (msg: LogMessage) => void): LogSubscription;
  /** Opens a terminal in a running container (a shell, or its console with `attach`); `close()` ends it. */
  startTerminal(spec: TermSpec, onMessage: (msg: TermMessage) => void): TermSession;
  /** Adds a debug container to a pod (it stays there) and opens a terminal in it once it runs. */
  startDebug(spec: DebugSpec, onMessage: (msg: TermMessage) => void): TermSession;
  /** Opens a shell on a node through a privileged helper pod, deleted when the session ends. */
  startNodeShell(spec: NodeShellSpec, onMessage: (msg: TermMessage) => void): TermSession;
  /** Starts a port-forward once it can work (the local port free, the permission granted, a pod to forward to). */
  startForward(spec: ForwardSpec): Promise<ForwardInfo>;
  stopForward(id: number): Promise<boolean>;
  /** The port-forwards (the engine's: they outlive a reload of the UI), on every change and while they carry traffic. */
  subscribeForwards(onList: (list: ForwardInfo[]) => void): Subscription;
  /** Opens a port-forward's local URL in the default browser. */
  openForward(id: number): Promise<void>;
  /** The graph around one object, again whenever it changes (a rollout, a pod replaced), until closed. */
  subscribeRelations(spec: RelationsSpec, onGraph: (msg: GraphMessage) => void): Subscription;
  /** Whether the user may do each of `checks` in `cluster`, in their order (`allowed: null` where it could not say). */
  accessReview(cluster: string, checks: AccessCheck[]): Promise<AccessDecision[]>;
  /** What the user may do in a namespace of `cluster`, as its API server lists it. */
  accessRules(cluster: string, namespace: string): Promise<AccessRules>;
  /** Helm releases (read from their records) of these clusters and namespaces, as a view's table. */
  subscribeHelm(spec: ViewSpec, onBatch: (batch: ViewBatch) => void): Subscription;
  helmRelease(cluster: string, namespace: string, name: string): Promise<HelmRelease>;
  helmDiff(cluster: string, namespace: string, name: string, from: number, to: number): Promise<HelmDiff>;
  /** `helm rollback` with the user's helm; refused in read-only mode. Resolves with helm's output. */
  helmRollback(cluster: string, namespace: string, name: string, revision: number): Promise<string>;
  /** `helm uninstall` of each target; refused in read-only mode. */
  helmUninstall(targets: ObjectRef[]): Promise<OpResult[]>;
  /** CPU and memory of pods or nodes (the metrics API, polled every 15 s), and why there is none where there is none. */
  subscribeMetrics(spec: MetricsSpec, onMessage: (msg: MetricsMessage) => void): Subscription;
  /** One pod's or node's usage over the last minutes, while a view polls it (null otherwise). */
  metricsHistory(cluster: string, kind: MetricsKind, namespace: string | null, name: string): Promise<MetricsHistory | null>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getObject(target: ObjectRef): Promise<any>;
  /** A Secret's values come back hidden (`<hidden: 24 bytes>`) unless `reveal`. */
  getYaml(target: ObjectRef, managedFields: boolean, reveal?: boolean): Promise<string>;
  deleteObjects(targets: ObjectRef[], force: boolean): Promise<OpResult[]>;
  scale(target: ObjectRef, replicas: number): Promise<void>;
  restart(target: ObjectRef): Promise<void>;
  setUnschedulable(target: ObjectRef, unschedulable: boolean): Promise<void>;
  setSuspend(target: ObjectRef, suspend: boolean): Promise<void>;
  triggerCronJob(target: ObjectRef): Promise<string>;
  getSettings(): Promise<Settings>;
  /** Returns the settings in effect: read-only mode can be turned on here, never off (see `setReadOnly`). */
  setSettings(settings: Settings): Promise<Settings>;
  /**
   * Turning read-only mode off asks the user first (natively, in the desktop app); they may keep it on.
   * The desktop app rejects, without asking, while its confirmation is open and for a few seconds after
   * the user kept read-only mode on.
   */
  setReadOnly(enabled: boolean): Promise<Settings>;
  /** What the UI keeps, as the desktop app's files hold it (or the mock's stand-ins for them). */
  loadPrefs(): Promise<PrefsSnapshot>;
  /** Keeps values (null forgets one); the files are written a moment later. Resolves once the app has them. */
  setPrefs(changes: PrefsChange[]): Promise<void>;
  /** Forgets what the UI kept. The engine's settings (read-only mode) stay. */
  resetPrefs(): Promise<void>;
  /** Opens a file in the app the desktop opens it with (an editor), or shows it in Finder / Explorer (`reveal`). */
  openPrefsFile(doc: PrefsDoc, reveal: boolean): Promise<void>;
  /** `settings.json` was edited outside the app (the desktop app looks when its window gets the focus back). */
  onSettingsChanged(cb: (change: SettingsChange) => void): () => void;
  stats(): Promise<HubStats>;
  onEngineEvent(cb: (event: EngineEvent) => void): () => void;
  /** Writes a frontend report to the app log (file + terminal). Fire-and-forget. */
  log(level: LogLevel, message: string): void;
  /** "The UI is alive" signal for the engine's freeze watchdog. Fire-and-forget. */
  heartbeat(visible: boolean): void;
  toggleDevtools(): Promise<void>;
  openLogDir(): Promise<void>;
  /** Opens a page of the project in the browser: its repository, its issues, its releases. */
  openProjectPage(page: "home" | "issues" | "releases"): Promise<void>;
  /** The theme the UI shows: the window takes its colour (and opens in it next time). Fire-and-forget. */
  setAppearance(theme: "dark" | "light"): void;
  /** Zooms the whole page (1 = 100%), as a browser's zoom does; the window opens at it next time. */
  setZoom(scale: number): Promise<void>;
  /**
   * Saves text to a file the user picks in a save dialog (`name`: the name it suggests). Resolves to where it was
   * saved, or null if the dialog was cancelled.
   */
  saveFile(name: string, contents: string): Promise<string | null>;
  /** Asks the project's releases whether there is a newer one (only builds with `AppInfo.updates`). */
  checkUpdate(): Promise<UpdateInfo | null>;
  /** Downloads the release the last check found and verifies its signature. */
  downloadUpdate(): Promise<UpdateInfo>;
  /** Installs the downloaded release and restarts into it. */
  installUpdate(): Promise<void>;
  /** Opens the page of the release the last check found in the browser. */
  openUpdateNotes(): Promise<void>;
}

export type LogLevel = "error" | "warn" | "info" | "debug";

export const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

let instance: Backend | undefined;

export async function initBackend(): Promise<Backend> {
  if (!instance) {
    // The mock is a separate chunk that never loads inside the desktop app.
    if (isTauri) disarmNativeDialogs();
    instance = isTauri ? new TauriBackend() : new (await import("./mock")).MockBackend();
  }
  return instance;
}

/** The active backend. Only valid after `initBackend()` resolved (done before the UI mounts). */
export function backend(): Backend {
  if (!instance) throw new Error("backend not initialised");
  return instance;
}

export function toError(e: unknown): BackendError {
  if (e && typeof e === "object" && "message" in e) {
    const err = e as Partial<BackendError>;
    return { kind: err.kind ?? "other", message: String(err.message), code: err.code ?? null };
  }
  return { kind: "other", message: String(e), code: null };
}

export function errorMessage(e: unknown): string {
  return toError(e).message;
}
