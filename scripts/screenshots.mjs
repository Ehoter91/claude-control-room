// Takes the README screenshots: the real UI, fed by the demo's sample sessions, framed like a Mac desktop.
// Run: npm run screenshots. It writes docs/images/*.png and touches nothing else.
import { app, BrowserWindow } from "electron";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "docs", "images");
const PRELOAD = join(ROOT, "scripts", "screenshots-preload.cjs");
const SCALE = 2;
const MENU_BAR = 26;
const PANEL_WIDTH = 384;

app.commandLine.appendSwitch("force-device-scale-factor", String(SCALE));
app.commandLine.appendSwitch("hide-scrollbars");
app.setPath("userData", join(tmpdir(), "control-room-screenshots"));
app.on("window-all-closed", () => {});
app.dock?.hide();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let windows = 0;
function makeWindow(width, height, native = true) {
  return new BrowserWindow({
    width,
    height,
    show: false,
    frame: false,
    useContentSize: true,
    enableLargerThanScreen: true,
    backgroundColor: "#06080c",
    webPreferences: {
      // An in-memory partition per window, so every scene starts with fresh UI state.
      partition: `shot-${++windows}`,
      preload: native ? PRELOAD : undefined,
      contextIsolation: true,
      sandbox: true,
    },
  });
}

async function waitFor(target, test, what, timeout = 15_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await target.executeJavaScript(`Boolean(${test})`).catch(() => false)) return;
    await sleep(120);
  }
  throw new Error(`Timed out waiting for ${what}`);
}

const run = (win, code) => win.webContents.executeJavaScript(code);
const click = (win, selector) => run(win, `document.querySelector(${JSON.stringify(selector)}).click()`);
const clickText = (win, selector, text) =>
  run(win, `[...document.querySelectorAll(${JSON.stringify(selector)})].find((e) => e.textContent.includes(${JSON.stringify(text)})).click()`);

/** The box around the elements, plus a margin, inside the window. */
async function boxOf(win, selectors, pad) {
  return run(
    win,
    `(() => {
      const rects = ${JSON.stringify(selectors)}.map((s) => document.querySelector(s).getBoundingClientRect());
      const x = Math.max(0, Math.min(...rects.map((r) => r.left)) - ${pad});
      const y = Math.max(0, Math.min(...rects.map((r) => r.top)) - ${pad});
      const right = Math.min(innerWidth, Math.max(...rects.map((r) => r.right)) + ${pad});
      const bottom = Math.min(innerHeight, Math.max(...rects.map((r) => r.bottom)) + ${pad});
      return { x: Math.round(x), y: Math.round(y), width: Math.round(right - x), height: Math.round(bottom - y) };
    })()`,
  );
}

const capture = (win, rect) => win.webContents.capturePage(rect, { stayHidden: true });

async function save(name, image, width) {
  const out = width && image.getSize().width > width ? image.resize({ width, quality: "best" }) : image;
  await writeFile(join(OUT, name), out.toPNG());
  const { width: w, height: h } = out.getSize();
  console.log(`  ${name}  ${w}×${h}`);
}

/** How many sessions wait for you: the number next to the menu bar icon. */
async function attentionCount(url) {
  const snap = await (await fetch(`${url}api/snapshot`)).json();
  const kinds = ["approval", "question", "waiting"];
  return snap.sessions.filter((x) => kinds.includes(x.activity.kind) || (x.activity.kind === "idle" && x.activity.askedYou)).length;
}

/** Opens the dashboard on a fresh demo and waits until every tile has settled. */
async function openApp(startDemo, { sessions = 8, query = "", width = 1640, height = 1020 } = {}) {
  const demo = await startDemo({ port: 0, sessions });
  const win = makeWindow(width, height);
  await win.loadURL(`${demo.url}${query}`);
  await waitFor(win.webContents, `document.querySelectorAll(".monitor, .focus-row").length >= ${sessions}`, "the sessions");
  await run(win, "document.fonts.ready.then(() => true)");
  await sleep(1200);
  return {
    win,
    demo,
    done: async () => {
      win.destroy();
      await demo.stop();
    },
  };
}

const WALLPAPER = `
  radial-gradient(1100px 760px at 10% 14%, rgba(29, 107, 255, 0.5), transparent 62%),
  radial-gradient(900px 700px at 92% 88%, rgba(255, 166, 61, 0.3), transparent 60%),
  radial-gradient(760px 560px at 64% 4%, rgba(62, 224, 197, 0.26), transparent 60%),
  radial-gradient(1000px 900px at 26% 104%, rgba(122, 92, 255, 0.32), transparent 60%),
  linear-gradient(160deg, #0b1020, #161c35 52%, #0a0d18)`;

const ICONS = {
  battery: `<svg width="25" height="12" viewBox="0 0 25 12"><rect x=".5" y=".5" width="21" height="11" rx="3" fill="none" stroke="currentColor" opacity=".5"/><rect x="2" y="2" width="15" height="8" rx="1.6" fill="currentColor"/><path d="M23 4v4c.8-.3 1.3-1 1.3-2s-.5-1.7-1.3-2z" fill="currentColor" opacity=".5"/></svg>`,
  wifi: `<svg width="16" height="12" viewBox="0 0 16 12"><path d="M8 11.4 5.5 8.8a3.6 3.6 0 0 1 5 0L8 11.4zM3.3 6.6a6.7 6.7 0 0 1 9.4 0l-1.1 1.1a5.1 5.1 0 0 0-7.2 0L3.3 6.6zM1 4.4a9.9 9.9 0 0 1 14 0l-1.1 1.1a8.3 8.3 0 0 0-11.8 0L1 4.4z" fill="currentColor"/></svg>`,
  search: `<svg width="14" height="14" viewBox="0 0 14 14"><circle cx="5.8" cy="5.8" r="4.3" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="m9 9 3.6 3.6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`,
  controls: `<svg width="16" height="14" viewBox="0 0 16 14"><rect x=".8" y="1" width="14.4" height="5" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.3"/><circle cx="12.6" cy="3.5" r="1.5" fill="currentColor"/><rect x=".8" y="8" width="14.4" height="5" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.3"/><circle cx="3.4" cy="10.5" r="1.5" fill="currentColor"/></svg>`,
};

/** A Mac desktop: wallpaper, an optional menu bar with the Control Room icon, app windows, and the menu bar panel. */
function stageHtml({ width, height, menuBar, menus = true, attention, windows: wins = [], panelUrl }) {
  const winHtml = wins
    .map(
      (w) => `<div class="win" style="left:${w.x}px;top:${w.y}px;width:${w.width}px;height:${w.height}px">
        <img src="${w.src}" width="${w.width}" height="${w.height}">
        <span class="lights"><i></i><i></i><i></i></span>
      </div>`,
    )
    .join("");
  const bar = menuBar
    ? `<div class="menubar">
        <div class="menus">${menus ? "<b>Code</b><span>File</span><span>Edit</span><span>Selection</span><span>View</span><span>Go</span><span>Run</span><span>Terminal</span><span>Window</span><span>Help</span>" : ""}</div>
        <div class="status">
          <span class="tray"><img src="tray.png" width="18" height="18">${attention ? `<b>${attention}</b>` : ""}</span>
          ${ICONS.battery}${ICONS.wifi}${ICONS.search}${ICONS.controls}<span>Mon Nov 2&nbsp;&nbsp;9:41 AM</span>
        </div>
      </div>`
    : "";
  const panel = panelUrl ? `<div class="panel"><iframe src="${panelUrl}" width="${PANEL_WIDTH}" height="700"></iframe></div>` : "";
  return `<!doctype html><meta charset="utf-8">
<style>
  :root { color-scheme: dark; }
  html, body { margin: 0; background: #0a0d18; }
  .desk { position: relative; width: ${width}px; height: ${height}px; overflow: hidden; background: ${WALLPAPER}; font: 13px/1 -apple-system, BlinkMacSystemFont, sans-serif; color: #fff; -webkit-font-smoothing: antialiased; }
  .menubar { position: absolute; inset: 0 0 auto; height: ${MENU_BAR}px; display: flex; align-items: center; justify-content: space-between; padding: 0 14px 0 18px; background: rgba(10, 12, 20, 0.42); backdrop-filter: blur(30px) saturate(1.6); box-shadow: 0 1px 0 rgba(255, 255, 255, 0.06); }
  .menus, .status { display: flex; align-items: center; gap: 19px; }
  .menus span { opacity: 0.92; }
  .status { gap: 17px; opacity: 0.94; }
  .tray { display: inline-flex; align-items: center; gap: 5px; font-variant-numeric: tabular-nums; }
  .tray img { filter: invert(1); }
  .tray b { font-weight: 500; }
  .win { position: absolute; border-radius: 12px; overflow: hidden; box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.1), 0 36px 90px rgba(0, 0, 0, 0.6), 0 8px 24px rgba(0, 0, 0, 0.35); }
  .win img { display: block; }
  .lights { position: absolute; left: 18px; top: 19px; display: flex; gap: 8px; }
  .lights i { width: 12px; height: 12px; border-radius: 50%; box-shadow: inset 0 0 0 0.5px rgba(0, 0, 0, 0.25); }
  .lights i:nth-child(1) { background: #ff5f57; }
  .lights i:nth-child(2) { background: #febc2e; }
  .lights i:nth-child(3) { background: #28c840; }
  .panel { position: absolute; top: ${MENU_BAR + 6}px; width: ${PANEL_WIDTH}px; border-radius: 12px; overflow: hidden; backdrop-filter: blur(44px) saturate(1.8); background: rgba(30, 34, 46, 0.32); box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.13), 0 28px 80px rgba(0, 0, 0, 0.6); }
  .panel iframe { display: block; border: 0; background: transparent; }
</style>
<div class="desk">${winHtml}${bar}${panel}</div>
<script>
  // The panel hangs under the menu bar icon, as it does on a real Mac.
  const icon = document.querySelector(".tray img");
  const panel = document.querySelector(".panel");
  if (icon && panel) {
    const r = icon.getBoundingClientRect();
    panel.style.left = Math.max(8, Math.min(${width} - ${PANEL_WIDTH} - 8, r.left + r.width / 2 - ${PANEL_WIDTH} / 2)) + "px";
  }
</script>`;
}

/** Renders a stage in a window and returns the picture. The panel's frame is sized to its content first. */
async function shootStage(dir, name, stage, crop) {
  const file = join(dir, `${name}.html`);
  await writeFile(file, stageHtml(stage));
  const win = makeWindow(stage.width, stage.height, false);
  await win.loadFile(file);
  await waitFor(win.webContents, `[...document.images].every((i) => i.complete && i.naturalWidth > 0)`, "the stage images");
  let panelBottom = 0;
  if (stage.panelUrl) {
    const frameOf = () => win.webContents.mainFrame.frames.find((f) => f.url.includes("view=menubar"));
    await waitFor({ executeJavaScript: (code) => frameOf()?.executeJavaScript(code) ?? Promise.resolve(false) }, `document.querySelector(".mb-row")`, "the panel");
    await sleep(1200);
    const h = Math.ceil(await frameOf().executeJavaScript(`document.querySelector(".mb").getBoundingClientRect().height`));
    await run(win, `document.querySelector(".panel iframe").height = ${h}; document.querySelector(".panel").style.height = "${h}px"`);
    panelBottom = MENU_BAR + 6 + h;
    await sleep(600);
  }
  const rect = crop ? await crop(win, panelBottom) : undefined;
  const image = await capture(win, rect);
  win.destroy();
  return image;
}

async function main() {
  const { startDemo } = await import(join(ROOT, "dist", "demo.mjs"));
  await mkdir(OUT, { recursive: true });
  const dir = await mkdtemp(join(tmpdir(), "control-room-stage-"));
  await writeFile(join(dir, "tray.png"), await readFile(join(ROOT, "build", "trayTemplate@2x.png")));
  console.log(`Writing screenshots to ${OUT}`);

  // The dashboard: overview on top, the wall of sessions below.
  let s = await openApp(startDemo);
  const dashboard = await capture(s.win);
  await writeFile(join(dir, "dashboard.png"), dashboard.toPNG());
  await save("needs-you.png", await capture(s.win, await boxOf(s.win, ['.monitor[data-pid="48211"]', '.monitor[data-pid="48077"]'], 14)));

  // The hero: the dashboard window with the menu bar panel open over it.
  const panelUrl = `${s.demo.url}?view=menubar`;
  const attention = await attentionCount(s.demo.url);
  await save(
    "hero.png",
    await shootStage(dir, "hero", {
      width: 1920,
      height: 1200,
      menuBar: true,
      attention,
      windows: [{ src: "dashboard.png", x: 72, y: 74, width: 1640, height: 1020 }],
      panelUrl,
    }),
    2000,
  );
  await save("dashboard.png", await shootStage(dir, "dashboard", { width: 1736, height: 1116, windows: [{ src: "dashboard.png", x: 48, y: 44, width: 1640, height: 1020 }] }), 2000);
  // The right end of the menu bar, with the panel open under the icon.
  await save(
    "menubar.png",
    await shootStage(dir, "menubar", { width: 1000, height: 1000, menuBar: true, menus: false, attention, panelUrl }, async (win, bottom) => {
      const left = Math.round(await run(win, `document.querySelector(".panel").getBoundingClientRect().left`)) - 150;
      return { x: left, y: 0, width: 1000 - left, height: bottom + 56 };
    }),
  );

  // Session details in the side drawer.
  await click(s.win, '.monitor[data-pid="47950"]');
  await waitFor(s.win.webContents, `document.querySelector(".drawer .convo-msg")`, "the drawer");
  await sleep(1000);
  const drawer = await boxOf(s.win, [".drawer"], 0);
  const end = await run(s.win, `Math.ceil(document.querySelector(".drawer .convo").lastElementChild.getBoundingClientRect().bottom)`);
  await save("details.png", await capture(s.win, { ...drawer, height: Math.min(drawer.height, end + 36) }));
  await run(s.win, `document.querySelector(".drawer-scrim").click()`);
  await sleep(700);

  // Closing a session: claims, and advice on the worktree.
  await click(s.win, '.monitor[data-pid="46980"] [aria-label="Close session…"]');
  await waitFor(s.win.webContents, `document.querySelector(".dialog .verdict")`, "the close advice");
  await run(s.win, `document.querySelectorAll(".dialog input[type=checkbox]")[1].click()`);
  await sleep(900);
  await save("close.png", await capture(s.win, await boxOf(s.win, [".dialog"], 28)));
  await s.done();

  // Worktree cleanup, in a shorter window so the list fills the sheet.
  s = await openApp(startDemo, { height: 660 });
  await clickText(s.win, ".card-mac .btn", "Clean up");
  await waitFor(s.win.webContents, `document.querySelector(".wt-row-head")`, "the worktree list");
  await click(s.win, ".wt-row-head input");
  await sleep(900);
  await save("worktrees.png", await capture(s.win, await boxOf(s.win, [".sheet"], 28)));
  await s.done();

  // Focus: one session big, the rest in a list.
  s = await openApp(startDemo, { width: 1440, height: 900 });
  await click(s.win, '[aria-label="Hide the overview"]');
  await clickText(s.win, ".seg-btn", "Focus");
  await waitFor(s.win.webContents, `document.querySelector(".focus .convo-msg")`, "the focus view");
  await sleep(1200);
  await writeFile(join(dir, "focus.png"), (await capture(s.win)).toPNG());
  await s.done();
  await save("focus.png", await shootStage(dir, "focus", { width: 1536, height: 996, windows: [{ src: "focus.png", x: 48, y: 44, width: 1440, height: 900 }] }), 2000);

  // The wall on a display of its own: twelve sessions, full screen.
  s = await openApp(startDemo, { sessions: 12, query: "?view=wall", width: 1920, height: 1080 });
  await save("wall.png", await capture(s.win), 2000);
  await s.done();

  await rm(dir, { recursive: true, force: true });
}

app
  .whenReady()
  .then(main)
  .then(
    () => app.quit(),
    (err) => {
      console.error(err);
      app.exit(1);
    },
  );
