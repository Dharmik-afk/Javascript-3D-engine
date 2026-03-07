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
//
//  Optimisations over the original
//  ─────────────────────────────────
//  KEY_ELS pre-cache (init-time)
//    getKeyEl() previously called document.querySelector() on every
//    physical keydown/keyup — a live DOM walk each time.  KEY_ELS is
//    a plain object populated once in init(), mapping 'w'/'a'/'s'/'d'
//    to the four element references.  Runtime lookups are O(1) property
//    reads with no DOM involvement.
//
//  EventBus payload trimming
//    Both pressKey and releaseKey previously emitted
//    { key, source, timestamp: Date.now() }.  player.onKeyDown /
//    onKeyUp destructure only { key } — source and timestamp were never
//    read by any subscriber.  Removed both fields:
//      • Eliminates Date.now() call (syscall) per key event.
//      • Shrinks the emitted object from 3 fields to 1, reducing
//        hidden-class churn and allocation size.
//    The source parameter is retained in pressKey's signature for
//    potential future use (e.g. replay recording) but is no longer
//    included in the emitted payload.
// ─────────────────────────────────────────────

import { c } from './canvas.js';
import { EventBus } from './eventbus.js';

// ── Internal key state ───────────────────────────────────────────
const keyMap = {};

// Populated in init() — maps lowercase key char → DOM element.
// Avoids document.querySelector() on every physical keydown/keyup.
const KEY_ELS = {};

function getKeyEl(k) {
  return KEY_ELS[k.toLowerCase()] ?? null;
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
  // source is available here if needed by future subscribers (e.g. replay),
  // but omitted from the payload — no current subscriber reads it.
  EventBus.emit('keypress', { key: k.toUpperCase() });
}

function releaseKey(keyEl) {
  if (!keyEl) return;
  const k = keyEl.dataset.key;
  if (!keyMap[k]) return;
  keyMap[k] = false;
  keyEl.classList.remove('pressed');
  EventBus.emit('keyrelease', { key: k.toUpperCase() });
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
  // Pre-cache the four key elements by their data-key attribute.
  // Replaces the per-event document.querySelector() call in getKeyEl()
  // with a single O(1) object property lookup.
  document.querySelectorAll('.key').forEach(el => {
    KEY_ELS[el.dataset.key] = el;
    setupKeyMouse(el);
  });

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

