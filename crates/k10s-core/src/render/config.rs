use serde_json::Value;

use super::util::JsonExt;
use super::{Add, Cell, ColumnKind as K, Tone, col};

pub fn register(add: &mut Add<'_>) {
    add("", "ConfigMap", vec![col("data", "Data", K::Number).w(70)], configmap);
    add("", "Secret", vec![col("type", "Type", K::Text).w(260), col("data", "Data", K::Number).w(70)], secret);
    add("", "ResourceQuota", vec![col("request", "Request", K::Text).w(320), col("limit", "Limit", K::Text).w(240)], resource_quota);
    add("", "LimitRange", vec![col("types", "Types", K::Text).w(200)], limit_range);
    add(
        "scheduling.k8s.io",
        "PriorityClass",
        vec![col("value", "Value", K::Number).w(110), col("globalDefault", "Global Default", K::Bool).w(110), col("preemption", "Preemption", K::Text).w(160)],
        priority_class,
    );
    add("coordination.k8s.io", "Lease", vec![col("holder", "Holder", K::Text).w(280), col("renewed", "Renewed", K::Age).w(90)], lease);
}

fn configmap(o: &Value) -> (Vec<Cell>, Tone) {
    (vec![Cell::Int((o.len_at(&["data"]) + o.len_at(&["binaryData"])) as i64)], Tone::Neutral)
}

fn secret(o: &Value) -> (Vec<Cell>, Tone) {
    (vec![Cell::opt_text(o.str_at(&["type"])), Cell::Int(o.len_at(&["data"]) as i64)], Tone::Neutral)
}

fn resource_quota(o: &Value) -> (Vec<Cell>, Tone) {
    let mut request = Vec::new();
    let mut limit = Vec::new();
    let mut tone = Tone::Neutral;
    for (name, hard) in o.entries(&["status", "hard"]) {
        let used = o.str_at(&["status", "used", name.as_str()]).unwrap_or("0");
        let hard = hard.as_str().unwrap_or_default();
        if used == hard && hard != "0" {
            tone = Tone::Warn;
        }
        let entry = format!("{name}: {used}/{hard}");
        if name.starts_with("limits.") { limit.push(entry) } else { request.push(entry) }
    }
    (vec![Cell::opt_text(Some(&request.join(", "))), Cell::opt_text(Some(&limit.join(", ")))], tone)
}

fn limit_range(o: &Value) -> (Vec<Cell>, Tone) {
    let types: Vec<&str> = o.arr(&["spec", "limits"]).iter().filter_map(|l| l.str_at(&["type"])).collect();
    (vec![Cell::opt_text(Some(&types.join(",")))], Tone::Neutral)
}

fn priority_class(o: &Value) -> (Vec<Cell>, Tone) {
    (
        vec![Cell::opt_int(o.i64_at(&["value"])), Cell::Bool(o.bool_at(&["globalDefault"]).unwrap_or(false)), Cell::opt_text(o.str_at(&["preemptionPolicy"]))],
        Tone::Neutral,
    )
}

fn lease(o: &Value) -> (Vec<Cell>, Tone) {
    (vec![Cell::opt_text(o.str_at(&["spec", "holderIdentity"])), Cell::time(o.str_at(&["spec", "renewTime"]))], Tone::Neutral)
}
