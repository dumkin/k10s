import { backend, errorMessage, type ObjectRef } from "../lib/backend";
import { HELM_RELEASES } from "../lib/helm";
import { accessNow } from "../state/access";
import { clusterColor, shortName } from "../state/clusters";
import { unmark } from "../state/nav";
import { ask, busyToast, noteReadOnlyRefusal, toast } from "../state/ui";
import type { UIRow } from "../state/view";
import { type ActionContext, breakdown, registerAction, typedConfirmText } from "./actions";

// Changes to Helm releases run the user's own `helm` (its hooks, three-way merges and release records are Helm's
// to do): refused in read-only mode like any change, confirmed first, journalled by the engine.

const ref = (r: UIRow): ObjectRef => ({ cluster: r.cl, resource: HELM_RELEASES, namespace: r.ns ?? "default", name: r.n });

/** Helm keeps a release's revisions in Secrets of its namespace: a rollback writes a new one, an uninstall deletes them. */
const records = (verb: string) => (r: UIRow) => [{ verb, group: "", resource: "secrets", namespace: r.ns ?? "default" }];
const place = (r: UIRow) => `${shortName(r.cl)} ${r.ns}/${r.n}`;

function refused(title: string, e: unknown, where: string) {
  if ((e as { kind?: string })?.kind === "readOnly") noteReadOnlyRefusal();
  toast("error", title, `${where}: ${errorMessage(e)}`, { sticky: true, copy: `${title}\n${where}\t${errorMessage(e)}` });
}

/**
 * Rolls a release back (`helm rollback NAME REVISION`) once confirmed: to `revision`, else to one the user picks
 * among those kept (the one before the current by default).
 */
export async function rollbackRelease(row: UIRow, revision?: number) {
  // Also from the History tab's buttons, which are no action: what helm would be refused is said before confirming.
  const [can] = await accessNow(row.cl, records("create")(row));
  if (can.allowed === false) {
    toast("info", `No permission: roll back ${row.n}`, `You may not create secrets in ${row.ns} on ${shortName(row.cl)} (Helm writes each revision there). Permissions come from the cluster's RBAC: its admins can grant them.`);
    return;
  }
  let history: { revision: number; status: string; chart: string; appVersion: string }[];
  let currentRev: number;
  try {
    const rel = await backend().helmRelease(row.cl, row.ns ?? "default", row.n);
    history = rel.history.filter((h) => h.revision !== rel.revision);
    currentRev = rel.revision;
  } catch (e) {
    refused(`Could not read ${row.n}`, e, place(row));
    return;
  }
  if (!history.length) {
    toast("info", `${row.n} has no earlier revision to roll back to`);
    return;
  }
  const res = await ask({
    title: `Roll back ${row.n}?`,
    body: `Runs \`helm rollback ${row.n}\` (your helm, your kubeconfig): the chosen revision's manifest and values become revision ${currentRev + 1}. Hooks run as Helm runs them.`,
    breakdown: [{ label: row.cl, count: 1, color: clusterColor(row.cl) }],
    choice: { label: "To revision", options: history.map((h) => ({ value: String(h.revision), label: `${h.revision} · ${h.chart}`, meta: `${h.status} · app ${h.appVersion}` })), value: String(revision ?? history[0].revision) },
    confirmLabel: "Roll back",
  });
  const to = Number(res?.choice);
  if (!res || !to) return;
  const done = busyToast(`Rolling back ${row.n} to revision ${to}…`);
  try {
    await backend().helmRollback(row.cl, row.ns ?? "default", row.n, to);
    toast("success", `Rolled back ${row.n} to revision ${to}`, place(row));
  } catch (e) {
    refused("Rollback failed", e, place(row));
  } finally {
    done();
  }
}

const isRelease = (ctx: ActionContext) => ctx.resourceKey === HELM_RELEASES;

registerAction({
  id: "helm-rollback",
  title: "Roll back…",
  icon: "restart",
  primary: true,
  mutating: true,
  readOnlyWhy: "it changes the release and its objects",
  needs: records("create"),
  applies: isRelease,
  run: (ctx) => rollbackRelease(ctx.rows[0]),
});

registerAction({
  id: "helm-uninstall",
  title: (ctx) => (ctx.rows.length > 1 ? `Uninstall ${ctx.rows.length}…` : "Uninstall…"),
  icon: "trash",
  shortcut: "ctrl+d",
  danger: true,
  multi: true,
  mutating: true,
  readOnlyWhy: "it deletes the release and its objects",
  needs: records("delete"),
  applies: isRelease,
  async run(ctx) {
    const n = ctx.rows.length;
    const res = await ask({
      title: `Uninstall ${n > 1 ? `${n} releases` : ctx.rows[0].n}?`,
      body: "Runs `helm uninstall` (your helm, your kubeconfig): every object the release made is deleted (but those it keeps by policy), and so is its history. This cannot be undone.",
      breakdown: breakdown(ctx.rows),
      items: ctx.rows.map((r) => ({ label: `${r.ns}/${r.n}`, meta: shortName(r.cl), color: clusterColor(r.cl) })),
      confirmLabel: "Uninstall",
      danger: true,
      // Like deletes of kinds that take much with them: always typed.
      confirmText: typedConfirmText(ctx, "uninstall", true),
    });
    if (!res) return;
    const done = busyToast(`Uninstalling ${n > 1 ? `${n} releases` : ctx.rows[0].n}…`);
    let results: { ok: boolean; error?: { message: string } }[];
    try {
      results = await backend().helmUninstall(ctx.rows.map(ref));
    } catch (e) {
      refused("Uninstall failed", e, n > 1 ? `${n} releases` : place(ctx.rows[0]));
      return;
    } finally {
      done();
    }
    const ok = ctx.rows.filter((_, i) => results[i]?.ok);
    unmark(ok.map((r) => r.key));
    if (ok.length) toast("success", `Uninstalled ${ok.length === 1 ? ok[0].n : `${ok.length} releases`}`);
    const failed = ctx.rows.flatMap((r, i) => (results[i]?.ok ? [] : [`${place(r)}: ${results[i]?.error?.message ?? "no result"}`]));
    if (failed.length) toast("error", `Uninstall failed for ${failed.length} of ${n}`, failed.slice(0, 5).join("\n"), { sticky: true, copy: failed.join("\n") });
  },
});
