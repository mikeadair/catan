import { describe, expect, it } from 'vitest';
import { applyAction, createGame, type GameStateBundle } from './rules';
import { decideBotAction } from './bots';
import { MAX_CITIES, MAX_ROADS, RESOURCES, type BotDifficulty, type Resource, type TradeOffer } from './types';

// Regression test for a real production bug: a bot deciding a robber move (after rolling a
// 7, or playing a knight) scored/picked opponents via their PRIVATE hand
// (hands[opponentUid].resources), but the decision bundle passed to decideBotAction in
// firebase/rooms.ts's claimAndRunBotAction only ever contains the acting bot's OWN hand
// (by design — bots shouldn't see hidden opponent card types any more than a human could).
// That crashed with "Cannot read properties of undefined (reading 'resources')", which
// decideBotAction's try/catch silently swallowed into `null` — permanently stalling the
// game the instant a bot rolled a 7, since every retry hit the same crash.

function makeGame(): GameStateBundle {
  return createGame(
    { id: 'r1', code: 'ABCDE', hostUid: 'p0', mapPreset: 'official-beginner', seed: 'bots-robber-test' },
    [
      { uid: 'p0', displayName: 'Bot A', isBot: true, botDifficulty: 'normal' },
      { uid: 'p1', displayName: 'Bot B', isBot: true, botDifficulty: 'normal' },
      { uid: 'p2', displayName: 'Human', isBot: false },
    ],
  );
}

/** Mirrors exactly what claimAndRunBotAction builds: full public players, only the acting
 * bot's own private hand. */
function decisionBundleFor(bundle: GameStateBundle, actingUid: string): GameStateBundle {
  return {
    room: bundle.room,
    players: bundle.players,
    hands: { [actingUid]: bundle.hands[actingUid] },
    trades: [],
  };
}

describe('decideBotAction: robber phase', () => {
  it('decides a moveRobber action without opponent hand data (empty board)', () => {
    const bundle = makeGame();
    bundle.room.phase = 'robber';
    const botUid = bundle.room.turnOrder.find((u) => bundle.players[u].isBot)!;
    bundle.room.currentPlayerIndex = bundle.room.turnOrder.indexOf(botUid);

    const action = decideBotAction(decisionBundleFor(bundle, botUid), botUid);
    expect(action).not.toBeNull();
    expect(action?.type).toBe('moveRobber');
  });

  it('picks a steal target using public resourceCount, not private hands', () => {
    const bundle = makeGame();
    const botUid = bundle.room.turnOrder.find((u) => bundle.players[u].isBot)!;
    const otherUid = bundle.room.turnOrder.find((u) => u !== botUid)!;

    // Give the bot a hex to target: put an opponent settlement on a vertex adjacent to a
    // non-desert hex, with a healthy public resourceCount so it's a worthwhile steal target.
    const board = bundle.room.board!;
    const hex = board.hexes.find((h) => h.terrain !== 'desert')!;
    const vertex = Object.values(board.vertices).find((v) => v.adjacentHexIds.includes(hex.id))!;
    bundle.room.vertices[vertex.id] = { type: 'settlement', uid: otherUid };
    bundle.players[otherUid].resourceCount = 5;
    bundle.hands[otherUid].resources = { brick: 5, lumber: 0, ore: 0, grain: 0, wool: 0 };

    bundle.room.phase = 'robber';
    bundle.room.currentPlayerIndex = bundle.room.turnOrder.indexOf(botUid);

    const action = decideBotAction(decisionBundleFor(bundle, botUid), botUid);
    expect(action).not.toBeNull();
    expect(action?.type).toBe('moveRobber');
  });
});

// ---------------------------------------------------------------------------
// Bot trading + difficulty tiers
// ---------------------------------------------------------------------------

/** Builds a bundle with the bot ('p0') on its own 'main' phase turn, hand set exactly as
 * given, and enough pieces/deck state controlled via `opts` that only the intended build
 * gap is reachable — isolating decidePlayerTrade/decideBankTrade from the earlier
 * city/settlement/road/devCard build steps in decideMainAction. */
function makeMainPhaseGame(
  botDifficulty: BotDifficulty,
  hand: Partial<Record<Resource, number>>,
  opts: { citiesMaxed?: boolean; settlementsMaxed?: boolean; roadsMaxed?: boolean; devCardDeckCount?: number } = {},
): { bundle: GameStateBundle; botUid: string } {
  const bundle = createGame(
    { id: 'r-trade', code: 'ABCDE', hostUid: 'p0', mapPreset: 'official-beginner', seed: 'bots-trade-test' },
    [
      { uid: 'p0', displayName: 'Bot', isBot: true, botDifficulty },
      { uid: 'p1', displayName: 'Other', isBot: true, botDifficulty: 'normal' },
    ],
  );
  const botUid = 'p0';
  bundle.room.phase = 'main';
  bundle.room.currentPlayerIndex = bundle.room.turnOrder.indexOf(botUid);
  bundle.room.devCardDeckCount = opts.devCardDeckCount ?? 0;
  const player = bundle.players[botUid];
  player.citiesBuilt = opts.citiesMaxed ? MAX_CITIES : 0;
  player.roadsBuilt = opts.roadsMaxed ? MAX_ROADS : 0;
  player.settlementsBuilt = opts.settlementsMaxed ? 5 : 0;
  for (const r of RESOURCES) bundle.hands[botUid].resources[r] = hand[r] ?? 0;
  return { bundle, botUid };
}

describe('decideBotAction: bank/player trading', () => {
  it('normal bot proposes a fair open trade when exactly one resource short of its next build', () => {
    const { bundle, botUid } = makeMainPhaseGame(
      'normal',
      { brick: 2, lumber: 2, ore: 3, grain: 2, wool: 0 },
      { citiesMaxed: true, roadsMaxed: true, devCardDeckCount: 0 },
    );
    const action = decideBotAction(bundle, botUid);
    expect(action?.type).toBe('proposeTrade');
    if (action?.type === 'proposeTrade') {
      expect(action.targetUid).toBeNull();
      expect(action.receive).toEqual({ wool: 1 });
      // Only gives away resources it holds a genuine (>=2) surplus of, never the resource
      // it's actually short on.
      expect(action.give.wool).toBeUndefined();
      const totalGiven = RESOURCES.reduce((s, r) => s + (action.give[r] ?? 0), 0);
      expect(totalGiven).toBe(1);
    }
  });

  it('does not propose a player trade for a resource the bank has none of left', () => {
    const { bundle, botUid } = makeMainPhaseGame(
      'normal',
      { brick: 2, lumber: 2, ore: 3, grain: 2, wool: 0 },
      { citiesMaxed: true, roadsMaxed: true, devCardDeckCount: 0 },
    );
    // Same setup as the passing case above (bot is one wool short of a settlement), except the
    // bank pool is fully depleted of wool — the bot should neither propose a player trade nor
    // fall back to a bank trade for it, since both require room.bank[need] > 0.
    bundle.room.bank.wool = 0;

    const action = decideBotAction(bundle, botUid);
    expect(action?.type).toBe('endTurn');
  });

  it('easy bot does not propose a trade (or bank-trade) in the same situation, and just ends its turn', () => {
    const { bundle, botUid } = makeMainPhaseGame(
      'easy',
      { brick: 2, lumber: 2, ore: 3, grain: 2, wool: 0 },
      { citiesMaxed: true, roadsMaxed: true, devCardDeckCount: 0 },
    );
    const action = decideBotAction(bundle, botUid);
    expect(action?.type).toBe('endTurn');
  });

  it('hard bot proposes a trade closing a two-resource-type gap that normal will not attempt', () => {
    const hand: Partial<Record<Resource, number>> = { brick: 5, lumber: 1, ore: 1, grain: 1, wool: 4 };
    const opts = { settlementsMaxed: true, roadsMaxed: true, devCardDeckCount: 0 };

    const hard = makeMainPhaseGame('hard', hand, opts);
    const hardAction = decideBotAction(hard.bundle, hard.botUid);
    expect(hardAction?.type).toBe('proposeTrade');
    if (hardAction?.type === 'proposeTrade') {
      expect(hardAction.receive).toEqual({ ore: 2, grain: 1 });
    }

    const normal = makeMainPhaseGame('normal', hand, opts);
    const normalAction = decideBotAction(normal.bundle, normal.botUid);
    // Normal only ever closes a single-resource-type gap (city here is short on two: ore
    // and grain), so it falls back to a bank trade instead of proposing to another player.
    expect(normalAction?.type).not.toBe('proposeTrade');
  });

  it('does not re-propose a trade while one from the bot is already pending', () => {
    const { bundle, botUid } = makeMainPhaseGame(
      'normal',
      { brick: 2, lumber: 2, ore: 3, grain: 2, wool: 0 },
      { citiesMaxed: true, roadsMaxed: true, devCardDeckCount: 0 },
    );
    const pendingTrade: TradeOffer = {
      id: 't1',
      proposerUid: botUid,
      targetUid: null,
      give: { ore: 1 },
      receive: { wool: 1 },
      status: 'pending',
      counterOf: null,
      createdAt: Date.now(),
      interestedUids: [],
    };
    bundle.trades.push(pendingTrade);

    const action = decideBotAction(bundle, botUid);
    expect(action?.type).not.toBe('proposeTrade');
  });
});

describe('decideBotAction: responding to trades (decideTradeResponse)', () => {
  /** Bot ('p0') is NOT the current player (p1 is), so decideBotActionInner routes to
   * decideTradeResponse regardless of room.phase. */
  function makeTradeResponseGame(
    botDifficulty: BotDifficulty,
    hand: Partial<Record<Resource, number>>,
    trade: { give: Partial<Record<Resource, number>>; receive: Partial<Record<Resource, number>> },
    targetUid: string | null = null,
  ): { bundle: GameStateBundle; botUid: string } {
    const bundle = createGame(
      { id: 'r-respond', code: 'ABCDE', hostUid: 'p0', mapPreset: 'official-beginner', seed: 'bots-respond-test' },
      [
        { uid: 'p0', displayName: 'Bot', isBot: true, botDifficulty },
        { uid: 'p1', displayName: 'Proposer', isBot: false },
      ],
    );
    const botUid = 'p0';
    bundle.room.phase = 'main';
    bundle.room.currentPlayerIndex = bundle.room.turnOrder.indexOf('p1');
    for (const r of RESOURCES) bundle.hands[botUid].resources[r] = hand[r] ?? 0;
    bundle.trades.push({
      id: 't1',
      proposerUid: 'p1',
      targetUid,
      give: trade.give,
      receive: trade.receive,
      status: 'pending',
      counterOf: null,
      createdAt: Date.now(),
      interestedUids: [],
    });
    return { bundle, botUid };
  }

  it('easy accepts a slightly unfavorable trade that normal and hard reject', () => {
    // Bot would give 2 brick to get 1 lumber back — a losing trade by card count.
    const trade = { give: { lumber: 1 }, receive: { brick: 2 } };

    const easy = makeTradeResponseGame('easy', { brick: 5, lumber: 0 }, trade);
    const easyAction = decideBotAction(easy.bundle, easy.botUid);
    expect(easyAction).toEqual({ type: 'respondTrade', uid: 'p0', tradeId: 't1', accept: true });

    const normal = makeTradeResponseGame('normal', { brick: 5, lumber: 0 }, trade);
    expect(decideBotAction(normal.bundle, normal.botUid)).toEqual({
      type: 'respondTrade',
      uid: 'p0',
      tradeId: 't1',
      accept: false,
    });

    const hard = makeTradeResponseGame('hard', { brick: 5, lumber: 0 }, trade);
    expect(decideBotAction(hard.bundle, hard.botUid)).toEqual({
      type: 'respondTrade',
      uid: 'p0',
      tradeId: 't1',
      accept: false,
    });
  });

  it('hard rejects an even trade that would deplete a scarce resource; normal accepts it', () => {
    // Even 1-for-1 swap, but the bot only has 2 ore (giving 1 leaves just 1 — scarce).
    const trade = { give: { lumber: 1 }, receive: { ore: 1 } };

    const hard = makeTradeResponseGame('hard', { ore: 2, lumber: 0 }, trade);
    expect(decideBotAction(hard.bundle, hard.botUid)).toEqual({
      type: 'respondTrade',
      uid: 'p0',
      tradeId: 't1',
      accept: false,
    });

    const normal = makeTradeResponseGame('normal', { ore: 2, lumber: 0 }, trade);
    expect(decideBotAction(normal.bundle, normal.botUid)).toEqual({
      type: 'respondTrade',
      uid: 'p0',
      tradeId: 't1',
      accept: true,
    });
  });

  // Regression coverage: decideTradeResponse used to return null (no action at all) whenever
  // it decided not to accept, which left a trade *targeted* at a specific bot pending
  // forever — the bot would never actually answer unless it happened to like the offer. A
  // targeted trade now always gets a definitive respondTrade, accept or explicit reject.
  it('explicitly rejects a targeted trade it cannot afford, rather than leaving it pending', () => {
    const trade = { give: { lumber: 1 }, receive: { ore: 3 } }; // bot has 0 ore — can't afford
    const { bundle, botUid } = makeTradeResponseGame('normal', { ore: 0, lumber: 5 }, trade, 'p0');

    expect(decideBotAction(bundle, botUid)).toEqual({ type: 'respondTrade', uid: 'p0', tradeId: 't1', accept: false });
  });

  it('explicitly rejects an unfavorable targeted trade, rather than leaving it pending', () => {
    // Same losing trade as the "easy accepts, normal/hard reject" case above, but targeted
    // directly at the bot instead of open — normal/hard must now answer, not stay silent.
    const trade = { give: { lumber: 1 }, receive: { brick: 2 } };

    const normal = makeTradeResponseGame('normal', { brick: 5, lumber: 0 }, trade, 'p0');
    expect(decideBotAction(normal.bundle, normal.botUid)).toEqual({
      type: 'respondTrade',
      uid: 'p0',
      tradeId: 't1',
      accept: false,
    });

    const hard = makeTradeResponseGame('hard', { brick: 5, lumber: 0 }, trade, 'p0');
    expect(decideBotAction(hard.bundle, hard.botUid)).toEqual({
      type: 'respondTrade',
      uid: 'p0',
      tradeId: 't1',
      accept: false,
    });
  });

  // Regression coverage: decideTradeResponse used to leave an unwanted OPEN trade alone
  // entirely (no action), which meant a trade no bot (or human) wanted just sat pending until
  // it expired 90s later instead of resolving/auto-dismissing once every eligible responder
  // had explicitly passed. It now always answers open trades too — accept (registering
  // interest) or explicit reject (rules.ts's rejectedUids), same as targeted trades.
  it('explicitly rejects an unwanted OPEN trade instead of leaving it alone', () => {
    const trade = { give: { lumber: 1 }, receive: { brick: 2 } };
    const { bundle, botUid } = makeTradeResponseGame('normal', { brick: 5, lumber: 0 }, trade, null);

    expect(decideBotAction(bundle, botUid)).toEqual({
      type: 'respondTrade',
      uid: 'p0',
      tradeId: 't1',
      accept: false,
    });
  });

  it('still accepts a favorable targeted trade', () => {
    const trade = { give: { ore: 2 }, receive: { lumber: 1 } };
    const { bundle, botUid } = makeTradeResponseGame('normal', { lumber: 3, ore: 0 }, trade, 'p0');

    expect(decideBotAction(bundle, botUid)).toEqual({ type: 'respondTrade', uid: 'p0', tradeId: 't1', accept: true });
  });

  // Regression coverage: decideBotActionInner only ever called decideTradeResponse when the
  // bot was NOT the current player — a trade targeted at (or open to) the current-turn bot
  // was never checked at all, so it sat completely unanswered until that bot's entire turn
  // finished (build actions, robber, etc.) and finally became eligible for the client's
  // off-turn trade-check driver. The bot must now answer a respondable trade before doing
  // anything else on its own turn, in both the 'roll' and 'main' phases.
  it('answers a trade targeted at it even on its own turn, before rolling or acting', () => {
    const trade = { give: { ore: 2 }, receive: { lumber: 1 } }; // favorable, should accept
    const { bundle, botUid } = makeTradeResponseGame('normal', { lumber: 3, ore: 0 }, trade, 'p0');
    bundle.room.currentPlayerIndex = bundle.room.turnOrder.indexOf(botUid); // now the bot's own turn
    bundle.room.phase = 'roll'; // would otherwise just roll the dice

    expect(decideBotAction(bundle, botUid)).toEqual({ type: 'respondTrade', uid: 'p0', tradeId: 't1', accept: true });
  });

  it('rejects an open trade during its own main-phase turn instead of building first', () => {
    const trade = { give: { lumber: 1 }, receive: { brick: 2 } }; // unfavorable, should reject
    const { bundle, botUid } = makeTradeResponseGame('normal', { brick: 5, lumber: 0 }, trade, null);
    bundle.room.currentPlayerIndex = bundle.room.turnOrder.indexOf(botUid);
    bundle.room.phase = 'main';

    expect(decideBotAction(bundle, botUid)).toEqual({ type: 'respondTrade', uid: 'p0', tradeId: 't1', accept: false });
  });
});

describe('decideBotAction: robber targeting differs by difficulty', () => {
  it('hard biases toward the human opponent even when a bot opponent has a higher raw score; normal targets by score alone', () => {
    const bundle = createGame(
      { id: 'r-robber-diff', code: 'ABCDE', hostUid: 'p0', mapPreset: 'official-beginner', seed: 'bots-robber-diff' },
      [
        { uid: 'p0', displayName: 'Acting Bot', isBot: true, botDifficulty: 'normal' },
        { uid: 'p1', displayName: 'Human', isBot: false },
        { uid: 'p2', displayName: 'Other Bot', isBot: true, botDifficulty: 'normal' },
      ],
    );
    const board = bundle.room.board!;
    const botUid = 'p0';

    // Human scores lower under the plain formula (VP*3 + resourceCount) than the bot
    // opponent, so 'normal' should target the bot opponent; 'hard' adds a flat human bias
    // large enough to flip that preference toward the human.
    bundle.players.p1.visibleVictoryPoints = 1;
    bundle.players.p1.resourceCount = 3; // normal score: 6, hard score: 13
    bundle.players.p2.visibleVictoryPoints = 2;
    bundle.players.p2.resourceCount = 1; // normal score: 7, hard score: 9

    const nonDesertHexes = board.hexes.filter((h) => h.terrain !== 'desert' && h.id !== board.robberHexId);
    const hexA = nonDesertHexes[0];
    const vertexA = Object.values(board.vertices).find((v) => v.adjacentHexIds.includes(hexA.id))!;
    // vertexB must share NO hexes at all with vertexA (not just avoid hexA/hexB by name) —
    // otherwise a hex straddling both settlements would end up with both players as
    // occupants, muddying the leader-bonus comparison this test relies on.
    const vertexACoverage = new Set(vertexA.adjacentHexIds);
    let vertexB: (typeof board.vertices)[string] | undefined;
    let hexB: (typeof board.hexes)[number] | undefined;
    for (const v of Object.values(board.vertices)) {
      if (v.adjacentHexIds.some((h) => vertexACoverage.has(h))) continue;
      const candidate = v.adjacentHexIds
        .map((hid) => board.hexes.find((h) => h.id === hid)!)
        .find((h) => h.terrain !== 'desert' && h.id !== board.robberHexId);
      if (candidate) {
        vertexB = v;
        hexB = candidate;
        break;
      }
    }
    if (!vertexB || !hexB) throw new Error('test setup: no disjoint vertex found on this board');

    bundle.room.vertices[vertexA.id] = { type: 'settlement', uid: 'p1' }; // human
    bundle.room.vertices[vertexB.id] = { type: 'settlement', uid: 'p2' }; // bot opponent

    bundle.room.phase = 'robber';
    bundle.room.currentPlayerIndex = bundle.room.turnOrder.indexOf(botUid);

    bundle.players[botUid].botDifficulty = 'hard';
    const hardAction = decideBotAction(bundle, botUid);
    expect(hardAction?.type).toBe('moveRobber');
    if (hardAction?.type === 'moveRobber') {
      expect(hardAction.robberHexId).toBe(hexA.id);
      expect(hardAction.stealFromUid).toBe('p1');
    }

    bundle.players[botUid].botDifficulty = 'normal';
    const normalAction = decideBotAction(bundle, botUid);
    expect(normalAction?.type).toBe('moveRobber');
    if (normalAction?.type === 'moveRobber') {
      expect(normalAction.robberHexId).toBe(hexB.id);
      expect(normalAction.stealFromUid).toBe('p2');
    }
  });
});

describe('decideBotAction: fog-of-war setup', () => {
  // Regression test: decideSetupAction's candidate-vertex list didn't exclude spots bordering
  // the gold hex or a hidden hex, so on the fog-of-war board a bot could repeatedly propose
  // (and have the server reject) the exact same illegal vertex every beat, since nothing
  // about the rejected proposal changes what vertexScore/candidateSettlementVertices consider
  // — the bot never placed anything ("bots don't pick a tile"). See vertexLegalForFogSetup.

  it('always proposes a settlement vertex that avoids the gold hex and every hidden hex', () => {
    // Across several seeds, not just one, since the bug only bites when the bot's own
    // highest-scoring vertex happens to be illegal — with only one hidden-safe outer ring to
    // choose from, a single seed could pass by luck even with the bug present.
    for (let i = 0; i < 8; i++) {
      const bundle = createGame(
        { id: `r-fog-${i}`, code: 'ABCDE', hostUid: 'p0', mapPreset: 'fog-of-war', seed: `bots-fog-setup-test-${i}` },
        [
          { uid: 'p0', displayName: 'Bot A', isBot: true, botDifficulty: 'normal' },
          { uid: 'p1', displayName: 'Human', isBot: false },
        ],
      );
      const board = bundle.room.board!;
      const revealed = new Set(bundle.room.discoveredHexIds);
      const botUid = bundle.room.turnOrder[bundle.room.currentPlayerIndex];

      const action = decideBotAction(bundle, botUid);
      expect(action?.type).toBe('buildSettlement');
      if (action?.type !== 'buildSettlement') continue;
      const v = board.vertices[action.vertexId];
      for (const hexId of v.adjacentHexIds) {
        const hex = board.hexes.find((h) => h.id === hexId)!;
        expect(hex.terrain, `seed ${i}: vertex ${action.vertexId} borders the gold hex`).not.toBe('gold');
        expect(revealed.has(hexId), `seed ${i}: vertex ${action.vertexId} borders hidden hex ${hexId}`).toBe(true);
      }
    }
  });

  it('two bots complete a full setup1+setup2 snake draft without an illegal placement', () => {
    // Two bots so every turn — including the "opponent's" — can be driven through the real
    // applyAction reducer, which throws on an illegal vertex just like the server would; this
    // is the strongest possible check that
    // decideSetupAction and rules.ts's own validation actually agree.
    let bundle = createGame(
      { id: 'r2', code: 'ABCDE', hostUid: 'p0', mapPreset: 'fog-of-war', seed: 'bots-fog-setup-draft-test' },
      [
        { uid: 'p0', displayName: 'Bot A', isBot: true, botDifficulty: 'normal' },
        { uid: 'p1', displayName: 'Bot B', isBot: true, botDifficulty: 'hard' },
      ],
    );
    for (let i = 0; i < 8; i++) {
      // 2 players x 2 rounds x (settlement + road) = 8 actions to reach phase 'roll'.
      const uid = bundle.room.turnOrder[bundle.room.currentPlayerIndex];
      const action = decideBotAction(bundle, uid);
      expect(action, `action ${i}: bot ${uid} failed to decide (would previously null out on a permanently-rejected illegal spot)`).not.toBeNull();
      bundle = applyAction(bundle, action!);
    }
    expect(bundle.room.phase).toBe('roll');
    for (const uid of bundle.room.turnOrder) {
      expect(bundle.players[uid].settlementsBuilt).toBe(2);
      expect(bundle.players[uid].roadsBuilt).toBe(2);
    }
  });
});
