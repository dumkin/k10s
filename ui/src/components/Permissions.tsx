import { createEffect, createMemo, createSignal, For, on, Show } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import { type AccessCheck, type AccessDecision, type AccessRules, backend, errorMessage } from "../lib/backend";
import { answer, PERMISSION_ROWS, type PermissionRow, VERBS } from "../lib/permissions";
import { catalogEntry } from "../registry/catalog";
import { accessNow, streamVerb } from "../state/access";
import { clusterColor, clusterStatus, selectedClusters, shortName } from "../state/clusters";
import { kubeconfigNamespaces, namespaces, navigate, recentNamespaces } from "../state/nav";
import { Icon } from "./Icon";

// What the user may do, per resource and verb, in each selected cluster — the cluster's RBAC (and other
// authorizers) as its API server lists it for a namespace; cluster-wide resources asked about one by one. Like
// `kubectl auth can-i --list`, for every cluster at once: where one zone lets you and another does not shows.

type State = "yes" | "some" | "no" | "unknown" | "loading";

interface ClusterRules {
  state: "loading" | "ok" | "error";
  rules?: AccessRules;
  error?: string;
}

const [picked, setPicked] = createSignal<string | null>(null);

const WORDS: Record<State, string> = { yes: "allowed", some: "only some objects", no: "not allowed", unknown: "not known", loading: "asking…" };

export function PermissionsView() {
  /** The namespace asked about: the one picked here, else the first open in the tables, else the kubeconfig's. */
  const ns = createMemo(() => picked() ?? namespaces()[0] ?? kubeconfigNamespaces()[0] ?? "default");
  const choices = createMemo(() => [...new Set([ns(), ...namespaces(), ...recentNamespaces(), "default"])]);
  const [rules, setRules] = createStore<Record<string, ClusterRules>>({});
  const [reviews, setReviews] = createSignal<Map<string, AccessDecision>>(new Map());
  let generation = 0;

  createEffect(
    on([selectedClusters, ns], ([clusters, namespace]) => {
      const gen = ++generation;
      setRules(reconcile(Object.fromEntries(clusters.map((c) => [c, { state: "loading" } as ClusterRules]))));
      setReviews(new Map());
      for (const c of clusters) {
        backend()
          .accessRules(c, namespace)
          .then(
            (r) => gen === generation && setRules(c, { state: "ok", rules: r }),
            (e) => gen === generation && setRules(c, { state: "error", error: errorMessage(e) }),
          );
        // Cluster-wide resources: the namespace's rules do not answer for them.
        const checks: AccessCheck[] = PERMISSION_ROWS.filter((r) => r.cluster).flatMap((r) => r.verbs.map((verb) => ({ verb, group: r.group, resource: r.resource })));
        void accessNow(c, checks, 20_000).then((decisions) => {
          if (gen !== generation) return;
          setReviews((prev) => {
            const next = new Map(prev);
            checks.forEach((ch, i) => next.set(`${c}|${ch.resource}|${ch.verb}`, decisions[i]));
            return next;
          });
        });
      }
    }),
  );

  const stateOf = (c: string, row: PermissionRow, verb: string): State => {
    const cr = rules[c];
    if (row.cluster) {
      const d = reviews().get(`${c}|${row.resource}|${verb}`);
      return !d ? "loading" : d.allowed === true ? "yes" : d.allowed === false ? "no" : "unknown";
    }
    if (!cr || cr.state === "loading") return "loading";
    if (cr.state === "error" || !cr.rules) return "unknown";
    const a = answer(cr.rules, row.stream ? streamVerb(clusterStatus[c]?.version) : verb, row.group, row.resource, row.subresource);
    // An authorizer that cannot list its rules (a webhook) may allow what none of them says.
    return a === "no" && cr.rules.incomplete ? "unknown" : a;
  };
  const loading = () => selectedClusters().some((c) => rules[c]?.state === "loading");

  return (
    <div class="content perms">
      <div class="view-header">
        <div class="view-title">
          <Icon name="user" size={18} />
          <h1>My permissions</h1>
          <span class="kind">in namespace</span>
          <select class="input perm-ns" value={ns()} onChange={(e) => setPicked(e.currentTarget.value)} title="The namespace whose permissions are shown (cluster-wide resources apart)">
            <For each={choices()}>{(n) => <option value={n}>{n}</option>}</For>
          </select>
        </div>
        <div class="perm-legend">
          <For each={["yes", "some", "no", "unknown"] as State[]}>
            {(s) => (
              <span>
                <span class={`perm-sq ${s}`} /> {WORDS[s]}
              </span>
            )}
          </For>
        </div>
        <span class="progress-line" classList={{ on: loading() }} role="progressbar" aria-label="Reading the permissions" aria-hidden={!loading()} />
      </div>
      <div class="perm-clusters">
        <For each={selectedClusters()}>
          {(c) => {
            const r = () => rules[c];
            return (
              <span class="perm-cluster" title={r()?.state === "error" ? `${c}: ${r()!.error}` : r()?.rules?.incomplete ? `${c}: an authorizer (a webhook) cannot list what it allows — "not known" where its rules say nothing` : c}>
                <span class="swatch" style={{ background: clusterColor(c) }} />
                {shortName(c)}
                <Show when={r()?.state === "error"}>
                  <Icon name="alert" size={11} class="warn-mark" />
                </Show>
                <Show when={r()?.rules?.incomplete}>
                  <span class="faint">incomplete</span>
                </Show>
                <Show when={r()?.rules?.error}>
                  <span class="faint" title={r()!.rules!.error}>
                    partly
                  </span>
                </Show>
              </span>
            );
          }}
        </For>
      </div>
      <div class="perm-body">
        <table class="perm-table">
          <thead>
            <tr>
              <th>Resource</th>
              <For each={VERBS}>{(v) => <th>{v}</th>}</For>
            </tr>
          </thead>
          <tbody>
            <For each={PERMISSION_ROWS}>
              {(row, i) => (
                <tr classList={{ sub: !!row.subresource, sep: !!row.cluster && !PERMISSION_ROWS[i() - 1]?.cluster }}>
                  <td class="perm-res">
                    <button class="perm-res-btn" title={`Open ${row.title}`} onClick={() => navigate(row.key)}>
                      <Show when={!row.subresource}>
                        <Icon name={catalogEntry(row.key)?.icon ?? "crd"} size={13} />
                      </Show>
                      <span>{row.title}</span>
                    </button>
                    <Show when={row.hint}>
                      <span class="faint mono perm-hint">{row.hint}</span>
                    </Show>
                    <Show when={row.cluster}>
                      <span class="faint perm-hint">cluster-wide</span>
                    </Show>
                  </td>
                  <For each={VERBS}>
                    {(verb) => (
                      <Show when={row.verbs.includes(verb)} fallback={<td class="na" />}>
                        <Cell states={selectedClusters().map((c) => [c, stateOf(c, row, verb)] as const)} what={`${verb} ${row.hint ?? row.title.toLowerCase()}${row.cluster ? "" : ` in ${ns()}`}`} />
                      </Show>
                    )}
                  </For>
                </tr>
              )}
            </For>
          </tbody>
        </table>
        <p class="perm-note faint">
          What the API server lists for you: RBAC and other authorizers. A webhook that cannot list its rules makes a cluster "incomplete": actions still ask it before they are offered.
        </p>
      </div>
    </div>
  );
}

/** One verb on one resource: a square per cluster (in the order picked), the whole story on hover. */
function Cell(props: { states: (readonly [string, State])[]; what: string }) {
  const all = (s: State) => props.states.every(([, x]) => x === s);
  const glyph = () => (all("yes") ? "✓" : all("no") ? "✕" : "");
  return (
    <td class="perm-cell" title={`${props.what}\n${props.states.map(([c, s]) => `${shortName(c)}: ${WORDS[s]}`).join("\n")}`}>
      <span class="perm-sqs">
        <For each={props.states}>{([, s]) => <span class={`perm-sq ${s}`} />}</For>
      </span>
      {/* Always there, empty or not: a ✓ in one row and none in the next would move the squares. */}
      <span class={`perm-glyph ${props.states[0]?.[1] ?? ""}`}>{glyph()}</span>
    </td>
  );
}
