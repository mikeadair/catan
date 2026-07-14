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
single unbroken fan. Worth knowing, not worth resurrecting as-is: it solves
"looks nice at ~5-8 cards," not "stays compact at 20+."

## Options considered

1. **Refined fan/overlap.** Bring back overlapping cards, but cap visible
   faces low and rely on tight negative-margin packing to keep a big hand
   inside 1-2 rows. Pros: tactile, game-like. Cons: this is the exact thing
   `1179170` moved away from — doesn't wrap cleanly, and the identity of an
   individual face buys nothing here since every card of a resource is
   visually identical (unlike a real deck). To *guarantee* ≤2 rows at 20+
   cards you'd need extreme overlap (single-digit px reveal per card), which
   stops reading as a hand of cards and doesn't scale better than option 2.

2. **Group into one stack per resource type, with an owned/selected count.**
   Catan has exactly 5 resources, so this bounds the hand to at most 5
   elements — one row, always, regardless of whether a player holds 3 cards
   or 30. Interaction moves from "tap a specific card face" to "tap the
   stack to add one to the trade, or use a small ±stepper for precise
   control" — a real change, but one this same UI already uses successfully
   elsewhere (`TradeBar`'s "you want" row is exactly this: icon + name +
   ±stepper). Chosen — see rationale below.

3. **Hybrid: cap visible faces per resource (e.g. 3) + horizontal scroll
   strip for the rest.** Keeps literal per-card tapping for a few cards.
   Rejected: horizontal scroll inside a toolbar is fiddly on both mouse and
   touch, doesn't give the same *guaranteed* bounded footprint (visible
   count still varies with resource distribution), and hidden/scrolled-off
   cards make "what's selected" unclear at a glance — works against
   priority 3, not just a wash.

## Chosen: grouped stacks

- At most 5 `.resource-card` elements ever render, so the hand's box is a
  fixed, single-row footprint independent of card count — solves the
  "up to 6 rows" and "jumps around" complaints directly, not just
  incrementally.
- Visually and interaction-wise consistent with `TradeBar`'s existing
  "you want" stepper cards, so give/want sides of a trade now read as the
  same control instead of two different metaphors.
- Selected count is an explicit number next to explicit ± buttons, not
  "count the highlighted icons" — clearer at a glance than the old
  highlighted-card-face approach, especially past a handful of cards.
- `data-testid="hand-card"` / `data-resource="<resource>"` stay exactly as
  before (still one element per resource, just now always exactly one
  regardless of count); existing e2e specs that do
  `[data-testid="hand-card"][data-resource="X"]` → `.first().click()` to
  stage one card of a resource for a trade keep working unchanged, since a
  plain click on the stack still adds exactly one to the selection.
- Simplifies the component: the per-face `faceSelection` index-tracking
  this file grew (to keep the *exact tapped card* highlighted rather than
  "some card of that type") is no longer needed — there's only one element
  per resource now, so there's no "which face" ambiguity to track.
