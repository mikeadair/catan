# Catan

A web implementation of Settlers of Catan (React 19 + TypeScript + Vite, Firebase Firestore + Cloud Functions), deployed at https://mikeadair-catan.web.app.

## Repo layout (npm workspaces)

- `packages/engine` — the pure game rules engine (`applyAction`, `createGame`, board generation, bot AI). Zero Firebase/React imports, deterministic given a seed. Shared by both `web/` and `functions/`.
- `web/` — the React client.
- `functions/` — Cloud Functions (`submitAction`, `startGame`). These are the sole authority over game state: clients never write game-state documents directly. `submitAction` derives the acting player from the verified auth token and re-runs `packages/engine`'s reducer server-side; `firestore.rules` denies direct client writes to game-state docs once a room is `'playing'`.
- `firestore-tests/` — `@firebase/rules-unit-testing` tests for `firestore.rules`, run against the Firestore emulator.

## Seeing the current UI without driving a browser

`web/e2e/layout.spec.ts` (Playwright) drives through home → lobby → game setup → mid-game and screenshots each stage into `web/e2e/screenshots/*.png`. These are committed to the repo and regenerated automatically by the `capture-screenshots` job in `.github/workflows/deploy.yml` on every push to `main` — so `web/e2e/screenshots/home.png`, `lobby-full.png`, `game-setup.png`, and `game-mid.png` always reflect what's actually live. Read them directly instead of spinning up a browser to check what the UI currently looks like.

(That job is deliberately not a dependency of `deploy` and doesn't gate it — e2e/Firestore timing can be flaky, and a flaky screenshot regen should never block a real deploy.)

## Testing

- `npm run test -w packages/engine` — pure unit tests, no emulator needed.
- `npm run test -w functions` / `npm run test -w firestore-tests` — need a live Firestore emulator: `firebase emulators:exec --project mikeadair-catan --only firestore "npm run test -w functions && npm run test -w firestore-tests"`. These call `submitActionHandler`/`startGameHandler` directly against the Firestore emulator (no Functions Framework HTTP layer involved), so they're the fastest way to verify server-side game logic.
- `npm run test:e2e` (from `web/`) — Playwright, against the Firebase Local Emulator Suite for auth/firestore (see `web/src/firebase/config.ts` and `web/playwright.config.ts`) plus `functions/src/e2eBridge.ts` standing in for the Functions emulator, not the live project. `workers: 1` is intentional: the bridge is a single process and gets overwhelmed by concurrent invocations across viewport projects.
  - Why a bridge instead of the real Functions emulator: in at least one sandboxed dev environment (WSL2, and eventually GitHub Actions' runners too), the Functions emulator's worker process would crash with "Your function was killed because it raised an unhandled error" on invocation and fail to reload, hanging callables until `deadline-exceeded` — reproduced even fully isolated (single test, single worker, fresh emulator boot), with no stack trace forwarded through firebase-tools' own logging even in `--debug` mode. This was **not** a bug in application code — `npm run test -w functions` (which exercises the exact same handlers against the same Firestore emulator, just without the Functions Framework HTTP layer) always passed reliably. `functions/src/e2eBridge.ts` is a minimal HTTP server implementing just enough of the callable-functions wire protocol to serve `startGameHandler`/`submitActionHandler` directly, sidestepping the Functions Framework/emulator worker process entirely — see that file's header comment for the full rationale. It is never bundled into the deployed function (only `src/index.ts`'s exports are).
