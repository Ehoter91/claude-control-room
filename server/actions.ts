import { existsSync } from "node:fs";
import { openTarget } from "../shared/ides.ts";
import type { ActionResult, ClosePlan, CloseRequest, Session, WorktreeReport } from "../shared/types.ts";
import { endClaim, forgetClaims, repoClaims } from "./claims.ts";
import { settings } from "./config.ts";
import { git, listWorktrees } from "./git.ts";
import { prForBranch, type PrRow } from "./github.ts";
import { hostedName, hostedSessions, startSession, tmux, tmuxReady } from "./hosted.ts";
import { openInIde } from "./ide.ts";
import type { Monitor } from "./monitor.ts";
import { readSessionFiles } from "./monitor.ts";
import { cleanName, saveName } from "./names.ts";
import { launch, run, sleep } from "./proc.ts";
import { CLEAR_DRAFT, REMOTE_COMMAND, remoteRefusal } from "./remote.ts";
import { closeTerminal, focusTerminal, renameTerminal, sendText } from "./vscode.ts";
import { buildReport, insidePath } from "./worktrees.ts";

const KEYS = { enter: "\r", escape: "\u001b" } as const;

function find(monitor: Monitor, pid: number): Session | null {
  return monitor.snapshot?.sessions.find((s) => s.pid === pid) ?? null;
}

async function freshStatus(pid: number): Promise<{ status: string | null; waitingFor: string | null; bridgeSessionId: string | null } | null> {
  const f = (await readSessionFiles()).find((x) => x.pid === pid);
  return f ? { status: f.status, waitingFor: f.waitingFor, bridgeSessionId: f.bridgeSessionId } : null;
}

/** Sends raw keys to the terminal that runs the session: tmux directly, VS Code through the helper. */
async function sendKeys(s: Session, text: string, tmuxKey: string | null): Promise<ActionResult> {
  if (s.tmux) {
    const pane = s.tmux.split(".").pop() ?? s.tmux;
    const args = tmuxKey ? ["send-keys", "-t", pane, tmuxKey] : ["send-keys", "-t", pane, "-l", text];
    // A session started here lives on Control Room's own tmux server; pane ids like %0 count per server. Its name
    // decides, not the last list from tmux, so a key never lands in a pane of the same id on your own tmux.
    const out = hostedName(s.tmux) ? await tmux(args) : await run("tmux", args, { timeoutMs: 5_000 });
    return { ok: out.ok, message: out.ok ? "Sent" : out.stderr.trim() };
  }
  if (s.vscodeLinked) {
    const r = await sendText(s.shellPid, text);
    return { ok: r.ok, message: r.message };
  }
  return { ok: false, message: "This terminal can't receive keys from the dashboard. Open the session instead." };
}

async function settle(pid: number, from: string): Promise<boolean> {
  for (let i = 0; i < 10; i++) {
    await sleep(200);
    const now = await freshStatus(pid);
    if (!now || now.status !== from) return true;
  }
  return false;
}

export async function answerPermission(monitor: Monitor, pid: number, approve: boolean): Promise<ActionResult> {
  const s = find(monitor, pid);
  if (!s) return { ok: false, message: "That session is gone." };
  // Re-read the status right now: a stale card must never press Enter into a prompt that moved on.
  const now = await freshStatus(pid);
  if (!now || now.status !== "waiting" || !(now.waitingFor ?? "").includes("permission")) {
    return { ok: false, message: "The session is no longer waiting for approval." };
  }
  const r = await sendKeys(s, approve ? KEYS.enter : KEYS.escape, approve ? "Enter" : "Escape");
  if (!r.ok) return r;
  const moved = await settle(pid, "waiting");
  await monitor.tick();
  return { ok: true, message: moved ? (approve ? "Approved" : "Rejected") : "Sent — the session has not moved yet" };
}

export async function answerQuestion(monitor: Monitor, pid: number, option: number): Promise<ActionResult> {
  const s = find(monitor, pid);
  if (!s) return { ok: false, message: "That session is gone." };
  const now = await freshStatus(pid);
  const q = s.activity.question;
  if (!now || now.status !== "waiting" || !(now.waitingFor ?? "").includes("input") || !q) {
    return { ok: false, message: "The session is no longer asking." };
  }
  if (q.count !== 1 || q.multiSelect || option < 0 || option >= q.options.length || option > 8) {
    return { ok: false, message: "Answer this one in the terminal." };
  }
  const digit = String(option + 1);
  const r = await sendKeys(s, digit, null);
  if (!r.ok) return r;
  await settle(pid, "waiting");
  await monitor.tick();
  return { ok: true, message: `Answered “${q.options[option].label}”` };
}

/** Types /remote-control into the session, as you would by hand. Claude Code runs it at once, even mid-turn. */
export async function startRemoteControl(monitor: Monitor, pid: number): Promise<ActionResult> {
  const s = find(monitor, pid);
  if (!s) return { ok: false, message: "That session is gone." };
  if (!s.tmux && !s.vscodeLinked) {
    const helper = s.ide === "vscode" ? ", or install the VS Code helper (Settings)" : "";
    return { ok: false, message: `Control Room can't type in this terminal. Type /rc in the session${helper}.` };
  }
  const before = await freshStatus(pid);
  // A second /remote-control would open Claude Code's Remote Control menu in the terminal.
  if (before?.bridgeSessionId) return { ok: true, message: "It is already on your phone." };
  const refused = remoteRefusal(before);
  if (refused) return { ok: false, message: refused };
  for (const [text, key] of [...CLEAR_DRAFT, [REMOTE_COMMAND, null] as const]) {
    const r = await sendKeys(s, text, key);
    if (!r.ok) return r;
  }
  await sleep(300);
  // Look again right before Enter: a prompt that opened meanwhile would take Enter as "yes".
  const late = remoteRefusal(await freshStatus(pid));
  if (late) return { ok: false, message: late };
  const r = await sendKeys(s, KEYS.enter, "Enter");
  if (!r.ok) return r;
  for (let i = 0; i < 24; i++) {
    await sleep(250);
    if ((await freshStatus(pid))?.bridgeSessionId) {
      await monitor.tick();
      return { ok: true, message: "On your phone now: open the Claude app and tap Code." };
    }
  }
  return { ok: false, message: "Sent /remote-control, but it did not connect. Look at the session to see why." };
}

export async function focusSession(monitor: Monitor, pid: number): Promise<ActionResult> {
  const s = find(monitor, pid);
  if (!s) return { ok: false, message: "That session is gone." };
  const target = openTarget(s, settings().ide);
  // The page opens the console itself; this answers a menu or a keyboard shortcut that asked the server.
  if (target.kind === "console") return { ok: true, message: "Its console is in Control Room." };
  if (target.kind === "tmux") {
    launch("open", ["-a", "Terminal"]);
    return { ok: true, message: `It runs in tmux (${(s.tmux ?? "").split(":")[0]}).` };
  }
  // A VS Code session goes through the helper: it jumps to the session's terminal, or says how to get that jump.
  if (s.ide === "vscode") {
    const r = await focusTerminal(s.shellPid);
    return { ok: r.ok, message: r.ok ? "Opened in VS Code" : r.message };
  }
  return openInIde(target.ide, s.git?.root ?? s.cwd, !!s.git);
}

/**
 * Renames the session's VS Code tab, and the tile takes the tab's name. A session outside VS Code keeps its name in
 * Control Room; an empty name there brings back the name Claude Code gives it.
 */
export async function renameSession(monitor: Monitor, pid: number, raw: unknown): Promise<ActionResult> {
  const s = find(monitor, pid);
  if (!s) return { ok: false, message: "That session is gone." };
  const name = cleanName(raw);
  if (s.ide === "vscode") {
    // A name saved here would lose to the tab's name once the helper connects, so VS Code tabs go through the helper only.
    if (!name) return { ok: false, message: "Type a name first." };
    if (!s.vscodeLinked) return { ok: false, message: "Rename works for sessions in a VS Code terminal, with the VS Code helper (Settings)." };
    const r = await renameTerminal(s.shellPid, name);
    if (!r.ok) return r;
  } else {
    if (!name && s.nameSource !== "saved") return { ok: false, message: "Type a name first." };
    try {
      await saveName(s.sessionId, name);
    } catch (err) {
      return { ok: false, message: `The name was not saved: ${(err as Error).message}` };
    }
  }
  await monitor.tick();
  return { ok: true, message: name ? `Renamed to “${name}”` : "Name cleared" };
}

/** The pid of the Claude Code that runs in hosted tmux session `name`, once Claude Code has written its session file. */
async function hostedPid(name: string, waitMs: number): Promise<number | null> {
  for (const until = Date.now() + waitMs; ; await sleep(250)) {
    const f = (await readSessionFiles()).find((x) => hostedName(x.tmux) === name);
    if (f) return f.pid;
    if (Date.now() > until) return null;
  }
}

/** Starts Claude Code in Control Room, in a folder of your choice, with an optional first message. */
export async function newSession(monitor: Monitor, b: { cwd?: unknown; prompt?: unknown }): Promise<ActionResult & { pid?: number; name?: string }> {
  const prompt = typeof b.prompt === "string" && b.prompt.trim() ? b.prompt.trim() : null;
  const r = await startSession({ cwd: typeof b.cwd === "string" ? b.cwd : "", prompt });
  if (!r.ok || !r.name) return r;
  // Claude Code writes its session file within a second or two; a longer wait means it asks something first.
  const pid = await hostedPid(r.name, 5_000);
  if (!pid && (await hostedSessions())?.has(r.name) === false) return { ok: false, message: STOPPED_AT_START };
  await monitor.fresh();
  return pid ? { ok: true, message: "Started", pid, name: r.name } : { ok: true, message: "Claude Code asks something first. Answer it in the console.", name: r.name };
}

const STOPPED_AT_START = "Claude Code stopped right after it started. Run claude in that folder in a terminal once to see why.";
const moving = new Set<number>();

/**
 * Moves a session from another terminal into Control Room: stops it, then continues the same conversation here with
 * `claude --resume`. Only an idle session moves, so no turn is cut off.
 */
export async function moveSession(monitor: Monitor, pid: number): Promise<ActionResult & { pid?: number; name?: string }> {
  const s = find(monitor, pid);
  if (!s) return { ok: false, message: "That session is gone." };
  if (s.hosted) return { ok: true, message: "It already runs in Control Room.", pid };
  // A second click, or a second window, must not resume the same conversation twice.
  if (moving.has(pid)) return { ok: false, message: "It is moving already." };
  moving.add(pid);
  try {
    const file = (await readSessionFiles()).find((x) => x.pid === pid);
    if (!file || file.status !== "idle" || !["idle", "inactive"].includes(s.activity.kind)) {
      return { ok: false, message: "Wait until it is idle. Moving restarts Claude Code, so a running turn or background task would stop." };
    }
    // Everything a restart here needs is checked before Claude Code stops there.
    if (!tmuxReady()) return { ok: false, message: "Control Room needs tmux for this. Install it: brew install tmux" };
    if (!existsSync(file.cwd)) return { ok: false, message: `Its folder is gone: ${file.cwd}` };
    if (!(await stopProcess(pid))) return { ok: false, message: "Claude did not stop, so the session stays where it is." };
    const resumeHint = `To continue it yourself, run in ${file.cwd}: claude --resume ${s.sessionId}`;
    // Claude Code keeps a conversation under the folder it started in, so it continues from there.
    const r = await startSession({ cwd: file.cwd, resume: s.sessionId });
    if (!r.ok || !r.name) return { ok: false, message: `It stopped, but did not start here: ${r.message} ${resumeHint}` };
    const pidHere = await hostedPid(r.name, 15_000);
    if (!pidHere && (await hostedSessions())?.has(r.name) === false) return { ok: false, message: `It stopped, but did not start here. ${resumeHint}` };
    // A VS Code tab's name stays with the tab, so it comes along as a name saved here.
    if (pidHere && (s.nameSource === "tab" || s.nameSource === "saved")) {
      const moved = (await readSessionFiles()).find((x) => x.pid === pidHere);
      if (moved && (s.nameSource === "tab" || moved.sessionId !== s.sessionId)) await saveName(moved.sessionId, s.name).catch(() => {});
    }
    await monitor.fresh();
    return pidHere
      ? { ok: true, message: "Moved to Control Room. Its old terminal tab can be closed.", pid: pidHere, name: r.name }
      : { ok: true, message: "Moved. It shows up here as soon as Claude Code is ready.", name: r.name };
  } finally {
    moving.delete(pid);
  }
}

export function openUrl(url: string): ActionResult {
  if (!/^https:\/\//.test(url)) return { ok: false, message: "Only https links open from here." };
  launch("open", [url]);
  return { ok: true, message: "Opened" };
}

export function openFolder(path: string): ActionResult {
  launch("open", [path]);
  return { ok: true, message: "Opened in Finder" };
}

export async function worktreeReportFor(monitor: Monitor, s: Session): Promise<WorktreeReport | null> {
  if (!s.git || !s.git.isWorktree) return null;
  const entries = await listWorktrees(s.git.mainRoot);
  const entry = entries.find((e) => e.path === s.git?.root);
  if (!entry) return null;
  const slug = s.git.remote ? `${s.git.remote.owner}/${s.git.remote.name}` : null;
  const prs = new Map<string, PrRow>();
  const pr = slug && entry.branch ? prForBranch(slug, entry.branch) : null;
  if (pr && entry.branch) prs.set(entry.branch, pr);
  const reg = await repoClaims(s.git.mainRoot, monitor.isLiveClaude);
  const others = (path: string) =>
    (monitor.snapshot?.sessions ?? []).filter((o) => o.pid !== s.pid && insidePath(o.cwd, path)).map((o) => o.pid);
  return buildReport(s.git.mainRoot, entry, {
    prs,
    livePids: others,
    claim: (path) => {
      const c = reg?.claims.find((x) => x.worktree === path);
      return c ? { live: c.live, note: c.note } : null;
    },
  });
}

export async function closePlan(monitor: Monitor, pid: number): Promise<ClosePlan | null> {
  const s = find(monitor, pid);
  if (!s) return null;
  return { pid, claims: s.claims, worktree: await worktreeReportFor(monitor, s) };
}

async function stopProcess(pid: number): Promise<boolean> {
  const alive = () => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return !alive();
  }
  for (let i = 0; i < 25; i++) {
    await sleep(200);
    if (!alive()) return true;
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    /* already gone */
  }
  await sleep(300);
  return !alive();
}

export async function closeSession(monitor: Monitor, pid: number, req: CloseRequest): Promise<ActionResult> {
  const s = find(monitor, pid);
  if (!s) return { ok: false, message: "That session is gone." };
  if (!req.close) return { ok: false, message: "Nothing to do." };
  const log: string[] = [];
  const report = req.deleteWorktree ? await worktreeReportFor(monitor, s) : null;
  if (req.deleteWorktree) {
    if (!report) return { ok: false, message: "This session is not in a worktree that can be deleted." };
    if (report.verdict === "in-use" || report.verdict === "main") return { ok: false, message: report.reason };
    if (report.verdict === "keep" && !req.force) return { ok: false, message: `Not deleted: ${report.reason}` };
  }

  const stopped = await stopProcess(pid);
  log.push(stopped ? "Stopped Claude." : "Claude did not stop.");
  if (!stopped) return { ok: false, message: "Claude did not stop, so nothing else was changed.", log };
  // closeTerminal checks the helper itself, so it also says when an unlinked tab stays open.
  if (s.ide === "vscode" || s.vscodeLinked) {
    const closed = await closeTerminal(s.shellPid);
    log.push(closed.ok ? "Closed its VS Code terminal." : closed.message);
  }

  const reg = s.git ? await repoClaims(s.git.mainRoot, monitor.isLiveClaude) : null;
  const worktree = s.git?.isWorktree ? s.git.root : null;
  const held = new Set(s.claims.map((c) => c.worktree));
  if (reg) {
    for (const w of held) {
      const remove = req.deleteWorktree && w === worktree;
      // A merged PR whose head is this HEAD has every commit, so the script's own unpushed check may be overruled.
      const force = remove && (req.force || (report !== null && report.verdict === "safe"));
      const out = await endClaim(reg, w, { remove, force });
      log.push(out.output || (out.ok ? `Released ${w}` : `Could not release ${w}`));
      if (remove && !out.ok) return { ok: false, message: "The session stopped, but the worktree was not deleted.", log };
    }
  }
  if (req.deleteWorktree && worktree && !held.has(worktree)) {
    let out;
    if (reg?.script) {
      const force = req.force || report?.verdict === "safe";
      out = await endClaim(reg, worktree, { remove: true, force });
      log.push(out.output);
    } else {
      const args = ["worktree", "remove", ...(req.force ? ["--force"] : []), worktree];
      const r = await git(s.git!.mainRoot, args, 60_000);
      out = { ok: r.ok, output: (r.stdout + r.stderr).trim() };
      log.push(out.ok ? `Deleted ${worktree}` : out.output);
    }
    if (!out.ok) return { ok: false, message: "The session stopped, but the worktree was not deleted.", log };
  }
  if (s.git) forgetClaims(s.git.mainRoot);
  await monitor.tick();
  const parts = ["Session closed"];
  if (held.size) parts.push(`${held.size} claim${held.size === 1 ? "" : "s"} released`);
  if (req.deleteWorktree) parts.push("worktree deleted");
  return { ok: true, message: parts.join(" · "), log };
}

/** Deletes worktrees, each one re-checked right before: a scan can be minutes old. */
export async function removeWorktrees(
  mainRoot: string,
  paths: string[],
  isLiveClaude: (pid: number) => boolean,
  freshReport: (path: string) => Promise<WorktreeReport | null>,
  onDone: (path: string) => void,
): Promise<ActionResult> {
  const reg = await repoClaims(mainRoot, isLiveClaude);
  const log: string[] = [];
  let removed = 0;
  for (const path of paths) {
    const report = path === mainRoot ? null : await freshReport(path);
    if (!report || (report.verdict !== "safe" && report.verdict !== "probably-safe")) {
      log.push(`Kept ${path}: ${report?.reason ?? "not a removable worktree"}`);
      continue;
    }
    // "safe" means a merged PR holds every commit, so the script's own unpushed check may be overruled.
    const force = report.verdict === "safe";
    const out = reg?.script
      ? await endClaim(reg, path, { remove: true, force })
      : await git(mainRoot, ["worktree", "remove", ...(force ? ["--force"] : []), path], 60_000).then((r) => ({
          ok: r.ok,
          output: (r.stdout + r.stderr).trim(),
        }));
    if (out.ok) {
      removed++;
      onDone(path);
    }
    log.push(out.ok ? `Deleted ${path}` : `Failed ${path}: ${out.output.split("\n").pop()}`);
  }
  return { ok: removed === paths.length, message: `Deleted ${removed} of ${paths.length} worktrees`, log };
}

export async function pruneWorktrees(mainRoot: string): Promise<ActionResult> {
  const r = await git(mainRoot, ["worktree", "prune"], 60_000);
  return { ok: r.ok, message: r.ok ? "Pruned worktree entries whose folders are gone" : r.stderr.trim() };
}
