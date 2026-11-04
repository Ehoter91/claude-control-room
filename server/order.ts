// The order of the session list. The one you used last comes first; a card you drag stays where you dropped it until
// you use that session again. Kept in ~/.claude-control-room/order.json, so it survives a restart.
import { readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { APP_DIR } from "./paths.ts";

const FILE = join(APP_DIR, "order.json");
const KEEP = 200; // placements kept, newest last

interface Placement {
  key: number; // where it sits: the list runs from the biggest key down
  at: number; // when you dropped it there
}

function load(): Map<string, Placement> {
  try {
    const raw = JSON.parse(readFileSync(FILE, "utf8")) as Record<string, Placement>;
    return new Map(Object.entries(raw).filter(([, p]) => Number.isFinite(p?.key) && Number.isFinite(p?.at)));
  } catch {
    return new Map();
  }
}

const placed = load();
let writing: Promise<void> = Promise.resolve();

/** Where a session sits in the list: where you dropped it, unless you used it after that. */
export function sortKey(sessionId: string, lastUsedAt: number): number {
  const p = placed.get(sessionId);
  return p && p.at >= lastUsedAt ? p.key : lastUsedAt;
}

/**
 * Puts a session between two others, as it was dropped: right under `above` and right over `below`, given their keys.
 * Dropped first in the list, it counts as used now.
 */
export function place(sessionId: string, above: number | null, below: number | null): Promise<void> {
  const now = Date.now();
  const key = above !== null && below !== null ? (above + below) / 2 : above !== null ? above - 60_000 : below !== null ? Math.max(now, below + 1) : now;
  placed.delete(sessionId);
  placed.set(sessionId, { key, at: now });
  for (const old of placed.keys()) {
    if (placed.size <= KEEP) break;
    placed.delete(old);
  }
  const snapshot = JSON.stringify(Object.fromEntries(placed), null, 2) + "\n";
  const write = async () => {
    await mkdir(dirname(FILE), { recursive: true });
    await writeFile(`${FILE}.tmp`, snapshot);
    await rename(`${FILE}.tmp`, FILE);
  };
  writing = writing.then(write, write);
  return writing;
}
