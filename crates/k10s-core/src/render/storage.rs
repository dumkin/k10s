use serde_json::Value;

use super::util::{JsonExt, access_modes, parse_quantity};
use super::{Add, Cell, ColumnKind as K, Tone, col};

pub fn register(add: &mut Add<'_>) {
    add(
        "",
        "PersistentVolume",
        vec![
            col("capacity", "Capacity", K::Bytes).w(90),
            col("accessModes", "Access Modes", K::Text).w(110),
            col("reclaimPolicy", "Reclaim Policy", K::Text).w(120),
            col("status", "Status", K::Status).w(100),
            col("claim", "Claim", K::Text).w(240),
            col("storageClass", "Storage Class", K::Text).w(150),
            col("reason", "Reason", K::Text).w(140).hidden(),
            col("volumeMode", "Volume Mode", K::Text).w(110).hidden(),
        ],
        pv,
    );
    add(
        "",
        "PersistentVolumeClaim",
        vec![
            col("status", "Status", K::Status).w(100),
            col("volume", "Volume", K::Text).w(260),
            col("capacity", "Capacity", K::Bytes).w(90),
            col("accessModes", "Access Modes", K::Text).w(110),
            col("storageClass", "Storage Class", K::Text).w(150),
            col("volumeMode", "Volume Mode", K::Text).w(110).hidden(),
        ],
        pvc,
    );
    add(
        "storage.k8s.io",
        "StorageClass",
        vec![
            col("provisioner", "Provisioner", K::Text).w(220),
            col("reclaimPolicy", "Reclaim Policy", K::Text).w(120),
            col("bindingMode", "Binding Mode", K::Text).w(170),
            col("expansion", "Allow Expansion", K::Bool).w(120),
            col("default", "Default", K::Bool).w(80),
        ],
        storage_class,
    );
    add(
        "storage.k8s.io",
        "VolumeAttachment",
        vec![
            col("attacher", "Attacher", K::Text).w(200),
            col("pv", "PV", K::Text).w(240),
            col("node", "Node", K::Text).w(180),
            col("attached", "Attached", K::Status).w(90),
        ],
        volume_attachment,
    );
}

fn bytes(q: Option<&str>) -> Cell {
    q.and_then(parse_quantity).map_or(Cell::Null, Cell::Float)
}

/// As kubectl: a volume or claim being deleted (usually held by its protection finalizer while still in use)
/// shows as Terminating, whatever its phase.
fn phase(o: &Value) -> &str {
    if o.str_at(&["metadata", "deletionTimestamp"]).is_some() { "Terminating" } else { o.str_at(&["status", "phase"]).unwrap_or("Unknown") }
}

fn pv(o: &Value) -> (Vec<Cell>, Tone) {
    let phase = phase(o);
    let tone = match phase {
        "Terminating" => Tone::Muted,
        "Bound" => Tone::Ok,
        "Available" => Tone::Info,
        "Released" | "Pending" => Tone::Warn,
        _ => Tone::Error,
    };
    let claim = match (o.str_at(&["spec", "claimRef", "namespace"]), o.str_at(&["spec", "claimRef", "name"])) {
        (Some(ns), Some(n)) => Some(format!("{ns}/{n}")),
        _ => None,
    };
    let cells = vec![
        bytes(o.str_at(&["spec", "capacity", "storage"])),
        Cell::opt_text(o.at(&["spec", "accessModes"]).and_then(access_modes).as_deref()),
        Cell::opt_text(o.str_at(&["spec", "persistentVolumeReclaimPolicy"])),
        Cell::status(phase, tone),
        Cell::opt_text(claim.as_deref()),
        Cell::opt_text(o.str_at(&["spec", "storageClassName"])),
        Cell::opt_text(o.str_at(&["status", "reason"])),
        Cell::opt_text(o.str_at(&["spec", "volumeMode"])),
    ];
    (cells, tone)
}

fn pvc(o: &Value) -> (Vec<Cell>, Tone) {
    let phase = phase(o);
    let tone = match phase {
        "Terminating" => Tone::Muted,
        "Bound" => Tone::Ok,
        "Pending" => Tone::Warn,
        _ => Tone::Error,
    };
    let cells = vec![
        Cell::status(phase, tone),
        Cell::opt_text(o.str_at(&["spec", "volumeName"])),
        bytes(o.str_at(&["status", "capacity", "storage"])),
        Cell::opt_text(o.at(&["status", "accessModes"]).and_then(access_modes).as_deref()),
        Cell::opt_text(o.str_at(&["spec", "storageClassName"])),
        Cell::opt_text(o.str_at(&["spec", "volumeMode"])),
    ];
    (cells, tone)
}

fn storage_class(o: &Value) -> (Vec<Cell>, Tone) {
    let default = o.str_at(&["metadata", "annotations", "storageclass.kubernetes.io/is-default-class"]) == Some("true");
    let cells = vec![
        Cell::opt_text(o.str_at(&["provisioner"])),
        Cell::text(o.str_at(&["reclaimPolicy"]).unwrap_or("Delete")),
        Cell::text(o.str_at(&["volumeBindingMode"]).unwrap_or("Immediate")),
        Cell::Bool(o.bool_at(&["allowVolumeExpansion"]).unwrap_or(false)),
        Cell::Bool(default),
    ];
    (cells, Tone::Neutral)
}

fn volume_attachment(o: &Value) -> (Vec<Cell>, Tone) {
    let attached = o.bool_at(&["status", "attached"]).unwrap_or(false);
    let tone = if attached { Tone::Ok } else { Tone::Warn };
    let cells = vec![
        Cell::opt_text(o.str_at(&["spec", "attacher"])),
        Cell::opt_text(o.str_at(&["spec", "source", "persistentVolumeName"])),
        Cell::opt_text(o.str_at(&["spec", "nodeName"])),
        Cell::status(if attached { "true" } else { "false" }, tone),
    ];
    (cells, tone)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::render::{build_row, builtin};
    use serde_json::json;

    #[test]
    fn deleted_volumes_and_claims_are_terminating() {
        let bound = json!({"metadata": {"name": "data"}, "spec": {"volumeName": "pv-1"}, "status": {"phase": "Bound"}});
        let (cells, tone) = pvc(&bound);
        assert_eq!((&cells[0], tone), (&Cell::status("Bound", Tone::Ok), Tone::Ok));

        let mut deleting = bound.clone();
        deleting["metadata"]["deletionTimestamp"] = json!("2024-01-01T00:00:00Z");
        let row = build_row(&deleting, builtin("", "PersistentVolumeClaim").unwrap().as_ref());
        assert_eq!((&row.cells[0], row.tone, row.terminating), (&Cell::status("Terminating", Tone::Muted), Tone::Muted, true));

        let pv_deleting = json!({"metadata": {"deletionTimestamp": "2024-01-01T00:00:00Z"}, "spec": {"claimRef": {"namespace": "db", "name": "data"}}, "status": {"phase": "Bound"}});
        let (cells, tone) = pv(&pv_deleting);
        assert_eq!((&cells[3], tone), (&Cell::status("Terminating", Tone::Muted), Tone::Muted));
        assert_eq!(cells[4], Cell::text("db/data"));
        assert_eq!(pv(&json!({"status": {"phase": "Released"}})).1, Tone::Warn);
    }
}
