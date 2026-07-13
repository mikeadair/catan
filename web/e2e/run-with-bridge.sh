#!/usr/bin/env bash
# Runs Playwright against the e2e Functions bridge (see functions/src/e2eBridge.ts) instead
# of the real Functions emulator, which is unreliable in this class of sandboxed environment.
# Invoked as the inner command of `firebase emulators:exec --only auth,firestore "..."` —
# auth/firestore are still the real emulators; only the Functions emulator is replaced.
set -euo pipefail

node ../functions/lib/e2eBridge.js &
BRIDGE_PID=$!
trap 'kill "$BRIDGE_PID" 2>/dev/null || true' EXIT

for _ in $(seq 1 50); do
  code=$(curl -s -o /dev/null -w '%{http_code}' -X POST \
    "http://127.0.0.1:5001/${GCLOUD_PROJECT:-mikeadair-catan}/us-central1/startGame" \
    -H 'Content-Type: application/json' -d '{}' || true)
  if [ "$code" != "000" ]; then
    break
  fi
  sleep 0.2
done

npx playwright test "$@"
