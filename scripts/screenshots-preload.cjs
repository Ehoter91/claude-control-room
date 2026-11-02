// Stands in for electron/preload.cjs in the screenshot windows, so the page draws as it does inside the Mac app.
const { contextBridge } = require("electron");

const displays = [
  { id: 1, label: "Built-in Retina Display", primary: true, current: true, width: 1512, height: 982 },
  { id: 2, label: "DELL U2723QE", primary: false, current: false, width: 3840, height: 2160 },
  { id: 3, label: "LG HDR 4K", primary: false, current: false, width: 3840, height: 2160 },
];
const nothing = () => {};

contextBridge.exposeInMainWorld("controlRoom", {
  focusWindow: nothing,
  setBadge: nothing,
  displays: async () => displays,
  openWall: nothing,
  popout: nothing,
  moveToDisplay: nothing,
  toggleFullScreen: nothing,
  onSelect: nothing,
  openMain: nothing,
  hidePanel: nothing,
  setPanelHeight: nothing,
  showMenu: nothing,
  loginItem: async () => true,
  setLoginItem: async (on) => on,
});
