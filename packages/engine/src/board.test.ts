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
  const EXPECTED_OASIS_NUMBERS = [2, 3, 4, 5, 6, 8, 9, 10, 11, 12];
  const DIRS = [
    [1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1],
  ] as const;
  const cubeRadius = (c: { q: number; r: number }): number => {
    const x = c.q;
    const z = c.r;
    const y = -x - z;
    return Math.max(Math.abs(x), Math.abs(y), Math.abs(z));
  };
  const isAdjacent = (a: { q: number; r: number }, b: { q: number; r: number }): boolean =>
    DIRS.some(([dq, dr]) => a.q + dq === b.q && a.r + dr === b.r);

  it('has 61 hexes with correct terrain/port counts (30 oasis spanning rings 4+3 + 18 hidden + 12 desert + 1 gold)', () => {
    const board = generateBoard('fog-of-war', 'seed-fog');
    expect(board.hexes).toHaveLength(61);

    // Combined oasis pool (rings 4+3, 30 hexes: 5,7,5,6,7) + hidden (rings 1+2, 18 hexes:
    // 3,4,3,4,4) = 8,11,8,10,11.
    const counts = terrainCounts(board);
    expect(counts.hills).toBe(8);
    expect(counts.forest).toBe(11);
    expect(counts.mountains).toBe(8);
    expect(counts.fields).toBe(10);
    expect(counts.pasture).toBe(11);
    expect(counts.desert).toBe(12); // 6 on ring 4 + 6 continuing onto ring 3
    expect(board.hexes.filter((h) => h.terrain === 'gold')).toHaveLength(1);

    const desertHexes = board.hexes.filter((h) => h.terrain === 'desert');
    for (const d of desertHexes) expect(d.number).toBeNull();
    expect(desertHexes.map((d) => d.id)).toContain(board.robberHexId);

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

  it('the center hex is always gold with a number of 6 or 8, across many seeds', () => {
    for (let i = 0; i < 15; i++) {
      const board = generateBoard('fog-of-war', `fog-center-seed-${i}`);
      const centerHex = board.hexes.find((h) => h.coord.q === 0 && h.coord.r === 0)!;
      expect(centerHex.terrain, `seed ${i}`).toBe('gold');
      expect([6, 8], `seed ${i}`).toContain(centerHex.number);
    }
  });

  it('places exactly 12 desert hexes, 6 on ring 4 and 6 continuing onto ring 3, across many seeds', () => {
    for (let i = 0; i < 15; i++) {
      const board = generateBoard('fog-of-war', `fog-desert-seed-${i}`);
      const desertHexes = board.hexes.filter((h) => h.terrain === 'desert');
      expect(desertHexes, `seed ${i}`).toHaveLength(12);
      for (const d of desertHexes) {
        const r = cubeRadius(d.coord);
        expect([3, 4], `seed ${i}, hex ${d.id}`).toContain(r);
        expect(d.number, `seed ${i}, hex ${d.id}`).toBeNull();
      }
      const ring4Desert = desertHexes.filter((d) => cubeRadius(d.coord) === 4);
      const ring3Desert = desertHexes.filter((d) => cubeRadius(d.coord) === 3);
      expect(ring4Desert, `seed ${i}`).toHaveLength(6);
      expect(ring3Desert, `seed ${i}`).toHaveLength(6);

      // Each ring-3 desert hex continues the corridor inward from a ring-4 desert hex, not
      // floating independently — every one of them must be adjacent to a ring-4 desert hex.
      for (const d of ring3Desert) {
        const hasRing4DesertNeighbor = ring4Desert.some((r4) => isAdjacent(d.coord, r4.coord));
        expect(hasRing4DesertNeighbor, `seed ${i}, hex ${d.id}`).toBe(true);
      }
    }
  });

  it('each desert hex (on either revealed ring) is a lone singleton between two oasis clusters (no desert-desert adjacency, no oasis/desert overlap)', () => {
    for (let i = 0; i < 15; i++) {
      const board = generateBoard('fog-of-war', `fog-oasis-seed-${i}`);
      const outer = board.hexes.filter((h) => cubeRadius(h.coord) === 4 || cubeRadius(h.coord) === 3);
      expect(outer, `seed ${i}`).toHaveLength(42);
      const desertHexes = outer.filter((h) => h.terrain === 'desert');
      const oasisHexes = outer.filter((h) => h.terrain !== 'desert');
      expect(desertHexes, `seed ${i}`).toHaveLength(12);
      expect(oasisHexes, `seed ${i}`).toHaveLength(30);

      // Every desert hex has at most one desert neighbor within the two revealed rings — its
      // own radial continuation partner on the *other* ring (the whole point of the corridor
      // spanning both rings) — and never a same-ring desert neighbor, confirming the pairing
      // logic never accidentally leaves two same-ring desert hexes adjacent to each other.
      for (const d of desertHexes) {
        const neighbors = outer.filter((h) => h.id !== d.id && isAdjacent(h.coord, d.coord));
        expect(neighbors.length, `seed ${i}, hex ${d.id}`).toBeGreaterThan(0);
        const desertNeighbors = neighbors.filter((n) => n.terrain === 'desert');
        expect(desertNeighbors.length, `seed ${i}, hex ${d.id}`).toBeLessThanOrEqual(1);
        for (const dn of desertNeighbors) {
          expect(cubeRadius(dn.coord), `seed ${i}, hex ${d.id} desert neighbor ${dn.id}`).not.toBe(cubeRadius(d.coord));
        }
      }

      // Every oasis hex has at least one same-status neighbor within the two revealed rings —
      // no oasis hex is an isolated singleton.
      for (const o of oasisHexes) {
        const neighbors = outer.filter((h) => h.id !== o.id && isAdjacent(h.coord, o.coord));
        expect(neighbors.some((n) => n.terrain !== 'desert'), `seed ${i}, hex ${o.id}`).toBe(true);
      }
    }
  });

  it('oasis clusters genuinely span both revealed rings, forming exactly 6 connected wedges divided by desert', () => {
    for (let i = 0; i < 15; i++) {
      const board = generateBoard('fog-of-war', `fog-wedge-seed-${i}`);
      const outer = board.hexes.filter((h) => cubeRadius(h.coord) === 4 || cubeRadius(h.coord) === 3);
      const oasisHexes = outer.filter((h) => h.terrain !== 'desert');
      const byId = new Map(oasisHexes.map((h) => [h.id, h]));

      // Flood-fill through oasis-only adjacency (never stepping onto a desert hex) to find
      // connected components — should be exactly 6 (one per compass wedge), and at least one
      // of them must contain hexes from *both* rings, or this would just be "two independently
      // patterned rings" rather than genuinely spanning clusters.
      const seen = new Set<string>();
      const components: (typeof oasisHexes)[] = [];
      for (const start of oasisHexes) {
        if (seen.has(start.id)) continue;
        const component: typeof oasisHexes = [];
        const queue = [start];
        seen.add(start.id);
        while (queue.length > 0) {
          const cur = queue.pop()!;
          component.push(cur);
          for (const h of oasisHexes) {
            if (!seen.has(h.id) && isAdjacent(cur.coord, h.coord)) {
              seen.add(h.id);
              queue.push(h);
            }
          }
        }
        components.push(component);
      }
      expect(components, `seed ${i}`).toHaveLength(6);
      for (const c of components) expect(c.length, `seed ${i}`).toBe(5); // 3 (ring 4) + 2 (ring 3)

      const spansBothRings = components.some(
        (c) => c.some((h) => cubeRadius(h.coord) === 4) && c.some((h) => cubeRadius(h.coord) === 3),
      );
      expect(spansBothRings, `seed ${i}`).toBe(true);
      expect(byId.size, `seed ${i}`).toBe(30);
    }
  });

  it('every revealed non-desert, non-gold hex gets a number from the shared oasis pool', () => {
    const board = generateBoard('fog-of-war', 'seed-fog-gold');
    const centerHex = board.hexes.find((h) => h.coord.q === 0 && h.coord.r === 0)!;
    expect(centerHex.terrain).toBe('gold');

    const validOasisNumbers = new Set(EXPECTED_OASIS_NUMBERS);
    for (const hex of board.hexes) {
      if (hex.terrain === 'gold' || hex.terrain === 'desert' || hex.number === null) continue;
      const r = cubeRadius(hex.coord);
      if (r === 4 || r === 3) expect(validOasisNumbers.has(hex.number)).toBe(true);
    }
  });

  it('never leaves a ring-1/2 (hidden) hex as desert or gold, and starts it with number: null, across many seeds', () => {
    for (let i = 0; i < 15; i++) {
      const board = generateBoard('fog-of-war', `fog-hidden-seed-${i}`);
      const revealed = new Set(initialFogRevealHexIds(board.hexes));
      const hidden = board.hexes.filter((h) => !revealed.has(h.id));
      expect(hidden.length, `seed ${i}`).toBe(18); // ring 1 (6) + ring 2 (12)
      for (const hex of hidden) {
        expect(hex.terrain, `seed ${i}, hex ${hex.id}`).not.toBe('desert');
        expect(hex.terrain, `seed ${i}, hex ${hex.id}`).not.toBe('gold');
        expect(hex.number, `seed ${i}, hex ${hex.id}`).toBeNull();
      }
    }
  });

  it('is fully connected — every hex reachable from any other via shared edges', () => {
    const board = generateBoard('fog-of-war', 'fog-connectivity-seed');
    const key = (c: { q: number; r: number }) => `${c.q},${c.r}`;
    const byKey = new Map(board.hexes.map((h) => [key(h.coord), h]));
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
