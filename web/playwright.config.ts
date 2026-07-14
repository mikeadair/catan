import { defineConfig, devices } from '@playwright/test';

const PORT = 5183;
const baseURL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: './e2e',
  // The latency-fuzz suite (web/e2e/latency-fuzz.spec.ts) has its own dedicated config
  // (playwright.latency.config.ts, run via the test:e2e:latency npm script) and must stay out
  // of this one: it's deliberately slower and more resource-hungry (real injected network
  // latency, multiple browser contexts, generous settle windows) and this config's
  // test:e2e:screenshots script already runs on every push to main in
  // .github/workflows/deploy.yml — we don't want that picking it up by accident.
  testIgnore: '**/latency-fuzz.spec.ts',
  fullyParallel: false, // each test creates Firestore rooms (against the emulator); keep runs simple and sequential
  // Cross-project parallelism (the 3 viewport projects below) would otherwise still run
  // concurrently against the single local Functions/Firestore emulator processes, causing
  // real deadline-exceeded errors under contention (cold starts + concurrent submitAction
  // calls from bots). Force everything onto one worker so the whole suite is sequential.
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  timeout: 60_000,
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
    {
      name: 'desktop-ultrawide',
      use: { ...devices['Desktop Chrome'], viewport: { width: 3440, height: 1440 } },
    },
    {
      name: 'desktop-1366',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1366, height: 768 } },
    },
  ],
  webServer: {
    command: `npm run dev -- --port ${PORT} --strictPort`,
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
    // Point the dev server Playwright spawns at the Firebase Local Emulator Suite (see
    // web/src/firebase/config.ts) instead of the real `mikeadair-catan` project. `test:e2e`
    // wraps this whole run in `firebase emulators:exec`, which must already be up by the
    // time this env var takes effect.
    env: {
      VITE_USE_FIREBASE_EMULATOR: 'true',
    },
  },
});
