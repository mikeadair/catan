import { create } from 'zustand';
import type { RoomState, PublicPlayer, PrivateHand, TradeOffer, GameAction } from '@catan/engine';
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

// Bot turns are driven reactively off the room/players listeners we already pay for,
// rather than an unconditional poll — see runBotActionIfDue/triggerBotCheck below.
const BOT_TRIGGER_JITTER_MS = 250;
const BOT_FALLBACK_MS = 15000;
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
  /** Same wire call as dispatch, but for background/best-effort actions any connected
   * client may fire on someone else's behalf (AFK auto-roll, turn-timeout skip) — races
   * where another client already won are expected and must never surface as a user-facing
   * error toast. */
  dispatchQuiet: (action: GameAction) => Promise<void>;
  sendChatMessage: (text: string) => Promise<void>;
  clearError: () => void;
}

let unsubscribers: Array<() => void> = [];
let botTriggerTimeout: ReturnType<typeof setTimeout> | null = null;
let botFallbackTimer: ReturnType<typeof setInterval> | null = null;
let botActionInFlight = false;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

function teardown() {
  unsubscribers.forEach((u) => u());
  unsubscribers = [];
  if (botTriggerTimeout) {
    clearTimeout(botTriggerTimeout);
    botTriggerTimeout = null;
  }
  if (botFallbackTimer) {
    clearInterval(botFallbackTimer);
    botFallbackTimer = null;
  }
  botActionInFlight = false;
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

// Mirrors the gate claimAndRunBotAction itself applies (only the current player's seat is
// ever driven), computed here against state we already have locally from the room/players
// listeners — so most of the time we can tell "nothing to do" without touching Firestore.
function isBotTurn(room: RoomState | null, players: Record<string, PublicPlayer>): boolean {
  if (!room || room.status !== 'playing') return false;
  const currentUid = room.turnOrder[room.currentPlayerIndex];
  return !!currentUid && players[currentUid]?.isBot === true;
}

function runBotActionIfDue(roomId: string, get: () => GameStore): void {
  if (botActionInFlight) return;
  const { roomId: currentRoomId, room, players } = get();
  if (currentRoomId !== roomId || !room || !isBotTurn(room, players)) return;
  botActionInFlight = true;
  claimAndRunBotAction(roomId, room, players)
    .catch(() => {})
    .finally(() => {
      botActionInFlight = false;
    });
}

/**
 * Debounced entry point called from the room/players listeners. Coalesces bursts (room and
 * players updating together, or several bot moves in a row) into one attempt, and jitters it
 * slightly so multiple connected clients don't all open the write transaction in the same
 * instant — Firestore resolves the resulting race safely either way, this just avoids paying
 * for guaranteed-wasted contention retries. A bot's turn naturally chains: each committed
 * action changes room/players, which re-fires this listener for the next move.
 */
function triggerBotCheck(roomId: string, get: () => GameStore): void {
  if (botTriggerTimeout) return;
  botTriggerTimeout = setTimeout(() => {
    botTriggerTimeout = null;
    runBotActionIfDue(roomId, get);
  }, Math.random() * BOT_TRIGGER_JITTER_MS);
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

    unsubscribers.push(
      subscribeRoom(roomId, (room) => {
        set({ room });
        triggerBotCheck(roomId, get);
      })
    );
    unsubscribers.push(
      subscribePlayers(roomId, (players) => {
        set({ players });
        triggerBotCheck(roomId, get);
      })
    );
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

    // Every connected client can drive bot turns (claimAndRunBotAction is transaction-safe
    // against others doing the same), but only reactively — see triggerBotCheck. This
    // low-frequency timer is purely a safety net for edge cases the listeners could miss
    // (e.g. joining mid-bot-turn before any state change fires, or a stalled write).
    botFallbackTimer = setInterval(() => runBotActionIfDue(roomId, get), BOT_FALLBACK_MS);
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

  dispatchQuiet: async (action) => {
    const { roomId } = get();
    if (!roomId) return;
    await fbDispatchAction(roomId, action).catch(() => {});
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
