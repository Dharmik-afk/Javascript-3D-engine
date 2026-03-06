// ─────────────────────────────────────────────
//  map.js
//  Vector map: walls as line segments + uniform
//  bucket grid for spatial queries.
//
//  WALLS   — array of { x1, y1, x2, y2, r, g, b, ex, ey, absNY }
//  BUCKETS — WORLD_W × WORLD_H grid; each cell is an Int16Array
//            of indices into WALLS.
//
//  Why Int16Array instead of Set?
//    Buckets are populated once at startup and never mutated.
//    for...of over a Set pays iterator-protocol + hash-map overhead
//    on every DDA step for every ray.  A typed array avoids both —
//    the JIT can compile it to a tight counted loop with no object
//    allocation and better cache locality.  Int16 is sufficient
//    because WALLS.length will never approach 32 767 in practice.
//
//  Precomputed per-segment fields (set after all walls are defined):
//    ex    = x2 - x1
//    ey    = y2 - y1
//    absNY = abs(-ey / length)  — used for normal-based wall shading.
//            Equals the cosine of the angle between the segment normal
//            and the horizontal axis.  Constant per wall so computing
//            it inside castRays() every frame is pure waste.
//
//  Helpers:
//    makeRect(x, y, w, h, r, g, b)
//      Appends 4 axis-aligned segments (top, right,
//      bottom, left) all sharing one colour.
//
//    makePolygon(points, colors)
//      Appends N segments connecting points in order,
//      closing back to the first point.
//      points : [[x, y], ...]
//      colors : [{ r, g, b }, ...]  — one per segment.
//      colors.length must equal points.length.
//
//  Buckets are populated at module-load time by
//  stepping 0.5 tile-units along every segment and
//  recording each visited cell.  No external build
//  call needed.
//
//  getSegments(tx, ty) — O(1) bucket lookup;
//  returns an empty Int16Array for out-of-bounds coords.
// ─────────────────────────────────────────────

export const WORLD_W = 16;
export const WORLD_H = 8;

// ── Segment array ────────────────────────────────────────────────
export const WALLS = [];

// ── Helpers ──────────────────────────────────────────────────────

// Appends a closed axis-aligned rectangle as 4 segments.
// All four sides share the same colour.
export function makeRect(x, y, w, h, r, g, b) {
  WALLS.push(
    { x1: x, y1: y, x2: x + w, y2: y, r, g, b },  // top
    { x1: x + w, y1: y, x2: x + w, y2: y + h, r, g, b },  // right
    { x1: x + w, y1: y + h, x2: x, y2: y + h, r, g, b },  // bottom
    { x1: x, y1: y + h, x2: x, y2: y, r, g, b },  // left
  );
}

// Appends N segments from an array of [x, y] vertices.
// Closes automatically: last point connects back to first.
// colors : [{ r, g, b }, ...] — one entry per segment (= per vertex).
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

// Border walls — perimeter of the 16 × 8 world
makeRect(0, 0, 16, 8, 120, 150, 210);

// Interior pillar — 2×2 box, left-centre area, warm orange
makeRect(3, 2, 2, 2, 210, 120, 60);

// Triangle — right area, one colour per face
makePolygon(
  [[11, 1], [14, 1], [14, 4]],
  [
    { r: 180, g: 80, b: 200 },  // top edge     — purple
    { r: 200, g: 180, b: 80 },  // right edge   — gold
    { r: 80, g: 200, b: 160 },  // hypotenuse   — teal
  ]
);

// Lone diagonal — crosses centre-right, green
WALLS.push({ x1: 9, y1: 6, x2: 13, y2: 3, r: 80, g: 200, b: 100 });

// ── Precompute derived fields ─────────────────────────────────────
// Done once here so renderer.js never pays for these in the hot path.
// ex / ey   : segment direction vector — used in ray-segment intersection.
// absNY     : abs of the segment normal's Y component, normalised.
//             Drives the surface-angle shading term in castRays().
//             Formula: abs(-ey / length).  For axis-aligned walls this
//             is exactly 0 (vertical) or 1 (horizontal), matching the
//             classic side-0/side-1 bright/dark convention.
for (const seg of WALLS) {
  const ex = seg.x2 - seg.x1;
  const ey = seg.y2 - seg.y1;
  const len = Math.hypot(ex, ey) || 1;
  seg.ex = ex;
  seg.ey = ey;
  seg.absNY = Math.abs(-ey / len);
}

// ── Bucket grid ──────────────────────────────────────────────────
// Phase 1: populate with Sets (fast insertion, automatic dedup during build)
const _sets = Array.from({ length: WORLD_W * WORLD_H }, () => new Set());

for (let i = 0; i < WALLS.length; i++) {
  const { x1, y1, x2, y2 } = WALLS[i];
  const dx = x2 - x1;
  const dy = y2 - y1;
  const steps = Math.ceil(Math.hypot(dx, dy) / 0.5);

  for (let s = 0; s <= steps; s++) {
    const t = steps === 0 ? 0 : s / steps;
    const tx = Math.floor(x1 + dx * t);
    const ty = Math.floor(y1 + dy * t);
    const cx = Math.min(Math.max(tx, 0), WORLD_W - 1);
    const cy = Math.min(Math.max(ty, 0), WORLD_H - 1);
    _sets[cy * WORLD_W + cx].add(i);
  }
}

// Phase 2: freeze each Set into an Int16Array.
// for...of over a typed array is a tight counted loop in the JIT —
// no iterator-protocol overhead, no hash-map traversal per step.
// The Sets are discarded after this point; only typed arrays survive.
const _buckets = _sets.map(s => new Int16Array(s));
const _empty = new Int16Array(0);

// ── Public query ─────────────────────────────────────────────────
export function getSegments(tx, ty) {
  if (tx < 0 || tx >= WORLD_W || ty < 0 || ty >= WORLD_H) return _empty;
  return _buckets[ty * WORLD_W + tx];
}

