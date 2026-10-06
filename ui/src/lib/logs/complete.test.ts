import { describe, expect, it } from "vitest";
import { applyAt, rank, spotAt } from "./complete";

/** The spot at the `|` of `s`. */
const spot = (s: string, explicit = false) => spotAt(s.replace("|", ""), s.indexOf("|"), explicit);
/** `s` (with the caret at `|`) with `text` taken there, the caret shown as `|`. */
const take = (s: string, text: string) => {
  const sp = spot(s)!;
  const r = applyAt(s.replace("|", ""), sp, text);
  return `${r.input.slice(0, r.caret)}|${r.input.slice(r.caret)}`;
};

describe("completing a query", () => {
  it("knows a field's name is typed where a term may start with one", () => {
    expect(spot("err timeout lev|")).toEqual({ kind: "key", prefix: "lev", from: 12, to: 15, op: null });
    expect(spot("!tra|")).toEqual({ kind: "key", prefix: "tra", from: 1, to: 4, op: null });
    // Inside a name: all of it is replaced, the operator after it stays.
    expect(spot("sta|tus>=500")).toEqual({ kind: "key", prefix: "sta", from: 0, to: 6, op: ">=" });
    // Words that cannot be fields, regular expressions, phrases, blanks.
    for (const s of ["500m|s", "a/b|", "/time.?o|ut/", '"connection re|', "x |", "!|"]) expect(spot(s)).toBeNull();
    // Asked for: between terms too.
    expect(spot("x |", true)).toEqual({ kind: "key", prefix: "", from: 2, to: 2, op: null });
    expect(spot("!|", true)).toEqual({ kind: "key", prefix: "", from: 1, to: 1, op: null });
  });

  it("knows a field's value is typed after its operator: the item of a list, a quoted one", () => {
    expect(spot("level:|")).toEqual({ kind: "value", key: "level", op: ":", prefix: "", from: 6, to: 6, quoted: false, list: false });
    expect(spot("x !pod=web|-1")).toEqual({ kind: "value", key: "pod", op: "=", prefix: "web", from: 7, to: 12, quoted: false, list: false });
    expect(spot("status>=5|")).toMatchObject({ key: "status", op: ">=", prefix: "5" });
    expect(spot("level:warn,er|")).toMatchObject({ prefix: "er", from: 11, to: 13, list: true });
    expect(spot("level:wa|,error")).toMatchObject({ prefix: "wa", from: 6, to: 8, list: true });
    expect(spot('msg:"connection re|')).toMatchObject({ prefix: "connection re", from: 4, quoted: true });
    // Items in quotes are items too, and a comma in quotes is in the item.
    expect(spot('msg="a b",c|')).toMatchObject({ prefix: "c", from: 10, to: 11, quoted: false, list: true });
    expect(spot('msg=a,"b, c|')).toMatchObject({ prefix: "b, c", from: 6, to: 11, quoted: true, list: true });
    expect(spot('msg="a, b|"')).toMatchObject({ prefix: "a, b", from: 4, to: 10, quoted: true, list: false });
    // What is typed, as the query reads it: an escaped quote is a quote.
    expect(spot('msg="ab\\"|')).toMatchObject({ prefix: 'ab"', quoted: true });
  });

  it("puts a name with its operator, a value quoted when it must be and a blank after it", () => {
    expect(take("err lev|", "level")).toBe("err level:|");
    expect(take("sta|tus>=500", "status")).toBe("status>=|500");
    expect(take("level:e|", "error")).toBe("level:error |");
    expect(take("pod=w| x", "web-1")).toBe("pod=web-1| x");
    expect(take("msg:con|", "connection refused")).toBe('msg:"connection refused" |');
    expect(take('msg:"con|', "connection refused")).toBe('msg:"connection refused" |');
    expect(take("level:warn,e|", "error")).toBe("level:warn,error|");
    expect(take('msg="a b",c|', "connection refused")).toBe('msg="a b","connection refused"|');
    expect(take('msg=a,"b|', "b c")).toBe('msg=a,"b c"|');
  });

  it("ranks what starts with what is typed first, then a word in it, the most common first", () => {
    const items = [
      { text: "request_id", count: 5 },
      { text: "trace_id", count: 9 },
      { text: "idle", count: 1 },
      { text: "hidden", count: 50 },
      { text: "userId", count: 3 },
    ];
    const r = rank(items, "id");
    expect(r.map((x) => x.text)).toEqual(["idle", "trace_id", "request_id", "userId", "hidden"]);
    expect(r[1].at).toEqual([6, 7]);
    expect(rank(items, "zz")).toEqual([]);
    // What is typed whole comes first, however rare.
    expect(rank([...items, { text: "ID", count: 1 }], "id")[0]).toMatchObject({ text: "ID", score: -1 });
    // As given: levels in their order, whatever their counts.
    expect(rank([{ text: "error", count: 1 }, { text: "warn", count: 9 }], "", false).map((x) => x.text)).toEqual(["error", "warn"]);
  });
});
