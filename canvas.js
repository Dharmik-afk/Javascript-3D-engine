// ─────────────────────────────────────────────
//  canvas.js
//  Single source of truth for the canvas element,
//  2-D rendering context, and immutable dimensions.
//
//  Every other module that needs W / H or ctx
//  imports from here — nothing touches the DOM
//  directly for canvas access.
// ─────────────────────────────────────────────

export const c   = document.querySelector('#c');
export const ctx = c.getContext('2d');
export const W   = c.width;
export const H   = c.height;
