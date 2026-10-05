//! Helm releases, read where Helm keeps them: Secrets of type `helm.sh/release.v1` labelled `owner=helm` (its default
//! storage). Listing releases, reading their values, manifest, notes and history, and comparing revisions need no
//! helm binary — and work across clusters like any table. Rollbacks and uninstalls run the user's own `helm` (hooks,
//! three-way merges and the release records are Helm's to do): refused in read-only mode, journalled.
//!
//! The list is polled every [`POLL`]: the metadata of the releases' current records only — the labels name the
//! release, its revision and status, a few hundred bytes each — and a release's record (gzipped JSON, often
//! hundreds of kilobytes with its chart) is fetched only when its current revision changed. It is sent as a
//! view's table would be (schema, statuses, rows), so the UI shows it like any resource. Under strict RBAC Secrets
//! are often not readable: a namespace that refuses (403) says so once, like a forbidden list in other views.

use std::collections::HashMap;
use std::io::Read;
use std::sync::Arc;
use std::time::Duration;

use base64::Engine as _;
use futures::StreamExt;
use k8s_openapi::api::core::v1::Secret;
use kube::Api;
use kube::api::ListParams;
use serde::Serialize;
use serde_json::Value;

use crate::cluster::{Cluster, is_auth_failure};
use crate::engine::Inner;
use crate::error::{Error, Result};
use crate::feed::FeedStatus;
use crate::object::ObjectRef;
use crate::ops;
use crate::render::{Cell, Column, ColumnKind as K, Row, Tone, col};
use crate::time;
use crate::view::{Sink, ViewSpec};
use crate::yaml;

/// The resource key the UI asks for releases with.
pub const RESOURCE: &str = "helmreleases";
/// How often the list is read.
const POLL: Duration = Duration::from_secs(10);
/// After a failure (network, server), the next read waits this long.
const RETRY: Duration = Duration::from_secs(20);
/// Records fetched at once (a cluster's releases on its first read).
const PARALLEL_FETCH: usize = 6;
/// A release's current records (older revisions are `superseded`).
const CURRENT: &str = "owner=helm,status!=superseded";
/// A `helm rollback` or `helm uninstall` (its hooks may take a while; Helm's own timeout is five minutes).
const HELM_TIMEOUT: Duration = Duration::from_secs(600);

/// What the table shows of a release: its latest revision.
#[derive(Debug, Clone, PartialEq)]
struct Summary {
    revision: i64,
    status: String,
    chart: String,
    app_version: String,
    updated: Option<i64>,
    first: Option<i64>,
    description: String,
}

fn columns() -> Vec<Column> {
    vec![
        col("revision", "Revision", K::Number).w(80),
        col("status", "Status", K::Status).w(130),
        col("chart", "Chart", K::Text).w(220),
        col("appVersion", "App Version", K::Text).w(120),
        col("updated", "Updated", K::Age).w(100),
        col("description", "Description", K::Text).w(280).hidden(),
    ]
}

fn tone(status: &str) -> Tone {
    match status {
        "deployed" => Tone::Ok,
        "failed" => Tone::Error,
        "superseded" | "uninstalled" => Tone::Muted,
        _ => Tone::Warn,
    }
}

fn row(namespace: &str, name: &str, s: &Summary) -> Row {
    let tone = tone(&s.status);
    Row {
        uid: Arc::from(format!("{namespace}/{name}")),
        name: name.to_string(),
        namespace: Some(namespace.to_string()),
        resource_version: s.revision.to_string(),
        created: s.first.unwrap_or_default(),
        tone,
        cells: vec![
            Cell::Int(s.revision),
            Cell::status(s.status.clone(), tone),
            Cell::opt_text(Some(&s.chart)),
            Cell::opt_text(Some(&s.app_version)),
            s.updated.map_or(Cell::Null, Cell::Int),
            Cell::opt_text(Some(&s.description)),
        ],
        labels: String::new(),
        terminating: s.status == "uninstalling",
    }
}

/// A release record's JSON: the Secret's `release` (base64 of gzipped JSON — uncompressed in old records).
pub(crate) fn decode(secret: &Secret) -> std::result::Result<Value, String> {
    let raw = secret.data.as_ref().and_then(|d| d.get("release")).ok_or("the record holds no release")?;
    let text = std::str::from_utf8(&raw.0).map_err(|_| "the record is not base64 text")?;
    let bytes = base64::engine::general_purpose::STANDARD.decode(text.trim()).map_err(|e| format!("the record is not base64: {e}"))?;
    let json = if bytes.starts_with(&[0x1f, 0x8b]) {
        let mut out = Vec::new();
        flate2::read::GzDecoder::new(&bytes[..]).read_to_end(&mut out).map_err(|e| format!("the record is not gzip: {e}"))?;
        out
    } else {
        bytes
    };
    serde_json::from_slice(&json).map_err(|e| format!("the record is not a release: {e}"))
}

fn summary(rel: &Value) -> Summary {
    let meta = &rel["chart"]["metadata"];
    let s = |v: &Value| v.as_str().unwrap_or_default().to_string();
    let ts = |v: &Value| v.as_str().and_then(time::unix_seconds);
    Summary {
        revision: rel["version"].as_i64().unwrap_or_default(),
        status: s(&rel["info"]["status"]),
        chart: format!("{}-{}", s(&meta["name"]), s(&meta["version"])),
        app_version: s(&meta["appVersion"]),
        updated: ts(&rel["info"]["last_deployed"]),
        first: ts(&rel["info"]["first_deployed"]),
        description: s(&rel["info"]["description"]),
    }
}

/// One cluster×namespace's releases as last read: the record each one's row comes from (its name and
/// resourceVersion: a change fetches it again) and its summary.
#[derive(Default)]
struct Scope {
    releases: HashMap<(String, String), (String, String, Summary)>,
}

/// Messages in a view's batch (see `view.rs`): the UI takes releases like any table.
fn batch(m: Vec<Value>) -> String {
    serde_json::json!({ "t": "batch", "m": m }).to_string()
}

fn status(cluster: &str, ns: Option<&str>, status: &FeedStatus) -> Value {
    let mut v = serde_json::to_value(status).unwrap_or_default();
    v["t"] = "status".into();
    v["c"] = cluster.into();
    v["ns"] = ns.into();
    v
}

/// Streams the releases of `spec`'s clusters and namespaces (empty: all) to `sink` as a view's table, until
/// cancelled: each cluster×namespace on its own (a slow or refusing one does not hold up the others).
pub(crate) async fn run(inner: Arc<Inner>, spec: ViewSpec, sink: Sink) {
    let cols = serde_json::json!({ "t": "schema", "columns": columns() });
    if !sink(batch(vec![cols])) {
        return;
    }
    let namespaces: Vec<Option<String>> = if spec.namespaces.is_empty() { vec![None] } else { spec.namespaces.iter().cloned().map(Some).collect() };
    let scopes = spec.clusters.iter().flat_map(|c| namespaces.iter().map(move |ns| (c.clone(), ns.clone())));
    let polls = scopes.map(|(c, ns)| poll_scope(inner.clone(), c, ns, sink.clone()));
    futures::future::join_all(polls).await;
}

/// Polls one cluster×namespace until the sink is gone, or the namespace refused (403).
async fn poll_scope(inner: Arc<Inner>, cluster: String, ns: Option<String>, sink: Sink) {
    let send = |m: Vec<Value>| sink(batch(m));
    if !send(vec![status(&cluster, ns.as_deref(), &FeedStatus::Connecting)]) {
        return;
    }
    let mut scope = Scope::default();
    let mut first = true;
    loop {
        let wait = match read(&inner, &cluster, ns.as_deref(), &mut scope).await {
            Ok((up, del)) => {
                let mut m = Vec::new();
                if first || !up.is_empty() || !del.is_empty() {
                    let up: Vec<Value> = up.iter().map(|r| serde_json::to_value(r).unwrap_or_default()).collect();
                    m.push(serde_json::json!({ "t": "rows", "c": cluster, "ns": ns, "reset": first, "up": up, "del": del }));
                }
                if first {
                    m.push(status(&cluster, ns.as_deref(), &FeedStatus::Ready));
                    first = false;
                }
                if !m.is_empty() && !send(m) {
                    return;
                }
                POLL
            }
            Err(e) => {
                let terminal = matches!(e.code(), Some(403 | 404));
                let st = FeedStatus::Error { message: e.message(), code: e.code(), reason: e.reason(), terminal };
                if !send(vec![status(&cluster, ns.as_deref(), &st)]) || terminal {
                    return;
                }
                if matches!(&e, Error::Kube(kube::Error::Api(s)) if s.code == 401) || matches!(&e, Error::Kube(k) if is_auth_failure(k)) {
                    inner.reauthenticate(&cluster).await;
                }
                RETRY
            }
        };
        tokio::time::sleep(wait).await;
    }
}

type Changes = (Vec<Row>, Vec<String>);

/// Reads the current records' metadata, fetches those that changed, and says which rows changed and which went.
async fn read(inner: &Arc<Inner>, cluster: &str, ns: Option<&str>, scope: &mut Scope) -> Result<Changes> {
    let c = ops::connected(inner, cluster, false).await?;
    let api: Api<Secret> = match ns {
        Some(ns) => Api::namespaced(c.client.clone(), ns),
        None => Api::all(c.client.clone()),
    };
    let list = tokio::time::timeout(ops::READ_TIMEOUT, api.list_metadata(&ListParams::default().labels(CURRENT)))
        .await
        .map_err(|_| Error::other(format!("no answer from the API server within {}s", ops::READ_TIMEOUT.as_secs())))??;
    // Each release's latest record (a failed upgrade leaves the deployed one too).
    let mut latest: HashMap<(String, String), (i64, String, String)> = HashMap::new();
    for m in list.items {
        let labels = m.metadata.labels.unwrap_or_default();
        let (Some(name), Some(namespace), Some(record)) = (labels.get("name").cloned(), m.metadata.namespace, m.metadata.name) else { continue };
        let revision = labels.get("version").and_then(|v| v.parse::<i64>().ok()).unwrap_or_default();
        let rv = m.metadata.resource_version.unwrap_or_default();
        let key = (namespace, name);
        if latest.get(&key).is_none_or(|(r, _, _)| revision > *r) {
            latest.insert(key, (revision, record, rv));
        }
    }
    let gone: Vec<String> = scope.releases.keys().filter(|k| !latest.contains_key(*k)).map(|(ns, name)| format!("{ns}/{name}")).collect();
    scope.releases.retain(|k, _| latest.contains_key(k));
    let stale: Vec<((String, String), String, String)> = latest
        .into_iter()
        .filter(|(k, (_, record, rv))| scope.releases.get(k).is_none_or(|(r, v, _)| r != record || v != rv))
        .map(|(k, (_, record, rv))| (k, record, rv))
        .collect();
    let fetched: Vec<_> = futures::stream::iter(stale)
        .map(|(key, record, rv)| {
            let api: Api<Secret> = Api::namespaced(c.client.clone(), &key.0);
            async move {
                let got = tokio::time::timeout(ops::READ_TIMEOUT, api.get(&record)).await;
                (key, record, rv, got)
            }
        })
        .buffer_unordered(PARALLEL_FETCH)
        .collect()
        .await;
    let mut up = Vec::new();
    for (key, record, rv, got) in fetched {
        let secret = match got {
            Ok(Ok(s)) => s,
            // Gone meanwhile (an upgrade superseded it): the next read finds the new one.
            Ok(Err(kube::Error::Api(s))) if s.code == 404 => continue,
            Ok(Err(e)) => return Err(e.into()),
            Err(_) => return Err(Error::other(format!("no answer from the API server within {}s", ops::READ_TIMEOUT.as_secs()))),
        };
        let s = match decode(&secret) {
            Ok(rel) => summary(&rel),
            Err(why) => {
                tracing::debug!(cluster, namespace = %key.0, release = %key.1, "unreadable helm record: {why}");
                Summary {
                    revision: 0,
                    status: "unreadable".into(),
                    chart: String::new(),
                    app_version: String::new(),
                    updated: None,
                    first: None,
                    description: why,
                }
            }
        };
        up.push(row(&key.0, &key.1, &s));
        scope.releases.insert(key, (record, rv, s));
    }
    Ok((up, gone))
}

// ---------------------------------------------------------------------------------------------
// Details
// ---------------------------------------------------------------------------------------------

/// One revision, as the history lists it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Revision {
    pub revision: i64,
    pub status: String,
    pub chart: String,
    pub app_version: String,
    pub updated: Option<i64>,
    pub description: String,
}

/// A release in full: its latest revision's values, manifest and notes, and every revision Helm keeps.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Release {
    pub name: String,
    pub namespace: String,
    pub revision: i64,
    pub status: String,
    pub chart: String,
    pub app_version: String,
    pub description: String,
    pub first_deployed: Option<i64>,
    pub last_deployed: Option<i64>,
    pub notes: String,
    /// The values given at install or upgrade (YAML).
    pub values: String,
    /// Those over the chart's defaults: what the templates were rendered with (YAML).
    pub computed: String,
    pub manifest: String,
    /// Newest first.
    pub history: Vec<Revision>,
}

/// Every record of a release, decoded, newest first.
async fn records(cluster: &Cluster, namespace: &str, name: &str) -> Result<Vec<Value>> {
    let api: Api<Secret> = Api::namespaced(cluster.client.clone(), namespace);
    let lp = ListParams::default().labels(&format!("owner=helm,name={name}"));
    let list = tokio::time::timeout(ops::READ_TIMEOUT, api.list(&lp))
        .await
        .map_err(|_| Error::other(format!("no answer from the API server within {}s", ops::READ_TIMEOUT.as_secs())))??;
    let mut out: Vec<Value> = list.items.iter().filter_map(|s| decode(s).ok()).collect();
    out.sort_by_key(|r| std::cmp::Reverse(r["version"].as_i64().unwrap_or_default()));
    if out.is_empty() {
        return Err(Error::other(format!("release \"{name}\" not found in namespace \"{namespace}\"")));
    }
    Ok(out)
}

pub(crate) async fn release(inner: &Arc<Inner>, cluster: &str, namespace: &str, name: &str) -> Result<Release> {
    let c = ops::connected(inner, cluster, false).await?;
    let all = records(&c, namespace, name).await?;
    let latest = &all[0];
    let s = summary(latest);
    let config = latest["config"].clone();
    let computed = coalesce(latest["chart"]["values"].clone(), config.clone());
    Ok(Release {
        name: name.to_string(),
        namespace: namespace.to_string(),
        revision: s.revision,
        status: s.status,
        chart: s.chart,
        app_version: s.app_version,
        description: s.description,
        first_deployed: s.first,
        last_deployed: s.updated,
        notes: latest["info"]["notes"].as_str().unwrap_or_default().to_string(),
        values: values_yaml(&config),
        computed: values_yaml(&computed),
        manifest: latest["manifest"].as_str().unwrap_or_default().to_string(),
        history: all
            .iter()
            .map(|r| {
                let s = summary(r);
                Revision { revision: s.revision, status: s.status, chart: s.chart, app_version: s.app_version, updated: s.updated, description: s.description }
            })
            .collect(),
    })
}

fn values_yaml(v: &Value) -> String {
    match v {
        Value::Object(m) if m.is_empty() => String::new(),
        Value::Null => String::new(),
        v => yaml::to_yaml(v),
    }
}

/// Values over defaults the way Helm coalesces them: maps merge key by key, anything else replaces, and a null
/// removes the default.
pub(crate) fn coalesce(defaults: Value, overrides: Value) -> Value {
    match (defaults, overrides) {
        (Value::Object(mut d), Value::Object(o)) => {
            for (k, v) in o {
                if v.is_null() {
                    d.remove(&k);
                    continue;
                }
                let merged = match d.remove(&k) {
                    Some(dv) => coalesce(dv, v),
                    None => v,
                };
                d.insert(k, merged);
            }
            Value::Object(d)
        }
        (d, Value::Null) => d,
        (_, o) => o,
    }
}

/// What changed between two revisions of a release: unified diffs of their values and manifests.
#[derive(Debug, Clone, Serialize)]
pub struct Diff {
    pub values: String,
    pub manifest: String,
}

pub(crate) async fn diff(inner: &Arc<Inner>, cluster: &str, namespace: &str, name: &str, from: i64, to: i64) -> Result<Diff> {
    let c = ops::connected(inner, cluster, false).await?;
    let all = records(&c, namespace, name).await?;
    let pick = |rev: i64| {
        all.iter().find(|r| r["version"].as_i64() == Some(rev)).ok_or_else(|| Error::other(format!("revision {rev} of \"{name}\" is not kept any more")))
    };
    let (a, b) = (pick(from)?, pick(to)?);
    let unified = |old: &str, new: &str| {
        similar::TextDiff::from_lines(old, new).unified_diff().context_radius(3).header(&format!("revision {from}"), &format!("revision {to}")).to_string()
    };
    Ok(Diff {
        values: unified(&values_yaml(&a["config"]), &values_yaml(&b["config"])),
        manifest: unified(a["manifest"].as_str().unwrap_or_default(), b["manifest"].as_str().unwrap_or_default()),
    })
}

// ---------------------------------------------------------------------------------------------
// Rollback and uninstall: the user's helm
// ---------------------------------------------------------------------------------------------

fn release_ref(cluster: &str, namespace: &str, name: &str) -> ObjectRef {
    ObjectRef { cluster: cluster.to_string(), resource: RESOURCE.into(), namespace: Some(namespace.to_string()), name: name.to_string(), uid: None }
}

/// `helm rollback NAME REVISION`.
pub(crate) async fn rollback(inner: &Arc<Inner>, cluster: &str, namespace: &str, name: &str, revision: i64) -> Result<String> {
    let params = format!("revision={revision}");
    let res = run_helm(inner, cluster, &["rollback", name, &revision.to_string(), "--namespace", namespace]).await;
    ops::audit(&release_ref(cluster, namespace, name), "helm rollback", &params, &res);
    res
}

/// `helm uninstall NAME`.
pub(crate) async fn uninstall(inner: &Arc<Inner>, cluster: &str, namespace: &str, name: &str) -> Result<String> {
    let res = run_helm(inner, cluster, &["uninstall", name, "--namespace", namespace]).await;
    ops::audit(&release_ref(cluster, namespace, name), "helm uninstall", "", &res);
    res
}

/// Runs the user's `helm` (found on the login shell's PATH) against `cluster`'s context of the kubeconfig in use:
/// read-only mode refuses it first. Its output, or what it said on failing.
async fn run_helm(inner: &Arc<Inner>, cluster: &str, args: &[&str]) -> Result<String> {
    inner.guard_write()?;
    let env = inner.env().await;
    let kc = inner.kubeconfig().await?;
    let path = env.var("PATH").unwrap_or_default();
    let helm = std::env::split_paths(&path)
        .map(|d| d.join(if cfg!(windows) { "helm.exe" } else { "helm" }))
        .find(|p| p.is_file())
        .ok_or_else(|| Error::other("helm is not installed (or not on PATH): rollback and uninstall run it"))?;
    let mut cmd = tokio::process::Command::new(&helm);
    cmd.args(args).args(["--kube-context", cluster]).env("PATH", &path).kill_on_drop(true).stdin(std::process::Stdio::null());
    let paths = kc.list().paths;
    if !paths.is_empty() {
        cmd.env("KUBECONFIG", std::env::join_paths(&paths).map_err(|e| Error::other(e.to_string()))?);
    }
    // Waiting may have taken a while (the login shell, the kubeconfig): read-only mode may be on by now.
    inner.guard_write()?;
    let out = tokio::time::timeout(HELM_TIMEOUT, cmd.output())
        .await
        .map_err(|_| Error::other(format!("helm did not finish within {}s; it may still be working", HELM_TIMEOUT.as_secs())))?
        .map_err(|e| Error::other(format!("{}: {e}", helm.display())))?;
    let text = |b: &[u8]| String::from_utf8_lossy(b).trim().to_string();
    if out.status.success() {
        Ok(text(&out.stdout))
    } else {
        let err = text(&out.stderr);
        Err(Error::other(if err.is_empty() { format!("helm failed ({})", out.status) } else { err.trim_start_matches("Error: ").to_string() }))
    }
}

/// The records of a release, by revision, for tests.
#[cfg(test)]
pub(crate) fn record_for_tests(rel: &Value, gzip: bool) -> Secret {
    use std::io::Write;
    let json = serde_json::to_vec(rel).unwrap();
    let bytes = if gzip {
        let mut e = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        e.write_all(&json).unwrap();
        e.finish().unwrap()
    } else {
        json
    };
    let b64 = base64::engine::general_purpose::STANDARD.encode(bytes);
    Secret { data: Some(std::collections::BTreeMap::from([("release".to_string(), k8s_openapi::ByteString(b64.into_bytes()))])), ..Default::default() }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn rel(version: i64, status: &str, chart_version: &str) -> Value {
        json!({
            "name": "web", "namespace": "shop", "version": version,
            "info": { "status": status, "first_deployed": "2026-09-01T10:00:00Z", "last_deployed": "2026-10-01T10:00:00Z", "description": "Upgrade complete", "notes": "Visit http://web" },
            "chart": { "metadata": { "name": "web", "version": chart_version, "appVersion": "2.4.1" }, "values": { "replicas": 1, "image": { "repository": "nginx", "tag": "1.27" }, "debug": false } },
            "config": { "replicas": 3, "image": { "tag": "1.28" }, "debug": null },
            "manifest": "---\nkind: Deployment\nreplicas: 3\n",
        })
    }

    #[test]
    fn records_decode_gzipped_or_not() {
        let r = rel(4, "deployed", "1.4.2");
        assert_eq!(decode(&record_for_tests(&r, true)).unwrap(), r);
        assert_eq!(decode(&record_for_tests(&r, false)).unwrap(), r);
        assert!(decode(&Secret::default()).unwrap_err().contains("no release"));
    }

    #[test]
    fn a_release_reads_as_a_row() {
        let s = summary(&rel(4, "failed", "1.4.2"));
        assert_eq!((s.revision, s.status.as_str(), s.chart.as_str(), s.app_version.as_str()), (4, "failed", "web-1.4.2", "2.4.1"));
        let r = row("shop", "web", &s);
        assert_eq!((&*r.uid, r.tone), ("shop/web", Tone::Error));
        assert_eq!(r.cells[0], Cell::Int(4));
        assert_eq!(r.cells[1], Cell::Status("failed".into(), Tone::Error));
    }

    use parking_lot::Mutex;

    /// A fake API server holding release records: metadata lists answer with each record's labels and
    /// resourceVersion, GETs with the record. `forbidden`: every list is refused.
    fn server(records: Arc<Mutex<Vec<(Value, String)>>>, gets: Arc<Mutex<Vec<String>>>, forbidden: bool) -> kube::Client {
        let svc = tower::service_fn(move |req: http::Request<kube::client::Body>| {
            let path = req.uri().path().to_string();
            let (status, body) = if forbidden {
                (403, r#"{"kind":"Status","apiVersion":"v1","status":"Failure","message":"secrets is forbidden","reason":"Forbidden","code":403}"#.to_string())
            } else if let Some(name) = path.strip_prefix("/api/v1/namespaces/shop/secrets/") {
                gets.lock().push(name.to_string());
                let recs = records.lock();
                let (rel, rv) = recs.iter().find(|(r, _)| format!("sh.helm.release.v1.{}.v{}", r["name"].as_str().unwrap(), r["version"]) == name).unwrap();
                let mut secret = serde_json::to_value(record_for_tests(rel, true)).unwrap();
                secret["metadata"] = json!({ "name": name, "namespace": "shop", "resourceVersion": rv });
                (200, secret.to_string())
            } else {
                let items: Vec<Value> = records
                    .lock()
                    .iter()
                    .map(|(r, rv)| {
                        let (name, version, status) = (r["name"].as_str().unwrap(), r["version"].clone(), r["info"]["status"].as_str().unwrap());
                        json!({ "kind": "PartialObjectMetadata", "apiVersion": "meta.k8s.io/v1", "metadata": {
                            "name": format!("sh.helm.release.v1.{name}.v{version}"), "namespace": "shop", "resourceVersion": rv,
                            "labels": { "owner": "helm", "name": name, "version": version.to_string(), "status": status } } })
                    })
                    .collect();
                (200, json!({ "kind": "PartialObjectMetadataList", "apiVersion": "meta.k8s.io/v1", "metadata": {}, "items": items }).to_string())
            };
            async move {
                Ok::<_, std::convert::Infallible>(
                    http::Response::builder()
                        .status(status)
                        .header("content-type", "application/json")
                        .body(kube::client::Body::from(body.into_bytes()))
                        .unwrap(),
                )
            }
        });
        kube::Client::new(svc, "default")
    }

    fn named(name: &str, version: i64, status: &str, chart_version: &str) -> Value {
        let mut r = rel(version, status, chart_version);
        r["name"] = json!(name);
        r
    }

    #[tokio::test]
    async fn releases_are_read_from_their_current_records_fetching_only_what_changed() {
        let inner = Inner::for_tests();
        let records =
            Arc::new(Mutex::new(vec![(named("web", 3, "deployed", "1.4.2"), "10".to_string()), (named("db", 1, "deployed", "0.9.0"), "11".to_string())]));
        let gets = Arc::new(Mutex::new(Vec::new()));
        inner.clusters.insert_ready_for_tests(Cluster::for_tests("prod-eu-z1", server(records.clone(), gets.clone(), false), vec![]));
        let mut scope = Scope::default();
        let (up, del) = read(&inner, "prod-eu-z1", Some("shop"), &mut scope).await.unwrap();
        let mut names: Vec<_> = up.iter().map(|r| (r.name.clone(), r.cells[2].clone())).collect();
        names.sort_by(|a, b| a.0.cmp(&b.0));
        assert_eq!(names, [("db".to_string(), Cell::Text("web-0.9.0".into())), ("web".to_string(), Cell::Text("web-1.4.2".into()))]);
        assert!(del.is_empty());
        assert_eq!(gets.lock().len(), 2);

        // Nothing changed: nothing fetched, nothing sent.
        let (up, del) = read(&inner, "prod-eu-z1", Some("shop"), &mut scope).await.unwrap();
        assert!(up.is_empty() && del.is_empty());
        assert_eq!(gets.lock().len(), 2);

        // web upgraded and failed (revision 4; the deployed 3 stays current too), db uninstalled.
        *records.lock() = vec![(named("web", 3, "deployed", "1.4.2"), "10".to_string()), (named("web", 4, "failed", "1.5.0"), "12".to_string())];
        let (up, del) = read(&inner, "prod-eu-z1", Some("shop"), &mut scope).await.unwrap();
        assert_eq!(up.iter().map(|r| (r.name.as_str(), r.cells[0].clone(), r.tone)).collect::<Vec<_>>(), [("web", Cell::Int(4), Tone::Error)]);
        assert_eq!(del, ["shop/db"]);
        assert_eq!(gets.lock().last().map(String::as_str), Some("sh.helm.release.v1.web.v4"));
    }

    #[tokio::test]
    async fn a_namespace_that_refuses_says_so_once_and_is_not_asked_again() {
        let inner = Inner::for_tests();
        inner.clusters.insert_ready_for_tests(Cluster::for_tests("prod-eu-z1", server(Arc::default(), Arc::default(), true), vec![]));
        let got = Arc::new(Mutex::new(Vec::<String>::new()));
        let g = got.clone();
        let sink: Sink = Arc::new(move |m: String| {
            g.lock().push(m);
            true
        });
        // The poll ends by itself: a 403 is final.
        tokio::time::timeout(Duration::from_secs(5), poll_scope(inner, "prod-eu-z1".into(), Some("shop".into()), sink)).await.unwrap();
        let msgs = got.lock().clone();
        assert_eq!(msgs.len(), 2);
        assert!(msgs[1].contains(r#""state":"error""#) && msgs[1].contains(r#""terminal":true"#) && msgs[1].contains("forbidden"), "{}", msgs[1]);
    }

    #[test]
    fn values_coalesce_like_helm() {
        let r = rel(1, "deployed", "1.0.0");
        let merged = coalesce(r["chart"]["values"].clone(), r["config"].clone());
        assert_eq!(merged, json!({ "replicas": 3, "image": { "repository": "nginx", "tag": "1.28" } }));
        assert_eq!(coalesce(json!({ "a": 1 }), Value::Null), json!({ "a": 1 }));
        assert_eq!(coalesce(json!({ "a": { "b": 1 } }), json!({ "a": "flat" })), json!({ "a": "flat" }));
    }
}
