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

export async function addBots(page: Page, count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    await page.click('button:has-text("Add bot")');
    await page.waitForTimeout(200);
  }
}

/** Starts the game from the Lobby and waits for the board to render. */
export async function startGame(page: Page): Promise<void> {
  await page.click('button:has-text("Start game")');
  await page.waitForSelector('.catan-board', { timeout: 20000 });
  await page.waitForTimeout(500); // let the first layout/paint settle
}

/**
 * Drives the local human player's own setup-phase placements (nothing auto-plays for a
 * human, unlike bots). Polls the phase banner and clicks the first available hotspot
 * whenever it's this player's turn, until the game reaches a normal turn (banner clears
 * and the bottom build toolbar appears) or `maxRounds` polls are exhausted.
 */
export async function playThroughSetupForSelf(page: Page, maxRounds = 60): Promise<void> {
  for (let i = 0; i < maxRounds; i++) {
    const toolbarVisible = await page.locator('.game__toolbar').count();
    if (toolbarVisible > 0) return; // past setup, into a normal turn

    const banner = await page.locator('.game__phase-banner').textContent().catch(() => null);
    if (banner?.includes('Place your first settlement') || banner?.includes('Place a road')) {
      const vertexHotspot = page.locator('.catan-board__hotspot--vertex').first();
      const edgeHotspot = page.locator('.catan-board__hotspot--edge').first();
      // force: true — these are SVG hit-targets inside a <g onClick>, and a sibling
      // near-transparent circle (opacity 0.001, used to widen the edge hit-area) sits
      // exactly at the point Playwright's actionability check probes, which it reports
      // as "intercepting" even though both elements share the same click handler.
      if (banner.includes('settlement') && (await vertexHotspot.count()) > 0) {
        await vertexHotspot.click({ force: true });
      } else if ((await edgeHotspot.count()) > 0) {
        await edgeHotspot.click({ force: true });
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
