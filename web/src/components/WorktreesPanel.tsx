import { FolderGit2, RefreshCw, X } from "lucide-react";
import { motion } from "motion/react";
import { useEffect, useMemo, useState } from "react";
import type { WorktreeReport, WorktreeVerdict } from "../../../shared/types.ts";
import { ago, folderName, plural } from "../lib/format.ts";
import { act, api, setState, useStore } from "../store.ts";
import { VerdictPill } from "./CloseDialog.tsx";
import { Spinner, useNow } from "./Primitives.tsx";

interface Job {
  repo: string;
  running: boolean;
  done: number;
  total: number;
  reports: WorktreeReport[];
  finishedAt: number | null;
}

const ORDER: WorktreeVerdict[] = ["safe", "probably-safe", "gone", "keep", "in-use", "main"];
const LABEL: Record<WorktreeVerdict, string> = {
  safe: "Safe",
  "probably-safe": "Probably safe",
  gone: "Gone",
  keep: "Keep",
  "in-use": "In use",
  main: "Main",
};

export function WorktreesPanel() {
  const snap = useStore((s) => s.snapshot);
  const busy = useStore((s) => s.busy);
  const now = useNow();
  const repos = useMemo(() => [...new Set((snap?.sessions ?? []).map((s) => s.git?.mainRoot).filter(Boolean) as string[])], [snap?.sessions]);
  const [repo, setRepo] = useState<string | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [view, setView] = useState<WorktreeVerdict>("safe");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const active = repo ?? repos[0] ?? null;

  useEffect(() => {
    if (!active) return;
    let alive = true;
    const poll = async () => {
      const j = await api<Job | null>(`/api/worktrees?repo=${encodeURIComponent(active)}`);
      if (!alive) return;
      setJob(j);
      if (!j) await api("/api/worktrees/scan", { repo: active });
    };
    void poll();
    const t = setInterval(() => void poll(), 1200);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [active]);

  const reports = job?.reports ?? [];
  const groups = Object.fromEntries(ORDER.map((v) => [v, reports.filter((r) => r.verdict === v)])) as Record<WorktreeVerdict, WorktreeReport[]>;
  const list = groups[view] ?? [];
  const selectable = view === "safe" || view === "probably-safe";
  const close = () => setState({ panel: null });

  const remove = async () => {
    const paths = [...picked];
    const out = await act("wt-remove", "/api/worktrees/remove", { repo: active, paths });
    if (out.ok || out.message) setPicked(new Set());
  };

  return (
    <div className="scrim" onClick={close}>
      <motion.div
        className="sheet"
        role="dialog"
        aria-modal
        initial={{ opacity: 0, y: 14 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ type: "spring", stiffness: 420, damping: 36 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sheet-head">
          <FolderGit2 size={20} />
          <div>
            <h2>Worktree cleanup</h2>
            <p className="dialog-sub">Each folder is checked for unsaved work, unpushed commits, open PRs and live sessions.</p>
          </div>
          {repos.length > 1 && (
            <select className="select" value={active ?? ""} onChange={(e) => setRepo(e.target.value)}>
              {repos.map((r) => (
                <option key={r} value={r}>
                  {folderName(r)}
                </option>
              ))}
            </select>
          )}
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            disabled={job?.running}
            onClick={() => active && void api("/api/worktrees/scan", { repo: active }).then(() => setPicked(new Set()))}
          >
            <RefreshCw size={13} /> Rescan
          </button>
          <button type="button" className="icon-btn" aria-label="Close" onClick={close}>
            <X size={16} />
          </button>
        </div>

        {!job || (job.running && job.reports.length === 0) ? (
          <div className="scan-progress">
            <Spinner />
            <span>
              Checking {job?.total ? `${job.done} of ${job.total}` : "the"} worktrees of {active ? folderName(active) : "your repos"}…
            </span>
            {job?.total ? <span className="progress-bar"><span style={{ width: `${(job.done / job.total) * 100}%` }} /></span> : null}
          </div>
        ) : (
          <>
            <div className="seg sheet-tabs">
              {ORDER.filter((v) => v !== "main").map((v) => (
                <button
                  key={v}
                  type="button"
                  className={`seg-btn ${view === v ? "is-on" : ""}`}
                  onClick={() => {
                    setView(v);
                    setPicked(new Set());
                  }}
                >
                  {LABEL[v]} <span className="seg-count">{groups[v].length}</span>
                </button>
              ))}
              <span className="sheet-meta">
                {plural(reports.length, "worktree")} · checked {job.finishedAt ? ago(job.finishedAt, now) : "now"}
              </span>
            </div>

            <div className="wt-list">
              {selectable && list.length > 0 && (
                <label className="wt-row wt-row-head">
                  <input
                    type="checkbox"
                    checked={picked.size === list.length}
                    onChange={(e) => setPicked(e.target.checked ? new Set(list.map((r) => r.path)) : new Set())}
                  />
                  <span>Select all {list.length}</span>
                </label>
              )}
              {list.map((r) => (
                <label key={r.path} className={`wt-row ${picked.has(r.path) ? "is-picked" : ""}`}>
                  {selectable ? (
                    <input
                      type="checkbox"
                      checked={picked.has(r.path)}
                      onChange={(e) => {
                        const next = new Set(picked);
                        if (e.target.checked) next.add(r.path);
                        else next.delete(r.path);
                        setPicked(next);
                      }}
                    />
                  ) : (
                    <span className="wt-gap" />
                  )}
                  <span className="wt-main">
                    <span className="wt-name mono">{folderName(r.path)}</span>
                    <span className="wt-branch mono">{r.branch ?? "detached"}</span>
                  </span>
                  <span className="wt-reason">
                    <VerdictPill verdict={r.verdict} /> {r.reason}
                  </span>
                  <span className="wt-meta">
                    {r.pr && (
                      <span className={`pr-state pr-${r.pr.state.toLowerCase()}`}>
                        #{r.pr.number} {r.pr.state.toLowerCase()}
                      </span>
                    )}
                    {r.lastCommitAt && <span className="muted">{ago(Date.parse(r.lastCommitAt), now)}</span>}
                  </span>
                </label>
              ))}
              {list.length === 0 && <p className="muted wt-empty">Nothing in this group.</p>}
            </div>

            <div className="sheet-foot">
              {view === "gone" ? (
                <button type="button" className="btn btn-primary" disabled={!list.length || busy["wt-prune"]} onClick={() => void act("wt-prune", "/api/worktrees/prune", { repo: active })}>
                  Prune {plural(list.length, "entry", "entries")}
                </button>
              ) : selectable ? (
                <>
                  <span className="muted">Branches stay on GitHub and locally. Only the folders go.</span>
                  <button type="button" className="btn btn-danger" disabled={!picked.size || busy["wt-remove"]} onClick={() => void remove()}>
                    {busy["wt-remove"] ? <Spinner /> : null} Delete {plural(picked.size, "worktree")}
                  </button>
                </>
              ) : (
                <span className="muted">These folders hold work or a live session, so they are not offered for deletion.</span>
              )}
            </div>
          </>
        )}
      </motion.div>
    </div>
  );
}
