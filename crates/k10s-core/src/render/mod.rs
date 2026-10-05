//! Row rendering: turns raw objects into compact table rows.
//!
//! Rendering happens in Rust, once per watch event, so the UI only ever receives the handful of
//! cells it displays (never whole objects). Each resource kind gets a [`Renderer`]; other kinds get the
//! CRD's `additionalPrinterColumns` ([`crd::PrinterColumns`]), else the columns the API server prints for them
//! ([`table::ServerColumns`], as `kubectl get` shows them), else [`generic`].
//!
//! Extending: implement a `fn(&Value) -> (Vec<Cell>, Tone)` plus its column list and register it in
//! [`builtin`] (see `workloads.rs` for examples).

mod cluster;
mod config;
pub mod crd;
pub mod jsonpath;
mod network;
mod rbac;
mod storage;
pub mod table;
pub mod util;
mod workloads;

use std::borrow::Cow;
use std::collections::HashMap;
use std::sync::{Arc, LazyLock};

use serde::ser::SerializeMap;
use serde::{Serialize, Serializer};
use serde_json::Value;

use self::util::JsonExt;
use crate::time;

/// Semantic color of a row or cell. Serialized as a small integer.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
#[repr(u8)]
pub enum Tone {
    #[default]
    Neutral = 0,
    Ok = 1,
    Warn = 2,
    Error = 3,
    Muted = 4,
    Info = 5,
}

impl Serialize for Tone {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_u8(*self as u8)
    }
}

/// How the UI formats, aligns and sorts a column. Cell shapes per kind:
/// - `text`/`labels`: string · `number`/`bytes`/`cpu`: number · `bool`: bool
/// - `status`: `[text, tone]` · `ratio`: `[ready, total]`
/// - `age`: unix seconds · `duration`: `[start, end | null]` · `restarts`: `[count, lastRestart | null]`
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ColumnKind {
    Text,
    Number,
    Bool,
    Status,
    Ratio,
    Restarts,
    Age,
    Duration,
    Bytes,
    Cpu,
    Labels,
}

impl ColumnKind {
    /// The kind as it is serialized.
    pub const fn name(self) -> &'static str {
        match self {
            ColumnKind::Text => "text",
            ColumnKind::Number => "number",
            ColumnKind::Bool => "bool",
            ColumnKind::Status => "status",
            ColumnKind::Ratio => "ratio",
            ColumnKind::Restarts => "restarts",
            ColumnKind::Age => "age",
            ColumnKind::Duration => "duration",
            ColumnKind::Bytes => "bytes",
            ColumnKind::Cpu => "cpu",
            ColumnKind::Labels => "labels",
        }
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct Column {
    pub id: Cow<'static, str>,
    pub title: Cow<'static, str>,
    pub kind: ColumnKind,
    /// Preferred width in px (0 = let the UI decide).
    #[serde(skip_serializing_if = "is_zero")]
    pub width: u16,
    /// Hidden by default (kubectl "wide" columns).
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub hidden: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<Cow<'static, str>>,
}

fn is_zero(v: &u16) -> bool {
    *v == 0
}

impl Column {
    pub const fn new(id: &'static str, title: &'static str, kind: ColumnKind) -> Self {
        Self { id: Cow::Borrowed(id), title: Cow::Borrowed(title), kind, width: 0, hidden: false, description: None }
    }
    pub const fn w(mut self, width: u16) -> Self {
        self.width = width;
        self
    }
    pub const fn hidden(mut self) -> Self {
        self.hidden = true;
        self
    }
    /// What the column shows, for its header's tooltip.
    pub fn describe(mut self, text: &'static str) -> Self {
        self.description = Some(Cow::Borrowed(text));
        self
    }
}

pub const fn col(id: &'static str, title: &'static str, kind: ColumnKind) -> Column {
    Column::new(id, title, kind)
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(untagged)]
pub enum Cell {
    Null,
    Bool(bool),
    Int(i64),
    Float(f64),
    Text(String),
    Status(String, Tone),
    Ratio(i64, i64),
    /// `[value, optional timestamp]` — restarts `[count, last]`, durations `[start, end]`.
    Pair(i64, Option<i64>),
}

impl Cell {
    pub fn text(s: impl Into<String>) -> Cell {
        Cell::Text(s.into())
    }
    pub fn opt_text(s: Option<&str>) -> Cell {
        s.filter(|s| !s.is_empty()).map_or(Cell::Null, |s| Cell::Text(s.to_owned()))
    }
    pub fn status(s: impl Into<String>, tone: Tone) -> Cell {
        Cell::Status(s.into(), tone)
    }
    pub fn opt_int(v: Option<i64>) -> Cell {
        v.map_or(Cell::Null, Cell::Int)
    }
    pub fn time(s: Option<&str>) -> Cell {
        s.and_then(time::unix_seconds).map_or(Cell::Null, Cell::Int)
    }
}

/// One table row. Field names are kept short on the wire.
#[derive(Clone, Debug, Serialize)]
pub struct Row {
    #[serde(rename = "u")]
    pub uid: Arc<str>,
    #[serde(rename = "n")]
    pub name: String,
    #[serde(rename = "ns", skip_serializing_if = "Option::is_none")]
    pub namespace: Option<String>,
    #[serde(rename = "rv")]
    pub resource_version: String,
    /// creationTimestamp, unix seconds.
    #[serde(rename = "t")]
    pub created: i64,
    #[serde(rename = "s")]
    pub tone: Tone,
    #[serde(rename = "c")]
    pub cells: Vec<Cell>,
    /// Labels as `k=v` joined by spaces — drives the Labels column and client-side filtering.
    #[serde(rename = "l", skip_serializing_if = "String::is_empty")]
    pub labels: String,
    /// Set while the object is being deleted.
    #[serde(rename = "x", skip_serializing_if = "std::ops::Not::not")]
    pub terminating: bool,
}

/// A [`Row`] on the wire with its cells laid out for other columns: `map[i]` is the index in `row.cells` of
/// the cell for column `i`, `None` where the row has no such column; cells past the end of `map` are left
/// out (the UI shows missing cells empty). Without a map, exactly the row. Keep in sync with [`Row`]'s fields.
pub struct RowOut<'a> {
    pub row: &'a Row,
    pub map: Option<&'a [Option<usize>]>,
}

impl Serialize for RowOut<'_> {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        struct Cells<'a>(&'a [Cell], &'a [Option<usize>]);
        impl Serialize for Cells<'_> {
            fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
                s.collect_seq(self.1.iter().map(|i| i.and_then(|i| self.0.get(i)).unwrap_or(&Cell::Null)))
            }
        }
        let Some(map) = self.map else { return self.row.serialize(s) };
        let r = self.row;
        let mut m = s.serialize_map(None)?;
        m.serialize_entry("u", &r.uid)?;
        m.serialize_entry("n", &r.name)?;
        if let Some(ns) = &r.namespace {
            m.serialize_entry("ns", ns)?;
        }
        m.serialize_entry("rv", &r.resource_version)?;
        m.serialize_entry("t", &r.created)?;
        m.serialize_entry("s", &r.tone)?;
        m.serialize_entry("c", &Cells(&r.cells, map))?;
        if !r.labels.is_empty() {
            m.serialize_entry("l", &r.labels)?;
        }
        if r.terminating {
            m.serialize_entry("x", &true)?;
        }
        m.end()
    }
}

pub type RenderFn = fn(&Value) -> (Vec<Cell>, Tone);

pub trait Renderer: Send + Sync {
    fn columns(&self) -> &[Column];
    fn render(&self, obj: &Value) -> (Vec<Cell>, Tone);

    /// Set when the cells come from server-side printing: the feed then lists and watches tables
    /// ([`table::watcher`]) instead of plain objects.
    fn server_table(&self) -> Option<&table::ServerColumns> {
        None
    }

    /// What a renderer built at runtime shows (its column definitions): two with the same identity render
    /// alike, so a feed started with one serves the other (see [`same`]). `None`: only itself.
    fn identity(&self) -> Option<&str> {
        None
    }
}

/// Whether two renderers render alike: the same one, or built from the same column definitions (printer
/// columns are resolved again after a reconnect or discovery refresh, usually to the same ones).
pub fn same(a: &Arc<dyn Renderer>, b: &Arc<dyn Renderer>) -> bool {
    Arc::ptr_eq(a, b) || a.identity().is_some_and(|x| b.identity() == Some(x))
}

pub struct FnRenderer {
    pub columns: Vec<Column>,
    pub f: RenderFn,
}

impl Renderer for FnRenderer {
    fn columns(&self) -> &[Column] {
        &self.columns
    }
    fn render(&self, obj: &Value) -> (Vec<Cell>, Tone) {
        (self.f)(obj)
    }
}

/// Builds a full row (common metadata + kind-specific cells).
pub fn build_row(obj: &Value, renderer: &dyn Renderer) -> Row {
    let md = obj.get("metadata");
    let s = |k: &str| md.and_then(|m| m.get(k)).and_then(Value::as_str);
    let (cells, mut tone) = renderer.render(obj);
    let terminating = s("deletionTimestamp").is_some();
    if terminating && tone == Tone::Neutral {
        tone = Tone::Muted;
    }
    let labels = md
        .and_then(|m| m.get("labels"))
        .and_then(Value::as_object)
        .map(|l| {
            let mut out = String::with_capacity(l.len() * 24);
            for (k, v) in l {
                if !out.is_empty() {
                    out.push(' ');
                }
                out.push_str(k);
                out.push('=');
                out.push_str(v.as_str().unwrap_or_default());
            }
            out
        })
        .unwrap_or_default();
    Row {
        uid: Arc::from(s("uid").unwrap_or_default()),
        name: s("name").unwrap_or_default().to_owned(),
        namespace: s("namespace").map(str::to_owned),
        resource_version: s("resourceVersion").unwrap_or_default().to_owned(),
        created: s("creationTimestamp").and_then(time::unix_seconds).unwrap_or(0),
        tone,
        cells,
        labels,
        terminating,
    }
}

struct Registry {
    by_kind: HashMap<(&'static str, &'static str), Arc<dyn Renderer>>,
    by_key: HashMap<String, Arc<dyn Renderer>>,
}

static REGISTRY: LazyLock<Registry> = LazyLock::new(|| {
    let mut by_kind: HashMap<(&'static str, &'static str), Arc<dyn Renderer>> = HashMap::new();
    let mut add = |group: &'static str, kind: &'static str, columns: Vec<Column>, f: RenderFn| {
        by_kind.insert((group, kind), Arc::new(FnRenderer { columns, f }));
    };
    workloads::register(&mut add);
    network::register(&mut add);
    config::register(&mut add);
    storage::register(&mut add);
    cluster::register(&mut add);
    rbac::register(&mut add);
    let by_key = by_kind
        .iter()
        .map(|((group, kind), r)| {
            let plural = naive_plural(kind);
            (if group.is_empty() { plural } else { format!("{plural}.{group}") }, r.clone())
        })
        .collect();
    Registry { by_kind, by_key }
});

pub type Add<'a> = dyn FnMut(&'static str, &'static str, Vec<Column>, RenderFn) + 'a;

/// Built-in renderer for a group/kind, if any.
pub fn builtin(group: &str, kind: &str) -> Option<Arc<dyn Renderer>> {
    REGISTRY.by_kind.get(&(group, kind)).cloned()
}

/// Built-in renderer by resource key (`deployments.apps`), usable before discovery has run.
pub fn builtin_for_key(key: &str) -> Option<Arc<dyn Renderer>> {
    REGISTRY.by_key.get(key).cloned()
}

/// kubectl-style pluralization; exact for every built-in kind.
fn naive_plural(kind: &str) -> String {
    let lower = kind.to_ascii_lowercase();
    if lower.ends_with("ss") {
        format!("{lower}es")
    } else if lower.ends_with('s') {
        lower
    } else if let Some(stem) = lower.strip_suffix('y').filter(|s| !s.ends_with(['a', 'e', 'i', 'o', 'u'])) {
        format!("{stem}ies")
    } else {
        format!("{lower}s")
    }
}

static GENERIC: LazyLock<Arc<dyn Renderer>> = LazyLock::new(|| Arc::new(FnRenderer { columns: Vec::new(), f: |_| (Vec::new(), Tone::Neutral) }));

/// Renderer with no kind-specific columns (Name / Namespace / Age are always provided by the UI).
pub fn generic() -> Arc<dyn Renderer> {
    GENERIC.clone()
}

/// Shared helper for kinds whose health is a list of standard `status.conditions`.
pub(crate) fn condition_tone(obj: &Value, cond: &str) -> Option<Tone> {
    obj.arr(&["status", "conditions"]).iter().find(|c| c.str_at(&["type"]) == Some(cond)).map(|c| match c.str_at(&["status"]) {
        Some("True") => Tone::Ok,
        Some("False") => Tone::Error,
        _ => Tone::Warn,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn row_serializes_compactly() {
        let obj = json!({
            "metadata": {"name": "web", "namespace": "prod", "uid": "u1", "resourceVersion": "7",
                         "creationTimestamp": "2024-01-01T00:00:00Z", "labels": {"app": "web"}},
            "spec": {"replicas": 3}, "status": {"readyReplicas": 2, "updatedReplicas": 3, "availableReplicas": 2}
        });
        let r = builtin("apps", "Deployment").unwrap();
        let row = build_row(&obj, r.as_ref());
        let s = serde_json::to_string(&row).unwrap();
        assert_eq!(s, r#"{"u":"u1","n":"web","ns":"prod","rv":"7","t":1704067200,"s":2,"c":[[2,3],3,2,null,null,null],"l":"app=web"}"#);
    }

    #[test]
    fn rows_with_rearranged_cells_keep_the_wire_format() {
        let mut row = Row {
            uid: Arc::from("u1"),
            name: "w".into(),
            namespace: Some("prod".into()),
            resource_version: "7".into(),
            created: 5,
            tone: Tone::Warn,
            cells: vec![Cell::Int(1), Cell::text("a"), Cell::Bool(true)],
            labels: "app=w".into(),
            terminating: true,
        };
        let identity = [Some(0), Some(1), Some(2)];
        for _ in 0..2 {
            let out = serde_json::to_value(RowOut { row: &row, map: Some(&identity) }).unwrap();
            assert_eq!(out, serde_json::to_value(&row).unwrap());
            assert_eq!(serde_json::to_value(RowOut { row: &row, map: None }).unwrap(), out);
            // And without the optional fields.
            (row.namespace, row.labels, row.terminating) = (None, String::new(), false);
        }
        let out = serde_json::to_value(RowOut { row: &row, map: Some(&[Some(2), None, Some(0)]) }).unwrap();
        assert_eq!(out["c"], serde_json::json!([true, null, 1]));
    }
}
