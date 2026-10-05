import type { IconName } from "../components/Icon";

// Sidebar catalog of well-known resources. Anything discovery finds that is not listed here appears
// under "Custom Resources", grouped by API group — so CRDs show up automatically.

export interface CatalogEntry {
  /** Resource key, as produced by discovery (`deployments.apps`). */
  key: string;
  title: string;
  icon: IconName;
}

export interface CatalogSection {
  id: string;
  title: string;
  entries: CatalogEntry[];
}

export const CATALOG: CatalogSection[] = [
  {
    id: "cluster",
    title: "Cluster",
    entries: [
      { key: "nodes", title: "Nodes", icon: "node" },
      { key: "namespaces", title: "Namespaces", icon: "namespace" },
      { key: "events", title: "Events", icon: "event" },
    ],
  },
  {
    id: "workloads",
    title: "Workloads",
    entries: [
      { key: "pods", title: "Pods", icon: "pod" },
      { key: "deployments.apps", title: "Deployments", icon: "deployment" },
      { key: "statefulsets.apps", title: "StatefulSets", icon: "statefulset" },
      { key: "daemonsets.apps", title: "DaemonSets", icon: "daemonset" },
      { key: "replicasets.apps", title: "ReplicaSets", icon: "replicaset" },
      { key: "jobs.batch", title: "Jobs", icon: "job" },
      { key: "cronjobs.batch", title: "CronJobs", icon: "cronjob" },
    ],
  },
  {
    id: "network",
    title: "Network",
    entries: [
      { key: "services", title: "Services", icon: "service" },
      { key: "ingresses.networking.k8s.io", title: "Ingresses", icon: "ingress" },
      { key: "endpointslices.discovery.k8s.io", title: "Endpoint Slices", icon: "endpoint" },
      { key: "endpoints", title: "Endpoints", icon: "endpoint" },
      { key: "networkpolicies.networking.k8s.io", title: "Network Policies", icon: "shield" },
      { key: "ingressclasses.networking.k8s.io", title: "Ingress Classes", icon: "tag" },
    ],
  },
  {
    id: "config",
    title: "Config",
    entries: [
      { key: "configmaps", title: "Config Maps", icon: "config" },
      { key: "secrets", title: "Secrets", icon: "secret" },
      { key: "horizontalpodautoscalers.autoscaling", title: "HPA", icon: "gauge" },
      { key: "poddisruptionbudgets.policy", title: "Disruption Budgets", icon: "shield" },
      { key: "resourcequotas", title: "Resource Quotas", icon: "pie" },
      { key: "limitranges", title: "Limit Ranges", icon: "ruler" },
      { key: "priorityclasses.scheduling.k8s.io", title: "Priority Classes", icon: "flag" },
      { key: "leases.coordination.k8s.io", title: "Leases", icon: "timer" },
    ],
  },
  {
    id: "storage",
    title: "Storage",
    entries: [
      { key: "persistentvolumeclaims", title: "Volume Claims", icon: "volume" },
      { key: "persistentvolumes", title: "Volumes", icon: "storage" },
      { key: "storageclasses.storage.k8s.io", title: "Storage Classes", icon: "storage" },
      { key: "volumeattachments.storage.k8s.io", title: "Attachments", icon: "link" },
    ],
  },
  {
    id: "helm",
    title: "Helm",
    entries: [{ key: "helmreleases", title: "Releases", icon: "layers" }],
  },
  {
    id: "access",
    title: "Access Control",
    entries: [
      { key: "serviceaccounts", title: "Service Accounts", icon: "user" },
      { key: "roles.rbac.authorization.k8s.io", title: "Roles", icon: "lock" },
      { key: "rolebindings.rbac.authorization.k8s.io", title: "Role Bindings", icon: "users" },
      { key: "clusterroles.rbac.authorization.k8s.io", title: "Cluster Roles", icon: "lock" },
      { key: "clusterrolebindings.rbac.authorization.k8s.io", title: "Cluster Role Bindings", icon: "users" },
      // No resource: what the user may do, cluster by cluster (`components/Permissions.tsx`).
      { key: "permissions", title: "My permissions", icon: "user" },
    ],
  },
  {
    id: "admin",
    title: "Extensions",
    entries: [
      { key: "customresourcedefinitions.apiextensions.k8s.io", title: "CRDs", icon: "crd" },
      { key: "apiservices.apiregistration.k8s.io", title: "API Services", icon: "layers" },
      { key: "mutatingwebhookconfigurations.admissionregistration.k8s.io", title: "Mutating Webhooks", icon: "webhook" },
      { key: "validatingwebhookconfigurations.admissionregistration.k8s.io", title: "Validating Webhooks", icon: "webhook" },
    ],
  },
];

const BY_KEY = new Map(CATALOG.flatMap((s) => s.entries.map((e) => [e.key, e] as const)));

export function catalogEntry(key: string): CatalogEntry | undefined {
  return BY_KEY.get(key);
}

export function isCatalogued(key: string): boolean {
  return BY_KEY.has(key);
}

/** Groups whose resources are infrastructure noise in the "Custom Resources" list. */
const HIDDEN_GROUPS = new Set([
  "authentication.k8s.io",
  "authorization.k8s.io",
  "metrics.k8s.io",
  "flowcontrol.apiserver.k8s.io",
  "certificates.k8s.io",
  "node.k8s.io",
  "events.k8s.io",
  "resource.k8s.io",
  "internal.apiserver.k8s.io",
  "storagemigration.k8s.io",
]);

export function isHiddenGroup(group: string): boolean {
  return HIDDEN_GROUPS.has(group);
}

/** Fallback title for non-catalogued resources: `ServiceMonitor` → `Service Monitors`. */
export function titleFor(kind: string): string {
  const words = kind.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
  if (/[^aeiou]y$/i.test(words)) return `${words.slice(0, -1)}ies`;
  if (/(s|x|ch|sh)$/i.test(words)) return `${words}es`;
  return `${words}s`;
}
