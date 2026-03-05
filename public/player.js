// ─────────────────────────────────────────────
//  player.js
//  Player state, movement physics, and
//  segment-normal push-out collision.
//
//  Extends Entity for shared pos, angle,
//  velocity, and radius.
//
//  Collision algorithm (runs 3 iterations / frame):
//    1. Apply velocity to position unconditionally.
//    2. Gather unique segment indices from the 3×3
//       bucket neighbourhood around the player.
//    3. For each segment, find the closest point on
//       the segment to the player centre.
//    4. If dist < radius, push the player out along
//       the contact normal and remove the velocity
//       component directed into the wall — giving
//       true wall-normal sliding on any geometry.
//
//  All coordinates are tile-space floats.
// ─────────────────────────────────────────────

import { Entity } from './entity.js';
import { WALLS, getSegments } from './map.js';

export class Player extends Entity {
  static FRICTION = 0.82;
  static ACCEL = 0.04;    // tiles / frame²
  static LOOK_SENSITIVITY = 0.007;   // radians per drag-pixel

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
    this.angle += this.lookDeltaX * Player.LOOK_SENSITIVITY;
    this.lookDeltaX = 0;

    // ── Build world-space wish vector from WASD + facing angle ──
    const fx = Math.sin(this.angle);
    const fy = -Math.cos(this.angle);
    const rx = Math.cos(this.angle);
    const ry = Math.sin(this.angle);

    const wx = fx * (-this.input.y) + rx * this.input.x;
    const wy = fy * (-this.input.y) + ry * this.input.x;

    const wlen = Math.hypot(wx, wy) || 1;
    const inx = (wx !== 0 || wy !== 0) ? wx / wlen : 0;
    const iny = (wx !== 0 || wy !== 0) ? wy / wlen : 0;

    this.velocity.x = (this.velocity.x + inx * Player.ACCEL) * Player.FRICTION;
    this.velocity.y = (this.velocity.y + iny * Player.ACCEL) * Player.FRICTION;

    // Kill sub-pixel drift when no input is held
    if (!this.input.x && !this.input.y &&
      Math.hypot(this.velocity.x, this.velocity.y) < 0.001) {
      this.velocity.x = 0;
      this.velocity.y = 0;
    }

    // ── Apply velocity ──────────────────────────────────────────
    this.pos.x += this.velocity.x;
    this.pos.y += this.velocity.y;

    // ── Segment push-out collision (3 iterations) ───────────────
    //   Multiple iterations resolve corner cases where two walls
    //   are simultaneously penetrated (e.g. tight corridor ends).
    const R = this.radius;

    for (let iter = 0; iter < 3; iter++) {
      const tx = this.pos.x | 0;
      const ty = this.pos.y | 0;

      // Gather unique segment indices from 3×3 bucket neighbourhood.
      // Using a Set prevents re-processing the same segment when it
      // appears in more than one of the nine buckets.
      const seen = new Set();
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          for (const i of getSegments(tx + dx, ty + dy)) {
            seen.add(i);
          }
        }
      }

      for (const i of seen) {
        const seg = WALLS[i];
        const ex = seg.x2 - seg.x1;
        const ey = seg.y2 - seg.y1;
        const len2 = ex * ex + ey * ey;
        if (len2 < 1e-10) continue;   // degenerate segment

        // Closest point on segment to player centre (clamped t)
        let t = ((this.pos.x - seg.x1) * ex + (this.pos.y - seg.y1) * ey) / len2;
        t = Math.max(0, Math.min(1, t));

        const cpx = seg.x1 + t * ex;
        const cpy = seg.y1 + t * ey;

        const dpx = this.pos.x - cpx;
        const dpy = this.pos.y - cpy;
        const dist = Math.hypot(dpx, dpy);

        if (dist < R && dist > 1e-6) {
          const overlap = R - dist;
          const invDist = 1 / dist;
          const nx = dpx * invDist;   // contact normal (away from wall)
          const ny = dpy * invDist;

          // Push position out of wall
          this.pos.x += nx * overlap;
          this.pos.y += ny * overlap;

          // Remove the velocity component directed into the wall.
          // Leaves the tangential component intact → wall sliding.
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

