import type { GameAction, PrivateHand, PublicPlayer, RoomState, TradeOffer } from './types';
import { applyAction, type GameStateBundle } from './rules';
import { neededHandUidsFor } from './actionHands';

// Client-side optimistic prediction of applyAction.
//
// The server (submitAction) stays the sole authority over game state; this module only
// answers "what will the server almost certainly compute for this action?" so a client can
// render the result immediately instead of waiting a full callable round trip + snapshot
// fan-out. A prediction is display state: the next server snapshot always replaces it.
//
// An action is predictable only when every input to its outcome is on the client already:
//  - no live randomness (dice, robber steals, timeout auto-picks, fog number tokens) — the
//    server rolls those with Math.random and nothing local can match them;
//  - no other player's private hand (playMonopoly, finalizeTrade, accepting a *targeted*
//    trade — the engine re-checks the proposer's hand, which this client can't see);
//  - no server-only state (buyDevCard pops serverOnly/devDeck; the client's copy of
//    room.devCardDeck is always empty).
//
// Everything else — builds, bank/player-trade bookkeeping, discards, gold picks, endTurn,
// votes — is a pure function of (room, players, trades, own hand), all of which the client
// mirrors live, so the predicted bundle matches the server's byte-for-byte apart from
// generated ids/timestamps (log entries, proposed trades) which the snapshot then corrects.

/** Thrown by the guard rng handed to applyAction: any engine path that consumes randomness
 * during a prediction aborts it (predictAction returns null) instead of silently diverging
 * from the server. This is the backstop behind canPredictAction's explicit list — a future
 * action type that adds randomness fails safe here even if the list isn't updated. */
class PredictionRandomnessError extends Error {
  constructor() {
    super('applyAction consumed randomness during a client-side prediction');
  }
}

function guardRng(): number {
  throw new PredictionRandomnessError();
}

/** Action types whose outcome depends on randomness or state the client never has. */
const NEVER_PREDICTABLE: ReadonlySet<GameAction['type']> = new Set([
  'rollDice', // dice
  'buyDevCard', // deck order is server-only
  'playMonopoly', // reads every other player's hand
  'finalizeTrade', // reads the chosen responder's hand
  'timeoutDiscard', // random auto-discard, all hands
  'timeoutRobber', // random hex pick
  'timeoutSetupPlacement', // random placement
]);

/**
 * Whether `action`'s outcome is fully determined by client-visible state. `trades` is
 * needed to distinguish accepting an open trade (interest registration, own hand only)
 * from accepting a targeted one (executes immediately, re-checking the proposer's hand).
 */
export function canPredictAction(action: GameAction, trades: TradeOffer[]): boolean {
  if (NEVER_PREDICTABLE.has(action.type)) return false;
  if ((action.type === 'playKnight' || action.type === 'moveRobber') && action.stealFromUid) {
    // The robber move itself is deterministic, but the steal draws a random card from a
    // hand the client can't see. Callers wanting instant feedback for a steal should mask
    // with animation instead.
    return false;
  }
  if (action.type === 'respondTrade' && action.accept) {
    const trade = trades.find((t) => t.id === action.tradeId);
    if (!trade || trade.targetUid !== null) return false;
  }
  return true;
}

/** What a client actually has on hand: the public room/players/trades mirrors plus its own
 * private hand. Everything predictAction needs — no other player's hand ever required. */
export interface PredictionInput {
  room: RoomState;
  players: Record<string, PublicPlayer>;
  trades: TradeOffer[];
  uid: string;
  ownHand: PrivateHand;
}

function stubHand(): PrivateHand {
  return { resources: { brick: 0, lumber: 0, ore: 0, grain: 0, wool: 0 }, devCards: [] };
}

/**
 * Optimistically applies `action` for the local player. Returns the predicted bundle, or
 * null when the action isn't predictable or the engine rejects it (illegal move, game
 * paused, randomness consumed, ...) — null always means "just wait for the server", never
 * an error to surface.
 *
 * The returned bundle's `hands` entries for OTHER players are zeroed stubs (their real
 * hands aren't on the client) — callers must only read `hands[input.uid]`. Public per-player
 * display state (players[*].resourceCount etc.) is untouched by every predictable action,
 * so rendering room/players/trades from the prediction is safe as-is. checkWin runs against
 * those stubs, so a prediction can never flag another player's hidden-VP win — the server
 * snapshot delivers that.
 */
export function predictAction(input: PredictionInput, action: GameAction): GameStateBundle | null {
  if (action.uid !== input.uid) return null;
  if (!canPredictAction(action, input.trades)) return null;
  // Belt and braces with the list above: if the engine would need any hand beyond the local
  // player's loaded (the same classification submitAction uses server-side), don't predict.
  for (const neededUid of neededHandUidsFor(action, input.room.turnOrder)) {
    if (neededUid !== input.uid) return null;
  }

  const hands: Record<string, PrivateHand> = {};
  for (const uid of input.room.turnOrder) {
    hands[uid] = uid === input.uid ? input.ownHand : stubHand();
  }
  const bundle: GameStateBundle = {
    room: input.room,
    players: input.players,
    hands,
    trades: input.trades,
  };
  try {
    // applyAction structuredClones the bundle, so input.room/players/trades/ownHand are
    // never mutated here.
    return applyAction(bundle, action, guardRng);
  } catch {
    return null;
  }
}
