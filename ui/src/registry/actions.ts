import type { IconName } from "../components/Icon";
import { type AccessCheck, type AccessDecision, backend, errorMessage, type ResourceInfo, Tone, toError } from "../lib/backend";
import { HELM_RELEASES } from "../lib/helm";
import { registerKeyCommand } from "../lib/keymap";
import { accessKnown, accessNow, accessOf, checkKey, checkText, streamVerb } from "../state/access";
import { clusterColor, clusterStatus, shortName } from "../state/clusters";
import { COMPARE_TAB, compareRows, isPinned, rowRef, togglePins } from "../state/compare";
import { debugImage, type LogSourceDef, nodeShellImage, nodeShellNamespace, openLogs, openTerminal, setDebugImage, setNodeShellImage, setNodeShellNamespace } from "../state/dock";
import { openInBrowser, setOpenInBrowser, startForward } from "../state/forwards";
import { objectRef, openDetails, resourceTitle, unmark } from "../state/nav";
import { ask, busyToast, noteReadOnlyRefusal, readOnly, toast } from "../state/ui";
import type { UIRow } from "../state/view";
import { mainView } from "../state/views";
import { tabKeyId } from "./details";

/**
 * Actions on selected objects — shown in the details header, context menu and command palette.
 * Add new ones with `registerAction` (plugins can do the same).
 *
 * Mutating actions (`mutating: true`) confirm first, list where their targets are, and are disabled in
 * read-only mode — the engine refuses them anyway, this only keeps the UI honest about it. Every one of
 * them is confirmed by typing when it reaches many objects or several clusters (see {@link typedConfirmText}).
 * The built-in ones say that they are running until every request is answered, and are not sent again to
 * rows they are still running on (see `running`).
 */
export interface ActionContext {
  resourceKey: string;
  resource?: ResourceInfo;
  rows: UIRow[];
}

export interface ResourceAction {
  id: string;
  title: string | ((ctx: ActionContext) => string);
  icon: IconName;
  /** Its keys, unless the settings give it others: bind and show them by its command, `actionKeyId(action)`. */
  shortcut?: string | readonly string[];
  /**
   * The details tab it opens, which lends it its key (it has none of its own): that key opens the tab — and on several
   * marked rows, where a tab can't, runs the action (their logs together, a comparison).
   */
  tab?: string;
  danger?: boolean;
  /** Works on several rows at once. */
  multi?: boolean;
  /** Shown as a primary button in the details header. */
  primary?: boolean;
  /** Changes objects: disabled in read-only mode. */
  mutating?: boolean;
  /**
   * Why read-only mode turns it off, when that is not plainly a change to objects: "a shell can change anything in
   * the container" (default: "it changes objects in the cluster").
   */
  readOnlyWhy?: string;
  /**
   * The permissions it takes on one target row (Kubernetes RBAC), asked of the cluster before the action is offered:
   * one the user may not take on any of its rows shows a lock and why; rows it may not act on are left out of it (and
   * said so) — in each cluster on its own. Unknown answers never stop it: the API server still decides.
   */
  needs?: (row: UIRow, ctx: ActionContext) => AccessCheck[];
  /**
   * Set on what `actionsFor` returns for an action that cannot run now: why, in two words ("read-only mode"). Such
   * an action shows a lock and the reason in its title, and running it only explains. Buttons and menu items show
   * it greyed out, with `disabledReason` in their tooltip; the palette and shortcuts run it to explain.
   */
  disabled?: string;
  /** With `disabled`: the whole of it, for tooltips — what turns it off, why, and how to turn it on again. */
  disabledReason?: string;
  /** With `disabled`: what locks it — read-only mode (an amber lock), or missing permissions (a grey one). */
  lock?: "read-only" | "rbac";
  /** Set by `actionsFor` when it may act on some of its rows only: which are left out, and why. */
  note?: string;
  applies(ctx: ActionContext): boolean;
  run(ctx: ActionContext): void | Promise<void>;
}

const actions: ResourceAction[] = [];

export function registerAction(action: ResourceAction) {
  const i = actions.findIndex((a) => a.id === action.id);
  if (i >= 0) actions[i] = action;
  else actions.push(action);
  if (!action.tab)
    registerKeyCommand({
      id: actionKeyId(action),
      scope: "table",
      get title() {
        return keyTitle(action);
      },
      defaults: ([] as string[]).concat(action.shortcut ?? []),
    });
}

/** The keymap's command whose keys run an action: `action.delete` (settings.json: `keys.action.delete`), or its tab's. */
export const actionKeyId = (a: Pick<ResourceAction, "id" | "tab">) => (a.tab ? tabKeyId({ id: a.tab }) : (`action.${a.id}` as const));

/** What an action is called on one object, for the list of keys: "Delete", "Cordon". */
function keyTitle(a: ResourceAction): string {
  const row: UIRow = { key: "", cl: "", u: "", n: "", rv: "", t: 0, s: Tone.Neutral, c: [] };
  try {
    return actionTitle(a, { resourceKey: "", rows: [row] }).replace(/…$/, "");
  } catch {
    return a.id;
  }
}

/** Every action, whatever it applies to, in the order `actionsFor` lists them. */
export const allActions = (): readonly ResourceAction[] => actions;

export function actionsFor(ctx: ActionContext): ResourceAction[] {
  if (!ctx.rows.length) return [];
  const ro = readOnly();
  return actions.filter((a) => offered(a, ctx)).map((a) => asOffered(a, ctx, ro));
}

/**
 * One action as `actionsFor` has it (undefined where it doesn't): what its key runs. Only that action is looked at —
 * the others' permissions are not asked, and on many marked rows that is most of the work.
 */
export function actionFor(id: string, ctx: ActionContext): ResourceAction | undefined {
  const a = actions.find((x) => x.id === id);
  return a && ctx.rows.length && offered(a, ctx) ? asOffered(a, ctx, readOnly()) : undefined;
}

/** Whether `a` is offered on what `ctx` holds: rows it applies to — several only if it works on several. */
const offered = (a: ResourceAction, ctx: ActionContext) => (ctx.rows.length === 1 || a.multi) && a.applies(ctx);

/** The action as it can run now: locked by read-only mode or missing permissions, or left to the rows allowed. */
function asOffered(a: ResourceAction, ctx: ActionContext, ro: boolean): ResourceAction {
  if (ro && a.mutating) return blockedByReadOnly(a, ctx);
  if (!a.needs) return a;
  // Reactive: buttons lock (or unlock) as the cluster answers.
  const denied = deniedRows(a, ctx, accessOf);
  if (denied.size && denied.size === ctx.rows.length) return blockedByAccess(a, ctx, denied);
  return withAccessGate(a, denied.size ? `${denied.size} of ${ctx.rows.length} not allowed — you may not ${denialSummary(denied)} — they are left out` : undefined);
}

export const actionTitle = (a: ResourceAction, ctx: ActionContext) => (typeof a.title === "function" ? a.title(ctx) : a.title);

/** The title without why the action is disabled: a label next to its lock, whose tooltip ({@link actionTitle}) says why. */
export function actionLabel(a: ResourceAction, ctx: ActionContext): string {
  const title = actionTitle(a, ctx);
  return a.disabled ? title.replace(` (${a.disabled})`, "") : title;
}

export const READ_ONLY_HINT = "read-only mode";

const READ_ONLY_WAY_OUT = "Turn read-only mode off in the status bar (it asks to confirm) to use it.";

/**
 * A mutating action while read-only mode is on: a lock, the reason in its title and tooltip (said to be read-only
 * mode's doing, not missing permissions), and an explanation instead of a confirmation.
 */
function blockedByReadOnly(a: ResourceAction, ctx: ActionContext): ResourceAction {
  // "Shell — off in read-only mode: a shell can change anything in the container. Turn read-only mode off…"
  const reason = (c: ActionContext) => `${actionTitle(a, c).replace(/…$/, "")} — off in read-only mode: ${a.readOnlyWhy ?? "it changes objects in the cluster"}. ${READ_ONLY_WAY_OUT}`;
  return {
    ...a,
    icon: "lock",
    danger: false,
    disabled: READ_ONLY_HINT,
    lock: "read-only",
    disabledReason: reason(ctx),
    title: (c) => `${actionTitle(a, c)} (${READ_ONLY_HINT})`,
    run: (c) => toast("info", "Read-only mode is on", reason(c)),
  };
}

// ---------------------------------------------------------------------------------------------
// Permissions (RBAC), asked before acting
// ---------------------------------------------------------------------------------------------

export const NO_PERMISSION_HINT = "no permission";

/** Rows past this many are judged by their namespace's answer alone: asking about each object would flood the cluster. */
export const NAME_CHECKS_MAX = 50;

/** Why one row was refused: what the user may not do, and where. */
interface Denial {
  /** "patch deployments in payments" */
  what: string;
  cluster: string;
}

type Lookup = (cluster: string, check: AccessCheck) => AccessDecision | undefined;

/** The question for any object (a namespace-wide permission answers for all its objects). */
const broad = (c: AccessCheck): AccessCheck => (c.name ? { ...c, name: undefined } : c);

/**
 * Rows `a` may not act on, by row key, from the decisions `look` knows. The namespace's answer is asked first; where it
 * says no, the object's own (RBAC may grant a role on named objects only), for up to {@link NAME_CHECKS_MAX} rows. A row
 * whose decisions are unknown, or not in yet, is not refused.
 */
function deniedRows(a: ResourceAction, ctx: ActionContext, lookUp: Lookup): Map<string, Denial> {
  // Rows mostly ask the same (one namespace, one cluster): each question is looked up once — `accessOf` is reactive,
  // and every look would be one more subscription.
  const known = new Map<string, AccessDecision | undefined>();
  const look: Lookup = (cluster, c) => {
    const k = checkKey(cluster, c);
    if (known.has(k)) return known.get(k);
    const d = lookUp(cluster, c);
    known.set(k, d);
    return d;
  };
  const out = new Map<string, Denial>();
  const named = ctx.rows.length <= NAME_CHECKS_MAX;
  for (const row of ctx.rows) {
    for (const check of a.needs!(row, ctx)) {
      if (look(row.cl, broad(check))?.allowed !== false) continue;
      if (check.name && named && look(row.cl, check)?.allowed !== false) continue;
      out.set(row.key, { what: `${checkText(check)}${check.namespace ? ` in ${check.namespace}` : ""}`, cluster: row.cl });
      break;
    }
  }
  return out;
}

/** {@link deniedRows}, with every decision it takes asked for and waited for (a few seconds at most). */
async function deniedNow(a: ResourceAction, ctx: ActionContext): Promise<Map<string, Denial>> {
  const known = new Map<string, AccessDecision>();
  const look: Lookup = (cluster, c) => known.get(checkKey(cluster, c));
  const learn = async (pairs: [string, AccessCheck][]) => {
    const byCluster = new Map<string, Map<string, AccessCheck>>();
    for (const [cluster, c] of pairs) {
      let m = byCluster.get(cluster);
      if (!m) byCluster.set(cluster, (m = new Map()));
      m.set(checkKey(cluster, c), c);
    }
    await Promise.all(
      [...byCluster].map(async ([cluster, checks]) => {
        const list = [...checks.values()];
        const decisions = await accessNow(cluster, list);
        list.forEach((c, i) => known.set(checkKey(cluster, c), decisions[i]));
      }),
    );
  };
  const needs = ctx.rows.map((row) => [row, a.needs!(row, ctx)] as const);
  await learn(needs.flatMap(([row, checks]) => checks.map((c): [string, AccessCheck] => [row.cl, broad(c)])));
  if (ctx.rows.length <= NAME_CHECKS_MAX) await learn(needs.flatMap(([row, checks]) => checks.filter((c) => c.name && look(row.cl, broad(c))?.allowed === false).map((c): [string, AccessCheck] => [row.cl, c])));
  return deniedRows(a, ctx, look);
}

/** {@link deniedRows} if every decision it takes is known already (then nothing is waited for), else undefined. */
function knownDenials(a: ResourceAction, ctx: ActionContext): Map<string, Denial> | undefined {
  let complete = true;
  const denied = deniedRows(a, ctx, (cluster, c) => {
    const d = accessKnown(cluster, c);
    if (!d) complete = false;
    return d;
  });
  return complete ? denied : undefined;
}

/** "patch deployments in payments on z3, z4; delete pods in shop on z1" */
export function denialSummary(denied: Map<string, Denial>): string {
  const by = new Map<string, Set<string>>();
  for (const d of denied.values()) {
    let clusters = by.get(d.what);
    if (!clusters) by.set(d.what, (clusters = new Set()));
    clusters.add(d.cluster);
  }
  return [...by].map(([what, clusters]) => `${what} on ${[...clusters].map(shortName).join(", ")}`).join("; ");
}

const RBAC_WAY_OUT = "Permissions come from the cluster's RBAC: its admins can grant them.";

/** An action the user may not take on any of its rows: a grey lock, and why — said to be permissions, not read-only mode. */
function blockedByAccess(a: ResourceAction, ctx: ActionContext, denied: Map<string, Denial>): ResourceAction {
  const reason = (c: ActionContext) => `${actionTitle(a, c).replace(/…$/, "")} — not allowed: you may not ${denialSummary(denied)}. ${RBAC_WAY_OUT}`;
  return {
    ...a,
    icon: "lock",
    danger: false,
    disabled: NO_PERMISSION_HINT,
    lock: "rbac",
    disabledReason: reason(ctx),
    title: (c) => `${actionTitle(a, c)} (${NO_PERMISSION_HINT})`,
    run: (c) => toast("info", `No permission: ${actionTitle(a, c).replace(/…$/, "")}`, `You may not ${denialSummary(denied)}. ${RBAC_WAY_OUT}`),
  };
}

/**
 * Runs `a` on the rows the user may act on — with decisions not in yet asked for and waited for first, so what the API
 * server would refuse is said before anything is confirmed. Rows left out are said so; none left: only explains.
 */
function withAccessGate(a: ResourceAction, note: string | undefined): ResourceAction {
  const proceed = (c: ActionContext, denied: Map<string, Denial>) => {
    if (!denied.size) return a.run(c);
    const why = `You may not ${denialSummary(denied)}.`;
    if (denied.size === c.rows.length) {
      toast("info", `No permission: ${actionTitle(a, c).replace(/…$/, "")}`, `${why} ${RBAC_WAY_OUT}`);
      return;
    }
    toast("info", `Left out ${denied.size} of ${c.rows.length}: no permission`, why);
    return a.run({ ...c, rows: c.rows.filter((r) => !denied.has(r.key)) });
  };
  return {
    ...a,
    note,
    // Decisions known already: at once (no dialog waits for nothing); otherwise once they are in.
    run: (c) => {
      const known = knownDenials(a, c);
      return known ? proceed(c, known) : deniedNow(a, c).then((denied) => proceed(c, denied));
    },
  };
}

/** The resource of the table, as access reviews name it (its group and plural). */
function resourceOf(ctx: ActionContext): { group: string; resource: string } {
  if (ctx.resource) return { group: ctx.resource.group, resource: ctx.resource.plural };
  const dot = ctx.resourceKey.indexOf(".");
  return dot < 0 ? { group: "", resource: ctx.resourceKey } : { group: ctx.resourceKey.slice(dot + 1), resource: ctx.resourceKey.slice(0, dot) };
}

/** Takes `verb` on the row itself: `patch deployments payments/web`. */
const own =
  (verb: string) =>
  (row: UIRow, ctx: ActionContext): AccessCheck[] => [{ verb, ...resourceOf(ctx), namespace: row.ns ?? null, name: row.n }];

/** Takes a subresource of the pod: `patch pods/ephemeralcontainers`; `stream` for a stream into it (exec, attach). */
const podPart =
  (verb: string, subresource: string) =>
  (row: UIRow): AccessCheck[] => [{ verb: verb === "stream" ? streamVerb(clusterStatus[row.cl]?.version) : verb, group: "", resource: "pods", subresource, namespace: row.ns ?? null, name: row.n }];

const can = (ctx: ActionContext, verb: string) => !ctx.resource || ctx.resource.verbs.includes(verb);
const is = (ctx: ActionContext, ...keys: string[]) => keys.includes(ctx.resourceKey);
const WORKLOADS = ["deployments.apps", "statefulsets.apps", "daemonsets.apps", "replicasets.apps", "jobs.batch"];

/** Dialog list of the targets: every row with its namespace and cluster, plus optional details. */
function items(ctx: ActionContext, extra?: (r: UIRow) => string | undefined) {
  return ctx.rows.map((r) => ({
    label: r.ns ? `${r.ns}/${r.n}` : r.n,
    meta: [shortName(r.cl), extra?.(r)].filter(Boolean).join(" · "),
    color: clusterColor(r.cl),
  }));
}

/** "payments-api" for one row, "3 deployments" for several. */
function what(ctx: ActionContext): string {
  return ctx.rows.length > 1 ? `${ctx.rows.length} ${resourceTitle(ctx.resourceKey).toLowerCase()}` : ctx.rows[0].n;
}

/** Objects per cluster, for confirmations: which clusters an action reaches and how far. */
export function breakdown(rows: UIRow[]) {
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.cl, (counts.get(r.cl) ?? 0) + 1);
  return [...counts].map(([cl, count]) => ({ label: cl, count, color: clusterColor(cl) }));
}

/** Where a row lives, for result messages: rows with the same name differ only by cluster/namespace. */
const place = (r: UIRow) => `${shortName(r.cl)} ${r.ns ? `${r.ns}/` : ""}${r.n}`;

/** Toasts show this many failures; "Copy details" has them all. */
const FAILURES_SHOWN = 5;

/** A change to objects, as its messages name it. */
interface Change {
  /** The action's id: an action is sent to a row once at a time (see `running`). */
  action: string;
  /** "restarting": "Restarting 3 deployments…" while it runs, "Already restarting 3 of these". */
  doing: string;
  /** "Restarted": "Restarted 3 objects". */
  done: string;
  /** "Restart": "Restart failed for 2 of 3". */
  failed: string;
  /** Said after the objects: "to 3" (scale). */
  to?: string;
}

/**
 * Reports a change: rows that succeeded are unmarked and counted; failures stay on screen until
 * dismissed, with their cluster and namespace, and "Copy details" copies every one with the full
 * cluster name. `errors[i]`: why row i failed, undefined if it succeeded.
 */
function report(change: Change, resourceKey: string, rows: UIRow[], errors: (unknown | undefined)[]) {
  const okRows = rows.filter((_, i) => errors[i] === undefined);
  const failedAt = rows.flatMap((_, i) => (errors[i] === undefined ? [] : [i]));
  unmark(okRows.map((r) => r.key));
  if (okRows.length) toast("success", `${change.done} ${okRows.length === 1 ? okRows[0].n : `${okRows.length} objects`}${change.to ? ` ${change.to}` : ""}`);
  if (!failedAt.length) return;
  if (failedAt.some((i) => toError(errors[i]).kind === "readOnly")) noteReadOnlyRefusal();
  const n = failedAt.length;
  const title = `${change.failed} failed for ${n === rows.length ? (n === 1 ? rows[0].n : `all ${n}`) : `${n} of ${rows.length}`}`;
  const shown = failedAt.slice(0, FAILURES_SHOWN).map((i) => `${place(rows[i])}: ${errorMessage(errors[i])}`);
  const more = n > FAILURES_SHOWN ? `\n…and ${n - FAILURES_SHOWN} more` : "";
  const copy = [`${title} (${resourceKey})`, ...failedAt.map((i) => `${rows[i].cl}\t${rows[i].ns ?? "-"}\t${rows[i].n}\t${errorMessage(errors[i])}`)].join("\n");
  toast("error", title, shown.join("\n") + more, { sticky: true, copy });
}

/** A single operation failed: on screen until dismissed, with where it was. */
function failed(title: string, row: UIRow, e: unknown) {
  if (toError(e).kind === "readOnly") noteReadOnlyRefusal();
  toast("error", title, `${place(row)}: ${errorMessage(e)}`, { sticky: true, copy: `${title}\n${row.cl}\t${row.ns ?? "-"}\t${row.n}\t${errorMessage(e)}` });
}

// ---------------------------------------------------------------------------------------------
// Changes in flight
// ---------------------------------------------------------------------------------------------

/**
 * Rows a change is being sent to, by action (`${action}\n${row key}` → what it does there: "restarting"). Until
 * every request of a change is answered — up to a minute and more when a cluster is slow or unreachable — the
 * same action is not sent to those rows again: a second ⇧R would roll a deployment out twice, a second scale
 * race the first.
 *
 * Rows an action is still running on are left out before its confirmation, not after it: the confirmation then
 * lists (and the typed confirmation counts) exactly what will be sent, and pressing the key again while it runs
 * says so at once instead of asking to confirm what would not happen. Once confirmed, the rows are checked again
 * as they are claimed: the confirmation stays open as long as the user likes.
 */
const running = new Map<string, string>();
const runningKey = (action: string, row: UIRow) => `${action}\n${row.key}`;

/** The rows of `ctx` that `action` is not running on (undefined: none), with an info toast if it is on any. */
function notRunning(ctx: ActionContext, action: string): ActionContext | undefined {
  const rows = ctx.rows.filter((r) => !running.has(runningKey(action, r)));
  const busy = ctx.rows.length - rows.length;
  if (!busy) return ctx;
  // What is being done (cordoning), which need not be what was asked for this time (uncordon).
  const doing = running.get(runningKey(action, ctx.rows.find((r) => running.has(runningKey(action, r)))!));
  if (!rows.length) toast("info", `Already ${doing} ${what(ctx)}`, "The result shows once every request is answered.");
  else toast("info", `Already ${doing} ${busy} of these`, "They are left out: the change sent before is still waiting for an answer.");
  return rows.length ? { ...ctx, rows } : undefined;
}

/** Registers a mutating action. Rows it is still running on are left out of it (see `running`). */
function registerChange(action: Omit<ResourceAction, "mutating">) {
  registerAction({
    ...action,
    mutating: true,
    run: (ctx) => {
      const free = notRunning(ctx, action.id);
      return free && action.run(free);
    },
  });
}

/**
 * Claims the rows of a confirmed change (see `running`) and says that it runs, until `end` — called once every
 * request is answered, before the result is reported. Undefined when it runs on every row already.
 */
function start(ctx: ActionContext, change: Pick<Change, "action" | "doing" | "to">): { ctx: ActionContext; end: () => void } | undefined {
  const free = notRunning(ctx, change.action);
  if (!free) return undefined;
  const keys = free.rows.map((r) => runningKey(change.action, r));
  for (const k of keys) running.set(k, change.doing);
  const hide = busyToast(`${change.doing[0].toUpperCase()}${change.doing.slice(1)} ${what(free)}${change.to ? ` ${change.to}` : ""}…`);
  return {
    ctx: free,
    end: () => {
      for (const k of keys) running.delete(k);
      hide();
    },
  };
}

/** Sends a confirmed change to every row at once (see `start`) and reports how each request went. */
async function runAll(ctx: ActionContext, change: Change, op: (row: UIRow) => Promise<unknown>) {
  const run = start(ctx, change);
  if (!run) return;
  // `async`: a request that throws before it is sent fails its row like any other.
  const results = await Promise.allSettled(run.ctx.rows.map(async (r) => op(r)));
  run.end();
  report(change, ctx.resourceKey, run.ctx.rows, results.map((r) => (r.status === "rejected" ? (r.reason ?? "failed") : undefined)));
}

/** Why a replica count is invalid, or null. Empty input blocks confirming without a message. */
export function replicasError(value: string): string | null {
  const v = value.trim();
  if (!v) return "";
  if (!/^\d+$/.test(v)) return "Enter a whole number of replicas (0 or more)";
  if (Number(v) > 10_000) return "That is more than 10,000 replicas";
  return null;
}

registerAction({
  id: "logs",
  title: (ctx) => (ctx.rows.length > 1 ? "Logs, together (in the dock)" : "Logs"),
  icon: "logs",
  tab: "logs",
  primary: true,
  multi: true,
  // A workload's logs are its pods': any of them in its namespace.
  needs: (row, ctx) => [{ verb: "get", group: "", resource: "pods", subresource: "log", namespace: row.ns ?? null, name: ctx.resourceKey === "pods" ? row.n : undefined }],
  // A service's: the pods behind it.
  applies: (ctx) => is(ctx, "pods", "services", ...WORKLOADS),
  // Several: their logs merged into one timeline in a dock tab — pods or workloads, from any clusters.
  run: (ctx) => (ctx.rows.length === 1 ? openDetails(ctx.rows[0].key, "logs") : openLogsTogether(ctx)),
});

/** A text cell of a row of the table, by column id. */
function cellText(row: UIRow, id: string): string | undefined {
  const k = mainView?.columns().findIndex((c) => c.id === id) ?? -1;
  const v = k >= 0 ? row.c[k] : undefined;
  return typeof v === "string" && v ? v : undefined;
}

/** The logs of several pods or workloads in one dock tab; a workload picked in several clusters is one source. */
export function openLogsTogether(ctx: ActionContext) {
  const sources: LogSourceDef[] = [];
  const bySelector = new Map<string, Extract<LogSourceDef, { kind: "selector" }>>();
  const skipped: string[] = [];
  for (const r of ctx.rows) {
    const containers = cellText(r, "containers")?.split(",");
    if (ctx.resourceKey === "pods") {
      sources.push({ kind: "pod", cluster: r.cl, namespace: r.ns ?? "", name: r.n, uid: r.u, containers });
      continue;
    }
    const selector = cellText(r, "selector");
    if (!selector) {
      skipped.push(r.n);
      continue;
    }
    const key = `${r.ns}\n${selector}`;
    const same = bySelector.get(key);
    if (same) same.clusters.push(r.cl);
    else {
      const s: Extract<LogSourceDef, { kind: "selector" }> = { kind: "selector", clusters: [r.cl], namespace: r.ns ?? "", selector, title: r.n, containers };
      bySelector.set(key, s);
      sources.push(s);
    }
  }
  if (!sources.length) {
    toast("info", "No logs to show", `${skipped.join(", ")}: no pod selector to find their pods by (matchExpressions only?). Open them one by one.`);
    return;
  }
  const names = [...new Set(ctx.rows.filter((r) => !skipped.includes(r.n)).map((r) => r.n))];
  openLogs({ title: names.length === 1 ? names[0] : `${names[0]} +${names.length - 1}`, cluster: ctx.rows[0].cl, sources, container: null });
  if (skipped.length) toast("info", `Left out ${skipped.length}`, `${skipped.join(", ")}: no pod selector to find their pods by.`);
}

// ---------------------------------------------------------------------------------------------
// Terminals (they open in the dock and stay there while the views change)
// ---------------------------------------------------------------------------------------------

interface ContainerInfo {
  name: string;
  /** Kind (sidecar, debug) and state, for pickers. */
  meta: string;
  running: boolean;
  /** Takes input (`stdin: true`): what attaching needs. */
  stdin: boolean;
  /** An ephemeral (debug) container. */
  debug: boolean;
}

/**
 * A pod's containers terminals can open in: regular ones, init containers that keep running (sidecars), debug
 * containers — with what each does now — and kubectl's default one (its annotation, else the first).
 */
async function podContainers(row: UIRow): Promise<{ containers: ContainerInfo[]; preferred?: string }> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type K = any;
  const pod: K = await backend().getObject(objectRef(row, "pods"));
  const states = new Map<string, K>();
  for (const st of [...(pod.status?.containerStatuses ?? []), ...(pod.status?.initContainerStatuses ?? []), ...(pod.status?.ephemeralContainerStatuses ?? [])]) states.set(st.name, st.state ?? {});
  const info = (c: K, kind: string | undefined, debug = false): ContainerInfo => {
    const st = states.get(c.name) ?? {};
    const state = st.running ? "running" : (st.waiting?.reason ?? (st.terminated ? `exited (${st.terminated.reason ?? st.terminated.exitCode})` : "not started"));
    return { name: c.name, meta: [kind, state].filter(Boolean).join(" · "), running: !!st.running, stdin: !!c.stdin, debug };
  };
  const containers = [
    ...((pod.spec?.containers ?? []) as K[]).map((c) => info(c, undefined)),
    ...((pod.spec?.initContainers ?? []) as K[]).filter((c) => c.restartPolicy === "Always").map((c) => info(c, "sidecar")),
    ...((pod.spec?.ephemeralContainers ?? []) as K[]).map((c) => info(c, "debug", true)),
  ];
  const annotated = pod.metadata?.annotations?.["kubectl.kubernetes.io/default-container"];
  return { containers, preferred: containers.some((c) => c.name === annotated) ? annotated : containers[0]?.name };
}

/**
 * The container of `row` to open a terminal in, among those `fits`: the only one, else the user picks (kubectl's
 * default one first). Undefined (said why) when none fits or the pod cannot be read.
 */
async function pickContainer(row: UIRow, title: string, fits: (c: ContainerInfo) => boolean, none: (all: ContainerInfo[]) => [string, string]): Promise<string | undefined> {
  let found: Awaited<ReturnType<typeof podContainers>>;
  try {
    found = await podContainers(row);
  } catch (e) {
    failed(`Could not read ${row.n}`, row, e);
    return undefined;
  }
  const fitting = found.containers.filter(fits);
  if (!fitting.length) {
    toast("info", ...none(found.containers));
    return undefined;
  }
  if (fitting.length === 1) return fitting[0].name;
  const res = await ask({
    title,
    choice: {
      label: "Container",
      options: fitting.map((c) => ({ value: c.name, label: c.name, meta: c.meta })),
      value: fitting.some((c) => c.name === found.preferred) ? found.preferred! : fitting[0].name,
    },
    confirmLabel: "Open",
  });
  return res?.choice;
}

const notRunningNote = (row: UIRow) => (all: ContainerInfo[]): [string, string] => [`No container of ${row.n} is running`, all.map((c) => `${c.name}: ${c.meta}`).join("\n")];

// Entering a container can change anything in it: like changes, refused in read-only mode (by the engine too).
registerAction({
  id: "shell",
  title: "Shell",
  icon: "terminal",
  shortcut: "s",
  primary: true,
  mutating: true,
  readOnlyWhy: "a shell can change anything in the container",
  needs: podPart("stream", "exec"),
  applies: (ctx) => is(ctx, "pods"),
  async run(ctx) {
    const row = ctx.rows[0];
    const container = await pickContainer(row, `Shell in ${row.n}`, (c) => c.running, notRunningNote(row));
    if (container) openTerminal({ kind: "shell", spec: { cluster: row.cl, namespace: row.ns ?? "default", pod: row.n, uid: row.u, container } });
  },
});

registerAction({
  id: "attach",
  title: "Attach",
  icon: "link",
  shortcut: "a",
  mutating: true,
  readOnlyWhy: "what you type goes to the container's own process",
  needs: podPart("stream", "attach"),
  applies: (ctx) => is(ctx, "pods"),
  async run(ctx) {
    const row = ctx.rows[0];
    const container = await pickContainer(
      row,
      `Attach to ${row.n}`,
      (c) => c.running && c.stdin,
      () => [`No running container of ${row.n} takes input`, "Attaching works with containers that keep stdin open (stdin: true). What the others write is in their logs (L)."],
    );
    if (container) openTerminal({ kind: "attach", spec: { cluster: row.cl, namespace: row.ns ?? "default", pod: row.n, uid: row.u, container, attach: true } });
  },
});

// ---------------------------------------------------------------------------------------------
// Port-forwards (they run in the engine until stopped, listed in the dock)
// ---------------------------------------------------------------------------------------------

/** Kinds a port-forward can go to: pods, services (one of their ready pods), workloads (one of their pods). */
const FORWARDABLE = ["pods", "services", "deployments.apps", "statefulsets.apps", "daemonsets.apps", "replicasets.apps"];

interface PortOption {
  port: number;
  /** "8080 http" */
  label: string;
  /** Its container, or for a service where it goes ("→ 8080"). */
  meta?: string;
}

/** The TCP ports an object declares: its containers' (a pod's, a workload's template's), or a service's own. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function declaredPorts(resourceKey: string, obj: any): PortOption[] {
  const tcp = (p: { protocol?: string }) => !p.protocol || p.protocol === "TCP";
  const seen = new Set<number>();
  const out: PortOption[] = [];
  const add = (o: PortOption) => {
    if (seen.has(o.port)) return;
    seen.add(o.port);
    out.push(o);
  };
  if (resourceKey === "services") {
    for (const p of obj?.spec?.ports ?? []) if (tcp(p) && p.port) add({ port: p.port, label: `${p.port}${p.name ? ` ${p.name}` : ""}`, meta: p.targetPort !== undefined && p.targetPort !== p.port ? `→ ${p.targetPort}` : undefined });
    return out;
  }
  const spec = resourceKey === "pods" ? obj?.spec : obj?.spec?.template?.spec;
  for (const c of spec?.containers ?? []) for (const p of c.ports ?? []) if (tcp(p) && p.containerPort) add({ port: p.containerPort, label: `${p.containerPort}${p.name ? ` ${p.name}` : ""}`, meta: c.name });
  return out;
}

/** Why a port number is wrong, or null. */
export function portError(value: string): string | null {
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535) return "A port is a number from 1 to 65535";
  return null;
}

// Forwarding changes nothing in the cluster: it works in read-only mode too.
registerAction({
  id: "port-forward",
  title: "Port forward…",
  icon: "link",
  shortcut: "shift+f",
  // To a service or workload: through one of its pods, picked later — any pod of the namespace.
  needs: (row, ctx) => [{ verb: streamVerb(clusterStatus[row.cl]?.version), group: "", resource: "pods", subresource: "portforward", namespace: row.ns ?? null, name: ctx.resourceKey === "pods" ? row.n : undefined }],
  applies: (ctx) => is(ctx, ...FORWARDABLE),
  async run(ctx) {
    const row = ctx.rows[0];
    let obj: unknown;
    try {
      obj = await backend().getObject(objectRef(row, ctx.resourceKey));
    } catch (e) {
      failed(`Could not read ${row.n}`, row, e);
      return;
    }
    const ports = declaredPorts(ctx.resourceKey, obj);
    const behind = ctx.resourceKey === "pods" ? "" : " Connections go to one of its ready pods; when that one goes away, to another.";
    const res = await ask({
      title: `Forward a port of ${row.n}`,
      body: `A port on this computer that leads to the ${ctx.resourceKey === "services" ? "service" : ctx.resourceKey === "pods" ? "pod" : "workload"}.${behind}`,
      breakdown: breakdown(ctx.rows),
      items: items(ctx),
      choice: ports.length ? { label: ctx.resourceKey === "services" ? "Service port" : "Port", options: ports.map((p) => ({ value: String(p.port), label: p.label, meta: p.meta })), value: String(ports[0].port) } : undefined,
      fields: [
        ...(ports.length ? [] : [{ label: ctx.resourceKey === "services" ? "Service port" : "Port in the pod", value: "", placeholder: "8080", validate: portError }]),
        { label: "Local port", value: "", placeholder: "the same if free, else any", optional: true, validate: portError },
      ],
      checkbox: { label: "Open in the browser", value: openInBrowser() },
      confirmLabel: "Forward",
    });
    if (!res) return;
    const typed = res.fields ?? [];
    const remote = Number(ports.length ? res.choice : typed[0]);
    const local = typed.at(-1) ? Number(typed.at(-1)) : undefined;
    if (!remote || portError(String(remote)) !== null) return;
    setOpenInBrowser(!!res.checkbox);
    await startForward({ cluster: row.cl, namespace: row.ns ?? "default", resource: ctx.resourceKey, name: row.n, port: remote, localPort: local }, !!res.checkbox);
  },
});

registerAction({
  id: "yaml",
  title: "YAML",
  icon: "code",
  tab: "yaml",
  applies: (ctx) => ctx.resourceKey !== HELM_RELEASES,
  run: (ctx) => openDetails(ctx.rows[0].key, "yaml"),
});

registerAction({
  id: "events",
  title: "Events",
  icon: "event",
  tab: "events",
  applies: (ctx) => !is(ctx, "events", "events.events.k8s.io", HELM_RELEASES),
  run: (ctx) => openDetails(ctx.rows[0].key, "events"),
});

/** Kubernetes objects compare: not events (records of what happened), nor Helm releases. */
const comparable = (ctx: ActionContext) => !is(ctx, "events", "events.events.k8s.io", HELM_RELEASES);

// Several: the first compared with the others (pinned for it); one: its Compare tab.
registerAction({
  id: "compare",
  title: (ctx) => (ctx.rows.length > 1 ? `Compare ${ctx.rows.length}` : "Compare"),
  icon: "compare",
  tab: COMPARE_TAB,
  multi: true,
  applies: comparable,
  run: (ctx) => (ctx.rows.length > 1 ? compareRows(ctx.rows, ctx.resourceKey) : openDetails(ctx.rows[0].key, COMPARE_TAB)),
});

registerAction({
  id: "compare-pin",
  title: (ctx) => {
    const n = ctx.rows.length > 1 ? ` ${ctx.rows.length}` : "";
    return ctx.rows.every((r) => isPinned(rowRef(r, ctx.resourceKey))) ? `Unpin${n} from compare` : `Pin${n} to compare`;
  },
  icon: "pin",
  shortcut: "+",
  multi: true,
  applies: comparable,
  run(ctx) {
    const refs = ctx.rows.map((r) => rowRef(r, ctx.resourceKey));
    const unpin = refs.every(isPinned);
    togglePins(refs);
    const what = refs.length > 1 ? `${refs.length} ${resourceTitle(ctx.resourceKey).toLowerCase()}` : `${refs[0].name} (${shortName(refs[0].cluster)})`;
    if (unpin) toast("info", `Unpinned ${what}`);
    else toast("info", `Pinned ${what} to compare`, "Open Compare (=) on another object — of any cluster, namespace or kind — to compare it with what is pinned.");
  },
});

registerChange({
  id: "restart",
  title: "Restart",
  icon: "restart",
  shortcut: "shift+r",
  multi: true,
  primary: true,
  needs: own("patch"),
  applies: (ctx) => is(ctx, "deployments.apps", "statefulsets.apps", "daemonsets.apps") && can(ctx, "patch"),
  async run(ctx) {
    const ok = await ask({
      title: `Restart ${what(ctx)}?`,
      body: "Performs a rolling restart (like `kubectl rollout restart`). Pods are replaced respecting the rollout strategy.",
      breakdown: breakdown(ctx.rows),
      items: items(ctx),
      confirmLabel: "Restart",
      confirmText: typedConfirmText(ctx, "restart"),
    });
    if (ok) await runAll(ctx, { action: "restart", doing: "restarting", done: "Restarted", failed: "Restart" }, (r) => backend().restart(objectRef(r, ctx.resourceKey)));
  },
});

registerChange({
  id: "scale",
  title: "Scale…",
  icon: "scale",
  shortcut: "shift+s",
  multi: true,
  needs: own("patch"),
  applies: (ctx) => is(ctx, "deployments.apps", "statefulsets.apps", "replicasets.apps") && can(ctx, "patch"),
  async run(ctx) {
    // Current desired replicas (the ratio cell is [ready, desired]); prefilled only when all rows agree.
    const desired = (r: UIRow) => (Array.isArray(r.c[0]) ? String(r.c[0][1]) : undefined);
    const all = ctx.rows.map(desired);
    const current = all[0] !== undefined && all.every((d) => d === all[0]) ? all[0] : "";
    const res = await ask({
      title: `Scale ${what(ctx)}`,
      body: "Desired number of replicas:",
      breakdown: breakdown(ctx.rows),
      items: items(ctx, (r) => (desired(r) !== undefined ? `${desired(r)} now` : undefined)),
      confirmLabel: "Scale",
      input: { value: current, type: "text", placeholder: "replicas" },
      validate: replicasError,
      confirmText: typedConfirmText(ctx, "scale"),
    });
    // `validate` already blocks bad input; this is the last line of defence before the API call.
    if (!res || replicasError(res.input ?? "") !== null) return;
    const n = Number(res.input!.trim());
    // Scaling to 0 asks again, with a click: what reaches many objects or clusters was typed for above.
    if (n === 0) {
      const sure = await ask({
        title: `Scale ${what(ctx)} to 0?`,
        body: "Every pod will be terminated.",
        breakdown: breakdown(ctx.rows),
        items: items(ctx, (r) => (desired(r) !== undefined ? `${desired(r)} → 0` : undefined)),
        confirmLabel: "Scale to 0",
        danger: true,
      });
      if (!sure) return;
    }
    await runAll(ctx, { action: "scale", doing: "scaling", done: "Scaled", failed: "Scale", to: `to ${n}` }, (r) => backend().scale(objectRef(r, ctx.resourceKey), n));
  },
});

registerChange({
  id: "cordon",
  title: (ctx) => (ctx.rows.every((r) => Array.isArray(r.c[0]) && String(r.c[0][0]).includes("SchedulingDisabled")) ? "Uncordon" : "Cordon"),
  icon: "ban",
  multi: true,
  needs: own("patch"),
  applies: (ctx) => is(ctx, "nodes") && can(ctx, "patch"),
  async run(ctx) {
    const uncordon = ctx.rows.every((r) => Array.isArray(r.c[0]) && String(r.c[0][0]).includes("SchedulingDisabled"));
    const verb = uncordon ? "Uncordon" : "Cordon";
    const ok = await ask({
      title: `${verb} ${ctx.rows.length} node${ctx.rows.length > 1 ? "s" : ""}?`,
      breakdown: breakdown(ctx.rows),
      items: items(ctx),
      confirmLabel: verb,
      danger: !uncordon,
      confirmText: typedConfirmText(ctx, verb.toLowerCase()),
    });
    const change = { action: "cordon", doing: uncordon ? "uncordoning" : "cordoning", done: uncordon ? "Uncordoned" : "Cordoned", failed: verb };
    if (ok) await runAll(ctx, change, (r) => backend().setUnschedulable(objectRef(r, ctx.resourceKey), !uncordon));
  },
});

registerChange({
  id: "suspend",
  title: (ctx) => (ctx.rows.every((r) => r.c[2] === true) ? "Resume" : "Suspend"),
  icon: "pause",
  multi: true,
  needs: own("patch"),
  applies: (ctx) => is(ctx, "cronjobs.batch") && can(ctx, "patch"),
  async run(ctx) {
    const resume = ctx.rows.every((r) => r.c[2] === true);
    const verb = resume ? "Resume" : "Suspend";
    const ok = await ask({
      title: `${verb} ${what(ctx)}?`,
      body: resume ? "Scheduled runs start again." : "No new jobs are scheduled until resumed; running jobs continue.",
      breakdown: breakdown(ctx.rows),
      items: items(ctx),
      confirmLabel: verb,
      confirmText: typedConfirmText(ctx, verb.toLowerCase()),
    });
    const change = { action: "suspend", doing: resume ? "resuming" : "suspending", done: resume ? "Resumed" : "Suspended", failed: verb };
    if (ok) await runAll(ctx, change, (r) => backend().setSuspend(objectRef(r, ctx.resourceKey), !resume));
  },
});

// One confirmation creates one Job: a CronJob with a manual run in flight is not run again meanwhile (see `running`).
registerChange({
  id: "trigger",
  title: "Trigger now",
  icon: "play",
  needs: (row) => [{ verb: "create", group: "batch", resource: "jobs", namespace: row.ns ?? null }],
  applies: (ctx) => is(ctx, "cronjobs.batch"),
  async run(ctx) {
    const row = ctx.rows[0];
    const ok = await ask({
      title: `Run ${row.n} now?`,
      body: "Creates a Job from the CronJob template (like `kubectl create job --from=cronjob/…`).",
      breakdown: breakdown(ctx.rows),
      items: items(ctx),
      confirmLabel: "Create job",
    });
    const run = ok && start(ctx, { action: "trigger", doing: "creating a job from" });
    if (!run) return;
    try {
      const name = await backend().triggerCronJob(objectRef(row, ctx.resourceKey));
      toast("success", "Job created", name);
    } catch (e) {
      failed("Could not create job", row, e);
    } finally {
      run.end();
    }
  },
});


registerChange({
  id: "debug",
  title: "Debug container…",
  icon: "zap",
  readOnlyWhy: "it adds a container to the pod, for good",
  // Adds the container, then attaches to it.
  needs: (row) => [...podPart("patch", "ephemeralcontainers")(row), ...podPart("stream", "attach")(row)],
  applies: (ctx) => is(ctx, "pods") && can(ctx, "patch"),
  async run(ctx) {
    const row = ctx.rows[0];
    let found: Awaited<ReturnType<typeof podContainers>>;
    try {
      found = await podContainers(row);
    } catch (e) {
      failed(`Could not read ${row.n}`, row, e);
      return;
    }
    const targets = found.containers.filter((c) => c.running && !c.debug);
    const res = await ask({
      title: `Debug ${row.n}`,
      body: "Adds a container to the pod and attaches to it, like `kubectl debug -it`: for images without a shell, or tools the app lacks. Kubernetes cannot remove it again — it stays until the pod is deleted.",
      breakdown: breakdown(ctx.rows),
      items: items(ctx),
      fields: [{ label: "Image", value: debugImage(), placeholder: "busybox:1.37" }],
      choice: targets.length
        ? {
            label: "Sees the processes of",
            options: [...targets.map((c) => ({ value: c.name, label: c.name, meta: c.meta })), { value: "", label: "no container", meta: "the pod's network only" }],
            value: targets.some((c) => c.name === found.preferred) ? found.preferred! : targets[0].name,
          }
        : undefined,
      confirmLabel: "Add and attach",
    });
    const image = res?.fields?.[0];
    if (!res || !image) return;
    setDebugImage(image);
    openTerminal({ kind: "debug", spec: { cluster: row.cl, namespace: row.ns ?? "default", pod: row.n, uid: row.u, image, target: res.choice || undefined } });
  },
});

registerChange({
  id: "node-shell",
  title: "Node shell…",
  icon: "terminal",
  readOnlyWhy: "it creates a privileged pod on the node",
  shortcut: "s",
  applies: (ctx) => is(ctx, "nodes"),
  async run(ctx) {
    const row = ctx.rows[0];
    // Where the helper pod goes is asked below: a namespace the user may not create pods in is said up front.
    const [can] = await accessNow(row.cl, [{ verb: "create", group: "", resource: "pods", namespace: nodeShellNamespace() }], 1500);
    const res = await ask({
      title: `Open a shell on ${row.n}?`,
      body: `Creates a privileged pod on the node that shares its namespaces (processes, network, mounts) and opens a root shell in them, like \`kubectl node-shell\`. The pod is deleted when the session ends.${can.allowed === false ? ` You may not create pods in ${nodeShellNamespace()} on ${shortName(row.cl)}: pick a namespace where you can.` : ""}`,
      breakdown: breakdown(ctx.rows),
      items: items(ctx),
      fields: [
        { label: "Image (with nsenter)", value: nodeShellImage(), placeholder: "busybox:1.37" },
        { label: "Namespace for the pod", value: nodeShellNamespace(), placeholder: "default" },
      ],
      confirmLabel: "Open shell",
    });
    const [image, namespace] = res?.fields ?? [];
    if (!res || !image || !namespace) return;
    setNodeShellImage(image);
    setNodeShellNamespace(namespace);
    openTerminal({ kind: "node", spec: { cluster: row.cl, node: row.n, namespace, image } });
  },
});

registerAction({
  id: "copy-name",
  title: (ctx) => (ctx.rows.length > 1 ? `Copy ${ctx.rows.length} names` : "Copy name"),
  icon: "copy",
  shortcut: "c",
  multi: true,
  applies: () => true,
  async run(ctx) {
    await navigator.clipboard.writeText(ctx.rows.map((r) => r.n).join("\n"));
    toast("info", "Copied to clipboard");
  },
});

/**
 * Kinds whose deletion takes much more with it, or breaks what depends on it: deleting them is confirmed
 * by typing, with what else goes.
 */
export const DANGEROUS_DELETES = new Map<string, string>([
  ["namespaces", "Everything in the namespace is deleted with it."],
  ["customresourcedefinitions.apiextensions.k8s.io", "Every custom resource of this type in the cluster is deleted with it."],
  ["nodes", "The node leaves the cluster; the pods bound to it are deleted."],
  ["persistentvolumes", "With the Delete reclaim policy, the storage and its data can go too."],
  ["persistentvolumeclaims", "With the Delete reclaim policy, the volume and its data are deleted too."],
  ["clusterroles.rbac.authorization.k8s.io", "Everyone bound to it loses the permissions it grants."],
  ["clusterrolebindings.rbac.authorization.k8s.io", "Its subjects lose the permissions it grants."],
  ["validatingwebhookconfigurations.admissionregistration.k8s.io", "The admission checks it makes stop at once."],
  ["mutatingwebhookconfigurations.admissionregistration.k8s.io", "The changes it makes to new objects stop at once."],
  ["apiservices.apiregistration.k8s.io", "The API it serves (metrics, an aggregated API…) disappears."],
  ["storageclasses.storage.k8s.io", "Claims that name it can no longer be provisioned."],
]);

/** Changing more objects than this at once (delete, restart, scale, cordon, suspend) is confirmed by typing. */
export const TYPED_CONFIRM_OVER = 10;

/**
 * What has to be typed to `verb` these rows — the object's name, or "restart 12" for several — or
 * undefined when a click is enough: up to {@link TYPED_CONFIRM_OVER} objects in one cluster, unless `always`.
 * Context names never matter: no cluster is guessed to be "production".
 */
export function typedConfirmText(ctx: ActionContext, verb: string, always = false): string | undefined {
  const clusters = new Set(ctx.rows.map((r) => r.cl)).size;
  if (!always && ctx.rows.length <= TYPED_CONFIRM_OVER && clusters <= 1) return undefined;
  return ctx.rows.length === 1 ? ctx.rows[0].n : `${verb} ${ctx.rows.length}`;
}

/** Deletes are typed for like the other changes, and also for dangerous kinds and with Force. */
export function deleteConfirmText(ctx: ActionContext, force: boolean): string | undefined {
  return typedConfirmText(ctx, "delete", force || DANGEROUS_DELETES.has(ctx.resourceKey));
}

registerChange({
  id: "delete",
  title: (ctx) => (ctx.rows.length > 1 ? `Delete ${ctx.rows.length}…` : "Delete…"),
  icon: "trash",
  shortcut: ["ctrl+d", "mod+backspace"],
  danger: true,
  multi: true,
  needs: own("delete"),
  applies: (ctx) => can(ctx, "delete"),
  async run(ctx) {
    const cascade = DANGEROUS_DELETES.get(ctx.resourceKey);
    const res = await ask({
      title: `Delete ${what(ctx)}?`,
      body: cascade ? `${cascade} This cannot be undone.` : "This cannot be undone.",
      breakdown: breakdown(ctx.rows),
      items: items(ctx),
      confirmLabel: "Delete",
      danger: true,
      checkbox: ctx.resourceKey === "pods" ? { label: "Force (grace period 0)", value: false } : undefined,
      confirmText: (force) => deleteConfirmText(ctx, force),
    });
    const change = { action: "delete", doing: "deleting", done: "Deleted", failed: "Delete" };
    const run = res && start(ctx, change);
    if (!run) return;
    const { rows } = run.ctx;
    let errors: unknown[];
    try {
      const results = await backend().deleteObjects(
        rows.map((r) => objectRef(r, ctx.resourceKey)),
        !!res.checkbox,
      );
      // Results come back in request order.
      errors = rows.map((_, i) => (results[i]?.ok ? undefined : (results[i]?.error ?? "no result")));
    } catch (e) {
      // Nothing was attempted (read-only mode, the engine unreachable): every row failed the same way.
      errors = rows.map(() => e ?? "failed");
    } finally {
      run.end();
    }
    report(change, ctx.resourceKey, rows, errors);
  },
});
