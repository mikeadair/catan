// Admin-SDK port of web/src/firebase/rooms.ts's loadRoomForTx / applyActionInTransaction /
// fetchPendingTradesIfNeeded. Deliberately duplicated rather than shared: the client
// (firebase/firestore) and Admin (firebase-admin/firestore) SDKs have structurally similar
// but distinct Transaction/DocumentReference types, so this is a one-time port, kept close
// in structure/naming to the original. The one piece where drift would be dangerous —
// neededHandUidsFor — is shared via @catan/engine instead of ported.
//
// Two things this version does that the client-side original didn't need to:
//  1. Splits devCardDeck off the public room doc into serverOnly/devDeck (see db.ts) so the
//     real draw order is never client-readable, mirroring its count via devCardDeckCount.
//  2. Deletes (rather than just diff-and-sets) a player/hand doc for any uid that removeSeat
//     dropped from turnOrder.
import type { Transaction } from 'firebase-admin/firestore';
import {
  applyAction,
  neededHandUidsFor,
  type DevCardType,
  type GameAction,
  type GameStateBundle,
  type PrivateHand,
  type PublicPlayer,
  type RoomState,
  type TradeOffer,
} from '@catan/engine';
import { db, devDeckRef, handRef, playerRef, roomRef, tradeRef } from './db';

export async function loadRoomForTx(tx: Transaction, roomId: string): Promise<RoomState> {
  const [roomSnap, devDeckSnap] = await Promise.all([tx.get(roomRef(roomId)), tx.get(devDeckRef(roomId))]);
  if (!roomSnap.exists) {
    throw new Error('Room not found');
  }
  const roomData = roomSnap.data() as Omit<RoomState, 'id' | 'devCardDeck'>;
  const devCardDeck = devDeckSnap.exists ? ((devDeckSnap.data() as { cards: DevCardType[] }).cards ?? []) : [];
  return { id: roomId, ...roomData, devCardDeck };
}

// Of every action type, only endTurn, expireTrades, and timeoutTradeResponse actually read
// the broader pending-trades list (endTurn to auto-cancel the actor's own open offers;
// expireTrades/timeoutTradeResponse to scan every pending offer for one that's aged out) —
// see web/src/firebase/rooms.ts for the original rationale (skips a network round-trip for
// the common case).
export async function fetchPendingTradesIfNeeded(roomId: string, action: GameAction): Promise<TradeOffer[]> {
  if (action.type !== 'endTurn' && action.type !== 'expireTrades' && action.type !== 'timeoutTradeResponse') return [];
  const snap = await db
    .collection('rooms')
    .doc(roomId)
    .collection('trades')
    .where('status', '==', 'pending')
    .limit(20)
    .get();
  return snap.docs.map((d) => d.data() as TradeOffer);
}

export async function applyActionInTransaction(
  tx: Transaction,
  roomId: string,
  room: RoomState,
  action: GameAction,
  pendingTrades: TradeOffer[],
  roomPatch: Partial<RoomState> = {},
): Promise<void> {
  const playerUids = room.turnOrder;
  const playerSnaps = await Promise.all(playerUids.map((uid) => tx.get(playerRef(roomId, uid))));
  const players: Record<string, PublicPlayer> = {};
  playerUids.forEach((uid, i) => {
    const snap = playerSnaps[i];
    if (snap.exists) players[uid] = snap.data() as PublicPlayer;
  });

  const tradesById = new Map(pendingTrades.map((t) => [t.id, t]));
  if (action.type === 'respondTrade' || action.type === 'cancelTrade' || action.type === 'finalizeTrade') {
    const specificSnap = await tx.get(tradeRef(roomId, action.tradeId));
    if (specificSnap.exists) {
      tradesById.set(action.tradeId, specificSnap.data() as TradeOffer);
    } else {
      tradesById.delete(action.tradeId);
    }
  }
  const trades = [...tradesById.values()];

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
    if (snap.exists) hands[uid] = snap.data() as PrivateHand;
  });

  const bundle: GameStateBundle = { room, players, hands, trades };
  const rawNextBundle = applyAction(bundle, action); // throws Error(message) on illegal action
  const nextBundle: GameStateBundle = {
    ...rawNextBundle,
    room: { ...rawNextBundle.room, ...roomPatch },
  };

  // Public room doc: never persist the real devCardDeck array, only its count — the real
  // deck lives exclusively in serverOnly/devDeck.
  if (JSON.stringify(room) !== JSON.stringify(nextBundle.room)) {
    const { id: _id, devCardDeck: _deck, ...nextRoomData } = nextBundle.room;
    void _id;
    void _deck;
    tx.set(roomRef(roomId), nextRoomData);
  }
  if (JSON.stringify(room.devCardDeck) !== JSON.stringify(nextBundle.room.devCardDeck)) {
    tx.set(devDeckRef(roomId), { cards: nextBundle.room.devCardDeck });
  }

  // Players/hands: delete anyone removeSeat dropped from turnOrder, diff-and-set everyone else.
  const removedUids = room.turnOrder.filter((uid) => !nextBundle.room.turnOrder.includes(uid));
  for (const uid of removedUids) {
    tx.delete(playerRef(roomId, uid));
    tx.delete(handRef(roomId, uid));
  }

  for (const uid of Object.keys(nextBundle.players)) {
    if (JSON.stringify(players[uid]) !== JSON.stringify(nextBundle.players[uid])) {
      tx.set(playerRef(roomId, uid), nextBundle.players[uid]);
    }
  }

  for (const uid of neededHandUidList) {
    if (removedUids.includes(uid)) continue; // already deleted above
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
