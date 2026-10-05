// What a log line says about itself, whatever its format: its level, its fields (JSON, logfmt), its message, and
// whether it is more of the line before it (a stack trace). Log lines are untrusted and many: everything here is
// a bounded scan of the line's head or a single parse, never a pattern that can backtrack without bound.

/** How bad a line says it is: `None` when it does not say. Fatal, panic, critical… are errors. */
export const Level = { None: 0, Trace: 1, Debug: 2, Info: 3, Warn: 4, Error: 5 } as const;
export type Level = (typeof Level)[keyof typeof Level];

/** Most severe first. */
export const LEVELS: readonly Level[] = [5, 4, 3, 2, 1, 0];
export const LEVEL_NAME = ["other", "trace", "debug", "info", "warn", "error"] as const;
/** The tag a structured line's level is shown as. */
export const LEVEL_TAG = ["", "TRACE", "DEBUG", "INFO", "WARN", "ERROR"] as const;

const WORDS: Record<string, Level> = {
  trace: 1, trac: 1, trc: 1, finest: 1, finer: 1, verbose: 1, silly: 1,
  debug: 2, debu: 2, dbg: 2, fine: 2,
  info: 3, inf: 3, information: 3, informational: 3, notice: 3, note: 3, log: 3, config: 3,
  warn: 4, warning: 4, wrn: 4,
  error: 5, erro: 5, err: 5, eror: 5, fatal: 5, fata: 5, ftl: 5, panic: 5, pani: 5, crit: 5, critical: 5, alert: 5, emerg: 5, emergency: 5, severe: 5,
};

/** A level as a word ("WARNING", "err") or a number (pino and bunyan's 10…60, syslog's 0…7). */
export function levelWord(w: string): Level {
  const c = w.charCodeAt(0);
  if (c >= 48 && c <= 57) {
    const n = Number(w);
    if (n >= 10) return n >= 50 ? 5 : n >= 40 ? 4 : n >= 30 ? 3 : n >= 20 ? 2 : 1;
    return n <= 3 ? 5 : n === 4 ? 4 : n <= 6 ? 3 : 2;
  }
  return WORDS[w.toLowerCase()] ?? 0;
}

/** Levels as names: a query's `level:warn`. */
export const levelNamed = (name: string): Level | undefined => (name.toLowerCase() === "other" || name.toLowerCase() === "none" ? 0 : WORDS[name.toLowerCase()]);

// A level under a key: JSON ("level":"info", "severity":"ERROR", "level":30, "log.level") or logfmt (level=warn).
const KEYED = /(?:"(?:level|lvl|severity|levelname|level_name|loglevel|log_level|log\.level|@l|@level)"\s*:\s*"?|(?:^|[\s,;{(])(?:level|lvl|severity|loglevel)=["']?)([A-Za-z]{1,13}|\d{1,3})\b/i;
// klog and glog (I1004 10:42:01.123456), Ruby's Logger (E, [2024-…).
const PREFIX = /^([DIWEF])(?:\d{4} \d{2}:\d{2}:\d{2}|, \[)/;
const PREFIX_LEVEL: Record<string, Level> = { D: 2, I: 3, W: 4, E: 5, F: 5 };
// Lines that are errors by what they start with.
const STARTS = /^(?:panic: |fatal error: |Exception in thread |Traceback \(most recent call last\)|Unhandled (?:exception|rejection)|Uncaught )/;
// A level in brackets or between bars, any case: [error], <warn>, | INFO |.
const TAGGED = /[[<(|]\s*(trace|trc|debug|dbg|info|inf|notice|note|warn|warning|wrn|error|err|fatal|crit|critical|panic|alert|emerg|severe|verbose)\s*[\]>)|]/i;
// A level in capitals anywhere in the head (logrus's ERRO[0000] and Postgres's LOG: too). No lookbehind (WebKit
// before 16.4 has none): the character before the word is part of the match.
const UPPER = /(?:^|[^\w-])(TRACE|TRAC|TRC|DEBUG|DEBU|DBG|INFO|INF|NOTICE|WARN|WARNING|WRN|ERROR|ERRO|ERR|FATAL|FATA|FTL|PANIC|PANI|CRIT|CRITICAL|ALERT|EMERG|SEVERE|FINEST|FINER|FINE|LOG(?=:))(?![\w-])/;
// A lower-case level that starts the line: winston's "error: …".
const LOWER_START = /^(error|err|warn|warning|info|debug|trace|fatal|verbose|silly|notice|critical)\s*[:|]/i;
// An access log's request and status (nginx, Envoy): 5xx are errors, 4xx warnings.
const ACCESS = /"(?:GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS|CONNECT) [^"]{0,2000}" ([1-5]\d\d)\b/;

/** How long a head of the line is looked at for its level. */
const HEAD = 320;

/** The level a line says it has (`plain`: without ANSI escapes). */
export function levelOf(plain: string): Level {
  const head = plain.length > HEAD ? plain.slice(0, HEAD) : plain;
  const keyed = KEYED.exec(head);
  if (keyed) {
    const l = levelWord(keyed[1]);
    if (l) return l;
  }
  const prefix = PREFIX.exec(head);
  if (prefix) return PREFIX_LEVEL[prefix[1]];
  if (STARTS.test(head)) return Level.Error;
  // The leftmost level word of any kind.
  let at = Infinity;
  let level: Level = Level.None;
  for (const re of [TAGGED, UPPER, LOWER_START]) {
    const m = re.exec(head);
    if (m && m.index < at) {
      const l = levelWord(m[1]);
      if (l) {
        at = m.index;
        level = l;
      }
    }
  }
  if (level) return level;
  const access = ACCESS.exec(plain.length > 2400 ? plain.slice(0, 2400) : plain);
  if (access) return access[1] >= "500" ? Level.Error : access[1] >= "400" ? Level.Warn : Level.Info;
  return Level.None;
}

// ------------------------------------------------------------------------------------------ structured lines

export type FieldValue = string | number | boolean | null;

/** A JSON or logfmt line: its fields (nested objects flattened: `http.status`), message and special keys. */
export interface Structured {
  kind: "json" | "logfmt";
  fields: [string, FieldValue][];
  /** The message, from its key (`msg`, `message`…); a Serilog template has its values filled in. */
  msg?: string;
  msgKey?: string;
  levelKey?: string;
  timeKey?: string;
}

const MSG_KEYS = ["msg", "message", "@m", "@mt", "event", "MESSAGE", "Message", "text", "short_message", "log", "body"];
const LEVEL_KEYS = new Set(["level", "lvl", "severity", "levelname", "level_name", "loglevel", "log_level", "log.level", "@l", "@level", "Level", "LEVEL", "Severity", "SEVERITY"]);
const TIME_KEYS = new Set(["ts", "time", "timestamp", "@timestamp", "@t", "t", "date", "datetime", "Timestamp", "eventTime", "asctime", "time_local", "timeMillis"]);
/** Keys whose values are errors: shown as such. */
export const ERROR_KEYS = new Set(["error", "err", "exception", "exc_info", "stack", "stacktrace", "stack_trace", "error.message", "error.stack", "error.stack_trace", "errorVerbose"]);
/** Keys whose values tie lines together across pods and clusters: one click filters by them. */
export const TRACE_KEYS = new Set(["trace_id", "traceId", "traceID", "trace.id", "dd.trace_id", "request_id", "requestId", "requestID", "x_request_id", "correlation_id", "correlationId", "span_id", "spanId"]);

/** Nested objects are flattened this deep; deeper ones (and arrays) are kept as JSON. */
const MAX_DEPTH = 3;

function flatten(obj: Record<string, unknown>, prefix: string, depth: number, out: [string, FieldValue][]) {
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    const key = prefix ? `${prefix}.${k}` : k;
    if (v === null || typeof v === "string" || typeof v === "number" || typeof v === "boolean") out.push([key, v]);
    else if (typeof v === "object" && !Array.isArray(v) && depth < MAX_DEPTH) flatten(v as Record<string, unknown>, key, depth + 1, out);
    else out.push([key, JSON.stringify(v)]);
  }
}

/** The JSON object a line is, or null. */
export function jsonOf(text: string): Record<string, unknown> | null {
  if (text.charCodeAt(0) !== 123 || text.charCodeAt(text.length - 1) !== 125) return null;
  try {
    const v = JSON.parse(text);
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

const KEY = /^[A-Za-z_@][\w.@/-]*$/;
const NUMBER = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/;
// Worth trying as logfmt: a key=value pair first, perhaps after one bare word (a timestamp).
const LOGFMT_HINT = /^(?:\S+ )?[A-Za-z_@][\w.@/-]*=/;

/**
 * The pairs of a logfmt line (`level=info msg="a b" n=3`), or null if it is not one: two pairs at least, nothing
 * but pairs after the first (one bare word before it is allowed — a timestamp).
 */
export function logfmtOf(s: string): [string, FieldValue][] | null {
  if (!LOGFMT_HINT.test(s)) return null;
  const out: [string, FieldValue][] = [];
  const n = s.length;
  let i = 0;
  let bare = 0;
  while (i < n) {
    while (i < n && (s[i] === " " || s[i] === "\t")) i++;
    if (i >= n) break;
    const start = i;
    while (i < n && s[i] !== "=" && s[i] !== " " && s[i] !== "\t") i++;
    const key = s.slice(start, i);
    if (s[i] !== "=") {
      // A bare word: only before the first pair, and only one.
      if (out.length || ++bare > 1) return null;
      continue;
    }
    if (!KEY.test(key)) return null;
    i++;
    let value: FieldValue;
    if (s[i] === '"') {
      let v = "";
      i++;
      while (i < n && s[i] !== '"') {
        if (s[i] === "\\" && i + 1 < n) {
          const e = s[++i];
          v += e === "n" ? "\n" : e === "t" ? "\t" : e;
        } else v += s[i];
        i++;
      }
      if (i >= n) return null;
      i++;
      value = v;
    } else {
      const vs = i;
      while (i < n && s[i] !== " " && s[i] !== "\t") i++;
      const v = s.slice(vs, i);
      value = NUMBER.test(v) && v.length < 16 ? Number(v) : v === "true" ? true : v === "false" ? false : v;
    }
    out.push([key, value]);
  }
  return out.length >= 2 ? out : null;
}

/** A JSON or logfmt line's fields and message, or null for anything else. */
export function structure(text: string): Structured | null {
  let kind: Structured["kind"];
  const fields: [string, FieldValue][] = [];
  const json = jsonOf(text);
  if (json) {
    kind = "json";
    flatten(json, "", 0, fields);
  } else {
    const pairs = logfmtOf(text);
    if (!pairs) return null;
    kind = "logfmt";
    for (const p of pairs) fields.push(p);
  }
  const s: Structured = { kind, fields };
  const has = new Map<string, FieldValue>();
  for (const [k, v] of fields) {
    if (!has.has(k)) has.set(k, v);
    if (s.levelKey === undefined && LEVEL_KEYS.has(k)) s.levelKey = k;
    else if (s.timeKey === undefined && TIME_KEYS.has(k)) s.timeKey = k;
  }
  for (const k of MSG_KEYS) {
    const v = has.get(k);
    if (typeof v !== "string") continue;
    s.msgKey = k;
    // A Serilog template ("Order {OrderId} placed") with the values it names.
    s.msg = k === "@mt" ? v.replace(/\{@?(\w+)(?::[^}]*)?\}/g, (whole, name: string) => (has.has(name) ? String(has.get(name)) : whole)) : v;
    break;
  }
  return s;
}

// ------------------------------------------------------------------------------------------ multi-line entries

const INDENTED = /^[ \t]+\S/;
// Lines that are a stack trace's whatever their indentation.
const STACK = /^(?:Caused by: |Suppressed: |\.\.\. \d+ (?:more|common frames omitted)|goroutine \d+ \[|\[recovered\]|created by |During handling of the above exception|The above exception was the direct cause|Traceback \(most recent call last\):)/;
// Frames that say a stack trace has begun: Java's and JavaScript's "at …", Python's "File …".
const FRAME = /^[ \t]+(?:at |File ")/;
// An exception's first line, logged right after the line that reports it (Java's logback, Node).
const EXCEPTION = /^(?:(?:[a-z_$][\w$]*\.)+[A-Z][\w$]*(?:Exception|Error|Throwable)|[A-Z]\w*(?:Error|Exception))(?::|$)/;
// Lines that start an entry of their own however close they come: a timestamp, a level, a JSON object, a pair.
const ENTRY_HEAD = /^(?:\{|\[?\d{4}[-/]\d{2}[-/]\d{2}|\[?\d{2}:\d{2}:\d{2}|[IWEF]\d{4} |\[?\s*(?:TRACE|DEBUG|INFO|WARN|WARNING|ERROR|FATAL|PANIC|CRITICAL|NOTICE)\b|(?:time|ts|level|lvl|msg)=)/;
/** Lines after which unindented lines (Go's function names, Python's final error) belong to the stack trace too. */
const STACK_START = /^(?:panic: |fatal error: |Exception in thread |Traceback \(most recent call last\):|goroutine \d+ \[)/;

/** Continuation lines further apart than this from the line before them start entries of their own. */
export const CONTINUATION_MS = 1000;
/** An exception's first line belongs to the line before it only when written right after it. */
const EXCEPTION_MS = 5;

/** Whether a line that starts an entry starts a stack trace (unindented lines may follow in it). */
export const startsStack = (plain: string) => STACK_START.test(plain);

/**
 * How a line relates to the entry before it from the same source, written `ms` before it (null: unknown):
 * 0 it starts an entry of its own, 1 it is more of that entry, 2 more of it, and a stack trace from here on
 * (`inStack`: the entry is one already, so unindented lines that start no entry belong to it).
 */
export function follows(plain: string, inStack: boolean, ms: number | null): 0 | 1 | 2 {
  if (ms !== null && ms > CONTINUATION_MS) return 0;
  // JSON lines are entries of their own (indented or not): structured logs have one entry per line.
  if (plain.charCodeAt(0) === 123 || (plain.trimStart().charCodeAt(0) === 123 && plain.trimEnd().endsWith("}"))) return 0;
  if (STACK.test(plain)) return 2;
  if (INDENTED.test(plain)) return FRAME.test(plain) ? 2 : 1;
  if (inStack) return ENTRY_HEAD.test(plain) ? 0 : 1;
  if (EXCEPTION.test(plain) && (ms === null || ms <= EXCEPTION_MS)) return 2;
  return 0;
}
