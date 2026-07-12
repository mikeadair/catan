import { create } from 'zustand';
import type { RoomState, PublicPlayer, PrivateHand, TradeOffer, GameAction } from '../game/types';
import {
  subscribeRoom,
  subscribePlayers,
  subscribeOwnHand,
  subscribeTrades,
  subscribeChat,
  dispatchAction as fbDispatchAction,
  claimAndRunBotAction,
  heartbeat,
  sendChat as fbSendChat,
  type ChatMessage,
} from '../firebase/rooms';

const BOT_POLL_MS = 1500;
const BOT_POLL_MAX_MS = 20000;
const HEARTBEAT_MS = 15000;
const LAST_ROOM_KEY = 'catan.lastRoomId';

interface GameStore {
  uid: string | null;
  roomId: string | null;
  room: RoomState | null;
  players: Record<string, PublicPlayer>;
  ownHand: PrivateHand | null;
  trades: TradeOffer[];
  chat: ChatMessage[];
  error: string | null;

  setUid: (uid: string | null) => void;
  enterRoom: (roomId: string) => void;
  leaveRoom: () => void;
  dispatch: (action: GameAction) => Promise<void>;
  sendChatMessage: (text: string) => Promise<void>;
  clearError: () => void;
}

let unsubscribers: Array<() => void> = [];
let botPollTimeout: ReturnType<typeof setTimeout> | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

function teardown() {
  unsubscribers.forEach((u) => u());
  unsubscribers = [];
  if (botPollTimeout) {
    clearTimeout(botPollTimeout);
    botPollTimeout = null;
  }
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

/**
 * Self-scheduling bot-turn poller (setTimeout, not setInterval) with exponential backoff on
 * failure. A burst of transient errors (e.g. a Firestore rate-limit blip) previously meant
 * every connected client kept retrying every 1.5s regardless, which only pours more load on
 * an already-throttled backend. On success (including "nothing to do right now") the delay
 * resets to the base cadence; on failure it doubles up to BOT_POLL_MAX_MS.
 */
function scheduleBotPoll(roomId: string, get: () => GameStore, delay: number): void {
  botPollTimeout = setTimeout(() => {
    const current = get();
    if (current.roomId !== roomId || current.room?.status !== 'playing') {
      scheduleBotPoll(roomId, get, BOT_POLL_MS);
      return;
    }
    claimAndRunBotAction(roomId)
      .then(() => scheduleBotPoll(roomId, get, BOT_POLL_MS))
      .catch(() => scheduleBotPoll(roomId, get, Math.min(delay * 2, BOT_POLL_MAX_MS)));
  }, delay);
}

export const useGameStore = create<GameStore>((set, get) => ({
  uid: null,
  roomId: null,
  room: null,
  players: {},
  ownHand: null,
  trades: [],
  chat: [],
  error: null,

  setUid: (uid) => set({ uid }),

  enterRoom: (roomId) => {
    teardown();
    set({ roomId, room: null, players: {}, ownHand: null, trades: [], chat: [], error: null });
    try {
      localStorage.setItem(LAST_ROOM_KEY, roomId);
    } catch {
      // localStorage unavailable (private browsing, etc) — non-fatal, just skip persistence.
    }

    unsubscribers.push(subscribeRoom(roomId, (room) => set({ room })));
    unsubscribers.push(subscribePlayers(roomId, (players) => set({ players })));
    unsubscribers.push(subscribeTrades(roomId, (trades) => set({ trades })));
    unsubscribers.push(subscribeChat(roomId, (chat) => set({ chat })));

    const uid = get().uid;
    if (uid) {
      unsubscribers.push(subscribeOwnHand(roomId, uid, (ownHand) => set({ ownHand })));
      heartbeat(roomId, uid).catch(() => {});
      heartbeatTimer = setInterval(() => {
        heartbeat(roomId, uid).catch(() => {});
      }, HEARTBEAT_MS);
    }

    // One driver per client polls to advance bot turns; claimAndRunBotAction is itself
    // transaction-safe against every other connected client doing the same thing.
    scheduleBotPoll(roomId, get, BOT_POLL_MS);
  },

  leaveRoom: () => {
    teardown();
    try {
      localStorage.removeItem(LAST_ROOM_KEY);
    } catch {
      // non-fatal
    }
    set({ roomId: null, room: null, players: {}, ownHand: null, trades: [], chat: [] });
  },

  dispatch: async (action) => {
    const { roomId } = get();
    if (!roomId) return;
    try {
      await fbDispatchAction(roomId, action);
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  },

  sendChatMessage: async (text) => {
    const { roomId, uid, players } = get();
    if (!roomId || !uid || !text.trim()) return;
    const displayName = players[uid]?.displayName ?? 'Player';
    await fbSendChat(roomId, uid, displayName, text.trim());
  },

  clearError: () => set({ error: null }),
}));

export function getLastRoomId(): string | null {
  try {
    return localStorage.getItem(LAST_ROOM_KEY);
  } catch {
    return null;
  }
}
