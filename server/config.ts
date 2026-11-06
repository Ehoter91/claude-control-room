import { statSync } from "node:fs";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, normalize } from "node:path";
import { isIdeId } from "../shared/ides.ts";
import type { Settings } from "../shared/types.ts";
import { chosenIde } from "./ide.ts";
import { CONFIG_FILE, HOME } from "./paths.ts";

export const DEFAULT_SETTINGS: Settings = {
  notifications: true,
  sounds: true,
  aiSummaries: true,
  inactiveAfterMinutes: 120,
  includeIdePanel: false,
  ide: "vscode",
  terminalFolder: HOME,
  layout: "fit",
  shortcutTokens: [],
};

let current: Settings = { ...DEFAULT_SETTINGS };

/** Saved settings over the defaults. An IDE this build does not know (from a newer build, or typed by hand) falls back. */
export function cleanSettings(raw: Partial<Settings>): Settings {
  const s = { ...DEFAULT_SETTINGS, ...raw };
  if (!isIdeId(s.ide)) s.ide = DEFAULT_SETTINGS.ide;
  return s;
}

export async function loadSettings(): Promise<Settings> {
  try {
    const raw = JSON.parse(await readFile(CONFIG_FILE, "utf8")) as Partial<Settings>;
    current = cleanSettings(raw);
  } catch {
    current = { ...DEFAULT_SETTINGS };
  }
  const envToken = process.env.SHORTCUT_API_TOKEN;
  if (envToken && !current.shortcutTokens.includes(envToken)) {
    current.shortcutTokens = [...current.shortcutTokens, envToken];
  }
  return current;
}

/** A folder typed in Settings, ~ for home, if it is a folder on this Mac. */
export function folderSetting(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const path = raw.trim().replace(/^~(?=$|\/)/, HOME);
  if (!isAbsolute(path)) return null;
  try {
    return statSync(path).isDirectory() ? normalize(path).replace(/(.)\/$/, "$1") : null;
  } catch {
    return null;
  }
}

export function settings(): Settings {
  return current;
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  current = { ...current, ...patch };
  await mkdir(dirname(CONFIG_FILE), { recursive: true });
  const tmp = `${CONFIG_FILE}.tmp`;
  await writeFile(tmp, JSON.stringify(current, null, 2) + "\n", { mode: 0o600 });
  await rename(tmp, CONFIG_FILE);
  await chmod(CONFIG_FILE, 0o600);
  return current;
}

/** The UI never receives a token, only its last four characters. It gets the IDE "Open in" uses. */
export function publicSettings(): Settings {
  return { ...current, ide: chosenIde(current.ide), shortcutTokens: current.shortcutTokens.map((t) => `••••${t.slice(-4)}`) };
}
