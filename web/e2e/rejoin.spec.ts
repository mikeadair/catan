import { expect, test } from '@playwright/test';
import { setDisplayName, createRoom, addBots, startGame } from './helpers';

// Regression coverage for the "guest booted on refresh" bug: a guest who joined through a
// ?join=CODE invite link kept that param in the address bar, and on a mid-game refresh
// App.tsx's auto-rejoin deferred to the invite link — dumping them on Home, where re-joining
// by code fails once the room is 'playing' (joinRoom only matches status=='lobby'). Fixed
// two ways (either alone suffices, both are exercised here): Home strips the consumed param
// on successful join, and App recognizes an invite code that matches the last room this
// browser was seated in and rejoins anyway. See App.tsx / Home.tsx.
test('guest who joined via invite link stays in the game across a refresh', async ({ page, browser }) => {
  test.setTimeout(120_000);

  await setDisplayName(page, 'HostBot');
  const code = await createRoom(page);
  await addBots(page, 1);

  const guestContext = await browser.newContext();
  const guest = await guestContext.newPage();
  try {
    // Join through the invite link, the same entry path a real invitee uses.
    await guest.goto(`/?join=${code}`);
    await guest.waitForSelector('#display-name', { timeout: 15000 });
    await guest.fill('#display-name', 'GuestBot');
    await expect(guest.locator('.home__input--code')).toHaveValue(code); // prefilled from the URL
    await guest.click('button:has-text("Join room")');
    await guest.waitForSelector('.lobby__code', { timeout: 20000 });

    await startGame(page);
    await guest.waitForSelector('.game__board-area', { timeout: 20000 });

    // The regression: refresh mid-game. Must land back in the game, not on Home.
    await guest.reload();
    await guest.waitForSelector('.game__board-area', { timeout: 20000 });

    // And again with the invite link restored in the URL — covers a guest re-opening a
    // bookmarked invite link (or one whose join predates the param-stripping fix), which
    // exercises App.tsx's code-matches-last-room rejoin path specifically.
    await guest.goto(`/?join=${code}`);
    await guest.waitForSelector('.game__board-area', { timeout: 20000 });
  } finally {
    await guestContext.close();
  }
});
