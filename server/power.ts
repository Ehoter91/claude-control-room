import type { PowerState } from "../shared/types.ts";
import { run } from "./proc.ts";

const PMSET = "/usr/bin/pmset";
let state: PowerState = { sleepDisabled: null, passwordless: false };

export function powerState(): PowerState {
  return state;
}

export async function readPower(): Promise<PowerState> {
  const [out, sudo] = await Promise.all([
    run(PMSET, ["-g"], { timeoutMs: 5_000 }),
    run("sudo", ["-n", "-l", PMSET, "-a", "disablesleep", "1"], { timeoutMs: 5_000 }),
  ]);
  const m = /SleepDisabled\s+(\d)/.exec(out.stdout);
  state = { sleepDisabled: m ? m[1] === "1" : null, passwordless: sudo.ok };
  return state;
}

/** Turns "never sleep" on or off. Uses a sudoers rule when present, else the macOS admin prompt. */
export async function setSleepDisabled(on: boolean): Promise<{ ok: boolean; message: string }> {
  const value = on ? "1" : "0";
  const quick = await run("sudo", ["-n", PMSET, "-a", "disablesleep", value], { timeoutMs: 10_000 });
  if (!quick.ok) {
    const script = `do shell script "${PMSET} -a disablesleep ${value}" with prompt "Control Room wants to change whether your Mac may sleep." with administrator privileges`;
    const prompt = await run("osascript", ["-e", script], { timeoutMs: 120_000 });
    if (!prompt.ok) {
      const cancelled = /User canceled|-128/.test(prompt.stderr);
      await readPower();
      return { ok: false, message: cancelled ? "Cancelled" : `Could not change sleep: ${prompt.stderr.trim()}` };
    }
  }
  await readPower();
  return { ok: true, message: on ? "Your Mac will stay awake, even with the lid closed." : "Your Mac can sleep again." };
}

/** The one-line sudoers rule that removes the password prompt for exactly these two commands. */
export function sudoersLine(user: string): string {
  return `${user} ALL=(root) NOPASSWD: ${PMSET} -a disablesleep 0, ${PMSET} -a disablesleep 1`;
}
