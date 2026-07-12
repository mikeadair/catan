// Pure game-logic rules engine. Zero Firebase/React imports.
// applyAction is a pure function: it never mutates its input bundle.

import { nanoid } from 'nanoid';
import type {
  BotDifficulty,
  Building,
  DevCard,
  DevCardType,
  EdgeId,
  GameAction,
  MapPresetId,
  Port,
  PrivateHand,
  PublicPlayer,
  Resource,
  ResourceCount,
  RoomState,
  Terrain,
  TradeOffer,
  VertexId,
} from './types';
import {
  BUILD_COSTS,
  DEFAULT_DISCARD_LIMIT,
  DEFAULT_VICTORY_POINTS_TO_WIN,
  LARGEST_ARMY_MIN,
  LONGEST_ROAD_MIN,
  MAX_CITIES,
  MAX_ROADS,
  MAX_SETTLEMENTS,
  PLAYER_COLORS,
  RESOURCES,
  STARTING_BANK,
  TERRAIN_RESOURCE,
} from './types';
import { generateBoard } from './board';
import { createRng, shuffle } from './rng';

export interface GameStateBundle {
  room: RoomState;
  players: Record<string, PublicPlayer>;
  hands: Record<string, PrivateHand>;
  trades: TradeOffer[];
}

export interface CreateGameRoomBase {
  id: string;
  code: string;
  hostUid: string;
  mapPreset: MapPresetId;
  seed: string;
  /** House rules, fixed once the game starts. Defaults to the DEFAULT_* constants. */
  victoryPointsToWin?: number;
  discardLimit?: number;
}

export interface CreateGameSeatedPlayer {
  uid: string;
  displayName: string;
  isBot: boolean;
  botDifficulty?: BotDifficulty;
}

// ---------------------------------------------------------------------------
// Small generic helpers
// ---------------------------------------------------------------------------

function emptyResources(): ResourceCount {
  return { brick: 0, lumber: 0, ore: 0, grain: 0, wool: 0 };
}

function canAfford(have: ResourceCount, cost: Partial<ResourceCount>): boolean {
  for (const r of RESOURCES) {
    if ((have[r] ?? 0) < (cost[r] ?? 0)) return false;
  }
  return true;
}

function deduct(target: ResourceCount, cost: Partial<ResourceCount>): void {
  for (const r of RESOURCES) {
    target[r] -= cost[r] ?? 0;
  }
}

function credit(target: ResourceCount, gain: Partial<ResourceCount>): void {
  for (const r of RESOURCES) {
    target[r] += gain[r] ?? 0;
  }
}

function handSize(hand: PrivateHand): number {
  return RESOURCES.reduce((sum, r) => sum + hand.resources[r], 0);
}

function addLog(room: RoomState, message: string): void {
  room.log.push({ id: nanoid(), ts: Date.now(), message });
  if (room.log.length > 50) {
    room.log.splice(0, room.log.length - 50);
  }
}

function requirePlayer(players: Record<string, PublicPlayer>, uid: string): PublicPlayer {
  const p = players[uid];
  if (!p) throw new Error(`Unknown player: ${uid}`);
  return p;
}

function requireHand(hands: Record<string, PrivateHand>, uid: string): PrivateHand {
  const h = hands[uid];
  if (!h) throw new Error(`Unknown player: ${uid}`);
  return h;
}

function requireCurrentPlayer(room: RoomState, uid: string): void {
  if (room.turnOrder[room.currentPlayerIndex] !== uid) {
    throw new Error('It is not your turn');
  }
}

function requirePhase(room: RoomState, phases: RoomState['phase'][]): void {
  if (!phases.includes(room.phase)) {
    throw new Error(`Illegal action during phase '${room.phase}'`);
  }
}

// ---------------------------------------------------------------------------
// Board-derived helpers
// ---------------------------------------------------------------------------

function verticesAdjacentToHex(room: RoomState, hexId: string): VertexId[] {
  const board = room.board;
  if (!board) return [];
  return Object.values(board.vertices)
    .filter((v) => v.adjacentHexIds.includes(hexId))
    .map((v) => v.id);
}

function hexResource(terrain: Terrain): Resource | null {
  if (terrain === 'desert') return null;
  return TERRAIN_RESOURCE[terrain];
}

function playerSettlementVertices(room: RoomState, uid: string): VertexId[] {
  return Object.entries(room.vertices)
    .filter(([, b]) => b.uid === uid)
    .map(([id]) => id);
}

function playerPortRate(room: RoomState, uid: string, resource: Resource): number {
  const board = room.board;
  if (!board) return 4;
  const myVertices = new Set(playerSettlementVertices(room, uid));
  let best = 4;
  for (const port of board.ports as Port[]) {
    if (!port.vertexIds.some((v) => myVertices.has(v))) continue;
    if (port.type === 'generic') best = Math.min(best, 3);
    else if (port.type === resource) best = Math.min(best, 2);
  }
  return best;
}

// ---------------------------------------------------------------------------
// Longest road (longest trail, broken by opponent buildings) and largest army
// ---------------------------------------------------------------------------

export function longestRoadForPlayer(room: RoomState, uid: string): number {
  const board = room.board;
  if (!board) return 0;
  const ownedEdges = Object.entries(room.edges)
    .filter(([, owner]) => owner === uid)
    .map(([id]) => id);
  if (ownedEdges.length === 0) return 0;

  const adj: Record<VertexId, { edgeId: EdgeId; to: VertexId }[]> = {};
  for (const edgeId of ownedEdges) {
    const [a, b] = board.edges[edgeId].vertexIds;
    (adj[a] ??= []).push({ edgeId, to: b });
    (adj[b] ??= []).push({ edgeId, to: a });
  }

  function isBlocked(v: VertexId): boolean {
    const building: Building | undefined = room.vertices[v];
    return !!building && building.uid !== uid;
  }

  let best = 0;
  function dfs(v: VertexId, used: Set<EdgeId>, len: number, isStart: boolean): void {
    if (len > best) best = len;
    if (!isStart && isBlocked(v)) return;
    for (const { edgeId, to } of adj[v] || []) {
      if (used.has(edgeId)) continue;
      used.add(edgeId);
      dfs(to, used, len + 1, false);
      used.delete(edgeId);
    }
  }

  for (const v of Object.keys(adj)) {
    dfs(v, new Set(), 0, true);
  }
  return best;
}

export function recalcLongestRoad(room: RoomState, players: Record<string, PublicPlayer>): void {
  const lengths: Record<string, number> = {};
  for (const uid of Object.keys(players)) lengths[uid] = longestRoadForPlayer(room, uid);

  const current = room.longestRoadUid;
  let best = current;
  let bestLen = current ? lengths[current] : 0;

  for (const uid of Object.keys(players)) {
    if (lengths[uid] >= LONGEST_ROAD_MIN && lengths[uid] > bestLen) {
      best = uid;
      bestLen = lengths[uid];
    }
  }
  if (best && lengths[best] < LONGEST_ROAD_MIN) best = null;
  room.longestRoadUid = best;
}

export function recalcLargestArmy(room: RoomState, players: Record<string, PublicPlayer>): void {
  const current = room.largestArmyUid;
  let best = current;
  let bestCount = current ? players[current].knightsPlayed : 0;

  for (const p of Object.values(players)) {
    if (p.knightsPlayed >= LARGEST_ARMY_MIN && p.knightsPlayed > bestCount) {
      best = p.uid;
      bestCount = p.knightsPlayed;
    }
  }
  room.largestArmyUid = best;
}

// ---------------------------------------------------------------------------
// Victory points / win condition
// ---------------------------------------------------------------------------

function recomputeVisibleVP(room: RoomState, players: Record<string, PublicPlayer>): void {
  for (const p of Object.values(players)) {
    p.visibleVictoryPoints =
      p.settlementsBuilt * 1 +
      p.citiesBuilt * 2 +
      (room.longestRoadUid === p.uid ? 2 : 0) +
      (room.largestArmyUid === p.uid ? 2 : 0);
  }
}

function totalVictoryPoints(player: PublicPlayer, hand: PrivateHand): number {
  const hiddenVp = hand.devCards.filter((c) => c.type === 'victoryPoint').length;
  return player.visibleVictoryPoints + hiddenVp;
}

function checkWin(bundle: GameStateBundle): void {
  const { room, players, hands } = bundle;
  if (room.phase === 'gameOver') return;
  for (const uid of room.turnOrder) {
    const p = players[uid];
    const h = hands[uid];
    if (!p || !h) continue;
    if (totalVictoryPoints(p, h) >= room.victoryPointsToWin) {
      room.winnerUid = uid;
      room.phase = 'gameOver';
      room.status = 'finished';
      addLog(room, `${p.displayName} wins the game!`);
      return;
    }
  }
}

// ---------------------------------------------------------------------------
// Resource distribution on a dice roll
// ---------------------------------------------------------------------------

function distributeResources(bundle: GameStateBundle, roll: number): void {
  const { room, players, hands } = bundle;
  const board = room.board;
  if (!board) return;

  const claims: Partial<Record<Resource, Record<string, number>>> = {};

  for (const hex of board.hexes) {
    if (hex.number !== roll) continue;
    if (hex.id === board.robberHexId) continue;
    const resource = hexResource(hex.terrain);
    if (!resource) continue;

    for (const vId of verticesAdjacentToHex(room, hex.id)) {
      const building = room.vertices[vId];
      if (!building) continue;
      const amount = building.type === 'city' ? 2 : 1;
      const perUid = (claims[resource] ??= {});
      perUid[building.uid] = (perUid[building.uid] ?? 0) + amount;
    }
  }

  for (const resource of RESOURCES) {
    const perUid = claims[resource];
    if (!perUid) continue;
    const total = Object.values(perUid).reduce((a, b) => a + b, 0);
    if (total > room.bank[resource]) {
      // Bank can't cover every claimant for this resource: nobody gets it.
      continue;
    }
    for (const [uid, amt] of Object.entries(perUid)) {
      hands[uid].resources[resource] += amt;
      players[uid].resourceCount += amt;
    }
    room.bank[resource] -= total;
  }
}

// ---------------------------------------------------------------------------
// createGame
// ---------------------------------------------------------------------------

export function createGame(
  roomBase: CreateGameRoomBase,
  seatedPlayers: CreateGameSeatedPlayer[],
): GameStateBundle {
  if (seatedPlayers.length < 2) {
    throw new Error('Need at least 2 players to start a game');
  }

  const board = generateBoard(roomBase.mapPreset, roomBase.seed);

  const seatRng = createRng(`${roomBase.seed}:seats`);
  const turnOrder = shuffle(
    seatedPlayers.map((p) => p.uid),
    seatRng,
  );
  const colors = shuffle(PLAYER_COLORS.slice(), seatRng);

  const players: Record<string, PublicPlayer> = {};
  const hands: Record<string, PrivateHand> = {};
  const byUid = new Map(seatedPlayers.map((p) => [p.uid, p]));

  turnOrder.forEach((uid, seatIndex) => {
    const seated = byUid.get(uid)!;
    players[uid] = {
      uid,
      displayName: seated.displayName,
      color: colors[seatIndex],
      isBot: seated.isBot,
      ...(seated.botDifficulty ? { botDifficulty: seated.botDifficulty } : {}),
      seatIndex,
      resourceCount: 0,
      devCardCount: 0,
      visibleVictoryPoints: 0,
      knightsPlayed: 0,
      roadsBuilt: 0,
      settlementsBuilt: 0,
      citiesBuilt: 0,
      connected: true,
      lastSeen: Date.now(),
    };
    hands[uid] = { resources: emptyResources(), devCards: [] };
  });

  const devCardPool: DevCardType[] = [
    ...Array<DevCardType>(14).fill('knight'),
    ...Array<DevCardType>(5).fill('victoryPoint'),
    ...Array<DevCardType>(2).fill('roadBuilding'),
    ...Array<DevCardType>(2).fill('yearOfPlenty'),
    ...Array<DevCardType>(2).fill('monopoly'),
  ];
  const devCardDeck = shuffle(devCardPool, createRng(`${roomBase.seed}:devcards`));

  const room: RoomState = {
    id: roomBase.id,
    code: roomBase.code,
    hostUid: roomBase.hostUid,
    status: 'playing',
    mapPreset: roomBase.mapPreset,
    seed: roomBase.seed,
    board,
    vertices: {},
    edges: {},
    turnOrder,
    currentPlayerIndex: 0,
    phase: 'setup1',
    diceRoll: null,
    bank: { ...STARTING_BANK },
    devCardDeck,
    longestRoadUid: null,
    largestArmyUid: null,
    winnerUid: null,
    turnNumber: 0,
    turnStartedAt: Date.now(),
    setupRound: 1,
    pendingDiscardUids: [],
    botActionClaim: null,
    log: [],
    createdAt: Date.now(),
    victoryPointsToWin: roomBase.victoryPointsToWin ?? DEFAULT_VICTORY_POINTS_TO_WIN,
    discardLimit: roomBase.discardLimit ?? DEFAULT_DISCARD_LIMIT,
    devCardPlayedThisTurn: false,
    lastSetupSettlementVertexId: null,
  };

  addLog(room, 'Game started.');

  return { room, players, hands, trades: [] };
}

// ---------------------------------------------------------------------------
// Build legality
// ---------------------------------------------------------------------------

function settlementDistanceOk(room: RoomState, vertexId: VertexId): boolean {
  const board = room.board!;
  if (room.vertices[vertexId]) return false;
  const v = board.vertices[vertexId];
  if (!v) throw new Error(`Unknown vertex: ${vertexId}`);
  for (const nId of v.adjacentVertexIds) {
    if (room.vertices[nId]) return false;
  }
  return true;
}

function vertexTouchesOwnRoad(room: RoomState, vertexId: VertexId, uid: string): boolean {
  const board = room.board!;
  const v = board.vertices[vertexId];
  if (!v) throw new Error(`Unknown vertex: ${vertexId}`);
  return v.adjacentEdgeIds.some((eId) => room.edges[eId] === uid);
}

function edgeConnectsToOwnNetwork(room: RoomState, edgeId: EdgeId, uid: string): boolean {
  const board = room.board!;
  const e = board.edges[edgeId];
  if (!e) throw new Error(`Unknown edge: ${edgeId}`);
  for (const vId of e.vertexIds) {
    const building = room.vertices[vId];
    if (building && building.uid === uid) return true;
    const v = board.vertices[vId];
    if (v.adjacentEdgeIds.some((otherEdgeId) => otherEdgeId !== edgeId && room.edges[otherEdgeId] === uid)) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// applyAction
// ---------------------------------------------------------------------------

export function applyAction(bundle: GameStateBundle, action: GameAction): GameStateBundle {
  const next: GameStateBundle = structuredClone(bundle);
  const { room, players, hands, trades } = next;
  const board = room.board;

  switch (action.type) {
    case 'rollDice': {
      requireCurrentPlayer(room, action.uid);
      requirePhase(room, ['roll']);
      const d1 = 1 + Math.floor(Math.random() * 6);
      const d2 = 1 + Math.floor(Math.random() * 6);
      room.diceRoll = [d1, d2];
      const roll = d1 + d2;
      addLog(room, `${players[action.uid].displayName} rolled ${roll}.`);

      if (roll === 7) {
        const discardUids = room.turnOrder.filter((uid) => handSize(hands[uid]) > room.discardLimit);
        if (discardUids.length > 0) {
          room.pendingDiscardUids = discardUids;
          room.phase = 'discard';
        } else {
          room.phase = 'robber';
        }
      } else {
        distributeResources(next, roll);
        room.phase = 'main';
      }
      break;
    }

    case 'discard': {
      requirePhase(room, ['discard']);
      if (!room.pendingDiscardUids.includes(action.uid)) {
        throw new Error('You do not need to discard');
      }
      const hand = requireHand(hands, action.uid);
      const total = Object.values(action.resources).reduce((a, b) => a + (b ?? 0), 0);
      const required = Math.floor(handSize(hand) / 2);
      if (total !== required) {
        throw new Error(`Must discard exactly ${required} cards`);
      }
      if (!canAfford(hand.resources, action.resources)) {
        throw new Error('Cannot discard resources you do not have');
      }
      deduct(hand.resources, action.resources);
      credit(room.bank, action.resources);
      players[action.uid].resourceCount = handSize(hand);
      room.pendingDiscardUids = room.pendingDiscardUids.filter((u) => u !== action.uid);
      addLog(room, `${players[action.uid].displayName} discarded ${required} cards.`);
      if (room.pendingDiscardUids.length === 0) {
        room.phase = 'robber';
      }
      break;
    }

    case 'moveRobber':
    case 'playKnight': {
      const isKnight = action.type === 'playKnight';
      requireCurrentPlayer(room, action.uid);
      if (isKnight) {
        requirePhase(room, ['roll', 'main']);
        if (room.devCardPlayedThisTurn) throw new Error('Already played a development card this turn');
        const hand = requireHand(hands, action.uid);
        const idx = hand.devCards.findIndex((c) => c.id === action.devCardId && c.type === 'knight');
        if (idx === -1) throw new Error('You do not have that knight card');
        if (hand.devCards[idx].boughtTurn === room.turnNumber) {
          throw new Error('Cannot play a development card the same turn it was bought');
        }
        hand.devCards.splice(idx, 1);
        players[action.uid].devCardCount = hand.devCards.length;
        players[action.uid].knightsPlayed += 1;
        room.devCardPlayedThisTurn = true;
      } else {
        requirePhase(room, ['robber']);
      }
      if (!board) throw new Error('No board');
      if (!board.hexes.some((h) => h.id === action.robberHexId)) {
        throw new Error('Unknown hex');
      }
      if (action.robberHexId === board.robberHexId) {
        throw new Error('Robber must move to a different hex');
      }
      board.robberHexId = action.robberHexId;

      if (action.stealFromUid) {
        const victimUid = action.stealFromUid;
        if (victimUid === action.uid) throw new Error('Cannot steal from yourself');
        const targetVertices = verticesAdjacentToHex(room, action.robberHexId);
        const eligible = targetVertices.some((vId) => room.vertices[vId]?.uid === victimUid);
        if (!eligible) throw new Error('That player has no building on the robbed hex');
        const victimHand = requireHand(hands, victimUid);
        const pool: Resource[] = [];
        for (const r of RESOURCES) {
          for (let i = 0; i < victimHand.resources[r]; i++) pool.push(r);
        }
        if (pool.length > 0) {
          const stolen = pool[Math.floor(Math.random() * pool.length)];
          victimHand.resources[stolen] -= 1;
          hands[action.uid].resources[stolen] += 1;
          players[victimUid].resourceCount = handSize(victimHand);
          players[action.uid].resourceCount = handSize(hands[action.uid]);
          addLog(room, `${players[action.uid].displayName} stole a card from ${players[victimUid].displayName}.`);
        }
      }
      if (room.phase === 'robber') room.phase = 'main';
      if (isKnight) recalcLargestArmy(room, players);
      break;
    }

    case 'buildRoad': {
      requireCurrentPlayer(room, action.uid);
      const player = requirePlayer(players, action.uid);
      const board2 = board!;
      if (!board2.edges[action.edgeId]) throw new Error('Unknown edge');
      if (room.edges[action.edgeId]) throw new Error('Edge already has a road');
      if (player.roadsBuilt >= MAX_ROADS) throw new Error('No road pieces remaining');

      if (action.free) {
        requirePhase(room, ['setup1', 'setup2']);
        if (player.settlementsBuilt !== player.roadsBuilt + 1) {
          throw new Error('Must place a settlement before its free road');
        }
        const anchor = room.lastSetupSettlementVertexId;
        if (!anchor || !board2.edges[action.edgeId].vertexIds.includes(anchor)) {
          throw new Error('Free setup road must connect to the settlement just placed');
        }
        room.edges[action.edgeId] = action.uid;
        player.roadsBuilt += 1;
        room.lastSetupSettlementVertexId = null;
        advanceSetupTurn(room);
      } else {
        requirePhase(room, ['roll', 'main']);
        if (!canAfford(hands[action.uid].resources, BUILD_COSTS.road)) {
          throw new Error('Cannot afford a road');
        }
        if (!edgeConnectsToOwnNetwork(room, action.edgeId, action.uid)) {
          throw new Error('Road must connect to your existing roads or buildings');
        }
        deduct(hands[action.uid].resources, BUILD_COSTS.road);
        credit(room.bank, BUILD_COSTS.road);
        room.edges[action.edgeId] = action.uid;
        player.roadsBuilt += 1;
        player.resourceCount = handSize(hands[action.uid]);
        addLog(room, `${player.displayName} built a road.`);
      }
      recalcLongestRoad(room, players);
      recomputeVisibleVP(room, players);
      break;
    }

    case 'buildSettlement': {
      requireCurrentPlayer(room, action.uid);
      const player = requirePlayer(players, action.uid);
      const board2 = board!;
      if (!board2.vertices[action.vertexId]) throw new Error('Unknown vertex');
      if (!settlementDistanceOk(room, action.vertexId)) {
        throw new Error('Settlement violates the distance rule');
      }
      if (player.settlementsBuilt >= MAX_SETTLEMENTS) throw new Error('No settlement pieces remaining');

      if (action.free) {
        requirePhase(room, ['setup1', 'setup2']);
        if (player.settlementsBuilt !== player.roadsBuilt) {
          throw new Error('Already placed this turn\'s free settlement');
        }
        room.vertices[action.vertexId] = { type: 'settlement', uid: action.uid };
        player.settlementsBuilt += 1;
        room.lastSetupSettlementVertexId = action.vertexId;
        addLog(room, `${player.displayName} placed a settlement.`);

        if (room.phase === 'setup2') {
          for (const hexId of board2.vertices[action.vertexId].adjacentHexIds) {
            const hex = board2.hexes.find((h) => h.id === hexId);
            if (!hex) continue;
            const resource = hexResource(hex.terrain);
            if (!resource) continue;
            if (room.bank[resource] > 0) {
              room.bank[resource] -= 1;
              hands[action.uid].resources[resource] += 1;
            }
          }
          player.resourceCount = handSize(hands[action.uid]);
        }
      } else {
        requirePhase(room, ['roll', 'main']);
        if (!canAfford(hands[action.uid].resources, BUILD_COSTS.settlement)) {
          throw new Error('Cannot afford a settlement');
        }
        if (!vertexTouchesOwnRoad(room, action.vertexId, action.uid)) {
          throw new Error('Settlement must connect to your road network');
        }
        deduct(hands[action.uid].resources, BUILD_COSTS.settlement);
        credit(room.bank, BUILD_COSTS.settlement);
        room.vertices[action.vertexId] = { type: 'settlement', uid: action.uid };
        player.settlementsBuilt += 1;
        player.resourceCount = handSize(hands[action.uid]);
        addLog(room, `${player.displayName} built a settlement.`);
      }
      recalcLongestRoad(room, players);
      recomputeVisibleVP(room, players);
      break;
    }

    case 'buildCity': {
      requireCurrentPlayer(room, action.uid);
      requirePhase(room, ['roll', 'main']);
      const player = requirePlayer(players, action.uid);
      const building = room.vertices[action.vertexId];
      if (!building || building.uid !== action.uid || building.type !== 'settlement') {
        throw new Error('You must upgrade your own settlement');
      }
      if (player.citiesBuilt >= MAX_CITIES) throw new Error('No city pieces remaining');
      if (!canAfford(hands[action.uid].resources, BUILD_COSTS.city)) {
        throw new Error('Cannot afford a city');
      }
      deduct(hands[action.uid].resources, BUILD_COSTS.city);
      credit(room.bank, BUILD_COSTS.city);
      room.vertices[action.vertexId] = { type: 'city', uid: action.uid };
      player.settlementsBuilt -= 1;
      player.citiesBuilt += 1;
      player.resourceCount = handSize(hands[action.uid]);
      addLog(room, `${player.displayName} built a city.`);
      recomputeVisibleVP(room, players);
      break;
    }

    case 'buyDevCard': {
      requireCurrentPlayer(room, action.uid);
      requirePhase(room, ['roll', 'main']);
      if (room.devCardDeck.length === 0) throw new Error('The development card deck is empty');
      if (!canAfford(hands[action.uid].resources, BUILD_COSTS.devCard)) {
        throw new Error('Cannot afford a development card');
      }
      deduct(hands[action.uid].resources, BUILD_COSTS.devCard);
      credit(room.bank, BUILD_COSTS.devCard);
      const cardType = room.devCardDeck.pop()!;
      const card: DevCard = { id: nanoid(), type: cardType, boughtTurn: room.turnNumber };
      hands[action.uid].devCards.push(card);
      players[action.uid].devCardCount = hands[action.uid].devCards.length;
      players[action.uid].resourceCount = handSize(hands[action.uid]);
      addLog(room, `${players[action.uid].displayName} bought a development card.`);
      break;
    }

    case 'playRoadBuilding': {
      requireCurrentPlayer(room, action.uid);
      requirePhase(room, ['roll', 'main']);
      if (room.devCardPlayedThisTurn) throw new Error('Already played a development card this turn');
      const player = requirePlayer(players, action.uid);
      const hand = requireHand(hands, action.uid);
      const idx = hand.devCards.findIndex((c) => c.id === action.devCardId && c.type === 'roadBuilding');
      if (idx === -1) throw new Error('You do not have that road building card');
      if (hand.devCards[idx].boughtTurn === room.turnNumber) {
        throw new Error('Cannot play a development card the same turn it was bought');
      }
      const board2 = board!;
      const [e1, e2] = action.edgeIds;
      if (e1 === e2) throw new Error('Must choose two different edges');
      if (!board2.edges[e1] || !board2.edges[e2]) throw new Error('Unknown edge');
      if (room.edges[e1] || room.edges[e2]) throw new Error('Edge already has a road');
      if (player.roadsBuilt + 2 > MAX_ROADS) throw new Error('Not enough road pieces remaining');
      if (!edgeConnectsToOwnNetwork(room, e1, action.uid)) {
        throw new Error('First road must connect to your existing network');
      }
      room.edges[e1] = action.uid;
      player.roadsBuilt += 1;
      if (!edgeConnectsToOwnNetwork(room, e2, action.uid)) {
        // undo first placement before failing, keep applyAction atomic
        delete room.edges[e1];
        player.roadsBuilt -= 1;
        throw new Error('Second road must connect to your existing network');
      }
      room.edges[e2] = action.uid;
      player.roadsBuilt += 1;

      hand.devCards.splice(idx, 1);
      player.devCardCount = hand.devCards.length;
      room.devCardPlayedThisTurn = true;
      addLog(room, `${player.displayName} played Road Building.`);
      recalcLongestRoad(room, players);
      recomputeVisibleVP(room, players);
      break;
    }

    case 'playYearOfPlenty': {
      requireCurrentPlayer(room, action.uid);
      requirePhase(room, ['roll', 'main']);
      if (room.devCardPlayedThisTurn) throw new Error('Already played a development card this turn');
      const hand = requireHand(hands, action.uid);
      const idx = hand.devCards.findIndex((c) => c.id === action.devCardId && c.type === 'yearOfPlenty');
      if (idx === -1) throw new Error('You do not have that Year of Plenty card');
      if (hand.devCards[idx].boughtTurn === room.turnNumber) {
        throw new Error('Cannot play a development card the same turn it was bought');
      }
      const want: Partial<ResourceCount> = {};
      for (const r of action.resources) want[r] = (want[r] ?? 0) + 1;
      if (!canAfford(room.bank, want)) throw new Error('Bank does not have those resources');
      deduct(room.bank, want);
      credit(hands[action.uid].resources, want);
      hand.devCards.splice(idx, 1);
      players[action.uid].devCardCount = hand.devCards.length;
      players[action.uid].resourceCount = handSize(hand);
      room.devCardPlayedThisTurn = true;
      addLog(room, `${players[action.uid].displayName} played Year of Plenty.`);
      break;
    }

    case 'playMonopoly': {
      requireCurrentPlayer(room, action.uid);
      requirePhase(room, ['roll', 'main']);
      if (room.devCardPlayedThisTurn) throw new Error('Already played a development card this turn');
      const hand = requireHand(hands, action.uid);
      const idx = hand.devCards.findIndex((c) => c.id === action.devCardId && c.type === 'monopoly');
      if (idx === -1) throw new Error('You do not have that Monopoly card');
      if (hand.devCards[idx].boughtTurn === room.turnNumber) {
        throw new Error('Cannot play a development card the same turn it was bought');
      }
      let total = 0;
      for (const uid of room.turnOrder) {
        if (uid === action.uid) continue;
        const amt = hands[uid].resources[action.resource];
        if (amt > 0) {
          hands[uid].resources[action.resource] = 0;
          hands[action.uid].resources[action.resource] += amt;
          players[uid].resourceCount = handSize(hands[uid]);
          total += amt;
        }
      }
      players[action.uid].resourceCount = handSize(hand);
      hand.devCards.splice(idx, 1);
      players[action.uid].devCardCount = hand.devCards.length;
      room.devCardPlayedThisTurn = true;
      addLog(room, `${players[action.uid].displayName} played Monopoly on ${action.resource} and collected ${total}.`);
      break;
    }

    case 'bankTrade': {
      requireCurrentPlayer(room, action.uid);
      requirePhase(room, ['roll', 'main']);
      const hand = requireHand(hands, action.uid);
      const rate = playerPortRate(room, action.uid, action.give);
      if (action.giveAmount !== rate) {
        throw new Error(`Trade rate for ${action.give} is ${rate}:1`);
      }
      if (hand.resources[action.give] < action.giveAmount) {
        throw new Error('Not enough resources to make that trade');
      }
      if (room.bank[action.receive] < 1) {
        throw new Error('Bank is out of that resource');
      }
      hand.resources[action.give] -= action.giveAmount;
      room.bank[action.give] += action.giveAmount;
      hand.resources[action.receive] += 1;
      room.bank[action.receive] -= 1;
      players[action.uid].resourceCount = handSize(hand);
      addLog(room, `${players[action.uid].displayName} traded ${action.giveAmount} ${action.give} for 1 ${action.receive} with the bank.`);
      break;
    }

    case 'proposeTrade': {
      requireCurrentPlayer(room, action.uid);
      requirePhase(room, ['roll', 'main']);
      const hand = requireHand(hands, action.uid);
      if (!canAfford(hand.resources, action.give)) {
        throw new Error('You do not have the resources you are offering');
      }
      const offer: TradeOffer = {
        id: nanoid(),
        proposerUid: action.uid,
        targetUid: action.targetUid,
        give: action.give,
        receive: action.receive,
        status: 'pending',
        counterOf: null,
        createdAt: Date.now(),
      };
      trades.push(offer);
      addLog(room, `${players[action.uid].displayName} proposed a trade.`);
      break;
    }

    case 'respondTrade': {
      const trade = trades.find((t) => t.id === action.tradeId);
      if (!trade) throw new Error('Unknown trade');
      if (trade.status !== 'pending') throw new Error('Trade is no longer pending');
      if (trade.proposerUid === action.uid) throw new Error('Cannot respond to your own trade');
      if (trade.targetUid && trade.targetUid !== action.uid) {
        throw new Error('This trade is not directed at you');
      }
      if (!action.accept) {
        trade.status = 'rejected';
        break;
      }
      const proposerHand = requireHand(hands, trade.proposerUid);
      const responderHand = requireHand(hands, action.uid);
      if (!canAfford(proposerHand.resources, trade.give)) {
        throw new Error('Proposer can no longer afford this trade');
      }
      if (!canAfford(responderHand.resources, trade.receive)) {
        throw new Error('You cannot afford this trade');
      }
      deduct(proposerHand.resources, trade.give);
      credit(proposerHand.resources, trade.receive);
      deduct(responderHand.resources, trade.receive);
      credit(responderHand.resources, trade.give);
      players[trade.proposerUid].resourceCount = handSize(proposerHand);
      players[action.uid].resourceCount = handSize(responderHand);
      trade.status = 'accepted';
      addLog(room, `${players[action.uid].displayName} accepted a trade from ${players[trade.proposerUid].displayName}.`);
      break;
    }

    case 'cancelTrade': {
      const trade = trades.find((t) => t.id === action.tradeId);
      if (!trade) throw new Error('Unknown trade');
      if (trade.proposerUid !== action.uid) throw new Error('You can only cancel your own trade');
      if (trade.status !== 'pending') throw new Error('Trade is no longer pending');
      trade.status = 'cancelled';
      break;
    }

    case 'endTurn': {
      requireCurrentPlayer(room, action.uid);
      requirePhase(room, ['main']);
      for (const trade of trades) {
        if (trade.proposerUid === action.uid && trade.status === 'pending') {
          trade.status = 'cancelled';
        }
      }
      room.currentPlayerIndex = (room.currentPlayerIndex + 1) % room.turnOrder.length;
      room.turnNumber += 1;
      room.phase = 'roll';
      room.diceRoll = null;
      room.devCardPlayedThisTurn = false;
      room.turnStartedAt = Date.now();
      addLog(room, `${players[action.uid].displayName} ended their turn.`);
      break;
    }

    default: {
      const _exhaustive: never = action;
      throw new Error(`Unknown action type: ${JSON.stringify(_exhaustive)}`);
    }
  }

  checkWin(next);
  return next;
}

function advanceSetupTurn(room: RoomState): void {
  const n = room.turnOrder.length;
  if (room.phase === 'setup1') {
    if (room.currentPlayerIndex < n - 1) {
      room.currentPlayerIndex += 1;
    } else {
      room.phase = 'setup2';
      room.setupRound = 2;
    }
  } else if (room.phase === 'setup2') {
    if (room.currentPlayerIndex === 0) {
      room.phase = 'roll';
      room.setupRound = null;
      room.turnNumber = 1;
      room.turnStartedAt = Date.now();
      room.devCardPlayedThisTurn = false;
      addLog(room, 'Setup complete.');
    } else {
      room.currentPlayerIndex -= 1;
    }
  }
}

// ---------------------------------------------------------------------------
// legalActionTypes
// ---------------------------------------------------------------------------

export function legalActionTypes(bundle: GameStateBundle, uid: string): GameAction['type'][] {
  const { room, players, hands, trades } = bundle;
  const types: GameAction['type'][] = [];
  const hand = hands[uid];
  const player = players[uid];
  if (!hand || !player) return types;

  const isCurrent = room.turnOrder[room.currentPlayerIndex] === uid;

  if (room.phase === 'gameOver') return types;

  if (room.phase === 'discard') {
    if (room.pendingDiscardUids.includes(uid)) types.push('discard');
    return types;
  }

  if (room.phase === 'robber') {
    if (isCurrent) types.push('moveRobber');
    return types;
  }

  if (room.phase === 'setup1' || room.phase === 'setup2') {
    if (isCurrent) {
      if (player.settlementsBuilt === player.roadsBuilt) types.push('buildSettlement');
      else types.push('buildRoad');
    }
    return types;
  }

  if (!isCurrent) {
    const hasRespondable = trades.some(
      (t) => t.status === 'pending' && t.proposerUid !== uid && (t.targetUid === uid || t.targetUid === null),
    );
    if (hasRespondable) types.push('respondTrade');
    return types;
  }

  if (room.phase === 'roll') {
    types.push('rollDice');
    if (
      !room.devCardPlayedThisTurn &&
      hand.devCards.some((c) => c.type === 'knight' && c.boughtTurn !== room.turnNumber)
    ) {
      types.push('playKnight');
    }
    return types;
  }

  // phase === 'main'
  types.push('endTurn');
  if (player.roadsBuilt < MAX_ROADS && canAfford(hand.resources, BUILD_COSTS.road)) types.push('buildRoad');
  if (player.settlementsBuilt < MAX_SETTLEMENTS && canAfford(hand.resources, BUILD_COSTS.settlement)) {
    types.push('buildSettlement');
  }
  if (player.citiesBuilt < MAX_CITIES && canAfford(hand.resources, BUILD_COSTS.city)) types.push('buildCity');
  if (room.devCardDeck.length > 0 && canAfford(hand.resources, BUILD_COSTS.devCard)) types.push('buyDevCard');

  if (!room.devCardPlayedThisTurn) {
    const playable = (type: DevCardType) => hand.devCards.some((c) => c.type === type && c.boughtTurn !== room.turnNumber);
    if (playable('knight')) types.push('playKnight');
    if (playable('roadBuilding')) types.push('playRoadBuilding');
    if (playable('yearOfPlenty')) types.push('playYearOfPlenty');
    if (playable('monopoly')) types.push('playMonopoly');
  }

  types.push('bankTrade');
  types.push('proposeTrade');
  if (trades.some((t) => t.proposerUid === uid && t.status === 'pending')) types.push('cancelTrade');

  return types;
}
