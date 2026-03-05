// ─────────────────────────────────────────────
//  main.js
//  Entry point.  Wires all modules together and
//  owns the single requestAnimationFrame loop.
//
//  Nothing in here should contain game logic —
//  it only calls into the appropriate modules.
// ─────────────────────────────────────────────

import { Buffers } from './buffers.js';
import { Player } from './player.js';
import { init as initInput } from './input.js';
import { buildBackground, castRays } from './renderer.js';
import { drawMinimap, drawDebug } from './hud.js';

// ── Debug flags ──────────────────────────────────────────────────
const SHOW_BUCKETS = false;   // true → bucket grid overlay on minimap

// ── Bootstrap ────────────────────────────────────────────────────
const player = new Player(8.5, 4.5);
initInput(player);       // attaches WASD pad, keyboard, look-drag
buildBackground();       // writes sky + floor into Buffers.bg once

// ── FPS counter state ────────────────────────────────────────────
let fps = 0;
let frames = 0;
let lastFpsTime = performance.now();

// ── Render ───────────────────────────────────────────────────────
function render() {
  // Layer 1 — world: clear pixel buffer, cast rays
  Buffers.world.clear();
  castRays(player);

  // Composite layers 0 (sky/floor) + 1 (walls) → canvas
  Buffers.flush();

  // Layer 2 — HUD: ctx drawn on top of the composited image
  drawMinimap(player, SHOW_BUCKETS);
  drawDebug(player, fps);
}

// ── Engine loop ──────────────────────────────────────────────────
function engine(ts) {
  // FPS counter — updates once per second
  frames++;
  if (ts - lastFpsTime >= 1000) {
    fps = frames;
    frames = 0;
    lastFpsTime = ts;
  }

  player.update();
  render();
  requestAnimationFrame(engine);
}

requestAnimationFrame(engine);

