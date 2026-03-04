// ─────────────────────────────────────────────
//  renderer.js
//  Two responsibilities:
//
//  buildBackground()
//    Writes a static sky + floor gradient into
//    Buffers.bg (layer 0).  Called once at startup.
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
//  Ray parameterisation: P + t·D, where D = (rayDirX, rayDirY)
//  is the un-normalised ray direction (same as the original DDA).
//  The intersection t is in the same space as sideDistX/Y, so
//  the early-exit comparison is numerically consistent.
//
//  Perpendicular distance:
//    perpWallDist = t · dot(rayDir, dir)
//  Projects the hit onto the forward axis — identical guarantee
//  to the original perpendicular formula, no fisheye.
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
  const buf = Buffers.bg;
  buf.clear();

  // Sky  — top half, deep navy → lighter blue at horizon
  for (let y = 0; y < H / 2; y++) {
    const t = y / (H / 2);
    const r = (8 + t * 18) | 0;
    const g = (8 + t * 20) | 0;
    const b = (22 + t * 55) | 0;
    for (let x = 0; x < W; x++) buf.putPixel(x, y, r, g, b, 255);
  }

  // Floor — bottom half, dark stone, slightly lighter toward horizon
  for (let y = H / 2; y < H; y++) {
    const t = (y - H / 2) / (H / 2);
    const r = (28 + t * 14) | 0;
    const g = (24 + t * 8) | 0;
    const b = (20 + t * 6) | 0;
    for (let x = 0; x < W; x++) buf.putPixel(x, y, r, g, b, 255);
  }
}

// ── Layer 1: vector raycaster ────────────────────────────────────
export function castRays(player) {
  const buf = Buffers.world;

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

    // DDA step distances — same sentinel as original
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

      // Test every segment registered in this bucket
      for (const i of getSegments(mapX, mapY)) {
        const seg = WALLS[i];

        // 2D ray-segment intersection
        // Ray:     P + t·D,          t ≥ 0
        // Segment: A + u·(B−A),  0 ≤ u ≤ 1
        // Let E = B−A,  F = A−P
        // denom = cross(D, E) = Dx·Ey − Dy·Ex
        // t     = cross(F, E) / denom
        // u     = cross(F, D) / denom
        const ex = seg.x2 - seg.x1;
        const ey = seg.y2 - seg.y1;
        const fx = seg.x1 - px;
        const fy = seg.y1 - py;
        const denom = rayDirX * ey - rayDirY * ex;

        if (Math.abs(denom) < 1e-10) continue;   // parallel

        const t = (fx * ey - fy * ex) / denom;
        const u = (fx * rayDirY - fy * rayDirX) / denom;

        // t > 1e-4 prevents self-intersection when touching a wall
        if (t > 1e-4 && u >= 0 && u <= 1 && t < bestT) {
          bestT = t;
          bestSeg = i;
        }
      }

      // Early exit: next bucket boundary is beyond the closest hit
      if (bestT < Infinity && Math.min(sideDistX, sideDistY) > bestT) break;

      // Advance DDA to next bucket
      if (sideDistX < sideDistY) {
        sideDistX += deltaDistX;
        mapX += stepX;
      } else {
        sideDistY += deltaDistY;
        mapY += stepY;
      }

      // Safety: ray left the world with no hit
      if (mapX < 0 || mapX >= WORLD_W || mapY < 0 || mapY >= WORLD_H) break;
    }

    if (bestSeg < 0) continue;   // no hit — skip column

    // ── Perpendicular distance (no fisheye) ───────────────────
    // Projects hit distance onto the forward axis via dot product.
    // When camX = 0 (centre ray) dot = 1 so perpDist = bestT exactly.
    const perpWallDist = bestT * (rayDirX * dirX + rayDirY * dirY);
    if (perpWallDist <= 0) continue;

    // ── Vertical strip ────────────────────────────────────────
    const lineHeight = Math.min(H * 4, (H / perpWallDist) | 0);
    const drawStart = Math.max(0, (H - lineHeight) >> 1);
    const drawEnd = Math.min(H, drawStart + lineHeight);

    // ── Shading ───────────────────────────────────────────────
    // Normal of the hit segment: N = (−Ey, Ex) (unnormalised).
    // |Nx / |N|| → 1 for E/W-facing walls (brighter),
    //            → 0 for N/S-facing walls (darker).
    // Matches the original side-0 / side-1 shading convention.
    const seg = WALLS[bestSeg];
    const sex = seg.x2 - seg.x1;
    const sey = seg.y2 - seg.y1;
    const slen = Math.hypot(sex, sey) || 1;
    const shade = 0.55 + 0.45 * Math.abs(-sey / slen);   // 0.55–1.0

    // Fog fades distant walls to black proportionally
    const fog = Math.min(1, perpWallDist / 12);
    const scale = (1 - fog * 0.85) * shade;

    const wr = (seg.r * scale) | 0;
    const wg = (seg.g * scale) | 0;
    const wb = (seg.b * scale) | 0;

    for (let y = drawStart; y < drawEnd; y++) {
      buf.putPixel(x, y, wr, wg, wb, 255);
    }
  }
}

