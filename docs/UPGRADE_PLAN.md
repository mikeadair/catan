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
| 3.A | Dice auto-roll after 15s AFK | done | `Game.tsx`, `state/store.ts` (`dispatchQuiet`) | Current player's own client schedules a 15s timeout from `turnStartedAt`; fires via `dispatchQuiet` (new store method that mirrors the existing bot-driving `.catch(() => {})` pattern — never surfaces a race as an error toast). |
| 3.B | Turn timer expiry skips the turn | done | `packages/engine/src/rules.ts` (`timeoutEndTurn` case + `legalActionTypes`), `actionValidation.ts`, `Game.tsx` | Any room member's client can report a timeout; server re-validates `now - turnStartedAt >= turnTimerSeconds*1000` and re-derives the actually-current player server-side (never trusts which player the reporter claims timed out). Every connected client schedules the same deadline independently — races are expected and resolved server-side, losers swallowed via `dispatchQuiet`. |
| 3.C | Pause vote (non-bot players, ≥50% to pause/unpause) | done | `types.ts` (`paused`/`pausedAt`/`pauseVotes`), `rules.ts` (`voteToPause`/`voteToUnpause`, central pause guard at the top of `applyAction`), `PauseControl.tsx/css`, `TurnTimer.tsx` (freezes display), `Game.tsx` (blocks board interaction while paused) | Majority = `votes*2 >= nonBotCount` ("at least half"), computed once per vote; on unpause, `turnStartedAt` is shifted forward by the paused duration so the turn/AFK timers resume with the same time remaining they had at pause. No vote-retraction action — voting is a one-way commit per pause/unpause cycle, matching scope. |

## Phase 4 — new map features (serialized after Phase 3, same files: `board.ts`/`rules.ts`/`types.ts`)

| # | Item | Status | Files | Notes |
|---|------|--------|-------|-------|
| 4.A | Gold tile (new terrain) | done | `board.ts` (`'gold'` Terrain, folded into the new `fog-of-war` preset only — not retrofitted into the 4 stable presets), `types.ts` (`goldPick` phase, `pendingGoldPicks`, `pickGoldResources` action), `rules.ts` (roll production branches gold claims into a pending per-player pick instead of auto-distributing; setup-phase settlement placement adjacent to gold is rejected), `bots.ts` (bots fill whichever resource they're shortest on), `GoldPickModal.tsx` (reuses the Discard modal's picker pattern) | Delivered as scoped: one gold hex, only on the new `fog-of-war` preset; no port-adjacency guarantee needed in practice since gold's position isn't forced onto a boundary edge. |
| 4.B | Fog-of-war map (new preset) | done | `board.ts` (`initialFogRevealHexIds` — 6 geometric corner hexes + desert + gold revealed at generation; hidden hexes' `number` nulled out), `types.ts` (`RoomState.discoveredHexIds`), `rules.ts` (`discoverHexesAtEdge` in `buildRoad` reveals any newly-reachable hex with a **genuinely random** number token — not drawn from the board's original fairness pool — and grants the discoverer 1 of its resource), `Board.tsx` (undiscovered hexes render a generic fog fill/glyph instead of their real terrain), `mapPresets.ts`, `MapPreview.tsx` (thumbnail shows the same fog state) | "Corners having a 6 tile area" read as *the 6 corner tiles of the hex-hexagon* (one per corner) rather than 6-hex clusters per corner — the latter reading would reveal most of a 19-hex board immediately, defeating the mechanic. Terrain itself is pre-generated (present in the shared `room.board` doc, same trust model as the rest of this client-reads-are-public architecture) but not client-rendered until discovery — a rendering choice, not new anti-cheat infrastructure; only the number token is genuinely undetermined server-side pre-discovery, which is what the "completely random" requirement is actually about. |

## Phase 5 — e2e tests (deferred, low priority per instruction)

| # | Item | Status | Notes |
|---|------|--------|-------|
| 5.A | Fix Functions-emulator crash in CI `capture-screenshots` job | investigated, deferred | Reproduced locally (same sandbox class as CLAUDE.md's original WSL2 note) with `firebase-tools --debug`: the Functions emulator's worker process for `startGame` dies with only a generic "killed because it raised an unhandled error" — no stack trace surfaces through firebase-tools' own logging (`firebase-debug.log` is deleted on clean shutdown; `--debug` verbose mode still doesn't forward the worker's own stdout/stderr for this failure). `npm run test -w functions` (same `startGameHandler`, called directly, no Functions Framework HTTP layer) passes 100% both locally and in CI — confirms this is an emulator/worker-process infrastructure issue, not application logic. Checked the one previously-noted workaround (`firebase-tools` 15.x needs Java 21+): still only Java 11 available here, so unverifiable locally; whether GH Actions' own runner image has Java 21 (making the upgrade viable there even if not locally) is unconfirmed and would need its own iterate-on-CI cycle. Left deferred per explicit low-priority instruction — this does not block `deploy` (separate parallel job). |

## Decisions made unilaterally (to avoid round-tripping questions)

- Trade redesign (2.F) supersedes the separate always-visible `TradeOffers` sidebar panel only for the *propose* flow — pending-trade accept/reject stays in the sidebar as-is (out of scope, not mentioned by user).
- Map preview grid (1.A) replaces the dropdown-with-preview ask entirely, since the user's own last bullet explicitly proposed the grid as a better alternative.
- Auth (1.B): anonymous→permanent upgrade via `linkWithCredential`, not a parallel identity system, to avoid a uid-migration project.
- Bank cards (2.D): one card per resource *type* showing a total count, not one card per unit owned — see note above.
- Trade bar (2.F) give-selector uses stepper chips, not click-to-select on the hand itself — see note above.
- Pause (3.C): majority threshold computed over **non-bot** turnOrder members only, per explicit instruction; bots never vote and are not in the denominator.
- Gold tile (4.A) and fog-of-war (4.B) are both new, additive map/terrain concepts — implemented without touching the existing 4 presets' behavior.
