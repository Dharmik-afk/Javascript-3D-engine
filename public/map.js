// ─────────────────────────────────────────────
//  map.js
//  Vector map: wall segments + spatial bucket grid.
//
//  Two representations of the same wall data are
//  exported, each optimised for its consumer:
//
//  WALLS (Array of objects)
//    Used by:  hud.js (minimap draw), bucket builder (below).
//    Why kept: makeRect / makePolygon push objects; rewriting
//              them to write directly into a typed array would
//              complicate the map-authoring API for zero runtime
//              gain — this array is only touched at startup.
//
//  WALLS_FLAT (Float32Array)
//    Used by:  renderer.js (castRays), player.js (collision).
//    Layout:   8 floats per segment — SEG_SIZE = 8:
//
//      offset  field    notes
//      ──────  ───────  ──────────────────────────────────────
//        0     x1       segment start X
//        1     y1       segment start Y
//        2     ex       x2 − x1  (precomputed direction vector)
//        3     ey       y2 − y1
//        4     absNY    |−ey / length|  (shading normal term)
//        5     r        red   0–255
//        6     g        green 0–255
//        7     b        blue  0–255
//
//    Field grouping is deliberate:
//      Offsets 0–3 are read together in every ray–segment
//      intersection test (the hot loop).
//      Offsets 4–7 are read together only on a confirmed hit
//      (once per column at most).
//      Both groups are exactly 4 × float32 = 16 bytes, so each
//      group fits in a single L1 cache-line fetch on any CPU
//      with ≥ 32-byte lines.  No cross-group prefetch needed.
//
//    Float32 precision: world coords max at 16, colours at 255,
//    absNY in [0, 1].  Float32 (~7 significant digits) is exact
//    for all values this map will ever contain.
//
//  BUCKETS (Int16Array per cell)
//    Spatial lookup grid.  Each cell stores indices into WALLS
//    (and equivalently into WALLS_FLAT — same index, same segment).
//    Populated once at startup by stepping along every segment.
//    Int16Array chosen over Set: typed-array for…of is a tight
//    counted loop in the JIT; Set iterator pays hash-map overhead
//    on every DDA step of every ray.
//
//  Public API
//  ──────────
//  WALLS        Array of segment objects (build-time shape)
//  WALLS_FLAT   Float32Array mirror    (runtime hot-path shape)
//  WALLS_COUNT  segment count          (= WALLS.length, frozen)
//  SEG_*        flat-array field offsets
//  SEG_SIZE     floats per segment (8)
//  WORLD_W/H    grid dimensions in tiles
//  makeRect(x, y, w, h, r, g, b)
//  makePolygon(points, colors)
//  getSegments(tx, ty) → Int16Array   O(1) bucket lookup
// ─────────────────────────────────────────────

export const WORLD_W = 16;
export const WORLD_H = 8;

// ── Flat-array field offsets (element index within one segment) ──
// Named constants prevent the "magic number" bugs that index
// arithmetic invites.  SEG_SIZE is the stride between segments.
export const SEG_X1 = 0;   // geometry group (hot: read every intersection)
export const SEG_Y1 = 1;
export const SEG_EX = 2;
export const SEG_EY = 3;
export const SEG_ABSNY = 4;   // appearance group (cold: read only on hit)
export const SEG_R = 5;
export const SEG_G = 6;
export const SEG_B = 7;
export const SEG_SIZE = 8;   // total floats per segment

// ── Build-time segment object array ─────────────────────────────
export const WALLS = [];

// ── Map-authoring helpers ────────────────────────────────────────

/**
 * Appends four axis-aligned segments forming a closed rectangle.
 * All sides share a single colour.
 * @param {number} x  top-left tile X
 * @param {number} y  top-left tile Y
 * @param {number} w  width  in tiles
 * @param {number} h  height in tiles
 * @param {number} r  red   0–255
 * @param {number} g  green 0–255
 * @param {number} b  blue  0–255
 */
export function makeRect(x, y, w, h, r, g, b) {
  WALLS.push(
    { x1: x, y1: y, x2: x + w, y2: y, r, g, b },  // top
    { x1: x + w, y1: y, x2: x + w, y2: y + h, r, g, b },  // right
    { x1: x + w, y1: y + h, x2: x, y2: y + h, r, g, b },  // bottom
    { x1: x, y1: y + h, x2: x, y2: y, r, g, b },  // left
  );
}

/**
 * Appends N segments from an ordered vertex list, closing back to
 * the first point.  One colour entry per segment (= per vertex).
 * @param {[number, number][]} points  vertex array
 * @param {{r:number, g:number, b:number}[]} colors  one per edge
 */
export function makePolygon(points, colors) {
  const n = points.length;
  for (let i = 0; i < n; i++) {
    const [x1, y1] = points[i];
    const [x2, y2] = points[(i + 1) % n];
    const { r, g, b } = colors[i];
    WALLS.push({ x1, y1, x2, y2, r, g, b });
  }
}

// ── Map definition ───────────────────────────────────────────────

// Perimeter — 16 × 8 world boundary
makeRect(0, 0, WORLD_W, WORLD_H, 120, 150, 210);

// Interior pillar — 2 × 2 box, warm orange
makeRect(3, 2, 2, 2, 210, 120, 60);

// Triangle — right area, one colour per face
makePolygon(
  [[11, 1], [14, 1], [14, 4]],
  [
    { r: 180, g: 80, b: 200 },   // top edge   — purple
    { r: 200, g: 180, b: 80 },   // right edge — gold
    { r: 80, g: 200, b: 160 },   // hypotenuse — teal
  ]
);

// Lone diagonal — centre-right, green
WALLS.push({ x1: 9, y1: 6, x2: 13, y2: 3, r: 80, g: 200, b: 100 });

// ── Precompute derived fields on the object array ─────────────────
// ex / ey    : direction vector — used in ray–segment and collision math.
// absNY      : |−ey / length|.  Equals the cosine of the angle between
//              the segment's outward normal and the horizontal axis.
//              0 for vertical walls (N/S faces), 1 for horizontal walls
//              (E/W faces) — mirrors the classic side-0/side-1 shading
//              convention from grid-based raycasters.
//              Precomputing here means Math.hypot() never runs in any
//              hot-path loop.
for (const seg of WALLS) {
  const ex = seg.x2 - seg.x1;
  const ey = seg.y2 - seg.y1;
  const len = Math.hypot(ex, ey) || 1;   // || 1 guards degenerate zero-length segments
  seg.ex = ex;
  seg.ey = ey;
  seg.absNY = Math.abs(-ey / len);
}

// ── Build WALLS_FLAT ─────────────────────────────────────────────
// Mirror of WALLS as a contiguous Float32Array.  Built once here at
// module-load time so renderer.js and player.js see a frozen, fully
// populated array on first import — no lazy-init null-checks needed.
// ensure WALLS is defined and SEG_SIZE is an integer
if (!Array.isArray(WALLS)) throw new TypeError('WALLS must be an array');
if (!Number.isInteger(SEG_SIZE) || SEG_SIZE < 0) throw new TypeError('SEG_SIZE must be a non-negative integer');

export const WALLS_COUNT = WALLS.length;               // number of walls
export const WALLS_FLAT = new Float32Array(WALLS_COUNT * SEG_SIZE); // element count

for (let i = 0; i < WALLS_COUNT; i++) {
  const s = WALLS[i];
  const base = i * SEG_SIZE;
  WALLS_FLAT[base + SEG_X1] = s.x1;
  WALLS_FLAT[base + SEG_Y1] = s.y1;
  WALLS_FLAT[base + SEG_EX] = s.ex;
  WALLS_FLAT[base + SEG_EY] = s.ey;
  WALLS_FLAT[base + SEG_ABSNY] = s.absNY;
  WALLS_FLAT[base + SEG_R] = s.r;
  WALLS_FLAT[base + SEG_G] = s.g;
  WALLS_FLAT[base + SEG_B] = s.b;
}

// ── Bucket grid — Phase 1: build via Sets (dedup during insertion) ─
// Walking 0.5-tile steps along each segment ensures that no cell a
// segment passes through is missed, even for long diagonal segments.
const _sets = Array.from({ length: WORLD_W * WORLD_H }, () => new Set());

for (let i = 0; i < WALLS_COUNT; i++) {
  const { x1, y1, x2, y2 } = WALLS[i];
  const dx = x2 - x1;
  const dy = y2 - y1;
  const steps = Math.ceil(Math.hypot(dx, dy) / 0.5);

  for (let s = 0; s <= steps; s++) {
    const t = steps === 0 ? 0 : s / steps;
    const tx = Math.floor(x1 + dx * t);
    const ty = Math.floor(y1 + dy * t);
    // Clamp to valid grid range before storing
    const cx = Math.min(Math.max(tx, 0), WORLD_W - 1);
    const cy = Math.min(Math.max(ty, 0), WORLD_H - 1);
    _sets[cy * WORLD_W + cx].add(i);
  }
}

// ── Bucket grid — Phase 2: freeze Sets → Int16Arrays ──────────────
// for…of over a typed array compiles to a tight counted loop in V8/SpiderMonkey.
// for…of over a Set pays iterator-protocol + hash-map traversal overhead on
// every DDA step of every ray — unacceptable in a function called 800× per frame.
// The Sets are discarded after this; only the typed arrays survive at runtime.
const _buckets = _sets.map(s => new Int16Array(s));
const _empty = new Int16Array(0);   // returned for out-of-bounds queries — avoids null checks in callers

/**
 * Returns the Int16Array of wall indices registered in tile (tx, ty).
 * Returns an empty array (not null) for out-of-bounds coordinates so
 * callers never need a null-check before iterating.
 * O(1) — direct array index calculation.
 * @param {number} tx  tile X
 * @param {number} ty  tile Y
 * @returns {Int16Array}
 */
export function getSegments(tx, ty) {
  if (tx < 0 || tx >= WORLD_W || ty < 0 || ty >= WORLD_H) return _empty;
  return _buckets[ty * WORLD_W + tx];
}

