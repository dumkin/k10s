use serde_json::Value;

use super::util::{JsonExt, truncate_list};
use super::{Add, Cell, ColumnKind as K, Tone, col};

pub fn register(add: &mut Add<'_>) {
    add("", "ServiceAccount", vec![col("secrets", "Secrets", K::Number).w(70)], service_account);
    add("rbac.authorization.k8s.io", "Role", vec![col("rules", "Rules", K::Number).w(70)], role);
    add("rbac.authorization.k8s.io", "ClusterRole", vec![col("rules", "Rules", K::Number).w(70)], role);
    let binding_columns = || {
        vec![
            col("role", "Role", K::Text).w(240),
            col("users", "Users", K::Text).w(200),
            col("groups", "Groups", K::Text).w(200),
            col("serviceAccounts", "Service Accounts", K::Text).w(240),
        ]
    };
    add("rbac.authorization.k8s.io", "RoleBinding", binding_columns(), binding);
    add("rbac.authorization.k8s.io", "ClusterRoleBinding", binding_columns(), binding);
}

fn service_account(o: &Value) -> (Vec<Cell>, Tone) {
    (vec![Cell::Int(o.arr(&["secrets"]).len() as i64)], Tone::Neutral)
}

fn role(o: &Value) -> (Vec<Cell>, Tone) {
    (vec![Cell::Int(o.arr(&["rules"]).len() as i64)], Tone::Neutral)
}

fn binding(o: &Value) -> (Vec<Cell>, Tone) {
    let role = match (o.str_at(&["roleRef", "kind"]), o.str_at(&["roleRef", "name"])) {
        (Some(k), Some(n)) => Some(format!("{k}/{n}")),
        _ => None,
    };
    let mut users = Vec::new();
    let mut groups = Vec::new();
    let mut sas = Vec::new();
    for s in o.arr(&["subjects"]) {
        let name = s.str_at(&["name"]).unwrap_or_default().to_string();
        match s.str_at(&["kind"]) {
            Some("User") => users.push(name),
            Some("Group") => groups.push(name),
            Some("ServiceAccount") => sas.push(match s.str_at(&["namespace"]) {
                Some(ns) => format!("{ns}/{name}"),
                None => name,
            }),
            _ => {}
        }
    }
    let cells = vec![
        Cell::opt_text(role.as_deref()),
        Cell::opt_text(truncate_list(&users, 3).as_deref()),
        Cell::opt_text(truncate_list(&groups, 3).as_deref()),
        Cell::opt_text(truncate_list(&sas, 3).as_deref()),
    ];
    (cells, Tone::Neutral)
}
