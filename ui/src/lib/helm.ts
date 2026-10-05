import type { ResourceInfo } from "./backend";

/**
 * Helm releases are no Kubernetes resource: the engine reads them from their records (Secrets) and serves them as a
 * table under this key. A stand-in resource puts them in the sidebar, the palette (`:helm`, `:hm`) and the views.
 */
export const HELM_RELEASES = "helmreleases";

export const HELM_RESOURCE: ResourceInfo = {
  key: HELM_RELEASES,
  group: "helm.sh",
  version: "v3",
  kind: "Release",
  plural: "releases",
  singular: "release",
  namespaced: true,
  // What k10s does with them itself; changes go through `helm` (see `registry/helmActions.ts`).
  verbs: ["list", "get"],
  shortNames: ["helm", "hm"],
  categories: [],
  subresources: [],
};
