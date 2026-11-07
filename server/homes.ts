// Claude Code keeps a login, its sessions, its conversations and its settings in one config folder: ~/.claude, or the
// folder CLAUDE_CONFIG_DIR names. Each folder added in Settings is another account, and Control Room reads them all.
import { join, sep } from "node:path";
import type { AccountRef } from "../shared/types.ts";
import { settings } from "./config.ts";
import { CLAUDE_DIR } from "./paths.ts";
import { CHILD_ENV } from "./proc.ts";

/** One config folder; `account` is null for ~/.claude, the usual one. */
export interface Home {
  account: AccountRef | null;
  dir: string;
}

export function homes(accounts = settings().accounts): Home[] {
  return [{ account: null, dir: CLAUDE_DIR }, ...accounts.map((a) => ({ account: a, dir: a.dir }))];
}

/** The config folder of an account; ~/.claude for the usual one. */
export function homeDir(account: AccountRef | null): string {
  return account?.dir ?? CLAUDE_DIR;
}

export const sessionsDir = (dir: string) => join(dir, "sessions");
export const projectsDir = (dir: string) => join(dir, "projects");
export const settingsFile = (dir: string) => join(dir, "settings.json");

/** The account a file belongs to, by the config folder it lies in, the deepest first. A file in none is no account's. */
export function homeOf(path: string, list = homes()): Home | null {
  const holders = list.filter((h) => path.startsWith(h.dir + sep));
  return holders.sort((a, b) => b.dir.length - a.dir.length)[0] ?? null;
}

/** The environment a `claude` command runs in for this account. */
export function claudeEnv(account: AccountRef | null): NodeJS.ProcessEnv {
  const { CLAUDE_CONFIG_DIR: _, ...env } = CHILD_ENV;
  return account ? { ...env, CLAUDE_CONFIG_DIR: account.dir } : env;
}

/** The account Settings lists under this folder: what an action may start a session on. */
export function accountByDir(dir: unknown): AccountRef | null {
  return settings().accounts.find((a) => a.dir === dir) ?? null;
}
