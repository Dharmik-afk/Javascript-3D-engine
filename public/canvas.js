// ─────────────────────────────────────────────
//  canvas.js
//  Single source of truth for the canvas element,
//  2-D rendering context, and immutable dimensions.
//
//  The internal pixel buffer is fixed at 800 × 400
//  regardless of device pixel ratio.  A raycaster
//  gains nothing from DPR scaling — every column
//  is already 1 pixel wide, and going from 800 to
//  1600 columns quadruples the workload for no
//  visible improvement.
//
//  CSS handles all display scaling (width: 100%;
//  aspect-ratio: 2/1; image-rendering: pixelated).
//  The browser stretches the 800 × 400 buffer to
//  fill whatever size the element occupies.
//
//  DPR is still exported so hud.js can optionally
//  use it for sharp ctx text via ctx.scale(), but
//  the pixel buffer always stays at W × H.
// ─────────────────────────────────────────────

export const c = document.querySelector('#c');
export const ctx = c.getContext('2d');
export const DPR = window.devicePixelRatio || 1;

export const W = 800;
export const H = 400;

c.width = W;
c.height = H;

