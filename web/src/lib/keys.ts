// Every shortcut, written once: the keyboard handler, the tips and the Keyboard shortcuts panel all read it. The ⌘ ones
// follow PyCharm and the Mac, and work while a console has the keyboard; the single keys work everywhere else.

export const KEYS = {
  newSession: { keys: ["⌘N", "N"], label: "New session" },
  newTerminal: { keys: ["⌘T", "T"], label: "New terminal" },
  settings: { keys: ["⌘,"], label: "Settings" },
  help: { keys: ["⌘/", "?"], label: "Keyboard shortcuts" },
  layout: { keys: ["F"], label: "Switch between Focus and Fit" },
  next: { keys: ["⌘⇧]", "⌃⇥", "→"], label: "Next session" },
  prev: { keys: ["⌘⇧[", "⌃⇧⇥", "←"], label: "Previous session" },
  below: { keys: ["↓"], label: "The session below" },
  above: { keys: ["↑"], label: "The session above" },
  ends: { keys: ["Home", "End"], label: "The first or last session" },
  pick: { keys: ["⌘1–9", "1–9"], label: "Go to session 1 to 9" },
  open: { keys: ["↵"], label: "Open it: type in its console, or go to its terminal" },
  leave: { keys: ["⇧Esc"], label: "Leave the console, so these keys work again" },
  details: { keys: ["Space"], label: "Show or hide its details" },
  rename: { keys: ["⇧F6", "F2"], label: "Rename it" },
  approve: { keys: ["A"], label: "Approve what it asks" },
  reject: { keys: ["R"], label: "Reject what it asks" },
  pr: { keys: ["P"], label: "Open its PR" },
  close: { keys: ["X"], label: "Close it…" },
  back: { keys: ["Esc"], label: "Close a panel, the details or a full console" },
} as const satisfies Record<string, { keys: readonly string[]; label: string }>;

export type KeyId = keyof typeof KEYS;

export const KEY_GROUPS: { title: string; ids: KeyId[] }[] = [
  { title: "Start", ids: ["newSession", "newTerminal", "settings", "help", "layout"] },
  { title: "Move between sessions", ids: ["next", "prev", "below", "above", "ends", "pick"] },
  { title: "The selected session", ids: ["open", "leave", "details", "rename", "approve", "reject", "pr", "close", "back"] },
];

/** A tip with its shortcut after it, the way a Mac menu shows one: "New session (⌘N)". */
export function withKey(label: string, id: KeyId): string {
  return `${label} (${KEYS[id].keys[0]})`;
}

export type Command = { id: "newSession" | "newTerminal" | "settings" | "help" | "next" | "prev" | "rename" | "leave" } | { id: "pick"; n: number };

/**
 * The shortcut a key press is, of those that work everywhere: in a console, too, where every other key goes to the
 * session. None of them means anything to a shell or to Claude Code.
 */
export function commandOf(e: KeyboardEvent): Command | null {
  if (e.altKey) return null;
  if (e.ctrlKey && !e.metaKey && e.key === "Tab") return { id: e.shiftKey ? "prev" : "next" };
  if (e.ctrlKey) return null;
  if (!e.metaKey) {
    if (e.shiftKey && e.key === "F6") return { id: "rename" };
    if (e.shiftKey && e.key === "Escape") return { id: "leave" };
    return null;
  }
  if (e.shiftKey) return e.code === "BracketRight" ? { id: "next" } : e.code === "BracketLeft" ? { id: "prev" } : null;
  if (/^[1-9]$/.test(e.key)) return { id: "pick", n: Number(e.key) };
  const key = e.key.toLowerCase();
  return key === "n" ? { id: "newSession" } : key === "t" ? { id: "newTerminal" } : key === "," ? { id: "settings" } : key === "/" ? { id: "help" } : null;
}
