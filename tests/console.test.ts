// Sessions that run in Control Room, and their console, against a real tmux server of the test's own.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openTarget, targetName } from "../shared/ides.ts";

const home = mkdtempSync(join(tmpdir(), "cr-home-"));
process.env.HOME = home;
process.env.CONTROL_ROOM_TMUX_SOCKET = `cr-test-${process.pid}`;

let hosted: typeof import("../server/hosted.ts");
let consoles: typeof import("../server/console.ts");
beforeAll(async () => {
  hosted = await import("../server/hosted.ts");
  consoles = await import("../server/console.ts");
});

describe("hosted sessions", () => {
  it("knows its own session names only", () => {
    expect(hosted.isHostedName("cr-0a1b2c3d")).toBe(true);
    for (const name of ["cr-0a1b2c3", "cr-0A1B2C3D", "work", "cr-0a1b2c3d;rm", 7, null]) expect(hosted.isHostedName(name)).toBe(false);
    expect(hosted.hostedName("cr-0a1b2c3d:@0.%0")).toBe("cr-0a1b2c3d");
    expect(hosted.hostedName("dev:@1.%3")).toBeNull();
    expect(hosted.hostedName(null)).toBeNull();
  });

  it("hands the first message to Claude Code as one argument, never to the shell", () => {
    const prompt = `fix "this"; rm -rf ~ $(whoami) \`id\``;
    const args = hosted.newSessionArgs("cr-0a1b2c3d", { cwd: "/repo", prompt, cols: 1000, rows: 2 }, "/bin/zsh");
    expect(args.slice(-6)).toEqual(["/bin/zsh", "-lic", 'claude "$@"', "claude", "--", prompt]);
    expect(args).toContain("new-session");
    expect(args[args.indexOf("-x") + 1]).toBe("400");
    expect(args[args.indexOf("-y") + 1]).toBe("10");
    expect(hosted.newSessionArgs("cr-0a1b2c3d", { cwd: "/repo", prompt: "-x" }).slice(-2)).toEqual(["--", "-x"]);
    expect(hosted.newSessionArgs("cr-0a1b2c3d", { cwd: "/repo", resume: "abc" }).slice(-2)).toEqual(["--resume", "abc"]);
    expect(hosted.newSessionArgs("cr-0a1b2c3d", { cwd: "/repo" }).at(-1)).toBe("claude");
    const tuned = hosted.newSessionArgs("cr-0a1b2c3d", { cwd: "/repo", prompt: "hi", model: "opus[1m]", effort: "high", mode: "plan" });
    expect(tuned.slice(tuned.indexOf("claude", tuned.indexOf("-lic") + 2))).toEqual(["claude", "--model", "opus[1m]", "--effort", "high", "--permission-mode", "plan", "--", "hi"]);
  });

  it("starts Claude Code without the variables of whoever started Control Room", () => {
    const env = hosted.sessionEnv({ PATH: "/bin", CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "cli", ELECTRON_RUN_AS_NODE: "1", npm_lifecycle_event: "app", TMUX: "x", HOME: "/h" });
    expect(env).toMatchObject({ PATH: "/bin", HOME: "/h", COLORTERM: "truecolor", LANG: "en_US.UTF-8" });
    for (const k of ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "ELECTRON_RUN_AS_NODE", "npm_lifecycle_event", "TMUX"]) expect(env[k]).toBeUndefined();
  });

  it("refuses a folder that does not exist, and a resume id that is not one", async () => {
    expect((await hosted.startSession({ cwd: join(home, "nope") })).ok).toBe(false);
    expect((await hosted.startSession({ cwd: "relative/path" })).ok).toBe(false);
    expect((await hosted.startSession({ cwd: home, resume: "--mcp-config x" })).ok).toBe(false);
    expect((await hosted.startSession({ cwd: home, model: "opus --settings x" })).ok).toBe(false);
    expect((await hosted.startSession({ cwd: home, effort: "ultra" })).ok).toBe(false);
    expect((await hosted.startSession({ cwd: home, mode: "bypassPermissions" })).ok).toBe(false);
  });

  it("puts back the defaults that /model and /effort save, and nothing else", async () => {
    const { keepDefaults } = await import("../server/statusline.ts");
    const file = join(home, ".claude", "settings.json");
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(file, JSON.stringify({ model: "opus", modelSettings: { "claude-opus-5-5": { effortLevel: "xhigh" } }, theme: "dark" }));
    const out = await keepDefaults(async () => {
      // What Claude Code writes when you pick Sonnet at high effort, plus a change of your own meanwhile.
      writeFileSync(file, JSON.stringify({ model: "sonnet", modelSettings: { "claude-opus-5-5": { effortLevel: "xhigh" }, "claude-sonnet-5-5": { effortLevel: "high" } }, effortLevel: "high", theme: "light" }));
      return "done";
    });
    expect(out).toBe("done");
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ model: "opus", modelSettings: { "claude-opus-5-5": { effortLevel: "xhigh" } }, theme: "light" });
  });

  it("keeps a dropped card where it was dropped, until the session is used again", async () => {
    const order = await import("../server/order.ts");
    expect(order.sortKey("a", 5_000)).toBe(5_000);
    await order.place("a", 3_000, 1_000);
    const dropped = order.sortKey("a", 5_000);
    expect(dropped).toBe(2_000);
    expect(order.sortKey("a", Date.now() + 1_000)).toBeGreaterThan(dropped); // used after the drop: by its use again
    await order.place("b", 3_000, null);
    expect(order.sortKey("b", 0)).toBe(3_000 - 60_000);
    await order.place("c", null, 9_000);
    expect(order.sortKey("c", 0)).toBeGreaterThanOrEqual(Date.now() - 1_000);
    expect(JSON.parse(readFileSync(join(home, ".claude-control-room", "order.json"), "utf8"))).toHaveProperty("a.key", 2_000);
  });

  it("finds your last message even when much tool output came after it", async () => {
    const { readTranscript } = await import("../server/transcript.ts");
    const file = join(home, "long.jsonl");
    const said = JSON.stringify({ type: "user", message: { content: "Fix the build" }, timestamp: "2026-11-04T10:00:00Z" });
    const noise = Array.from({ length: 150 }, (_, i) => JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "x".repeat(10_000) }] }, timestamp: `2026-11-04T10:0${Math.floor(i / 60)}:00Z` }));
    writeFileSync(file, [said, ...noise].join("\n") + "\n");
    expect((await readTranscript(file))?.lastPromptAt).toBe(Date.parse("2026-11-04T10:00:00Z"));
  });

  it("does not update a copy that was not built from a git checkout", async () => {
    const update = await import("../server/update.ts");
    expect(update.updateState().source).toBeNull();
    expect(update.startUpdate().ok).toBe(false);
    expect(update.updateState().phase).toBe("idle");
  });

  it("opens a session that runs here in its console", () => {
    const t = openTarget({ tmux: "cr-0a1b2c3d:@0.%0", ide: null, hosted: true }, "pycharm");
    expect(t).toEqual({ kind: "console" });
    expect(targetName(t)).toBe("console");
    expect(openTarget({ tmux: "dev:@0.%0", ide: null, hosted: false }, "pycharm")).toEqual({ kind: "tmux" });
  });
});

describe("console protocol", () => {
  it("undoes tmux's escaping, and leaves text alone", () => {
    const raw = Buffer.from("a\\033[1mb\\015\\012\\134c é", "utf8");
    expect(consoles.unescapeOutput(raw).toString("utf8")).toBe("a\x1b[1mb\r\n\\c é");
    expect(consoles.unescapeOutput(Buffer.from("end\\01", "utf8")).toString("utf8")).toBe("end\\01");
  });

  it("types keys as hex, so escape sequences and any text arrive unchanged", () => {
    expect(consoles.keyCommands("=cr-0a1b2c3d:", "é\x1b[A\r")).toEqual(["send-keys -t =cr-0a1b2c3d: -H c3 a9 1b 5b 41 0d"]);
    const long = consoles.keyCommands("=x:", "y".repeat(2500));
    expect(long).toHaveLength(3);
    expect(long.join(" ").match(/79/g)).toHaveLength(2500);
  });
});

const TMUX = ["/opt/homebrew/bin/tmux", "/usr/local/bin/tmux", "/usr/bin/tmux"].find((p) => existsSync(p));

describe.skipIf(!TMUX)("console on a real tmux", () => {
  const name = "cr-7e57c0de";
  const tmux = (...args: string[]) => execFileSync(TMUX!, ["-L", process.env.CONTROL_ROOM_TMUX_SOCKET!, "-f", "/dev/null", ...args], { encoding: "utf8" });
  afterAll(() => {
    try {
      tmux("kill-server");
    } catch {
      /* already gone */
    }
  });

  it("paints the screen, streams what the session writes, and carries keys and size", async () => {
    tmux("new-session", "-d", "-s", name, "-x", "80", "-y", "20", "sh", "-c", "printf 'ready\\n'; exec cat");
    await until(() => tmux("capture-pane", "-p", "-t", `=${name}:`).includes("ready"));
    expect([...((await hosted.hostedSessions()) ?? [])]).toEqual([name]);

    const events: import("../server/console.ts").ConsoleEvent[] = [];
    const off = consoles.watchConsole(name, 100, 24, (e) => events.push(e))!;
    await until(() => events.some((e) => e.type === "reset"));
    const reset = events.find((e) => e.type === "reset")!;
    expect(reset.type === "reset" && reset.data.toString("utf8")).toContain("ready");
    expect(tmux("display-message", "-p", "-t", `=${name}:`, "#{window_width}x#{window_height}").trim()).toBe("100x24");

    expect(consoles.typeInConsole(name, "héllo\r")).toBe(true);
    const seen = () => Buffer.concat(events.flatMap((e) => (e.type === "data" ? [e.data] : []))).toString("utf8");
    await until(() => (seen().match(/héllo/g) ?? []).length >= 2); // the terminal's echo, then cat's copy

    // A second window sets the size for both; the first one hears about it and follows.
    const second: import("../server/console.ts").ConsoleEvent[] = [];
    const offSecond = consoles.watchConsole(name, 90, 30, (e) => second.push(e))!;
    await until(() => second.some((e) => e.type === "reset"));
    const reset2 = second.find((e) => e.type === "reset")!;
    expect(reset2.type === "reset" && [reset2.cols, reset2.rows]).toEqual([90, 30]);
    expect(events).toContainEqual({ type: "size", cols: 90, rows: 30 });
    await until(() => tmux("display-message", "-p", "-t", `=${name}:`, "#{window_width}x#{window_height}").trim() === "90x30");
    offSecond();

    // A window that closes before its screen arrives never joins, so nothing is sent to it later.
    const early: string[] = [];
    consoles.watchConsole(name, 90, 30, (e) => early.push(e.type))!();
    consoles.typeInConsole(name, "x\r");
    await until(() => (seen().match(/x/g) ?? []).length >= 2);
    expect(early).toEqual([]);

    tmux("kill-session", "-t", `=${name}`);
    await until(() => events.some((e) => e.type === "exit"));
    off();
  });

  it("ends a console at once when its session does not exist", async () => {
    const events: string[] = [];
    consoles.watchConsole("cr-00000000", 80, 24, (e) => events.push(e.type));
    await until(() => events.includes("exit"));
    expect(events).not.toContain("reset");
  });
});

async function until(check: () => boolean, ms = 5_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
}
