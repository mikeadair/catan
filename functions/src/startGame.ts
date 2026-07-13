import { randomBytes } from 'node:crypto';
import { HttpsError, onCall, type CallableRequest } from 'firebase-functions/v2/https';
import { createGame, type PublicPlayer, type RoomState } from '@catan/engine';
import { db, devDeckRef, handRef, playerRef, roomRef } from './db';

export interface StartGameRequest {
  roomId: string;
}
export interface StartGameResponse {
  ok: true;
}

// Separated from the onCall(...) wrapper below so tests can invoke it directly with a
// hand-built CallableRequest against the Firestore emulator.
export async function startGameHandler(request: CallableRequest<StartGameRequest>): Promise<StartGameResponse> {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Must be signed in.');
  }
  const roomId = request.data?.roomId;
  if (typeof roomId !== 'string' || !roomId) {
    throw new HttpsError('invalid-argument', 'roomId is required.');
  }
  const callerUid = request.auth.uid;

  try {
    await db.runTransaction(async (tx) => {
      const roomSnap = await tx.get(roomRef(roomId));
      if (!roomSnap.exists) {
        throw new HttpsError('failed-precondition', 'Room not found.');
      }
      const room = roomSnap.data() as Omit<RoomState, 'id' | 'devCardDeck'>;
      if (callerUid !== room.hostUid) {
        throw new HttpsError('permission-denied', 'Only the host can start the game.');
      }
      if (room.status !== 'lobby') {
        throw new HttpsError('failed-precondition', 'Game already started.');
      }

      const playerSnaps = await Promise.all(room.turnOrder.map((uid) => tx.get(playerRef(roomId, uid))));
      const seatedPlayers = room.turnOrder.map((uid, i) => {
        const snap = playerSnaps[i];
        if (!snap.exists) {
          throw new HttpsError('failed-precondition', `Missing player doc for seated uid ${uid}`);
        }
        const p = snap.data() as PublicPlayer;
        return {
          uid: p.uid,
          displayName: p.displayName,
          isBot: p.isBot,
          ...(p.botDifficulty ? { botDifficulty: p.botDifficulty } : {}),
        };
      });

      // Generated fresh here, server-side, and never written to any client-readable doc —
      // it's the sole input to the dev-card shuffle, so leaking it is equivalent to leaking
      // the deck order itself (see devCardDeck's comment in packages/engine/src/types.ts).
      const seed = randomBytes(16).toString('hex');

      const bundle = createGame(
        {
          id: roomId,
          code: room.code,
          hostUid: room.hostUid,
          mapPreset: room.mapPreset,
          seed,
          victoryPointsToWin: room.victoryPointsToWin,
          discardLimit: room.discardLimit,
          turnTimerSeconds: room.turnTimerSeconds,
          safeMode: room.safeMode,
        },
        seatedPlayers,
      );

      const { id: _id, devCardDeck, seed: _seed, ...roomWithoutSecrets } = bundle.room;
      void _id;
      void _seed;
      const roomToWrite: Omit<RoomState, 'id' | 'devCardDeck'> = {
        ...roomWithoutSecrets,
        seed: '', // never persisted publicly; keep the field present only for type shape
        status: 'playing',
        victoryPointsToWin: room.victoryPointsToWin,
        discardLimit: room.discardLimit,
        turnTimerSeconds: room.turnTimerSeconds,
        safeMode: room.safeMode,
      };

      tx.set(roomRef(roomId), roomToWrite);
      tx.set(devDeckRef(roomId), { cards: devCardDeck });
      for (const uid of Object.keys(bundle.players)) {
        tx.set(playerRef(roomId, uid), bundle.players[uid]);
      }
      for (const uid of Object.keys(bundle.hands)) {
        tx.set(handRef(roomId, uid), bundle.hands[uid]);
      }
    });

    return { ok: true };
  } catch (err) {
    if (err instanceof HttpsError) throw err;
    throw new HttpsError('failed-precondition', err instanceof Error ? err.message : String(err));
  }
}

export const startGame = onCall<StartGameRequest>(startGameHandler);
