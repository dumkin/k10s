//! Pods and workload controllers. Status logic mirrors kubectl's printers so the UI agrees with
//! what people see in their terminals.

use serde_json::Value;

use super::util::{JsonExt, join, join_map, parse_quantity};
use super::{Add, Cell, Column, ColumnKind as K, Tone, col};
use crate::time;

pub fn register(add: &mut Add<'_>) {
    add("", "Pod", pod_columns(), pod);
    add(
        "apps",
        "Deployment",
        with_template(vec![
            col("ready", "Ready", K::Ratio).w(70),
            col("upToDate", "Up-to-date", K::Number).w(90),
            col("available", "Available", K::Number).w(80),
        ]),
        deployment,
    );
    add("apps", "StatefulSet", with_template(vec![col("ready", "Ready", K::Ratio).w(70)]), statefulset);
    add(
        "apps",
        "DaemonSet",
        with_template(vec![
            col("ready", "Ready", K::Ratio).w(70),
            col("current", "Current", K::Number).w(70),
            col("upToDate", "Up-to-date", K::Number).w(90),
            col("available", "Available", K::Number).w(80),
            col("nodeSelector", "Node Selector", K::Text).w(180),
        ]),
        daemonset,
    );
    add("apps", "ReplicaSet", with_template(vec![col("ready", "Ready", K::Ratio).w(70), col("current", "Current", K::Number).w(70)]), replicaset);
    add("", "ReplicationController", with_template(vec![col("ready", "Ready", K::Ratio).w(70), col("current", "Current", K::Number).w(70)]), replicaset);
    add(
        "batch",
        "Job",
        with_template(vec![
            col("status", "Status", K::Status).w(110),
            col("completions", "Completions", K::Ratio).w(100),
            col("duration", "Duration", K::Duration).w(90),
        ]),
        job,
    );
    add(
        "batch",
        "CronJob",
        vec![
            col("schedule", "Schedule", K::Text).w(130),
            col("timezone", "Timezone", K::Text).w(110).hidden(),
            col("suspend", "Suspend", K::Bool).w(80),
            col("active", "Active", K::Number).w(70),
            col("lastSchedule", "Last Schedule", K::Age).w(110),
            col("containers", "Containers", K::Text).w(160).hidden(),
            col("images", "Images", K::Text).w(260).hidden(),
        ],
        cronjob,
    );
    add(
        "autoscaling",
        "HorizontalPodAutoscaler",
        vec![
            col("reference", "Reference", K::Text).w(220),
            col("targets", "Targets", K::Text).w(200),
            col("minPods", "Min Pods", K::Number).w(80),
            col("maxPods", "Max Pods", K::Number).w(80),
            col("replicas", "Replicas", K::Number).w(80),
        ],
        hpa,
    );
    add(
        "policy",
        "PodDisruptionBudget",
        vec![
            col("minAvailable", "Min Available", K::Text).w(110),
            col("maxUnavailable", "Max Unavailable", K::Text).w(120),
            col("allowed", "Allowed Disruptions", K::Status).w(140),
        ],
        pdb,
    );
}

fn pod_columns() -> Vec<Column> {
    vec![
        col("ready", "Ready", K::Ratio).w(64),
        col("status", "Status", K::Status).w(150),
        col("restarts", "Restarts", K::Restarts).w(110),
        col("ip", "IP", K::Text).w(120),
        col("node", "Node", K::Text).w(190),
        col("qos", "QoS", K::Text).w(90).hidden(),
        col("containers", "Containers", K::Text).w(160).hidden(),
        col("images", "Images", K::Text).w(260).hidden(),
        col("cpuRequest", "CPU Req", K::Cpu)
            .w(80)
            .hidden()
            .describe("CPU the pod requests: its containers and sidecars together, or its largest init container"),
        col("cpuLimit", "CPU Lim", K::Cpu).w(80).hidden().describe("CPU the pod is limited to (none unless every container has a limit)"),
        col("memRequest", "MEM Req", K::Bytes)
            .w(90)
            .hidden()
            .describe("Memory the pod requests: its containers and sidecars together, or its largest init container"),
        col("memLimit", "MEM Lim", K::Bytes).w(90).hidden().describe("Memory the pod is limited to (none unless every container has a limit)"),
    ]
}

/// Appends the hidden pod-template columns every workload controller exposes (kubectl `-o wide`).
fn with_template(mut cols: Vec<Column>) -> Vec<Column> {
    cols.push(col("containers", "Containers", K::Text).w(160).hidden());
    cols.push(col("images", "Images", K::Text).w(260).hidden());
    cols.push(col("selector", "Selector", K::Text).w(220).hidden());
    cols
}

fn template_cells(o: &Value, spec_path: &[&str]) -> [Cell; 2] {
    let mut path = spec_path.to_vec();
    path.extend(["template", "spec", "containers"]);
    let containers = o.arr(&path);
    [
        Cell::opt_text(join(containers.iter().filter_map(|c| c.str_at(&["name"]))).as_deref()),
        Cell::opt_text(join(containers.iter().filter_map(|c| c.str_at(&["image"]))).as_deref()),
    ]
}

fn selector_cell(o: &Value) -> Cell {
    Cell::opt_text(join_map(o.at(&["spec", "selector", "matchLabels"])).as_deref())
}

fn has_condition(o: &Value, kind: &str) -> bool {
    o.arr(&["status", "conditions"]).iter().any(|c| c.str_at(&["type"]) == Some(kind) && c.str_at(&["status"]) == Some("True"))
}

fn condition_false(o: &Value, kind: &str) -> bool {
    o.arr(&["status", "conditions"]).iter().any(|c| c.str_at(&["type"]) == Some(kind) && c.str_at(&["status"]) == Some("False"))
}

fn replica_tone(desired: i64, ready: i64) -> Tone {
    if desired == 0 {
        Tone::Muted
    } else if ready >= desired {
        Tone::Ok
    } else {
        Tone::Warn
    }
}

// ---------------------------------------------------------------------------------------------
// Pod
// ---------------------------------------------------------------------------------------------

#[derive(Debug, PartialEq)]
pub(crate) struct PodSummary {
    pub reason: String,
    pub ready: i64,
    pub total: i64,
    pub restarts: i64,
    pub last_restart: Option<i64>,
}

/// Port of kubectl's `printPod` status computation.
pub(crate) fn pod_summary(o: &Value) -> PodSummary {
    let init_specs = o.arr(&["spec", "initContainers"]);
    let is_sidecar = |name: &str| init_specs.iter().any(|c| c.str_at(&["name"]) == Some(name) && c.str_at(&["restartPolicy"]) == Some("Always"));
    let total = o.arr(&["spec", "containers"]).len() as i64 + init_specs.iter().filter(|c| c.str_at(&["restartPolicy"]) == Some("Always")).count() as i64;
    let mut ready = 0;
    let mut restarts = 0;
    let mut last_restart: Option<i64> = None;
    let mut sidecar_restarts = 0;
    let mut sidecar_last: Option<i64> = None;

    let phase = o.str_at(&["status", "phase"]).unwrap_or_default();
    let mut reason = o.str_at(&["status", "reason"]).filter(|r| !r.is_empty()).unwrap_or(phase).to_owned();
    let conditions = o.arr(&["status", "conditions"]);
    if conditions.iter().any(|c| c.str_at(&["type"]) == Some("PodScheduled") && c.str_at(&["reason"]) == Some("SchedulingGated")) {
        reason = "SchedulingGated".into();
    }

    let mut initializing = false;
    for (i, cs) in o.arr(&["status", "initContainerStatuses"]).iter().enumerate() {
        let rc = cs.i64_at(&["restartCount"]).unwrap_or(0);
        let finished = cs.str_at(&["lastState", "terminated", "finishedAt"]).and_then(time::unix_seconds);
        restarts += rc;
        last_restart = last_restart.max(finished);
        let sidecar = is_sidecar(cs.str_at(&["name"]).unwrap_or_default());
        if sidecar {
            sidecar_restarts += rc;
            sidecar_last = sidecar_last.max(finished);
        }
        let terminated = cs.at(&["state", "terminated"]);
        if terminated.is_some_and(|t| t.i64_at(&["exitCode"]) == Some(0)) {
            continue;
        }
        if sidecar && cs.bool_at(&["started"]) == Some(true) {
            if cs.bool_at(&["ready"]) == Some(true) {
                ready += 1;
            }
            continue;
        }
        let waiting = cs.str_at(&["state", "waiting", "reason"]).filter(|r| !r.is_empty());
        reason = if let Some(t) = terminated {
            match t.str_at(&["reason"]).filter(|r| !r.is_empty()) {
                Some(r) => format!("Init:{r}"),
                None => match t.i64_at(&["signal"]).filter(|s| *s != 0) {
                    Some(sig) => format!("Init:Signal:{sig}"),
                    None => format!("Init:ExitCode:{}", t.i64_at(&["exitCode"]).unwrap_or(0)),
                },
            }
        } else if let Some(w) = waiting.filter(|w| *w != "PodInitializing") {
            format!("Init:{w}")
        } else {
            format!("Init:{i}/{}", init_specs.len())
        };
        initializing = true;
        break;
    }

    let initialized = conditions.iter().any(|c| c.str_at(&["type"]) == Some("Initialized") && c.str_at(&["status"]) == Some("True"));
    if !initializing || initialized {
        restarts = sidecar_restarts;
        last_restart = sidecar_last;
        let mut has_running = false;
        for cs in o.arr(&["status", "containerStatuses"]).iter().rev() {
            restarts += cs.i64_at(&["restartCount"]).unwrap_or(0);
            last_restart = last_restart.max(cs.str_at(&["lastState", "terminated", "finishedAt"]).and_then(time::unix_seconds));
            let terminated = cs.at(&["state", "terminated"]);
            if let Some(w) = cs.str_at(&["state", "waiting", "reason"]).filter(|r| !r.is_empty()) {
                reason = w.to_owned();
            } else if let Some(r) = terminated.and_then(|t| t.str_at(&["reason"])).filter(|r| !r.is_empty()) {
                reason = r.to_owned();
            } else if let Some(t) = terminated {
                reason = match t.i64_at(&["signal"]).filter(|s| *s != 0) {
                    Some(sig) => format!("Signal:{sig}"),
                    None => format!("ExitCode:{}", t.i64_at(&["exitCode"]).unwrap_or(0)),
                };
            } else if cs.bool_at(&["ready"]) == Some(true) && cs.at(&["state", "running"]).is_some() {
                has_running = true;
                ready += 1;
            }
        }
        if reason == "Completed" && has_running {
            let pod_ready = conditions.iter().any(|c| c.str_at(&["type"]) == Some("Ready") && c.str_at(&["status"]) == Some("True"));
            reason = if pod_ready { "Running" } else { "NotReady" }.into();
        }
    }

    if o.str_at(&["metadata", "deletionTimestamp"]).is_some() {
        if o.str_at(&["status", "reason"]) == Some("NodeLost") {
            reason = "Unknown".into();
        } else if phase != "Succeeded" && phase != "Failed" {
            reason = "Terminating".into();
        }
    }

    PodSummary { reason, ready, total, restarts, last_restart }
}

pub(crate) fn pod_tone(reason: &str, ready: i64, total: i64) -> Tone {
    match reason {
        "Running" if ready >= total => Tone::Ok,
        "Running" | "NotReady" => Tone::Warn,
        "Completed" | "Succeeded" | "Terminating" => Tone::Muted,
        "Pending" | "ContainerCreating" | "PodInitializing" | "SchedulingGated" => Tone::Info,
        r if r.strip_prefix("Init:").is_some_and(|rest| rest.starts_with(|c: char| c.is_ascii_digit())) => Tone::Info,
        _ => Tone::Error,
    }
}

fn pod(o: &Value) -> (Vec<Cell>, Tone) {
    let s = pod_summary(o);
    let tone = pod_tone(&s.reason, s.ready, s.total);
    let containers = o.arr(&["spec", "containers"]);
    let ip = o.str_at(&["status", "podIP"]).or_else(|| o.arr(&["status", "podIPs"]).first().and_then(|p| p.str_at(&["ip"])));
    let cells = vec![
        Cell::Ratio(s.ready, s.total),
        Cell::status(s.reason, tone),
        Cell::Pair(s.restarts, s.last_restart),
        Cell::opt_text(ip),
        Cell::opt_text(o.str_at(&["spec", "nodeName"])),
        Cell::opt_text(o.str_at(&["status", "qosClass"])),
        Cell::opt_text(join(containers.iter().filter_map(|c| c.str_at(&["name"]))).as_deref()),
        Cell::opt_text(join(containers.iter().filter_map(|c| c.str_at(&["image"]))).as_deref()),
    ];
    let mut cells = cells;
    cells.extend(pod_resources(o));
    (cells, tone)
}

/// What a pod requests and is limited to — CPU in millicores, memory in bytes — as the scheduler counts it: its
/// containers and sidecars (init containers that keep running) together, or its largest other init container when
/// that one asks for more; plus the pod's overhead. A limit only when every container that runs has one: else the
/// pod may use what the node has.
fn pod_resources(o: &Value) -> [Cell; 4] {
    let amount = |c: &Value, kind: &str, res: &str| c.str_at(&["resources", kind, res]).and_then(parse_quantity);
    let init = o.arr(&["spec", "initContainers"]);
    let sidecar = |c: &&Value| c.str_at(&["restartPolicy"]) == Some("Always");
    let running: Vec<&Value> = o.arr(&["spec", "containers"]).iter().chain(init.iter().filter(sidecar)).collect();
    let overhead = |res: &str| o.str_at(&["spec", "overhead", res]).and_then(parse_quantity).unwrap_or(0.0);
    let total = |kind: &str, res: &str| -> Option<f64> {
        let sum: f64 = running.iter().filter_map(|c| amount(c, kind, res)).sum();
        let first_init = init.iter().filter(|c| !sidecar(c)).filter_map(|c| amount(c, kind, res)).fold(0.0, f64::max);
        let all_set = running.iter().all(|c| amount(c, kind, res).is_some());
        if kind == "limits" && (running.is_empty() || !all_set) {
            return None;
        }
        let v = sum.max(first_init) + overhead(res);
        (v > 0.0).then_some(v)
    };
    let cpu = |v: Option<f64>| v.map_or(Cell::Null, |c| Cell::Int((c * 1000.0).round() as i64));
    let mem = |v: Option<f64>| v.map_or(Cell::Null, Cell::Float);
    [cpu(total("requests", "cpu")), cpu(total("limits", "cpu")), mem(total("requests", "memory")), mem(total("limits", "memory"))]
}

// ---------------------------------------------------------------------------------------------
// Controllers
// ---------------------------------------------------------------------------------------------

fn deployment(o: &Value) -> (Vec<Cell>, Tone) {
    let desired = o.i64_at(&["spec", "replicas"]).unwrap_or(1);
    let ready = o.i64_at(&["status", "readyReplicas"]).unwrap_or(0);
    let available = o.i64_at(&["status", "availableReplicas"]).unwrap_or(0);
    let mut tone = replica_tone(desired, ready.min(available));
    if condition_false(o, "Progressing") {
        tone = Tone::Error;
    }
    let [containers, images] = template_cells(o, &["spec"]);
    let cells = vec![
        Cell::Ratio(ready, desired),
        Cell::Int(o.i64_at(&["status", "updatedReplicas"]).unwrap_or(0)),
        Cell::Int(available),
        containers,
        images,
        selector_cell(o),
    ];
    (cells, tone)
}

fn statefulset(o: &Value) -> (Vec<Cell>, Tone) {
    let desired = o.i64_at(&["spec", "replicas"]).unwrap_or(1);
    let ready = o.i64_at(&["status", "readyReplicas"]).unwrap_or(0);
    let [containers, images] = template_cells(o, &["spec"]);
    (vec![Cell::Ratio(ready, desired), containers, images, selector_cell(o)], replica_tone(desired, ready))
}

fn daemonset(o: &Value) -> (Vec<Cell>, Tone) {
    let desired = o.i64_at(&["status", "desiredNumberScheduled"]).unwrap_or(0);
    let ready = o.i64_at(&["status", "numberReady"]).unwrap_or(0);
    let [containers, images] = template_cells(o, &["spec"]);
    let cells = vec![
        Cell::Ratio(ready, desired),
        Cell::Int(o.i64_at(&["status", "currentNumberScheduled"]).unwrap_or(0)),
        Cell::Int(o.i64_at(&["status", "updatedNumberScheduled"]).unwrap_or(0)),
        Cell::Int(o.i64_at(&["status", "numberAvailable"]).unwrap_or(0)),
        Cell::opt_text(join_map(o.at(&["spec", "template", "spec", "nodeSelector"])).as_deref()),
        containers,
        images,
        selector_cell(o),
    ];
    (cells, replica_tone(desired, ready))
}

fn replicaset(o: &Value) -> (Vec<Cell>, Tone) {
    let desired = o.i64_at(&["spec", "replicas"]).unwrap_or(1);
    let ready = o.i64_at(&["status", "readyReplicas"]).unwrap_or(0);
    let [containers, images] = template_cells(o, &["spec"]);
    let cells = vec![Cell::Ratio(ready, desired), Cell::Int(o.i64_at(&["status", "replicas"]).unwrap_or(0)), containers, images, selector_cell(o)];
    (cells, replica_tone(desired, ready))
}

fn job(o: &Value) -> (Vec<Cell>, Tone) {
    let succeeded = o.i64_at(&["status", "succeeded"]).unwrap_or(0);
    let completions = o.i64_at(&["spec", "completions"]).unwrap_or(1);
    let (status, tone) = if has_condition(o, "Complete") {
        ("Complete", Tone::Ok)
    } else if has_condition(o, "Failed") {
        ("Failed", Tone::Error)
    } else if o.str_at(&["metadata", "deletionTimestamp"]).is_some() {
        ("Terminating", Tone::Muted)
    } else if has_condition(o, "Suspended") {
        ("Suspended", Tone::Muted)
    } else if has_condition(o, "FailureTarget") {
        ("FailureTarget", Tone::Error)
    } else if has_condition(o, "SuccessCriteriaMet") {
        ("SuccessCriteriaMet", Tone::Ok)
    } else {
        ("Running", Tone::Info)
    };
    let duration = match o.str_at(&["status", "startTime"]).and_then(time::unix_seconds) {
        Some(start) => Cell::Pair(start, o.str_at(&["status", "completionTime"]).and_then(time::unix_seconds)),
        None => Cell::Null,
    };
    let [containers, images] = template_cells(o, &["spec"]);
    let cells = vec![Cell::status(status, tone), Cell::Ratio(succeeded, completions), duration, containers, images, selector_cell(o)];
    (cells, tone)
}

fn cronjob(o: &Value) -> (Vec<Cell>, Tone) {
    let suspended = o.bool_at(&["spec", "suspend"]).unwrap_or(false);
    let [containers, images] = template_cells(o, &["spec", "jobTemplate", "spec"]);
    let cells = vec![
        Cell::opt_text(o.str_at(&["spec", "schedule"])),
        Cell::opt_text(o.str_at(&["spec", "timeZone"])),
        Cell::Bool(suspended),
        Cell::Int(o.arr(&["status", "active"]).len() as i64),
        Cell::time(o.str_at(&["status", "lastScheduleTime"])),
        containers,
        images,
    ];
    (cells, if suspended { Tone::Muted } else { Tone::Neutral })
}

fn hpa(o: &Value) -> (Vec<Cell>, Tone) {
    let reference = match (o.str_at(&["spec", "scaleTargetRef", "kind"]), o.str_at(&["spec", "scaleTargetRef", "name"])) {
        (Some(k), Some(n)) => Some(format!("{k}/{n}")),
        _ => None,
    };
    let max = o.i64_at(&["spec", "maxReplicas"]).unwrap_or(0);
    let current = o.i64_at(&["status", "currentReplicas"]).unwrap_or(0);
    let mut tone = if max > 0 && current >= max { Tone::Warn } else { Tone::Neutral };
    if condition_false(o, "ScalingActive") {
        tone = Tone::Warn;
    }
    let cells = vec![
        Cell::opt_text(reference.as_deref()),
        Cell::opt_text(hpa_targets(o).as_deref()),
        Cell::Int(o.i64_at(&["spec", "minReplicas"]).unwrap_or(1)),
        Cell::Int(max),
        Cell::Int(current),
    ];
    (cells, tone)
}

/// Simplified kubectl `formatHPAMetrics`: `cpu: 45%/80%, memory: 300Mi/1Gi`.
fn hpa_targets(o: &Value) -> Option<String> {
    let current = o.arr(&["status", "currentMetrics"]);
    let parts: Vec<String> = o
        .arr(&["spec", "metrics"])
        .iter()
        .map(|m| {
            let kind = m.str_at(&["type"]).unwrap_or_default();
            let key = match kind {
                "Resource" => "resource",
                "ContainerResource" => "containerResource",
                "Pods" => "pods",
                "Object" => "object",
                "External" => "external",
                _ => return "<unknown>".to_string(),
            };
            let spec = m.at(&[key]).cloned().unwrap_or(Value::Null);
            let name = spec.str_at(&["name"]).or_else(|| spec.str_at(&["metric", "name"])).unwrap_or(kind);
            let cur = current.iter().find(|c| {
                c.str_at(&["type"]) == Some(kind) && {
                    let cs = c.at(&[key]);
                    cs.and_then(|x| x.str_at(&["name"]).or_else(|| x.str_at(&["metric", "name"]))) == Some(name)
                }
            });
            let cur = cur.and_then(|c| c.at(&[key, "current"]));
            let (target, actual) = if let Some(u) = spec.i64_at(&["target", "averageUtilization"]) {
                (format!("{u}%"), cur.and_then(|c| c.i64_at(&["averageUtilization"])).map(|v| format!("{v}%")))
            } else if let Some(v) = spec.str_at(&["target", "averageValue"]) {
                (v.to_string(), cur.and_then(|c| c.str_at(&["averageValue"])).map(str::to_string))
            } else {
                (
                    spec.str_at(&["target", "value"]).unwrap_or("?").to_string(),
                    cur.and_then(|c| c.str_at(&["value"]).or_else(|| c.str_at(&["averageValue"]))).map(str::to_string),
                )
            };
            format!("{name}: {}/{target}", actual.as_deref().unwrap_or("<unknown>"))
        })
        .collect();
    (!parts.is_empty()).then(|| parts.join(", "))
}

fn int_or_string(v: Option<&Value>) -> Cell {
    match v {
        Some(Value::Number(n)) => Cell::Text(n.to_string()),
        Some(Value::String(s)) => Cell::Text(s.clone()),
        _ => Cell::text("N/A"),
    }
}

fn pdb(o: &Value) -> (Vec<Cell>, Tone) {
    let allowed = o.i64_at(&["status", "disruptionsAllowed"]).unwrap_or(0);
    let tone = if allowed == 0 { Tone::Warn } else { Tone::Ok };
    (vec![int_or_string(o.at(&["spec", "minAvailable"])), int_or_string(o.at(&["spec", "maxUnavailable"])), Cell::status(allowed.to_string(), tone)], tone)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn pod_requests_and_limits_add_up_like_the_scheduler_counts_them() {
        let res = |cpu: &str, mem: &str| json!({ "requests": { "cpu": cpu, "memory": mem }, "limits": { "cpu": cpu, "memory": mem } });
        let pod = json!({ "spec": {
            "containers": [{ "name": "app", "resources": res("250m", "256Mi") }, { "name": "envoy", "resources": res("100m", "64Mi") }],
            // A sidecar adds up with the containers; the other init container only counts if it asks for more.
            "initContainers": [{ "name": "proxy", "restartPolicy": "Always", "resources": res("50m", "32Mi") }, { "name": "migrate", "resources": res("1", "128Mi") }],
            "overhead": { "cpu": "10m" },
        } });
        let mib = 1024.0 * 1024.0;
        assert_eq!(pod_resources(&pod), [Cell::Int(1010), Cell::Int(1010), Cell::Float(352.0 * mib), Cell::Float(352.0 * mib)]);
        // A container without a limit: the pod has none (it may use what the node has); requests still add up.
        let open = json!({ "spec": { "containers": [{ "name": "app", "resources": { "requests": { "cpu": "100m" } } }, { "name": "b", "resources": { "requests": { "cpu": "100m" }, "limits": { "cpu": "1" } } }] } });
        assert_eq!(pod_resources(&open), [Cell::Int(200), Cell::Null, Cell::Null, Cell::Null]);
    }

    #[test]
    fn running_pod() {
        let o = json!({
            "metadata": {"name": "p"},
            "spec": {"containers": [{"name": "a"}, {"name": "b"}]},
            "status": {"phase": "Running", "conditions": [{"type": "Ready", "status": "True"}],
                "containerStatuses": [
                    {"name": "a", "ready": true, "restartCount": 2, "state": {"running": {}},
                     "lastState": {"terminated": {"finishedAt": "2024-01-01T00:00:00Z"}}},
                    {"name": "b", "ready": true, "restartCount": 1, "state": {"running": {}}}
                ]}
        });
        let s = pod_summary(&o);
        assert_eq!(s, PodSummary { reason: "Running".into(), ready: 2, total: 2, restarts: 3, last_restart: Some(1704067200) });
        assert_eq!(pod_tone(&s.reason, s.ready, s.total), Tone::Ok);
    }

    #[test]
    fn crashloop_and_init_states() {
        let crash = json!({
            "spec": {"containers": [{"name": "a"}]},
            "status": {"phase": "Running", "containerStatuses": [
                {"name": "a", "ready": false, "restartCount": 7, "state": {"waiting": {"reason": "CrashLoopBackOff"}}}]}
        });
        assert_eq!(pod_summary(&crash).reason, "CrashLoopBackOff");
        assert_eq!(pod_tone("CrashLoopBackOff", 0, 1), Tone::Error);

        let init = json!({
            "spec": {"initContainers": [{"name": "i1"}, {"name": "i2"}], "containers": [{"name": "a"}]},
            "status": {"phase": "Pending", "initContainerStatuses": [
                {"name": "i1", "state": {"terminated": {"exitCode": 0}}},
                {"name": "i2", "state": {"running": {}}}]}
        });
        assert_eq!(pod_summary(&init).reason, "Init:1/2");
        assert_eq!(pod_tone("Init:1/2", 0, 1), Tone::Info);

        let init_err = json!({
            "spec": {"initContainers": [{"name": "i1"}], "containers": [{"name": "a"}]},
            "status": {"phase": "Pending", "initContainerStatuses": [
                {"name": "i1", "state": {"terminated": {"exitCode": 1, "reason": "Error"}}}]}
        });
        assert_eq!(pod_summary(&init_err).reason, "Init:Error");
    }

    #[test]
    fn terminating_and_sidecars() {
        let o = json!({
            "metadata": {"deletionTimestamp": "2024-01-01T00:00:00Z"},
            "spec": {"initContainers": [{"name": "proxy", "restartPolicy": "Always"}], "containers": [{"name": "a"}]},
            "status": {"phase": "Running",
                "conditions": [{"type": "Initialized", "status": "True"}],
                "initContainerStatuses": [{"name": "proxy", "started": true, "ready": true, "restartCount": 1, "state": {"running": {}}}],
                "containerStatuses": [{"name": "a", "ready": true, "restartCount": 0, "state": {"running": {}}}]}
        });
        let s = pod_summary(&o);
        assert_eq!((s.reason.as_str(), s.ready, s.total, s.restarts), ("Terminating", 2, 2, 1));
    }

    #[test]
    fn job_status() {
        let o = json!({"spec": {"completions": 3}, "status": {"succeeded": 3, "startTime": "2024-01-01T00:00:00Z",
            "completionTime": "2024-01-01T00:01:00Z", "conditions": [{"type": "Complete", "status": "True"}]}});
        let (cells, tone) = job(&o);
        assert_eq!(tone, Tone::Ok);
        assert_eq!(cells[1], Cell::Ratio(3, 3));
        assert_eq!(cells[2], Cell::Pair(1704067200, Some(1704067260)));
    }
}
