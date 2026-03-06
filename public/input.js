// ─────────────────────────────────────────────
//  input.js
//  All user-input wiring in one place:
//    • WASD on-screen pad  (mouse + touch)
//    • Physical keyboard   (keydown / keyup)
//    • Canvas look-drag    (touch, delta-based)
//
//  Key events are published through EventBus so
//  no other module needs to import input.js
//  directly — they just subscribe.
//
//  Touch pad uses a global drag tracker so that
//  dragging from one key to another correctly
//  releases the old key and presses the new one.
//  Two Maps drive this:
//    touchKeyMap : touchId  → keyEl currently held (or null)
//    keyTouches  : keyEl    → Set of touchIds pressing it
//  A key is only released once all fingers leave it.
//
//  call init(player) once after the player is
//  created to attach the look-drag accumulator.
// ─────────────────────────────────────────────

import { c } from './canvas.js';
import { EventBus } from './eventbus.js';

// ── Internal key state ───────────────────────────────────────────
const keyMap = {};

function getKeyEl(k) {
  return document.querySelector(`.key[data-key="${k.toLowerCase()}"]`);
}

function pressKey(keyEl, source) {
  if (!keyEl) return;
  const k = keyEl.dataset.key;
  if (keyMap[k]) return;
  keyMap[k] = true;
  keyEl.classList.add('pressed');
  const ripple = document.createElement('div');
  ripple.className = 'ripple';
  keyEl.appendChild(ripple);
  ripple.addEventListener('animationend', () => ripple.remove());
  EventBus.emit('keypress', { key: k.toUpperCase(), source, timestamp: Date.now() });
}

function releaseKey(keyEl) {
  if (!keyEl) return;
  const k = keyEl.dataset.key;
  if (!keyMap[k]) return;
  keyMap[k] = false;
  keyEl.classList.remove('pressed');
  EventBus.emit('keyrelease', { key: k.toUpperCase(), timestamp: Date.now() });
}

// ── WASD on-screen pad — mouse ───────────────────────────────────
//   Mouse doesn't need cross-key drag, so per-element listeners are fine.
function setupKeyMouse(keyEl) {
  keyEl.addEventListener('mousedown', () => pressKey(keyEl, 'mouse'));
  keyEl.addEventListener('mouseup', () => releaseKey(keyEl));
  keyEl.addEventListener('mouseleave', () => releaseKey(keyEl));
}

// ── WASD on-screen pad — touch (global, cross-key drag) ──────────
//   touchKeyMap : touchId → keyEl currently pressed by this touch (null if none)
//   keyTouches  : keyEl   → Set of touchIds currently pressing it
//   A key fires releaseKey only when its Set empties — handles two-finger same-key correctly.
const touchKeyMap = new Map();
const keyTouches = new Map();

function getKeyAtPoint(x, y) {
  const el = document.elementFromPoint(x, y);
  return el ? el.closest('.key') : null;
}

function touchPressKey(keyEl, touchId) {
  if (!keyTouches.has(keyEl)) keyTouches.set(keyEl, new Set());
  keyTouches.get(keyEl).add(touchId);
  pressKey(keyEl, 'touch');
}

function touchReleaseKey(keyEl, touchId) {
  const set = keyTouches.get(keyEl);
  if (!set) return;
  set.delete(touchId);
  if (set.size === 0) {
    keyTouches.delete(keyEl);
    releaseKey(keyEl);
  }
}

function setupPadTouch() {
  // touchstart — only intercept touches that land on a .key element
  document.addEventListener('touchstart', e => {
    for (const t of e.changedTouches) {
      const keyEl = getKeyAtPoint(t.clientX, t.clientY);
      if (!keyEl) continue;
      e.preventDefault();                          // suppress scroll / tap-highlight
      touchKeyMap.set(t.identifier, keyEl);
      touchPressKey(keyEl, t.identifier);
    }
  }, { passive: false });

  // touchmove — swap press to whatever key the finger is now over
  document.addEventListener('touchmove', e => {
    let handled = false;

    for (const t of e.changedTouches) {
      if (!touchKeyMap.has(t.identifier)) continue;
      handled = true;

      const prevKey = touchKeyMap.get(t.identifier);
      const nextKey = getKeyAtPoint(t.clientX, t.clientY);

      if (nextKey === prevKey) continue;           // still on same key — nothing to do

      if (prevKey) touchReleaseKey(prevKey, t.identifier);
      if (nextKey) touchPressKey(nextKey, t.identifier);
      touchKeyMap.set(t.identifier, nextKey ?? null);
    }

    if (handled) e.preventDefault();
  }, { passive: false });

  function handleTouchEnd(e) {
    for (const t of e.changedTouches) {
      const keyEl = touchKeyMap.get(t.identifier);
      if (keyEl) touchReleaseKey(keyEl, t.identifier);
      touchKeyMap.delete(t.identifier);
    }
  }
  document.addEventListener('touchend', handleTouchEnd, { passive: true });
  document.addEventListener('touchcancel', handleTouchEnd, { passive: true });
}

// ── Physical keyboard ────────────────────────────────────────────
const WASD = new Set(['w', 'a', 's', 'd']);

document.addEventListener('keydown', e => {
  if (!WASD.has(e.key.toLowerCase()) || e.repeat) return;
  pressKey(getKeyEl(e.key), 'keyboard');
});

document.addEventListener('keyup', e => {
  if (!WASD.has(e.key.toLowerCase())) return;
  releaseKey(getKeyEl(e.key));
});

// ── Canvas look-drag (touch, delta-based) ────────────────────────
//   lookState maps touchId → lastClientX.
//   Each touchmove accumulates the delta into player.lookDeltaX;
//   Player.update() consumes and resets it every frame.
const lookState = new Map();

export function init(player) {
  // Attach mouse handlers to every .key element
  document.querySelectorAll('.key').forEach(setupKeyMouse);

  // Attach global touch handler for cross-key drag
  setupPadTouch();

  // Wire EventBus → player methods
  EventBus.on('keypress', ({ key }) => player.onKeyDown(key));
  EventBus.on('keyrelease', ({ key }) => player.onKeyUp(key));

  // Canvas touch-look
  c.addEventListener('touchstart', e => {
    e.preventDefault();
    for (const t of e.changedTouches) lookState.set(t.identifier, t.clientX);
  }, { passive: false });

  c.addEventListener('touchmove', e => {
    e.preventDefault();
    for (const t of e.changedTouches) {
      if (!lookState.has(t.identifier)) continue;
      player.lookDeltaX += t.clientX - lookState.get(t.identifier);
      lookState.set(t.identifier, t.clientX);
    }
  }, { passive: false });

  function clearLook(e) {
    for (const t of e.changedTouches) lookState.delete(t.identifier);
  }
  c.addEventListener('touchend', clearLook, { passive: true });
  c.addEventListener('touchcancel', clearLook, { passive: true });
}

