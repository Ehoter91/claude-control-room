// Control Room as a Mac app: one server in this process, a menu bar icon with a quick panel, the dashboard, wall windows per display.
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, nativeTheme, screen, shell, Tray } from "electron";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const isMac = process.platform === "darwin";

if (!app.requestSingleInstanceLock()) app.quit();
app.setName("Control Room");

let server = null;
let mainWin = null;
let panel = null;
let panelHiddenAt = 0;
let tray = null;
let quitting = false;
let attention = { count: 0, items: [] };
const walls = new Map(); // display id -> window
const popouts = new Map(); // session pid -> window

const BG = "#06080c";
const PRELOAD = join(here, "preload.cjs");
const PANEL_WIDTH = 384;
// macOS keeps the icon where you ⌘-drag it, under this name.
const TRAY_ID = "5d2f6c1e-8a43-4f0b-9c1d-3e7a2b6f4c90";

function webPreferences() {
  return { preload: PRELOAD, contextIsolation: true, sandbox: true, autoplayPolicy: "no-user-gesture-required" };
}

function isOurUrl(url) {
  return server && url.startsWith(server.url);
}

function guardNavigation(win) {
  // Links leave for the browser; only this app's own pages open as app windows.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isOurUrl(url)) {
      const pid = new URL(url).searchParams.get("session");
      if (pid) openPopout(Number(pid), null);
      else openWall(screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).id);
      return { action: "deny" };
    }
    if (/^https:\/\//.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (!isOurUrl(url)) {
      e.preventDefault();
      if (/^https:\/\//.test(url)) void shell.openExternal(url);
    }
  });
}

function appWindows() {
  return [mainWin, ...walls.values(), ...popouts.values()].filter((w) => w && !w.isDestroyed());
}

// The Dock icon shows only while a window is open; the rest of the time Control Room lives in the menu bar.
async function syncDock() {
  if (!isMac || !app.dock) return;
  const open = appWindows().some((w) => w.isVisible() || w.isMinimized());
  if (open && !app.dock.isVisible()) {
    await app.dock.show();
    app.focus({ steal: true });
  } else if (!open && app.dock.isVisible()) {
    app.dock.hide();
  }
}

function trackForDock(win) {
  win.on("show", () => void syncDock());
  win.on("hide", () => void syncDock());
}

function createMain(showNow) {
  mainWin = new BrowserWindow({
    width: 1640,
    height: 1020,
    minWidth: 980,
    minHeight: 640,
    title: "Control Room",
    show: false,
    titleBarStyle: isMac ? "hiddenInset" : "default",
    trafficLightPosition: { x: 18, y: 19 },
    backgroundColor: BG,
    webPreferences: webPreferences(),
  });
  guardNavigation(mainWin);
  trackForDock(mainWin);
  if (showNow) mainWin.once("ready-to-show", () => mainWin.show());
  mainWin.on("close", (e) => {
    // Closing the window keeps the app in the menu bar, so alerts keep coming.
    if (!quitting) {
      e.preventDefault();
      mainWin.hide();
    }
  });
  void mainWin.loadURL(server.url);
}

async function showMain(pid) {
  if (!mainWin) return;
  hidePanel();
  if (isMac && app.dock && !app.dock.isVisible()) await app.dock.show();
  mainWin.show();
  mainWin.focus();
  app.focus({ steal: true });
  if (pid) mainWin.webContents.send("cr:select", pid);
}

function createPanel() {
  panel = new BrowserWindow({
    width: PANEL_WIDTH,
    height: 520,
    show: false,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    // A panel opens over any app, even a full-screen one, and does not pull the dashboard forward with it.
    type: isMac ? "panel" : undefined,
    vibrancy: "popover",
    visualEffectState: "active",
    backgroundColor: "#00000000",
    webPreferences: webPreferences(),
  });
  panel.setAlwaysOnTop(true, "pop-up-menu");
  panel.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
  guardNavigation(panel);
  panel.on("blur", hidePanel);
  void panel.loadURL(`${server.url}?view=menubar`);
}

function hidePanel() {
  if (!panel || panel.isDestroyed() || !panel.isVisible()) return;
  panel.hide();
  panelHiddenAt = Date.now();
}

function placePanel(anchor) {
  const hasAnchor = anchor && anchor.width > 0;
  const cursor = screen.getCursorScreenPoint();
  const area = (hasAnchor ? screen.getDisplayMatching(anchor) : screen.getDisplayNearestPoint(cursor)).workArea;
  const [width, height] = panel.getSize();
  const centre = hasAnchor ? anchor.x + anchor.width / 2 : cursor.x;
  const x = Math.round(Math.min(Math.max(centre - width / 2, area.x + 8), area.x + area.width - width - 8));
  const y = Math.round(Math.max(area.y, hasAnchor ? anchor.y + anchor.height : area.y) + 6);
  panel.setBounds({ x, y, width, height: Math.min(height, area.y + area.height - y - 8) });
}

function togglePanel(anchor) {
  if (!panel || panel.isDestroyed()) return;
  if (panel.isVisible()) return hidePanel();
  // The same click that took focus away (and so closed the panel) must not open it again.
  if (Date.now() - panelHiddenAt < 300) return;
  placePanel(anchor ?? tray?.getBounds());
  panel.show();
  panel.focus();
}

function displayLabel(d, i) {
  const base = d.label || (d.internal ? "Built-in display" : `Display ${i + 1}`);
  return base;
}

function openWall(displayId) {
  hidePanel();
  const display = screen.getAllDisplays().find((d) => d.id === displayId) ?? screen.getPrimaryDisplay();
  const existing = walls.get(display.id);
  if (existing && !existing.isDestroyed()) {
    existing.show();
    existing.focus();
    return;
  }
  const { x, y, width, height } = display.workArea;
  const win = new BrowserWindow({
    x,
    y,
    width,
    height,
    title: "Control Room · Wall",
    titleBarStyle: isMac ? "hiddenInset" : "default",
    trafficLightPosition: { x: 18, y: 15 },
    backgroundColor: BG,
    webPreferences: webPreferences(),
  });
  guardNavigation(win);
  trackForDock(win);
  walls.set(display.id, win);
  win.on("closed", () => {
    walls.delete(display.id);
    void syncDock();
  });
  void win.loadURL(`${server.url}?view=wall`);
  win.once("ready-to-show", () => {
    win.show();
    // A display of its own becomes a full-screen wall; the display the dashboard is on stays as is.
    const dashboardDisplay = mainWin?.isVisible() ? screen.getDisplayMatching(mainWin.getBounds()).id : null;
    if (dashboardDisplay !== display.id) win.setFullScreen(true);
  });
}

function openPopout(pid, displayId) {
  const existing = popouts.get(pid);
  if (existing && !existing.isDestroyed()) {
    existing.show();
    existing.focus();
    return;
  }
  const display =
    (displayId !== null && screen.getAllDisplays().find((d) => d.id === displayId)) ||
    screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const width = 720;
  const height = Math.min(900, display.workArea.height - 40);
  const win = new BrowserWindow({
    x: Math.round(display.workArea.x + (display.workArea.width - width) / 2),
    y: Math.round(display.workArea.y + 30),
    width,
    height,
    minWidth: 480,
    minHeight: 420,
    title: "Session · Control Room",
    titleBarStyle: isMac ? "hiddenInset" : "default",
    trafficLightPosition: { x: 18, y: 19 },
    backgroundColor: BG,
    webPreferences: webPreferences(),
  });
  guardNavigation(win);
  trackForDock(win);
  popouts.set(pid, win);
  win.on("closed", () => {
    popouts.delete(pid);
    void syncDock();
  });
  void win.loadURL(`${server.url}?session=${pid}`);
}

function moveToDisplay(win, displayId) {
  const display = screen.getAllDisplays().find((d) => d.id === displayId);
  if (!display || !win) return;
  const b = win.getBounds();
  const area = display.workArea;
  const width = Math.min(b.width, area.width);
  const height = Math.min(b.height, area.height);
  win.setBounds({ x: area.x + Math.round((area.width - width) / 2), y: area.y + Math.round((area.height - height) / 2), width, height });
}

function trayTitle() {
  return attention.count > 0 ? ` ${attention.count}` : "";
}

function wallItems() {
  return screen.getAllDisplays().map((d, i) => ({ label: `${displayLabel(d, i)} (${d.size.width}×${d.size.height})`, click: () => openWall(d.id) }));
}

function buildTrayMenu() {
  const items = [
    { label: "Open Control Room", click: () => void showMain(null) },
    { type: "separator" },
    ...(attention.items.length
      ? [
          { label: attention.items.length === 1 ? "1 session needs you" : `${attention.items.length} sessions need you`, enabled: false },
          ...attention.items.slice(0, 8).map((it) => ({ label: `${it.name} — ${it.label}`, click: () => void showMain(it.pid) })),
        ]
      : [{ label: "Nothing needs you", enabled: false }]),
    { type: "separator" },
    { label: "Show the wall on", submenu: wallItems() },
    {
      label: "Open at login",
      type: "checkbox",
      checked: app.getLoginItemSettings().openAtLogin,
      click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked }),
    },
    { type: "separator" },
    {
      label: "Quit Control Room",
      accelerator: "Command+Q",
      click: () => {
        quitting = true;
        app.quit();
      },
    },
  ];
  return Menu.buildFromTemplate(items);
}

function showTrayMenu() {
  hidePanel();
  tray?.popUpContextMenu(buildTrayMenu());
}

function refreshTray() {
  if (!tray) return;
  tray.setTitle(trayTitle(), { fontType: "monospacedDigit" });
  tray.setToolTip(attention.count ? `${attention.count} session${attention.count === 1 ? "" : "s"} need you` : "Control Room");
}

function createTray() {
  const iconPath = join(root, "build", "trayTemplate.png");
  const icon = existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty();
  if (!icon.isEmpty()) icon.setTemplateImage(true);
  tray = new Tray(icon, TRAY_ID);
  if (icon.isEmpty()) tray.setTitle("◧");
  // A click opens the quick panel; a right-click (or control-click) opens the menu.
  tray.setIgnoreDoubleClickEvents(true);
  tray.on("click", (e, bounds) => (e.ctrlKey ? showTrayMenu() : togglePanel(bounds)));
  tray.on("right-click", showTrayMenu);
  refreshTray();
}

// Once, on the first start from /Applications, so the menu bar icon is back after every restart.
function openAtLoginOnce() {
  if (!isMac || !app.isPackaged || !app.isInApplicationsFolder()) return;
  const dir = app.getPath("userData");
  const marker = join(dir, "open-at-login-set");
  if (existsSync(marker)) return;
  app.setLoginItemSettings({ openAtLogin: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(marker, `${new Date().toISOString()}\n`);
}

function senderWindow(e) {
  return BrowserWindow.fromWebContents(e.sender);
}

ipcMain.on("cr:focus", (e) => {
  const win = senderWindow(e);
  if (win === mainWin) return void showMain(null);
  win?.show();
  win?.focus();
  app.focus({ steal: true });
});
ipcMain.on("cr:badge", (_e, count, items) => {
  attention = { count: Number(count) || 0, items: Array.isArray(items) ? items : [] };
  if (isMac) app.dock?.setBadge(attention.count ? String(attention.count) : "");
  refreshTray();
});
ipcMain.handle("cr:displays", (e) => {
  const win = senderWindow(e);
  const current = win ? screen.getDisplayMatching(win.getBounds()).id : null;
  return screen.getAllDisplays().map((d, i) => ({
    id: d.id,
    label: displayLabel(d, i),
    primary: d.id === screen.getPrimaryDisplay().id,
    current: d.id === current,
    width: d.size.width,
    height: d.size.height,
  }));
});
ipcMain.on("cr:wall", (_e, displayId) => openWall(displayId));
ipcMain.on("cr:popout", (_e, pid, displayId) => openPopout(Number(pid), displayId));
ipcMain.on("cr:move", (e, displayId) => moveToDisplay(senderWindow(e), displayId));
ipcMain.on("cr:fullscreen", (e) => {
  const win = senderWindow(e);
  win?.setFullScreen(!win.isFullScreen());
});
ipcMain.on("cr:open-main", (_e, pid) => void showMain(pid ? Number(pid) : null));
ipcMain.on("cr:panel-hide", hidePanel);
ipcMain.on("cr:panel-height", (e, height) => {
  if (!panel || senderWindow(e) !== panel) return;
  // The panel grows with its list, down to the bottom of the screen at most; the top stays under the icon.
  const b = panel.getBounds();
  const area = screen.getDisplayMatching(b).workArea;
  const h = Math.max(120, Math.min(Math.ceil(Number(height) || 0), area.y + area.height - b.y - 8));
  if (h !== b.height) panel.setBounds({ ...b, height: h });
});
ipcMain.on("cr:menu", (e, kind) => {
  const menu = kind === "walls" ? Menu.buildFromTemplate(wallItems()) : buildTrayMenu();
  menu.popup({ window: senderWindow(e) ?? undefined });
});
ipcMain.handle("cr:login-item", () => app.getLoginItemSettings().openAtLogin);
ipcMain.handle("cr:pick-folder", async (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const r = await dialog.showOpenDialog(win, { title: "Start a session in", buttonLabel: "Start here", properties: ["openDirectory"] });
  return r.canceled ? null : (r.filePaths[0] ?? null);
});
ipcMain.handle("cr:set-login-item", (_e, on) => {
  app.setLoginItemSettings({ openAtLogin: Boolean(on) });
  return app.getLoginItemSettings().openAtLogin;
});

app.on("second-instance", () => void showMain(null));
app.on("activate", () => void showMain(null));
app.on("before-quit", () => {
  quitting = true;
});
app.on("will-quit", () => {
  void server?.stop();
});

app.whenReady().then(async () => {
  const bundle = join(root, "dist", "server.mjs");
  if (!existsSync(bundle)) {
    console.error("dist/server.mjs is missing. Run: npm run build");
    app.quit();
    return;
  }
  const { startServer, loginAgeSeconds } = await import(pathToFileURL(bundle).href);
  server = await startServer({});
  // The whole app is dark, so its menus and the panel's blur are too.
  nativeTheme.themeSource = "dark";
  const dockIcon = join(root, "build", "icon.png");
  if (isMac && existsSync(dockIcon)) app.dock?.setIcon(dockIcon);
  // Started at login: stay in the menu bar. Started by you: open the dashboard too.
  // Electron's flag can miss a login start on newer macOS, so a start in the login's first 3 minutes counts too.
  const loginAge = isMac ? await loginAgeSeconds() : null;
  const atLogin = isMac && (app.getLoginItemSettings().wasOpenedAtLogin || (loginAge !== null && loginAge < 180));
  createMain(!atLogin);
  createPanel();
  createTray();
  openAtLoginOnce();
  if (atLogin) void syncDock();
});
