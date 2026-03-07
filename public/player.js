// ─────────────────────────────────────────────
//  player.js
//  Player state, movement physics, and wall
//  collision with segment-normal push-out.
//
//  Collision algorithm (3 iterations per frame):
//    1. Apply velocity to position unconditionally.
//    2. Gather unique segment indices from the 3 × 3
//       tile neighbourhood around the player.
//    3. For each segment, project the player centre
//       onto the segment to find the closest point.
//    4. If the distance is less than the player radius,
//       push the centre out along the contact normal
//       and cancel the velocity component into the wall,
//       leaving the tangential component intact (sliding).
//
//  Segment data is read from WALLS_FLAT — the same contiguous
//  Float32Array used by renderer.js — so the collision geometry
//  reads benefit from the same cache-locality properties.
//  Only the four geometry fields (x1, y1, ex, ey) are needed
//  here; colour and shading fields are not imported.
//
//  Dedup without Set allocation
//  ─────────────────────────────
//  The 3 × 3 neighbourhood spans up to 9 buckets; a segment
//  straddling multiple cells would be processed twice without
//  deduplication.  The original code allocated a new Set()
//  each of the 3 iterations (= 3 allocations per frame, plus
//  GC pressure).
//
//  Replaced with a module-level Uint8Array (_colTested) and a
//  generation counter (_colGen) — the same pattern renderer.js
//  uses.  _colTested[i] === _colGen means segment i has already
//  been processed this iteration.  The counter is bumped once
//  per iteration; no allocation occurs inside update().
//
//  All coordinates are tile-space floats.
// ─────────────────────────────────────────────

import { Entity } from './entity.js';
import {
  WALLS_FLAT, WALLS_COUNT,
  SEG_X1, SEG_Y1, SEG_EX, SEG_EY, SEG_SIZE,
  getSegments
} from './map.js';

// ── Collision dedup — module level, zero allocation per frame ────
// Mirrors the _tested / _generation pattern in renderer.js.
// One slot per wall segment; bumping _colGen each iteration
// effectively "clears" the flags without touching the array.
const _colTested = new Uint8Array(WALLS_COUNT);
let _colGen = 1;

export class Player extends Entity {
  static FRICTION = 0.82;
  static ACCEL = 0.04;     // tiles / frame²
  static LOOK_SENSITIVITY = 0.007;    // radians per drag-pixel

  constructor(x, y) {
    super(x, y, 0.25);
    this.input = { x: 0, y: 0 };
    this.lookDeltaX = 0;
  }

  onKeyDown(k) {
    switch (k) {
      case 'W': this.input.y = -1; break;
      case 'S': this.input.y = 1; break;
      case 'A': this.input.x = -1; break;
      case 'D': this.input.x = 1; break;
    }
  }

  onKeyUp(k) {
    switch (k) {
      case 'W': case 'S': this.input.y = 0; break;
      case 'A': case 'D': this.input.x = 0; break;
    }
  }

  update() {
    // ── Rotate from look-drag ───────────────────────────────────
    // lookDeltaX is accumulated by input.js during touchmove events
    // and consumed (reset) here each frame.
    this.angle += this.lookDeltaX * Player.LOOK_SENSITIVITY;
    this.lookDeltaX = 0;

    // ── World-space wish vector from WASD + facing angle ────────
    // Forward (fx, fy) and right (rx, ry) in world space,
    // derived from the player's current facing angle.
    const fx = Math.sin(this.angle);
    const fy = -Math.cos(this.angle);
    const rx = Math.cos(this.angle);
    const ry = Math.sin(this.angle);

    // input.y: −1 = forward (W), +1 = back (S) — negated so W maps to +forward
    const wx = fx * (-this.input.y) + rx * this.input.x;
    const wy = fy * (-this.input.y) + ry * this.input.x;

    // Normalise so diagonal movement isn't faster than cardinal
    const wlen = Math.hypot(wx, wy) || 1;
    const inx = (wx !== 0 || wy !== 0) ? wx / wlen : 0;
    const iny = (wx !== 0 || wy !== 0) ? wy / wlen : 0;

    this.velocity.x = (this.velocity.x + inx * Player.ACCEL) * Player.FRICTION;
    this.velocity.y = (this.velocity.y + iny * Player.ACCEL) * Player.FRICTION;

    // Snap to zero when coasting to a stop — avoids sub-pixel drift
    // that would keep the player update loop "active" with no visible effect.
    if (!this.input.x && !this.input.y &&
      Math.hypot(this.velocity.x, this.velocity.y) < 0.001) {
      this.velocity.x = 0;
      this.velocity.y = 0;
    }

    // ── Apply velocity ──────────────────────────────────────────
    this.pos.x += this.velocity.x;
    this.pos.y += this.velocity.y;

    // ── Segment push-out collision (3 iterations) ───────────────
    // Multiple iterations resolve corner cases where two walls are
    // simultaneously penetrated (e.g. tight corridor ends).
    // Each iteration re-evaluates the player's tile position because
    // the push-out from one wall may move the player into another cell.
    const R = this.radius;

    for (let iter = 0; iter < 3; iter++) {

      // Bump generation to invalidate last iteration's tested flags.
      // Avoids clearing the whole array each iteration.
      if (++_colGen > 254) { _colTested.fill(0); _colGen = 1; }

      const tx = this.pos.x | 0;
      const ty = this.pos.y | 0;

      // Walk the 3 × 3 neighbourhood and resolve each unique segment once.
      // The nested loop visits up to 9 buckets; _colTested deduplicates
      // segments that appear in more than one of those buckets.
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          for (const i of getSegments(tx + dx, ty + dy)) {

            // Skip if already resolved this segment this iteration
            if (_colTested[i] === _colGen) continue;
            _colTested[i] = _colGen;

            // ── Flat array geometry read (offsets 0–3) ──────────
            // ex / ey are precomputed in map.js — no subtraction here.
            const base = i * SEG_SIZE;
            const x1 = WALLS_FLAT[base + SEG_X1];
            const y1 = WALLS_FLAT[base + SEG_Y1];
            const ex = WALLS_FLAT[base + SEG_EX];
            const ey = WALLS_FLAT[base + SEG_EY];
            const len2 = ex * ex + ey * ey;
            if (len2 < 1e-10) continue;   // degenerate zero-length segment — skip

            // Closest point on segment to the player centre.
            // t is clamped to [0, 1] so the result stays on the segment,
            // not its infinite-line extension (handles endpoint corners).
            let t = ((this.pos.x - x1) * ex + (this.pos.y - y1) * ey) / len2;
            t = Math.max(0, Math.min(1, t));

            const cpx = x1 + t * ex;
            const cpy = y1 + t * ey;
            const dpx = this.pos.x - cpx;
            const dpy = this.pos.y - cpy;
            const dist = Math.hypot(dpx, dpy);

            if (dist < R && dist > 1e-6) {
              // Contact normal — unit vector pointing away from the wall surface
              const overlap = R - dist;
              const invDist = 1 / dist;
              const nx = dpx * invDist;
              const ny = dpy * invDist;

              // Translate player out of penetration depth
              this.pos.x += nx * overlap;
              this.pos.y += ny * overlap;

              // Cancel only the velocity component directed into the wall.
              // The tangential component is preserved — this gives smooth
              // wall-sliding rather than a dead stop on contact.
              const vDotN = this.velocity.x * nx + this.velocity.y * ny;
              if (vDotN < 0) {
                this.velocity.x -= vDotN * nx;
                this.velocity.y -= vDotN * ny;
              }
            }
          }
        }
      }
    }
  }
}

