import { describe, expect, it } from "vitest";
import { follows, Level, levelOf, logfmtOf, startsStack, structure } from "./parse";

const { None, Trace, Debug, Info, Warn, Error } = Level;

describe("levelOf", () => {
  it("reads the level a line says it has, whatever its format", () => {
    const cases: [string, Level][] = [
      ['{"level":"info","msg":"started"}', Info],
      ['{"severity":"ERROR","message":"boom"}', Error],
      ['{"level":30,"msg":"pino"}', Info],
      ['{"level":50,"msg":"pino error"}', Error],
      ['{"log":{"level":"warn"},"message":"ecs"}', Warn],
      ['{"@l":"Debug","@mt":"serilog"}', Debug],
      ["level=warn msg=slow", Warn],
      ['time=2026-10-04T10:42:01Z level=error msg="failed"', Error],
      ["I1004 10:42:01.123456       1 controller.go:123] Starting workers", Info],
      ["E1004 10:42:01.123456       1 reflector.go:7] failed to list", Error],
      ["W1004 10:42:01.123456       1 x.go:1] retrying", Warn],
      ["E, [2026-10-04T10:42:01.123 #1] ERROR -- : ruby", Error],
      ["2026/10/04 10:42:01 [error] 29#29: *1 open() failed", Error],
      ["[2026-10-04 10:42:01,123] WARN [Controller id=1] slow", Warn],
      ["2026-10-04T10:42:01.123Z  INFO 1 --- [main] o.s.b.StartupInfoLogger : Starting", Info],
      ["2026-10-04 10:42:01.123 UTC [1] LOG:  database system is ready", Info],
      ["ERRO[0000] logrus failed", Error],
      ["DEBU[0000] logrus details", Debug],
      ["\x1b[32mINFO\x1b[0m coloured".replace(/\x1b\[\d+m/g, ""), Info],
      ["error: winston style", Error],
      ["panic: runtime error: index out of range", Error],
      ["Traceback (most recent call last):", Error],
      ["TRACE entering handler", Trace],
      ['10.0.0.1 - - [04/Oct/2026:10:42:01 +0000] "GET /api HTTP/1.1" 503 12', Error],
      ['10.0.0.1 - - [04/Oct/2026:10:42:01 +0000] "GET /missing HTTP/1.1" 404 12', Warn],
      ['10.0.0.1 - - [04/Oct/2026:10:42:01 +0000] "GET / HTTP/1.1" 200 612', Info],
      ["just a line", None],
      // Words in prose are not levels: only capitals, tags, keys and line starts are.
      ["no error found, information is fine", None],
      ['{"severity":"high","msg":"not a level"}', None],
    ];
    for (const [line, level] of cases) expect(levelOf(line), line).toBe(level);
  });

  it("takes the leftmost level word", () => {
    expect(levelOf("INFO retry after ERROR in upstream")).toBe(Info);
    expect(levelOf("[warn] then INFO")).toBe(Warn);
  });
});

describe("structure", () => {
  it("parses JSON lines: flattened fields, message, level and time keys", () => {
    const s = structure('{"ts":1.7e9,"level":"info","msg":"request completed","http":{"method":"GET","status":200},"tags":["a"],"ok":true,"err":null}')!;
    expect(s.kind).toBe("json");
    expect(s.fields).toEqual([
      ["ts", 1.7e9],
      ["level", "info"],
      ["msg", "request completed"],
      ["http.method", "GET"],
      ["http.status", 200],
      ["tags", '["a"]'],
      ["ok", true],
      ["err", null],
    ]);
    expect([s.msg, s.msgKey, s.levelKey, s.timeKey]).toEqual(["request completed", "msg", "level", "ts"]);
  });

  it("fills in a Serilog template", () => {
    expect(structure('{"@t":"2026-10-04T10:42:01Z","@mt":"Order {OrderId} placed by {User:l}","OrderId":42,"User":"bob"}')!.msg).toBe("Order 42 placed by bob");
  });

  it("parses logfmt lines, and leaves prose with a pair or two alone", () => {
    expect(logfmtOf('level=info msg="a b \\"c\\"" n=3 ok=true x=')).toEqual([
      ["level", "info"],
      ["msg", 'a b "c"'],
      ["n", 3],
      ["ok", true],
      ["x", ""],
    ]);
    expect(logfmtOf("2026-10-04T10:42:01Z level=info msg=hi")).toEqual([
      ["level", "info"],
      ["msg", "hi"],
    ]);
    expect(logfmtOf("connection pool size=20 idle=14")).toBeNull();
    expect(logfmtOf("a=1 then words b=2")).toBeNull();
    expect(logfmtOf("only=one")).toBeNull();
    expect(structure("plain text")).toBeNull();
    expect(structure("{not json}")).toBeNull();
    expect(structure("[1,2,3]")).toBeNull();
  });
});

describe("follows", () => {
  it("tells continuation lines from lines of their own", () => {
    expect(follows("\tat com.acme.Main.run(Main.java:1)", false, 0)).toBe(2);
    expect(follows('  File "app.py", line 3, in <module>', false, 0)).toBe(2);
    expect(follows("    more of a pretty dump", false, 0)).toBe(1);
    expect(follows("Caused by: java.io.IOException", false, 0)).toBe(2);
    expect(follows("goroutine 1 [running]:", false, 0)).toBe(2);
    expect(follows("java.lang.IllegalStateException: boom", false, 1)).toBe(2);
    // An exception's first line written much later is not part of the line before it.
    expect(follows("java.lang.IllegalStateException: boom", false, 300)).toBe(0);
    expect(follows("    indented but a second later", false, 2000)).toBe(0);
    expect(follows('  {"json":"is its own"}', false, 0)).toBe(0);
    expect(follows("{}", true, 0)).toBe(0);
    expect(follows("a new line", false, 0)).toBe(0);
    expect(follows("", false, 0)).toBe(0);
  });

  it("keeps unindented lines in a stack trace until one starts an entry", () => {
    expect(startsStack("panic: boom")).toBe(true);
    expect(follows("", true, 0)).toBe(1);
    expect(follows("main.main()", true, 0)).toBe(1);
    expect(follows("ValueError: bad value", true, 0)).toBe(1);
    expect(follows("2026-10-04 10:42:01 INFO next", true, 0)).toBe(0);
    expect(follows("INFO next", true, 0)).toBe(0);
    expect(follows("level=info msg=next", true, 0)).toBe(0);
  });
});
