import { FolderOpen, Plus, TerminalSquare } from "lucide-react";
import { motion } from "motion/react";
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import type { ActionResult, Snapshot } from "../../../shared/types.ts";
import { folderName } from "../lib/format.ts";
import { native } from "../lib/native.ts";
import { api, consoleName, remember, setState, stored, toast } from "../store.ts";

const Console = lazy(() => import("./Console.tsx"));

/** Folders worth offering: the last ones you started in, then the folders your sessions work in, newest first. */
function folderChoices(snap: Snapshot): string[] {
  const recent = stored<string[]>("cr.recentFolders", []);
  const fromSessions = [...snap.sessions].sort((a, b) => b.lastActivityAt - a.lastActivityAt).map((s) => s.git?.root ?? s.cwd);
  return [...new Set([...recent, ...fromSessions])].slice(0, 20);
}

export function NewSessionDialog({ snap }: { snap: Snapshot }) {
  const choices = useMemo(() => folderChoices(snap), []);
  const [cwd, setCwd] = useState(choices[0] ?? "");
  const [typed, setTyped] = useState(choices.length === 0 && !native);
  const [prompt, setPrompt] = useState("");
  const [starting, setStarting] = useState(false);
  const [waiting, setWaiting] = useState<string | null>(null); // a console that must be answered before the session shows
  const open = useRef(true);
  useEffect(() => () => void (open.current = false), []);
  const close = () => setState({ panel: null });
  // A session that still waits for its first answer shows nowhere else, so leaving the dialog stops it.
  const cancel = () => {
    if (waiting) void api(`/api/console/${waiting}/stop`, {});
    close();
  };

  // Esc in the console goes to Claude Code; anywhere else it closes the dialog.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !waiting) close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [waiting]);

  // Once Claude Code has started for real, the session shows in the list: open it there.
  useEffect(() => {
    const s = waiting ? snap.sessions.find((x) => consoleName(x) === waiting) : null;
    if (s) setState({ panel: null, drawer: s.pid, selected: s.pid, typeInto: s.pid });
  }, [waiting, snap]);

  const pick = async () => {
    const path = await native?.pickFolder();
    if (path) setCwd(path);
  };

  const start = async () => {
    if (!cwd.trim() || starting) return;
    setStarting(true);
    const r = await api<ActionResult & { pid?: number; name?: string }>("/api/sessions/new", { cwd: cwd.trim(), prompt }).catch(
      (err: Error) => ({ ok: false, message: err.message }) as ActionResult & { pid?: number; name?: string },
    );
    // Closed while it started: the session runs, and shows in the list, but nothing jumps at you.
    if (!open.current) return void (r.ok && toast(r.pid ? "Started" : r.message, "ok"));
    setStarting(false);
    if (!r.ok) return toast(r.message, "error");
    remember("cr.recentFolders", [cwd.trim(), ...stored<string[]>("cr.recentFolders", []).filter((f) => f !== cwd.trim())].slice(0, 8));
    if (r.pid) setState({ panel: null, drawer: r.pid, selected: r.pid, typeInto: r.pid });
    else if (r.name) setWaiting(r.name);
  };

  return (
    <div className="scrim" onClick={waiting ? undefined : close}>
      <motion.div
        className={`dialog new-session ${waiting ? "is-waiting" : ""}`}
        role="dialog"
        aria-modal
        aria-labelledby="new-title"
        initial={{ opacity: 0, y: 10, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ type: "spring", stiffness: 500, damping: 36 }}
        onClick={(e) => e.stopPropagation()}
      >
        {waiting ? (
          <>
            <h2 id="new-title">Claude Code asks something first</h2>
            <p className="dialog-sub">Answer it here. The session opens as soon as it starts.</p>
            <div className="new-console">
              <Suspense fallback={null}>
                <Console name={waiting} autoFocus />
              </Suspense>
            </div>
            <div className="dialog-buttons">
              <button type="button" className="btn btn-ghost" onClick={cancel}>
                Cancel and stop it
              </button>
            </div>
          </>
        ) : (
          <>
            <h2 id="new-title">New session</h2>
            <p className="dialog-sub">Claude Code starts in Control Room. You type to it in its console here, no terminal needed.</p>

            <label className="field">
              <span className="field-label">Folder</span>
              <div className="field-row">
                {typed ? (
                  <input className="input mono" placeholder="/Users/you/code/project" value={cwd} autoFocus onChange={(e) => setCwd(e.target.value)} />
                ) : (
                  <select className="select field-grow" value={cwd} onChange={(e) => setCwd(e.target.value)}>
                    {!choices.includes(cwd) && cwd && <option value={cwd}>{folderName(cwd)} · {cwd}</option>}
                    {choices.map((f) => (
                      <option key={f} value={f}>
                        {folderName(f)} · {f}
                      </option>
                    ))}
                  </select>
                )}
                {native ? (
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => void pick()}>
                    <FolderOpen size={14} /> Choose…
                  </button>
                ) : (
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => setTyped((v) => !v)}>
                    {typed ? "Pick from list" : "Type a path"}
                  </button>
                )}
              </div>
            </label>

            <label className="field">
              <span className="field-label">
                First message <span className="muted">optional</span>
              </span>
              <textarea
                className="input textarea"
                rows={4}
                placeholder="What should Claude work on? You can also type it in the console."
                value={prompt}
                autoFocus={!typed}
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void start();
                }}
              />
            </label>

            {!snap.setup.tmuxReady && (
              <p className="field-warn">
                <TerminalSquare size={14} /> Control Room runs sessions in tmux. Install it first: <span className="mono">brew install tmux</span>
              </p>
            )}

            <div className="dialog-buttons">
              <button type="button" className="btn btn-ghost" onClick={close}>
                Cancel
              </button>
              <button type="button" className="btn btn-primary" disabled={!cwd.trim() || starting || !snap.setup.tmuxReady} onClick={() => void start()}>
                <Plus size={15} /> {starting ? "Starting…" : "Start session"}
              </button>
            </div>
          </>
        )}
      </motion.div>
    </div>
  );
}
