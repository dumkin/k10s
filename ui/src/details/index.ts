import { HELM_RELEASES } from "../lib/helm";
import { registerDetailTab } from "../registry/details";
import { CompareTab } from "./compare/CompareTab";
import { HistoryTab, ManifestTab, ReleaseTab, ValuesTab } from "./Helm";
import { EventsTab } from "./EventsTab";
import { LogsTab } from "./LogsTab";
import { Overview } from "./Overview";
import { RELATED, RelationsTab } from "./Relations";
import { YamlTab } from "./YamlTab";

const LOGGABLE = new Set(["pods", "deployments.apps", "statefulsets.apps", "daemonsets.apps", "replicasets.apps", "jobs.batch", "services"]);
const NO_EVENTS = new Set(["events", "events.events.k8s.io", HELM_RELEASES]);
/** Not a Kubernetes object: no generic Overview or YAML (their tabs below). */
const object = (key: string) => key !== HELM_RELEASES;

registerDetailTab({ id: "overview", title: "Overview", icon: "info", shortcut: "d", order: 0, when: object, component: Overview });
registerDetailTab({ id: "relations", title: "Relations", icon: "relations", shortcut: "r", order: 5, when: (key) => RELATED.has(key), component: RelationsTab, flush: true });
registerDetailTab({ id: "logs", title: "Logs", icon: "logs", shortcut: "l", order: 10, when: (key) => LOGGABLE.has(key), component: LogsTab, flush: true });
registerDetailTab({ id: "events", title: "Events", icon: "event", shortcut: "e", order: 20, when: (key) => !NO_EVENTS.has(key), component: EventsTab });
registerDetailTab({ id: "yaml", title: "YAML", icon: "code", shortcut: "y", order: 30, when: object, component: YamlTab, flush: true });
// Events are records of what happened, nothing to compare.
registerDetailTab({ id: "compare", title: "Compare", icon: "compare", shortcut: "=", order: 40, when: (key) => object(key) && !NO_EVENTS.has(key), component: CompareTab, flush: true });

const release = (key: string) => key === HELM_RELEASES;
registerDetailTab({ id: "release", title: "Release", icon: "info", shortcut: "d", order: 0, when: release, component: ReleaseTab });
registerDetailTab({ id: "values", title: "Values", icon: "config", shortcut: "v", order: 10, when: release, component: ValuesTab, flush: true });
registerDetailTab({ id: "manifest", title: "Manifest", icon: "code", shortcut: "m", order: 20, when: release, component: ManifestTab, flush: true });
registerDetailTab({ id: "history", title: "History", icon: "clock", shortcut: "h", order: 30, when: release, component: HistoryTab, flush: true });
