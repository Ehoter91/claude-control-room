// The model, effort and permission mode a session runs with: what the page offers, and what the server lets through.

export interface Choice {
  id: string;
  label: string;
  hint: string;
}

/** Claude Code's model aliases: each starts the latest model of its family. */
export const MODELS: Choice[] = [
  { id: "fable", label: "Fable", hint: "Most capable" },
  { id: "opus", label: "Opus", hint: "Deep work" },
  { id: "opus[1m]", label: "Opus 1M", hint: "Opus with a 1M-token context" },
  { id: "sonnet", label: "Sonnet", hint: "Fast and capable" },
  { id: "haiku", label: "Haiku", hint: "Fastest" },
];

export const EFFORTS: Choice[] = [
  { id: "low", label: "low", hint: "Quick answers" },
  { id: "medium", label: "medium", hint: "" },
  { id: "high", label: "high", hint: "" },
  { id: "xhigh", label: "xhigh", hint: "" },
  { id: "max", label: "max", hint: "Thinks longest" },
];

/** The modes Shift+Tab cycles through in Claude Code, in its order. */
export const MODES: Choice[] = [
  { id: "auto", label: "auto", hint: "Runs safe actions, asks about risky ones" },
  { id: "manual", label: "manual", hint: "Asks before each edit and command" },
  { id: "acceptEdits", label: "accept edits", hint: "Edits files without asking" },
  { id: "plan", label: "plan", hint: "Plans first, changes nothing" },
];

export const DEFAULT_MODE = "auto";

export function isModel(v: unknown): v is string {
  return typeof v === "string" && /^[a-z][a-z0-9.-]{1,60}(\[1m\])?$/.test(v);
}

export function isEffort(v: unknown): v is string {
  return typeof v === "string" && EFFORTS.some((e) => e.id === v);
}

export function isMode(v: unknown): v is string {
  return typeof v === "string" && MODES.some((m) => m.id === v);
}

/** The alias a model id belongs to, e.g. "claude-opus-5-5[1m]" is "opus[1m]". */
export function modelAlias(id: string | null): string | null {
  if (!id) return null;
  const family = MODELS.find((m) => !m.id.includes("[") && id.includes(m.id))?.id;
  if (!family) return null;
  return /\[1m\]$/.test(id) && family === "opus" ? "opus[1m]" : family;
}

/** A permission mode as Claude Code writes it, in the words Shift+Tab shows; older versions called "manual" "default". */
export function modeName(mode: string | null): string | null {
  if (!mode) return null;
  const id = mode === "default" ? "manual" : mode;
  return MODES.find((m) => m.id === id)?.label ?? id;
}

/** Quotes a word for the shell, so it stays one word whatever is in it. */
export function shellQuote(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

/** How many Claude accounts Control Room takes besides the usual one. */
export const MAX_ACCOUNTS = 5;

/** What starts Claude Code on an account, for a command to copy: plain `claude` for the usual one. */
export function claudeCommand(account: { dir: string } | null): string {
  return account ? `CLAUDE_CONFIG_DIR=${shellQuote(account.dir)} claude` : "claude";
}
