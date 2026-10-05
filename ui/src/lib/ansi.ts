// ANSI escape sequences → styled segments for log lines. SGR (colours, bold…) is applied; every other
// escape sequence is dropped. Log lines are untrusted: this is a single forward scan (no regex
// backtracking), linear in the line length whatever the input.

import { createSignal } from "solid-js";

export interface Segment {
  text: string;
  fg?: string;
  bg?: string;
  bold?: boolean;
  /**
   * Never set by `parseAnsi`: faint text (SGR 2) gets a muted colour that stays readable instead, as
   * fading it (opacity) would drop it below the minimum contrast.
   */
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
}

type Rgb = [number, number, number];
/** A palette index (0–15, a theme token) or a computed colour (256-colour cube, truecolour). */
type Color = number | Rgb;

interface Style {
  fg?: Color;
  bg?: Color;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  inverse?: boolean;
}

/**
 * The log background per theme (`--bg-panel` in tokens.css). The 16 standard colours are tokens
 * (`--ansi-0…15`) chosen to be readable on it; 256-colour and truecolour text is lightened or
 * darkened here until it is (minimum contrast, like terminals' "minimum contrast ratio").
 */
export const LOG_BACKGROUND: Record<"dark" | "light", Rgb> = { dark: [0x13, 0x14, 0x17], light: [0xff, 0xff, 0xff] };
export const MIN_CONTRAST = 4.5;
const [logTheme, setLogTheme] = createSignal<"dark" | "light">("dark");
/** The app's effective theme; computed colours depend on it (and re-render when it changes). */
export const setAnsiTheme = setLogTheme;

/** Text on palette backgrounds and in inverse video: the log background, readable on every token. */
const BASE = "var(--ansi-base)";
/** Faint default-coloured text. */
const DIM = "var(--ansi-dim)";
const INK_DARK = "#16161a";
const INK_LIGHT = "#f4f4f6";

function luminance([r, g, b]: Rgb): number {
  const f = (c: number) => ((c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

export function contrast(a: Rgb, b: Rgb): number {
  const x = luminance(a);
  const y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

const css = ([r, g, b]: Rgb) => `rgb(${r},${g},${b})`;

const readableCache = new Map<string, string>();
/** `c` as text on `bg`, moved towards black or white just enough to reach `MIN_CONTRAST`. */
function readable(c: Rgb, bg: Rgb): string {
  const key = `${c}|${bg}`;
  let out = readableCache.get(key);
  if (out !== undefined) return out;
  if (contrast(c, bg) >= MIN_CONTRAST) out = css(c);
  else {
    const to = luminance(bg) > 0.18 ? 0 : 255;
    const mix = (t: number): Rgb => [0, 1, 2].map((k) => Math.round(c[k] + (to - c[k]) * t)) as Rgb;
    let lo = 0;
    let hi = 1;
    for (let k = 0; k < 10; k++) {
      const mid = (lo + hi) / 2;
      if (contrast(mix(mid), bg) >= MIN_CONTRAST) hi = mid;
      else lo = mid;
    }
    out = css(mix(hi));
  }
  if (readableCache.size > 4096) readableCache.clear();
  readableCache.set(key, out);
  return out;
}

function xterm256(n: number): Color {
  if (n < 16) return n;
  if (n < 232) {
    const i = n - 16;
    const c = (v: number) => (v === 0 ? 0 : 55 + v * 40);
    return [c(Math.floor(i / 36)), c(Math.floor(i / 6) % 6), c(i % 6)];
  }
  const g = 8 + (n - 232) * 10;
  return [g, g, g];
}

const isGray = (c: Color | undefined) => c === 0 || c === 7 || c === 8 || c === 15;

/** CSS colours of a style. Text on a coloured background gets an ink that is readable on it. */
function resolve(st: Style): Omit<Segment, "text"> {
  const out: Omit<Segment, "text"> = {};
  let fg: Color | "base" | undefined = st.fg;
  let bg: Color | "text" | undefined = st.bg;
  if (st.inverse) {
    [fg, bg] = [st.bg ?? "base", st.fg ?? "text"];
    // A colour on the default text colour has no readable guarantee (red on light grey): show the colour
    // as text on the log background instead, which the tokens (and `readable`) guarantee.
    if (bg === "text" && fg !== "base") bg = undefined;
  }
  // Faint: default text becomes muted, bright colours their normal variants (both still readable).
  if (st.dim && bg === undefined && typeof fg === "number" && fg >= 8) fg -= 8;
  if (bg === "text") out.bg = "var(--text)";
  else if (typeof bg === "number") out.bg = `var(--ansi-${bg})`;
  else if (bg) out.bg = css(bg);
  if (bg !== undefined && (fg === undefined || fg === "base" || isGray(fg))) {
    // Black/white/default text on a colour: the log background on a palette colour (every token is
    // readable on it, so it is readable on every token), else black or white by the colour's luminance.
    out.fg = Array.isArray(bg) ? (luminance(bg) > 0.18 ? INK_DARK : INK_LIGHT) : BASE;
  } else if (fg === "base") out.fg = BASE;
  else if (fg === undefined && st.dim) out.fg = DIM;
  else if (typeof fg === "number") out.fg = `var(--ansi-${fg})`;
  else if (fg) out.fg = bg === undefined ? readable(fg, LOG_BACKGROUND[logTheme()]) : css(fg);
  if (st.bold) out.bold = true;
  if (st.italic) out.italic = true;
  if (st.underline) out.underline = true;
  return out;
}

const SGR_PARAMS = /^[\d;]*$/;

function applySgr(st: Style, params: string): Style {
  // Colon sub-parameters ("38:2::r:g:b", "4:3") and private SGRs ("?…m") are ignored.
  if (!SGR_PARAMS.test(params)) return st;
  const codes = (params || "0").split(";").map((x) => Number(x) || 0);
  let next: Style = { ...st };
  for (let i = 0; i < codes.length; i++) {
    const c = codes[i];
    if (c === 0) next = {};
    else if (c === 1) next.bold = true;
    else if (c === 2) next.dim = true;
    else if (c === 3) next.italic = true;
    else if (c === 4) next.underline = true;
    else if (c === 7) next.inverse = true;
    else if (c === 22) next.bold = next.dim = false;
    else if (c === 23) next.italic = false;
    else if (c === 24) next.underline = false;
    else if (c === 27) next.inverse = false;
    else if (c >= 30 && c <= 37) next.fg = c - 30;
    else if (c >= 90 && c <= 97) next.fg = c - 90 + 8;
    else if (c >= 40 && c <= 47) next.bg = c - 40;
    else if (c >= 100 && c <= 107) next.bg = c - 100 + 8;
    else if (c === 39) next.fg = undefined;
    else if (c === 49) next.bg = undefined;
    else if ((c === 38 || c === 48) && codes[i + 1] === 5) {
      const n = codes[i + 2] ?? 0;
      if (n <= 255) next[c === 38 ? "fg" : "bg"] = xterm256(n);
      i += 2;
    } else if ((c === 38 || c === 48) && codes[i + 1] === 2) {
      const v = (k: number) => Math.min(255, codes[i + k] ?? 0);
      next[c === 38 ? "fg" : "bg"] = [v(2), v(3), v(4)];
      i += 4;
    }
  }
  return next;
}

const ESC = 0x1b;
const BEL = 0x07;

/**
 * End (exclusive) of the escape sequence at `i` (an ESC), or -1 if there is no complete one there.
 * Every lookahead stops at the next ESC, so scanning a line costs O(length) in total.
 */
function sequenceEnd(s: string, i: number): number {
  const n = s.length;
  const c = s.charCodeAt(i + 1);
  if (c === 0x5b) {
    // CSI (ECMA-48): ESC [ parameter bytes 0x30–0x3F, intermediate bytes 0x20–0x2F, final byte 0x40–0x7E.
    let j = i + 2;
    while (j < n && s.charCodeAt(j) >= 0x30 && s.charCodeAt(j) <= 0x3f) j++;
    while (j < n && s.charCodeAt(j) >= 0x20 && s.charCodeAt(j) <= 0x2f) j++;
    const f = s.charCodeAt(j);
    return f >= 0x40 && f <= 0x7e ? j + 1 : -1;
  }
  if (c === 0x5d || c === 0x50 || c === 0x58 || c === 0x5e || c === 0x5f) {
    // OSC / DCS / SOS / PM / APC: a string up to BEL or ST (ESC \). Any other ESC means it is unterminated.
    for (let j = i + 2; j < n; j++) {
      const d = s.charCodeAt(j);
      if (d === BEL) return j + 1;
      if (d === ESC) return s.charCodeAt(j + 1) === 0x5c ? j + 2 : -1;
    }
    return -1;
  }
  if (c === 0x28 || c === 0x29 || c === 0x2a || c === 0x2b) {
    // Character set designation: ESC ( B…
    const d = s.charCodeAt(i + 2);
    return (d >= 0x30 && d <= 0x39) || (d >= 0x41 && d <= 0x5a) || (d >= 0x61 && d <= 0x7a) ? i + 3 : -1;
  }
  // Other two-byte sequences (ESC 7, ESC =, ESC M…).
  return c >= 0x30 && c <= 0x7e ? i + 2 : -1;
}

/**
 * Walks `input` once: `text(from, to)` for each run of plain text, `sgr(params)` for each SGR sequence
 * (`ESC [ params m`). Other sequences are skipped; an ESC that starts no complete sequence is dropped
 * and what follows it is text.
 */
function scan(input: string, text: (from: number, to: number) => void, sgr?: (params: string) => void) {
  let last = 0;
  for (let i = input.indexOf("\x1b"); i >= 0; ) {
    if (i > last) text(last, i);
    const end = sequenceEnd(input, i);
    if (end < 0) {
      last = i + 1;
      i = input.indexOf("\x1b", last);
      continue;
    }
    if (sgr && input.charCodeAt(i + 1) === 0x5b && input.charCodeAt(end - 1) === 0x6d) sgr(input.slice(i + 2, end - 1));
    last = end;
    i = input.indexOf("\x1b", end);
  }
  if (last < input.length) text(last, input.length);
}

export const hasAnsi = (s: string) => s.includes("\x1b");

export function parseAnsi(input: string): Segment[] {
  if (!hasAnsi(input)) return [{ text: input }];
  const out: Segment[] = [];
  let style: Style = {};
  let resolved: Omit<Segment, "text"> | undefined;
  scan(
    input,
    (from, to) => out.push({ text: input.slice(from, to), ...(resolved ??= resolve(style)) }),
    (params) => {
      style = applySgr(style, params);
      resolved = undefined;
    },
  );
  return out;
}

export function stripAnsi(input: string): string {
  if (!hasAnsi(input)) return input;
  let out = "";
  scan(input, (from, to) => (out += input.slice(from, to)));
  return out;
}
