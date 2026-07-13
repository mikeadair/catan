import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  optimizeDeps: {
    // @catan/engine is an npm-workspace symlink, not a real node_modules install — Vite's
    // dev server excludes linked packages from dependency pre-bundling by default (it
    // assumes linked packages are your own ESM source to watch/HMR directly). But
    // packages/engine builds to CommonJS (needed for functions/'s Node/esbuild bundling),
    // so without forcing it through the same esbuild CJS->ESM interop pre-bundling gets,
    // the dev server serves the raw `exports.foo = ...` file straight to the browser,
    // which can't parse it as ESM at all — every named import fails with "does not provide
    // an export named 'X'" and the whole app fails to render (blank page, no console error
    // beyond that one import). `vite build`/`vite preview` were never affected — Rollup's
    // production bundler handles this interop unconditionally, which is why this went
    // unnoticed until someone tried plain `npm run dev`.
    include: ['@catan/engine'],
  },
  test: {
    // Playwright owns everything under e2e/ (its own `test`/`expect`, run via `npm run test:e2e`).
    exclude: ['e2e/**', 'node_modules/**'],
    // Unit-testable logic now lives in packages/engine; web has no unit tests of its
    // own today but may gain some again (e.g. client-only UI logic).
    passWithNoTests: true,
  },
})
