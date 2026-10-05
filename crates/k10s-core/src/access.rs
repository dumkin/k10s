//! Permissions, asked for before acting: whether the user may patch these deployments in that namespace of that
//! cluster — so an action the API server would refuse says why before it is confirmed, not with a 403 after. Asked
//! with SelfSubjectAccessReviews, which every authorizer answers (RBAC, webhooks, Node…), one per question, and kept
//! for a few minutes per connection (another connection may have other credentials: they are asked again).
//!
//! A question that gets no answer (no network, a cluster that forbids asking) is answered "unknown": it never stops
//! an action — the API server still decides.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use futures::StreamExt;
use k8s_openapi::api::authorization::v1::{
    ResourceAttributes, SelfSubjectAccessReview, SelfSubjectAccessReviewSpec, SelfSubjectRulesReview, SelfSubjectRulesReviewSpec,
};
use kube::Api;
use kube::api::PostParams;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};

use crate::engine::Inner;
use crate::error::Result;
use crate::ops;

/// How long a decision is kept: one that allowed…
const ALLOWED_TTL: Duration = Duration::from_secs(300);
/// …and one that did not (shorter: access an admin just granted should show soon).
const DENIED_TTL: Duration = Duration::from_secs(60);
/// One review gets an answer within this long, or is "unknown".
const REVIEW_TIMEOUT: Duration = Duration::from_secs(10);
/// Reviews of one request in flight at once.
const PARALLEL: usize = 8;
/// Decisions kept at most (all clusters); the oldest go first.
const MAX_KEPT: usize = 4096;

/// The verb a stream into a pod (exec, attach, port-forward) is authorized with on a cluster of `version`: `create`
/// since Kubernetes 1.30, where the API server authorizes the websocket upgrade as the POST it stands for; `get`
/// before (the upgrade is a GET). Unknown versions: `create`.
pub fn stream_verb(version: Option<&str>) -> &'static str {
    let minor = version.and_then(|v| {
        let mut parts = v.trim_start_matches('v').split('.');
        let major: u32 = parts.next()?.parse().ok()?;
        let minor: u32 = parts.next()?.chars().take_while(char::is_ascii_digit).collect::<String>().parse().ok()?;
        Some((major, minor))
    });
    match minor {
        Some((1, m)) if m < 30 => "get",
        _ => "create",
    }
}

/// One question: may the user `verb` this resource (its subresource), in this namespace (none: cluster-wide or
/// every namespace), this object (none: any of them)?
#[derive(Debug, Clone, PartialEq, Eq, Hash, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccessCheck {
    pub verb: String,
    /// API group: empty for the core group.
    #[serde(default)]
    pub group: String,
    /// Plural resource name (`deployments`, `pods`).
    pub resource: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subresource: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub namespace: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccessDecision {
    /// `None`: unknown — the review could not be made. Never a reason to refuse anything.
    pub allowed: Option<bool>,
    /// What the authorizer said, when it said something (RBAC usually does not).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

impl AccessDecision {
    const UNKNOWN: AccessDecision = AccessDecision { allowed: None, reason: None };
}

struct Kept {
    /// The connection it was asked on.
    generation: Option<u64>,
    at: Instant,
    decision: AccessDecision,
}

/// Decisions per cluster and question (see the module docs).
#[derive(Default)]
pub(crate) struct AccessCache(Mutex<HashMap<(Arc<str>, AccessCheck), Kept>>);

impl AccessCache {
    fn get(&self, cluster: &str, generation: Option<u64>, check: &AccessCheck) -> Option<AccessDecision> {
        let map = self.0.lock();
        let kept = map.get(&(Arc::from(cluster), check.clone()))?;
        let ttl = if kept.decision.allowed == Some(true) { ALLOWED_TTL } else { DENIED_TTL };
        (kept.generation == generation && kept.at.elapsed() < ttl).then(|| kept.decision.clone())
    }

    fn put(&self, cluster: &str, generation: Option<u64>, check: AccessCheck, decision: AccessDecision) {
        let mut map = self.0.lock();
        if map.len() >= MAX_KEPT {
            let mut by_age: Vec<_> = map.iter().map(|(k, v)| (v.at, k.clone())).collect();
            by_age.sort_by_key(|(at, _)| *at);
            for (_, k) in by_age.into_iter().take(MAX_KEPT / 4) {
                map.remove(&k);
            }
        }
        map.insert((Arc::from(cluster), check), Kept { generation, at: Instant::now(), decision });
    }
}

/// Answers `checks` for `cluster`, in their order: from what was asked lately on this connection, else with reviews.
pub(crate) async fn review(inner: &Arc<Inner>, cluster: &str, checks: Vec<AccessCheck>) -> Result<Vec<AccessDecision>> {
    let c = ops::connected(inner, cluster, false).await?;
    let generation = inner.clusters.state(cluster).map(|(g, _)| g);
    let api: Api<SelfSubjectAccessReview> = Api::all(c.client.clone());
    let asks = checks.into_iter().map(|check| {
        let api = api.clone();
        async move {
            if let Some(d) = inner.access.get(cluster, generation, &check) {
                return d;
            }
            let decision = ask(&api, &check).await;
            if decision.allowed.is_some() {
                inner.access.put(cluster, generation, check, decision.clone());
            }
            decision
        }
    });
    Ok(futures::stream::iter(asks).buffered(PARALLEL).collect().await)
}

async fn ask(api: &Api<SelfSubjectAccessReview>, check: &AccessCheck) -> AccessDecision {
    let review = SelfSubjectAccessReview {
        spec: SelfSubjectAccessReviewSpec {
            resource_attributes: Some(ResourceAttributes {
                verb: Some(check.verb.clone()),
                group: Some(check.group.clone()),
                resource: Some(check.resource.clone()),
                subresource: check.subresource.clone(),
                namespace: check.namespace.clone(),
                name: check.name.clone(),
                ..Default::default()
            }),
            ..Default::default()
        },
        ..Default::default()
    };
    match tokio::time::timeout(REVIEW_TIMEOUT, api.create(&PostParams::default(), &review)).await {
        Ok(Ok(r)) => match r.status {
            Some(s) => {
                // `denied` (an authorizer said no outright) implies not allowed; `reason` is the authorizer's words.
                let reason = s.reason.filter(|r| !r.is_empty()).or(s.evaluation_error.filter(|e| !e.is_empty()));
                AccessDecision { allowed: Some(s.allowed && s.denied != Some(true)), reason }
            }
            None => AccessDecision::UNKNOWN,
        },
        Ok(Err(e)) => {
            tracing::debug!(verb = %check.verb, resource = %check.resource, error = %e, "access review failed");
            AccessDecision::UNKNOWN
        }
        Err(_) => AccessDecision::UNKNOWN,
    }
}

/// What the user may do in a namespace, as the API server lists it (`kubectl auth can-i --list`): rules over
/// resources and over non-resource URLs. `incomplete` when an authorizer (a webhook) cannot list what it allows:
/// then the rules say less than the user may do.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Rules {
    pub resources: Vec<ResourceRule>,
    pub incomplete: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceRule {
    pub verbs: Vec<String>,
    pub groups: Vec<String>,
    /// Resources, `resource/subresource`, `*`.
    pub resources: Vec<String>,
    /// When set, the rule allows these objects only.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub names: Vec<String>,
}

/// The user's rules in `namespace` of `cluster` (a SelfSubjectRulesReview).
pub(crate) async fn rules(inner: &Arc<Inner>, cluster: &str, namespace: &str) -> Result<Rules> {
    let c = ops::connected(inner, cluster, false).await?;
    let api: Api<SelfSubjectRulesReview> = Api::all(c.client.clone());
    let review = SelfSubjectRulesReview { spec: SelfSubjectRulesReviewSpec { namespace: Some(namespace.to_string()) }, ..Default::default() };
    let r = match tokio::time::timeout(REVIEW_TIMEOUT, api.create(&PostParams::default(), &review)).await {
        Ok(res) => res?,
        Err(_) => return Err(crate::error::Error::other(format!("no answer from the API server within {}s", REVIEW_TIMEOUT.as_secs()))),
    };
    let status = r.status.unwrap_or_default();
    Ok(Rules {
        resources: status
            .resource_rules
            .into_iter()
            .map(|rule| ResourceRule {
                verbs: rule.verbs,
                groups: rule.api_groups.unwrap_or_default(),
                resources: rule.resources.unwrap_or_default(),
                names: rule.resource_names.unwrap_or_default(),
            })
            .collect(),
        incomplete: status.incomplete,
        error: status.evaluation_error.filter(|e| !e.is_empty()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cluster::Cluster;
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// A fake API server answering access reviews: allowed unless the verb is `delete`; `get` gets no answer (500).
    fn reviews(asked: Arc<AtomicUsize>) -> kube::Client {
        let svc = tower::service_fn(move |req: http::Request<kube::client::Body>| {
            let asked = asked.clone();
            async move {
                asked.fetch_add(1, Ordering::SeqCst);
                let body = req.into_body().collect_bytes().await.unwrap();
                let review: serde_json::Value = serde_json::from_slice(&body).unwrap();
                let verb = review["spec"]["resourceAttributes"]["verb"].as_str().unwrap_or_default().to_string();
                let (status, json) = match verb.as_str() {
                    "get" => (500, r#"{"kind":"Status","apiVersion":"v1","status":"Failure","message":"boom","code":500}"#.to_string()),
                    v => {
                        let allowed = v != "delete";
                        let reason = if allowed { "RBAC: allowed by RoleBinding \"edit\"" } else { "" };
                        let json = serde_json::json!({"apiVersion": "authorization.k8s.io/v1", "kind": "SelfSubjectAccessReview", "spec": {}, "status": {"allowed": allowed, "reason": reason}});
                        (201, json.to_string())
                    }
                };
                Ok::<_, std::convert::Infallible>(
                    http::Response::builder()
                        .status(status)
                        .header("content-type", "application/json")
                        .body(kube::client::Body::from(json.into_bytes()))
                        .unwrap(),
                )
            }
        });
        kube::Client::new(svc, "default")
    }

    fn check(verb: &str, name: Option<&str>) -> AccessCheck {
        AccessCheck {
            verb: verb.into(),
            group: "apps".into(),
            resource: "deployments".into(),
            subresource: None,
            namespace: Some("shop".into()),
            name: name.map(String::from),
        }
    }

    #[tokio::test]
    async fn answers_in_order_keeps_decisions_and_never_refuses_on_no_answer() {
        let inner = Inner::for_tests();
        let asked = Arc::new(AtomicUsize::new(0));
        inner.clusters.insert_ready_for_tests(Cluster::for_tests("prod-eu-z1", reviews(asked.clone()), Vec::new()));
        let checks = vec![check("patch", Some("web")), check("delete", Some("web")), check("get", None)];
        let first = review(&inner, "prod-eu-z1", checks.clone()).await.unwrap();
        assert_eq!(first[0], AccessDecision { allowed: Some(true), reason: Some("RBAC: allowed by RoleBinding \"edit\"".into()) });
        assert_eq!(first[1], AccessDecision { allowed: Some(false), reason: None });
        assert_eq!(first[2], AccessDecision::UNKNOWN);
        assert_eq!(asked.load(Ordering::SeqCst), 3);

        // Answers are kept; what got none is asked again.
        let again = review(&inner, "prod-eu-z1", checks.clone()).await.unwrap();
        assert_eq!(again, first);
        assert_eq!(asked.load(Ordering::SeqCst), 4);

        // Another connection (a reconnect may bring other credentials) asks anew.
        inner.clusters.insert_ready_for_tests(Cluster::for_tests("prod-eu-z1", reviews(asked.clone()), Vec::new()));
        review(&inner, "prod-eu-z1", checks).await.unwrap();
        assert_eq!(asked.load(Ordering::SeqCst), 7);
    }

    #[test]
    fn streams_into_pods_take_create_since_1_30_and_get_before() {
        assert_eq!(stream_verb(Some("v1.33.4+k3s1")), "create");
        assert_eq!(stream_verb(Some("v1.30.0")), "create");
        assert_eq!(stream_verb(Some("v1.29.9-eks-1234")), "get");
        assert_eq!(stream_verb(Some("v2.0.0")), "create");
        assert_eq!(stream_verb(None), "create");
        assert_eq!(stream_verb(Some("dev")), "create");
    }

    #[test]
    fn the_cache_forgets_the_oldest_when_full() {
        let cache = AccessCache::default();
        let yes = AccessDecision { allowed: Some(true), reason: None };
        for i in 0..MAX_KEPT + 1 {
            cache.put("c", Some(1), check("patch", Some(&format!("d{i}"))), yes.clone());
        }
        assert!(cache.0.lock().len() <= MAX_KEPT);
        assert!(cache.get("c", Some(1), &check("patch", Some(&format!("d{MAX_KEPT}")))).is_some(), "the newest stays");
        assert!(cache.get("c", Some(1), &check("patch", Some("d0"))).is_none(), "the oldest went");
        assert!(cache.get("c", Some(2), &check("patch", Some(&format!("d{MAX_KEPT}")))).is_none(), "another connection");
    }
}
