import { defineConfig, devices } from '@playwright/test';

const PORT = 5183;
const baseURL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: './e2e',
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
