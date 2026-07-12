import { nanoid, customAlphabet } from 'nanoid';
import {
  collection,
  doc,
  getDoc,
  getDocs,
  limit,
  onSnapshot,
  orderBy,
  query,
  runTransaction,
  setDoc,
  updateDoc,
  where,
  writeBatch,
  type DocumentReference,
  type Transaction,
} from 'firebase/firestore';
import { auth, db } from './config';
import { createGame, applyAction, type GameStateBundle } from '../game/rules';
import { decideBotAction } from '../game/bots';
import {
  PLAYER_COLORS,
  STARTING_BANK,
  DEFAULT_VICTORY_POINTS_TO_WIN,
  DEFAULT_DISCARD_LIMIT,
  type RoomState,
  type PublicPlayer,
  type PrivateHand,
  type TradeOffer,
  type GameAction,
  type MapPresetId,
  type BotDifficulty,
  type PlayerColor,
} from '../game/types';

// --- Firestore layout ---
// rooms/{roomId}                                -> Omit<RoomState, 'id'>
// rooms/{roomId}/players/{uid}                   -> PublicPlayer
// rooms/{roomId}/players/{uid}/private/hand      -> PrivateHand  (doc id literally "hand")
// rooms/{roomId}/trades/{tradeId}                -> TradeOffer
// rooms/{roomId}/chat/{msgId}                    -> ChatMessage

export interface ChatMessage {
  id: string;
  uid: string;
  displayName: string;
  text: string;
  ts: number;
}

const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous 0/O/1/I
const generateRoomCode = customAlphabet(ROOM_CODE_ALPHABET, 5);
const BOT_CLAIM_STALE_MS = 5000;

function roomRef(roomId: string): DocumentReference {
  return doc(db, 'rooms', roomId);
}
function playerRef(roomId: string, uid: string): DocumentReference {
  return doc(db, 'rooms', roomId, 'players', uid);
}
function handRef(roomId: string, uid: string): DocumentReference {
  return doc(db, 'rooms', roomId, 'players', uid, 'private', 'hand');
}
function tradeRef(roomId: string, tradeId: string): DocumentReference {
  return doc(db, 'rooms', roomId, 'trades', tradeId);
}

function newPublicPlayer(params: {
  uid: string;
  displayName: string;
  color: PlayerColor;
  isBot: boolean;
  botDifficulty?: BotDifficulty;
  seatIndex: number;
}): PublicPlayer {
  return {
    uid: params.uid,
    displayName: params.displayName,
    color: params.color,
    isBot: params.isBot,
    ...(params.botDifficulty ? { botDifficulty: params.botDifficulty } : {}),
    seatIndex: params.seatIndex,
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
}

/**
 * Picks the lowest unused seatIndex and the first unused PlayerColor among the
 * currently-seated players, reading each player doc directly by uid (bounded by
 * `turnOrder`, so no Firestore wildcard/collection read is needed inside the transaction).
 */
async function assignSeat(
  tx: Transaction,
  roomId: string,
  turnOrder: string[]
): Promise<{ seatIndex: number; color: PlayerColor }> {
  const usedSeatIndices = new Set<number>();
  const usedColors = new Set<PlayerColor>();
  for (const uid of turnOrder) {
    const snap = await tx.get(playerRef(roomId, uid));
    if (snap.exists()) {
      const p = snap.data() as PublicPlayer;
      usedSeatIndices.add(p.seatIndex);
      usedColors.add(p.color);
    }
  }
  let seatIndex = 0;
  while (usedSeatIndices.has(seatIndex)) seatIndex++;
  const color = PLAYER_COLORS.find((c) => !usedColors.has(c));
  if (color === undefined) {
    throw new Error('Room is full');
  }
  return { seatIndex, color };
}

export async function createRoom(
  hostUid: string,
  hostName: string,
  mapPreset: MapPresetId,
  settings?: { victoryPointsToWin?: number; discardLimit?: number }
): Promise<{ roomId: string; code: string }> {
  const newRoomRef = doc(collection(db, 'rooms'));
  const roomId = newRoomRef.id;

  // Best-effort code uniqueness check; codes are short so collisions are rare but possible.
  // Scoped to status=='lobby' so this list query stays provable-safe under the security
  // rules' room-read rule (a list query is rejected in full if any doc it could match
  // would fail the rule — restricting to lobby rooms means every possible match is
  // readable by any signed-in caller regardless of membership). Reusing a finished/playing
  // room's code is fine; it's no longer joinable by code anyway.
  let code = generateRoomCode();
  for (let attempt = 0; attempt < 5; attempt++) {
    const existing = await getDocs(
      query(collection(db, 'rooms'), where('code', '==', code), where('status', '==', 'lobby'), limit(1))
    );
    if (existing.empty) break;
    code = generateRoomCode();
  }

  const now = Date.now();
  const room: Omit<RoomState, 'id'> = {
    code,
    hostUid,
    status: 'lobby',
    mapPreset,
    seed: nanoid(16),
    board: null,
    vertices: {},
    edges: {},
    turnOrder: [hostUid],
    currentPlayerIndex: 0,
    phase: 'lobby',
    diceRoll: null,
    bank: { ...STARTING_BANK },
    devCardDeck: [],
    longestRoadUid: null,
    largestArmyUid: null,
    winnerUid: null,
    turnNumber: 0,
    turnStartedAt: now,
    setupRound: null,
    pendingDiscardUids: [],
    botActionClaim: null,
    log: [],
    createdAt: now,
    victoryPointsToWin: settings?.victoryPointsToWin ?? DEFAULT_VICTORY_POINTS_TO_WIN,
    discardLimit: settings?.discardLimit ?? DEFAULT_DISCARD_LIMIT,
    devCardPlayedThisTurn: false,
    lastSetupSettlementVertexId: null,
  };

  const hostPlayer = newPublicPlayer({
    uid: hostUid,
    displayName: hostName,
    color: PLAYER_COLORS[0],
    isBot: false,
    seatIndex: 0,
  });

  const batch = writeBatch(db);
  batch.set(newRoomRef, room);
  batch.set(playerRef(roomId, hostUid), hostPlayer);
  await batch.commit();

  return { roomId, code };
}

export async function joinRoom(code: string, uid: string, displayName: string): Promise<string> {
  const normalizedCode = code.trim().toUpperCase();
  // Filtered to status=='lobby' for the same list-query-safety reason as createRoom's
  // uniqueness check above — every possible match must be readable by a non-member.
  const matches = await getDocs(
    query(
      collection(db, 'rooms'),
      where('code', '==', normalizedCode),
      where('status', '==', 'lobby'),
      limit(1)
    )
  );
  if (matches.empty) {
    throw new Error('Room not found or already started');
  }
  const roomId = matches.docs[0].id;

  return runTransaction(db, async (tx) => {
    const ref = roomRef(roomId);
    const snap = await tx.get(ref);
    if (!snap.exists()) {
      throw new Error('Room not found');
    }
    const room = snap.data() as Omit<RoomState, 'id'>;
    if (room.status !== 'lobby') {
      throw new Error('Room already started');
    }
    if (room.turnOrder.includes(uid)) {
      return roomId; // already joined; idempotent
    }
    if (room.turnOrder.length >= PLAYER_COLORS.length) {
      throw new Error('Room is full');
    }

    const { seatIndex, color } = await assignSeat(tx, roomId, room.turnOrder);
    const player = newPublicPlayer({ uid, displayName, color, isBot: false, seatIndex });

    tx.set(playerRef(roomId, uid), player);
    tx.update(ref, { turnOrder: [...room.turnOrder, uid] });

    return roomId;
  });
}

export async function addBot(roomId: string, difficulty: BotDifficulty): Promise<void> {
  await runTransaction(db, async (tx) => {
    const ref = roomRef(roomId);
    const snap = await tx.get(ref);
    if (!snap.exists()) {
      throw new Error('Room not found');
    }
    const room = snap.data() as Omit<RoomState, 'id'>;
    if (room.status !== 'lobby') {
      throw new Error('Room already started');
    }
    const currentUid = auth.currentUser?.uid ?? null;
    if (currentUid !== room.hostUid) {
      throw new Error('Only the host can add bots');
    }
    if (room.turnOrder.length >= PLAYER_COLORS.length) {
      throw new Error('Room is full');
    }

    const { seatIndex, color } = await assignSeat(tx, roomId, room.turnOrder);
    const botUid = `bot_${nanoid(10)}`;
    const player = newPublicPlayer({
      uid: botUid,
      displayName: `Bot ${seatIndex + 1}`,
      color,
      isBot: true,
      botDifficulty: difficulty,
      seatIndex,
    });

    tx.set(playerRef(roomId, botUid), player);
    tx.update(ref, { turnOrder: [...room.turnOrder, botUid] });
  });
}

export async function removeSeat(roomId: string, uid: string): Promise<void> {
  await runTransaction(db, async (tx) => {
    const ref = roomRef(roomId);
    const pRef = playerRef(roomId, uid);
    const [roomSnap, playerSnap] = await Promise.all([tx.get(ref), tx.get(pRef)]);
    if (!roomSnap.exists()) {
      throw new Error('Room not found');
    }
    const room = roomSnap.data() as Omit<RoomState, 'id'>;
    const player = playerSnap.exists() ? (playerSnap.data() as PublicPlayer) : null;

    const currentUid = auth.currentUser?.uid ?? null;
    const isSelf = currentUid === uid;
    const isHostKickingBot = currentUid === room.hostUid && !!player?.isBot;
    if (!isSelf && !isHostKickingBot) {
      throw new Error('Not allowed to remove this seat');
    }

    tx.update(ref, { turnOrder: room.turnOrder.filter((u) => u !== uid) });
    tx.delete(pRef);
    tx.delete(handRef(roomId, uid));
  });
}

export async function startGame(roomId: string): Promise<void> {
  const ref = roomRef(roomId);
  const roomSnap = await getDoc(ref);
  if (!roomSnap.exists()) {
    throw new Error('Room not found');
  }
  const room = roomSnap.data() as Omit<RoomState, 'id'>;

  const currentUid = auth.currentUser?.uid ?? null;
  if (currentUid !== room.hostUid) {
    throw new Error('Only the host can start the game');
  }
  if (room.status !== 'lobby') {
    throw new Error('Game already started');
  }

  const playersSnap = await getDocs(collection(db, 'rooms', roomId, 'players'));
  const playersByUid = new Map<string, PublicPlayer>();
  playersSnap.forEach((d) => playersByUid.set(d.id, d.data() as PublicPlayer));

  const seatedPlayers = room.turnOrder.map((uid) => {
    const p = playersByUid.get(uid);
    if (!p) {
      throw new Error(`Missing player doc for seated uid ${uid}`);
    }
    return {
      uid: p.uid,
      displayName: p.displayName,
      isBot: p.isBot,
      ...(p.botDifficulty ? { botDifficulty: p.botDifficulty } : {}),
    };
  });

  const bundle = createGame(
    {
      id: roomId,
      code: room.code,
      hostUid: room.hostUid,
      mapPreset: room.mapPreset,
      seed: room.seed,
      // Host-configured house rules, set at createRoom time — createGame defaults these
      // internally if omitted, but we always have them here since every room carries them
      // from creation onward.
      victoryPointsToWin: room.victoryPointsToWin,
      discardLimit: room.discardLimit,
    },
    seatedPlayers
  );

  const { id: _bundleRoomId, ...bundleRoomWithoutId } = bundle.room;
  void _bundleRoomId;
  // Defensive belt-and-suspenders: re-assert the configured house rules even though
  // createGame already threads them through, in case a future createGame revision ever
  // stops doing so.
  const roomToWrite: Omit<RoomState, 'id'> = {
    ...bundleRoomWithoutId,
    status: 'playing',
    victoryPointsToWin: room.victoryPointsToWin,
    discardLimit: room.discardLimit,
  };

  const batch = writeBatch(db);
  batch.set(ref, roomToWrite);
  for (const uid of Object.keys(bundle.players)) {
    batch.set(playerRef(roomId, uid), bundle.players[uid]);
  }
  for (const uid of Object.keys(bundle.hands)) {
    batch.set(handRef(roomId, uid), bundle.hands[uid]);
  }
  await batch.commit();
}

function neededHandUidsFor(action: GameAction, turnOrder: string[]): Set<string> {
  const uids = new Set<string>([action.uid]);
  if ((action.type === 'playKnight' || action.type === 'moveRobber') && action.stealFromUid) {
    uids.add(action.stealFromUid);
  }
  if (action.type === 'playMonopoly') {
    turnOrder.forEach((u) => uids.add(u));
  }
  return uids;
}

async function loadRoomForTx(tx: Transaction, roomId: string): Promise<RoomState> {
  const snap = await tx.get(roomRef(roomId));
  if (!snap.exists()) {
    throw new Error('Room not found');
  }
  return { id: roomId, ...(snap.data() as Omit<RoomState, 'id'>) };
}

/**
 * Reads whatever public players / hands / trades this specific action needs, applies it
 * via game/rules.ts's pure `applyAction`, and writes back only the docs that changed.
 *
 * Trade-off: this SDK version's `Transaction.get` only accepts a `DocumentReference`
 * (verified against the installed @firebase/firestore v12.16.0 typings — no `Query`
 * overload), so a fully transactional `where('status','==','pending')` read isn't
 * available. Callers instead take a non-transactional snapshot of pending trades
 * (`pendingTrades`) before starting the transaction; the *specific* trade this action
 * touches (respondTrade/cancelTrade's tradeId) is still read+written transactionally by
 * id here, so accept/reject/cancel races on a single trade are still safe. Unrelated
 * pending trades included in the returned bundle purely for context may be up to a poll
 * interval stale.
 */
async function applyActionInTransaction(
  tx: Transaction,
  roomId: string,
  room: RoomState,
  action: GameAction,
  pendingTrades: TradeOffer[],
  roomPatch: Partial<RoomState> = {}
): Promise<void> {
  // Public players: read directly by uid off room.turnOrder (bounded, no wildcard read needed).
  const playerUids = room.turnOrder;
  const playerSnaps = await Promise.all(playerUids.map((uid) => tx.get(playerRef(roomId, uid))));
  const players: Record<string, PublicPlayer> = {};
  playerUids.forEach((uid, i) => {
    const snap = playerSnaps[i];
    if (snap.exists()) players[uid] = snap.data() as PublicPlayer;
  });

  // Trades: merge the non-transactional pending snapshot with a transactional read of the
  // specific trade this action references (if any), so accept/cancel are race-safe.
  const tradesById = new Map(pendingTrades.map((t) => [t.id, t]));
  if (action.type === 'respondTrade' || action.type === 'cancelTrade') {
    const specificSnap = await tx.get(tradeRef(roomId, action.tradeId));
    if (specificSnap.exists()) {
      tradesById.set(action.tradeId, specificSnap.data() as TradeOffer);
    } else {
      tradesById.delete(action.tradeId);
    }
  }
  const trades = [...tradesById.values()];

  // Hands: only what this action needs (acting player, steal/monopoly targets, and — for
  // respondTrade — the trade proposer, since accept swaps resources between both sides).
  const neededHandUids = neededHandUidsFor(action, room.turnOrder);
  if (action.type === 'respondTrade') {
    const trade = tradesById.get(action.tradeId);
    if (trade) neededHandUids.add(trade.proposerUid);
  }
  const neededHandUidList = [...neededHandUids];
  const handSnaps = await Promise.all(neededHandUidList.map((uid) => tx.get(handRef(roomId, uid))));
  const hands: Record<string, PrivateHand> = {};
  neededHandUidList.forEach((uid, i) => {
    const snap = handSnaps[i];
    if (snap.exists()) hands[uid] = snap.data() as PrivateHand;
  });

  const bundle: GameStateBundle = { room, players, hands, trades };
  const rawNextBundle = applyAction(bundle, action); // throws Error(message) on illegal action
  const nextBundle: GameStateBundle = {
    ...rawNextBundle,
    room: { ...rawNextBundle.room, ...roomPatch },
  };

  // Write back only what changed.
  if (JSON.stringify(room) !== JSON.stringify(nextBundle.room)) {
    const { id: _nextRoomId, ...nextRoomData } = nextBundle.room;
    void _nextRoomId;
    tx.set(roomRef(roomId), nextRoomData);
  }

  for (const uid of Object.keys(nextBundle.players)) {
    if (JSON.stringify(players[uid]) !== JSON.stringify(nextBundle.players[uid])) {
      tx.set(playerRef(roomId, uid), nextBundle.players[uid]);
    }
  }

  for (const uid of neededHandUidList) {
    const next = nextBundle.hands[uid];
    if (next && JSON.stringify(hands[uid]) !== JSON.stringify(next)) {
      tx.set(handRef(roomId, uid), next);
    }
  }

  for (const trade of nextBundle.trades) {
    const prev = tradesById.get(trade.id);
    if (!prev || JSON.stringify(prev) !== JSON.stringify(trade)) {
      tx.set(tradeRef(roomId, trade.id), trade);
    }
  }
}

export async function dispatchAction(roomId: string, action: GameAction): Promise<void> {
  const pendingTradesSnap = await getDocs(
    query(collection(db, 'rooms', roomId, 'trades'), where('status', '==', 'pending'), limit(20))
  );
  const pendingTrades = pendingTradesSnap.docs.map((d) => d.data() as TradeOffer);

  await runTransaction(db, async (tx) => {
    const room = await loadRoomForTx(tx, roomId);
    if (room.status !== 'playing') {
      throw new Error('Game is not in progress');
    }
    await applyActionInTransaction(tx, roomId, room, action, pendingTrades);
  });
}

export async function claimAndRunBotAction(roomId: string): Promise<boolean> {
  const pendingTradesSnap = await getDocs(
    query(collection(db, 'rooms', roomId, 'trades'), where('status', '==', 'pending'), limit(20))
  );
  const pendingTrades = pendingTradesSnap.docs.map((d) => d.data() as TradeOffer);

  return runTransaction(db, async (tx) => {
    const room = await loadRoomForTx(tx, roomId);
    if (room.status !== 'playing') return false;

    const botUid = room.turnOrder[room.currentPlayerIndex];
    if (!botUid) return false;

    const currentPlayerSnap = await tx.get(playerRef(roomId, botUid));
    const currentPlayer = currentPlayerSnap.exists() ? (currentPlayerSnap.data() as PublicPlayer) : null;
    if (!currentPlayer?.isBot) return false;

    const now = Date.now();
    const existingClaim = room.botActionClaim;
    const claimIsFresh = !!existingClaim && now - existingClaim.ts < BOT_CLAIM_STALE_MS;
    if (claimIsFresh) return false; // another client already holds a fresh claim

    // Gather everything decideBotAction/applyAction might need before any writes (Firestore
    // transactions require all reads before all writes).
    const playerUids = room.turnOrder;
    const playerSnaps = await Promise.all(playerUids.map((uid) => tx.get(playerRef(roomId, uid))));
    const players: Record<string, PublicPlayer> = {};
    playerUids.forEach((uid, i) => {
      const snap = playerSnaps[i];
      if (snap.exists()) players[uid] = snap.data() as PublicPlayer;
    });

    const botHandSnap = await tx.get(handRef(roomId, botUid));
    const botHand = botHandSnap.exists() ? (botHandSnap.data() as PrivateHand) : undefined;

    const decisionBundle: GameStateBundle = {
      room,
      players,
      hands: botHand ? { [botUid]: botHand } : {},
      trades: pendingTrades,
    };
    const action = decideBotAction(decisionBundle, botUid);

    if (!action) {
      tx.set(roomRef(roomId), { botActionClaim: null }, { merge: true });
      return false;
    }

    // Claim + apply as one atomic write. Note: because this whole flow (claim, decide,
    // apply, clear) runs inside a single transaction, the botActionClaim field is never
    // observably non-null to other clients on success — real double-execution safety comes
    // from Firestore's optimistic-concurrency conflict detection + automatic transaction
    // retry, not from this field. The 5s staleness window here is a defensive/observability
    // guard (and matches the documented contract) rather than the sole correctness mechanism.
    await applyActionInTransaction(tx, roomId, room, action, pendingTrades, {
      botActionClaim: null,
    });
    return true;
  });
}

export function subscribeRoom(roomId: string, cb: (room: RoomState | null) => void): () => void {
  return onSnapshot(roomRef(roomId), (snap) => {
    if (!snap.exists()) {
      cb(null);
      return;
    }
    cb({ id: snap.id, ...(snap.data() as Omit<RoomState, 'id'>) });
  });
}

export function subscribePlayers(
  roomId: string,
  cb: (players: Record<string, PublicPlayer>) => void
): () => void {
  return onSnapshot(collection(db, 'rooms', roomId, 'players'), (snap) => {
    const players: Record<string, PublicPlayer> = {};
    snap.forEach((d) => {
      players[d.id] = d.data() as PublicPlayer;
    });
    cb(players);
  });
}

export function subscribeOwnHand(
  roomId: string,
  uid: string,
  cb: (hand: PrivateHand | null) => void
): () => void {
  return onSnapshot(handRef(roomId, uid), (snap) => {
    cb(snap.exists() ? (snap.data() as PrivateHand) : null);
  });
}

export function subscribeTrades(roomId: string, cb: (trades: TradeOffer[]) => void): () => void {
  const q = query(collection(db, 'rooms', roomId, 'trades'), orderBy('createdAt', 'desc'));
  return onSnapshot(q, (snap) => {
    cb(snap.docs.map((d) => d.data() as TradeOffer));
  });
}

export function subscribeChat(roomId: string, cb: (messages: ChatMessage[]) => void): () => void {
  const q = query(collection(db, 'rooms', roomId, 'chat'), orderBy('ts', 'asc'), limit(200));
  return onSnapshot(q, (snap) => {
    cb(snap.docs.map((d) => d.data() as ChatMessage));
  });
}

export async function sendChat(
  roomId: string,
  uid: string,
  displayName: string,
  text: string
): Promise<void> {
  const msgRef = doc(collection(db, 'rooms', roomId, 'chat'));
  const message: ChatMessage = { id: msgRef.id, uid, displayName, text, ts: Date.now() };
  await setDoc(msgRef, message);
}

export async function heartbeat(roomId: string, uid: string): Promise<void> {
  await updateDoc(playerRef(roomId, uid), {
    connected: true,
    lastSeen: Date.now(),
  });
}
