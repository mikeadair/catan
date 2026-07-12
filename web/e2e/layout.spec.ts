import { test } from '@playwright/test';
import {
  setDisplayName,
  createRoom,
  addBots,
  startGame,
  assertNoPageOverflow,
  playThroughSetupForSelf,
} from './helpers';

// These run against every project in playwright.config.ts (1080p, ultrawide, 1366x768) —
// the app targets desktop/ultrawide only (no mobile support), so the hard requirement is
// simply: never a page-level scrollbar, at any of those sizes.

test('home screen has no page overflow', async ({ page }) => {
  await setDisplayName(page, 'LayoutBot');
  await assertNoPageOverflow(page);
  await page.screenshot({ path: 'e2e/screenshots/home.png' });
});

test('lobby has no page overflow, even fully seated', async ({ page }) => {
  await setDisplayName(page, 'LayoutBot');
  await createRoom(page);
  await assertNoPageOverflow(page);

  await addBots(page, 5); // fill every remaining seat
  await assertNoPageOverflow(page);
  await page.screenshot({ path: 'e2e/screenshots/lobby-full.png' });
});

test('game board has no page overflow during setup', async ({ page }) => {
  await setDisplayName(page, 'LayoutBot');
  await createRoom(page);
  await addBots(page, 2);
  await startGame(page);
  await assertNoPageOverflow(page);
  await page.screenshot({ path: 'e2e/screenshots/game-setup.png' });
});

test('game board has no page overflow mid-game (post-setup)', async ({ page }) => {
  test.setTimeout(120_000);
  await setDisplayName(page, 'LayoutBot');
  await createRoom(page);
  await addBots(page, 2);
  await startGame(page);

  // The bot-turn poller drives the two bots' setup placements automatically; the local
  // human player's own placements need to be clicked through explicitly.
  await playThroughSetupForSelf(page);

  await assertNoPageOverflow(page);
  await page.screenshot({ path: 'e2e/screenshots/game-mid.png' });
});
