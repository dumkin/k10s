import { createEffect, createMemo, For, Match, Show, Switch } from "solid-js";
import { Icon } from "../components/Icon";
import { type Cell, type ViewSpec, Tone } from "../lib/backend";
import { age } from "../lib/format";
import { errorTitle, isError, isForbidden } from "../lib/k8s";
import { type DetailProps, deferReady } from "../registry/details";
import { now } from "../state/ui";
import { createViewFeed, type FeedState } from "../state/view";

/**
 * Where the events of an object are: its namespace, or `default` for cluster-scoped objects (event
 * recorders put them there; listing events across all namespaces would need cluster-wide access for
 * nothing). Matched by uid — except nodes: the kubelet records node events with the node's name as its
 * uid, so nodes are matched by kind and name.
 */
export function eventsSpec(p: Pick<DetailProps, "row" | "resourceKey">): ViewSpec {
  const node = p.resourceKey === "nodes";
  return {
    resource: "events",
    clusters: [p.row.cl],
    namespaces: [p.row.ns || "default"],
    fieldSelector: node ? `involvedObject.kind=Node,involvedObject.name=${p.row.n}` : `involvedObject.uid=${p.row.u}`,
  };
}

/** Events whose involvedObject is the selected object, streamed live via a field-selector watch. */
export function EventsTab(props: DetailProps) {
  const feed = createViewFeed(() => eventsSpec(props));
  // Event columns: lastSeen, type, reason, object, message, count, source, firstSeen
  const events = createMemo(() =>
    [...feed.rows()].sort((a, b) => ((b.c[0] as number) ?? b.t) - ((a.c[0] as number) ?? a.t)),
  );
  const status = (c: Cell) => (Array.isArray(c) ? (c as [string, Tone]) : null);
  /** Why events can't be shown (or may be stale): the feed's error, if any. */
  const error = createMemo(() => Object.values(feed.statuses).find((s): s is FeedState & { state: "error" } => isError(s)));
  const namespace = () => eventsSpec(props).namespaces[0];
  // The panel keeps showing the previous object until the watch has answered (with events, none, or an error).
  const ready = deferReady();
  createEffect(() => (!feed.loading() || events().length || error()) && ready());

  return (
    <Show
      when={events().length}
      fallback={
        <div class="table-empty" style={{ inset: "0" }}>
          <Switch
            fallback={
              <>
                <Icon name="event" size={26} />
                <h3>No events</h3>
                <p>Kubernetes keeps events for about an hour; nothing was recorded for this object recently.</p>
              </>
            }
          >
            <Match when={error() && isForbidden(error())}>
              <Icon name="lock" size={26} />
              <h3>No permission to list events in {namespace()}</h3>
              <p>Your role doesn't allow reading events there, so this object's events can't be shown. It doesn't mean there are none.</p>
              <p class="faint selectable" style={{ "font-size": "var(--fs-xs)" }}>
                {error()!.message}
              </p>
            </Match>
            <Match when={error()}>
              {(e) => (
                <>
                  <Icon name="alert" size={26} style={{ color: "var(--err)" }} />
                  <h3>Could not load events</h3>
                  <p class="error-text">
                    {errorTitle(e())}: {e().message}
                  </p>
                  <Show when={!e().terminal}>
                    <p>Retrying…</p>
                  </Show>
                </>
              )}
            </Match>
            <Match when={feed.loading()}>
              <span class="spinner" />
            </Match>
          </Switch>
        </div>
      }
    >
      <Show when={error()}>
        {(e) => (
          <div class="ns-hint" style={{ margin: "0 0 10px" }} title={e().message}>
            <Icon name="alert" size={13} />
            <span class="selectable">
              Not updating — {errorTitle(e())}: {e().message}
            </span>
          </div>
        )}
      </Show>
      <div class="section">
        <table class="mini-table">
          <thead>
            <tr>
              <th>Type</th>
              <th>Reason</th>
              <th>Message</th>
              <th>Count</th>
              <th>Last seen</th>
            </tr>
          </thead>
          <tbody>
            <For each={events()}>
              {(e) => {
                const st = status(e.c[1]);
                return (
                  <tr>
                    <td>
                      <span class={`badge ${st?.[1] === Tone.Warn ? "warn" : ""}`}>{st?.[0] ?? ""}</span>
                    </td>
                    <td style={{ "font-weight": 500, "white-space": "nowrap" }}>{e.c[2] as string}</td>
                    <td class="msg">{e.c[4] as string}</td>
                    <td class="faint">{e.c[5] as number}</td>
                    <td class="faint" style={{ "white-space": "nowrap" }}>
                      {age((e.c[0] as number) ?? e.t, now())}
                    </td>
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
