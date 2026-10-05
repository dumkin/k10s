//! The JSONPath subset Kubernetes uses for CRD `additionalPrinterColumns` (and `kubectl -o jsonpath`):
//! `.a.b`, `['a.b']`, `[0]`, `[-1]`, `[*]`, `.*`, `[?(@.type=="Ready")]`, `[?(@.x)]`, escaped dots (`a\.b`),
//! optional `$` and surrounding `{…}`.

use serde_json::Value;

#[derive(Debug, Clone, PartialEq)]
enum Seg {
    Key(String),
    Index(i64),
    Wildcard,
    Filter { path: Vec<String>, op: Option<(bool, Value)> },
}

#[derive(Debug, Clone, PartialEq)]
pub struct JsonPath(Vec<Seg>);

impl JsonPath {
    pub fn parse(src: &str) -> Result<Self, String> {
        let mut s = src.trim();
        if let Some(inner) = s.strip_prefix('{').and_then(|x| x.strip_suffix('}')) {
            s = inner.trim();
        }
        s = s.strip_prefix('$').unwrap_or(s);
        let b: Vec<char> = s.chars().collect();
        let mut i = 0;
        let mut segs = Vec::new();
        while i < b.len() {
            match b[i] {
                '.' => {
                    i += 1;
                    if b.get(i) == Some(&'.') {
                        return Err("recursive descent (..) is not supported".into());
                    }
                    if b.get(i) == Some(&'*') {
                        segs.push(Seg::Wildcard);
                        i += 1;
                        continue;
                    }
                    let (name, next) = read_name(&b, i);
                    if name.is_empty() {
                        if i >= b.len() {
                            break; // trailing "." as in "{.}"
                        }
                        return Err(format!("expected a field name at {i}"));
                    }
                    segs.push(Seg::Key(name));
                    i = next;
                }
                '[' => {
                    let end = find_bracket_end(&b, i).ok_or("unterminated [")?;
                    let inner: String = b[i + 1..end].iter().collect();
                    segs.push(parse_bracket(inner.trim())?);
                    i = end + 1;
                }
                c if c.is_whitespace() => i += 1,
                _ => {
                    // A bare leading name (`metadata.name`) — be lenient like kubectl.
                    let (name, next) = read_name(&b, i);
                    if name.is_empty() {
                        return Err(format!("unexpected '{}' at {i}", b[i]));
                    }
                    segs.push(Seg::Key(name));
                    i = next;
                }
            }
        }
        Ok(JsonPath(segs))
    }

    /// All matches, in document order.
    pub fn eval<'a>(&self, root: &'a Value) -> Vec<&'a Value> {
        let mut cur = vec![root];
        for seg in &self.0 {
            let mut next = Vec::with_capacity(cur.len());
            for v in cur {
                match seg {
                    Seg::Key(k) => {
                        if let Some(x) = v.get(k.as_str()) {
                            next.push(x);
                        }
                    }
                    Seg::Index(n) => {
                        if let Some(a) = v.as_array() {
                            let idx = if *n < 0 { a.len() as i64 + n } else { *n };
                            if let Some(x) = usize::try_from(idx).ok().and_then(|i| a.get(i)) {
                                next.push(x);
                            }
                        }
                    }
                    Seg::Wildcard => match v {
                        Value::Array(a) => next.extend(a.iter()),
                        Value::Object(m) => next.extend(m.values()),
                        _ => {}
                    },
                    Seg::Filter { path, op } => {
                        if let Some(a) = v.as_array() {
                            for item in a {
                                let target = path.iter().try_fold(item, |acc, k| acc.get(k.as_str()));
                                let keep = match (target, op) {
                                    (Some(t), Some((eq, lit))) => loose_eq(t, lit) == *eq,
                                    (None, Some((eq, _))) => !*eq,
                                    (Some(t), None) => !t.is_null(),
                                    (None, None) => false,
                                };
                                if keep {
                                    next.push(item);
                                }
                            }
                        }
                    }
                }
            }
            cur = next;
            if cur.is_empty() {
                break;
            }
        }
        cur
    }

    pub fn first<'a>(&self, root: &'a Value) -> Option<&'a Value> {
        self.eval(root).into_iter().next()
    }
}

fn read_name(b: &[char], mut i: usize) -> (String, usize) {
    let mut name = String::new();
    while i < b.len() {
        match b[i] {
            '\\' if i + 1 < b.len() => {
                name.push(b[i + 1]);
                i += 2;
            }
            '.' | '[' | ' ' | '}' => break,
            c => {
                name.push(c);
                i += 1;
            }
        }
    }
    (name, i)
}

fn find_bracket_end(b: &[char], start: usize) -> Option<usize> {
    let mut depth = 0;
    let mut quote: Option<char> = None;
    for (i, &c) in b.iter().enumerate().skip(start) {
        match (quote, c) {
            (Some(q), c) if c == q => quote = None,
            (Some(_), _) => {}
            (None, '\'' | '"') => quote = Some(c),
            (None, '[') => depth += 1,
            (None, ']') => {
                depth -= 1;
                if depth == 0 {
                    return Some(i);
                }
            }
            _ => {}
        }
    }
    None
}

fn unquote(s: &str) -> Option<&str> {
    let s = s.trim();
    s.strip_prefix('\'').and_then(|x| x.strip_suffix('\'')).or_else(|| s.strip_prefix('"').and_then(|x| x.strip_suffix('"')))
}

fn parse_bracket(inner: &str) -> Result<Seg, String> {
    if inner == "*" {
        return Ok(Seg::Wildcard);
    }
    if let Some(name) = unquote(inner) {
        return Ok(Seg::Key(name.to_string()));
    }
    if let Ok(n) = inner.parse::<i64>() {
        return Ok(Seg::Index(n));
    }
    let filter = inner.strip_prefix("?(").and_then(|x| x.strip_suffix(')')).ok_or_else(|| format!("unsupported selector [{inner}]"))?;
    let filter = filter.trim();
    let (lhs, op) = if let Some((l, r)) = filter.split_once("==") {
        (l, Some((true, parse_literal(r.trim())?)))
    } else if let Some((l, r)) = filter.split_once("!=") {
        (l, Some((false, parse_literal(r.trim())?)))
    } else {
        (filter, None)
    };
    let rel = lhs.trim().strip_prefix('@').ok_or_else(|| format!("filter must start with @: {filter}"))?;
    let path = rel.split('.').filter(|p| !p.is_empty()).map(str::to_string).collect();
    Ok(Seg::Filter { path, op })
}

fn parse_literal(s: &str) -> Result<Value, String> {
    if let Some(q) = unquote(s) {
        return Ok(Value::String(q.to_string()));
    }
    serde_json::from_str(s).map_err(|_| format!("bad literal {s}"))
}

fn loose_eq(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => x.as_f64() == y.as_f64(),
        (Value::String(x), Value::Number(y)) | (Value::Number(y), Value::String(x)) => x.parse::<f64>().ok() == y.as_f64(),
        _ => a == b,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn first(path: &str, v: &Value) -> Option<Value> {
        JsonPath::parse(path).unwrap().first(v).cloned()
    }

    #[test]
    fn printer_column_paths() {
        let v = json!({
            "metadata": {"labels": {"app.kubernetes.io/name": "web"}},
            "spec": {"replicas": 3, "containers": [{"image": "a"}, {"image": "b"}]},
            "status": {"conditions": [{"type": "Synced", "status": "True"}, {"type": "Ready", "status": "False", "reason": "Boom"}]}
        });
        assert_eq!(first(".spec.replicas", &v), Some(json!(3)));
        assert_eq!(first("{.spec.replicas}", &v), Some(json!(3)));
        assert_eq!(first("$.spec.containers[1].image", &v), Some(json!("b")));
        assert_eq!(first(".spec.containers[-1].image", &v), Some(json!("b")));
        assert_eq!(first(".spec.containers[*].image", &v), Some(json!("a")));
        assert_eq!(first(r#".status.conditions[?(@.type=="Ready")].status"#, &v), Some(json!("False")));
        assert_eq!(first(".status.conditions[?(@.type=='Ready')].reason", &v), Some(json!("Boom")));
        assert_eq!(first(r#".status.conditions[?(@.type!="Ready")].type"#, &v), Some(json!("Synced")));
        assert_eq!(first(r".metadata.labels.app\.kubernetes\.io/name", &v), Some(json!("web")));
        assert_eq!(first(".metadata.labels['app.kubernetes.io/name']", &v), Some(json!("web")));
        assert_eq!(first(".status.missing", &v), None);
        assert!(JsonPath::parse("..x").is_err());
    }
}
