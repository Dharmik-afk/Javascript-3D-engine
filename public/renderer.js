// ─────────────────────────────────────────────
//  renderer.js
//  Two responsibilities:
//
//  buildBackground()
//    Writes a static sky + floor gradient into
//    Buffers.bg (layer 0).  Called once at startup.
//    Uses Uint32Array writes (1 write per pixel).
//    Row colour is computed once and broadcast
//    across the full row width.
//
//  castRays(player)
//    Vector raycaster.  For every screen column:
//      1. Compute ray direction from player angle + FOV offset
//      2. DDA-march through the bucket grid
//      3. At each bucket, test all registered segments with
//         a 2D ray-segment intersection
//      4. Stop marching once the next bucket boundary is
//         farther than the closest hit found so far
//      5. Compute perpendicular distance (no fisheye) and
//         draw a distance-shaded vertical wall strip
//
//  Hot-path pixel write optimisations
//  ───────────────────────────────────
//  • Colour is packed to a single uint32 once per column,
//    outside the vertical strip loop.
//  • Strip loop uses a running index (idx += W) instead of
//    recomputing y * W + x every iteration — replaces a
//    multiply with a cheaper add.
//  • Writes directly to Buffers.world.data32 — no putPixel
//    function call overhead, no per-pixel bounds check
//    (drawStart / drawEnd are already clamped to [0, H)).
//
//  FOV = 60°  →  camera-plane half-length = tan(30°) ≈ 0.57735
// ─────────────────────────────────────────────

import { W, H } from './canvas.js';
import { Buffers } from './buffers.js';
import {
  WALLS, WORLD_W, WORLD_H,
  getSegments
} from './map.js';

const FOV_HALF_TAN = Math.tan(Math.PI / 6);   // tan(30°)

// ── Layer 0: static sky + floor gradient ────────────────────────
export function buildBackground() {
  const buf32 = Buffers.bg.data32;
  const halfH = H >> 1;

  // Sky — top half, deep navy → lighter blue at horizon
  for (let y = 0; y < halfH; y++) {
    const t = y / halfH;
    const r = (8 + t * 18) | 0;
    const g = (8 + t * 20) | 0;
    const b = (22 + t * 55) | 0;
    const color = (0xFF000000 | (b << 16) | (g << 8) | r) >>> 0;
    const rowOff = y * W;
    for (let x = 0; x < W; x++) buf32[rowOff + x] = color;
  }

  // Floor — bottom half, dark stone, slightly lighter toward horizon
  for (let y = halfH; y < H; y++) {
    const t = (y - halfH) / halfH;
    const r = (28 + t * 14) | 0;
    const g = (24 + t * 8) | 0;
    const b = (20 + t * 6) | 0;
    const color = (0xFF000000 | (b << 16) | (g << 8) | r) >>> 0;
    const rowOff = y * W;
    for (let x = 0; x < W; x++) buf32[rowOff + x] = color;
  }
}

// ── Layer 1: vector raycaster ────────────────────────────────────
export function castRays(player) {
  const data32 = Buffers.world.data32;

  const px = player.pos.x;
  const py = player.pos.y;

  // Normalised forward vector (north = 0, clockwise positive)
  const dirX = Math.sin(player.angle);
  const dirY = -Math.cos(player.angle);

  // Camera plane — perpendicular to dir, half-length = FOV_HALF_TAN
  const planeX = Math.cos(player.angle) * FOV_HALF_TAN;
  const planeY = Math.sin(player.angle) * FOV_HALF_TAN;

  for (let x = 0; x < W; x++) {

    // camX: −1 (left edge) → +1 (right edge)
    const camX = (2 * x / W) - 1;

    const rayDirX = dirX + planeX * camX;
    const rayDirY = dirY + planeY * camX;

    // Starting bucket
    let mapX = px | 0;
    let mapY = py | 0;

    // DDA step distances — sentinel for near-zero direction
    const deltaDistX = Math.abs(rayDirX) < 1e-10 ? 1e30 : Math.abs(1 / rayDirX);
    const deltaDistY = Math.abs(rayDirY) < 1e-10 ? 1e30 : Math.abs(1 / rayDirY);

    // Step direction and initial boundary distances
    let stepX, sideDistX;
    if (rayDirX < 0) {
      stepX = -1;
      sideDistX = (px - mapX) * deltaDistX;
    } else {
      stepX = 1;
      sideDistX = (mapX + 1 - px) * deltaDistX;
    }

    let stepY, sideDistY;
    if (rayDirY < 0) {
      stepY = -1;
      sideDistY = (py - mapY) * deltaDistY;
    } else {
      stepY = 1;
      sideDistY = (mapY + 1 - py) * deltaDistY;
    }

    // ── DDA march with segment intersection ───────────────────
    let bestT = Infinity;
    let bestSeg = -1;

    while (true) {

      for (const i of getSegments(mapX, mapY)) {
        const seg = WALLS[i];

        const ex = seg.x2 - seg.x1;
        const ey = seg.y2 - seg.y1;
        const fx = seg.x1 - px;
        const fy = seg.y1 - py;
        const denom = rayDirX * ey - rayDirY * ex;

        if (Math.abs(denom) < 1e-10) continue;

        const t = (fx * ey - fy * ex) / denom;
        const u = (fx * rayDirY - fy * rayDirX) / denom;

        if (t > 1e-4 && u >= 0 && u <= 1 && t < bestT) {
          bestT = t;
          bestSeg = i;
        }
      }

      if (bestT < Infinity && Math.min(sideDistX, sideDistY) > bestT) break;

      if (sideDistX < sideDistY) {
        sideDistX += deltaDistX;
        mapX += stepX;
      } else {
        sideDistY += deltaDistY;
        mapY += stepY;
      }

      if (mapX < 0 || mapX >= WORLD_W || mapY < 0 || mapY >= WORLD_H) break;
    }

    if (bestSeg < 0) continue;

    // ── Perpendicular distance (no fisheye) ───────────────────
    const perpWallDist = bestT * (rayDirX * dirX + rayDirY * dirY);
    if (perpWallDist <= 0) continue;

    // ── Vertical strip bounds ─────────────────────────────────
    const lineHeight = Math.min(H * 4, (H / perpWallDist) | 0);
    const drawStart = Math.max(0, (H - lineHeight) >> 1);
    const drawEnd = Math.min(H, drawStart + lineHeight);

    // ── Shading ───────────────────────────────────────────────
    const seg = WALLS[bestSeg];
    const sex = seg.x2 - seg.x1;
    const sey = seg.y2 - seg.y1;
    const slen = Math.hypot(sex, sey) || 1;
    const shade = 0.55 + 0.45 * Math.abs(-sey / slen);

    const fog = Math.min(1, perpWallDist / 12);
    const scale = (1 - fog * 0.85) * shade;

    const wr = (seg.r * scale) | 0;
    const wg = (seg.g * scale) | 0;
    const wb = (seg.b * scale) | 0;

    // ── Pack colour once; write strip with stride increment ───
    // Avoids y * W + x multiply inside the loop — replaced by idx += W.
    // No bounds check needed: drawStart and drawEnd are clamped to [0, H).
    const color32 = (0xFF000000 | (wb << 16) | (wg << 8) | wr) >>> 0;
    let idx = drawStart * W + x;
    for (let y = drawStart; y < drawEnd; y++, idx += W) {
      data32[idx] = color32;
    }
  }
}

