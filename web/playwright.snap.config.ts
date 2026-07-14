import { defineConfig, devices } from '@playwright/test';

// Dedicated config for the on-demand single-screenshot tool (web/e2e/snap.spec.ts), invoked via
// the `npm run snap` script — same "own config + own testMatch" pattern as
// playwright.gallery.config.ts/playwright.latency.config.ts, and for the same reason: keeps this
// out of every default `npx playwright test` invocation (see those configs' own header comments
// for the full rationale). No Firebase emulator wiring here at all (unlike every other config) —
// snap.spec.ts only ever targets the `?preview=` dev harnesses, which need none.
const PORT = 5183;
const baseURL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/snap.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  timeout: 30_000,
  use: {
    baseURL,
    trace: 'off',
    screenshot: 'off', // snap.spec.ts takes its own explicit screenshot; the auto on-failure one adds nothing here
    video: 'off',
  },
  projects: [{ name: 'snap', use: { ...devices['Desktop Chrome'], viewport: { width: 1920, height: 1080 } } }],
  webServer: {
    command: `npm run dev -- --port ${PORT} --strictPort`,
    url: baseURL,
    reuseExistingServer: true, // always reuse, even in CI — this is called repeatedly in quick succession during iteration
    timeout: 30_000,
  },
});
