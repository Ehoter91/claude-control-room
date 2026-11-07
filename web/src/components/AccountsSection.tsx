// Claude accounts besides the usual one, in Settings. Each keeps its own login in its own Claude Code config folder.
import { UserRound, X } from "lucide-react";
import { type FormEvent, useState } from "react";
import { claudeCommand, MAX_ACCOUNTS } from "../../../shared/claude.ts";
import type { OtherAccount, Snapshot } from "../../../shared/types.ts";
import { act, useStore } from "../store.ts";

export function AccountsSection({ snap }: { snap: Snapshot }) {
  const busy = useStore((s) => s.busy);
  const others = snap.otherAccounts;
  // The first one is most likely the personal account, so its form comes filled in.
  const [label, setLabel] = useState(others.length ? "" : "Personal");
  const [dir, setDir] = useState(others.length ? "" : "~/.claude-personal");

  const add = async (e: FormEvent) => {
    e.preventDefault();
    if (!label.trim() || !dir.trim()) return;
    const r = await act("account-add", "/api/settings", { addAccount: { label: label.trim(), dir: dir.trim() } });
    if (r.ok) {
      setLabel("");
      setDir("");
    }
  };
  const signIn = (a: OtherAccount) => void act(`account:${a.dir}`, "/api/account/switch", { dir: a.dir });
  const remove = (a: OtherAccount) => void act(`account:${a.dir}`, "/api/settings", { removeAccount: a.dir });

  return (
    <>
      <h4 className="set-section">Claude accounts</h4>
      <div className="set-line set-line-stack">
        <div className="set-text">
          <b>Other accounts</b>
          <span>
            A personal account next to your work one, say. Each keeps its own login, settings and conversations in its own folder. Sessions from every account show
            here, marked with the account's name, and New session asks which one to use.
          </span>
        </div>
        <div className="account-list">
          <div className="account-item">
            <UserRound size={15} />
            <div className="account-item-text">
              <b>Default</b>
              <span>{snap.account.email ?? "Not signed in"} · ~/.claude</span>
            </div>
          </div>
          {others.map((a) => (
            <div key={a.dir} className="account-item">
              <UserRound size={15} className="tone-account" />
              <div className="account-item-text">
                <b>{a.label}</b>
                <span data-tip={a.dir}>
                  {a.loggedIn ? (a.email ?? "Signed in") : "Not signed in"} · {a.dir}
                </span>
              </div>
              <button
                type="button"
                className={`btn btn-sm ${a.loggedIn ? "btn-ghost" : "btn-primary"}`}
                disabled={busy[`account:${a.dir}`]}
                data-tip={a.loggedIn ? "Sign in with another claude.ai account, in your browser" : "Sign in in your browser"}
                onClick={() => signIn(a)}
              >
                {a.loggedIn ? "Switch" : "Sign in"}
              </button>
              <button
                type="button"
                className="icon-btn"
                aria-label={`Remove ${a.label}`}
                data-tip="Remove it from Control Room. Its folder and login stay."
                disabled={busy[`account:${a.dir}`]}
                onClick={() => remove(a)}
              >
                <X size={14} />
              </button>
            </div>
          ))}
          {others.length < MAX_ACCOUNTS && (
            <form className="account-form" onSubmit={(e) => void add(e)}>
              <input className="input" aria-label="Account name" placeholder="Name, such as Personal" value={label} maxLength={30} onChange={(e) => setLabel(e.target.value)} />
              <input className="input mono" aria-label="Its folder" placeholder="~/.claude-personal" value={dir} onChange={(e) => setDir(e.target.value)} />
              <button type="submit" className="btn btn-ghost btn-sm" disabled={!label.trim() || !dir.trim() || busy["account-add"]}>
                Add
              </button>
            </form>
          )}
          {others[0] && (
            <p className="field-hint">
              To start one in a terminal yourself: <span className="mono">{claudeCommand(others[0])}</span>
            </p>
          )}
        </div>
      </div>
    </>
  );
}
