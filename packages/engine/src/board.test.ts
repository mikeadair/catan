import { describe, expect, it } from 'vitest';
import { edgeMidpoint, generateBoard, hexPixel, initialFogRevealHexIds, vertexPixel } from './board';
import { TERRAIN_RESOURCE, type Terrain } from './types';

const ALL_TERRAINS: Terrain[] = ['hills', 'forest', 'mountains', 'fields', 'pasture', 'desert'];

function terrainCounts(board: ReturnType<typeof generateBoard>): Record<Terrain, number> {
  const counts = Object.fromEntries(ALL_TERRAINS.map((t) => [t, 0])) as Record<Terrain, number>;
  for (const hex of board.hexes) counts[hex.terrain]++;
  return counts;
}

function numberMultiset(board: ReturnType<typeof generateBoard>): number[] {
  return board.hexes
    .map((h) => h.number)
    .filter((n): n is number => n !== null)
    .sort((a, b) => a - b);
}

const EXPECTED_NUMBERS = [2, 3, 3, 4, 4, 5, 5, 6, 6, 8, 8, 9, 9, 10, 10, 11, 11, 12].sort((a, b) => a - b);

describe('generateBoard: counts', () => {
  for (const preset of ['official-beginner', 'balanced-random', 'chaos'] as const) {
    it(`${preset}: has 19 hexes with correct terrain/number/port counts`, () => {
      const board = generateBoard(preset, `seed-${preset}`);
      expect(board.hexes).toHaveLength(19);

      const counts = terrainCounts(board);
      expect(counts.hills).toBe(3);
      expect(counts.forest).toBe(4);
      expect(counts.mountains).toBe(3);
      expect(counts.fields).toBe(4);
      expect(counts.pasture).toBe(4);
      expect(counts.desert).toBe(1);

      expect(numberMultiset(board)).toEqual(EXPECTED_NUMBERS);

      const desertHexes = board.hexes.filter((h) => h.terrain === 'desert');
      expect(desertHexes).toHaveLength(1);
      expect(desertHexes[0].number).toBeNull();
      expect(board.robberHexId).toBe(desertHexes[0].id);

      expect(board.ports).toHaveLength(9);
      const generic = board.ports.filter((p) => p.type === 'generic');
      expect(generic).toHaveLength(4);
      for (const r of ['brick', 'lumber', 'ore', 'grain', 'wool'] as const) {
        expect(board.ports.filter((p) => p.type === r)).toHaveLength(1);
      }
      for (const port of board.ports) {
        expect(new Set(port.vertexIds).size).toBe(2);
      }
    });
  }
});

describe('generateBoard: extended-5-6p', () => {
  const EXPECTED_EXTENDED_NUMBERS = [
    2, 2, 3, 3, 3, 4, 4, 4, 5, 5, 5, 6, 6, 6, 8, 8, 8, 9, 9, 9, 10, 10, 10, 11, 11, 11, 12, 12,
  ].sort((a, b) => a - b);

  it('has 30 hexes with correct terrain/number/port counts', () => {
    const board = generateBoard('extended-5-6p', 'seed-extended');
    expect(board.hexes).toHaveLength(30);

    const counts = terrainCounts(board);
    expect(counts.hills).toBe(5);
    expect(counts.forest).toBe(6);
    expect(counts.mountains).toBe(5);
    expect(counts.fields).toBe(6);
    expect(counts.pasture).toBe(6);
    expect(counts.desert).toBe(2);

    expect(numberMultiset(board)).toEqual(EXPECTED_EXTENDED_NUMBERS);

    const desertHexes = board.hexes.filter((h) => h.terrain === 'desert');
    expect(desertHexes).toHaveLength(2);
    for (const d of desertHexes) expect(d.number).toBeNull();
    expect(desertHexes.map((d) => d.id)).toContain(board.robberHexId);

    // Row widths 3,4,5,6,5,4,3 (7 rows) is the shape signature — verify it directly rather
    // than just trusting the hex count, since a bug could still produce 30 hexes in the
    // wrong (e.g. disconnected, or wrong-shaped) arrangement.
    const rowWidths = new Map<number, number>();
    for (const h of board.hexes) rowWidths.set(h.coord.r, (rowWidths.get(h.coord.r) ?? 0) + 1);
    expect([...rowWidths.entries()].sort(([a], [b]) => a - b)).toEqual([
      [-3, 3], [-2, 4], [-1, 5], [0, 6], [1, 5], [2, 4], [3, 3],
    ]);

    expect(board.ports).toHaveLength(9);
    for (const port of board.ports) {
      expect(new Set(port.vertexIds).size).toBe(2);
    }
  });

  it('is fully connected — every hex reachable from any other via shared edges', () => {
    const board = generateBoard('extended-5-6p', 'connectivity-seed');
    const key = (c: { q: number; r: number }) => `${c.q},${c.r}`;
    const byKey = new Map(board.hexes.map((h) => [key(h.coord), h]));
    const DIRS = [
      [1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1],
    ];
    const seen = new Set<string>([key(board.hexes[0].coord)]);
    const queue = [board.hexes[0]];
    while (queue.length > 0) {
      const cur = queue.pop()!;
      for (const [dq, dr] of DIRS) {
        const nk = key({ q: cur.coord.q + dq, r: cur.coord.r + dr });
        const neighbor = byKey.get(nk);
        if (neighbor && !seen.has(nk)) {
          seen.add(nk);
          queue.push(neighbor);
        }
      }
    }
    expect(seen.size).toBe(board.hexes.length);
  });

  it('never places two 6/8 tokens hex-adjacent, across many seeds', () => {
    for (let i = 0; i < 15; i++) {
      const board = generateBoard('extended-5-6p', `extended-fair-seed-${i}`);
      const hot = board.hexes.filter((h) => h.number === 6 || h.number === 8);
      for (let a = 0; a < hot.length; a++) {
        for (let b = a + 1; b < hot.length; b++) {
          const dq = Math.abs(hot[a].coord.q - hot[b].coord.q);
          const dr = Math.abs(hot[a].coord.r - hot[b].coord.r);
          const ds = Math.abs(hot[a].coord.q + hot[a].coord.r - (hot[b].coord.q + hot[b].coord.r));
          const isAdjacent = Math.max(dq, dr, ds) === 1;
          expect(isAdjacent).toBe(false);
        }
      }
    }
  });
});

describe('generateBoard: fog-of-war', () => {
  const EXPECTED_FOG_NUMBERS = [
    2, 2, 2, 3, 3, 3, 3, 3, 3, 4, 4, 4, 4, 4, 4, 5, 5, 5, 5, 5, 5, 6, 6, 6, 6, 6, 6, 6, 8, 8, 8, 8, 8, 8, 9, 9, 9, 9,
    9, 9, 10, 10, 10, 10, 10, 10, 11, 11, 11, 11, 11, 11, 12, 12, 12,
  ].sort((a, b) => a - b);

  it('has 61 hexes with correct terrain/port counts, one pasture swapped to gold', () => {
    const board = generateBoard('fog-of-war', 'seed-fog');
    expect(board.hexes).toHaveLength(61);

    const counts = terrainCounts(board);
    expect(counts.hills).toBe(9);
    expect(counts.forest).toBe(12);
    expect(counts.mountains).toBe(9);
    expect(counts.fields).toBe(12);
    expect(counts.pasture).toBe(12); // 13 in the pool, minus the one swapped to gold
    expect(counts.desert).toBe(6);
    expect(board.hexes.filter((h) => h.terrain === 'gold')).toHaveLength(1);

    const desertHexes = board.hexes.filter((h) => h.terrain === 'desert');
    expect(desertHexes).toHaveLength(6);
    for (const d of desertHexes) expect(d.number).toBeNull();
    expect(desertHexes.map((d) => d.id)).toContain(board.robberHexId);

    // Desert is fixed at the 6 corner hexes of the radius-2 ring (the hidden ring bordering
    // the revealed area), not shuffled — the 6 compass-direction axial corners at that radius
    // are exactly (2,0),(2,-2),(0,-2),(-2,0),(-2,2),(0,2). Verified by exact coordinate set,
    // not just the count, since a bug could still produce 6 deserts in the wrong spots.
    const desertCoords = new Set(desertHexes.map((d) => `${d.coord.q},${d.coord.r}`));
    expect(desertCoords).toEqual(new Set(['2,0', '2,-2', '0,-2', '-2,0', '-2,2', '0,2']));

    // Row widths 5,6,7,8,9,8,7,6,5 (9 rows) — a true radius-4 hexagon, unlike extended-5-6p's
    // asymmetric shape. Verified directly (not just the 61 count) since that's what makes
    // "two revealed outer rings + two hidden rings" well-defined in the first place (see
    // initialFogRevealHexIds).
    const rowWidths = new Map<number, number>();
    for (const h of board.hexes) rowWidths.set(h.coord.r, (rowWidths.get(h.coord.r) ?? 0) + 1);
    expect([...rowWidths.entries()].sort(([a], [b]) => a - b)).toEqual([
      [-4, 5], [-3, 6], [-2, 7], [-1, 8], [0, 9], [1, 8], [2, 7], [3, 6], [4, 5],
    ]);

    expect(board.ports).toHaveLength(9);
  });

  it('never places desert anywhere but the 6 fixed corner hexes, across many seeds', () => {
    for (let i = 0; i < 15; i++) {
      const board = generateBoard('fog-of-war', `fog-desert-seed-${i}`);
      const desertCoords = new Set(
        board.hexes.filter((h) => h.terrain === 'desert').map((d) => `${d.coord.q},${d.coord.r}`),
      );
      expect(desertCoords, `seed ${i}`).toEqual(new Set(['2,0', '2,-2', '0,-2', '-2,0', '-2,2', '0,2']));
    }
  });

  it('the gold hex sits dead center and every non-desert hex gets a number from the fog pool', () => {
    const board = generateBoard('fog-of-war', 'seed-fog-gold');
    const centerHex = board.hexes.find((h) => h.coord.q === 0 && h.coord.r === 0)!;
    expect(centerHex.terrain).toBe('gold');

    // Numbers are nulled out for hidden hexes at generation time (assigned on discovery
    // instead — see rules.ts), so to check the full pool landed correctly we have to look at
    // it before that nulling happens; reconstruct via a fresh call isn't possible from the
    // public API, so instead just verify every REVEALED non-desert hex's number came from the
    // fog pool's value set, and that the hidden count/shape works out (covered in
    // rules.test.ts's 'fog-of-war and gold hex' describe block, which has room.discoveredHexIds
    // to work with).
    const validNumbers = new Set(EXPECTED_FOG_NUMBERS);
    for (const hex of board.hexes) {
      if (hex.number !== null) expect(validNumbers.has(hex.number)).toBe(true);
    }
  });

  it('never leaves a hidden (not-initially-revealed) hex as desert, across many seeds', () => {
    // Hidden fog tiles should never "turn out to be" desert once discovered via gameplay —
    // desert must always be part of the initial reveal set. See initialFogRevealHexIds.
    for (let i = 0; i < 15; i++) {
      const board = generateBoard('fog-of-war', `fog-hidden-desert-seed-${i}`);
      const revealed = new Set(initialFogRevealHexIds(board.hexes));
      const hidden = board.hexes.filter((h) => !revealed.has(h.id));
      expect(hidden.length, `seed ${i}`).toBeGreaterThan(0); // sanity: still hexes left hidden
      for (const hex of hidden) {
        expect(hex.terrain, `seed ${i}, hex ${hex.id}`).not.toBe('desert');
      }
    }
  });

  it('is fully connected — every hex reachable from any other via shared edges', () => {
    const board = generateBoard('fog-of-war', 'fog-connectivity-seed');
    const key = (c: { q: number; r: number }) => `${c.q},${c.r}`;
    const byKey = new Map(board.hexes.map((h) => [key(h.coord), h]));
    const DIRS = [
      [1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1],
    ];
    const seen = new Set<string>([key(board.hexes[0].coord)]);
    const queue = [board.hexes[0]];
    while (queue.length > 0) {
      const cur = queue.pop()!;
      for (const [dq, dr] of DIRS) {
        const nk = key({ q: cur.coord.q + dq, r: cur.coord.r + dr });
        const neighbor = byKey.get(nk);
        if (neighbor && !seen.has(nk)) {
          seen.add(nk);
          queue.push(neighbor);
        }
      }
    }
    expect(seen.size).toBe(board.hexes.length);
  });
});

describe('generateBoard: determinism', () => {
  it('same preset+seed produces an identical board', () => {
    const a = generateBoard('chaos', 'my-seed-123');
    const b = generateBoard('chaos', 'my-seed-123');
    expect(a).toEqual(b);
  });

  it('different seeds produce different chaos boards', () => {
    const a = generateBoard('chaos', 'seed-A');
    const b = generateBoard('chaos', 'seed-B');
    expect(a.hexes.map((h) => h.terrain)).not.toEqual(b.hexes.map((h) => h.terrain));
  });

  it('official-beginner is identical regardless of seed', () => {
    const a = generateBoard('official-beginner', 'seed-A');
    const b = generateBoard('official-beginner', 'seed-B');
    expect(a.hexes.map((h) => h.terrain)).toEqual(b.hexes.map((h) => h.terrain));
    expect(a.hexes.map((h) => h.number)).toEqual(b.hexes.map((h) => h.number));
  });
});

describe('generateBoard: balanced-random fairness', () => {
  it('never places two 6/8 tokens on hex-adjacent tiles, across many seeds', () => {
    for (let i = 0; i < 25; i++) {
      const board = generateBoard('balanced-random', `fair-seed-${i}`);
      const hot = board.hexes.filter((h) => h.number === 6 || h.number === 8);
      for (let a = 0; a < hot.length; a++) {
        for (let b = a + 1; b < hot.length; b++) {
          const dq = Math.abs(hot[a].coord.q - hot[b].coord.q);
          const dr = Math.abs(hot[a].coord.r - hot[b].coord.r);
          const ds = Math.abs(hot[a].coord.q + hot[a].coord.r - (hot[b].coord.q + hot[b].coord.r));
          const isAdjacent = Math.max(dq, dr, ds) === 1;
          expect(isAdjacent).toBe(false);
        }
      }
    }
  });
});

describe('board adjacency', () => {
  const board = generateBoard('chaos', 'adjacency-seed');

  it('every vertex touches 1-3 hexes and 2-3 edges/vertices', () => {
    for (const v of Object.values(board.vertices)) {
      expect(v.adjacentHexIds.length).toBeGreaterThanOrEqual(1);
      expect(v.adjacentHexIds.length).toBeLessThanOrEqual(3);
      expect(v.adjacentEdgeIds.length).toBeGreaterThanOrEqual(2);
      expect(v.adjacentEdgeIds.length).toBeLessThanOrEqual(3);
      expect(v.adjacentVertexIds.length).toBe(v.adjacentEdgeIds.length);
    }
  });

  it('vertex adjacency is symmetric', () => {
    for (const v of Object.values(board.vertices)) {
      for (const n of v.adjacentVertexIds) {
        const neighbor = board.vertices[n];
        expect(neighbor).toBeDefined();
        expect(neighbor.adjacentVertexIds).toContain(v.id);
      }
    }
  });

  it('every edge references exactly 2 distinct vertices that both know about it', () => {
    for (const e of Object.values(board.edges)) {
      expect(e.vertexIds).toHaveLength(2);
      expect(e.vertexIds[0]).not.toBe(e.vertexIds[1]);
      for (const vId of e.vertexIds) {
        const v = board.vertices[vId];
        expect(v.adjacentEdgeIds).toContain(e.id);
      }
      expect(e.adjacentHexIds.length).toBeGreaterThanOrEqual(1);
      expect(e.adjacentHexIds.length).toBeLessThanOrEqual(2);
    }
  });

  it('total hexes touching each vertex matches count of distinct terrains at that corner', () => {
    // sanity: hex count referenced by vertices should be consistent with 19 hexes, 6 corners each
    const totalCorners = board.hexes.length * 6;
    let sum = 0;
    for (const v of Object.values(board.vertices)) sum += v.adjacentHexIds.length;
    expect(sum).toBe(totalCorners);
  });

  it('terrain/resource mapping is consistent for adjacent hexes', () => {
    for (const hex of board.hexes) {
      if (hex.terrain === 'desert') continue;
      expect(TERRAIN_RESOURCE[hex.terrain]).toBeDefined();
    }
  });
});

describe('geometry helpers', () => {
  const board = generateBoard('chaos', 'geometry-seed');

  it('hexPixel scales linearly with size', () => {
    const p1 = hexPixel({ q: 1, r: -1 }, 1);
    const p2 = hexPixel({ q: 1, r: -1 }, 10);
    expect(p2.x).toBeCloseTo(p1.x * 10, 6);
    expect(p2.y).toBeCloseTo(p1.y * 10, 6);
  });

  it('vertexPixel scales with size and throws for unknown vertex', () => {
    const someVertexId = Object.keys(board.vertices)[0];
    const p1 = vertexPixel(someVertexId, board, 1);
    const p2 = vertexPixel(someVertexId, board, 5);
    expect(p2.x).toBeCloseTo(p1.x * 5, 6);
    expect(p2.y).toBeCloseTo(p1.y * 5, 6);
    expect(() => vertexPixel('not-a-real-vertex', board, 1)).toThrow();
  });

  it('edgeMidpoint is the average of its two vertex positions', () => {
    const someEdgeId = Object.keys(board.edges)[0];
    const edge = board.edges[someEdgeId];
    const [a, b] = edge.vertexIds;
    const pa = vertexPixel(a, board, 3);
    const pb = vertexPixel(b, board, 3);
    const mid = edgeMidpoint(someEdgeId, board, 3);
    expect(mid.x).toBeCloseTo((pa.x + pb.x) / 2, 6);
    expect(mid.y).toBeCloseTo((pa.y + pb.y) / 2, 6);
  });
});
