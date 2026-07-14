// Latency-fuzz suite: hunts for race conditions between the client's optimistic/local UI
// state and delayed server confirmation, by actually driving the app through real CDP
// network throttling instead of relying on fast-localhost round trips (where these bugs are
// invisible — see the already-fixed Board.tsx armed-preview bug this suite guards against).
//
// Kept separate from the main `npm run test:e2e` suite (its own `test:e2e:latency` script,
// below) rather than folded in: it's inherently slower (real injected latency + generous
// settle windows) and, being latency-driven, more probabilistic than the plain-localhost
// layout suite — mirrors why playwright.config.ts's `workers: 1` rationale gets its own
// comment there. Nobody should have this gating their everyday inner loop; it's meant to be
// run deliberately (locally, or as a scheduled/opt-in CI job) when hunting for or verifying a
// fix to this class of bug.
//
// How to rerun:
//   cd web && npm run test:e2e:latency
//
// How to reproduce a specific failure: every run logs its seed to the console on start
// (`[latency-fuzz] seed = ...`) and every latency change it applies throughout
// (`[latency-fuzz] <label>: <ms>ms`). Rerun with that exact seed to replay the same sequence
// of injected latency values:
//   LATENCY_SEED=12345 npm run test:e2e:latency
// Note that this only pins the *latency* sequence — bot decision timing (BOT_TRADE_RESPONSE_
// DELAY_*_MS in state/store.ts) and real wall-clock scheduling are not seeded, so a replay is
// "much more likely to hit the same window," not bit-for-bit identical. In practice that's
// been enough to reliably reproduce every bug this suite has caught so far.
//
// The oracle: every assertion here compares the rendered DOM (via data-testid/data-* hooks
// added to Board.tsx/TradeOffers.tsx/ResourceHand.tsx specifically for this suite — inert,
// no visual/behavioral change) against the *authoritative* Firestore state, read directly via
// firebase-admin from the untouched Node test process (see latency-helpers.ts) — a path
// entirely separate from the app's own (CDP-throttled) Firestore listeners, so it's a real
// independent ground truth rather than "does the DOM match the client's own possibly-stale
// state" (which would always trivially pass).
//
// Coverage in this pass: build actions (roads/cities) under randomized asymmetric latency
// across two human contexts, a robber-phase manual-vs-timeout race (regression coverage for
// the Game.tsx robberMoveSubmitted fix — see that file), and a trade-lifecycle check that a
// bot-accepted trade doesn't get stuck rendering as pending. Discard-phase's analogous
// manual-vs-timeout race is NOT covered here (same shape as the robber-phase test, and no bug
// was found in that path — DiscardModal's visibility is fully derived from room state with no
// local-state gate to go stale — but a dedicated regression test would be a reasonable
// follow-up for whoever extends this suite next).
//
// Screenshots — two independent, non-analyzed signals for human review, neither of which
// this file itself inspects the pixels of:
//   1. maybeCaptureScreenshot: full-page screenshots of each active player's view at a
//      handful of checkpoints through each scenario, ALWAYS saved (gated only by the same
//      seeded `rng` used for latency, so a rerun with the same LATENCY_SEED captures the same
//      set) — general skim-review material, named `seed<seed>_<scenario>_<checkpoint>_<player>.png`.
//   2. withFailureScreenshots: wraps every oracle checkpoint (DOM-vs-server comparison) with
//      an in-memory (not written to disk) before/after screenshot of every relevant page —
//      persisted to disk ONLY if that checkpoint actually found a divergence, named
//      `FAILURE_seed<seed>_<scenario>_<checkpoint>_<player>_{before,after}.png`. A normal
//      passing run writes none of these; when one does fire, its console log line sits right
//      next to the failing expect()'s own output so a human can immediately correlate the
//      specific assertion failure with the exact visual transition that produced it.
// Both save under e2e/latency-fuzz-screenshots/ (gitignored — ad hoc per-run output, not the
// committed baseline images under e2e/screenshots/).
import { expect, test } from '@playwright/test';
import { addBots, createRoom, joinRoomByCode, playThroughSetupForSelf, setDisplayName, startGame } from './helpers';
import {
  closeAdminApp,
  diffTrades,
  fetchHand,
  fetchPlayers,
  fetchRoom,
  fetchRoomIdByCode,
  fetchTrades,
  findUidByDisplayName,
  forceHand,
  forceRoomFields,
  isEdgeVisuallyRepresented,
  isVertexVisuallyRepresented,
  maybeCaptureScreenshot,
  mulberry32,
  newContextAndPage,
  resolveSeed,
  startRandomLatency,
  waitForBoardStateToSettle,
  withFailureScreenshots,
} from './latency-helpers';

// Mirrors packages/engine/src/types.ts's ROBBER_TIMEOUT_SECONDS export — kept as a literal
// here rather than imported at runtime: @catan/engine's compiled dist is CommonJS and depends
// on nanoid (an ESM-only package as of v5), which Vite bundles transparently for the app but
// which fails a raw Node `require()` under Playwright's own test-file loader (helpers.ts and
// layout.spec.ts avoid this the same way — no runtime imports from '@catan/engine'; type-only
// imports in latency-helpers.ts are fine, since verbatimModuleSyntax elides them entirely).
const ROBBER_TIMEOUT_SECONDS = 30;

const SEED = resolveSeed();
// eslint-disable-next-line no-console
console.log(`[latency-fuzz] seed = ${SEED} (rerun with LATENCY_SEED=${SEED} npm run test:e2e:latency to reproduce)`);

test.afterAll(async () => {
  await closeAdminApp();
});

test.describe('Latency fuzz: build actions', () => {
  test('roads and city upgrades render correctly under randomized asymmetric latency', async ({ browser }) => {
    test.setTimeout(150_000);
    const rng = mulberry32(SEED);

    const { context: p1Context, page: p1Page } = await newContextAndPage(browser);
    const { context: p2Context, page: p2Page } = await newContextAndPage(browser);

    await setDisplayName(p1Page, 'LatencyP1');
    const code = await createRoom(p1Page);
    await addBots(p1Page, 1);
    await joinRoomByCode(p2Page, 'LatencyP2', code);
    await startGame(p1Page);
    await p2Page.waitForSelector('.game__board-area', { timeout: 20000 });

    // Setup placements happen fast (no latency injected yet) — the interesting part of this
    // test is what happens once real, independently-randomized latency is live for both
    // human clients simultaneously.
    await Promise.all([playThroughSetupForSelf(p1Page), playThroughSetupForSelf(p2Page)]);

    const roomId = await fetchRoomIdByCode(code);
    const players = await fetchPlayers(roomId);
    const uidP1 = findUidByDisplayName(players, 'LatencyP1');

    const p1Latency = await startRandomLatency(p1Context, p1Page, rng, 'P1 (actor)');
    const p2Latency = await startRandomLatency(p2Context, p2Page, rng, 'P2 (observer)');

    await maybeCaptureScreenshot(rng, p1Page, SEED, 'build-actions', 'after-setup', 'P1');
    await maybeCaptureScreenshot(rng, p2Page, SEED, 'build-actions', 'after-setup', 'P2');

    try {
      const room = await fetchRoom(roomId);
      await forceRoomFields(roomId, {
        currentPlayerIndex: room.turnOrder.indexOf(uidP1),
        phase: 'main',
        turnStartedAt: Date.now(),
        devCardPlayedThisTurn: false,
      });
      await forceHand(roomId, uidP1, { resources: { brick: 6, lumber: 6, ore: 6, grain: 6, wool: 6 }, devCards: [] });

      // --- Build a road ---
      await p1Page.locator('.build-toolbar__button:has-text("Road")').click({ timeout: 20000 });
      const edgeHotspot = p1Page.locator('[data-testid^="hotspot-edge-"]').first();
      await edgeHotspot.waitFor({ timeout: 20000 });
      const edgeTestId = await edgeHotspot.getAttribute('data-testid');
      const edgeId = edgeTestId!.slice('hotspot-edge-'.length);
      const edgeLocator = p1Page.locator(`[data-testid="hotspot-edge-${edgeId}"]`);
      await edgeLocator.click({ force: true, timeout: 10000 }); // arm
      await maybeCaptureScreenshot(rng, p1Page, SEED, 'build-actions', 'road-armed', 'P1');
      await p1Page.waitForTimeout(200);

      // Tight gap-check, wrapped so a failure here saves the exact before/after transition:
      // from the moment of confirmation to the moment the server-committed edge shows up in
      // the oracle, *something* (the armed preview or the real road) must always visually
      // represent this edge — this is exactly the invariant the original Board.tsx
      // armed-preview bug violated (see that file's fix comment).
      const gaps = await withFailureScreenshots({ P1: p1Page }, SEED, 'build-actions', 'road-gap-check', async () => {
        await edgeLocator.click({ force: true, timeout: 10000 }); // confirm -> dispatches buildRoad
        const g: string[] = [];
        const gapCheckDeadline = Date.now() + 8000;
        for (;;) {
          const represented = await isEdgeVisuallyRepresented(p1Page, edgeId);
          if (!represented) g.push(`tick ${Date.now()}: neither road nor armed preview rendered for edge ${edgeId}`);
          const liveRoom = await fetchRoom(roomId);
          if (liveRoom.edges[edgeId]) break; // server has committed it — stop watching for the gap
          if (Date.now() > gapCheckDeadline) break;
          await p1Page.waitForTimeout(75);
        }
        return g;
      });
      expect(gaps, `edge ${edgeId}: gap(s) with neither a road nor an armed preview rendered between confirm and server commit`).toEqual([]);

      const roadSettleDiffs = await withFailureScreenshots({ P1: p1Page, P2: p2Page }, SEED, 'build-actions', 'road-settle', async () => {
        const p1Diffs = await waitForBoardStateToSettle(p1Page, roomId, 8000);
        const p2Diffs = await waitForBoardStateToSettle(p2Page, roomId, 8000);
        return [...p1Diffs.map((d) => `P1: ${d}`), ...p2Diffs.map((d) => `P2 (observer): ${d}`)];
      });
      expect(roadSettleDiffs, 'P1/P2 board state vs server after building a road').toEqual([]);
      await maybeCaptureScreenshot(rng, p1Page, SEED, 'build-actions', 'road-settled', 'P1');
      await maybeCaptureScreenshot(rng, p2Page, SEED, 'build-actions', 'road-settled', 'P2');

      // --- Upgrade a setup settlement to a city ---
      const roomAfterRoad = await fetchRoom(roomId);
      await forceRoomFields(roomId, {
        currentPlayerIndex: roomAfterRoad.turnOrder.indexOf(uidP1),
        phase: 'main',
        turnStartedAt: Date.now(),
        devCardPlayedThisTurn: false,
      });
      const ownSettlementVertexId = Object.entries(roomAfterRoad.vertices).find(([, b]) => b.uid === uidP1 && b.type === 'settlement')?.[0];
      expect(ownSettlementVertexId, 'expected P1 to still have a settlement left to upgrade').toBeTruthy();

      await p1Page.locator('.build-toolbar__button:has-text("City")').click({ timeout: 20000 });
      const vertexLocator = p1Page.locator(`[data-testid="hotspot-vertex-${ownSettlementVertexId}"]`);
      await vertexLocator.waitFor({ timeout: 20000 });
      await vertexLocator.click({ force: true, timeout: 10000 }); // arm
      await maybeCaptureScreenshot(rng, p1Page, SEED, 'build-actions', 'city-armed', 'P1');
      await p1Page.waitForTimeout(200);

      const gaps2 = await withFailureScreenshots({ P1: p1Page }, SEED, 'build-actions', 'city-gap-check', async () => {
        await vertexLocator.click({ force: true, timeout: 10000 }); // confirm -> dispatches buildCity
        const g: string[] = [];
        const gapCheckDeadline2 = Date.now() + 8000;
        for (;;) {
          const represented = await isVertexVisuallyRepresented(p1Page, ownSettlementVertexId!);
          if (!represented) g.push(`tick ${Date.now()}: neither building nor armed preview rendered for vertex ${ownSettlementVertexId}`);
          const liveRoom = await fetchRoom(roomId);
          if (liveRoom.vertices[ownSettlementVertexId!]?.type === 'city') break;
          if (Date.now() > gapCheckDeadline2) break;
          await p1Page.waitForTimeout(75);
        }
        return g;
      });
      expect(gaps2, `vertex ${ownSettlementVertexId}: gap(s) with neither a building nor an armed preview rendered between confirm and server commit`).toEqual([]);

      const citySettleDiffs = await withFailureScreenshots({ P1: p1Page, P2: p2Page }, SEED, 'build-actions', 'city-settle', async () => {
        const p1Diffs = await waitForBoardStateToSettle(p1Page, roomId, 8000);
        const p2Diffs = await waitForBoardStateToSettle(p2Page, roomId, 8000);
        return [...p1Diffs.map((d) => `P1: ${d}`), ...p2Diffs.map((d) => `P2 (observer): ${d}`)];
      });
      expect(citySettleDiffs, 'P1/P2 board state vs server after upgrading to a city').toEqual([]);
      await maybeCaptureScreenshot(rng, p1Page, SEED, 'build-actions', 'city-settled', 'P1');
      await maybeCaptureScreenshot(rng, p2Page, SEED, 'build-actions', 'city-settled', 'P2');
    } finally {
      await p1Latency.stop();
      await p2Latency.stop();
      await p1Context.close();
      await p2Context.close();
    }
  });
});

test.describe('Latency fuzz: robber phase', () => {
  test('manual robber placement racing the auto-timeout never leaves the hex-picker stuck open', async ({ browser }) => {
    test.setTimeout(120_000);
    const rng = mulberry32(SEED + 1);
    const { context: p1Context, page: p1Page } = await newContextAndPage(browser);

    await setDisplayName(p1Page, 'LatencyRobberP1');
    const code = await createRoom(p1Page);
    await addBots(p1Page, 2);
    await startGame(p1Page);
    await playThroughSetupForSelf(p1Page);

    const roomId = await fetchRoomIdByCode(code);
    const players = await fetchPlayers(roomId);
    const uidP1 = findUidByDisplayName(players, 'LatencyRobberP1');

    const p1Latency = await startRandomLatency(p1Context, p1Page, rng, 'P1 (robber)');
    try {
      const room = await fetchRoom(roomId);
      const currentHex = room.board!.robberHexId;
      const targetHex = room.board!.hexes.find((h) => h.id !== currentHex)!.id;

      // Force 'robber' phase for P1 with the server-side auto-timeout due to fire ~2.5s from
      // now — long enough for P1's own (latency-throttled) listener to catch up and render
      // the hex picker, short enough that the manual-click-vs-auto-timeout race actually
      // happens within this test's patience.
      await forceRoomFields(roomId, {
        currentPlayerIndex: room.turnOrder.indexOf(uidP1),
        phase: 'robber',
        robberPhaseStartedAt: Date.now() - (ROBBER_TIMEOUT_SECONDS * 1000 - 2500),
      });

      const hexLocator = p1Page.locator(`[data-testid="hotspot-hex-${targetHex}"]`);
      await hexLocator.waitFor({ timeout: 15000 });
      await maybeCaptureScreenshot(rng, p1Page, SEED, 'robber-phase', 'hex-picker-open', 'P1');
      await hexLocator.click({ force: true, timeout: 5000 });

      // Whichever of {P1's manual moveRobber, the app's own auto timeoutRobber effect} wins
      // server-side, the room must settle into a real post-robber phase (never stuck showing
      // 'robber' forever) with the robber having actually moved exactly once.
      let settledRoom = room;
      const settleDeadline = Date.now() + 15000;
      while (Date.now() < settleDeadline) {
        settledRoom = await fetchRoom(roomId);
        if (settledRoom.phase !== 'robber') break;
        await p1Page.waitForTimeout(200);
      }
      expect(settledRoom.phase, 'room should have left robber phase once either action landed').not.toBe('robber');
      expect(settledRoom.board!.robberHexId, 'robber should have actually moved off its original hex').not.toBe(currentHex);
      await maybeCaptureScreenshot(rng, p1Page, SEED, 'robber-phase', 'settled', 'P1');

      // Regression coverage for Game.tsx's robberMoveSubmitted guard: previously, the instant
      // the *winning* action's dispatch promise resolved, the client cleared its local
      // knightPending/robberVictimStep guards unconditionally and re-derived robberHexStep
      // straight from room.phase — which, if the client's own listener snapshot hadn't yet
      // caught up past 'robber', re-opened the hex picker (and its "choose a hex" banner) for
      // an instant, inviting a second, server-rejected moveRobber submission. Sample
      // repeatedly for a few seconds after the phase has genuinely moved on — it must never
      // come back.
      const reopenTicks = await withFailureScreenshots({ P1: p1Page }, SEED, 'robber-phase', 'reopen-watch', async () => {
        const ticks: string[] = [];
        const watchDeadline = Date.now() + 3000;
        while (Date.now() < watchDeadline) {
          const hexHotspots = await p1Page.locator('[data-testid^="hotspot-hex-"]').count();
          const banner = await p1Page.locator('.robber-banner').count();
          if (hexHotspots > 0 || banner > 0) {
            ticks.push(`tick ${Date.now()}: hexHotspots=${hexHotspots} robber-banner=${banner}`);
          }
          await p1Page.waitForTimeout(150);
        }
        return ticks;
      });
      expect(reopenTicks, 'robber hex-picker UI should not reopen once the room has moved past robber phase').toEqual([]);
    } finally {
      await p1Latency.stop();
      await p1Context.close();
    }
  });
});

test.describe('Latency fuzz: trade lifecycle', () => {
  test('a bot-accepted trade resolves in the UI instead of getting stuck as pending', async ({ browser }) => {
    test.setTimeout(90_000);
    const rng = mulberry32(SEED + 2);
    const { context: p1Context, page: p1Page } = await newContextAndPage(browser);

    await setDisplayName(p1Page, 'LatencyTradeP1');
    const code = await createRoom(p1Page);
    await addBots(p1Page, 1);
    await startGame(p1Page);
    await playThroughSetupForSelf(p1Page);

    const roomId = await fetchRoomIdByCode(code);
    const players = await fetchPlayers(roomId);
    const uidP1 = findUidByDisplayName(players, 'LatencyTradeP1');
    const botUid = Object.values(players).find((p) => p.isBot)!.uid;

    const p1Latency = await startRandomLatency(p1Context, p1Page, rng, 'P1 (trader)');
    try {
      const room = await fetchRoom(roomId);
      await forceRoomFields(roomId, {
        currentPlayerIndex: room.turnOrder.indexOf(uidP1),
        phase: 'main',
        turnStartedAt: Date.now(),
      });
      await forceHand(roomId, uidP1, { resources: { brick: 3, lumber: 3, ore: 3, grain: 3, wool: 3 }, devCards: [] });
      // Guarantee the bot can actually afford to accept: it needs >=1 wool to hand over.
      const botHand = await fetchHand(roomId, botUid);
      await forceHand(roomId, botUid, { resources: { brick: 3, lumber: 3, ore: 3, grain: 3, wool: 3 }, devCards: botHand?.devCards ?? [] });

      await p1Page.locator('button:has-text("Trade")').click({ timeout: 15000 });

      // Give 1 ore + 1 grain, want 1 wool back — a clearly bot-favorable 2-for-1, so it
      // should be accepted regardless of bot difficulty (see decideTradeResponse in
      // packages/engine/src/bots.ts).
      await p1Page.locator('[data-testid="hand-card"][data-resource="ore"]').first().click({ timeout: 15000 });
      await p1Page.locator('[data-testid="hand-card"][data-resource="grain"]').first().click({ timeout: 15000 });
      // Note the capital "Wool" — TradeBar.tsx builds this label from RESOURCE_LABEL, which
      // is capitalized (see resourceIcons.ts); attribute-value selectors are case-sensitive.
      await p1Page.locator('button[aria-label="Add Wool to what you want"]').click({ timeout: 15000 });
      await p1Page.locator('select[aria-label="Trade target"]').selectOption(botUid, { timeout: 15000 });
      await p1Page.locator('button:has-text("Offer Trade")').click({ timeout: 15000 });

      const proposed = await expectSingleTrade(roomId);
      const tradeId = proposed.id;
      await p1Page.locator(`[data-testid="trade-${tradeId}"]`).waitFor({ timeout: 15000 });
      await maybeCaptureScreenshot(rng, p1Page, SEED, 'trade-lifecycle', 'proposed', 'P1');

      // Wait out the bot's randomized reaction delay (BOT_TRADE_RESPONSE_DELAY_*_MS in
      // state/store.ts is 1-5s) plus injected latency on top for the round trip.
      let resolvedStatus = proposed.status;
      const deadline = Date.now() + 20000;
      while (Date.now() < deadline) {
        const trades = await fetchTrades(roomId);
        const t = trades.find((x) => x.id === tradeId);
        if (t) resolvedStatus = t.status;
        if (resolvedStatus !== 'pending') break;
        await p1Page.waitForTimeout(200);
      }
      expect(resolvedStatus, 'bot should have accepted this clearly favorable trade').toBe('accepted');
      await maybeCaptureScreenshot(rng, p1Page, SEED, 'trade-lifecycle', 'resolved', 'P1');

      // Once resolved server-side, the DOM must stop showing it as an active pending trade —
      // exactly the "stuck showing pending" divergence the responder-status UI could suffer
      // from under latency.
      await expect(
        p1Page.locator(`[data-testid="trade-${tradeId}"]`),
        'trade card should disappear once accepted, not linger as pending',
      ).toHaveCount(0, { timeout: 10000 });

      const tradeDiffs = await withFailureScreenshots({ P1: p1Page }, SEED, 'trade-lifecycle', 'final-diff', async () => {
        const finalTrades = await fetchTrades(roomId);
        const finalPlayers = await fetchPlayers(roomId);
        return diffTrades(p1Page, finalTrades, finalPlayers, uidP1);
      });
      expect(tradeDiffs, 'final trade state vs server').toEqual([]);
    } finally {
      await p1Latency.stop();
      await p1Context.close();
    }

    async function expectSingleTrade(rid: string) {
      // Offer Trade's click() resolving only means the DOM click event fired, not that the
      // proposeTrade round trip (subject to the very latency this suite injects) has landed
      // server-side yet — poll instead of checking once immediately after the click.
      const deadline = Date.now() + 10000;
      let trades = await fetchTrades(rid);
      while (trades.length === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 200));
        trades = await fetchTrades(rid);
      }
      expect(trades.length, 'expected exactly one trade to have been proposed').toBe(1);
      return trades[0];
    }
  });
});
