import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Claim } from "../shared/types.ts";
import { run } from "./proc.ts";

// Mirrors scripts/worktree_session.py: a claim written by a plain shell (pid 0) holds for 12 hours.
const SHELL_CLAIM_HOURS = 12;

interface RawClaim {
  session: string;
  pid: number;
  worktree: string;
  branch: string;
  note: string;
  paths: string[];
  leases: string[];
  heartbeat: string;
}

export interface RepoClaims {
  repo: string;
  file: string;
  script: string | null; // scripts/worktree_session.py when the repo carries it
  claims: (RawClaim & { live: boolean })[];
}

const cache = new Map<string, { at: number; mtime: number; value: RepoClaims | null }>();

async function registryFile(mainRoot: string): Promise<string | null> {
  const gitDir = join(mainRoot, ".git");
  try {
    const names = await readdir(gitDir);
    const hit = names.find((n) => n.endsWith("-sessions.json"));
    return hit ? join(gitDir, hit) : null;
  } catch {
    return null;
  }
}

/** The repo's claim registry, or null when the repo keeps none. */
export async function repoClaims(mainRoot: string, isLiveClaude: (pid: number) => boolean): Promise<RepoClaims | null> {
  const hit = cache.get(mainRoot);
  if (hit && Date.now() - hit.at < 2_500) return hit.value;
  const file = await registryFile(mainRoot);
  if (!file) {
    cache.set(mainRoot, { at: Date.now(), mtime: 0, value: null });
    return null;
  }
  let value: RepoClaims | null = null;
  try {
    const mtime = (await stat(file)).mtimeMs;
    const raw = JSON.parse(await readFile(file, "utf8")) as { claims?: RawClaim[] };
    const script = join(mainRoot, "scripts", "worktree_session.py");
    value = {
      repo: mainRoot,
      file,
      script: existsSync(script) ? script : null,
      claims: (raw.claims ?? []).map((c) => ({ ...c, live: claimIsLive(c, isLiveClaude) })),
    };
    cache.set(mainRoot, { at: Date.now(), mtime, value });
  } catch {
    cache.set(mainRoot, { at: Date.now(), mtime: 0, value: null });
  }
  return value;
}

export function claimIsLive(c: { pid: number; heartbeat: string }, isLiveClaude: (pid: number) => boolean): boolean {
  if (c.pid > 0) return isLiveClaude(c.pid);
  const t = Date.parse(c.heartbeat);
  return !Number.isNaN(t) && Date.now() - t < SHELL_CLAIM_HOURS * 3_600_000;
}

export function claimsOf(reg: RepoClaims | null, pid: number, sessionId: string): Claim[] {
  if (!reg) return [];
  return reg.claims
    .filter((c) => c.pid === pid || c.session === sessionId)
    .map((c) => ({
      repo: reg.repo,
      worktree: c.worktree,
      branch: c.branch,
      note: c.note,
      paths: c.paths,
      leases: c.leases,
      live: c.live,
    }));
}

export function forgetClaims(mainRoot: string): void {
  cache.delete(mainRoot);
}

/** Releases one worktree's claim through the repo's own script, optionally deleting the worktree. */
export async function endClaim(
  reg: RepoClaims,
  worktree: string,
  opts: { remove: boolean; force: boolean },
): Promise<{ ok: boolean; output: string }> {
  if (!reg.script) return { ok: false, output: "This repo has no scripts/worktree_session.py" };
  const args = [reg.script, "end", "--worktree", worktree];
  if (opts.remove) args.push("--remove");
  if (opts.force) args.push("--force");
  const out = await run("python3", args, { cwd: reg.repo, timeoutMs: 120_000 });
  forgetClaims(reg.repo);
  return { ok: out.ok, output: (out.stdout + out.stderr).trim() };
}
