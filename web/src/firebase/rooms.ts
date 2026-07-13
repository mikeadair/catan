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
import { httpsCallable } from 'firebase/functions';
import { auth, db, functions } from './config';
import { decideBotAction } from '@catan/engine';
import {
  PLAYER_COLORS,
  STARTING_BANK,
  DEFAULT_VICTORY_POINTS_TO_WIN,
  DEFAULT_DISCARD_LIMIT,
  DEFAULT_TURN_TIMER_SECONDS,
  type RoomState,
  type PublicPlayer,
  type PrivateHand,
  type TradeOffer,
  type GameAction,
  type GameStateBundle,
  type MapPresetId,
  type BotDifficulty,
  type PlayerColor,
} from '@catan/engine';

// --- Firestore layout ---
// rooms/{roomId}                                -> Omit<RoomState, 'id'>
// rooms/{roomId}/players/{uid}                   -> PublicPlayer
// rooms/{roomId}/players/{uid}/private/hand      -> PrivateHand  (doc id literally "hand")
// rooms/{roomId}/trades/{tradeId}                -> TradeOffer
// rooms/{roomId}/chat/{msgId}                    -> ChatMessage
// rooms/{roomId}/serverOnly/devDeck              -> { cards: DevCardType[] } (Cloud Functions only)
//
// All in-game mutation (rollDice, build*, trade*, ..., and startGame's initial deal) goes
// through the submitAction/startGame Cloud Functions below, not direct Firestore writes —
// see functions/src/{submitAction,startGame,roomIO}.ts for the authoritative counterpart of
// what dispatchAction/claimAndRunBotAction/startGame used to do locally in this file.

// Mirrors functions/src/submitAction.ts's request/response shape (kept as a local,
// duplicated type rather than a shared import — functions/ depends on firebase-admin,
// which web has no reason to pull in).
interface SubmitActionRequest {
  roomId: string;
  action: GameAction;
  asBotUid?: string;
}
interface SubmitActionResponse {
  ok: true;
}
const submitActionCallable = httpsCallable<SubmitActionRequest, SubmitActionResponse>(functions, 'submitAction');

interface StartGameRequest {
  roomId: string;
}
interface StartGameResponse {
  ok: true;
}
const startGameCallable = httpsCallable<StartGameRequest, StartGameResponse>(functions, 'startGame');

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
 * `preferredColor` (from a signed-in user's persisted profile) is honored if it's still
 * free; otherwise falls back to the first unused color, same as before.
 */
async function assignSeat(
  tx: Transaction,
  roomId: string,
  turnOrder: string[],
  preferredColor?: PlayerColor
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
  const color =
    preferredColor && !usedColors.has(preferredColor)
      ? preferredColor
      : PLAYER_COLORS.find((c) => !usedColors.has(c));
  if (color === undefined) {
    throw new Error('Room is full');
  }
  return { seatIndex, color };
}

export async function createRoom(
  hostUid: string,
  hostName: string,
  mapPreset: MapPresetId,
  settings?: {
    victoryPointsToWin?: number;
    discardLimit?: number;
    turnTimerSeconds?: number | null;
    safeMode?: boolean;
    preferredColor?: PlayerColor;
  }
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
    devCardDeck: [], // placeholder while status is 'lobby' — no real deck exists yet, nothing to leak; startGame (Cloud Function) is what deals real cards, kept server-only
    devCardDeckCount: 0,
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
    turnTimerSeconds: settings?.turnTimerSeconds !== undefined ? settings.turnTimerSeconds : DEFAULT_TURN_TIMER_SECONDS,
    safeMode: settings?.safeMode ?? false,
    paused: false,
    pausedAt: null,
    pauseVotes: [],
    discoveredHexIds: null, // real game board (and its fog reveal state, if any) is generated by startGame
    pendingGoldPicks: [],
    devCardPlayedThisTurn: false,
    lastSetupSettlementVertexId: null,
  };

  const hostColor =
    settings?.preferredColor && PLAYER_COLORS.includes(settings.preferredColor)
      ? settings.preferredColor
      : PLAYER_COLORS[0];
  const hostPlayer = newPublicPlayer({
    uid: hostUid,
    displayName: hostName,
    color: hostColor,
    isBot: false,
    seatIndex: 0,
  });

  const batch = writeBatch(db);
  batch.set(newRoomRef, room);
  batch.set(playerRef(roomId, hostUid), hostPlayer);
  await batch.commit();

  return { roomId, code };
}

export async function joinRoom(
  code: string,
  uid: string,
  displayName: string,
  preferredColor?: PlayerColor
): Promise<string> {
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

    const { seatIndex, color } = await assignSeat(tx, roomId, room.turnOrder, preferredColor);
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

/**
 * Lets a seated player pick their own color while the room is still in lobby (already
 * permitted by firestore.rules: a self-write to your own player doc during 'lobby' has no
 * field restriction, same as any other lobby seat edit). Best-effort uniqueness check
 * against currently-seated players' colors — like the rest of the lobby, this is the
 * accepted client-authoritative trade-off (cosmetic-only stakes), not a transaction; a rare
 * simultaneous pick by two players just means one of them has to try again.
 */
export async function updatePlayerColor(roomId: string, uid: string, color: PlayerColor): Promise<void> {
  const playersSnap = await getDocs(collection(db, 'rooms', roomId, 'players'));
  const taken = new Set<PlayerColor>();
  playersSnap.forEach((d) => {
    const p = d.data() as PublicPlayer;
    if (p.uid !== uid) taken.add(p.color);
  });
  if (taken.has(color)) {
    throw new Error('That color is already taken');
  }
  await updateDoc(playerRef(roomId, uid), { color });
}

export interface RoomSettingsUpdate {
  mapPreset?: MapPresetId;
  victoryPointsToWin?: number;
  discardLimit?: number;
  turnTimerSeconds?: number | null;
  safeMode?: boolean;
}

/** Host-only (enforced in the UI, same pattern as addBot/startGame — the underlying
 * firestore.rules room-update rule already allows any seated member to update the room doc
 * during lobby, same as it always has for turnOrder edits). */
export async function updateRoomSettings(roomId: string, updates: RoomSettingsUpdate): Promise<void> {
  await updateDoc(roomRef(roomId), { ...updates });
}

export async function removeSeat(roomId: string, uid: string): Promise<void> {
  const roomSnap = await getDoc(roomRef(roomId));
  if (!roomSnap.exists()) {
    throw new Error('Room not found');
  }
  const room = roomSnap.data() as Omit<RoomState, 'id'>;

  // Lobby: still a direct client write, same as every other lobby-management action —
  // nothing hidden or resource-bearing is at stake before a game starts.
  if (room.status === 'lobby') {
    await runTransaction(db, async (tx) => {
      const ref = roomRef(roomId);
      const pRef = playerRef(roomId, uid);
      const [roomTxSnap, playerSnap] = await Promise.all([tx.get(ref), tx.get(pRef)]);
      if (!roomTxSnap.exists()) {
        throw new Error('Room not found');
      }
      const roomTx = roomTxSnap.data() as Omit<RoomState, 'id'>;
      const player = playerSnap.exists() ? (playerSnap.data() as PublicPlayer) : null;

      const currentUid = auth.currentUser?.uid ?? null;
      const isSelf = currentUid === uid;
      const isHostKickingBot = currentUid === roomTx.hostUid && !!player?.isBot;
      if (!isSelf && !isHostKickingBot) {
        throw new Error('Not allowed to remove this seat');
      }

      // No hand-doc delete here: a hand can only ever exist once startGame (Cloud
      // Function) has run, which also flips status to 'playing' in the same transaction —
      // so a hand never exists while status is still 'lobby'. (It also couldn't succeed
      // anymore: private/hand's write rule is now unconditionally `false` for clients.)
      const remaining = roomTx.turnOrder.filter((u) => u !== uid);
      if (remaining.length === 0) {
        // Last seat leaving an empty pre-game lobby — nothing left to host, so there's
        // nothing to keep around.
        tx.delete(ref);
        tx.delete(pRef);
        return;
      }
      // The host leaving doesn't dissolve the room if others are still here — hand hosting
      // to whoever's been seated longest (turnOrder is join order), otherwise every
      // remaining player is permanently locked out of settings/start (isHost === false for
      // everyone, since hostUid would point at a uid no longer in the room).
      const roomPatch: Partial<RoomState> = { turnOrder: remaining };
      if (uid === roomTx.hostUid) {
        roomPatch.hostUid = remaining[0];
      }
      tx.update(ref, roomPatch);
      tx.delete(pRef);
    });
    return;
  }

  // Mid-game: a game-rule (leave/kick invariants, turn-order reindexing, award
  // reassignment, ...) now enforced server-side — see rules.ts's 'removeSeat' case.
  const currentUid = auth.currentUser?.uid ?? '';
  await submitActionCallable({ roomId, action: { type: 'removeSeat', uid: currentUid, targetUid: uid } });
}

export async function startGame(roomId: string): Promise<void> {
  await startGameCallable({ roomId });
}

export async function dispatchAction(roomId: string, action: GameAction): Promise<void> {
  await submitActionCallable({ roomId, action });
}

/**
 * Runs decideBotAction for a single bot uid and, if it produced an action, submits it via
 * submitAction (asBotUid). Shared by claimAndRunBotAction (the current-turn driver) and
 * claimAndRunOffTurnBotTrade (the off-turn trade-response driver) below — both eventually
 * boil down to "load this bot's hand, ask the engine what it wants to do, submit it".
 */
async function runBotDecisionAndSubmit(
  roomId: string,
  room: RoomState,
  players: Record<string, PublicPlayer>,
  trades: TradeOffer[],
  botUid: string,
): Promise<boolean> {
  const botHandSnap = await getDoc(handRef(roomId, botUid));
  const botHand = botHandSnap.exists() ? (botHandSnap.data() as PrivateHand) : undefined;

  // trades passed straight from the caller's own already-subscribed `subscribeTrades` state
  // (public data, safe to hand to any bot's decision).
  const decisionBundle: GameStateBundle = {
    room,
    players,
    hands: botHand ? { [botUid]: botHand } : {},
    trades,
  };
  const action = decideBotAction(decisionBundle, botUid);
  if (!action) return false;

  await submitActionCallable({ roomId, action, asBotUid: botUid });
  return true;
}

export async function claimAndRunBotAction(
  roomId: string,
  room: RoomState,
  players: Record<string, PublicPlayer>,
  trades: TradeOffer[] = [],
): Promise<boolean> {
  if (room.status !== 'playing') return false;

  const botUid = room.turnOrder[room.currentPlayerIndex];
  if (!botUid) return false;

  const currentPlayer = players[botUid];
  if (!currentPlayer?.isBot) return false;

  // Client-side politeness check only, to skip a redundant invocation when another client
  // is likely already driving this bot's turn — NOT the source of double-execution safety.
  // That safety now lives inside submitAction's Firestore transaction: two concurrent
  // callers both submit their (already-decided) action, whichever commits first wins, and
  // the loser's transaction reads the now-advanced state on retry and fails with a normal
  // "not your turn"/phase-mismatch error from rules.ts, which callers of this function
  // should treat as a harmless no-op.
  const now = Date.now();
  const existingClaim = room.botActionClaim;
  const claimIsFresh = !!existingClaim && now - existingClaim.ts < BOT_CLAIM_STALE_MS;
  if (claimIsFresh) return false;

  return runBotDecisionAndSubmit(roomId, room, players, trades, botUid);
}

/**
 * Off-turn counterpart to claimAndRunBotAction: lets a bot that is NOT the current player
 * react to a trade proposed to it (or open to everyone) via decideTradeResponse — the path
 * decideBotAction already supports (see its `!isCurrent` branch) but that claimAndRunBotAction
 * itself can never reach, since it's hard-gated to room.turnOrder[currentPlayerIndex].
 *
 * No botActionClaim-style staleness gate here: unlike a bot's own turn (a sequence of several
 * actions that must not be double-driven mid-sequence), a trade response is a single
 * idempotent decision — decideTradeResponse is a pure function of the trade/hand/difficulty,
 * so two clients racing to submit it independently just means the loser's submitAction call
 * fails on a "trade is no longer pending" error once the winner's has already landed, same as
 * the harmless race described above. Pacing (the human-like reaction delay) is the caller's
 * job — see BOT_TRADE_RESPONSE_DELAY_*_MS in web/src/state/store.ts.
 */
export async function claimAndRunOffTurnBotTrade(
  roomId: string,
  room: RoomState,
  players: Record<string, PublicPlayer>,
  trades: TradeOffer[],
  botUid: string,
): Promise<boolean> {
  if (room.status !== 'playing') return false;
  if (room.turnOrder[room.currentPlayerIndex] === botUid) return false; // it's this bot's own turn; claimAndRunBotAction owns that path
  if (!players[botUid]?.isBot) return false;

  return runBotDecisionAndSubmit(roomId, room, players, trades, botUid);
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
