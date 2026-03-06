// ─────────────────────────────────────────────
//  hud.js
//  HUD layer — drawn directly with ctx on top of
//  the composited pixel buffers (layer 2).
//
//  ctx coordinates are in canvas pixel space
//  (0..W, 0..H = 0..800, 0..400).  No DPR
//  scaling needed — the canvas is fixed 800×400
//  and CSS handles all display scaling.
//
//  drawMinimap(player)
//    Top-right corner: world bounds background,
//    wall segments, player dot, facing line,
//    and FOV cone.
//
//  drawDebug(player, fps)
//    Top-left corner numeric readout.
//
//  toggleBuckets()
//    Call from devtools console to toggle bucket
//    grid overlay on the minimap.
//    Occupied cells — flat blue-white tint.
//    Player's current cell — flat red tint.
//    Grid lines always drawn when overlay is on.
// ─────────────────────────────────────────────

import { ctx, W } from './canvas.js';
import {
  WALLS, WORLD_W, WORLD_H,
  getSegments
} from './map.js';

// Minimap layout constants
const MM_TILE = 10;
const MM_PAD = 8;
const MM_X = W - WORLD_W * MM_TILE - MM_PAD;
const MM_Y = MM_PAD;

// ── Bucket visualisation toggle ──────────────────────────────────
let _showBuckets = false;
export function toggleBuckets() {
  _showBuckets = !_showBuckets;
  console.log(`[hud] bucket overlay: ${_showBuckets ? 'ON' : 'OFF'}`);
}

export function drawMinimap(player) {
  // ── World bounds background ─────────────────────────────────
  ctx.fillStyle = '#0c0c1c';
  ctx.fillRect(MM_X, MM_Y, WORLD_W * MM_TILE, WORLD_H * MM_TILE);

  // ── Bucket overlay ───────────────────────────────────────────
  if (_showBuckets) {
    const playerTX = player.pos.x | 0;
    const playerTY = player.pos.y | 0;

    for (let ty = 0; ty < WORLD_H; ty++) {
      for (let tx = 0; tx < WORLD_W; tx++) {
        const occupied = getSegments(tx, ty).size > 0;

        if (tx === playerTX && ty === playerTY) {
          ctx.fillStyle = 'rgba(255, 80, 80, 0.35)';
          ctx.fillRect(MM_X + tx * MM_TILE, MM_Y + ty * MM_TILE, MM_TILE, MM_TILE);
        } else if (occupied) {
          ctx.fillStyle = 'rgba(120, 160, 255, 0.25)';
          ctx.fillRect(MM_X + tx * MM_TILE, MM_Y + ty * MM_TILE, MM_TILE, MM_TILE);
        }
      }
    }

    ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
    ctx.lineWidth = 0.5;
    for (let tx = 0; tx <= WORLD_W; tx++) {
      ctx.beginPath();
      ctx.moveTo(MM_X + tx * MM_TILE, MM_Y);
      ctx.lineTo(MM_X + tx * MM_TILE, MM_Y + WORLD_H * MM_TILE);
      ctx.stroke();
    }
    for (let ty = 0; ty <= WORLD_H; ty++) {
      ctx.beginPath();
      ctx.moveTo(MM_X, MM_Y + ty * MM_TILE);
      ctx.lineTo(MM_X + WORLD_W * MM_TILE, MM_Y + ty * MM_TILE);
      ctx.stroke();
    }
  }

  // ── Wall segments ────────────────────────────────────────────
  ctx.strokeStyle = '#5868bb';
  ctx.lineWidth = 1.5;
  for (const seg of WALLS) {
    ctx.beginPath();
    ctx.moveTo(MM_X + seg.x1 * MM_TILE, MM_Y + seg.y1 * MM_TILE);
    ctx.lineTo(MM_X + seg.x2 * MM_TILE, MM_Y + seg.y2 * MM_TILE);
    ctx.stroke();
  }

  // Player position in minimap pixel space
  const pdx = MM_X + player.pos.x * MM_TILE;
  const pdy = MM_Y + player.pos.y * MM_TILE;

  // ── FOV cone (±30° from facing angle) ───────────────────────
  ctx.strokeStyle = 'rgba(100, 180, 255, 0.30)';
  ctx.lineWidth = 1;
  for (const offset of [-Math.PI / 6, Math.PI / 6]) {
    const a = player.angle + offset;
    ctx.beginPath();
    ctx.moveTo(pdx, pdy);
    ctx.lineTo(pdx + Math.sin(a) * 28, pdy - Math.cos(a) * 28);
    ctx.stroke();
  }

  // ── Facing direction line ────────────────────────────────────
  ctx.strokeStyle = '#ff5555';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(pdx, pdy);
  ctx.lineTo(
    pdx + Math.sin(player.angle) * 14,
    pdy - Math.cos(player.angle) * 14
  );
  ctx.stroke();

  // ── Player dot ───────────────────────────────────────────────
  ctx.fillStyle = '#ff5555';
  ctx.beginPath();
  ctx.arc(pdx, pdy, 3, 0, Math.PI * 2);
  ctx.fill();
}

export function drawDebug(player, fps) {
  ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
  ctx.fillRect(8, 8, 220, 88);

  ctx.fillStyle = '#4af';
  ctx.font = 'bold 11px Consolas, monospace';
  ctx.fillText('── DEBUG ──────────────────', 16, 24);

  ctx.fillStyle = '#7bcfff';
  ctx.font = '12px Consolas, monospace';
  ctx.fillText(`pos  ${player.pos.x.toFixed(2)},  ${player.pos.y.toFixed(2)}`, 16, 42);
  ctx.fillText(`vel  ${player.velocity.x.toFixed(3)},  ${player.velocity.y.toFixed(3)}`, 16, 58);
  ctx.fillText(`ang  ${(player.angle % (Math.PI * 2)).toFixed(3)} rad`, 16, 74);
  ctx.fillText(`fps  ${fps}`, 16, 90);
}

