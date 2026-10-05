import { describe, expect, it } from "vitest";
import { blockMask, type Token, type TokenKind, tokenizeLine } from "./yaml";

const kinds = (line: string, inBlock = false) => tokenizeLine(line, inBlock).map((t) => [t.kind, t.text]);

describe("tokenizeLine", () => {
  it("highlights keys, values and comments", () => {
    expect(kinds("  name: payments-api")).toEqual([
      ["plain", "  "],
      ["key", "name"],
      ["punct", ":"],
      ["plain", " "],
      ["str", "payments-api"],
    ]);
    expect(kinds("- replicas: 3 # scaled")).toEqual([
      ["punct", "- "],
      ["key", "replicas"],
      ["punct", ":"],
      ["plain", " "],
      ["num", "3"],
      ["comment", " # scaled"],
    ]);
    expect(kinds('"app.kubernetes.io/name": web')).toEqual([
      ["key", '"app.kubernetes.io/name"'],
      ["punct", ":"],
      ["plain", " "],
      ["str", "web"],
    ]);
    expect(kinds("  - true")).toEqual([
      ["plain", "  "],
      ["punct", "- "],
      ["bool", "true"],
    ]);
    expect(kinds("data: |-")).toEqual([
      ["key", "data"],
      ["punct", ":"],
      ["plain", " "],
      ["block", "|-"],
    ]);
    expect(kinds("  # comment")).toEqual([["comment", "  # comment"]]);
    expect(kinds("anything", true)).toEqual([["str", "anything"]]);
  });

  it("matches the previous regex highlighter on every short line", () => {
    // Random lines over the characters that matter to the grammar.
    const alphabet = [" ", " ", "a", "b", ":", ":", "#", '"', "'", "-", "- ", "|", ">", "\\", "1", "0x1f", ".", "e", "~", "&", "{}", "\t", "true", "null"];
    let seed = 11;
    const rand = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31), seed % n);
    for (let k = 0; k < 20_000; k++) {
      let line = "";
      for (let p = rand(9); p >= 0; p--) line += alphabet[rand(alphabet.length)];
      expect(tokenizeLine(line, false), JSON.stringify(line)).toEqual(legacyTokenize(line));
      expect(blockMask([line, "  x"]), JSON.stringify(line)).toEqual(legacyBlockMask([line, "  x"]));
    }
  });

  it("is linear on hostile lines", () => {
    const n = 200_000;
    const hostile = [
      ` a${" ".repeat(n)}b`,
      `key: a${" ".repeat(n)}b`,
      `- a${" \t".repeat(n / 2)}#`,
      `"${"a".repeat(n)}`,
      `- "${"\\".repeat(n)}`,
      `'${"x: ".repeat(n / 3)}`,
      `${" ".repeat(n)}x`,
      `${"a:".repeat(n / 2)}`,
      `${": ".repeat(n / 2)}|`,
      `k: ${"1".repeat(n)}x`,
      `:${" ".repeat(n)}|${"1".repeat(n)}${" ".repeat(n)}x`,
    ];
    for (const line of hostile) {
      const t0 = performance.now();
      tokenizeLine(line, false);
      blockMask([line]);
      expect(performance.now() - t0, line.slice(0, 20)).toBeLessThan(150);
    }
  });
});

describe("blockMask", () => {
  it("marks block scalar lines", () => {
    const lines = ["data:", "  script: |", "    echo hi", "", "    exit 0", "  other: x", "items:", "- >-", "  folded", "- y"];
    expect(blockMask(lines)).toEqual([false, false, true, true, true, false, false, false, true, false]);
  });
});

// The regex-based highlighter this module replaced, for comparison on ordinary input.
const KEY_RE = /^(\s*)(- )?((?:"(?:[^"\\]|\\.)*"|'[^']*'|[^\s#:'"][^:#]*?))(:)(?=\s|$)(.*)$/;
const ITEM_RE = /^(\s*)(- )(.*)$/;
function legacyScalar(text: string): Token[] {
  const out: Token[] = [];
  const m = /^(\s*)(.*?)(\s+#.*)?$/.exec(text);
  if (!m) return [{ kind: "plain", text }];
  const [, lead, value, comment] = m;
  if (lead) out.push({ kind: "plain", text: lead });
  if (value) {
    let kind: TokenKind = "str";
    if (/^[|>][-+0-9]*$/.test(value)) kind = "block";
    else if (/^(true|false|yes|no|on|off)$/i.test(value)) kind = "bool";
    else if (/^(null|~)$/i.test(value)) kind = "null";
    else if (/^[-+]?(\d[\d_]*(\.\d+)?([eE][-+]?\d+)?|0x[0-9a-fA-F]+|\.inf|\.nan)$/.test(value)) kind = "num";
    else if (/^[&*!]/.test(value)) kind = "anchor";
    else if (value === "{}" || value === "[]") kind = "punct";
    out.push({ kind, text: value });
  }
  if (comment) out.push({ kind: "comment", text: comment });
  return out;
}
function legacyTokenize(line: string): Token[] {
  if (/^\s*#/.test(line)) return [{ kind: "comment", text: line }];
  const km = KEY_RE.exec(line);
  if (km) {
    const [, indent, dash, key, colon, rest] = km;
    const out: Token[] = [];
    if (indent) out.push({ kind: "plain", text: indent });
    if (dash) out.push({ kind: "punct", text: dash });
    out.push({ kind: "key", text: key }, { kind: "punct", text: colon });
    if (rest) out.push(...legacyScalar(rest));
    return out;
  }
  const im = ITEM_RE.exec(line);
  if (im) {
    const [, indent, dash, rest] = im;
    const out: Token[] = [];
    if (indent) out.push({ kind: "plain", text: indent });
    out.push({ kind: "punct", text: dash }, ...legacyScalar(rest));
    return out;
  }
  return legacyScalar(line);
}
function legacyBlockMask(lines: string[]): boolean[] {
  const mask = new Array<boolean>(lines.length).fill(false);
  let blockIndent = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const indent = line.length - line.trimStart().length;
    if (blockIndent >= 0) {
      if (line.trim() === "" || indent > blockIndent) {
        mask[i] = true;
        continue;
      }
      blockIndent = -1;
    }
    if (/:\s*[|>][-+0-9]*\s*$/.test(line) || /^\s*-\s+[|>][-+0-9]*\s*$/.test(line)) blockIndent = indent;
  }
  return mask;
}
