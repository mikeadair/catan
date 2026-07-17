# Handoff: remaining trade/pause bugs

Session context: this follows a bot-AI overhaul, a fog-of-war board redesign, and a 6-item
visual-polish pass (all committed — see git log up to `07986db`). Two issues remain open.

## Issue 1 (new, confirmed via HAR) — client spams the server while paused

**Evidence:** `mikeadair-catan.web.app.har` (captured live, 22s window) shows 90 `POST` calls to
`submitAction` with `{"type":"timeoutTradeResponse", ...}`, roughly every 250ms, every single one
rejected server-side with `400 {"error":{"message":"Game is paused","status":"FAILED_PRECONDITION"}}`.

**Root cause:** `web/src/state/store.ts` — neither of these two scheduled-timeout checkers
accounts for `room.paused`:

- `runTradeExpiryIfDue` (~line 248)
- `runTradeResponseTimeoutIfDue` (~line 295)

Both gate only on `room?.status === 'playing'`, which stays `'playing'` while paused (pause is a
separate boolean, not a status change). Each function dispatches its timeout action when
"overdue," then unconditionally reschedules itself via
`Math.max(0, deadline - now) + TRADE_EXPIRY_CHECK_BUFFER_MS`. Once the deadline is in the past,
that collapses to just the ~250ms buffer — so once a pending trade's response deadline passes
during a pause, the client fires `timeoutTradeResponse` (or `expireTrades`) every ~250ms,
forever, since pausing never lets the deadline resolve.

**Fix direction:** add a `!room.paused` guard in both functions — either skip the dispatch+
reschedule entirely while paused (relying on the reactive room listener, which already calls
`scheduleTradeExpiryCheck`/`scheduleTradeResponseTimeoutCheck` — confirm those are re-armed on
unpause), or reschedule at a long fallback interval while paused instead of the tight buffer.

**Also worth spot-checking:** Game.tsx's other timeout paths (turn timer, robber, discard,
setup-phase, AFK auto-roll) for the same missing-pause-guard pattern. Not confirmed by this HAR
capture, but the same class of bug. `DiscardModal.tsx` already threads `paused`/`pausedAt`
through to its `TurnTimer`, which suggests those may already be handled correctly — unverified
this session.

## Issue 2 (in progress, not yet fixed) — bots still loop on a rejected trade across turns

`packages/engine/src/bots.ts`'s `alreadyTriedThisTurn` (added this session) only dedupes an
**exact** give/receive match **within the same turn** — confirmed correct for that narrow case
(see the two new tests in `bots.test.ts`: "does not re-propose an identical open trade already
rejected earlier this turn" / "proposes the same trade again once a new turn has started").

What it doesn't cover, and what's most likely behind the user's report ("bot still enters loop
when it's wanting to make a certain trade and it's declined"): `decideMainAction` recomputes
`buildPriorityCosts` fresh every turn, so if a bot is perpetually one resource short (nobody ever
supplies it), it proposes again **every single turn** — and since an earlier fix this session
(store.ts's `triggerBotCheck` wiring) made turns resolve much faster, that now reads as a tight
loop even though it's technically "once per turn."

Two compounding factors to check:

1. The dedup key (`sameTradeShape`) is an exact `give`+`receive` match — if the bot's hand
   composition shifts turn-to-turn (e.g. it also has an unrelated bank trade go through), the
   `give` side can differ even when the underlying ask (`receive`) is identical, defeating the
   dedup entirely.
2. There's no cross-turn cooldown at all — `TradeOffer` (`packages/engine/src/types.ts:182`) has
   no `proposedTurn`/similar field to compare against `room.turnNumber`.

**Fix direction (not yet implemented):**
- Add a `proposedTurn?: number` field to `TradeOffer` in `types.ts`.
- Set it in `rules.ts`'s `proposeTrade` handler from `room.turnNumber`.
- Widen the bot-side dedup in `bots.ts` from "this turn only" (`t.createdAt >= room.turnStartedAt`)
  to "rejected within the last N turns" (`room.turnNumber - t.proposedTurn <= N`), and/or key the
  dedup on the `receive` side alone (the actual ask) rather than requiring an exact `give` match
  too, so a shifted `give` combination for the same underlying need still gets deduped.
- Pick `N` (a few turns feels right — enough to stop the tight loop, not so long a genuinely
  changed situation never gets retried).

No code changes for either issue are in the working tree — this file is the only artifact from
this investigation. Everything else from the session is already committed (see `git log`).
