// Heuristic bot AI. Zero Firebase/React imports.
// decideBotAction is called in a loop by an external bot-driver until it
// returns null or an 'endTurn' action. It never throws to the caller — any
// internal error results in `null` so the driver can safely stop/skip a beat.
//
// Three difficulty tiers (PublicPlayer.botDifficulty, default 'normal' when absent):
//  - 'easy': weaker placement/robber evaluation, no strategic trading (bank or
//    player), and occasionally skips a beneficial build entirely.
//  - 'normal': the original heuristics — solid placement scoring, bank trading
//    toward whatever build it's closest to, no player-to-player trade proposals.
//  - 'hard': sharper placement scoring (weights 6/8 and ports higher), targets
//    the strongest opponent (with a bias toward humans over bots) with the
//    robber, and will additionally propose player trades to close a 2-resource
//    gap (normal only closes a 1-resource gap).

import type {
  BotDifficulty,
  EdgeId,
  GameAction,
  Resource,
  ResourceCount,
  RoomState,
  VertexId,
} from './types';
import {
  BUILD_COSTS,
  MAX_CITIES,
  MAX_ROADS,
  MAX_SETTLEMENTS,
  MIN_OPEN_TRADE_WINDOW_MS,
  RESOURCES,
  STARTING_BANK,
  TERRAIN_RESOURCE,
} from './types';
import { pipCount, vertexLegalForFogSetup } from './board';
import type { GameStateBundle } from './rules';

export function decideBotAction(bundle: GameStateBundle, botUid: string): GameAction | null {
  try {
    return decideBotActionInner(bundle, botUid);
  } catch {
    return null;
  }
}

function decideBotActionInner(bundle: GameStateBundle, botUid: string): GameAction | null {
  const { room, players, hands } = bundle;
  const player = players[botUid];
  const hand = hands[botUid];
  if (!player || !hand || !room.board) return null;
  const difficulty: BotDifficulty = player.botDifficulty ?? 'normal';

  if (room.phase === 'discard') {
    if (!room.pendingDiscardUids.includes(botUid)) return null;
    return decideDiscard(bundle, botUid);
  }

  if (room.phase === 'goldPick') {
    const pending = room.pendingGoldPicks.find((p) => p.uid === botUid);
    if (!pending) return null;
    return decideGoldPick(bundle, botUid, pending.amount);
  }

  if (room.phase === 'setup1' || room.phase === 'setup2') {
    if (room.turnOrder[room.currentPlayerIndex] !== botUid) return null;
    return decideSetupAction(bundle, botUid, difficulty);
  }

  if (room.phase === 'robber') {
    if (room.turnOrder[room.currentPlayerIndex] !== botUid) return null;
    return decideRobberMove(bundle, botUid, null, difficulty);
  }

  const isCurrent = room.turnOrder[room.currentPlayerIndex] === botUid;
  if (!isCurrent) {
    return decideTradeResponse(bundle, botUid, difficulty);
  }

  // Even on the bot's own turn, a trade someone's targeted at it (or an open trade it could
  // answer) needs a response before anything else — otherwise it sits completely unanswered
  // until the bot's *entire* turn finishes (build actions, robber, etc.) and the client's
  // off-turn trade-check driver (which explicitly skips the current player — see
  // triggerOffTurnBotTradeChecks in store.ts) finally picks it up. decideTradeResponse itself
  // already no-ops (returns null) when there's nothing respondable, so this is a cheap check
  // on every turn.
  if (room.phase === 'roll' || room.phase === 'main') {
    const tradeResponse = decideTradeResponse(bundle, botUid, difficulty);
    if (tradeResponse) return tradeResponse;
  }

  if (room.phase === 'roll') {
    return { type: 'rollDice', uid: botUid };
  }

  if (room.phase === 'main') {
    return decideMainAction(bundle, botUid, difficulty);
  }

  return null;
}

// ---------------------------------------------------------------------------
// Shared scoring helpers
// ---------------------------------------------------------------------------

function candidateSettlementVertices(bundle: GameStateBundle): VertexId[] {
  const { room } = bundle;
  const board = room.board!;
  return Object.keys(board.vertices).filter((vId) => {
    if (room.vertices[vId]) return false;
    const v = board.vertices[vId];
    return !v.adjacentVertexIds.some((n) => room.vertices[n]);
  });
}

/** Difficulty affects both the inputs considered and how heavily they're weighted:
 * 'easy' ignores resource-diversity/port value entirely (raw pip count only, the
 * weakest evaluation); 'normal' is the original balanced score; 'hard' additionally
 * rewards the high-probability 6/8 numbers and values ports more. */
function vertexScore(bundle: GameStateBundle, vertexId: VertexId, difficulty: BotDifficulty = 'normal'): number {
  const { room } = bundle;
  const board = room.board!;
  const v = board.vertices[vertexId];
  if (!v) return 0;
  let pipScore = 0;
  let primeBonus = 0;
  const resourcesSeen = new Set<Resource>();
  for (const hexId of v.adjacentHexIds) {
    const hex = board.hexes.find((h) => h.id === hexId);
    if (!hex) continue;
    pipScore += pipCount(hex.number);
    if (difficulty === 'hard' && (hex.number === 6 || hex.number === 8)) primeBonus += 0.5;
    // Gold has no fixed resource (bot picks whatever's scarcest when it actually rolls —
    // see 'pickGoldResources'); the pip-count bump above already values it, just skip the
    // fixed-resource-diversity bonus since there isn't one to look up.
    if (hex.terrain !== 'desert' && hex.terrain !== 'gold') resourcesSeen.add(TERRAIN_RESOURCE[hex.terrain]);
  }
  if (difficulty === 'easy') return pipScore;
  let score = pipScore + resourcesSeen.size * 0.5 + primeBonus;
  if (board.ports.some((p) => p.vertexIds.includes(vertexId))) score += difficulty === 'hard' ? 1.5 : 1;
  return score;
}

function canAffordLocal(have: ResourceCount, cost: Partial<ResourceCount>): boolean {
  for (const r of RESOURCES) {
    if ((have[r] ?? 0) < (cost[r] ?? 0)) return false;
  }
  return true;
}

function portRateLocal(bundle: GameStateBundle, uid: string, resource: Resource): number {
  const { room } = bundle;
  const board = room.board!;
  const myVertices = new Set(
    Object.entries(room.vertices)
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

// ---------------------------------------------------------------------------
// Setup placement
// ---------------------------------------------------------------------------

function decideSetupAction(bundle: GameStateBundle, botUid: string, difficulty: BotDifficulty): GameAction {
  const { room, players } = bundle;
  const player = players[botUid];

  if (player.settlementsBuilt === player.roadsBuilt) {
    // fog-of-war: exclude spots the server would reject anyway (bordering the gold hex or a
    // hidden hex) — same check rules.ts's 'buildSettlement' handler enforces, shared via
    // vertexLegalForFogSetup so this can't silently drift out of sync with the real rule.
    // Without this, a bot could repeatedly propose (and have rejected) the same illegal spot
    // every beat, since nothing about game state changes to make it reconsider.
    const candidates = candidateSettlementVertices(bundle).filter((vId) =>
      vertexLegalForFogSetup(room.board!, room.discoveredHexIds, vId),
    );
    if (candidates.length === 0) throw new Error('bot: no legal setup settlement spot');
    candidates.sort((a, b) => vertexScore(bundle, b, difficulty) - vertexScore(bundle, a, difficulty));
    return { type: 'buildSettlement', uid: botUid, vertexId: candidates[0], free: true };
  }

  const anchor = room.lastSetupSettlementVertexId;
  if (!anchor) throw new Error('bot: missing setup anchor');
  const board = room.board!;
  const v = board.vertices[anchor];
  const options = v.adjacentEdgeIds.filter((eId) => !room.edges[eId]);
  if (options.length === 0) throw new Error('bot: no legal setup road');
  let best = options[0];
  let bestScore = -Infinity;
  for (const eId of options) {
    const edge = board.edges[eId];
    const other = edge.vertexIds.find((id) => id !== anchor)!;
    const s = vertexScore(bundle, other, difficulty);
    if (s > bestScore) {
      bestScore = s;
      best = eId;
    }
  }
  return { type: 'buildRoad', uid: botUid, edgeId: best, free: true };
}

// ---------------------------------------------------------------------------
// Discard
// ---------------------------------------------------------------------------

function decideDiscard(bundle: GameStateBundle, botUid: string): GameAction {
  const { hands } = bundle;
  const hand = hands[botUid];
  const total = RESOURCES.reduce((s, r) => s + hand.resources[r], 0);
  const required = Math.floor(total / 2);
  const counts = RESOURCES.map((r) => ({ r, n: hand.resources[r] })).sort((a, b) => b.n - a.n);
  const toDiscard: Partial<ResourceCount> = {};
  let remaining = required;
  for (const { r, n } of counts) {
    if (remaining <= 0) break;
    const take = Math.min(n, remaining);
    if (take > 0) {
      toDiscard[r] = take;
      remaining -= take;
    }
  }
  return { type: 'discard', uid: botUid, resources: toDiscard };
}

/** Greedily fills whichever resource(s) the bot is shortest on — the inverse priority of
 * decideDiscard, which sheds whatever it has the most of. */
function decideGoldPick(bundle: GameStateBundle, botUid: string, amount: number): GameAction {
  const { hands } = bundle;
  const hand = hands[botUid];
  const counts = RESOURCES.map((r) => ({ r, n: hand.resources[r] })).sort((a, b) => a.n - b.n);
  const resources: Resource[] = Array.from({ length: amount }, (_, i) => counts[i % counts.length].r);
  return { type: 'pickGoldResources', uid: botUid, resources };
}

// ---------------------------------------------------------------------------
// Robber
// ---------------------------------------------------------------------------

/** How worrying an opponent looks, purely from public info (visibleVictoryPoints +
 * resourceCount — a bot can no more see a rival's hidden hand than a human could).
 * 'easy' evaluates this crudely (card count only, ignoring VP); 'hard' weighs VP more
 * heavily and adds an explicit bias toward human targets over fellow bots, so a 'hard'
 * bot is meaningfully more likely to lean on the human player specifically. */
function opponentThreatScore(players: GameStateBundle['players'], uid: string, difficulty: BotDifficulty): number {
  const p = players[uid];
  if (difficulty === 'easy') return p.resourceCount;
  if (difficulty === 'hard') return p.visibleVictoryPoints * 4 + p.resourceCount + (p.isBot ? 0 : 6);
  return p.visibleVictoryPoints * 3 + p.resourceCount;
}

function decideRobberMove(
  bundle: GameStateBundle,
  botUid: string,
  devCardId: string | null,
  difficulty: BotDifficulty,
): GameAction {
  const { room, players } = bundle;
  const board = room.board!;
  const opponents = room.turnOrder.filter((u) => u !== botUid);

  let leader: string | null = null;
  for (const u of opponents) {
    if (leader === null || opponentThreatScore(players, u, difficulty) > opponentThreatScore(players, leader, difficulty)) {
      leader = u;
    }
  }

  const candidateHexes = board.hexes.filter((h) => h.id !== board.robberHexId);
  let bestHex = candidateHexes[0];
  let bestScore = -Infinity;
  for (const hex of candidateHexes) {
    const vIds = Object.values(board.vertices)
      .filter((v) => v.adjacentHexIds.includes(hex.id))
      .map((v) => v.id);
    const occupants = new Set(vIds.map((v) => room.vertices[v]?.uid).filter(Boolean) as string[]);
    let score = 0;
    if (leader && occupants.has(leader)) score += 10;
    if (occupants.has(botUid)) score -= 20;
    score += occupants.size;
    if (score > bestScore) {
      bestScore = score;
      bestHex = hex;
    }
  }

  const vIds = Object.values(board.vertices)
    .filter((v) => v.adjacentHexIds.includes(bestHex.id))
    .map((v) => v.id);
  const victims = Array.from(
    new Set(vIds.map((v) => room.vertices[v]?.uid).filter((u): u is string => !!u && u !== botUid)),
  );
  let stealFromUid: string | null = null;
  for (const u of victims) {
    if (stealFromUid === null || opponentThreatScore(players, u, difficulty) > opponentThreatScore(players, stealFromUid, difficulty)) {
      stealFromUid = u;
    }
  }

  if (devCardId) {
    return { type: 'playKnight', uid: botUid, devCardId, robberHexId: bestHex.id, stealFromUid };
  }
  return { type: 'moveRobber', uid: botUid, robberHexId: bestHex.id, stealFromUid };
}

// ---------------------------------------------------------------------------
// Main-phase turn logic
// ---------------------------------------------------------------------------

function bestConnectedSettlementVertex(bundle: GameStateBundle, botUid: string, difficulty: BotDifficulty): VertexId | null {
  const { room } = bundle;
  const candidates = candidateSettlementVertices(bundle).filter((vId) => {
    const v = room.board!.vertices[vId];
    return v.adjacentEdgeIds.some((eId) => room.edges[eId] === botUid);
  });
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => vertexScore(bundle, b, difficulty) - vertexScore(bundle, a, difficulty));
  return candidates[0];
}

function bestExpansionRoad(bundle: GameStateBundle, botUid: string, difficulty: BotDifficulty): EdgeId | null {
  const { room } = bundle;
  const board = room.board!;
  const ownVertices = new Set<VertexId>();
  for (const [eId, owner] of Object.entries(room.edges)) {
    if (owner !== botUid) continue;
    for (const v of board.edges[eId].vertexIds) ownVertices.add(v);
  }
  for (const [vId, b] of Object.entries(room.vertices)) {
    if (b.uid === botUid) ownVertices.add(vId);
  }

  let best: EdgeId | null = null;
  let bestScore = -Infinity;
  for (const [eId, e] of Object.entries(board.edges)) {
    if (room.edges[eId]) continue;
    const touches = e.vertexIds.some((v) => ownVertices.has(v));
    if (!touches) continue;
    const farVertex = e.vertexIds.find((v) => !ownVertices.has(v)) ?? e.vertexIds[0];
    const score = vertexScore(bundle, farVertex, difficulty);
    if (score > bestScore) {
      bestScore = score;
      best = eId;
    }
  }
  return best;
}

function pickNeededResource(resources: ResourceCount): Resource {
  const sorted = RESOURCES.slice().sort((a, b) => resources[a] - resources[b]);
  return sorted[0];
}

/** In priority order (matching decideMainAction's build priority), the costs of every
 * build the bot could still make progress toward — i.e. hasn't maxed out piece-wise, or
 * (for dev cards) the deck isn't empty. Shared by the bank-trade and player-trade
 * heuristics below so both target "whatever's actually blocking a build" consistently. */
function buildPriorityCosts(bundle: GameStateBundle, botUid: string): Partial<ResourceCount>[] {
  const { room, players } = bundle;
  const player = players[botUid];
  const costs: Partial<ResourceCount>[] = [];
  if (player.citiesBuilt < MAX_CITIES) costs.push(BUILD_COSTS.city);
  if (player.settlementsBuilt < MAX_SETTLEMENTS) costs.push(BUILD_COSTS.settlement);
  if (player.roadsBuilt < MAX_ROADS) costs.push(BUILD_COSTS.road);
  if (room.devCardDeckCount > 0) costs.push(BUILD_COSTS.devCard);
  return costs;
}

/** Per-resource shortfall (cost - have, only for resources actually short) for a single
 * build cost against the bot's current hand. */
function resourceDeficits(hand: ResourceCount, cost: Partial<ResourceCount>): Partial<Record<Resource, number>> {
  const out: Partial<Record<Resource, number>> = {};
  for (const r of RESOURCES) {
    const need = cost[r] ?? 0;
    if (hand[r] < need) out[r] = need - hand[r];
  }
  return out;
}

/** Whether anyone *other than this bot* could conceivably hold resource `r`, computed from
 * public information alone: room.bank[r] plus every player's hand[r] always sums to the
 * fixed STARTING_BANK[r] total (resources move between bank and hands — building costs are
 * credited back to the bank, trades/steals move card-for-card — but the total per resource
 * type is always conserved). So "how much do other players collectively hold" is exactly
 * STARTING_BANK[r] - room.bank[r] - thisBot'sOwnHand[r], with no need to see any other
 * player's actual (private) hand. */
function othersMayHave(room: RoomState, hand: ResourceCount, r: Resource): boolean {
  return STARTING_BANK[r] - room.bank[r] - hand[r] > 0;
}

/** Bank-trade target: the resource that would unlock the highest-priority build it's
 * exactly one resource TYPE short of, falling back to "whatever I have least of" if no
 * build is that close. */
function pickBankTradeTarget(bundle: GameStateBundle, botUid: string): Resource {
  const hand = bundle.hands[botUid].resources;
  for (const cost of buildPriorityCosts(bundle, botUid)) {
    const deficits = resourceDeficits(hand, cost);
    const missing = RESOURCES.filter((r) => deficits[r]);
    if (missing.length === 1) return missing[0];
  }
  return pickNeededResource(hand);
}

function decideBankTrade(bundle: GameStateBundle, botUid: string): GameAction | null {
  const { room, hands } = bundle;
  const hand = hands[botUid];
  for (const give of RESOURCES) {
    const rate = portRateLocal(bundle, botUid, give);
    if (hand.resources[give] < rate) continue;
    // Don't trade away the last copies of a resource we're not truly flush in.
    if (hand.resources[give] - rate < 0) continue;
    const need = pickBankTradeTarget(bundle, botUid);
    if (need === give) continue;
    if (room.bank[need] <= 0) continue;
    return { type: 'bankTrade', uid: botUid, give, giveAmount: rate, receive: need };
  }
  return null;
}

/**
 * Proposes an open (targetUid: null) player trade when the bot is short exactly one
 * resource TYPE ('normal') — or up to two ('hard') — for its highest-priority buildable
 * item, and holds a genuine surplus (≥2 more than that build itself needs) of something
 * else to offer in a fair, same-size swap. 'easy' never proposes (no strategic trading).
 * Skips entirely if the bot already has an open trade pending, so a stalled proposal
 * doesn't get re-spammed every time the reactive bot-driver re-evaluates this turn.
 */
function decidePlayerTrade(bundle: GameStateBundle, botUid: string, difficulty: BotDifficulty): GameAction | null {
  if (difficulty === 'easy') return null;
  const { room, hands, trades } = bundle;
  const hand = hands[botUid].resources;
  if (trades.some((t) => t.proposerUid === botUid && t.status === 'pending')) return null;

  const maxGapTypes = difficulty === 'hard' ? 2 : 1;
  for (const cost of buildPriorityCosts(bundle, botUid)) {
    const deficits = resourceDeficits(hand, cost);
    const missingTypes = RESOURCES.filter((r) => deficits[r]);
    if (missingTypes.length === 0 || missingTypes.length > maxGapTypes) continue;
    // A *player* trade's counterparty is other players, not the bank — checking room.bank
    // here (as decideBankTrade correctly does for its own, bank-counterparty case) was
    // actually testing the wrong thing: the bank being empty says nothing about whether
    // other players hold the resource, and by the same token a nonempty bank doesn't rule
    // out the degenerate case where this bot itself already holds every remaining copy.
    // othersMayHave uses only public information (room.bank, the fixed total supply) plus
    // this bot's own hand — never another player's private hand — to work out whether
    // *anyone but this bot* could conceivably hold any, via resource conservation.
    if (missingTypes.some((r) => !othersMayHave(room, hand, r))) continue;

    let remaining = missingTypes.reduce((s, r) => s + (deficits[r] ?? 0), 0);
    const give: Partial<ResourceCount> = {};
    for (const r of RESOURCES) {
      if (remaining === 0) break;
      if (missingTypes.includes(r)) continue;
      const margin = hand[r] - (cost[r] ?? 0);
      if (margin < 2) continue;
      const take = Math.min(margin, remaining);
      give[r] = take;
      remaining -= take;
    }
    if (remaining > 0) continue; // not enough genuine surplus to cover the gap fairly

    const receive: Partial<ResourceCount> = {};
    for (const r of missingTypes) receive[r] = deficits[r]!;
    return { type: 'proposeTrade', uid: botUid, give, receive, targetUid: null };
  }
  return null;
}

// 'easy' bots occasionally just end their turn instead of making an otherwise-available
// build, reflecting weaker play. Kept as a single named constant so tests can reason about
// (and mock Math.random around) the exact threshold.
const EASY_SKIP_BUILD_CHANCE = 0.15;

function decideMainAction(bundle: GameStateBundle, botUid: string, difficulty: BotDifficulty): GameAction | null {
  const { room, players, hands, trades } = bundle;
  const player = players[botUid];
  const hand = hands[botUid];

  if (difficulty === 'easy' && Math.random() < EASY_SKIP_BUILD_CHANCE) {
    return { type: 'endTurn', uid: botUid };
  }

  // 1. Upgrade to city.
  if (player.citiesBuilt < MAX_CITIES && canAffordLocal(hand.resources, BUILD_COSTS.city)) {
    const ownSettlements = Object.entries(room.vertices)
      .filter(([, b]) => b.uid === botUid && b.type === 'settlement')
      .map(([id]) => id);
    if (ownSettlements.length > 0) {
      ownSettlements.sort((a, b) => vertexScore(bundle, b, difficulty) - vertexScore(bundle, a, difficulty));
      return { type: 'buildCity', uid: botUid, vertexId: ownSettlements[0] };
    }
  }

  // 2. Build settlement on a strong, connected, open spot.
  if (player.settlementsBuilt < MAX_SETTLEMENTS && canAffordLocal(hand.resources, BUILD_COSTS.settlement)) {
    const spot = bestConnectedSettlementVertex(bundle, botUid, difficulty);
    if (spot) return { type: 'buildSettlement', uid: botUid, vertexId: spot };
  }

  // 3. Build a road toward a decent spot.
  if (player.roadsBuilt < MAX_ROADS && canAffordLocal(hand.resources, BUILD_COSTS.road)) {
    const edge = bestExpansionRoad(bundle, botUid, difficulty);
    if (edge) return { type: 'buildRoad', uid: botUid, edgeId: edge };
  }

  // 4. Buy a development card.
  if (room.devCardDeckCount > 0 && canAffordLocal(hand.resources, BUILD_COSTS.devCard)) {
    return { type: 'buyDevCard', uid: botUid };
  }

  // 5. Propose a player trade to close a resource gap ('easy' never does this).
  const playerTrade = decidePlayerTrade(bundle, botUid, difficulty);
  if (playerTrade) return playerTrade;

  // 6. Trade with the bank to work toward the next priority ('easy' never does this).
  if (difficulty !== 'easy') {
    const trade = decideBankTrade(bundle, botUid);
    if (trade) return trade;
  }

  // 7. Nothing left to usefully do — unless ending the turn would cancel our own still-fresh
  // open trade offer out from under it (endTurn cancels any pending trade this bot proposed;
  // see rules.ts). Give other players at least MIN_OPEN_TRADE_WINDOW_MS to notice and respond
  // before the turn ends, instead of yanking the offer within one bot-driver beat of proposing
  // it. Returning null just means "nothing to do this beat" — the driver re-evaluates on the
  // next reactive trigger or fallback poll, so this naturally retries until the window passes.
  const ownTrade = trades.find((t) => t.proposerUid === botUid && t.status === 'pending');
  if (ownTrade && Date.now() - ownTrade.createdAt < MIN_OPEN_TRADE_WINDOW_MS) {
    return null;
  }

  return { type: 'endTurn', uid: botUid };
}

// ---------------------------------------------------------------------------
// Responding to trades on someone else's turn
// ---------------------------------------------------------------------------

/**
 * Called once per "beat" a bot has an eligible trade to react to (whether it's off-turn, or
 * on its own turn with a trade targeted at it or open — see decideBotActionInner) — the delay
 * before this actually gets invoked (so the bot doesn't respond instantly) is the caller's
 * responsibility (see BOT_TRADE_RESPONSE_DELAY_*_MS in web/src/state/store.ts), since this
 * function is stateless and has no notion of elapsed time.
 *
 * Every respondable trade — targeted at this bot, or open — always gets a definitive answer:
 * accept, or an explicit reject via respondTrade. For an open trade, rejecting adds this bot
 * to trade.rejectedUids (see rules.ts's respondTrade), which both drives the responder-status
 * UI (TradeOffers.tsx's per-player accept/reject dots) and lets the trade resolve/auto-dismiss
 * once every eligible responder has explicitly passed, instead of it just sitting there
 * indefinitely with bots silently never weighing in.
 */
function decideTradeResponse(bundle: GameStateBundle, botUid: string, difficulty: BotDifficulty): GameAction | null {
  const { hands, trades } = bundle;
  const hand = hands[botUid];
  const candidate = trades.find(
    (t) => t.status === 'pending' && t.proposerUid !== botUid && (t.targetUid === botUid || t.targetUid === null),
  );
  if (!candidate) return null;

  const canAffordTrade = canAffordLocal(hand.resources, candidate.receive);
  let accept = false;
  if (canAffordTrade) {
    const giveValue = RESOURCES.reduce((s, r) => s + (candidate.receive[r] ?? 0), 0);
    const getValue = RESOURCES.reduce((s, r) => s + (candidate.give[r] ?? 0), 0);

    if (difficulty === 'easy') {
      // Weaker judgment: also takes trades that are a little unfavorable.
      accept = getValue >= giveValue - 1;
    } else if (difficulty === 'hard') {
      // Pickier: strictly favorable trades are always fine; an even trade is only taken if
      // it doesn't cut into a resource the bot is already low on (protects scarce cards).
      if (getValue > giveValue) {
        accept = true;
      } else if (getValue === giveValue) {
        const givingScarce = RESOURCES.some(
          (r) => (candidate.receive[r] ?? 0) > 0 && hand.resources[r] - (candidate.receive[r] ?? 0) <= 1,
        );
        accept = !givingScarce;
      } else {
        accept = false;
      }
    } else {
      accept = getValue >= giveValue;
    }
  }

  return { type: 'respondTrade', uid: botUid, tradeId: candidate.id, accept };
}
