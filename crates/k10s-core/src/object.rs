//! `Obj`: a lean dynamic Kubernetes object.
//!
//! `kube::core::DynamicObject` deserializes through `#[serde(flatten)]`, which buffers every object
//! into an intermediate tree first. `Obj` parses straight into one `serde_json::Value`, skips
//! `metadata.managedFields` while parsing (often half of an object's size: never built at all) and keeps
//! only the few typed metadata fields the watcher machinery needs.
//!
//! Nesting is bounded: serde_json refuses documents nested deeper than 128 levels, and a list counts as one
//! document — a single custom resource with deeply nested `x-kubernetes-preserve-unknown-fields` data (Helm
//! values, say) failed the list it came in, again and again, for everyone watching that resource. Values
//! nested deeper than [`MAX_DEPTH`] levels inside an object are skipped without recursion (serde_json's
//! iterative `ignore_value`) and replaced by [`TOO_DEEP`], so such an object is listed, marked
//! ([`Obj::truncated`]), and the rest of its list with it.

use std::borrow::Cow;
use std::cell::Cell;
use std::fmt;

use k8s_openapi::apimachinery::pkg::apis::meta::v1::ObjectMeta;
use kube::core::{ApiResource, DynamicResourceScope, Resource};
use serde::de::{DeserializeSeed, IgnoredAny, MapAccess, SeqAccess, Visitor};
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::{Map, Number, Value};

/// Levels of nesting kept below an object's root. Leaves room within serde_json's limit of 128 for what
/// wraps the object (a list and its `items`, a watch event).
pub const MAX_DEPTH: usize = 100;
/// Stands in for a value nested deeper than [`MAX_DEPTH`].
pub const TOO_DEEP: &str = "<k10s: nested too deeply to show>";

#[derive(Clone, Debug, Default)]
pub struct Obj {
    meta: ObjectMeta,
    pub raw: Value,
    /// Some values were nested too deeply and replaced by [`TOO_DEEP`].
    truncated: bool,
}

impl Obj {
    pub fn from_value(mut raw: Value, keep_managed_fields: bool) -> Self {
        if !keep_managed_fields && let Some(m) = raw.get_mut("metadata").and_then(Value::as_object_mut) {
            m.remove("managedFields");
        }
        let md = raw.get("metadata");
        let s = |k: &str| md.and_then(|m| m.get(k)).and_then(Value::as_str).map(str::to_owned);
        let meta = ObjectMeta { name: s("name"), namespace: s("namespace"), uid: s("uid"), resource_version: s("resourceVersion"), ..Default::default() };
        Self { meta, raw, truncated: false }
    }

    pub fn name(&self) -> &str {
        self.meta.name.as_deref().unwrap_or_default()
    }

    pub fn namespace(&self) -> Option<&str> {
        self.meta.namespace.as_deref()
    }

    pub fn uid(&self) -> &str {
        self.meta.uid.as_deref().unwrap_or_default()
    }

    pub fn resource_version(&self) -> &str {
        self.meta.resource_version.as_deref().unwrap_or_default()
    }

    /// An object taken out of a [`BoundedValue`] (a server-printed table, say); `cut`: that value was cut
    /// somewhere — then this object counts as [`Obj::truncated`] if the cut is in it.
    pub fn from_bounded(raw: Value, cut: bool) -> Self {
        let mut obj = Obj::from_value(raw, false);
        obj.truncated = cut && holds_too_deep(&obj.raw);
        obj
    }

    /// Values nested deeper than [`MAX_DEPTH`] levels were left out (each replaced by [`TOO_DEEP`]).
    pub fn truncated(&self) -> bool {
        self.truncated
    }

    /// List items come without `apiVersion`/`kind`; fill them in so YAML/JSON views are complete.
    pub fn ensure_type_meta(&mut self, ar: &ApiResource) {
        if let Some(map) = self.raw.as_object_mut() {
            if !map.contains_key("apiVersion") {
                map.insert("apiVersion".into(), Value::String(ar.api_version.clone()));
            }
            if !map.contains_key("kind") {
                map.insert("kind".into(), Value::String(ar.kind.clone()));
            }
        }
    }
}

impl<'de> Deserialize<'de> for Obj {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let truncated = Cell::new(false);
        let raw = Bounded { depth: 0, at: At::Root, truncated: &truncated }.deserialize(d)?;
        let mut obj = Obj::from_value(raw, false);
        obj.truncated = truncated.get();
        Ok(obj)
    }
}

/// Any JSON value, parsed with nesting bounded by [`MAX_DEPTH`] (see the module docs). For whoever parses
/// objects outside of [`Obj`] (a list read as a plain value): `.0` is the value, `.1` whether it was cut.
pub struct BoundedValue(pub Value, pub bool);

impl<'de> Deserialize<'de> for BoundedValue {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let truncated = Cell::new(false);
        let v = Bounded { depth: 0, at: At::Other, truncated: &truncated }.deserialize(d)?;
        Ok(BoundedValue(v, truncated.get()))
    }
}

/// Whether `v` holds the [`TOO_DEEP`] placeholder somewhere (iteratively; only asked when something was cut).
fn holds_too_deep(v: &Value) -> bool {
    let mut stack = vec![v];
    while let Some(v) = stack.pop() {
        match v {
            Value::String(s) if s == TOO_DEEP => return true,
            Value::Object(m) => stack.extend(m.values()),
            Value::Array(a) => stack.extend(a),
            _ => {}
        }
    }
    false
}

/// Where in the object a value is: `managedFields` is skipped only as `metadata.managedFields`.
#[derive(Clone, Copy, PartialEq)]
enum At {
    Root,
    Metadata,
    Other,
}

/// Builds a `Value` like serde_json's own visitor, one nesting level per call (bounded by [`MAX_DEPTH`]).
struct Bounded<'a> {
    depth: usize,
    at: At,
    truncated: &'a Cell<bool>,
}

impl<'a> Bounded<'a> {
    fn child(&self, at: At) -> Bounded<'a> {
        Bounded { depth: self.depth + 1, at, truncated: self.truncated }
    }

    fn cut(&self) -> Value {
        self.truncated.set(true);
        Value::String(TOO_DEEP.into())
    }
}

impl<'de> DeserializeSeed<'de> for Bounded<'_> {
    type Value = Value;

    fn deserialize<D: Deserializer<'de>>(self, d: D) -> Result<Value, D::Error> {
        d.deserialize_any(self)
    }
}

impl<'de> Visitor<'de> for Bounded<'_> {
    type Value = Value;

    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("any JSON value")
    }

    fn visit_bool<E>(self, v: bool) -> Result<Value, E> {
        Ok(Value::Bool(v))
    }

    fn visit_i64<E>(self, v: i64) -> Result<Value, E> {
        Ok(Value::Number(v.into()))
    }

    fn visit_u64<E>(self, v: u64) -> Result<Value, E> {
        Ok(Value::Number(v.into()))
    }

    fn visit_f64<E>(self, v: f64) -> Result<Value, E> {
        Ok(Number::from_f64(v).map_or(Value::Null, Value::Number))
    }

    fn visit_str<E>(self, v: &str) -> Result<Value, E> {
        Ok(Value::String(v.to_owned()))
    }

    fn visit_string<E>(self, v: String) -> Result<Value, E> {
        Ok(Value::String(v))
    }

    fn visit_none<E>(self) -> Result<Value, E> {
        Ok(Value::Null)
    }

    fn visit_unit<E>(self) -> Result<Value, E> {
        Ok(Value::Null)
    }

    fn visit_some<D: Deserializer<'de>>(self, d: D) -> Result<Value, D::Error> {
        self.deserialize(d)
    }

    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Value, A::Error> {
        if self.depth >= MAX_DEPTH {
            // Skipped without recursion: serde_json ignores values iteratively, whatever their depth.
            while seq.next_element::<IgnoredAny>()?.is_some() {}
            return Ok(self.cut());
        }
        let mut out = Vec::with_capacity(seq.size_hint().unwrap_or(0).min(1024));
        while let Some(v) = seq.next_element_seed(self.child(At::Other))? {
            out.push(v);
        }
        Ok(Value::Array(out))
    }

    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Value, A::Error> {
        if self.depth >= MAX_DEPTH {
            while map.next_entry::<IgnoredAny, IgnoredAny>()?.is_some() {}
            return Ok(self.cut());
        }
        let mut out = Map::new();
        while let Some(key) = map.next_key::<String>()? {
            let at = match (self.at, key.as_str()) {
                (At::Metadata, "managedFields") => {
                    map.next_value::<IgnoredAny>()?;
                    continue;
                }
                (At::Root, "metadata") => At::Metadata,
                _ => At::Other,
            };
            let v = map.next_value_seed(self.child(at))?;
            out.insert(key, v);
        }
        Ok(Value::Object(out))
    }
}

impl Serialize for Obj {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        self.raw.serialize(s)
    }
}

impl Resource for Obj {
    type DynamicType = ApiResource;
    type Scope = DynamicResourceScope;

    fn group(dt: &ApiResource) -> Cow<'_, str> {
        dt.group.as_str().into()
    }

    fn version(dt: &ApiResource) -> Cow<'_, str> {
        dt.version.as_str().into()
    }

    fn kind(dt: &ApiResource) -> Cow<'_, str> {
        dt.kind.as_str().into()
    }

    fn api_version(dt: &ApiResource) -> Cow<'_, str> {
        dt.api_version.as_str().into()
    }

    fn plural(dt: &ApiResource) -> Cow<'_, str> {
        dt.plural.as_str().into()
    }

    fn meta(&self) -> &ObjectMeta {
        &self.meta
    }

    fn meta_mut(&mut self) -> &mut ObjectMeta {
        &mut self.meta
    }
}

/// Reference to a single object in a single cluster, as passed from the UI.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ObjectRef {
    pub cluster: String,
    /// Resource key (`deployments.apps`) or anything discovery can resolve (`deploy`).
    pub resource: String,
    #[serde(default)]
    pub namespace: Option<String>,
    pub name: String,
    #[serde(default)]
    pub uid: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use kube::core::{ObjectList, WatchEvent};
    use serde_json::json;

    /// `{"values":{"a":{"a":…}}}`, `depth` maps deep, as text (a `Value` that deep could not even be dropped
    /// without recursing that deep).
    fn nested(depth: usize) -> String {
        format!(r#"{{"values":{}"leaf"{}}}"#, r#"{"a":"#.repeat(depth), "}".repeat(depth))
    }

    fn widget(name: &str, spec: &str) -> String {
        format!(
            r#"{{"apiVersion":"example.com/v1","kind":"Widget","metadata":{{"name":"{name}","namespace":"default","uid":"uid-{name}","resourceVersion":"7","managedFields":[{{"manager":"helm","fieldsV1":{{"f:spec":{{}}}}}}]}},"spec":{spec}}}"#
        )
    }

    /// How deep `v` goes (iteratively: `v` may be deep).
    fn depth(v: &Value) -> usize {
        let mut stack = vec![(v, 0)];
        let mut max = 0;
        while let Some((v, d)) = stack.pop() {
            max = max.max(d);
            match v {
                Value::Object(m) => stack.extend(m.values().map(|c| (c, d + 1))),
                Value::Array(a) => stack.extend(a.iter().map(|c| (c, d + 1))),
                _ => {}
            }
        }
        max
    }

    #[test]
    fn one_deeply_nested_object_does_not_fail_its_list() {
        // serde_json alone refuses the list (what used to fail the whole feed, again and again).
        let list = format!(
            r#"{{"kind":"WidgetList","apiVersion":"example.com/v1","metadata":{{"resourceVersion":"9"}},"items":[{},{},{}]}}"#,
            widget("a", "{}"),
            widget("deep", &nested(10_000)),
            widget("c", r#"{"x":1}"#)
        );
        assert!(serde_json::from_str::<Value>(&list).unwrap_err().to_string().contains("recursion limit"));

        let list: ObjectList<Obj> = serde_json::from_str(&list).unwrap();
        let names: Vec<(&str, bool)> = list.items.iter().map(|o| (o.name(), o.truncated())).collect();
        assert_eq!(names, [("a", false), ("deep", true), ("c", false)]);
        let deep = &list.items[1].raw;
        // Cut at the bound, where the placeholder says so; the rest of the object is intact.
        assert_eq!(depth(deep), MAX_DEPTH);
        assert_eq!(deep.pointer(&format!("/spec/values{}", "/a".repeat(MAX_DEPTH - 2))), Some(&json!(TOO_DEEP)));
        assert_eq!((deep["metadata"]["uid"].as_str(), deep["metadata"].get("managedFields")), (Some("uid-deep"), None));
        assert_eq!(list.items[2].raw["spec"], json!({"x": 1}));
    }

    #[test]
    fn deep_objects_in_watch_events_and_single_reads_are_cut_too() {
        let event = format!(r#"{{"type":"MODIFIED","object":{}}}"#, widget("deep", &nested(500)));
        let WatchEvent::Modified(obj) = serde_json::from_str::<WatchEvent<Obj>>(&event).unwrap() else { panic!("not a modification") };
        assert!(obj.truncated() && depth(&obj.raw) == MAX_DEPTH);
        // Arrays count as levels too.
        let arrays = format!(r#"{{"metadata":{{"name":"x"}},"spec":{}1{}}}"#, "[".repeat(300), "]".repeat(300));
        let obj: Obj = serde_json::from_str(&arrays).unwrap();
        assert!(obj.truncated() && depth(&obj.raw) == MAX_DEPTH);
        // Anything shallower is exactly what serde_json parses (without managedFields).
        let text = widget("w", &nested(MAX_DEPTH - 3));
        let obj: Obj = serde_json::from_str(&text).unwrap();
        let mut plain: Value = serde_json::from_str(&text).unwrap();
        plain["metadata"].as_object_mut().unwrap().remove("managedFields");
        assert!(!obj.truncated());
        assert_eq!(obj.raw, plain);
        assert_eq!(depth(&obj.raw), MAX_DEPTH - 1);
    }

    #[test]
    fn only_metadata_managed_fields_are_skipped() {
        let text = r#"{"metadata":{"name":"x","managedFields":[{"manager":"m"}]},"spec":{"managedFields":"kept"},"status":{"metadata":{"managedFields":1}}}"#;
        let obj: Obj = serde_json::from_str(text).unwrap();
        assert_eq!(obj.raw, json!({"metadata": {"name": "x"}, "spec": {"managedFields": "kept"}, "status": {"metadata": {"managedFields": 1}}}));
        let BoundedValue(v, cut) = serde_json::from_str(&format!(r#"{{"items":[{}]}}"#, nested(1_000))).unwrap();
        assert!(cut && depth(&v) == MAX_DEPTH);
    }

    /// Parsing a list of typical pods with `Obj` (bounded, `managedFields` skipped) against serde_json's own
    /// `Value` (what `Obj` did before): `cargo test --release -p k10s-core parse_speed -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn parse_speed() {
        let items: Vec<Value> = (0..10_000).map(crate::feed::tests::typical_pod).collect();
        let list = serde_json::to_string(&json!({"kind": "PodList", "apiVersion": "v1", "metadata": {"resourceVersion": "1"}, "items": items})).unwrap();
        let time = |f: &dyn Fn()| {
            let mut best = std::time::Duration::MAX;
            for _ in 0..5 {
                let t = std::time::Instant::now();
                f();
                best = best.min(t.elapsed());
            }
            best
        };
        let bounded = time(&|| assert_eq!(serde_json::from_str::<ObjectList<Obj>>(&list).unwrap().items.len(), 10_000));
        let plain = time(&|| {
            let list: ObjectList<Value> = serde_json::from_str(&list).unwrap();
            let objs: Vec<Obj> = list.items.into_iter().map(|v| Obj::from_value(v, false)).collect();
            assert_eq!(objs.len(), 10_000);
        });
        eprintln!("10k pods ({} MB): Obj {bounded:?}, Value + strip {plain:?}", list.len() >> 20);
    }
}
