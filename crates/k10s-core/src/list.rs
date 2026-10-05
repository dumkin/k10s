//! Lists that are fast on every network, for the feeds' watches ([`crate::watch`]).
//!
//! A first page of [`FIRST_PAGE`] objects puts rows on screen after one round trip and tells how big an object is
//! and how many are left. The rest comes in pages of about [`PAGE_BYTES`] of JSON, at least [`PARTS`] of them so
//! that the API server prepares them in parallel; each is asked for as soon as the page before it told its continue
//! token (it comes first in a page, before the objects), [`WINDOW`] at most at once. Every page is parsed while it
//! streams in, one object at a time: memory stays flat whatever the size of the list, and objects reach the feed
//! while the rest of their page is still on its way.
//!
//! Measured against an API server (Kubernetes 1.36) holding 100,000 namespaces, behind a link that delays and caps
//! the traffic, time to the whole list:
//!
//! | link              | pages of 500 in turn | one request | streaming list (watch) | this   |
//! |-------------------|----------------------|-------------|------------------------|--------|
//! | localhost         | 1.09 s               | 0.37 s      | 1.23 s                 | 0.17 s |
//! | 50 ms, 50 Mbit/s  | 13.6 s               | 0.80 s      | 10.0 s                 | 0.9 s  |
//! | 150 ms, 10 Mbit/s | 37.5 s               | 3.76 s      | 49.6 s                 | 4.1 s  |
//!
//! One request is no answer either: the API server ends a request after a minute (`--request-timeout`), which a big
//! list over a slow link can take, again on every retry; older API servers build the whole answer in memory. A
//! streaming list is not compressed (61.8 MB against 4.4).
//!
//! Every page reads the list as of its first page (the continue token says which version): it is consistent. A
//! continue token that expired meanwhile (etcd compacted it) fails the list, which then starts over.

use std::io;
use std::pin::pin;
use std::sync::Arc;

use futures::AsyncBufReadExt;
use k8s_openapi::apimachinery::pkg::apis::meta::v1::ListMeta;
use kube::Client;
use kube::core::Request;
use kube::core::params::ListParams;
use kube::runtime::watcher;
use serde_json::Value;
use tokio::sync::{mpsc, oneshot};
use tokio::task::{JoinHandle, JoinSet};

use crate::object::{BoundedValue, Obj};
use crate::render::table::{self, Arrangement};

/// Objects in the first page.
const FIRST_PAGE: u32 = 500;
/// JSON in each further page, about (~1.5 MB on the wire: seconds even over a slow link, far from the API server's
/// request timeout).
const PAGE_BYTES: usize = 16 << 20;
/// The rest of a list comes in at least this many pages, which the API server prepares in parallel…
const PARTS: usize = 3;
/// …and at most this many are asked for at once.
const WINDOW: usize = 3;
/// What an object is taken to weigh when the first page held none.
const GUESS_BYTES: usize = 4096;
/// Objects handed over at once.
const BATCH: usize = 128;
/// Batches waiting for the watch at most: pages wait (and with them the network) while it is behind.
const QUEUED: usize = 4;

/// What a list tells its watch, in this order: objects (pages interleave), then whether it worked.
pub(crate) enum Listed {
    Objects(Vec<Obj>),
    /// All in: the version to watch from, how the cells of a table's rows lined up.
    Done {
        rv: String,
        arrangement: Arrangement,
    },
    Failed(watcher::Error),
}

/// What to list: `layout` lists a server-printed table (see [`table::watcher`]).
pub(crate) struct Target {
    pub client: Client,
    pub url: String,
    pub labels: Option<String>,
    pub fields: Option<String>,
    pub layout: Option<Arc<[String]>>,
}

/// Lists `target` (see the module docs); the list stops when the receiver or the handle is dropped.
pub(crate) fn start(target: Arc<Target>) -> (mpsc::Receiver<Listed>, Running) {
    let (tx, rx) = mpsc::channel(QUEUED);
    let task = tokio::spawn(async move {
        let outcome = match list(&target, &tx).await {
            Ok((rv, arrangement)) => Listed::Done { rv, arrangement },
            Err(e) => Listed::Failed(e),
        };
        let _ = tx.send(outcome).await;
    });
    (rx, Running(task))
}

/// A list going on; dropping it stops it, and the pages it asked for.
pub(crate) struct Running(JoinHandle<()>);

impl Drop for Running {
    fn drop(&mut self) {
        self.0.abort();
    }
}

async fn list(target: &Arc<Target>, tx: &mpsc::Sender<Listed>) -> Result<(String, Arrangement), watcher::Error> {
    let failed = watcher::Error::InitialListFailed;
    let first = page(target.clone(), None, FIRST_PAGE, tx.clone(), None).await.map_err(failed)?;
    // Every page is of the version of the first: that is where the watch starts.
    let rv = first.rv.clone().ok_or(watcher::Error::NoResourceVersion)?;
    let mut arrangement = first.arrangement.clone();
    let limit = next_limit(&first);
    let mut pages: JoinSet<kube::Result<Page>> = JoinSet::new();
    let mut next = first.cont;
    let joined = |r: Result<kube::Result<Page>, tokio::task::JoinError>| r.map_err(|e| kube::Error::Service(Box::new(e))).and_then(|r| r);
    while let Some(cont) = next.take() {
        while pages.len() >= WINDOW {
            let Some(done) = pages.join_next().await else { break };
            arrangement = joined(done).map_err(failed)?.arrangement;
        }
        let (told, token) = oneshot::channel();
        pages.spawn(page(target.clone(), Some(cont), limit, tx.clone(), Some(told)));
        // The page's own continue token comes before its objects; a page that fails tells none, and its error is
        // collected below.
        next = token.await.ok().flatten();
    }
    while let Some(done) = pages.join_next().await {
        arrangement = joined(done).map_err(failed)?.arrangement;
    }
    Ok((rv, arrangement))
}

/// Objects per page after the first (see the module docs).
fn next_limit(first: &Page) -> u32 {
    let per = first.bytes.checked_div(first.objects).map_or(GUESS_BYTES, |b| b.max(1));
    let limit = match first.remaining {
        Some(rest) => rest.div_ceil(rest.saturating_mul(per).div_ceil(PAGE_BYTES).max(PARTS)),
        None => PAGE_BYTES / per,
    };
    u32::try_from(limit).unwrap_or(u32::MAX).max(FIRST_PAGE)
}

/// One page as it went: its list metadata, how many objects it held and their JSON's length.
#[derive(Default)]
struct Page {
    rv: Option<String>,
    cont: Option<String>,
    remaining: Option<usize>,
    objects: usize,
    bytes: usize,
    arrangement: Arrangement,
}

/// Asks for a page and parses it while it streams in: its objects go to `tx` in batches, its continue token to
/// `told` as soon as it is read.
async fn page(
    target: Arc<Target>,
    cont: Option<String>,
    limit: u32,
    tx: mpsc::Sender<Listed>,
    mut told: Option<oneshot::Sender<Option<String>>>,
) -> kube::Result<Page> {
    let lp = ListParams {
        label_selector: target.labels.clone(),
        field_selector: target.fields.clone(),
        limit: Some(limit),
        continue_token: cont,
        ..Default::default()
    };
    let mut req = Request::new(&target.url).list(&lp).map_err(kube::Error::BuildRequest)?;
    if target.layout.is_some() {
        req = table::as_table(req, "Object");
    }
    req.extensions_mut().insert("list");
    let mut body = pin!(target.client.request_stream(req).await?);
    let mut split = Splitter::default();
    let mut p = Page::default();
    let mut batch = Vec::with_capacity(BATCH);
    let gone = || kube::Error::ReadEvents(io::Error::other("the list was stopped"));
    loop {
        let chunk = body.fill_buf().await.map_err(kube::Error::ReadEvents)?;
        if chunk.is_empty() {
            break;
        }
        let n = chunk.len();
        split.feed(chunk, |piece| take(piece, &target, &mut p, &mut batch, &mut told))?;
        body.as_mut().consume_unpin(n);
        if batch.len() >= BATCH {
            tx.send(Listed::Objects(std::mem::replace(&mut batch, Vec::with_capacity(BATCH)))).await.map_err(|_| gone())?;
        }
    }
    split.finish()?;
    if !batch.is_empty() {
        tx.send(Listed::Objects(batch)).await.map_err(|_| gone())?;
    }
    if let Some(told) = told {
        let _ = told.send(p.cont.clone());
    }
    Ok(p)
}

/// One piece of a page: its metadata, its column definitions (a table), an object.
fn take(piece: Piece<'_>, target: &Target, p: &mut Page, batch: &mut Vec<Obj>, told: &mut Option<oneshot::Sender<Option<String>>>) -> kube::Result<()> {
    match piece {
        Piece::Field("metadata", json) => {
            let meta: ListMeta = serde_json::from_slice(json).map_err(kube::Error::SerdeError)?;
            p.rv = meta.resource_version.filter(|v| !v.is_empty());
            p.cont = meta.continue_.filter(|c| !c.is_empty());
            p.remaining = meta.remaining_item_count.and_then(|n| usize::try_from(n).ok());
            if let Some(told) = told.take() {
                let _ = told.send(p.cont.clone());
            }
        }
        Piece::Field("columnDefinitions", json) => {
            if let Some(layout) = &target.layout {
                let defs: Vec<Value> = serde_json::from_slice(json).map_err(kube::Error::SerdeError)?;
                p.arrangement = table::arrange(&defs, layout);
            }
        }
        // Items that are not a list: what the server sent cannot be read (a list without items says `null`).
        Piece::Field("items" | "rows", json) if json != b"null" => {
            serde_json::from_slice::<Vec<Value>>(json).map_err(kube::Error::SerdeError)?;
        }
        Piece::Field(..) => {}
        Piece::Item("items", json) => {
            batch.push(serde_json::from_slice::<Obj>(json).map_err(kube::Error::SerdeError)?);
            p.objects += 1;
            p.bytes += json.len();
        }
        Piece::Item(_, json) => {
            let BoundedValue(row, cut) = serde_json::from_slice(json).map_err(kube::Error::SerdeError)?;
            if let Some((obj, _)) = table::object(row, p.arrangement.map.as_deref(), cut) {
                batch.push(obj);
            }
            p.objects += 1;
            p.bytes += json.len();
        }
    }
    Ok(())
}

/// A piece of a list: a field of its top-level object, whole (`metadata`…), or an element of its `items` (a table's
/// `rows`).
#[derive(Debug, PartialEq)]
pub(crate) enum Piece<'a> {
    Field(&'a str, &'a [u8]),
    Item(&'a str, &'a [u8]),
}

/// Splits a list as its bytes arrive: hands over each element of its `items` (or `rows`) as soon as it is complete
/// and each other field of the top-level object whole. Only the structure is read (strings, nesting), iteratively:
/// however deep an object nests, it is passed on as it is (its parser bounds the depth, see [`Obj`]).
#[derive(Default)]
pub(crate) struct Splitter {
    buf: Vec<u8>,
    /// Read up to here.
    pos: usize,
    /// Where the token or value being read starts.
    start: usize,
    at: At,
    /// The top-level key whose value is being read.
    key: String,
    /// In the value being read: its nesting, whether in a string of it (just after a backslash), whether it is a
    /// number or a literal.
    depth: usize,
    string: bool,
    escaped: bool,
    bare: bool,
}

#[derive(Default, Clone, Copy, PartialEq, Debug)]
enum At {
    /// Before the top-level `{`.
    #[default]
    Start,
    /// Before a key of the top-level object (or its `}`).
    Key,
    InKey,
    Colon,
    /// Before a value of the top-level object.
    Value,
    InValue,
    /// In `items`: before an element, `,` or `]`.
    Items,
    InItem,
    /// After a value of the top-level object: `,` or `}`.
    Next,
    End,
}

impl Splitter {
    /// Reads `chunk`, the next bytes of the list; `on` gets every piece it completes.
    pub(crate) fn feed(&mut self, chunk: &[u8], mut on: impl FnMut(Piece<'_>) -> kube::Result<()>) -> kube::Result<()> {
        self.buf.extend_from_slice(chunk);
        loop {
            let reading = matches!(self.at, At::InKey | At::InValue | At::InItem);
            if !reading {
                while self.pos < self.buf.len() && self.buf[self.pos].is_ascii_whitespace() {
                    self.pos += 1;
                }
            }
            if self.pos == self.buf.len() {
                break;
            }
            let c = self.buf[self.pos];
            match self.at {
                At::Start => self.expect(c, b'{', At::Key)?,
                At::Key if c == b'}' => self.expect(c, b'}', At::End)?,
                At::Key if c == b'"' => self.begin(At::InKey),
                At::Colon => self.expect(c, b':', At::Value)?,
                At::Value if c == b'[' && (self.key == "items" || self.key == "rows") => self.expect(c, b'[', At::Items)?,
                At::Value => self.begin(At::InValue),
                At::Items if c == b']' => self.expect(c, b']', At::Next)?,
                At::Items if c == b',' => self.pos += 1,
                At::Items => self.begin(At::InItem),
                At::Next if c == b',' => self.expect(c, b',', At::Key)?,
                At::Next => self.expect(c, b'}', At::End)?,
                At::InKey | At::InValue | At::InItem => {
                    if !self.scan() {
                        break;
                    }
                    let (key, json) = (&self.key, &self.buf[self.start..self.pos]);
                    match self.at {
                        At::InKey => {
                            self.key = String::from_utf8_lossy(&json[1..json.len() - 1]).into_owned();
                            self.at = At::Colon;
                        }
                        At::InValue => {
                            on(Piece::Field(key, json))?;
                            self.at = At::Next;
                        }
                        _ => {
                            on(Piece::Item(key, json))?;
                            self.at = At::Items;
                        }
                    }
                }
                At::Key | At::End => return Err(Self::error(&format!("unexpected `{}` in a list", c as char))),
            }
        }
        // What was read is dropped; a token or value not complete yet stays.
        let keep = if matches!(self.at, At::InKey | At::InValue | At::InItem) { self.start } else { self.pos };
        if keep > 0 {
            self.buf.drain(..keep);
            self.pos -= keep;
            self.start -= keep.min(self.start);
        }
        Ok(())
    }

    /// The list ended: an error unless it was whole (a connection cut short is worth another try).
    pub(crate) fn finish(&self) -> kube::Result<()> {
        if self.at == At::End { Ok(()) } else { Err(kube::Error::ReadEvents(io::Error::new(io::ErrorKind::UnexpectedEof, "the list ended early"))) }
    }

    fn expect(&mut self, c: u8, want: u8, then: At) -> kube::Result<()> {
        if c != want {
            return Err(Self::error(&format!("expected `{}` in a list, found `{}`", want as char, c as char)));
        }
        self.pos += 1;
        self.at = then;
        Ok(())
    }

    fn begin(&mut self, at: At) {
        self.at = at;
        self.start = self.pos;
        let first = self.buf[self.pos];
        self.bare = !matches!(first, b'"' | b'{' | b'[');
        self.string = first == b'"';
        self.escaped = false;
        self.depth = usize::from(matches!(first, b'{' | b'['));
        if !self.bare {
            self.pos += 1;
        }
    }

    /// Reads on in the token or value that started at `start`; whether it is complete (it ends at `pos`).
    fn scan(&mut self) -> bool {
        let buf = &self.buf;
        let mut i = self.pos;
        if self.bare {
            while i < buf.len() && !matches!(buf[i], b',' | b'}' | b']') && !buf[i].is_ascii_whitespace() {
                i += 1;
            }
            self.pos = i;
            return i < buf.len();
        }
        while i < buf.len() {
            let c = buf[i];
            i += 1;
            if self.string {
                if self.escaped {
                    self.escaped = false;
                } else if c == b'\\' {
                    self.escaped = true;
                } else if c == b'"' {
                    self.string = false;
                    if self.depth == 0 {
                        self.pos = i;
                        return true;
                    }
                }
            } else {
                match c {
                    b'"' => self.string = true,
                    b'{' | b'[' => self.depth += 1,
                    b'}' | b']' => {
                        self.depth -= 1;
                        if self.depth == 0 {
                            self.pos = i;
                            return true;
                        }
                    }
                    _ => {}
                }
            }
        }
        self.pos = i;
        false
    }

    /// What the API server sent is not a list (as a serde error: retrying cannot fix it).
    fn error(msg: &str) -> kube::Error {
        kube::Error::SerdeError(<serde_json::Error as serde::de::Error>::custom(msg))
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use parking_lot::Mutex;
    use serde_json::json;

    use super::*;
    use crate::render::table::fake;

    /// Splits `json` fed in chunks of `step` bytes: its fields by name, its items, whether it was whole.
    fn split_all(json: &[u8], step: usize) -> (HashMap<String, String>, Vec<String>, bool) {
        let mut split = Splitter::default();
        let mut fields = HashMap::new();
        let mut items = Vec::new();
        for chunk in json.chunks(step.max(1)) {
            split
                .feed(chunk, |piece| {
                    match piece {
                        Piece::Field(k, v) => {
                            fields.insert(k.to_string(), String::from_utf8_lossy(v).into_owned());
                        }
                        Piece::Item(k, v) => items.push(format!("{k}:{}", String::from_utf8_lossy(v))),
                    }
                    Ok(())
                })
                .unwrap();
        }
        (fields, items, split.finish().is_ok())
    }

    #[test]
    fn splits_a_list_wherever_its_chunks_end() {
        let list = br#" {"kind":"PodList","apiVersion":"v1","metadata":{"resourceVersion":"10","continue":"a\"b}"},
            "items":[ {"metadata":{"name":"a]{"}}, {"metadata":{"name":"b\\"},"spec":{"x":[1,{"y":"}"}]}} ] ,"extra":42 } "#;
        for step in [1, 2, 3, 7, 64, 4096] {
            let (fields, items, whole) = split_all(list, step);
            assert!(whole, "step {step}");
            assert_eq!(fields["kind"], r#""PodList""#);
            assert_eq!(fields["metadata"], r#"{"resourceVersion":"10","continue":"a\"b}"}"#);
            assert_eq!(fields["extra"], "42");
            assert_eq!(items, [r#"items:{"metadata":{"name":"a]{"}}"#, r#"items:{"metadata":{"name":"b\\"},"spec":{"x":[1,{"y":"}"}]}}"#], "step {step}");
        }
    }

    #[test]
    fn rows_of_a_table_are_items_too_and_empty_lists_are_whole() {
        let (fields, items, whole) = split_all(br#"{"kind":"Table","columnDefinitions":[{"name":"Name"}],"rows":[{"cells":["a"]}],"metadata":{}}"#, 5);
        assert!(whole);
        assert_eq!(fields["columnDefinitions"], r#"[{"name":"Name"}]"#);
        assert_eq!(items, [r#"rows:{"cells":["a"]}"#]);
        let (_, items, whole) = split_all(br#"{"items":[],"metadata":{"resourceVersion":"1"}}"#, 1);
        assert!(whole && items.is_empty());
        // Items that are not a list are a field (which the page cannot read, see `take`).
        let (fields, items, _) = split_all(br#"{"items":{"not":"a list"}}"#, 3);
        assert_eq!((fields["items"].as_str(), items.len()), (r#"{"not":"a list"}"#, 0));
    }

    #[test]
    fn a_list_cut_short_or_malformed_is_an_error() {
        let (_, items, whole) = split_all(br#"{"metadata":{},"items":[{"a":1},{"b":"#, 4);
        assert!(!whole);
        assert_eq!(items, [r#"items:{"a":1}"#]);
        let mut split = Splitter::default();
        let err = split.feed(br#"["not","an","object"]"#, |_| Ok(())).unwrap_err();
        assert!(err.to_string().contains("expected `{`"), "{err}");
    }

    #[test]
    fn deeply_nested_items_are_passed_on_without_recursion() {
        let deep = format!(r#"{{"items":[{}1{}]}}"#, "[".repeat(100_000), "]".repeat(100_000));
        let (_, items, whole) = split_all(deep.as_bytes(), 1000);
        assert!(whole);
        assert_eq!(items.len(), 1);
    }

    #[test]
    fn later_pages_hold_about_page_bytes_in_at_least_parts() {
        let page = |objects, bytes, remaining| Page { objects, bytes, remaining, ..Default::default() };
        // 100,000 namespaces of ~350 bytes: three pages of the rest, prepared in parallel.
        assert_eq!(next_limit(&page(500, 175_000, Some(99_500))), 33_167);
        // 50,000 pods of ~3 KB: pages of about 16 MB.
        let limit = next_limit(&page(500, 1_500_000, Some(49_500)));
        assert!((4_900..=5_600).contains(&limit), "{limit}");
        // A small rest still fits one page; with no count (selectors), pages of about 16 MB.
        assert_eq!(next_limit(&page(500, 175_000, Some(300))), FIRST_PAGE);
        assert_eq!(next_limit(&page(500, 1_500_000, None)), 5_592);
        assert_eq!(next_limit(&page(0, 0, None)), 4_096);
    }

    /// A page of pods as the API server writes it: its metadata (with the continue token) before its items.
    fn pods(names: impl IntoIterator<Item = String>, rv: &str, cont: Option<String>, remaining: Option<usize>) -> String {
        let items: Vec<String> = names
            .into_iter()
            .map(|n| {
                json!({"metadata": {"name": n, "namespace": "default", "uid": format!("uid-{n}"), "resourceVersion": rv, "managedFields": [{"manager": "x"}]}})
                    .to_string()
            })
            .collect();
        let mut meta = json!({"resourceVersion": rv});
        if let Some(c) = cont {
            meta["continue"] = json!(c);
        }
        if let Some(r) = remaining {
            meta["remainingItemCount"] = json!(r);
        }
        format!(r#"{{"kind":"PodList","apiVersion":"v1","metadata":{meta},"items":[{}]}}"#, items.join(","))
    }

    /// A server of `n` pods that pages as asked (`limit`, `continue` = the index to go on from).
    fn paging_server(n: usize, log: fake::Log) -> Client {
        fake::server(log, move |uri, _| {
            let q = |k: &str| uri.split(['?', '&']).find_map(|p| p.strip_prefix(&format!("{k}="))).map(str::to_string);
            let from: usize = q("continue").and_then(|c| c.parse().ok()).unwrap_or(0);
            let limit: usize = q("limit").and_then(|l| l.parse().ok()).unwrap_or(usize::MAX);
            let to = n.min(from.saturating_add(limit));
            let cont = (to < n).then(|| to.to_string());
            fake::Reply::json(pods((from..to).map(|i| format!("pod-{i:05}")), "7", cont, (to < n).then_some(n - to)))
        })
    }

    fn target(client: Client) -> Arc<Target> {
        Arc::new(Target { client, url: "/api/v1/pods".into(), labels: None, fields: None, layout: None })
    }

    async fn collect(rx: &mut mpsc::Receiver<Listed>) -> Result<(Vec<String>, String), String> {
        let mut names = Vec::new();
        while let Some(m) = rx.recv().await {
            match m {
                Listed::Objects(objs) => names.extend(objs.iter().map(|o| o.name().to_string())),
                Listed::Done { rv, .. } => return Ok((names, rv)),
                Listed::Failed(e) => return Err(e.to_string()),
            }
        }
        Err("ended without a word".into())
    }

    #[tokio::test]
    async fn lists_a_first_page_then_the_rest_in_bigger_pages() {
        let log: fake::Log = Arc::default();
        let (mut rx, _running) = start(target(paging_server(2_000, log.clone())));
        let (mut names, rv) = collect(&mut rx).await.unwrap();
        assert_eq!(rv, "7");
        names.sort();
        assert_eq!(names.len(), 2_000);
        names.dedup();
        assert_eq!(names.len(), 2_000, "each pod once");
        let uris: Vec<String> = log.lock().iter().map(|(u, _)| u.clone()).collect();
        // 500 first, then the 1,500 left in pages of 500 (three parts, none smaller than the first).
        assert_eq!(uris.len(), 4, "{uris:?}");
        assert!(uris[0].ends_with("?&limit=500"), "{uris:?}");
        assert!(uris[1..].iter().all(|u| u.contains("limit=500&continue=")), "{uris:?}");
        // No resourceVersion: a consistent list, of the version the continue tokens carry.
        assert!(uris.iter().all(|u| !u.contains("resourceVersion")), "{uris:?}");
    }

    #[tokio::test]
    async fn a_page_that_fails_fails_the_list_and_objects_skip_managed_fields() {
        let calls = Arc::new(AtomicUsize::new(0));
        let c = calls.clone();
        let client = fake::server(Arc::default(), move |_, _| match c.fetch_add(1, Ordering::SeqCst) {
            0 => fake::Reply::json(pods(["a".to_string()], "3", Some("1".into()), Some(5))),
            _ => fake::Reply::status(410),
        });
        let (mut rx, _running) = start(target(client));
        let mut seen = Vec::new();
        let err = loop {
            match rx.recv().await.unwrap() {
                Listed::Objects(objs) => seen.extend(objs),
                Listed::Done { .. } => panic!("listed"),
                Listed::Failed(e) => break e,
            }
        };
        assert!(matches!(&err, watcher::Error::InitialListFailed(kube::Error::Api(s)) if s.code == 410), "{err:?}");
        assert_eq!(seen.len(), 1);
        assert!(seen[0].raw["metadata"].get("managedFields").is_none());
    }

    #[tokio::test]
    async fn a_list_cut_short_is_worth_another_try_and_one_without_version_is_not_a_list() {
        let client =
            fake::server(Arc::default(), |_, _| fake::Reply::json(r#"{"kind":"PodList","metadata":{"resourceVersion":"3"},"items":[{"metadata":{"name":"a"}"#));
        let (mut rx, _running) = start(target(client));
        let err = collect(&mut rx).await.unwrap_err();
        assert!(err.contains("ended early"), "{err}");
        let client = fake::server(Arc::default(), |_, _| fake::Reply::json(r#"{"kind":"PodList","metadata":{},"items":[]}"#));
        let (mut rx, _running) = start(target(client));
        assert!(matches!(rx.recv().await, Some(Listed::Failed(watcher::Error::NoResourceVersion))));
    }

    /// A body that sends `head` at once and `tail` only once `open` says so.
    struct Gated {
        head: Option<bytes::Bytes>,
        tail: Option<bytes::Bytes>,
        open: Box<dyn Fn() -> bool + Send>,
        wakers: Arc<Mutex<Vec<std::task::Waker>>>,
    }

    impl http_body::Body for Gated {
        type Data = bytes::Bytes;
        type Error = std::convert::Infallible;

        fn poll_frame(
            mut self: std::pin::Pin<&mut Self>,
            cx: &mut std::task::Context<'_>,
        ) -> std::task::Poll<Option<Result<http_body::Frame<bytes::Bytes>, Self::Error>>> {
            use std::task::Poll;
            if let Some(head) = self.head.take() {
                return Poll::Ready(Some(Ok(http_body::Frame::data(head))));
            }
            if self.tail.is_some() && !(self.open)() {
                self.wakers.lock().push(cx.waker().clone());
                if !(self.open)() {
                    return Poll::Pending;
                }
            }
            Poll::Ready(self.tail.take().map(|t| Ok(http_body::Frame::data(t))))
        }
    }

    #[tokio::test]
    async fn the_next_page_is_asked_for_before_the_one_before_it_is_read() {
        // Each page after the first sends its metadata at once and its objects only once the page after it was asked
        // for: a list that waited for a page before asking for the next one would never end.
        let asked = Arc::new(Mutex::new(Vec::<usize>::new()));
        let wakers = Arc::new(Mutex::new(Vec::<std::task::Waker>::new()));
        let (a, w) = (asked.clone(), wakers.clone());
        let svc = tower::service_fn(move |req: http::Request<kube::client::Body>| {
            let from: usize = req.uri().query().unwrap_or_default().split("continue=").nth(1).and_then(|c| c.parse().ok()).unwrap_or(0);
            a.lock().push(from);
            for waker in w.lock().drain(..) {
                waker.wake();
            }
            let to = (from + 500).min(2_000);
            let page = pods((from..to).map(|i| format!("pod-{i:05}")), "7", (to < 2_000).then(|| to.to_string()), Some(2_000 - to));
            let at = page.find(r#""items":["#).unwrap() + 9;
            let asked = a.clone();
            let gated = from > 0 && to < 2_000;
            let body = Gated {
                head: Some(bytes::Bytes::from(page[..at].to_string())),
                tail: Some(bytes::Bytes::from(page[at..].to_string())),
                open: Box::new(move || !gated || asked.lock().contains(&to)),
                wakers: w.clone(),
            };
            async move { Ok::<_, std::convert::Infallible>(http::Response::builder().status(200).header("content-type", "application/json").body(body).unwrap()) }
        });
        let (mut rx, _running) = start(target(Client::new(svc, "default")));
        let (names, _) = tokio::time::timeout(std::time::Duration::from_secs(5), collect(&mut rx)).await.expect("the list waited for each page").unwrap();
        assert_eq!(names.len(), 2_000);
        assert_eq!(*asked.lock(), [0, 500, 1_000, 1_500]);
    }

    #[tokio::test]
    async fn tables_are_listed_as_rows_with_their_cells_arranged() {
        use crate::render::table::tests::{definitions, row, table};
        let defs = definitions(&[("Ready", "string", 0)]);
        let d = defs.clone();
        let log: fake::Log = Arc::default();
        let client = fake::server(log.clone(), move |_, _| fake::Reply::json(table(Some(&d), &[row("a", "10", &[json!("True")])], "10").to_string()));
        let layout = crate::render::table::ServerColumns::from_definitions(defs.as_array().unwrap()).unwrap().layout();
        let (mut rx, _running) =
            start(Arc::new(Target { client, url: "/apis/example.com/v1/widgets".into(), labels: None, fields: None, layout: Some(layout) }));
        let mut cells = Vec::new();
        while let Some(m) = rx.recv().await {
            match m {
                Listed::Objects(objs) => cells.extend(objs.iter().map(|o| o.raw[table::CELLS].to_string())),
                Listed::Done { .. } => break,
                Listed::Failed(e) => panic!("{e}"),
            }
        }
        assert_eq!(cells, [r#"["a","True","640d"]"#]);
        assert!(log.lock().iter().all(|(u, accept)| u.contains("includeObject=Object") && accept.contains("as=Table")));
    }
}
