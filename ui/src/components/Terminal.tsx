import "@xterm/xterm/css/xterm.css";
import { FitAddon } from "@xterm/addon-fit";
import { type ITheme, Terminal } from "@xterm/xterm";
import { createEffect, on, onCleanup, onMount } from "solid-js";
import { backend, type TermMessage, type TermSession, type TermSize } from "../lib/backend";
import { setTermStatus, type TermTab } from "../state/dock";

/** Lines a terminal keeps above its screen. */
const SCROLLBACK = 10_000;
/** How long the terminal's box keeps a new width before the terminal takes it (see `boxResized`). */
const SETTLE_MS = 100;

/** The terminal's colours from the theme's tokens: the logs' ANSI palette on the panel's background. */
function themeColors(): ITheme {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string) => css.getPropertyValue(name).trim();
  const ansi = (i: number) => v(`--ansi-${i}`);
  return {
    background: v("--bg-panel"),
    foreground: v("--text"),
    cursor: v("--text"),
    cursorAccent: v("--bg-panel"),
    selectionBackground: v("--term-selection") || "rgba(124, 108, 255, 0.35)",
    black: ansi(0),
    red: ansi(1),
    green: ansi(2),
    yellow: ansi(3),
    blue: ansi(4),
    magenta: ansi(5),
    cyan: ansi(6),
    white: ansi(7),
    brightBlack: ansi(8),
    brightRed: ansi(9),
    brightGreen: ansi(10),
    brightYellow: ansi(11),
    brightBlue: ansi(12),
    brightMagenta: ansi(13),
    brightCyan: ansi(14),
    brightWhite: ansi(15),
  };
}

function decode(b64: string): Uint8Array {
  const s = atob(b64);
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
  return bytes;
}

const dim = (text: string) => `\x1b[2m${text}\x1b[0m`;

/**
 * One terminal tab: an xterm.js terminal and its session. It lives as long as the tab — hidden, not unmounted,
 * while another tab or the table has the screen — so the shell, its output and scrollback stay.
 *
 * What the engine sends is drawn as it comes; each chunk is acknowledged once drawn (the engine stops reading
 * while too much waits, see `k10s_core::term`). A shell or attach session that ended starts again on Enter;
 * debug containers and node shells create something, so starting another is the menu's business.
 */
export function TerminalView(props: { tab: TermTab; visible: boolean }) {
  let el!: HTMLDivElement;
  const term = new Terminal({
    fontFamily: getComputedStyle(document.documentElement).getPropertyValue("--font-mono").trim() || "monospace",
    fontSize: 12.5,
    lineHeight: 1.15,
    scrollback: SCROLLBACK,
    cursorBlink: true,
    allowProposedApi: false,
    theme: themeColors(),
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  const id = props.tab.id;
  const target = props.tab.target;
  const restartable = target.kind === "shell" || target.kind === "attach";
  let session: TermSession | undefined;
  let ended = false;

  const start = () => {
    ended = false;
    const size: TermSize = { cols: term.cols, rows: term.rows };
    let self: TermSession | undefined;
    const onMessage = (m: TermMessage) => {
      switch (m.t) {
        case "out":
          term.write(decode(m.d), () => self?.ack(m.n));
          break;
        case "state":
          setTermStatus(id, (prev) => ({ state: m.state, message: m.message, pod: m.pod ?? prev?.pod, container: m.container ?? prev?.container }));
          if (m.state !== "open" && m.message) term.write(dim(`${m.message}…`) + "\r\n");
          if (m.state === "open" && props.visible) term.focus();
          break;
        case "end": {
          ended = true;
          session = undefined;
          setTermStatus(id, (prev) => ({ ...prev, state: "ended", code: m.code, error: m.error, message: m.message }));
          const how = m.error ? `\x1b[31m${m.message ?? "the session failed"}\x1b[0m` : dim(`[exited${m.code != null ? ` with code ${m.code}` : ""}]`);
          term.write(`\r\n${how}\r\n`);
          if (restartable) term.write(dim("Press Enter to start a new session.") + "\r\n");
          break;
        }
      }
    };
    const t = target;
    // (Log tabs are not terminals: the dock shows them with the log view.)
    if (t.kind === "logs") return;
    self = t.kind === "debug" ? backend().startDebug({ ...t.spec, size }, onMessage) : t.kind === "node" ? backend().startNodeShell({ ...t.spec, size }, onMessage) : backend().startTerminal({ ...t.spec, size }, onMessage);
    session = self;
  };

  let settling: ReturnType<typeof setTimeout> | undefined;
  /** Fits the terminal to its box — only while it is on screen (a hidden one measures nothing). */
  const refit = () => {
    clearTimeout(settling);
    if (!el || !el.clientWidth || !el.clientHeight) return;
    try {
      fit.fit();
    } catch {
      // not measurable yet
    }
  };
  /**
   * The box changed size: fitted at once while the columns stay, else once its width has stayed for a moment. New
   * columns reflow the whole scrollback and have the shell (or a full-screen program in it) draw its screen again, and
   * dragging the sidebar's edge or the window's changes them every few frames.
   */
  const boxResized = () => {
    clearTimeout(settling);
    let cols: number | undefined;
    try {
      cols = fit.proposeDimensions()?.cols;
    } catch {
      // not measurable yet
    }
    if (cols === undefined || cols === term.cols) refit();
    else settling = setTimeout(refit, SETTLE_MS);
  };

  onMount(() => {
    term.open(el);
    refit();
    term.onData((data) => {
      if (session) session.input(data);
      else if (ended && restartable && data === "\r") start();
    });
    term.onBinary((data) => session?.input(data, true));
    term.onResize((s) => session?.resize({ cols: s.cols, rows: s.rows }));
    const resized = new ResizeObserver(boxResized);
    resized.observe(el);
    // The web font may arrive after the first measurement: measure again.
    void document.fonts?.ready.then(refit);
    // Theme switches (also the system's): new colours from the tokens.
    const themed = new MutationObserver(() => (term.options.theme = themeColors()));
    themed.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    start();
    onCleanup(() => {
      clearTimeout(settling);
      resized.disconnect();
      themed.disconnect();
      session?.close();
      term.dispose();
    });
  });

  // Shown (its tab picked, the dock opened): fit it to the box it got and give it the keyboard — unless the keyboard
  // is on the dock's tabs (← → going along them): it stays there.
  createEffect(
    on(
      () => props.visible,
      (visible) => {
        if (!visible) return;
        requestAnimationFrame(() => {
          refit();
          if (!document.activeElement?.closest(".dock-tabs")) term.focus();
        });
      },
    ),
  );

  return <div class="term" ref={el} data-own-keys onMouseDown={() => term.focus()} />;
}
