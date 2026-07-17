// Heuristic bot AI. Zero Firebase/React imports.
// decideBotAction is called in a loop by an external bot-driver until it
// returns null or an 'endTurn' action. It never throws to the caller — any
// internal error results in `null` so the driver can safely stop/skip a beat.
//
// Three difficulty tiers (PublicPlayer.botDifficulty, default 'normal' when absent):
//  - 'easy': weaker placement/robber evaluation, no strategic trading (bank or
//    player), no Monopoly/Road Building, and occasionally skips a beneficial
//    build entirely.
//  - 'normal': the original heuristics — solid placement scoring, bank trading
//    toward whatever build it's closest to, no player-to-player trade proposals.
//  - 'hard': sharper placement scoring (weights 6/8 and ports higher), targets
//    the strongest opponent (with a bias toward humans over bots) with the
//    robber, and will additionally propose player trades to close a 2-resource
//    gap (normal only closes a 1-resource gap).
//
// All three tiers will voluntarily *play* development cards, not just buy them (see
// decideKnightPlay/decideRoadBuildingPlay/decideYearOfPlentyPlay/decideMonopolyPlay below) —
// Knight to contest Largest Army or clear the robber off a hex the bot owns, Year of Plenty to
// close a build gap for free, Road Building when it has two good roads queued up, and Monopoly
// (skipped by 'easy') for a large enough haul. Without this, dev cards were purely a "buy and
// hoard" line item: Largest Army/Monopoly effectively could only ever be won by a human who
// bothered to play their cards.

import type {
  BotDifficulty,
  DevCard,
  DevCardType,
  EdgeId,
  GameAction,
  Resource,
  ResourceCount,
  RoomState,
  VertexId,
} from './types';
import {
  BUILD_COSTS,
  LARGEST_ARMY_MIN,
  LONGEST_ROAD_MIN,
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

// How much one extra edge of longest-chain length is worth relative to vertexScore's roughly
// 0-8ish range — small enough that a genuinely strong settlement spot still wins, large enough
// to swing close calls once Longest Road is actually plausible (see roadNetworkChainLength).
const LONGEST_ROAD_CHAIN_WEIGHT = 0.4;

/** Longest simple path (by edge count) through this player's own road network, optionally
 * including one hypothetical extra edge — a plain DFS is fine here since it's bounded by a
 * single player's own road count (MAX_ROADS = 15), not the whole board. */
function roadNetworkChainLength(bundle: GameStateBundle, botUid: string, extraEdgeId?: EdgeId): number {
  const { room } = bundle;
  const board = room.board!;
  const edgeIds = Object.entries(room.edges)
    .filter(([, owner]) => owner === botUid)
    .map(([eId]) => eId);
  if (extraEdgeId) edgeIds.push(extraEdgeId);
  const edgeSet = new Set(edgeIds);

  const dfs = (vertexId: VertexId, visited: Set<EdgeId>): number => {
    let best = 0;
    for (const eId of edgeSet) {
      if (visited.has(eId)) continue;
      const edge = board.edges[eId];
      if (!edge.vertexIds.includes(vertexId)) continue;
      const nextVertex = edge.vertexIds.find((v) => v !== vertexId)!;
      visited.add(eId);
      const len = 1 + dfs(nextVertex, visited);
      visited.delete(eId);
      if (len > best) best = len;
    }
    return best;
  };

  let longest = 0;
  for (const eId of edgeSet) {
    for (const v of board.edges[eId].vertexIds) {
      longest = Math.max(longest, dfs(v, new Set()));
    }
  }
  return longest;
}

function bestExpansionRoad(bundle: GameStateBundle, botUid: string, difficulty: BotDifficulty): EdgeId | null {
  const { room, players } = bundle;
  const board = room.board!;
  const ownVertices = new Set<VertexId>();
  for (const [eId, owner] of Object.entries(room.edges)) {
    if (owner !== botUid) continue;
    for (const v of board.edges[eId].vertexIds) ownVertices.add(v);
  }
  for (const [vId, b] of Object.entries(room.vertices)) {
    if (b.uid === botUid) ownVertices.add(vId);
  }

  // Bots otherwise never factor road *length* into where they build — every candidate edge is
  // scored purely on its far vertex's settlement potential, so Longest Road sits uncontested
  // for whichever human bothers to chase it. Once a bot has built enough roads to plausibly be
  // in range, nudge candidate scoring toward whichever edge extends its longest chain further,
  // without abandoning settlement value entirely (see LONGEST_ROAD_CHAIN_WEIGHT).
  const player = players[botUid];
  const contestingLongestRoad = room.longestRoadUid !== botUid && player.roadsBuilt >= LONGEST_ROAD_MIN - 2;

  let best: EdgeId | null = null;
  let bestScore = -Infinity;
  for (const [eId, e] of Object.entries(board.edges)) {
    if (room.edges[eId]) continue;
    const touches = e.vertexIds.some((v) => ownVertices.has(v));
    if (!touches) continue;
    const farVertex = e.vertexIds.find((v) => !ownVertices.has(v)) ?? e.vertexIds[0];
    let score = vertexScore(bundle, farVertex, difficulty);
    if (contestingLongestRoad) {
      score += roadNetworkChainLength(bundle, botUid, eId) * LONGEST_ROAD_CHAIN_WEIGHT;
    }
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
    if (alreadyTriedThisTurn(bundle, botUid, give, receive)) continue;
    return { type: 'proposeTrade', uid: botUid, give, receive, targetUid: null };
  }
  return null;
}

/** Same give/receive shape, resource-for-resource (ignores id/timestamps) — used to recognize
 * "this is the exact trade we already tried," not just "some trade or other is pending." */
function sameTradeShape(a: Partial<ResourceCount>, b: Partial<ResourceCount>): boolean {
  return RESOURCES.every((r) => (a[r] ?? 0) === (b[r] ?? 0));
}

/** Whether this bot already proposed this exact give/receive shape earlier in the *current*
 * turn and it's since been resolved (rejected or cancelled) one way or another. Without this,
 * a rejected open trade whose underlying resource gap hasn't changed gets re-proposed verbatim
 * the moment decideMainAction next runs — and since the proposer's own bot driver now reacts
 * to trade updates promptly (see triggerBotCheck in store.ts) rather than waiting out the old
 * 15s fallback poll, that re-proposal could otherwise fire almost immediately, reading as the
 * bot spamming the same just-declined ask instead of moving on with its turn. */
function alreadyTriedThisTurn(
  bundle: GameStateBundle,
  botUid: string,
  give: Partial<ResourceCount>,
  receive: Partial<ResourceCount>,
): boolean {
  const { room, trades } = bundle;
  return trades.some(
    (t) =>
      t.proposerUid === botUid &&
      t.status !== 'pending' &&
      t.createdAt >= room.turnStartedAt &&
      sameTradeShape(t.give, give) &&
      sameTradeShape(t.receive, receive),
  );
}

// ---------------------------------------------------------------------------
// Voluntary development-card plays
// ---------------------------------------------------------------------------

/** A dev card of the given type the bot could legally play right now — i.e. not bought this
 * same turn (the "can't play a card the turn you bought it" rule rules.ts enforces server-
 * side for every play* action). Returns the whole card (its id is what the action needs). */
function findPlayableDevCard(bundle: GameStateBundle, botUid: string, type: DevCardType): DevCard | null {
  const hand = bundle.hands[botUid];
  return hand.devCards.find((c) => c.type === type && c.boughtTurn !== bundle.room.turnNumber) ?? null;
}

/** Plays a Knight when it's effectively free value: either it would grab/extend a Largest
 * Army lead the bot doesn't already hold, or the robber currently sits on a hex the bot itself
 * owns (worth relocating for future rolls even though it can't help the roll that already
 * happened this turn). Reuses decideRobberMove for the actual hex/victim choice — identical
 * heuristic to a forced post-7 move, just voluntarily triggered. */
function decideKnightPlay(bundle: GameStateBundle, botUid: string, difficulty: BotDifficulty): GameAction | null {
  const { room, players } = bundle;
  if (room.devCardPlayedThisTurn) return null;
  const card = findPlayableDevCard(bundle, botUid, 'knight');
  if (!card) return null;

  const player = players[botUid];
  const newKnightCount = player.knightsPlayed + 1;
  const contestsLargestArmy =
    newKnightCount >= LARGEST_ARMY_MIN &&
    room.largestArmyUid !== botUid &&
    (room.largestArmyUid === null || newKnightCount > players[room.largestArmyUid].knightsPlayed);

  const board = room.board!;
  const ownsRobberedHex = Object.values(board.vertices).some(
    (v) => room.vertices[v.id]?.uid === botUid && v.adjacentHexIds.includes(board.robberHexId),
  );

  if (!contestsLargestArmy && !ownsRobberedHex) return null;
  return decideRobberMove(bundle, botUid, card.id, difficulty);
}

/** Plays Road Building when the bot has two legal, worthwhile expansion edges queued up (the
 * second scored as if the first were already built, mirroring the real chained placement the
 * card allows) — skipped by 'easy' as one of its "no strategic trading"-adjacent plays, and
 * whenever fewer than two legal edges are actually available (a single free road isn't worth
 * spending the card on; decideMainAction's ordinary paid road-build step covers that case). */
function decideRoadBuildingPlay(bundle: GameStateBundle, botUid: string, difficulty: BotDifficulty): GameAction | null {
  if (difficulty === 'easy') return null;
  const { room, players } = bundle;
  if (room.devCardPlayedThisTurn) return null;
  const player = players[botUid];
  if (player.roadsBuilt + 2 > MAX_ROADS) return null;
  const card = findPlayableDevCard(bundle, botUid, 'roadBuilding');
  if (!card) return null;

  const board = room.board!;
  const ownVertices = new Set<VertexId>();
  for (const [eId, owner] of Object.entries(room.edges)) {
    if (owner !== botUid) continue;
    for (const v of board.edges[eId].vertexIds) ownVertices.add(v);
  }
  for (const [vId, b] of Object.entries(room.vertices)) {
    if (b.uid === botUid) ownVertices.add(vId);
  }

  const bestUnbuiltEdge = (exclude: EdgeId | null): EdgeId | null => {
    let best: EdgeId | null = null;
    let bestScore = -Infinity;
    for (const [eId, e] of Object.entries(board.edges)) {
      if (eId === exclude || room.edges[eId]) continue;
      if (!e.vertexIds.some((v) => ownVertices.has(v))) continue;
      const farVertex = e.vertexIds.find((v) => !ownVertices.has(v)) ?? e.vertexIds[0];
      const score = vertexScore(bundle, farVertex, difficulty);
      if (score > bestScore) {
        bestScore = score;
        best = eId;
      }
    }
    return best;
  };

  const edge1 = bestUnbuiltEdge(null);
  if (!edge1) return null;
  for (const v of board.edges[edge1].vertexIds) ownVertices.add(v);
  const edge2 = bestUnbuiltEdge(edge1);
  if (!edge2) return null;

  return { type: 'playRoadBuilding', uid: botUid, devCardId: card.id, edgeIds: [edge1, edge2] };
}

/** Plays Year of Plenty to close a build gap outright, for free, instead of waiting on a bank
 * or player trade for the same resources — checked in the same build-priority order as
 * pickBankTradeTarget/decidePlayerTrade. Only fires when the gap is small (<=2 cards total,
 * matching what the card actually grants) and the bank genuinely has the cards to give. */
function decideYearOfPlentyPlay(bundle: GameStateBundle, botUid: string): GameAction | null {
  const { room, hands } = bundle;
  if (room.devCardPlayedThisTurn) return null;
  const card = findPlayableDevCard(bundle, botUid, 'yearOfPlenty');
  if (!card) return null;
  const hand = hands[botUid].resources;

  for (const cost of buildPriorityCosts(bundle, botUid)) {
    const deficits = resourceDeficits(hand, cost);
    const totalDeficit = RESOURCES.reduce((s, r) => s + (deficits[r] ?? 0), 0);
    if (totalDeficit === 0 || totalDeficit > 2) continue;

    const resources: Resource[] = [];
    for (const r of RESOURCES) {
      for (let i = 0; i < (deficits[r] ?? 0); i++) resources.push(r);
    }
    // The card always grants exactly two resources — pad a one-card gap with whatever the bot
    // is shortest on overall, same fallback pickBankTradeTarget uses.
    if (resources.length < 2) resources.push(pickNeededResource(hand));

    const need: Partial<ResourceCount> = {};
    for (const r of resources) need[r] = (need[r] ?? 0) + 1;
    if (!canAffordLocal(room.bank, need)) continue;

    return { type: 'playYearOfPlenty', uid: botUid, devCardId: card.id, resources: [resources[0], resources[1]] };
  }
  return null;
}

// Minimum total cards a Monopoly must haul (via resource-conservation math, same as
// othersMayHave — STARTING_BANK[r] - room.bank[r] - ownHand[r] is *exactly* how much every
// other player combined holds of r) before it's worth revealing the aggression and spending
// the card on. 'hard' is pickier about targets elsewhere but more willing to pull this
// trigger; 'easy' never plays Monopoly at all (see decideMonopolyPlay).
const MONOPOLY_MIN_HAUL_HARD = 2;
const MONOPOLY_MIN_HAUL_NORMAL = 3;

/** Plays Monopoly on whichever resource would haul in the most cards from other players,
 * computed purely from public information (see the resource-conservation comment on
 * othersMayHave) — no need to see anyone's private hand to know this is an exact count, not an
 * estimate. Skipped by 'easy' (this is the single most aggressive/political card in the deck,
 * consistent with 'easy' doing no strategic trading either). */
function decideMonopolyPlay(bundle: GameStateBundle, botUid: string, difficulty: BotDifficulty): GameAction | null {
  if (difficulty === 'easy') return null;
  const { room, hands } = bundle;
  if (room.devCardPlayedThisTurn) return null;
  const card = findPlayableDevCard(bundle, botUid, 'monopoly');
  if (!card) return null;
  const hand = hands[botUid].resources;

  let best: Resource | null = null;
  let bestHaul = 0;
  for (const r of RESOURCES) {
    const haul = STARTING_BANK[r] - room.bank[r] - hand[r];
    if (haul > bestHaul) {
      bestHaul = haul;
      best = r;
    }
  }
  const threshold = difficulty === 'hard' ? MONOPOLY_MIN_HAUL_HARD : MONOPOLY_MIN_HAUL_NORMAL;
  if (!best || bestHaul < threshold) return null;
  return { type: 'playMonopoly', uid: botUid, devCardId: card.id, resource: best };
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

  // 1. Play a Knight when it's free value (Largest Army, or clearing the robber off our own
  // hex) — costs nothing, so it's worth doing before any build decision.
  const knightPlay = decideKnightPlay(bundle, botUid, difficulty);
  if (knightPlay) return knightPlay;

  // 2. Upgrade to city.
  if (player.citiesBuilt < MAX_CITIES && canAffordLocal(hand.resources, BUILD_COSTS.city)) {
    const ownSettlements = Object.entries(room.vertices)
      .filter(([, b]) => b.uid === botUid && b.type === 'settlement')
      .map(([id]) => id);
    if (ownSettlements.length > 0) {
      ownSettlements.sort((a, b) => vertexScore(bundle, b, difficulty) - vertexScore(bundle, a, difficulty));
      return { type: 'buildCity', uid: botUid, vertexId: ownSettlements[0] };
    }
  }

  // 3. Build settlement on a strong, connected, open spot.
  if (player.settlementsBuilt < MAX_SETTLEMENTS && canAffordLocal(hand.resources, BUILD_COSTS.settlement)) {
    const spot = bestConnectedSettlementVertex(bundle, botUid, difficulty);
    if (spot) return { type: 'buildSettlement', uid: botUid, vertexId: spot };
  }

  // 4. Play Road Building if two good roads are queued up (free; 'easy' never does this).
  const roadBuildingPlay = decideRoadBuildingPlay(bundle, botUid, difficulty);
  if (roadBuildingPlay) return roadBuildingPlay;

  // 5. Build a road toward a decent spot.
  if (player.roadsBuilt < MAX_ROADS && canAffordLocal(hand.resources, BUILD_COSTS.road)) {
    const edge = bestExpansionRoad(bundle, botUid, difficulty);
    if (edge) return { type: 'buildRoad', uid: botUid, edgeId: edge };
  }

  // 6. Buy a development card.
  if (room.devCardDeckCount > 0 && canAffordLocal(hand.resources, BUILD_COSTS.devCard)) {
    return { type: 'buyDevCard', uid: botUid };
  }

  // 7. Play Year of Plenty to close a build gap for free, before paying a trade tax for the
  // same resources.
  const yearOfPlentyPlay = decideYearOfPlentyPlay(bundle, botUid);
  if (yearOfPlentyPlay) return yearOfPlentyPlay;

  // 8. Play Monopoly for a large enough haul ('easy' never does this).
  const monopolyPlay = decideMonopolyPlay(bundle, botUid, difficulty);
  if (monopolyPlay) return monopolyPlay;

  // 9. Propose a player trade to close a resource gap ('easy' never does this).
  const playerTrade = decidePlayerTrade(bundle, botUid, difficulty);
  if (playerTrade) return playerTrade;

  // 10. Trade with the bank to work toward the next priority ('easy' never does this).
  if (difficulty !== 'easy') {
    const trade = decideBankTrade(bundle, botUid);
    if (trade) return trade;
  }

  // 11. Resolve our own still-pending trade offer, if there is one, before falling through to
  // the plain endTurn below (endTurn cancels any pending trade this bot proposed — see
  // rules.ts — so an offer that's actually resolved here never just gets silently swept away).
  const ownTrade = trades.find((t) => t.proposerUid === botUid && t.status === 'pending');
  if (ownTrade) {
    // An open trade's give/receive amounts are fixed regardless of who it's finalized with —
    // the resource outcome for this bot is identical either way — so there's no decision to
    // weigh here beyond "someone's interested, take it," which can happen the moment interest
    // shows up rather than waiting out the rest of the window below.
    const interested = ownTrade.interestedUids ?? [];
    if (interested.length > 0) {
      return { type: 'finalizeTrade', uid: botUid, tradeId: ownTrade.id, withUid: interested[0] };
    }

    // No one's interested — if every other player in the room has already explicitly
    // rejected, there's nothing left to wait for; cancel now instead of sitting on a dead
    // offer for the rest of MIN_OPEN_TRADE_WINDOW_MS.
    const rejectedUids = new Set(ownTrade.rejectedUids ?? []);
    const stillEligible = Object.keys(players).some((uid) => uid !== botUid && !rejectedUids.has(uid));
    if (!stillEligible) {
      return { type: 'cancelTrade', uid: botUid, tradeId: ownTrade.id };
    }

    // Still some responders who haven't weighed in yet — give them at least
    // MIN_OPEN_TRADE_WINDOW_MS to notice and respond before the turn ends, instead of yanking
    // the offer within one bot-driver beat of proposing it. Returning null just means "nothing
    // to do this beat" — the driver re-evaluates on the next reactive trigger or fallback
    // poll, so this naturally retries until the window passes or everyone's responded.
    if (Date.now() - ownTrade.createdAt < MIN_OPEN_TRADE_WINDOW_MS) {
      return null;
    }
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
    // Weight by whether a resource actually advances (or drains) the bot's own next build,
    // not just raw card count — a trade that's "fair" by count alone can still be bad if what
    // the bot gives up is the one type it's short on, and worth taking even at a slight count
    // deficit if what it receives directly closes that gap. Reuses the same highest-priority
    // build gap decidePlayerTrade/pickBankTradeTarget already reason about, so a responding
    // bot and a proposing bot judge "do I need this" the same way.
    const nextCost = buildPriorityCosts(bundle, botUid)[0];
    const deficits = nextCost ? resourceDeficits(hand.resources, nextCost) : {};
    const weight = (r: Resource) => ((deficits[r] ?? 0) > 0 ? 2 : 1);
    const giveValue = RESOURCES.reduce((s, r) => s + (candidate.receive[r] ?? 0) * weight(r), 0);
    const getValue = RESOURCES.reduce((s, r) => s + (candidate.give[r] ?? 0) * weight(r), 0);

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
