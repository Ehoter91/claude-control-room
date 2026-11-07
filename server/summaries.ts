import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AccountRef, Summary } from "../shared/types.ts";
import { claudeEnv } from "./homes.ts";
import { SUMMARIZER_CWD, SUMMARY_DIR } from "./paths.ts";
import { run } from "./proc.ts";

const SYSTEM = `You write status notes about one AI coding session for a dashboard.
The reader may be non-technical and is not a native English speaker.
Rules:
- Plain, everyday English. Short sentences. No jargon.
- Never use code names, file paths, function names, branch names, ticket or PR numbers.
- Say what the work means for the product or the team, not how the code works.
- "headline": what this session works on overall. At most 12 words. No final period.
  Example: "Teaching the assistant to understand dates like 'last week'"
- "now": the latest state in one sentence of at most 20 words: what it just finished,
  what it is doing, or what it needs from the person.
Reply with JSON only: {"headline": "...", "now": "..."}`;

export interface SummaryInput {
  sessionId: string;
  account: AccountRef | null; // the summary runs on the session's own account, never on another one
  basisAt: number; // time of the newest transcript entry the summary covers
  status: string;
  title: string | null;
  story: string | null;
  note: string | null;
  firstPrompt: string | null;
  recent: { role: string; text: string }[];
}

interface Stored {
  headline: string;
  now: string | null;
  at: number;
  basisAt: number;
  status: string;
}

const cache = new Map<string, Stored | null>();
const queue = new Map<string, SummaryInput>();
let running = 0;
const MAX_RUNNING = 2;

function cut(text: string | null, max: number): string {
  if (!text) return "";
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

export function buildPrompt(input: SummaryInput): string {
  const lines = [
    input.title ? `Session title: ${cut(input.title, 120)}` : null,
    input.story ? `Planned task: ${cut(input.story, 200)}` : null,
    input.note ? `Team note: ${cut(input.note, 300)}` : null,
    input.firstPrompt ? `First request from the person:\n${cut(input.firstPrompt, 1500)}` : null,
    `Current status: ${input.status}`,
    "Latest conversation (oldest first):",
    ...input.recent.map((m) => `${m.role === "user" ? "Person" : m.role === "tool" ? "Assistant action" : "Assistant"}: ${cut(m.text, 500)}`),
  ];
  return lines.filter(Boolean).join("\n");
}

export function parseSummary(text: string): { headline: string; now: string | null } | null {
  const m = /\{[\s\S]*\}/.exec(text);
  if (!m) return null;
  try {
    const d = JSON.parse(m[0]);
    if (typeof d.headline !== "string" || !d.headline.trim()) return null;
    return { headline: d.headline.trim().replace(/\.$/, ""), now: typeof d.now === "string" && d.now.trim() ? d.now.trim() : null };
  } catch {
    return null;
  }
}

async function load(sessionId: string): Promise<Stored | null> {
  if (cache.has(sessionId)) return cache.get(sessionId) ?? null;
  try {
    const stored = JSON.parse(await readFile(join(SUMMARY_DIR, `${sessionId}.json`), "utf8")) as Stored;
    cache.set(sessionId, stored);
    return stored;
  } catch {
    cache.set(sessionId, null);
    return null;
  }
}

export async function storedSummary(sessionId: string): Promise<Summary | null> {
  const s = await load(sessionId);
  return s ? { headline: s.headline, now: s.now, source: "ai", updatedAt: s.at } : null;
}

/** Asks for a fresh summary when the session moved on enough since the last one. */
export async function maybeSummarize(input: SummaryInput, opts: { turnJustEnded: boolean; working: boolean }): Promise<void> {
  const prev = await load(input.sessionId);
  const now = Date.now();
  if (prev) {
    if (input.basisAt <= prev.basisAt) return;
    const age = now - prev.at;
    const due = opts.turnJustEnded ? age > 30_000 : opts.working ? age > 4 * 60_000 : age > 10 * 60_000;
    if (!due) return;
  }
  if (!input.recent.length && !input.firstPrompt) return;
  queue.set(input.sessionId, input);
  pump();
}

function pump(): void {
  while (running < MAX_RUNNING && queue.size) {
    const [id, input] = queue.entries().next().value as [string, SummaryInput];
    queue.delete(id);
    running++;
    void summarize(input).finally(() => {
      running--;
      pump();
    });
  }
}

async function summarize(input: SummaryInput): Promise<void> {
  await mkdir(SUMMARIZER_CWD, { recursive: true });
  const out = await run(
    "claude",
    [
      "-p",
      "--model",
      "haiku",
      "--output-format",
      "json",
      "--tools",
      "",
      "--no-session-persistence",
      "--strict-mcp-config",
      "--setting-sources",
      "",
      "--system-prompt",
      SYSTEM,
    ],
    { cwd: SUMMARIZER_CWD, timeoutMs: 90_000, input: buildPrompt(input), env: claudeEnv(input.account) },
  );
  let parsed: { headline: string; now: string | null } | null = null;
  try {
    const envelope = JSON.parse(out.stdout);
    if (!envelope.is_error && typeof envelope.result === "string") parsed = parseSummary(envelope.result);
  } catch {
    parsed = null;
  }
  if (!parsed) return;
  const stored: Stored = { ...parsed, at: Date.now(), basisAt: input.basisAt, status: input.status };
  cache.set(input.sessionId, stored);
  await mkdir(SUMMARY_DIR, { recursive: true });
  await writeFile(join(SUMMARY_DIR, `${input.sessionId}.json`), JSON.stringify(stored) + "\n");
}
