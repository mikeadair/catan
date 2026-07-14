// Ad hoc screenshot tool for iterating on UI visuals — see CLAUDE.md's "Focused screenshots for
// a single component" section for the full writeup on when to reach for this instead of
// state-gallery.spec.ts (many states, whole-page, Firebase-backed) or a full manual browser
// session. This suite has exactly one test, parameterized entirely by env vars, so there's
// nothing to edit here for a normal invocation.
//
// Fast on purpose: no Firebase emulator, no bot AI, no `submitAction` round trips. It only makes
// sense against the two dev-only fake-state harnesses (main.tsx's `?preview=trade` / `?preview=
// board`, see TradePreview.tsx/DevPreview.tsx), which seed the zustand store directly and mount
// the real components — so what you screenshot is pixel-identical to production, just reached
// without playing an actual game. If you need a state those harnesses don't already cover (a
// specific hand, a specific selection, a specific resource distribution), edit the relevant
// harness file's fake state inline — that's the intended workflow, not a limitation to work
// around here.
//
// Usage (from web/, dev server auto-started/reused by playwright.snap.config.ts):
//
//   npm run snap                                          # every SNAP_COMPONENTS + SNAP_SCENARIOS entry, one file each
//   SNAP_COMPONENT=all npm run snap                        # just components, skip scenarios (faster, no interaction states)
//   SNAP_COMPONENT=hand npm run snap                       # one named component (registry: snap-components.ts)
//   SNAP_SCENARIO=hand-card-selected npm run snap          # one named component + interaction sequence
//   SNAP_LIST=1 npm run snap                                # print the registry, capture nothing
//   SNAP_URL='http://localhost:5183/?preview=trade' SNAP_SELECTOR='.trade-bar' npm run snap   # ad hoc, not in the registry
//
// Env vars:
//   SNAP_COMPONENT  name from SNAP_COMPONENTS (snap-components.ts), or 'all' for every component
//                   but no scenarios. Omit + no other mode selected defaults to *every* component
//                   and every scenario. Saved as <name>.png.
//   SNAP_SCENARIO   name from SNAP_SCENARIOS (snap-components.ts) — a component plus a click
//                   sequence that reaches a specific, worth-repeating interaction state (e.g. a
//                   card selected for trade). Takes precedence over SNAP_COMPONENT. Saved as <name>.png.
//   SNAP_URL        ad hoc escape hatch for anything not in the registry — full URL to load.
//                   Takes precedence over SNAP_COMPONENT/SNAP_SCENARIO.
//   SNAP_SELECTOR   with SNAP_URL: CSS selector to crop to (first match) — omit for full-page.
//   SNAP_CLICK      with SNAP_URL, or appended after SNAP_COMPONENT's own clicks: comma-separated
//                   CSS selectors to click in order (first match each) before capturing.
//   SNAP_PAD        pixels of extra surrounding context beyond the tight element crop, on all
//                   sides (clamped to the viewport) — applies to any selector-based capture
//                   (SNAP_COMPONENT, SNAP_SCENARIO, or SNAP_URL+SNAP_SELECTOR). Default 0.
//   SNAP_OUT        with SNAP_URL: filename, saved under e2e/snap-screenshots/ (gitignored).
//                   Ignored for SNAP_COMPONENT/SNAP_SCENARIO/'all' modes, which name files after
//                   the component/scenario name so a batch run doesn't overwrite itself.
import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { SNAP_COMPONENTS, SNAP_SCENARIOS, type SnapComponent } from './snap-components';

const SCREENSHOT_DIR = 'e2e/snap-screenshots'; // relative to web/ (the suite's cwd) — gitignored

function printRegistry(): void {
  // eslint-disable-next-line no-console
  console.log('\n[snap] SNAP_COMPONENTS:');
  for (const [name, c] of Object.entries(SNAP_COMPONENTS)) {
    // eslint-disable-next-line no-console
    console.log(`  ${name.padEnd(16)} (${c.preview}) ${c.description}`);
  }
  // eslint-disable-next-line no-console
  console.log('\n[snap] SNAP_SCENARIOS:');
  for (const [name, s] of Object.entries(SNAP_SCENARIOS)) {
    // eslint-disable-next-line no-console
    console.log(`  ${name.padEnd(24)} (component: ${s.component}) ${s.description}`);
  }
}

async function clickAll(page: Page, selectors: string[]): Promise<void> {
  for (const sel of selectors) {
    await page.locator(sel).first().click();
  }
}

/** Crops to `selector`'s bounding box, expanded by `pad` px on every side and clamped to the
 * viewport — plain `locator.screenshot()` has no padding option, so this computes an explicit
 * `clip` region instead. */
async function captureElement(page: Page, selector: string, pad: number, file: string): Promise<void> {
  const box = await page.locator(selector).first().boundingBox();
  if (!box) throw new Error(`[snap] selector matched nothing (or is hidden): ${selector}`);
  if (pad <= 0) {
    await page.screenshot({ path: file, clip: box });
    return;
  }
  const viewport = page.viewportSize();
  const maxX = viewport?.width ?? box.x + box.width + pad;
  const maxY = viewport?.height ?? box.y + box.height + pad;
  const x = Math.max(0, box.x - pad);
  const y = Math.max(0, box.y - pad);
  const clip = {
    x,
    y,
    width: Math.min(box.width + pad * 2, maxX - x),
    height: Math.min(box.height + pad * 2, maxY - y),
  };
  await page.screenshot({ path: file, clip });
}

async function captureComponent(page: Page, name: string, comp: SnapComponent, extraClicks: string[], pad: number, out?: string): Promise<void> {
  await page.goto(`/?preview=${comp.preview}`);
  await page.waitForLoadState('networkidle');
  await clickAll(page, [...(comp.clicks ?? []), ...extraClicks]);
  const file = `${SCREENSHOT_DIR}/${out ?? name}.png`;
  await captureElement(page, comp.selector, pad, file);
  // eslint-disable-next-line no-console
  console.log(`[snap] saved: ${file}`);
}

test('snap', async ({ page }) => {
  mkdirSync(SCREENSHOT_DIR, { recursive: true });

  if (process.env.SNAP_LIST) {
    printRegistry();
    return;
  }

  const pad = Number(process.env.SNAP_PAD ?? 0);
  const url = process.env.SNAP_URL;
  const scenarioName = process.env.SNAP_SCENARIO;
  const componentName = process.env.SNAP_COMPONENT;

  if (url) {
    // Ad hoc escape hatch — not in the registry.
    const selector = process.env.SNAP_SELECTOR;
    const out = process.env.SNAP_OUT ?? 'snap.png';
    const clicks = (process.env.SNAP_CLICK ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    await page.goto(url);
    await page.waitForLoadState('networkidle');
    await clickAll(page, clicks);
    const file = `${SCREENSHOT_DIR}/${out}`;
    if (selector) {
      await captureElement(page, selector, pad, file);
    } else {
      await page.screenshot({ path: file, fullPage: true });
    }
    // eslint-disable-next-line no-console
    console.log(`[snap] saved: ${file}`);
    return;
  }

  if (scenarioName) {
    const scenario = SNAP_SCENARIOS[scenarioName];
    if (!scenario) {
      printRegistry();
      throw new Error(`[snap] unknown SNAP_SCENARIO "${scenarioName}" — see registry above (or snap-components.ts)`);
    }
    const comp = SNAP_COMPONENTS[scenario.component];
    await captureComponent(page, scenarioName, comp, scenario.clicks, pad);
    return;
  }

  if (componentName && componentName !== 'all') {
    const comp = SNAP_COMPONENTS[componentName];
    if (!comp) {
      printRegistry();
      throw new Error(`[snap] unknown SNAP_COMPONENT "${componentName}" — see registry above (or snap-components.ts)`);
    }
    const extraClicks = (process.env.SNAP_CLICK ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    await captureComponent(page, componentName, comp, extraClicks, pad);
    return;
  }

  // SNAP_COMPONENT=all explicitly: every component, but skip scenarios — a faster sweep of
  // plain/default states only, for when you don't need the interaction states too.
  for (const [name, comp] of Object.entries(SNAP_COMPONENTS)) {
    await captureComponent(page, name, comp, [], pad);
  }
  if (componentName === 'all') {
    expect(Object.keys(SNAP_COMPONENTS).length).toBeGreaterThan(0);
    return;
  }

  // True default (nothing set at all): every component *and* every scenario, since a scenario
  // is just as reviewable as a component's plain state and there's no good reason to make
  // someone already know its name to ever see it. Components and scenarios share one flat
  // output directory keyed by name, so a name collision between the two registries would
  // silently overwrite one file with the other — fail loudly instead.
  for (const [name, scenario] of Object.entries(SNAP_SCENARIOS)) {
    if (SNAP_COMPONENTS[name]) {
      throw new Error(`[snap] SNAP_SCENARIOS["${name}"] collides with a SNAP_COMPONENTS entry of the same name — rename one (they share e2e/snap-screenshots/<name>.png)`);
    }
    const comp = SNAP_COMPONENTS[scenario.component];
    await captureComponent(page, name, comp, scenario.clicks, pad);
  }
  expect(Object.keys(SNAP_COMPONENTS).length + Object.keys(SNAP_SCENARIOS).length).toBeGreaterThan(0);
});
