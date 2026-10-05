import { createMemo, createRoot } from "solid-js";
import { afterEach, describe, expect, it } from "vitest";
import { contrast, LOG_BACKGROUND, MIN_CONTRAST, parseAnsi, type Segment, setAnsiTheme, stripAnsi } from "./ansi";

const E = "\x1b";
afterEach(() => setAnsiTheme("dark"));

describe("parseAnsi", () => {
  it("styles text with SGR sequences", () => {
    expect(parseAnsi("plain")).toEqual([{ text: "plain" }]);
    expect(parseAnsi(`${E}[31mred${E}[0m and ${E}[1;92mbold green${E}[22m plain green${E}[39m`)).toEqual([
      { text: "red", fg: "var(--ansi-1)" },
      { text: " and " },
      { text: "bold green", fg: "var(--ansi-10)", bold: true },
      { text: " plain green", fg: "var(--ansi-10)" },
    ]);
    // Faint text is muted by colour, not faded (fading would make it unreadable).
    expect(parseAnsi(`${E}[2;3;4mx${E}[23;24my${E}[mz${E}[2;91mw${E}[22mv`)).toEqual([
      { text: "x", fg: "var(--ansi-dim)", italic: true, underline: true },
      { text: "y", fg: "var(--ansi-dim)" },
      { text: "z" },
      { text: "w", fg: "var(--ansi-1)" },
      { text: "v", fg: "var(--ansi-9)" },
    ]);
    expect(parseAnsi(`${E}[38;5;4ma${E}[38;5;12mb${E}[38;5;208mc${E}[38;2;10;200;30md`)).toEqual([
      { text: "a", fg: "var(--ansi-4)" },
      { text: "b", fg: "var(--ansi-12)" },
      { text: "c", fg: "rgb(255,135,0)" },
      { text: "d", fg: "rgb(10,200,30)" },
    ]);
  });

  it("drops other escape sequences", () => {
    // Cursor movement, private modes, charset designation, window title (BEL and ST), hyperlinks.
    const line = `${E}[2K${E}[?25l${E}(Bstart ${E}]0;title\x07${E}]8;;https://example.com${E}\\link${E}]8;;${E}\\ middle ${E}]8;;https://example.org\x07two${E}]8;;\x07 end${E}7`;
    expect(stripAnsi(line)).toBe("start link middle two end");
    expect(parseAnsi(line).map((s) => s.text).join("")).toBe("start link middle two end");
  });

  it("drops a lone or unterminated ESC and keeps the text after it", () => {
    expect(stripAnsi(`a${E}`)).toBe("a");
    expect(stripAnsi(`a${E}[12;`)).toBe("a[12;");
    expect(stripAnsi(`a${E}]0;no terminator`)).toBe("a]0;no terminator");
    expect(stripAnsi(`a${E}]0;title${E}[31mred`)).toBe("a]0;titlered");
    expect(parseAnsi(`a${E}]0;title${E}[31mred`).at(-1)).toEqual({ text: "red", fg: "var(--ansi-1)" });
  });

  it("gives text on a coloured background a readable ink", () => {
    // Background only, black or white on a colour: the log background colour (readable on every token).
    expect(parseAnsi(`${E}[41m ERROR ${E}[0m`)[0]).toEqual({ text: " ERROR ", bg: "var(--ansi-1)", fg: "var(--ansi-base)" });
    expect(parseAnsi(`${E}[97;41mx`)[0]).toEqual({ text: "x", bg: "var(--ansi-1)", fg: "var(--ansi-base)" });
    expect(parseAnsi(`${E}[30;43mx`)[0]).toEqual({ text: "x", bg: "var(--ansi-3)", fg: "var(--ansi-base)" });
    // A colour on a colour is the program's choice.
    expect(parseAnsi(`${E}[31;42mx`)[0]).toEqual({ text: "x", bg: "var(--ansi-2)", fg: "var(--ansi-1)" });
    // Computed backgrounds: black or white by luminance.
    expect(parseAnsi(`${E}[48;5;226mx`)[0]).toEqual({ text: "x", bg: "rgb(255,255,0)", fg: "#16161a" });
    expect(parseAnsi(`${E}[48;2;20;20;120mx`)[0]).toEqual({ text: "x", bg: "rgb(20,20,120)", fg: "#f4f4f6" });
  });

  it("supports inverse video (SGR 7 / 27)", () => {
    expect(parseAnsi(`${E}[7m PASS ${E}[27m ok`)).toEqual([{ text: " PASS ", fg: "var(--ansi-base)", bg: "var(--text)" }, { text: " ok" }]);
    expect(parseAnsi(`${E}[1;7;31m FAIL ${E}[0m`)[0]).toEqual({ text: " FAIL ", fg: "var(--ansi-base)", bg: "var(--ansi-1)", bold: true });
    expect(parseAnsi(`${E}[31;42;7mx`)[0]).toEqual({ text: "x", fg: "var(--ansi-2)", bg: "var(--ansi-1)" });
    // Only a background colour: it would become text on the default text colour (red on light grey,
    // ~2.6:1). It is shown as text on the log background instead, readable by the tokens' guarantee.
    expect(parseAnsi(`${E}[41;7mx`)[0]).toEqual({ text: "x", fg: "var(--ansi-1)" });
    expect(parseAnsi(`${E}[7;100mx`)[0]).toEqual({ text: "x", fg: "var(--ansi-8)" });
    for (const theme of ["dark", "light"] as const) {
      setAnsiTheme(theme);
      const fg = parseAnsi(`${E}[48;2;250;250;120;7mx`)[0];
      expect(fg.bg).toBeUndefined();
      expect(contrast(fg.fg!.match(/\d+/g)!.map(Number) as [number, number, number], LOG_BACKGROUND[theme])).toBeGreaterThanOrEqual(MIN_CONTRAST);
    }
  });

  it("keeps 256-colour and truecolour text readable in the current theme", () => {
    const fgOf = (line: string) => parseAnsi(line)[0].fg!;
    const rgb = (css: string) => css.match(/\d+/g)!.map(Number) as [number, number, number];
    for (const theme of ["dark", "light"] as const) {
      setAnsiTheme(theme);
      for (let n = 16; n < 256; n++) expect(contrast(rgb(fgOf(`${E}[38;5;${n}mx`)), LOG_BACKGROUND[theme])).toBeGreaterThanOrEqual(MIN_CONTRAST);
      expect(contrast(rgb(fgOf(`${E}[38;2;255;255;255mx`)), LOG_BACKGROUND[theme])).toBeGreaterThanOrEqual(MIN_CONTRAST);
    }
    // Already readable colours are left alone.
    setAnsiTheme("light");
    expect(fgOf(`${E}[38;2;0;0;160mx`)).toBe("rgb(0,0,160)");
  });

  it("recomputes colours when the theme changes", () => {
    const fg = createRoot(() => createMemo(() => parseAnsi(`${E}[38;5;226myellow`)[0].fg));
    const dark = fg();
    setAnsiTheme("light");
    expect(fg()).not.toBe(dark);
  });

  it("matches the previous parser on ordinary coloured logs", () => {
    let seed = 7;
    const rand = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31), seed % n);
    const codes = ["0", "1", "2", "3", "4", "22", "23", "24", "39", "", ...[30, 31, 32, 33, 34, 35, 36, 37, 90, 91, 92, 93, 94, 95, 96, 97].map(String), "38;5;2", "38;5;9", "38;5;208", "38;2;200;120;10", "1;31", "0;32"];
    for (let k = 0; k < 500; k++) {
      let line = "";
      for (let p = rand(8); p >= 0; p--) line += rand(3) ? ["INFO ", "x", "request done", " ", "{\"a\":1}"][rand(5)] : `${E}[${codes[rand(codes.length)]}m`;
      expect(parseAnsi(line).map(normalize)).toEqual(legacyParse(line).map(expected));
      expect(stripAnsi(line)).toBe(legacyStrip(line));
    }
  });

  it("is linear on hostile input", () => {
    const hostile = [
      `${E}]`.repeat(32_768),
      `${E}[`.repeat(32_768),
      `${E}P`.repeat(32_768),
      `${E}]${"a".repeat(65_536)}`,
      `${E}[${"1;".repeat(32_768)}`,
      `${E}[${"1;".repeat(32_768)}m${"x".repeat(1000)}`,
      `${E}]8;;${E}`.repeat(13_000),
      `${E}[31m${E}`.repeat(10_000),
    ];
    for (const line of hostile) {
      const t0 = performance.now();
      stripAnsi(line);
      parseAnsi(line);
      expect(performance.now() - t0).toBeLessThan(150);
    }
  });
});

describe("ANSI colour tokens", async () => {
  // Read from disk: Vitest hands CSS imports (even `?raw`) to tests as empty modules. The path is
  // relative to this file, so the check runs from any working directory (IDE runners, `--root`).
  const [nodeFs, nodeUrl] = ["node:fs", "node:url"];
  const fs = (await import(/* @vite-ignore */ nodeFs)) as { readFileSync(path: string, encoding: "utf8"): string };
  const { fileURLToPath } = (await import(/* @vite-ignore */ nodeUrl)) as { fileURLToPath(url: string): string };
  // (Not `new URL("…", import.meta.url)` literally: Vite rewrites that pattern into a served asset URL.)
  const here = import.meta.url;
  const css = fs.readFileSync(fileURLToPath(new URL("../styles/tokens.css", here).href), "utf8");
  const block = (selector: string) => css.slice(css.indexOf(`${selector} {`), css.indexOf("}", css.indexOf(`${selector} {`)));
  const tokens = (body: string) => Object.fromEntries([...body.matchAll(/--([\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
  const dark = tokens(block(":root"));
  const light = { ...dark, ...tokens(block(':root[data-theme="light"]')) };
  const hex = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];

  it("are all readable on the log background of both themes", () => {
    for (const [theme, t] of [["dark", dark], ["light", light]] as const) {
      expect(hex(t["bg-panel"])).toEqual(LOG_BACKGROUND[theme]);
      expect(t["ansi-base"]).toBe("var(--bg-panel)");
      expect(t["ansi-dim"]).toBe("var(--text-2)");
      expect(contrast(hex(t["text-2"]), LOG_BACKGROUND[theme]), `${theme} --text-2`).toBeGreaterThanOrEqual(MIN_CONTRAST);
      for (let n = 0; n < 16; n++) expect(contrast(hex(t[`ansi-${n}`]), LOG_BACKGROUND[theme]), `${theme} --ansi-${n}`).toBeGreaterThanOrEqual(MIN_CONTRAST);
    }
  });
});

// The regex-based parser this module replaced (colours as palette indices), for comparison on ordinary input.
const BASIC = ["#4b5263", "#ef6b73", "#5fd38d", "#e6c15a", "#61afef", "#c678dd", "#56b6c2", "#d7dae0"];
const BRIGHT = ["#7f848e", "#ff8a92", "#7ee2a8", "#f5d77a", "#82c3ff", "#dc9cf0", "#7fd4df", "#ffffff"];
function xterm256(n: number): string {
  if (n < 8) return BASIC[n];
  if (n < 16) return BRIGHT[n - 8];
  if (n < 232) {
    const i = n - 16;
    const c = (v: number) => (v === 0 ? 0 : 55 + v * 40);
    return `rgb(${c(Math.floor(i / 36))},${c(Math.floor(i / 6) % 6)},${c(i % 6)})`;
  }
  const g = 8 + (n - 232) * 10;
  return `rgb(${g},${g},${g})`;
}
// eslint-disable-next-line no-control-regex
const ESC_RE = /\x1b\[([0-9;]*)([A-Za-z])|\x1b\][^\x07]*(?:\x07|\x1b\\)|\x1b[()][A-Za-z0-9]/g;
function legacyParse(input: string): Segment[] {
  if (!input.includes(E)) return [{ text: input }];
  const out: Segment[] = [];
  let style: Omit<Segment, "text"> = {};
  let last = 0;
  ESC_RE.lastIndex = 0;
  for (let m = ESC_RE.exec(input); m; m = ESC_RE.exec(input)) {
    if (m.index > last) out.push({ text: input.slice(last, m.index), ...style });
    last = ESC_RE.lastIndex;
    if (m[2] !== "m") continue;
    const codes = (m[1] || "0").split(";").map((x) => Number(x) || 0);
    for (let i = 0; i < codes.length; i++) {
      const c = codes[i];
      if (c === 0) style = {};
      else if (c === 1) style.bold = true;
      else if (c === 2) style.dim = true;
      else if (c === 3) style.italic = true;
      else if (c === 4) style.underline = true;
      else if (c === 22) style.bold = style.dim = false;
      else if (c === 23) style.italic = false;
      else if (c === 24) style.underline = false;
      else if (c >= 30 && c <= 37) style.fg = BASIC[c - 30];
      else if (c >= 90 && c <= 97) style.fg = BRIGHT[c - 90];
      else if (c === 39) style.fg = undefined;
      else if (c === 38 && codes[i + 1] === 5) {
        style.fg = xterm256(codes[i + 2] ?? 0);
        i += 2;
      } else if (c === 38 && codes[i + 1] === 2) {
        style.fg = `rgb(${codes[i + 2] ?? 0},${codes[i + 3] ?? 0},${codes[i + 4] ?? 0})`;
        i += 4;
      }
    }
  }
  if (last < input.length) out.push({ text: input.slice(last), ...style });
  return out;
}
const legacyStrip = (input: string) => input.replace(ESC_RE, "");
const normalize = (s: Segment) => ({ text: s.text, fg: s.fg, bold: !!s.bold, dim: !!s.dim, italic: !!s.italic, underline: !!s.underline });
/** What the old output becomes now: hex palette → tokens, faint text → a muted colour instead of the flag. */
function expected(s: Segment) {
  const i = s.fg ? [...BASIC, ...BRIGHT].indexOf(s.fg) : -1;
  let fg = i >= 0 ? `var(--ansi-${s.dim && i >= 8 ? i - 8 : i})` : s.fg;
  if (s.dim && !fg) fg = "var(--ansi-dim)";
  return { ...normalize(s), fg, dim: false };
}
