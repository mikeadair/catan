import { expect, type Page } from '@playwright/test';

/** Fills the display name on Home and returns once the field is ready. */
export async function setDisplayName(page: Page, name: string): Promise<void> {
  await page.goto('/');
  await page.waitForSelector('#display-name', { timeout: 15000 });
  await page.fill('#display-name', name);
}

/** Creates a room from Home and waits for the Lobby to load. Returns the room code. */
export async function createRoom(page: Page): Promise<string> {
  await page.click('button:has-text("Create room")');
  await page.waitForSelector('.lobby__code', { timeout: 20000 });
  return (await page.textContent('.lobby__code'))?.trim() ?? '';
}

/** Joins an existing room by its lobby code from Home (the `displayName` field must already
 * be reachable — this navigates to '/' itself, same as createRoom's callers do via
 * setDisplayName). Used by multi-human-context suites (e.g. e2e/latency-fuzz.spec.ts) where a
 * second simulated player needs to join a room a different page already created. */
export async function joinRoomByCode(page: Page, displayName: string, code: string): Promise<void> {
  await setDisplayName(page, displayName);
  await page.fill('.home__input--code', code);
  await page.click('button:has-text("Join room")');
  await page.waitForSelector('.lobby__code', { timeout: 20000 });
}

export async function addBots(page: Page, count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    await page.click('button:has-text("Add bot")');
    await page.waitForTimeout(200);
  }
}

/**
 * Starts the game from the Lobby and waits for the board to render.
 *
 * Waits on `.game__board-area` rather than `.catan-board` — the Lobby's "Game settings"
 * section embeds a live, read-only board preview (MapPreview) that also carries the
 * `catan-board` class, so `.catan-board` alone can resolve before the game has actually
 * started, leaving the test to proceed as if setup began when it's really still stuck
 * showing the lobby (e.g. behind a slow/failed `startGame` call).
 */
export async function startGame(page: Page): Promise<void> {
  await page.click('button:has-text("Start game")');
  await page.waitForSelector('.game__board-area', { timeout: 20000 });
  await page.waitForTimeout(500); // let the first layout/paint settle
}

/**
 * Drives the local human player's own setup-phase placements (nothing auto-plays for a
 * human, unlike bots). Polls the phase banner and clicks the first available hotspot
 * whenever it's this player's turn, until the game reaches a normal turn (the dice roller
 * mounts) or `maxRounds` polls are exhausted.
 *
 * Deliberately does NOT key off `.game__toolbar`'s presence — since the "always-on toolbar"
 * UI overhaul (see Game.tsx's footer, and its own comment on `showDiceRoller`), that element
 * is unconditionally mounted for the *entire* live game, setup included, so checking for it
 * here would return on the very first poll without ever placing anything. `.dice-roller`
 * only mounts once `room.phase` is 'roll'/'main' (past setup for every seat, not just this
 * one — setup is snake-ordered), which is the real signal this helper is after.
 */
export async function playThroughSetupForSelf(page: Page, maxRounds = 60): Promise<void> {
  for (let i = 0; i < maxRounds; i++) {
    const diceRollerVisible = await page.locator('.dice-roller').count();
    if (diceRollerVisible > 0) return; // past setup, into a normal turn

    const banner = await page.locator('.game__phase-banner').textContent().catch(() => null);
    // Matches both setup rounds' banner text ("Place your first settlement." / "Place your
    // second settlement." — see Game.tsx's phaseBanner) rather than hardcoding "first", which
    // used to silently skip every round-2 settlement placement.
    const needsSettlement = !!banner?.includes('Place your') && banner.includes('settlement');
    if (needsSettlement || banner?.includes('Place a road')) {
      const vertexHotspot = page.locator('.catan-board__hotspot--vertex').first();
      const edgeHotspot = page.locator('.catan-board__hotspot--edge').first();
      // force: true — these are SVG hit-targets inside a <g onClick>, and a sibling
      // near-transparent circle (opacity 0.001, used to widen the edge hit-area) sits
      // exactly at the point Playwright's actionability check probes, which it reports
      // as "intercepting" even though both elements share the same click handler.
      //
      // Wrapped in try/catch with a short per-click timeout: with bots polling and
      // applying their own moves concurrently, the board can re-render (detaching the
      // located SVG element) between locate and click. Playwright's built-in retry can
      // spin on that for the test's full timeout; on failure here we just loop and
      // re-locate against the fresh DOM instead.
      try {
        if (needsSettlement && (await vertexHotspot.count()) > 0) {
          await vertexHotspot.click({ force: true, timeout: 5000 });
        } else if ((await edgeHotspot.count()) > 0) {
          await edgeHotspot.click({ force: true, timeout: 5000 });
        }
      } catch {
        // transient detach/re-render race — retry on the next loop iteration
      }
      await page.waitForTimeout(300);
    } else {
      await page.waitForTimeout(1000); // waiting on a bot's turn
    }
  }
}

export interface PageOverflow {
  scrollWidth: number;
  scrollHeight: number;
  innerWidth: number;
  innerHeight: number;
}

export async function getPageOverflow(page: Page): Promise<PageOverflow> {
  return page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    scrollHeight: document.documentElement.scrollHeight,
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
  }));
}

/** Fails the test if the page is scrollable beyond the viewport in either axis. */
export async function assertNoPageOverflow(page: Page): Promise<void> {
  const o = await getPageOverflow(page);
  expect(o.scrollHeight, `page scrollHeight (${o.scrollHeight}) should not exceed viewport height (${o.innerHeight})`).toBeLessThanOrEqual(o.innerHeight);
  expect(o.scrollWidth, `page scrollWidth (${o.scrollWidth}) should not exceed viewport width (${o.innerWidth})`).toBeLessThanOrEqual(o.innerWidth);
}
