// Names of the tmux sessions Control Room starts. The server and the page both read them from Claude Code's
// "session:@window.%pane", so they parse it in one place.

// cr- runs Claude Code; crt- is a terminal: a shell started here.
const NAME = /^crt?-[0-9a-f]{8}$/;

export function isHostedName(name: unknown): name is string {
  return typeof name === "string" && NAME.test(name);
}

export function isTerminalName(name: string): boolean {
  return name.startsWith("crt-");
}

/** The tmux session name in Claude Code's "session:@window.%pane", when it is one Control Room started. */
export function hostedName(tmux: string | null): string | null {
  const name = tmux?.split(":")[0] ?? null;
  return isHostedName(name) ? name : null;
}
