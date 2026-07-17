# UI/UX Improvement Proposals

From a visual/UX review of all 43 snap-screenshot registry entries (`web/e2e/snap-screenshots/`)
plus a skim of the main game components. Organized by suggested implementation phase.
Effort: S = small, M = medium, L = large.

> Status note: items marked ✅ were implemented right after the review (see git log).
> Scope note (from Mike, 2026-07-17): **desktop-only** — no mobile/touch-specific usability
> work. B1 and B5 are dropped accordingly; B2 needs a visible shortcuts reference so the
> shortcuts are discoverable.

---

## Phase 1 — Perception of quality + core game readability (all S)

### A1. Fix the Fog of War map card ✅
Broken layout + wall of text. On Home, Lobby, and the map picker, Fog of War was the only
card using a horizontal text-first layout; its ~120-word description dwarfed every sibling
card's one-liner, and the thumbnail was clipped at the card's bottom edge. It's the first
screen every player sees and it read as a bug.
**Fix applied:** short 1–2 line `description` on the card, full rules text moved to a new
`MapPreset.details` field surfaced as a tooltip, CSS line-clamp guardrail.
**Touches:** `packages/engine/src/mapPresets.ts`, `types.ts`, `web/src/components/MapPickerGrid.tsx` + `.css`.

### A2. Show whose turn it is during an opponent's roll/main phase ✅
`Game.tsx`'s `phaseBanner` covered paused/setup/robber/discard/goldPick waits — but during an
opponent's ordinary roll/main phase (most of the game) there was no banner at all; the only
cue was the sidebar roster highlight. "Whose turn is it?" is the single most-asked question
at a Catan table.
**Fix applied:** fallback banner branch — `{name}'s turn…`.
**Touches:** `web/src/routes/Game.tsx` (phaseBanner block).

### A3. Make the dice roller legible when idle/not-your-turn ✅
The widget was nearly invisible when disabled (whole-widget opacity 0.45) — dark navy dice
on dark navy panel, small low-contrast roll sum. The last roll is key shared context (it
explains everyone's gains) and should be readable at all times.
**Fix applied:** disabled opacity raised to 0.8, sum caption enlarged.
**Touches:** `web/src/components/DiceRoller.css`.

### A4. Make the robber prominent on the board ✅
The robber is a ~28px dark circle tucked against the desert's number token — easy to miss
entirely, yet it's the piece that blocks production. Enlarge it, give it a high-contrast
ring/drop shadow, consider dimming the hex it occupies.
**Touches:** `web/src/components/Board.tsx` (robber render, ~L599), board SVG styles.

---

## Phase 2 — Independent small polish (all S, any order)

### A5. Trade composer "You want" row: uniform grid + surface trade rates ✅
The 5 want-cards wrap 2-2-1 with the Wool card visibly narrower — reads as broken. Make it a
consistent 5-column (or 1-row scroll) grid with equal card widths. Bonus: `computePortRates()`
(`web/src/components/TradeBar.tsx:14`) already computes per-resource bank rates but they're
only revealed inside a disabled-button tooltip — add a small "Your bank rates: 4:1 · Wool 2:1 · …"
hint line so port ownership feels rewarding.
**Touches:** `TradeBar.tsx`, `TradeBar.css`.

### A6. Victory-point context in the roster ✅
`PlayerRoster.tsx` shows raw VP but never the target; `room.victoryPointsToWin` isn't passed
in. Show "7 / 10" (or a progress ring on the VP ribbon) so tension is legible at a glance —
especially for guests who didn't set the house rules.
**Touches:** `PlayerRoster.tsx` (new prop), `Game.tsx` (pass `room.victoryPointsToWin`), `PlayerRoster.css`.

### A7. Roster mini-stat legibility ✅
Knight/road mini-stat icons at ~12px are cryptic (road icon reads as a pencil, resource vs
dev card badges as anonymous rectangles); meaning is hover-tooltip-only. Slightly larger
icons and/or one-letter labels. Semantic trap: the row shows `roadsBuilt`, which players will
misread as longest-road length.
**Touches:** `PlayerRoster.tsx`, `PlayerRoster.css`, `gameIcons.tsx`.

### A8. Replace the emoji sound toggle with the SVG icon set ✅
`web/src/App.tsx:81` renders 🔇/🔊 — the exact cross-platform tofu problem this repo already
fixed in `DevCardPanel.tsx` (see its header comment). Add speaker icons to `gameIcons.tsx`.
**Touches:** `App.tsx`, `gameIcons.tsx`, `App.css`.

### A9. Discard modal: quick-pick button ✅
Discarding 9 cards means 9 taps under a 25s countdown. Add an "Auto-pick" button that
pre-fills a suggested selection (mirroring the server's `timeoutDiscard` random pick, or a
"most-held-first" heuristic) which the player can adjust then confirm.
**Touches:** `web/src/components/DiscardModal.tsx` only (selection is local state).

### A10. Sidebar-side toggle button is opaque ✅
`Game.tsx` ~L732 renders a bare `⇤`/`⇥` glyph (glyph-font-dependent, same issue as A8).
First-time users won't guess it moves the sidebar. Use a proper SVG panel-left/panel-right icon.
**Touches:** `Game.tsx`, `gameIcons.tsx`, `Game.css`.

---

## Phase 3 — Biggest usability multipliers (M)

### B1. ~~Touch-visible disabled reasons and card descriptions~~ (DROPPED — desktop only)
Nearly every affordance explanation lives in `title=` attributes — `BuildToolbar.tsx`
(`disabledReason`), `TradeBar.tsx` (`proposeReason`/`bankTradeReason`), `DevCardPanel.tsx`
(`CARD_DESCRIPTION` + disabled reasons), `TradeOffers.tsx` (can't-afford reason), CostChips
have/need counts. On touch devices none of this is reachable — disabled buttons are just
mysteriously dead. Fix pattern: a single small "hint line" region in the toolbar that shows
the reason for the last-tapped disabled control for ~3s, reusing the existing reason strings.
*(Most important item for mobile ergonomics.)*
**Touches:** `Game.tsx` (shared hint state), `BuildToolbar.tsx`, `TradeBar.tsx`, `DevCardPanel.tsx`, `TradeOffers.tsx`, CSS.

### B2. Keyboard shortcuts ✅
Zero keyboard support today. Add: `R` roll, `E` end turn, `T` toggle trade composer,
`1/2/3` road/settlement/city build modes, `Esc` cancel build mode / close composer / dismiss
modals, `Enter` focus chat. Gate on no input being focused. Dramatically speeds up the core
loop for desktop players in a game with many short turns.
**Touches:** `Game.tsx` (one `useEffect` keydown listener dispatching to existing handlers),
shortcut hints in button tooltips.
**Discoverability (required per Mike):** the shortcuts need somewhere visible to show them
off — a `?`-key overlay listing all bindings, plus the key name appended to each button's
tooltip (e.g. "End turn (E)"). Without that they're a hidden feature nobody finds.

---

## Phase 4 — Gameplay-feel features (M)

### B4. Counter-offer on incoming trades ✅
Implemented via a new `counterTrade` engine action (the review's "pure wiring" framing was
wrong — `proposeTrade` requires the current player, so a responder-initiated counter needed
engine support): validates against the original trade (pending, directed at or open to the
actor, give affordable), marks it `countered`, and creates a new offer targeted back at the
original proposer with `counterOf`/`proposedTurn` set. Client: Counter button on incoming
offers pre-seeds the composer flipped around (target locked, Bank Trade disabled, button
reads "Send Counter"). Bots: `decideMainAction` now answers pending trades targeted at the
bot first, so a bot proposer responds to counters instead of letting them expire.
`TradeOffers.tsx` supports only Accept/Reject/Withdraw. Add a "Counter" button that opens the
trade composer pre-seeded with `tradeGive` = their `receive`, `tradeReceive` = their `give`,
`tradeTargetUid` = proposer, and rejects the original. All composer state is already lifted
into `Game.tsx`, so this is pure wiring — no engine changes. Haggling is the heart of Catan;
today a near-miss offer forces a full manual re-compose.
**Touches:** `TradeOffers.tsx` (new callback prop), `Game.tsx`.

### B3. Dice-roll histogram / game stats panel ✅
Every serious online Catan shows the roll distribution. All data already exists client-side:
`room.log` entries carry `meta.kind === 'diceRoll'` with the roll. Add a small toggleable
histogram (2–12 bars vs. expected curve) as a third sidebar card or a tab on the Log panel.
**Touches:** new `web/src/components/RollStats.tsx` + CSS, mounted from `Game.tsx`; data
derived purely from `room.log`, no engine/server changes.

### B5. ~~Two-step confirm for build placement on touch~~ (DROPPED — desktop only)
In build mode a single tap on an edge/vertex immediately submits the build — on a phone-sized
board a fat-finger builds the wrong road with no undo (server-authoritative, irreversible).
Change to: first tap selects and shows a ghost piece + floating "Confirm ✓ / ✗" chip; second
tap submits. Keep single-tap on fine pointers via `matchMedia('(pointer: coarse)')` if desired.
Note: the confirm step must still derive completion from `room.edges`/`room.vertices` per the
`pendingBuild` pattern in `Game.tsx` (see the armed-preview race commentary in `Board.tsx`).
**Touches:** `Board.tsx`, `Game.tsx`.

---

## Phase 5 — Depth/stats layer (M)

### B7. Game log: turn separators and filters ✅
The log is a single undifferentiated stream; mid/late game it's hundreds of visually identical
rows. Add subtle "— Turn N: PlayerName —" divider rows (turn boundary detectable from
`endTurn`/roll entries) and a chat-only/events-only filter chip. Also fills the awkward empty
panel early game.
**Touches:** `GameLog.tsx`, `GameLog.css`; ideally `rules.ts` log entries gain a `turnNumber`
field (engine touch) — otherwise infer client-side.

### B6. Game-over stats summary ✅ (first pass)
Game-over shows only final VP standings. Add per-player fun stats — total resources gained,
cards played, rolls made, robber steals — derivable by folding over `room.log` metas
client-side (no engine change for a first pass). Turns the ending into a shareable moment.
**Touches:** `GameOverStandings.tsx`, possibly a small log-aggregation helper.

### B8. Live longest-road length in roster ✅
The engine computes longest road to award `longestRoadUid`, but per-player current chain
length isn't in `PublicPlayer`, so the roster can only show the award icon and raw
`roadsBuilt`. Exposing `longestRoadLength` per player lets the roster show "4/5 to Longest
Road" — a real strategic signal.
**Implemented without any engine/schema change:** the engine already exports
`longestRoadForPlayer`, so Game.tsx computes each player's live chain length client-side
from public board state and passes it to PlayerRoster — the road mini-stat now shows chain
length (tooltip carries piece count).

---

## Implementation notes (Phases 3–5, 2026-07-17)

- **B2:** one window keydown listener in `Game.tsx` dispatching into a per-render rebuilt
  `shortcutsRef` map; every shortcut is gated on the same `legalTypes`/pending/paused checks
  as its button. Discoverability: a `?` key + a `?` button in the sidebar top row open a
  shortcuts modal (`.game__shortcuts-modal`).
- **B3:** `web/src/components/RollStats.tsx` — collapsed-by-default `<details>` card in the
  sidebar; bars per sum 2–12 with a tick at the expected count, folded from `room.log`.
- **B7:** GameLog gained an All/Game/Chat cycle button and "Turn N" divider rows (a turn
  boundary = a diceRoll meta; numbered by counting rolls).
- **B6:** GameOverStandings now takes `room.log` and shows per-player total resources
  collected plus "N turns played — X was the most-rolled number". Steals/cards-played would
  need richer log metas (engine) — left for a second pass.

## Review-tooling note

The batch `npm run snap` run failed transiently partway (selector `boundingBoxOrThrow`
returned null on `game-log` at `web/e2e/snap.spec.ts:95` after 28 captures; exit 1) — every
remaining component captured fine when re-run individually, so this looks like a flaky race
in the batch pass, not a product bug.

Verification for any visual item: `SNAP_COMPONENT=<name> npm run snap` from `web/`
(registry: `web/e2e/snap-components.ts`), and add a `SNAP_SCENARIOS` entry for any new
interaction state per the CLAUDE.md convention.
