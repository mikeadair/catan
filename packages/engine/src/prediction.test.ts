import { describe, expect, it } from 'vitest';
import { applyAction, createGame } from './rules';
import type { GameStateBundle } from './rules';
import { canPredictAction, predictAction, type PredictionInput } from './prediction';
import { initialFogRevealHexIds } from './board';
import type { GameAction, MapPresetId, TradeOffer, VertexId } from './types';

function makeGame(playerCount = 4, mapPreset: MapPresetId = 'official-beginner'): GameStateBundle {
  const seatedPlayers = Array.from({ length: playerCount }, (_, i) => ({
    uid: `p${i}`,
    displayName: `Player ${i}`,
    isBot: false,
  }));
  return createGame(
    { id: 'room1', code: 'ABCDE', hostUid: 'p0', mapPreset, seed: 'fixed-test-seed' },
    seatedPlayers,
  );
}

function findFreeVertex(bundle: GameStateBundle, excluding: Set<VertexId>): VertexId {
  const board = bundle.room.board!;
  const touchesGold = (v: (typeof board.vertices)[string]) =>
    v.adjacentHexIds.some((h) => board.hexes.find((hex) => hex.id === h)?.terrain === 'gold');
  const initialReveal = bundle.room.discoveredHexIds !== null ? new Set(initialFogRevealHexIds(board.hexes)) : null;
  const touchesHidden = (v: (typeof board.vertices)[string]) =>
    initialReveal !== null && v.adjacentHexIds.some((h) => !initialReveal.has(h));
  for (const v of Object.values(board.vertices)) {
    if (excluding.has(v.id)) continue;
    if (bundle.room.vertices[v.id]) continue;
    if (v.adjacentVertexIds.some((n) => bundle.room.vertices[n])) continue;
    if (touchesGold(v)) continue;
    if (touchesHidden(v)) continue;
    return v.id;
  }
  throw new Error('No free vertex available');
}

function driveSetup(bundle: GameStateBundle): GameStateBundle {
  let b = bundle;
  const usedVertices = new Set<VertexId>();
  for (let round = 0; round < 2; round++) {
    const order = round === 0 ? b.room.turnOrder : [...b.room.turnOrder].reverse();
    for (const uid of order) {
      const vertexId = findFreeVertex(b, usedVertices);
      usedVertices.add(vertexId);
      b = applyAction(b, { type: 'buildSettlement', uid, vertexId, free: true });
      const edgeId = b.room.board!.vertices[vertexId].adjacentEdgeIds.find((e) => !b.room.edges[e])!;
      b = applyAction(b, { type: 'buildRoad', uid, edgeId, free: true });
    }
  }
  return b;
}

/** Post-setup game in 'main' phase with p0 current and a stocked hand. */
function mainPhaseGame(mapPreset: MapPresetId = 'official-beginner'): GameStateBundle {
  const b = driveSetup(makeGame(4, mapPreset));
  b.room.phase = 'main';
  b.room.diceRoll = [3, 3];
  b.hands.p0.resources = { brick: 4, lumber: 4, ore: 4, grain: 4, wool: 4 };
  b.players.p0.resourceCount = 20;
  return b;
}

function inputFor(bundle: GameStateBundle, uid: string): PredictionInput {
  return {
    room: bundle.room,
    players: bundle.players,
    trades: bundle.trades,
    uid,
    ownHand: bundle.hands[uid],
  };
}

describe('canPredictAction', () => {
  const noTrades: TradeOffer[] = [];

  it('rejects actions with server-side randomness or hidden state', () => {
    for (const action of [
      { type: 'rollDice', uid: 'p0' },
      { type: 'buyDevCard', uid: 'p0' },
      { type: 'playMonopoly', uid: 'p0', devCardId: 'x', resource: 'ore' },
      { type: 'finalizeTrade', uid: 'p0', tradeId: 't', withUid: 'p1' },
      { type: 'timeoutDiscard', uid: 'p0' },
      { type: 'timeoutRobber', uid: 'p0' },
      { type: 'timeoutSetupPlacement', uid: 'p0' },
    ] satisfies GameAction[]) {
      expect(canPredictAction(action, noTrades)).toBe(false);
    }
  });

  it('rejects robber moves that steal, allows steal-free ones', () => {
    expect(canPredictAction({ type: 'moveRobber', uid: 'p0', robberHexId: 'h', stealFromUid: 'p1' }, noTrades)).toBe(false);
    expect(canPredictAction({ type: 'moveRobber', uid: 'p0', robberHexId: 'h', stealFromUid: null }, noTrades)).toBe(true);
    expect(canPredictAction({ type: 'playKnight', uid: 'p0', devCardId: 'x', robberHexId: 'h', stealFromUid: 'p1' }, noTrades)).toBe(false);
  });

  it('distinguishes open-trade accepts (predictable) from targeted ones (not)', () => {
    const base = {
      id: 't1',
      proposerUid: 'p1',
      give: { brick: 1 },
      receive: { ore: 1 },
      status: 'pending',
      counterOf: null,
      createdAt: Date.now(),
    } as const;
    const open: TradeOffer = { ...base, targetUid: null };
    const targeted: TradeOffer = { ...base, targetUid: 'p0' };
    const accept: GameAction = { type: 'respondTrade', uid: 'p0', tradeId: 't1', accept: true };
    const reject: GameAction = { type: 'respondTrade', uid: 'p0', tradeId: 't1', accept: false };
    expect(canPredictAction(accept, [open])).toBe(true);
    expect(canPredictAction(accept, [targeted])).toBe(false);
    expect(canPredictAction(accept, [])).toBe(false); // unknown trade: don't guess
    expect(canPredictAction(reject, [targeted])).toBe(true);
  });
});

describe('predictAction', () => {
  it('predicts a paid road exactly (board, bank, own hand)', () => {
    const b = mainPhaseGame();
    const edgeId = Object.values(b.room.board!.edges).find(
      (e) => !b.room.edges[e.id] && e.vertexIds.some((v) => b.room.vertices[v]?.uid === 'p0'),
    )!.id;
    const action: GameAction = { type: 'buildRoad', uid: 'p0', edgeId };

    const predicted = predictAction(inputFor(b, 'p0'), action);
    expect(predicted).not.toBeNull();
    const authoritative = applyAction(b, action);
    expect(predicted!.room.edges).toEqual(authoritative.room.edges);
    expect(predicted!.room.bank).toEqual(authoritative.room.bank);
    expect(predicted!.hands.p0.resources).toEqual(authoritative.hands.p0.resources);
    expect(predicted!.players.p0.roadsBuilt).toBe(authoritative.players.p0.roadsBuilt);
  });

  it('predicts endTurn phase/turn bookkeeping', () => {
    const b = mainPhaseGame();
    const predicted = predictAction(inputFor(b, 'p0'), { type: 'endTurn', uid: 'p0' });
    expect(predicted).not.toBeNull();
    expect(predicted!.room.phase).toBe('roll');
    expect(predicted!.room.currentPlayerIndex).toBe(1);
    expect(predicted!.room.turnNumber).toBe(b.room.turnNumber + 1);
  });

  it('predicts a bank trade against the own hand only', () => {
    const b = mainPhaseGame();
    const input = inputFor(b, 'p0');
    const tradeAt = (giveAmount: number): GameAction => ({
      type: 'bankTrade',
      uid: 'p0',
      give: 'brick',
      giveAmount,
      receive: 'ore',
    });
    // p0's real rate depends on which ports setup happened to reach — the engine enforces
    // the exact rate, so probe for it rather than assuming 4:1.
    const rate = [4, 3, 2].find((amt) => predictAction(input, tradeAt(amt)) !== null);
    expect(rate).toBeDefined();
    const predicted = predictAction(input, tradeAt(rate!))!;
    expect(predicted.hands.p0.resources.brick).toBe(4 - rate!);
    expect(predicted.hands.p0.resources.ore).toBe(5);
  });

  it('never mutates its input', () => {
    const b = mainPhaseGame();
    const snapshot = structuredClone({ room: b.room, hand: b.hands.p0, players: b.players, trades: b.trades });
    predictAction(inputFor(b, 'p0'), { type: 'endTurn', uid: 'p0' });
    expect(b.room).toEqual(snapshot.room);
    expect(b.hands.p0).toEqual(snapshot.hand);
    expect(b.players).toEqual(snapshot.players);
    expect(b.trades).toEqual(snapshot.trades);
  });

  it('returns null for other players\' actions, illegal moves, and unpredictable types', () => {
    const b = mainPhaseGame();
    const input = inputFor(b, 'p0');
    expect(predictAction(input, { type: 'endTurn', uid: 'p1' })).toBeNull();
    expect(predictAction(input, { type: 'rollDice', uid: 'p0' })).toBeNull();
    b.hands.p0.resources = { brick: 0, lumber: 0, ore: 0, grain: 0, wool: 0 };
    const edgeId = Object.values(b.room.board!.edges).find(
      (e) => !b.room.edges[e.id] && e.vertexIds.some((v) => b.room.vertices[v]?.uid === 'p0'),
    )!.id;
    expect(predictAction(inputFor(b, 'p0'), { type: 'buildRoad', uid: 'p0', edgeId })).toBeNull();
  });

  it('bails (null) on a fog-of-war road that would reveal a hex, instead of guessing its number', () => {
    const b = mainPhaseGame('fog-of-war');
    const discovered = new Set(b.room.discoveredHexIds!);
    const board = b.room.board!;
    // A free edge whose surrounding hexes include an undiscovered one — placing it consumes
    // randomness (the revealed hex's number token), so no prediction. Setup roads may not
    // reach that far, so wire connectivity up manually: hand p0 a neighboring edge.
    const revealingEdge = Object.values(board.edges).find((e) => {
      if (b.room.edges[e.id]) return false;
      const touched = new Set(e.adjacentHexIds);
      for (const v of e.vertexIds) for (const h of board.vertices[v].adjacentHexIds) touched.add(h);
      return [...touched].some((h) => !discovered.has(h));
    })!;
    expect(revealingEdge).toBeDefined();
    const neighborEdge = board.vertices[revealingEdge.vertexIds[0]].adjacentEdgeIds.find(
      (e) => e !== revealingEdge.id && !b.room.edges[e],
    )!;
    b.room.edges[neighborEdge] = 'p0';
    const action: GameAction = { type: 'buildRoad', uid: 'p0', edgeId: revealingEdge.id };
    // Positive control: the authoritative path (real rng) accepts this exact action…
    expect(() => applyAction(b, action)).not.toThrow();
    // …so the null below is the randomness guard, not an illegal move.
    expect(predictAction(inputFor(b, 'p0'), action)).toBeNull();
  });
});
