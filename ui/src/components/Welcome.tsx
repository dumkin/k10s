import { createMemo, createSignal, For, Match, Show, Switch } from "solid-js";
import mark from "../assets/brand/k10s-crab.svg";
import { zoneSummary } from "../lib/clusters";
import { comboLabel } from "../lib/hotkeys";
import { contextNames, contexts, kubeconfigState, loadContexts, recentClusters, savedSets, setSelectedClusters, zoneFamilies } from "../state/clusters";
import { setPickerOpen, toast } from "../state/ui";
import { Icon } from "./Icon";

/** Quick picks shown per kind; the picker has the rest. */
const QUICK_PICKS = 8;

function openClusterPicker() {
  setPickerOpen(null);
  setPickerOpen("clusters");
}

/**
 * The main area before there is anything to show: no clusters picked yet (first run without a
 * current-context — nothing is connected until the user picks), or a kubeconfig that can't be used
 * (missing, unreadable, without contexts).
 */
export function Welcome() {
  const [reloading, setReloading] = createSignal(false);
  const reload = async () => {
    setReloading(true);
    try {
      await loadContexts();
    } finally {
      setReloading(false);
    }
    const n = contexts().length;
    if (kubeconfigState().state === "ok") toast("success", `Kubeconfig reloaded: ${n} context${n === 1 ? "" : "s"}`);
  };
  const failure = createMemo(() => {
    const st = kubeconfigState();
    return st.state === "error" ? st : undefined;
  });
  const problem = createMemo(() => {
    const st = kubeconfigState();
    return st.state === "missing" || st.state === "empty" ? st : undefined;
  });

  return (
    <div class="content welcome" style={{ position: "relative" }}>
      <div class="table-empty" style={{ inset: "0" }}>
        <Switch>
          <Match when={kubeconfigState().state === "loading"}>
            <span class="spinner" />
            <h3>Reading kubeconfig…</h3>
            <p>Contexts come from the same kubeconfig kubectl uses.</p>
          </Match>
          <Match when={failure()}>
            {(st) => (
              <>
                <Icon name="alert" size={28} style={{ color: "var(--err)" }} />
                <h3>Can't read the kubeconfig</h3>
                <p class="error-text">{st().message}</p>
                <p>Fix the file (or KUBECONFIG in your shell profile), then reload.</p>
                <ReloadButton busy={reloading()} onClick={reload} />
              </>
            )}
          </Match>
          <Match when={problem()}>
            {(st) => (
              <>
                <Icon name="config" size={28} />
                <h3>{st().state === "missing" ? "No kubeconfig found" : "No contexts in the kubeconfig"}</h3>
                <p>{st().state === "missing" ? `Searched${st().fromEnv ? " (from KUBECONFIG)" : ""}:` : "Read:"}</p>
                <div class="error-list mono selectable" style={{ "margin-top": "0" }}>
                  <For each={st().paths}>{(p) => <div>{p}</div>}</For>
                </div>
                <p>
                  <Show
                    when={st().state === "missing"}
                    fallback={<>Add a context — for example with your cloud's CLI (aws eks update-kubeconfig, gcloud container clusters get-credentials…) — then reload.</>}
                  >
                    k10s reads the same kubeconfig as kubectl: put it at ~/.kube/config or set KUBECONFIG in your shell profile, then reload.
                  </Show>
                </p>
                <ReloadButton busy={reloading()} onClick={reload} />
              </>
            )}
          </Match>
          <Match when={kubeconfigState().state === "ok"}>
            <ClusterChoice />
          </Match>
        </Switch>
      </div>
    </div>
  );
}

function ReloadButton(p: { busy: boolean; onClick: () => void }) {
  return (
    <button class="btn" disabled={p.busy} onClick={() => p.onClick()}>
      <Show when={p.busy} fallback={<Icon name="refresh" size={13} />}>
        <span class="spinner" style={{ width: "11px", height: "11px" }} />
      </Show>
      Reload kubeconfig
    </button>
  );
}

/** First run (or the saved clusters are gone): what k10s is, and ways to pick clusters. */
function ClusterChoice() {
  const known = createMemo(() => new Set(contextNames()));
  const sets = createMemo(() => savedSets().filter((s) => s.clusters.some((c) => known().has(c))));
  const recent = createMemo(() => recentClusters().filter((c) => known().has(c)));
  const pick = (clusters: string[]) => {
    const usable = clusters.filter((c) => known().has(c));
    if (usable.length) setSelectedClusters(usable);
  };
  // Only clusters that are zones by name: one click connects all of them, so a family made up from a shared
  // trailing number (EKS ARNs of one region across accounts) must not be offered.
  const more = () => Math.max(0, zoneFamilies().length - QUICK_PICKS);

  return (
    <div class="access-cta">
      <img src={mark} alt="" width={40} height={40} draggable={false} />
      <h3>Pick the clusters to look at</h3>
      <p>
        k10s shows Kubernetes clusters side by side in one live table — {contexts().length} contexts in your kubeconfig. Nothing is connected until you pick.
      </p>
      <button class="btn primary" onClick={openClusterPicker}>
        <Icon name="layers" size={13} />
        Select clusters
        <span class="kbd">{comboLabel("mod+shift+c")}</span>
      </button>
      <Show when={sets().length}>
        <div class="cta-recent">
          <span class="faint">Saved sets:</span>
          <For each={sets().slice(0, QUICK_PICKS)}>
            {(s) => (
              <button class="chip" title={s.clusters.join(", ")} onClick={() => pick(s.clusters)}>
                <Icon name="star" size={11} style={{ color: "var(--warn)" }} />
                {s.name}
              </button>
            )}
          </For>
        </div>
      </Show>
      <Show when={zoneFamilies().length}>
        <div class="cta-recent">
          <span class="faint">Zone groups:</span>
          <For each={zoneFamilies().slice(0, QUICK_PICKS)}>
            {(f) => (
              <button class="chip" title={f.members.join(", ")} onClick={() => pick(f.members)}>
                <Icon name="layers" size={11} />
                {f.base} · {zoneSummary(f.members, 6)}
              </button>
            )}
          </For>
          <Show when={more()}>
            <button class="chip" onClick={openClusterPicker}>
              +{more()} more…
            </button>
          </Show>
        </div>
      </Show>
      <Show when={recent().length}>
        <div class="cta-recent">
          <span class="faint">Recent:</span>
          <For each={recent().slice(0, QUICK_PICKS)}>
            {(c) => (
              <button class="chip" onClick={() => pick([c])}>
                {c}
              </button>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}
