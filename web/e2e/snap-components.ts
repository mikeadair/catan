// Registry snap.spec.ts reads so agents can say `SNAP_COMPONENT=hand` instead of having to grep
// component .tsx/.css files for the right selector every time — see CLAUDE.md's "Focused
// screenshots for a single component" section for the full workflow. Keep this to genuinely
// distinct, reviewable regions (roughly: things a design/UX pass would call out by name), not
// every div — a registry nobody can hold in their head defeats the point.
//
// `SNAP_LIST=1 npm run snap` prints this whole registry (components + scenarios) without
// navigating anywhere, if you just want to check what's available.
export type SnapPreview = 'home' | 'lobby' | 'trade' | 'board';
export type SnapScreen = 'main-menu' | 'lobby' | 'game' | 'game/maps';

export interface SnapComponent {
  /** CSS selector for the element to screenshot (first match). */
  selector: string;
  /** Which `?preview=` dev harness renders this component (HomePreview/LobbyPreview/TradePreview/DevPreview.tsx). */
  preview: SnapPreview;
  /** Which screen this belongs to — drives the output subfolder (e2e/snap-screenshots/<screen>/<name>.png). */
  screen: SnapScreen;
  /** Shown by SNAP_LIST and in error messages — what a reviewer would recognize this region as. */
  description: string;
  /** Extra query-string params (no leading '&'/'?') appended to the preview URL — for harness
   * variants that aren't reached by clicking (e.g. LobbyPreview's `seats=full`, TradePreview's
   * `state=discard`), as opposed to `clicks` below, which drives in-page interaction. */
  query?: string;
  /** Selectors to click, in order, before this component exists/is visible at all — e.g. the
   * trade composer only mounts once its toggle button is clicked. Distinct from a *scenario*'s
   * clicks (below), which go further than "make it visible" into a specific interaction state. */
  clicks?: string[];
  /** Keystrokes typed at the page level (page.keyboard.type) after load, before `clicks` — for
   * components summoned by typing rather than clicking (e.g. the secret menu's trigger word). */
  keys?: string;
  /** Install a frozen Playwright clock before navigating (Date.now()/timers stop advancing on
   * their own past install time) — for components whose interesting state is otherwise a
   * transient, timer-driven race against real wall-clock time (e.g. TradeOffers' reject-flash,
   * which schedules its own dismissal 1800ms after mount via Date.now()). Freezing time keeps the
   * state on screen indefinitely instead of it depending on how fast the page happens to load. */
  freezeClock?: boolean;
}

export const SNAP_COMPONENTS: Record<string, SnapComponent> = {
  // --- main-menu screen (HomePreview.tsx, ?preview=home) ---
  home: {
    selector: '.home',
    preview: 'home',
    screen: 'main-menu',
    description: 'Whole main-menu / home screen',
  },
  'home-name-card': {
    selector: '.home__card--name',
    preview: 'home',
    screen: 'main-menu',
    description: '"Play as" card — display name, color picker, sign-in/account entry point',
  },
  'home-create-room-card': {
    selector: '.home__grid > form:first-of-type',
    preview: 'home',
    screen: 'main-menu',
    description: 'Create-a-room card (map picker + create button)',
  },
  'home-join-room-card': {
    selector: '.home__grid > form:last-of-type',
    preview: 'home',
    screen: 'main-menu',
    description: 'Join-a-room card (room code input + join button)',
  },
  'map-picker': {
    selector: '.map-picker-grid',
    preview: 'home',
    screen: 'main-menu',
    description: 'Map preset picker grid (used by both the home create-room card and the lobby settings card)',
  },

  // --- lobby screen (LobbyPreview.tsx, ?preview=lobby) ---
  lobby: {
    selector: '.lobby',
    preview: 'lobby',
    screen: 'lobby',
    description: 'Whole lobby screen, as the host, partially seated',
  },
  'lobby-room-code': {
    selector: '.lobby__card--code',
    preview: 'lobby',
    screen: 'lobby',
    description: 'Room code + copy-invite-link card',
  },
  'lobby-players-card': {
    selector: '.lobby__column--left .lobby__card:not(.lobby__card--code)',
    preview: 'lobby',
    screen: 'lobby',
    description: 'Seat list card (players, bot controls, start/leave)',
  },
  'lobby-settings-card': {
    selector: '.lobby__column--right .lobby__card',
    preview: 'lobby',
    screen: 'lobby',
    description: 'Game settings card (map, victory points, discard limit, turn timer, safe mode)',
  },
  'map-preview': {
    selector: '.map-preview',
    preview: 'lobby',
    screen: 'lobby',
    description: 'Small rendered-board preview swatch atop the lobby settings card',
  },
  'lobby-full': {
    selector: '.lobby',
    preview: 'lobby',
    screen: 'lobby',
    description: 'Lobby with every seat filled (6/6) — tests the seat list at max density',
    query: 'seats=full',
  },
  'lobby-guest-view': {
    selector: '.lobby',
    preview: 'lobby',
    screen: 'lobby',
    description: 'Lobby as a non-host seated player — host-only controls hidden (add bot/start) or disabled (map/settings fields)',
    query: 'role=guest',
  },

  // --- game screen (TradePreview.tsx / DevPreview.tsx) ---
  hand: {
    selector: '.game__toolbar-hand',
    preview: 'trade',
    screen: 'game',
    description: "Player's own resource hand / trade card picker, in the toolbar",
  },
  toolbar: {
    selector: '.game__toolbar',
    preview: 'trade',
    screen: 'game',
    description: 'Whole bottom action toolbar (hand with its own trade toggle, dev cards stacked above the build toolbar, turn timer, end turn)',
  },
  'toolbar-maxed-hand': {
    selector: '.game__toolbar',
    preview: 'trade',
    screen: 'game',
    description:
      'Toolbar stress test: every resource pinned at 19 (all five hand groups hit the overlap-fan + overflow-stepper look at once) and one of every dev card type (full 5-card DevCardPanel row, stacked above the build buttons)',
    query: 'hand=maxed',
  },
  'build-toolbar': {
    selector: '.build-toolbar',
    preview: 'trade',
    screen: 'game',
    description: 'Road/settlement/city/dev-card build buttons with live affordability chips',
  },
  'dev-cards': {
    selector: '.dev-card-panel',
    preview: 'trade',
    screen: 'game',
    description: 'Development card panel',
  },
  'trade-bar': {
    selector: '.trade-bar',
    preview: 'trade',
    screen: 'game',
    description: 'Floating trade composer panel ("you want" cards + offer/bank/target controls)',
    // The toggle button lives in the hand's own label row (Game.tsx), styled via its own
    // `.game__hand-trade-toggle` class rather than BuildToolbar's shared button class — it used
    // to sit inside .game__toolbar-actions alongside the build buttons, scoped by being a direct
    // child there; a plain text match still isn't safe regardless (TradeOffers' "Trade with Bot
    // Bob" finalize button also contains "Trade" and sits earlier in the DOM), so the distinct
    // class name is what scopes this to exactly the one button.
    clicks: ['.game__hand-trade-toggle'], // closed by default — this is what mounts it
  },
  'trade-offers': {
    selector: '.game__trades-overlay',
    preview: 'trade',
    screen: 'game',
    description:
      'Pending trade offers overlay, top-right of the board (TradePreview seeds 3 fake trades, one already fully-rejected — freezeClock pins time at page-load so its red "everyone rejected" flash is reliably still showing at capture time, not a race against ALL_REJECTED_FLASH_MS)',
    freezeClock: true,
  },
  board: {
    selector: '.catan-board',
    preview: 'board',
    screen: 'game',
    description: 'Hex board SVG, default map (official-beginner) — see game/maps/ below for every preset',
  },
  // One entry per MapPresetId (packages/engine/src/mapPresets.ts), filed under their own
  // subfolder so a review pass can check every map's rendering at once without wading through
  // the rest of the game screen's captures. board (above) stays the quick single-default-map
  // check most workflows actually want.
  'map-official-beginner': {
    selector: '.catan-board',
    preview: 'board',
    screen: 'game/maps',
    query: 'map=official-beginner',
    description: 'Hex board SVG — official-beginner preset',
  },
  'map-balanced-random': {
    selector: '.catan-board',
    preview: 'board',
    screen: 'game/maps',
    query: 'map=balanced-random',
    description: 'Hex board SVG — balanced-random preset',
  },
  'map-chaos': {
    selector: '.catan-board',
    preview: 'board',
    screen: 'game/maps',
    query: 'map=chaos',
    description: 'Hex board SVG — chaos preset',
  },
  'map-extended-5-6p': {
    selector: '.catan-board',
    preview: 'board',
    screen: 'game/maps',
    query: 'map=extended-5-6p',
    description: 'Hex board SVG — extended-5-6p preset',
  },
  'map-fog-of-war': {
    selector: '.catan-board',
    preview: 'board',
    screen: 'game/maps',
    query: 'map=fog-of-war',
    description: 'Hex board SVG — fog-of-war preset (desert corners + hidden ring)',
  },
  sidebar: {
    selector: '.game__sidebar',
    preview: 'trade',
    screen: 'game',
    description: 'Whole right-hand sidebar (bank, players, log)',
  },
  bank: {
    selector: '.bank-panel',
    preview: 'trade',
    screen: 'game',
    description: 'Bank resource-count strip',
  },
  players: {
    selector: '.player-roster',
    preview: 'trade',
    screen: 'game',
    description: 'Player roster / scoreboard',
  },
  'game-log': {
    selector: '.game-log',
    preview: 'trade',
    screen: 'game',
    description: 'Game log & chat panel',
  },
  'dice-roller': {
    selector: '.dice-roller',
    preview: 'trade',
    screen: 'game',
    description: 'Dice roller widget',
  },
  'discard-modal': {
    selector: '.discard-modal',
    preview: 'trade',
    screen: 'game',
    description: 'Post-7-roll discard modal (rules.ts "discard" phase)',
    query: 'state=discard',
  },
  'robber-banner': {
    selector: '.robber-banner',
    preview: 'trade',
    screen: 'game',
    description: 'Robber-phase "choose a hex" banner (the victim-picker sub-modal needs an actual board click, not just a fixed state — not covered here, see CLAUDE.md gap notes)',
    query: 'state=robber-hex',
  },
  'gold-pick-modal': {
    selector: '.discard-modal', // GoldPickModal reuses discard-modal's stylesheet/class, not its own
    preview: 'trade',
    screen: 'game',
    description: 'Fog-of-war gold-hex resource picker modal (rules.ts "goldPick" phase)',
    query: 'state=gold-pick',
  },
  'game-over': {
    selector: '.game-over',
    preview: 'trade',
    screen: 'game',
    description: 'Game-over / victory screen',
    query: 'state=game-over',
  },
  'robber-victim-modal': {
    selector: '.robber-modal',
    preview: 'trade',
    screen: 'game',
    description:
      "Robber victim-picker sub-modal — RobberModal's 'victim' step, reached only by an actual board-hex click (not just the fixed 'robber-hex' phase, which alone only shows robber-banner's plain 'choose a hex' banner)",
    query: 'state=robber-hex',
    clicks: ['[data-testid="hotspot-hex--1,-1"]'], // hex adjacent to both p1's and p2's seeded settlements — 2 eligible victims
  },
  'setup1-settlement': {
    selector: '.catan-board',
    preview: 'trade',
    screen: 'game',
    description: 'Setup-phase board with settlement placement hotspots active (rules.ts "setup1" phase, needs-settlement sub-state)',
    query: 'state=setup1-settlement',
  },
  'setup1-road': {
    selector: '.catan-board',
    preview: 'trade',
    screen: 'game',
    description: 'Setup-phase board with free-road placement hotspots active, anchored off the just-placed settlement (rules.ts "setup1" phase, needs-road sub-state)',
    query: 'state=setup1-road',
  },
  'phase-banner-action': {
    selector: '.game__phase-banner',
    preview: 'trade',
    screen: 'game',
    description: 'Top-of-board phase banner, \'action\' variant — something only the local player can do right now ("Your turn — roll the dice!"), bold/saturated/pulsing',
    query: 'state=roll',
  },
  'phase-banner-paused': {
    selector: '.game__phase-banner',
    preview: 'trade',
    screen: 'game',
    description: "Top-of-board phase banner, 'paused' variant (\"Game paused\") — same bold/pulsing treatment as 'action', in --color-danger instead of --color-accent",
    query: 'state=paused',
  },
  'phase-banner-waiting': {
    selector: '.game__phase-banner',
    preview: 'trade',
    screen: 'game',
    description: "Top-of-board phase banner, 'waiting' variant (\"Bot Alice's turn…\") — purely informational, stays close to the banner's old quiet plain-panel look",
    query: 'state=waiting',
  },
  'pause-control-paused': {
    selector: '.pause-control',
    preview: 'trade',
    screen: 'game',
    description: 'PauseControl paused, no resume vote from self yet ("Resume?") — the plain not-voted / not-yet-paused variant is already visible in sidebar.png',
    query: 'state=paused',
  },
  'pause-control-pausing': {
    selector: '.pause-control',
    preview: 'trade',
    screen: 'game',
    description: 'PauseControl not-yet-paused, own vote already in ("Pausing… (X/Y)")',
    query: 'state=pausing',
  },
  'pause-control-paused-voted': {
    selector: '.pause-control',
    preview: 'trade',
    screen: 'game',
    description: 'PauseControl paused, own resume-vote already in ("Resume X/Y")',
    query: 'state=paused-voted',
  },
  'leave-confirm-dialog': {
    selector: '.modal-overlay',
    preview: 'trade',
    screen: 'game',
    description: "Leave-game confirmation dialog (Game.tsx's leaveConfirmOpen)",
    clicks: ['.game__leave-button'], // not visible at all until this click — same pattern as trade-bar above
  },
  'secret-menu': {
    selector: '.secret-menu',
    preview: 'trade',
    screen: 'game',
    description: 'Hidden easter-egg menu (flashbang/ship/confetti/quake/sheep/disco broadcasts) — summoned by typing "michael" anywhere in-game',
    keys: 'michael', // only mounts once its trigger word has been typed — see SecretMenu.tsx
  },
  'fx-sheep': {
    selector: '.secret-fx-sheep',
    preview: 'trade',
    screen: 'game',
    description: 'Secret-menu sheep-rain effect mid-fall (captured via the preview-only fx= param — see SecretMenu.tsx)',
    query: 'fx=sheep',
  },
};

export interface SnapScenario {
  /** Which SNAP_COMPONENTS entry to resolve the selector/preview/screen/base clicks from. */
  component: string;
  /** Extra clicks applied *after* the component's own `clicks` (if any) — the interaction that
   * actually produces the state being demonstrated, not just what makes the component exist. */
  clicks: string[];
  description: string;
  /** Additional selectors whose bounding boxes get unioned with the component's own selector
   * before cropping — for scenarios that need to show two elements together that share no common
   * ancestor box (e.g. a `position: absolute` panel that floats outside its parent's layout box).
   * Each selector still just needs to resolve to a real, visible element; snap.spec.ts takes the
   * union of all their bounding boxes rather than any single one. */
  extraSelectors?: string[];
}

// Named, reusable interaction states — the point is that the *sequence of clicks* to reach a
// state worth screenshotting only has to get worked out once and committed here, instead of
// every agent re-deriving it (and the exact selectors involved) from scratch per task. Add to
// this whenever you work out a click sequence for a state worth being able to reach again.
export const SNAP_SCENARIOS: Record<string, SnapScenario> = {
  'hand-card-selected': {
    component: 'hand',
    // The hand's card picker only becomes interactive (onChange wired up) once the trade
    // composer is open (Game.tsx's tradeComposerOpen ? ... : ... around .game__toolbar-hand) —
    // without this first click, the hand-card click below lands on a non-interactive card and
    // silently no-ops, producing a screenshot indistinguishable from the plain 'hand' component.
    clicks: ['.game__hand-trade-toggle', '[data-testid="hand-card"]'],
    description: 'Trade composer open, one hand card tapped/selected for the trade',
  },
  'trade-bar-with-selection': {
    // .trade-bar (the "you want" panel) is deliberately taken out of flow — `position: absolute;
    // bottom: 100%` relative to .game__toolbar (see TradeBar.css/Game.css's `.game__toolbar >
    // .trade-bar`), floating above-left of the bottom bar so it never resizes the toolbar/board.
    // No single element's own bounding box covers both it and .game__toolbar-hand (the give
    // side), so this uses 'hand' as the base component and unions in '.trade-bar' via
    // extraSelectors — captures exactly the two real, already-rendered regions together (with
    // whatever's normally visible in the gap between them), not a synthetic layout.
    component: 'hand',
    clicks: ['.game__hand-trade-toggle', '[data-testid="hand-card"]'],
    extraSelectors: ['.trade-bar'],
    description: 'Trade composer open with one hand card selected — give side (hand, bottom) and want side (trade-bar, floating above) shown together',
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
      '.game__hand-trade-toggle',
      ...Array(5).fill('[data-testid="hand-card-overflow"][data-resource="ore"] button[aria-label="Add one more Ore to trade"]'),
    ],
    description: 'Ore over the cap, counter alone clicked 5x — every individual face now selected, stepper still at 0',
  },
  'hand-overflow-counter-into-overflow': {
    component: 'hand',
    clicks: [
      '.game__hand-trade-toggle',
      ...Array(7).fill('[data-testid="hand-card-overflow"][data-resource="ore"] button[aria-label="Add one more Ore to trade"]'),
    ],
    description: 'Ore over the cap, counter clicked 7x — faces full, stepper now climbing past them (total 7)',
  },
  'home-signin-panel-open': {
    component: 'home-name-card',
    clicks: ['.home__link-button'],
    description: 'Home name card with the sign-in/create-account panel expanded (email+password tab)',
  },
};

// Full-page, whole-viewport captures at a spread of real desktop/laptop resolutions — for
// checking a whole screen's responsive layout (grid columns, wrapping, starved rows) rather than
// one component in isolation, which is what SNAP_COMPONENTS/SNAP_SCENARIOS above are for. These
// used to only be reachable one at a time via the SNAP_URL/SNAP_VIEWPORT/SNAP_OUT ad hoc escape
// hatch (e.g. `SNAP_URL=.../?preview=trade SNAP_VIEWPORT=1366x768 SNAP_OUT=size-game-1366x768.png
// npm run snap`), which is fine for a single one-off check but tedious to repeat across a whole
// sweep — SNAP_SIZES=1 (or the true default full sweep) now drives this list automatically.
// Sizes span the common range from small laptops up through very large desktop monitors —
// 1512x982 and 1600x900 in particular exposed a real bug (see Game.css's max-width: 1800px
// comment) where a breakpoint cut off just below them, so keep those in the list rather than
// only round numbers.
export const SNAP_SIZES: { width: number; height: number }[] = [
  { width: 1280, height: 720 },
  { width: 1280, height: 800 },
  { width: 1366, height: 768 },
  { width: 1440, height: 900 },
  { width: 1512, height: 982 },
  { width: 1600, height: 900 },
  { width: 1920, height: 1080 },
  { width: 2560, height: 1440 },
];

export interface SnapSizeScreen {
  /** Which `?preview=` dev harness renders this screen. */
  preview: SnapPreview;
  /** Extra query-string params (no leading '&'/'?'), same as SnapComponent.query. */
  query?: string;
}

// Screens swept across every SNAP_SIZES entry, full-page (not cropped to a selector — the whole
// point is to see the layout, sidebar, and dead space together). Saved as
// e2e/snap-screenshots/size-<name>-<width>x<height>.png (flat, not under a <screen> subfolder,
// matching the filenames these already had from prior ad hoc SNAP_OUT runs).
//
// Deliberately maxed out, not the harnesses' own comfortable defaults: a responsive sweep is
// only as useful as its worst case. The default 3-player, 1-dev-card TradePreview state is the
// easy case — it already fit at every size before these query params existed. `hand=maxed`
// (TradePreview.tsx) seeds one of every dev-card type; `players=max` fills the room to a full
// 6-player table (PLAYER_COLORS.length, the engine's real max) with longer bot names than the
// 3-player default uses, to also stress PlayerRoster's row count/name handling. `seats=full`
// (LobbyPreview.tsx) is the equivalent for the lobby screen, and already existed before this.
export const SNAP_SIZE_SCREENS: Record<string, SnapSizeScreen> = {
  game: { preview: 'trade', query: 'hand=maxed&players=max' },
  lobby: { preview: 'lobby', query: 'seats=full' },
};
