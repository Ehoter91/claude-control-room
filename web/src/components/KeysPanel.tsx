// Every shortcut, from lib/keys.ts. ⌘/ or ? opens it, and so does the keyboard button at the top.
import { X } from "lucide-react";
import { motion } from "motion/react";
import { Fragment } from "react";
import { KEY_GROUPS, KEYS } from "../lib/keys.ts";
import { setState } from "../store.ts";
import { Kbd } from "./Primitives.tsx";

export function KeysPanel() {
  const close = () => setState({ panel: null });
  return (
    <div className="scrim" onClick={close}>
      <motion.div
        className="sheet sheet-narrow"
        role="dialog"
        aria-modal
        aria-label="Keyboard shortcuts"
        initial={{ opacity: 0, y: 14 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ type: "spring", stiffness: 420, damping: 36 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sheet-head">
          <div>
            <h2>Keyboard shortcuts</h2>
            <p className="dialog-sub">The ⌘ and F-key ones work while you type in a console too. In a session's right-click menu, the keys act on that session.</p>
          </div>
          <button type="button" className="icon-btn" aria-label="Close" onClick={close}>
            <X size={16} />
          </button>
        </div>
        <div className="set-body">
          {KEY_GROUPS.map((g) => (
            <section key={g.title}>
              <h4 className="set-section">{g.title}</h4>
              <dl className="keys">
                {g.ids.map((id) => (
                  <div key={id} className="keys-row">
                    <dt>{KEYS[id].label}</dt>
                    <dd>
                      {KEYS[id].keys.map((k, i) => (
                        <Fragment key={k}>
                          {i > 0 && <span className="keys-or">or</span>}
                          <Kbd>{k}</Kbd>
                        </Fragment>
                      ))}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </motion.div>
    </div>
  );
}
