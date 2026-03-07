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
//  Trig cache (sinA / cosA)
//  ─────────────────────────
//  sin and cos of player.angle are needed every frame by both
//  player.update() (wish vector) and castRays() (dir + camera plane).
//  Rather than calling Math.sin / Math.cos 4 times each in those two
//  functions (8 calls total on the same angle), the results are cached
//  on the player immediately after angle changes.  Both modules then
//  read sinA / cosA directly — 2 trig calls per frame regardless of
//  whether the player is rotating or standing still.
//
//  The cache is initialised in the constructor from angle = 0:
//    sin(0) = 0,  cos(0) = 1.
//  It is refreshed in update() right after the angle mutation so that
//  castRays(), which runs later the same frame, always sees current values.
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
//  Local variable caching for property chains
//  ───────────────────────────────────────────
//  Inside the collision block, this.pos.x / this.pos.y and
//  this.velocity.x / this.velocity.y are each accessed several
//  times per iteration across 3 iterations.  Each such access
//  is two pointer dereferences: this → pos → x.  Caching them
//  in local scalars (px, py, vx, vy) at the start of the block
//  and writing back to the object once after all 3 iterations
//  reduces those to single register reads — no hidden-class
//  lookup, no intermediate object pointer.  With 3 iterations,
//  each touching pos and velocity multiple times, this removes
//  roughly 30–40 property-chain reads per frame.
//
//  Indexed bucket iteration
//  ─────────────────────────
//  The inner segment loop previously used for…of on the Int16Array
//  returned by getSegments().  Replaced with an explicit indexed
//  for loop over a cached local const (segs / nSegs) for the same
//  reason as in renderer.js: eliminates iterator protocol overhead
//  and lets the JIT emit a tight counted loop.
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

    // Trig cache — sin and cos of this.angle.
    // Initialised here so castRays() can safely read them on the very
    // first frame before update() has run.  angle = 0 at construction
    // (set by Entity), so sin(0) = 0 and cos(0) = 1.
    this.sinA = 0;
    this.cosA = 1;
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

    // ── Refresh trig cache ──────────────────────────────────────
    // Must happen immediately after angle changes and before any
    // code this frame reads sinA / cosA — including the wish vector
    // below and castRays() later in the same RAF tick.
    // Two calls here replace 8 calls spread across player.js and
    // renderer.js that previously recomputed the same values.
    this.sinA = Math.sin(this.angle);
    this.cosA = Math.cos(this.angle);

    // ── World-space wish vector from WASD + facing angle ────────
    // Forward (fx, fy) and right (rx, ry) in world space.
    // Derived from the cached sin/cos — no trig calls here.
    //   forward: ( sinA, -cosA )
    //   right:   ( cosA,  sinA )
    const fx = this.sinA;
    const fy = -this.cosA;
    const rx = this.cosA;
    const ry = this.sinA;

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
    //
    // pos and velocity are cached as local scalars for the duration of
    // the collision block.  Each this.pos.x / this.velocity.x access is
    // two pointer dereferences (this → pos → x).  Local vars are single
    // register reads — no hidden-class traversal, no intermediate load.
    // The write-back after the loop restores the object state exactly once.
    const R = this.radius;
    let px = this.pos.x;
    let py = this.pos.y;
    let vx = this.velocity.x;
    let vy = this.velocity.y;

    for (let iter = 0; iter < 3; iter++) {

      // Bump generation to invalidate last iteration's tested flags.
      // Avoids clearing the whole array each iteration.
      if (++_colGen > 254) { _colTested.fill(0); _colGen = 1; }

      const tx = px | 0;
      const ty = py | 0;

      // Walk the 3 × 3 neighbourhood and resolve each unique segment once.
      // The nested loop visits up to 9 buckets; _colTested deduplicates
      // segments that appear in more than one of those buckets.
      //
      // getSegments() is hoisted into segs / nSegs so the call doesn't
      // repeat for each element, and the indexed for loop replaces for…of
      // to avoid iterator protocol overhead on the typed array.
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const segs = getSegments(tx + dx, ty + dy);
          const nSegs = segs.length;
          for (let si = 0; si < nSegs; si++) {
            const i = segs[si];

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
            let t = ((px - x1) * ex + (py - y1) * ey) / len2;
            t = Math.max(0, Math.min(1, t));

            const cpx = x1 + t * ex;
            const cpy = y1 + t * ey;
            const dpx = px - cpx;
            const dpy = py - cpy;
            const dist = Math.hypot(dpx, dpy);

            if (dist < R && dist > 1e-6) {
              // Contact normal — unit vector pointing away from the wall surface
              const overlap = R - dist;
              const invDist = 1 / dist;
              const nx = dpx * invDist;
              const ny = dpy * invDist;

              // Translate player out of penetration depth
              px += nx * overlap;
              py += ny * overlap;

              // Cancel only the velocity component directed into the wall.
              // The tangential component is preserved — this gives smooth
              // wall-sliding rather than a dead stop on contact.
              const vDotN = vx * nx + vy * ny;
              if (vDotN < 0) {
                vx -= vDotN * nx;
                vy -= vDotN * ny;
              }
            }
          }
        }
      }
    }

    // Write cached locals back to the object once after all 3 iterations.
    this.pos.x = px;
    this.pos.y = py;
    this.velocity.x = vx;
    this.velocity.y = vy;
  }
}

