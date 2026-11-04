import { useSyncExternalStore } from "react";
import { hostedName } from "../../shared/hosted.ts";
import { openTarget, targetName } from "../../shared/ides.ts";
import type { ActionResult, Session, Snapshot, StatusKind } from "../../shared/types.ts";

export type Filter = "all" | "attention" | "working" | "idle" | "inactive";
export type Panel = "settings" | "worktrees" | "new" | null;

export interface Toast {
  id: number;
  tone: "ok" | "error" | "info";
  text: string;
}

export interface State {
  snapshot: Snapshot | null;
  connected: boolean;
  selected: number | null; // pid with keyboard focus
  drawer: number | null; // pid shown in the detail drawer
  closing: number | null; // pid in the close dialog
  panel: Panel;
  filter: Filter;
  overviewCollapsed: boolean;
  toasts: Toast[];
  busy: Record<string, boolean>; // "pid:action" while a request runs
  typeInto: number | null; // pid whose console takes the keyboard when it shows
  consoleView: ConsoleView;
}

/** How a session's console shows: in its details, folded to its bar, or filling the window. */
export type ConsoleView = "normal" | "min" | "max";

const params = new URLSearchParams(location.search);
export const VIEW = {
  wallOnly: params.get("view") === "wall",
  menubar: params.get("view") === "menubar",
  sessionPid: params.get("session") ? Number(params.get("session")) : null,
};

export function stored<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

export function remember(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private window or blocked storage */
  }
}

let state: State = {
  snapshot: null,
  connected: false,
  selected: null,
  drawer: null,
  closing: null,
  panel: null,
  filter: stored<Filter>("cr.filter", "all"),
  overviewCollapsed: VIEW.wallOnly || stored("cr.overviewCollapsed", false),
  toasts: [],
  busy: {},
  typeInto: null,
  consoleView: "normal",
};
const listeners = new Set<() => void>();

export function getState(): State {
  return state;
}

export function setState(patch: Partial<State> | ((s: State) => Partial<State>)): void {
  const next = typeof patch === "function" ? patch(state) : patch;
  state = { ...state, ...next };
  listeners.forEach((l) => l());
}

export function useStore<T>(select: (s: State) => T): T {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => select(state),
  );
}

/** Where "Open in …" takes this session, by name: "PyCharm", "VS Code" or "Terminal". The server decides the same way. */
export function useOpenName(s: Session): string {
  return useStore((st) => targetName(openTarget(s, st.snapshot?.settings.ide ?? "vscode")));
}

/** Opens the session where you can type into it: one that runs here in its console, any other in its own terminal. */
export function openSession(s: Session): void {
  if (s.hosted) setState({ drawer: s.pid, selected: s.pid, typeInto: s.pid });
  else void act(`${s.pid}:focus`, `/api/sessions/${s.pid}/focus`, {}, true);
}

/** The tmux session behind a session that runs here, from Claude Code's "name:@window.%pane". */
export function consoleName(s: Session): string | null {
  return s.hosted ? hostedName(s.tmux) : null;
}

let toastId = 0;
export function toast(text: string, tone: Toast["tone"] = "info"): void {
  const id = ++toastId;
  setState((s) => ({ toasts: [...s.toasts.slice(-3), { id, tone, text }] }));
  setTimeout(() => setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), tone === "error" ? 7000 : 4200);
}

export async function api<T = ActionResult>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json", "X-Control-Room": "1" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return (await res.json()) as T;
}

/** Runs an action, marks it busy meanwhile, and reports the result as a toast. */
export async function act(key: string, path: string, body: unknown = {}, quiet = false): Promise<ActionResult> {
  setState((s) => ({ busy: { ...s.busy, [key]: true } }));
  try {
    const out = await api<ActionResult>(path, body);
    if (!quiet || !out.ok) toast(out.message, out.ok ? "ok" : "error");
    return out;
  } catch (err) {
    const out = { ok: false, message: `Request failed: ${(err as Error).message}` };
    toast(out.message, "error");
    return out;
  } finally {
    setState((s) => {
      const busy = { ...s.busy };
      delete busy[key];
      return { busy };
    });
  }
}

export function connect(onSnapshot: (prev: Snapshot | null, next: Snapshot) => void): () => void {
  const es = new EventSource("/api/stream");
  es.addEventListener("snapshot", (ev) => {
    const next = JSON.parse((ev as MessageEvent).data) as Snapshot;
    const prev = state.snapshot;
    setState({ snapshot: next, connected: true });
    onSnapshot(prev, next);
  });
  es.onerror = () => setState({ connected: false });
  return () => es.close();
}

export const ATTENTION: StatusKind[] = ["approval", "question", "waiting"];

export function needsYou(s: Session): boolean {
  return ATTENTION.includes(s.activity.kind) || (s.activity.kind === "idle" && s.activity.askedYou);
}

export function matchesFilter(s: Session, f: Filter): boolean {
  switch (f) {
    case "all":
      return true;
    case "attention":
      return needsYou(s);
    case "working":
      return s.activity.kind === "working" || s.activity.kind === "background";
    case "idle":
      return s.activity.kind === "idle";
    case "inactive":
      return s.activity.kind === "inactive";
  }
}
