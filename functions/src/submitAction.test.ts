import { beforeEach, describe, expect, it } from 'vitest';
import { HttpsError, type CallableRequest } from 'firebase-functions/v2/https';
import { DISCARD_TIMEOUT_SECONDS, TRADE_EXPIRY_MS, type GameAction, type TradeOffer } from '@catan/engine';
import { devDeckRef, handRef, playerRef, roomRef, tradeRef } from './db';
import { submitActionHandler, type SubmitActionRequest } from './submitAction';
import { freshRoomId, seedPlayingRoom } from './testHelpers';

function fakeRequest(data: SubmitActionRequest, uid: string | null): CallableRequest<SubmitActionRequest> {
  return {
    data,
    auth: uid ? ({ uid } as CallableRequest<SubmitActionRequest>['auth']) : undefined,
  } as CallableRequest<SubmitActionRequest>;
}

async function expectHttpsErrorCode(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise;
    throw new Error('expected promise to reject');
  } catch (err) {
    expect(err).toBeInstanceOf(HttpsError);
    expect((err as HttpsError).code).toBe(code);
  }
}

describe('submitActionHandler', () => {
  let roomId: string;

  beforeEach(() => {
    roomId = freshRoomId();
  });

  it('rejects an unauthenticated caller', async () => {
    const action: GameAction = { type: 'endTurn', uid: 'whoever' };
    await expectHttpsErrorCode(submitActionHandler(fakeRequest({ roomId, action }, null)), 'unauthenticated');
  });

  it('rejects a caller who is not a member of the room', async () => {
    await seedPlayingRoom(roomId, [
      { uid: 'p0', displayName: 'Host', isBot: false },
      { uid: 'p1', displayName: 'Two', isBot: false },
    ]);
    const action: GameAction = { type: 'endTurn', uid: 'p0' };
    await expectHttpsErrorCode(submitActionHandler(fakeRequest({ roomId, action }, 'intruder')), 'permission-denied');
  });

  it('rejects a malformed action shape', async () => {
    await seedPlayingRoom(roomId, [
      { uid: 'p0', displayName: 'Host', isBot: false },
      { uid: 'p1', displayName: 'Two', isBot: false },
    ]);
    const action = { type: 'buildRoad', uid: 'p0' } as GameAction; // missing edgeId
    await expectHttpsErrorCode(submitActionHandler(fakeRequest({ roomId, action }, 'p0')), 'invalid-argument');
  });

  it('never trusts action.uid from the client — derives the acting uid from the caller', async () => {
    const bundle = await seedPlayingRoom(roomId, [
      { uid: 'p0', displayName: 'Host', isBot: false },
      { uid: 'p1', displayName: 'Two', isBot: false },
    ]);
    // createGame shuffles turnOrder, so look up who's actually current rather than assuming
    // seat order matches input order.
    const currentUid = bundle.room.turnOrder[bundle.room.currentPlayerIndex];
    const otherUid = bundle.room.turnOrder.find((u) => u !== currentUid)!;
    // otherUid calls, but forges action.uid as the real current player — if the server
    // trusted action.uid, this would illegitimately succeed on otherUid's behalf. It must
    // instead be rejected as "not your turn" because the real caller (otherUid) isn't current.
    const forgedAction = { type: 'endTurn', uid: currentUid } as GameAction;
    await expectHttpsErrorCode(
      submitActionHandler(fakeRequest({ roomId, action: forgedAction }, otherUid)),
      'failed-precondition',
    );
  });

  it('applies a legal action and writes only the changed docs', async () => {
    const bundle = await seedPlayingRoom(roomId, [
      { uid: 'p0', displayName: 'Host', isBot: false },
      { uid: 'p1', displayName: 'Two', isBot: false },
    ]);
    const currentUid = bundle.room.turnOrder[bundle.room.currentPlayerIndex];
    const action: GameAction = { type: 'endTurn', uid: 'someone-else-entirely' }; // uid ignored
    const res = await submitActionHandler(fakeRequest({ roomId, action }, currentUid));
    expect(res).toEqual({ ok: true });

    const roomSnap = await roomRef(roomId).get();
    const room = roomSnap.data()!;
    expect(room.turnNumber).toBe(bundle.room.turnNumber + 1);
    expect(room.phase).toBe('roll');
  });

  it('surfaces a rules.ts rejection (wrong phase) as failed-precondition with the original message', async () => {
    const bundle = await seedPlayingRoom(roomId, [
      { uid: 'p0', displayName: 'Host', isBot: false },
      { uid: 'p1', displayName: 'Two', isBot: false },
    ]);
    // endTurn is only legal in 'main' (rules.ts) — 'roll' is seeded by seedPlayingRoom's
    // default, so force 'roll' explicitly here to be independent of that default.
    await roomRef(roomId).set({ phase: 'roll' }, { merge: true });
    const currentUid = bundle.room.turnOrder[bundle.room.currentPlayerIndex];
    const action: GameAction = { type: 'endTurn', uid: currentUid };
    try {
      await submitActionHandler(fakeRequest({ roomId, action }, currentUid));
      throw new Error('expected rejection');
    } catch (err) {
      expect(err).toBeInstanceOf(HttpsError);
      expect((err as HttpsError).code).toBe('failed-precondition');
      expect((err as HttpsError).message).toMatch(/phase/i);
    }
  });

  it('never writes the real devCardDeck to the public room doc, and mirrors its count', async () => {
    const bundle = await seedPlayingRoom(roomId, [
      { uid: 'p0', displayName: 'Host', isBot: false },
      { uid: 'p1', displayName: 'Two', isBot: false },
    ]);
    const currentUid = bundle.room.turnOrder[bundle.room.currentPlayerIndex];
    await handRef(roomId, currentUid).set({ resources: { brick: 0, lumber: 0, ore: 1, grain: 1, wool: 1 }, devCards: [] });
    const countBefore = bundle.room.devCardDeck.length;

    await submitActionHandler(fakeRequest({ roomId, action: { type: 'buyDevCard', uid: currentUid } }, currentUid));

    const roomSnap = await roomRef(roomId).get();
    const roomData = roomSnap.data()!;
    expect(roomData.devCardDeck).toBeUndefined();
    expect(roomData.devCardDeckCount).toBe(countBefore - 1);

    const deckSnap = await devDeckRef(roomId).get();
    expect((deckSnap.data() as { cards: unknown[] }).cards).toHaveLength(countBefore - 1);
  });

  describe('asBotUid', () => {
    it('rejects asBotUid pointing at a seat that is not a bot', async () => {
      const bundle = await seedPlayingRoom(roomId, [
        { uid: 'p0', displayName: 'Host', isBot: false },
        { uid: 'p1', displayName: 'Two', isBot: false },
      ]);
      const action: GameAction = { type: 'endTurn', uid: 'ignored' };
      await expectHttpsErrorCode(
        submitActionHandler(fakeRequest({ roomId, action, asBotUid: 'p1' }, bundle.room.hostUid)),
        'permission-denied',
      );
    });

    it('rejects asBotUid pointing at a seat that does not exist', async () => {
      await seedPlayingRoom(roomId, [
        { uid: 'p0', displayName: 'Host', isBot: false },
        { uid: 'p1', displayName: 'Two', isBot: false },
      ]);
      const action: GameAction = { type: 'endTurn', uid: 'ignored' };
      await expectHttpsErrorCode(
        submitActionHandler(fakeRequest({ roomId, action, asBotUid: 'nobody' }, 'p0')),
        'permission-denied',
      );
    });

    it('lets any room member drive a real bot seat, and clears botActionClaim', async () => {
      const bundle = await seedPlayingRoom(roomId, [
        { uid: 'p0', displayName: 'Host', isBot: false },
        { uid: 'bot1', displayName: 'Bot', isBot: true },
      ]);
      // createGame shuffles turnOrder — force currentPlayerIndex onto the bot's actual seat
      // rather than assuming the shuffle happened to put it there.
      const botIndex = bundle.room.turnOrder.indexOf('bot1');
      await roomRef(roomId).set(
        { currentPlayerIndex: botIndex, botActionClaim: { turnNumber: 1, ts: Date.now() } },
        { merge: true },
      );

      const action: GameAction = { type: 'endTurn', uid: 'ignored' };
      const res = await submitActionHandler(fakeRequest({ roomId, action, asBotUid: 'bot1' }, 'p0'));
      expect(res).toEqual({ ok: true });

      const roomSnap = await roomRef(roomId).get();
      expect(roomSnap.data()!.botActionClaim).toBeNull();
    });
  });

  describe('removeSeat', () => {
    it('deletes the player and hand docs for the removed seat', async () => {
      const bundle = await seedPlayingRoom(roomId, [
        { uid: 'p0', displayName: 'Host', isBot: false },
        { uid: 'p1', displayName: 'Two', isBot: false },
        { uid: 'p2', displayName: 'Three', isBot: false },
      ]);
      const leaving = bundle.room.turnOrder[1];
      const action: GameAction = { type: 'removeSeat', uid: 'ignored', targetUid: leaving };
      const res = await submitActionHandler(fakeRequest({ roomId, action }, leaving));
      expect(res).toEqual({ ok: true });

      const [playerSnap, handSnap, roomSnap] = await Promise.all([
        playerRef(roomId, leaving).get(),
        handRef(roomId, leaving).get(),
        roomRef(roomId).get(),
      ]);
      expect(playerSnap.exists).toBe(false);
      expect(handSnap.exists).toBe(false);
      expect(roomSnap.data()!.turnOrder).not.toContain(leaving);
    });

    it('rejects a non-host trying to remove another human', async () => {
      const bundle = await seedPlayingRoom(roomId, [
        { uid: 'p0', displayName: 'Host', isBot: false },
        { uid: 'p1', displayName: 'Two', isBot: false },
        { uid: 'p2', displayName: 'Three', isBot: false },
      ]);
      // Pick a target that is neither the caller (p1, which would be a self-leave — allowed)
      // nor the host (who could legitimately remove a bot, though not another human either).
      const target = bundle.room.turnOrder.find((u) => u !== 'p1' && u !== bundle.room.hostUid)!;
      const action: GameAction = { type: 'removeSeat', uid: 'ignored', targetUid: target };
      await expectHttpsErrorCode(submitActionHandler(fakeRequest({ roomId, action }, 'p1')), 'failed-precondition');
    });
  });

  describe('expireTrades', () => {
    // Regression coverage for fetchPendingTradesIfNeeded (roomIO.ts): only endTurn used to
    // read the broader pending-trades list into the transaction bundle, which would have
    // silently made expireTrades a no-op against a live Firestore-backed room (it only ever
    // "saw" a single trade doc when the action type was respondTrade/cancelTrade). This
    // exercises the real submitAction path end to end against the emulator, not just
    // rules.ts's pure reducer.
    it('flips an aged-out pending trade to expired, and leaves a fresh one alone', async () => {
      const bundle = await seedPlayingRoom(roomId, [
        { uid: 'p0', displayName: 'Host', isBot: false },
        { uid: 'p1', displayName: 'Two', isBot: false },
      ]);
      const [uidA, uidB] = bundle.room.turnOrder;

      const staleTrade: TradeOffer = {
        id: 'stale-trade',
        proposerUid: uidA,
        targetUid: uidB,
        give: { brick: 1 },
        receive: { ore: 1 },
        status: 'pending',
        counterOf: null,
        createdAt: Date.now() - TRADE_EXPIRY_MS - 1000,
        interestedUids: [],
      };
      const freshTrade: TradeOffer = {
        id: 'fresh-trade',
        proposerUid: uidA,
        targetUid: null,
        give: { lumber: 1 },
        receive: { wool: 1 },
        status: 'pending',
        counterOf: null,
        createdAt: Date.now(),
        interestedUids: [],
      };
      await tradeRef(roomId, staleTrade.id).set(staleTrade);
      await tradeRef(roomId, freshTrade.id).set(freshTrade);

      const action: GameAction = { type: 'expireTrades', uid: uidB };
      const res = await submitActionHandler(fakeRequest({ roomId, action }, uidB));
      expect(res).toEqual({ ok: true });

      const [staleSnap, freshSnap] = await Promise.all([
        tradeRef(roomId, staleTrade.id).get(),
        tradeRef(roomId, freshTrade.id).get(),
      ]);
      expect(staleSnap.data()!.status).toBe('expired');
      expect(freshSnap.data()!.status).toBe('pending');
    });

    it('rejects when no pending trade has actually aged out yet', async () => {
      const bundle = await seedPlayingRoom(roomId, [
        { uid: 'p0', displayName: 'Host', isBot: false },
        { uid: 'p1', displayName: 'Two', isBot: false },
      ]);
      const [uidA] = bundle.room.turnOrder;
      const action: GameAction = { type: 'expireTrades', uid: uidA };
      await expectHttpsErrorCode(submitActionHandler(fakeRequest({ roomId, action }, uidA)), 'failed-precondition');
    });
  });

  describe('finalizeTrade', () => {
    // Regression coverage: applyActionInTransaction (roomIO.ts) only fetched the specific
    // trade doc into the transaction bundle for respondTrade/cancelTrade, never
    // finalizeTrade — so a real proposer finalizing an open trade a bot (or any player) had
    // expressed interest in would hit rules.ts's `trades.find(...)` against an empty array
    // and fail with "Unknown trade", even though the trade genuinely existed in Firestore.
    // This exercises the real submitAction path end to end against the emulator.
    it('resolves an open trade with the chosen interested player', async () => {
      const bundle = await seedPlayingRoom(roomId, [
        { uid: 'p0', displayName: 'Host', isBot: false },
        { uid: 'p1', displayName: 'Two', isBot: false },
      ]);
      const [uidA, uidB] = bundle.room.turnOrder;

      await handRef(roomId, uidA).set({ resources: { brick: 1, lumber: 0, ore: 0, grain: 0, wool: 0 }, devCards: [] });
      await handRef(roomId, uidB).set({ resources: { brick: 0, lumber: 0, ore: 0, grain: 1, wool: 0 }, devCards: [] });

      const openTrade: TradeOffer = {
        id: 'open-trade',
        proposerUid: uidA,
        targetUid: null,
        give: { brick: 1 },
        receive: { grain: 1 },
        status: 'pending',
        counterOf: null,
        createdAt: Date.now(),
        interestedUids: [uidB],
      };
      await tradeRef(roomId, openTrade.id).set(openTrade);

      const action: GameAction = { type: 'finalizeTrade', uid: uidA, tradeId: openTrade.id, withUid: uidB };
      const res = await submitActionHandler(fakeRequest({ roomId, action }, uidA));
      expect(res).toEqual({ ok: true });

      const [handASnap, handBSnap, tradeSnap] = await Promise.all([
        handRef(roomId, uidA).get(),
        handRef(roomId, uidB).get(),
        tradeRef(roomId, openTrade.id).get(),
      ]);
      expect(handASnap.data()!.resources).toEqual({ brick: 0, lumber: 0, ore: 0, grain: 1, wool: 0 });
      expect(handBSnap.data()!.resources).toEqual({ brick: 1, lumber: 0, ore: 0, grain: 0, wool: 0 });
      expect(tradeSnap.data()!.status).toBe('accepted');
    });
  });

  describe('timeoutDiscard', () => {
    // Regression coverage: timeoutDiscard needs every pending discarder's hand loaded into
    // the transaction (neededHandUidsFor), not just the reporting caller's — exercised
    // against the real submitAction path so a gap there (like the finalizeTrade one above)
    // would actually fail here instead of only in packages/engine's own fully-populated-bundle
    // unit tests.
    it('auto-discards down to the required count for every pending player once the timer has elapsed', async () => {
      const bundle = await seedPlayingRoom(
        roomId,
        [
          { uid: 'p0', displayName: 'Host', isBot: false },
          { uid: 'p1', displayName: 'Two', isBot: false },
          { uid: 'p2', displayName: 'Three', isBot: false },
        ],
        { phase: 'discard' },
      );
      const [uidA, uidB, uidC] = bundle.room.turnOrder;
      await roomRef(roomId).set(
        {
          pendingDiscardUids: [uidB, uidC],
          discardPhaseStartedAt: Date.now() - DISCARD_TIMEOUT_SECONDS * 1000 - 1000,
        },
        { merge: true },
      );
      await handRef(roomId, uidB).set({ resources: { brick: 3, lumber: 3, ore: 0, grain: 0, wool: 0 }, devCards: [] });
      await handRef(roomId, uidC).set({ resources: { brick: 0, lumber: 0, ore: 4, grain: 4, wool: 0 }, devCards: [] });

      const action: GameAction = { type: 'timeoutDiscard', uid: uidA };
      const res = await submitActionHandler(fakeRequest({ roomId, action }, uidA));
      expect(res).toEqual({ ok: true });

      const [handBSnap, handCSnap, roomSnap] = await Promise.all([
        handRef(roomId, uidB).get(),
        handRef(roomId, uidC).get(),
        roomRef(roomId).get(),
      ]);
      const total = (r: { brick: number; lumber: number; ore: number; grain: number; wool: number }) =>
        r.brick + r.lumber + r.ore + r.grain + r.wool;
      expect(total(handBSnap.data()!.resources)).toBe(3);
      expect(total(handCSnap.data()!.resources)).toBe(4);
      expect(roomSnap.data()!.phase).toBe('robber');
      expect(roomSnap.data()!.pendingDiscardUids).toEqual([]);
      expect(roomSnap.data()!.discardPhaseStartedAt).toBeNull();
    });

    it('rejects when the discard timer has not actually elapsed yet', async () => {
      const bundle = await seedPlayingRoom(
        roomId,
        [
          { uid: 'p0', displayName: 'Host', isBot: false },
          { uid: 'p1', displayName: 'Two', isBot: false },
        ],
        { phase: 'discard' },
      );
      const [uidA, uidB] = bundle.room.turnOrder;
      await roomRef(roomId).set(
        { pendingDiscardUids: [uidB], discardPhaseStartedAt: Date.now() },
        { merge: true },
      );
      const action: GameAction = { type: 'timeoutDiscard', uid: uidA };
      await expectHttpsErrorCode(submitActionHandler(fakeRequest({ roomId, action }, uidA)), 'failed-precondition');
    });
  });
});
