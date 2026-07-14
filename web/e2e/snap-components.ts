// Registry snap.spec.ts reads so agents can say `SNAP_COMPONENT=hand` instead of having to grep
// component .tsx/.css files for the right selector every time — see CLAUDE.md's "Focused
// screenshots for a single component" section for the full workflow. Keep this to genuinely
// distinct, reviewable regions (roughly: things a design/UX pass would call out by name), not
// every div — a registry nobody can hold in their head defeats the point.
//
// `SNAP_LIST=1 npm run snap` prints this whole registry (components + scenarios) without
// navigating anywhere, if you just want to check what's available.
export type SnapPreview = 'trade' | 'board';

export interface SnapComponent {
  /** CSS selector for the element to screenshot (first match). */
  selector: string;
  /** Which `?preview=` dev harness (TradePreview.tsx / DevPreview.tsx) renders this component. */
  preview: SnapPreview;
  /** Shown by SNAP_LIST and in error messages — what a reviewer would recognize this region as. */
  description: string;
  /** Selectors to click, in order, before this component exists/is visible at all — e.g. the
   * trade composer only mounts once its toggle button is clicked. Distinct from a *scenario*'s
   * clicks (below), which go further than "make it visible" into a specific interaction state. */
  clicks?: string[];
}

export const SNAP_COMPONENTS: Record<string, SnapComponent> = {
  hand: {
    selector: '.game__toolbar-hand',
    preview: 'trade',
    description: "Player's own resource hand / trade card picker, in the toolbar",
  },
  toolbar: {
    selector: '.game__toolbar',
    preview: 'trade',
    description: 'Whole bottom action toolbar (hand, trade toggle, dev cards, build toolbar, turn timer, end turn)',
  },
  'build-toolbar': {
    selector: '.build-toolbar',
    preview: 'trade',
    description: 'Road/settlement/city/dev-card build buttons with live affordability chips',
  },
  'dev-cards': {
    selector: '.dev-card-panel',
    preview: 'trade',
    description: 'Development card panel',
  },
  'trade-bar': {
    selector: '.trade-bar',
    preview: 'trade',
    description: 'Floating trade composer panel ("you want" cards + offer/bank/target controls)',
    // The toggle button (Game.tsx) reuses BuildToolbar's `.build-toolbar__button` class for
    // visual consistency but, unlike BuildToolbar's own road/settlement/city/dev-card buttons,
    // is a *direct* child of `.game__toolbar-main` rather than nested inside `.build-toolbar` —
    // this scopes to exactly that one button. (A plain text match isn't safe here: TradeOffers'
    // "Trade with Bot Bob" finalize button also contains "Trade" and sits earlier in the DOM.)
    clicks: ['.game__toolbar-main > button.build-toolbar__button'], // closed by default — this is what mounts it
  },
  'trade-offers': {
    selector: '.game__trades-overlay',
    preview: 'trade',
    description: 'Pending trade offers overlay, top-right of the board (TradePreview seeds 3 fake trades)',
  },
  board: {
    selector: '.catan-board',
    preview: 'board',
    description: 'Hex board SVG (use ?preview=board&map=<preset> via SNAP_URL directly for a non-default map)',
  },
  sidebar: {
    selector: '.game__sidebar',
    preview: 'trade',
    description: 'Whole right-hand sidebar (bank, players, log)',
  },
  bank: {
    selector: '.bank-panel',
    preview: 'trade',
    description: 'Bank resource-count strip',
  },
  players: {
    selector: '.player-roster',
    preview: 'trade',
    description: 'Player roster / scoreboard',
  },
  'game-log': {
    selector: '.game-log',
    preview: 'trade',
    description: 'Game log & chat panel',
  },
  'dice-roller': {
    selector: '.dice-roller',
    preview: 'trade',
    description: 'Dice roller widget',
  },
};

export interface SnapScenario {
  /** Which SNAP_COMPONENTS entry to resolve the selector/preview/base clicks from. */
  component: string;
  /** Extra clicks applied *after* the component's own `clicks` (if any) — the interaction that
   * actually produces the state being demonstrated, not just what makes the component exist. */
  clicks: string[];
  description: string;
}

// Named, reusable interaction states — the point is that the *sequence of clicks* to reach a
// state worth screenshotting only has to get worked out once and committed here, instead of
// every agent re-deriving it (and the exact selectors involved) from scratch per task. Add to
// this whenever you work out a click sequence for a state worth being able to reach again.
export const SNAP_SCENARIOS: Record<string, SnapScenario> = {
  'hand-card-selected': {
    component: 'hand',
    clicks: ['[data-testid="hand-card"]'],
    description: 'Trade composer open, one hand card tapped/selected for the trade',
  },
  'trade-bar-with-selection': {
    component: 'trade-bar',
    clicks: ['[data-testid="hand-card"]'],
    description: 'Trade composer open with one hand card selected, showing the give/want state together',
  },
  'hand-overflow-counter-faces-full': {
    component: 'hand',
    // The hand's own card picker only becomes interactive (onChange wired up) once the trade
    // composer is open (see Game.tsx's tradeComposerOpen ? ... : ... around .game__toolbar-hand)
    // — the 'hand' component entry itself has no `clicks` since the read-only display is a valid
    // state to snap on its own, so scenarios that need the interactive picker open it here first.
    // TradePreview's hand seeds ore at 12 (over RESOURCE_GROUP_CAP) specifically so this is
    // reachable — 5 clicks on the overflow slot's + button fills every individual face slot via
    // stepGroup's "lowest unselected index first" fill order, before it starts climbing pure
    // overflow.
    clicks: [
      '.game__toolbar-main > button.build-toolbar__button',
      ...Array(5).fill('[data-testid="hand-card-overflow"][data-resource="ore"] button[aria-label="Add one more Ore to trade"]'),
    ],
    description: 'Ore over the cap, counter alone clicked 5x — every individual face now selected, stepper still at 0',
  },
  'hand-overflow-counter-into-overflow': {
    component: 'hand',
    clicks: [
      '.game__toolbar-main > button.build-toolbar__button',
      ...Array(7).fill('[data-testid="hand-card-overflow"][data-resource="ore"] button[aria-label="Add one more Ore to trade"]'),
    ],
    description: 'Ore over the cap, counter clicked 7x — faces full, stepper now climbing past them (total 7)',
  },
};
