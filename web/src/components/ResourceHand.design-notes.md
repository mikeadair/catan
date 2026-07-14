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

Other options considered and not taken for round 2:
- **Keep the stepper-only stack design (round 1).** Simpler, and already
  fully bounded, but explicitly not what was wanted after seeing it — traded
  away the tactile "tap an actual card" interaction.
- **Uncapped fan, rely on overlap alone for compactness.** This is just the
  pre-`1179170` design again; a 26-of-one-resource hand would still make that
  one group extremely wide (or need overlap so extreme it stops reading as
  cards at all) even though it no longer breaks mid-fan across a wrap.

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
