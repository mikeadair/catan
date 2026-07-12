import { HttpsError, onCall, type CallableRequest } from 'firebase-functions/v2/https';
import { assertValidActionShape, type GameAction } from '@catan/engine';
import { db, playerRef } from './db';
import { applyActionInTransaction, fetchPendingTradesIfNeeded, loadRoomForTx } from './roomIO';

export interface SubmitActionRequest {
  roomId: string;
  action: GameAction;
  /** Present only when the caller is driving a bot's turn on its behalf. */
  asBotUid?: string;
}
export interface SubmitActionResponse {
  ok: true;
}

// Separated from the onCall(...) wrapper below so tests can invoke it directly with a
// hand-built CallableRequest against the Firestore emulator, without going through the
// HTTPS/emulator-function-serving layer.
export async function submitActionHandler(
  request: CallableRequest<SubmitActionRequest>,
): Promise<SubmitActionResponse> {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Must be signed in.');
  }
  const { roomId, action, asBotUid } = request.data ?? ({} as SubmitActionRequest);
  if (typeof roomId !== 'string' || !roomId) {
    throw new HttpsError('invalid-argument', 'roomId is required.');
  }
  if (asBotUid !== undefined && (typeof asBotUid !== 'string' || !asBotUid)) {
    throw new HttpsError('invalid-argument', 'asBotUid must be a non-empty string when present.');
  }
  try {
    assertValidActionShape(action);
  } catch (err) {
    throw new HttpsError('invalid-argument', err instanceof Error ? err.message : String(err));
  }

  const callerUid = request.auth.uid;

  try {
    // Non-transactional; only decides which docs applyActionInTransaction reads, not who's
    // authorized to act — see fetchPendingTradesIfNeeded for why this is safe to do early.
    const pendingTrades = await fetchPendingTradesIfNeeded(roomId, action);

    await db.runTransaction(async (tx) => {
      const room = await loadRoomForTx(tx, roomId);
      if (room.status !== 'playing') {
        throw new HttpsError('failed-precondition', 'Game is not in progress.');
      }
      if (!room.turnOrder.includes(callerUid)) {
        throw new HttpsError('permission-denied', 'Not a member of this room.');
      }

      // Never trust action.uid from the client — derive the acting uid from the verified
      // caller identity (and, for a bot move, from a server-side isBotUid check mirroring
      // the old firestore.rules helper of the same name).
      let actingUid = callerUid;
      let roomPatch = {};
      if (asBotUid) {
        const botSnap = await tx.get(playerRef(roomId, asBotUid));
        if (!botSnap.exists || (botSnap.data() as { isBot?: boolean } | undefined)?.isBot !== true) {
          throw new HttpsError('permission-denied', 'Not a valid bot seat in this room.');
        }
        actingUid = asBotUid;
        roomPatch = { botActionClaim: null };
      }

      const authorizedAction: GameAction = { ...action, uid: actingUid };
      await applyActionInTransaction(tx, roomId, room, authorizedAction, pendingTrades, roomPatch);
    });

    return { ok: true };
  } catch (err) {
    if (err instanceof HttpsError) throw err;
    throw new HttpsError('failed-precondition', err instanceof Error ? err.message : String(err));
  }
}

export const submitAction = onCall<SubmitActionRequest>(submitActionHandler);
