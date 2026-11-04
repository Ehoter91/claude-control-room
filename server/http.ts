import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
// Bundled: dist/*.mjs next to dist/web. From source: server/*.ts, two levels from dist/web.
export const DIST = existsSync(join(HERE, "web")) ? HERE : join(HERE, "..", "dist");
const WEB_DIR = join(DIST, "web");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".json": "application/json",
  ".ico": "image/x-icon",
};

export const DEV_ORIGINS = ["http://localhost:5173", "http://127.0.0.1:5173"];

export function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

const MAX_BODY = 8 * 1024 * 1024; // a big paste into a console fits; anything larger is not ours

export async function body<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw new Error("Request too large");
    chunks.push(c as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return (raw ? JSON.parse(raw) : {}) as T;
}

/** Why a request must be refused, or null. Only this Mac may talk to the server, and only pages it served may act through it. */
export function refusal(req: IncomingMessage, port: number, extraOrigins: string[] = []): string | null {
  const host = req.headers.host ?? "";
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return "Forbidden host";
  const origin = req.headers.origin;
  const origins = [`http://127.0.0.1:${port}`, `http://localhost:${port}`, ...extraOrigins];
  if (origin && !origins.includes(origin)) return "Forbidden origin";
  if (req.method === "POST" && req.headers["x-control-room"] !== "1") return "Missing header";
  return null;
}

export async function serveStatic(res: ServerResponse, path: string): Promise<void> {
  const rel = normalize(path === "/" ? "/index.html" : decodeURIComponent(path)).replace(/^(\.\.[/\\])+/, "");
  let file = join(WEB_DIR, rel);
  if (!file.startsWith(WEB_DIR) || !existsSync(file) || (await stat(file)).isDirectory()) file = join(WEB_DIR, "index.html");
  if (!existsSync(file)) {
    res.writeHead(503, { "Content-Type": "text/plain" });
    res.end("The UI is not built yet. Run: npm run build");
    return;
  }
  const type = MIME[extname(file)] ?? "application/octet-stream";
  const cache = file.includes("/assets/") ? "public, max-age=31536000, immutable" : "no-store";
  res.writeHead(200, { "Content-Type": type, "Cache-Control": cache });
  res.end(await readFile(file));
}
