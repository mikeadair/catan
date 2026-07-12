import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  test: {
    // Playwright owns everything under e2e/ (its own `test`/`expect`, run via `npm run test:e2e`).
    exclude: ['e2e/**', 'node_modules/**'],
  },
})
