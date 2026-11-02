import { motion } from "motion/react";
import type { Session } from "../../../shared/types.ts";
import { duration } from "../lib/format.ts";
import { needsYou, setState, useStore } from "../store.ts";
import { StatusOrb, useNow } from "./Primitives.tsx";
import { SessionDetail } from "./SessionDetail.tsx";

/** One session large on the left; every other session as a slim row on the right. */
export function FocusView({ sessions }: { sessions: Session[] }) {
  const selected = useStore((s) => s.selected);
  const now = useNow();
  const current = sessions.find((s) => s.pid === selected) ?? sessions.find(needsYou) ?? sessions[0] ?? null;
  return (
    <div className="focus">
      <div className="focus-main">
        {current ? <SessionDetail s={current} variant="focus" /> : <div className="wall-empty"><h3>No session to show</h3></div>}
      </div>
      <nav className="focus-list" aria-label="Sessions">
        {sessions.map((s, i) => (
          <motion.button
            layout
            key={s.sessionId}
            type="button"
            className={`focus-row st-${s.activity.kind} ${current?.pid === s.pid ? "is-on" : ""}`}
            onClick={() => setState({ selected: s.pid })}
          >
            <span className="mon-key">{i < 9 ? i + 1 : ""}</span>
            <StatusOrb kind={s.activity.kind} size={9} />
            <span className="focus-row-text">
              <span className="focus-row-name">{s.name}</span>
              <span className="focus-row-status">
                {s.activity.label} · {duration(now - s.activity.since)}
              </span>
            </span>
          </motion.button>
        ))}
      </nav>
    </div>
  );
}
