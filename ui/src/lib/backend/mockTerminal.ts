import type { TermMessage, TermSession, TermState } from "./types";

// A fake shell for the browser mock: what the engine's terminals send, from a prompt with line editing (backspace,
// ⌃C, ⌃D, ⌃L, ⌃U) and a handful of commands — `seq 100000` makes plenty of output to try flow control on.

const enc = new TextEncoder();

function base64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export interface FakeShell {
  /** Before the prompt: `[state, message, ms]` steps (creating a pod, pulling an image…). */
  steps?: [TermState, string | undefined, number][];
  /** What it entered, sent with the first step (a node shell's helper pod, a debug container). */
  entered?: { pod: string; container: string };
  /** The session fails instead of opening (no permission, read-only mode…). */
  fail?: string;
  user: string;
  host: string;
  /** Text printed once it opens. */
  banner?: string;
  env: Record<string, string>;
}

export function fakeShell(shell: FakeShell, cb: (msg: TermMessage) => void): TermSession {
  let closed = false;
  let open = false;
  let line = "";
  const timers: ReturnType<typeof setTimeout>[] = [];
  const later = (ms: number, f: () => void) => timers.push(setTimeout(() => !closed && f(), ms));
  const out = (text: string) => {
    if (closed) return;
    const bytes = enc.encode(text);
    cb({ t: "out", d: base64(bytes), n: bytes.length });
  };
  const showPrompt = () => out(`\x1b[1;32m${shell.user}@${shell.host}\x1b[0m:\x1b[1;34m/\x1b[0m${shell.user === "root" ? "#" : "$"} `);
  const end = (code: number) => {
    cb({ t: "end", code, error: false });
    open = false;
  };

  const run = (cmd: string) => {
    const [name, ...args] = cmd.trim().split(/\s+/);
    switch (name) {
      case "":
        break;
      case "exit":
        end(Number(args[0] ?? 0) || 0);
        return;
      case "clear":
        out("\x1b[H\x1b[2J");
        break;
      case "ls":
        out("bin  dev  etc  home  lib  proc  root  run  sbin  srv  sys  tmp  usr  var\r\n");
        break;
      case "pwd":
        out("/\r\n");
        break;
      case "whoami":
        out(`${shell.user}\r\n`);
        break;
      case "hostname":
        out(`${shell.host}\r\n`);
        break;
      case "date":
        out(`${new Date().toUTCString()}\r\n`);
        break;
      case "uname":
        out(args.includes("-a") ? `Linux ${shell.host} 6.8.0-1021-aws #23-Ubuntu SMP x86_64 GNU/Linux\r\n` : "Linux\r\n");
        break;
      case "env":
        out(Object.entries(shell.env).map(([k, v]) => `${k}=${v}\r\n`).join(""));
        break;
      case "echo":
        out(`${args.join(" ")}\r\n`);
        break;
      case "seq": {
        const n = Math.min(Number(args[0]) || 10, 1_000_000);
        let chunk = "";
        for (let i = 1; i <= n; i++) {
          chunk += `${i}\r\n`;
          if (chunk.length > 32_000) {
            out(chunk);
            chunk = "";
          }
        }
        out(chunk);
        break;
      }
      case "colors":
        out([...Array(8).keys()].map((i) => `\x1b[3${i}m██\x1b[9${i}m██`).join("") + "\x1b[0m\r\n");
        break;
      default:
        out(`sh: ${name}: not found\r\n`);
    }
    showPrompt();
  };

  const input = (data: string) => {
    if (!open) return;
    for (const ch of data) {
      if (ch === "\r") {
        out("\r\n");
        const cmd = line;
        line = "";
        run(cmd);
        if (!open) return;
      } else if (ch === "\x7f") {
        if (line) {
          line = line.slice(0, -1);
          out("\b \b");
        }
      } else if (ch === "\x03") {
        line = "";
        out("^C\r\n");
        showPrompt();
      } else if (ch === "\x04") {
        if (!line) {
          out("exit\r\n");
          end(0);
          return;
        }
      } else if (ch === "\x0c") {
        out("\x1b[H\x1b[2J");
        showPrompt();
        out(line);
      } else if (ch === "\x15") {
        out("\b \b".repeat(line.length));
        line = "";
      } else if (ch >= " ") {
        line += ch;
        out(ch);
      }
    }
  };

  let at = 0;
  cb({ t: "state", state: "connecting", ...(shell.entered ?? {}) });
  for (const [state, message, ms] of shell.steps ?? []) {
    at += ms;
    later(at, () => cb({ t: "state", state, message, ...(shell.entered ?? {}) }));
  }
  later(at + 250 + Math.random() * 250, () => {
    if (shell.fail) {
      cb({ t: "end", message: shell.fail, error: true });
      return;
    }
    open = true;
    cb({ t: "state", state: "open" });
    if (shell.banner) out(shell.banner);
    showPrompt();
  });

  return {
    close() {
      closed = true;
      for (const t of timers) clearTimeout(t);
    },
    input,
    resize() {},
    ack() {},
  };
}
