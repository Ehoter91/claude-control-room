import { useSyncExternalStore, type ReactNode } from "react";
import type { StatusKind } from "../../../shared/types.ts";

let now = Date.now();
const nowListeners = new Set<() => void>();
setInterval(() => {
  now = Date.now();
  nowListeners.forEach((l) => l());
}, 1000);

/** The current time, shared by every component and updated once a second. */
export function useNow(): number {
  return useSyncExternalStore(
    (l) => {
      nowListeners.add(l);
      return () => nowListeners.delete(l);
    },
    () => now,
  );
}

export function StatusOrb({ kind, size = 10 }: { kind: StatusKind; size?: number }) {
  return (
    <span className={`orb orb-${kind}`} style={{ width: size, height: size }} aria-hidden>
      <span />
    </span>
  );
}

export function IconButton(props: {
  label: string;
  onClick: () => void;
  children: ReactNode;
  active?: boolean;
  disabled?: boolean;
  tone?: "default" | "danger";
  tipSide?: "top" | "bottom" | "left";
}) {
  return (
    <button
      type="button"
      className={`icon-btn ${props.active ? "is-active" : ""} ${props.tone === "danger" ? "is-danger" : ""}`}
      aria-label={props.label}
      data-tip={props.label}
      data-tip-side={props.tipSide ?? "bottom"}
      disabled={props.disabled}
      onClick={(e) => {
        e.stopPropagation();
        props.onClick();
      }}
    >
      {props.children}
    </button>
  );
}

export function Toggle(props: { on: boolean; onChange: (on: boolean) => void; label: string; busy?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={props.on}
      aria-label={props.label}
      className={`toggle ${props.on ? "is-on" : ""} ${props.busy ? "is-busy" : ""}`}
      onClick={() => props.onChange(!props.on)}
      disabled={props.busy}
    >
      <span className="toggle-knob" />
    </button>
  );
}

export function Meter({ value, tone }: { value: number; tone?: "auto" | "plain" }) {
  const v = Math.max(0, Math.min(100, value));
  const level = tone === "plain" ? "plain" : v >= 90 ? "high" : v >= 70 ? "mid" : "low";
  return (
    <span className={`meter meter-${level}`} role="meter" aria-valuenow={Math.round(v)} aria-valuemin={0} aria-valuemax={100}>
      <span style={{ width: `${v}%` }} />
    </span>
  );
}

/** A small ring that fills as the value grows; reads as a gauge at any tile size. */
export function Ring({ value, size = 14 }: { value: number; size?: number }) {
  const v = Math.max(0, Math.min(100, value));
  const r = (size - 3) / 2;
  const c = 2 * Math.PI * r;
  const level = v >= 90 ? "high" : v >= 70 ? "mid" : "low";
  return (
    <svg className={`ring ring-${level}`} width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden>
      <circle cx={size / 2} cy={size / 2} r={r} className="ring-track" />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        className="ring-fill"
        strokeDasharray={`${(v / 100) * c} ${c}`}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
    </svg>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="kbd">{children}</kbd>;
}

export function Spinner() {
  return <span className="spinner" aria-hidden />;
}
