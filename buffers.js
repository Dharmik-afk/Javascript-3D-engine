// ─────────────────────────────────────────────
//  buffers.js
//  Three-layer pixel buffer pipeline.
//
//  LAYER 0  bg     — sky + floor gradient, written once at startup
//  LAYER 1  world  — raycaster wall strips, cleared every frame
//  LAYER 2  hud    — drawn directly with ctx on top (not a buffer)
//
//  flush() alpha-blends world over bg into a single composite
//  ImageData and calls ctx.putImageData once per frame.
// ─────────────────────────────────────────────

import { ctx, W, H } from './canvas.js';

function makeBuffer() {
  const img  = ctx.createImageData(W, H);
  const data = img.data;
  return {
    img,
    data,
    clear() { data.fill(0); },
    putPixel(x, y, r, g, b, a = 255) {
      x = x | 0; y = y | 0;
      if (x < 0 || x >= W || y < 0 || y >= H) return;
      const i = (y * W + x) * 4;
      data[i]     = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = a;
    },
  };
}

const bg        = makeBuffer();   // layer 0
const world     = makeBuffer();   // layer 1
const composite = ctx.createImageData(W, H);

function flush() {
  const out = composite.data;
  const b   = bg.data;
  const w   = world.data;

  for (let i = 0; i < out.length; i += 4) {
    const wa = w[i + 3] / 255;
    const ba = b[i + 3] / 255;
    const oa = wa + ba * (1 - wa);

    if (oa === 0) {
      out[i] = out[i + 1] = out[i + 2] = out[i + 3] = 0;
    } else {
      out[i]     = (w[i]     * wa + b[i]     * ba * (1 - wa)) / oa;
      out[i + 1] = (w[i + 1] * wa + b[i + 1] * ba * (1 - wa)) / oa;
      out[i + 2] = (w[i + 2] * wa + b[i + 2] * ba * (1 - wa)) / oa;
      out[i + 3] = oa * 255;
    }
  }
  ctx.putImageData(composite, 0, 0);
}

export const Buffers = { bg, world, flush };
