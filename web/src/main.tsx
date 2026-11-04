import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { MenuBarPanel } from "./components/MenuBar.tsx";
import { alertOnChange, unlockAudioOnce } from "./lib/alerts.ts";
import { native } from "./lib/native.ts";
import { connect, setState, VIEW } from "./store.ts";
import "./styles.css";

// Only the main window raises notices and chimes; the menu bar panel, pop-outs and wall windows stay quiet.
const isMainWindow = !VIEW.wallOnly && !VIEW.menubar && VIEW.sessionPid === null;
connect((prev, next) => {
  if (isMainWindow) alertOnChange(prev, next);
});
unlockAudioOnce();
native?.onSelect((pid) => setState({ drawer: pid, selected: pid, typeInto: pid }));
if (VIEW.menubar) document.documentElement.classList.add("is-menubar");

createRoot(document.getElementById("root")!).render(<StrictMode>{VIEW.menubar ? <MenuBarPanel /> : <App />}</StrictMode>);
