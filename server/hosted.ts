// Sessions that run inside Control Room: each is a tmux session on Control Room's own tmux server, so it keeps
// running when the app quits, and the app's console can show it and type into it.
import { randomBytes } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { isEffort, isMode, isModel } from "../shared/claude.ts";
import { isHostedName } from "../shared/hosted.ts";
import type { ActionResult } from "../shared/types.ts";
import { APP_DIR } from "./paths.ts";
import { CHILD_ENV, run } from "./proc.ts";

// A socket of its own: the person's own tmux, its config and its sessions stay untouched.
export const SOCKET = process.env.CONTROL_ROOM_TMUX_SOCKET ?? "control-room";
const CONF = join(APP_DIR, "tmux.conf");
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// screen-256color is known to every Mac; tmux answers the terminal queries itself, so the console never has to.
const CONF_TEXT = `# Written by Control Room for its own tmux server (tmux -L ${SOCKET}). Changes are overwritten.
set -g default-terminal "screen-256color"
set -g history-limit 20000
set -g status off
set -g escape-time 0
set -g window-size latest
set -g extended-keys off
set -g focus-events on
`;

const TMUX_PATHS = ["/opt/homebrew/bin/tmux", "/usr/local/bin/tmux", "/usr/bin/tmux"];

export function tmuxReady(): boolean {
  return TMUX_PATHS.some((p) => existsSync(p));
}

/** Arguments for Control Room's tmux server. */
export function tmuxArgs(...args: string[]): string[] {
  return ["-L", SOCKET, ...args];
}

export { hostedName, isHostedName } from "../shared/hosted.ts";

// The variables of whoever started Control Room (Electron, npm, or a Claude Code session) must not reach a new
// session: a Claude Code that sees CLAUDECODE thinks it runs inside another one.
const FOREIGN = /^(CLAUDECODE|CLAUDE_CODE_.*|CLAUDE_AGENT_.*|ELECTRON_.*|npm_.*|NODE_OPTIONS|INIT_CWD|VSCODE_.*|TERM_PROGRAM.*|TMUX|TMUX_PANE|COLUMNS|LINES)$/;

export function sessionEnv(base: NodeJS.ProcessEnv = CHILD_ENV): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) if (!FOREIGN.test(k)) env[k] = v;
  env.COLORTERM = "truecolor";
  env.LANG ??= "en_US.UTF-8";
  return env;
}

/** Runs a command on Control Room's tmux server, with the clean environment it was started with. */
export function tmux(args: string[], timeoutMs = 5_000) {
  return run("tmux", tmuxArgs(...args), { timeoutMs, env: sessionEnv() });
}

/** Names of the sessions that run on Control Room's tmux server now; null when tmux could not say. */
export async function hostedSessions(): Promise<Set<string> | null> {
  if (!tmuxReady()) return new Set();
  const out = await tmux(["list-sessions", "-F", "#{session_name}"], 2_000);
  if (out.ok) return new Set(out.stdout.split("\n").map((l) => l.trim()).filter(isHostedName));
  // No server means nothing runs here; any other failure says nothing either way.
  return /no server running|error connecting/i.test(out.stderr) ? new Set() : null;
}

export interface StartOptions {
  cwd: string;
  prompt?: string | null;
  resume?: string | null; // a session id to continue
  model?: string | null; // an alias such as "opus", or a full model name
  effort?: string | null;
  mode?: string | null; // permission mode
  cols?: number;
  rows?: number;
}

/**
 * The arguments for `tmux new-session`. An interactive login shell runs `claude` the way a terminal tab does: with the
 * same PATH and variables, and with a `claude` function from ~/.zshrc when there is one.
 */
export function newSessionArgs(name: string, o: StartOptions, shell = process.env.SHELL || "/bin/zsh"): string[] {
  // "--" ends Claude Code's own options, so a message that starts with "-" stays a message.
  const claude = [
    ...(o.model ? ["--model", o.model] : []),
    ...(o.effort ? ["--effort", o.effort] : []),
    ...(o.mode ? ["--permission-mode", o.mode] : []),
    ...(o.resume ? ["--resume", o.resume] : o.prompt ? ["--", o.prompt] : []),
  ];
  const cols = String(Math.max(40, Math.min(400, Math.round(o.cols ?? 120))));
  const rows = String(Math.max(10, Math.min(200, Math.round(o.rows ?? 36))));
  // "$@" hands the prompt over as one argument, so nothing in it is read by the shell.
  return ["-f", CONF, "-u", "new-session", "-d", "-s", name, "-c", o.cwd, "-x", cols, "-y", rows, shell, "-lic", 'claude "$@"', "claude", ...claude];
}

async function writeConf(): Promise<void> {
  const current = await readFile(CONF, "utf8").catch(() => null);
  if (current !== CONF_TEXT) await writeFile(CONF, CONF_TEXT);
}

/** Starts Claude Code in a new tmux session. Claude Code writes its session file a moment later, or once the folder is trusted. */
export async function startSession(o: StartOptions): Promise<ActionResult & { name?: string }> {
  if (!tmuxReady()) return { ok: false, message: "Control Room needs tmux for this. Install it: brew install tmux" };
  if (typeof o.cwd !== "string" || !isAbsolute(o.cwd) || !existsSync(o.cwd) || !statSync(o.cwd).isDirectory()) {
    return { ok: false, message: "Pick a folder that exists." };
  }
  if (o.prompt !== undefined && o.prompt !== null && typeof o.prompt !== "string") return { ok: false, message: "The first message must be text." };
  if (o.resume && !SESSION_ID.test(o.resume)) return { ok: false, message: "That is not a Claude Code session id." };
  if (o.model && !isModel(o.model)) return { ok: false, message: "That is not a model name." };
  if (o.effort && !isEffort(o.effort)) return { ok: false, message: "That is not an effort level." };
  if (o.mode && !isMode(o.mode)) return { ok: false, message: "That is not a permission mode." };
  await writeConf();
  const name = `cr-${randomBytes(4).toString("hex")}`;
  const started = await tmux(newSessionArgs(name, o), 10_000);
  if (!started.ok) return { ok: false, message: (started.stderr || started.stdout).trim() || "tmux did not start the session." };
  return { ok: true, message: "Started", name };
}
