//! Small, allocation-light helpers for reading `serde_json::Value` trees.

use serde_json::Value;

pub trait JsonExt {
    fn at(&self, path: &[&str]) -> Option<&Value>;

    fn str_at(&self, path: &[&str]) -> Option<&str> {
        self.at(path).and_then(Value::as_str)
    }

    fn i64_at(&self, path: &[&str]) -> Option<i64> {
        self.at(path).and_then(|v| v.as_i64().or_else(|| v.as_f64().map(|f| f as i64)))
    }

    fn bool_at(&self, path: &[&str]) -> Option<bool> {
        self.at(path).and_then(Value::as_bool)
    }

    /// Array at `path`, or an empty slice.
    fn arr(&self, path: &[&str]) -> &[Value] {
        self.at(path).and_then(Value::as_array).map_or(&[], Vec::as_slice)
    }

    /// Object at `path` as an iterator of (key, value).
    fn entries(&self, path: &[&str]) -> Box<dyn Iterator<Item = (&String, &Value)> + '_> {
        match self.at(path).and_then(Value::as_object) {
            Some(m) => Box::new(m.iter()),
            None => Box::new(std::iter::empty()),
        }
    }

    fn len_at(&self, path: &[&str]) -> usize {
        match self.at(path) {
            Some(Value::Object(m)) => m.len(),
            Some(Value::Array(a)) => a.len(),
            _ => 0,
        }
    }
}

impl JsonExt for Value {
    #[inline]
    fn at(&self, path: &[&str]) -> Option<&Value> {
        let mut cur = self;
        for key in path {
            cur = cur.as_object()?.get(*key)?;
        }
        Some(cur)
    }
}

/// `k=v,k2=v2` for a label/selector map (sorted, as kubectl prints).
pub fn join_map(v: Option<&Value>) -> Option<String> {
    let m = v?.as_object()?;
    if m.is_empty() {
        return None;
    }
    Some(m.iter().map(|(k, v)| format!("{k}={}", v.as_str().unwrap_or_default())).collect::<Vec<_>>().join(","))
}

/// Joins an iterator of strings with `,`; `None` if empty.
pub fn join<'a>(it: impl IntoIterator<Item = &'a str>) -> Option<String> {
    let mut out = String::new();
    for s in it {
        if s.is_empty() {
            continue;
        }
        if !out.is_empty() {
            out.push(',');
        }
        out.push_str(s);
    }
    (!out.is_empty()).then_some(out)
}

/// Parses a Kubernetes quantity (`100m`, `1.5Gi`, `2e3`, `512Mi`) into a float of base units.
pub fn parse_quantity(q: &str) -> Option<f64> {
    const KI: f64 = 1024.0;
    // Binary suffixes first so `Mi` is not mistaken for `M`; exponent forms (`1e3`) end in a digit.
    const SUFFIXES: &[(&str, f64)] = &[
        ("Ki", KI),
        ("Mi", KI * KI),
        ("Gi", KI * KI * KI),
        ("Ti", KI * KI * KI * KI),
        ("Pi", KI * KI * KI * KI * KI),
        ("Ei", KI * KI * KI * KI * KI * KI),
        ("n", 1e-9),
        ("u", 1e-6),
        ("m", 1e-3),
        ("k", 1e3),
        ("M", 1e6),
        ("G", 1e9),
        ("T", 1e12),
        ("P", 1e15),
        ("E", 1e18),
    ];
    let q = q.trim();
    for (suffix, mult) in SUFFIXES {
        if let Some(num) = q.strip_suffix(suffix) {
            return num.parse::<f64>().ok().map(|n| n * mult);
        }
    }
    q.parse().ok()
}

/// Access-mode short names as kubectl prints them.
pub fn access_modes(v: &Value) -> Option<String> {
    let modes = v.as_array()?;
    join(modes.iter().filter_map(Value::as_str).map(|m| match m {
        "ReadWriteOnce" => "RWO",
        "ReadOnlyMany" => "ROX",
        "ReadWriteMany" => "RWX",
        "ReadWriteOncePod" => "RWOP",
        other => other,
    }))
}

/// Truncates a list of items for display: `a,b,c + 5 more...`
pub fn truncate_list(items: &[String], max: usize) -> Option<String> {
    if items.is_empty() {
        return None;
    }
    if items.len() <= max {
        return Some(items.join(","));
    }
    Some(format!("{} + {} more...", items[..max].join(","), items.len() - max))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quantities() {
        assert_eq!(parse_quantity("100m"), Some(0.1));
        assert_eq!(parse_quantity("2"), Some(2.0));
        assert_eq!(parse_quantity("1Gi"), Some(1073741824.0));
        assert_eq!(parse_quantity("1.5k"), Some(1500.0));
        assert_eq!(parse_quantity("1e3"), Some(1000.0));
        assert_eq!(parse_quantity("2E"), Some(2e18));
        assert_eq!(parse_quantity("abc"), None);
    }
}
