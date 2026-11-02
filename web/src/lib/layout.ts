export interface WallLayout {
  cols: number;
  rows: number;
  tileW: number;
  tileH: number;
  scroll: boolean; // the tiles do not all fit; the wall scrolls
}

export const TILE_MIN_W = 266;
export const TILE_MIN_H = 182;
const TILE_MAX_W = 820;
const TILE_MAX_H = 560;
const SHAPE = 1.28; // the screen shape a tile looks best at (width / height)

/**
 * Splits the wall among `n` sessions like a monitor wall: every tile on screen at once,
 * as large as possible and close to a screen shape. Falls back to scrolling rows when
 * the tiles would get too small to read.
 */
export function fitWall(n: number, width: number, height: number, gap: number): WallLayout {
  if (n <= 0 || width <= 0 || height <= 0) return { cols: 1, rows: 0, tileW: 0, tileH: 0, scroll: false };
  let best: (WallLayout & { score: number }) | null = null;
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    const w = Math.min(TILE_MAX_W, (width - gap * (cols - 1)) / cols);
    const h = Math.min(TILE_MAX_H, (height - gap * (rows - 1)) / rows);
    if (w < TILE_MIN_W || h < TILE_MIN_H) continue;
    // Area of the largest screen-shaped box inside the tile, minus a little for empty cells.
    const boxW = Math.min(w, h * SHAPE);
    const boxH = Math.min(h, w / SHAPE);
    const empty = cols * rows - n;
    const score = boxW * boxH * (1 - empty * 0.04);
    if (!best || score > best.score) best = { cols, rows, tileW: Math.floor(w), tileH: Math.floor(h), scroll: false, score };
  }
  if (best) {
    const { score: _ignored, ...layout } = best;
    return layout;
  }
  const cols = Math.max(1, Math.floor((width + gap) / (TILE_MIN_W + gap)));
  const tileW = Math.floor((width - gap * (cols - 1)) / cols);
  const tileH = Math.max(260, Math.min(360, Math.floor(tileW / SHAPE)));
  return { cols, rows: Math.ceil(n / cols), tileW, tileH, scroll: true };
}
