// The live terminal of a session that runs in Control Room. What you type goes straight to Claude Code,
// the same as in a terminal tab: Esc, Ctrl+C, slash commands, arrows and pasting all work.
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef, useState } from "react";
import { api } from "../store.ts";

const THEME = {
  background: "#0a0d13",
  foreground: "#e9edf4",
  cursor: "#7aa2ff",
  cursorAccent: "#0a0d13",
  selectionBackground: "rgba(122, 162, 255, 0.32)",
  black: "#1b1f27",
  red: "#ff6b6b",
  green: "#5be39a",
  yellow: "#ffb547",
  blue: "#7aa2ff",
  magenta: "#c4a5ff",
  cyan: "#3ee0c5",
  white: "#d5dae3",
  brightBlack: "#6c7588",
  brightRed: "#ff8a8a",
  brightGreen: "#7cf0b2",
  brightYellow: "#ffc978",
  brightBlue: "#9bb9ff",
  brightMagenta: "#d6bfff",
  brightCyan: "#6ff0da",
  brightWhite: "#ffffff",
};

function bytes(base64: string): Uint8Array {
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export default function Console({ name, autoFocus = false, onFocused }: { name: string; autoFocus?: boolean; onFocused?: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const [state, setState] = useState<"connecting" | "live" | "ended">("connecting");

  // Takes the keyboard only when asked, and only once: in the focus layout, keys 1 to 9 still pick a session.
  useEffect(() => {
    if (!autoFocus || state !== "live") return;
    termRef.current?.focus();
    onFocused?.();
  }, [autoFocus, state]);

  useEffect(() => {
    const term = new Terminal({
      fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
      fontSize: 13,
      lineHeight: 1.12,
      cursorBlink: true,
      scrollback: 5_000,
      theme: THEME,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(box.current!);
    termRef.current = term;
    const wanted = () => fit.proposeDimensions() ?? { cols: 100, rows: 30 };

    // tmux already answers what Claude Code asks the terminal (its type, the cursor position, the colors).
    // A second answer from here would reach Claude Code as typed text, so these questions go unanswered.
    const ignore = () => true;
    for (const id of [
      { final: "c" },
      { prefix: ">", final: "c" },
      { prefix: "=", final: "c" },
      { final: "n" },
      { prefix: "?", final: "n" },
      { intermediates: "$", final: "p" },
      { prefix: "?", intermediates: "$", final: "p" },
      { prefix: ">", final: "q" },
      { final: "t" },
      // The kitty keyboard protocol would change what keys send; tmux passes keys the classic way.
      { prefix: "?", final: "u" },
      { prefix: ">", final: "u" },
      { prefix: "<", final: "u" },
      { prefix: "=", final: "u" },
    ]) {
      term.parser.registerCsiHandler(id, ignore);
    }
    term.parser.registerDcsHandler({ intermediates: "$", final: "q" }, ignore);
    for (const osc of [4, 10, 11, 12]) term.parser.registerOscHandler(osc, ignore);

    // Keys go out in order, and whatever is typed while one request runs goes out with the next.
    let pending = "";
    let sending = false;
    const pump = async () => {
      if (sending || !pending) return;
      sending = true;
      const data = pending;
      pending = "";
      await api(`/api/console/${name}/input`, { data }).catch(() => null);
      sending = false;
      void pump();
    };
    const send = (data: string) => {
      pending += data;
      void pump();
    };
    term.onData(send);
    // Shift+Enter starts a new line in the prompt, the way Option+Enter does in Claude Code.
    term.attachCustomKeyEventHandler((e) => {
      if (e.key !== "Enter" || !e.shiftKey) return true;
      if (e.type === "keydown") send("\x1b\r");
      return false;
    });

    // One session has one size, whichever window set it last; this console follows it and asks for its own
    // only when its own box changes.
    const follow = (cols: number, rows: number) => {
      if (cols !== term.cols || rows !== term.rows) term.resize(cols, rows);
    };
    let ended = false;
    let stream: EventSource | null = null;
    const connect = () => {
      const { cols, rows } = wanted();
      stream = new EventSource(`/api/console/${name}/stream?cols=${cols}&rows=${rows}`);
      stream.addEventListener("reset", (ev) => {
        const d = JSON.parse((ev as MessageEvent).data) as { data: string; x: number; y: number; cursor: boolean; cols: number; rows: number };
        term.reset();
        follow(d.cols, d.rows);
        term.write(bytes(d.data));
        // Claude Code turned bracketed paste on when it started, so a pasted block arrives as one message.
        term.write(`\x1b[${d.y + 1};${d.x + 1}H${d.cursor ? "\x1b[?25h" : "\x1b[?25l"}\x1b[?2004h`);
        setState("live");
      });
      stream.addEventListener("data", (ev) => term.write(bytes((ev as MessageEvent).data)));
      stream.addEventListener("size", (ev) => {
        const d = JSON.parse((ev as MessageEvent).data) as { cols: number; rows: number };
        follow(d.cols, d.rows);
      });
      stream.addEventListener("exit", () => {
        ended = true;
        setState("ended");
        stream?.close();
      });
      // A lost link: the browser connects again by itself, and the server paints the screen anew.
      stream.onerror = () => {
        if (!ended) setState("connecting");
      };
    };
    connect();

    let resizeTimer: ReturnType<typeof setTimeout> | undefined;
    let last = "";
    const observer = new ResizeObserver(() => {
      if (!box.current?.offsetParent) return;
      const { cols, rows } = wanted();
      if (`${cols}x${rows}` === last) return;
      last = `${cols}x${rows}`;
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => void api(`/api/console/${name}/resize`, { cols, rows }).catch(() => null), 120);
    });
    observer.observe(box.current!);

    return () => {
      clearTimeout(resizeTimer);
      observer.disconnect();
      stream?.close();
      termRef.current = null;
      term.dispose();
    };
  }, [name]);

  return (
    <div className={`console is-${state}`} onClick={(e) => e.stopPropagation()}>
      <div className="console-term" ref={box} />
      {state === "connecting" && <div className="console-note">Connecting…</div>}
      {state === "ended" && <div className="console-note">This session has ended.</div>}
    </div>
  );
}
