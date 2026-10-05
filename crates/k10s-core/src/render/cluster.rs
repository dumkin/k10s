use serde_json::Value;

use super::util::{JsonExt, join, parse_quantity};
use super::{Add, Cell, ColumnKind as K, Tone, col, condition_tone};
use crate::time;

pub fn register(add: &mut Add<'_>) {
    add(
        "",
        "Node",
        vec![
            col("status", "Status", K::Status).w(170),
            col("roles", "Roles", K::Text).w(130),
            col("version", "Version", K::Text).w(110),
            col("internalIP", "Internal IP", K::Text).w(120),
            col("cpu", "CPU", K::Cpu).w(70),
            col("memory", "Memory", K::Bytes).w(90),
            col("pods", "Pods", K::Number).w(60).hidden(),
            col("taints", "Taints", K::Number).w(70),
            col("externalIP", "External IP", K::Text).w(120).hidden(),
            col("osImage", "OS Image", K::Text).w(200).hidden(),
            col("kernel", "Kernel", K::Text).w(160).hidden(),
            col("runtime", "Runtime", K::Text).w(160).hidden(),
        ],
        node,
    );
    add("", "Namespace", vec![col("status", "Status", K::Status).w(110)], namespace);
    let event_columns = || {
        vec![
            col("lastSeen", "Last Seen", K::Age).w(90),
            col("type", "Type", K::Status).w(80),
            col("reason", "Reason", K::Text).w(150),
            col("object", "Object", K::Text).w(240),
            col("message", "Message", K::Text).w(480),
            col("count", "Count", K::Number).w(60),
            col("source", "Source", K::Text).w(160).hidden(),
            col("firstSeen", "First Seen", K::Age).w(90).hidden(),
        ]
    };
    add("", "Event", event_columns(), event);
    add("events.k8s.io", "Event", event_columns(), event_v1);
    add(
        "apiextensions.k8s.io",
        "CustomResourceDefinition",
        vec![
            col("group", "Group", K::Text).w(200),
            col("kind", "Kind", K::Text).w(170),
            col("versions", "Versions", K::Text).w(120),
            col("scope", "Scope", K::Text).w(100),
        ],
        crd,
    );
    add("apiregistration.k8s.io", "APIService", vec![col("service", "Service", K::Text).w(240), col("available", "Available", K::Status).w(140)], api_service);
    add("admissionregistration.k8s.io", "MutatingWebhookConfiguration", vec![col("webhooks", "Webhooks", K::Number).w(90)], webhooks);
    add("admissionregistration.k8s.io", "ValidatingWebhookConfiguration", vec![col("webhooks", "Webhooks", K::Number).w(90)], webhooks);
}

fn node(o: &Value) -> (Vec<Cell>, Tone) {
    let ready = o.arr(&["status", "conditions"]).iter().find(|c| c.str_at(&["type"]) == Some("Ready"));
    // As kubectl: any Ready status but True is "NotReady" — including Unknown, which is what a node whose
    // kubelet stopped posting status has; "Unknown" only when there is no Ready condition at all.
    let mut status = match ready.map(|c| c.str_at(&["status"])) {
        Some(Some("True")) => "Ready".to_string(),
        Some(_) => "NotReady".to_string(),
        None => "Unknown".to_string(),
    };
    let unschedulable = o.bool_at(&["spec", "unschedulable"]).unwrap_or(false);
    let tone = match (status.as_str(), unschedulable) {
        ("Ready", false) => Tone::Ok,
        ("Ready", true) => Tone::Warn,
        _ => Tone::Error,
    };
    if unschedulable {
        status.push_str(",SchedulingDisabled");
    }

    let mut roles: Vec<&str> = o
        .entries(&["metadata", "labels"])
        .filter_map(|(k, v)| match k.strip_prefix("node-role.kubernetes.io/") {
            Some(role) if !role.is_empty() => Some(role),
            _ if k == "kubernetes.io/role" => v.as_str(),
            _ => None,
        })
        .collect();
    roles.sort_unstable();
    roles.dedup();

    let address = |kind: &str| o.arr(&["status", "addresses"]).iter().find(|a| a.str_at(&["type"]) == Some(kind)).and_then(|a| a.str_at(&["address"]));
    let alloc = |res: &str| o.str_at(&["status", "allocatable", res]).and_then(parse_quantity);
    let cells = vec![
        Cell::status(status, tone),
        Cell::text(if roles.is_empty() { "<none>".to_string() } else { roles.join(",") }),
        Cell::opt_text(o.str_at(&["status", "nodeInfo", "kubeletVersion"])),
        Cell::opt_text(address("InternalIP")),
        alloc("cpu").map_or(Cell::Null, |c| Cell::Int((c * 1000.0).round() as i64)),
        alloc("memory").map_or(Cell::Null, Cell::Float),
        alloc("pods").map_or(Cell::Null, |p| Cell::Int(p as i64)),
        Cell::Int(o.arr(&["spec", "taints"]).len() as i64),
        Cell::opt_text(address("ExternalIP")),
        Cell::opt_text(o.str_at(&["status", "nodeInfo", "osImage"])),
        Cell::opt_text(o.str_at(&["status", "nodeInfo", "kernelVersion"])),
        Cell::opt_text(o.str_at(&["status", "nodeInfo", "containerRuntimeVersion"])),
    ];
    (cells, tone)
}

fn namespace(o: &Value) -> (Vec<Cell>, Tone) {
    let phase = o.str_at(&["status", "phase"]).unwrap_or("Active");
    let tone = if phase == "Active" { Tone::Neutral } else { Tone::Muted };
    (vec![Cell::status(phase, tone)], tone)
}

fn event_tone(typ: &str) -> Tone {
    if typ == "Normal" { Tone::Neutral } else { Tone::Warn }
}

fn first_time(o: &Value, paths: &[&[&str]]) -> Option<i64> {
    paths.iter().find_map(|p| o.str_at(p).and_then(time::unix_seconds))
}

fn event(o: &Value) -> (Vec<Cell>, Tone) {
    let typ = o.str_at(&["type"]).unwrap_or("Normal");
    let tone = event_tone(typ);
    let object = match (o.str_at(&["involvedObject", "kind"]), o.str_at(&["involvedObject", "name"])) {
        (Some(k), Some(n)) => Some(format!("{}/{n}", k.to_ascii_lowercase())),
        (None, Some(n)) => Some(n.to_string()),
        _ => None,
    };
    let last = first_time(o, &[&["series", "lastObservedTime"], &["lastTimestamp"], &["eventTime"], &["firstTimestamp"], &["metadata", "creationTimestamp"]]);
    let first = first_time(o, &[&["firstTimestamp"], &["eventTime"], &["metadata", "creationTimestamp"]]);
    let count = o.i64_at(&["series", "count"]).or_else(|| o.i64_at(&["count"])).unwrap_or(1);
    let source = join([
        o.str_at(&["source", "component"]).or_else(|| o.str_at(&["reportingComponent"])).unwrap_or_default(),
        o.str_at(&["source", "host"]).unwrap_or_default(),
    ]);
    let cells = vec![
        Cell::opt_int(last),
        Cell::status(typ, tone),
        Cell::opt_text(o.str_at(&["reason"])),
        Cell::opt_text(object.as_deref()),
        Cell::opt_text(o.str_at(&["message"]).map(str::trim)),
        Cell::Int(count),
        Cell::opt_text(source.as_deref()),
        Cell::opt_int(first),
    ];
    (cells, tone)
}

fn event_v1(o: &Value) -> (Vec<Cell>, Tone) {
    let typ = o.str_at(&["type"]).unwrap_or("Normal");
    let tone = event_tone(typ);
    let object = match (o.str_at(&["regarding", "kind"]), o.str_at(&["regarding", "name"])) {
        (Some(k), Some(n)) => Some(format!("{}/{n}", k.to_ascii_lowercase())),
        (None, Some(n)) => Some(n.to_string()),
        _ => None,
    };
    let last = first_time(o, &[&["series", "lastObservedTime"], &["deprecatedLastTimestamp"], &["eventTime"], &["metadata", "creationTimestamp"]]);
    let first = first_time(o, &[&["deprecatedFirstTimestamp"], &["eventTime"], &["metadata", "creationTimestamp"]]);
    let count = o.i64_at(&["series", "count"]).or_else(|| o.i64_at(&["deprecatedCount"])).unwrap_or(1);
    let cells = vec![
        Cell::opt_int(last),
        Cell::status(typ, tone),
        Cell::opt_text(o.str_at(&["reason"])),
        Cell::opt_text(object.as_deref()),
        Cell::opt_text(o.str_at(&["note"]).map(str::trim)),
        Cell::Int(count),
        Cell::opt_text(o.str_at(&["reportingController"])),
        Cell::opt_int(first),
    ];
    (cells, tone)
}

fn crd(o: &Value) -> (Vec<Cell>, Tone) {
    let versions = join(o.arr(&["spec", "versions"]).iter().filter(|v| v.bool_at(&["served"]) != Some(false)).filter_map(|v| v.str_at(&["name"])));
    let tone = match condition_tone(o, "Established") {
        Some(Tone::Ok) | None => Tone::Neutral,
        Some(t) => t,
    };
    let cells = vec![
        Cell::opt_text(o.str_at(&["spec", "group"])),
        Cell::opt_text(o.str_at(&["spec", "names", "kind"])),
        Cell::opt_text(versions.as_deref()),
        Cell::opt_text(o.str_at(&["spec", "scope"])),
    ];
    (cells, tone)
}

fn api_service(o: &Value) -> (Vec<Cell>, Tone) {
    let service = match (o.str_at(&["spec", "service", "namespace"]), o.str_at(&["spec", "service", "name"])) {
        (Some(ns), Some(n)) => format!("{ns}/{n}"),
        _ => "Local".to_string(),
    };
    let cond = o.arr(&["status", "conditions"]).iter().find(|c| c.str_at(&["type"]) == Some("Available"));
    let (text, tone) = match cond.and_then(|c| c.str_at(&["status"])) {
        Some("True") => ("True".to_string(), Tone::Ok),
        Some(s) => (format!("{s} ({})", cond.and_then(|c| c.str_at(&["reason"])).unwrap_or("?")), Tone::Error),
        None => ("Unknown".to_string(), Tone::Warn),
    };
    (vec![Cell::text(service), Cell::status(text, tone)], if tone == Tone::Ok { Tone::Neutral } else { tone })
}

fn webhooks(o: &Value) -> (Vec<Cell>, Tone) {
    (vec![Cell::Int(o.arr(&["webhooks"]).len() as i64)], Tone::Neutral)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn node_status(ready: Option<&str>, unschedulable: bool) -> Cell {
        let conditions: Vec<Value> = ready.map(|s| json!({"type": "Ready", "status": s})).into_iter().collect();
        let o = json!({"spec": {"unschedulable": unschedulable}, "status": {"conditions": conditions}});
        let (cells, tone) = node(&o);
        let Cell::Status(_, cell_tone) = &cells[0] else { panic!("status cell") };
        assert_eq!(*cell_tone, tone);
        cells[0].clone()
    }

    #[test]
    fn node_status_like_kubectl() {
        assert_eq!(node_status(Some("True"), false), Cell::status("Ready", Tone::Ok));
        assert_eq!(node_status(Some("True"), true), Cell::status("Ready,SchedulingDisabled", Tone::Warn));
        assert_eq!(node_status(Some("False"), false), Cell::status("NotReady", Tone::Error));
        // "Kubelet stopped posting node status": kubectl prints NotReady, and so must the table (and its filter).
        assert_eq!(node_status(Some("Unknown"), false), Cell::status("NotReady", Tone::Error));
        assert_eq!(node_status(Some("Unknown"), true), Cell::status("NotReady,SchedulingDisabled", Tone::Error));
        assert_eq!(node_status(None, false), Cell::status("Unknown", Tone::Error));
    }
}
