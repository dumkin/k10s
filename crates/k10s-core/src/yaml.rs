//! JSON → YAML emitter producing kubectl-style output: block literals (`|`) for multi-line strings,
//! compact sequences under mapping keys, and conservative quoting so the output round-trips.

use serde_json::Value;
use std::fmt::Write;

pub fn to_yaml(v: &Value) -> String {
    let mut out = String::with_capacity(4096);
    match v {
        Value::Object(m) if !m.is_empty() => write_map(&mut out, m, 0),
        Value::Array(a) if !a.is_empty() => write_seq(&mut out, a, 0),
        // A bare top-level block scalar has no parent indentation to be relative to (libyaml and the spec
        // disagree on what `|2` means there), so a document that is just a string is always quoted.
        Value::String(s) => {
            write_str(&mut out, s);
            out.push('\n');
        }
        other => {
            write_scalar(&mut out, other, 0);
            out.push('\n');
        }
    }
    out
}

fn indent(out: &mut String, n: usize) {
    out.extend(std::iter::repeat_n(' ', n));
}

/// Longest key (in bytes) written as an implicit `key:`. Parsers give up on an implicit key past 1024
/// characters; like go-yaml (so byte-for-byte as kubectl) anything over 128 becomes an explicit `? key`.
const MAX_SIMPLE_KEY: usize = 128;

fn write_map(out: &mut String, m: &serde_json::Map<String, Value>, ind: usize) {
    let mut first = true;
    for (k, v) in m {
        if !first {
            indent(out, ind);
        }
        first = false;
        if k.len() > MAX_SIMPLE_KEY {
            out.push_str("? ");
            write_key(out, k);
            out.push('\n');
            indent(out, ind);
            write_explicit_value(out, v, ind);
        } else {
            write_key(out, k);
            write_value_after_key(out, v, ind);
        }
    }
}

/// Writes `: v` on the line after an explicit `? key`, compact as go-yaml does: a collection starts on that line.
fn write_explicit_value(out: &mut String, v: &Value, ind: usize) {
    match v {
        Value::Object(m) if !m.is_empty() => {
            out.push_str(": ");
            write_map(out, m, ind + 2);
        }
        Value::Array(a) if !a.is_empty() => {
            out.push_str(": ");
            write_seq(out, a, ind + 2);
        }
        _ => write_value_after_key(out, v, ind),
    }
}

/// Writes `v` after `key:` — inline for scalars/empty collections, on following lines otherwise.
fn write_value_after_key(out: &mut String, v: &Value, ind: usize) {
    match v {
        Value::Object(m) if !m.is_empty() => {
            out.push_str(":\n");
            indent(out, ind + 2);
            write_map(out, m, ind + 2);
        }
        Value::Array(a) if !a.is_empty() => {
            // kubectl style: sequence items at the same indentation as the parent key.
            out.push_str(":\n");
            indent(out, ind);
            write_seq(out, a, ind);
        }
        _ => {
            out.push(':');
            if !is_block_string(v) {
                out.push(' ');
            }
            write_scalar(out, v, ind + 2);
            out.push('\n');
        }
    }
}

fn write_seq(out: &mut String, a: &[Value], ind: usize) {
    let mut first = true;
    for item in a {
        if !first {
            indent(out, ind);
        }
        first = false;
        out.push('-');
        match item {
            Value::Object(m) if !m.is_empty() => {
                out.push(' ');
                write_map(out, m, ind + 2);
            }
            Value::Array(inner) if !inner.is_empty() => {
                out.push(' ');
                write_seq(out, inner, ind + 2);
            }
            _ => {
                if !is_block_string(item) {
                    out.push(' ');
                }
                write_scalar(out, item, ind + 2);
                out.push('\n');
            }
        }
    }
}

fn write_key(out: &mut String, k: &str) {
    write_str(out, k);
}

/// A string on a single line: plain when that reads back as the same string, double-quoted otherwise.
fn write_str(out: &mut String, s: &str) {
    if is_plain_safe(s) { out.push_str(s) } else { write_quoted(out, s) }
}

/// Characters that must be escaped (so never appear in plain or block scalars): C0/C1 controls including
/// NEL, the Unicode line/paragraph separators (parsers treat them as line breaks), the BOM, and the
/// non-characters U+FFFE/U+FFFF that libyaml (go-yaml, kubectl) rejects in its input.
fn needs_escape(c: char) -> bool {
    c.is_control() || matches!(c, '\u{2028}' | '\u{2029}' | '\u{feff}' | '\u{fffe}' | '\u{ffff}')
}

fn is_block_string(v: &Value) -> bool {
    matches!(v, Value::String(s) if use_block(s))
}

fn use_block(s: &str) -> bool {
    s.contains('\n') && !s.chars().any(|c| c != '\n' && c != '\t' && needs_escape(c))
}

fn write_scalar(out: &mut String, v: &Value, block_indent: usize) {
    match v {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Number(n) => {
            let _ = write!(out, "{n}");
        }
        Value::String(s) if use_block(s) => write_block(out, s, block_indent),
        Value::String(s) => write_str(out, s),
        Value::Object(_) => out.push_str("{}"),
        Value::Array(_) => out.push_str("[]"),
    }
}

/// Literal block scalar whose content sits at `ind`, which is always the parent's indentation + 2.
fn write_block(out: &mut String, s: &str, ind: usize) {
    let content = s.trim_end_matches('\n');
    let trailing = s.len() - content.len();
    // Strip without a final newline, clip for exactly one, keep for more — and for a value that is only
    // newlines, where clip would read back as "".
    let chomp = match trailing {
        0 => "-",
        1 if !content.is_empty() => "",
        _ => "+",
    };
    out.push_str(" |");
    // Like go-yaml, state the indentation when the value starts with a space, tab or newline: auto-detection
    // would take the first line's own indentation (or that of leading empty lines) as the block's, and libyaml
    // rejects a tab there outright. The indicator is relative to the parent, so it is always 2 here.
    if s.starts_with([' ', '\t', '\n']) {
        out.push('2');
    }
    out.push_str(chomp);
    let body = if trailing > 0 { &s[..s.len() - 1] } else { s };
    for line in body.split('\n') {
        out.push('\n');
        if !line.is_empty() {
            indent(out, ind);
            out.push_str(line);
        }
    }
}

fn write_quoted(out: &mut String, s: &str) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\t' => out.push_str("\\t"),
            '\r' => out.push_str("\\r"),
            c if needs_escape(c) => {
                let _ = write!(out, "\\u{:04x}", c as u32);
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

/// Whether `s` can be emitted as a plain scalar without changing meaning (YAML 1.1 and 1.2).
fn is_plain_safe(s: &str) -> bool {
    let Some(first) = s.chars().next() else { return false };
    // `...` at the start of a line (a top-level key) can end the document.
    if s.starts_with(' ') || s.ends_with(' ') || s.ends_with(':') || s.starts_with("...") {
        return false;
    }
    if matches!(first, '-' | '?' | ':' | ',' | '[' | ']' | '{' | '}' | '#' | '&' | '*' | '!' | '|' | '>' | '\'' | '"' | '%' | '@' | '`') {
        // "-foo" is fine as plain in practice, but "- foo" / "-" are not; keep it simple and quote.
        return false;
    }
    if s.contains(": ") || s.contains(" #") || s.chars().any(needs_escape) {
        return false;
    }
    let lower = s.to_ascii_lowercase();
    if matches!(lower.as_str(), "true" | "false" | "yes" | "no" | "on" | "off" | "y" | "n" | "null" | "~" | ".inf" | "-.inf" | "+.inf" | ".nan" | "<<" | "=") {
        return false;
    }
    !looks_numeric_or_temporal(s)
}

/// Numbers (incl. hex/octal/binary/underscore/sexagesimal forms) and dates must be quoted to stay strings.
fn looks_numeric_or_temporal(s: &str) -> bool {
    if !s.starts_with(|c: char| c.is_ascii_digit() || matches!(c, '+' | '-' | '.')) {
        return false;
    }
    // go-yaml (behind kubectl) drops every `_` before parsing a number and takes Go's base prefixes in either
    // case: `+_1` is 1, `0_x1` is 0x1, `0X1F` is 31.
    let t = s.replace('_', "");
    let body = t.trim_start_matches(['+', '-']);
    let Some(first) = body.bytes().next() else { return false };
    if !(first.is_ascii_digit() || first == b'.') {
        return false;
    }
    let radix = body.get(..2).is_some_and(|p| ["0x", "0o", "0b"].iter().any(|r| p.eq_ignore_ascii_case(r)));
    if radix || t.parse::<f64>().is_ok() {
        return true;
    }
    // Timestamps (YYYY-M-D…), YAML 1.1 sexagesimals (1:30) and other digit-led number-ish strings (1e, 1-2).
    let b = s.as_bytes();
    if b.len() > 5 && b[..4].iter().all(u8::is_ascii_digit) && b[4] == b'-' && b[5].is_ascii_digit() {
        return true;
    }
    body.bytes().all(|c| c.is_ascii_digit() || matches!(c, b':' | b'.' | b'e' | b'E' | b'+' | b'-')) && body.bytes().filter(|c| *c == b'.').count() <= 1
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn kubectl_like_output() {
        // Keys are written pre-sorted so the test holds with and without serde_json's `preserve_order`.
        let v = json!({
            "apiVersion": "v1",
            "data": {"config.yaml": "a: 1\nb: 2\n", "date": "2024-01-01T00:00:00Z", "empty": "", "flag": "true", "ip": "10.0.0.1", "ver": "1.2"},
            "kind": "ConfigMap",
            "list": [{"name": "x", "ports": [80, 443]}, "plain", ["nested"]],
            "metadata": {"annotations": {}, "labels": {"app": "web"}, "name": "cfg", "resourceVersion": "123"},
            "n": 5,
            "nil": null
        });
        let y = to_yaml(&v);
        let expected = r#"apiVersion: v1
data:
  config.yaml: |
    a: 1
    b: 2
  date: "2024-01-01T00:00:00Z"
  empty: ""
  flag: "true"
  ip: 10.0.0.1
  ver: "1.2"
kind: ConfigMap
list:
- name: x
  ports:
  - 80
  - 443
- plain
- - nested
metadata:
  annotations: {}
  labels:
    app: web
  name: cfg
  resourceVersion: "123"
"n": 5
nil: null
"#;
        assert_eq!(y, expected);
    }

    #[test]
    fn block_chomping() {
        assert_eq!(to_yaml(&json!({"a": "x\ny"})), "a: |-\n  x\n  y\n");
        assert_eq!(to_yaml(&json!({"a": "x\n\n"})), "a: |+\n  x\n\n");
        assert_eq!(to_yaml(&json!({"a": "  x\ny"})), "a: |2-\n    x\n  y\n");
    }

    // Expected strings marked "kubectl" are byte-for-byte what kubectl itself prints (sigs.k8s.io/yaml JSONToYAML).
    #[test]
    fn block_indentation_indicator() {
        // Leading newline: without `2` the first content line's own indentation would become the block's.
        assert_eq!(to_yaml(&json!({"a": "\n  foo"})), "a: |2-\n\n    foo\n"); // kubectl
        assert_eq!(to_yaml(&json!({"a": "\n  foo\nbar"})), "a: |2-\n\n    foo\n  bar\n"); // kubectl
        assert_eq!(to_yaml(&json!({"a": "\n    \nfoo"})), "a: |2-\n\n      \n  foo\n");
        // A tab where libyaml auto-detects indentation is a parse error.
        assert_eq!(to_yaml(&json!({"a": "\tfoo\nbar"})), "a: |2-\n  \tfoo\n  bar\n");
        // The indicator is relative to the parent: same `2` under nested keys and in sequences.
        assert_eq!(to_yaml(&json!({"m": {"k": "\n  x\n"}})), "m:\n  k: |2\n\n      x\n"); // kubectl
        assert_eq!(to_yaml(&json!({"l": ["\n  foo", {"k": "\tx\ny"}, ["\n"]]})), "l:\n- |2-\n\n    foo\n- k: |2-\n    \tx\n    y\n- - |2+\n\n");
    }

    #[test]
    fn newline_only_values_keep_their_newlines() {
        assert_eq!(to_yaml(&json!({"a": "\n"})), "a: |2+\n\n"); // kubectl
        assert_eq!(to_yaml(&json!({"a": "\n\n"})), "a: |2+\n\n\n"); // kubectl
    }

    #[test]
    fn quotes_strings_that_parsers_read_as_numbers() {
        for s in [
            "0X1F",
            "0B101",
            "0O17",
            "0x_1F",
            "+_1",
            "-_1",
            "0_x1",
            "1_000",
            "1__0",
            "08",
            "1e3",
            "1E+3",
            ".5",
            "+.5",
            "1.",
            "1:30",
            "2024-1-2T1:2:3Z",
            "123456789012345678901234567890",
        ] {
            assert_eq!(to_yaml(&json!({"a": s})), format!("a: \"{s}\"\n"), "{s}");
        }
        for s in ["10.0.0.1", "1.2.3", "500m", "100Mi", "v1.30", ".dockerconfigjson", "_1", "+inf", "0-day"] {
            assert_eq!(to_yaml(&json!({"a": s})), format!("a: {s}\n"), "{s}");
        }
    }

    #[test]
    fn escapes_line_separators_and_noncharacters() {
        assert_eq!(to_yaml(&json!({"a": "x\u{2028}y\u{2029}\u{feff}\u{fffe}\u{ffff}\u{85}"})), "a: \"x\\u2028y\\u2029\\ufeff\\ufffe\\uffff\\u0085\"\n");
        // Parsers break lines at U+2028 too, so such a value is never a block literal.
        assert_eq!(to_yaml(&json!({"a": "x\ny\u{2028}"})), "a: \"x\\ny\\u2028\"\n");
    }

    #[test]
    fn long_keys_are_explicit() {
        let k128 = "k".repeat(128);
        assert_eq!(to_yaml(&json!({k128.clone(): 1})), format!("{k128}: 1\n")); // kubectl
        // libyaml rejects an implicit key past 1024 characters; over 128 bytes go-yaml writes `? key`.
        assert_eq!(to_yaml(&json!({"k".repeat(1000): 1})), format!("? {}\n: 1\n", "k".repeat(1000))); // kubectl
        let k = "k".repeat(1100);
        assert_eq!(to_yaml(&json!({k.clone(): 1})), format!("? {k}\n: 1\n"));
        assert_eq!(to_yaml(&json!({"m": {k.clone(): "x\ny"}})), format!("m:\n  ? {k}\n  : |-\n    x\n    y\n"));
        let k = "é".repeat(65);
        assert_eq!(
            to_yaml(&json!({"a": 1, k.clone(): {"b": "\n  x", "c": [1, {"d": 2}], "e": {}}})),
            format!("a: 1\n? {k}\n: b: |2-\n\n      x\n  c:\n  - 1\n  - d: 2\n  e: {{}}\n")
        ); // kubectl
        let k = "x: y".repeat(40);
        assert_eq!(to_yaml(&json!([{k.clone(): [[null]]}])), format!("- ? \"{k}\"\n  : - - null\n"));
    }

    #[test]
    fn top_level_scalars_and_document_markers() {
        assert_eq!(to_yaml(&json!("a\nb")), "\"a\\nb\"\n");
        assert_eq!(to_yaml(&json!("...")), "\"...\"\n");
        assert_eq!(to_yaml(&json!(5)), "5\n");
        assert_eq!(to_yaml(&json!({"---": 2, "... x": 1})), "\"---\": 2\n\"... x\": 1\n");
    }

    /// Every string made of up to three tricky pieces reads back unchanged.
    #[test]
    fn strings_round_trip_through_libyaml_rules() {
        const PIECES: [&str; 25] = [
            "", " ", "\t", "\n", "\r", "a", "x", "X", "0", "1", "_", ".", "e", "+", "-", "#", ": ", "'", "\"", "\\", "\u{85}", "\u{2028}", "\u{feff}",
            "\u{ffff}", "日",
        ];
        for a in PIECES {
            for b in PIECES {
                for c in PIECES {
                    let s = format!("{a}{b}{c}");
                    let y = to_yaml(&json!({"k": s}));
                    assert_eq!(read_back(&y).as_deref(), Some(s.as_str()), "{s:?} emitted as {y:?}");
                }
            }
        }
        let nginx = "\n    server {\n      listen 80;\n    }\n";
        assert_eq!(read_back(&to_yaml(&json!({"k": nginx}))).as_deref(), Some(nginx));
    }

    // A reader for `k: <scalar>` documents that follows libyaml (go-yaml, and so kubectl) rather than this
    // emitter: `None` is a parse error or a value that would not come back as this string.
    fn read_back(y: &str) -> Option<String> {
        // libyaml's reader rejects anything outside the YAML printable set.
        if !y.chars().all(|c| matches!(c, '\t' | '\n' | '\r' | ' '..='~' | '\u{85}' | '\u{a0}'..='\u{d7ff}' | '\u{e000}'..='\u{fffd}' | '\u{10000}'..)) {
            return None;
        }
        let v = y.strip_prefix("k:")?;
        if let Some(block) = v.strip_prefix(" |") {
            return read_literal(block);
        }
        let v = v.strip_prefix(' ')?.strip_suffix('\n')?;
        match v.strip_prefix('"') {
            Some(q) => read_double_quoted(q),
            None => read_plain(v),
        }
    }

    fn is_break(c: char) -> bool {
        matches!(c, '\n' | '\r' | '\u{85}' | '\u{2028}' | '\u{2029}')
    }

    /// `yaml_parser_scan_block_scalar` (literal style) for a value of a mapping at column 0.
    fn read_literal(s: &str) -> Option<String> {
        let (header, body) = s.split_once('\n')?;
        let mut indent = header.chars().find_map(|c| c.to_digit(10)).unwrap_or(0) as usize;
        let chomp = if header.contains('-') { -1 } else { i32::from(header.contains('+')) };
        let c: Vec<char> = body.chars().collect();
        let (mut i, mut col) = (0, 0);
        let (mut out, mut leading, mut trailing) = (String::new(), String::new(), String::new());
        scan_breaks(&c, &mut i, &mut col, &mut indent, &mut trailing)?;
        while col == indent && i < c.len() {
            out.push_str(&leading);
            out.push_str(&trailing);
            leading.clear();
            trailing.clear();
            while i < c.len() && !is_break(c[i]) {
                out.push(c[i]);
                i += 1;
            }
            if i < c.len() {
                leading.push('\n');
                (i, col) = (i + 1, 0);
            }
            scan_breaks(&c, &mut i, &mut col, &mut indent, &mut trailing)?;
        }
        if i < c.len() {
            return None;
        }
        if chomp != -1 {
            out.push_str(&leading);
        }
        if chomp == 1 {
            out.push_str(&trailing);
        }
        Some(out)
    }

    /// `yaml_parser_scan_block_scalar_breaks`: eats indentation and empty lines; without an indicator the
    /// indentation is the deepest of the leading lines (at least 1), and a tab before it is an error.
    fn scan_breaks(c: &[char], i: &mut usize, col: &mut usize, indent: &mut usize, breaks: &mut String) -> Option<()> {
        let mut max = 0;
        loop {
            while (*indent == 0 || *col < *indent) && c.get(*i) == Some(&' ') {
                (*i, *col) = (*i + 1, *col + 1);
            }
            max = max.max(*col);
            if (*indent == 0 || *col < *indent) && c.get(*i) == Some(&'\t') {
                return None;
            }
            if !c.get(*i).is_some_and(|&ch| is_break(ch)) {
                break;
            }
            breaks.push('\n');
            (*i, *col) = (*i + 1, 0);
        }
        if *indent == 0 {
            *indent = max.max(1);
        }
        Some(())
    }

    fn read_double_quoted(q: &str) -> Option<String> {
        let mut out = String::new();
        let mut it = q.chars();
        loop {
            match it.next()? {
                '"' => return it.next().is_none().then_some(out),
                '\\' => match it.next()? {
                    'n' => out.push('\n'),
                    't' => out.push('\t'),
                    'r' => out.push('\r'),
                    '"' => out.push('"'),
                    '\\' => out.push('\\'),
                    'u' => out.push(char::from_u32(u32::from_str_radix(&it.by_ref().take(4).collect::<String>(), 16).ok()?)?),
                    _ => return None,
                },
                // A raw line break inside quotes is folded into a space.
                c if is_break(c) => return None,
                c => out.push(c),
            }
        }
    }

    /// Plain scalar in block context, typed like go-yaml v2's `resolve`: bools/nulls from its table, then
    /// `strconv.ParseInt(s, 0, 64)` with `_` removed (any base prefix, either case) and YAML-style floats.
    fn read_plain(s: &str) -> Option<String> {
        let first = s.chars().next()?;
        if "-?:,[]{}#&*!|>'\"%@`".contains(first) || s.starts_with([' ', '\t']) || s.ends_with([' ', '\t', ':']) || s.contains(": ") || s.contains(" #") {
            return None;
        }
        const RESERVED: &[&str] = &[
            "y", "Y", "yes", "Yes", "YES", "n", "N", "no", "No", "NO", "true", "True", "TRUE", "false", "False", "FALSE", "on", "On", "ON", "off", "Off",
            "OFF", "null", "Null", "NULL", "~", "<<", ".inf", ".Inf", ".INF", "+.inf", "+.Inf", "+.INF", "-.inf", "-.Inf", "-.INF", ".nan", ".NaN", ".NAN",
        ];
        if RESERVED.contains(&s) {
            return None;
        }
        let digits = |x: &str, radix: u32| !x.is_empty() && x.chars().all(|c| c.is_digit(radix));
        let float = |x: &str| {
            let x = x.strip_prefix(['+', '-']).unwrap_or(x);
            let (mantissa, exp) = x.split_once(['e', 'E']).map_or((x, None), |(m, e)| (m, Some(e)));
            let mantissa_ok = match mantissa.split_once('.') {
                Some(("", frac)) => digits(frac, 10),
                Some((int, frac)) => digits(int, 10) && (frac.is_empty() || digits(frac, 10)),
                None => digits(mantissa, 10),
            };
            mantissa_ok && exp.is_none_or(|e| digits(e.strip_prefix(['+', '-']).unwrap_or(e), 10))
        };
        let numeric = match first {
            '.' => float(s),
            '0'..='9' | '+' | '-' => {
                let n = s.replace('_', "");
                let d = n.strip_prefix(['+', '-']).unwrap_or(&n);
                let int = match d.get(..2).map(str::to_ascii_lowercase).as_deref() {
                    Some("0x") => digits(&d[2..], 16),
                    Some("0o") => digits(&d[2..], 8),
                    Some("0b") => digits(&d[2..], 2),
                    _ => digits(d, if d.len() > 1 && d.starts_with('0') { 8 } else { 10 }),
                };
                int || float(&n)
            }
            _ => false,
        };
        (!numeric).then(|| s.to_string())
    }
}
