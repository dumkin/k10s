// Wire types shared with `k10s-core` (Rust). Keep in sync with the serde definitions there.

export interface ContextInfo {
  name: string;
  cluster: string;
  server?: string | null;
  user?: string | null;
  /** The namespace the context sets (kubectl's default for it). */
  namespace?: string | null;
  auth: string;
}

export interface ContextList {
  contexts: ContextInfo[];
  current?: string | null;
  /** Every file searched, in order. */
  paths: string[];
  /** Those of `paths` that exist; empty: there is no kubeconfig at all (not an empty one). */
  found?: string[];
  /** `paths` come from the `KUBECONFIG` variable (otherwise the default `~/.kube/config`). */
  fromEnv?: boolean;
}

export interface ResourceInfo {
  /** kubectl-style key: `pods`, `deployments.apps`, `certificates.cert-manager.io` */
  key: string;
  group: string;
  version: string;
  kind: string;
  plural: string;
  singular: string;
  namespaced: boolean;
  verbs: string[];
  shortNames: string[];
  categories: string[];
  subresources: string[];
}

export interface ClusterInfo {
  context: string;
  server: string;
  version?: string | null;
  defaultNamespace?: string | null;
  aggregatedDiscovery: boolean;
  resources: ResourceInfo[];
}

export const Tone = { Neutral: 0, Ok: 1, Warn: 2, Error: 3, Muted: 4, Info: 5 } as const;
export type Tone = (typeof Tone)[keyof typeof Tone];

export type ColumnKind =
  | "text"
  | "number"
  | "bool"
  | "status"
  | "ratio"
  | "restarts"
  | "age"
  | "duration"
  | "bytes"
  | "cpu"
  | "labels";

export interface Column {
  id: string;
  title: string;
  kind: ColumnKind;
  width?: number;
  hidden?: boolean;
  description?: string;
}

/** Cell shapes depend on the column kind — see `ColumnKind` docs in `render/mod.rs`. */
export type Cell = null | boolean | number | string | [string, Tone] | [number, number | null];

export interface Row {
  /** uid */
  u: string;
  /** name */
  n: string;
  /** namespace */
  ns?: string;
  /** resourceVersion */
  rv: string;
  /** creationTimestamp (unix seconds) */
  t: number;
  /** row tone */
  s: Tone;
  /** cells, aligned with the view's columns */
  c: Cell[];
  /** labels as `k=v k2=v2` */
  l?: string;
  /** terminating */
  x?: boolean;
}

export type FeedStatus =
  | { state: "connecting" }
  | { state: "loading" }
  | { state: "ready" }
  | { state: "error"; message: string; code?: number; reason?: string; terminal?: boolean };

export type ViewMessage =
  | { t: "schema"; columns: Column[] }
  /** `notice`: why the cluster shows no kind-specific columns (`printer columns unavailable: …`). */
  | { t: "resolved"; c: string; resource: ResourceInfo; notice?: string }
  | ({ t: "status"; c: string; ns: string | null } & FeedStatus)
  /**
   * `more`: a snapshot too big for one message comes in chunks — the first with `reset`, all but the last with
   * `more`; nothing else of that cluster×namespace comes in between (its changes and status follow the last).
   */
  | { t: "rows"; c: string; ns: string | null; reset?: boolean; up?: Row[]; del?: string[]; more?: boolean }
  /** `projection: "names"` views: names added/removed (one entry per object), never updates. Chunked as rows. */
  | { t: "names"; c: string; ns: string | null; reset?: boolean; up?: string[]; del?: string[]; more?: boolean };

export interface ViewBatch {
  t: "batch";
  m: ViewMessage[];
}

export interface ViewSpec {
  resource: string;
  clusters: string[];
  /** empty = all namespaces */
  namespaces: string[];
  labelSelector?: string;
  fieldSelector?: string;
  /**
   * "names": only object names, sent when the set of names changes (pickers over huge lists). "problems": rows of
   * objects that are not fine only — failing, degraded, in progress or being deleted (an object that becomes fine is
   * deleted from the view).
   */
  projection?: "rows" | "names" | "problems";
}

export interface ObjectRef {
  cluster: string;
  resource: string;
  namespace?: string | null;
  name: string;
  uid?: string | null;
}

export interface LogTarget {
  cluster: string;
  namespace: string;
  pod: string;
  container: string;
  /** The pod's uid: a pod re-created under the same name is another target (the deleted one's stream ends). */
  uid?: string;
  /** Identifies the target in messages (`i`); defaults to its position. Needed to change targets later. */
  id?: number;
  /** Its own history instead of a share of the stream's: a read of earlier history asks each container for its own. */
  tailLines?: number;
  /** One-shot reads: the read stops at the first line written after this time (unix millis) — earlier history. */
  until?: number;
}

export interface LogSpec {
  targets: LogTarget[];
  /** Ignored with `previous` (a one-shot read). */
  follow: boolean;
  /** Per container; the engine caps it when there are many. `null`: all lines. */
  tailLines?: number | null;
  sinceSeconds?: number | null;
  previous?: boolean;
  /** What is shown (`deployments.apps shop/web`), for diagnostics only. */
  label?: string;
}

/** `[target id, unix millis | null, text]` */
export type LogLine = [number, number | null, string];

/**
 * - `streaming`: connected, lines arrive as they are written;
 * - `reconnecting`: retrying after a failure;
 * - `waiting`: the container has not started yet or waits to restart (followed once it runs);
 * - `ended`: nothing more to read — read once, pod finished or deleted, container terminated (followed
 *   again if it restarts), or not streamed (too many containers); `message` says which;
 * - `error`: retrying cannot fix it (permissions…), or the cluster is unusable until it reconnects.
 */
export type LogState = "streaming" | "reconnecting" | "waiting" | "ended" | "error";

export type LogMessage = { t: "lines"; l: LogLine[] } | { t: "state"; i: number; state: LogState; message?: string };

/** A running log stream whose targets can change (a workload's pods come and go). */
export interface LogSubscription extends Subscription {
  /** Replaces the targets (told apart by `id`): new ones start, missing ones stop, the rest stream on. */
  setTargets(targets: LogTarget[]): void;
}

export interface TermSize {
  cols: number;
  rows: number;
}

/** A terminal in a container of a pod: a shell in it, or its own console (`attach`). */
export interface TermSpec {
  cluster: string;
  namespace: string;
  pod: string;
  /** The pod's uid: a pod re-created under the same name since it was picked is not entered. */
  uid?: string;
  container: string;
  /** Attach to the container's own process (its stdin and terminal) instead of starting a shell in it. */
  attach?: boolean;
  /** The terminal's size when it opens. */
  size?: TermSize;
}

/** A debug container added to a pod (`kubectl debug -it --image … --target …`) and attached to. */
export interface DebugSpec {
  cluster: string;
  namespace: string;
  pod: string;
  uid?: string;
  image: string;
  /** The container whose processes the debug container sees. */
  target?: string;
  size?: TermSize;
}

/** A shell on a node, in its namespaces, through a privileged helper pod created in `namespace` (deleted afterwards). */
export interface NodeShellSpec {
  cluster: string;
  node: string;
  namespace: string;
  image: string;
  size?: TermSize;
}

/**
 * - `connecting`: waiting for the cluster's connection, creating what the session needs, opening the stream;
 * - `waiting`: the container does not run yet (being created, pulling its image);
 * - `open`: keystrokes go to the container.
 */
export type TermState = "connecting" | "waiting" | "open";

export type TermMessage =
  /** `pod` / `container`: what the session entered, once known (a node shell's helper pod, a debug container). */
  | { t: "state"; state: TermState; message?: string; pod?: string; container?: string }
  /** Output, base64; `n`: its size in bytes (what acknowledgements count). */
  | { t: "out"; d: string; n: number }
  /** Over: the process exited (`code`), or it failed or broke off (`error`, `message`). */
  | { t: "end"; code?: number; message?: string; error: boolean };

/** A running terminal session. */
export interface TermSession extends Subscription {
  /** Keystrokes or pasted text, in order. `binary`: one byte per character (xterm.js's binary input). */
  input(data: string, binary?: boolean): void;
  resize(size: TermSize): void;
  /** The terminal drew this many more bytes of output: the engine stops reading while too much waits. */
  ack(bytes: number): void;
}

/** What to forward a local port to. */
export interface ForwardSpec {
  cluster: string;
  namespace: string;
  /** `pods`, `services`, or a workload (`deployments.apps`, `statefulsets.apps`, `daemonsets.apps`, `replicasets.apps`). */
  resource: string;
  name: string;
  /** The pod's port — or for a service, the service's port (its target port on the pod is looked up). */
  port: number;
  /** The local port; none: the same as `port` when that is free and not privileged, else one the system picks. */
  localPort?: number;
}

/** A running port-forward. */
export interface ForwardInfo {
  id: number;
  spec: ForwardSpec;
  localPort: number;
  /** The pod and port connections go to now. */
  pod?: string;
  podPort?: number;
  /** Local connections open now, and so far. */
  connections: number;
  total: number;
  /** Bytes from local clients to the pod, and back. */
  sent: number;
  received: number;
  /** Why the latest connection failed (cleared by one that worked). */
  error?: string;
  /** Unix seconds. */
  started: number;
}

export type ForwardsMessage = { t: "forwards"; list: ForwardInfo[] };

export type MetricsKind = "pods" | "nodes";

/** Usage of pods or nodes in these clusters and namespaces (empty: all; nodes have none). */
export interface MetricsSpec {
  kind: MetricsKind;
  clusters: string[];
  namespaces?: string[];
}

/** Why there are no numbers (no metrics API on the cluster, no permission, an error), or that there are. */
export type MetricsStatus = { state: "ok" } | { state: "unavailable" | "forbidden" | "error"; message: string };

export type MetricsMessage =
  | ({ t: "status"; c: string; ns: string | null } & MetricsStatus)
  /** Every object of a cluster×namespace, polled at `at` (unix seconds): `[namespace, name, CPU millicores, memory bytes]`. */
  | { t: "usage"; c: string; ns: string | null; at: number; items: [string, string, number, number][] };

/** One object's usage over the last minutes: `[unix seconds, CPU millicores, memory bytes]`, and its containers' now. */
export interface MetricsHistory {
  samples: [number, number, number][];
  containers: [string, number, number][];
}

/** One revision of a Helm release. */
export interface HelmRevision {
  revision: number;
  status: string;
  chart: string;
  appVersion: string;
  /** Unix seconds. */
  updated?: number | null;
  description: string;
}

/** A Helm release in full: its latest revision's values, manifest and notes, and every revision Helm keeps. */
export interface HelmRelease {
  name: string;
  namespace: string;
  revision: number;
  status: string;
  chart: string;
  appVersion: string;
  description: string;
  firstDeployed?: number | null;
  lastDeployed?: number | null;
  notes: string;
  /** The values given at install or upgrade (YAML). */
  values: string;
  /** Those over the chart's defaults: what the templates were rendered with (YAML). */
  computed: string;
  manifest: string;
  /** Newest first. */
  history: HelmRevision[];
}

/** What changed between two revisions: unified diffs. */
export interface HelmDiff {
  values: string;
  manifest: string;
}

/** The graph around one object: what it belongs to and owns, what routes to it, what it uses and what uses it. */
export interface RelationsSpec {
  cluster: string;
  /** The object's resource key. */
  resource: string;
  namespace?: string | null;
  name: string;
}

export type GraphLayer = "release" | "traffic" | "service" | "policy" | "workload" | "replica" | "pod" | "config" | "storage" | "identity" | "node";
export type GraphRel = "owns" | "selects" | "routes" | "tls" | "mounts" | "env" | "pulls" | "runsAs" | "runsOn" | "bound" | "class" | "scales" | "protects" | "isolates" | "subject" | "grants" | "manages";

export interface GraphNode {
  id: string;
  /** Where it opens; none for an object only named (an owner of a kind not read). */
  resource?: string;
  kind: string;
  name: string;
  namespace?: string;
  layer: GraphLayer;
  tone: Tone;
  status?: string;
  /** Referred to, but not there. */
  missing?: boolean;
  /** Every reference to it says it may be missing. */
  optional?: boolean;
  /** Its kind could not be read: whether it is there is not known. */
  unknown?: boolean;
  /** Of an owner: its pods left out of the graph. */
  more?: number;
  /** Of a pod: its owner's id. */
  owner?: string;
  created?: number;
}

export interface GraphEdge {
  from: string;
  to: string;
  rel: GraphRel;
  label?: string;
}

export interface GraphMessage {
  t: "graph";
  /** Empty when the object is not there (yet). */
  focus: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  notes: string[];
  loading: boolean;
  error?: string | null;
}

/** A permission question: may the user `verb` this resource (subresource), in this namespace, this object? */
export interface AccessCheck {
  verb: string;
  /** API group: "" for the core group. */
  group: string;
  /** Plural resource name (`deployments`). */
  resource: string;
  subresource?: string;
  /** None: cluster-wide (or every namespace). */
  namespace?: string | null;
  /** None: any object. */
  name?: string;
}

/** `allowed: null`: unknown (the cluster could not say) — never a reason to refuse. */
export interface AccessDecision {
  allowed: boolean | null;
  reason?: string;
}

/** What the user may do in a namespace (`kubectl auth can-i --list`); `incomplete`: an authorizer could not list all. */
export interface AccessRules {
  resources: { verbs: string[]; groups: string[]; resources: string[]; names?: string[] }[];
  incomplete: boolean;
  error?: string;
}

export interface OpResult {
  target: ObjectRef;
  ok: boolean;
  error?: BackendError;
}

export interface BackendError {
  kind: string;
  message: string;
  code?: number | null;
}

export interface Settings {
  readOnly: boolean;
  feedIdleTtlSecs: number;
}

/** One of the desktop app's two files (crates/k10s-app/src/prefs.rs): what the user sets, and what k10s remembers. */
export type PrefsDoc = "settings" | "state";

/** A value to keep at `key` (`logs.tail`) in a file; null forgets it. */
export interface PrefsChange {
  doc: PrefsDoc;
  key: string;
  value: unknown;
}

/** Both files as the desktop app read them at start. */
export interface PrefsSnapshot {
  settings: Record<string, unknown>;
  state: Record<string, unknown>;
  /** Why `settings.json` can't be read: k10s runs on the defaults, in read-only mode, until it is fixed. */
  settingsError: string | null;
  settingsPath: string | null;
  statePath: string | null;
}

/** `settings.json` after an edit made outside the app. */
export interface SettingsChange {
  settings: Record<string, unknown>;
  /** Why it can't be read: the UI keeps the settings it has, and the engine goes read-only. */
  error: string | null;
  /** The engine's settings it holds, which the engine took. */
  engine: Settings;
}

export interface HubStats {
  feeds: number;
  active: number;
  objects: number;
  /** Object JSON kept by the feeds, in bytes. */
  jsonBytes: number;
}

export interface AppInfo {
  version: string;
  os: string;
  arch: string;
  /** Folder with the app's log files (desktop app only). */
  logDir?: string | null;
  /** This build updates itself from the project's releases (builds made by the release workflow). */
  updates?: boolean;
}

/** A newer release than the one running. */
export interface UpdateInfo {
  version: string;
  current: string;
  /** When it was published (Unix seconds). */
  date: number | null;
  notes: string | null;
  /** Its page, when there is one to open (`openUpdateNotes`). */
  page: string | null;
  /** Downloaded and its signature verified: installing it takes a restart. */
  ready: boolean;
}

export type ClusterState = "connecting" | "connected" | "error" | "disconnected";

export type EngineEvent =
  | {
      type: "cluster";
      context: string;
      state: ClusterState;
      message?: string;
      version?: string;
    }
  /** The kubeconfig in effect may have changed (login-shell environment imported late): list contexts again. */
  | { type: "contexts" };

/** A live subscription (view, log stream, terminal). */
export interface Subscription {
  close(): void;
}
