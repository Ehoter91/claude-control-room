// Draws build/icon.png (the app icon) and build/trayTemplate*.png (the menu bar icon) without image tools.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const out = join(dirname(fileURLToPath(import.meta.url)), "..", "build");
mkdirSync(out, { recursive: true });

const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function png(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

/** Coverage of a rounded rectangle at a point, 4x4 supersampled for smooth edges. */
function cover(px, py, r) {
  let hit = 0;
  for (let sy = 0; sy < 4; sy++)
    for (let sx = 0; sx < 4; sx++) {
      const x = px + (sx + 0.5) / 4;
      const y = py + (sy + 0.5) / 4;
      if (x < r.x || y < r.y || x > r.x + r.w || y > r.y + r.h) continue;
      const cx = Math.max(r.x + r.rad, Math.min(x, r.x + r.w - r.rad));
      const cy = Math.max(r.y + r.rad, Math.min(y, r.y + r.h - r.rad));
      if ((x - cx) ** 2 + (y - cy) ** 2 <= r.rad ** 2) hit++;
    }
  return hit / 16;
}

function paint(size, shapes) {
  const buf = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      let [r, g, b, a] = [0, 0, 0, 0];
      for (const s of shapes) {
        const c = cover(x, y, s.rect);
        if (!c) continue;
        const t = (y - s.rect.y) / s.rect.h;
        const col = s.to ? s.from.map((v, i) => v + (s.to[i] - v) * t) : s.from;
        const alpha = c * (s.alpha ?? 1);
        // Paint over what is below ("source over").
        const out = alpha + a * (1 - alpha);
        if (out > 0) {
          r = (col[0] * alpha + r * a * (1 - alpha)) / out;
          g = (col[1] * alpha + g * a * (1 - alpha)) / out;
          b = (col[2] * alpha + b * a * (1 - alpha)) / out;
        }
        a = out;
      }
      const i = (y * size + x) * 4;
      buf[i] = Math.round(r);
      buf[i + 1] = Math.round(g);
      buf[i + 2] = Math.round(b);
      buf[i + 3] = Math.round(a * 255);
    }
  return png(size, buf);
}

// App icon: a dark tile holding four screens, two lit (working, needs you), two calm.
const S = 1024;
const tile = (x, y, from, to, alpha) => ({ rect: { x, y, w: 300, h: 236, rad: 52 }, from, to, alpha });
writeFileSync(
  join(out, "icon.png"),
  paint(S, [
    { rect: { x: 100, y: 100, w: 824, h: 824, rad: 185 }, from: [22, 27, 38], to: [9, 12, 18] },
    tile(196, 252, [95, 242, 214], [29, 107, 255]),
    tile(528, 252, [255, 196, 102], [255, 166, 43]),
    tile(196, 536, [122, 162, 255], [122, 162, 255], 0.6),
    tile(528, 536, [122, 162, 255], [122, 162, 255], 0.3),
    { rect: { x: 412, y: 812, w: 200, h: 26, rad: 13 }, from: [88, 97, 114] },
  ]),
);

// Menu bar icon: black shapes on transparent; macOS tints a "Template" image for light and dark bars.
for (const [name, size] of [
  ["trayTemplate.png", 18],
  ["trayTemplate@2x.png", 36],
]) {
  const u = size / 18;
  const sq = (x, y, alpha) => ({ rect: { x: x * u, y: y * u, w: 7 * u, h: 5.5 * u, rad: 1.6 * u }, from: [0, 0, 0], alpha });
  writeFileSync(join(out, name), paint(size, [sq(1.5, 2.5, 1), sq(9.5, 2.5, 1), sq(1.5, 10, 0.55), sq(9.5, 10, 0.55)]));
}
console.log(`icons written to ${out}`);
