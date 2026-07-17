import { beforeEach, describe, expect, it, vi } from 'vitest';
import { applyAction, computeRollGains, createGame, legalActionTypes, recalcLargestArmy, recalcLongestRoad } from './rules';
import { initialFogRevealHexIds } from './board';
import type { GameStateBundle } from './rules';
import type { Board, Building, PrivateHand, PublicPlayer, VertexId } from './types';
import {
  DISCARD_TIMEOUT_SECONDS,
  MIN_OPEN_TRADE_WINDOW_MS,
  RESOURCES,
  ROBBER_TIMEOUT_SECONDS,
  SETUP_TIMEOUT_SECONDS,
  TRADE_EXPIRY_MS,
  TRADE_TURN_EXTENSION_MS,
  TURN_TIMER_EXTENSION_CAP_MULTIPLIER,
} from './types';

function makeGame(
  playerCount = 4,
  opts: {
    victoryPointsToWin?: number;
    discardLimit?: number;
    turnTimerSeconds?: number | null;
    tradeResponseTimerSeconds?: number | null;
  } = {},
): GameStateBundle {
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
  const touchesGold = (v: (typeof board.vertices)[string]) =>
    v.adjacentHexIds.some((h) => board.hexes.find((hex) => hex.id === h)?.terrain === 'gold');
  // fog-of-war only: setup placements are restricted to the board's initial reveal set — see
  // rules.ts's 'buildSettlement' handler — so this helper has to respect that too, or it'd
  // pick a vertex the real validation then rejects (most vertices touch a hidden hex, since
  // only the outer ring + center start revealed).
  const initialReveal = bundle.room.discoveredHexIds !== null ? new Set(initialFogRevealHexIds(board.hexes)) : null;
  const touchesHidden = (v: (typeof board.vertices)[string]) =>
    initialReveal !== null && v.adjacentHexIds.some((h) => !initialReveal.has(h));
  for (const v of Object.values(board.vertices)) {
    if (excluding.has(v.id)) continue;
    if (bundle.room.vertices[v.id]) continue;
    if (v.adjacentVertexIds.some((n) => bundle.room.vertices[n])) continue;
    if (touchesGold(v)) continue; // setup placements can't border the gold hex — see rules.ts
    if (touchesHidden(v)) continue;
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

  it('creates a full 6-player game on the extended-5-6p board', () => {
    const seatedPlayers = Array.from({ length: 6 }, (_, i) => ({
      uid: `p${i}`,
      displayName: `Player ${i}`,
      isBot: false,
    }));
    const bundle = createGame(
      { id: 'r6', code: 'BIGGY', hostUid: 'p0', mapPreset: 'extended-5-6p', seed: 'six-player-seed' },
      seatedPlayers,
    );
    expect(bundle.room.turnOrder).toHaveLength(6);
    expect(bundle.room.board!.hexes).toHaveLength(30);
    expect(Object.keys(bundle.players)).toHaveLength(6);
    // Bank/dev-card deck sizing is player-count-based, not board-size-based — unaffected by
    // the bigger board.
    expect(bundle.room.bank).toEqual({ brick: 19, lumber: 19, ore: 19, grain: 19, wool: 19 });
    expect(bundle.room.devCardDeckCount).toBe(25);
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

    const logMeta = bundle.room.log.at(-1)?.meta;
    expect(logMeta).toMatchObject({ kind: 'diceRoll', roll: [d1, d2] });
    expect(logMeta?.kind === 'diceRoll' && logMeta.gains?.[uid]).toBeTruthy();
  });

  it('logs a diceRoll entry with no gains field on a roll of 7 (no resources distributed)', () => {
    let bundle = makeGame(2);
    bundle = driveSetup(bundle);
    const uid = bundle.room.turnOrder[bundle.room.currentPlayerIndex];
    mockDice(3, 4); // 7
    bundle = applyAction(bundle, { type: 'rollDice', uid });
    const logMeta = bundle.room.log.at(-1)?.meta;
    expect(logMeta).toEqual({ kind: 'diceRoll', roll: [3, 4] });
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
    expect(bundle.room.discardPhaseStartedAt).toBeNull();
  });

  it('rejects timeoutDiscard before the discard timer has actually elapsed', () => {
    let bundle = makeGame(2, { discardLimit: 5 });
    bundle = driveSetup(bundle);
    const uid = bundle.room.turnOrder[bundle.room.currentPlayerIndex];
    const other = bundle.room.turnOrder.find((u) => u !== uid)!;
    bundle.hands[other].resources = { brick: 3, lumber: 3, ore: 0, grain: 0, wool: 0 };
    mockDice(3, 4);
    bundle = applyAction(bundle, { type: 'rollDice', uid });
    expect(bundle.room.phase).toBe('discard');

    expect(() => applyAction(bundle, { type: 'timeoutDiscard', uid })).toThrow(/has not expired yet/i);
    expect(legalActionTypes(bundle, uid)).not.toContain('timeoutDiscard');
  });

  it('timeoutDiscard randomly discards down to the required count for every pending player at once', () => {
    let bundle = makeGame(3, { discardLimit: 5 });
    bundle = driveSetup(bundle);
    const uid = bundle.room.turnOrder[bundle.room.currentPlayerIndex];
    const [otherA, otherB] = bundle.room.turnOrder.filter((u) => u !== uid);
    bundle.hands[otherA].resources = { brick: 3, lumber: 3, ore: 0, grain: 0, wool: 0 }; // 6 > 5
    bundle.hands[otherB].resources = { brick: 0, lumber: 0, ore: 4, grain: 4, wool: 0 }; // 8 > 5

    mockDice(3, 4);
    bundle = applyAction(bundle, { type: 'rollDice', uid });
    expect(bundle.room.phase).toBe('discard');
    expect(new Set(bundle.room.pendingDiscardUids)).toEqual(new Set([otherA, otherB]));
    expect(bundle.room.discardPhaseStartedAt).not.toBeNull();

    bundle.room.discardPhaseStartedAt = Date.now() - DISCARD_TIMEOUT_SECONDS * 1000 - 1000;
    bundle = applyAction(bundle, { type: 'timeoutDiscard', uid });

    expect(bundle.room.phase).toBe('robber');
    expect(bundle.room.pendingDiscardUids).toEqual([]);
    expect(bundle.room.discardPhaseStartedAt).toBeNull();
    expect(handTotal(bundle.hands[otherA])).toBe(3);
    expect(handTotal(bundle.hands[otherB])).toBe(4);
    expect(bundle.room.log.some((l) => l.message.includes('timed out'))).toBe(true);
  });

  it('rejects timeoutRobber before the robber timer has actually elapsed', () => {
    let bundle = makeGame(2, { discardLimit: 20 });
    bundle = driveSetup(bundle);
    const uid = bundle.room.turnOrder[bundle.room.currentPlayerIndex];
    mockDice(3, 4); // roll 7, nobody over the discard limit -> straight to 'robber'
    bundle = applyAction(bundle, { type: 'rollDice', uid });
    expect(bundle.room.phase).toBe('robber');
    expect(bundle.room.robberPhaseStartedAt).not.toBeNull();

    expect(() => applyAction(bundle, { type: 'timeoutRobber', uid })).toThrow(/has not expired yet/i);
    expect(legalActionTypes(bundle, uid)).not.toContain('timeoutRobber');
  });

  it('timeoutRobber moves the robber to a random other hex and returns to the main phase', () => {
    let bundle = makeGame(2, { discardLimit: 20 });
    bundle = driveSetup(bundle);
    const uid = bundle.room.turnOrder[bundle.room.currentPlayerIndex];
    const startHexId = bundle.room.board!.robberHexId;
    mockDice(3, 4);
    bundle = applyAction(bundle, { type: 'rollDice', uid });
    expect(bundle.room.phase).toBe('robber');

    bundle.room.robberPhaseStartedAt = Date.now() - ROBBER_TIMEOUT_SECONDS * 1000 - 1000;
    expect(legalActionTypes(bundle, uid)).toContain('timeoutRobber');
    bundle = applyAction(bundle, { type: 'timeoutRobber', uid });

    expect(bundle.room.phase).toBe('main');
    expect(bundle.room.robberPhaseStartedAt).toBeNull();
    expect(bundle.room.board!.robberHexId).not.toBe(startHexId);
    expect(bundle.room.log.some((l) => l.message.includes('ran out of time'))).toBe(true);
  });

  it('rejects timeoutSetupPlacement before the setup timer has actually elapsed', () => {
    const bundle = makeGame(2);
    const uid = bundle.room.turnOrder[bundle.room.currentPlayerIndex];
    expect(bundle.room.phase).toBe('setup1');
    expect(() => applyAction(bundle, { type: 'timeoutSetupPlacement', uid })).toThrow(/has not expired yet/i);
    expect(legalActionTypes(bundle, uid)).not.toContain('timeoutSetupPlacement');
  });

  it('timeoutSetupPlacement auto-places a settlement, then a road, on the same stuck player', () => {
    let bundle = makeGame(2);
    const uid = bundle.room.turnOrder[bundle.room.currentPlayerIndex];

    bundle.room.setupTurnStartedAt = Date.now() - SETUP_TIMEOUT_SECONDS * 1000 - 1000;
    expect(legalActionTypes(bundle, uid)).toContain('timeoutSetupPlacement');
    bundle = applyAction(bundle, { type: 'timeoutSetupPlacement', uid });

    // Settlement placed; still this player's turn (owes the free road next), with a fresh
    // timer rather than an already-expired one.
    expect(bundle.players[uid].settlementsBuilt).toBe(1);
    expect(bundle.players[uid].roadsBuilt).toBe(0);
    expect(bundle.room.currentPlayerIndex).toBe(bundle.room.turnOrder.indexOf(uid));
    expect(bundle.room.lastSetupSettlementVertexId).not.toBeNull();
    expect(bundle.room.setupTurnStartedAt).not.toBeNull();
    expect(Date.now() - bundle.room.setupTurnStartedAt!).toBeLessThan(1000);
    expect(legalActionTypes(bundle, uid)).not.toContain('timeoutSetupPlacement');

    // Time out the road too.
    bundle.room.setupTurnStartedAt = Date.now() - SETUP_TIMEOUT_SECONDS * 1000 - 1000;
    bundle = applyAction(bundle, { type: 'timeoutSetupPlacement', uid });
    expect(bundle.players[uid].roadsBuilt).toBe(1);
    expect(bundle.room.lastSetupSettlementVertexId).toBeNull();
    // Two-player game: setup1 snake-drafts forward, so it's now the other player's turn.
    expect(bundle.room.currentPlayerIndex).not.toBe(bundle.room.turnOrder.indexOf(uid));
    expect(bundle.room.log.filter((l) => l.message.includes('ran out of time'))).toHaveLength(2);
  });

  it('timeoutSetupPlacement on the fog-of-war board never picks a spot bordering gold or a hidden hex', () => {
    const bundle = createGame(
      { id: 'room-fog-timeout', code: 'ABCDE', hostUid: 'p0', mapPreset: 'fog-of-war', seed: 'fog-timeout-seed' },
      [
        { uid: 'p0', displayName: 'Player 0', isBot: false },
        { uid: 'p1', displayName: 'Player 1', isBot: false },
      ],
    );
    const board = bundle.room.board!;
    const uid = bundle.room.turnOrder[bundle.room.currentPlayerIndex];
    const revealed = new Set(bundle.room.discoveredHexIds);

    bundle.room.setupTurnStartedAt = Date.now() - SETUP_TIMEOUT_SECONDS * 1000 - 1000;
    const after = applyAction(bundle, { type: 'timeoutSetupPlacement', uid });
    const placedVertexId = after.room.lastSetupSettlementVertexId!;
    const v = board.vertices[placedVertexId];
    for (const hexId of v.adjacentHexIds) {
      const hex = board.hexes.find((h) => h.id === hexId)!;
      expect(hex.terrain).not.toBe('gold');
      expect(revealed.has(hexId)).toBe(true);
    }
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

describe('safe mode', () => {
  function setupRobberScenario(safeMode: boolean) {
    const bundle = makeGame(2);
    const board = bundle.room.board!;
    const actingUid = bundle.room.turnOrder[bundle.room.currentPlayerIndex];
    const weakUid = bundle.room.turnOrder.find((u) => u !== actingUid)!;

    const protectedHex = board.hexes.find((h) => h.id !== bundle.room.robberHexId)!;
    const protectedVertex = Object.values(board.vertices).find((v) => v.adjacentHexIds.includes(protectedHex.id))!;
    bundle.room.vertices[protectedVertex.id] = { type: 'settlement', uid: weakUid };
    bundle.players[weakUid].visibleVictoryPoints = 2; // below the 3-point safe-mode threshold

    bundle.room.phase = 'robber';
    bundle.room.safeMode = safeMode;
    return { bundle, protectedHex, actingUid };
  }

  it('rejects targeting a hex touching a player with fewer than 3 VP', () => {
    const { bundle, protectedHex, actingUid } = setupRobberScenario(true);
    expect(() =>
      applyAction(bundle, { type: 'moveRobber', uid: actingUid, robberHexId: protectedHex.id, stealFromUid: null }),
    ).toThrow(/[Ss]afe mode/);
  });

  it('allows the same move when safe mode is off', () => {
    const { bundle, protectedHex, actingUid } = setupRobberScenario(false);
    const next = applyAction(bundle, {
      type: 'moveRobber',
      uid: actingUid,
      robberHexId: protectedHex.id,
      stealFromUid: null,
    });
    expect(next.room.board!.robberHexId).toBe(protectedHex.id);
  });

  it('still allows targeting a hex with no low-VP player nearby', () => {
    const { bundle, actingUid } = setupRobberScenario(true);
    const board = bundle.room.board!;
    const emptyHex = board.hexes.find((h) => {
      if (h.id === bundle.room.robberHexId) return false;
      const vertices = Object.values(board.vertices).filter((v) => v.adjacentHexIds.includes(h.id));
      return vertices.every((v) => !bundle.room.vertices[v.id]);
    })!;
    expect(emptyHex).toBeTruthy();
    const next = applyAction(bundle, {
      type: 'moveRobber',
      uid: actingUid,
      robberHexId: emptyHex.id,
      stealFromUid: null,
    });
    expect(next.room.board!.robberHexId).toBe(emptyHex.id);
  });

  it('fails open (allows the move) if every other hex is also protected', () => {
    const bundle = makeGame(2);
    const board = bundle.room.board!;
    const actingUid = bundle.room.turnOrder[bundle.room.currentPlayerIndex];
    const weakUid = bundle.room.turnOrder.find((u) => u !== actingUid)!;
    // Give every non-robber hex at least one adjacent vertex, and put a low-VP player's
    // settlement on all of them, so literally nowhere is a legal safe-mode target.
    bundle.players[weakUid].visibleVictoryPoints = 2;
    for (const hex of board.hexes) {
      if (hex.id === bundle.room.robberHexId) continue;
      const vertex = Object.values(board.vertices).find((v) => v.adjacentHexIds.includes(hex.id));
      if (vertex && !bundle.room.vertices[vertex.id]) {
        bundle.room.vertices[vertex.id] = { type: 'settlement', uid: weakUid };
      }
    }
    bundle.room.phase = 'robber';
    bundle.room.safeMode = true;
    const target = board.hexes.find((h) => h.id !== bundle.room.robberHexId)!;
    const next = applyAction(bundle, {
      type: 'moveRobber',
      uid: actingUid,
      robberHexId: target.id,
      stealFromUid: null,
    });
    expect(next.room.board!.robberHexId).toBe(target.id);
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
    expect(bundle.room.log.at(-1)?.meta).toEqual({
      kind: 'resourceTrade',
      fromUid: uid,
      toUid: other,
      give: { brick: 1 },
      receive: { grain: 1 },
    });
  });

  it('counterTrade marks the original countered and targets a new offer back at the proposer', () => {
    let bundle = makeGame(2);
    bundle = driveSetup(bundle);
    bundle.room.phase = 'main';
    const uid = bundle.room.turnOrder[bundle.room.currentPlayerIndex];
    const other = bundle.room.turnOrder.find((u) => u !== uid)!;
    bundle.hands[uid].resources = { brick: 2, lumber: 0, ore: 0, grain: 0, wool: 0 };
    bundle.hands[other].resources = { brick: 0, lumber: 0, ore: 0, grain: 2, wool: 0 };

    bundle = applyAction(bundle, { type: 'proposeTrade', uid, give: { brick: 1 }, receive: { grain: 1 }, targetUid: other });
    const originalId = bundle.trades[0].id;

    // The responder (not the current player) counters: asks for 2 brick instead of giving 1 grain for 1.
    bundle = applyAction(bundle, { type: 'counterTrade', uid: other, tradeId: originalId, give: { grain: 1 }, receive: { brick: 2 } });
    expect(bundle.trades[0].status).toBe('countered');
    const counter = bundle.trades[1];
    expect(counter.status).toBe('pending');
    expect(counter.proposerUid).toBe(other);
    expect(counter.targetUid).toBe(uid);
    expect(counter.counterOf).toBe(originalId);

    // Original proposer accepts the counter — a targeted trade, so it executes immediately.
    bundle = applyAction(bundle, { type: 'respondTrade', uid, tradeId: counter.id, accept: true });
    expect(bundle.trades[1].status).toBe('accepted');
    expect(bundle.hands[uid].resources).toMatchObject({ brick: 0, grain: 1 });
    expect(bundle.hands[other].resources).toMatchObject({ brick: 2, grain: 1 });
  });

  it('counterTrade rejects countering your own trade and unaffordable counters', () => {
    let bundle = makeGame(2);
    bundle = driveSetup(bundle);
    bundle.room.phase = 'main';
    const uid = bundle.room.turnOrder[bundle.room.currentPlayerIndex];
    const other = bundle.room.turnOrder.find((u) => u !== uid)!;
    bundle.hands[uid].resources = { brick: 1, lumber: 0, ore: 0, grain: 0, wool: 0 };
    bundle.hands[other].resources = { brick: 0, lumber: 0, ore: 0, grain: 0, wool: 0 };

    bundle = applyAction(bundle, { type: 'proposeTrade', uid, give: { brick: 1 }, receive: { grain: 1 }, targetUid: other });
    const tradeId = bundle.trades[0].id;

    expect(() => applyAction(bundle, { type: 'counterTrade', uid, tradeId, give: { brick: 1 }, receive: { grain: 1 } })).toThrow(/own trade/);
    expect(() =>
      applyAction(bundle, { type: 'counterTrade', uid: other, tradeId, give: { grain: 1 }, receive: { brick: 1 } }),
    ).toThrow(/do not have/);
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
    expect(bundle.room.log.at(-1)?.meta).toEqual({
      kind: 'resourceTrade',
      fromUid: uid,
      toUid: otherB,
      give: { brick: 1 },
      receive: { grain: 1 },
    });
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
    expect(after.room.log.at(-1)?.meta).toEqual({
      kind: 'resourceTrade',
      fromUid: uid,
      toUid: null,
      give: { brick: rate },
      receive: { ore: 1 },
    });
  });

  it('auto-rejects (does not throw) a targeted trade the responder can no longer afford at accept time', () => {
    let bundle = makeGame(2);
    bundle = driveSetup(bundle);
    bundle.room.phase = 'main';
    const uid = bundle.room.turnOrder[bundle.room.currentPlayerIndex];
    const other = bundle.room.turnOrder.find((u) => u !== uid)!;
    bundle.hands[uid].resources = { brick: 1, lumber: 0, ore: 0, grain: 0, wool: 0 };
    bundle.hands[other].resources = { brick: 0, lumber: 0, ore: 0, grain: 1, wool: 0 };

    bundle = applyAction(bundle, { type: 'proposeTrade', uid, give: { brick: 1 }, receive: { grain: 1 }, targetUid: other });
    const tradeId = bundle.trades[0].id;

    // The responder spends the very resource being asked of them (e.g. on a build) before
    // responding.
    bundle.hands[other].resources.grain = 0;

    bundle = applyAction(bundle, { type: 'respondTrade', uid: other, tradeId, accept: true });
    expect(bundle.trades[0].status).toBe('rejected');
    // No resources moved.
    expect(bundle.hands[uid].resources.brick).toBe(1);
    expect(bundle.hands[other].resources.grain).toBe(0);
    expect(bundle.room.log.at(-1)?.message).toMatch(/automatically rejected/i);
  });

  it('auto-rejects (does not throw) a targeted trade the proposer can no longer afford at accept time', () => {
    let bundle = makeGame(2);
    bundle = driveSetup(bundle);
    bundle.room.phase = 'main';
    const uid = bundle.room.turnOrder[bundle.room.currentPlayerIndex];
    const other = bundle.room.turnOrder.find((u) => u !== uid)!;
    bundle.hands[uid].resources = { brick: 1, lumber: 0, ore: 0, grain: 0, wool: 0 };
    bundle.hands[other].resources = { brick: 0, lumber: 0, ore: 0, grain: 1, wool: 0 };

    bundle = applyAction(bundle, { type: 'proposeTrade', uid, give: { brick: 1 }, receive: { grain: 1 }, targetUid: other });
    const tradeId = bundle.trades[0].id;

    // The proposer spends the resource they offered before the responder answers.
    bundle.hands[uid].resources.brick = 0;

    bundle = applyAction(bundle, { type: 'respondTrade', uid: other, tradeId, accept: true });
    expect(bundle.trades[0].status).toBe('rejected');
    expect(bundle.hands[other].resources.grain).toBe(1);
  });

  it('finalizeTrade drops a stale interested player who can no longer afford it, without throwing, and leaves the trade open', () => {
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

    // otherB spends their grain in the interim (e.g. on a build).
    bundle.hands[otherB].resources.grain = 0;

    bundle = applyAction(bundle, { type: 'finalizeTrade', uid, tradeId, withUid: otherB });
    expect(bundle.trades[0].status).toBe('pending');
    expect(bundle.trades[0].interestedUids).toEqual([otherA]);
    // No swap happened with otherB.
    expect(bundle.hands[uid].resources.brick).toBe(2);
  });

  it('finalizeTrade auto-rejects the whole trade if the proposer can no longer afford it, without throwing', () => {
    let bundle = makeGame(2);
    bundle = driveSetup(bundle);
    bundle.room.phase = 'main';
    const uid = bundle.room.turnOrder[bundle.room.currentPlayerIndex];
    const other = bundle.room.turnOrder.find((u) => u !== uid)!;
    bundle.hands[uid].resources = { brick: 1, lumber: 0, ore: 0, grain: 0, wool: 0 };
    bundle.hands[other].resources = { brick: 0, lumber: 0, ore: 0, grain: 1, wool: 0 };

    bundle = applyAction(bundle, { type: 'proposeTrade', uid, give: { brick: 1 }, receive: { grain: 1 }, targetUid: null });
    const tradeId = bundle.trades[0].id;
    bundle = applyAction(bundle, { type: 'respondTrade', uid: other, tradeId, accept: true });

    bundle.hands[uid].resources.brick = 0;

    bundle = applyAction(bundle, { type: 'finalizeTrade', uid, tradeId, withUid: other });
    expect(bundle.trades[0].status).toBe('rejected');
    expect(bundle.trades[0].interestedUids).toEqual([]);
  });
});

describe('trade-driven turn timer extension', () => {
  it('extends turnStartedAt by TRADE_TURN_EXTENSION_MS when a trade is proposed', () => {
    let bundle = makeGame(2, { turnTimerSeconds: 100 });
    bundle = driveSetup(bundle);
    bundle.room.phase = 'main';
    const uid = bundle.room.turnOrder[bundle.room.currentPlayerIndex];
    bundle.hands[uid].resources = { brick: 5, lumber: 5, ore: 0, grain: 0, wool: 0 };
    const startedAt = bundle.room.turnStartedAt;

    bundle = applyAction(bundle, { type: 'proposeTrade', uid, give: { brick: 1 }, receive: { grain: 1 }, targetUid: null });

    expect(bundle.room.turnStartedAt).toBe(startedAt + TRADE_TURN_EXTENSION_MS);
    expect(bundle.room.turnTimerExtensionMs).toBe(TRADE_TURN_EXTENSION_MS);
  });

  it('caps cumulative extension at TURN_TIMER_EXTENSION_CAP_MULTIPLIER x the initial turnTimerSeconds', () => {
    let bundle = makeGame(2, { turnTimerSeconds: 100 }); // max extension = 50_000ms
    bundle = driveSetup(bundle);
    bundle.room.phase = 'main';
    const uid = bundle.room.turnOrder[bundle.room.currentPlayerIndex];
    bundle.hands[uid].resources = { brick: 5, lumber: 5, ore: 0, grain: 0, wool: 0 };
    const startedAt = bundle.room.turnStartedAt;
    const maxExtensionMs = 100 * 1000 * (TURN_TIMER_EXTENSION_CAP_MULTIPLIER - 1);

    // First proposal: full 30s extension.
    bundle = applyAction(bundle, { type: 'proposeTrade', uid, give: { brick: 1 }, receive: { grain: 1 }, targetUid: null });
    expect(bundle.room.turnTimerExtensionMs).toBe(TRADE_TURN_EXTENSION_MS);

    // Second proposal: only the remaining budget (20s) is granted, not the full 30s.
    bundle = applyAction(bundle, { type: 'proposeTrade', uid, give: { lumber: 1 }, receive: { grain: 1 }, targetUid: null });
    expect(bundle.room.turnTimerExtensionMs).toBe(maxExtensionMs);
    expect(bundle.room.turnStartedAt).toBe(startedAt + maxExtensionMs);

    // Third proposal: budget is exhausted, no further extension.
    bundle = applyAction(bundle, { type: 'proposeTrade', uid, give: { brick: 1 }, receive: { grain: 1 }, targetUid: null });
    expect(bundle.room.turnTimerExtensionMs).toBe(maxExtensionMs);
    expect(bundle.room.turnStartedAt).toBe(startedAt + maxExtensionMs);
  });

  it('does not extend the timer when turnTimerSeconds is disabled (null)', () => {
    let bundle = makeGame(2, { turnTimerSeconds: null });
    bundle = driveSetup(bundle);
    bundle.room.phase = 'main';
    const uid = bundle.room.turnOrder[bundle.room.currentPlayerIndex];
    bundle.hands[uid].resources = { brick: 1, lumber: 0, ore: 0, grain: 0, wool: 0 };
    const startedAt = bundle.room.turnStartedAt;

    bundle = applyAction(bundle, { type: 'proposeTrade', uid, give: { brick: 1 }, receive: { grain: 1 }, targetUid: null });

    expect(bundle.room.turnStartedAt).toBe(startedAt);
  });

  it('resets the extension budget for the next player once the turn ends', () => {
    let bundle = makeGame(2, { turnTimerSeconds: 100 });
    bundle = driveSetup(bundle);
    bundle.room.phase = 'main';
    const uid = bundle.room.turnOrder[bundle.room.currentPlayerIndex];
    bundle.hands[uid].resources = { brick: 1, lumber: 0, ore: 0, grain: 0, wool: 0 };

    bundle = applyAction(bundle, { type: 'proposeTrade', uid, give: { brick: 1 }, receive: { grain: 1 }, targetUid: null });
    expect(bundle.room.turnTimerExtensionMs).toBe(TRADE_TURN_EXTENSION_MS);

    bundle = applyAction(bundle, { type: 'endTurn', uid });
    expect(bundle.room.turnTimerExtensionMs).toBe(0);
  });
});

describe('trade expiry window', () => {
  it('guarantees at least MIN_OPEN_TRADE_WINDOW_MS before TRADE_EXPIRY_MS can end an open trade', () => {
    // Encodes the invariant itself (asserted at module load in types.ts) as a regular test
    // too, so a future accidental shrink of TRADE_EXPIRY_MS shows up in a normal test failure,
    // not just a thrown-at-import error that's easy to misattribute.
    expect(TRADE_EXPIRY_MS).toBeGreaterThanOrEqual(MIN_OPEN_TRADE_WINDOW_MS);
  });

  it('does not expire an open trade before MIN_OPEN_TRADE_WINDOW_MS has elapsed', () => {
    let bundle = makeGame(3);
    bundle = driveSetup(bundle);
    bundle.room.phase = 'main';
    const uid = bundle.room.turnOrder[bundle.room.currentPlayerIndex];
    const other = bundle.room.turnOrder.find((u) => u !== uid)!;
    bundle.hands[uid].resources.brick = 1;

    bundle = applyAction(bundle, { type: 'proposeTrade', uid, give: { brick: 1 }, receive: { grain: 1 }, targetUid: null });
    bundle.trades[0].createdAt = Date.now() - MIN_OPEN_TRADE_WINDOW_MS + 1000; // just under the floor

    expect(() => applyAction(bundle, { type: 'expireTrades', uid: other })).toThrow(/have expired/i);
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
    expect(legalActionTypes(bundle, uid)).toEqual(['voteToPause', 'buildSettlement']);
  });

  it('offers rollDice at the start of a normal turn', () => {
    let bundle = makeGame(2);
    bundle = driveSetup(bundle);
    const uid = bundle.room.turnOrder[bundle.room.currentPlayerIndex];
    expect(legalActionTypes(bundle, uid)).toContain('rollDice');
  });
});

describe('pause voting', () => {
  it('pauses once at least half of non-bot players vote, freezing all other actions', () => {
    let bundle = makeGame(2);
    bundle = driveSetup(bundle);
    bundle.room.phase = 'main';
    const [uidA] = bundle.room.turnOrder;

    bundle = applyAction(bundle, { type: 'voteToPause', uid: uidA });
    expect(bundle.room.paused).toBe(true); // 1 of 2 players is already "at least half"
    expect(bundle.room.pausedAt).not.toBeNull();
    expect(bundle.room.pauseVotes).toEqual([]);

    const uid = bundle.room.turnOrder[bundle.room.currentPlayerIndex];
    expect(() => applyAction(bundle, { type: 'endTurn', uid })).toThrow(/paused/);
  });

  it('does not pause below the majority threshold', () => {
    let bundle = makeGame(4);
    bundle = driveSetup(bundle);
    bundle.room.phase = 'main';
    const [uidA] = bundle.room.turnOrder;

    bundle = applyAction(bundle, { type: 'voteToPause', uid: uidA });
    expect(bundle.room.paused).toBe(false); // 1 of 4 is not yet half
    expect(bundle.room.pauseVotes).toEqual([uidA]);
  });

  it('excludes bots from the vote denominator', () => {
    const seatedPlayers = [
      { uid: 'p0', displayName: 'Human', isBot: false },
      { uid: 'p1', displayName: 'Bot A', isBot: true },
      { uid: 'p2', displayName: 'Bot B', isBot: true },
    ];
    let bundle = createGame(
      { id: 'room1', code: 'ABCDE', hostUid: 'p0', mapPreset: 'official-beginner', seed: 'pause-bots-seed' },
      seatedPlayers,
    );
    bundle = driveSetup(bundle);
    bundle.room.phase = 'main';

    expect(() => applyAction(bundle, { type: 'voteToPause', uid: 'p1' })).toThrow(/[Bb]ots cannot vote/);
    bundle = applyAction(bundle, { type: 'voteToPause', uid: 'p0' });
    expect(bundle.room.paused).toBe(true); // the lone human is 100% of the non-bot denominator
  });

  it('unpause shifts turnStartedAt forward by the paused duration', () => {
    let bundle = makeGame(2);
    bundle = driveSetup(bundle);
    bundle.room.phase = 'main';
    const startedAt = bundle.room.turnStartedAt;
    const [uidA] = bundle.room.turnOrder;

    bundle = applyAction(bundle, { type: 'voteToPause', uid: uidA });
    bundle.room.pausedAt = startedAt + 5000; // simulate 5s elapsed before pausing
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(startedAt + 30000); // 25s paused
    try {
      bundle = applyAction(bundle, { type: 'voteToUnpause', uid: uidA });
    } finally {
      nowSpy.mockRestore();
    }
    expect(bundle.room.paused).toBe(false);
    expect(bundle.room.pausedAt).toBeNull();
    expect(bundle.room.turnStartedAt).toBe(startedAt + 25000);
  });
});

describe('timeoutEndTurn', () => {
  it('rejects a timeout before the configured timer has actually elapsed', () => {
    let bundle = makeGame(2, { turnTimerSeconds: 120 });
    bundle = driveSetup(bundle);
    bundle.room.phase = 'main';
    const uid = bundle.room.turnOrder[bundle.room.currentPlayerIndex];
    expect(() => applyAction(bundle, { type: 'timeoutEndTurn', uid })).toThrow(/not expired/);
  });

  it('rejects a timeout when no timer is configured for the room', () => {
    let bundle = makeGame(2, { turnTimerSeconds: null });
    bundle = driveSetup(bundle);
    bundle.room.phase = 'main';
    const uid = bundle.room.turnOrder[bundle.room.currentPlayerIndex];
    bundle.room.turnStartedAt = Date.now() - 999_999;
    expect(() => applyAction(bundle, { type: 'timeoutEndTurn', uid })).toThrow(/No turn timer/);
  });

  it('advances the turn once expired, crediting the timed-out player even if reported by someone else', () => {
    let bundle = makeGame(2, { turnTimerSeconds: 30 });
    bundle = driveSetup(bundle);
    bundle.room.phase = 'main';
    bundle.room.turnStartedAt = Date.now() - 31_000;
    const timedOutUid = bundle.room.turnOrder[bundle.room.currentPlayerIndex];
    const reporterUid = bundle.room.turnOrder.find((u) => u !== timedOutUid)!;

    bundle = applyAction(bundle, { type: 'timeoutEndTurn', uid: reporterUid });
    expect(bundle.room.turnOrder[bundle.room.currentPlayerIndex]).not.toBe(timedOutUid);
    expect(bundle.room.phase).toBe('roll');
    expect(bundle.room.log.at(-1)?.message).toContain('timed out');
  });

  it('is offered via legalActionTypes only once the timer has actually elapsed', () => {
    let bundle = makeGame(2, { turnTimerSeconds: 60 });
    bundle = driveSetup(bundle);
    bundle.room.phase = 'main';
    const uid = bundle.room.turnOrder[bundle.room.currentPlayerIndex];
    expect(legalActionTypes(bundle, uid)).not.toContain('timeoutEndTurn');

    bundle.room.turnStartedAt = Date.now() - 61_000;
    expect(legalActionTypes(bundle, uid)).toContain('timeoutEndTurn');
  });
});

describe('expireTrades', () => {
  it('rejects when no pending trade has aged past TRADE_EXPIRY_MS yet', () => {
    let bundle = makeGame(2);
    bundle = driveSetup(bundle);
    bundle.room.phase = 'main';
    const uid = bundle.room.turnOrder[bundle.room.currentPlayerIndex];
    const other = bundle.room.turnOrder.find((u) => u !== uid)!;
    bundle.hands[uid].resources.brick = 1;
    bundle = applyAction(bundle, { type: 'proposeTrade', uid, give: { brick: 1 }, receive: { grain: 1 }, targetUid: other });

    expect(() => applyAction(bundle, { type: 'expireTrades', uid: other })).toThrow(/have expired/i);
  });

  it('flips an aged-out pending trade to expired, reportable by any room member', () => {
    let bundle = makeGame(2);
    bundle = driveSetup(bundle);
    bundle.room.phase = 'main';
    const uid = bundle.room.turnOrder[bundle.room.currentPlayerIndex];
    const other = bundle.room.turnOrder.find((u) => u !== uid)!;
    bundle.hands[uid].resources.brick = 1;
    bundle = applyAction(bundle, { type: 'proposeTrade', uid, give: { brick: 1 }, receive: { grain: 1 }, targetUid: other });
    const tradeId = bundle.trades[0].id;
    bundle.trades[0].createdAt = Date.now() - TRADE_EXPIRY_MS - 1000;

    // Reported by the target, not the proposer — expiry isn't gated to any particular caller.
    bundle = applyAction(bundle, { type: 'expireTrades', uid: other });
    expect(bundle.trades.find((t) => t.id === tradeId)?.status).toBe('expired');
    expect(bundle.room.log.at(-1)?.message).toContain('expired');
  });

  it('leaves a still-fresh pending trade untouched even when an older one in the same batch expires', () => {
    let bundle = makeGame(3);
    bundle = driveSetup(bundle);
    bundle.room.phase = 'main';
    const uid = bundle.room.turnOrder[bundle.room.currentPlayerIndex];
    const [otherA, otherB] = bundle.room.turnOrder.filter((u) => u !== uid);
    bundle.hands[uid].resources = { brick: 1, lumber: 1, ore: 0, grain: 0, wool: 0 };

    bundle = applyAction(bundle, { type: 'proposeTrade', uid, give: { brick: 1 }, receive: { grain: 1 }, targetUid: otherA });
    const staleId = bundle.trades[0].id;
    bundle.trades[0].createdAt = Date.now() - TRADE_EXPIRY_MS - 1000;

    bundle = applyAction(bundle, { type: 'proposeTrade', uid, give: { lumber: 1 }, receive: { wool: 1 }, targetUid: otherB });
    const freshId = bundle.trades.find((t) => t.id !== staleId)!.id;

    bundle = applyAction(bundle, { type: 'expireTrades', uid });
    expect(bundle.trades.find((t) => t.id === staleId)?.status).toBe('expired');
    expect(bundle.trades.find((t) => t.id === freshId)?.status).toBe('pending');
  });

  it('an expired trade can no longer be responded to', () => {
    let bundle = makeGame(2);
    bundle = driveSetup(bundle);
    bundle.room.phase = 'main';
    const uid = bundle.room.turnOrder[bundle.room.currentPlayerIndex];
    const other = bundle.room.turnOrder.find((u) => u !== uid)!;
    bundle.hands[uid].resources.brick = 1;
    bundle.hands[other].resources.grain = 1;
    bundle = applyAction(bundle, { type: 'proposeTrade', uid, give: { brick: 1 }, receive: { grain: 1 }, targetUid: other });
    const tradeId = bundle.trades[0].id;
    bundle.trades[0].createdAt = Date.now() - TRADE_EXPIRY_MS - 1000;
    bundle = applyAction(bundle, { type: 'expireTrades', uid });

    expect(() => applyAction(bundle, { type: 'respondTrade', uid: other, tradeId, accept: true })).toThrow(
      /no longer pending/i,
    );
  });

  it('is offered via legalActionTypes only once a pending trade has actually aged out', () => {
    let bundle = makeGame(2);
    bundle = driveSetup(bundle);
    bundle.room.phase = 'main';
    const uid = bundle.room.turnOrder[bundle.room.currentPlayerIndex];
    const other = bundle.room.turnOrder.find((u) => u !== uid)!;
    bundle.hands[uid].resources.brick = 1;
    bundle = applyAction(bundle, { type: 'proposeTrade', uid, give: { brick: 1 }, receive: { grain: 1 }, targetUid: other });
    expect(legalActionTypes(bundle, other)).not.toContain('expireTrades');

    bundle.trades[0].createdAt = Date.now() - TRADE_EXPIRY_MS - 1000;
    expect(legalActionTypes(bundle, other)).toContain('expireTrades');
  });
});

describe('timeoutTradeResponse', () => {
  it('rejects when no pending trade response has aged past tradeResponseTimerSeconds yet', () => {
    let bundle = makeGame(2);
    bundle = driveSetup(bundle);
    bundle.room.phase = 'main';
    const uid = bundle.room.turnOrder[bundle.room.currentPlayerIndex];
    const other = bundle.room.turnOrder.find((u) => u !== uid)!;
    bundle.hands[uid].resources.brick = 1;
    bundle = applyAction(bundle, { type: 'proposeTrade', uid, give: { brick: 1 }, receive: { grain: 1 }, targetUid: other });

    expect(() => applyAction(bundle, { type: 'timeoutTradeResponse', uid: other })).toThrow(/timed out yet/i);
  });

  it('rejects when the trade response timer is disabled (null)', () => {
    let bundle = makeGame(2, { tradeResponseTimerSeconds: null });
    bundle = driveSetup(bundle);
    bundle.room.phase = 'main';
    const uid = bundle.room.turnOrder[bundle.room.currentPlayerIndex];
    const other = bundle.room.turnOrder.find((u) => u !== uid)!;
    bundle.hands[uid].resources.brick = 1;
    bundle = applyAction(bundle, { type: 'proposeTrade', uid, give: { brick: 1 }, receive: { grain: 1 }, targetUid: other });
    bundle.trades[0].createdAt = Date.now() - 60_000;

    expect(() => applyAction(bundle, { type: 'timeoutTradeResponse', uid: other })).toThrow(
      /no trade response timer is configured/i,
    );
  });

  it('auto-rejects an overdue targeted trade, reportable by any room member', () => {
    let bundle = makeGame(3);
    bundle = driveSetup(bundle);
    bundle.room.phase = 'main';
    const uid = bundle.room.turnOrder[bundle.room.currentPlayerIndex];
    const [other, bystander] = bundle.room.turnOrder.filter((u) => u !== uid);
    bundle.hands[uid].resources.brick = 1;
    bundle = applyAction(bundle, { type: 'proposeTrade', uid, give: { brick: 1 }, receive: { grain: 1 }, targetUid: other });
    const tradeId = bundle.trades[0].id;
    bundle.trades[0].createdAt = Date.now() - (bundle.room.tradeResponseTimerSeconds! * 1000 + 1000);

    // Reported by an uninvolved bystander, not the target or proposer.
    bundle = applyAction(bundle, { type: 'timeoutTradeResponse', uid: bystander });
    expect(bundle.trades.find((t) => t.id === tradeId)?.status).toBe('rejected');
    expect(bundle.room.log.at(-1)?.message).toContain("didn't respond");
  });

  it('auto-rejects only the still-pending responders of an overdue open trade, leaving one who already answered untouched', () => {
    let bundle = makeGame(3);
    bundle = driveSetup(bundle);
    bundle.room.phase = 'main';
    const uid = bundle.room.turnOrder[bundle.room.currentPlayerIndex];
    const [otherA, otherB] = bundle.room.turnOrder.filter((u) => u !== uid);
    bundle.hands[uid].resources.brick = 1;
    bundle.hands[otherA].resources.grain = 1;
    bundle = applyAction(bundle, { type: 'proposeTrade', uid, give: { brick: 1 }, receive: { grain: 1 }, targetUid: null });
    const tradeId = bundle.trades[0].id;
    // otherA answers in time (expresses interest); otherB never responds.
    bundle = applyAction(bundle, { type: 'respondTrade', uid: otherA, tradeId, accept: true });
    bundle.trades[0].createdAt = Date.now() - (bundle.room.tradeResponseTimerSeconds! * 1000 + 1000);

    bundle = applyAction(bundle, { type: 'timeoutTradeResponse', uid: otherB });
    const trade = bundle.trades.find((t) => t.id === tradeId)!;
    expect(trade.status).toBe('pending'); // the whole trade isn't killed, unlike expireTrades
    expect(trade.interestedUids).toContain(otherA);
    expect(trade.rejectedUids).toContain(otherB);
  });

  it('is offered via legalActionTypes only once a pending trade response has actually timed out', () => {
    let bundle = makeGame(2);
    bundle = driveSetup(bundle);
    bundle.room.phase = 'main';
    const uid = bundle.room.turnOrder[bundle.room.currentPlayerIndex];
    const other = bundle.room.turnOrder.find((u) => u !== uid)!;
    bundle.hands[uid].resources.brick = 1;
    bundle = applyAction(bundle, { type: 'proposeTrade', uid, give: { brick: 1 }, receive: { grain: 1 }, targetUid: other });
    expect(legalActionTypes(bundle, other)).not.toContain('timeoutTradeResponse');

    bundle.trades[0].createdAt = Date.now() - (bundle.room.tradeResponseTimerSeconds! * 1000 + 1000);
    expect(legalActionTypes(bundle, other)).toContain('timeoutTradeResponse');
  });
});

describe('fog-of-war and gold hex', () => {
  function makeFogGame(seed = 'fog-seed-1'): GameStateBundle {
    const seatedPlayers = [
      { uid: 'p0', displayName: 'Player 0', isBot: false },
      { uid: 'p1', displayName: 'Player 1', isBot: false },
    ];
    return createGame({ id: 'room1', code: 'ABCDE', hostUid: 'p0', mapPreset: 'fog-of-war', seed }, seatedPlayers);
  }

  it('reveals exactly the outer ring plus the center (gold) hex at generation time', () => {
    const bundle = makeFogGame();
    const board = bundle.room.board!;
    expect(bundle.room.discoveredHexIds).toEqual(initialFogRevealHexIds(board.hexes));
    const revealed = new Set(bundle.room.discoveredHexIds);
    const centerHex = board.hexes.find((h) => h.coord.q === 0 && h.coord.r === 0)!;
    expect(centerHex.terrain).toBe('gold');
    expect(revealed.has(centerHex.id)).toBe(true);
    for (const hex of board.hexes) {
      if (revealed.has(hex.id)) {
        if (hex.terrain !== 'desert') expect(hex.number).not.toBeNull();
      } else {
        expect(hex.number).toBeNull();
      }
    }
    expect(board.hexes.some((h) => h.terrain === 'gold')).toBe(true);
  });

  it('reveals rings 4+3 (outer two rings) + center, hiding rings 1+2 (61-hex board)', () => {
    const bundle = makeFogGame();
    const board = bundle.room.board!;
    expect(board.hexes).toHaveLength(61);

    // Radius-4 hexagon ring sizes: ring 4 = 24 hexes, ring 3 = 18 hexes, ring 2 = 12 hexes,
    // ring 1 = 6 hexes, center (radius 0) = 1 hex. 24+18+12+6+1=61. Revealed at start: rings
    // 4+3 + center = 43 (ring 4 carries all 6 original desert hexes + 6 oasis clusters; ring 3
    // continues the desert corridor with 6 more desert hexes + 12 more real-resource hexes —
    // see initialFogRevealHexIds/buildFogTerrainNumberAssignment in board.ts). Hidden: rings
    // 1+2 = 18, none of them desert or gold — the same hidden-ring depth the original
    // (radius-3) fog-of-war board had, just pushed one ring further from the center now.
    const revealed = new Set(bundle.room.discoveredHexIds);
    expect(revealed.size).toBe(43);
    const hidden = board.hexes.filter((h) => !revealed.has(h.id));
    expect(hidden).toHaveLength(18);
    for (const hex of hidden) {
      expect(hex.number).toBeNull();
      expect(hex.terrain).not.toBe('desert');
      expect(hex.terrain).not.toBe('gold');
    }
  });

  it('never leaves a desert hex hidden — all 12 desert hexes (rings 4+3) start revealed', () => {
    const bundle = makeFogGame();
    const board = bundle.room.board!;
    const revealed = new Set(bundle.room.discoveredHexIds);
    const desertHexes = board.hexes.filter((h) => h.terrain === 'desert');
    expect(desertHexes).toHaveLength(12);
    for (const hex of desertHexes) expect(revealed.has(hex.id)).toBe(true);
  });

  it('rejects a starting settlement adjacent to the gold hex', () => {
    const bundle = makeFogGame();
    const board = bundle.room.board!;
    const goldHex = board.hexes.find((h) => h.terrain === 'gold')!;
    const vertexId = Object.values(board.vertices).find((v) => v.adjacentHexIds.includes(goldHex.id))!.id;
    const uid = bundle.room.turnOrder[0];
    expect(() => applyAction(bundle, { type: 'buildSettlement', uid, vertexId, free: true })).toThrow(/gold/);
  });

  it('rejects a starting settlement adjacent to a still-hidden hex', () => {
    const bundle = makeFogGame();
    const board = bundle.room.board!;
    const revealed = new Set(bundle.room.discoveredHexIds);
    const hiddenHex = board.hexes.find((h) => !revealed.has(h.id))!;
    const vertexId = Object.values(board.vertices).find((v) => v.adjacentHexIds.includes(hiddenHex.id))!.id;
    const uid = bundle.room.turnOrder[0];
    expect(() => applyAction(bundle, { type: 'buildSettlement', uid, vertexId, free: true })).toThrow(/hidden hex/);
  });

  it("rejects a setup settlement next to a hex revealed mid-setup by an earlier player's road", () => {
    let bundle = makeFogGame();
    const board = bundle.room.board!;
    const [uidA, uidB] = bundle.room.turnOrder;

    // Find a legal first-settlement vertex for player A whose free setup road can reach a
    // hidden hex in a single edge — the free road must connect directly to the settlement
    // just placed (see rules.ts's 'buildRoad' anchor check), so a longer BFS path wouldn't be
    // buildable as a single free road.
    let vertexA: VertexId | null = null;
    let revealEdgeId: string | null = null;
    const tried = new Set<VertexId>();
    for (let i = 0; i < 100; i++) {
      let candidate: VertexId;
      try {
        candidate = findFreeVertex(bundle, tried);
      } catch {
        break;
      }
      tried.add(candidate);
      const path = findPathToHiddenHex(bundle, candidate, uidA);
      if (path && path.length === 1) {
        vertexA = candidate;
        revealEdgeId = path[0];
        break;
      }
    }
    expect(vertexA).not.toBeNull();

    bundle = applyAction(bundle, { type: 'buildSettlement', uid: uidA, vertexId: vertexA!, free: true });
    const discoveredBefore = new Set(bundle.room.discoveredHexIds);
    bundle = applyAction(bundle, { type: 'buildRoad', uid: uidA, edgeId: revealEdgeId!, free: true });
    const newlyRevealed = bundle.room.discoveredHexIds!.filter((id) => !discoveredBefore.has(id));
    expect(newlyRevealed.length).toBeGreaterThan(0);

    // Player B (still in setup) tries to settle on a vertex touching that newly-revealed
    // hex — must still be rejected, even though the hex is no longer hidden, since setup
    // placements are restricted to the board's *initial* reveal set, not whatever's been
    // discovered so far.
    const revealedHexId = newlyRevealed[0];
    const candidateVertex = Object.values(board.vertices).find(
      (v) =>
        v.adjacentHexIds.includes(revealedHexId) &&
        !bundle.room.vertices[v.id] &&
        !v.adjacentVertexIds.some((n) => bundle.room.vertices[n]),
    );
    expect(candidateVertex).toBeDefined();
    expect(() =>
      applyAction(bundle, { type: 'buildSettlement', uid: uidB, vertexId: candidateVertex!.id, free: true }),
    ).toThrow(/hidden hex/);
  });

  it('resolves pending gold picks one player at a time, returning to main once all are done', () => {
    let bundle = makeFogGame();
    bundle = driveSetup(bundle);
    bundle.room.phase = 'goldPick';
    const [uidA, uidB] = bundle.room.turnOrder;
    bundle.room.pendingGoldPicks = [
      { uid: uidA, amount: 1 },
      { uid: uidB, amount: 2 },
    ];
    const oreBefore = bundle.room.bank.ore;
    const oreBeforeA = bundle.hands[uidA].resources.ore;
    const brickBeforeB = bundle.hands[uidB].resources.brick;

    bundle = applyAction(bundle, { type: 'pickGoldResources', uid: uidA, resources: ['ore'] });
    expect(bundle.room.phase).toBe('goldPick'); // uidB still pending
    expect(bundle.hands[uidA].resources.ore).toBe(oreBeforeA + 1);
    expect(bundle.room.bank.ore).toBe(oreBefore - 1);
    expect(bundle.room.log.at(-1)?.meta).toEqual({ kind: 'resourceGain', uid: uidA, resources: { ore: 1 } });

    bundle = applyAction(bundle, { type: 'pickGoldResources', uid: uidB, resources: ['brick', 'brick'] });
    expect(bundle.room.phase).toBe('main');
    expect(bundle.hands[uidB].resources.brick).toBe(brickBeforeB + 2);
    expect(bundle.room.log.at(-1)?.meta).toEqual({ kind: 'resourceGain', uid: uidB, resources: { brick: 2 } });
  });

  it('rejects a gold pick with the wrong resource count', () => {
    let bundle = makeFogGame();
    bundle = driveSetup(bundle);
    bundle.room.phase = 'goldPick';
    const uid = bundle.room.turnOrder[0];
    bundle.room.pendingGoldPicks = [{ uid, amount: 2 }];
    expect(() => applyAction(bundle, { type: 'pickGoldResources', uid, resources: ['ore'] })).toThrow(/exactly 2/);
  });

  it('rejects a gold pick from a player with nothing pending', () => {
    let bundle = makeFogGame();
    bundle = driveSetup(bundle);
    bundle.room.phase = 'goldPick';
    const [uidA, uidB] = bundle.room.turnOrder;
    bundle.room.pendingGoldPicks = [{ uid: uidA, amount: 1 }];
    expect(() => applyAction(bundle, { type: 'pickGoldResources', uid: uidB, resources: ['ore'] })).toThrow(/pending/);
  });

  it('reveals a hidden hex (with a freshly random number) and grants a resource when a road reaches it', () => {
    let bundle = makeFogGame();
    bundle = driveSetup(bundle);
    bundle.room.phase = 'main';
    const uid = bundle.room.turnOrder[bundle.room.currentPlayerIndex];
    bundle.hands[uid].resources = { brick: 20, lumber: 20, ore: 20, grain: 20, wool: 20 };

    const myVertex = Object.entries(bundle.room.vertices).find(([, b]) => b.uid === uid)![0];
    const path = findPathToHiddenHex(bundle, myVertex, uid);
    expect(path).not.toBeNull();

    const discoveredBefore = new Set(bundle.room.discoveredHexIds);
    for (const edgeId of path!) {
      if (bundle.room.edges[edgeId]) continue; // already built during setup
      bundle = applyAction(bundle, { type: 'buildRoad', uid, edgeId });
    }
    const discoveredAfter = new Set(bundle.room.discoveredHexIds!);
    const newlyRevealed = [...discoveredAfter].filter((id) => !discoveredBefore.has(id));
    expect(newlyRevealed.length).toBeGreaterThan(0);
    for (const hexId of newlyRevealed) {
      const hex = bundle.room.board!.hexes.find((h) => h.id === hexId)!;
      expect(hex.number).not.toBeNull();
    }
  });

  it('reveals a hidden hex that a road only touches at one corner (tip), not a full shared edge', () => {
    let bundle = makeFogGame();
    bundle = driveSetup(bundle);
    bundle.room.phase = 'main';
    const uid = bundle.room.turnOrder[bundle.room.currentPlayerIndex];
    bundle.hands[uid].resources = { brick: 20, lumber: 20, ore: 20, grain: 20, wool: 20 };
    const board = bundle.room.board!;
    const discoveredBefore = new Set(bundle.room.discoveredHexIds);

    const myVertex = Object.entries(bundle.room.vertices).find(([, b]) => b.uid === uid)![0];
    const path = findPathToHiddenHex(bundle, myVertex, uid, {
      // Only accept an edge whose *edge*-adjacent hexes are all already discovered, but whose
      // endpoint vertices touch an undiscovered hex — i.e. a tip/corner touch, not a side touch.
      requireTipTouchOnly: true,
    });
    expect(path).not.toBeNull();

    for (const edgeId of path!) {
      if (bundle.room.edges[edgeId]) continue; // already built during setup
      bundle = applyAction(bundle, { type: 'buildRoad', uid, edgeId });
    }
    const discoveredAfter = new Set(bundle.room.discoveredHexIds!);
    const newlyRevealed = [...discoveredAfter].filter((id) => !discoveredBefore.has(id));
    expect(newlyRevealed.length).toBeGreaterThan(0);
  });
});

// --- test-only helpers ---

/** BFS over the edge graph from `fromVertexId` to the nearest edge that would trigger a fog
 * reveal (fog-of-war only) — returns the edge ids to build, in order, ending with whichever
 * edge actually touches the hidden hex (building it is what triggers discovery). Only
 * traverses edges that are unowned or already owned by `uid`, so the returned path is always
 * legally buildable in sequence (an edge owned by another player can never be built through).
 * With `requireTipTouchOnly`, only matches an edge that touches a hidden hex solely via one of
 * its endpoint vertices (a "tip" touch) and not via `edge.adjacentHexIds` (a "side" touch). */
function findPathToHiddenHex(
  bundle: GameStateBundle,
  fromVertexId: VertexId,
  uid: string,
  opts: { requireTipTouchOnly?: boolean } = {},
): string[] | null {
  const board = bundle.room.board!;
  const discovered = new Set(bundle.room.discoveredHexIds ?? []);
  const isHidden = (hexId: string) => !discovered.has(hexId);
  const matchesEdge = (edge: Board['edges'][string]) => {
    const sideHidden = edge.adjacentHexIds.some(isHidden);
    const tipHidden = edge.vertexIds.some((vId) => board.vertices[vId].adjacentHexIds.some(isHidden));
    return opts.requireTipTouchOnly ? tipHidden && !sideHidden : sideHidden || tipHidden;
  };

  const visited = new Set<VertexId>([fromVertexId]);
  const queue: { vertex: VertexId; path: string[] }[] = [{ vertex: fromVertexId, path: [] }];
  while (queue.length > 0) {
    const { vertex, path } = queue.shift()!;
    for (const edgeId of board.vertices[vertex].adjacentEdgeIds) {
      const edge = board.edges[edgeId];
      const owner = bundle.room.edges[edgeId];
      if (owner && owner !== uid) continue; // can never legally build through another player's road
      if (matchesEdge(edge)) {
        return [...path, edgeId];
      }
      const [a, b] = edge.vertexIds;
      const next = a === vertex ? b : a;
      if (visited.has(next)) continue;
      visited.add(next);
      queue.push({ vertex: next, path: [...path, edgeId] });
    }
  }
  return null;
}

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
