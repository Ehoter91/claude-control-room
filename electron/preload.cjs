// The small native surface the dashboard page may use; everything else stays in the main process.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("controlRoom", {
  focusWindow: () => ipcRenderer.send("cr:focus"),
  setBadge: (count, items) => ipcRenderer.send("cr:badge", count, items ?? []),
  displays: () => ipcRenderer.invoke("cr:displays"),
  openWall: (displayId) => ipcRenderer.send("cr:wall", displayId),
  popout: (pid, displayId) => ipcRenderer.send("cr:popout", pid, displayId ?? null),
  moveToDisplay: (displayId) => ipcRenderer.send("cr:move", displayId),
  toggleFullScreen: () => ipcRenderer.send("cr:fullscreen"),
  onSelect: (fn) => ipcRenderer.on("cr:select", (_e, pid) => fn(pid)),
  openMain: (pid) => ipcRenderer.send("cr:open-main", pid ?? null),
  hidePanel: () => ipcRenderer.send("cr:panel-hide"),
  setPanelHeight: (height) => ipcRenderer.send("cr:panel-height", height),
  showMenu: (kind) => ipcRenderer.send("cr:menu", kind),
  loginItem: () => ipcRenderer.invoke("cr:login-item"),
  setLoginItem: (on) => ipcRenderer.invoke("cr:set-login-item", on),
  pickFolder: () => ipcRenderer.invoke("cr:pick-folder"),
});
