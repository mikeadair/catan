import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { doc, getDoc, setDoc, updateDoc, writeBatch } from 'firebase/firestore';

let testEnv: RulesTestEnvironment;

beforeAll(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: 'demo-catan-rules-test',
    firestore: {
      rules: readFileSync(join(__dirname, '..', 'firestore.rules'), 'utf8'),
    },
  });
});

afterAll(async () => {
  await testEnv.cleanup();
});

beforeEach(async () => {
  await testEnv.clearFirestore();
});

const ROOM_ID = 'room1';

async function seedLobbyRoom(): Promise<void> {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'rooms', ROOM_ID), {
      hostUid: 'p0',
      status: 'lobby',
      turnOrder: ['p0', 'p1'],
      code: 'ABCDE',
    });
    await setDoc(doc(db, 'rooms', ROOM_ID, 'players', 'p0'), { uid: 'p0', isBot: false, connected: true, lastSeen: 1 });
    await setDoc(doc(db, 'rooms', ROOM_ID, 'players', 'p1'), { uid: 'p1', isBot: false, connected: true, lastSeen: 1 });
    await setDoc(doc(db, 'rooms', ROOM_ID, 'players', 'bot1'), { uid: 'bot1', isBot: true, connected: true, lastSeen: 1 });
  });
}

async function seedPlayingRoom(): Promise<void> {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'rooms', ROOM_ID), {
      hostUid: 'p0',
      status: 'playing',
      turnOrder: ['p0', 'p1'],
      code: 'ABCDE',
    });
    await setDoc(doc(db, 'rooms', ROOM_ID, 'players', 'p0'), { uid: 'p0', isBot: false, connected: true, lastSeen: 1 });
    await setDoc(doc(db, 'rooms', ROOM_ID, 'players', 'p1'), { uid: 'p1', isBot: false, connected: true, lastSeen: 1 });
    await setDoc(doc(db, 'rooms', ROOM_ID, 'players', 'bot1'), { uid: 'bot1', isBot: true, connected: true, lastSeen: 1 });
    await setDoc(doc(db, 'rooms', ROOM_ID, 'players', 'p0', 'private', 'hand'), {
      resources: { brick: 0, lumber: 0, ore: 0, grain: 0, wool: 0 },
      devCards: [],
    });
    await setDoc(doc(db, 'rooms', ROOM_ID, 'players', 'bot1', 'private', 'hand'), {
      resources: { brick: 0, lumber: 0, ore: 0, grain: 0, wool: 0 },
      devCards: [],
    });
    await setDoc(doc(db, 'rooms', ROOM_ID, 'serverOnly', 'devDeck'), { cards: ['knight'] });
  });
}

describe('firestore.rules — game-state write lockdown', () => {
  it('lets a member update the room doc while status is lobby', async () => {
    await seedLobbyRoom();
    const db = testEnv.authenticatedContext('p0').firestore();
    await assertSucceeds(updateDoc(doc(db, 'rooms', ROOM_ID), { mapPreset: 'chaos' }));
  });

  it('blocks a direct client update to the room doc once status is playing', async () => {
    await seedPlayingRoom();
    const db = testEnv.authenticatedContext('p0').firestore();
    await assertFails(updateDoc(doc(db, 'rooms', ROOM_ID), { currentPlayerIndex: 1 }));
  });

  it('blocks a full player-doc edit mid-game', async () => {
    await seedPlayingRoom();
    const db = testEnv.authenticatedContext('p0').firestore();
    await assertFails(updateDoc(doc(db, 'rooms', ROOM_ID, 'players', 'p0'), { resourceCount: 99 }));
  });

  it('allows the heartbeat carve-out (connected/lastSeen only) mid-game', async () => {
    await seedPlayingRoom();
    const db = testEnv.authenticatedContext('p0').firestore();
    await assertSucceeds(
      updateDoc(doc(db, 'rooms', ROOM_ID, 'players', 'p0'), { connected: true, lastSeen: Date.now() }),
    );
  });

  it('rejects a heartbeat-shaped write that also sneaks in another field', async () => {
    await seedPlayingRoom();
    const db = testEnv.authenticatedContext('p0').firestore();
    await assertFails(
      updateDoc(doc(db, 'rooms', ROOM_ID, 'players', 'p0'), {
        connected: true,
        lastSeen: Date.now(),
        resourceCount: 99,
      }),
    );
  });

  it('rejects a heartbeat write for someone else\'s player doc', async () => {
    await seedPlayingRoom();
    const db = testEnv.authenticatedContext('p1').firestore();
    await assertFails(updateDoc(doc(db, 'rooms', ROOM_ID, 'players', 'p0'), { connected: true, lastSeen: 1 }));
  });

  it('always denies a direct hand write, lobby or not', async () => {
    await seedPlayingRoom();
    const db = testEnv.authenticatedContext('p0').firestore();
    await assertFails(
      setDoc(doc(db, 'rooms', ROOM_ID, 'players', 'p0', 'private', 'hand'), {
        resources: { brick: 99, lumber: 0, ore: 0, grain: 0, wool: 0 },
        devCards: [],
      }),
    );
  });

  it('still allows a member to read their own hand', async () => {
    await seedPlayingRoom();
    const db = testEnv.authenticatedContext('p0').firestore();
    await assertSucceeds(getDoc(doc(db, 'rooms', ROOM_ID, 'players', 'p0', 'private', 'hand')));
  });

  it('allows any member to read a bot\'s hand', async () => {
    await seedPlayingRoom();
    const db = testEnv.authenticatedContext('p1').firestore();
    await assertSucceeds(getDoc(doc(db, 'rooms', ROOM_ID, 'players', 'bot1', 'private', 'hand')));
  });

  it('denies reading another human\'s hand', async () => {
    await seedPlayingRoom();
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'rooms', ROOM_ID, 'players', 'p1', 'private', 'hand'), {
        resources: { brick: 0, lumber: 0, ore: 0, grain: 0, wool: 0 },
        devCards: [],
      });
    });
    const db = testEnv.authenticatedContext('p0').firestore();
    await assertFails(getDoc(doc(db, 'rooms', ROOM_ID, 'players', 'p1', 'private', 'hand')));
  });

  it('denies creating a trade directly', async () => {
    await seedPlayingRoom();
    const db = testEnv.authenticatedContext('p0').firestore();
    await assertFails(
      setDoc(doc(db, 'rooms', ROOM_ID, 'trades', 't1'), {
        proposerUid: 'p0',
        targetUid: null,
        give: {},
        receive: {},
        status: 'pending',
        counterOf: null,
        createdAt: Date.now(),
      }),
    );
  });

  it('denies reading serverOnly/devDeck entirely, even for a member', async () => {
    await seedPlayingRoom();
    const db = testEnv.authenticatedContext('p0').firestore();
    await assertFails(getDoc(doc(db, 'rooms', ROOM_ID, 'serverOnly', 'devDeck')));
  });

  it('denies writing serverOnly/devDeck from a client, even the host', async () => {
    await seedPlayingRoom();
    const db = testEnv.authenticatedContext('p0').firestore();
    await assertFails(setDoc(doc(db, 'rooms', ROOM_ID, 'serverOnly', 'devDeck'), { cards: ['knight'] }));
  });
});

describe('firestore.rules — atomic write patterns (createRoom / joinRoom regressions)', () => {
  it('lets an atomic createRoom-style batch create the room doc and the host\'s own player doc together', async () => {
    // Regression test for Bug 1: createRoom() creates the room doc AND the host's own
    // players/{uid} doc in a single writeBatch. The player-doc create rule used to call
    // get() on the room doc to check its status, but the room doc doesn't exist yet from
    // the rules engine's point of view mid-batch, so the read (and the whole write) was
    // denied. The fix made self-writes to your own player doc not read room(roomId) at all.
    const db = testEnv.authenticatedContext('host1').firestore();
    const batch = writeBatch(db);
    batch.set(doc(db, 'rooms', ROOM_ID), {
      hostUid: 'host1',
      status: 'lobby',
      turnOrder: ['host1'],
      code: 'ABCDE',
    });
    batch.set(doc(db, 'rooms', ROOM_ID, 'players', 'host1'), {
      uid: 'host1',
      isBot: false,
      connected: true,
      lastSeen: 1,
    });
    await assertSucceeds(batch.commit());
  });

  it('lets a genuinely non-member user run the joinRoom sequence: read seated players, then create their own seat and join turnOrder', async () => {
    // Regression test for Bug 2: joinRoom() calls assignSeat(), which reads every
    // already-seated player's doc (to know which seats/colors are taken) before the
    // joining user is a member (isMember() requires already being in turnOrder). The
    // player-doc read rule used to only allow members to read, so those reads were
    // denied. The fix also lets any signed-in user read player docs while the room is
    // still 'lobby'.
    await seedLobbyRoom();
    const db = testEnv.authenticatedContext('p2').firestore();

    // joinRoom reads the room doc first, to confirm it's still joinable.
    await assertSucceeds(getDoc(doc(db, 'rooms', ROOM_ID)));

    // assignSeat's reads of the already-seated players' docs — this is the exact read
    // that Bug 2 broke, since 'p2' is not yet a member of the room.
    await assertSucceeds(getDoc(doc(db, 'rooms', ROOM_ID, 'players', 'p0')));
    await assertSucceeds(getDoc(doc(db, 'rooms', ROOM_ID, 'players', 'p1')));

    // The joiner creates their own player doc...
    await assertSucceeds(
      setDoc(doc(db, 'rooms', ROOM_ID, 'players', 'p2'), { uid: 'p2', isBot: false, connected: true, lastSeen: 1 }),
    );

    // ...and self-joins the room's turnOrder.
    await assertSucceeds(updateDoc(doc(db, 'rooms', ROOM_ID), { turnOrder: ['p0', 'p1', 'p2'] }));
  });

  it('still denies a non-member reading player docs once the room is playing (the lobby-read carve-out must not leak past lobby)', async () => {
    await seedPlayingRoom();
    const db = testEnv.authenticatedContext('outsider').firestore();
    await assertFails(getDoc(doc(db, 'rooms', ROOM_ID, 'players', 'p0')));
  });
});
