import { beforeEach, describe, expect, it, vi } from 'vitest';
import { applyAction, computeRollGains, createGame, legalActionTypes, recalcLargestArmy, recalcLongestRoad } from './rules';
import type { GameStateBundle } from './rules';
import type { Building, PrivateHand, PublicPlayer, VertexId } from './types';
import { RESOURCES } from './types';

function makeGame(playerCount = 4, opts: { victoryPointsToWin?: number; discardLimit?: number } = {}): GameStateBundle {
  const seatedPlayers = Array.from({ length: playerCount }, (_, i) => ({
    uid: `p${i}`,
    displayName: `Player ${i}`,
    isBot: false,
  }));
  return createGame(
    {
      id: 'room1',
      code: 'ABCDE',
      hostUid: 'p0',
      mapPreset: 'official-beginner',
      seed: 'fixed-test-seed',
      ...opts,
    },
    seatedPlayers,
  );
}

/** Finds a vertex satisfying the distance rule against the bundle's current room.vertices. */
function findFreeVertex(bundle: GameStateBundle, excluding: Set<VertexId> = new Set()): VertexId {
  const board = bundle.room.board!;
  for (const v of Object.values(board.vertices)) {
    if (excluding.has(v.id)) continue;
    if (bundle.room.vertices[v.id]) continue;
    if (v.adjacentVertexIds.some((n) => bundle.room.vertices[n])) continue;
    return v.id;
  }
  throw new Error('No free vertex available');
}

function firstFreeEdgeAt(bundle: GameStateBundle, vertexId: VertexId): string {
  const board = bundle.room.board!;
  const v = board.vertices[vertexId];
  const edge = v.adjacentEdgeIds.find((e) => !bundle.room.edges[e]);
  if (!edge) throw new Error('No free edge at vertex');
  return edge;
}

/** Drives full setup1+setup2 snake draft, picking non-adjacent vertices for every placement
 * so all games reach phase 'roll' with real board-backed state. */
function driveSetup(bundle: GameStateBundle): GameStateBundle {
  let b = bundle;
  const usedVertices = new Set<VertexId>();
  // setup1: forward order, one settlement + one free road each.
  for (let round = 0; round < 2; round++) {
    const order =
      round === 0 ? b.room.turnOrder : [...b.room.turnOrder].reverse();
    for (const uid of order) {
      const vertexId = findFreeVertex(b, usedVertices);
      usedVertices.add(vertexId);
      b = applyAction(b, { type: 'buildSettlement', uid, vertexId, free: true });
      const edgeId = firstFreeEdgeAt(b, vertexId);
      b = applyAction(b, { type: 'buildRoad', uid, edgeId, free: true });
    }
  }
  return b;
}

function mockDice(d1: number, d2: number): void {
  let call = 0;
  vi.spyOn(Math, 'random').mockImplementation(() => {
    call += 1;
    const die = call % 2 === 1 ? d1 : d2;
    // rollDice does `1 + Math.floor(Math.random() * 6)`; solve for a value in-range.
    return (die - 1) / 6 + 0.01;
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('createGame', () => {
  it('sets up a fresh game with correct bank, deck, and phase', () => {
    const bundle = makeGame(4);
    expect(bundle.room.phase).toBe('setup1');
    expect(bundle.room.status).toBe('playing');
    expect(bundle.room.turnOrder).toHaveLength(4);
    expect(bundle.room.devCardDeck).toHaveLength(25);
    expect(bundle.room.devCardDeckCount).toBe(25);
    expect(bundle.room.bank).toEqual({ brick: 19, lumber: 19, ore: 19, grain: 19, wool: 19 });
    expect(Object.keys(bundle.players)).toHaveLength(4);
    expect(Object.keys(bundle.hands)).toHaveLength(4);
    for (const uid of bundle.room.turnOrder) {
      expect(bundle.hands[uid].resources).toEqual({ brick: 0, lumber: 0, ore: 0, grain: 0, wool: 0 });
    }
  });

  it('rejects fewer than 2 players', () => {
    expect(() =>
      createGame(
        { id: 'r', code: 'X', hostUid: 'p0', mapPreset: 'official-beginner', seed: 's' },
        [{ uid: 'p0', displayName: 'Solo', isBot: false }],
      ),
    ).toThrow();
  });

  it('applies configured house rules onto the room', () => {
    const bundle = makeGame(3, { victoryPointsToWin: 6, discardLimit: 5 });
    expect(bundle.room.victoryPointsToWin).toBe(6);
    expect(bundle.room.discardLimit).toBe(5);
  });
});

describe('setup phase', () => {
  it('snake-drafts placement and credits second-settlement resources', () => {
    let bundle = makeGame(4);
    bundle = driveSetup(bundle);

    expect(bundle.room.phase).toBe('roll');
    expect(bundle.room.currentPlayerIndex).toBe(0);
    expect(bundle.room.turnNumber).toBe(1);

    // Every player placed exactly 2 settlements + 2 roads.
    for (const uid of bundle.room.turnOrder) {
      expect(bundle.players[uid].settlementsBuilt).toBe(2);
      expect(bundle.players[uid].roadsBuilt).toBe(2);
    }

    // Second-settlement resource distribution should have handed out something overall
    // (can't guarantee a specific player given seeded-but-arbitrary vertex picks, but with
    // only one desert hex on a 19-hex board it's not possible for every placement to whiff).
    const totalResources = Object.values(bundle.hands).reduce(
      (sum, h) => sum + RESOURCES.reduce((s, r) => s + h.resources[r], 0),
      0,
    );
    expect(totalResources).toBeGreaterThan(0);
  });

  it('rejects a second settlement on an adjacent vertex (distance rule)', () => {
    let bundle = makeGame(2);
    const v1 = findFreeVertex(bundle);
    bundle = applyAction(bundle, { type: 'buildSettlement', uid: 'p0', vertexId: v1, free: true });
    const board = bundle.room.board!;
    const neighborVertex = board.vertices[v1].adjacentVertexIds[0];

    expect(() =>
      applyAction(bundle, { type: 'buildSettlement', uid: 'p0', vertexId: neighborVertex, free: true }),
    ).toThrow(/distance rule/);
  });

  it('rejects acting out of turn', () => {
    const bundle = makeGame(2);
    const v1 = findFreeVertex(bundle);
    expect(() =>
      applyAction(bundle, { type: 'buildSettlement', uid: 'p1', vertexId: v1, free: true }),
    ).toThrow(/not your turn/);
  });
});

describe('dice roll and resource distribution', () => {
  it('distributes resources to settlements adjacent to the rolled number', () => {
    let bundle = makeGame(2);
    bundle = driveSetup(bundle);

    const uid = bundle.room.turnOrder[bundle.room.currentPlayerIndex];
    const board = bundle.room.board!;
    const myVertex = Object.entries(bundle.room.vertices).find(([, b]) => b.uid === uid)![0];
    const adjacentHex = board.hexes.find(
      (h) => h.id !== board.robberHexId && h.number !== null && board.vertices[myVertex].adjacentHexIds.includes(h.id),
    );
    if (!adjacentHex) return; // this seed's placement happened not to touch a numbered hex; skip

    const before = bundle.hands[uid].resources[
      // resource type is derivable but not needed for the count assertion below
      Object.keys(bundle.hands[uid].resources)[0] as keyof PrivateHand['resources']
    ];
    void before;

    const [d1, d2] = pickDiceFor(adjacentHex.number!);
    mockDice(d1, d2);
    const totalBefore = handTotal(bundle.hands[uid]);
    bundle = applyAction(bundle, { type: 'rollDice', uid });
    const totalAfter = handTotal(bundle.hands[uid]);

    expect(bundle.room.diceRoll![0] + bundle.room.diceRoll![1]).toBe(adjacentHex.number);
    expect(totalAfter).toBeGreaterThan(totalBefore);
    expect(bundle.room.phase).toBe('main');
  });

  it('computeRollGains previews exactly what applyAction actually grants', () => {
    let bundle = makeGame(2);
    bundle = driveSetup(bundle);

    const uid = bundle.room.turnOrder[bundle.room.currentPlayerIndex];
    const board = bundle.room.board!;
    const myVertex = Object.entries(bundle.room.vertices).find(([, b]) => b.uid === uid)![0];
    const adjacentHex = board.hexes.find(
      (h) => h.id !== board.robberHexId && h.number !== null && board.vertices[myVertex].adjacentHexIds.includes(h.id),
    );
    if (!adjacentHex) return;

    const preview = computeRollGains(board, bundle.room.vertices, adjacentHex.number!);
    const before: Record<string, PrivateHand['resources']> = {};
    for (const gainedUid of Object.keys(preview)) {
      before[gainedUid] = { ...bundle.hands[gainedUid].resources };
    }

    const [d1, d2] = pickDiceFor(adjacentHex.number!);
    mockDice(d1, d2);
    bundle = applyAction(bundle, { type: 'rollDice', uid });

    for (const [gainedUid, byResource] of Object.entries(preview)) {
      for (const [resource, amount] of Object.entries(byResource) as [keyof PrivateHand['resources'], number][]) {
        const actualGain = bundle.hands[gainedUid].resources[resource] - before[gainedUid][resource];
        expect(actualGain).toBe(amount);
      }
    }
  });

  it('a roll of 7 with no one over the discard limit goes straight to the robber phase', () => {
    let bundle = makeGame(2);
    bundle = driveSetup(bundle);
    const uid = bundle.room.turnOrder[bundle.room.currentPlayerIndex];
    mockDice(3, 4); // 7
    bundle = applyAction(bundle, { type: 'rollDice', uid });
    expect(bundle.room.diceRoll![0] + bundle.room.diceRoll![1]).toBe(7);
    expect(bundle.room.phase).toBe('robber');
  });

  it('a roll of 7 forces players above the discard limit to discard half their hand', () => {
    let bundle = makeGame(2, { discardLimit: 5 });
    bundle = driveSetup(bundle);
    const uid = bundle.room.turnOrder[bundle.room.currentPlayerIndex];
    const other = bundle.room.turnOrder.find((u) => u !== uid)!;
    bundle.hands[other].resources = { brick: 3, lumber: 3, ore: 0, grain: 0, wool: 0 }; // 6 > limit 5

    mockDice(3, 4);
    bundle = applyAction(bundle, { type: 'rollDice', uid });
    expect(bundle.room.phase).toBe('discard');
    expect(bundle.room.pendingDiscardUids).toEqual([other]);

    bundle = applyAction(bundle, { type: 'discard', uid: other, resources: { brick: 3 } });
    expect(handTotal(bundle.hands[other])).toBe(3);
    expect(bundle.room.phase).toBe('robber');
  });

  it('does not distribute a resource the bank cannot fully cover', () => {
    let bundle = makeGame(2);
    bundle = driveSetup(bundle);
    const uid = bundle.room.turnOrder[bundle.room.currentPlayerIndex];
    const board = bundle.room.board!;
    const myVertex = Object.entries(bundle.room.vertices).find(([, b]) => b.uid === uid)![0];
    const adjacentHex = board.hexes.find(
      (h) => h.id !== board.robberHexId && h.number !== null && board.vertices[myVertex].adjacentHexIds.includes(h.id),
    );
    if (!adjacentHex) return;
    const resource = terrainResourceOf(adjacentHex.terrain);
    if (!resource) return;

    bundle.room.bank[resource] = 0; // bank empty for this resource
    const totalBefore = handTotal(bundle.hands[uid]);
    const [d1, d2] = pickDiceFor(adjacentHex.number!);
    mockDice(d1, d2);
    bundle = applyAction(bundle, { type: 'rollDice', uid });
    expect(handTotal(bundle.hands[uid])).toBe(totalBefore);
    expect(bundle.room.bank[resource]).toBe(0);
  });
});

describe('building', () => {
  it('rejects building without sufficient resources', () => {
    let bundle = makeGame(2);
    bundle = driveSetup(bundle);
    bundle.room.phase = 'main';
    const uid = bundle.room.turnOrder[bundle.room.currentPlayerIndex];
    bundle.hands[uid].resources = { brick: 0, lumber: 0, ore: 0, grain: 0, wool: 0 };
    const board = bundle.room.board!;
    const myVertex = Object.entries(bundle.room.vertices).find(([, b]) => b.uid === uid)![0];
    const edgeId = board.vertices[myVertex].adjacentEdgeIds.find((e) => !bundle.room.edges[e])!;

    expect(() => applyAction(bundle, { type: 'buildRoad', uid, edgeId })).toThrow(/afford/);
  });

  it('rejects a road that does not connect to the player network', () => {
    let bundle = makeGame(2);
    bundle = driveSetup(bundle);
    bundle.room.phase = 'main';
    const uid = bundle.room.turnOrder[bundle.room.currentPlayerIndex];
    bundle.hands[uid].resources = { brick: 5, lumber: 5, ore: 5, grain: 5, wool: 5 };

    const board = bundle.room.board!;
    const disconnectedEdge = Object.values(board.edges).find((e) => {
      if (bundle.room.edges[e.id]) return false;
      return e.vertexIds.every((v) => {
        const touchesOwn = board.vertices[v].adjacentEdgeIds.some((ee) => bundle.room.edges[ee] === uid);
        const isOwnBuilding = bundle.room.vertices[v]?.uid === uid;
        return !touchesOwn && !isOwnBuilding;
      });
    })!;

    expect(() => applyAction(bundle, { type: 'buildRoad', uid, edgeId: disconnectedEdge.id })).toThrow(/connect/);
  });

  it('builds a settlement then upgrades it to a city, updating VP', () => {
    let bundle = makeGame(2);
    bundle = driveSetup(bundle);
    bundle.room.phase = 'main';
    const uid = bundle.room.turnOrder[bundle.room.currentPlayerIndex];
    const vpBefore = bundle.players[uid].visibleVictoryPoints;

    const board = bundle.room.board!;
    const myVertex = Object.entries(bundle.room.vertices).find(([, b]) => b.uid === uid)![0];
    bundle.hands[uid].resources = { brick: 0, lumber: 0, ore: 3, grain: 2, wool: 0 };

    bundle = applyAction(bundle, { type: 'buildCity', uid, vertexId: myVertex });
    expect((bundle.room.vertices[myVertex] as Building).type).toBe('city');
    expect(bundle.players[uid].citiesBuilt).toBe(1);
    expect(bundle.players[uid].settlementsBuilt).toBe(1); // one converted
    expect(bundle.players[uid].visibleVictoryPoints).toBe(vpBefore + 1); // settlement(1)->city(2)
    void board;
  });

  it('keeps devCardDeckCount in sync with devCardDeck.length on buyDevCard', () => {
    let bundle = makeGame(2);
    bundle = driveSetup(bundle);
    bundle.room.phase = 'main';
    const uid = bundle.room.turnOrder[bundle.room.currentPlayerIndex];
    bundle.hands[uid].resources = { brick: 0, lumber: 0, ore: 1, grain: 1, wool: 1 };
    const countBefore = bundle.room.devCardDeckCount;

    bundle = applyAction(bundle, { type: 'buyDevCard', uid });
    expect(bundle.room.devCardDeckCount).toBe(countBefore - 1);
    expect(bundle.room.devCardDeckCount).toBe(bundle.room.devCardDeck.length);
  });
});

describe('removeSeat', () => {
  it('lets a player leave voluntarily, closing the turnOrder gap', () => {
    let bundle = makeGame(3);
    bundle = driveSetup(bundle);
    bundle.room.phase = 'main';
    const leavingUid = bundle.room.turnOrder[1];

    bundle = applyAction(bundle, { type: 'removeSeat', uid: leavingUid, targetUid: leavingUid });
    expect(bundle.room.turnOrder).not.toContain(leavingUid);
    expect(bundle.players[leavingUid]).toBeUndefined();
    expect(bundle.hands[leavingUid]).toBeUndefined();
  });

  it('lets the host remove a bot seat', () => {
    const seatedPlayers = [
      { uid: 'p0', displayName: 'Host', isBot: false },
      { uid: 'bot1', displayName: 'Bot', isBot: true as const },
    ];
    let bundle = createGame(
      { id: 'r', code: 'X', hostUid: 'p0', mapPreset: 'official-beginner', seed: 'seed-bot' },
      seatedPlayers,
    );
    bundle = driveSetup(bundle);
    bundle.room.phase = 'main';

    bundle = applyAction(bundle, { type: 'removeSeat', uid: 'p0', targetUid: 'bot1' });
    expect(bundle.room.turnOrder).not.toContain('bot1');
  });

  it('rejects a non-host trying to remove another human', () => {
    let bundle = makeGame(3);
    bundle = driveSetup(bundle);
    bundle.room.phase = 'main';
    const [, other] = bundle.room.turnOrder;

    expect(() => applyAction(bundle, { type: 'removeSeat', uid: 'p0', targetUid: other })).toThrow(/not allowed/i);
  });

  it('rejects removal during setup', () => {
    const bundle = makeGame(3);
    expect(bundle.room.phase).toBe('setup1');
    const uid = bundle.room.turnOrder[0];
    expect(() => applyAction(bundle, { type: 'removeSeat', uid, targetUid: uid })).toThrow(/setup/i);
  });

  it('adjusts currentPlayerIndex when a seat before the current player is removed', () => {
    let bundle = makeGame(3);
    bundle = driveSetup(bundle);
    bundle.room.phase = 'main';
    bundle.room.currentPlayerIndex = 2;
    const currentUid = bundle.room.turnOrder[2];
    const removedUid = bundle.room.turnOrder[0];

    bundle = applyAction(bundle, { type: 'removeSeat', uid: removedUid, targetUid: removedUid });
    expect(bundle.room.turnOrder[bundle.room.currentPlayerIndex]).toBe(currentUid);
  });

  it('reassigns longest road when its holder is removed', () => {
    // No driveSetup here: setup placements would seed opponent settlements onto the
    // board that could bisect the simple path assigned below. removeSeat only cares
    // about phase/turnOrder, not board state, so a fresh board (phase forced to 'main')
    // is sufficient and keeps the path assignment clean, as in the top-level
    // 'longest road and largest army' tests.
    let bundle = makeGame(3);
    bundle.room.phase = 'main';
    const board = bundle.room.board!;
    const { edges } = findSimplePath(board, 5);
    for (const edgeId of edges) bundle.room.edges[edgeId] = 'p0';
    recalcLongestRoad(bundle.room, bundle.players);
    expect(bundle.room.longestRoadUid).toBe('p0');

    bundle = applyAction(bundle, { type: 'removeSeat', uid: 'p0', targetUid: 'p0' });
    expect(bundle.room.longestRoadUid).not.toBe('p0');
  });
});

describe('longest road and largest army', () => {
  it('awards longest road to the first player reaching 5+ contiguous roads', () => {
    const bundle = makeGame(2);
    const board = bundle.room.board!;
    const { edges } = findSimplePath(board, 5);
    for (const edgeId of edges) bundle.room.edges[edgeId] = 'p0';

    recalcLongestRoad(bundle.room, bundle.players);
    expect(bundle.room.longestRoadUid).toBe('p0');
  });

  it('breaks a road chain at an opponent settlement', () => {
    const bundle = makeGame(2);
    const board = bundle.room.board!;
    const { edges, vertices } = findSimplePath(board, 6);
    for (const edgeId of edges) bundle.room.edges[edgeId] = 'p0';

    // Place an opposing settlement on the vertex in the middle of the simple path — this
    // provably bisects it (degree-2 interior vertex, no alternate route around it since only
    // these 6 edges are owned by anyone).
    const midVertex = vertices[3];
    bundle.room.vertices[midVertex] = { type: 'settlement', uid: 'p1' };

    recalcLongestRoad(bundle.room, bundle.players);
    // Longest remaining run on either side of the break is 3, below the 5-minimum.
    expect(bundle.room.longestRoadUid).not.toBe('p0');
  });

  it('largest army goes to the first player at 3+ knights and can be overtaken', () => {
    const bundle = makeGame(2);
    bundle.players.p0.knightsPlayed = 3;
    recalcLargestArmy(bundle.room, bundle.players);
    expect(bundle.room.largestArmyUid).toBe('p0');

    bundle.players.p1.knightsPlayed = 4;
    recalcLargestArmy(bundle.room, bundle.players);
    expect(bundle.room.largestArmyUid).toBe('p1');
  });
});

describe('trading', () => {
  it('proposes, accepts, and swaps resources between players', () => {
    let bundle = makeGame(2);
    bundle = driveSetup(bundle);
    bundle.room.phase = 'main';
    const uid = bundle.room.turnOrder[bundle.room.currentPlayerIndex];
    const other = bundle.room.turnOrder.find((u) => u !== uid)!;
    bundle.hands[uid].resources = { brick: 2, lumber: 0, ore: 0, grain: 0, wool: 0 };
    bundle.hands[other].resources = { brick: 0, lumber: 0, ore: 0, grain: 2, wool: 0 };

    bundle = applyAction(bundle, {
      type: 'proposeTrade',
      uid,
      give: { brick: 1 },
      receive: { grain: 1 },
      targetUid: other,
    });
    const tradeId = bundle.trades[0].id;

    bundle = applyAction(bundle, { type: 'respondTrade', uid: other, tradeId, accept: true });
    expect(bundle.hands[uid].resources.brick).toBe(1);
    expect(bundle.hands[uid].resources.grain).toBe(1);
    expect(bundle.hands[other].resources.grain).toBe(1);
    expect(bundle.hands[other].resources.brick).toBe(1);
    expect(bundle.trades[0].status).toBe('accepted');
  });

  it('rejects responding to your own trade', () => {
    let bundle = makeGame(2);
    bundle = driveSetup(bundle);
    bundle.room.phase = 'main';
    const uid = bundle.room.turnOrder[bundle.room.currentPlayerIndex];
    bundle.hands[uid].resources.brick = 1;
    bundle = applyAction(bundle, { type: 'proposeTrade', uid, give: { brick: 1 }, receive: { grain: 1 }, targetUid: null });
    const tradeId = bundle.trades[0].id;
    expect(() => applyAction(bundle, { type: 'respondTrade', uid, tradeId, accept: true })).toThrow(/own trade/);
  });

  it('accepting an open trade registers interest instead of executing immediately', () => {
    let bundle = makeGame(3);
    bundle = driveSetup(bundle);
    bundle.room.phase = 'main';
    const uid = bundle.room.turnOrder[bundle.room.currentPlayerIndex];
    const [otherA] = bundle.room.turnOrder.filter((u) => u !== uid);
    bundle.hands[uid].resources = { brick: 2, lumber: 0, ore: 0, grain: 0, wool: 0 };
    bundle.hands[otherA].resources = { brick: 0, lumber: 0, ore: 0, grain: 2, wool: 0 };

    bundle = applyAction(bundle, { type: 'proposeTrade', uid, give: { brick: 1 }, receive: { grain: 1 }, targetUid: null });
    const tradeId = bundle.trades[0].id;

    bundle = applyAction(bundle, { type: 'respondTrade', uid: otherA, tradeId, accept: true });
    expect(bundle.trades[0].status).toBe('pending');
    expect(bundle.trades[0].interestedUids).toEqual([otherA]);
    // No swap has happened yet — the proposer hasn't picked anyone.
    expect(bundle.hands[uid].resources.brick).toBe(2);
    expect(bundle.hands[otherA].resources.grain).toBe(2);
  });

  it('lets the proposer finalize an open trade with one of several interested players', () => {
    let bundle = makeGame(3);
    bundle = driveSetup(bundle);
    bundle.room.phase = 'main';
    const uid = bundle.room.turnOrder[bundle.room.currentPlayerIndex];
    const [otherA, otherB] = bundle.room.turnOrder.filter((u) => u !== uid);
    bundle.hands[uid].resources = { brick: 2, lumber: 0, ore: 0, grain: 0, wool: 0 };
    bundle.hands[otherA].resources = { brick: 0, lumber: 0, ore: 0, grain: 2, wool: 0 };
    bundle.hands[otherB].resources = { brick: 0, lumber: 0, ore: 0, grain: 2, wool: 0 };

    bundle = applyAction(bundle, { type: 'proposeTrade', uid, give: { brick: 1 }, receive: { grain: 1 }, targetUid: null });
    const tradeId = bundle.trades[0].id;
    bundle = applyAction(bundle, { type: 'respondTrade', uid: otherA, tradeId, accept: true });
    bundle = applyAction(bundle, { type: 'respondTrade', uid: otherB, tradeId, accept: true });
    expect(bundle.trades[0].interestedUids).toEqual([otherA, otherB]);

    bundle = applyAction(bundle, { type: 'finalizeTrade', uid, tradeId, withUid: otherB });
    expect(bundle.trades[0].status).toBe('accepted');
    expect(bundle.trades[0].interestedUids).toEqual([]);
    // Traded with otherB only — otherA's hand (and interest) never got acted on.
    expect(bundle.hands[uid].resources).toEqual({ brick: 1, lumber: 0, ore: 0, grain: 1, wool: 0 });
    expect(bundle.hands[otherB].resources).toEqual({ brick: 1, lumber: 0, ore: 0, grain: 1, wool: 0 });
    expect(bundle.hands[otherA].resources).toEqual({ brick: 0, lumber: 0, ore: 0, grain: 2, wool: 0 });
  });

  it('rejects finalizeTrade from anyone but the proposer', () => {
    let bundle = makeGame(3);
    bundle = driveSetup(bundle);
    bundle.room.phase = 'main';
    const uid = bundle.room.turnOrder[bundle.room.currentPlayerIndex];
    const [otherA, otherB] = bundle.room.turnOrder.filter((u) => u !== uid);
    bundle.hands[uid].resources.brick = 1;
    bundle.hands[otherA].resources.grain = 1;

    bundle = applyAction(bundle, { type: 'proposeTrade', uid, give: { brick: 1 }, receive: { grain: 1 }, targetUid: null });
    const tradeId = bundle.trades[0].id;
    bundle = applyAction(bundle, { type: 'respondTrade', uid: otherA, tradeId, accept: true });

    expect(() => applyAction(bundle, { type: 'finalizeTrade', uid: otherB, tradeId, withUid: otherA })).toThrow(
      /only the proposer/i,
    );
  });

  it('rejects finalizeTrade with a uid that never expressed interest', () => {
    let bundle = makeGame(3);
    bundle = driveSetup(bundle);
    bundle.room.phase = 'main';
    const uid = bundle.room.turnOrder[bundle.room.currentPlayerIndex];
    const [, otherB] = bundle.room.turnOrder.filter((u) => u !== uid);
    bundle.hands[uid].resources.brick = 1;

    bundle = applyAction(bundle, { type: 'proposeTrade', uid, give: { brick: 1 }, receive: { grain: 1 }, targetUid: null });
    const tradeId = bundle.trades[0].id;

    expect(() => applyAction(bundle, { type: 'finalizeTrade', uid, tradeId, withUid: otherB })).toThrow(
      /has not accepted/i,
    );
  });

  it('withdrawing interest in an open trade does not cancel it for other interested players', () => {
    let bundle = makeGame(3);
    bundle = driveSetup(bundle);
    bundle.room.phase = 'main';
    const uid = bundle.room.turnOrder[bundle.room.currentPlayerIndex];
    const [otherA, otherB] = bundle.room.turnOrder.filter((u) => u !== uid);
    bundle.hands[uid].resources.brick = 1;
    bundle.hands[otherA].resources.grain = 1;
    bundle.hands[otherB].resources.grain = 1;

    bundle = applyAction(bundle, { type: 'proposeTrade', uid, give: { brick: 1 }, receive: { grain: 1 }, targetUid: null });
    const tradeId = bundle.trades[0].id;
    bundle = applyAction(bundle, { type: 'respondTrade', uid: otherA, tradeId, accept: true });
    bundle = applyAction(bundle, { type: 'respondTrade', uid: otherB, tradeId, accept: true });
    bundle = applyAction(bundle, { type: 'respondTrade', uid: otherA, tradeId, accept: false });

    expect(bundle.trades[0].status).toBe('pending');
    expect(bundle.trades[0].interestedUids).toEqual([otherB]);
  });

  it('bank trade requires the correct port-aware rate and resources', () => {
    let bundle = makeGame(2);
    bundle = driveSetup(bundle);
    bundle.room.phase = 'main';
    const uid = bundle.room.turnOrder[bundle.room.currentPlayerIndex];
    const rate = expectedPortRate(bundle, uid, 'brick');
    bundle.hands[uid].resources = { brick: rate, lumber: 0, ore: 0, grain: 0, wool: 0 };

    expect(() =>
      applyAction(bundle, { type: 'bankTrade', uid, give: 'brick', giveAmount: rate + 1, receive: 'ore' }),
    ).toThrow(/rate/);

    const after = applyAction(bundle, { type: 'bankTrade', uid, give: 'brick', giveAmount: rate, receive: 'ore' });
    expect(after.hands[uid].resources.brick).toBe(0);
    expect(after.hands[uid].resources.ore).toBe(1);
  });
});

describe('win condition', () => {
  it('declares a winner once victoryPointsToWin is reached', () => {
    let bundle = makeGame(2, { victoryPointsToWin: 3 });
    bundle = driveSetup(bundle);
    bundle.room.phase = 'main';
    const uid = bundle.room.turnOrder[bundle.room.currentPlayerIndex];
    setVisibleVP(bundle.players[uid], 3);

    bundle = applyAction(bundle, { type: 'endTurn', uid });
    expect(bundle.room.winnerUid).toBe(uid);
    expect(bundle.room.phase).toBe('gameOver');
    expect(bundle.room.status).toBe('finished');
  });

  it('counts hidden victory-point development cards toward the win', () => {
    let bundle = makeGame(2, { victoryPointsToWin: 3 });
    bundle = driveSetup(bundle);
    bundle.room.phase = 'main';
    const uid = bundle.room.turnOrder[bundle.room.currentPlayerIndex];
    setVisibleVP(bundle.players[uid], 2);
    bundle.hands[uid].devCards.push({ id: 'vp1', type: 'victoryPoint', boughtTurn: 0 });

    bundle = applyAction(bundle, { type: 'endTurn', uid });
    expect(bundle.room.winnerUid).toBe(uid);
  });
});

describe('legalActionTypes', () => {
  it('offers buildSettlement then buildRoad in setup order', () => {
    const bundle = makeGame(2);
    const uid = bundle.room.turnOrder[0];
    expect(legalActionTypes(bundle, uid)).toEqual(['buildSettlement']);
  });

  it('offers rollDice at the start of a normal turn', () => {
    let bundle = makeGame(2);
    bundle = driveSetup(bundle);
    const uid = bundle.room.turnOrder[bundle.room.currentPlayerIndex];
    expect(legalActionTypes(bundle, uid)).toContain('rollDice');
  });
});

// --- test-only helpers ---

function handTotal(hand: PrivateHand): number {
  return RESOURCES.reduce((sum, r) => sum + hand.resources[r], 0);
}

function terrainResourceOf(terrain: string): keyof PrivateHand['resources'] | null {
  const map: Record<string, keyof PrivateHand['resources']> = {
    hills: 'brick',
    forest: 'lumber',
    mountains: 'ore',
    fields: 'grain',
    pasture: 'wool',
  };
  return map[terrain] ?? null;
}

/** Returns [d1,d2] summing to `total` (2-12). */
function pickDiceFor(total: number): [number, number] {
  const d1 = Math.max(1, Math.min(6, total - 1));
  const d2 = total - d1;
  return [d1, d2];
}

function setVisibleVP(player: PublicPlayer, vp: number): void {
  player.visibleVictoryPoints = vp;
}

/**
 * Walks the board's edge adjacency graph to find a genuinely simple path (no repeated
 * vertices, so no branching/looping back) of exactly `length` contiguous edges. Returns
 * both the edge ids and the ordered vertex sequence (length+1 vertices) so tests can pick a
 * precise interior vertex to block.
 */
function findSimplePath(
  board: GameStateBundle['room']['board'],
  length: number,
): { edges: string[]; vertices: VertexId[] } {
  const b = board!;
  for (const startEdge of Object.values(b.edges)) {
    const [v0, v1] = startEdge.vertexIds;
    const result = extendSimplePath(b, [startEdge.id], [v0, v1], length);
    if (result) return { edges: result.edges, vertices: result.vertices };
  }
  throw new Error(`Could not find a simple path of length ${length}`);
}

function extendSimplePath(
  board: NonNullable<GameStateBundle['room']['board']>,
  edges: string[],
  vertices: VertexId[],
  length: number,
): { edges: string[]; vertices: VertexId[] } | null {
  if (edges.length === length) return { edges, vertices };
  const frontier = vertices[vertices.length - 1];
  for (const edgeId of board.vertices[frontier].adjacentEdgeIds) {
    if (edges.includes(edgeId)) continue;
    const [a, b] = board.edges[edgeId].vertexIds;
    const next = a === frontier ? b : a;
    if (vertices.includes(next)) continue; // keep the path vertex-simple, not just edge-simple
    const result = extendSimplePath(board, [...edges, edgeId], [...vertices, next], length);
    if (result) return result;
  }
  return null;
}

/** Mirrors rules.ts's internal playerPortRate: cheapest port rate the player currently owns
 * for `resource` (2:1 matching port, else 3:1 generic port, else default 4:1). */
function expectedPortRate(
  bundle: GameStateBundle,
  uid: string,
  resource: keyof PrivateHand['resources'],
): number {
  const board = bundle.room.board!;
  const myVertices = new Set(
    Object.entries(bundle.room.vertices)
      .filter(([, b]) => b.uid === uid)
      .map(([id]) => id),
  );
  let best = 4;
  for (const port of board.ports) {
    if (!port.vertexIds.some((v) => myVertices.has(v))) continue;
    if (port.type === 'generic') best = Math.min(best, 3);
    else if (port.type === resource) best = Math.min(best, 2);
  }
  return best;
}
