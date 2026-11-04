// The order of the session list. The one you used last comes first; a card you drag stays where you dropped it until
// you use that session again. Both are kept in ~/.claude-control-room/order.json, so the order survives a restart.
import { readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { APP_DIR } from "./paths.ts";

const FILE = join(APP_DIR, "order.json");
const KEEP = 200; // sessions kept in each list, newest last
const WRITE_MS = 1_000; // typing marks use many times a second; the file is written once they settle

interface Placement {
  key: number; // where it sits: the list runs from the biggest key down
  at: number; // when you dropped it there
}

interface Stored {
  placed: Map<string, Placement>;
  used: Map<string, number>; // when you last did something to it from Control Room
}

let stored: Stored | null = null;

/** Read on first use, so a process that only needs keyBetween (the demo) reads nothing from this Mac. */
function load(): Stored {
  if (stored) return stored;
  stored = { placed: new Map(), used: new Map() };
  try {
    const raw = JSON.parse(readFileSync(FILE, "utf8")) as { placed?: Record<string, Placement>; used?: Record<string, number> };
    // The first version kept only placements, at the top level.
    const placed = raw.placed ?? (raw.used ? {} : (raw as Record<string, Placement>));
    for (const [id, p] of Object.entries(placed)) if (Number.isFinite(p?.key) && Number.isFinite(p?.at)) stored.placed.set(id, p);
    for (const [id, at] of Object.entries(raw.used ?? {})) if (Number.isFinite(at)) stored.used.set(id, at);
  } catch {
    /* none yet */
  }
  return stored;
}

/** The key for a card dropped right under the one with key `above` and right over the one with key `below`. */
export function keyBetween(above: number | null, below: number | null, now: number): number {
  if (above !== null && below !== null) return (above + below) / 2;
  if (above !== null) return above - 60_000;
  // Dropped first: it counts as used now.
  return below !== null ? Math.max(now, below + 1) : now;
}

/** When you last did something to the session from Control Room, or 0. */
export function usedAt(sessionId: string): number {
  return load().used.get(sessionId) ?? 0;
}

/** Where a session sits in the list: where you dropped it, unless you used it after that. */
export function sortKey(sessionId: string, lastUsedAt: number): number {
  const p = load().placed.get(sessionId);
  return p && p.at >= lastUsedAt ? p.key : lastUsedAt;
}

export function noteUsed(sessionId: string): void {
  setNewest(load().used, sessionId, Date.now());
  save(WRITE_MS);
}

export function place(sessionId: string, above: number | null, below: number | null): Promise<void> {
  const now = Date.now();
  setNewest(load().placed, sessionId, { key: keyBetween(above, below, now), at: now });
  return save(0);
}

function setNewest<T>(map: Map<string, T>, id: string, value: T): void {
  map.delete(id);
  map.set(id, value);
  for (const old of map.keys()) {
    if (map.size <= KEEP) break;
    map.delete(old);
  }
}

let timer: NodeJS.Timeout | null = null;
let dueAt = 0;
let waiting: (() => void)[] = [];
let writing: Promise<void> = Promise.resolve();

/** Writes the file within `delayMs`; a write already due sooner stays. Every caller hears when it is on disk. */
function save(delayMs: number): Promise<void> {
  const written = new Promise<void>((done) => waiting.push(done));
  if (!timer || Date.now() + delayMs < dueAt) {
    if (timer) clearTimeout(timer);
    dueAt = Date.now() + delayMs;
    timer = setTimeout(flush, delayMs);
  }
  return written;
}

function flush(): void {
  timer = null;
  const done = waiting;
  waiting = [];
  const s = load();
  const text = JSON.stringify({ placed: Object.fromEntries(s.placed), used: Object.fromEntries(s.used) }, null, 2) + "\n";
  const write = async () => {
    await mkdir(dirname(FILE), { recursive: true });
    await writeFile(`${FILE}.tmp`, text);
    await rename(`${FILE}.tmp`, FILE);
  };
  writing = writing.then(write, write);
  void writing.then(
    () => done.forEach((d) => d()),
    () => done.forEach((d) => d()),
  );
}
