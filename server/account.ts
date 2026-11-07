import { spawn } from "node:child_process";
import type { Account, AccountRef } from "../shared/types.ts";
import { claudeEnv } from "./homes.ts";
import { settings } from "./config.ts";
import { launch, run } from "./proc.ts";

const NONE: Account = { email: null, orgName: null, plan: null, loggedIn: false };
// By config folder; "" is ~/.claude, the usual one.
const accounts = new Map<string, Account>();
const logins = new Map<string, { startedAt: number; url: string | null; done: boolean }>();

export function currentAccount(dir: string | null = null): Account {
  return accounts.get(dir ?? "") ?? NONE;
}

export async function readAccount(ref: AccountRef | null = null): Promise<Account> {
  const out = await run("claude", ["auth", "status", "--json"], { timeoutMs: 20_000, env: claudeEnv(ref) });
  try {
    const d = JSON.parse(out.stdout);
    accounts.set(ref?.dir ?? "", {
      email: d.email ?? null,
      orgName: d.orgName ?? null,
      plan: d.subscriptionType ?? null,
      loggedIn: d.loggedIn === true,
    });
  } catch {
    /* keep the last known account */
  }
  return currentAccount(ref?.dir);
}

/** The usual account and every one in Settings. */
export async function readAccounts(): Promise<void> {
  await Promise.all([readAccount(null), ...settings().accounts.map((a) => readAccount(a))]);
}

/**
 * Starts `claude auth login`, which opens claude.ai in the browser to pick an account. For the usual account, every
 * session uses the new one once the browser sign-in finishes; another account signs in within its own folder.
 */
export function startAccountSwitch(ref: AccountRef | null = null): Promise<{ ok: boolean; message: string; url: string | null }> {
  const key = ref?.dir ?? "";
  const login = logins.get(key);
  if (login && !login.done && Date.now() - login.startedAt < 10 * 60_000) {
    if (login.url) launch("open", [login.url]);
    return Promise.resolve({ ok: true, message: "A sign-in is already open in your browser.", url: login.url });
  }
  const state = { startedAt: Date.now(), url: null as string | null, done: false };
  logins.set(key, state);
  const child = spawn("claude", ["auth", "login", "--claudeai"], { env: claudeEnv(ref), stdio: ["ignore", "pipe", "pipe"] });
  const timer = setTimeout(() => child.kill("SIGTERM"), 10 * 60_000);
  const which = ref ? ` to ${ref.label}` : "";
  return new Promise((resolve) => {
    let answered = false;
    const answer = (ok: boolean, message: string) => {
      if (answered) return;
      answered = true;
      resolve({ ok, message, url: state.url });
    };
    const onData = (chunk: Buffer) => {
      const m = /https:\/\/\S+/.exec(chunk.toString());
      if (m && !state.url) {
        state.url = m[0];
        answer(true, `Sign in${which} with the account you want in the browser window that opened.`);
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("error", (err) => answer(false, `Could not start the sign-in: ${err.message}`));
    child.on("exit", (code) => {
      clearTimeout(timer);
      state.done = true;
      void readAccount(ref);
      answer(code === 0, code === 0 ? `Signed in${which}.` : "The sign-in did not finish.");
    });
    // The CLI usually opens the browser itself; if it printed nothing yet, say what is happening.
    setTimeout(() => answer(true, `Finish the sign-in${which} in your browser.`), 4_000);
  });
}
