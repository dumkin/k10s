import type { AccessRules } from "./backend";

// "My permissions": what the user may do, per resource and verb, as each cluster's API server lists it (a
// SelfSubjectRulesReview in a namespace). Pure: rules in, answers out.

/** The "My permissions" view's key, where a resource's would be. */
export const PERMISSIONS = "permissions";

export const VERBS = ["get", "list", "watch", "create", "update", "patch", "delete"] as const;
export type Verb = (typeof VERBS)[number];

export interface PermissionRow {
  /** Resource key (for the icon and to open it). */
  key: string;
  title: string;
  group: string;
  resource: string;
  subresource?: string;
  /** The verbs that mean something for it (a subresource: the one it is used with). */
  verbs: readonly Verb[];
  /** Cluster-scoped: the namespace's rules do not answer for it (access reviews do). */
  cluster?: boolean;
  /** What it is for, said beside a subresource ("shell"). */
  hint?: string;
  /** A stream into a pod: `create` since Kubernetes 1.30, `get` before (its one verb is asked as the cluster takes it). */
  stream?: boolean;
}

export const PERMISSION_ROWS: PermissionRow[] = [
  { key: "pods", title: "Pods", group: "", resource: "pods", verbs: VERBS },
  { key: "pods", title: "Shell", group: "", resource: "pods", subresource: "exec", verbs: ["create"], hint: "pods/exec", stream: true },
  { key: "pods", title: "Logs", group: "", resource: "pods", subresource: "log", verbs: ["get"], hint: "pods/log" },
  { key: "pods", title: "Port-forward", group: "", resource: "pods", subresource: "portforward", verbs: ["create"], hint: "pods/portforward", stream: true },
  { key: "pods", title: "Debug containers", group: "", resource: "pods", subresource: "ephemeralcontainers", verbs: ["patch"], hint: "pods/ephemeralcontainers" },
  { key: "deployments.apps", title: "Deployments", group: "apps", resource: "deployments", verbs: VERBS },
  { key: "statefulsets.apps", title: "StatefulSets", group: "apps", resource: "statefulsets", verbs: VERBS },
  { key: "daemonsets.apps", title: "DaemonSets", group: "apps", resource: "daemonsets", verbs: VERBS },
  { key: "replicasets.apps", title: "ReplicaSets", group: "apps", resource: "replicasets", verbs: VERBS },
  { key: "jobs.batch", title: "Jobs", group: "batch", resource: "jobs", verbs: VERBS },
  { key: "cronjobs.batch", title: "CronJobs", group: "batch", resource: "cronjobs", verbs: VERBS },
  { key: "services", title: "Services", group: "", resource: "services", verbs: VERBS },
  { key: "ingresses.networking.k8s.io", title: "Ingresses", group: "networking.k8s.io", resource: "ingresses", verbs: VERBS },
  { key: "configmaps", title: "Config Maps", group: "", resource: "configmaps", verbs: VERBS },
  { key: "secrets", title: "Secrets", group: "", resource: "secrets", verbs: VERBS },
  { key: "persistentvolumeclaims", title: "Volume Claims", group: "", resource: "persistentvolumeclaims", verbs: VERBS },
  { key: "serviceaccounts", title: "Service Accounts", group: "", resource: "serviceaccounts", verbs: VERBS },
  { key: "horizontalpodautoscalers.autoscaling", title: "HPA", group: "autoscaling", resource: "horizontalpodautoscalers", verbs: VERBS },
  { key: "poddisruptionbudgets.policy", title: "Disruption Budgets", group: "policy", resource: "poddisruptionbudgets", verbs: VERBS },
  { key: "networkpolicies.networking.k8s.io", title: "Network Policies", group: "networking.k8s.io", resource: "networkpolicies", verbs: VERBS },
  { key: "roles.rbac.authorization.k8s.io", title: "Roles", group: "rbac.authorization.k8s.io", resource: "roles", verbs: VERBS },
  { key: "rolebindings.rbac.authorization.k8s.io", title: "Role Bindings", group: "rbac.authorization.k8s.io", resource: "rolebindings", verbs: VERBS },
  { key: "events", title: "Events", group: "", resource: "events", verbs: ["get", "list", "watch"] },
  { key: "nodes", title: "Nodes", group: "", resource: "nodes", verbs: ["get", "list", "watch", "patch", "delete"], cluster: true },
  { key: "namespaces", title: "Namespaces", group: "", resource: "namespaces", verbs: ["get", "list", "watch", "create", "delete"], cluster: true },
  { key: "persistentvolumes", title: "Volumes", group: "", resource: "persistentvolumes", verbs: ["get", "list", "watch", "delete"], cluster: true },
  { key: "customresourcedefinitions.apiextensions.k8s.io", title: "CRDs", group: "apiextensions.k8s.io", resource: "customresourcedefinitions", verbs: ["get", "list", "watch"], cluster: true },
];

/** Yes; only some objects (a rule names them); no. */
export type Answer = "yes" | "some" | "no";

const has = (list: string[] | undefined, value: string) => !!list && (list.includes(value) || list.includes("*"));

// Whether a rule's resources cover `resource` (or `resource/subresource`): by name, "*", "*/sub" or "resource/*".
function coversResource(resources: string[], resource: string, subresource?: string): boolean {
  if (!subresource) return resources.includes(resource) || resources.includes("*");
  return resources.includes(`${resource}/${subresource}`) || resources.includes(`*/${subresource}`) || resources.includes(`${resource}/*`) || resources.includes("*");
}

/** What `rules` allow for `verb` on a resource, as the API server would authorize it. */
export function answer(rules: AccessRules, verb: string, group: string, resource: string, subresource?: string): Answer {
  let some = false;
  for (const r of rules.resources) {
    if (!has(r.verbs, verb) || !has(r.groups, group) || !coversResource(r.resources, resource, subresource)) continue;
    if (!r.names?.length) return "yes";
    some = true;
  }
  return some ? "some" : "no";
}
