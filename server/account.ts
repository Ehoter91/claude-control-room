import { spawn } from "node:child_process";
import type { Account } from "../shared/types.ts";
import { CHILD_ENV, launch, run } from "./proc.ts";

let account: Account = { email: null, orgName: null, plan: null, loggedIn: false };
let login: { startedAt: number; url: string | null; done: boolean } | null = null;

export function currentAccount(): Account {
  return account;
}

export async function readAccount(): Promise<Account> {
  const out = await run("claude", ["auth", "status", "--json"], { timeoutMs: 20_000 });
  try {
    const d = JSON.parse(out.stdout);
    account = {
      email: d.email ?? null,
      orgName: d.orgName ?? null,
      plan: d.subscriptionType ?? null,
      loggedIn: d.loggedIn === true,
    };
  } catch {
    /* keep the last known account */
  }
  return account;
}

/**
 * Starts `claude auth login`, which opens claude.ai in the browser to pick an account.
 * Every session uses the new account once the browser sign-in finishes.
 */
export function startAccountSwitch(): Promise<{ ok: boolean; message: string; url: string | null }> {
  if (login && !login.done && Date.now() - login.startedAt < 10 * 60_000) {
    if (login.url) launch("open", [login.url]);
    return Promise.resolve({ ok: true, message: "A sign-in is already open in your browser.", url: login.url });
  }
  const state = { startedAt: Date.now(), url: null as string | null, done: false };
  login = state;
  const child = spawn("claude", ["auth", "login", "--claudeai"], { env: CHILD_ENV, stdio: ["ignore", "pipe", "pipe"] });
  const timer = setTimeout(() => child.kill("SIGTERM"), 10 * 60_000);
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
        answer(true, "Sign in with the account you want in the browser window that opened.");
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("error", (err) => answer(false, `Could not start the sign-in: ${err.message}`));
    child.on("exit", (code) => {
      clearTimeout(timer);
      state.done = true;
      void readAccount();
      answer(code === 0, code === 0 ? "Signed in." : "The sign-in did not finish.");
    });
    // The CLI usually opens the browser itself; if it printed nothing yet, say what is happening.
    setTimeout(() => answer(true, "Finish the sign-in in your browser."), 4_000);
  });
}
