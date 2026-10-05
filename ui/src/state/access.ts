import { createSignal } from "solid-js";
import { type AccessCheck, type AccessDecision, backend } from "../lib/backend";

// What the user may do, asked of each cluster before an action is offered (access reviews, see `access.rs`): kept here a
// minute, asked of the engine again after that (it keeps answers longer, per connection). Questions asked together are
// sent together, per cluster.

/** How long a decision is used before it is asked for again. */
export const ACCESS_TTL_MS = 60_000;
/** Questions asked within this long go out in one request per cluster. */
const BATCH_MS = 25;
/** How long an action waits for decisions it does not have before it goes on without them. */
export const ACCESS_WAIT_MS = 3_000;

interface Entry {
  decision?: AccessDecision;
  at: number;
  asking?: Promise<AccessDecision>;
}

const entries = new Map<string, Entry>();
const [version, setVersion] = createSignal(0);
/** Questions waiting to go out, per cluster. */
const queued = new Map<string, Map<string, { check: AccessCheck; done: ((d: AccessDecision) => void)[] }>>();
let timer: ReturnType<typeof setTimeout> | undefined;

export const checkKey = (cluster: string, c: AccessCheck) => [cluster, c.verb, c.group, c.resource, c.subresource ?? "", c.namespace ?? "", c.name ?? ""].join("\n");

const UNKNOWN: AccessDecision = { allowed: null };

function flush() {
  timer = undefined;
  const batches = [...queued];
  queued.clear();
  for (const [cluster, questions] of batches) {
    const list = [...questions.values()];
    // `async`: an engine that throws before answering leaves the questions unknown like one that fails.
    (async () =>
      backend().accessReview(
        cluster,
        list.map((q) => q.check),
      ))().then(
      (decisions) => list.forEach((q, i) => q.done.forEach((f) => f(decisions[i] ?? UNKNOWN))),
      () => list.forEach((q) => q.done.forEach((f) => f(UNKNOWN))),
    );
  }
}

/** Asks for one decision (with others asked meanwhile). Resolves with it, unknown if the cluster could not say. */
function ask(cluster: string, check: AccessCheck): Promise<AccessDecision> {
  const key = checkKey(cluster, check);
  const e = entries.get(key);
  if (e?.asking) return e.asking;
  const asking = new Promise<AccessDecision>((resolve) => {
    let q = queued.get(cluster);
    if (!q) queued.set(cluster, (q = new Map()));
    const waiting = q.get(key) ?? { check, done: [] };
    waiting.done.push(resolve);
    q.set(key, waiting);
    timer ??= setTimeout(flush, BATCH_MS);
  }).then((decision) => {
    // Unknown answers are not kept long: the next look asks again.
    entries.set(key, { decision, at: decision.allowed === null ? Date.now() - ACCESS_TTL_MS / 2 : Date.now() });
    setVersion((v) => v + 1);
    return decision;
  });
  entries.set(key, { ...(e ?? { at: 0 }), asking });
  return asking;
}

const fresh = (e: Entry | undefined) => !!e?.decision && Date.now() - e.at < ACCESS_TTL_MS;

/**
 * The decision for `check` in `cluster` — reactive: what is known (an older one while it is asked again), undefined
 * until the first answer. Asks when there is none, or it is old.
 */
export function accessOf(cluster: string, check: AccessCheck): AccessDecision | undefined {
  version();
  const e = entries.get(checkKey(cluster, check));
  if (!fresh(e) && !e?.asking) void ask(cluster, check);
  return e?.decision;
}

/** The decision for `check` in `cluster` if a fresh one is known (not reactive, asks nothing). */
export function accessKnown(cluster: string, check: AccessCheck): AccessDecision | undefined {
  const e = entries.get(checkKey(cluster, check));
  return fresh(e) ? e!.decision : undefined;
}

/** Decisions for `checks` (asking for those not known), waiting at most `waitMs`: what has no answer by then is unknown. */
export async function accessNow(cluster: string, checks: AccessCheck[], waitMs = ACCESS_WAIT_MS): Promise<AccessDecision[]> {
  const late = new Promise<"late">((r) => setTimeout(() => r("late"), waitMs));
  return Promise.all(
    checks.map(async (c) => {
      const e = entries.get(checkKey(cluster, c));
      if (fresh(e)) return e!.decision!;
      const d = await Promise.race([e?.asking ?? ask(cluster, c), late]);
      return d === "late" ? UNKNOWN : d;
    }),
  );
}

/** Forgets every decision (tests; a reconnect with other credentials is caught by the engine's per-connection cache). */
export function forgetAccess() {
  entries.clear();
  queued.clear();
  if (timer !== undefined) clearTimeout(timer);
  timer = undefined;
  setVersion((v) => v + 1);
}

/**
 * The verb a stream into a pod (exec, attach, port-forward) is authorized with on a cluster of `version`: `create`
 * since Kubernetes 1.30 (the websocket upgrade counts as the POST it stands for), `get` before. Unknown: `create`.
 */
export function streamVerb(version: string | null | undefined): "create" | "get" {
  const m = /^v?(\d+)\.(\d+)/.exec(version ?? "");
  return m && Number(m[1]) === 1 && Number(m[2]) < 30 ? "get" : "create";
}

/** "patch deployments", "create pods/exec", "delete certificates.cert-manager.io" */
export function checkText(c: AccessCheck): string {
  const resource = `${c.resource}${c.subresource ? `/${c.subresource}` : ""}`;
  return `${c.verb} ${c.group && !["apps", "batch"].includes(c.group) ? `${resource}.${c.group}` : resource}`;
}
