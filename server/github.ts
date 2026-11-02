import type { CheckState, PullRequest } from "../shared/types.ts";
import { run } from "./proc.ts";

const FIELDS =
  "number,title,url,state,isDraft,headRefName,headRefOid,reviewDecision,mergeable,statusCheckRollup,updatedAt,mergedAt";

export interface PrRow extends PullRequest {
  headRefName: string;
  headRefOid: string;
}

interface RepoCache {
  at: number;
  rows: PrRow[];
  loading: boolean;
}

const repos = new Map<string, RepoCache>();
const byNumber = new Map<string, { at: number; row: PrRow | null }>();
let ghOk: boolean | null = null;

export function ghReady(): boolean {
  return ghOk === true;
}

export async function checkGh(): Promise<boolean> {
  const out = await run("gh", ["auth", "status"], { timeoutMs: 8_000 });
  ghOk = out.ok;
  return ghOk;
}

export function summarizeChecks(rollup: unknown): { state: CheckState; passed: number; failed: number; pending: number } {
  let passed = 0;
  let failed = 0;
  let pending = 0;
  for (const item of Array.isArray(rollup) ? (rollup as Record<string, unknown>[]) : []) {
    if (item.__typename === "StatusContext") {
      const s = String(item.state ?? "");
      if (s === "SUCCESS") passed++;
      else if (s === "FAILURE" || s === "ERROR") failed++;
      else pending++;
      continue;
    }
    const status = String(item.status ?? "");
    const conclusion = String(item.conclusion ?? "");
    if (status !== "COMPLETED") pending++;
    else if (["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"].includes(conclusion)) failed++;
    else passed++;
  }
  const state: CheckState = failed ? "failing" : pending ? "pending" : passed ? "passing" : "none";
  return { state, passed, failed, pending };
}

function toRow(raw: Record<string, any>): PrRow {
  const checks = summarizeChecks(raw.statusCheckRollup);
  return {
    number: raw.number,
    title: raw.title ?? "",
    url: raw.url ?? "",
    state: raw.state,
    isDraft: raw.isDraft === true,
    review: raw.reviewDecision || null,
    checks: checks.state,
    checksSummary: { passed: checks.passed, failed: checks.failed, pending: checks.pending },
    mergeable: raw.mergeable ?? "UNKNOWN",
    updatedAt: raw.updatedAt ?? "",
    mergedAt: raw.mergedAt ?? null,
    headRefName: raw.headRefName ?? "",
    headRefOid: raw.headRefOid ?? "",
  };
}

/** Refreshes a repo's recent PRs in the background; callers read whatever is cached. */
export function refreshRepo(slug: string, maxAgeMs: number, limit = 80): void {
  const cur = repos.get(slug);
  if (cur && (cur.loading || Date.now() - cur.at < maxAgeMs)) return;
  const entry: RepoCache = cur ?? { at: 0, rows: [], loading: false };
  entry.loading = true;
  repos.set(slug, entry);
  void run("gh", ["pr", "list", "--repo", slug, "--state", "all", "--limit", String(limit), "--json", FIELDS], {
    timeoutMs: 30_000,
  }).then((out) => {
    entry.loading = false;
    entry.at = Date.now();
    if (!out.ok) return;
    ghOk = true;
    try {
      entry.rows = (JSON.parse(out.stdout) as Record<string, any>[]).map(toRow);
    } catch {
      /* keep the last good rows */
    }
  });
}

export function prForBranch(slug: string, branch: string | null): PrRow | null {
  if (!branch) return null;
  const rows = repos.get(slug)?.rows ?? [];
  const mine = rows.filter((r) => r.headRefName === branch);
  if (!mine.length) return null;
  return mine.find((r) => r.state === "OPEN") ?? mine.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
}

/** A PR named by number (from the session's own pr-link), fetched once every two minutes. */
export function prByNumber(slug: string, num: number): PrRow | null {
  const listed = repos.get(slug)?.rows.find((r) => r.number === num);
  if (listed) return listed;
  const key = `${slug}#${num}`;
  const hit = byNumber.get(key);
  if (!hit || Date.now() - hit.at > 120_000) {
    byNumber.set(key, { at: Date.now(), row: hit?.row ?? null });
    void run("gh", ["pr", "view", String(num), "--repo", slug, "--json", FIELDS], { timeoutMs: 20_000 }).then((out) => {
      if (!out.ok) return;
      try {
        byNumber.set(key, { at: Date.now(), row: toRow(JSON.parse(out.stdout)) });
      } catch {
        /* ignore */
      }
    });
  }
  return hit?.row ?? null;
}

/** Every PR of a repo, for the worktree cleanup scan. */
export async function allPrs(slug: string): Promise<PrRow[]> {
  const out = await run(
    "gh",
    ["pr", "list", "--repo", slug, "--state", "all", "--limit", "1500", "--json", "number,title,url,state,headRefName,headRefOid,mergedAt,updatedAt"],
    { timeoutMs: 90_000 },
  );
  if (!out.ok) return [];
  try {
    return (JSON.parse(out.stdout) as Record<string, any>[]).map((r) =>
      toRow({ ...r, isDraft: false, reviewDecision: null, mergeable: "UNKNOWN", statusCheckRollup: [] }),
    );
  } catch {
    return [];
  }
}
