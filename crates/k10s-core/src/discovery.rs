//! API discovery. Uses Aggregated Discovery (2 requests total, k8s ≥ 1.26) and falls back to the
//! legacy per-group-version walk (done concurrently) on older or restricted servers.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use futures::{StreamExt, stream};
use kube::Client;
use kube::core::ApiResource;
use serde::Serialize;

use crate::error::{Result, kube_message};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceInfo {
    /// kubectl-style unique key: `pods`, `deployments.apps`, `certificates.cert-manager.io`.
    pub key: String,
    pub group: String,
    /// Preferred version served by this cluster.
    pub version: String,
    pub kind: String,
    pub plural: String,
    pub singular: String,
    pub namespaced: bool,
    pub verbs: Vec<String>,
    pub short_names: Vec<String>,
    pub categories: Vec<String>,
    pub subresources: Vec<String>,
}

impl ResourceInfo {
    pub fn key_for(group: &str, plural: &str) -> String {
        if group.is_empty() { plural.to_string() } else { format!("{plural}.{group}") }
    }

    pub fn api_version(&self) -> String {
        if self.group.is_empty() { self.version.clone() } else { format!("{}/{}", self.group, self.version) }
    }

    pub fn api_resource(&self) -> ApiResource {
        ApiResource {
            group: self.group.clone(),
            version: self.version.clone(),
            api_version: self.api_version(),
            kind: self.kind.clone(),
            plural: self.plural.clone(),
        }
    }

    pub fn can(&self, verb: &str) -> bool {
        self.verbs.iter().any(|v| v == verb)
    }

    pub fn has_subresource(&self, name: &str) -> bool {
        self.subresources.iter().any(|s| s == name)
    }
}

#[derive(Debug, Default)]
pub struct Discovery {
    pub resources: Vec<Arc<ResourceInfo>>,
    by_key: HashMap<String, Arc<ResourceInfo>>,
    pub aggregated: bool,
}

impl Discovery {
    pub(crate) fn new(mut list: Vec<ResourceInfo>, aggregated: bool) -> Self {
        list.sort_by(|a, b| a.group.cmp(&b.group).then_with(|| a.plural.cmp(&b.plural)));
        let resources: Vec<Arc<ResourceInfo>> = list.into_iter().map(Arc::new).collect();
        let by_key = resources.iter().map(|r| (r.key.clone(), r.clone())).collect();
        Self { resources, by_key, aggregated }
    }

    /// Resolves a resource by key (`deployments.apps`), plural, singular, kind or short name
    /// (`deploy`, `po`) — the same lookups kubectl and k9s accept.
    pub fn resolve(&self, query: &str) -> Option<Arc<ResourceInfo>> {
        if let Some(r) = self.by_key.get(query) {
            return Some(r.clone());
        }
        let q = query.to_ascii_lowercase();
        // Prefer core/well-known groups when ambiguous (e.g. `events` exists in two groups).
        let mut best: Option<&Arc<ResourceInfo>> = None;
        for r in &self.resources {
            let hit = r.plural == q || r.singular == q || r.kind.eq_ignore_ascii_case(&q) || r.short_names.contains(&q);
            if hit && best.is_none_or(|b| group_rank(&r.group) < group_rank(&b.group)) {
                best = Some(r);
            }
        }
        best.cloned()
    }
}

fn group_rank(group: &str) -> u8 {
    match group {
        "" => 0,
        "apps" | "batch" => 1,
        g if g.ends_with(".k8s.io") || !g.contains('.') => 2,
        _ => 3,
    }
}

pub async fn discover(client: &Client) -> Result<Discovery> {
    match aggregated(client).await {
        Ok(list) if !list.is_empty() => return Ok(Discovery::new(list, true)),
        Ok(_) => tracing::debug!("aggregated discovery returned nothing; falling back"),
        Err(err) => tracing::debug!(%err, "aggregated discovery unavailable; falling back"),
    }
    Ok(Discovery::new(legacy(client).await?, false))
}

async fn aggregated(client: &Client) -> Result<Vec<ResourceInfo>> {
    let (core, apis) = tokio::join!(client.list_core_api_versions_aggregated(), client.list_api_groups_aggregated());
    let mut out = Vec::with_capacity(256);
    for group in core?.items.into_iter().chain(apis?.items) {
        let group_name = group.metadata.and_then(|m| m.name).unwrap_or_default();
        let mut seen = HashSet::new();
        // Versions are listed in preference order; first occurrence of a resource wins.
        for version in group.versions {
            let Some(ver) = version.version else { continue };
            for r in version.resources {
                let Some(plural) = r.resource else { continue };
                if !seen.insert(plural.clone()) {
                    continue;
                }
                let kind = r.response_kind.and_then(|k| k.kind).unwrap_or_default();
                out.push(ResourceInfo {
                    key: ResourceInfo::key_for(&group_name, &plural),
                    group: group_name.clone(),
                    version: ver.clone(),
                    singular: r.singular_resource.filter(|s| !s.is_empty()).unwrap_or_else(|| kind.to_ascii_lowercase()),
                    kind,
                    namespaced: r.scope.as_deref() == Some("Namespaced"),
                    verbs: r.verbs,
                    short_names: r.short_names,
                    categories: r.categories,
                    subresources: r.subresources.into_iter().filter_map(|s| s.subresource).collect(),
                    plural,
                });
            }
        }
    }
    Ok(out)
}

async fn legacy(client: &Client) -> Result<Vec<ResourceInfo>> {
    let groups = client.list_api_groups().await?;
    let mut targets: Vec<(String, String)> = vec![(String::new(), "v1".into())];
    for g in groups.groups {
        let preferred = g.preferred_version.map(|v| v.version);
        let mut versions: Vec<String> = g.versions.into_iter().map(|v| v.version).collect();
        if let Some(p) = preferred
            && let Some(pos) = versions.iter().position(|v| *v == p)
        {
            let pv = versions.remove(pos);
            versions.insert(0, pv);
        }
        targets.extend(versions.into_iter().map(|v| (g.name.clone(), v)));
    }

    let lists: Vec<_> = stream::iter(targets)
        .map(|(group, version)| async move {
            let res = if group.is_empty() {
                client.list_core_api_resources(&version).await
            } else {
                client.list_api_group_resources(&format!("{group}/{version}")).await
            };
            (group, version, res)
        })
        .buffered(16)
        .collect()
        .await;

    let mut out = Vec::new();
    let mut seen: HashSet<(String, String)> = HashSet::new();
    let mut subresources: HashMap<(String, String), Vec<String>> = HashMap::new();
    for (group, version, res) in lists {
        let list = match res {
            Ok(list) => list,
            Err(err) => {
                tracing::warn!(%group, %version, err = %kube_message(&err), "skipping unavailable API group version");
                continue;
            }
        };
        for r in list.resources {
            if let Some((parent, sub)) = r.name.split_once('/') {
                subresources.entry((group.clone(), parent.to_string())).or_default().push(sub.to_string());
                continue;
            }
            if !seen.insert((group.clone(), r.name.clone())) {
                continue;
            }
            out.push(ResourceInfo {
                key: ResourceInfo::key_for(&group, &r.name),
                group: group.clone(),
                version: r.version.filter(|v| !v.is_empty()).unwrap_or_else(|| version.clone()),
                singular: if r.singular_name.is_empty() { r.kind.to_ascii_lowercase() } else { r.singular_name },
                kind: r.kind,
                namespaced: r.namespaced,
                verbs: r.verbs,
                short_names: r.short_names.unwrap_or_default(),
                categories: r.categories.unwrap_or_default(),
                subresources: Vec::new(),
                plural: r.name,
            });
        }
    }
    for r in &mut out {
        if let Some(subs) = subresources.remove(&(r.group.clone(), r.plural.clone())) {
            r.subresources = subs;
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn res(group: &str, plural: &str, kind: &str, short: &[&str]) -> ResourceInfo {
        ResourceInfo {
            key: ResourceInfo::key_for(group, plural),
            group: group.into(),
            version: "v1".into(),
            kind: kind.into(),
            plural: plural.into(),
            singular: kind.to_ascii_lowercase(),
            namespaced: true,
            verbs: vec![],
            short_names: short.iter().map(|s| s.to_string()).collect(),
            categories: vec![],
            subresources: vec![],
        }
    }

    #[test]
    fn resolves_like_kubectl() {
        let d = Discovery::new(
            vec![
                res("", "events", "Event", &["ev"]),
                res("events.k8s.io", "events", "Event", &["ev"]),
                res("apps", "deployments", "Deployment", &["deploy"]),
                res("", "pods", "Pod", &["po"]),
            ],
            true,
        );
        assert_eq!(d.resolve("po").unwrap().key, "pods");
        assert_eq!(d.resolve("deploy").unwrap().key, "deployments.apps");
        assert_eq!(d.resolve("Deployment").unwrap().key, "deployments.apps");
        assert_eq!(d.resolve("events").unwrap().key, "events");
        assert_eq!(d.resolve("events.events.k8s.io").unwrap().group, "events.k8s.io");
        assert!(d.resolve("nope").is_none());
    }
}
