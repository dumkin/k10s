//! The watches behind the feeds: a list ([`crate::list`]), then a watch resumed from the last resourceVersion
//! whenever the server ends it, a fresh list after `410 Gone` — the events and errors of kube's `watcher`, so that a
//! feed treats both alike.
//!
//! Objects come as they are or, with a `layout`, as server-printed table rows (see [`crate::render::table`]): each
//! object then carries its cells under [`CELLS`](crate::render::table::CELLS), arranged as `layout` names the
//! columns (a table whose columns changed meanwhile is rearranged by name).

use std::collections::VecDeque;
use std::io;
use std::sync::Arc;
use std::time::Duration;

use futures::stream::BoxStream;
use futures::{AsyncBufReadExt, Stream, StreamExt};
use kube::Api;
use kube::core::params::WatchParams;
use kube::core::{Request, Status};
use kube::runtime::watcher::{self, Event};
use serde::Deserialize;
use serde_json::Value;

use crate::list::{self, Listed};
use crate::object::{BoundedValue, Obj};
use crate::render::table::{self, Arrangement};
use crate::render::util::JsonExt;

/// A watch that stays silent this much longer than the server's timeout is considered dead (as kube does).
const IDLE_MARGIN: Duration = Duration::from_secs(5);

/// Lists and watches what `api` names (see the module docs); `config` gives its selectors and the watch timeout.
pub fn watcher(api: Api<Obj>, config: watcher::Config, layout: Option<Arc<[String]>>) -> impl Stream<Item = Result<Event<Obj>, watcher::Error>> + Send {
    let target = list::Target {
        url: api.resource_url().to_string(),
        client: api.into_client(),
        labels: config.label_selector.clone(),
        fields: config.field_selector.clone(),
        layout,
    };
    let ctx = Arc::new(Ctx { target: Arc::new(target), config });
    futures::stream::unfold((ctx, State::Empty), |(ctx, state)| async move {
        let (event, state) = step(&ctx, state).await;
        Some((event, (ctx, state)))
    })
}

struct Ctx {
    target: Arc<list::Target>,
    config: watcher::Config,
}

/// A watch event as the server sent it. (kube's `WatchEvent` keeps only the resourceVersion of a BOOKMARK,
/// whose table may carry the watch's column definitions.)
enum Raw {
    /// ADDED or MODIFIED (`deleted: false`), DELETED, of a table's rows; `cut`: nested too deeply somewhere (see
    /// [`BoundedValue`]).
    Rows {
        deleted: bool,
        table: Value,
        cut: bool,
    },
    /// The same of an object.
    Object {
        deleted: bool,
        obj: Box<Obj>,
    },
    Bookmark(Value),
    Error(Box<Status>),
}

type Events = BoxStream<'static, kube::Result<Raw>>;

enum State {
    Empty,
    /// The list goes on: objects it handed over wait in `queue`; `done` once it is all in.
    Listing {
        rx: tokio::sync::mpsc::Receiver<Listed>,
        _running: list::Running,
        queue: VecDeque<Obj>,
        done: Option<(String, Arrangement)>,
    },
    Listed {
        rv: String,
        arrangement: Arrangement,
    },
    /// `headed`: this watch sent column definitions.
    Watching {
        rv: String,
        stream: Events,
        arrangement: Arrangement,
        headed: bool,
        queue: VecDeque<Event<Obj>>,
    },
}

impl Ctx {
    async fn watch(&self, rv: &str) -> kube::Result<Events> {
        let c = &self.config;
        let wp = WatchParams {
            label_selector: c.label_selector.clone(),
            field_selector: c.field_selector.clone(),
            timeout: c.timeout,
            bookmarks: c.bookmarks,
            ..Default::default()
        };
        let mut req = Request::new(&self.target.url).watch(&wp, rv).map_err(kube::Error::BuildRequest)?;
        let rows = self.target.layout.is_some();
        if rows {
            req = table::as_table(req, "Object");
        }
        req.extensions_mut().insert("watch");
        let lines = self.target.client.request_stream(req).await?.lines();
        Ok(lines
            .filter_map(move |line| async move {
                match line {
                    Ok(line) => raw_event(&line, rows),
                    // A connection cut short (as kube's own watches): the watch ends and is resumed.
                    Err(e) if matches!(e.kind(), io::ErrorKind::TimedOut | io::ErrorKind::UnexpectedEof) => None,
                    Err(e) => Some(Err(kube::Error::ReadEvents(e))),
                }
            })
            .boxed())
    }
}

/// One line of a watch (of table rows if `rows`): an event, a `Status` the server failed with, or nothing (an empty
/// or cut-off line, an event type this does not know).
fn raw_event(line: &str, rows: bool) -> Option<kube::Result<Raw>> {
    #[derive(Deserialize)]
    struct Line<T> {
        #[serde(rename = "type")]
        ty: String,
        object: T,
    }
    if line.trim().is_empty() {
        return None;
    }
    let failed = |e: serde_json::Error| {
        if e.is_eof() {
            return None;
        }
        Some(Err(serde_json::from_str::<Status>(line).map_or(kube::Error::SerdeError(e), |s| kube::Error::Api(s.boxed()))))
    };
    let status = |v: Value| match serde_json::from_value::<Status>(v) {
        Ok(s) => Some(Ok(Raw::Error(s.boxed()))),
        Err(e) => Some(Err(kube::Error::SerdeError(e))),
    };
    if rows {
        let Line { ty, object: BoundedValue(table, cut) } = match serde_json::from_str::<Line<BoundedValue>>(line) {
            Ok(l) => l,
            Err(e) => return failed(e),
        };
        return Some(Ok(match ty.as_str() {
            "ADDED" | "MODIFIED" => Raw::Rows { deleted: false, table, cut },
            "DELETED" => Raw::Rows { deleted: true, table, cut },
            "BOOKMARK" => Raw::Bookmark(table),
            "ERROR" => return status(table),
            _ => return None,
        }));
    }
    // Objects are parsed as such: their managedFields are skipped, not built (see [`Obj`]).
    let Line { ty, object: obj } = match serde_json::from_str::<Line<Obj>>(line) {
        Ok(l) => l,
        Err(e) => return failed(e),
    };
    Some(Ok(match ty.as_str() {
        "ADDED" | "MODIFIED" => Raw::Object { deleted: false, obj: Box::new(obj) },
        "DELETED" => Raw::Object { deleted: true, obj: Box::new(obj) },
        "BOOKMARK" => Raw::Bookmark(obj.raw),
        "ERROR" => return status(obj.raw),
        _ => return None,
    }))
}

async fn step(ctx: &Ctx, mut state: State) -> (Result<Event<Obj>, watcher::Error>, State) {
    loop {
        state = match state {
            State::Empty => {
                let (rx, running) = list::start(ctx.target.clone());
                return (Ok(Event::Init), State::Listing { rx, _running: running, queue: VecDeque::new(), done: None });
            }
            State::Listing { mut rx, _running, mut queue, done } => {
                if let Some(obj) = queue.pop_front() {
                    return (Ok(Event::InitApply(obj)), State::Listing { rx, _running, queue, done });
                }
                if let Some((rv, arrangement)) = done {
                    return (Ok(Event::InitDone), State::Listed { rv, arrangement });
                }
                match rx.recv().await {
                    Some(Listed::Objects(objs)) => State::Listing { rx, _running, queue: objs.into(), done: None },
                    Some(Listed::Done { rv, arrangement }) => State::Listing { rx, _running, queue, done: Some((rv, arrangement)) },
                    Some(Listed::Failed(e)) => return (Err(e), State::Empty),
                    None => return (Err(watcher::Error::InitialListFailed(kube::Error::ReadEvents(io::Error::other("the list stopped")))), State::Empty),
                }
            }
            State::Listed { rv, arrangement } => match ctx.watch(&rv).await {
                Ok(stream) => State::Watching { rv, stream, arrangement, headed: false, queue: VecDeque::new() },
                Err(e) => return (Err(watcher::Error::WatchStartFailed(e)), State::Listed { rv, arrangement }),
            },
            State::Watching { mut rv, mut stream, mut arrangement, mut headed, mut queue } => {
                if let Some(event) = queue.pop_front() {
                    return (Ok(event), State::Watching { rv, stream, arrangement, headed, queue });
                }
                let idle = Duration::from_secs(u64::from(ctx.config.timeout.unwrap_or(290))) + IDLE_MARGIN;
                // Silent for too long, a half-open connection (sleep, VPN switch): watch again, as when it ends.
                let event = tokio::time::timeout(idle, stream.next()).await.unwrap_or_default();
                match event {
                    Some(Ok(Raw::Object { deleted, obj })) => {
                        if obj.resource_version().is_empty() {
                            return (Err(watcher::Error::NoResourceVersion), State::Empty);
                        }
                        rv = obj.resource_version().to_string();
                        queue.push_back(if deleted { Event::Delete(*obj) } else { Event::Apply(*obj) });
                        State::Watching { rv, stream, arrangement, headed, queue }
                    }
                    Some(Ok(Raw::Rows { deleted, table, cut })) => {
                        let layout = ctx.target.layout.as_deref().unwrap_or_default();
                        let (objs, head, fits) = table::objects(table, layout, &mut arrangement, cut);
                        headed |= head;
                        if !fits && !headed {
                            // Rows of other columns than the list's, and the watch did not say which: the columns
                            // changed meanwhile. A fresh list says (and rearranges them).
                            tracing::debug!(url = %ctx.target.url, "printed columns changed during the watch; listing again");
                            State::Empty
                        } else {
                            for obj in objs {
                                if obj.resource_version().is_empty() {
                                    return (Err(watcher::Error::NoResourceVersion), State::Empty);
                                }
                                rv = obj.resource_version().to_string();
                                queue.push_back(if deleted { Event::Delete(obj) } else { Event::Apply(obj) });
                            }
                            State::Watching { rv, stream, arrangement, headed, queue }
                        }
                    }
                    Some(Ok(Raw::Bookmark(t))) => {
                        // The first event of a watch carries its column definitions, a bookmark's table too.
                        if let Some(layout) = &ctx.target.layout
                            && let Some(defs) = table::definitions(&t)
                        {
                            arrangement = table::arrange(defs, layout);
                            headed = true;
                        }
                        // (A table without its resourceVersion must not make the next watch start from "now".)
                        if let Some(v) = t.str_at(&["metadata", "resourceVersion"]).filter(|v| !v.is_empty()) {
                            rv = v.to_string();
                        }
                        State::Watching { rv, stream, arrangement, headed, queue }
                    }
                    Some(Ok(Raw::Error(status))) => {
                        // 410 Gone: too far behind to resume, list again.
                        let next = if status.code == 410 { State::Empty } else { State::Watching { rv, stream, arrangement, headed, queue } };
                        return (Err(watcher::Error::WatchError(status)), next);
                    }
                    Some(Err(e)) => return (Err(watcher::Error::WatchFailed(e)), State::Watching { rv, stream, arrangement, headed, queue }),
                    // The server ended the watch (its timeout): resume where it was.
                    None => State::Listed { rv, arrangement },
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::render::table::fake;

    fn describe(e: Result<Event<Obj>, watcher::Error>) -> String {
        match e.unwrap() {
            Event::Init => "init".to_string(),
            Event::InitApply(o) => format!("list {}", o.name()),
            Event::InitDone => "listed".to_string(),
            Event::Apply(o) => format!("apply {} {}", o.name(), o.resource_version()),
            Event::Delete(o) => format!("delete {}", o.name()),
        }
    }

    fn pod(name: &str, rv: &str) -> Value {
        json!({"metadata": {"name": name, "namespace": "default", "uid": format!("uid-{name}"), "resourceVersion": rv, "managedFields": [{"manager": "x"}]}})
    }

    #[tokio::test]
    async fn lists_and_watches_objects_resuming_after_bookmarks() {
        let log: fake::Log = Arc::default();
        let client = fake::server(log.clone(), |uri, _| {
            if uri.contains("watch=true") {
                if uri.contains("resourceVersion=13") {
                    return fake::Reply::events(&[]);
                }
                let events = [
                    json!({"type": "ADDED", "object": pod("b", "11")}),
                    json!({"type": "MODIFIED", "object": pod("a", "12")}),
                    json!({"type": "BOOKMARK", "object": {"kind": "Pod", "apiVersion": "v1", "metadata": {"resourceVersion": "13"}}}),
                ];
                // The server ends the watch: it is resumed from the bookmark.
                return fake::Reply { status: 200, body: events.map(|e| e.to_string()).join("\n") + "\n", open: false };
            }
            fake::Reply::json(json!({"kind": "PodList", "apiVersion": "v1", "metadata": {"resourceVersion": "10"}, "items": [pod("a", "10")]}).to_string())
        });
        let api: Api<Obj> = Api::namespaced_with(client, "default", &kube::core::ApiResource::erase::<k8s_openapi::api::core::v1::Pod>(&()));
        let config = watcher::Config::default().timeout(55).labels("app=web");
        let events: Vec<String> = watcher(api, config, None).take(5).map(describe).collect().await;
        assert_eq!(events, ["init", "list a", "listed", "apply b 11", "apply a 12"]);
        tokio::time::sleep(Duration::from_millis(50)).await;
        let log = log.lock();
        assert!(log[0].0.contains("labelSelector=app%3Dweb") && log[0].0.contains("limit=500"), "{log:?}");
        assert!(log[1].0.contains("watch=true") && log[1].0.contains("resourceVersion=10") && log[1].0.contains("timeoutSeconds=55"), "{log:?}");
        assert!(log.iter().all(|(_, accept)| !accept.contains("as=Table")), "{log:?}");
    }

    #[test]
    fn watch_lines_of_objects_skip_managed_fields_and_tell_errors() {
        let line = json!({"type": "MODIFIED", "object": pod("a", "12")}).to_string();
        let Some(Ok(Raw::Object { deleted: false, obj })) = raw_event(&line, false) else { panic!() };
        assert!(obj.raw["metadata"].get("managedFields").is_none());
        let gone = json!({"type": "ERROR", "object": {"kind": "Status", "apiVersion": "v1", "status": "Failure", "message": "too old", "reason": "Expired", "code": 410}}).to_string();
        assert!(matches!(raw_event(&gone, false), Some(Ok(Raw::Error(s))) if s.code == 410));
        assert!(raw_event("", false).is_none());
        assert!(raw_event(r#"{"type":"ADDED","object":{"metadata":"#, false).is_none(), "cut off");
    }
}
