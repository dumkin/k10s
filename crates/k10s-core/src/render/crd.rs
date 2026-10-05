//! Renderer built from a CRD's `additionalPrinterColumns`, so custom resources show the same
//! columns as `kubectl get` — with status-looking values colored.
//!
//! Also how printer columns and their cells are typed, shared with server-side printing
//! ([`super::table`]): a column gets the same id, kind and cells whichever way a cluster serves it, so the
//! columns of several clusters line up in one table (ids come from the column's name, not its position).

use std::borrow::Cow;
use std::collections::HashSet;

use serde_json::Value;

use super::jsonpath::JsonPath;
use super::util::JsonExt;
use super::{Cell, Column, ColumnKind, Renderer, Tone};
use crate::time;

/// How the API server describes a CRD's printer column that has no description of its own, followed by its
/// JSONPath (which is how [`super::table`] learns it).
pub(crate) const DESCRIBED_BY_PATH: &str = "Custom resource definition column (in JSONPath format): ";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Ty {
    Int,
    Number,
    Bool,
    Date,
    Text,
    Status,
}

/// What a CRD's printer columns come to.
pub enum FromCrd {
    /// Every declared column can be evaluated here.
    Complete(PrinterColumns),
    /// Some columns use JSONPath this evaluator does not support: the others, if any.
    Partial(Option<PrinterColumns>),
    /// The CRD declares no columns besides Age (kubectl then shows only Name and Age too).
    Empty,
}

pub struct PrinterColumns {
    columns: Vec<Column>,
    paths: Vec<(JsonPath, Ty)>,
    identity: String,
}

impl PrinterColumns {
    /// The printer columns of `version` of a CRD object.
    pub fn from_crd(crd: &Value, version: &str) -> FromCrd {
        let versions = crd.arr(&["spec", "versions"]);
        let defs = versions
            .iter()
            .find(|v| v.str_at(&["name"]) == Some(version))
            .map(|v| v.arr(&["additionalPrinterColumns"]))
            .filter(|d| !d.is_empty())
            .unwrap_or_else(|| crd.arr(&["spec", "additionalPrinterColumns"]));

        let mut columns = Vec::new();
        let mut paths = Vec::new();
        let mut ids = HashSet::new();
        let mut unsupported = false;
        for def in defs {
            let (Some(name), Some(path)) = (def.str_at(&["name"]), def.str_at(&["jsonPath"]).or_else(|| def.str_at(&["JSONPath"]))) else { continue };
            // The UI always shows Age from creationTimestamp.
            if is_creation_timestamp(path) {
                continue;
            }
            let Ok(jp) = JsonPath::parse(path) else {
                tracing::debug!(%path, "unsupported printer column path");
                unsupported = true;
                continue;
            };
            // Described as the API server describes it, so a column reads the same whichever way it is served.
            let description =
                def.str_at(&["description"]).filter(|d| !d.is_empty()).map_or_else(|| Cow::Owned(format!("{DESCRIBED_BY_PATH}{path}")), Cow::Borrowed);
            let (column, ty) = column(&mut ids, name, def.str_at(&["type"]).unwrap_or("string"), def.i64_at(&["priority"]).unwrap_or(0), Some(&description));
            columns.push(column);
            paths.push((jp, ty));
        }
        let built = (!columns.is_empty()).then(|| Self { columns, paths, identity: format!("crd:{}", Value::Array(defs.to_vec())) });
        match built {
            _ if unsupported => FromCrd::Partial(built),
            Some(p) => FromCrd::Complete(p),
            None => FromCrd::Empty,
        }
    }
}

impl Renderer for PrinterColumns {
    fn columns(&self) -> &[Column] {
        &self.columns
    }

    fn render(&self, obj: &Value) -> (Vec<Cell>, Tone) {
        let mut row_tone = Tone::Neutral;
        let cells = self.paths.iter().map(|(path, ty)| cell(path.first(obj), *ty, &mut row_tone)).collect();
        (cells, row_tone)
    }

    fn identity(&self) -> Option<&str> {
        Some(&self.identity)
    }
}

/// Whether a printer column's JSONPath is the objects' creation time (the UI's own Age column).
pub(crate) fn is_creation_timestamp(path: &str) -> bool {
    path.trim_matches(['{', '}', '$', ' ']) == ".metadata.creationTimestamp"
}

/// A printer column as the UI shows it, and how its cells are typed. `ty` is the declared type
/// (`integer`, `number`, `boolean`, `date`, `string`); `priority > 0` columns are hidden by default (kubectl's
/// `-o wide`). `ids` keeps ids unique within one table.
pub(crate) fn column(ids: &mut HashSet<String>, name: &str, ty: &str, priority: i64, description: Option<&str>) -> (Column, Ty) {
    let ty = match ty {
        "integer" => Ty::Int,
        "number" => Ty::Number,
        "boolean" => Ty::Bool,
        "date" => Ty::Date,
        _ if looks_like_status(name) => Ty::Status,
        _ => Ty::Text,
    };
    let kind = match ty {
        Ty::Int | Ty::Number => ColumnKind::Number,
        Ty::Bool => ColumnKind::Bool,
        Ty::Date => ColumnKind::Age,
        Ty::Status => ColumnKind::Status,
        Ty::Text => ColumnKind::Text,
    };
    let base = column_id(name, kind);
    let mut id = base.clone();
    let mut n = 1;
    while !ids.insert(id.clone()) {
        n += 1;
        id = format!("{base}_{n}");
    }
    let column = Column {
        id: Cow::Owned(id),
        title: Cow::Owned(name.to_string()),
        kind,
        width: 0,
        hidden: priority > 0,
        description: description.filter(|d| !d.is_empty()).map(|d| Cow::Owned(d.to_string())),
    };
    (column, ty)
}

/// `pc_<name>_<kind>`: the same for a column whichever cluster serves it, and whatever its position (case and
/// punctuation aside). Names with other characters get a hash of the name, so they cannot collide.
fn column_id(name: &str, kind: ColumnKind) -> String {
    let slug: String = name.trim().chars().map(|c| if c.is_ascii_alphanumeric() { c.to_ascii_lowercase() } else { '_' }).collect();
    let mut id = format!("pc_{slug}_{}", kind.name());
    if !name.chars().all(|c| c.is_ascii_alphanumeric() || " _-./".contains(c)) {
        // FNV-1a: stable across runs and platforms (the UI keeps widths and visibility by id).
        let hash = name.to_lowercase().bytes().fold(0x811c_9dc5_u32, |h, b| (h ^ u32::from(b)).wrapping_mul(0x0100_0193));
        id.push_str(&format!("_{hash:08x}"));
    }
    id
}

/// The cell for a printer column value (a CRD JSONPath result, or a cell of a server-side table); status
/// cells make `row_tone` worse.
pub(crate) fn cell(v: Option<&Value>, ty: Ty, row_tone: &mut Tone) -> Cell {
    let Some(v) = v.filter(|v| !v.is_null()) else { return Cell::Null };
    match ty {
        Ty::Int => v.as_i64().or_else(|| v.as_f64().map(|f| f as i64)).or_else(|| v.as_str().and_then(|s| s.parse().ok())).map_or(Cell::Null, Cell::Int),
        Ty::Number => v.as_f64().or_else(|| v.as_str().and_then(|s| s.parse().ok())).map_or(Cell::Null, Cell::Float),
        Ty::Bool => v.as_bool().or_else(|| v.as_str().map(|s| s.eq_ignore_ascii_case("true"))).map_or(Cell::Null, Cell::Bool),
        Ty::Date => v.as_str().and_then(time::unix_seconds).map_or(Cell::Null, Cell::Int),
        Ty::Text => Cell::Text(display(v)),
        Ty::Status => {
            let text = display(v);
            let tone = word_tone(&text);
            *row_tone = worse(*row_tone, tone);
            Cell::Status(text, tone)
        }
    }
}

fn display(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

fn looks_like_status(name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    ["ready", "status", "state", "phase", "health", "sync", "available", "condition", "succeeded"].iter().any(|w| n.contains(w))
}

pub(crate) fn word_tone(value: &str) -> Tone {
    match value.to_ascii_lowercase().replace([' ', '_', '-'], "").as_str() {
        "true" | "ready" | "running" | "succeeded" | "success" | "healthy" | "synced" | "bound" | "available" | "active" | "established" | "complete"
        | "completed" | "issued" | "valid" | "up" | "ok" | "deployed" | "provisioned" | "reconciled" => Tone::Ok,
        "false" | "failed" | "failure" | "error" | "degraded" | "missing" | "invalid" | "crashloopbackoff" | "unhealthy" | "down" | "notready" | "rejected"
        | "errored" => Tone::Error,
        "unknown" | "outofsync" | "pending" | "suspended" | "warning" | "notsynced" | "stalled" => Tone::Warn,
        "progressing" | "creating" | "updating" | "deleting" | "provisioning" | "reconciling" | "inprogress" | "initializing" | "terminating" => Tone::Info,
        _ => Tone::Neutral,
    }
}

fn worse(a: Tone, b: Tone) -> Tone {
    let rank = |t: Tone| match t {
        Tone::Neutral | Tone::Muted => 0,
        Tone::Ok => 1,
        Tone::Info => 2,
        Tone::Warn => 3,
        Tone::Error => 4,
    };
    if rank(b) > rank(a) { b } else { a }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn complete(f: FromCrd) -> PrinterColumns {
        match f {
            FromCrd::Complete(p) => p,
            _ => panic!("not complete"),
        }
    }

    #[test]
    fn builds_from_crd() {
        let crd = json!({"spec": {"versions": [{"name": "v1", "additionalPrinterColumns": [
            {"name": "Ready", "type": "string", "jsonPath": ".status.conditions[?(@.type==\"Ready\")].status"},
            {"name": "Secret", "type": "string", "jsonPath": ".spec.secretName"},
            {"name": "Replicas", "type": "integer", "jsonPath": ".spec.replicas", "priority": 1},
            {"name": "Age", "type": "date", "jsonPath": ".metadata.creationTimestamp"}
        ]}]}});
        let pc = complete(PrinterColumns::from_crd(&crd, "v1"));
        let ids: Vec<&str> = pc.columns().iter().map(|c| c.id.as_ref()).collect();
        assert_eq!(ids, ["pc_ready_status", "pc_secret_text", "pc_replicas_number"]);
        assert!(pc.columns()[2].hidden);
        let obj = json!({"spec": {"secretName": "tls", "replicas": 2}, "status": {"conditions": [{"type": "Ready", "status": "False"}]}});
        let (cells, tone) = pc.render(&obj);
        assert_eq!(cells, vec![Cell::Status("False".into(), Tone::Error), Cell::Text("tls".into()), Cell::Int(2)]);
        assert_eq!(tone, Tone::Error);
    }

    #[test]
    fn says_when_columns_are_missing_or_cannot_be_evaluated() {
        let only_age = json!({"spec": {"versions": [{"name": "v1", "additionalPrinterColumns": [
            {"name": "Age", "type": "date", "jsonPath": ".metadata.creationTimestamp"}
        ]}]}});
        assert!(matches!(PrinterColumns::from_crd(&only_age, "v1"), FromCrd::Empty));
        assert!(matches!(PrinterColumns::from_crd(&json!({"spec": {}}), "v1"), FromCrd::Empty));
        let recursive = json!({"spec": {"versions": [{"name": "v1", "additionalPrinterColumns": [
            {"name": "Owner", "type": "string", "jsonPath": "..owner"},
            {"name": "Phase", "type": "string", "jsonPath": ".status.phase"}
        ]}]}});
        let FromCrd::Partial(Some(pc)) = PrinterColumns::from_crd(&recursive, "v1") else { panic!("not partial") };
        assert_eq!(pc.columns().len(), 1);
    }

    #[test]
    fn ids_come_from_names_not_positions() {
        let mut ids = HashSet::new();
        let (a, _) = column(&mut ids, "Sync Status", "string", 0, None);
        let (b, _) = column(&mut ids, "Sync Status", "string", 0, None);
        let (c, _) = column(&mut ids, "Готов", "string", 0, None);
        let (d, _) = column(&mut ids, "Статус", "string", 0, None);
        assert_eq!((a.id.as_ref(), b.id.as_ref()), ("pc_sync_status_status", "pc_sync_status_status_2"));
        // Names of other characters would all come out as `pc_____…`: a hash of the name tells them apart.
        assert!(c.id.starts_with(&format!("pc_{}_text_", "_".repeat(5))) && c.id.len() == "pc__text_".len() + 5 + 8, "{}", c.id);
        assert!(d.id.starts_with(&format!("pc_{}_text_", "_".repeat(6))), "{}", d.id);
        assert_ne!(c.id, d.id);
        // The same column of another table (another cluster) gets the same id wherever it is.
        let (e, _) = column(&mut HashSet::new(), "Готов", "string", 0, Some(""));
        assert_eq!((e.id, e.description), (c.id, None));
    }
}
