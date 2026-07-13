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
// Standard hex layout: a "hexagon of hexes" of radius 2 (19 tiles), laid out
// in 5 rows of 3,4,5,4,3 hexes, top (r=-2) to bottom (r=2), left to right.
// ---------------------------------------------------------------------------

export function standardHexCoords(): AxialCoord[] {
  const coords: AxialCoord[] = [];
  for (let r = -2; r <= 2; r++) {
    const qMin = Math.max(-2, -r - 2);
    const qMax = Math.min(2, -r + 2);
    for (let q = qMin; q <= qMax; q++) {
      coords.push({ q, r });
    }
  }
  return coords;
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

// fog-of-war pool: same 19-hex distribution as the base pool, but one pasture becomes the
// gold hex (still needs a number token, so NUMBER_POOL's 18 entries still cover exactly the
// 18 non-desert hexes).
const FOG_TERRAIN_POOL: Terrain[] = (() => {
  const pool = TERRAIN_POOL.slice();
  pool[pool.lastIndexOf('pasture')] = 'gold';
  return pool;
})();

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

function buildTerrainNumberAssignment(
  presetId: MapPresetId,
  coords: AxialCoord[],
  rng: () => number,
): { terrains: Terrain[]; numbers: (number | null)[] } {
  if (presetId === 'official-beginner') {
    return { terrains: OFFICIAL_TERRAIN.slice(), numbers: OFFICIAL_NUMBERS.slice() };
  }

  // extended-5-6p has no authored "official" arrangement (unlike official-beginner) — it's
  // always randomized, same as balanced-random/chaos, just from the bigger pool.
  const terrainPool = presetId === 'extended-5-6p' ? EXTENDED_TERRAIN_POOL : presetId === 'fog-of-war' ? FOG_TERRAIN_POOL : TERRAIN_POOL;
  const numberPool = presetId === 'extended-5-6p' ? EXTENDED_NUMBER_POOL : NUMBER_POOL;
  const requireFair = presetId === 'balanced-random' || presetId === 'extended-5-6p' || presetId === 'fog-of-war';
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

/** The 6 hexes at a hex-hexagon's true geometric corners — where two of the three cube
 * coordinates simultaneously hit the board's outer radius. Used by the fog-of-war preset to
 * decide which hexes are revealed from the start ("the corners having a 6 tile area", read
 * as the 6 corner tiles of the hex-hexagon, one per corner). */
function cornerHexIds(hexes: HexTile[]): Set<string> {
  const radius = hexes.reduce((m, h) => Math.max(m, hexCubeRadius(h.coord)), 0);
  const corners = new Set<string>();
  for (const h of hexes) {
    const x = h.coord.q;
    const z = h.coord.r;
    const y = -x - z;
    const atRadius = [Math.abs(x), Math.abs(y), Math.abs(z)].filter((v) => v === radius).length;
    if (atRadius >= 2) corners.add(h.id);
  }
  return corners;
}

/** Hex ids revealed from the start of a fog-of-war game: the 6 corner hexes, the desert,
 * and the gold hex (always known/plannable-around, never hidden) — everything else starts
 * hidden until a road reaches it (see 'buildRoad' in rules.ts). */
export function initialFogRevealHexIds(hexes: HexTile[]): string[] {
  const revealed = cornerHexIds(hexes);
  for (const h of hexes) {
    if (h.terrain === 'desert' || h.terrain === 'gold') revealed.add(h.id);
  }
  return Array.from(revealed);
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export function generateBoard(presetId: MapPresetId, seed: string): Board {
  const rng = createRng(`${seed}:board`);
  const coords = presetId === 'extended-5-6p' ? extendedHexCoords() : standardHexCoords();
  const { terrains, numbers } = buildTerrainNumberAssignment(presetId, coords, rng);

  const hexes: HexTile[] = coords.map((coord, i) => ({
    id: hexKey(coord),
    coord,
    terrain: terrains[i],
    number: numbers[i],
  }));

  // Fog-of-war: terrain is generated like any other preset, but only revealed hexes' number
  // tokens are meaningful yet — the rest are nulled out here and assigned a genuinely random
  // token at discovery time (see 'buildRoad' in rules.ts), matching "the number on it is
  // completely random" rather than merely hidden-but-predetermined.
  if (presetId === 'fog-of-war') {
    const revealed = new Set(initialFogRevealHexIds(hexes));
    for (const h of hexes) {
      if (!revealed.has(h.id)) h.number = null;
    }
  }

  const { vertices, edges } = buildAdjacency(hexes);
  const ports = buildPorts(presetId, edges, rng);
  const desert = hexes.find((h) => h.terrain === 'desert');
  if (!desert) throw new Error('generateBoard: no desert hex produced');

  return { hexes, vertices, edges, ports, robberHexId: desert.id };
}
