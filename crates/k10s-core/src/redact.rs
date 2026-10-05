//! Scrubs credentials out of error text before it reaches the UI or the log file.
//!
//! kube renders a failed exec auth plugin as `auth exec command '<Command:?>' failed with status
//! <status>: <Output:?>`. The `Command` debug form starts with every variable passed to the plugin
//! (`API_TOKEN="…" PATH="…" "kubelogin" "get-token"`) — for us the whole login-shell environment — and
//! `Output` carries the plugin's stdout, which may hold a (partial) credential. YAML parse errors (exec
//! plugin output, kubeconfig) quote the offending input lines below their first line.
//!
//! The former is rewritten as ``exec auth plugin `kubelogin get-token` failed (exit status: 1): <stderr>``,
//! the latter is cut to its first line. Whatever cannot be parsed is withheld, never passed through.

use std::borrow::Cow;
use std::fmt::Write;

/// Longest error text handed to the UI or the log.
const MAX_CHARS: usize = 2000;
/// How much of the plugin's stderr (its own diagnostics) is kept.
const STDERR_TAIL_CHARS: usize = 800;

const EXEC: &str = "auth exec command '";
const EXEC_END: &str = "' failed with status ";
/// Debug-printed (`{:?}`) errors that carry raw secrets, with what is left of them: the exec failure
/// above (`AuthExecRun { cmd: "…", out: Output { … } }`), a plugin output parse error and YAML error
/// snippets (`AuthExecParse(…)`, `CroppedRegion { text: "<input>" … }`) that quote the plugin's stdout.
const DEBUG: [(&str, &str); 3] = [("AuthExecRun {", "AuthExecRun { … }"), ("AuthExecParse(", "AuthExecParse(…)"), ("CroppedRegion {", "CroppedRegion { … }")];
/// Flags whose value is a credential: `--client-secret=…`, `--token …`, `--password=…`.
const SECRET_FLAGS: [&str; 7] = ["secret", "token", "password", "passwd", "key", "credential", "auth"];
const OUTPUT: &str = ": Output { status: ";
const STDOUT: &str = ", stdout: ";
const STDERR: &str = ", stderr: ";
/// Errors whose lines after the first quote the input (exec plugin stdout, kubeconfig).
const PARSE: [&str; 2] = ["failed to parse auth exec output: ", "failed to parse kubeconfig YAML: "];

/// [`redact_secrets`], capped at a length that fits a toast and a log line.
pub(crate) fn sanitize_error_text(text: &str) -> String {
    truncate(&redact_secrets(text), MAX_CHARS)
}

/// Rewrites exec auth failures and YAML parse errors so they carry no environment variables, plugin
/// stdout or input snippets. Any other text is returned as is.
pub fn redact_secrets(text: &str) -> Cow<'_, str> {
    if next_marker(text).is_none() {
        return Cow::Borrowed(text);
    }
    let mut out = String::with_capacity(text.len().min(MAX_CHARS));
    let mut rest = text;
    while let Some((at, marker)) = next_marker(rest) {
        out.push_str(&rest[..at]);
        let tail = &rest[at + marker.len()..];
        rest = if marker == EXEC {
            exec_failure(tail, &mut out)
        } else if let Some((_, withheld)) = DEBUG.iter().find(|(m, _)| *m == marker) {
            out.push_str(withheld);
            ""
        } else {
            // "line 3 column 5: what went wrong"; the lines below quote the input.
            out.push_str(marker);
            out.push_str(tail.lines().next().unwrap_or_default());
            ""
        };
    }
    out.push_str(rest);
    Cow::Owned(out)
}

fn next_marker(s: &str) -> Option<(usize, &'static str)> {
    [EXEC, PARSE[0], PARSE[1]].into_iter().chain(DEBUG.map(|(m, _)| m)).filter_map(|m| s.find(m).map(|at| (at, m))).min_by_key(|(at, _)| *at)
}

/// Writes the friendly form of one exec failure (`tail` starts right after `auth exec command '`) and
/// returns the text that follows it, or nothing when the failure could not be parsed.
fn exec_failure<'a>(tail: &'a str, out: &mut String) -> &'a str {
    out.push_str("exec auth plugin");
    let Some((words, rest)) = debug_command(tail).or_else(|| plain_command(tail)) else {
        out.push_str(" failed (details withheld)");
        return "";
    };
    if !words.is_empty() {
        let _ = write!(out, " `{}`", mask_secret_args(words).join(" "));
    }
    out.push_str(" failed");
    // `exit status: 1`, `signal: 9 (SIGKILL)`…, then `: Output { status: …, stdout: …, stderr: … }`.
    let parsed = rest.find(OUTPUT).filter(|&at| is_exit_status(&rest[..at])).and_then(|at| {
        let (stderr, after) = output_stderr(&rest[at + OUTPUT.len()..])?;
        Some((&rest[..at], stderr, after))
    });
    let Some((status, stderr, after)) = parsed else {
        out.push_str(" (details withheld)");
        return "";
    };
    let _ = write!(out, " ({status})");
    // stderr is the plugin's own diagnostic; it could still relay a nested failure of the same kind.
    let stderr = one_line(&redact_secrets(&stderr));
    let stderr = tail_chars(&stderr, STDERR_TAIL_CHARS);
    if !stderr.is_empty() {
        let _ = write!(out, ": {stderr}");
    }
    after
}

/// A failed run of an exec auth plugin that k10s started itself (`exec.rs`), told like kube's failures above:
/// the command with credential-looking flag values masked, how it ended (`exit status: 1`), and the end of
/// its stderr on one line — never its environment or stdout.
pub(crate) fn plugin_run_failure(words: Vec<String>, status: &str, stderr: &str) -> String {
    let mut out = format!("auth plugin `{}` failed ({status})", mask_secret_args(words).join(" "));
    let stderr = one_line(&redact_secrets(stderr));
    let stderr = tail_chars(&stderr, STDERR_TAIL_CHARS);
    if !stderr.is_empty() {
        let _ = write!(out, ": {stderr}");
    }
    out
}

/// Program and arguments from `std::process::Command`'s debug form, skipping its working directory and
/// environment: `[cd "…" && ][env -i |env -u K… ]K="v"… ["program"] "argv0" "arg"…`.
/// Returns them with the text after `' failed with status `.
fn debug_command(mut s: &str) -> Option<(Vec<String>, &str)> {
    if let Some(rest) = s.strip_prefix("cd ") {
        s = quoted(rest)?.1.strip_prefix(" && ")?;
    }
    if let Some(rest) = s.strip_prefix("env -i ") {
        s = rest;
    } else if let Some(mut rest) = s.strip_prefix("env ") {
        while let Some(r) = rest.strip_prefix("-u ") {
            rest = &r[r.find(' ')? + 1..];
        }
        s = rest;
    }
    // `KEY="value" ` for every variable passed to the plugin: dropped whole, whatever the value holds.
    while !s.starts_with(['"', '[']) {
        let eq = s.find("=\"")?;
        s = quoted(&s[eq + 1..])?.1.strip_prefix(' ')?;
    }
    let mut program = None;
    if let Some(rest) = s.strip_prefix('[') {
        let (p, rest) = quoted(rest)?;
        program = Some(p);
        s = rest.strip_prefix("] ")?;
    }
    let mut words = Vec::new();
    loop {
        let (word, rest) = quoted(s)?;
        words.push(word);
        if let Some(rest) = rest.strip_prefix(EXEC_END) {
            // `[program]` is printed when argv[0] differs from it; show what actually ran.
            if let Some(p) = program {
                words[0] = p;
            }
            return Some((words, rest));
        }
        s = rest.strip_prefix(' ')?;
    }
}

/// Hides the values of credential-looking flags (`--client-secret=…` or `--client-secret …`); the
/// program, subcommands and other flags stay, since they explain what failed.
fn mask_secret_args(mut words: Vec<String>) -> Vec<String> {
    let is_secret = |flag: &str| {
        let name = flag.trim_start_matches('-').to_ascii_lowercase();
        SECRET_FLAGS.iter().any(|s| name.contains(s))
    };
    let mut i = 1;
    while i < words.len() {
        let w = &words[i];
        if w.starts_with('-') {
            match w.split_once('=') {
                Some((flag, _)) if is_secret(flag) => words[i] = format!("{flag}=***"),
                None if is_secret(w) && words.get(i + 1).is_some_and(|v| !v.starts_with('-')) => {
                    words[i + 1] = "***".into();
                    i += 1;
                }
                _ => {}
            }
        }
        i += 1;
    }
    words
}

/// The gcp `cmd-path` provider reports `<cmd-path> <cmd-args>` unquoted and without environment.
/// Anything quoted or escaped is not that form (e.g. a debug-printed copy of the message).
fn plain_command(s: &str) -> Option<(Vec<String>, &str)> {
    let end = s.find(EXEC_END)?;
    let cmd = &s[..end];
    if cmd.contains(['"', '\\']) {
        return None;
    }
    Some((cmd.split(' ').filter(|w| !w.is_empty()).map(String::from).collect(), &s[end + EXEC_END.len()..]))
}

/// `ExitStatus`'s display form: `exit status: 1`, `signal: 9 (SIGKILL) (core dumped)`, `exit code: 1`…
fn is_exit_status(s: &str) -> bool {
    !s.is_empty() && s.len() <= 64 && s.chars().all(|c| c.is_ascii_alphanumeric() || " :()-_".contains(c))
}

/// Skips `ExitStatus(…), stdout: <value>` and decodes `stderr: <value> }`. Returns stderr and the rest.
fn output_stderr(s: &str) -> Option<(String, &str)> {
    let at = s.find(STDOUT).filter(|&at| at <= 64)?;
    let (_stdout, rest) = output_value(&s[at + STDOUT.len()..])?;
    let (stderr, rest) = output_value(rest.strip_prefix(STDERR)?)?;
    Some((stderr, rest.strip_prefix(" }")?))
}

/// A debug-quoted string, or a byte list (`[104, 105]`) when the output was not UTF-8.
fn output_value(s: &str) -> Option<(String, &str)> {
    if s.starts_with('"') {
        return quoted(s);
    }
    let body = s.strip_prefix('[')?;
    let end = body.find(']')?;
    let bytes = body[..end].split(", ").filter(|b| !b.is_empty()).map(|b| b.parse::<u8>().ok()).collect::<Option<Vec<u8>>>()?;
    Some((String::from_utf8_lossy(&bytes).into_owned(), &body[end + 1..]))
}

/// Parses a Rust debug string literal (`\"`, `\\`, `\n`, `\u{…}`, `\xFF`… escapes) at the start of `s`.
/// Returns the unescaped text and the rest after the closing quote.
fn quoted(s: &str) -> Option<(String, &str)> {
    let body = s.strip_prefix('"')?;
    let mut bytes = Vec::new();
    let mut chars = body.char_indices();
    while let Some((i, c)) = chars.next() {
        match c {
            '"' => return Some((String::from_utf8_lossy(&bytes).into_owned(), &body[i + 1..])),
            '\\' => match chars.next()?.1 {
                'n' => bytes.push(b'\n'),
                'r' => bytes.push(b'\r'),
                't' => bytes.push(b'\t'),
                '0' => bytes.push(0),
                'x' => {
                    let hex: String = [chars.next()?.1, chars.next()?.1].into_iter().collect();
                    bytes.push(u8::from_str_radix(&hex, 16).ok()?);
                }
                'u' => {
                    chars.next().filter(|(_, c)| *c == '{')?;
                    let hex: String = chars.by_ref().map(|(_, c)| c).take_while(|c| *c != '}').collect();
                    let c = char::from_u32(u32::from_str_radix(&hex, 16).ok()?)?;
                    bytes.extend_from_slice(c.encode_utf8(&mut [0; 4]).as_bytes());
                }
                other => bytes.extend_from_slice(other.encode_utf8(&mut [0; 4]).as_bytes()),
            },
            c => bytes.extend_from_slice(c.encode_utf8(&mut [0; 4]).as_bytes()),
        }
    }
    None
}

/// Plugin stderr as one line: no terminal escapes or control characters, lines joined with "; ".
fn one_line(s: &str) -> String {
    let mut plain = String::with_capacity(s.len());
    let mut chars = s.chars();
    while let Some(c) = chars.next() {
        match c {
            // CSI (`ESC [ … final`) colours and cursor moves; other escapes are two characters.
            '\u{1b}' => {
                if chars.next() == Some('[') {
                    for c in chars.by_ref() {
                        if ('@'..='~').contains(&c) {
                            break;
                        }
                    }
                }
            }
            '\n' | '\r' => plain.push('\n'),
            '\t' => plain.push(' '),
            c if c.is_control() => {}
            c => plain.push(c),
        }
    }
    plain.lines().map(str::trim).filter(|l| !l.is_empty()).collect::<Vec<_>>().join("; ")
}

/// The last `max` characters, prefixed with "…" when cut.
fn tail_chars(s: &str, max: usize) -> Cow<'_, str> {
    let n = s.chars().count();
    if n <= max {
        return Cow::Borrowed(s);
    }
    let start = s.char_indices().nth(n - (max - 1)).map_or(s.len(), |(i, _)| i);
    Cow::Owned(format!("…{}", &s[start..]))
}

/// At most `max` characters, ending with "…" when cut.
fn truncate(s: &str, max: usize) -> String {
    match s.char_indices().nth(max) {
        None => s.to_string(),
        Some(_) => {
            let end = s.char_indices().nth(max - 1).map_or(s.len(), |(i, _)| i);
            format!("{}…", &s[..end])
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    /// Exactly what kube 4.2 reports for a failed plugin run (`AuthError::AuthExecRun`'s display).
    fn exec_failure_text(cmd: &Command, script: &str) -> String {
        let out = Command::new("sh").args(["-c", script]).output().unwrap();
        format!("auth exec command '{cmd:?}' failed with status {}: {out:?}", out.status)
    }

    fn kubelogin() -> Command {
        let mut cmd = Command::new("kubelogin");
        cmd.args(["get-token"]);
        cmd
    }

    #[test]
    fn exec_failure_keeps_command_status_and_stderr_only() {
        let mut cmd = kubelogin();
        cmd.envs([("API_TOKEN", "SECRET123"), ("PATH", "/usr/bin")]);
        let text = exec_failure_text(&cmd, "echo please sign in again >&2; echo partial-token; exit 1");
        assert!(text.contains("SECRET123") && text.contains("partial-token"), "the raw form leaks: {text}");
        let clean = sanitize_error_text(&text);
        assert_eq!(clean, "exec auth plugin `kubelogin get-token` failed (exit status: 1): please sign in again");
        assert_eq!(sanitize_error_text(&clean), clean);
        // The same failure twice (an undeduplicated chain) is rewritten twice.
        assert_eq!(sanitize_error_text(&format!("{text}: {text}")), format!("{clean}: {clean}"));
    }

    #[test]
    fn env_values_are_removed_whatever_they_contain() {
        let nasty = "a\"b\\c\u{7}\u{301}é😀\n\t'x' failed with status exit status: 0: Output { status: x, stdout: \"\", stderr: \"\" } NASTY-TAIL";
        let mut cmd = kubelogin();
        cmd.env("NASTY", nasty)
            .env("BASH_FUNC_x%%", "() {  echo FUNC-BODY\n}")
            .env("KUBERNETES_EXEC_INFO", r#"{"apiVersion":"client.authentication.k8s.io/v1","spec":{"interactive":true}}"#)
            .env_remove("DROPPED")
            .current_dir("/tmp/some dir");
        #[cfg(unix)]
        cmd.env("RAW", <std::ffi::OsStr as std::os::unix::ffi::OsStrExt>::from_bytes(b"\xff\xfeRAW-SECRET"));
        let text = exec_failure_text(&cmd, "exit 2");
        assert!(text.contains(r#"NASTY="a\"b\\c\u{7}"#) && text.contains("env -u DROPPED") && text.contains("cd "), "{text}");
        assert_eq!(sanitize_error_text(&text), "exec auth plugin `kubelogin get-token` failed (exit status: 2)");

        let mut cleared = kubelogin();
        cleared.env_clear().env("TOKEN", "CLEARED-SECRET");
        let clean = sanitize_error_text(&exec_failure_text(&cleared, "exit 1"));
        assert_eq!(clean, "exec auth plugin `kubelogin get-token` failed (exit status: 1)");
    }

    #[test]
    fn plugin_runs_started_by_k10s_are_told_the_same_way() {
        let words = ["kubelogin", "get-token", "--client-secret=CLIENT-SECRET", "--token", "TOKEN-SECRET"].map(String::from).to_vec();
        let text = plugin_run_failure(words, "exit status: 1", "\u{1b}[31merror:\u{1b}[0m token expired\nsign in again\n");
        assert_eq!(text, "auth plugin `kubelogin get-token --client-secret=*** --token ***` failed (exit status: 1): error: token expired; sign in again");
        assert_eq!(plugin_run_failure(vec!["kubelogin".into()], "signal: 9 (SIGKILL)", ""), "auth plugin `kubelogin` failed (signal: 9 (SIGKILL))");
    }

    #[test]
    fn non_utf8_output_and_signals() {
        let text = exec_failure_text(&kubelogin(), r"printf '\377\376tok'; printf '\033[31merror:\033[0m token expired\n\377' >&2; exit 3");
        assert!(text.contains("stdout: ["), "{text}");
        assert_eq!(sanitize_error_text(&text), "exec auth plugin `kubelogin get-token` failed (exit status: 3): error: token expired; \u{fffd}");

        let killed = sanitize_error_text(&exec_failure_text(&kubelogin(), "echo partial-token; kill -9 $$"));
        assert_eq!(killed, "exec auth plugin `kubelogin get-token` failed (signal: 9 (SIGKILL))");
    }

    #[test]
    fn gcp_cmd_path_form() {
        let text = r#"auth error: auth exec command 'gcloud config config-helper --format=json' failed with status exit status: 1: Output { status: ExitStatus(unix_wait_status(256)), stdout: "{\"token\": \"ya29.SECRET\"", stderr: "ERROR: (gcloud) You do not currently have an active account.\n" }"#;
        assert_eq!(
            sanitize_error_text(text),
            "auth error: exec auth plugin `gcloud config config-helper --format=json` failed (exit status: 1): ERROR: (gcloud) You do not currently have an active account."
        );
    }

    #[test]
    fn unrecognised_exec_text_is_withheld() {
        for text in [
            // Cut short.
            r#"auth exec command 'API_TOKEN="SECRET123" "kubelogin"#,
            // A debug-printed copy of the message.
            r#"auth exec command 'API_TOKEN=\"SECRET123\" \"kubelogin\"' failed with status exit status: 1: Output { status: ExitStatus(unix_wait_status(256)), stdout: \"\", stderr: \"\" }"#,
            // Unknown output form.
            r#"auth exec command '"kubelogin"' failed with status exit status: 1: stdout=SECRET123"#,
            r#"auth exec command '"kubelogin"' failed with status SECRET123="x": Output { status: ExitStatus(unix_wait_status(256)), stdout: "", stderr: "" }"#,
        ] {
            let clean = sanitize_error_text(text);
            assert!(!clean.contains("SECRET") && clean.contains("(details withheld)"), "{clean}");
        }
        let debug = r#"Auth(AuthExecRun { cmd: "API_TOKEN=\"SECRET123\" \"kubelogin\"", status: ExitStatus(unix_wait_status(256)), out: Output { status: ExitStatus(unix_wait_status(256)), stdout: "", stderr: "" } })"#;
        assert_eq!(sanitize_error_text(debug), "Auth(AuthExecRun { … }");
    }

    #[test]
    fn credential_flags_are_masked() {
        let mut cmd = Command::new("kubelogin");
        cmd.args([
            "get-token",
            "--client-id=k10s",
            "--client-secret=CLIENT-SECRET",
            "--password",
            "PASS-SECRET",
            "--api-key=KEY-SECRET",
            "--verbose",
            "--server-id",
            "abc",
        ]);
        let clean = sanitize_error_text(&exec_failure_text(&cmd, "exit 1"));
        assert_eq!(
            clean,
            "exec auth plugin `kubelogin get-token --client-id=k10s --client-secret=*** --password *** --api-key=*** --verbose --server-id abc` failed (exit status: 1)"
        );
        // Subcommands are not flags: `kubelogin get-token` stays readable.
        assert!(sanitize_error_text(&exec_failure_text(&kubelogin(), "exit 1")).contains("`kubelogin get-token`"));
        // A secret flag at the very end has no value to hide.
        let mut last = kubelogin();
        last.arg("--token");
        assert!(sanitize_error_text(&exec_failure_text(&last, "exit 1")).contains("`kubelogin get-token --token`"));
    }

    #[test]
    fn debug_printed_parse_errors_are_withheld() {
        let text = r#"watcher error: Auth(AuthExecParse(Error { msg: "unexpected event", regions: [CroppedRegion { text: "eyJhbGciOiJSUzI1NiJ9.SECRET.sig", start: 0 }] }))"#;
        assert_eq!(sanitize_error_text(text), "watcher error: Auth(AuthExecParse(…)");
        let snippet = r#"Parse(WithSnippet { regions: [CroppedRegion { text: "token: SECRET" }] })"#;
        assert_eq!(sanitize_error_text(snippet), "Parse(WithSnippet { regions: [CroppedRegion { … }");
    }

    #[test]
    fn yaml_snippets_are_cut_to_the_first_line() {
        let text = "auth error: failed to parse auth exec output: error: line 1 column 1: unexpected event: expected mapping start\n --> <input>:1:1\n  |\n1 | eyJhbGciOiJSUzI1NiJ9.SECRET.sig\n  | ^ unexpected event: expected mapping start";
        assert_eq!(sanitize_error_text(text), "auth error: failed to parse auth exec output: error: line 1 column 1: unexpected event: expected mapping start");
        let kubeconfig = "/Users/me/.kube/config: failed to parse kubeconfig YAML: error: line 9 column 3: mapping values are not allowed in this context\n --> <input>:9:3\n  |\n8 |     token: SECRET\n";
        assert_eq!(
            sanitize_error_text(kubeconfig),
            "/Users/me/.kube/config: failed to parse kubeconfig YAML: error: line 9 column 3: mapping values are not allowed in this context"
        );
    }

    #[test]
    fn ordinary_messages_are_untouched() {
        for msg in [
            r#"pods "x" is forbidden: User "u" cannot list resource "pods" in API group "" in the namespace "default""#,
            r#"admission webhook "v.example.com" denied the request: FOO="bar" is not allowed"#,
            "error trying to connect: tcp connect error: Connection refused (os error 61)",
            "",
        ] {
            assert!(matches!(redact_secrets(msg), Cow::Borrowed(_)), "{msg}");
            assert_eq!(sanitize_error_text(msg), msg);
        }
    }

    #[test]
    fn long_text_is_capped() {
        for unit in ["x", "é", "😀"] {
            let capped = sanitize_error_text(&unit.repeat(10_000));
            assert_eq!(capped.chars().count(), MAX_CHARS);
            assert!(capped.ends_with('…'));
            assert_eq!(sanitize_error_text(&capped), capped);
        }
        let exact = "x".repeat(MAX_CHARS);
        assert_eq!(sanitize_error_text(&exact), exact);

        // Of a chatty plugin, the end of stderr is kept.
        let script = format!("printf '%s' '{}' >&2; echo THE-END >&2; exit 1", "y".repeat(5000));
        let clean = sanitize_error_text(&exec_failure_text(&kubelogin(), &script));
        assert!(clean.starts_with("exec auth plugin `kubelogin get-token` failed (exit status: 1): …yyy") && clean.ends_with("yTHE-END"), "{clean}");
        assert!(clean.chars().count() < 900);
    }
}
