# Catan

A web implementation of Settlers of Catan (React 19 + TypeScript + Vite, Firebase Firestore + Cloud Functions), deployed at https://mikeadair-catan.web.app.

## Repo layout (npm workspaces)

- `packages/engine` — the pure game rules engine (`applyAction`, `createGame`, board generation, bot AI). Zero Firebase/React imports, deterministic given a seed. Shared by both `web/` and `functions/`.
- `web/` — the React client.
- `functions/` — Cloud Functions (`submitAction`, `startGame`). These are the sole authority over game state: clients never write game-state documents directly. `submitAction` derives the acting player from the verified auth token and re-runs `packages/engine`'s reducer server-side; `firestore.rules` denies direct client writes to game-state docs once a room is `'playing'`.
- `firestore-tests/` — `@firebase/rules-unit-testing` tests for `firestore.rules`, run against the Firestore emulator.

## Seeing the current UI without driving a browser

Four different mechanisms exist for this, at different cost/coverage tradeoffs — pick the cheapest one that answers your question. All of them are Playwright under the hood; none of them require you to drive `mcp__*` browser tools or open a real tab yourself.

**Committed baselines — `web/e2e/screenshots/*.png`.** `web/e2e/layout.spec.ts` drives through home → lobby → game setup → mid-game and screenshots each stage. Committed to the repo and regenerated automatically by the `capture-screenshots` job in `.github/workflows/deploy.yml` on every push to `main`, so `home.png`/`lobby-full.png`/`game-setup.png`/`game-mid.png` always reflect what's actually live. Just `Read` them directly — no Playwright invocation needed at all. Good for "what does the app currently look like," bad for anything more specific than that (only 4 fixed states, full-page). (That job is deliberately not a dependency of `deploy` and doesn't gate it — e2e/Firestore timing can be flaky, and a flaky screenshot regen should never block a real deploy.)

**A focused screenshot of one component — `npm run snap` (from `web/`).** By far the cheapest option for "does this one component look right," both in wall-clock time (no Firebase emulator, no bot AI, no game setup — each capture is ~1-2s) and in your own context (an element-cropped PNG is typically 10-50KB vs. several hundred KB for a full 1080p page). Run with no arguments and it screenshots *every* registered component *and* every named scenario in one pass (~15-20s total); pass `SNAP_COMPONENT`/`SNAP_SCENARIO` to narrow to one, or `SNAP_COMPONENT=all` for just the plain components without the interaction states:

```
npm run snap                              # every SNAP_COMPONENTS + SNAP_SCENARIOS entry, one file each
SNAP_COMPONENT=all npm run snap           # just components, skip scenarios (faster)
SNAP_COMPONENT=hand npm run snap          # just the hand, saved as hand.png
SNAP_SCENARIO=hand-card-selected npm run snap   # the hand with a card already tapped/selected
SNAP_LIST=1 npm run snap                  # print the registry (names + descriptions), capture nothing
```

The component/scenario names, their selectors, and (where relevant) the click sequence needed to reach them are a registry in `web/e2e/snap-components.ts` — check there (or `SNAP_LIST=1 npm run snap`) before grepping component files for a selector yourself. `SNAP_SCENARIOS` in that same file is specifically for states worth reaching more than once (a card selected for trade, a panel opened) — add to it whenever you work out a click sequence like that, so the next agent gets it for free instead of re-deriving it. `SNAP_PAD=<px>` adds that much surrounding context around the tight element crop (clamped to the viewport) if you need to see a component in relation to its neighbors rather than in isolation. For anything not worth adding to the registry, `SNAP_URL`/`SNAP_SELECTOR`/`SNAP_CLICK`/`SNAP_OUT` remain as an ad hoc escape hatch — see `web/e2e/snap.spec.ts`'s header comment for the full env var list either way.

Everything above targets one of two dev-only fake-state harnesses, which is what makes this fast — no live Firebase room, deterministic, real components:

- `?preview=trade` (`web/src/TradePreview.tsx`) — mounts the real `<Game/>` with a fake room/players/hand/trades already in `'main'` phase, dispatch stubbed to a no-op logger. Everything in `SNAP_COMPONENTS` except `board` targets this.
- `?preview=board&map=<preset>` (`web/src/DevPreview.tsx`) — mounts just `<Board/>` with a fake room, defaulting to `official-beginner`; pass `map=fog-of-war` etc. for other presets (via `SNAP_URL` directly — the `board` registry entry always uses the default map). Use for board/hex/piece rendering only (no toolbar/sidebar chrome — those render as inert placeholders).

If the fake state either harness seeds by default doesn't cover the scenario you need (a specific hand, a specific selection, a specific resource count), edit that harness file's inline fake state directly — that's the intended workflow, not a limitation to work around. Both harnesses are wired in from `main.tsx` behind those query params and require `npm run dev` running (`playwright.snap.config.ts` will auto-start/reuse it on port 5183 if it isn't).

**Many states at once, for a broad visual review — `npm run test:e2e:gallery` (from `web/`).** `web/e2e/state-gallery.spec.ts` drives the real app against the Firebase emulator through ~35 distinct states (lobby variants, mid-game board, trade composer, discard modal, robber phase, game log sizes, etc.) and full-page-screenshots each one into the gitignored `web/e2e/state-gallery-screenshots/`. Slower than `snap` (real emulator, real game flow — several minutes) and every screenshot is full-page, but it's the right tool when you need to survey a lot of ground at once (e.g. a design-review pass) rather than check one specific component. Reuses `forceRoomFields`/`forceHand` (from `web/e2e/latency-helpers.ts`) to jump straight to awkward-to-reach states instead of always playing through naturally.

**Screenshots incidental to a correctness run — `npm run test:e2e:latency` (from `web/`).** `web/e2e/latency-fuzz.spec.ts`'s screenshots (into the gitignored `web/e2e/latency-fuzz-screenshots/`) are a side effect of its actual job (asserting the UI stays correct under randomized injected network latency), seeded and chance-gated rather than deterministic. Don't reach for this one for visual review — use it only if you're already running it for its real purpose and want to glance at what it saw.

## Testing

- `npm run test -w packages/engine` — pure unit tests, no emulator needed.
- `npm run test -w functions` / `npm run test -w firestore-tests` — need a live Firestore emulator: `firebase emulators:exec --project mikeadair-catan --only firestore "npm run test -w functions && npm run test -w firestore-tests"`. These call `submitActionHandler`/`startGameHandler` directly against the Firestore emulator (no Functions Framework HTTP layer involved), so they're the fastest way to verify server-side game logic.
- `npm run test:e2e` (from `web/`) — Playwright, against the Firebase Local Emulator Suite for auth/firestore (see `web/src/firebase/config.ts` and `web/playwright.config.ts`) plus `functions/src/e2eBridge.ts` standing in for the Functions emulator, not the live project. `workers: 1` is intentional: the bridge is a single process and gets overwhelmed by concurrent invocations across viewport projects.
  - Why a bridge instead of the real Functions emulator: in at least one sandboxed dev environment (WSL2, and eventually GitHub Actions' runners too), the Functions emulator's worker process would crash with "Your function was killed because it raised an unhandled error" on invocation and fail to reload, hanging callables until `deadline-exceeded` — reproduced even fully isolated (single test, single worker, fresh emulator boot), with no stack trace forwarded through firebase-tools' own logging even in `--debug` mode. This was **not** a bug in application code — `npm run test -w functions` (which exercises the exact same handlers against the same Firestore emulator, just without the Functions Framework HTTP layer) always passed reliably. `functions/src/e2eBridge.ts` is a minimal HTTP server implementing just enough of the callable-functions wire protocol to serve `startGameHandler`/`submitActionHandler` directly, sidestepping the Functions Framework/emulator worker process entirely — see that file's header comment for the full rationale. It is never bundled into the deployed function (only `src/index.ts`'s exports are).
