import { create } from 'zustand';
import type { RoomState, PublicPlayer, PrivateHand, TradeOffer, GameAction } from '@catan/engine';
import { TRADE_EXPIRY_MS } from '@catan/engine';
import {
  subscribeRoom,
  subscribePlayers,
  subscribeOwnHand,
  subscribeTrades,
  subscribeChat,
  dispatchAction as fbDispatchAction,
  claimAndRunBotAction,
  claimAndRunOffTurnBotTrade,
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

// A bot that isn't currently the active player still reacts to a trade proposed to it (or
// open to everyone) — see claimAndRunOffTurnBotTrade — but only after a human-like pause,
// randomized within this window so several bots eligible for the same open trade don't all
// answer in the same instant. Reuses the same reactive-listener + low-frequency-fallback
// pattern as the current-turn bot driver above, just with a randomized delay. Capped well
// under 5s so a player-initiated trade always gets a bot response quickly.
const BOT_TRADE_RESPONSE_DELAY_MIN_MS = 1000;
const BOT_TRADE_RESPONSE_DELAY_MAX_MS = 5000;
// Small buffer added past a trade's exact TTL deadline before we report its expiry, purely
// so the scheduled check reliably fires after (never right at/just before) the deadline.
const TRADE_EXPIRY_CHECK_BUFFER_MS = 250;

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

// Off-turn bot trade responses: per-bot-uid scheduled "consider this trade" timer, so a bot
// waits out its randomized reaction delay exactly once per candidate trade rather than
// re-rolling the delay on every listener re-fire. Keyed by botUid (a bot only ever has one
// live candidate trade to react to at a time — see findRespondableTrade).
const offTurnBotTradeTimers = new Map<string, { tradeId: string; timeout: ReturnType<typeof setTimeout> }>();
const offTurnBotTradeInFlight = new Set<string>();

// Trade-offer expiry: a single scheduled check timed to fire just after whichever pending
// trade is closest to aging out, rather than a tight poll — recomputed whenever the trade
// list changes. BOT_FALLBACK_MS's existing safety-net interval also nudges this in case a
// scheduled timeout gets lost (e.g. a backgrounded/throttled tab).
let tradeExpiryTimer: ReturnType<typeof setTimeout> | null = null;

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
  for (const { timeout } of offTurnBotTradeTimers.values()) clearTimeout(timeout);
  offTurnBotTradeTimers.clear();
  offTurnBotTradeInFlight.clear();
  if (tradeExpiryTimer) {
    clearTimeout(tradeExpiryTimer);
    tradeExpiryTimer = null;
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
  const { roomId: currentRoomId, room, players, trades } = get();
  if (currentRoomId !== roomId || !room || !isBotTurn(room, players)) return;
  botActionInFlight = true;
  claimAndRunBotAction(roomId, room, players, trades)
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

// ---------------------------------------------------------------------------
// Off-turn bot trade responses
// ---------------------------------------------------------------------------

/** Same "is there something for this bot to react to" predicate decideTradeResponse itself
 * uses internally — duplicated here (rather than imported) since it's just a cheap filter
 * used to decide whether to schedule a delayed check, not a game-rule decision. */
function findRespondableTrade(trades: TradeOffer[], botUid: string): TradeOffer | undefined {
  return trades.find(
    (t) => t.status === 'pending' && t.proposerUid !== botUid && (t.targetUid === botUid || t.targetUid === null),
  );
}

function runOffTurnBotTradeIfDue(roomId: string, botUid: string, get: () => GameStore): void {
  if (offTurnBotTradeInFlight.has(botUid)) return;
  const { roomId: currentRoomId, room, players, trades } = get();
  if (currentRoomId !== roomId || !room) return;
  offTurnBotTradeInFlight.add(botUid);
  claimAndRunOffTurnBotTrade(roomId, room, players, trades, botUid)
    .catch(() => {})
    .finally(() => {
      offTurnBotTradeInFlight.delete(botUid);
    });
}

/**
 * For every bot seated in the room that isn't the current player, checks whether it has a
 * trade worth reacting to and, if so, arms a one-shot timer (randomized within
 * BOT_TRADE_RESPONSE_DELAY_*_MS) that fires claimAndRunOffTurnBotTrade for it — so the
 * response lands after a human-like pause rather than instantly. Re-fires on every
 * room/players/trades update, but only actually (re)schedules when the candidate trade for a
 * given bot has changed, so a burst of unrelated updates doesn't keep resetting the clock.
 */
function triggerOffTurnBotTradeChecks(roomId: string, get: () => GameStore): void {
  const { roomId: currentRoomId, room, players, trades } = get();
  if (currentRoomId !== roomId || !room || room.status !== 'playing') return;
  const currentUid = room.turnOrder[room.currentPlayerIndex];

  for (const [botUid, player] of Object.entries(players)) {
    if (!player.isBot || botUid === currentUid) {
      const scheduled = offTurnBotTradeTimers.get(botUid);
      if (scheduled) {
        clearTimeout(scheduled.timeout);
        offTurnBotTradeTimers.delete(botUid);
      }
      continue;
    }

    const candidate = findRespondableTrade(trades, botUid);
    const scheduled = offTurnBotTradeTimers.get(botUid);
    if (!candidate) {
      if (scheduled) {
        clearTimeout(scheduled.timeout);
        offTurnBotTradeTimers.delete(botUid);
      }
      continue;
    }
    if (scheduled && scheduled.tradeId === candidate.id) continue; // already waiting out the delay for this exact trade

    if (scheduled) clearTimeout(scheduled.timeout);
    const delay =
      BOT_TRADE_RESPONSE_DELAY_MIN_MS + Math.random() * (BOT_TRADE_RESPONSE_DELAY_MAX_MS - BOT_TRADE_RESPONSE_DELAY_MIN_MS);
    const timeout = setTimeout(() => {
      offTurnBotTradeTimers.delete(botUid);
      runOffTurnBotTradeIfDue(roomId, botUid, get);
    }, delay);
    offTurnBotTradeTimers.set(botUid, { tradeId: candidate.id, timeout });
  }
}

// ---------------------------------------------------------------------------
// Trade-offer expiry
// ---------------------------------------------------------------------------

function runTradeExpiryIfDue(roomId: string, get: () => GameStore): void {
  const { roomId: currentRoomId, room, uid, trades } = get();
  if (currentRoomId === roomId && room?.status === 'playing' && uid) {
    const now = Date.now();
    if (trades.some((t) => t.status === 'pending' && now - t.createdAt >= TRADE_EXPIRY_MS)) {
      void fbDispatchAction(roomId, { type: 'expireTrades', uid }).catch(() => {});
    }
  }
  scheduleTradeExpiryCheck(roomId, get);
}

/**
 * (Re)arms a single timer targeted at whichever currently-pending trade will age out
 * soonest, rather than polling on a fixed cadence. Safe to call repeatedly (e.g. on every
 * trades-listener update) — always clears any previously-scheduled check first, so the
 * timer stays in sync with the current pending set.
 */
function scheduleTradeExpiryCheck(roomId: string, get: () => GameStore): void {
  if (tradeExpiryTimer) {
    clearTimeout(tradeExpiryTimer);
    tradeExpiryTimer = null;
  }
  const { roomId: currentRoomId, room, trades } = get();
  if (currentRoomId !== roomId || room?.status !== 'playing') return;

  const now = Date.now();
  const deadlines = trades.filter((t) => t.status === 'pending').map((t) => t.createdAt + TRADE_EXPIRY_MS);
  if (deadlines.length === 0) return;
  const delay = Math.max(0, Math.min(...deadlines) - now) + TRADE_EXPIRY_CHECK_BUFFER_MS;
  tradeExpiryTimer = setTimeout(() => runTradeExpiryIfDue(roomId, get), delay);
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
        triggerOffTurnBotTradeChecks(roomId, get);
      })
    );
    unsubscribers.push(
      subscribePlayers(roomId, (players) => {
        set({ players });
        triggerBotCheck(roomId, get);
        triggerOffTurnBotTradeChecks(roomId, get);
      })
    );
    unsubscribers.push(
      subscribeTrades(roomId, (trades) => {
        set({ trades });
        triggerOffTurnBotTradeChecks(roomId, get);
        scheduleTradeExpiryCheck(roomId, get);
      })
    );
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
    // (e.g. joining mid-bot-turn before any state change fires, or a stalled write). Also
    // doubles as the safety net for off-turn bot trade responses and trade expiry, whose own
    // scheduled timers could similarly be lost (backgrounded/throttled tab, missed listener
    // fire on room join, ...).
    botFallbackTimer = setInterval(() => {
      runBotActionIfDue(roomId, get);
      triggerOffTurnBotTradeChecks(roomId, get);
      scheduleTradeExpiryCheck(roomId, get);
    }, BOT_FALLBACK_MS);
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
