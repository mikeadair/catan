import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  test: {
    // Playwright owns everything under e2e/ (its own `test`/`expect`, run via `npm run test:e2e`).
    exclude: ['e2e/**', 'node_modules/**'],
    // Unit-testable logic now lives in packages/engine; web has no unit tests of its
    // own today but may gain some again (e.g. client-only UI logic).
    passWithNoTests: true,
  },
})
