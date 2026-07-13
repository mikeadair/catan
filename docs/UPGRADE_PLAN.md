# Upgrade plan & status

Working tracker for the July 2026 feature batch. Update the status column as work lands.
Order below is execution order (top to bottom), chosen so that changes touching the same
files are grouped/serialized and independent-file changes can run in parallel.

Legend: `todo` / `in-progress` / `done` / `blocked`

## Phase 0 — CI / Deploy

| # | Item | Status | Notes |
|---|------|--------|-------|
| 0.1 | Deploy pipeline green | done | Root cause was GCP-project config, not workflow YAML: (a) Cloud Billing API was never enabled on `mikeadair-catan` (fixed: `gcloud services enable cloudbilling.googleapis.com`), (b) the `github-deploy` CI service account was missing `roles/iam.serviceAccountUser` on the default compute service account, required for Cloud Functions v2/Cloud Run deploys (fixed via `gcloud iam service-accounts add-iam-policy-binding`). Verifying with a fresh run now. |
| 0.2 | e2e/screenshot job | todo (low priority) | Fails in CI now too (previously believed WSL2-local-only per CLAUDE.md): Functions emulator crashes on `startGame` invocation ("killed because it raised an unhandled error") partway through `layout.spec.ts`. Does NOT block `deploy` (separate parallel job, both only depend on `build-and-test`). Deferred until after feature work per explicit instruction. |

## Phase 1 — parallel-safe workstreams (independent files)

| # | Item | Status | Files | Notes |
|---|------|--------|-------|-------|
| 1.A | Lobby redesign: settings panel moves beside room code/players, inline-editable (no Edit gate), map picker becomes a preview grid (supersedes "dropdown with preview" ask per user's own follow-up) | todo | `web/src/routes/Lobby.tsx/css`, new `MapPickerGrid` component, `packages/engine/src/mapPresets.ts` (add thumbnail metadata) | Two-column layout: left = room code + players (unchanged), right = settings, always in edit-mode for host (no view/edit toggle), live-saving with debounce like today's live map preview. |
| 1.B | Auth: email/password + email-link (passwordless) sign-in as alternative to guest, save preferred name+color to account | todo | `web/src/firebase/auth.ts`, new `SignIn`/`AuthPanel` component, `web/src/routes/Home.tsx`, new Firestore `users/{uid}` profile doc + `firestore.rules` | User confirmed providers are already enabled in Firebase console. Anonymous uid is currently the durable identity everywhere (rooms/turnOrder) — use `linkWithCredential` to upgrade an anonymous user in place (preserves uid, no migration needed) rather than a separate sign-in identity. Store `{displayName, color}` on `users/{uid}`, prefill Home's create/join form when signed in non-anonymously. |

## Phase 2 — in-game UI cluster (serialized: all touch Game.tsx/Game.css)

| # | Item | Status | Files | Notes |
|---|------|--------|-------|-------|
| 2.A | Bottom bar always visible during a live game (incl. setup), not just roll/main | todo | `Game.tsx` (`showBottomBar`), `Game.css` | Show the toolbar frame throughout `setup1/setup2/roll/main/robber/discard`; build buttons individually disabled by phase/legality (already have `legalTypes`/`disabledReason` plumbing per BuildToolbar) rather than hiding the whole bar. Hide only on `gameOver`. |
| 2.B | Build buttons: bigger, add icons | todo | `BuildToolbar.tsx/css` | One icon per action (road/settlement/city/dev-card), reuse resource icon set (`resourceIcons.tsx`) for cost display; bump min touch target/padding. |
| 2.C | Move "pieces remaining" (roads/settlements/cities left) from PlayerRoster to next to the build buttons | todo | `BuildToolbar.tsx`, `PlayerRoster.tsx` | Remove self-only pieces-left row from `PlayerRoster.tsx:71-77`; show "N left" as a small badge under/beside each BuildToolbar button instead (data already available via `MAX_ROADS/MAX_SETTLEMENTS/MAX_CITIES - builtCount`). |
| 2.D | Bank resource counts get card-wrapper styling like a player's hand | todo | `BankPanel.tsx/css` | Reuse `ResourceHand`'s `variant="cards"` rendering instead of the current inline icon+number row. |
| 2.E | Players list: replace emoji stat icons with real icon set | todo | `PlayerRoster.tsx/css` | Same icon set as 2.B/2.D (small SVG sprite or icon component) for resources/dev-cards/VP/knights/roads, keep 🏆/🎖️/🏅 badges or replace consistently — decide during implementation, not user-facing ambiguity. |
| 2.F | Trade redesign: drop the popover modal for an inline panel — Trade button+icon left of hand, "cards you want" request row above it, Offer-trade / Bank-trade buttons to the right (bank-trade grayed out until a valid bank/port ratio offer exists) | todo | New `TradeBar` component replacing `TradePanel` popover usage in `Game.tsx`, keep `TradePanel`'s bank-rate math (`computePortRates`) | Biggest single UI rework in this batch — build as its own component, wire into the toolbar row in place of the current `game__toolbar-popovers` block. |
| 2.G | Sidebar-left / sound-icon overlap | todo | `App.css` (`.sound-toggle`), `Game.css` (`.game__sidebar-top`) | Cheapest fix: when `sidebarSide === 'left'`, shift `.game__sidebar-top`'s toggle row down/right past the fixed sound button's footprint, or move the sound toggle to a corner that never collides (e.g. always top-right). Do this first in Phase 2 since it's tiny and touches the same files. |

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
- Pause (3.C): majority threshold computed over **non-bot** turnOrder members only, per explicit instruction; bots never vote and are not in the denominator.
- Gold tile (4.A) and fog-of-war (4.B) are both new, additive map/terrain concepts — implemented without touching the existing 4 presets' behavior.
