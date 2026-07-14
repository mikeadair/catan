import { defineConfig, devices } from '@playwright/test';

// Dedicated config for the state-gallery suite (web/e2e/state-gallery.spec.ts), invoked via
// the `test:e2e:gallery` npm script — deliberately NOT just `playwright.config.ts` + a CLI
// file argument, mirroring playwright.latency.config.ts's own rationale exactly:
// playwright.config.ts's `testIgnore` excludes state-gallery.spec.ts from that config's own
// file discovery (testMatch/testIgnore), and a CLI file-path argument only narrows an
// *already-discovered* file set — it can't add an ignored file back in. So the only way to
// keep this suite out of every default `npx playwright test` invocation (including the
// existing `test:e2e`/`test:e2e:screenshots`/`test:e2e:ui`/`test:e2e:latency` scripts, one of
// which — screenshots — already runs on every push to main in .github/workflows/deploy.yml)
// while still being able to run it deliberately is to give it its own config entirely.
const PORT = 5183;
const baseURL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/state-gallery.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report-gallery' }]],
  timeout: 90_000, // per-test test.setTimeout(...) calls in the spec itself override this as needed
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'on',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'desktop-1080p',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1920, height: 1080 } },
    },
  ],
  webServer: {
    command: `npm run dev -- --port ${PORT} --strictPort`,
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
    env: {
      VITE_USE_FIREBASE_EMULATOR: 'true',
    },
  },
});
