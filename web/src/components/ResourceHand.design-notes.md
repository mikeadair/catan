# Compact resource hand — design notes

## Problem

`ResourceHand`'s `'cards'` variant rendered one DOM element per *unit* of a
resource (a hand of 20 cards = 20 elements). Wrapped in a flex row inside a
fixed-width `.game__toolbar-hand` box, a big hand (easily 15-20+ cards before
the discard limit forces a 7) wrapped across up to ~6 rows, and the box's
`min-height` only budgeted for 2, so the footer/board visibly jumped every
time the hand grew or shrank.

## Prior art already tried in this repo

Before the current wrap-based grid, `ResourceHand` rendered cards in a fanned,
overlapping stack (negative `margin-left`, alternating rotation — see commit
`c96a223`). That was deliberately replaced in `1179170` ("stable hand width")
specifically because the overlap "doesn't wrap cleanly" once a fixed-width
container forced cards onto a second row — negative margins make wrapped rows
misalign and the per-card rotation looks wrong once cards are no longer a
single unbroken fan.

## Round 1: grouped stacks (superseded)

The first pass replaced individual card faces entirely: one stack per
resource *type* (at most 5 elements total) showing an owned count plus a
±stepper, matching `TradeBar`'s existing "you want" row. This fully solved
the row-count/layout-shift problem (at most 5 elements, ever), but traded
away literal per-card tapping for a stepper-only interaction. After
reviewing screenshots, the call was to bring individually-tappable cards
back — the stepper read as clear but less tactile/game-like than tapping an
actual card, which was the more important property to preserve. That
feedback is what round 2 (below, the version actually shipped) is built
around.

## Round 2: capped, heavily-overlapped fan (chosen)

Requirements this needed to satisfy simultaneously: individually-tappable
cards (one element per unit, not a stack), a heavy (~75%) overlap within
each resource's group so a handful of cards take a fraction of the width of
fully-separate cards, *and* a hard bound on how wide one resource's group
can get — otherwise this is just the pre-`1179170` design again, headed for
the same "doesn't wrap cleanly" fate once a resource count gets large.

**The fix for "doesn't wrap cleanly":** the old design put every card of
every resource as siblings in one big `flex-wrap` row, so the wrap boundary
could fall *in the middle of* a resource's fanned run, breaking the overlap
math and misaligning the rotated cards. This version wraps each resource's
cards inside their own non-wrapping group (`.resource-card-group`), and only
`.resource-hand--cards` (the group-of-groups) wraps — so a wrap can only ever
happen *between* two resources' groups, never inside one. Groups stay intact
no matter how the row breaks.

**The fix for "unbounded width":** each resource's group is capped at
`RESOURCE_GROUP_CAP` slots (chosen: **6**). Below the cap, every unit gets
its own individually-tappable, overlapping face. At/above it, the last slot
becomes a small ±stepper representing everything from the cap onward (e.g.
at cap=6: faces for units 1-5, then one stepper slot covering unit 6+) —
so a group's width tops out at 5 overlapped faces + one stepper slot
regardless of whether the resource count is 6 or 26. 6 was the suggested
starting point and held up well at the ~75%-overlap card size that reads
clearly (46px cards, 46×0.75≈34.5px negative margin, ~11.5px reveal per
card) — verified visually at 5, 10, and 40-card hands (see screenshots); a
smaller cap left the fan feeling stubby before it hit the stepper, a larger
one made a single maxed-out group noticeably wider than the others.

**Hit-testing pitfall (found via the e2e run, not just eyeballing
screenshots):** the natural instinct is to paint later cards *over* earlier
ones (ascending z-index), like dealing a hand left to right. That breaks
`.first()`-style clicks on face 0 — the existing latency-fuzz/state-gallery
specs' `[data-testid="hand-card"][data-resource="X"].first().click()` calls
target the *center* of face 0's bounding box, which sits directly under
face 1 once there are 2+ of a resource, so the click gets silently
intercepted by the wrong element. Fixed by reversing the stack order (face 0
painted on top, later faces recede behind it) — face 0 is always fully
visible/clickable, matching what `.first()` (and a player's "just tap the
pile" instinct) expects. A selected face is additionally bumped to the very
front of its whole group (z-index 1000+) so it stays legible even if it
started out mid-stack. The overflow stepper slot deliberately does *not*
join the overlap chain at all — it holds real ±buttons that need to stay
reliably clickable, not just visible-sliver-clickable like the card faces.
(Revisited in round 3 below — the overflow slot does join the chain as of
that round, once a way was found to do it without the ±buttons' clickability
or the individual faces' visibility paying for it.)

Other options considered and not taken for round 2:
- **Keep the stepper-only stack design (round 1).** Simpler, and already
  fully bounded, but explicitly not what was wanted after seeing it — traded
  away the tactile "tap an actual card" interaction.
- **Uncapped fan, rely on overlap alone for compactness.** This is just the
  pre-`1179170` design again; a 26-of-one-resource hand would still make that
  one group extremely wide (or need overlap so extreme it stops reading as
  cards at all) even though it no longer breaks mid-fan across a wrap.

## Round 3: overflow slot joins the fan, counter shows a running total

Feedback on round 2's screenshots: the overflow/counter slot sat outside the
overlap chain entirely (positive margin, low z-index, off to the side with
normal spacing) — visually a detached box next to the fan rather than part of
it, and its number only showed the overflow's own portion (e.g. "2 of 7"
beyond the 5 visible faces) rather than the resource's total selected count.
Three changes: (1) the overflow slot joins the same overlap chain the
individual faces use and renders frontmost in its group; (2) its number is
now the *total* selected for that resource (individual faces + overflow
combined), climbing as a running total; (3) its +/- buttons became
index-agnostic fill/drain controls (`stepGroup` in ResourceHand.tsx) instead
of touching only the stepper: + selects the lowest-indexed unselected visible
face first (only climbing pure overflow once every visible face is selected),
- mirrors that in reverse (drain the stepper first, then deselect the
highest-indexed selected face) — and both correctly pick up wherever manual
`toggleFace` taps left off, never resetting or fighting a face the user
already tapped directly, which those must continue to do exactly as before
(tapping any specific face still toggles just that one face, independent of
the counter).

**Geometry conflict found while implementing "frontmost, highest z-index."**
The literal ask was for the overflow slot to use the *same* -34.5px overlap
margin as individual faces (the standard 75%-overlap pullback) and sit at a
z-index higher even than a selected face's own front-of-group bump (1000+).
Implemented exactly that way first — screenshot:
`e2e/state-gallery-screenshots/MANUAL-overflow-counter-5-selected-faces-full.png`
from this round's own verification run — and it visually collapsed the
entire 5-card fan down to what reads as one card next to one box. The cause
is arithmetic, not a styling slip: with individual faces spaced only 11.5px
apart, a -34.5px pullback reaches back across *three* of them (34.5 / 11.5 =
3), and a z-index above every face's selected-bump (which is itself always
≥1000, far above any unselected face's 1-5 range) necessarily paints over
*all* of them wherever the overflow box spatially reaches — there's no
z-index that beats a selected face's bump without also beating every
unselected face in reach, so "highest z-index, standard pullback" and
"individual faces stay independently visible" are mutually exclusive once
you work out the actual pixel ranges, not just two independent style knobs.

The shipped fix keeps the frontmost/joins-the-chain *intent* but changes the
overlap depth so the collision only touches the overflow slot's one true
neighbor (the last individual face, index `individualSlots - 1`) instead of
reaching three faces back: `.resource-card--overflow` uses its own -11.5px
margin (the same *reveal* increment every other card already uses, just
applied relative to its actual neighbor instead of inheriting a pullback
sized for a same-width predecessor) rather than the shared -34.5px rule.
Faces 0 through `individualSlots - 2` (typically 0-3) are completely
unaffected — same visible slivers, same z-indices, same click geometry as
round 2. The one accepted trade-off: the last individual face does become
fully visually covered once the overflow slot appears, since *any* amount of
higher-z overlap into it covers its entire (already-slim, ~11.5px) exposed
sliver — there's no partial-overlap option once overflow needs to be
genuinely on top of it at all. That face is still selectable (the counter's
+ reaches it in fill order same as any other index, and `toggleFace` can
still target its DOM element by exact coordinates — verified in
`hand-manual-then-counter-faces-full.png` below, where clicking + four times
does reach it), just no longer independently visually distinguishable from
the overflow slot's own card front. `pointer-events: none` on the overflow
shell (with `.resource-card__stepper` opting back in via `pointer-events:
auto`) keeps that face's tap target reachable via passthrough rather than
dead-clicking on the overflow's empty background there.

**Verification:** `npm run snap` (see `web/e2e/snap.spec.ts` and the registry
in `web/e2e/snap-components.ts`, added the same day as this round — no
Firebase emulator needed, targets `?preview=trade` directly) rather than a
one-off Playwright script against the full gallery suite. Two new reusable
`SNAP_SCENARIOS` entries (`hand-overflow-counter-faces-full`,
`hand-overflow-counter-into-overflow`) demonstrate the counter alone driving
selection from 0 up past the cap; `TradePreview.tsx`'s seeded hand was bumped
to include an over-cap ore count (12) specifically so `SNAP_COMPONENT=hand`
exercises the overflow slot by default going forward. The "manual
out-of-order taps then counter" scenario (tap face index 2 directly — the
task's own "3rd face" example — then use the counter, confirming it fills
0/1/3/4 in index order and skips 2, then correctly drains the stepper before
un-filling the highest-indexed face on the way back down) needed exact
sub-pixel clicks on specific card slivers, which the registry's plain
selector-click model doesn't support, so that one used a throwaway script
against the same `?preview=trade` harness instead (deleted after capturing —
see `hand-manual-tap-face-2.png` through
`hand-manual-then-counter-decrement-then-highest-face.png` in
`e2e/state-gallery-screenshots/`).

## Compatibility

`data-testid="hand-card"` / `data-resource="<resource>"` stay on every
individually-tappable face (now `data-face-index` too, for the exact-face
bookkeeping below); the overflow stepper slot gets its own
`data-testid="hand-card-overflow"` (not currently targeted by any spec, but
distinct so a future one could target it without ambiguity). `.first()` on
`[data-testid="hand-card"][data-resource="X"]` still resolves to a real,
fully-clickable element regardless of how many of that resource are held —
existing specs needed no interaction changes, only the frontmost-face
z-index fix above.

Bringing back individual faces also brings back the need to track *which
exact face* is tapped-selected (the concern the original per-face
`faceSelection` bookkeeping — see commit `3a764c0` — existed for), now
extended to also account for the overflow stepper's own contribution to a
resource's total: `faces.length + stepper === selected[resource]` is kept
true by construction on every tap, and reconciled back to a canonical
fill (individual faces first, remainder into the stepper) only when
something *external* changes the picture out from under it (hand shrinking,
a Clear-button-style full reset) — see the `faceState` effect in
`ResourceHand.tsx`.
