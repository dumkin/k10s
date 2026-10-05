//! Server-side printing: the API server renders the table, as for `kubectl get`
//! (`Accept: application/json;as=Table;…`).
//!
//! For resources whose printer columns k10s cannot evaluate itself: custom resources whose
//! CustomResourceDefinition the user may not read (strict RBAC grants the resources, rarely their
//! cluster-scoped definitions), aggregated APIs, built-in kinds without a renderer here. [`probe`] asks for
//! the column definitions; [`watcher`] then lists and watches the resource as tables — with
//! `includeObject=Object`, so the feed still keeps whole objects for details and YAML — and hands each
//! object over with its cells attached under [`CELLS`], which [`ServerColumns`] turns into a row (the feed
//! drops them before it keeps the object). Lists and watch events are parsed with nesting bounded
//! ([`BoundedValue`](crate::object::BoundedValue)), like plain objects: one deeply nested object cannot fail the
//! table it comes in.

use std::collections::HashSet;
use std::sync::Arc;

use futures::Stream;
use kube::core::Request;
use kube::core::params::ListParams;
use kube::runtime::watcher::{self, Event};
use kube::{Api, Client};
use serde_json::Value;

use super::crd::{self, Ty};
use super::jsonpath::JsonPath;
use super::util::JsonExt;
use super::{Cell, Column, Renderer, Tone};
use crate::object::Obj;
use crate::time;

/// Where an object handed to the feed carries its cells (removed before the feed keeps the object).
pub const CELLS: &str = "__k10sTableCells";
/// What `kubectl get` asks for; plain JSON from servers that cannot print tables.
const ACCEPT: &str = "application/json;as=Table;v=v1;g=meta.k8s.io,application/json;as=Table;v=v1beta1;g=meta.k8s.io,application/json";

/// Renders the cells the API server printed (see the module docs).
pub struct ServerColumns {
    columns: Vec<Column>,
    /// Per shown column: where its cell is among the server's (`layout`), how it is typed, and for dates
    /// the JSONPath of a CRD's column (see [`ServerColumns::render`]).
    cells: Vec<(usize, Ty, Option<JsonPath>)>,
    /// Names of all the server's columns, in the order the feed hands their cells over.
    layout: Arc<[String]>,
    identity: String,
}

impl ServerColumns {
    /// From a table's `columnDefinitions`; `None` if they hold nothing besides the name and the age of
    /// objects (the UI always shows those).
    pub fn from_definitions(defs: &[Value]) -> Option<Self> {
        let layout: Arc<[String]> = defs.iter().map(|d| d.str_at(&["name"]).unwrap_or_default().to_string()).collect();
        let mut columns = Vec::new();
        let mut cells = Vec::new();
        let mut ids = HashSet::new();
        for (i, def) in defs.iter().enumerate() {
            let name = &layout[i];
            let ty = def.str_at(&["type"]).unwrap_or("string");
            let description = def.str_at(&["description"]);
            // A CRD's column says its JSONPath (unless the CRD describes it): dropped exactly where the CRD's own
            // columns are, so both ways give a cluster the same columns.
            let path = description.and_then(|d| d.strip_prefix(crd::DESCRIBED_BY_PATH));
            let age = path.map_or_else(|| is_age(name, ty, description), crd::is_creation_timestamp);
            if name.is_empty() || def.str_at(&["format"]) == Some("name") || age {
                continue;
            }
            let (column, ty) = crd::column(&mut ids, name, ty, def.i64_at(&["priority"]).unwrap_or(0), description);
            let path = path.filter(|_| ty == Ty::Date).and_then(|p| JsonPath::parse(p).ok());
            columns.push(column);
            cells.push((i, ty, path));
        }
        (!columns.is_empty()).then(|| Self { columns, cells, layout, identity: format!("table:{}", Value::Array(defs.to_vec())) })
    }

    /// Names of all the server's columns: how [`watcher`] arranges the cells it hands over.
    pub fn layout(&self) -> Arc<[String]> {
        self.layout.clone()
    }
}

/// The age of objects, for columns that do not say their JSONPath: kubectl's humanized `Age` of built-in
/// kinds and the default table's `Created At` (described by the field's API documentation), a CRD's date
/// column named Age.
fn is_age(name: &str, ty: &str, description: Option<&str>) -> bool {
    let creation = description.is_some_and(|d| d.starts_with("CreationTimestamp is a timestamp"));
    let age = name.eq_ignore_ascii_case("age");
    (creation && (ty == "date" || age)) || (ty == "date" && age)
}

impl Renderer for ServerColumns {
    fn columns(&self) -> &[Column] {
        &self.columns
    }

    /// Dates come printed as ages (`5d3h`, `<unknown>`): taken from the object where the column's JSONPath is
    /// known (exact, like a CRD's columns evaluated here), else counted back from now.
    fn render(&self, obj: &Value) -> (Vec<Cell>, Tone) {
        let cells = obj.arr(&[CELLS]);
        let mut tone = Tone::Neutral;
        let out = self
            .cells
            .iter()
            .map(|(i, ty, path)| match ty {
                Ty::Date => date(path.as_ref().and_then(|p| p.first(obj)), cells.get(*i)),
                _ => crd::cell(cells.get(*i), *ty, &mut tone),
            })
            .collect();
        (out, tone)
    }

    fn server_table(&self) -> Option<&ServerColumns> {
        Some(self)
    }

    fn identity(&self) -> Option<&str> {
        Some(&self.identity)
    }
}

/// A date cell: the object's own timestamp if there is one, else the printed age (a timestamp from servers
/// that print one) as of now.
fn date(exact: Option<&Value>, printed: Option<&Value>) -> Cell {
    let exact = exact.and_then(Value::as_str).and_then(time::unix_seconds);
    let printed = || printed.and_then(Value::as_str).and_then(|s| time::unix_seconds(s).or_else(|| age_seconds(s).map(|d| time::now_unix() - d)));
    exact.or_else(printed).map_or(Cell::Null, Cell::Int)
}

/// Seconds of an age as the API server prints them (`45s`, `3m20s`, `5h`, `5d3h`, `2y30d`); `None` for
/// `<unknown>`, `<invalid>` (a time in the future) and anything else.
fn age_seconds(s: &str) -> Option<i64> {
    let mut total = 0i64;
    let mut n: Option<i64> = None;
    for c in s.chars() {
        if let Some(d) = c.to_digit(10) {
            n = Some(n.unwrap_or(0).checked_mul(10)?.checked_add(i64::from(d))?);
            continue;
        }
        let unit = match c {
            'y' => 365 * 86_400,
            'd' => 86_400,
            'h' => 3_600,
            'm' => 60,
            's' => 1,
            _ => return None,
        };
        total = total.checked_add(n.take()?.checked_mul(unit)?)?;
    }
    (n.is_none() && !s.is_empty()).then_some(total)
}

/// What server-side printing offers for a resource.
pub enum Probe {
    Columns(ServerColumns),
    /// A table with nothing besides name and age.
    NoColumns,
    /// No table: the server does not print this resource.
    Unsupported,
}

/// Asks for the table of a collection (`url`: a resource, possibly in a namespace) with one row and no
/// objects: its column definitions.
pub async fn probe(client: &Client, url: &str) -> kube::Result<Probe> {
    let lp = ListParams { limit: Some(1), ..Default::default() };
    let mut req = as_table(Request::new(url).list(&lp).map_err(kube::Error::BuildRequest)?, "None");
    req.extensions_mut().insert("list");
    match client.request::<Value>(req).await {
        Ok(table) if is_table(&table) => Ok(ServerColumns::from_definitions(table.arr(&["columnDefinitions"])).map_or(Probe::NoColumns, Probe::Columns)),
        Ok(_) => Ok(Probe::Unsupported),
        Err(kube::Error::Api(s)) if matches!(s.code, 406 | 415) => Ok(Probe::Unsupported),
        Err(e) => Err(e),
    }
}

/// `req` asking for a table whose rows carry `include` (`Object`, `Metadata` or `None`).
pub(crate) fn as_table(mut req: http::Request<Vec<u8>>, include: &str) -> http::Request<Vec<u8>> {
    let uri = req.uri().to_string();
    let sep = if uri.ends_with('?') {
        ""
    } else if uri.contains('?') {
        "&"
    } else {
        "?"
    };
    if let Ok(uri) = format!("{uri}{sep}includeObject={include}").parse() {
        *req.uri_mut() = uri;
    }
    req.headers_mut().insert(http::header::ACCEPT, http::HeaderValue::from_static(ACCEPT));
    req
}

fn is_table(v: &Value) -> bool {
    v.str_at(&["kind"]) == Some("Table") && v.str_at(&["apiVersion"]).is_some_and(|a| a.starts_with("meta.k8s.io/"))
}

/// Lists and watches a resource as server-side printed tables (see [`crate::watch`]): objects carry their cells
/// under [`CELLS`], arranged as `layout` names the columns.
pub fn watcher(api: Api<Obj>, config: watcher::Config, layout: Arc<[String]>) -> impl Stream<Item = Result<Event<Obj>, watcher::Error>> + Send {
    crate::watch::watcher(api, config, Some(layout))
}

/// How the cells of a table's rows go onto the layout, as the last column definitions seen say. A watch
/// sends them with its first event only (a BOOKMARK, often); until then, those of the list it follows hold.
#[derive(Clone, Default)]
pub(crate) struct Arrangement {
    /// How many cells rows have (`None`: no definitions seen; the layout's).
    pub(crate) width: Option<usize>,
    /// Where the cells of the layout's columns are among a row's (`None`: they line up).
    pub(crate) map: Option<Vec<Option<usize>>>,
}

pub(crate) fn definitions(table: &Value) -> Option<&[Value]> {
    table.get("columnDefinitions").and_then(Value::as_array).map(Vec::as_slice).filter(|d| !d.is_empty())
}

/// The objects of a table (or of a watch event's one-row table), each with its cells; whether the table had
/// column definitions (then `arrangement` follows them); whether every row had the cells they say. `cut`: the
/// table was nested too deeply somewhere (see [`BoundedValue`](crate::object::BoundedValue)).
pub(crate) fn objects(table: Value, layout: &[String], arrangement: &mut Arrangement, cut: bool) -> (Vec<Obj>, bool, bool) {
    if !is_table(&table) {
        // The object itself: this server does not print it.
        return (vec![Obj::from_bounded(table, cut)], false, true);
    }
    let headed = match definitions(&table) {
        Some(defs) => {
            *arrangement = arrange(defs, layout);
            true
        }
        None => false,
    };
    let Value::Object(mut table) = table else { return (Vec::new(), headed, true) };
    let Some(Value::Array(rows)) = table.remove("rows") else { return (Vec::new(), headed, true) };
    let width = arrangement.width.unwrap_or(layout.len());
    let mut fits = true;
    let objects = rows
        .into_iter()
        .filter_map(|row| {
            let (obj, n) = object(row, arrangement.map.as_deref(), cut)?;
            fits &= n == width;
            Some(obj)
        })
        .collect();
    (objects, headed, fits)
}

/// A row's object with its cells, and how many cells the row had.
pub(crate) fn object(row: Value, map: Option<&[Option<usize>]>, cut: bool) -> Option<(Obj, usize)> {
    let Value::Object(mut row) = row else { return None };
    let Some(Value::Object(mut obj)) = row.remove("object") else { return None };
    let cells = match row.remove("cells") {
        Some(Value::Array(cells)) => cells,
        _ => Vec::new(),
    };
    let n = cells.len();
    let cells = match map {
        None => cells,
        Some(map) => map.iter().map(|i| i.and_then(|i| cells.get(i).cloned()).unwrap_or(Value::Null)).collect(),
    };
    obj.insert(CELLS.to_string(), Value::Array(cells));
    Some((Obj::from_bounded(Value::Object(obj), cut), n))
}

pub(crate) fn arrange(defs: &[Value], layout: &[String]) -> Arrangement {
    let names: Vec<&str> = defs.iter().map(|d| d.str_at(&["name"]).unwrap_or_default()).collect();
    let map = (names.len() != layout.len() || names.iter().zip(layout).any(|(a, b)| *a != b.as_str()))
        .then(|| layout.iter().map(|l| names.iter().position(|n| *n == l.as_str())).collect());
    Arrangement { width: Some(names.len()), map }
}

/// A fake API server for tests that need more than pods: answers are chosen per request.
#[cfg(test)]
pub(crate) mod fake {
    use std::pin::Pin;
    use std::sync::Arc;
    use std::task::{Context, Poll};

    use kube::Client;
    use kube::client::Body;
    use parking_lot::Mutex;

    /// An answer: status, body, and whether the body then stays open (an idle watch).
    pub(crate) struct Reply {
        pub status: u16,
        pub body: String,
        pub open: bool,
    }

    impl Reply {
        pub(crate) fn json(body: impl Into<String>) -> Self {
            Reply { status: 200, body: body.into(), open: false }
        }

        /// A watch: these events, then nothing (the stream stays open).
        pub(crate) fn events(lines: &[String]) -> Self {
            let mut body = lines.join("\n");
            if !body.is_empty() {
                body.push('\n');
            }
            Reply { status: 200, body, open: true }
        }

        pub(crate) fn status(code: u16) -> Self {
            Reply {
                status: code,
                body: format!(r#"{{"kind":"Status","apiVersion":"v1","status":"Failure","message":"failed with {code}","reason":"R{code}","code":{code}}}"#),
                open: false,
            }
        }
    }

    struct TestBody {
        data: Option<bytes::Bytes>,
        open: bool,
    }

    impl http_body::Body for TestBody {
        type Data = bytes::Bytes;
        type Error = std::convert::Infallible;

        fn poll_frame(mut self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<Option<Result<http_body::Frame<bytes::Bytes>, Self::Error>>> {
            match self.data.take() {
                Some(d) => Poll::Ready(Some(Ok(http_body::Frame::data(d)))),
                None if self.open => Poll::Pending,
                None => Poll::Ready(None),
            }
        }
    }

    /// Requests seen: `uri` and `accept` header.
    pub(crate) type Log = Arc<Mutex<Vec<(String, String)>>>;

    pub(crate) fn server(log: Log, reply: impl Fn(&str, &str) -> Reply + Send + Sync + 'static) -> Client {
        let svc = tower::service_fn(move |req: http::Request<Body>| {
            let uri = req.uri().to_string();
            let accept = req.headers().get(http::header::ACCEPT).and_then(|v| v.to_str().ok()).unwrap_or_default().to_string();
            let r = reply(&uri, &accept);
            log.lock().push((uri, accept));
            async move {
                Ok::<_, std::convert::Infallible>(
                    http::Response::builder()
                        .status(r.status)
                        .header("content-type", "application/json")
                        .body(TestBody { data: Some(bytes::Bytes::from(r.body)), open: r.open })
                        .unwrap(),
                )
            }
        });
        Client::new(svc, "default")
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use futures::StreamExt;

    use super::*;
    use crate::render::ColumnKind;
    use serde_json::json;

    /// Column definitions as the API server prints them for a custom resource.
    pub(crate) fn definitions(extra: &[(&str, &str, i64)]) -> Value {
        let mut defs =
            vec![json!({"name": "Name", "type": "string", "format": "name", "description": "Name must be unique within a namespace.", "priority": 0})];
        for (name, ty, priority) in extra {
            defs.push(json!({"name": name, "type": ty, "format": "", "description": format!("Custom resource definition column (in JSONPath format): .status.{}", name.to_lowercase()), "priority": priority}));
        }
        defs.push(json!({"name": "Age", "type": "date", "format": "", "description": "Custom resource definition column (in JSONPath format): .metadata.creationTimestamp", "priority": 0}));
        Value::Array(defs)
    }

    /// A widget as a table row: name, then `cells`, then its age (printed as the API server prints dates).
    pub(crate) fn row(name: &str, rv: &str, cells: &[Value]) -> Value {
        let mut all = vec![json!(name)];
        all.extend(cells.iter().cloned());
        all.push(json!("640d"));
        json!({"cells": all, "object": {"apiVersion": "example.com/v1", "kind": "Widget", "metadata": {"name": name, "namespace": "default", "uid": format!("uid-{name}"), "resourceVersion": rv, "creationTimestamp": "2024-01-01T00:00:00Z", "managedFields": [{"manager": "x"}]}, "spec": {}}})
    }

    pub(crate) fn table(defs: Option<&Value>, rows: &[Value], rv: &str) -> Value {
        let mut t = json!({"kind": "Table", "apiVersion": "meta.k8s.io/v1", "metadata": {"resourceVersion": rv}, "rows": rows});
        if let Some(defs) = defs {
            t["columnDefinitions"] = defs.clone();
        }
        t
    }

    #[test]
    fn columns_from_definitions_leave_name_and_age_to_the_ui() {
        let defs = definitions(&[("Ready", "string", 0), ("Replicas", "integer", 1), ("Expires", "date", 0)]);
        let sc = ServerColumns::from_definitions(defs.as_array().unwrap()).unwrap();
        let shown: Vec<(&str, ColumnKind, bool)> = sc.columns().iter().map(|c| (c.id.as_ref(), c.kind, c.hidden)).collect();
        assert_eq!(
            shown,
            [("pc_ready_status", ColumnKind::Status, false), ("pc_replicas_number", ColumnKind::Number, true), ("pc_expires_age", ColumnKind::Age, false)]
        );
        // Dates are printed as ages; the object (included whole) has the exact time.
        let mut obj = json!({"metadata": {"name": "w"}, "status": {"expires": "2024-01-01T00:00:00Z"}});
        obj[CELLS] = json!(["w", "False", 3, "640d", "640d"]);
        let (cells, tone) = sc.render(&obj);
        assert_eq!(cells, [Cell::Status("False".into(), Tone::Error), Cell::Int(3), Cell::Int(1704067200)]);
        assert_eq!(tone, Tone::Error);

        // Built-in kinds print a humanized Age; the default table a `Created At`. Neither is a column here.
        let builtin = json!([
            {"name": "Name", "type": "string", "format": "name"},
            {"name": "Holder", "type": "string", "format": ""},
            {"name": "Age", "type": "string", "description": "CreationTimestamp is a timestamp representing the server time when this object was created."}
        ]);
        let sc = ServerColumns::from_definitions(builtin.as_array().unwrap()).unwrap();
        assert_eq!(sc.columns().len(), 1);
        let default = json!([{"name": "Name", "type": "string", "format": "name"}, {"name": "Created At", "type": "date", "description": "CreationTimestamp is a timestamp representing the server time when this object was created."}]);
        assert!(ServerColumns::from_definitions(default.as_array().unwrap()).is_none());
    }

    #[test]
    fn dates_without_a_known_json_path_are_counted_back_from_their_printed_age() {
        // The CRD describes its column itself: the API server does not say its JSONPath.
        let defs = json!([{"name": "Name", "type": "string", "format": "name"}, {"name": "Last Run", "type": "date", "description": "When the job last ran."}]);
        let sc = ServerColumns::from_definitions(defs.as_array().unwrap()).unwrap();
        assert_eq!(sc.columns()[0].description.as_deref(), Some("When the job last ran."));
        let render = |printed: Value| {
            let mut obj = json!({"metadata": {"name": "w"}});
            obj[CELLS] = json!(["w", printed]);
            sc.render(&obj).0.remove(0)
        };
        let ago = |s: i64| Cell::Int(time::now_unix() - s);
        assert_eq!(render(json!("5d3h")), ago(5 * 86_400 + 3 * 3_600));
        assert_eq!(render(json!("3m20s")), ago(200));
        assert_eq!(render(json!("2y30d")), ago(760 * 86_400));
        // Servers that print a timestamp after all.
        assert_eq!(render(json!("2024-01-01T00:00:00Z")), Cell::Int(1704067200));
        for nothing in [json!("<unknown>"), json!("<invalid>"), json!(""), json!("5x"), json!("d"), Value::Null] {
            assert_eq!(render(nothing), Cell::Null);
        }
    }

    #[test]
    fn a_crd_gets_the_same_columns_read_from_it_or_printed_by_the_server() {
        use crate::render::crd::{FromCrd, PrinterColumns};
        // (name, type, JSONPath, description)
        let columns = [
            ("Ready", "string", ".status.conditions[?(@.type==\"Ready\")].status", ""),
            ("Age", "date", ".status.startTime", ""),
            ("Created", "date", ".metadata.creationTimestamp", ""),
            ("Replicas", "integer", ".spec.replicas", "Desired replicas"),
        ];
        let crd = json!({"spec": {"versions": [{"name": "v1", "additionalPrinterColumns":
            columns.iter().map(|(n, t, p, d)| json!({"name": n, "type": t, "jsonPath": p, "description": d})).collect::<Vec<_>>()}]}});
        let FromCrd::Complete(read) = PrinterColumns::from_crd(&crd, "v1") else { panic!("not complete") };
        // As the API server prints them: the name first, CRD columns described by their JSONPath unless described.
        let mut defs = vec![json!({"name": "Name", "type": "string", "format": "name", "description": "Name must be unique within a namespace."})];
        defs.extend(columns.iter().map(|(n, t, p, d)| {
            let description = if d.is_empty() { format!("{}{p}", crd::DESCRIBED_BY_PATH) } else { d.to_string() };
            json!({"name": n, "type": t, "format": "", "description": description, "priority": 0})
        }));
        let printed = ServerColumns::from_definitions(&defs).unwrap();
        let shown = |r: &dyn Renderer| r.columns().iter().map(|c| (c.id.to_string(), c.kind, c.description.clone())).collect::<Vec<_>>();
        assert_eq!(shown(&read), shown(&printed));
        assert_eq!(read.columns().iter().map(|c| c.id.as_ref()).collect::<Vec<_>>(), ["pc_ready_status", "pc_age_age", "pc_replicas_number"]);
        // And the same cells: dates exact either way.
        let obj = json!({"spec": {"replicas": 2}, "status": {"startTime": "2024-01-01T00:00:00Z", "conditions": [{"type": "Ready", "status": "True"}]}});
        let mut with_cells = obj.clone();
        with_cells[CELLS] = json!(["w", "True", "640d", "640d", 2]);
        assert_eq!(read.render(&obj), printed.render(&with_cells));
    }

    #[test]
    fn rows_of_a_table_whose_columns_changed_are_rearranged_by_name() {
        let layout: Arc<[String]> = ["Name", "Ready", "Secret", "Age"].map(String::from).into();
        let newer = definitions(&[("Secret", "string", 0), ("Issuer", "string", 0), ("Ready", "string", 0)]);
        let t = table(Some(&newer), &[row("w", "5", &[json!("tls"), json!("ca"), json!("True")])], "5");
        let mut arrangement = Arrangement::default();
        let (objs, headed, fits) = objects(t, &layout, &mut arrangement, false);
        assert!(headed && fits);
        assert_eq!(objs[0].raw[CELLS], json!(["w", "True", "tls", "640d"]));
        assert!(objs[0].raw["metadata"].get("managedFields").is_none());
        // Later events of the watch come without definitions: the same arrangement holds.
        let (objs, headed, fits) = objects(table(None, &[row("w", "6", &[json!("tls2"), json!("ca"), json!("False")])], "6"), &layout, &mut arrangement, false);
        assert!(!headed && fits);
        assert_eq!(objs[0].raw[CELLS], json!(["w", "False", "tls2", "640d"]));
        // A row of other columns than the definitions said: told.
        let (_, _, fits) = objects(table(None, &[row("w", "7", &[json!("tls2"), json!("False")])], "7"), &layout, &mut arrangement, false);
        assert!(!fits);
    }

    fn widgets_api(client: Client) -> Api<Obj> {
        let ar = kube::core::ApiResource {
            group: "example.com".into(),
            version: "v1".into(),
            api_version: "example.com/v1".into(),
            kind: "Widget".into(),
            plural: "widgets".into(),
        };
        Api::namespaced_with(client, "default", &ar)
    }

    fn describe(e: Result<Event<Obj>, watcher::Error>) -> String {
        match e.unwrap() {
            Event::Init => "init".to_string(),
            Event::InitApply(o) => format!("list {} {}", o.name(), o.raw[CELLS]),
            Event::InitDone => "listed".to_string(),
            Event::Apply(o) => format!("apply {} {}", o.name(), o.raw[CELLS]),
            Event::Delete(o) => format!("delete {}", o.name()),
        }
    }

    #[tokio::test]
    async fn lists_and_watches_tables_like_the_object_watcher() {
        let defs = definitions(&[("Ready", "string", 0)]);
        let log: fake::Log = Arc::default();
        let d = defs.clone();
        let client = fake::server(log.clone(), move |uri, _| {
            if uri.contains("watch=true") {
                let added = json!({"type": "ADDED", "object": table(Some(&d), &[row("b", "11", &[json!("True")])], "11")});
                let modified = json!({"type": "MODIFIED", "object": table(None, &[row("a", "12", &[json!("False")])], "12")});
                let bookmark =
                    json!({"type": "BOOKMARK", "object": {"kind": "Table", "apiVersion": "meta.k8s.io/v1", "metadata": {"resourceVersion": "13"}, "rows": []}});
                let deleted = json!({"type": "DELETED", "object": table(None, &[row("b", "14", &[json!("True")])], "14")});
                return fake::Reply::events(&[added, modified, bookmark, deleted].map(|e| e.to_string()));
            }
            fake::Reply::json(table(Some(&d), &[row("a", "10", &[json!("True")])], "10").to_string())
        });
        let layout = ServerColumns::from_definitions(defs.as_array().unwrap()).unwrap().layout();
        let config = watcher::Config::default().any_semantic().timeout(55).labels("app=web");
        let events: Vec<String> = watcher(widgets_api(client), config, layout).take(6).map(describe).collect().await;
        assert_eq!(
            events,
            ["init", r#"list a ["a","True","640d"]"#, "listed", r#"apply b ["b","True","640d"]"#, r#"apply a ["a","False","640d"]"#, "delete b"]
        );
        let log = log.lock();
        assert!(
            log.iter().all(|(uri, accept)| uri.contains("includeObject=Object") && accept.starts_with("application/json;as=Table;v=v1;g=meta.k8s.io")),
            "{log:?}"
        );
        assert!(log[0].0.contains("labelSelector=app%3Dweb") && log[1].0.contains("watch=true") && log[1].0.contains("resourceVersion=10"), "{log:?}");
    }

    #[tokio::test]
    async fn a_watch_whose_first_event_is_a_bookmark_keeps_its_column_definitions() {
        // The columns were probed (and listed) as Ready, Secret; the operator was upgraded since.
        let old = definitions(&[("Ready", "string", 0), ("Secret", "string", 0)]);
        let new = definitions(&[("Secret", "string", 0), ("Issuer", "string", 0), ("Ready", "string", 0)]);
        let o = old.clone();
        let client = fake::server(Arc::default(), move |uri, _| {
            if uri.contains("watch=true") {
                // A quiet resource: the watch's first event, with the definitions, is a bookmark.
                let bookmark = json!({"type": "BOOKMARK", "object": table(Some(&new), &[], "11")});
                let modified = json!({"type": "MODIFIED", "object": table(None, &[row("a", "12", &[json!("tls2"), json!("ca"), json!("False")])], "12")});
                return fake::Reply::events(&[bookmark, modified].map(|e| e.to_string()));
            }
            fake::Reply::json(table(Some(&o), &[row("a", "10", &[json!("True"), json!("tls")])], "10").to_string())
        });
        let layout = ServerColumns::from_definitions(old.as_array().unwrap()).unwrap().layout();
        let config = watcher::Config::default().any_semantic().timeout(55);
        let events: Vec<String> = watcher(widgets_api(client), config, layout).take(4).map(describe).collect().await;
        assert_eq!(events, ["init", r#"list a ["a","True","tls","640d"]"#, "listed", r#"apply a ["a","False","tls2","640d"]"#]);
    }

    #[tokio::test]
    async fn one_deeply_nested_object_fails_neither_the_printed_list_nor_its_watch() {
        let defs = definitions(&[("Ready", "string", 0)]);
        // As text: a `Value` that deep could not even be dropped without recursing that deep.
        let deep = |rv: &str| {
            let mut r = row("deep", rv, &[json!("True")]);
            r["object"]["spec"] = json!("SPEC");
            r.to_string().replace(r#""SPEC""#, &format!(r#"{{"values":{}"leaf"{}}}"#, r#"{"a":"#.repeat(10_000), "}".repeat(10_000)))
        };
        let list = format!(
            r#"{{"kind":"Table","apiVersion":"meta.k8s.io/v1","metadata":{{"resourceVersion":"10"}},"columnDefinitions":{defs},"rows":[{},{},{}]}}"#,
            row("a", "10", &[json!("True")]),
            deep("10"),
            row("c", "10", &[json!("False")])
        );
        assert!(serde_json::from_str::<Value>(&list).unwrap_err().to_string().contains("recursion limit"));
        let event = format!(
            r#"{{"type":"MODIFIED","object":{{"kind":"Table","apiVersion":"meta.k8s.io/v1","metadata":{{"resourceVersion":"11"}},"rows":[{}]}}}}"#,
            deep("11")
        );
        let client = fake::server(Arc::default(), move |uri, _| {
            if uri.contains("watch=true") { fake::Reply::events(std::slice::from_ref(&event)) } else { fake::Reply::json(list.clone()) }
        });
        let layout = ServerColumns::from_definitions(defs.as_array().unwrap()).unwrap().layout();
        let config = watcher::Config::default().any_semantic().timeout(55);
        let events: Vec<(String, bool)> = watcher(widgets_api(client), config, layout)
            .take(6)
            .map(|e| match e.unwrap() {
                Event::InitApply(o) => (format!("list {} {}", o.name(), o.raw[CELLS]), o.truncated()),
                Event::Apply(o) => (format!("apply {} {}", o.name(), o.raw[CELLS]), o.truncated()),
                other => (describe(Ok(other)), false),
            })
            .collect()
            .await;
        let deep_cells = r#"["deep","True","640d"]"#;
        assert_eq!(
            events,
            [
                ("init".to_string(), false),
                (r#"list a ["a","True","640d"]"#.to_string(), false),
                (format!("list deep {deep_cells}"), true),
                (r#"list c ["c","False","640d"]"#.to_string(), false),
                ("listed".to_string(), false),
                (format!("apply deep {deep_cells}"), true),
            ]
        );
    }

    #[tokio::test]
    async fn rows_of_unknown_columns_during_a_watch_are_listed_again() {
        let old = definitions(&[("Ready", "string", 0)]);
        let new = definitions(&[("Issuer", "string", 0), ("Ready", "string", 0)]);
        let lists = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let (o, l) = (old.clone(), lists.clone());
        let client = fake::server(Arc::default(), move |uri, _| {
            if uri.contains("watch=true") {
                // Without definitions (as no API server sends a watch), rows of more cells than listed.
                let modified = json!({"type": "MODIFIED", "object": table(None, &[row("a", "12", &[json!("ca"), json!("False")])], "12")});
                return fake::Reply::events(&[modified.to_string()]);
            }
            match l.fetch_add(1, std::sync::atomic::Ordering::SeqCst) {
                0 => fake::Reply::json(table(Some(&o), &[row("a", "10", &[json!("True")])], "10").to_string()),
                _ => fake::Reply::json(table(Some(&new), &[row("a", "12", &[json!("ca"), json!("False")])], "12").to_string()),
            }
        });
        let layout = ServerColumns::from_definitions(old.as_array().unwrap()).unwrap().layout();
        let config = watcher::Config::default().any_semantic().timeout(55);
        let events: Vec<String> = watcher(widgets_api(client), config, layout).take(6).map(describe).collect().await;
        assert_eq!(events, ["init", r#"list a ["a","True","640d"]"#, "listed", "init", r#"list a ["a","False","640d"]"#, "listed"]);
    }
}
