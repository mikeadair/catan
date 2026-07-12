import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: ['./vitest.setup.ts'],
    testTimeout: 15000,
    hookTimeout: 15000,
    // These tests need a running Firestore emulator (FIRESTORE_EMULATOR_HOST) — run via
    // `firebase emulators:exec --only firestore "npm run test -w functions"`, not bare vitest.
    fileParallelism: false,
  },
});
