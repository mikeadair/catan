# catan

A browser-based Settlers of Catan clone with real-time multiplayer, built on Firebase (Firestore + Anonymous Auth + Hosting).

## Features

- Real-time multiplayer rooms with a shareable join code
- Anonymous auth — no sign-up required
- Bank, port (2:1/3:1), and player-to-player trading (propose/accept/reject/counter)
- Bots fill empty seats and play full turns (setup, building, trading, robber, dev cards)
- Multiple preset boards: Official Beginner layout, Balanced Random, and full Chaos random
- Host-configurable house rules (victory points to win, discard hand-size limit)
- Full core ruleset: setup snake draft, dice/resource distribution, robber, longest road, largest army, development cards

## Stack

- React + TypeScript + Vite, Zustand for local state
- Firebase: Firestore (game state), Anonymous Auth, Hosting, Cloud Functions
- Server-authoritative: clients call the `submitAction`/`startGame` Cloud Functions, which re-run the shared engine reducer server-side and are the sole authority over game state; `firestore.rules` denies direct client writes to game-state docs once a room is `'playing'`

## Development

```bash
cd web
npm install
npm run dev
```

Run unit tests:

```bash
cd web
npm run test
```

Run e2e tests (Playwright — drives the real app through Home → Lobby → a full game against the Firebase Local Emulator Suite, at 1080p/ultrawide/1366×768):

```bash
cd web
npx playwright install chromium   # first time only
npm run test:e2e                  # headless, spins up its own dev server
npm run test:e2e:ui               # interactive UI mode
```

## Deploy

```bash
cd web && npm run build && cd ..
firebase deploy
```
