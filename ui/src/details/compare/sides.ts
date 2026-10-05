import { type Accessor, createMemo, mapArray } from "solid-js";
import { backend, toError } from "../../lib/backend";
import type { Json } from "../../lib/compare/yaml";
import { isError } from "../../lib/k8s";
import type { CompareRef } from "../../state/compare";
import { createViewFeed, type UIRow } from "../../state/view";
import { createSafeResource } from "../common";

/** The object the tab is of, one pinned, or one of the same name in another cluster. */
export type Role = "this" | "pin" | "twin";

export interface Side {
  id: string;
  ref: CompareRef;
  role: Role;
}

/** A side's object as it is now, or why there is none. */
export interface Loaded {
  id: string;
  obj: Accessor<Json | undefined>;
  error: Accessor<string | undefined>;
  /** Not there: never created in that cluster, or deleted. */
  missing: Accessor<boolean>;
  loading: Accessor<boolean>;
}

/**
 * Reads each side's object, and again whenever it changes: told by its row in the table when it has one (its
 * resourceVersion), else by a watch of that object alone (a field selector on its name).
 */
export function loadSides(sides: Accessor<Side[]>, rowOf: (s: Side) => UIRow | undefined): Accessor<Loaded[]> {
  const byId = createMemo(() => new Map(sides().map((s) => [s.id, s])));
  return createMemo(
    mapArray(
      () => sides().map((s) => s.id),
      (id): Loaded => {
        const side = () => byId().get(id);
        const row = createMemo(() => {
          const s = side();
          return s ? rowOf(s) : undefined;
        });
        const feed = createViewFeed(() => {
          const s = side();
          if (!s || row()) return null;
          return { resource: s.ref.resource, clusters: [s.ref.cluster], namespaces: s.ref.namespace ? [s.ref.namespace] : [], fieldSelector: `metadata.name=${s.ref.name}` };
        });
        const watchError = () => Object.values(feed.statuses).find(isError);
        // The watch listed it, and it is not there (one that cannot list it reads it anyway).
        const unlisted = () => !row() && !feed.loading() && !feed.rows().length && !watchError();
        const obj = createSafeResource(
          () => {
            const s = side();
            // Read once the watch has listed it: its resourceVersion is known then (not a read now and another then).
            if (!s || (!row() && feed.loading()) || unlisted()) return null;
            return { ref: s.ref, rv: row()?.rv ?? feed.rows()[0]?.rv ?? "" };
          },
          ({ ref }) => backend().getObject({ ...ref }) as Promise<Json>,
        );
        const notFound = () => toError(obj.error() ?? {}).code === 404;
        const missing = () => unlisted() || (!!obj.error() && notFound());
        return {
          id,
          obj: () => (missing() ? undefined : obj.value()),
          error: () => (obj.error() && !notFound() ? toError(obj.error()).message : undefined),
          missing,
          loading: () => obj.loading() || (!row() && feed.loading()),
        };
      },
    ),
  );
}
