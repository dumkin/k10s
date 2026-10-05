import { createMemo, createSignal, For, type JSX, Match, onCleanup, onMount, Show, Switch } from "solid-js";
import { Icon } from "../../components/Icon";
import { Popover } from "../../components/Popover";
import { type Change, changes, type CompareOptions, deepEqual, type Hide, isSecret, pairDiff, type Path, pathText, secretText, strip, yamlLines } from "../../lib/compare/diff";
import { ADD, DEL, editScript } from "../../lib/compare/myers";
import { isBlock, isMap, isNested, type Json } from "../../lib/compare/yaml";
import { comboLabel } from "../../lib/hotkeys";
import { isError } from "../../lib/k8s";
import type { DetailProps } from "../../registry/details";
import { clusterColor, contexts, discoveredResources, selectedClusters, shortName } from "../../state/clusters";
import {
  addExtraCluster,
  comparedWith,
  compareSettings,
  type CompareRef,
  extraClusters,
  refId,
  removeExtraCluster,
  rowRef,
  sameRef,
  setCompareSetting,
  toggleTwin,
  twinIncluded,
  unpin,
} from "../../state/compare";
import { reveal as revealObject } from "../../state/nav";
import type { FeedState, UIRow } from "../../state/view";
import { mainView } from "../../state/views";
import { DiffView } from "./DiffView";
import { type Loaded, loadSides, type Role, type Side } from "./sides";

/** Split view from this width of the panel on (when the layout is left to it). */
const SPLIT_FROM = 900;
/** Changes listed at most: two unrelated objects differ everywhere. */
const MAX_CHANGES = 1000;

/** A cluster of the table, with the object of the same name in it or not. */
interface Twin {
  cluster: string;
  /** Added in this tab: outside the table. */
  extra: boolean;
  included: boolean;
  state: "found" | "loading" | "missing" | "error";
  message?: string;
}

/** A Secret's value revealed: its text, where it is text (`data` holds base64). */
function decoded(path: Path, v: string): string {
  if (path[0] !== "data") return v;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(atob(v), (c) => c.charCodeAt(0)));
  } catch {
    return v;
  }
}

/** How a value shows in the list of changes: in short, whole in its tooltip. */
function cell(v: Json, path: Path, hide: Hide | undefined, revealed: boolean): { text: string; title?: string; kind: "absent" | "text" | "more" | "hidden" } {
  if (v === undefined) return { text: "—", title: "Not set", kind: "absent" };
  const secret = secretText(path, v);
  if (secret !== undefined && hide) return { text: secret, kind: "hidden", title: "Hidden: Reveal values shows it" };
  if (secret !== undefined && revealed && typeof v === "string") v = decoded(path, v);
  const yaml = () => {
    const lines = yamlLines(v, hide && ((p, x) => hide([...path, ...p], x))).map((l) => l.text);
    return lines.length > 60 ? [...lines.slice(0, 60), `… ${lines.length - 60} more lines`].join("\n") : lines.join("\n");
  };
  if (isBlock(v)) {
    const lines = v.replace(/\n$/, "").split("\n");
    const title = lines.length > 60 ? [...lines.slice(0, 60), `… ${lines.length - 60} more lines`].join("\n") : lines.join("\n");
    return { text: `${lines.length} lines`, title, kind: "more" };
  }
  if (Array.isArray(v) && v.length && v.every((x) => !isNested(x) && !isBlock(x))) {
    const text = v.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(", ");
    return { text: `[${text}]`, title: yaml(), kind: "text" };
  }
  if (isNested(v)) {
    const n = Array.isArray(v) ? v.length : Object.keys(v).length;
    return { text: Array.isArray(v) ? `${n} item${n === 1 ? "" : "s"}` : `${n} field${n === 1 ? "" : "s"}`, title: yaml(), kind: "more" };
  }
  if (typeof v === "string") return { text: v === "" ? '""' : v, title: v, kind: "text" };
  const text = isMap(v) ? "{}" : Array.isArray(v) ? "[]" : String(v);
  return { text, title: text, kind: "text" };
}

/**
 * Where values that start alike are cut so that what differs shows first (`registry/team/web:v1.4` and `…:v1.5` as
 * `…v1.4` and `…v1.5`): after the last separator they share (`:` `/` `=` `,` or a blank); 0 when they share little.
 */
export function sharedCut(values: Json[]): number {
  const strs = values.filter((v): v is string => typeof v === "string");
  if (strs.length < 2 || strs.length !== values.filter((v) => v !== undefined).length) return 0;
  let p = 0;
  while (strs.every((s) => p < s.length && s[p] === strs[0][p])) p++;
  const head = strs[0].slice(0, p);
  const cut = Math.max(...[":", "/", "=", ",", " "].map((c) => head.lastIndexOf(c))) + 1;
  return cut >= 6 ? cut : 0;
}

/** How text `b` differs from `a`, line by line: the first line of it that is not in `a`, and how many more. */
export function textChange(a: string, b: string): { first: string; more: number } | null {
  const la = a.replace(/\n$/, "").split("\n");
  const lb = b.replace(/\n$/, "").split("\n");
  const ops = editScript(la, lb);
  let j = 0;
  const changed: string[] = [];
  for (const op of ops) {
    if (op === ADD) changed.push(lb[j]);
    if (op !== DEL) j++;
  }
  // Only lines gone: what went, then.
  if (!changed.length) {
    let i = 0;
    for (const op of ops) {
      if (op === DEL) changed.push(`− ${la[i].trim()}`);
      if (op !== ADD) i++;
    }
  }
  return changed.length ? { first: changed[0].trim(), more: changed.length - 1 } : null;
}

/** Objects compared with the one the tab is of: pinned ones, or those of its name in the other clusters. */
export function CompareTab(props: DetailProps) {
  const settings = compareSettings;
  const self = createMemo(() => rowRef(props.row, props.resourceKey), undefined, { equals: sameRef });
  const selfId = () => refId(self());
  /** Pinned, or marked with it: then the objects of its name in other clusters are not compared unless asked. */
  const withs = createMemo(() => comparedWith(self()));
  const others = createMemo(() => withs().map((w) => w.ref));
  const pinMode = () => others().length > 0;

  // Rows of the table for the objects compared, by cluster, namespace and name.
  const index = createMemo(() => {
    mainView.version();
    const names = new Set([props.row.n, ...others().map((p) => p.name)]);
    const m = new Map<string, UIRow>();
    for (const r of mainView.rows()) if (names.has(r.n)) m.set(`${r.cl}|${r.ns ?? ""}|${r.n}`, r);
    return m;
  });
  const rowOf = (s: Side) => (s.role === "this" ? props.row : s.ref.resource === props.resourceKey ? index().get(`${s.ref.cluster}|${s.ref.namespace ?? ""}|${s.ref.name}`) : undefined);

  /** Whether a cluster of the table has listed this object's namespace (or failed to). */
  const listed = (c: string): { state: "loading" | "error" | "ready"; message?: string } => {
    const ns = props.row.ns ?? null;
    const sts = Object.values(mainView.statuses).filter((s) => s && s.c === c && (s.ns === null || s.ns === ns));
    if (!sts.length || sts.some((s) => s.state === "connecting" || s.state === "loading")) return { state: "loading" };
    const err = sts.find((st): st is FeedState & { state: "error" } => isError(st));
    return err ? { state: "error", message: err.message } : { state: "ready" };
  };

  const twins = createMemo<Twin[]>(() => {
    const out: Twin[] = [];
    // One compared already (pinned, marked) is not offered again.
    const taken = (c: string) => others().some((o) => sameRef(o, { ...self(), cluster: c }));
    for (const c of selectedClusters()) {
      if (c === props.row.cl || taken(c)) continue;
      const found = index().has(`${c}|${props.row.ns ?? ""}|${props.row.n}`);
      const l = found ? { state: "ready" as const } : listed(c);
      out.push({ cluster: c, extra: false, included: twinIncluded(c, pinMode()), state: found ? "found" : l.state === "ready" ? "missing" : l.state, message: l.message });
    }
    for (const c of extraClusters()) if (c !== props.row.cl && !selectedClusters().includes(c) && !taken(c)) out.push({ cluster: c, extra: true, included: true, state: "found" });
    return out;
  });

  const sides = createMemo(
    (): Side[] => {
      const out: Side[] = [{ id: selfId(), ref: self(), role: "this" }];
      const add = (ref: CompareRef, role: Role) => !out.some((s) => s.id === refId(ref)) && out.push({ id: refId(ref), ref, role });
      for (const p of others()) add(p, "pin");
      for (const t of twins()) if (t.included && t.state === "found") add({ ...self(), cluster: t.cluster }, "twin");
      return out;
    },
    undefined,
    { equals: (a, b) => a.length === b.length && a.every((s, i) => s.id === b[i].id && s.role === b[i].role) },
  );
  const sideById = createMemo(() => new Map(sides().map((s) => [s.id, s])));
  const loaded = loadSides(sides, rowOf);
  const loadedById = createMemo(() => new Map(loaded().map((l) => [l.id, l])));
  const own = () => loadedById().get(selfId());
  /** The objects read, in the order of their sides: this one first. */
  const compared = createMemo(() => loaded().filter((l) => l.obj() !== undefined));
  const ready = () => !!own()?.obj() && compared().length > 1;
  const loading = () => loaded().some((l) => l.loading());

  // ------------------------------------------------------------------ what differs
  const opts = createMemo((): CompareOptions => ({ status: settings().status, noise: settings().noise }), undefined, { equals: (a, b) => a.status === b.status && a.noise === b.noise });
  const objs = createMemo(() => compared().map((l) => l.obj()));
  const listFor = (o: CompareOptions) => (ready() ? changes(objs().map((x) => strip(x, o))) : []);
  const list = createMemo(() => listFor(opts()));
  /** How many more fields differ with status, or the volatile ones, compared too. */
  const more = (key: keyof CompareOptions) => createMemo(() => (opts()[key] || !ready() ? 0 : Math.max(0, listFor({ ...opts(), [key]: true }).length - list().length)));
  const statusMore = more("status");
  const noiseMore = more("noise");

  const [revealed, setRevealed] = createSignal(false);
  const secrets = () => compared().some((l) => isSecret(l.obj()));
  const hideOf = (obj: Json): Hide | undefined => (isSecret(obj) && !revealed() ? secretText : undefined);

  // ------------------------------------------------------------------ two of them, side by side
  const [pairWith, setPairWith] = createSignal<string>();
  const other = createMemo(() => {
    const rest = compared().slice(1);
    return rest.find((l) => l.id === pairWith()) ?? rest[0];
  });
  /** The other object on the left, this one on the right (what changes from it to this one). */
  const [swapped, setSwapped] = createSignal(false);
  const pair = createMemo(() => {
    const b = other()?.obj();
    if (!ready() || b === undefined) return null;
    const a = own()!.obj();
    return swapped() ? pairDiff(strip(b, opts()), strip(a, opts()), hideOf(b), hideOf(a)) : pairDiff(strip(a, opts()), strip(b, opts()), hideOf(a), hideOf(b));
  });
  const [jump, setJump] = createSignal<{ path: Path; n: number } | null>(null);
  /** Another view, at its top (not where a change last jumped to). */
  const show = (view: "changes" | "yaml") => {
    setJump(null);
    setCompareSetting("view", view);
  };
  let jumps = 0;
  /** From a change to the YAML: of this object and the one of `col` (or the first that differs there). */
  const pick = (c: Change, col: number) => {
    let k = col;
    if (k < 1) k = Math.max(1, c.values.findIndex((v, i) => i > 0 && !deepEqual(v, c.values[0])));
    setPairWith(compared()[k]?.id);
    setCompareSetting("view", "yaml");
    setJump({ path: c.path, n: ++jumps });
  };

  // ------------------------------------------------------------------ names
  const kindOf = (resource: string) => discoveredResources().get(resource)?.kind ?? resource.split(".")[0];
  /** What tells an object apart from the others compared: its cluster, kind, namespace or name — whichever differ. */
  const label = (ref: CompareRef): string => {
    const refs = sides().map((s) => s.ref);
    const differ = (f: (r: CompareRef) => string) => new Set(refs.map(f)).size > 1;
    const parts: string[] = [];
    if (differ((r) => r.resource)) parts.push(kindOf(ref.resource));
    if (differ((r) => r.namespace ?? "")) parts.push(ref.namespace ?? "cluster-wide");
    if (differ((r) => r.name)) parts.push(ref.name);
    if (differ((r) => r.cluster) || !parts.length) parts.push(shortName(ref.cluster));
    return parts.join(" · ");
  };
  const fullName = (ref: CompareRef) => `${kindOf(ref.resource)} ${ref.namespace ? `${ref.namespace}/` : ""}${ref.name} in ${ref.cluster}`;
  const Label = (p: { id: string }) => {
    const ref = () => sideById().get(p.id)?.ref;
    return (
      <Show when={ref()}>
        {(r) => (
          <span class="cmp-label" title={fullName(r())}>
            <span class="swatch" style={{ background: clusterColor(r().cluster) }} />
            <span class="ellipsis">{label(r())}</span>
          </span>
        )}
      </Show>
    );
  };

  // ------------------------------------------------------------------ layout
  let root!: HTMLDivElement;
  const [width, setWidth] = createSignal(0);
  onMount(() => {
    const ro = new ResizeObserver(() => setWidth(root.offsetWidth));
    ro.observe(root);
    onCleanup(() => ro.disconnect());
  });
  const split = () => settings().layout === "split" || (settings().layout === "auto" && width() >= SPLIT_FROM);

  // ------------------------------------------------------------------ another cluster
  const [pickAt, setPickAt] = createSignal<HTMLElement>();
  const [pickQuery, setPickQuery] = createSignal("");
  const candidates = createMemo(() => {
    const q = pickQuery().trim().toLowerCase();
    return contexts()
      .map((c) => c.name)
      .filter((n) => n !== props.row.cl && !selectedClusters().includes(n) && !extraClusters().includes(n) && n.toLowerCase().includes(q));
  });
  const addCluster = (c: string | undefined) => {
    if (c) addExtraCluster(c);
    setPickAt(undefined);
    setPickQuery("");
  };

  /** A side's chip: its name, and why it is not compared when it is not (not there, unreadable, still loading). */
  const SideState = (p: { id: string }) => {
    const l = () => loadedById().get(p.id);
    return (
      <Switch>
        <Match when={l()?.missing()}>
          <span class="cmp-note">not there</span>
        </Match>
        <Match when={l()?.error()}>
          <span title={l()!.error()}>
            <Icon name="alert" size={11} class="err-mark" />
          </span>
        </Match>
        <Match when={l()?.loading() && !l()?.obj()}>
          <span class="spinner" style={{ width: "9px", height: "9px" }} />
        </Match>
      </Switch>
    );
  };

  const missingTwins = () => twins().filter((t) => !t.extra && t.state === "missing");

  return (
    <div class="cmp" ref={root}>
      <div class="toolbar">
        <div class="seg">
          <button class="btn sm ghost" classList={{ on: settings().view === "changes" }} onClick={() => show("changes")} title="The fields that differ, in every object compared">
            Changes
          </button>
          <button class="btn sm ghost" classList={{ on: settings().view === "yaml" }} onClick={() => show("yaml")} title="Two of them as YAML, side by side">
            YAML
          </button>
        </div>
        <Show when={settings().view === "yaml" && compared().length > 2}>
          <div class="seg" title="Which object this one is shown against">
            <For each={compared().slice(1)}>
              {(l) => (
                <button class="btn sm ghost" classList={{ on: other()?.id === l.id }} onClick={() => setPairWith(l.id)}>
                  <Label id={l.id} />
                </button>
              )}
            </For>
          </div>
        </Show>
        <span class="grow" />
        <Show when={loading()}>
          <span class="spinner" />
        </Show>
        <button
          class="btn sm ghost"
          classList={{ on: settings().status }}
          aria-pressed={settings().status}
          onClick={() => setCompareSetting("status", !settings().status)}
          title={`Compare status too: what the cluster reports, not what was asked for${statusMore() ? ` (${statusMore()} more field${statusMore() === 1 ? "" : "s"} differ there)` : ""}`}
        >
          Status
          <Show when={statusMore()}>
            <span class="badge">{statusMore()}</span>
          </Show>
        </button>
        <button
          class="btn sm ghost"
          classList={{ on: settings().noise }}
          aria-pressed={settings().noise}
          onClick={() => setCompareSetting("noise", !settings().noise)}
          title={`Compare what differs between any two objects too: uid, resourceVersion, generation, creation time, managed fields, owners' uids, last-applied-configuration, the rollout's revision, the IPs and node ports a cluster picked for a Service${noiseMore() ? ` (${noiseMore()} more field${noiseMore() === 1 ? "" : "s"} differ there)` : ""}`}
        >
          Volatile
          <Show when={noiseMore()}>
            <span class="badge">{noiseMore()}</span>
          </Show>
        </button>
        <Show when={secrets()}>
          <button class="btn sm ghost" classList={{ on: revealed() }} aria-pressed={revealed()} onClick={() => setRevealed(!revealed())} title={revealed() ? "Hide the Secrets' values again" : "Show the Secrets' values (data, stringData)"}>
            <Icon name={revealed() ? "eye-off" : "eye"} size={12} />
            {revealed() ? "Hide values" : "Reveal values"}
          </button>
        </Show>
        <Show when={settings().view === "yaml"}>
          <button class="btn sm ghost icon" onClick={() => setCompareSetting("layout", split() ? "unified" : "split")} title={split() ? "One column: lines removed, then added" : "Side by side"}>
            <Icon name={split() ? "list" : "columns"} size={13} />
          </button>
        </Show>
      </div>

      <div class="cmp-sides">
        <span class="chip cmp-this" title={fullName(self())}>
          <span class="swatch" style={{ background: clusterColor(self().cluster) }} />
          {label(self())}
        </span>
        <span class="faint">vs</span>
        <For each={withs()}>
          {({ ref: p, marked }) => (
            <span class="chip removable cmp-chip">
              <button
                class="chip-open"
                onClick={() => revealObject({ ...p, namespace: p.namespace ?? undefined })}
                title={`${fullName(p)} — ${marked ? `marked with ${props.row.n} when = was pressed` : "pinned (+): every object is compared with it"}. Click to go to it.`}
              >
                <Icon name={marked ? "compare" : "pin"} size={11} />
                <span class="swatch" style={{ background: clusterColor(p.cluster) }} />
                <span class="ellipsis">{label(p)}</span>
                <SideState id={refId(p)} />
              </button>
              <button class="chip-x" onClick={() => unpin(p)} title={marked ? "Leave it out" : "Unpin"}>
                <Icon name="x" size={10} />
              </button>
            </span>
          )}
        </For>
        {/* Next to pins, clusters without an object of its name are no news (a pod's name is its own). */}
        <For each={twins().filter((t) => !(pinMode() && t.state === "missing"))}>
          {(t) => {
            const id = () => refId({ ...self(), cluster: t.cluster });
            const toggle = () => (t.extra ? removeExtraCluster(t.cluster) : t.state === "found" && toggleTwin(t.cluster, pinMode()));
            const title = () =>
              t.extra
                ? `${props.row.n} in ${t.cluster} — click to stop comparing with it`
                : t.state === "missing"
                  ? `There is no ${props.row.n} in ${t.cluster}${props.row.ns ? ` (namespace ${props.row.ns})` : ""}`
                  : t.state === "error"
                    ? `${t.cluster}: ${t.message ?? "cannot list"}`
                    : t.state === "loading"
                      ? `${t.cluster}: loading`
                      : `${props.row.n} in ${t.cluster} — click to ${t.included ? "leave it out" : "compare with it"}`;
            return (
              <button class="chip cmp-chip twin" classList={{ off: !t.included || t.state !== "found", missing: t.state === "missing" }} aria-pressed={t.included} onClick={toggle} title={title()}>
                <span class="swatch" style={{ background: clusterColor(t.cluster) }} />
                <span class="ellipsis">{shortName(t.cluster)}</span>
                <Switch>
                  <Match when={t.extra}>
                    <SideState id={id()} />
                    <Icon name="x" size={10} />
                  </Match>
                  <Match when={t.state === "missing"}>
                    <span class="cmp-note">not there</span>
                  </Match>
                  <Match when={t.state === "loading"}>
                    <span class="spinner" style={{ width: "9px", height: "9px" }} />
                  </Match>
                  <Match when={t.state === "error"}>
                    <Icon name="lock" size={10} />
                  </Match>
                  <Match when={t.included}>
                    <SideState id={id()} />
                  </Match>
                </Switch>
              </button>
            );
          }}
        </For>
        <button class="btn sm ghost cmp-add" onClick={(e) => setPickAt(e.currentTarget)} title={`Compare with ${props.row.n} in a cluster outside the table`}>
          <Icon name="plus" size={11} />
          Cluster
        </button>
      </div>

      <div class="cmp-body">
      <Switch>
        <Match when={own()?.error() && !own()?.obj()}>
          <div class="section error-text">{own()!.error()}</div>
        </Match>
        <Match when={own()?.missing()}>
          <div class="table-empty">
            <h3>{props.row.n} is not there any more</h3>
          </div>
        </Match>
        <Match when={!own()?.obj()}>
          <div class="table-empty">
            <span class="spinner" />
          </div>
        </Match>
        <Match when={sides().length < 2}>
          <div class="table-empty cmp-empty">
            <Icon name="compare" size={26} />
            <h3>Nothing to compare {props.row.n} with yet</h3>
            <Show when={missingTwins().length}>
              <p>
                It is not in {missingTwins().map((t) => shortName(t.cluster)).join(", ")}
                {props.row.ns ? ` (namespace ${props.row.ns})` : ""}.
              </p>
            </Show>
            <p>
              Mark rows with <span class="kbd">{comboLabel("space")}</span> and press <span class="kbd">=</span> to compare them. Or pin an object with <span class="kbd">+</span> — of any cluster,
              namespace or kind: Compare on any other object compares it with that one.
            </p>
            <button class="btn sm" onClick={(e) => setPickAt(e.currentTarget)}>
              <Icon name="plus" size={12} />
              {props.row.n} in another cluster…
            </button>
          </div>
        </Match>
        <Match when={!ready()}>
          <div class="table-empty">
            <Show when={loading()} fallback={<p>None of the objects compared could be read: see their chips above.</p>}>
              <span class="spinner" />
            </Show>
          </div>
        </Match>
        <Match when={settings().view === "changes"}>
          <ChangesTable cols={compared()} list={list()} label={(id) => <Label id={id} />} hideOf={hideOf} revealed={revealed()} onPick={pick} status={statusMore()} noise={noiseMore()} />
        </Match>
        <Match when={pair()}>
          {(d) => (
            <DiffView
              diff={d()}
              split={split()}
              left={<Label id={swapped() ? other()!.id : selfId()} />}
              right={<Label id={swapped() ? selfId() : other()!.id} />}
              onSwap={() => setSwapped(!swapped())}
              pairKey={`${selfId()}>${other()?.id}>${swapped()}`}
              jump={jump()}
            />
          )}
        </Match>
      </Switch>
      </div>

      <Show when={pickAt()}>
        <Popover anchor={pickAt()} onClose={() => addCluster(undefined)} width={300} maxHeight={380}>
          <div class="menu cmp-pick">
            <div class="pop-group">{props.row.n} in another cluster</div>
            <input
              class="input"
              placeholder="Filter clusters"
              value={pickQuery()}
              ref={(e) => queueMicrotask(() => e.focus())}
              onInput={(e) => setPickQuery(e.currentTarget.value)}
              onKeyDown={(e) => e.key === "Enter" && addCluster(candidates()[0])}
              spellcheck={false}
            />
            <For each={candidates().slice(0, 200)} fallback={<div class="opt faint">{contexts().length > 1 ? "No other cluster matches" : "There is no other cluster in the kubeconfig"}</div>}>
              {(c) => (
                <button class="opt" onClick={() => addCluster(c)}>
                  <span class="ellipsis">{c}</span>
                </button>
              )}
            </For>
          </div>
        </Popover>
      </Show>
    </div>
  );
}

/** The fields that differ, one row each, every object's value in its column; this object's first. */
function ChangesTable(props: {
  cols: Loaded[];
  list: Change[];
  label: (id: string) => JSX.Element;
  hideOf: (obj: Json) => Hide | undefined;
  revealed: boolean;
  onPick: (c: Change, col: number) => void;
  /** More fields that differ in status / the volatile ones, not compared. */
  status: number;
  noise: number;
}) {
  const shown = () => props.list.slice(0, MAX_CHANGES);
  const hides = createMemo(() => props.cols.map((l) => props.hideOf(l.obj())));
  /** What differs where it is not compared: "3 in status, 4 volatile". */
  const notCompared = () => [props.status ? `${props.status} in status` : "", props.noise ? `${props.noise} volatile` : ""].filter(Boolean).join(", ");
  return (
    <Show
      when={props.list.length}
      fallback={
        <div class="table-empty cmp-same">
          <Icon name="check" size={26} />
          <h3>Identical</h3>
          <p>
            {props.cols.length > 2 ? `All ${props.cols.length} are the same` : "They are the same"}
            {notCompared() ? `, but for fields not compared: ${notCompared()} (Status, Volatile above).` : "."}
          </p>
        </div>
      }
    >
      <div class="cmp-scroll scroller">
        <div class="cmp-summary faint">
          {props.list.length} field{props.list.length === 1 ? "" : "s"} differ{props.list.length === 1 ? "s" : ""}
          {notCompared() ? ` · not compared: ${notCompared()}` : ""}
          {props.list.length > MAX_CHANGES ? ` · the first ${MAX_CHANGES} shown` : ""}
        </div>
        {/* Columns too narrow to read scroll sideways instead. */}
        <table class="cmp-table" style={{ "min-width": `${180 + props.cols.length * 110}px` }}>
          <thead>
            <tr>
              <th>Field</th>
              <For each={props.cols}>{(l) => <th>{props.label(l.id)}</th>}</For>
            </tr>
          </thead>
          <tbody>
            <For each={shown()}>
              {(c, i) => {
                const full = pathText(c.path);
                const last = pathText(c.path.slice(-1));
                const cut = sharedCut(c.values);
                return (
                  <tr classList={{ "sec-start": i() > 0 && shown()[i() - 1].path[0] !== c.path[0] }}>
                    {/* Cut at its start when it does not fit: the field is at its end. */}
                    <td class="cmp-path" title={`${full}\nClick: the YAML here`} onClick={() => props.onPick(c, 0)}>
                      <span class="cmp-path-text">
                        <span class="faint">{full.slice(0, full.length - last.length)}</span>
                        {last}
                      </span>
                    </td>
                    <For each={c.values}>
                      {(v, k) => {
                        const same = k() > 0 && deepEqual(v, c.values[0]);
                        // Again when values are revealed or hidden.
                        const shown = createMemo(() => {
                          const x = cell(v, c.path, hides()[k()], props.revealed);
                          // Texts: the first line that differs from this object's.
                          const lines = k() > 0 && !same && x.kind === "more" && isBlock(v) && isBlock(c.values[0]) ? textChange(c.values[0], v) : null;
                          const text = lines ? `${lines.first}${lines.more ? ` (+${lines.more} more)` : ""}` : cut && x.text === v ? `…${x.text.slice(cut)}` : x.text;
                          return { ...x, text };
                        });
                        return (
                          <td class={`cmp-val ${shown().kind}`} classList={{ same, diff: k() > 0 && !same }} title={shown().title} onClick={() => props.onPick(c, k())}>
                            {shown().text}
                          </td>
                        );
                      }}
                    </For>
                  </tr>
                );
              }}
            </For>
          </tbody>
        </table>
      </div>
    </Show>
  );
}
