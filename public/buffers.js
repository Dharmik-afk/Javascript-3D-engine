// ─────────────────────────────────────────────
//  buffer.js
//  Three-layer pixel buffer pipeline.
//
//  LAYER 0  bg     — sky + floor gradient, written once at startup
//  LAYER 1  world  — raycaster wall strips, cleared every frame
//  LAYER 2  hud    — drawn directly with ctx on top (not a buffer)
//
//  Uint32Array optimisations
//  ─────────────────────────
//  Each ImageData.data (Uint8ClampedArray) is aliased by a
//  Uint32Array view over the same ArrayBuffer.  This means:
//
//    putPixel  → 1 array write  (was 4 byte writes + function overhead)
//    clear()   → typed fill(0)  (was 4× byte fill over whole buffer)
//    flush()   → 1 uint32 read + 1 write per pixel, no float division
//
//  Pixel encoding (little-endian x86/ARM):
//    Uint32 = 0xAABBGGRR
//    data32[i] = (a << 24) | (b << 16) | (g << 8) | r
//    The >>> 0 suffix coerces to unsigned so stored values are
//    always non-negative — important for the flush() OR trick.
//
//  flush() compositing trick
//  ─────────────────────────
//  bg pixels are always fully opaque (alpha = 255, so value ≥ 0xFF000000).
//  world pixels are either fully opaque (wall hit) or zero (transparent miss).
//  So: output = world[i] || bg[i]
//  No floating-point blending needed — one bitwise OR per pixel.
// ─────────────────────────────────────────────

import { ctx, W, H } from './canvas.js';

function makeBuffer() {
  const img = ctx.createImageData(W, H);
  const data = img.data;                          // Uint8ClampedArray
  const data32 = new Uint32Array(data.buffer);      // aliased Uint32 view

  return {
    img,
    data,
    data32,

    clear() {
      data32.fill(0);
    },

    // Bounds-checked write — used by buildBackground() and any non-hot path.
    // Hot path (castRays strip loop) writes directly to data32.
    putPixel(x, y, r, g, b, a = 255) {
      x = x | 0; y = y | 0;
      if (x < 0 || x >= W || y < 0 || y >= H) return;
      data32[y * W + x] = ((a << 24) | (b << 16) | (g << 8) | r) >>> 0;
    },
  };
}

export const Buffers = (() => {
  const bg = makeBuffer();
  const world = makeBuffer();
  const composite = ctx.createImageData(W, H);
  const comp32 = new Uint32Array(composite.data.buffer);
  const bg32 = bg.data32;
  const w32 = world.data32;
  const len = comp32.length;   // W * H, constant

  function flush() {
    // Branchless composite: world pixel if present, else bg pixel.
    // Works because bg is always opaque (≥ 0xFF000000 → truthy) and
    // transparent world pixels are exactly 0 (falsy).
    for (let i = 0; i < len; i++) {
      comp32[i] = w32[i] || bg32[i];
    }
    ctx.putImageData(composite, 0, 0);
  }

  return { bg, world, flush };
})();

