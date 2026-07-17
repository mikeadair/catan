import { describe, expect, it } from 'vitest';
import type { CallableRequest } from 'firebase-functions/v2/https';
import {
  DEFAULT_DISCARD_LIMIT,
  DEFAULT_TRADE_RESPONSE_TIMER_SECONDS,
  DEFAULT_TURN_TIMER_SECONDS,
  DEFAULT_VICTORY_POINTS_TO_WIN,
  PLAYER_COLORS,
  STARTING_BANK,
  type PublicPlayer,
  type RoomState,
} from '@catan/engine';
import { devDeckRef, handRef, playerRef, roomRef } from './db';
import { startGameHandler, type StartGameRequest } from './startGame';
import { freshRoomId } from './testHelpers';

function fakeRequest(data: StartGameRequest, uid: string | null): CallableRequest<StartGameRequest> {
  return {
    data,
    auth: uid ? ({ uid } as CallableRequest<StartGameRequest>['auth']) : undefined,
  } as CallableRequest<StartGameRequest>;
}

function lobbyPlayer(uid: string, seatIndex: number, isBot = false): PublicPlayer {
  return {
    uid,
    displayName: uid,
    color: PLAYER_COLORS[seatIndex],
    isBot,
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
}

async function seedLobbyRoom(roomId: string, hostUid: string, otherUids: string[]): Promise<void> {
  const turnOrder = [hostUid, ...otherUids];
  const room: Omit<RoomState, 'id' | 'devCardDeck'> = {
    code: 'TEST1',
    hostUid,
    status: 'lobby',
    mapPreset: 'official-beginner',
    seed: 'lobby-seed',
    board: null,
    vertices: {},
    edges: {},
    turnOrder,
    currentPlayerIndex: 0,
    phase: 'lobby',
    diceRoll: null,
    bank: { ...STARTING_BANK },
    devCardDeckCount: 0,
    longestRoadUid: null,
    largestArmyUid: null,
    winnerUid: null,
    turnNumber: 0,
    turnStartedAt: Date.now(),
    setupRound: null,
    pendingDiscardUids: [],
    botActionClaim: null,
    log: [],
    createdAt: Date.now(),
    victoryPointsToWin: DEFAULT_VICTORY_POINTS_TO_WIN,
    discardLimit: DEFAULT_DISCARD_LIMIT,
    turnTimerSeconds: DEFAULT_TURN_TIMER_SECONDS,
    tradeResponseTimerSeconds: DEFAULT_TRADE_RESPONSE_TIMER_SECONDS,
    safeMode: false,
    paused: false,
    pausedAt: null,
    pauseVotes: [],
    discoveredHexIds: null,
    pendingGoldPicks: [],
  };
  await roomRef(roomId).set(room);
  await Promise.all(turnOrder.map((uid, i) => playerRef(roomId, uid).set(lobbyPlayer(uid, i))));
}

describe('startGameHandler', () => {
  it('rejects an unauthenticated caller', async () => {
    const roomId = freshRoomId();
    await seedLobbyRoom(roomId, 'p0', ['p1']);
    await expect(startGameHandler(fakeRequest({ roomId }, null))).rejects.toMatchObject({ code: 'unauthenticated' });
  });

  it('rejects a non-host caller', async () => {
    const roomId = freshRoomId();
    await seedLobbyRoom(roomId, 'p0', ['p1']);
    await expect(startGameHandler(fakeRequest({ roomId }, 'p1'))).rejects.toMatchObject({ code: 'permission-denied' });
  });

  it('rejects starting a room that is already playing', async () => {
    const roomId = freshRoomId();
    await seedLobbyRoom(roomId, 'p0', ['p1']);
    await roomRef(roomId).set({ status: 'playing' }, { merge: true });
    await expect(startGameHandler(fakeRequest({ roomId }, 'p0'))).rejects.toMatchObject({ code: 'failed-precondition' });
  });

  it('deals the game server-side without leaking the seed or dev deck publicly', async () => {
    const roomId = freshRoomId();
    await seedLobbyRoom(roomId, 'p0', ['p1', 'p2']);

    const res = await startGameHandler(fakeRequest({ roomId }, 'p0'));
    expect(res).toEqual({ ok: true });

    const roomSnap = await roomRef(roomId).get();
    const room = roomSnap.data()!;
    expect(room.status).toBe('playing');
    expect(room.board).toBeTruthy();
    expect(room.devCardDeck).toBeUndefined();
    expect(room.devCardDeckCount).toBe(25);
    expect(room.seed).not.toBe('lobby-seed'); // real seed generated server-side, never this placeholder
    expect(room.seed).toBe(''); // and never persisted publicly at all

    const deckSnap = await devDeckRef(roomId).get();
    expect(deckSnap.exists).toBe(true);
    expect((deckSnap.data() as { cards: unknown[] }).cards).toHaveLength(25);

    for (const uid of room.turnOrder as string[]) {
      const handSnap = await handRef(roomId, uid).get();
      expect(handSnap.exists).toBe(true);
    }
  });

  it('rejects if a seated uid has no player doc', async () => {
    const roomId = freshRoomId();
    await seedLobbyRoom(roomId, 'p0', ['p1']);
    await playerRef(roomId, 'p1').delete();
    await expect(startGameHandler(fakeRequest({ roomId }, 'p0'))).rejects.toMatchObject({ code: 'failed-precondition' });
  });
});
