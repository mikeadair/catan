# Upgrade plan & status

Working tracker for the July 2026 feature batch. Update the status column as work lands.
Order below is execution order (top to bottom), chosen so that changes touching the same
files are grouped/serialized and independent-file changes can run in parallel.

Legend: `todo` / `in-progress` / `done` / `blocked`

## Phase 0 — CI / Deploy

| # | Item | Status | Notes |
|---|------|--------|-------|
| 0.1 | Deploy pipeline green | done | Root cause was GCP-project config, not workflow YAML: (a) Cloud Billing API was never enabled on `mikeadair-catan` (fixed: `gcloud services enable cloudbilling.googleapis.com`), (b) the `github-deploy` CI service account was missing `roles/iam.serviceAccountUser` on the default compute service account, required for Cloud Functions v2/Cloud Run deploys (fixed via `gcloud iam service-accounts add-iam-policy-binding`). Verified green on a fresh run (build-and-test + deploy both succeeded). |
| 0.2 | e2e/screenshot job | todo (low priority) | Fails in CI now too (previously believed WSL2-local-only per CLAUDE.md): Functions emulator crashes on `startGame` invocation ("killed because it raised an unhandled error") partway through `layout.spec.ts`. Does NOT block `deploy` (separate parallel job, both only depend on `build-and-test`). Deferred until after feature work per explicit instruction. |

## Phase 1 — parallel-safe workstreams (independent files)

| # | Item | Status | Files | Notes |
|---|------|--------|-------|-------|
| 1.A | Lobby redesign: settings panel moves beside room code/players, inline-editable (no Edit gate), map picker becomes a preview grid (supersedes "dropdown with preview" ask per user's own follow-up) | done | `web/src/routes/Lobby.tsx/css`, `MapPickerGrid.tsx/css`, `MapPreview.tsx/css` (`variant="thumbnail"`) | Built by a background agent, merged. Two-column CSS grid layout, settings write straight to Firestore per-change (host only; read-only disabled inputs for guests), map grid reuses live `MapPreview`/`Board` rendering at thumbnail size rather than a separate simplified renderer. |
| 1.B | Auth: email/password + email-link (passwordless) sign-in as alternative to guest, save preferred name+color to account | done | `web/src/firebase/auth.ts`, `web/src/firebase/users.ts` (new), `web/src/routes/Home.tsx/css`, `firestore.rules` + `firestore-tests/rules.test.ts` | Built by a background agent, merged. `linkWithCredential` upgrades the anonymous user in place; falls back to `signInWithCredential` on `auth/email-already-in-use` (abandons current anonymous session's room membership in that edge case, by design). `users/{uid}` doc stores `{displayName, color}`; `createRoom`/`joinRoom` now accept a `preferredColor` that `assignSeat` honors when free. |

## Phase 2 — in-game UI cluster (serialized: all touch Game.tsx/Game.css)

| # | Item | Status | Files | Notes |
|---|------|--------|-------|-------|
| 2.A | Bottom bar always visible during a live game (incl. setup), not just roll/main | done | `Game.tsx`, `Game.css` | Toolbar is unconditionally mounted/visible now (`gameOver` already returns before reaching it); only `DiceRoller` still gates on `phase === 'roll' \| 'main'` (`showDiceRoller`). Removed the old opacity/visibility hidden-class machinery entirely. |
| 2.B | Build buttons: bigger, add icons | done | `BuildToolbar.tsx/css`, `gameIcons.tsx` (new) | One SVG icon per action, bumped padding/min-width. |
| 2.C | Move "pieces remaining" (roads/settlements/cities left) from PlayerRoster to next to the build buttons | done | `BuildToolbar.tsx`, `PlayerRoster.tsx`, `Game.tsx` | `piecesLeft` computed once in `Game.tsx` from `players[uid]`, passed into `BuildToolbar`; self-only pieces row removed from `PlayerRoster`. |
| 2.D | Bank resource counts get card-wrapper styling like a player's hand | done | `BankPanel.tsx/css` | One small card tile per resource *type* (icon+count+label), not a per-unit fan — bank counts run to ~19, so per-unit fanning (like the hand) would overflow the 320px sidebar; this reads as "card-style" per the reference image without that problem. |
| 2.E | Players list: replace emoji stat icons with real icon set | done | `PlayerRoster.tsx/css`, `gameIcons.tsx` | Emoji swapped for the shared SVG icon set (`currentColor`-based, themeable). |
| 2.F | Trade redesign: drop the popover modal for an inline panel — Trade button+icon left of hand, "cards you want" request row above it, Offer-trade / Bank-trade buttons to the right (bank-trade grayed out until a valid bank/port ratio offer exists) | done | New `TradeBar.tsx/css` replacing `TradePanel.tsx/css` (deleted) in `Game.tsx` | Simplification: the "give" side is a chip-style stepper selector inside the expanded trade panel (not the read-only hand cards themselves becoming clickable) — keeps the always-visible hand display unchanged and avoids a riskier rework of `ResourceHand`'s card variant for in-place selection. Bank Trade enables only when give/receive is exactly one resource each at a valid N:1 rate. |
| 2.G | Sidebar-left / sound-icon overlap | done | `Game.css` (`.game--sidebar-left .game__sidebar-top`) | `padding-left: 44px` on the sidebar-top row when flipped left, clearing the fixed sound button's ~36px footprint. |

## Phase 3 — timer/pause engine work (serialized: all touch `rules.ts`/`types.ts`/`submitAction.ts`)

| # | Item | Status | Files | Notes |
|---|------|--------|-------|-------|
| 3.A | Dice auto-roll after 15s AFK | todo | `Game.tsx` or new hook, no server change needed | Client-side: when `room.phase === 'roll' && isCurrentPlayer` and `Date.now() - turnStartedAt > 15000`, auto-dispatch `rollDice`. Mirrors the existing reactive bot-driving pattern (commit "Drive bot turns reactively..."). |
| 3.B | Turn timer expiry skips the turn | todo | `packages/engine/src/rules.ts` (new `timeoutEndTurn` action), `functions/src/submitAction.ts` | No Cloud Scheduler exists — avoid adding one. New action type any authenticated room member may submit (not just the active player); server re-validates `now - room.turnStartedAt >= room.turnTimerSeconds*1000` before applying (prevents a malicious early-timeout call). Client: any player's browser auto-dispatches this once local countdown hits 0; server is naturally idempotent (rejects if turn already advanced). |
| 3.C | Pause vote (non-bot players, ≥50% to pause/unpause) | todo | `types.ts` (`RoomState.paused`, `pauseVotes: string[]`), `rules.ts` (`voteToPause`/`voteToUnpause` reducers + majority calc over non-bot `turnOrder` members), `functions/src/submitAction.ts`, new `PauseControl` UI component | While `paused`, `TurnTimer` and the 15s AFK auto-roll (3.A) must freeze — simplest approach: freeze by tracking accumulated paused-duration and excluding it from elapsed-time math, or (simpler) reset `turnStartedAt` forward by the pause duration on unpause. Majority = `ceil(nonBotCount / 2)` votes to flip state. |

## Phase 4 — new map features (serialized after Phase 3, same files: `board.ts`/`rules.ts`/`types.ts`)

| # | Item | Status | Files | Notes |
|---|------|--------|-------|-------|
| 4.A | Gold tile (new terrain) | todo | `packages/engine/src/board.ts` (new `'gold'` Terrain, setup-phase adjacency restriction so it can't be settled at game start), `rules.ts` (roll production: rolling a gold hex's number grants adjacent settlement/city owners a pending "pick 1 resource" choice, 2 for a city, instead of automatic distribution), `types.ts` (pending-choice state), new client resource-picker modal (reuse Year-of-Plenty modal pattern) | Scope as MVP: one gold hex on `balanced-random`/`chaos`/new fog map; no port on a gold hex. |
| 4.B | Fog-of-war map (new preset) | todo | `board.ts` (new `'fog-of-war'` preset: corner clusters + desert visible, rest hidden), `types.ts` (`RoomState.discoveredHexIds` or per-hex reveal flag), `rules.ts` (road-build reducer checks newly-reachable hex ids, reveals terrain + assigns a **randomized-at-discovery** number token, grants discovering player 1 of that resource), `mapPresets.ts`, `Board.tsx` (render undiscovered hexes as a fog-styled tile), `functions/src/submitAction.ts` if any server-side reveal-authority split is needed | Biggest scope item in the whole batch. MVP: terrain type is fixed upfront per-hex (not randomized at discovery) but hidden from rendering; **only the number token** is assigned randomly at discovery time, matching "the number on it is completely random." Desert and the 4 corner 6-hex clusters are revealed from game start. |

## Phase 5 — e2e tests (deferred, low priority per instruction)

| # | Item | Status | Notes |
|---|------|--------|-------|
| 5.A | Fix Functions-emulator crash in CI `capture-screenshots` job | todo | Revisit only after Phases 1-4 are done. |

## Decisions made unilaterally (to avoid round-tripping questions)

- Trade redesign (2.F) supersedes the separate always-visible `TradeOffers` sidebar panel only for the *propose* flow — pending-trade accept/reject stays in the sidebar as-is (out of scope, not mentioned by user).
- Map preview grid (1.A) replaces the dropdown-with-preview ask entirely, since the user's own last bullet explicitly proposed the grid as a better alternative.
- Auth (1.B): anonymous→permanent upgrade via `linkWithCredential`, not a parallel identity system, to avoid a uid-migration project.
- Bank cards (2.D): one card per resource *type* showing a total count, not one card per unit owned — see note above.
- Trade bar (2.F) give-selector uses stepper chips, not click-to-select on the hand itself — see note above.
- Pause (3.C): majority threshold computed over **non-bot** turnOrder members only, per explicit instruction; bots never vote and are not in the denominator.
- Gold tile (4.A) and fog-of-war (4.B) are both new, additive map/terrain concepts — implemented without touching the existing 4 presets' behavior.
