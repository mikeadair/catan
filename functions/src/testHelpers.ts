import { nanoid } from 'nanoid';
import { createGame, type CreateGameSeatedPlayer, type GameStateBundle, type RoomState, GamePhase } from '@catan/engine';
import { devDeckRef, handRef, playerRef, roomRef } from './db';

/**
 * Seeds a fresh, valid 'playing' room straight into the Firestore emulator (bypassing the
 * functions under test — this is setup, not the thing being tested), split exactly the way
 * startGame does: public doc gets devCardDeckCount only, the real deck goes to
 * serverOnly/devDeck. Defaults phase to 'main' (most action tests don't care about setup's
 * snake ordering); override via opts.phase.
 */
export async function seedPlayingRoom(
  roomId: string,
  seatedPlayers: CreateGameSeatedPlayer[],
  opts: { phase?: RoomState['phase'] } = {},
): Promise<GameStateBundle> {
  const bundle = createGame(
    {
      id: roomId,
      code: nanoid(5).toUpperCase(),
      hostUid: seatedPlayers[0].uid,
      mapPreset: 'official-beginner',
      seed: `seed-${roomId}`,
    },
    seatedPlayers,
  );
  bundle.room.phase = opts.phase ?? 'main';
  if (bundle.room.phase === GamePhase.Main || bundle.room.phase === GamePhase.Roll) {
    bundle.room.setupRound = null;
    bundle.room.turnNumber = 1;
  }

  const { id: _id, devCardDeck, ...roomData } = bundle.room;
  void _id;

  await roomRef(roomId).set({ ...roomData, devCardDeckCount: devCardDeck.length });
  await devDeckRef(roomId).set({ cards: devCardDeck });
  for (const uid of Object.keys(bundle.players)) {
    await playerRef(roomId, uid).set(bundle.players[uid]);
  }
  for (const uid of Object.keys(bundle.hands)) {
    await handRef(roomId, uid).set(bundle.hands[uid]);
  }

  return bundle;
}

export function freshRoomId(): string {
  return `test-room-${nanoid(10)}`;
}
