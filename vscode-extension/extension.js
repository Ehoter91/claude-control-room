// Control Room Bridge: connects this VS Code window to the Control Room dashboard on 127.0.0.1.
const vscode = require("vscode");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

const BRIDGE_FILE = path.join(os.homedir(), ".claude-control-room", "bridge.json");
const windowId = crypto.randomUUID();

let port = null;
let stream = null;
let retryTimer = null;
let helloTimer = null;
let stopped = false;

function readPort() {
  try {
    return JSON.parse(fs.readFileSync(BRIDGE_FILE, "utf8")).port || null;
  } catch {
    return null;
  }
}

function post(pathname, body) {
  if (!port) return Promise.resolve();
  return new Promise((resolve) => {
    const data = Buffer.from(JSON.stringify(body));
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: pathname,
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": data.length, "X-Control-Room": "1" },
      },
      (res) => {
        res.resume();
        res.on("end", resolve);
      },
    );
    req.on("error", () => resolve());
    req.end(data);
  });
}

async function terminalList() {
  const list = [];
  for (const t of vscode.window.terminals) {
    // A terminal that is still starting has no pid yet; skip it instead of waiting.
    const pid = await Promise.race([t.processId, new Promise((r) => setTimeout(() => r(undefined), 400))]);
    if (pid) list.push({ pid, name: t.name });
  }
  return list;
}

function scheduleHello() {
  clearTimeout(helloTimer);
  helloTimer = setTimeout(sayHello, 250);
}

async function sayHello() {
  await post("/bridge/hello", {
    windowId,
    folders: (vscode.workspace.workspaceFolders || []).map((f) => f.uri.fsPath),
    focused: vscode.window.state.focused,
    terminals: await terminalList(),
  });
}

async function findTerminal(pid) {
  for (const t of vscode.window.terminals) {
    if ((await t.processId) === pid) return t;
  }
  return null;
}

async function handle(cmd) {
  const term = await findTerminal(cmd.pid);
  let ok = false;
  let message = "That terminal is not in this window";
  if (term) {
    if (cmd.type === "focus") {
      term.show(false);
      ok = true;
      message = "Shown";
    } else if (cmd.type === "send" && typeof cmd.text === "string") {
      term.sendText(cmd.text, false);
      ok = true;
      message = "Sent";
    } else if (cmd.type === "close") {
      term.dispose();
      ok = true;
      message = "Closed";
    }
  }
  await post("/bridge/result", { requestId: cmd.requestId, ok, message });
}

function scheduleRetry() {
  if (stopped) return;
  clearTimeout(retryTimer);
  retryTimer = setTimeout(connect, 3000);
}

function connect() {
  if (stopped) return;
  if (stream) {
    stream.destroy();
    stream = null;
  }
  port = readPort();
  if (!port) return scheduleRetry();
  const req = http.get({ host: "127.0.0.1", port, path: `/bridge/stream?window=${windowId}` }, (res) => {
    if (res.statusCode !== 200) {
      res.resume();
      return scheduleRetry();
    }
    let buffer = "";
    res.setEncoding("utf8");
    res.on("data", (chunk) => {
      buffer += chunk;
      let cut;
      while ((cut = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, cut);
        buffer = buffer.slice(cut + 2);
        const event = /^event: (.*)$/m.exec(block)?.[1];
        const data = /^data: (.*)$/m.exec(block)?.[1];
        if (event === "hello") scheduleHello();
        else if (event === "command" && data) {
          try {
            void handle(JSON.parse(data));
          } catch {
            /* ignore a broken message */
          }
        }
      }
    });
    res.on("end", scheduleRetry);
    res.on("error", scheduleRetry);
  });
  req.on("error", scheduleRetry);
  stream = req;
}

function activate(context) {
  connect();
  // The dashboard writes its port here when it starts; follow it across restarts.
  fs.watchFile(BRIDGE_FILE, { interval: 2000 }, () => {
    if (readPort() !== port) connect();
  });
  context.subscriptions.push(
    vscode.window.onDidOpenTerminal(scheduleHello),
    vscode.window.onDidCloseTerminal(scheduleHello),
    vscode.window.onDidChangeWindowState(scheduleHello),
    vscode.workspace.onDidChangeWorkspaceFolders(scheduleHello),
    { dispose: () => fs.unwatchFile(BRIDGE_FILE) },
  );
  // Terminals restored after a reload get their pid a moment later.
  setTimeout(scheduleHello, 3000);
}

function deactivate() {
  stopped = true;
  clearTimeout(retryTimer);
  if (stream) stream.destroy();
}

module.exports = { activate, deactivate };
