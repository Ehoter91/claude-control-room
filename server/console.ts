// The console: a live view of a hosted session's terminal, and the keys typed into it. One tmux control-mode client
// per session carries both ways over plain pipes; every open console window of that session shares it.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { isHostedName, sessionEnv, tmux, tmuxArgs } from "./hosted.ts";

export type ConsoleEvent =
  // the screen and its history to start from, at the session's size
  | { type: "reset"; data: Buffer; x: number; y: number; cursor: boolean; cols: number; rows: number }
  | { type: "data"; data: Buffer } // what the session wrote since
  | { type: "size"; cols: number; rows: number } // another window set the size; every console shows the same one
  | { type: "lost" } // the link to tmux broke while the session runs on: connect again
  | { type: "exit" };

type Listener = (e: ConsoleEvent) => void;

const HISTORY = 3000; // lines of scrollback a console starts with
const IDLE_MS = 10_000; // a client nobody watches stays this long, so a quick reopen is instant
const FLUSH_MS = 8; // output is sent in batches this far apart: a redraw is many small writes
const KEY_CHUNK = 1000; // bytes per send-keys command

/** Undoes tmux's control-mode escaping: every byte below 32 and the backslash arrive as \ooo. */
export function unescapeOutput(raw: Buffer): Buffer {
  const out = Buffer.allocUnsafe(raw.length);
  let n = 0;
  for (let i = 0; i < raw.length; i++) {
    const b = raw[i];
    if (b === 0x5c && i + 3 < raw.length && isOctal(raw[i + 1]) && isOctal(raw[i + 2]) && isOctal(raw[i + 3])) {
      out[n++] = ((raw[i + 1] - 48) << 6) | ((raw[i + 2] - 48) << 3) | (raw[i + 3] - 48);
      i += 3;
    } else out[n++] = b;
  }
  return out.subarray(0, n);
}

function isOctal(b: number | undefined): boolean {
  return b !== undefined && b >= 48 && b <= 55;
}

/** Keys from the browser as tmux send-keys commands: hex bytes, so escape sequences and any text arrive unchanged. */
export function keyCommands(target: string, data: string): string[] {
  const bytes = Buffer.from(data, "utf8");
  const commands: string[] = [];
  for (let i = 0; i < bytes.length; i += KEY_CHUNK) {
    const hex = bytes.subarray(i, i + KEY_CHUNK).toString("hex").replace(/(..)(?!$)/g, "$1 ");
    commands.push(`send-keys -t ${target} -H ${hex}`);
  }
  return commands;
}

// What a terminal sends by itself, not typed: focus in and out (CSI I, CSI O) and mouse reports (X10 and SGR).
const REPORTS = /\x1b\[[IO]|\x1b\[<\d+;\d+;\d+[Mm]|\x1b\[M[\s\S]{3}/g;

/** Whether keys from the browser hold anything a person typed, beyond the terminal's own reports. */
export function isTyping(data: unknown): boolean {
  return typeof data === "string" && data.replace(REPORTS, "") !== "";
}

function clampSize(cols: number, rows: number): [number, number] {
  const c = Number.isFinite(cols) ? cols : 100;
  const r = Number.isFinite(rows) ? rows : 30;
  return [Math.max(20, Math.min(500, Math.round(c))), Math.max(5, Math.min(300, Math.round(r)))];
}

interface Pending {
  done: (lines: Buffer[], ok: boolean) => void;
  lines: Buffer[];
  id?: string; // the number tmux gave the command, from its %begin line
}

class ControlClient {
  private proc: ChildProcessWithoutNullStreams;
  private partial: Buffer[] = []; // the start of a line whose end has not arrived yet
  private queue: Pending[] = [];
  private block: Pending | null = null; // the command whose output is arriving
  private listeners = new Set<Listener>();
  private idleTimer: NodeJS.Timeout | null = null;
  private outBuf: Buffer[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private onClose: () => void;
  private size: [number, number] = [100, 30];
  private name: string;
  readonly target: string;
  closed = false;

  constructor(name: string, onClose: () => void) {
    this.onClose = onClose;
    this.name = name;
    this.target = `=${name}:`;
    this.proc = spawn("tmux", tmuxArgs("-C", "attach-session", "-t", `=${name}`), { env: sessionEnv(), stdio: "pipe" });
    this.proc.stdout.on("data", (chunk: Buffer) => this.read(chunk));
    this.proc.on("error", () => this.close());
    this.proc.on("close", () => this.close());
    this.proc.stdin.on("error", () => {}); // a write after tmux left; close() follows
    this.idleUnlessWatched();
  }

  /** A client nobody watches leaves after a while, also one that only carried keys from a request. */
  private idleUnlessWatched(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = this.listeners.size === 0 && !this.closed ? setTimeout(() => this.close(), IDLE_MS) : null;
  }

  private read(chunk: Buffer): void {
    let start = 0;
    let nl: number;
    while ((nl = chunk.indexOf(0x0a, start)) >= 0) {
      const piece = chunk.subarray(start, nl);
      // A long line can span many reads; it is joined once, when its end arrives.
      this.line(this.partial.length ? Buffer.concat([...this.partial, piece]) : piece);
      this.partial = [];
      start = nl + 1;
    }
    if (start < chunk.length) this.partial.push(chunk.subarray(start));
  }

  private line(line: Buffer): void {
    if (this.block) {
      // A command's output ends with %end or %error and the same number as its %begin, so a pane line never ends it.
      const end = line[0] === 0x25 ? /^%(end|error) \d+ (\d+) 1$/.exec(line.subarray(0, 64).toString("latin1")) : null;
      if (end && end[2] === this.block.id) {
        const b = this.block;
        this.block = null;
        b.done(b.lines, end[1] === "end");
      } else this.block.lines.push(line);
      return;
    }
    if (line.subarray(0, 8).toString("latin1") === "%output ") {
      const space = line.indexOf(0x20, 8);
      if (space >= 0) this.output(unescapeOutput(line.subarray(space + 1)));
      return;
    }
    // Flag 1 marks output of this client's own commands; tmux also reports the attach itself with flag 0.
    const begin = /^%begin \d+ (\d+) 1$/.exec(line.subarray(0, 64).toString("latin1"));
    if (begin) {
      this.flush(); // output before a command's reply belongs before it
      this.block = { ...(this.queue.shift() ?? { done: () => {}, lines: [] }), id: begin[1] };
    } else if (line.subarray(0, 5).toString("latin1") === "%exit") this.close();
  }

  private output(data: Buffer): void {
    this.outBuf.push(data);
    this.flushTimer ??= setTimeout(() => this.flush(), FLUSH_MS);
  }

  private flush(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    if (!this.outBuf.length) return;
    const data = this.outBuf.length === 1 ? this.outBuf[0] : Buffer.concat(this.outBuf);
    this.outBuf = [];
    for (const l of this.listeners) l({ type: "data", data });
  }

  /** Sends one command line; each `done` runs inside the reader, before any output that came after the command. */
  private send(commands: { cmd: string; done?: Pending["done"] }[]): void {
    if (this.closed) return commands.forEach((c) => c.done?.([], false));
    for (const c of commands) this.queue.push({ done: c.done ?? (() => {}), lines: [] });
    // Commands joined by " ; " run back to back in tmux, with no pane output in between.
    this.proc.stdin.write(`${commands.map((c) => c.cmd).join(" ; ")}\n`);
  }

  resize(cols: number, rows: number): void {
    this.size = clampSize(cols, rows);
    const [c, r] = this.size;
    this.send([{ cmd: `refresh-client -C ${c}x${r}` }]);
    for (const l of this.listeners) l({ type: "size", cols: c, rows: r });
  }

  type(data: string): void {
    for (const cmd of keyCommands(this.target, data)) this.send([{ cmd }]);
    this.idleUnlessWatched();
  }

  /** Paints a new console with the screen as it is, then streams from that exact moment on. */
  join(listener: Listener, cols: number, rows: number): () => void {
    let left = false;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    // The newest window sets the size: it is the one being looked at. The others follow through "size" events.
    this.resize(cols, rows);
    let cursor = { x: 0, y: 0, on: true };
    this.send([
      {
        cmd: `display-message -p -t ${this.target} '#{cursor_x} #{cursor_y} #{cursor_flag}'`,
        done: (lines) => {
          const [x, y, flag] = (lines[0]?.toString("latin1") ?? "").split(" ").map(Number);
          cursor = { x: x || 0, y: y || 0, on: flag !== 0 };
        },
      },
      {
        cmd: `capture-pane -p -e -t ${this.target} -S -${HISTORY}`,
        done: (lines, ok) => {
          if (left) return;
          if (this.closed || !ok) return listener({ type: "exit" });
          const data = Buffer.concat(lines.flatMap((l, i) => (i ? [Buffer.from("\x1b[0m\r\n"), l] : [l])));
          const [c, r] = this.size;
          listener({ type: "reset", data, x: cursor.x, y: cursor.y, cursor: cursor.on, cols: c, rows: r });
          // Joined here, inside the reader: the next %output line is the first thing this console has not seen.
          this.listeners.add(listener);
          this.idleUnlessWatched();
        },
      },
    ]);
    return () => {
      left = true;
      this.listeners.delete(listener);
      this.idleUnlessWatched();
    };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.flush();
    if (this.idleTimer) clearTimeout(this.idleTimer);
    for (const p of [...(this.block ? [this.block] : []), ...this.queue]) p.done([], false);
    this.queue = [];
    this.block = null;
    // Only a session that is gone has ended; any other break is a lost link, and the console connects again.
    const watching = [...this.listeners];
    this.listeners.clear();
    if (watching.length) {
      void tmux(["has-session", "-t", `=${this.name}`]).then((r) => watching.forEach((l) => l({ type: r.ok ? "lost" : "exit" })));
    }
    this.proc.stdin.end();
    this.proc.kill();
    this.onClose();
  }
}

const clients = new Map<string, ControlClient>();

function clientFor(name: string): ControlClient | null {
  if (!isHostedName(name)) return null;
  let c = clients.get(name);
  if (!c || c.closed) {
    c = new ControlClient(name, () => {
      if (clients.get(name) === c) clients.delete(name);
    });
    clients.set(name, c);
  }
  return c;
}

export function watchConsole(name: string, cols: number, rows: number, listener: Listener): (() => void) | null {
  return clientFor(name)?.join(listener, cols, rows) ?? null;
}

export function typeInConsole(name: string, data: string): boolean {
  const c = clientFor(name);
  if (!c || typeof data !== "string" || !data) return false;
  c.type(data);
  return true;
}

export function resizeConsole(name: string, cols: number, rows: number): boolean {
  const c = clients.get(name);
  if (!c || !Number.isFinite(cols) || !Number.isFinite(rows)) return false;
  c.resize(cols, rows);
  return true;
}

/** Stops a session that was started here but never got going, such as one left at the trust question. */
export async function stopConsole(name: string): Promise<boolean> {
  if (!isHostedName(name)) return false;
  clients.get(name)?.close();
  return (await tmux(["kill-session", "-t", `=${name}`])).ok;
}
