import { describe, expect, it } from "vitest";
import { type FieldValue, Level, structure } from "./parse";
import { compile, describeQuery, fieldTerm, highlighter, isEmpty, parseQuery, type QueryOptions, queryKey, type Subject, withTerm } from "./query";

function subject(text: string, src: Partial<Record<"pod" | "container" | "cluster" | "namespace", string>> = {}, level: Level = Level.None): Subject {
  const s = structure(text);
  return {
    text: () => text,
    lower: () => text.toLowerCase(),
    level,
    field: (key: string): FieldValue | undefined => {
      if (!s) return undefined;
      if (key === "msg" && s.msg !== undefined) return s.msg;
      return s.fields.find(([k]) => k === key)?.[1];
    },
    source: (key) => src[key] ?? "",
  };
}

const matches = (q: string, line: string, opts: QueryOptions = {}, level: Level = Level.None, src = {}) => compile(parseQuery(q, opts))(subject(line, src, level));

describe("query", () => {
  it("needs every word, any case, in any order; quotes keep words together", () => {
    expect(matches("error timeout", "ERROR: upstream Timeout")).toBe(true);
    expect(matches("error timeout", "error only")).toBe(false);
    expect(matches('"connection refused"', "dial: connection refused")).toBe(true);
    expect(matches('"connection refused"', "refused connection")).toBe(false);
    expect(matches("connection refused", "refused connection")).toBe(true);
  });

  it("leaves lines out with !", () => {
    expect(matches("!healthz", "GET /healthz 200")).toBe(false);
    expect(matches("GET !healthz", "GET /api 200")).toBe(true);
    expect(matches('!"no stock"', "out of stock")).toBe(true);
    // A lone ! is just a character.
    expect(matches("!", "wow!")).toBe(true);
  });

  it("takes /regular expressions/ among words, and the whole input as one with the option", () => {
    expect(matches("/time.?out/", "read timed out")).toBe(false);
    expect(matches("/time.?out/", "a timeout")).toBe(true);
    expect(matches("/5\\d\\d/ !healthz", "status 503")).toBe(true);
    // Paths are words, not expressions.
    expect(parseQuery("/api/v1/").terms).toEqual([{ kind: "text", text: "/api/v1/", not: false }]);
    expect(matches("GET .* 50[0-9]", "GET /api 503", { regex: true })).toBe(true);
    expect(matches("!GET", "GET /api", { regex: true })).toBe(false);
    const bad = parseQuery("(unclosed", { regex: true });
    expect(bad.error).toBeTruthy();
    expect(isEmpty(bad)).toBe(true);
    expect(compile(bad)(subject("anything"))).toBe(true);
  });

  it("matches case only when asked", () => {
    expect(matches("Error", "error", { matchCase: true })).toBe(false);
    expect(matches("Error", "Error", { matchCase: true })).toBe(true);
    expect(matches("/ERR/", "err", { matchCase: true })).toBe(false);
  });

  it("looks into structured fields: contains, equals, compares numbers, lists and wildcards", () => {
    const line = '{"level":"error","msg":"payment failed: timeout","status":503,"path":"/api/v1/pay","user":"Bob","latency_ms":1200}';
    expect(matches("status:503", line)).toBe(true);
    expect(matches("status=503", line)).toBe(true);
    expect(matches("status:50", line)).toBe(false);
    expect(matches("status>=500", line)).toBe(true);
    expect(matches("status<500", line)).toBe(false);
    expect(matches("latency_ms>1000", line)).toBe(true);
    expect(matches("status:500,503", line)).toBe(true);
    expect(matches("path:/api", line)).toBe(true);
    expect(matches("path=/api", line)).toBe(false);
    expect(matches("path=/api/*", line)).toBe(true);
    expect(matches("user=bob", line)).toBe(true);
    expect(matches("user=bob", line, { matchCase: true })).toBe(false);
    expect(matches("msg:timeout", line)).toBe(true);
    expect(matches("!status:503", line)).toBe(false);
    expect(matches("status!=503", line)).toBe(false);
    expect(matches('msg:"payment failed"', line)).toBe(true);
    // Quoted alternatives keep their blanks and commas.
    expect(matches('msg="ok","payment failed: timeout"', line)).toBe(true);
    expect(matches('msg="ok",done', line)).toBe(false);
    expect(parseQuery('k="a, b",c,,"" x').terms[0]).toMatchObject({ key: "k", values: ["a, b", "c", ""] });
  });

  it("matches a plain line by the term's text, so URLs and key=value text still find it", () => {
    expect(matches("http://example.com/a", "fetching http://example.com/a")).toBe(true);
    expect(matches("user=bob", "login ok user=bob")).toBe(true);
    expect(matches("error:", "error: disk full")).toBe(true);
    expect(matches("status>=500", "status>=500 is not a number")).toBe(true);
    expect(matches("status>=500", "a plain line")).toBe(false);
    expect(matches("msg:disk", "error: disk full")).toBe(true);
  });

  it("filters by level and source on every line", () => {
    expect(matches("level:error", "anything", {}, Level.Error)).toBe(true);
    expect(matches("level:warn,error", "anything", {}, Level.Info)).toBe(false);
    expect(matches("level>=warn", "anything", {}, Level.Warn)).toBe(true);
    expect(matches("level>=warn", "anything", {}, Level.Info)).toBe(false);
    expect(matches("level:other", "anything", {}, Level.None)).toBe(true);
    expect(matches("pod:web-7f", "x", {}, Level.None, { pod: "web-7f9c-abcde" })).toBe(true);
    expect(matches("container=app", "x", {}, Level.None, { container: "envoy" })).toBe(false);
    expect(matches("cluster:z2", "x", {}, Level.None, { cluster: "prod-eu-z2 z2" })).toBe(true);
    // Equal to either of its names.
    expect(matches("cluster=z2", "x", {}, Level.None, { cluster: "prod-eu-z2 z2" })).toBe(true);
    expect(matches("cluster=prod-eu-z2", "x", {}, Level.None, { cluster: "prod-eu-z2 z2" })).toBe(true);
    expect(matches("cluster=z1,z2", "x", {}, Level.None, { cluster: "prod-eu-z2 z2" })).toBe(true);
    expect(matches("cluster!=z2", "x", {}, Level.None, { cluster: "prod-eu-z2 z2" })).toBe(false);
    expect(matches("cluster=eu", "x", {}, Level.None, { cluster: "prod-eu-z2 z2" })).toBe(false);
  });

  it("takes a field's name and operator alone for lines that have the field", () => {
    const json = '{"level":"info","msg":"ok","trace_id":"abc"}';
    expect(matches("trace_id:", json)).toBe(true);
    expect(matches("trace_id=", '{"msg":"no trace"}')).toBe(false);
    expect(matches("!trace_id:", '{"msg":"no trace"}')).toBe(true);
    // A plain line: what it says.
    expect(matches("error:", "upstream error: refused")).toBe(true);
    expect(matches("error:", "upstream error refused")).toBe(false);
    expect(matches("level:", "anything")).toBe(true);
    expect(parseQuery("trace_id: x").spans).toEqual([
      [0, 8, "key"],
      [8, 9, "op"],
      [10, 11, "text"],
    ]);
    expect(describeQuery(parseQuery("trace_id: !user="))).toBe("with trace_id · without user");
  });

  it("colours the input by what each term is", () => {
    expect(parseQuery('!a key>=5 "x y" /r.*/').spans).toEqual([
      [0, 1, "not"],
      [1, 2, "text"],
      [3, 6, "key"],
      [6, 8, "op"],
      [8, 9, "value"],
      [10, 15, "phrase"],
      [16, 21, "regex"],
    ]);
  });

  it("highlights what it looks for: words, expressions, field values (not what it leaves out)", () => {
    const hl = highlighter(parseQuery("err /t.me/ !skip user=bob"));
    expect(hl("ERR time skip bob")).toEqual([
      [0, 3],
      [4, 8],
      [14, 17],
    ]);
    expect(highlighter(parseQuery(""))("x")).toEqual([]);
    // Overlapping matches are merged.
    expect(highlighter(parseQuery("abc bcd"))("abcd")).toEqual([[0, 4]]);
  });

  it("builds terms from values and adds them: one more value of a field, the opposite one gone", () => {
    expect(fieldTerm("status", 503)).toBe("status=503");
    expect(fieldTerm("msg", "a b")).toBe('msg="a b"');
    expect(fieldTerm("user", "bob", true)).toBe("!user=bob");
    expect(withTerm("", "status=503")).toBe("status=503");
    expect(withTerm("error user=bob", "status=503")).toBe("error user=bob status=503");
    expect(withTerm("status=503", "status=503")).toBe("status=503");
    // Another value of a field wanted: either; another left out: neither.
    expect(withTerm("error status=200", "status=503")).toBe("error status=200,503");
    expect(withTerm("status=200,503", "status=503")).toBe("status=200,503");
    expect(withTerm("!path=/healthz error", "!path=/metrics")).toBe("!path=/healthz,/metrics error");
    expect(withTerm('msg="a b"', fieldTerm("msg", "c, d"))).toBe('msg="a b","c, d"');
    expect(compile(parseQuery(withTerm('msg="a b"', fieldTerm("msg", "c, d"))))(subject('{"msg":"c, d"}'))).toBe(true);
    // The same value the other way round goes.
    expect(withTerm("status=503 error", "!status=503")).toBe("error !status=503");
    expect(withTerm("status=200,503", "!status=503")).toBe("status=200 !status=503");
    expect(withTerm("!status=503", "status=503")).toBe("status=503");
    // Other operators are other terms.
    expect(withTerm("status>=500 status!=503", "status=502")).toBe("status>=500 status!=503 status=502");
  });

  it("describes itself, and has a key per meaning", () => {
    expect(describeQuery(parseQuery('error !healthz status>=500 level:warn "a b"'))).toBe('with "error" · without "healthz" · status ≥ 500 · level contains warn · with "a b"');
    expect(queryKey(parseQuery(" error "))).toBe(queryKey(parseQuery("error")));
    expect(queryKey(parseQuery("error"))).not.toBe(queryKey(parseQuery("error", { matchCase: true })));
    expect(queryKey(parseQuery("  "))).toBe("");
  });
});
