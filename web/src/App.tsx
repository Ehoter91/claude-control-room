import { AnimatePresence, motion } from "motion/react";
import { type PointerEvent as ReactPointerEvent, useEffect } from "react";
import type { Session } from "../../shared/types.ts";
import { CloseDialog } from "./components/CloseDialog.tsx";
import { SessionMenu } from "./components/SessionMenu.tsx";
import { NewSessionDialog } from "./components/NewSessionDialog.tsx";
import { Overview } from "./components/Overview.tsx";
import { SessionDetail } from "./components/SessionDetail.tsx";
import { SettingsPanel } from "./components/SettingsPanel.tsx";
import { Toasts } from "./components/Toasts.tsx";
import { SetupBanner, TopBar } from "./components/TopBar.tsx";
import { Wall, WallToolbar } from "./components/Wall.tsx";
import { WorktreesPanel } from "./components/WorktreesPanel.tsx";
import { clampWidth, dragFrom, type DrawerKind, keepSizes, setDrawerWidth } from "./lib/resize.ts";
import { act, getState, matchesFilter, openSession, openTerminal, setState, useStore, VIEW } from "./store.ts";
import { openUrl } from "./components/Monitor.tsx";

function Drawer({ s }: { s: Session | null }) {
  const kind: DrawerKind = s?.hosted ? "wide" : "plain";
  const saved = useStore((st) => st.drawerWidths[kind]);
  const width = saved ? clampWidth(saved) : undefined;
  // Its left edge: drag it like a window's edge. The panel is anchored right, so it grows to the left.
  const startDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    const w0 = (e.currentTarget.parentElement as HTMLElement).getBoundingClientRect().width;
    dragFrom(e, "ew-resize", (dx) => setDrawerWidth(kind, w0 - dx));
  };
  const reset = () => {
    setDrawerWidth(kind, null);
    keepSizes();
  };
  return (
    <AnimatePresence>
      {s && (
        <>
          <motion.div className="drawer-scrim" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setState({ drawer: null })} />
          <motion.aside
            className={`drawer ${s.hosted ? "is-wide" : ""}`}
            style={width ? { width } : undefined}
            initial={{ x: 40, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: 40, opacity: 0 }}
            transition={{ type: "spring", stiffness: 420, damping: 40 }}
          >
            <div className="drawer-grip" data-tip="Drag to resize · double-click for the usual width" onPointerDown={startDrag} onDoubleClick={reset} />
            <SessionDetail s={s} variant="drawer" />
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  );
}

// Keys typed for another app can land here when this window takes focus, so the first moment is ignored.
let focusedAt = Date.now();
window.addEventListener("focus", () => (focusedAt = Date.now()));

function useKeyboard(visible: Session[]) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      // An open menu took this key already.
      if (e.defaultPrevented || target.closest("input, textarea, select") || e.metaKey || e.ctrlKey || e.altKey) return;
      const st = getState();
      // A session's menu is open: its keys are for that session, not the selected one.
      if (st.menu) return;
      if (e.key === "Escape") {
        // The new-session dialog decides for itself: it may hold a console that still waits for an answer.
        if (st.panel === "new") return;
        // A maximized console steps back to the details first. Esc inside the console still goes to Claude Code.
        if (st.drawer && st.consoleView === "max" && !st.closing && !st.panel) return setState({ consoleView: "normal" });
        setState(st.closing ? { closing: null } : st.panel ? { panel: null } : { drawer: null });
        return;
      }
      if (!document.hasFocus() || Date.now() - focusedAt < 900) return;
      if (st.closing || st.panel) return;
      if (/^[1-9]$/.test(e.key)) {
        const s = visible[Number(e.key) - 1];
        if (s) setState({ selected: s.pid });
        return;
      }
      if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
        const i = visible.findIndex((s) => s.pid === st.selected);
        const next = visible[Math.max(0, Math.min(visible.length - 1, i + (e.key === "ArrowRight" ? 1 : -1)))];
        if (next) setState({ selected: next.pid });
        return;
      }
      if (e.key.toLowerCase() === "n" && !VIEW.wallOnly) {
        setState({ panel: "new" });
        return;
      }
      if (e.key.toLowerCase() === "t" && !VIEW.wallOnly) {
        void openTerminal();
        return;
      }
      if (e.key.toLowerCase() === "f") {
        const layout = st.snapshot?.settings.layout === "focus" ? "fit" : "focus";
        void fetch("/api/settings", { method: "POST", headers: { "Content-Type": "application/json", "X-Control-Room": "1" }, body: JSON.stringify({ layout }) });
        return;
      }
      const s = visible.find((x) => x.pid === st.selected);
      if (!s) return;
      const key = e.key.toLowerCase();
      if (e.key === "Enter") {
        e.preventDefault(); // the Enter would otherwise reach the console that opens now
        openSession(s);
      }
      else if (e.key === " ") {
        e.preventDefault();
        setState({ drawer: st.drawer === s.pid ? null : s.pid });
      } else if (key === "a" && s.activity.kind === "approval") void act(`${s.pid}:approve`, `/api/sessions/${s.pid}/approve`);
      else if (key === "r" && s.activity.kind === "approval") void act(`${s.pid}:reject`, `/api/sessions/${s.pid}/reject`);
      else if (key === "p" && s.pr) openUrl(s.pr.url);
      else if (key === "x") setState({ closing: s.pid });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [visible]);
}

function Loading() {
  return (
    <div className="boot">
      <div className="empty-art" aria-hidden>
        <span />
        <span />
        <span />
        <span />
      </div>
      <p>Looking for your Claude Code sessions…</p>
    </div>
  );
}

/** A single session in its own window, for a second display. */
function SessionWindow({ pid }: { pid: number }) {
  const snap = useStore((s) => s.snapshot);
  const closing = useStore((s) => s.closing);
  const s = snap?.sessions.find((x) => x.pid === pid) ?? null;
  useEffect(() => {
    if (s) document.title = `${s.name} · Control Room`;
  }, [s?.name]);
  if (!snap) return <Loading />;
  if (!s) return <div className="boot"><p>This session has ended.</p></div>;
  return (
    <div className="app app-popout">
      <TopBar snap={snap} />
      <SessionDetail s={s} variant="popout" />
      {closing === s.pid && <CloseDialog s={s} />}
      <Toasts />
    </div>
  );
}

export function App() {
  const snap = useStore((s) => s.snapshot);
  const filter = useStore((s) => s.filter);
  const drawer = useStore((s) => s.drawer);
  const closing = useStore((s) => s.closing);
  const panel = useStore((s) => s.panel);
  const visible = (snap?.sessions ?? []).filter((s) => matchesFilter(s, filter));
  useKeyboard(visible);

  if (VIEW.sessionPid !== null) return <SessionWindow pid={VIEW.sessionPid} />;
  if (!snap) return <Loading />;
  const byPid = (pid: number | null) => (pid === null ? null : (snap.sessions.find((s) => s.pid === pid) ?? null));
  const closingSession = byPid(closing);
  return (
    <div className={`app ${VIEW.wallOnly ? "app-wall" : ""}`}>
      <TopBar snap={snap} />
      <SetupBanner snap={snap} />
      <Overview snap={snap} />
      <main className="wall-area">
        <WallToolbar sessions={snap.sessions} layout={snap.settings.layout} />
        <Wall sessions={snap.sessions} layout={snap.settings.layout} />
      </main>
      <Drawer s={snap.settings.layout === "focus" ? null : byPid(drawer)} />
      {closingSession && <CloseDialog s={closingSession} />}
      {panel === "settings" && <SettingsPanel snap={snap} />}
      {panel === "worktrees" && <WorktreesPanel />}
      {panel === "new" && <NewSessionDialog snap={snap} />}
      <SessionMenu />
      <Toasts />
    </div>
  );
}
