import type { Activity } from "../shared/types.ts";
import type { PermissionAsk } from "./statusline.ts";
import { describeTool, questionOf, type ToolUse, type TranscriptState } from "./transcript.ts";

export interface StatusFile {
  status: string | null; // "busy" | "idle" | "waiting" | "shell"
  waitingFor: string | null; // "permission prompt" | "input needed" | ...
  statusUpdatedAt: number | null;
  updatedAt: number | null;
  startedAt: number;
}

/** True when the reply ends by asking the person something. */
export function endsWithQuestion(text: string | null): boolean {
  if (!text) return false;
  const tail = text.trim().split("\n").filter((l) => l.trim()).slice(-3).join(" ");
  // A polite closing line is not a real question to the person.
  if (/\b(anything else|let me know if|happy to help|feel free to)\b/i.test(tail.slice(-160))) return false;
  if (/\?\s*(\*\*|_|`)?\s*$/.test(tail)) return true;
  return /\b(should I|shall I|do you want|would you like|want me to|which (one|option)|can you confirm|please confirm)\b/i.test(tail.slice(-240));
}

// Tools that never ask for permission, so they are never the call a prompt is about.
const AUTO_TOOLS = new Set(["Read", "Grep", "Glob", "LS", "TodoWrite", "TaskCreate", "TaskUpdate", "ToolSearch", "BashOutput"]);

export function deriveActivity(
  file: StatusFile,
  t: TranscriptState | null,
  now: number,
  inactiveAfterMs: number,
  ask: PermissionAsk | null = null,
): Activity {
  const since = file.statusUpdatedAt ?? file.updatedAt ?? file.startedAt;
  const pending = t && t.pending.length ? t.pending[t.pending.length - 1] : null;
  // The hook's record is the truth for a prompt on screen; the transcript only has calls already approved.
  const asked: ToolUse | null = ask && ask.at >= since - 5_000 ? { id: "hook", name: ask.toolName, input: ask.toolInput, at: null } : null;
  const base = { since, tool: null, question: null, askedYou: false } as const;

  switch (file.status) {
    case "busy": {
      const tool = pending ? describeTool(pending.name, pending.input) : null;
      const lastChat = t?.chat[t.chat.length - 1];
      const doing = tool ? (tool.detail ? `${tool.action}: ${tool.detail}` : tool.action) : lastChat?.role === "assistant" ? "Writing a reply" : "Thinking…";
      return { ...base, kind: "working", label: "Working", detail: doing, tool };
    }
    case "waiting": {
      const reason = (file.waitingFor ?? "").toLowerCase();
      if (reason.includes("permission")) {
        const asking = asked ?? t?.pending.find((p) => !AUTO_TOOLS.has(p.name)) ?? pending;
        const tool = asking ? describeTool(asking.name, asking.input) : null;
        if (asking?.name === "ExitPlanMode") {
          return { ...base, kind: "approval", label: "Plan ready for review", detail: "Approve the plan to let it start", tool };
        }
        return {
          ...base,
          kind: "approval",
          label: "Needs your approval",
          detail: tool ? (tool.detail ? `${tool.action}: ${tool.detail}` : tool.action) : "A tool wants permission to run",
          tool,
        };
      }
      if (reason.includes("input")) {
        const question = questionOf(asked?.name === "AskUserQuestion" ? asked : pending);
        return {
          ...base,
          kind: "question",
          label: "Asked you a question",
          detail: question?.question ?? "Claude needs an answer from you",
          question,
        };
      }
      return { ...base, kind: "waiting", label: "Waiting for you", detail: file.waitingFor ? capitalize(file.waitingFor) : null };
    }
    case "shell":
      return { ...base, kind: "background", label: "Background task running", detail: "The turn is done; a command still runs in the background" };
  }

  const askedYou = endsWithQuestion(t?.lastAssistantText ?? null);
  if (now - since > inactiveAfterMs) {
    return { ...base, kind: "inactive", label: "Inactive", detail: askedYou ? "Last reply asked you something" : null, askedYou };
  }
  if (askedYou) {
    return { ...base, kind: "idle", label: "Waiting for your reply", detail: "The last reply asked you something", askedYou };
  }
  return { ...base, kind: "idle", label: "Idle", detail: "Done — ready for the next step", askedYou };
}

function capitalize(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}
