// Heuristic bot AI. Zero Firebase/React imports. Single 'normal' difficulty tier.
// decideBotAction is called in a loop by an external bot-driver until it
// returns null or an 'endTurn' action. It never throws to the caller — any
// internal error results in `null` so the driver can safely stop/skip a beat.

import type {
  EdgeId,
  GameAction,
  Resource,
  ResourceCount,
  VertexId,
} from './types';
import { BUILD_COSTS, MAX_CITIES, MAX_ROADS, MAX_SETTLEMENTS, RESOURCES, TERRAIN_RESOURCE } from './types';
import { pipCount } from './board';
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
    return decideSetupAction(bundle, botUid);
  }

  if (room.phase === 'robber') {
    if (room.turnOrder[room.currentPlayerIndex] !== botUid) return null;
    return decideRobberMove(bundle, botUid, null);
  }

  const isCurrent = room.turnOrder[room.currentPlayerIndex] === botUid;
  if (!isCurrent) {
    return decideTradeResponse(bundle, botUid);
  }

  if (room.phase === 'roll') {
    return { type: 'rollDice', uid: botUid };
  }

  if (room.phase === 'main') {
    return decideMainAction(bundle, botUid);
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

function vertexScore(bundle: GameStateBundle, vertexId: VertexId): number {
  const { room } = bundle;
  const board = room.board!;
  const v = board.vertices[vertexId];
  if (!v) return 0;
  let score = 0;
  const resourcesSeen = new Set<Resource>();
  for (const hexId of v.adjacentHexIds) {
    const hex = board.hexes.find((h) => h.id === hexId);
    if (!hex) continue;
    score += pipCount(hex.number);
    // Gold has no fixed resource (bot picks whatever's scarcest when it actually rolls —
    // see 'pickGoldResources'); the pip-count bump above already values it, just skip the
    // fixed-resource-diversity bonus since there isn't one to look up.
    if (hex.terrain !== 'desert' && hex.terrain !== 'gold') resourcesSeen.add(TERRAIN_RESOURCE[hex.terrain]);
  }
  score += resourcesSeen.size * 0.5;
  if (board.ports.some((p) => p.vertexIds.includes(vertexId))) score += 1;
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

function decideSetupAction(bundle: GameStateBundle, botUid: string): GameAction {
  const { room, players } = bundle;
  const player = players[botUid];

  if (player.settlementsBuilt === player.roadsBuilt) {
    const candidates = candidateSettlementVertices(bundle);
    if (candidates.length === 0) throw new Error('bot: no legal setup settlement spot');
    candidates.sort((a, b) => vertexScore(bundle, b) - vertexScore(bundle, a));
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
    const s = vertexScore(bundle, other);
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

function decideRobberMove(bundle: GameStateBundle, botUid: string, devCardId: string | null): GameAction {
  const { room, players } = bundle;
  const board = room.board!;
  const opponents = room.turnOrder.filter((u) => u !== botUid);

  // Uses each opponent's public resourceCount rather than their private hand — the bot
  // (like a human player) can only see how many cards someone holds, not what they are,
  // and the decision bundle for a bot's turn only ever loads the bot's own private hand.
  const opponentScore = (u: string) => players[u].visibleVictoryPoints * 3 + players[u].resourceCount;

  let leader: string | null = null;
  for (const u of opponents) {
    if (leader === null || opponentScore(u) > opponentScore(leader)) leader = u;
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
    const n = players[u].resourceCount;
    if (stealFromUid === null || n > players[stealFromUid].resourceCount) {
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

function bestConnectedSettlementVertex(bundle: GameStateBundle, botUid: string): VertexId | null {
  const { room } = bundle;
  const candidates = candidateSettlementVertices(bundle).filter((vId) => {
    const v = room.board!.vertices[vId];
    return v.adjacentEdgeIds.some((eId) => room.edges[eId] === botUid);
  });
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => vertexScore(bundle, b) - vertexScore(bundle, a));
  return candidates[0];
}

function bestExpansionRoad(bundle: GameStateBundle, botUid: string): EdgeId | null {
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
    const score = vertexScore(bundle, farVertex);
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

function decideBankTrade(bundle: GameStateBundle, botUid: string): GameAction | null {
  const { room, hands } = bundle;
  const hand = hands[botUid];
  for (const give of RESOURCES) {
    const rate = portRateLocal(bundle, botUid, give);
    if (hand.resources[give] < rate) continue;
    // Don't trade away the last copies of a resource we're not truly flush in.
    if (hand.resources[give] - rate < 0) continue;
    const need = pickNeededResource(hand.resources);
    if (need === give) continue;
    if (room.bank[need] <= 0) continue;
    return { type: 'bankTrade', uid: botUid, give, giveAmount: rate, receive: need };
  }
  return null;
}

function decideMainAction(bundle: GameStateBundle, botUid: string): GameAction {
  const { room, players, hands } = bundle;
  const player = players[botUid];
  const hand = hands[botUid];

  // 1. Upgrade to city.
  if (player.citiesBuilt < MAX_CITIES && canAffordLocal(hand.resources, BUILD_COSTS.city)) {
    const ownSettlements = Object.entries(room.vertices)
      .filter(([, b]) => b.uid === botUid && b.type === 'settlement')
      .map(([id]) => id);
    if (ownSettlements.length > 0) {
      ownSettlements.sort((a, b) => vertexScore(bundle, b) - vertexScore(bundle, a));
      return { type: 'buildCity', uid: botUid, vertexId: ownSettlements[0] };
    }
  }

  // 2. Build settlement on a strong, connected, open spot.
  if (player.settlementsBuilt < MAX_SETTLEMENTS && canAffordLocal(hand.resources, BUILD_COSTS.settlement)) {
    const spot = bestConnectedSettlementVertex(bundle, botUid);
    if (spot) return { type: 'buildSettlement', uid: botUid, vertexId: spot };
  }

  // 3. Build a road toward a decent spot.
  if (player.roadsBuilt < MAX_ROADS && canAffordLocal(hand.resources, BUILD_COSTS.road)) {
    const edge = bestExpansionRoad(bundle, botUid);
    if (edge) return { type: 'buildRoad', uid: botUid, edgeId: edge };
  }

  // 4. Buy a development card.
  if (room.devCardDeckCount > 0 && canAffordLocal(hand.resources, BUILD_COSTS.devCard)) {
    return { type: 'buyDevCard', uid: botUid };
  }

  // 5. Trade with the bank to work toward the next priority.
  const trade = decideBankTrade(bundle, botUid);
  if (trade) return trade;

  // 6. Nothing left to usefully do.
  return { type: 'endTurn', uid: botUid };
}

// ---------------------------------------------------------------------------
// Responding to trades on someone else's turn
// ---------------------------------------------------------------------------

function decideTradeResponse(bundle: GameStateBundle, botUid: string): GameAction | null {
  const { hands, trades } = bundle;
  const hand = hands[botUid];
  const candidate = trades.find(
    (t) => t.status === 'pending' && t.proposerUid !== botUid && (t.targetUid === botUid || t.targetUid === null),
  );
  if (!candidate) return null;
  if (!canAffordLocal(hand.resources, candidate.receive)) return null;
  const giveValue = RESOURCES.reduce((s, r) => s + (candidate.receive[r] ?? 0), 0);
  const getValue = RESOURCES.reduce((s, r) => s + (candidate.give[r] ?? 0), 0);
  if (getValue >= giveValue) {
    return { type: 'respondTrade', uid: botUid, tradeId: candidate.id, accept: true };
  }
  return null;
}
