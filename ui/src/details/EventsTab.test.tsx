import { render } from "solid-js/web";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Tone, type ViewSpec } from "../lib/backend";
import type { FeedState, UIRow } from "../state/view";

// The events feed, as the tests set it.
const feed = vi.hoisted(() => ({ spec: undefined as ViewSpec | undefined, statuses: {} as Record<string, FeedState>, loading: false, rows: [] as UIRow[] }));
vi.mock("../state/view", () => ({
  createViewFeed: (spec: () => ViewSpec) => {
    feed.spec = spec();
    return { rows: () => feed.rows, statuses: feed.statuses, loading: () => feed.loading, version: () => 0, columns: () => [], resolved: {}, notices: {}, rowByKey: () => undefined };
  },
}));

import { EventsTab, eventsSpec } from "./EventsTab";

const pod: UIRow = { key: "prod-eu-z1/u-1", cl: "prod-eu-z1", u: "u-1", n: "payments-api-0", ns: "payments", rv: "1", t: 0, s: Tone.Ok, c: [] };
const node: UIRow = { key: "prod-eu-z1/u-2", cl: "prod-eu-z1", u: "u-2", n: "node-a1", rv: "1", t: 0, s: Tone.Ok, c: [] };
const pv: UIRow = { key: "prod-eu-z1/u-3", cl: "prod-eu-z1", u: "u-3", n: "pv-data", rv: "1", t: 0, s: Tone.Ok, c: [] };

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.innerHTML = "";
  Object.assign(feed, { statuses: {}, loading: false, rows: [] });
});

function show(row: UIRow, resourceKey = "pods") {
  const root = document.createElement("div");
  document.body.append(root);
  dispose = render(() => <EventsTab row={row} resourceKey={resourceKey} target={{ cluster: row.cl, resource: resourceKey, namespace: row.ns ?? null, name: row.n, uid: row.u }} />, root);
  return root;
}

describe("eventsSpec", () => {
  it("matches an object's events by uid in its namespace", () => {
    expect(eventsSpec({ row: pod, resourceKey: "pods" })).toEqual({ resource: "events", clusters: ["prod-eu-z1"], namespaces: ["payments"], fieldSelector: "involvedObject.uid=u-1" });
  });

  it("looks for cluster-scoped objects' events in default, and for nodes' by name (the kubelet uses the name as uid)", () => {
    expect(eventsSpec({ row: pv, resourceKey: "persistentvolumes" })).toMatchObject({ namespaces: ["default"], fieldSelector: "involvedObject.uid=u-3" });
    expect(eventsSpec({ row: node, resourceKey: "nodes" })).toMatchObject({ namespaces: ["default"], fieldSelector: "involvedObject.kind=Node,involvedObject.name=node-a1" });
  });
});

describe("EventsTab", () => {
  it("says when events may not be read, instead of 'No events'", () => {
    feed.statuses["prod-eu-z1|payments"] = { c: "prod-eu-z1", ns: "payments", state: "error", message: 'events is forbidden: User "jane" cannot list resource "events" in the namespace "payments"', code: 403, reason: "Forbidden", terminal: true };
    const root = show(pod);
    expect(root.querySelector("h3")?.textContent).toBe("No permission to list events in payments");
    expect(root.textContent).toContain('cannot list resource "events"');
    expect(root.textContent).not.toContain("No events");
  });

  it("shows other errors with their message", () => {
    feed.statuses["prod-eu-z1|"] = { c: "prod-eu-z1", ns: null, state: "error", message: 'cluster "prod-eu-z1": no answer within 60s' };
    const root = show(node, "nodes");
    expect(root.querySelector("h3")?.textContent).toBe("Could not load events");
    expect(root.textContent).toContain("Error: cluster \"prod-eu-z1\": no answer within 60s");
    expect(root.textContent).toContain("Retrying…");
  });

  it("shows a spinner while loading, and 'No events' only once the feed is ready", () => {
    feed.loading = true;
    let root = show(pod);
    expect(root.querySelector(".spinner")).not.toBeNull();
    expect(root.textContent).not.toContain("No events");
    dispose?.();
    feed.loading = false;
    feed.statuses["prod-eu-z1|payments"] = { c: "prod-eu-z1", ns: "payments", state: "ready" };
    root = show(pod);
    expect(root.querySelector("h3")?.textContent).toBe("No events");
  });

  it("keeps the events it has when the feed fails later, and says it is not updating", () => {
    feed.rows = [{ ...pod, key: "e1", u: "e1", n: "payments-api-0.1", c: [100, ["Warning", Tone.Warn], "BackOff", "pod/payments-api-0", "Back-off restarting failed container", 3, "kubelet", 50] }];
    feed.statuses["prod-eu-z1|payments"] = { c: "prod-eu-z1", ns: "payments", state: "error", message: "Unauthorized", code: 401 };
    const root = show(pod);
    expect(root.textContent).toContain("BackOff");
    expect(root.querySelector(".ns-hint")?.textContent).toContain("Not updating");
  });
});
