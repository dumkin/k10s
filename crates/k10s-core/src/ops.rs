//! Object reads and mutating actions. Every mutation goes through [`Inner::guard_write`] so the
//! read-only switch is enforced in the engine, not just hidden in the UI: when it starts, and again right
//! before its request goes out (turning read-only mode on also stops what still waits for its connection
//! or its turn). Every one — refused and failed ones too — is written to the log as one `k10s::audit`
//! line (what, where, how it ended; never object data).
//!
//! Nothing waits forever: the cluster connection is awaited at most [`CONNECT_TIMEOUT`], each request
//! [`READ_TIMEOUT`] / [`WRITE_TIMEOUT`], and at most [`PARALLEL_PER_CLUSTER`] mutations of a cluster are in
//! flight at once — timed-out ones included, which also stop the rest from being sent (see [`Lane`]).
//! Mutations carry the uid of the object the user picked (a delete precondition, `metadata.uid` in
//! patches), so an object re-created under the same name in the meantime is left alone.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use futures::StreamExt;
use k8s_openapi::api::core::v1::Pod;
use kube::api::{DeleteParams, Patch, PatchParams, PostParams, Preconditions, PropagationPolicy};
use kube::core::DynamicObject;
use parking_lot::Mutex;
use serde::Serialize;
use serde_json::{Value, json};
use tokio::sync::{Notify, OwnedSemaphorePermit, Semaphore};

use crate::cluster::Cluster;
use crate::engine::Inner;
use crate::error::{Error, Result};
use crate::object::{Obj, ObjectRef};
use crate::term::NodeShellSpec;
use crate::time;
use crate::yaml;

const FIELD_MANAGER: &str = "k10s";

/// How long an action waits for its cluster's connection (an auth plugin waiting for a login, a slow
/// network). The connection attempt itself goes on.
pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(60);
/// A read (object, YAML) gets an answer within this long, or fails.
pub const READ_TIMEOUT: Duration = Duration::from_secs(30);
/// A mutating request gets an answer within this long, or is reported as possibly applied.
pub const WRITE_TIMEOUT: Duration = Duration::from_secs(45);
/// Mutations of one cluster in flight at once (bulk deletes, a burst of restarts…).
pub const PARALLEL_PER_CLUSTER: usize = 16;

/// What a mutation refused for a uid mismatch reports (see [`explain_recreated`]).
pub const RECREATED: &str = "the object was re-created since you selected it; nothing was changed";

fn patch_params() -> PatchParams {
    PatchParams { field_manager: Some(FIELD_MANAGER.into()), ..Default::default() }
}

/// Each cluster's mutations: see [`Lane`].
#[derive(Default)]
pub(crate) struct Slots(Mutex<HashMap<String, Arc<Lane>>>);

/// One cluster's mutations over one connection (a reconnect starts a new lane, with a fresh budget): at
/// most [`PARALLEL_PER_CLUSTER`] requests in flight.
///
/// A request that gets no answer in time is not dropped: that would not stop it (the connection sends
/// it on in the background) but only hide it, and it could still be carried out minutes later with
/// nothing counting it. It goes on with its slot until it ends, and the lane *stalls*: mutations waiting
/// for a slot, and new ones, fail at once without being sent. The next answer from the cluster (a late
/// one included), or the end of every request left waiting, lifts the stall.
pub(crate) struct Lane {
    /// The connection generation the lane belongs to.
    generation: Option<u64>,
    sem: Arc<Semaphore>,
    state: Mutex<LaneState>,
    /// Wakes those waiting for a slot when the lane stalls.
    stalled: Notify,
}

#[derive(Default)]
struct LaneState {
    /// Requests that timed out and still wait for their answer in the background, slots held.
    lingering: usize,
    stalled: bool,
}

impl Lane {
    fn new(generation: Option<u64>) -> Arc<Self> {
        Arc::new(Lane { generation, sem: Arc::new(Semaphore::new(PARALLEL_PER_CLUSTER)), state: Mutex::default(), stalled: Notify::new() })
    }

    fn is_stalled(&self) -> bool {
        self.state.lock().stalled
    }

    fn timed_out(&self) {
        {
            let mut s = self.state.lock();
            s.lingering += 1;
            s.stalled = true;
        }
        self.stalled.notify_waiters();
    }

    fn answered(&self) {
        self.state.lock().stalled = false;
    }

    /// A request left waiting ended; `answered`: with an answer from the API server.
    fn ended(&self, answered: bool) {
        let mut s = self.state.lock();
        s.lingering -= 1;
        if answered || s.lingering == 0 {
            s.stalled = false;
        }
    }
}

impl Slots {
    /// A slot for one mutation of `cluster`, waited for while the cluster answers; once its lane stalls,
    /// an error instead (nothing was sent).
    async fn acquire(&self, cluster: &str, generation: Option<u64>) -> Result<Slot> {
        let lane = {
            let mut lanes = self.0.lock();
            let lane = lanes.entry(cluster.to_string()).or_insert_with(|| Lane::new(generation));
            if lane.generation != generation {
                *lane = Lane::new(generation);
            }
            lane.clone()
        };
        loop {
            // Created before the check: a stall right after it still wakes this waiter.
            let woken = lane.stalled.notified();
            if lane.is_stalled() {
                return Err(not_sent(cluster));
            }
            let permit = tokio::select! {
                permit = lane.sem.clone().acquire_owned() => permit.expect("never closed"),
                () = woken => continue,
            };
            if lane.is_stalled() {
                return Err(not_sent(cluster));
            }
            return Ok(Slot { lane, permit: Some(permit) });
        }
    }
}

/// The right to send a mutation's requests (trigger reads, then creates) to its cluster.
pub(crate) struct Slot {
    lane: Arc<Lane>,
    permit: Option<OwnedSemaphorePermit>,
}

impl Slot {
    /// Sends `request`, answered within `limit` — or `None`: no answer in time. The request then goes on
    /// in the background with this slot, its lane stalled, and `late` gets its outcome when it ends.
    async fn send<T: Send + 'static>(
        &mut self,
        inner: &Inner,
        limit: Duration,
        request: impl Future<Output = kube::Result<T>> + Send + 'static,
        late: impl FnOnce(kube::Result<T>) + Send + 'static,
    ) -> Option<Result<T>> {
        let mut call = inner.rt.spawn(request);
        match tokio::time::timeout(limit, &mut call).await {
            Ok(joined) => {
                let res = joined.unwrap_or_else(|e| Err(kube::Error::Service(Box::new(e))));
                if is_answer(&res) {
                    self.lane.answered();
                }
                Some(res.map_err(Error::from))
            }
            Err(_) => {
                let (lane, permit) = (self.lane.clone(), self.permit.take());
                lane.timed_out();
                inner.rt.spawn(async move {
                    let res = call.await.unwrap_or_else(|e| Err(kube::Error::Service(Box::new(e))));
                    lane.ended(is_answer(&res));
                    drop(permit);
                    late(res);
                });
                None
            }
        }
    }
}

/// The API server answered (an error status is an answer too; a transport failure is not).
fn is_answer<T>(res: &kube::Result<T>) -> bool {
    matches!(res, Ok(_) | Err(kube::Error::Api(_)))
}

/// A slot for a mutation of `cluster` (see [`Slots::acquire`]).
async fn slot(inner: &Inner, cluster: &str) -> Result<Slot> {
    let generation = inner.clusters.state(cluster).map(|(g, _)| g);
    inner.op_slots.acquire(cluster, generation).await
}

fn not_sent(cluster: &str) -> Error {
    Error::other(format!(
        "not sent: cluster \"{cluster}\" stopped answering (an earlier request got no answer in time and is still pending); nothing was changed"
    ))
}

/// The connected cluster, waited for at most [`CONNECT_TIMEOUT`].
pub(crate) async fn connected(inner: &Arc<Inner>, context: &str, write: bool) -> Result<Arc<Cluster>> {
    match tokio::time::timeout(CONNECT_TIMEOUT, inner.connect(context, false)).await {
        Ok(res) => res,
        Err(_) => Err(Error::Connect {
            context: context.to_string(),
            message: format!(
                "not connected within {}s (an auth plugin waiting for a login, or network trouble){}",
                CONNECT_TIMEOUT.as_secs(),
                if write { "; nothing was changed" } else { "" }
            ),
            code: None,
        }),
    }
}

/// `request`'s outcome, or `None` when it took longer than `limit`.
async fn within<T>(limit: Duration, request: impl Future<Output = kube::Result<T>>) -> Option<Result<T>> {
    tokio::time::timeout(limit, request).await.ok().map(|r| r.map_err(Error::from))
}

fn read_timed_out() -> Error {
    Error::other(format!("no answer from the API server within {}s", READ_TIMEOUT.as_secs()))
}

/// A mutating request that went unanswered may still be carried out: say so.
fn write_timed_out() -> Error {
    Error::other(format!(
        "no answer from the API server within {}s: the change may still have been made (the request is still pending; the log will say how it ended), check the object",
        WRITE_TIMEOUT.as_secs()
    ))
}

/// The uid of the object the user picked, if it is a real one: rows of objects without a uid carry a
/// synthetic `namespace/name` (see `feed.rs`), which must never become a precondition.
fn picked_uid(r: &ObjectRef) -> Option<&str> {
    r.uid.as_deref().filter(|u| !u.is_empty() && !u.contains('/'))
}

/// A failed uid precondition said in plain words. Deletes get `409 Precondition failed: UID in
/// precondition: …`; a merge patch whose `metadata.uid` differs is rejected either the same way or as a
/// change of an immutable field (`422 … metadata.uid: … field is immutable`), depending on the server.
fn explain_recreated(e: Error) -> Error {
    match e {
        Error::Kube(kube::Error::Api(mut s)) if is_uid_mismatch(&s) => {
            s.message = RECREATED.into();
            Error::Kube(kube::Error::Api(s))
        }
        other => other,
    }
}

fn is_uid_mismatch(s: &kube::core::Status) -> bool {
    (s.code == 409 && s.message.contains("UID in precondition")) || (s.code == 422 && s.message.contains("metadata.uid") && s.message.contains("immutable"))
}

fn recreated() -> Error {
    Error::Kube(kube::Error::Api(Box::new(kube::core::Status { code: 409, reason: "Conflict".into(), message: RECREATED.into(), ..Default::default() })))
}

/// The journal: one `k10s::audit` line per mutation and target, whatever the outcome. `params` are the
/// action's own arguments (replicas, force…), never object data.
pub(crate) fn audit<T>(r: &ObjectRef, action: &str, params: &str, res: &Result<T>) {
    journal(r, action, params, res, false);
}

/// `late`: the outcome of a request that had timed out (the user was told it may still be carried out).
fn journal<T>(r: &ObjectRef, action: &str, params: &str, res: &Result<T>, late: bool) {
    let (cluster, resource, name) = (r.cluster.as_str(), r.resource.as_str(), r.name.as_str());
    let namespace = r.namespace.as_deref().unwrap_or("");
    let uid = r.uid.as_deref().unwrap_or("");
    match res {
        Ok(_) => {
            tracing::info!(target: "k10s::audit", cluster, resource, namespace, name, uid, action, params, result = if late { "ok after timing out" } else { "ok" }, "mutation")
        }
        Err(Error::ReadOnly) => {
            tracing::info!(target: "k10s::audit", cluster, resource, namespace, name, uid, action, params, result = "refused", error = "read-only mode", "mutation")
        }
        Err(e) => {
            let result = match (late, matches!(e, Error::Kube(kube::Error::Api(_)))) {
                (false, _) => "failed",
                (true, true) => "failed after timing out",
                // No answer at all (the connection broke, a read timed out): it may have been carried out or not.
                (true, false) => "unknown after timing out",
            };
            // The error text comes from the cluster (an admission webhook's message may span lines): quoted and
            // escaped (`?`), it can neither split the line nor pass for another field.
            tracing::warn!(target: "k10s::audit", cluster, resource, namespace, name, uid, action, params, result, code = e.code(), error = ?e.message(), "mutation")
        }
    }
}

/// Journals how a mutating request that timed out ended (see [`Slot::send`]).
fn journal_late<T>(r: &ObjectRef, action: &str, params: &str) -> impl FnOnce(kube::Result<T>) + Send + 'static {
    let (r, action, params) = (r.clone(), action.to_string(), params.to_string());
    move |res| journal(&r, &action, &params, &res.map(drop).map_err(|e| explain_recreated(Error::from(e))), true)
}

/// Object JSON (managedFields stripped): served from a live feed when possible, else fetched — by a GET, or
/// where that is forbidden, by a list (see [`listed`]).
pub(crate) async fn get_object(inner: &Arc<Inner>, r: &ObjectRef) -> Result<Arc<str>> {
    let cluster = connected(inner, &r.cluster, false).await?;
    let info = cluster.resolve(&r.resource)?;
    if let Some(json) = inner.hub.find_object(&r.cluster, &info.key, r.namespace.as_deref(), &r.name, r.uid.as_deref()) {
        return Ok(json);
    }
    match within(READ_TIMEOUT, cluster.api(&info, r.namespace.as_deref()).get(&r.name)).await.unwrap_or_else(|| Err(read_timed_out())) {
        Ok(mut obj) => {
            obj.ensure_type_meta(&info.api_resource());
            Ok(serde_json::to_string(&obj.raw).map_err(|e| Error::other(e.to_string()))?.into())
        }
        Err(e) if e.code() == Some(403) => listed(inner, r, &info.key, false, e).await,
        Err(e) => Err(e),
    }
}

/// A GET of `r` was `denied` (403): strict RBAC may grant `list` and `watch` but not `get`. Big feeds keep rows
/// only (their objects' JSON is fetched when asked for), so details would not open there at all: the object
/// comes from a list of one instead, as the feed showing it lists it (see [`WatchHub::list_object`]). Without
/// such a feed, or if that list fails too, the GET's error stands.
///
/// [`WatchHub::list_object`]: crate::feed::WatchHub::list_object
async fn listed(inner: &Arc<Inner>, r: &ObjectRef, resource: &str, managed_fields: bool, denied: Error) -> Result<Arc<str>> {
    let lookup = inner.hub.list_object(&r.cluster, resource, r.namespace.as_deref(), &r.name, managed_fields);
    match tokio::time::timeout(READ_TIMEOUT, lookup).await {
        Ok(Some(Ok(json))) => Ok(json),
        Ok(Some(Err(e))) => {
            tracing::debug!(cluster = %r.cluster, resource, namespace = ?r.namespace, name = %r.name, "get forbidden, list of one failed too: {}", Error::from(e).message());
            Err(denied)
        }
        Ok(None) => Err(denied),
        Err(_) => Err(read_timed_out()),
    }
}

/// The object as YAML. A core Secret's values are hidden unless `reveal` (see [`mask_secret`]).
pub(crate) async fn get_yaml(inner: &Arc<Inner>, r: &ObjectRef, managed_fields: bool, reveal: bool) -> Result<String> {
    let mut v = if managed_fields {
        let cluster = connected(inner, &r.cluster, false).await?;
        let info = cluster.resolve(&r.resource)?;
        let ar = info.api_resource();
        let api: kube::Api<DynamicObject> = match r.namespace.as_deref().filter(|_| info.namespaced) {
            Some(ns) => kube::Api::namespaced_with(cluster.client.clone(), ns, &ar),
            None => kube::Api::all_with(cluster.client.clone(), &ar),
        };
        match within(READ_TIMEOUT, api.get(&r.name)).await.unwrap_or_else(|| Err(read_timed_out())) {
            Ok(mut obj) => {
                if obj.types.is_none() {
                    obj.types = Some(kube::core::TypeMeta { api_version: ar.api_version.clone(), kind: ar.kind.clone() });
                }
                serde_json::to_value(&obj).map_err(|e| Error::other(e.to_string()))?
            }
            Err(e) if e.code() == Some(403) => {
                let json = listed(inner, r, &info.key, true, e).await?;
                serde_json::from_str(&json).map_err(|e| Error::other(e.to_string()))?
            }
            Err(e) => return Err(e),
        }
    } else {
        let json = get_object(inner, r).await?;
        serde_json::from_str(&json).map_err(|e| Error::other(e.to_string()))?
    };
    if !reveal && is_secret(&v) {
        mask_secret(&mut v);
    }
    Ok(yaml::to_yaml(&v))
}

const LAST_APPLIED: &str = "kubectl.kubernetes.io/last-applied-configuration";

fn is_secret(v: &Value) -> bool {
    v.get("kind").and_then(Value::as_str) == Some("Secret") && v.get("apiVersion").and_then(Value::as_str) == Some("v1")
}

fn hidden(bytes: usize) -> Value {
    Value::String(format!("<hidden: {bytes} byte{}>", if bytes == 1 { "" } else { "s" }))
}

/// Decoded length of a base64 value (what `data` holds).
fn base64_len(s: &str) -> usize {
    let s = s.trim_end();
    let padding = s.bytes().rev().take_while(|&b| b == b'=').count().min(2);
    (s.len() / 4 * 3 + (s.len() % 4) * 3 / 4).saturating_sub(padding)
}

/// Replaces a Secret's values — `data` (base64) and `stringData` (plain), also inside the
/// `last-applied-configuration` annotation `kubectl apply` leaves — by their sizes. Keys stay.
pub fn mask_secret(v: &mut Value) {
    fn values(obj: &mut Value) {
        if let Some(data) = obj.get_mut("data").and_then(Value::as_object_mut) {
            for val in data.values_mut() {
                *val = hidden(val.as_str().map_or(0, base64_len));
            }
        }
        if let Some(data) = obj.get_mut("stringData").and_then(Value::as_object_mut) {
            for val in data.values_mut() {
                *val = hidden(val.as_str().map_or(0, str::len));
            }
        }
    }
    values(v);
    if let Some(applied) = v.pointer_mut("/metadata/annotations").and_then(Value::as_object_mut).and_then(|a| a.get_mut(LAST_APPLIED)) {
        let text = applied.as_str().unwrap_or_default().to_string();
        *applied = match serde_json::from_str::<Value>(&text) {
            Ok(mut last) if last.is_object() => {
                values(&mut last);
                let mut s = serde_json::to_string(&last).unwrap_or_default();
                // kubectl writes it with a trailing newline.
                if text.ends_with('\n') {
                    s.push('\n');
                }
                Value::String(s)
            }
            // Not the JSON kubectl writes: nothing in it can be told apart from a value.
            _ => hidden(text.len()),
        };
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpResult {
    pub target: ObjectRef,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<Error>,
}

/// Deletes `targets`, at most [`PARALLEL_PER_CLUSTER`] at a time per cluster, each cluster on its own so
/// a slow one does not hold up the others. Once a request to a cluster times out, its targets not yet
/// sent fail right away instead of waiting their turn to time out too (see [`Lane`]). Results are in
/// `targets` order.
pub(crate) async fn delete(inner: &Arc<Inner>, targets: Vec<ObjectRef>, force: bool) -> Result<Vec<OpResult>> {
    let params = if force { "force=true grace=0" } else { "force=false" };
    if let Err(e) = inner.guard_write() {
        for t in &targets {
            audit(t, "delete", params, &Err::<(), _>(Error::ReadOnly));
        }
        return Err(e);
    }
    let mut lanes: Vec<(&str, Vec<usize>)> = Vec::new();
    for (i, t) in targets.iter().enumerate() {
        match lanes.iter_mut().find(|(c, _)| *c == t.cluster) {
            Some((_, idx)) => idx.push(i),
            None => lanes.push((&t.cluster, vec![i])),
        }
    }
    let targets = &targets;
    let lanes = lanes.into_iter().map(|(_, idx)| async move {
        futures::stream::iter(idx)
            .map(|i| async move {
                let res = delete_one(inner, &targets[i], force, params).await;
                audit(&targets[i], "delete", params, &res);
                (i, res)
            })
            .buffer_unordered(PARALLEL_PER_CLUSTER)
            .collect::<Vec<_>>()
            .await
    });
    let mut results: Vec<(usize, Result<()>)> = futures::future::join_all(lanes).await.into_iter().flatten().collect();
    results.sort_by_key(|(i, _)| *i);
    Ok(results.into_iter().map(|(i, res)| OpResult { target: targets[i].clone(), ok: res.is_ok(), error: res.err() }).collect())
}

async fn delete_one(inner: &Arc<Inner>, target: &ObjectRef, force: bool, params: &str) -> Result<()> {
    let cluster = connected(inner, &target.cluster, true).await?;
    let info = cluster.resolve(&target.resource)?;
    let mut slot = slot(inner, &target.cluster).await?;
    let dp = DeleteParams {
        grace_period_seconds: force.then_some(0),
        propagation_policy: Some(PropagationPolicy::Background),
        preconditions: picked_uid(target).map(|uid| Preconditions { uid: Some(uid.to_string()), resource_version: None }),
        ..Default::default()
    };
    // Waiting for the connection and the slot may have taken a while: read-only mode may be on by now.
    inner.guard_write()?;
    let (api, name) = (cluster.api(&info, target.namespace.as_deref()), target.name.clone());
    match slot.send(inner, WRITE_TIMEOUT, async move { api.delete(&name, &dp).await }, journal_late(target, "delete", params)).await {
        Some(res) => res.map(drop).map_err(explain_recreated),
        None => Err(write_timed_out()),
    }
}

/// A JSON merge patch, refused by the API server if the object is not the one the user picked.
async fn merge_patch(inner: &Arc<Inner>, r: &ObjectRef, action: &str, params: &str, mut patch: Value) -> Result<()> {
    let res = async {
        inner.guard_write()?;
        let cluster = connected(inner, &r.cluster, true).await?;
        let info = cluster.resolve(&r.resource)?;
        if let Some(uid) = picked_uid(r) {
            patch["metadata"]["uid"] = json!(uid);
        }
        let mut slot = slot(inner, &r.cluster).await?;
        inner.guard_write()?;
        let (api, name) = (cluster.api(&info, r.namespace.as_deref()), r.name.clone());
        let request = async move {
            let pp = patch_params();
            api.patch(&name, &pp, &Patch::Merge(&patch)).await
        };
        match slot.send(inner, WRITE_TIMEOUT, request, journal_late(r, action, params)).await {
            Some(res) => res.map(drop).map_err(explain_recreated),
            None => Err(write_timed_out()),
        }
    }
    .await;
    audit(r, action, params, &res);
    res
}

pub(crate) async fn scale(inner: &Arc<Inner>, r: &ObjectRef, replicas: i32) -> Result<()> {
    merge_patch(inner, r, "scale", &format!("replicas={replicas}"), json!({ "spec": { "replicas": replicas } })).await
}

/// `kubectl rollout restart`: bumps the pod template's `restartedAt` annotation.
pub(crate) async fn restart(inner: &Arc<Inner>, r: &ObjectRef) -> Result<()> {
    let now = time::now_rfc3339();
    let patch = json!({ "spec": { "template": { "metadata": { "annotations": { "kubectl.kubernetes.io/restartedAt": now } } } } });
    merge_patch(inner, r, "restart", &format!("restartedAt={now}"), patch).await
}

pub(crate) async fn set_unschedulable(inner: &Arc<Inner>, r: &ObjectRef, unschedulable: bool) -> Result<()> {
    let action = if unschedulable { "cordon" } else { "uncordon" };
    merge_patch(inner, r, action, &format!("unschedulable={unschedulable}"), json!({ "spec": { "unschedulable": unschedulable } })).await
}

pub(crate) async fn set_suspend(inner: &Arc<Inner>, r: &ObjectRef, suspend: bool) -> Result<()> {
    let action = if suspend { "suspend" } else { "resume" };
    merge_patch(inner, r, action, &format!("suspend={suspend}"), json!({ "spec": { "suspend": suspend } })).await
}

/// `kubectl create job --from=cronjob/NAME`. Returns the new Job's name.
pub(crate) async fn trigger_cronjob(inner: &Arc<Inner>, r: &ObjectRef) -> Result<String> {
    let suffix = format!("{:x}", (time::now_unix() as u64).wrapping_mul(2_654_435_761) & 0xfffff);
    let base: String = r.name.chars().take(63 - suffix.len() - 8).collect();
    let name = format!("{base}-manual-{suffix}");
    let params = format!("job={name}");
    let res = create_job_from(inner, r, &name, &params).await;
    audit(r, "trigger", &params, &res);
    res.map(|()| name)
}

async fn create_job_from(inner: &Arc<Inner>, r: &ObjectRef, name: &str, params: &str) -> Result<()> {
    inner.guard_write()?;
    let cluster = connected(inner, &r.cluster, true).await?;
    let cj_info = cluster.resolve(&r.resource)?;
    let jobs = cluster.resolve("jobs.batch")?;
    let mut slot = slot(inner, &r.cluster).await?;
    let (api, cj_name) = (cluster.api(&cj_info, r.namespace.as_deref()), r.name.clone());
    let cj: Obj = slot
        .send(inner, READ_TIMEOUT, async move { api.get(&cj_name).await }, drop)
        .await
        .unwrap_or_else(|| Err(Error::other(format!("no answer from the API server within {}s; nothing was changed", READ_TIMEOUT.as_secs()))))?;
    if picked_uid(r).is_some_and(|uid| uid != cj.uid()) {
        return Err(recreated());
    }
    let template = cj.raw.pointer("/spec/jobTemplate").cloned().unwrap_or(Value::Null);
    let mut annotations = template.pointer("/metadata/annotations").cloned().unwrap_or_else(|| json!({}));
    annotations["cronjob.kubernetes.io/instantiate"] = json!("manual");
    let job = json!({
        "apiVersion": "batch/v1",
        "kind": "Job",
        "metadata": {
            "name": name,
            "namespace": cj.namespace(),
            "labels": template.pointer("/metadata/labels").cloned().unwrap_or_else(|| json!({})),
            "annotations": annotations,
            "ownerReferences": [{
                "apiVersion": cj_info.api_version(),
                "kind": "CronJob",
                "name": cj.name(),
                "uid": cj.uid(),
                "controller": true,
                "blockOwnerDeletion": true,
            }],
        },
        "spec": template.pointer("/spec").cloned().unwrap_or_else(|| json!({})),
    });
    inner.guard_write()?;
    let (api, job) = (cluster.api(&jobs, r.namespace.as_deref()), Obj::from_value(job, true));
    let request = async move {
        let pp = PostParams { field_manager: Some(FIELD_MANAGER.into()), ..Default::default() };
        api.create(&pp, &job).await
    };
    slot.send(inner, WRITE_TIMEOUT, request, journal_late(r, "trigger", params)).await.unwrap_or_else(|| Err(write_timed_out()))?;
    Ok(())
}

/// Five characters of the alphabet the API server's `generateName` uses: names that only need to differ from
/// the pod's other containers.
fn name_suffix() -> String {
    const ALPHABET: &[u8] = b"bcdfghjklmnpqrstvwxz2456789";
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_nanos() as u64);
    let mut x = nanos.wrapping_mul(0x9E37_79B9_7F4A_7C15);
    (0..5)
        .map(|_| {
            let c = ALPHABET[(x % ALPHABET.len() as u64) as usize] as char;
            x /= ALPHABET.len() as u64;
            c
        })
        .collect()
}

/// `kubectl debug -it --image IMAGE [--target CONTAINER]`: adds an ephemeral container with a terminal of its own
/// to the pod picked (its uid in the patch: a pod re-created since is left alone), to attach to once it runs.
/// Kubernetes cannot remove it again: it stays until the pod goes. Returns its name.
pub(crate) async fn add_debug_container(inner: &Arc<Inner>, r: &ObjectRef, image: &str, target: Option<&str>) -> Result<String> {
    let name = format!("debugger-{}", name_suffix());
    let params = match target {
        Some(t) => format!("container={name} image={image} target={t}"),
        None => format!("container={name} image={image}"),
    };
    let res = async {
        inner.guard_write()?;
        let cluster = connected(inner, &r.cluster, true).await?;
        let mut container = json!({ "name": name, "image": image, "stdin": true, "tty": true, "terminationMessagePolicy": "File" });
        if let Some(t) = target {
            container["targetContainerName"] = json!(t);
        }
        let mut patch = json!({ "spec": { "ephemeralContainers": [container] } });
        if let Some(uid) = picked_uid(r) {
            patch["metadata"] = json!({ "uid": uid });
        }
        let mut slot = slot(inner, &r.cluster).await?;
        inner.guard_write()?;
        let api: kube::Api<Pod> = kube::Api::namespaced(cluster.client.clone(), r.namespace.as_deref().unwrap_or_default());
        let pod = r.name.clone();
        let request = async move { api.patch_ephemeral_containers(&pod, &patch_params(), &Patch::Strategic(patch)).await };
        match slot.send(inner, WRITE_TIMEOUT, request, journal_late(r, "debug", &params)).await {
            Some(res) => res.map(drop).map_err(explain_recreated),
            None => Err(write_timed_out()),
        }
    }
    .await;
    audit(r, "debug", &params, &res);
    res.map(|()| name)
}

/// Creates a node shell's helper pod (`pod`, see `term::node_shell_pod`), journalled against the node. Returns
/// the pod with the uid it got: its deletion is bound to it (see [`remove_helper_pod`]).
pub(crate) async fn create_node_shell_pod(inner: &Arc<Inner>, spec: &NodeShellSpec, pod: Value) -> Result<ObjectRef> {
    let node = ObjectRef { cluster: spec.cluster.clone(), resource: "nodes".into(), namespace: None, name: spec.node.clone(), uid: None };
    let params = format!("namespace={} image={}", spec.namespace, spec.image);
    let res = async {
        inner.guard_write()?;
        let pod: Pod = serde_json::from_value(pod).map_err(|e| Error::other(e.to_string()))?;
        let cluster = connected(inner, &spec.cluster, true).await?;
        let mut slot = slot(inner, &spec.cluster).await?;
        inner.guard_write()?;
        let api: kube::Api<Pod> = kube::Api::namespaced(cluster.client.clone(), &spec.namespace);
        let request = async move {
            let pp = PostParams { field_manager: Some(FIELD_MANAGER.into()), ..Default::default() };
            api.create(&pp, &pod).await
        };
        slot.send(inner, WRITE_TIMEOUT, request, journal_late(&node, "node-shell", &params)).await.unwrap_or_else(|| Err(write_timed_out()))
    }
    .await;
    let res = res.map(|created| ObjectRef {
        cluster: spec.cluster.clone(),
        resource: "pods".into(),
        namespace: Some(spec.namespace.clone()),
        name: created.metadata.name.unwrap_or_default(),
        uid: created.metadata.uid,
    });
    let journalled = match &res {
        Ok(p) => format!("{params} pod={}", p.name),
        Err(_) => params,
    };
    audit(&node, "node-shell", &journalled, &res);
    res
}

/// Deletes a helper pod k10s created for a session (a node shell's) once the session ended — also in read-only
/// mode: k10s made it for that session alone, and a privileged pod in a node's namespaces must not outlive it.
/// Bound to the pod's uid; one already gone is fine.
pub(crate) async fn remove_helper_pod(inner: &Arc<Inner>, pod: &ObjectRef) {
    let res = async {
        let cluster = connected(inner, &pod.cluster, true).await?;
        let api: kube::Api<Pod> = kube::Api::namespaced(cluster.client.clone(), pod.namespace.as_deref().unwrap_or_default());
        let dp = DeleteParams {
            grace_period_seconds: Some(0),
            preconditions: picked_uid(pod).map(|uid| Preconditions { uid: Some(uid.to_string()), resource_version: None }),
            ..Default::default()
        };
        match within(WRITE_TIMEOUT, api.delete(&pod.name, &dp)).await {
            Some(Err(e)) if e.code() == Some(404) => Ok(()),
            Some(res) => res.map(drop),
            None => Err(write_timed_out()),
        }
    }
    .await;
    audit(pod, "node-shell cleanup", "", &res);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::discovery::ResourceInfo;
    use std::collections::BTreeMap;
    use std::sync::atomic::{AtomicUsize, Ordering};

    type Reply = Option<(u16, String)>;

    /// Requests the fake API server got: method, path and query, body.
    #[derive(Default)]
    struct Seen(Mutex<Vec<(String, String, String)>>);

    impl Seen {
        fn bodies(&self, method: &str) -> Vec<(String, Value)> {
            self.0.lock().iter().filter(|(m, ..)| m == method).map(|(_, uri, body)| (uri.clone(), serde_json::from_str(body).unwrap_or(Value::Null))).collect()
        }
    }

    /// A fake API server: `reply(method, uri, body)` is the status and JSON to answer with, `None` never answers.
    fn server(seen: Arc<Seen>, reply: impl Fn(&str, &str, &str) -> Reply + Send + Sync + 'static) -> kube::Client {
        let reply = Arc::new(reply);
        let svc = tower::service_fn(move |req: http::Request<kube::client::Body>| {
            let (seen, reply) = (seen.clone(), reply.clone());
            async move {
                let (method, uri) = (req.method().to_string(), req.uri().to_string());
                let body = String::from_utf8(req.into_body().collect_bytes().await.unwrap().to_vec()).unwrap();
                seen.0.lock().push((method.clone(), uri.clone(), body.clone()));
                let Some((status, json)) = reply(&method, &uri, &body) else {
                    return futures::future::pending::<Result<http::Response<kube::client::Body>, std::convert::Infallible>>().await;
                };
                Ok(http::Response::builder()
                    .status(status)
                    .header("content-type", "application/json")
                    .body(kube::client::Body::from(json.into_bytes()))
                    .unwrap())
            }
        });
        kube::Client::new(svc, "default")
    }

    fn status(code: u16, reason: &str, message: &str) -> Reply {
        Some((code, json!({ "kind": "Status", "apiVersion": "v1", "status": "Failure", "code": code, "reason": reason, "message": message }).to_string()))
    }

    fn object(kind: &str, name: &str, uid: &str) -> Reply {
        Some((200, json!({ "apiVersion": "v1", "kind": kind, "metadata": { "name": name, "namespace": "shop", "uid": uid } }).to_string()))
    }

    fn res(group: &str, version: &str, kind: &str, plural: &str) -> ResourceInfo {
        ResourceInfo {
            key: ResourceInfo::key_for(group, plural),
            group: group.into(),
            version: version.into(),
            kind: kind.into(),
            plural: plural.into(),
            singular: kind.to_lowercase(),
            namespaced: true,
            verbs: ["get", "list", "watch", "patch", "delete", "create"].map(String::from).to_vec(),
            short_names: Vec::new(),
            categories: Vec::new(),
            subresources: Vec::new(),
        }
    }

    fn engine_with(clusters: Vec<(&str, kube::Client)>) -> Arc<Inner> {
        let inner = Inner::for_tests();
        for (name, client) in clusters {
            let resources = vec![
                res("", "v1", "Pod", "pods"),
                res("", "v1", "Secret", "secrets"),
                res("apps", "v1", "Deployment", "deployments"),
                res("batch", "v1", "CronJob", "cronjobs"),
                res("batch", "v1", "Job", "jobs"),
            ];
            inner.clusters.insert_ready_for_tests(Cluster::for_tests(name, client, resources));
        }
        inner
    }

    fn target(cluster: &str, resource: &str, name: &str, uid: Option<&str>) -> ObjectRef {
        ObjectRef { cluster: cluster.into(), resource: resource.into(), namespace: Some("shop".into()), name: name.into(), uid: uid.map(String::from) }
    }

    /// The `k10s::audit` lines written on this thread while it lives: their fields, by name.
    #[derive(Clone, Default)]
    struct Journal(Arc<Mutex<Vec<BTreeMap<String, String>>>>);

    struct Fields<'a>(&'a mut BTreeMap<String, String>);

    impl tracing::field::Visit for Fields<'_> {
        fn record_str(&mut self, field: &tracing::field::Field, value: &str) {
            self.0.insert(field.name().into(), value.into());
        }
        fn record_debug(&mut self, field: &tracing::field::Field, value: &dyn std::fmt::Debug) {
            self.0.insert(field.name().into(), format!("{value:?}"));
        }
    }

    impl tracing::Subscriber for Journal {
        fn enabled(&self, m: &tracing::Metadata<'_>) -> bool {
            m.target() == "k10s::audit"
        }
        fn new_span(&self, _: &tracing::span::Attributes<'_>) -> tracing::span::Id {
            tracing::span::Id::from_u64(1)
        }
        fn record(&self, _: &tracing::span::Id, _: &tracing::span::Record<'_>) {}
        fn record_follows_from(&self, _: &tracing::span::Id, _: &tracing::span::Id) {}
        fn event(&self, e: &tracing::Event<'_>) {
            let mut fields = BTreeMap::from([("level".to_string(), e.metadata().level().to_string())]);
            e.record(&mut Fields(&mut fields));
            self.0.lock().push(fields);
        }
        fn enter(&self, _: &tracing::span::Id) {}
        fn exit(&self, _: &tracing::span::Id) {}
    }

    impl Journal {
        /// Collects the `k10s::audit` lines written on this thread until the guard drops.
        fn install() -> (Journal, tracing::subscriber::DefaultGuard) {
            // tracing works out once per call site, when a thread first writes there, whether anyone wants its
            // lines, and caches that for every thread. It asks every live subscriber — except while there is
            // just one: then the writing thread's default. With this journal the only one, a line another test
            // wrote first (on a thread without a journal) would be cached as unwanted, and this journal would
            // miss it. Another subscriber kept for the whole run keeps tracing asking them all.
            static KEPT: std::sync::OnceLock<tracing::Dispatch> = std::sync::OnceLock::new();
            KEPT.get_or_init(|| tracing::Dispatch::new(Journal::default()));
            let journal = Journal::default();
            let log = tracing::subscriber::set_default(journal.clone());
            (journal, log)
        }

        fn lines(&self) -> Vec<BTreeMap<String, String>> {
            self.0.lock().clone()
        }
    }

    #[tokio::test]
    async fn deletes_send_the_picked_uid_as_a_precondition_and_explain_a_recreated_object() {
        let (journal, _log) = Journal::install();
        let seen = Arc::new(Seen::default());
        let inner = engine_with(vec![(
            "prod-eu-z1",
            server(seen.clone(), |_, uri, _| {
                if uri.contains("/web-0") {
                    status(
                        409,
                        "Conflict",
                        r#"Operation cannot be fulfilled on pods "web-0": Precondition failed: UID in precondition: uid-old, UID in object meta: uid-new"#,
                    )
                } else {
                    object("Pod", "web-1", "uid-1")
                }
            }),
        )]);
        let targets = vec![
            target("prod-eu-z1", "pods", "web-0", Some("uid-old")),
            // Objects without a uid get a synthetic `namespace/name` in their rows: never a precondition.
            target("prod-eu-z1", "pods", "web-1", Some("shop/web-1")),
        ];
        let results = delete(&inner, targets, true).await.unwrap();

        let bodies = seen.bodies("DELETE");
        let body = |name: &str| bodies.iter().find(|(uri, _)| uri.contains(&format!("/namespaces/shop/pods/{name}"))).unwrap().1.clone();
        assert_eq!(body("web-0")["preconditions"], json!({ "uid": "uid-old" }));
        assert_eq!((body("web-0")["gracePeriodSeconds"].clone(), body("web-0")["propagationPolicy"].clone()), (json!(0), json!("Background")));
        assert!(body("web-1").get("preconditions").is_none(), "{}", body("web-1"));

        assert_eq!(results.iter().map(|r| (r.target.name.as_str(), r.ok)).collect::<Vec<_>>(), [("web-0", false), ("web-1", true)]);
        let err = results[0].error.as_ref().unwrap();
        assert_eq!((err.message(), err.code()), (RECREATED.to_string(), Some(409)));

        let lines = journal.lines();
        assert_eq!(lines.len(), 2);
        let web0 = lines.iter().find(|l| l["name"] == "web-0").unwrap();
        for (k, v) in [
            ("cluster", "prod-eu-z1"),
            ("resource", "pods"),
            ("namespace", "shop"),
            ("uid", "uid-old"),
            ("action", "delete"),
            ("params", "force=true grace=0"),
            ("result", "failed"),
            ("level", "WARN"),
        ] {
            assert_eq!(web0[k], v, "{k}");
        }
        // Quoted and escaped: text from the cluster never splits a journal line.
        assert_eq!(web0["error"], format!("{RECREATED:?}"));
        assert_eq!(lines.iter().find(|l| l["name"] == "web-1").unwrap()["result"], "ok");
    }

    #[tokio::test]
    async fn patches_carry_the_picked_uid_so_a_recreated_object_is_left_alone() {
        let seen = Arc::new(Seen::default());
        let inner = engine_with(vec![(
            "prod-eu-z1",
            server(seen.clone(), |_, uri, _| {
                if uri.contains("/web?") {
                    status(422, "Invalid", r#"Deployment.apps "web" is invalid: metadata.uid: Invalid value: "uid-old": field is immutable"#)
                } else {
                    object("Deployment", "api", "uid-api")
                }
            }),
        )]);
        let err = scale(&inner, &target("prod-eu-z1", "deployments.apps", "web", Some("uid-old")), 3).await.unwrap_err();
        assert_eq!(err.message(), RECREATED);
        restart(&inner, &target("prod-eu-z1", "deployments.apps", "api", Some("uid-api"))).await.unwrap();
        set_suspend(&inner, &target("prod-eu-z1", "deployments.apps", "api", None), true).await.unwrap();

        let patches = seen.bodies("PATCH");
        assert_eq!(patches[0].1, json!({ "metadata": { "uid": "uid-old" }, "spec": { "replicas": 3 } }));
        assert_eq!(patches[1].1["metadata"], json!({ "uid": "uid-api" }));
        assert!(patches[1].1.pointer("/spec/template/metadata/annotations/kubectl.kubernetes.io~1restartedAt").is_some());
        // No uid picked: nothing to check against.
        assert_eq!(patches[2].1, json!({ "spec": { "suspend": true } }));
        assert!(patches.iter().all(|(uri, _)| uri.contains("fieldManager=k10s")));
    }

    #[tokio::test]
    async fn a_recreated_cronjob_is_not_triggered() {
        let seen = Arc::new(Seen::default());
        let inner = engine_with(vec![(
            "prod-eu-z1",
            server(seen.clone(), |method, _, _| if method == "GET" { object("CronJob", "nightly", "uid-new") } else { object("Job", "x", "uid-job") }),
        )]);
        let err = trigger_cronjob(&inner, &target("prod-eu-z1", "cronjobs.batch", "nightly", Some("uid-old"))).await.unwrap_err();
        assert_eq!((err.message(), err.code()), (RECREATED.to_string(), Some(409)));
        assert!(seen.bodies("POST").is_empty());

        let name = trigger_cronjob(&inner, &target("prod-eu-z1", "cronjobs.batch", "nightly", Some("uid-new"))).await.unwrap();
        let posts = seen.bodies("POST");
        assert_eq!(posts.len(), 1);
        assert_eq!(posts[0].1["metadata"]["name"], json!(name));
        assert_eq!(posts[0].1["metadata"]["ownerReferences"][0]["uid"], json!("uid-new"));
    }

    #[tokio::test]
    async fn read_only_mode_refuses_every_mutation_and_journals_the_refusals() {
        let (journal, _log) = Journal::install();
        let seen = Arc::new(Seen::default());
        let inner = engine_with(vec![("prod-eu-z1", server(seen.clone(), |_, _, _| object("Pod", "x", "u")))]);
        inner.set_read_only_for_tests(true);
        let pod = target("prod-eu-z1", "pods", "web-0", Some("uid-0"));
        let deploy = target("prod-eu-z1", "deployments.apps", "web", Some("uid-1"));
        assert!(matches!(delete(&inner, vec![pod.clone(), pod.clone()], false).await, Err(Error::ReadOnly)));
        assert!(matches!(scale(&inner, &deploy, 0).await, Err(Error::ReadOnly)));
        assert!(matches!(restart(&inner, &deploy).await, Err(Error::ReadOnly)));
        assert!(matches!(set_unschedulable(&inner, &deploy, true).await, Err(Error::ReadOnly)));
        assert!(matches!(set_suspend(&inner, &deploy, true).await, Err(Error::ReadOnly)));
        assert!(matches!(trigger_cronjob(&inner, &target("prod-eu-z1", "cronjobs.batch", "nightly", None)).await, Err(Error::ReadOnly)));
        assert!(seen.0.lock().is_empty(), "nothing reached the cluster");
        let lines = journal.lines();
        assert_eq!(lines.iter().map(|l| l["action"].as_str()).collect::<Vec<_>>(), ["delete", "delete", "scale", "restart", "cordon", "suspend", "trigger"]);
        assert!(lines.iter().all(|l| l["result"] == "refused" && l["error"] == "read-only mode"));
        assert_eq!(lines[2]["params"], "replicas=0");
    }

    #[tokio::test]
    async fn bulk_deletes_run_a_bounded_number_at_once_per_cluster_and_keep_their_order() {
        let peak = Arc::new([AtomicUsize::new(0), AtomicUsize::new(0)]);
        let busy = Arc::new([AtomicUsize::new(0), AtomicUsize::new(0)]);
        let counting = |i: usize| {
            let (peak, busy) = (peak.clone(), busy.clone());
            let svc = tower::service_fn(move |_req: http::Request<kube::client::Body>| {
                let (peak, busy) = (peak.clone(), busy.clone());
                async move {
                    let now = busy[i].fetch_add(1, Ordering::SeqCst) + 1;
                    peak[i].fetch_max(now, Ordering::SeqCst);
                    tokio::time::sleep(Duration::from_millis(5)).await;
                    busy[i].fetch_sub(1, Ordering::SeqCst);
                    let body = json!({ "apiVersion": "v1", "kind": "Pod", "metadata": { "name": "x" } }).to_string();
                    Ok::<_, std::convert::Infallible>(http::Response::builder().status(200).body(kube::client::Body::from(body.into_bytes())).unwrap())
                }
            });
            kube::Client::new(svc, "default")
        };
        let inner = engine_with(vec![("prod-eu-z1", counting(0)), ("prod-eu-z2", counting(1))]);
        let targets: Vec<ObjectRef> =
            (0..120).map(|i| target(if i % 3 == 0 { "prod-eu-z2" } else { "prod-eu-z1" }, "pods", &format!("web-{i}"), Some(&format!("uid-{i}")))).collect();
        let results = delete(&inner, targets.clone(), false).await.unwrap();
        assert!(results.iter().all(|r| r.ok));
        assert_eq!(results.iter().map(|r| r.target.name.clone()).collect::<Vec<_>>(), targets.iter().map(|t| t.name.clone()).collect::<Vec<_>>());
        for p in peak.iter() {
            let p = p.load(Ordering::SeqCst);
            assert!(p > 1 && p <= PARALLEL_PER_CLUSTER, "peak {p}");
        }
    }

    #[tokio::test(start_paused = true)]
    async fn a_cluster_that_stops_answering_fails_in_bounded_time_without_holding_up_the_others() {
        let seen = Arc::new(Seen::default());
        let inner =
            engine_with(vec![("prod-eu-z1", server(seen.clone(), |_, _, _| None)), ("prod-eu-z2", server(Arc::default(), |_, _, _| object("Pod", "x", "u")))]);
        let mut targets: Vec<ObjectRef> = (0..40).map(|i| target("prod-eu-z1", "pods", &format!("web-{i}"), None)).collect();
        targets.push(target("prod-eu-z2", "pods", "web-0", None));
        let started = tokio::time::Instant::now();
        let results = delete(&inner, targets, false).await.unwrap();
        assert!(started.elapsed() < WRITE_TIMEOUT * 2, "{:?}", started.elapsed());
        assert!(results[40].ok, "the other cluster went ahead");
        let errors: Vec<String> = results[..40].iter().map(|r| r.error.as_ref().unwrap().message()).collect();
        let timed_out = errors.iter().filter(|e| e.contains("no answer from the API server within 45s: the change may still have been made")).count();
        assert_eq!(timed_out, PARALLEL_PER_CLUSTER);
        assert!(errors.iter().filter(|e| !e.contains("within 45s")).all(|e| e.contains("not sent") && e.contains("nothing was changed")), "{errors:?}");
        assert_eq!(seen.0.lock().len(), PARALLEL_PER_CLUSTER, "the rest was never sent");

        // While those still wait for an answer, the cluster's other mutations are not sent either.
        let deploy = target("prod-eu-z1", "deployments.apps", "web", None);
        let err = scale(&inner, &deploy, 2).await.unwrap_err().message();
        assert!(err.starts_with("not sent: cluster \"prod-eu-z1\" stopped answering") && err.ends_with("nothing was changed"), "{err}");
        assert_eq!(seen.0.lock().len(), PARALLEL_PER_CLUSTER);
        // Reads are bounded on their own.
        assert_eq!(get_yaml(&inner, &deploy, false, false).await.unwrap_err().message(), "no answer from the API server within 30s");

        // Single patches and triggers time out the same way.
        let inner = engine_with(vec![("prod-eu-z1", server(Arc::default(), |_, _, _| None))]);
        assert!(scale(&inner, &deploy, 2).await.unwrap_err().message().contains("may still have been made"));
        let inner = engine_with(vec![("prod-eu-z1", server(Arc::default(), |_, _, _| None))]);
        assert!(trigger_cronjob(&inner, &target("prod-eu-z1", "cronjobs.batch", "nightly", None)).await.unwrap_err().message().contains("nothing was changed"));
    }

    /// A fake API server that answers only once `gate` has permits (one per request).
    fn gated_server(seen: Arc<Seen>, gate: Arc<Semaphore>) -> kube::Client {
        let svc = tower::service_fn(move |req: http::Request<kube::client::Body>| {
            let (seen, gate) = (seen.clone(), gate.clone());
            async move {
                seen.0.lock().push((req.method().to_string(), req.uri().to_string(), String::new()));
                gate.acquire().await.unwrap().forget();
                let body = json!({ "apiVersion": "apps/v1", "kind": "Deployment", "metadata": { "name": "web", "namespace": "shop", "uid": "u" } }).to_string();
                Ok::<_, std::convert::Infallible>(http::Response::builder().status(200).body(kube::client::Body::from(body.into_bytes())).unwrap())
            }
        });
        kube::Client::new(svc, "default")
    }

    #[tokio::test(start_paused = true)]
    async fn a_burst_of_patches_to_a_cluster_that_stops_answering_sends_one_slot_full_and_fails_the_rest_at_once() {
        let (journal, _log) = Journal::install();
        let (seen, gate) = (Arc::new(Seen::default()), Arc::new(Semaphore::new(0)));
        let inner = engine_with(vec![("prod-eu-z1", gated_server(seen.clone(), gate.clone()))]);
        // What the UI does for 40 marked rows: one call per row, all at once.
        let deploys: Vec<ObjectRef> = (0..40).map(|i| target("prod-eu-z1", "deployments.apps", &format!("web-{i}"), Some(&format!("uid-{i}")))).collect();
        let started = tokio::time::Instant::now();
        let results = futures::future::join_all(deploys.iter().enumerate().map(|(i, d)| {
            let inner = &inner;
            async move { if i % 2 == 0 { scale(inner, d, 0).await } else { restart(inner, d).await } }
        }))
        .await;
        assert!(started.elapsed() < WRITE_TIMEOUT * 2, "{:?}", started.elapsed());
        assert_eq!(seen.0.lock().len(), PARALLEL_PER_CLUSTER, "one slot full was sent");
        let errors: Vec<String> = results.into_iter().map(|r| r.unwrap_err().message()).collect();
        assert_eq!(errors.iter().filter(|e| e.contains("may still have been made")).count(), PARALLEL_PER_CLUSTER);
        assert!(
            errors.iter().filter(|e| !e.contains("may still have been made")).all(|e| e.starts_with("not sent") && e.ends_with("nothing was changed")),
            "{errors:?}"
        );

        // The cluster answers after all: the journal says how the timed-out ones ended, and the stall is lifted.
        gate.add_permits(1000);
        tokio::time::sleep(Duration::from_millis(10)).await;
        let late: Vec<_> = journal.lines().into_iter().filter(|l| l["result"] == "ok after timing out").collect();
        assert_eq!(late.len(), PARALLEL_PER_CLUSTER);
        assert!(late.iter().all(|l| l["level"] == "INFO" && l["name"].starts_with("web-") && l["cluster"] == "prod-eu-z1"));
        scale(&inner, &deploys[0], 1).await.unwrap();
        assert_eq!(seen.0.lock().len(), PARALLEL_PER_CLUSTER + 1);
    }

    #[tokio::test(start_paused = true)]
    async fn a_reconnect_lifts_a_stall_with_a_fresh_budget() {
        let (seen, gate) = (Arc::new(Seen::default()), Arc::new(Semaphore::new(0)));
        let inner = engine_with(vec![("prod-eu-z1", gated_server(seen.clone(), gate))]);
        let deploy = target("prod-eu-z1", "deployments.apps", "web", None);
        let results = futures::future::join_all((0..PARALLEL_PER_CLUSTER + 1).map(|_| restart(&inner, &deploy))).await;
        assert!(results.iter().all(Result::is_err));
        assert!(restart(&inner, &deploy).await.unwrap_err().message().starts_with("not sent"));

        // The old connection's requests still hold every slot of the old lane; the new connection has its own.
        let fresh = Arc::new(Seen::default());
        inner.clusters.insert_ready_for_tests(Cluster::for_tests(
            "prod-eu-z1",
            server(fresh.clone(), |_, _, _| object("Deployment", "web", "u")),
            vec![res("apps", "v1", "Deployment", "deployments")],
        ));
        restart(&inner, &deploy).await.unwrap();
        assert_eq!((seen.0.lock().len(), fresh.0.lock().len()), (PARALLEL_PER_CLUSTER, 1));
    }

    #[tokio::test(start_paused = true)]
    async fn a_mutation_unanswered_past_the_endpoints_response_timeout_is_journaled_as_it_really_ended() {
        let (journal, _log) = Journal::install();
        let (seen, gate) = (Arc::new(Seen::default()), Arc::new(Semaphore::new(0)));
        // As in the app: requests go through the context's endpoint (which cuts reads off after 120s).
        let endpoint = Arc::new(crate::cluster::Endpoint::default());
        endpoint.set(gated_server(seen.clone(), gate.clone()).into());
        let inner = engine_with(vec![("prod-eu-z1", endpoint.client("default".into()))]);
        let deploy = target("prod-eu-z1", "deployments.apps", "web", Some("u"));
        assert!(scale(&inner, &deploy, 0).await.unwrap_err().message().contains("may still have been made"));

        // Minutes later the request is still pending: nothing says how it ended yet, and the lane stays stalled.
        tokio::time::sleep(Duration::from_secs(240)).await;
        let late = || journal.lines().into_iter().filter(|l| l["result"].ends_with("after timing out")).collect::<Vec<_>>();
        assert!(late().is_empty(), "{:?}", late());
        assert!(restart(&inner, &deploy).await.unwrap_err().message().starts_with("not sent"));
        assert_eq!(seen.0.lock().len(), 1);

        // The API server answers at last: that is what the journal says, and the cluster takes changes again.
        gate.add_permits(2);
        tokio::time::sleep(Duration::from_millis(10)).await;
        assert_eq!(late().iter().map(|l| (l["action"].as_str(), l["result"].as_str())).collect::<Vec<_>>(), [("scale", "ok after timing out")]);
        scale(&inner, &deploy, 1).await.unwrap();
    }

    #[tokio::test]
    async fn read_only_mode_turned_on_mid_way_stops_the_mutations_not_sent_yet() {
        let (journal, _log) = Journal::install();
        let (seen, gate) = (Arc::new(Seen::default()), Arc::new(Semaphore::new(0)));
        let inner = engine_with(vec![("prod-eu-z1", gated_server(seen.clone(), gate.clone()))]);
        let pods: Vec<ObjectRef> = (0..40).map(|i| target("prod-eu-z1", "pods", &format!("web-{i}"), None)).collect();
        let bulk = tokio::spawn({
            let inner = inner.clone();
            async move { delete(&inner, pods, false).await }
        });
        for _ in 0..1000 {
            if seen.0.lock().len() == PARALLEL_PER_CLUSTER {
                break;
            }
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
        assert_eq!(seen.0.lock().len(), PARALLEL_PER_CLUSTER, "one slot full went out");
        // Patches the UI sent meanwhile (one call per row) wait for a slot.
        let patches: Vec<_> = (0..10)
            .map(|i| {
                let inner = inner.clone();
                tokio::spawn(async move { restart(&inner, &target("prod-eu-z1", "deployments.apps", &format!("api-{i}"), None)).await })
            })
            .collect();
        tokio::time::sleep(Duration::from_millis(20)).await;

        inner.set_read_only_for_tests(true);
        gate.add_permits(1000);
        let results = bulk.await.unwrap().unwrap();
        assert_eq!(results.iter().filter(|r| r.ok).count(), PARALLEL_PER_CLUSTER, "what was sent ended as the cluster said");
        assert!(results.iter().filter(|r| !r.ok).all(|r| matches!(r.error, Some(Error::ReadOnly))));
        for p in patches {
            assert!(matches!(p.await.unwrap(), Err(Error::ReadOnly)));
        }
        assert_eq!(seen.0.lock().len(), PARALLEL_PER_CLUSTER, "nothing else reached the cluster");
        let refused = journal.lines().into_iter().filter(|l| l["result"] == "refused").count();
        assert_eq!(refused, 40 - PARALLEL_PER_CLUSTER + 10);
    }

    #[tokio::test]
    async fn without_get_details_come_from_a_list_of_one_where_a_feed_shows_the_object() {
        use crate::feed::{FeedKey, FeedSpec, Lease};
        let pod = json!({ "apiVersion": "v1", "kind": "Pod", "metadata": { "name": "web-0", "namespace": "shop", "uid": "uid-0", "resourceVersion": "7", "managedFields": [{ "manager": "kubelet" }] }, "spec": { "nodeName": "node-1" } });
        let list = json!({ "kind": "PodList", "apiVersion": "v1", "metadata": { "resourceVersion": "7" }, "items": [pod] }).to_string();
        let seen = Arc::new(Seen::default());
        // A strict RBAC role: `list` and `watch`, no `get`.
        let client = server(seen.clone(), move |_, uri, _| {
            if uri.contains("watch=true") {
                None
            } else if uri.contains("/pods?") {
                Some((200, list.clone()))
            } else if uri.contains("/pods/missing") {
                status(404, "NotFound", r#"pods "missing" not found"#)
            } else {
                status(403, "Forbidden", r#"pods "web-0" is forbidden: User "jane" cannot get resource "pods" in API group "" in the namespace "shop""#)
            }
        });
        let inner = engine_with(vec![("prod-eu-z1", client.clone())]);
        let web = target("prod-eu-z1", "pods", "web-0", Some("uid-0"));
        let listed_by_name = |name: &str| seen.0.lock().iter().filter(|(_, uri, _)| uri.contains(&format!("fieldSelector=metadata.name%3D{name}"))).count();

        // No feed shows it: the GET's answer stands.
        assert_eq!(get_object(&inner, &web).await.unwrap_err().code(), Some(403));
        assert_eq!(listed_by_name("web-0"), 0);

        // A view shows it, from a feed that keeps rows only (as big ones do).
        let key = FeedKey { cluster: "prod-eu-z1".into(), resource: "pods".into(), namespace: Some("shop".into()), labels: None, fields: None };
        let spec = || FeedSpec {
            client: client.clone(),
            api_resource: res("", "v1", "Pod", "pods").api_resource(),
            renderer: crate::render::builtin_for_key("pods").unwrap(),
        };
        let lease = inner.hub.lease_with(key, spec, Lease { fallback: false, objects: false });
        for _ in 0..500 {
            if lease.len() == 1 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert_eq!((lease.len(), lease.json_bytes()), (1, 0));

        let json: Value = serde_json::from_str(&get_object(&inner, &web).await.unwrap()).unwrap();
        assert_eq!((&json["kind"], &json["metadata"]["uid"], &json["spec"]["nodeName"]), (&json!("Pod"), &json!("uid-0"), &json!("node-1")));
        assert!(json["metadata"].get("managedFields").is_none());
        assert_eq!(listed_by_name("web-0"), 1);
        let yaml = get_yaml(&inner, &web, false, false).await.unwrap();
        assert!(yaml.contains("nodeName: node-1") && !yaml.contains("managedFields"), "{yaml}");
        // With managedFields too (listed again: the feed's JSON never has them).
        let yaml = get_yaml(&inner, &web, true, false).await.unwrap();
        assert!(yaml.contains("managedFields:") && yaml.contains("manager: kubelet") && yaml.contains("nodeName: node-1"), "{yaml}");
        assert_eq!(listed_by_name("web-0"), 2);

        // An object no feed holds: still the GET's 403. Other errors are not looked past.
        assert_eq!(get_object(&inner, &target("prod-eu-z1", "pods", "web-9", None)).await.unwrap_err().code(), Some(403));
        assert_eq!(get_object(&inner, &target("prod-eu-z1", "pods", "missing", None)).await.unwrap_err().code(), Some(404));
        assert_eq!(listed_by_name("web-9") + listed_by_name("missing"), 0);
    }

    fn secret() -> Value {
        json!({
            "apiVersion": "v1",
            "kind": "Secret",
            "type": "Opaque",
            "metadata": {
                "name": "db",
                "namespace": "shop",
                "annotations": {
                    "kubectl.kubernetes.io/last-applied-configuration": "{\"apiVersion\":\"v1\",\"kind\":\"Secret\",\"metadata\":{\"name\":\"db\"},\"stringData\":{\"password\":\"hunter2-plain\"},\"data\":{\"user\":\"YWRtaW4=\"}}\n",
                    "team": "payments"
                }
            },
            "data": { "password": "c3VwZXItc2VjcmV0LXZhbHVl", "user": "YWRtaW4=", "empty": "", "odd": "YWJj" },
            "stringData": { "token": "plain-token" }
        })
    }

    #[test]
    fn secret_values_are_replaced_by_their_sizes() {
        let mut v = secret();
        mask_secret(&mut v);
        assert_eq!(
            v["data"],
            json!({ "password": "<hidden: 18 bytes>", "user": "<hidden: 5 bytes>", "empty": "<hidden: 0 bytes>", "odd": "<hidden: 3 bytes>" })
        );
        assert_eq!(v["stringData"], json!({ "token": "<hidden: 11 bytes>" }));
        let applied = v["metadata"]["annotations"][LAST_APPLIED].as_str().unwrap();
        assert!(applied.ends_with('\n'));
        let applied: Value = serde_json::from_str(applied).unwrap();
        assert_eq!(applied["stringData"], json!({ "password": "<hidden: 13 bytes>" }));
        assert_eq!(applied["data"], json!({ "user": "<hidden: 5 bytes>" }));
        assert_eq!(applied["metadata"], json!({ "name": "db" }));
        assert_eq!(v["metadata"]["annotations"]["team"], "payments");

        let text = yaml::to_yaml(&v);
        for secret in ["c3VwZXItc2VjcmV0LXZhbHVl", "YWRtaW4=", "hunter2-plain", "plain-token", "YWJj"] {
            assert!(!text.contains(secret), "{secret} leaked:\n{text}");
        }

        // A last-applied annotation that is not kubectl's JSON is hidden whole.
        let mut v = json!({ "apiVersion": "v1", "kind": "Secret", "metadata": { "annotations": { "kubectl.kubernetes.io/last-applied-configuration": "password: hunter2" } } });
        mask_secret(&mut v);
        assert_eq!(v["metadata"]["annotations"][LAST_APPLIED], "<hidden: 17 bytes>");
        assert_eq!(base64_len("YQ"), 1);
        assert_eq!(base64_len("YWI"), 2);
    }

    #[tokio::test]
    async fn yaml_hides_secret_values_unless_revealed() {
        let inner = engine_with(vec![(
            "prod-eu-z1",
            server(Arc::default(), |_, uri, _| if uri.contains("/secrets/") { Some((200, secret().to_string())) } else { object("Pod", "web-0", "u") }),
        )]);
        let r = target("prod-eu-z1", "secrets", "db", None);
        let hidden = get_yaml(&inner, &r, false, false).await.unwrap();
        assert!(hidden.contains("<hidden: 18 bytes>") && !hidden.contains("c3VwZXItc2VjcmV0LXZhbHVl") && !hidden.contains("hunter2"), "{hidden}");
        assert!(hidden.contains("password:") && hidden.contains("team: payments"), "keys stay: {hidden}");
        let shown = get_yaml(&inner, &r, false, true).await.unwrap();
        assert!(shown.contains("c3VwZXItc2VjcmV0LXZhbHVl") && shown.contains("hunter2-plain"), "{shown}");
        // With managedFields (a direct GET) too.
        assert!(!get_yaml(&inner, &r, true, false).await.unwrap().contains("c3VwZXItc2VjcmV0LXZhbHVl"));
        // Other kinds are never touched.
        assert!(!get_yaml(&inner, &target("prod-eu-z1", "pods", "web-0", None), false, false).await.unwrap().contains("hidden"));
    }
}
