import { describe, expect, it } from "vitest";
import { follows, isGoroutine, Level, levelOf, logfmtOf, startsStack, structure } from "./parse";

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

  it("knows Go's crash reports: goroutine headers with their fields, frames' files with their registers", () => {
    // Go 1.23 on a fatal error, and with GOTRACEBACK=system.
    expect(follows("goroutine 7 gp=0xc000102a80 m=nil [IO wait]:", false, 0)).toBe(2);
    expect(follows("goroutine 1 gp=0xc000002380 m=0 mp=0x1d5a6c0 [running]:", false, 0)).toBe(2);
    expect(follows("goroutine 5 [select, 2 minutes]:", false, 0)).toBe(2);
    expect(follows("\t/usr/local/go/src/runtime/proc.go:435 +0xce fp=0xc00008be30 sp=0xc00008be10 pc=0x47e2ce", false, 0)).toBe(2);
    expect(follows("\t/usr/local/go/src/runtime/asm_amd64.s:1700 +0x1", false, 0)).toBe(2);
    expect(follows("\t/src/internal/shop/cart.go:42", false, 0)).toBe(2);
    expect(follows("runtime stack:", false, 0)).toBe(2);
    expect(follows("[signal SIGSEGV: segmentation violation code=0x1 addr=0x0 pc=0x4a2b3c]", false, 0)).toBe(2);
    expect(follows("created by example.com/shop/internal/queue.Start in goroutine 1", false, 0)).toBe(2);
    expect(follows("created by main.main", false, 0)).toBe(2);
    // A tab and a port is no frame; who created what is no goroutine's creator.
    expect(follows("\tlocalhost:8080", false, 0)).toBe(1);
    expect(follows("created by admin: order 42", false, 0)).toBe(0);
    for (const head of ["fatal error: concurrent map writes", "SIGQUIT: quit", "goroutine 7 gp=0xc000102a80 m=nil [IO wait]:", "\t/src/main.go:12 +0x1d", "created by main.main in goroutine 1"]) expect(startsStack(head), head).toBe(true);
    expect(levelOf("SIGSEGV: segmentation violation")).toBe(Error);
    // A signal's report word for word: a line that only begins so is no crash.
    expect(levelOf("SIGQUIT: draining connections")).toBe(None);
    expect(startsStack("SIGQUIT: draining connections")).toBe(false);
    // A frame's function is unindented: more of the stack trace only once one has begun.
    expect(follows("example.com/shop/internal/queue.(*Worker).run(0xc0001a2000)", false, 0)).toBe(0);
    expect(follows("example.com/shop/internal/queue.(*Worker).run(0xc0001a2000)", true, 0)).toBe(1);
    expect(startsStack("main.main()")).toBe(false);
    expect(isGoroutine("goroutine 7 gp=0xc000102a80 m=nil [IO wait]:")).toBe(true);
    expect(isGoroutine("goroutines: 7")).toBe(false);
  });

  it("tells a stack trace's own lines, every kind of them, from the rest", () => {
    // (Most lines are ruled out by their first character: each kind of line must begin with one the patterns let in.)
    const own = [
      "Caused by: java.io.IOException: closed",
      "Suppressed: java.io.IOException: closed",
      "... 12 more",
      "... 3 common frames omitted",
      "goroutine 7 [select]:",
      "[recovered]",
      "[signal SIGSEGV: segmentation violation code=0x1 addr=0x0 pc=0x4a2b3c]",
      "created by main.main in goroutine 1",
      "runtime stack:",
      "During handling of the above exception, another exception occurred:",
      "The above exception was the direct cause of the following exception:",
      "Traceback (most recent call last):",
    ];
    for (const line of own) {
      expect(follows(line, false, 0), line).toBe(2);
      expect(startsStack(line), line).toBe(true);
    }
    for (const line of ["panic: boom", "fatal error: all goroutines are asleep - deadlock!", "SIGABRT: abort", 'Exception in thread "main" java.lang.IllegalStateException', "\t/src/main.go:12"]) expect(startsStack(line), line).toBe(true);
    for (const line of ["Cause: none", "goroutines: 7", "created by admin: order 42", "runtime stacks:", "The above is fine", "plain words", "\tplain words"]) expect(startsStack(line), line).toBe(false);
  });

  it("keeps a warning's or an error's Go stack with it, written with it (zap's console, pkg/errors' %+v)", () => {
    expect(follows("example.com/shop/internal/cart.(*Handler).add", false, 0, Warn)).toBe(2);
    expect(follows("main.main", false, 1, Error)).toBe(2);
    // Not after a line of a lower level (a list of names under a heading), nor written later, nor of unknown time.
    expect(follows("docs/index.html", false, 0, None)).toBe(0);
    expect(follows("example.com/shop/internal/cart.(*Handler).add", false, 0, Info)).toBe(0);
    expect(follows("example.com/shop/internal/cart.(*Handler).add", false, 20, Warn)).toBe(0);
    expect(follows("example.com/shop/internal/cart.(*Handler).add", false, null, Warn)).toBe(0);
    expect(follows("a sentence. with words", false, 0, Error)).toBe(0);
  });

  it("reads huge lines by their beginnings, not through to their ends", () => {
    const huge = "x".repeat(1_000_000);
    expect(follows(`\t/${huge}`, false, 0)).toBe(1);
    expect(follows(`created by ${huge}`, false, 0)).toBe(0);
    expect(follows(`goroutine 7 gp=${huge}`, false, 0)).toBe(0);
    expect(follows(`example.com/${huge}`, false, 0, Error)).toBe(0);
    expect(startsStack(`\t${huge}.go:12`)).toBe(false);
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
