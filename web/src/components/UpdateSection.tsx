// Updating Control Room from inside it: what this build is, what is new in its git checkout, and one button that
// pulls, builds and restarts.
import { ArrowUpCircle, RefreshCw } from "lucide-react";
import type { Snapshot, UpdateState } from "../../../shared/types.ts";
import { ago } from "../lib/format.ts";
import { act, setState, useStore } from "../store.ts";
import { Spinner, useNow } from "./Primitives.tsx";

const STEPS: Partial<Record<UpdateState["phase"], string>> = {
  pulling: "Getting the new commits…",
  installing: "Installing packages…",
  building: "Building the app. This takes about 3 minutes…",
  restarting: "Restarting with the new build…",
};

export const updating = (u: UpdateState) => !!STEPS[u.phase];
export const hasUpdate = (u: UpdateState) => !!u.source && (u.behind > 0 || u.unbuilt > 0);

function home(path: string): string {
  return path.replace(/^\/Users\/[^/]+/, "~");
}

export function UpdateSection({ u }: { u: UpdateState }) {
  const now = useNow();
  const checking = useStore((s) => !!s.busy["update:check"]);
  if (!u.source) {
    return (
      <div className="set-line">
        <div className="set-text">
          <b>Updates</b>
          <span>This copy was not built from a git checkout, so it can't update itself. Build it with npm run package.</span>
        </div>
      </div>
    );
  }
  const run = () => void act("update:run", "/api/update/run");
  const what =
    u.behind > 0
      ? `${u.behind} new commit${u.behind === 1 ? "" : "s"} on ${u.upstream}`
      : u.unbuilt > 0
        ? `${u.unbuilt} commit${u.unbuilt === 1 ? "" : "s"} in the folder that this build does not have`
        : "Up to date";
  return (
    <div className="set-line set-line-stack update">
      <div className="set-text">
        <b>{what}</b>
        <span>
          This build: <span className="mono">{u.built ?? "?"}</span> from <span className="mono">{home(u.source)}</span>
          {u.branch && (
            <>
              {" "}
              on <span className="mono">{u.branch}</span>
            </>
          )}
          {u.checkedAt && ` · checked ${ago(u.checkedAt, now)}`}
        </span>
      </div>
      {(u.behind > 0 || u.unbuilt > 0) && u.incoming.length > 0 && (
        <ul className="update-list">
          {u.incoming.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ul>
      )}
      {u.dirty && !updating(u) && <p className="update-note">The folder has uncommitted changes. They go into the build too.</p>}
      {!u.upstream && u.branch && !updating(u) && <p className="update-note">The branch {u.branch} follows no remote branch, so there is nothing to pull. Update rebuilds what is in the folder.</p>}
      {updating(u) ? (
        <p className="update-progress">
          <Spinner /> {STEPS[u.phase]}
        </p>
      ) : (
        <>
          {u.phase === "failed" && <p className="update-error">{u.message}</p>}
          {u.phase === "idle" && u.message && <p className="update-note">{u.message}</p>}
          <div className="update-buttons">
            <button type="button" className={`btn btn-sm ${hasUpdate(u) ? "btn-primary" : "btn-ghost"}`} onClick={run}>
              <ArrowUpCircle size={14} /> {hasUpdate(u) ? "Update" : "Rebuild"}
              {u.restarts && " and restart"}
            </button>
            <button type="button" className="btn btn-ghost btn-sm" disabled={checking} onClick={() => void act("update:check", "/api/update/check", {}, true)}>
              <RefreshCw size={14} className={checking ? "spin-fast" : ""} /> Check now
            </button>
          </div>
          <p className="update-note">
            {u.restarts ? "Control Room restarts at the end. Sessions started here keep running." : "When it is built, start Control Room again to use it."}
          </p>
        </>
      )}
    </div>
  );
}

/** In the top bar while there is something new, or while it updates. */
export function UpdatePill({ snap }: { snap: Snapshot }) {
  const u = snap.update;
  if (!u) return null; // a server from before updates existed
  if (!updating(u) && !hasUpdate(u) && u.phase !== "failed") return null;
  const label = updating(u) ? "Updating…" : u.phase === "failed" ? "Update failed" : "Update";
  const tip = updating(u) ? STEPS[u.phase] : u.phase === "failed" ? "Open Settings to see why" : `${u.behind || u.unbuilt} new commit${(u.behind || u.unbuilt) === 1 ? "" : "s"}: open Settings to update`;
  return (
    <button type="button" className={`pill update-pill ${u.phase === "failed" ? "is-failed" : ""}`} data-tip={tip} data-tip-side="bottom" onClick={() => setState({ panel: "settings" })}>
      {updating(u) ? <Spinner /> : <ArrowUpCircle size={14} />} {label}
    </button>
  );
}
