//! k10s-core — the engine behind k10s, independent of any UI toolkit.
//!
//! - [`access`]: what the user may do, asked before acting (access reviews), and their rules per namespace
//! - [`kubeconfig`]: contexts from `KUBECONFIG`/`~/.kube/config`, per-context client configs
//! - [`cluster`]: lazy, de-duplicated, independent connections + aggregated discovery
//! - [`feed`]: shared watch feeds (informers) with warm idle caches
//! - [`watch`]: the lists and watches behind them — lists in pipelined pages parsed as they stream in
//! - [`view`]: multi-cluster × multi-namespace tables streamed as coalesced JSON batches
//! - [`render`]: per-kind row renderers (kubectl-compatible) + CRD printer columns
//! - [`logs`]: merged, resumable log streams
//! - [`ops`]: object reads/YAML and guarded mutating actions
//! - [`term`]: terminals in containers (shell, attach, debug containers) and on nodes
//! - [`pf`]: port-forwards that survive pod replacements, renewed credentials and sleep
//! - [`metrics`]: CPU and memory of pods and nodes (metrics API), with a short history
//! - [`relations`]: the graph around an object — owners, owned, selectors, routes, what it uses and what uses it — live
//! - [`helm`]: Helm releases from their records (values, manifests, history, diffs); rollback and uninstall with helm

pub mod access;
pub mod cluster;
pub mod discovery;
mod engine;
pub mod env;
pub mod error;
mod exec;
pub mod feed;
pub mod helm;
pub mod kubeconfig;
mod list;
pub mod logs;
pub mod metrics;
pub mod object;
pub mod ops;
pub mod pf;
mod redact;
pub mod relations;
pub mod render;
pub mod term;
pub mod time;
pub mod view;
pub mod watch;
pub mod yaml;

pub use access::{AccessCheck, AccessDecision};
pub use engine::{ClusterState, Engine, EngineEvent, SaveSettings, Settings};
pub use error::{Error, Result};
pub use logs::{LogSpec, LogTarget};
pub use metrics::MetricsSpec;
pub use object::ObjectRef;
pub use pf::{ForwardInfo, ForwardSpec};
pub use relations::RelationsSpec;
pub use term::{DebugSpec, NodeShellSpec, TermSize, TermSpec};
pub use view::{Projection, Sink, ViewSpec};

/// Test support: a fake API server.
#[cfg(test)]
pub(crate) mod testing {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use kube::Client;
    use parking_lot::Mutex;

    /// What the fake API server answers.
    #[derive(Clone, Copy, PartialEq)]
    pub(crate) enum Reply {
        /// A Status with this code.
        Status(u16),
        /// Lists: one pod (named after the list's ordinal); watches: an open stream with no events.
        Pods,
    }

    /// A response body that sends its bytes, then stays open when `open` (an idle watch).
    struct TestBody {
        data: Option<bytes::Bytes>,
        open: bool,
    }

    impl http_body::Body for TestBody {
        type Data = bytes::Bytes;
        type Error = std::convert::Infallible;

        fn poll_frame(
            mut self: std::pin::Pin<&mut Self>,
            _cx: &mut std::task::Context<'_>,
        ) -> std::task::Poll<Option<Result<http_body::Frame<bytes::Bytes>, Self::Error>>> {
            match self.data.take() {
                Some(d) => std::task::Poll::Ready(Some(Ok(http_body::Frame::data(d)))),
                None if self.open => std::task::Poll::Pending,
                None => std::task::Poll::Ready(None),
            }
        }
    }

    /// Request log of the fake server.
    #[derive(Default)]
    pub(crate) struct Server {
        pub lists: AtomicUsize,
        pub watches: AtomicUsize,
        pub uris: Mutex<Vec<String>>,
    }

    /// A fake API server: `reply(n)` decides the answer to the n-th list request (from 0); watches get
    /// the answer of the latest list (an idle stream when it succeeded).
    pub(crate) fn fake(server: Arc<Server>, reply: impl Fn(usize) -> Reply + Send + Sync + 'static) -> Client {
        let svc = tower::service_fn(move |req: http::Request<kube::client::Body>| {
            let uri = req.uri().to_string();
            server.uris.lock().push(uri.clone());
            let watch = uri.contains("watch=true");
            let n = if watch { server.lists.load(Ordering::SeqCst).saturating_sub(1) } else { server.lists.fetch_add(1, Ordering::SeqCst) };
            if watch {
                server.watches.fetch_add(1, Ordering::SeqCst);
            }
            let (status, body, open) = match reply(n) {
                Reply::Status(code) => (
                    code,
                    format!(r#"{{"kind":"Status","apiVersion":"v1","status":"Failure","message":"failed with {code}","reason":"R{code}","code":{code}}}"#),
                    false,
                ),
                Reply::Pods if watch => (200, String::new(), true),
                Reply::Pods => (
                    200,
                    format!(
                        r#"{{"kind":"PodList","apiVersion":"v1","metadata":{{"resourceVersion":"{n}0"}},"items":[{{"metadata":{{"name":"pod-{n}","namespace":"default","uid":"uid-{n}","resourceVersion":"{n}0"}}}}]}}"#
                    ),
                    false,
                ),
            };
            async move {
                Ok::<_, std::convert::Infallible>(
                    http::Response::builder()
                        .status(status)
                        .header("content-type", "application/json")
                        .body(TestBody { data: Some(bytes::Bytes::from(body)), open })
                        .unwrap(),
                )
            }
        });
        Client::new(svc, "default")
    }

    /// Discovery entry of pods.
    pub(crate) fn pods() -> crate::discovery::ResourceInfo {
        crate::discovery::ResourceInfo {
            key: "pods".into(),
            group: String::new(),
            version: "v1".into(),
            kind: "Pod".into(),
            plural: "pods".into(),
            singular: "pod".into(),
            namespaced: true,
            verbs: ["get", "list", "watch"].map(String::from).to_vec(),
            short_names: vec!["po".into()],
            categories: Vec::new(),
            subresources: Vec::new(),
        }
    }
}
