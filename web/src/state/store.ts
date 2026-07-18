import { create } from 'zustand';
import type { RoomState, PublicPlayer, PrivateHand, TradeOffer, GameAction } from '@catan/engine';
import { TRADE_EXPIRY_MS, RoomStatus, predictAction } from '@catan/engine';
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
// rather than an unconditional poll — see runBotActionIfDue/triggerBotCheck below. This is
// NOT a "human-like pause" (that's BOT_TRADE_RESPONSE_DELAY_*_MS's job, for off-turn trade
// responses specifically) — it exists purely so two clients with the same room open don't
// both open a write transaction in the very same instant, and every ms of it is dead air
// stacked onto the real network round trip of every single bot action in a turn (build road,
// build settlement, buy dev card, ...), which adds up fast across a multi-action turn. Kept
// tiny rather than zero so the anti-collision purpose still does something.
const BOT_TRIGGER_JITTER_MS = 40;
const BOT_FALLBACK_MS = 15000;
const HEARTBEAT_MS = 15000;
const LAST_ROOM_KEY = 'catan.lastRoomId';

// A bot that isn't currently the active player still reacts to a trade proposed to it (or
// open to everyone) — see claimAndRunOffTurnBotTrade — but only after a human-like pause,
// randomized within this window so several bots eligible for the same open trade don't all
// answer in the same instant. Reuses the same reactive-listener + low-frequency-fallback
// pattern as the current-turn bot driver above, just with a randomized delay. Short enough
// that a player-initiated trade reliably gets a bot response well under a couple seconds
// (a longer window here made every trade feel sluggish, on top of the already-real network
// round trip for the read + submitActionCallable in claimAndRunOffTurnBotTrade).
const BOT_TRADE_RESPONSE_DELAY_MIN_MS = 300;
const BOT_TRADE_RESPONSE_DELAY_MAX_MS = 1200;
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

// `trades: []` in the store is genuinely ambiguous: it means either "this room really has no
// trades" or "subscribeTrades hasn't delivered its first snapshot yet" (enterRoom resets it to
// `[]` immediately, before any listener has fired). Bot-driving logic that reasons about trade
// history (avoiding a repeat of an already-rejected proposal, not re-answering something
// already resolved, ...) needs to tell those apart — reacting on the empty-because-not-loaded
// case caused a real bug: right after a client (re)connects/refreshes, if the room/players
// listeners deliver their first snapshot before trades does, the bot would run with a
// still-empty trades list, "forget" every trade that had actually already been proposed and
// rejected, and re-propose it — visibly as a burst of duplicate trades right after a refresh.
// Set true the first time subscribeTrades' callback fires for the current room, reset false on
// enterRoom/teardown.
let tradesReady = false;

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

// Trade-response timeout (room.tradeResponseTimerSeconds): same single-scheduled-timer
// pattern as trade expiry just above, just keyed off each pending trade's still-unanswered
// responders rather than the trade's own overall TTL.
let tradeResponseTimeoutTimer: ReturnType<typeof setTimeout> | null = null;

// Bumped every time any game-state listener (room/players/trades/ownHand) delivers a server
// snapshot. dispatch()'s optimistic overlay records the epoch it was applied at; its
// on-error rollback only restores the pre-prediction copy if the epoch hasn't moved, because
// any snapshot that landed in between is newer truth than that copy. (On success there's
// nothing to do: the post-action snapshots simply overwrite the overlay with the real thing,
// which for a predictable action is identical modulo server-generated ids/timestamps.)
let serverSnapshotEpoch = 0;

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
  tradesReady = false;
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
  if (tradeResponseTimeoutTimer) {
    clearTimeout(tradeResponseTimeoutTimer);
    tradeResponseTimeoutTimer = null;
  }
}

// Mirrors the gate claimAndRunBotAction itself applies (only the current player's seat is
// ever driven), computed here against state we already have locally from the room/players
// listeners — so most of the time we can tell "nothing to do" without touching Firestore.
function isBotTurn(room: RoomState | null, players: Record<string, PublicPlayer>): boolean {
  if (!room || room.status !== RoomStatus.Playing) return false;
  const currentUid = room.turnOrder[room.currentPlayerIndex];
  return !!currentUid && players[currentUid]?.isBot === true;
}

function runBotActionIfDue(roomId: string, get: () => GameStore): void {
  if (botActionInFlight || !tradesReady) return;
  const { roomId: currentRoomId, room, players, trades } = get();
  // Server rejects every action while paused, so don't bother attempting bot moves — the
  // room listener re-triggers this on unpause.
  if (currentRoomId !== roomId || !room || room.paused || !isBotTurn(room, players)) return;
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
  if (offTurnBotTradeInFlight.has(botUid) || !tradesReady) return;
  const { roomId: currentRoomId, room, players, trades } = get();
  if (currentRoomId !== roomId || !room || room.paused) return;
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
  if (currentRoomId !== roomId || !room || room.status !== RoomStatus.Playing) return;
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
  if (currentRoomId === roomId && room?.status === RoomStatus.Playing && !room.paused && uid) {
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
  // While paused the server rejects expireTrades ("Game is paused"), so arming a timer would
  // just spin against a deadline that can never resolve — stay dark and let the room
  // listener re-arm on unpause.
  if (currentRoomId !== roomId || room?.status !== RoomStatus.Playing || room.paused) return;

  const now = Date.now();
  const deadlines = trades.filter((t) => t.status === 'pending').map((t) => t.createdAt + TRADE_EXPIRY_MS);
  if (deadlines.length === 0) return;
  const delay = Math.max(0, Math.min(...deadlines) - now) + TRADE_EXPIRY_CHECK_BUFFER_MS;
  tradeExpiryTimer = setTimeout(() => runTradeExpiryIfDue(roomId, get), delay);
}

// ---------------------------------------------------------------------------
// Trade-response timeout
// ---------------------------------------------------------------------------

/** Same predicate rules.ts's pendingTradeResponders uses server-side to decide who's still on
 * the hook for a trade (duplicated here, not imported, since it's just a cheap filter for
 * deciding whether to schedule a check — the real decision is re-validated server-side by
 * applyAction, never trusted from here). */
function hasPendingResponders(trade: TradeOffer, players: Record<string, PublicPlayer>): boolean {
  if (trade.targetUid !== null) return true; // caller already filtered to status === 'pending'
  const interested = new Set(trade.interestedUids ?? []);
  const rejected = new Set(trade.rejectedUids ?? []);
  return Object.keys(players).some((uid) => uid !== trade.proposerUid && !interested.has(uid) && !rejected.has(uid));
}

function runTradeResponseTimeoutIfDue(roomId: string, get: () => GameStore): void {
  const { roomId: currentRoomId, room, uid, trades, players } = get();
  if (currentRoomId === roomId && room?.status === RoomStatus.Playing && !room.paused && uid && room.tradeResponseTimerSeconds !== null) {
    const now = Date.now();
    const deadlineMs = room.tradeResponseTimerSeconds * 1000;
    const anyOverdue = trades.some(
      (t) => t.status === 'pending' && now - t.createdAt >= deadlineMs && hasPendingResponders(t, players),
    );
    if (anyOverdue) {
      void fbDispatchAction(roomId, { type: 'timeoutTradeResponse', uid }).catch(() => {});
    }
  }
  scheduleTradeResponseTimeoutCheck(roomId, get);
}

/**
 * (Re)arms a single timer targeted at whichever pending trade with an unanswered responder
 * will time out soonest, rather than polling on a fixed cadence — same shape as
 * scheduleTradeExpiryCheck just above, just keyed off room.tradeResponseTimerSeconds instead
 * of the fixed TRADE_EXPIRY_MS, and skipping trades every eligible responder has already
 * answered (nothing left to time out there).
 */
function scheduleTradeResponseTimeoutCheck(roomId: string, get: () => GameStore): void {
  if (tradeResponseTimeoutTimer) {
    clearTimeout(tradeResponseTimeoutTimer);
    tradeResponseTimeoutTimer = null;
  }
  const { roomId: currentRoomId, room, trades, players } = get();
  // Same paused rationale as scheduleTradeExpiryCheck above.
  if (currentRoomId !== roomId || room?.status !== RoomStatus.Playing || room.paused || room.tradeResponseTimerSeconds === null) return;

  const now = Date.now();
  const deadlineMs = room.tradeResponseTimerSeconds * 1000;
  const deadlines = trades
    .filter((t) => t.status === 'pending' && hasPendingResponders(t, players))
    .map((t) => t.createdAt + deadlineMs);
  if (deadlines.length === 0) return;
  const delay = Math.max(0, Math.min(...deadlines) - now) + TRADE_EXPIRY_CHECK_BUFFER_MS;
  tradeResponseTimeoutTimer = setTimeout(() => runTradeResponseTimeoutIfDue(roomId, get), delay);
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
        serverSnapshotEpoch += 1;
        set({ room });
        triggerBotCheck(roomId, get);
        triggerOffTurnBotTradeChecks(roomId, get);
        // Pause/unpause only touches the room doc, and the trade timers deliberately stay
        // unarmed while paused — re-arm here so unpause doesn't wait for the trades
        // listener or the BOT_FALLBACK_MS safety net.
        scheduleTradeExpiryCheck(roomId, get);
        scheduleTradeResponseTimeoutCheck(roomId, get);
      })
    );
    unsubscribers.push(
      subscribePlayers(roomId, (players) => {
        serverSnapshotEpoch += 1;
        set({ players });
        triggerBotCheck(roomId, get);
        triggerOffTurnBotTradeChecks(roomId, get);
      })
    );
    unsubscribers.push(
      subscribeTrades(roomId, (trades) => {
        serverSnapshotEpoch += 1;
        set({ trades });
        tradesReady = true;
        // A trade being proposed/accepted/rejected/cancelled only ever touches the trades
        // subcollection, never the room or players docs — so without this, the CURRENT
        // player's own bot driver (triggerBotCheck, wired to subscribeRoom/subscribePlayers
        // below) was never reactively woken by, say, everyone rejecting its own open trade.
        // It would just sit on decideMainAction's "still waiting" branch until the next
        // BOT_FALLBACK_MS (15s) safety-net tick caught up — a real, repeatable stall between
        // a bot's trade getting declined and it doing anything else that turn.
        triggerBotCheck(roomId, get);
        triggerOffTurnBotTradeChecks(roomId, get);
        scheduleTradeExpiryCheck(roomId, get);
        scheduleTradeResponseTimeoutCheck(roomId, get);
      })
    );
    unsubscribers.push(subscribeChat(roomId, (chat) => set({ chat })));

    const uid = get().uid;
    if (uid) {
      unsubscribers.push(
        subscribeOwnHand(roomId, uid, (ownHand) => {
          serverSnapshotEpoch += 1;
          set({ ownHand });
        })
      );
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
      scheduleTradeResponseTimeoutCheck(roomId, get);
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
    const { roomId, uid, room, players, trades, ownHand } = get();
    if (!roomId) return;

    // Optimistic overlay: render the engine's locally-computed result of this action now
    // instead of after the callable round trip + snapshot fan-out. predictAction returns
    // null for anything it can't compute faithfully (randomness, hidden hands, illegal
    // moves) — those dispatches stay a plain round trip, exactly as before. The server
    // remains the sole authority: its snapshots overwrite the overlay either way.
    //
    // Known cosmetic tradeoff: a predicted proposeTrade carries a locally-generated trade
    // id the server's own doc then replaces, so that one row can remount on confirm.
    // The bot-driver timers may also briefly read overlaid state; harmless, since every
    // bot submission is re-validated inside submitAction's transaction.
    let rollback: (() => void) | null = null;
    if (uid && room && ownHand && room.status === RoomStatus.Playing) {
      const predicted = predictAction({ room, players, trades, uid, ownHand }, action);
      if (predicted) {
        const prev = { room, players, trades, ownHand };
        const epochAtOverlay = serverSnapshotEpoch;
        set({
          room: predicted.room,
          players: predicted.players,
          trades: predicted.trades,
          ownHand: predicted.hands[uid],
        });
        rollback = () => {
          if (serverSnapshotEpoch === epochAtOverlay) set(prev);
        };
      }
    }

    try {
      await fbDispatchAction(roomId, action);
    } catch (err) {
      rollback?.();
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
