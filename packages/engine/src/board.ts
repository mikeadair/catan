// Board generation and pure geometry helpers.
// Zero Firebase/React imports. Deterministic given a seed.

import type {
  AxialCoord,
  Board,
  EdgeId,
  EdgeInfo,
  HexTile,
  MapPresetId,
  Port,
  PortType,
  Terrain,
  VertexId,
  VertexInfo,
} from './types';
import { createRng, shuffle } from './rng';

// ---------------------------------------------------------------------------
// Regular "hexagon of hexes" of a given radius, top to bottom, left to right.
// radius=2 (19 tiles, rows of 3,4,5,4,3) is the standard board; radius=4 (61
// tiles, rows of 5,6,7,8,9,8,7,6,5 — i.e. 1 + 6 + 12 + 18 + 24) is the
// fog-of-war board. Its outer two rings (ring 4 + ring 3, 42 hexes) are
// always revealed and together form 6 radial "oasis" wedges of real
// resource terrain (each spanning both rings, not confined to one — see
// FOG_OASIS_TERRAIN_POOL), divided from each other by 6 desert corridors
// that likewise run all the way through both rings (one ring-4 + one ring-3
// hex each, radially lined up — see fogOuterRingLayout/
// fogContinuationIndices). Rings 2 and 1 (18 hexes total, around the gold
// center) stay fully hidden until a road reaches each one (see
// initialFogRevealHexIds below) — the same two-ring depth of mystery the
// original (radius-3) fog-of-war board had, just pushed one ring further out
// now that there's an extra revealed ring surrounding it. Unlike the 5-6
// player extension board, which is an asymmetric 30-hex shape rather than a
// true hexagon (see extendedHexCoords), a true hexagon produces clean, even
// rings, which the fog reveal mechanism depends on.
// ---------------------------------------------------------------------------

function hexagonCoords(radius: number): AxialCoord[] {
  const coords: AxialCoord[] = [];
  for (let r = -radius; r <= radius; r++) {
    const qMin = Math.max(-radius, -r - radius);
    const qMax = Math.min(radius, -r + radius);
    for (let q = qMin; q <= qMax; q++) {
      coords.push({ q, r });
    }
  }
  return coords;
}

export function standardHexCoords(): AxialCoord[] {
  return hexagonCoords(2);
}

export function fogHexCoords(): AxialCoord[] {
  return hexagonCoords(4);
}

// 5-6 player extension: 30 hexes in 7 rows of 3,4,5,6,5,4,3 — an elongated hexagon rather
// than a scaled-up regular one (a true radius-3 hexagon would be 7 rows of 4,5,6,7,6,5,4 =
// 37, peaking at 7 wide; the real board peaks at 6). Built the same way as
// standardHexCoords() but with two different left/right radii instead of one, which is what
// produces the asymmetric-looking (but still row-symmetric) width sequence.
export function extendedHexCoords(): AxialCoord[] {
  const coords: AxialCoord[] = [];
  const radiusLeft = 3;
  const radiusRight = 2;
  for (let r = -3; r <= 3; r++) {
    const qMin = Math.max(-radiusLeft, -r - radiusLeft);
    const qMax = Math.min(radiusRight, -r + radiusRight);
    for (let q = qMin; q <= qMax; q++) {
      coords.push({ q, r });
    }
  }
  return coords;
}

const AXIAL_DIRS: AxialCoord[] = [
  { q: 1, r: 0 },
  { q: 1, r: -1 },
  { q: 0, r: -1 },
  { q: -1, r: 0 },
  { q: -1, r: 1 },
  { q: 0, r: 1 },
];

function hexesAdjacent(a: AxialCoord, b: AxialCoord): boolean {
  return AXIAL_DIRS.some((d) => a.q + d.q === b.q && a.r + d.r === b.r);
}

export function hexKey(c: AxialCoord): string {
  return `${c.q},${c.r}`;
}

// ---------------------------------------------------------------------------
// Terrain / number pools
// ---------------------------------------------------------------------------

// NOTE: the task brief listed "4 hills, 4 forest, 3 mountains, 4 fields,
// 4 pasture, 1 desert" which sums to 20 tiles — one too many for a 19-hex
// board. That's a typo; the real/standard Catan distribution (which is what
// makes 19 total) is 3 hills, 4 forest, 3 mountains, 4 fields, 4 pasture,
// 1 desert. Using the historically-correct counts here so hex/number/port
// counts and the 19-hex layout are internally consistent.
const TERRAIN_POOL: Terrain[] = [
  'hills',
  'hills',
  'hills',
  'forest',
  'forest',
  'forest',
  'forest',
  'mountains',
  'mountains',
  'mountains',
  'fields',
  'fields',
  'fields',
  'fields',
  'pasture',
  'pasture',
  'pasture',
  'pasture',
  'desert',
];

const NUMBER_POOL = [2, 3, 3, 4, 4, 5, 5, 6, 6, 8, 8, 9, 9, 10, 10, 11, 11, 12];

// 30-hex extended (5-6 player) pool, scaled from the base distribution: 5 hills, 6 forest,
// 5 mountains, 6 fields, 6 pasture, 2 desert = 30. 28 number tokens for the 28 non-desert
// hexes: 2 and 12 stay rare (2 copies each, same as the base pool), everything else gets a
// 3rd copy (28 = 2+2 + 8*3... i.e. 3,4,5,6,8,9,10,11 at 3 copies + 2,12 at 2 copies).
const EXTENDED_TERRAIN_POOL: Terrain[] = [
  'hills', 'hills', 'hills', 'hills', 'hills',
  'forest', 'forest', 'forest', 'forest', 'forest', 'forest',
  'mountains', 'mountains', 'mountains', 'mountains', 'mountains',
  'fields', 'fields', 'fields', 'fields', 'fields', 'fields',
  'pasture', 'pasture', 'pasture', 'pasture', 'pasture', 'pasture',
  'desert', 'desert',
];
const EXTENDED_NUMBER_POOL = [
  2, 2, 3, 3, 3, 4, 4, 4, 5, 5, 5, 6, 6, 6, 8, 8, 8, 9, 9, 9, 10, 10, 10, 11, 11, 11, 12, 12,
];

// fog-of-war pools: the board is the 61-hex true radius-4 hexagon (fogHexCoords — 1 + 6 + 12 +
// 18 + 24 hexes across the center + 4 rings). The outer two rings (ring 4, the perimeter, +
// ring 3 just inside it — 42 hexes total) are always revealed and together hold 6 "oasis"
// clusters of real resource terrain, one full radial wedge each (a ring-4 corner + its two
// ring-4 edge-hex neighbors + the two ring-3 hexes inward of them, 5 hexes per wedge, 30
// total — see fogOuterRingLayout/fogContinuationIndices), divided from one another by 6
// desert corridors (one ring-4 + one ring-3 hex each, radially lined up, 12 desert hexes
// total) — i.e. the oasis clusters span *both* revealed rings, with desert cutting all the way
// through both of them at each of the 6 compass points, not just the outer one. That makes
// desert the single most common *individual* terrain across the two rings (12 hexes of one
// type vs. 30 oasis hexes split across 5 resource types) even though oasis hexes collectively
// outnumber desert ones — the intended "desert-dominant, oasis is the rare fertile spot" read.
// Rings 2 and 1 (18 hexes total, around the gold center) stay fully hidden until a road
// reveals each one, drawing terrain from FOG_HIDDEN_TERRAIN_POOL with numbers left null (a
// genuinely random token is assigned at discovery time instead — see discoverHexesAtEdge in
// rules.ts). The center hex is always gold, forced to a hot (6 or 8) number token — see
// buildFogTerrainNumberAssignment.
//
// 30 hexes for the two rings' combined oasis clusters — a reasonably balanced split of the 5
// resource types, fairness-checked (see violatesNoAdjacent68) the same way as every other
// randomized preset via the retry loop in buildFogTerrainNumberAssignment below.
const FOG_OASIS_TERRAIN_POOL: Terrain[] = [
  'hills', 'hills', 'hills', 'hills', 'hills',
  'forest', 'forest', 'forest', 'forest', 'forest', 'forest', 'forest',
  'mountains', 'mountains', 'mountains', 'mountains', 'mountains',
  'fields', 'fields', 'fields', 'fields', 'fields', 'fields',
  'pasture', 'pasture', 'pasture', 'pasture', 'pasture', 'pasture', 'pasture',
];
// 30 number tokens for the 30 oasis hexes, fairness-checked the same way as every other
// randomized preset (see violatesNoAdjacent68) via the retry loop in
// buildFogTerrainNumberAssignment below.
const FOG_OASIS_NUMBER_POOL = [
  2, 2, 3, 3, 3, 4, 4, 4, 5, 5, 5, 6, 6, 6, 6, 8, 8, 8, 8, 9, 9, 9, 10, 10, 10, 11, 11, 11, 12, 12,
];
// 18-hex pool for rings 1+2, the two rings that stay genuinely hidden — same ratio as the
// standard 19-hex board's 18 non-desert hexes (a deliberate callback), reusing TERRAIN_POOL
// rather than hand-writing a parallel array that could drift out of sync with it.
const FOG_HIDDEN_TERRAIN_POOL: Terrain[] = TERRAIN_POOL.filter((t) => t !== 'desert');

// Fixed official-beginner layout (row order matches standardHexCoords()).
const OFFICIAL_TERRAIN: Terrain[] = [
  'mountains', 'pasture', 'forest',
  'fields', 'hills', 'pasture', 'hills',
  'fields', 'desert', 'pasture', 'forest', 'mountains',
  'forest', 'mountains', 'fields', 'pasture',
  'hills', 'fields', 'forest',
];
const OFFICIAL_NUMBERS: (number | null)[] = [
  10, 2, 9,
  12, 6, 4, 10,
  9, null, 11, 3, 8,
  8, 3, 4, 5,
  5, 6, 11,
];

function violatesNoAdjacent68(coords: AxialCoord[], numbers: (number | null)[]): boolean {
  const hot: AxialCoord[] = [];
  coords.forEach((c, i) => {
    if (numbers[i] === 6 || numbers[i] === 8) hot.push(c);
  });
  for (let i = 0; i < hot.length; i++) {
    for (let j = i + 1; j < hot.length; j++) {
      if (hexesAdjacent(hot[i], hot[j])) return true;
    }
  }
  return false;
}

/** Whether the hex at `coord` (already known to be at cube-radius `radius` from center) is
 * one of that ring's 6 "corner" hexes — laid out along the board's 6 compass directions —
 * rather than one of the 6*(radius-1) "edge" hexes between them. Corners are exactly the
 * cells where at least two of the three cube coordinates hit the ring's own radius (an edge
 * cell only ever has one). Used by fog-of-war's oasis/desert layout below. */
function isHexRingCorner(coord: AxialCoord, radius: number): boolean {
  const x = coord.q;
  const z = coord.r;
  const y = -x - z;
  const atRadius = [Math.abs(x), Math.abs(y), Math.abs(z)].filter((v) => v === radius).length;
  return atRadius >= 2;
}

/** fog-of-war's outermost-ring (always-revealed) layout: which hex-array indices form each of
 * the 6 "oasis" clusters, and which 6 indices are the lone desert hex left over between each
 * pair of clusters. Walking around a ring of the given `radius` visits a repeating
 * [corner, edge, edge, ...] pattern (6 corners + 6*(radius-1) edges, with (radius-1) edge hexes
 * between each pair of corners); sorting the ring's hexes by angle around the board center
 * recovers that walk order (the same technique buildPorts uses for the boundary edges further
 * down this file), so grouping each corner with the next (radius-2) hexes in angle order into
 * its oasis cluster, and leaving the hex after *that* (i.e. right before the next corner) as
 * the lone desert hex, produces 6 non-overlapping (radius-1)-hex oases with exactly one desert
 * hex sandwiched between each consecutive pair. Which rotational direction that walk goes
 * (clockwise or counter-clockwise, depending on atan2's sign convention) doesn't matter, only
 * that it's applied consistently — which sorting once and walking forward guarantees. Used for
 * the board's outermost ring (radius 4, 3-hex oases) — see fogContinuationIndices for how the
 * next ring in continues the desert corridor without repeating this same clustering. */
function fogOuterRingLayout(coords: AxialCoord[], radius: number): { oasisIndices: number[]; desertIndices: number[] } {
  const ring = coords
    .map((c, i) => ({ c, i }))
    .filter(({ c }) => hexCubeRadius(c) === radius)
    .sort((a, b) => {
      const pa = hexPixel(a.c, 1);
      const pb = hexPixel(b.c, 1);
      return Math.atan2(pa.y, pa.x) - Math.atan2(pb.y, pb.x);
    });

  const oasisIndices: number[] = [];
  const desertIndices: number[] = [];
  for (let k = 0; k < ring.length; k++) {
    if (isHexRingCorner(ring[k].c, radius)) {
      for (let j = 0; j <= radius - 2; j++) oasisIndices.push(ring[(k + j) % ring.length].i);
      desertIndices.push(ring[(k + radius - 1) % ring.length].i);
    }
  }
  return { oasisIndices, desertIndices };
}

/** fog-of-war's desert continuation: which hex indices on the ring one step in from
 * `desertIndices`' own ring continue each of that outer ring's 6 desert hexes further inward,
 * so the desert corridor reads as running from the rim toward the center rather than stopping
 * abruptly at the outer ring. Matches each desert hex to whichever not-yet-used hex on the
 * next ring in sits closest to it by angle around the board center (the same angular-sort
 * technique fogOuterRingLayout/buildPorts already use) — geometrically that's one of a desert
 * hex's two neighbors on the ring inside it, and since the 6 desert hexes are evenly spaced,
 * nearest-angle matching partitions that inner ring's hexes cleanly into 6 continuation hexes
 * plus whatever's left over for real resource terrain, with no collisions. */
function fogContinuationIndices(coords: AxialCoord[], innerRadius: number, desertIndices: number[]): number[] {
  const innerRing = coords.map((c, i) => ({ c, i })).filter(({ c }) => hexCubeRadius(c) === innerRadius);
  const angleOf = (c: AxialCoord): number => {
    const p = hexPixel(c, 1);
    return Math.atan2(p.y, p.x);
  };

  const used = new Set<number>();
  const continuation: number[] = [];
  for (const dIdx of desertIndices) {
    const desertAngle = angleOf(coords[dIdx]);
    let best: { i: number; diff: number } | null = null;
    for (const { c, i } of innerRing) {
      if (used.has(i)) continue;
      let diff = Math.abs(angleOf(c) - desertAngle);
      if (diff > Math.PI) diff = 2 * Math.PI - diff;
      if (!best || diff < best.diff) best = { i, diff };
    }
    if (best) {
      used.add(best.i);
      continuation.push(best.i);
    }
  }
  return continuation;
}

/** fog-of-war's terrain/number assignment. The center hex (ring 0) is always gold with a
 * forced hot (6 or 8) number token — gold hexes don't produce a resource on their own roll the
 * normal way (see pickGoldResources in rules.ts), so forcing a hot number keeps it reliably
 * relevant. The outermost ring gets its 6 desert hexes from fogOuterRingLayout above (one per
 * radial wedge); the next ring in continues that same desert corridor inward
 * (fogContinuationIndices), so together the two revealed rings have 6 desert hexes apiece,
 * radially lined up. Every other hex across those same two rings — both rings' oasis-cluster
 * hexes together — draws from one shared pool (FOG_OASIS_TERRAIN_POOL/FOG_OASIS_NUMBER_POOL),
 * so an oasis cluster is really one contiguous resource wedge spanning both rings, not two
 * independently-random rings that happen to sit next to each other. The two rings inside *that*
 * (hidden until a road reveals each one) get real resource terrain from FOG_HIDDEN_TERRAIN_POOL
 * with numbers left null — a genuinely random token is assigned at discovery time instead (see
 * discoverHexesAtEdge in rules.ts). Same no-adjacent-6/8 fairness retry every other randomized
 * preset uses (only the revealed hexes + center can ever violate it, since the hidden rings'
 * numbers are null). */
function buildFogTerrainNumberAssignment(coords: AxialCoord[], rng: () => number): { terrains: Terrain[]; numbers: (number | null)[] } {
  const maxRadius = coords.reduce((m, c) => Math.max(m, hexCubeRadius(c)), 0);
  const { oasisIndices: outerOasisIndices, desertIndices: outerDesertIndices } = fogOuterRingLayout(coords, maxRadius);
  const innerDesertIndices = fogContinuationIndices(coords, maxRadius - 1, outerDesertIndices);
  const innerDesertSet = new Set(innerDesertIndices);
  const innerOasisIndices = coords
    .map((_, i) => i)
    .filter((i) => hexCubeRadius(coords[i]) === maxRadius - 1 && !innerDesertSet.has(i));
  const oasisIndices = [...outerOasisIndices, ...innerOasisIndices];
  const desertIndices = [...outerDesertIndices, ...innerDesertIndices];
  const centerIndex = coords.findIndex((c) => c.q === 0 && c.r === 0);
  const hiddenIndices = coords
    .map((_, i) => i)
    .filter((i) => {
      const r = hexCubeRadius(coords[i]);
      return r === maxRadius - 2 || r === maxRadius - 3;
    });
  const centerNumber = rng() < 0.5 ? 6 : 8;

  let terrains: Terrain[] = [];
  let numbers: (number | null)[] = [];
  let attempts = 0;
  const MAX_ATTEMPTS = 2000;

  do {
    const shuffledOasisTerrains = shuffle(FOG_OASIS_TERRAIN_POOL, rng);
    const shuffledOasisNumbers = shuffle(FOG_OASIS_NUMBER_POOL, rng);
    const shuffledHiddenTerrains = shuffle(FOG_HIDDEN_TERRAIN_POOL, rng);

    terrains = new Array<Terrain>(coords.length);
    numbers = new Array<number | null>(coords.length);

    terrains[centerIndex] = 'gold';
    numbers[centerIndex] = centerNumber;

    desertIndices.forEach((i) => {
      terrains[i] = 'desert';
      numbers[i] = null;
    });
    oasisIndices.forEach((i, k) => {
      terrains[i] = shuffledOasisTerrains[k];
      numbers[i] = shuffledOasisNumbers[k];
    });
    hiddenIndices.forEach((i, k) => {
      terrains[i] = shuffledHiddenTerrains[k];
      numbers[i] = null;
    });

    attempts++;
  } while (attempts < MAX_ATTEMPTS && violatesNoAdjacent68(coords, numbers));

  return { terrains, numbers };
}

function buildTerrainNumberAssignment(
  presetId: MapPresetId,
  coords: AxialCoord[],
  rng: () => number,
): { terrains: Terrain[]; numbers: (number | null)[] } {
  if (presetId === 'official-beginner') {
    return { terrains: OFFICIAL_TERRAIN.slice(), numbers: OFFICIAL_NUMBERS.slice() };
  }
  if (presetId === 'fog-of-war') {
    return buildFogTerrainNumberAssignment(coords, rng);
  }

  // extended-5-6p has no authored "official" arrangement (unlike official-beginner) — it's
  // always randomized, same as balanced-random/chaos, just from the bigger pool.
  const terrainPool = presetId === 'extended-5-6p' ? EXTENDED_TERRAIN_POOL : TERRAIN_POOL;
  const numberPool = presetId === 'extended-5-6p' ? EXTENDED_NUMBER_POOL : NUMBER_POOL;
  const requireFair = presetId === 'balanced-random' || presetId === 'extended-5-6p';
  let terrains: Terrain[] = [];
  let numbers: (number | null)[] = [];
  let attempts = 0;
  const MAX_ATTEMPTS = 2000;

  do {
    terrains = shuffle(terrainPool, rng);
    const nums = shuffle(numberPool, rng);
    numbers = [];
    let ni = 0;
    for (const t of terrains) {
      numbers.push(t === 'desert' ? null : nums[ni++]);
    }
    attempts++;
  } while (requireFair && attempts < MAX_ATTEMPTS && violatesNoAdjacent68(coords, numbers));

  return { terrains, numbers };
}

// ---------------------------------------------------------------------------
// Geometry: pointy-top axial hex <-> pixel, and canonical vertex/edge ids.
// Vertex ids encode their own canonical (unit-size) position as
// `${xMicro}_${yMicro}` (integer micro-units, no '.', safe as Firebase keys),
// which lets vertexPixel/edgeMidpoint recover position without needing extra
// fields on VertexInfo (the shared type contract doesn't carry one).
// ---------------------------------------------------------------------------

export function hexPixel(coord: AxialCoord, size: number): { x: number; y: number } {
  const x = size * (Math.sqrt(3) * coord.q + (Math.sqrt(3) / 2) * coord.r);
  const y = size * (1.5 * coord.r);
  return { x, y };
}

function hexCorners(coord: AxialCoord, size: number): { x: number; y: number }[] {
  const center = hexPixel(coord, size);
  const corners: { x: number; y: number }[] = [];
  for (let i = 0; i < 6; i++) {
    const angleDeg = 60 * i - 30;
    const angleRad = (Math.PI / 180) * angleDeg;
    corners.push({
      x: center.x + size * Math.cos(angleRad),
      y: center.y + size * Math.sin(angleRad),
    });
  }
  return corners;
}

function roundToMicro(n: number): number {
  const r = Math.round(n * 1_000_000);
  return r === 0 ? 0 : r; // normalize -0
}

function pointKey(p: { x: number; y: number }): VertexId {
  return `${roundToMicro(p.x)}_${roundToMicro(p.y)}`;
}

function parseVertexId(id: VertexId): { x: number; y: number } {
  // Format is `${xMicro}_${yMicro}`; xMicro/yMicro are plain integers (only
  // an optional leading '-'), so the first '_' is always the separator.
  const idx = id.indexOf('_');
  const xs = id.slice(0, idx);
  const ys = id.slice(idx + 1);
  return { x: Number(xs) / 1_000_000, y: Number(ys) / 1_000_000 };
}

function edgeIdFor(a: VertexId, b: VertexId): EdgeId {
  return [a, b].sort().join('__');
}

export function vertexPixel(vertexId: VertexId, board: Board, size: number): { x: number; y: number } {
  if (!board.vertices[vertexId]) {
    throw new Error(`Unknown vertex: ${vertexId}`);
  }
  const p = parseVertexId(vertexId);
  return { x: p.x * size, y: p.y * size };
}

export function edgeMidpoint(edgeId: EdgeId, board: Board, size: number): { x: number; y: number } {
  const e = board.edges[edgeId];
  if (!e) throw new Error(`Unknown edge: ${edgeId}`);
  const [a, b] = e.vertexIds;
  const pa = vertexPixel(a, board, size);
  const pb = vertexPixel(b, board, size);
  return { x: (pa.x + pb.x) / 2, y: (pa.y + pb.y) / 2 };
}

/** Pip count ("dots") for a number token; 0 for null/desert. */
export function pipCount(n: number | null): number {
  if (n === null) return 0;
  const table: Record<number, number> = { 2: 1, 3: 2, 4: 3, 5: 4, 6: 5, 8: 5, 9: 4, 10: 3, 11: 2, 12: 1 };
  return table[n] ?? 0;
}

// ---------------------------------------------------------------------------
// Adjacency construction
// ---------------------------------------------------------------------------

function buildAdjacency(hexes: HexTile[]): {
  vertices: Record<VertexId, VertexInfo>;
  edges: Record<EdgeId, EdgeInfo>;
} {
  const vertices: Record<VertexId, VertexInfo> = {};
  const edges: Record<EdgeId, EdgeInfo> = {};

  function ensureVertex(id: VertexId): VertexInfo {
    let v = vertices[id];
    if (!v) {
      v = { id, adjacentHexIds: [], adjacentVertexIds: [], adjacentEdgeIds: [] };
      vertices[id] = v;
    }
    return v;
  }

  for (const hex of hexes) {
    const corners = hexCorners(hex.coord, 1).map(pointKey);

    for (let i = 0; i < 6; i++) {
      const v = ensureVertex(corners[i]);
      if (!v.adjacentHexIds.includes(hex.id)) v.adjacentHexIds.push(hex.id);
    }

    for (let i = 0; i < 6; i++) {
      const a = corners[i];
      const b = corners[(i + 1) % 6];
      const edgeId = edgeIdFor(a, b);
      let e = edges[edgeId];
      if (!e) {
        e = { id: edgeId, vertexIds: [a, b].sort() as [VertexId, VertexId], adjacentHexIds: [] };
        edges[edgeId] = e;
      }
      if (!e.adjacentHexIds.includes(hex.id)) e.adjacentHexIds.push(hex.id);

      const va = ensureVertex(a);
      const vb = ensureVertex(b);
      if (!va.adjacentVertexIds.includes(b)) va.adjacentVertexIds.push(b);
      if (!vb.adjacentVertexIds.includes(a)) vb.adjacentVertexIds.push(a);
      if (!va.adjacentEdgeIds.includes(edgeId)) va.adjacentEdgeIds.push(edgeId);
      if (!vb.adjacentEdgeIds.includes(edgeId)) vb.adjacentEdgeIds.push(edgeId);
    }
  }

  return { vertices, edges };
}

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

// 4x generic (3:1) + 1 each of the 5 resources (2:1) = 9 ports.
const PORT_TYPE_SEQUENCE: PortType[] = [
  'generic', 'wool', 'generic', 'ore', 'generic', 'grain', 'brick', 'generic', 'lumber',
];

function buildPorts(presetId: MapPresetId, edges: Record<EdgeId, EdgeInfo>, rng: () => number): Port[] {
  const boundary = Object.values(edges).filter((e) => e.adjacentHexIds.length === 1);

  const withAngle = boundary.map((e) => {
    const [a, b] = e.vertexIds;
    const pa = parseVertexId(a);
    const pb = parseVertexId(b);
    const mx = (pa.x + pb.x) / 2;
    const my = (pa.y + pb.y) / 2;
    return { edge: e, angle: Math.atan2(my, mx) };
  });
  withAngle.sort((x, y) => x.angle - y.angle);

  const PORT_COUNT = PORT_TYPE_SEQUENCE.length;
  const n = withAngle.length;
  const chosen: EdgeInfo[] = [];
  for (let i = 0; i < PORT_COUNT; i++) {
    const idx = Math.floor((i * n) / PORT_COUNT);
    chosen.push(withAngle[idx].edge);
  }

  const types = presetId === 'official-beginner' ? PORT_TYPE_SEQUENCE.slice() : shuffle(PORT_TYPE_SEQUENCE, rng);

  return chosen.map((e, i) => ({
    id: `port-${i}`,
    vertexIds: [...e.vertexIds] as [VertexId, VertexId],
    type: types[i],
  }));
}

// ---------------------------------------------------------------------------
// fog-of-war: which hexes start revealed
// ---------------------------------------------------------------------------

/** Radius from center in cube coordinates (x=q, z=r, y=-x-z). */
function hexCubeRadius(c: AxialCoord): number {
  const x = c.q;
  const z = c.r;
  const y = -x - z;
  return Math.max(Math.abs(x), Math.abs(y), Math.abs(z));
}

/** Hex ids revealed from the start of a fog-of-war game: the outer two rings (ring `maxRadius`
 * — the board's perimeter, where all 6 original desert hexes and 6 oasis clusters live — and
 * ring `maxRadius - 1`, which continues that desert corridor inward plus more real-resource
 * hexes of its own; see buildFogTerrainNumberAssignment) plus the single hex dead center
 * (always the gold hex; see generateBoard). The two rings inside *that* stay hidden until a
 * road reaches each one (see 'buildRoad' in rules.ts) — on the 61-hex fogHexCoords() board
 * (radius 4) that's rings 2 and 1, around the gold center. This function doesn't hardcode a
 * radius for the revealed rings, it just reveals the board's own outermost two ring distances
 * plus center, so it falls out automatically from however big the board actually is. Matches
 * real fog-of-war Catan variants (e.g. "Volcano"/"Black Forest": colored rings around the
 * outside, fog in the middle, a special tile at the very center). */
export function initialFogRevealHexIds(hexes: HexTile[]): string[] {
  const maxRadius = hexes.reduce((m, h) => Math.max(m, hexCubeRadius(h.coord)), 0);
  return hexes
    .filter((h) => {
      const r = hexCubeRadius(h.coord);
      return r === maxRadius || r === maxRadius - 1 || r === 0;
    })
    .map((h) => h.id);
}

/** Whether vertexId is legal for a *setup-phase* (free) settlement once fog-of-war's extra
 * restrictions are factored in: can't border the gold hex, and (fog-of-war only) can't border
 * any hex outside the board's initial reveal set — even one revealed mid-setup by an earlier
 * player's road (see rules.ts's 'buildSettlement' handler for the authoritative check this
 * mirrors). No-op (always true, modulo the gold check) for non-fog rooms, since
 * discoveredHexIds is null there. Shared by rules.ts (server validation), bots.ts (setup AI,
 * so bots don't propose a spot the server then rejects — see decideSetupAction), and
 * Board.tsx (client candidate highlighting, so the pulsing "legal placement" indicator doesn't
 * show a spot that isn't actually legal) — deliberately factored out here instead of
 * duplicated three times so they can't silently drift out of sync with each other. Only
 * relevant to *setup* placement; main-phase settlement building has no such restriction (see
 * rules.ts — the checks below only ever applied inside the `action.free` branch). */
export function vertexLegalForFogSetup(
  board: Board,
  discoveredHexIds: string[] | null,
  vertexId: VertexId,
): boolean {
  const v = board.vertices[vertexId];
  if (!v) return false;
  if (v.adjacentHexIds.some((h) => board.hexes.find((hex) => hex.id === h)?.terrain === 'gold')) return false;
  if (discoveredHexIds !== null) {
    const initialReveal = new Set(initialFogRevealHexIds(board.hexes));
    if (v.adjacentHexIds.some((h) => !initialReveal.has(h))) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export function generateBoard(presetId: MapPresetId, seed: string): Board {
  const rng = createRng(`${seed}:board`);
  const coords = presetId === 'extended-5-6p' ? extendedHexCoords() : presetId === 'fog-of-war' ? fogHexCoords() : standardHexCoords();
  const { terrains, numbers } = buildTerrainNumberAssignment(presetId, coords, rng);

  const hexes: HexTile[] = coords.map((coord, i) => ({
    id: hexKey(coord),
    coord,
    terrain: terrains[i],
    number: numbers[i],
  }));

  // Unlike every other preset, fog-of-war doesn't need any post-processing here:
  // buildFogTerrainNumberAssignment (via buildTerrainNumberAssignment above) already places
  // gold directly at the center coordinate and nulls out hidden hexes' numbers itself, so
  // there's no swap-search or reveal-then-null pass left to do.

  const { vertices, edges } = buildAdjacency(hexes);
  const ports = buildPorts(presetId, edges, rng);
  const desert = hexes.find((h) => h.terrain === 'desert');
  if (!desert) throw new Error('generateBoard: no desert hex produced');

  return { hexes, vertices, edges, ports, robberHexId: desert.id };
}
