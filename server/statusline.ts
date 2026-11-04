import { chmod, copyFile, mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RateWindow, SetupState, Usage } from "../shared/types.ts";
import { BACKUP_DIR, CLAUDE_SETTINGS, HOOK_DIR, HOOK_SCRIPT, TAP_DIR, TAP_SCRIPT } from "./paths.ts";

// Claude Code runs this on every reply; it saves the JSON it receives and prints a short status line.
// A status line the person already had is kept: it still runs and its output is what they see.
export function tapScript(wrapped: string | null): string {
  const line = wrapped
    ? `printf '%s' "$input" | ${wrapped}`
    : `printf '%s' "$input" | /usr/bin/jq -r '
  def pct(p): if p == null then empty else (p | floor | tostring) + "%" end;
  [ (.model.display_name // empty),
    (.effort.level // empty),
    (if .context_window.used_percentage != null then "context " + pct(.context_window.used_percentage) else empty end),
    (if .rate_limits.five_hour.used_percentage != null then "5h " + pct(.rate_limits.five_hour.used_percentage) else empty end),
    (if .rate_limits.seven_day.used_percentage != null then "week " + pct(.rate_limits.seven_day.used_percentage) else empty end)
  ] | join(" · ")' 2>/dev/null`;
  return `#!/bin/sh
# Control Room status line tap (installed by the Control Room app; remove it from the app's Setup panel).
input=$(cat)
dir="$HOME/.claude-control-room/statusline"
mkdir -p "$dir"
sid=$(printf '%s' "$input" | /usr/bin/jq -r '.session_id // empty' 2>/dev/null)
if [ -n "$sid" ]; then
  printf '%s' "$input" > "$dir/$sid.json.tmp" && mv "$dir/$sid.json.tmp" "$dir/$sid.json"
fi
${line}
`;
}

interface HookEntry {
  matcher?: string;
  hooks?: { type?: string; command?: string; async?: boolean; timeout?: number }[];
}

interface ClaudeSettings {
  statusLine?: { type?: string; command?: string; padding?: number; refreshInterval?: number };
  hooks?: Record<string, HookEntry[]>;
  effortLevel?: string;
  [key: string]: unknown;
}

// Runs in the background on every permission prompt (async, so it never delays one) and saves
// what the prompt asks, because the transcript only records a tool call once it is approved.
export const HOOK_BODY = `#!/bin/sh
# Control Room permission hook (installed by the Control Room app; remove it from the app's Settings).
input=$(cat)
dir="$HOME/.claude-control-room/permissions"
mkdir -p "$dir"
sid=$(printf '%s' "$input" | /usr/bin/jq -r '.session_id // empty' 2>/dev/null)
if [ -n "$sid" ]; then
  printf '%s' "$input" > "$dir/$sid.json.tmp" && mv "$dir/$sid.json.tmp" "$dir/$sid.json"
fi
exit 0
`;

const HOOK_EVENT = "PermissionRequest";

async function readSettings(): Promise<ClaudeSettings> {
  return JSON.parse(await readFile(CLAUDE_SETTINGS, "utf8")) as ClaudeSettings;
}

async function writeSettings(next: ClaudeSettings): Promise<void> {
  const tmp = `${CLAUDE_SETTINGS}.control-room.tmp`;
  await writeFile(tmp, JSON.stringify(next, null, 2) + "\n");
  await rename(tmp, CLAUDE_SETTINGS);
}

const DEFAULT_KEYS = ["model", "modelSettings", "effortLevel"] as const;

/**
 * Claude Code's /model and /effort also save the choice as the default for new sessions. A change made from
 * Control Room is for one session only, so this puts the saved defaults back once `change` is done.
 */
export async function keepDefaults<T>(change: () => Promise<T>): Promise<T> {
  const before = await readSettings().catch(() => null);
  try {
    return await change();
  } finally {
    if (before) await restoreDefaults(before).catch(() => {});
  }
}

async function restoreDefaults(before: Record<string, unknown>): Promise<void> {
  const now: Record<string, unknown> = await readSettings();
  let changed = false;
  for (const key of DEFAULT_KEYS) {
    if (JSON.stringify(now[key]) === JSON.stringify(before[key])) continue;
    if (before[key] === undefined) delete now[key];
    else now[key] = before[key];
    changed = true;
  }
  if (changed) await writeSettings(now);
}

async function backupSettings(): Promise<string> {
  await mkdir(BACKUP_DIR, { recursive: true });
  const target = join(BACKUP_DIR, `settings.${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  await copyFile(CLAUDE_SETTINGS, target);
  return target;
}

function isOurs(entry: HookEntry): boolean {
  return (entry.hooks ?? []).some((h) => h.command === HOOK_SCRIPT);
}

export function hookInstalled(settings: ClaudeSettings): boolean {
  return (settings.hooks?.[HOOK_EVENT] ?? []).some(isOurs);
}

/** Pure: the settings with our status line and hook added. Kept separate so the merge is tested alone. */
export function withConnection(settings: ClaudeSettings): ClaudeSettings {
  const next: ClaudeSettings = { ...settings, statusLine: { type: "command", command: TAP_SCRIPT, padding: 0 } };
  const hooks = { ...(settings.hooks ?? {}) };
  hooks[HOOK_EVENT] = [
    ...(hooks[HOOK_EVENT] ?? []).filter((e) => !isOurs(e)),
    { matcher: "*", hooks: [{ type: "command", command: HOOK_SCRIPT, async: true, timeout: 5 }] },
  ];
  next.hooks = hooks;
  return next;
}

/** Pure: the settings with our status line and hook taken out, and the person's own status line back. */
export function withoutConnection(settings: ClaudeSettings, original: ClaudeSettings["statusLine"] | null): ClaudeSettings {
  const next: ClaudeSettings = { ...settings };
  if (next.statusLine?.command?.includes(TAP_SCRIPT)) {
    if (original) next.statusLine = original;
    else delete next.statusLine;
  }
  if (next.hooks) {
    const hooks = { ...next.hooks };
    const kept = (hooks[HOOK_EVENT] ?? []).filter((e) => !isOurs(e));
    if (kept.length) hooks[HOOK_EVENT] = kept;
    else delete hooks[HOOK_EVENT];
    if (Object.keys(hooks).length) next.hooks = hooks;
    else delete next.hooks;
  }
  return next;
}

export async function statusLineState(): Promise<{ statusLine: SetupState["statusLine"]; hooks: boolean }> {
  try {
    const s = await readSettings();
    const cmd = s.statusLine?.command ?? null;
    return { statusLine: !cmd ? "missing" : cmd.includes(TAP_SCRIPT) ? "installed" : "foreign", hooks: hookInstalled(s) };
  } catch {
    return { statusLine: "missing", hooks: false };
  }
}

/** The person's default effort level from ~/.claude/settings.json, used until a session reports its own. */
export async function defaultEffort(): Promise<string | null> {
  try {
    const s = await readSettings();
    return process.env.CLAUDE_CODE_EFFORT_LEVEL ?? (typeof s.effortLevel === "string" ? s.effortLevel : null);
  } catch {
    return null;
  }
}

export async function installStatusLine(): Promise<{ ok: boolean; message: string }> {
  const settings = await readSettings();
  const current = settings.statusLine?.command ?? null;
  if (current?.includes(TAP_SCRIPT) && hookInstalled(settings)) return { ok: true, message: "Already connected" };
  const backup = await backupSettings();
  await mkdir(TAP_DIR, { recursive: true });
  const wrapped = current && !current.includes(TAP_SCRIPT) ? current : null;
  if (!current?.includes(TAP_SCRIPT)) {
    await writeFile(TAP_SCRIPT, tapScript(wrapped));
    await writeFile(join(BACKUP_DIR, "original-statusline.json"), JSON.stringify(settings.statusLine ?? null) + "\n");
  }
  await chmod(TAP_SCRIPT, 0o755);
  await writeFile(HOOK_SCRIPT, HOOK_BODY);
  await chmod(HOOK_SCRIPT, 0o755);
  // Re-read right before writing so a change Claude Code just made is not lost.
  await writeSettings(withConnection(await readSettings()));
  return { ok: true, message: `Connected. New sessions report everything; a backup of your settings is at ${backup}` };
}

export async function uninstallStatusLine(): Promise<{ ok: boolean; message: string }> {
  await backupSettings();
  let original: ClaudeSettings["statusLine"] | null = null;
  try {
    original = JSON.parse(await readFile(join(BACKUP_DIR, "original-statusline.json"), "utf8"));
  } catch {
    original = null;
  }
  await writeSettings(withoutConnection(await readSettings(), original));
  return { ok: true, message: "Disconnected. Your previous status line is back." };
}

export interface Tap {
  sessionId: string;
  mtimeMs: number;
  model: string | null;
  modelId: string | null;
  effort: string | null;
  contextPercent: number | null;
  costUsd: number | null;
  cwd: string | null;
  sessionName: string | null;
  transcriptPath: string | null;
  pr: { number: number; url: string } | null;
  fiveHour: RateWindow | null;
  sevenDay: RateWindow | null;
}

const taps = new Map<string, { mtimeMs: number; tap: Tap }>();

function rate(w: any): RateWindow | null {
  if (!w || typeof w.used_percentage !== "number") return null;
  return { usedPercent: w.used_percentage, resetsAt: typeof w.resets_at === "number" ? w.resets_at * 1000 : 0 };
}

export async function readTap(sessionId: string): Promise<Tap | null> {
  const file = join(TAP_DIR, `${sessionId}.json`);
  let mtimeMs: number;
  try {
    mtimeMs = (await stat(file)).mtimeMs;
  } catch {
    return null;
  }
  const hit = taps.get(sessionId);
  if (hit && hit.mtimeMs === mtimeMs) return hit.tap;
  try {
    const d = JSON.parse(await readFile(file, "utf8"));
    const tap: Tap = {
      sessionId,
      mtimeMs,
      model: d.model?.display_name ?? null,
      modelId: d.model?.id ?? null,
      effort: d.effort?.level ?? null,
      contextPercent: typeof d.context_window?.used_percentage === "number" ? d.context_window.used_percentage : null,
      costUsd: typeof d.cost?.total_cost_usd === "number" ? d.cost.total_cost_usd : null,
      cwd: d.workspace?.current_dir ?? d.cwd ?? null,
      sessionName: d.session_name ?? null,
      transcriptPath: d.transcript_path ?? null,
      pr: d.pr?.number ? { number: d.pr.number, url: d.pr.url } : null,
      fiveHour: rate(d.rate_limits?.five_hour),
      sevenDay: rate(d.rate_limits?.seven_day),
    };
    taps.set(sessionId, { mtimeMs, tap });
    return tap;
  } catch {
    return hit?.tap ?? null;
  }
}

/** Plan usage from whichever session reported last; every session shares the account's limits. */
export async function latestUsage(): Promise<Usage> {
  let names: string[] = [];
  try {
    names = (await readdir(TAP_DIR)).filter((n) => n.endsWith(".json"));
  } catch {
    return { fiveHour: null, sevenDay: null, observedAt: null };
  }
  let best: { at: number; id: string } | null = null;
  for (const n of names) {
    try {
      const at = (await stat(join(TAP_DIR, n))).mtimeMs;
      if (!best || at > best.at) best = { at, id: n.slice(0, -5) };
    } catch {
      /* file vanished */
    }
  }
  if (!best) return { fiveHour: null, sevenDay: null, observedAt: null };
  const tap = await readTap(best.id);
  const now = Date.now();
  // A window whose reset time passed is stale; Claude Code drops it too.
  const live = (w: RateWindow | null) => (w && w.resetsAt > now ? w : null);
  return { fiveHour: live(tap?.fiveHour ?? null), sevenDay: live(tap?.sevenDay ?? null), observedAt: best.at };
}

export interface PermissionAsk {
  at: number; // file time
  toolName: string;
  toolInput: Record<string, unknown>;
  effort: string | null;
}

/** What the session's latest permission prompt asked, as the hook saved it. */
export async function readPermission(sessionId: string): Promise<PermissionAsk | null> {
  const file = join(HOOK_DIR, `${sessionId}.json`);
  try {
    const at = (await stat(file)).mtimeMs;
    const d = JSON.parse(await readFile(file, "utf8"));
    if (typeof d.tool_name !== "string") return null;
    return { at, toolName: d.tool_name, toolInput: d.tool_input ?? {}, effort: d.effort?.level ?? null };
  } catch {
    return null;
  }
}
