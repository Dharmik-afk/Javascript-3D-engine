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
//  call init(player) once after the player is
//  created to attach the look-drag accumulator.
// ─────────────────────────────────────────────

import { c }        from './canvas.js';
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

// ── WASD on-screen pad ───────────────────────────────────────────
function setupKeyInteraction(keyEl) {
  let mouseActive = false;
  const activeTouches = new Set();
  const touchesInside = new Set();
  const isPressed     = () => mouseActive || touchesInside.size > 0;

  function updateState(source) {
    isPressed() ? pressKey(keyEl, source) : releaseKey(keyEl);
  }

  keyEl.addEventListener('mousedown',  () => { mouseActive = true;  updateState('mouse'); });
  keyEl.addEventListener('mouseup',    () => { mouseActive = false; updateState(); });
  keyEl.addEventListener('mouseleave', () => { mouseActive = false; updateState(); });

  keyEl.addEventListener('touchstart', e => {
    e.preventDefault();
    for (const t of e.changedTouches) {
      activeTouches.add(t.identifier);
      touchesInside.add(t.identifier);
    }
    updateState('touch');
  }, { passive: false });

  document.addEventListener('touchmove', e => {
    const rect = keyEl.getBoundingClientRect();
    for (const t of e.changedTouches) {
      if (!activeTouches.has(t.identifier)) continue;
      const inside = t.clientX >= rect.left && t.clientX <= rect.right &&
                     t.clientY >= rect.top  && t.clientY <= rect.bottom;
      inside ? touchesInside.add(t.identifier) : touchesInside.delete(t.identifier);
    }
    updateState();
  }, { passive: true });

  function handleTouchEnd(e) {
    for (const t of e.changedTouches) {
      activeTouches.delete(t.identifier);
      touchesInside.delete(t.identifier);
    }
    updateState();
  }
  document.addEventListener('touchend',    handleTouchEnd, { passive: true });
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
  // Attach WASD pad to every .key element
  document.querySelectorAll('.key').forEach(setupKeyInteraction);

  // Wire EventBus → player methods
  EventBus.on('keypress',  ({ key }) => player.onKeyDown(key));
  EventBus.on('keyrelease',({ key }) => player.onKeyUp(key));

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
  c.addEventListener('touchend',    clearLook, { passive: true });
  c.addEventListener('touchcancel', clearLook, { passive: true });
}
