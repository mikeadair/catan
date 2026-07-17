// State gallery: drives the real app (against the Firebase Local Emulator Suite, same as
// every other e2e suite — see run-with-bridge.sh) through as many distinct, meaningful UI
// states as reasonably reachable, screenshotting each one for human/design review. Unlike
// web/e2e/layout.spec.ts (which only guards against page-level overflow at a handful of
// checkpoints) this suite's whole purpose IS the screenshots — there are no correctness
// assertions here beyond "the state we tried to reach actually rendered."
//
// Deliberately separate from every other suite (own playwright.gallery.config.ts + its
// testIgnore entry in playwright.config.ts + its own test:e2e:gallery npm script), mirroring
// the precedent set by web/e2e/latency-fuzz.spec.ts/playwright.latency.config.ts exactly — see
// that config's own header comment for the full rationale. No artificial network latency is
// injected here (that's the other suite's job); this one just wants to reach each state as
// fast as possible.
//
// How to rerun:
//   cd web && npm run test:e2e:gallery
//
// Screenshots save to e2e/state-gallery-screenshots/ (gitignored, one-off visual-review
// material — not the seeded, chance-gated captures under e2e/latency-fuzz-screenshots/).
// Filenames are purely
// descriptive (state + player, e.g. `trade-composer-with-selections.png`,
// `robber-victim-select.png`) — no seed, since reproducing an exact randomized run isn't the
// point here; each test just drives straight to the state it wants.
//
// Where a state is awkward/slow to reach by actually playing (jumping straight into 'robber'
// phase, forcing a specific mapPreset, giving a player a big/specific hand, etc.) this suite
// reuses forceRoomFields/forceHand from latency-helpers.ts — the same admin-SDK escape hatch
// the latency-fuzz suite already established for this purpose — rather than always playing
// through naturally end to end.
import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import type { TradeOffer } from '@catan/engine';
import { addBots, createRoom, joinRoomByCode, playThroughSetupForSelf, setDisplayName, startGame } from './helpers';
import {
  closeAdminApp,
  fetchPlayers,
  fetchRoom,
  fetchRoomIdByCode,
  fetchTrades,
  findUidByDisplayName,
  forceHand,
  forceRoomFields,
  newContextAndPage,
} from './latency-helpers';

const SCREENSHOT_DIR = 'e2e/state-gallery-screenshots'; // relative to web/ (the suite's cwd) — gitignored, see .gitignore
let screenshotDirReady = false;

function ensureScreenshotDir(): void {
  if (screenshotDirReady) return;
  mkdirSync(SCREENSHOT_DIR, { recursive: true });
  screenshotDirReady = true;
}

/** Always-on, descriptively-named full-page capture — no chance-gating, no seed (unlike
 * latency-helpers.ts's maybeCaptureScreenshot): this suite's whole point is the screenshots,
 * so every call captures, and the name alone should tell a human what state they're looking
 * at without cross-referencing anything else. */
async function capture(page: Page, name: string): Promise<void> {
  ensureScreenshotDir();
  const file = `${SCREENSHOT_DIR}/${name}.png`;
  await page.screenshot({ path: file, fullPage: true });
  // eslint-disable-next-line no-console
  console.log(`[state-gallery] screenshot saved: ${file}`);
}

/** Finds a hex hotspot locator whose bounding box sits clear of the top-center resource-grant/
 * roll-gains toast (Game.css's .game__resource-grant / .game__roll-gains, both position:
 * absolute over the top of the board with no pointer-events:none) — that toast can end up
 * effectively permanently stuck on screen (see Game.tsx's resourceGrantMessage/rollGainsMessage
 * effects: their cleanup cancels the pending setTimeout on almost any dependency change, e.g. a
 * room.vertices/players update, but the re-run often early-returns without rescheduling a new
 * one), which silently swallows clicks on whatever hotspot happens to sit underneath it. Falls
 * back to the first hotspot if every candidate happens to be up top (unlikely on a real board).
 */
async function firstHexHotspotClearOfToast(page: Page): Promise<import('@playwright/test').Locator> {
  const hexes = page.locator('[data-testid^="hotspot-hex-"]');
  const count = await hexes.count();
  for (let i = 0; i < count; i++) {
    const box = await hexes.nth(i).boundingBox();
    if (box && box.y > 160) return hexes.nth(i); // clear of the toast's vertical extent
  }
  return hexes.first();
}

/** Polls fetchTrades until `predicate` is satisfied or `timeoutMs` elapses, returning
 * whatever the last poll saw. Used throughout the trade-flow test below instead of a single
 * point-in-time read, since every trade action here is a real Firestore round trip. */
async function waitForTrades(roomId: string, predicate: (trades: TradeOffer[]) => boolean, timeoutMs = 15000): Promise<TradeOffer[]> {
  const deadline = Date.now() + timeoutMs;
  let trades = await fetchTrades(roomId);
  while (!predicate(trades) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
    trades = await fetchTrades(roomId);
  }
  return trades;
}

test.afterAll(async () => {
  await closeAdminApp();
});

// ---------------------------------------------------------------------------
test.describe('State gallery: home & lobby', () => {
  test('home screen and lobby states', async ({ page }) => {
    test.setTimeout(60_000);
    await setDisplayName(page, 'GalleryHost');
    await capture(page, 'home');

    await createRoom(page);
    await capture(page, 'lobby-empty');

    await addBots(page, 5); // fills every remaining seat (MAX_SEATS = 6)
    await capture(page, 'lobby-full');

    // Map picker: switching the selected preset card is the host-only lobby interaction most
    // likely to be missed in a quick pass — captured here for contrast against the
    // fog-of-war-preset game states captured later in this suite.
    await page.locator('.map-picker-card', { hasText: 'Fog of War' }).click();
    await capture(page, 'lobby-fog-of-war-map-selected');
  });
});

// ---------------------------------------------------------------------------
test.describe('State gallery: setup phase', () => {
  test('settlement/road candidates and armed previews', async ({ page }) => {
    test.setTimeout(90_000);
    await setDisplayName(page, 'GallerySetupP1');
    await createRoom(page);
    await addBots(page, 2);
    await startGame(page);

    // Turn order is shuffled at game start (see generateBoard/createGame's `shuffle(...)` in
    // rules.ts) — this player is not guaranteed to go first, and with 2 bots seated there's a
    // real chance *both* go before them (mirrors the same wait/comment in latency-fuzz.spec.ts's
    // own setup-phase test, which only ever has 1 bot ahead of it and already budgets 30s for
    // that one-bot case — this one budgets more, for up to two full bot setup turns first).
    const vertexHotspot = page.locator('[data-testid^="hotspot-vertex-"]').first();
    await vertexHotspot.waitFor({ timeout: 45000 });
    await capture(page, 'setup-settlement-candidates');

    const vertexTestId = await vertexHotspot.getAttribute('data-testid');
    const vertexId = vertexTestId!.slice('hotspot-vertex-'.length);
    const vertexLocator = page.locator(`[data-testid="hotspot-vertex-${vertexId}"]`);
    await vertexLocator.click({ force: true, timeout: 10000 }); // arm
    await page.waitForTimeout(200);
    await capture(page, 'setup-settlement-armed');

    await vertexLocator.click({ force: true, timeout: 10000 }); // confirm
    await page.waitForTimeout(500);

    const edgeHotspot = page.locator('[data-testid^="hotspot-edge-"]').first();
    await edgeHotspot.waitFor({ timeout: 15000 });
    await capture(page, 'setup-road-candidates');

    const edgeTestId = await edgeHotspot.getAttribute('data-testid');
    const edgeId = edgeTestId!.slice('hotspot-edge-'.length);
    const edgeLocator = page.locator(`[data-testid="hotspot-edge-${edgeId}"]`);
    await edgeLocator.click({ force: true, timeout: 10000 }); // arm
    await page.waitForTimeout(200);
    await capture(page, 'setup-road-armed');
  });
});

// ---------------------------------------------------------------------------
test.describe('State gallery: fog of war & gold pick', () => {
  test('fog-of-war board (hidden hexes) and the gold-pick modal', async ({ page }) => {
    test.setTimeout(90_000);
    await setDisplayName(page, 'GalleryFogP1');
    const code = await createRoom(page);
    await addBots(page, 1);
    await page.locator('.map-picker-card', { hasText: 'Fog of War' }).click();

    await startGame(page);
    await capture(page, 'fog-of-war-board'); // most hexes still show as '?' at this point

    await playThroughSetupForSelf(page);

    const roomId = await fetchRoomIdByCode(code);
    const players = await fetchPlayers(roomId);
    const uid = findUidByDisplayName(players, 'GalleryFogP1');
    const room = await fetchRoom(roomId);
    await forceRoomFields(roomId, {
      currentPlayerIndex: room.turnOrder.indexOf(uid),
      phase: 'goldPick',
      pendingGoldPicks: [{ uid, amount: 2 }],
    });
    await page.locator('.modal-overlay', { hasText: 'Struck gold!' }).waitFor({ timeout: 15000 });
    await capture(page, 'gold-pick-modal');
  });
});

// ---------------------------------------------------------------------------
test.describe('State gallery: robber phase', () => {
  test('hex picker and victim-selection steps', async ({ page }) => {
    test.setTimeout(90_000);
    await setDisplayName(page, 'GalleryRobberP1');
    const code = await createRoom(page);
    await addBots(page, 2);
    await startGame(page);
    await playThroughSetupForSelf(page);

    const roomId = await fetchRoomIdByCode(code);
    const players = await fetchPlayers(roomId);
    const uid = findUidByDisplayName(players, 'GalleryRobberP1');
    const botUids = Object.values(players)
      .filter((p) => p.isBot)
      .map((p) => p.uid);

    const room = await fetchRoom(roomId);
    const board = room.board!;
    // Pick a hex that isn't the robber's current one and force settlements from two DIFFERENT
    // bots onto its adjacent vertices — guarantees moving the robber there offers a real choice
    // of victim (computeEligibleVictims in Game.tsx needs >=2 distinct non-self owners for the
    // victim-selection step to open instead of resolving immediately).
    const targetHex = board.hexes.find((h) => h.id !== board.robberHexId)!;
    const hexVertexIds = Object.values(board.vertices)
      .filter((v) => v.adjacentHexIds.includes(targetHex.id))
      .map((v) => v.id);
    const newVertices = { ...room.vertices };
    newVertices[hexVertexIds[0]] = { type: 'settlement', uid: botUids[0] };
    newVertices[hexVertexIds[1 % hexVertexIds.length]] = { type: 'settlement', uid: botUids[1] };
    await forceRoomFields(roomId, {
      vertices: newVertices,
      currentPlayerIndex: room.turnOrder.indexOf(uid),
      phase: 'robber',
      robberPhaseStartedAt: Date.now(),
    });

    const hexLocator = page.locator(`[data-testid="hotspot-hex-${targetHex.id}"]`);
    await hexLocator.waitFor({ timeout: 15000 });
    await capture(page, 'robber-hex-picker');

    await hexLocator.click({ force: true, timeout: 10000 });
    await page.locator('.robber-modal').waitFor({ timeout: 10000 });
    await capture(page, 'robber-victim-select');
  });
});

// ---------------------------------------------------------------------------
test.describe('State gallery: dev cards', () => {
  test('dev card panel and mid-play states (year of plenty, monopoly, knight, road building)', async ({ page }) => {
    test.setTimeout(120_000);
    await setDisplayName(page, 'GalleryDevCardP1');
    const code = await createRoom(page);
    await addBots(page, 1);
    await startGame(page);
    await playThroughSetupForSelf(page);

    const roomId = await fetchRoomIdByCode(code);
    const players = await fetchPlayers(roomId);
    const uid = findUidByDisplayName(players, 'GalleryDevCardP1');

    async function resetMainPhase() {
      const r = await fetchRoom(roomId);
      await forceRoomFields(roomId, {
        currentPlayerIndex: r.turnOrder.indexOf(uid),
        phase: 'main',
        turnStartedAt: Date.now(),
        devCardPlayedThisTurn: false,
      });
    }

    await resetMainPhase();
    // boughtTurn: -1 guarantees "not bought this turn" (DevCardPanel only blocks playing a
    // card the same turn it was bought — see its boughtTurn !== turnNumber check) regardless
    // of whatever turnNumber the room actually landed on post-setup.
    await forceHand(roomId, uid, {
      resources: { brick: 8, lumber: 8, ore: 8, grain: 8, wool: 8 },
      devCards: [
        { id: 'gallery-knight', type: 'knight', boughtTurn: -1 },
        { id: 'gallery-road-building', type: 'roadBuilding', boughtTurn: -1 },
        { id: 'gallery-yop', type: 'yearOfPlenty', boughtTurn: -1 },
        { id: 'gallery-monopoly', type: 'monopoly', boughtTurn: -1 },
        { id: 'gallery-vp', type: 'victoryPoint', boughtTurn: -1 },
      ],
    });
    await page.locator('.dev-card-panel').waitFor({ timeout: 15000 });
    await capture(page, 'dev-card-panel');

    // --- Year of Plenty: opens a local, cancel-able modal — never dispatches, so it can't
    // consume the card or flip devCardPlayedThisTurn.
    await page.locator('.dev-card-panel__card', { hasText: 'Year of Plenty' }).locator('.dev-card-panel__play').click({ timeout: 10000 });
    await page.locator('.modal', { hasText: 'Year of Plenty' }).waitFor({ timeout: 10000 });
    await capture(page, 'dev-card-year-of-plenty-modal');
    await page.locator('.modal', { hasText: 'Year of Plenty' }).locator('button', { hasText: 'Cancel' }).click({ timeout: 10000 });

    // --- Monopoly: same cancel-able-modal shape as Year of Plenty above.
    await page.locator('.dev-card-panel__card', { hasText: 'Monopoly' }).locator('.dev-card-panel__play').click({ timeout: 10000 });
    await page.locator('.modal', { hasText: 'Pick a resource' }).waitFor({ timeout: 10000 });
    await capture(page, 'dev-card-monopoly-modal');
    await page.locator('.modal', { hasText: 'Pick a resource' }).locator('button', { hasText: 'Cancel' }).click({ timeout: 10000 });

    // --- Knight: real play (moves the robber for real) — only 2 players seated (self + 1
    // bot), so computeEligibleVictims can never return more than 1 candidate here, meaning
    // this always resolves immediately on a single hex click (no victim-selection modal to
    // navigate around) — that step is covered separately by the robber-phase test above.
    await page.locator('.dev-card-panel__card', { hasText: 'Knight' }).locator('.dev-card-panel__play').click({ timeout: 10000 });
    await page.locator('[data-testid^="hotspot-hex-"]').first().waitFor({ timeout: 15000 });
    await capture(page, 'dev-card-knight-robber-placement');
    const knightHexHotspot = await firstHexHotspotClearOfToast(page);
    await knightHexHotspot.click({ force: true, timeout: 10000 });
    // Wait for the actual playKnight dispatch to settle (the robber-banner/hex-picker only
    // clears once Game.tsx's local knightPending guard is cleared, which only happens on a
    // successful dispatch — see finishRobberMove) rather than a fixed timeout. A fixed wait
    // here previously raced resetMainPhase()'s admin-SDK write below against the still-in-
    // flight submitAction call: forcing room.phase back to 'main' before the server-side
    // playKnight transaction had committed made that transaction fail its own precondition
    // checks, leaving knightPending stuck true forever — which (since robberHexStep is
    // checked before roadBuildingPending in Game.tsx's interactionMode priority chain) then
    // silently absorbed every subsequent Road Building click with no visible effect at all.
    await expect(page.locator('.robber-banner'), 'knight play should resolve and clear the hex-picker banner').toHaveCount(0, {
      timeout: 15000,
    });

    // --- Road Building: real play (grants 2 free roads) — capture the first-edge-picked
    // pending state (rendered as a same-style road-preview, see Board.tsx) before finishing it.
    await resetMainPhase(); // knight play above flipped devCardPlayedThisTurn; undo for this card
    await page.locator('.dev-card-panel__card', { hasText: 'Road Building' }).locator('.dev-card-panel__play').click({ timeout: 10000 });
    const firstEdgeHotspot = page.locator('[data-testid^="hotspot-edge-"]').first();
    await firstEdgeHotspot.waitFor({ timeout: 15000 });
    const firstEdgeTestId = await firstEdgeHotspot.getAttribute('data-testid');
    await firstEdgeHotspot.click({ force: true, timeout: 10000 });
    await page.waitForTimeout(300);
    await capture(page, 'dev-card-road-building-first-edge-picked');
    // Must pick a genuinely different edge for the second one — the first edge (not yet
    // committed to room.edges, only staged client-side) can still appear in its own
    // candidate set.
    const secondEdgeHotspot = page.locator(`[data-testid^="hotspot-edge-"]:not([data-testid="${firstEdgeTestId}"])`).first();
    if ((await secondEdgeHotspot.count()) > 0) {
      await secondEdgeHotspot.click({ force: true, timeout: 10000 });
    }
  });
});

// ---------------------------------------------------------------------------
test.describe('State gallery: trade flows', () => {
  test('composer, pending offers with responder dots, and an all-rejected flash', async ({ browser }) => {
    test.setTimeout(150_000);
    const { context: p1Context, page: p1Page } = await newContextAndPage(browser);
    const { context: p2Context, page: p2Page } = await newContextAndPage(browser);

    try {
      await setDisplayName(p1Page, 'GalleryTradeP1');
      const code = await createRoom(p1Page);
      await joinRoomByCode(p2Page, 'GalleryTradeP2', code);
      await startGame(p1Page);
      await p2Page.waitForSelector('.game__board-area', { timeout: 20000 });

      await Promise.all([playThroughSetupForSelf(p1Page), playThroughSetupForSelf(p2Page)]);

      const roomId = await fetchRoomIdByCode(code);
      const players = await fetchPlayers(roomId);
      const uidP1 = findUidByDisplayName(players, 'GalleryTradeP1');
      const uidP2 = findUidByDisplayName(players, 'GalleryTradeP2');

      const room = await fetchRoom(roomId);
      await forceRoomFields(roomId, {
        currentPlayerIndex: room.turnOrder.indexOf(uidP1),
        phase: 'main',
        turnStartedAt: Date.now(),
        devCardPlayedThisTurn: false,
      });
      const ample = { brick: 5, lumber: 5, ore: 5, grain: 5, wool: 5 };
      await forceHand(roomId, uidP1, { resources: { ...ample }, devCards: [] });
      await forceHand(roomId, uidP2, { resources: { ...ample }, devCards: [] });

      await p1Page.locator('button:has-text("Trade")').click({ timeout: 15000 });
      await capture(p1Page, 'trade-composer-empty');

      await p1Page.locator('[data-testid="hand-card"][data-resource="ore"]').first().click({ timeout: 15000 });
      await p1Page.locator('[data-testid="hand-card"][data-resource="grain"]').first().click({ timeout: 15000 });
      await p1Page.locator('button[aria-label="Add Wool to what you want"]').click({ timeout: 15000 });
      await capture(p1Page, 'trade-composer-with-selections');

      // --- Open trade (targetUid null) — proposer + responder perspectives, then the
      // responder expressing interest (the "interested" state a responder dot turns green for).
      await p1Page.locator('button:has-text("Offer Trade")').click({ timeout: 15000 });
      const afterOpen = await waitForTrades(roomId, (t) => t.some((x) => x.status === 'pending'));
      const openTradeId = afterOpen.find((x) => x.status === 'pending')!.id;

      await p1Page.locator(`[data-testid="trade-${openTradeId}"]`).waitFor({ timeout: 15000 });
      await capture(p1Page, 'trade-offer-open-proposer-view');

      await p2Page.locator(`[data-testid="trade-${openTradeId}"]`).waitFor({ timeout: 15000 });
      await capture(p2Page, 'trade-offer-pending-responder-view');

      await p2Page.locator(`[data-testid="trade-${openTradeId}"] button:has-text("Accept")`).click({ timeout: 15000 });
      await waitForTrades(roomId, (t) => !!t.find((x) => x.id === openTradeId)?.interestedUids?.includes(uidP2));
      await p1Page.locator(`[data-testid="trade-${openTradeId}"] button:has-text("Trade with")`).waitFor({ timeout: 15000 });
      await capture(p1Page, 'trade-offer-interested-view');

      await p1Page.locator(`[data-testid="trade-${openTradeId}"] button:has-text("Trade with")`).click({ timeout: 15000 });
      await expect(p1Page.locator(`[data-testid="trade-${openTradeId}"]`), 'trade card should disappear once finalized').toHaveCount(0, {
        timeout: 15000,
      });

      // --- Targeted trade, rejected by its sole responder -> the brief all-rejected red-flash
      // dismiss state (TradeOffers.tsx's ALL_REJECTED_FLASH_MS window). The composer's give/
      // receive/target selection is cleared automatically once a trade actually goes through
      // (see Game.tsx's handleProposeTrade), so both sides need staging fresh here rather than
      // assuming last trade's "want wool" selection is still sitting there.
      const clearGiveBtn = p1Page.locator('.game__toolbar-clear-give');
      if ((await clearGiveBtn.count()) > 0) await clearGiveBtn.click({ timeout: 10000 });
      await p1Page.locator('[data-testid="hand-card"][data-resource="brick"]').first().click({ timeout: 15000 });
      await p1Page.locator('button[aria-label="Add Wool to what you want"]').click({ timeout: 15000 });
      await p1Page.locator('select[aria-label="Trade target"]').selectOption(uidP2, { timeout: 15000 });
      await p1Page.locator('button:has-text("Offer Trade")').click({ timeout: 15000 });

      const afterTargeted = await waitForTrades(roomId, (t) => t.some((x) => x.status === 'pending' && x.id !== openTradeId));
      const targetedTradeId = afterTargeted.find((x) => x.status === 'pending' && x.id !== openTradeId)!.id;
      await p2Page.locator(`[data-testid="trade-${targetedTradeId}"] button:has-text("Reject")`).waitFor({ timeout: 15000 });
      await p2Page.locator(`[data-testid="trade-${targetedTradeId}"] button:has-text("Reject")`).click({ timeout: 15000 });

      await p1Page.waitForTimeout(300); // land somewhere inside the ~1.8s all-rejected flash window
      await capture(p1Page, 'trade-all-rejected-flash');
    } finally {
      await p1Context.close();
      await p2Context.close();
    }
  });
});

// ---------------------------------------------------------------------------
test.describe('State gallery: mid-game board, build toolbar, game log, pause & leave', () => {
  test('a busy board, build-mode candidates, turn timer, game log sizes, pause, and leave-confirm', async ({ page }) => {
    test.setTimeout(150_000);
    await setDisplayName(page, 'GalleryMidGameP1');
    const code = await createRoom(page);
    await addBots(page, 2);

    const roomIdEarly = await fetchRoomIdByCode(code);
    await forceRoomFields(roomIdEarly, { turnTimerSeconds: 120 }); // lobby-only setting; enabled here so it's visibly counting down later

    await startGame(page);
    await playThroughSetupForSelf(page);
    await capture(page, 'game-board-normal-preset'); // contrast against fog-of-war-board.png

    const roomId = await fetchRoomIdByCode(code);
    const players = await fetchPlayers(roomId);
    const uid = findUidByDisplayName(players, 'GalleryMidGameP1');
    const botUids = Object.values(players)
      .filter((p) => p.isBot)
      .map((p) => p.uid);

    // Force a handful of extra roads/settlements/cities across owners directly onto the board
    // doc — far faster than actually playing them out, and legality doesn't matter for a pure
    // visual-coverage screenshot (Board.tsx just draws whatever's in room.vertices/room.edges).
    const room = await fetchRoom(roomId);
    const board = room.board!;
    const usedVertexIds = new Set(Object.keys(room.vertices));
    const usedEdgeIds = new Set(Object.keys(room.edges));
    const freeVertexIds = Object.keys(board.vertices).filter((id) => !usedVertexIds.has(id));
    const freeEdgeIds = Object.keys(board.edges).filter((id) => !usedEdgeIds.has(id));
    const owners = [uid, botUids[0], botUids[1]];
    const newVertices = { ...room.vertices };
    for (let i = 0; i < Math.min(6, freeVertexIds.length); i++) {
      newVertices[freeVertexIds[i]] = { type: i % 4 === 0 ? 'city' : 'settlement', uid: owners[i % owners.length] };
    }
    const newEdges = { ...room.edges };
    for (let i = 0; i < Math.min(8, freeEdgeIds.length); i++) {
      newEdges[freeEdgeIds[i]] = owners[i % owners.length];
    }
    // Retry-verified: right after setup, the bot-turn poller running in this same page (see
    // state/store.ts) may have a bot action already in flight against the *pre-force* board —
    // its own submitAction transaction re-reads fresh state and merges rather than clobbers,
    // but has occasionally been observed to land right after this write and leave the extra
    // buildings not visibly reflected. Verifying (and re-issuing if needed) is far simpler than
    // fully synchronizing with the bot poller's internal timing.
    const markerVertexId = freeVertexIds[0];
    for (let attempt = 0; attempt < 3; attempt++) {
      await forceRoomFields(roomId, {
        vertices: newVertices,
        edges: newEdges,
        currentPlayerIndex: room.turnOrder.indexOf(uid),
        phase: 'main',
        turnStartedAt: Date.now(),
        devCardPlayedThisTurn: false,
      });
      await new Promise((r) => setTimeout(r, 400));
      const settled = await fetchRoom(roomId);
      if (!markerVertexId || settled.vertices[markerVertexId]?.uid === newVertices[markerVertexId]?.uid) break;
    }
    await forceHand(roomId, uid, { resources: { brick: 8, lumber: 8, ore: 8, grain: 8, wool: 8 }, devCards: [] });
    await page.waitForTimeout(500); // let the client's listeners catch up on the forced board state
    await capture(page, 'mid-game-board-many-buildings');
    await capture(page, 'turn-timer-counting'); // same view — .turn-timer sits in the toolbar's bottom-right

    await page.locator('.build-toolbar__button:has-text("Road")').click({ timeout: 15000 });
    await page.locator('[data-testid^="hotspot-edge-"]').first().waitFor({ timeout: 15000 });
    await capture(page, 'build-toolbar-road-mode-candidates');

    await page.locator('.build-toolbar__button:has-text("Settlement")').click({ timeout: 15000 });
    await page.waitForTimeout(300);
    await capture(page, 'build-toolbar-settlement-mode-candidates');

    await page.locator('.build-toolbar__button:has-text("City")').click({ timeout: 15000 });
    await page.waitForTimeout(300);
    await capture(page, 'build-toolbar-city-mode-candidates');

    // Deactivate build mode before touching the game log — an active build mode's pulsing
    // board hotspots aren't relevant to what's being captured from here on.
    await page.locator('.build-toolbar__button--active').click({ timeout: 15000 }).catch(() => {});

    // --- Game log: default 'medium' size, then cycle through 'large'/'small', then toggle
    // auto-scroll off.
    await capture(page, 'game-log-medium');
    await page.locator('.game-log__icon-btn--size').click({ timeout: 10000 });
    await capture(page, 'game-log-large');
    await page.locator('.game-log__icon-btn--size').click({ timeout: 10000 });
    await capture(page, 'game-log-small');
    await page.locator('.game-log__header-actions button[aria-pressed]').click({ timeout: 10000 });
    await capture(page, 'game-log-autoscroll-off');

    // --- Pause: with only 1 non-bot player seated, a single vote immediately pauses the room.
    await page.locator('.pause-control').click({ timeout: 15000 });
    await page.locator('.pause-control--paused').waitFor({ timeout: 10000 });
    await capture(page, 'game-paused');

    // --- Leave-confirm modal (client-only state, no server round trip) — captured, then
    // cancelled so the room stays alive for the remaining captures below.
    await page.locator('.game__leave-button').click({ timeout: 10000 });
    await page.locator('.modal', { hasText: 'Leave game?' }).waitFor({ timeout: 10000 });
    await capture(page, 'leave-confirm-modal');
    await page.locator('.modal', { hasText: 'Leave game?' }).locator('button', { hasText: 'Cancel' }).click({ timeout: 10000 });

    // --- Unpause + discard modal (rolled-a-7 with a big, lopsided hand — ResourceHand's
    // 'cards' variant renders one stack per resource type rather than one element per card, so
    // 12 lumber renders as a single "12" stack rather than a wall of card faces).
    await forceRoomFields(roomId, { paused: false, pausedAt: null });
    await forceHand(roomId, uid, { resources: { brick: 2, lumber: 12, ore: 2, grain: 1, wool: 1 }, devCards: [] });
    await forceRoomFields(roomId, { phase: 'discard', pendingDiscardUids: [uid], discardPhaseStartedAt: Date.now() });
    await page.locator('.discard-modal').waitFor({ timeout: 15000 });
    await capture(page, 'discard-modal-with-large-hand');
  });
});

// ---------------------------------------------------------------------------
test.describe('State gallery: end of game', () => {
  test('the winner screen', async ({ page }) => {
    test.setTimeout(60_000);
    await setDisplayName(page, 'GalleryWinner');
    const code = await createRoom(page);
    await addBots(page, 1);
    await startGame(page);
    await playThroughSetupForSelf(page);

    const roomId = await fetchRoomIdByCode(code);
    const players = await fetchPlayers(roomId);
    const uid = findUidByDisplayName(players, 'GalleryWinner');
    await forceRoomFields(roomId, { phase: 'gameOver', winnerUid: uid });
    await page.locator('.game-over').waitFor({ timeout: 15000 });
    await capture(page, 'game-over-screen');
  });
});
