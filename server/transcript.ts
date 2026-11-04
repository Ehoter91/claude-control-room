import { open, stat } from "node:fs/promises";
import type { ChatLine, QuestionPreview, ToolPreview } from "../shared/types.ts";

export interface ToolUse {
  id: string;
  name: string;
  input: Record<string, unknown>;
  at: string | null;
}

export interface TranscriptState {
  path: string;
  offset: number; // bytes consumed so far
  inode: number;
  chat: ChatLine[];
  pending: ToolUse[]; // tool calls with no result yet, oldest first
  aiTitle: string | null;
  agentName: string | null;
  lastPrompt: string | null;
  lastPromptAt: number | null; // when you last sent the session a message
  prLink: { number: number; url: string; repo: string } | null;
  worktreePath: string | null;
  worktreeBranch: string | null;
  cwd: string | null;
  branch: string | null;
  model: string | null; // raw model id, e.g. "claude-opus-5-5"
  effort: string | null; // from a `/effort` command in this session
  mode: string | null; // the permission mode of the last message
  modeAt: number | null; // when that message was sent
  costUsd: number | null;
  lastAssistantText: string | null;
  lastEntryAt: number | null;
  firstPrompt: string | null;
}

const CHAT_KEEP = 60;
const FIRST_READ_CAP = 12 * 1024 * 1024; // bytes read backwards on first sight of a file
const CHUNK = 1024 * 1024;
const SKIP_TYPES = ['"type":"api-request', '"type":"file-history', '"type":"atis-latch', '"type":"queue-operation'];

export function emptyState(path: string): TranscriptState {
  return {
    path,
    offset: 0,
    inode: 0,
    chat: [],
    pending: [],
    aiTitle: null,
    agentName: null,
    lastPrompt: null,
    lastPromptAt: null,
    prLink: null,
    worktreePath: null,
    worktreeBranch: null,
    cwd: null,
    branch: null,
    model: null,
    effort: null,
    mode: null,
    modeAt: null,
    costUsd: null,
    lastAssistantText: null,
    lastEntryAt: null,
    firstPrompt: null,
  };
}

const states = new Map<string, TranscriptState>();

/** Reads only what is new since the last call; the first call reads backwards from the end. */
export async function readTranscript(path: string): Promise<TranscriptState | null> {
  let info;
  try {
    info = await stat(path);
  } catch {
    states.delete(path);
    return null;
  }
  let state = states.get(path);
  if (state && (state.inode !== info.ino || info.size < state.offset)) state = undefined;
  if (!state) {
    state = emptyState(path);
    state.inode = info.ino;
    await firstRead(state, info.size);
    states.set(path, state);
    return state;
  }
  if (info.size > state.offset) {
    const buf = await readBytes(path, state.offset, info.size);
    // Only whole lines are read; a line still being written waits for the next call.
    const cut = buf.lastIndexOf(0x0a);
    if (cut >= 0) {
      applyLines(state, buf.subarray(0, cut).toString("utf8").split("\n"));
      state.offset += cut + 1;
    }
  }
  return state;
}

async function firstRead(state: TranscriptState, size: number): Promise<void> {
  state.firstPrompt = await readFirstPrompt(state.path);
  // Walk backwards in chunks until enough conversation is in hand or the cap is reached.
  let start = size;
  let buf = Buffer.alloc(0);
  while (start > 0 && size - start < FIRST_READ_CAP) {
    const from = Math.max(0, start - CHUNK);
    buf = Buffer.concat([await readBytes(state.path, from, start), buf]);
    start = from;
    if (countChat(buf) >= CHAT_KEEP) break;
  }
  let begin = 0;
  if (start > 0) {
    const nl = buf.indexOf(0x0a);
    begin = nl >= 0 ? nl + 1 : buf.length;
  }
  const end = buf.lastIndexOf(0x0a);
  if (end < begin) {
    state.offset = start + begin;
    return;
  }
  applyLines(state, buf.subarray(begin, end).toString("utf8").split("\n"));
  state.offset = start + end + 1;
  // A long turn of tool output can push your last message out of that stretch. The list's order needs its time.
  if (state.lastPromptAt === null && start + begin > 0) state.lastPromptAt = await lastPromptBefore(state.path, start + begin);
}

/** The time of your last message before byte `end`, reading backwards up to FIRST_READ_CAP more bytes. */
async function lastPromptBefore(path: string, end: number): Promise<number | null> {
  let start = end;
  let carry = Buffer.alloc(0); // the end part of a line whose start is in the chunk before
  while (start > 0 && end - start < FIRST_READ_CAP) {
    const from = Math.max(0, start - CHUNK);
    const buf = Buffer.concat([await readBytes(path, from, start), carry]);
    start = from;
    const nl = from > 0 ? buf.indexOf(0x0a) : -1;
    carry = nl >= 0 ? buf.subarray(0, nl) : from > 0 ? buf : Buffer.alloc(0);
    if (nl < 0 && from > 0) continue;
    const lines = buf.subarray(nl + 1).toString("utf8").split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes('"type":"user"')) continue;
      const e = parse(lines[i]);
      if (!e || e.type !== "user" || e.isMeta || e.isSidechain || !userText(e)) continue;
      const at = typeof e.timestamp === "string" ? Date.parse(e.timestamp) : NaN;
      if (!Number.isNaN(at)) return at;
    }
  }
  return null;
}

function countChat(buf: Buffer): number {
  let n = 0;
  for (const needle of ['"type":"user"', '"type":"assistant"']) {
    let i = buf.indexOf(needle);
    while (i >= 0) {
      n++;
      i = buf.indexOf(needle, i + needle.length);
    }
  }
  return n;
}

async function readBytes(path: string, from: number, to: number): Promise<Buffer> {
  const handle = await open(path, "r");
  try {
    const buf = Buffer.alloc(Math.max(0, to - from));
    const { bytesRead } = await handle.read(buf, 0, buf.length, from);
    return buf.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

async function readFirstPrompt(path: string): Promise<string | null> {
  let text: string;
  try {
    text = (await readBytes(path, 0, Math.min((await stat(path)).size, 512 * 1024))).toString("utf8");
  } catch {
    return null;
  }
  for (const line of text.split("\n")) {
    if (!line.includes('"type":"user"')) continue;
    const entry = parse(line);
    if (!entry || entry.type !== "user" || entry.isMeta) continue;
    const said = userText(entry);
    if (said && !said.startsWith("/")) return said;
  }
  return null;
}

type Entry = Record<string, any>;

function parse(line: string): Entry | null {
  if (!line || line[0] !== "{") return null;
  const head = line.slice(0, 120);
  if (SKIP_TYPES.some((t) => head.includes(t))) return null;
  try {
    return JSON.parse(line) as Entry;
  } catch {
    return null;
  }
}

export function applyLines(state: TranscriptState, lines: string[]): void {
  for (const line of lines) {
    const entry = parse(line);
    if (entry) applyEntry(state, entry);
  }
  if (state.chat.length > CHAT_KEEP) state.chat.splice(0, state.chat.length - CHAT_KEEP);
  if (state.pending.length > 20) state.pending.splice(0, state.pending.length - 20);
}

function applyEntry(state: TranscriptState, e: Entry): void {
  if (typeof e.timestamp === "string") {
    const t = Date.parse(e.timestamp);
    if (!Number.isNaN(t)) state.lastEntryAt = Math.max(state.lastEntryAt ?? 0, t);
  }
  if (typeof e.cwd === "string" && e.isSidechain !== true) state.cwd = e.cwd;
  if (typeof e.gitBranch === "string" && e.gitBranch && e.isSidechain !== true) state.branch = e.gitBranch;
  switch (e.type) {
    case "ai-title":
      if (typeof e.aiTitle === "string") state.aiTitle = e.aiTitle;
      return;
    case "agent-name":
      if (typeof e.agentName === "string") state.agentName = e.agentName;
      return;
    case "custom-title":
      if (typeof e.customTitle === "string") state.agentName = e.customTitle;
      return;
    case "last-prompt":
      if (typeof e.lastPrompt === "string") state.lastPrompt = e.lastPrompt;
      return;
    case "pr-link":
      if (typeof e.prNumber === "number") {
        state.prLink = { number: e.prNumber, url: String(e.prUrl ?? ""), repo: String(e.prRepository ?? "") };
      }
      return;
    case "worktree-state": {
      const w = e.worktreeSession;
      state.worktreePath = w && typeof w.worktreePath === "string" ? w.worktreePath : null;
      state.worktreeBranch = w && typeof w.worktreeBranch === "string" ? w.worktreeBranch : null;
      return;
    }
    case "relocated":
      if (typeof e.relocatedCwd === "string") state.cwd = e.relocatedCwd;
      return;
    case "permission-mode":
      // Written with each message, and on its own when a session resumes.
      if (typeof e.permissionMode === "string" && e.isSidechain !== true) state.mode = e.permissionMode;
      return;
    case "cost-state":
      if (typeof e.totalCostUSD === "number") state.costUsd = e.totalCostUSD;
      return;
    case "system":
      if (e.subtype === "local_command" && typeof e.content === "string") readCommandOutput(state, e.content);
      return;
    case "user":
      if (e.isSidechain) return;
      applyUser(state, e);
      return;
    case "assistant":
      if (e.isSidechain) return;
      applyAssistant(state, e);
      return;
  }
}

function readCommandOutput(state: TranscriptState, content: string): void {
  const effort = /Set effort level to (\w+)/.exec(content);
  if (effort) state.effort = effort[1].toLowerCase();
}

function applyUser(state: TranscriptState, e: Entry): void {
  const content = e.message?.content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block?.type === "tool_result" && typeof block.tool_use_id === "string") {
        state.pending = state.pending.filter((p) => p.id !== block.tool_use_id);
      }
    }
  }
  if (e.isMeta) return;
  if (typeof e.permissionMode === "string") {
    state.mode = e.permissionMode;
    const at = typeof e.timestamp === "string" ? Date.parse(e.timestamp) : NaN;
    if (!Number.isNaN(at)) state.modeAt = at;
  }
  const said = userText(e);
  if (said) {
    state.pending = [];
    state.chat.push({ role: "user", text: said, at: e.timestamp ?? null });
    const at = typeof e.timestamp === "string" ? Date.parse(e.timestamp) : NaN;
    if (!Number.isNaN(at)) state.lastPromptAt = Math.max(state.lastPromptAt ?? 0, at);
  }
}

function applyAssistant(state: TranscriptState, e: Entry): void {
  const msg = e.message ?? {};
  if (typeof msg.model === "string" && msg.model !== "<synthetic>") state.model = msg.model;
  const content = Array.isArray(msg.content) ? msg.content : [];
  const texts: string[] = [];
  for (const block of content) {
    if (block?.type === "text" && typeof block.text === "string" && block.text.trim()) {
      texts.push(block.text.trim());
    } else if (block?.type === "tool_use" && typeof block.id === "string") {
      const use: ToolUse = { id: block.id, name: String(block.name ?? "tool"), input: block.input ?? {}, at: e.timestamp ?? null };
      state.pending.push(use);
      const p = describeTool(use.name, use.input);
      state.chat.push({ role: "tool", text: p.detail ? `${p.action}: ${p.detail}` : p.action, at: use.at });
    }
  }
  if (texts.length) {
    const text = texts.join("\n\n");
    state.lastAssistantText = text;
    state.chat.push({ role: "assistant", text, at: e.timestamp ?? null });
  }
}

const NOISE = /<(system-reminder|local-command-stdout|local-command-stderr|local-command-caveat|task-notification|command-message)>[\s\S]*?<\/\1>/g;

/** The words a person typed, or null for tool results and machine-made messages. */
export function userText(e: Entry): string | null {
  const content = e.message?.content;
  let raw = "";
  if (typeof content === "string") raw = content;
  else if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (block?.type === "text" && typeof block.text === "string") parts.push(block.text);
      else if (block?.type === "image") parts.push("[image]");
    }
    raw = parts.join("\n");
  }
  if (!raw) return null;
  const command = /<command-name>\s*([^<]+?)\s*<\/command-name>/.exec(raw);
  if (command) {
    const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(raw)?.[1]?.trim();
    return `${command[1].startsWith("/") ? "" : "/"}${command[1]}${args ? ` ${args}` : ""}`;
  }
  const bash = /<bash-input>([\s\S]*?)<\/bash-input>/.exec(raw);
  if (bash) return `! ${bash[1].trim()}`;
  if (/^<(bash-stdout|bash-stderr)>/.test(raw.trim())) return null;
  const text = raw
    .replace(NOISE, "")
    .replace(/<pasted_content[^>]*>[\s\S]*?<\/pasted_content[^>]*>/g, "[pasted text]")
    .trim();
  if (!text) return null;
  if (text.startsWith("[Request interrupted")) return "⏹ Interrupted";
  if (text.startsWith("Caveat:")) return null;
  return text;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function short(path: string | null): string | null {
  if (!path) return null;
  const parts = path.split("/").filter(Boolean);
  return parts.slice(-2).join("/");
}

function firstLine(text: string | null, max = 160): string | null {
  if (!text) return null;
  const line = text.split("\n").find((l) => l.trim()) ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function pretty(name: string): string {
  return name.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
}

/** Turns a tool call into plain words a non-technical reader understands. */
export function describeTool(name: string, input: Record<string, unknown>): ToolPreview {
  const make = (action: string, detail: string | null): ToolPreview => ({ tool: name, action, detail });
  switch (name) {
    case "Bash":
      return make("Run a command", firstLine(str(input.description)) ?? firstLine(str(input.command)));
    case "BashOutput":
    case "KillShell":
    case "Monitor":
    case "TaskStop":
      return make("Check a background task", firstLine(str(input.description)));
    case "Read":
      return make("Read a file", short(str(input.file_path)));
    case "Edit":
    case "MultiEdit":
      return make("Edit a file", short(str(input.file_path)));
    case "Write":
      return make("Write a file", short(str(input.file_path)));
    case "NotebookEdit":
      return make("Edit a notebook", short(str(input.notebook_path)));
    case "Grep":
      return make("Search the code", firstLine(str(input.pattern), 80));
    case "Glob":
      return make("Find files", firstLine(str(input.pattern), 80));
    case "WebFetch": {
      const url = str(input.url);
      let host: string | null = url;
      try {
        host = url ? new URL(url).host : null;
      } catch {
        /* keep the raw url */
      }
      return make("Open a web page", host);
    }
    case "WebSearch":
      return make("Search the web", firstLine(str(input.query), 100));
    case "Task":
    case "Agent":
      return make("Start a helper agent", firstLine(str(input.description)));
    case "TodoWrite":
    case "TaskCreate":
    case "TaskUpdate":
      return make("Update its task list", null);
    case "AskUserQuestion": {
      const qs = Array.isArray(input.questions) ? input.questions : [];
      return make("Ask you a question", firstLine(str((qs[0] as Record<string, unknown>)?.question)));
    }
    case "ExitPlanMode":
      return make("Show you a plan", null);
    case "EnterWorktree":
      return make("Move into a worktree", short(str(input.path)));
    case "Skill":
      return make("Use a skill", str(input.skill));
    case "Workflow":
      return make("Run a workflow", null);
    case "SendMessage":
      return make("Message another session", str(input.to));
    case "Artifact":
      return make("Publish a page", null);
    case "ToolSearch":
      return make("Load more tools", null);
    case "ScheduleWakeup":
      return make("Schedule a check-in", null);
  }
  if (name.startsWith("mcp__")) {
    const [, server = "", tool = ""] = name.split("__");
    const service = pretty(server.replace(/^claude_ai_/, ""));
    return make(`Use ${service}`, pretty(tool));
  }
  return make(`Use ${pretty(name)}`, null);
}

/** The question form of a pending AskUserQuestion call. */
export function questionOf(use: ToolUse | null): QuestionPreview | null {
  if (!use || use.name !== "AskUserQuestion") return null;
  const qs = Array.isArray(use.input.questions) ? (use.input.questions as Record<string, unknown>[]) : [];
  const q = qs[0];
  if (!q) return null;
  const options = Array.isArray(q.options) ? (q.options as Record<string, unknown>[]) : [];
  return {
    question: str(q.question) ?? "",
    header: str(q.header),
    options: options.map((o) => ({ label: str(o.label) ?? "", description: str(o.description) })),
    multiSelect: q.multiSelect === true,
    count: qs.length,
  };
}

/** "claude-opus-5-5" → "Opus 5.5" */
export function modelName(id: string | null): string | null {
  if (!id) return null;
  const m = /claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?/.exec(id);
  if (!m) return id;
  const family = m[1][0].toUpperCase() + m[1].slice(1);
  return m[3] ? `${family} ${m[2]}.${m[3]}` : `${family} ${m[2]}`;
}
