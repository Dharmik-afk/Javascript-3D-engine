// ─────────────────────────────────────────────
//  renderer.js
//
//  buildBackground()
//    Writes a static sky + floor gradient into Buffers.bg (layer 0).
//    Called once at startup; never runs inside the RAF loop.
//    Cost: O(W × H) — one uint32 write per pixel.
//
//  castRays(player)
//    Per-frame vector raycaster (layer 1).  For each screen column:
//      1. Compute ray direction from player angle + FOV offset.
//      2. DDA-march through the bucket grid one cell at a time.
//      3. Test all registered segments in each cell via 2-D
//         ray–segment intersection (Cramér's rule).
//      4. Early-exit once the next bucket boundary is farther than
//         the closest hit found so far.
//      5. Draw a distance-shaded vertical strip into Buffers.world.
//
//  Flat-array hot path
//  ───────────────────
//  Wall data is stored in WALLS_FLAT — a Float32Array with SEG_SIZE=8
//  floats per segment (see map.js for field layout).
//
//  Why Float32Array over Array-of-Objects?
//    Object property access requires V8 to resolve a hidden class and
//    follow a pointer to the backing store — two indirections per field.
//    Float32Array access is a single bounds-checked index into one
//    contiguous block.  The JIT compiles it to a direct memory read
//    with no hidden-class lookup and no pointer chasing.
//    Additionally, all four intersection inputs (x1, y1, ex, ey) sit
//    at consecutive offsets 0–3, so a single cache-line fetch delivers
//    all the data the intersection test needs.
//
//  bestSegBase
//    Stores the flat-array base offset (= i * SEG_SIZE) of the
//    closest hit instead of an object reference.  Shading and colour
//    reads after the march use the same direct indexed access.
//    Sentinel -1 indicates no hit (base is always ≥ 0 for real hits).
//
//  Generation-counter dedup
//    A segment registered in N buckets would otherwise be tested N
//    times per ray as the DDA marches through those buckets.
//    _tested[i] === _generation means segment i was already tested
//    this column.  _generation is bumped once per column; when it
//    would exceed 254, _tested is zeroed and the counter resets.
//    No per-column allocation — the Uint8Array is module-level and reused.
//
//  Per-column speed notes
//    • walls is captured as a local const so V8 doesn't re-resolve
//      the module export reference inside the loop.
//    • color32 is packed once per column, outside the vertical strip loop.
//    • Strip loop uses idx += W (add) instead of y * W + x (multiply).
//    • No bounds-check inside the strip loop — drawStart/drawEnd are
//      already clamped to [0, H).
//    • perpWallDist === bestT directly (no dot-product multiply needed).
//      Proof: rayDir = dir + plane*camX; plane ⊥ dir → rayDir·dir = 1.
//
//  FOV = 60°  →  camera-plane half-length = tan(30°) ≈ 0.57735
// ─────────────────────────────────────────────

import { W, H } from './canvas.js';
import { Buffers } from './buffers.js';
import {
  WALLS_FLAT, WALLS_COUNT,
  SEG_X1, SEG_Y1, SEG_EX, SEG_EY,
  SEG_ABSNY, SEG_R, SEG_G, SEG_B,
  SEG_SIZE,
  WORLD_W, WORLD_H,
  getSegments
} from './map.js';

const FOV_HALF_TAN = Math.tan(Math.PI / 6);   // tan(30°) — do not recompute per frame
const MAX_LINE_HEIGHT = H * 4;                    // clamp: prevents integer overflow in strip bounds

// ── Generation-counter dedup ─────────────────────────────────────
// Sized to WALLS_COUNT at init so every valid segment index i has a slot.
// Avoids the per-column Set allocation the naive approach would require.
const _tested = new Uint8Array(WALLS_COUNT);
let _generation = 1;

// ── Layer 0: sky + floor gradient (called once) ──────────────────
export function buildBackground() {
  const buf32 = Buffers.bg.data32;
  const halfH = H >> 1;

  // Sky — deep navy at top, lighter blue approaching horizon
  for (let y = 0; y < halfH; y++) {
    const t = y / halfH;
    const r = (8 + t * 18) | 0;
    const g = (8 + t * 20) | 0;
    const b = (22 + t * 55) | 0;
    const color = (0xFF000000 | (b << 16) | (g << 8) | r) >>> 0;
    const rowOff = y * W;
    for (let x = 0; x < W; x++) buf32[rowOff + x] = color;
  }

  // Floor — dark stone, slightly lighter toward horizon
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

// ── Layer 1: vector raycaster (called every frame) ───────────────
export function castRays(player) {
  const data32 = Buffers.world.data32;
  // Local reference prevents the JIT from re-dereferencing the module
  // export binding on every iteration of the inner loop.
  const walls = WALLS_FLAT;

  const px = player.pos.x;
  const py = player.pos.y;

  // Forward unit vector and perpendicular camera plane.
  // Convention: north = 0, clockwise positive (matches player.angle).
  const dirX = Math.sin(player.angle);
  const dirY = -Math.cos(player.angle);
  const planeX = Math.cos(player.angle) * FOV_HALF_TAN;
  const planeY = Math.sin(player.angle) * FOV_HALF_TAN;

  for (let x = 0; x < W; x++) {

    // Advance generation: marks all _tested[] slots as "untested for this column".
    // Cheaper than clearing the whole array each column.
    if (++_generation > 254) { _tested.fill(0); _generation = 1; }

    // camX maps screen column to [-1, +1] (left edge to right edge)
    const camX = (2 * x / W) - 1;
    const rayDirX = dirX + planeX * camX;
    const rayDirY = dirY + planeY * camX;

    // Starting bucket — floor of player position in tile-space
    let mapX = px | 0;
    let mapY = py | 0;

    // DDA delta distances.  Sentinel 1e30 for near-zero direction components
    // prevents division-by-zero and keeps step logic uniform for all angles.
    const deltaDistX = Math.abs(rayDirX) < 1e-10 ? 1e30 : Math.abs(1 / rayDirX);
    const deltaDistY = Math.abs(rayDirY) < 1e-10 ? 1e30 : Math.abs(1 / rayDirY);

    // Step direction (-1 or +1) and distance to the first cell boundary
    let stepX, sideDistX;
    if (rayDirX < 0) { stepX = -1; sideDistX = (px - mapX) * deltaDistX; }
    else { stepX = 1; sideDistX = (mapX + 1 - px) * deltaDistX; }

    let stepY, sideDistY;
    if (rayDirY < 0) { stepY = -1; sideDistY = (py - mapY) * deltaDistY; }
    else { stepY = 1; sideDistY = (mapY + 1 - py) * deltaDistY; }

    // ── DDA march ──────────────────────────────────────────────
    let bestT = Infinity;
    let bestSegBase = -1;   // flat-array base of closest hit; -1 = no hit yet

    while (true) {

      // Test every segment registered in the current bucket
      for (const i of getSegments(mapX, mapY)) {
        if (_tested[i] === _generation) continue;   // already tested this column
        _tested[i] = _generation;

        // ── Intersection inputs — offsets 0–3, one cache-line fetch ──
        const base = i * SEG_SIZE;
        const segX1 = walls[base + SEG_X1];
        const segY1 = walls[base + SEG_Y1];
        const segEX = walls[base + SEG_EX];
        const segEY = walls[base + SEG_EY];

        // 2-D ray–segment intersection via Cramér's rule.
        // Ray:     P + t * rayDir   (t is the distance parameter we solve for)
        // Segment: S + u * segDir   (u ∈ [0,1] means the hit is on the segment)
        const fx = segX1 - px;
        const fy = segY1 - py;
        const denom = rayDirX * segEY - rayDirY * segEX;

        if (Math.abs(denom) < 1e-10) continue;   // parallel — no intersection

        const t = (fx * segEY - fy * segEX) / denom;
        const u = (fx * rayDirY - fy * rayDirX) / denom;

        // t > 1e-4: reject self-intersections at the ray origin
        // u in [0,1]: hit must lie within the segment endpoints
        if (t > 1e-4 && u >= 0 && u <= 1 && t < bestT) {
          bestT = t;
          bestSegBase = base;
        }
      }

      // Early exit: if the next bucket boundary is already farther than
      // our closest hit, no later bucket can produce a closer one.
      if (bestT < Infinity && (sideDistX < sideDistY ? sideDistX : sideDistY) > bestT) break;

      // Advance to next bucket — step along the axis whose boundary is closer
      if (sideDistX < sideDistY) { sideDistX += deltaDistX; mapX += stepX; }
      else { sideDistY += deltaDistY; mapY += stepY; }

      // Stop marching at world boundary
      if (mapX < 0 || mapX >= WORLD_W || mapY < 0 || mapY >= WORLD_H) break;
    }

    if (bestSegBase < 0) continue;   // no wall hit on this column — leave bg pixel

    // perpWallDist = bestT exactly (see file header proof).
    // No fisheye: perpendicular distance, not Euclidean.
    const perpWallDist = bestT;
    if (perpWallDist <= 0) continue;

    // Vertical strip extent — clamped to [0, H) so the strip loop
    // never writes out of bounds without a per-row check.
    const lineHeight = Math.min(MAX_LINE_HEIGHT, (H / perpWallDist) | 0);
    const drawStart = Math.max(0, (H - lineHeight) >> 1);
    const drawEnd = Math.min(H, drawStart + lineHeight);

    // ── Shading — offsets 4–7, second half of the same cache line ──
    // shade: normal-angle term — horizontal walls (absNY=1) are brighter;
    //        vertical walls (absNY=0) are darker.  Range: [0.55, 1.0].
    // fog:   linear distance fade toward the background colour.
    const shade = 0.55 + 0.45 * walls[bestSegBase + SEG_ABSNY];
    const fog = Math.min(1, perpWallDist / 12);
    const scale = (1 - fog * 0.85) * shade;

    const wr = (walls[bestSegBase + SEG_R] * scale) | 0;
    const wg = (walls[bestSegBase + SEG_G] * scale) | 0;
    const wb = (walls[bestSegBase + SEG_B] * scale) | 0;

    // Pack RGBA into a single uint32 once, then write every pixel in the
    // strip using a stride increment (idx += W) rather than a multiply
    // (y * W + x) — replaces a multiply with a cheaper add per pixel.
    const color32 = (0xFF000000 | (wb << 16) | (wg << 8) | wr) >>> 0;
    let idx = drawStart * W + x;
    for (let y = drawStart; y < drawEnd; y++, idx += W) {
      data32[idx] = color32;
    }
  }
}

