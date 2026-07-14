// Shared infrastructure for web/e2e/latency-fuzz.spec.ts — see that file's header comment for
// what the suite covers and how to rerun/reproduce it. Kept in its own module (rather than
// folded into helpers.ts) since everything here is specific to latency injection + the
// server-state oracle, not reusable by the plain-localhost layout suite.
import type { Browser, BrowserContext, CDPSession, Page } from '@playwright/test';
// Modular API (not the `firebase-admin` namespace default import) — mirrors
// functions/src/db.ts's own usage, the only other admin-SDK consumer in this repo.
import { deleteApp, getApps, initializeApp, type App } from 'firebase-admin/app';
import { getFirestore, type Firestore, type UpdateData } from 'firebase-admin/firestore';
import { mkdirSync, writeFileSync } from 'node:fs';
import type { PrivateHand, PublicPlayer, RoomState, TradeOffer } from '@catan/engine';

// ---------------------------------------------------------------------------
// Seeded PRNG — mulberry32. Small, dependency-free, and deterministic: the same seed always
// produces the same sequence, which is what makes a failing run reproducible via LATENCY_SEED.
// ---------------------------------------------------------------------------
export type Rng = () => number;

export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return function (): number {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function resolveSeed(): number {
  const fromEnv = process.env.LATENCY_SEED;
  if (fromEnv && /^\d+$/.test(fromEnv)) return Number(fromEnv);
  return 424242; // fixed default so a plain rerun without LATENCY_SEED is still deterministic
}

function randRange(rng: Rng, min: number, max: number): number {
  return min + rng() * (max - min);
}

// ---------------------------------------------------------------------------
// CDP-based latency injection. Applied per BrowserContext so different simulated players can
// carry independent profiles (e.g. one client fast, another's confirmations arriving slow) —
// this is what stresses the optimistic-UI-vs-server-confirmation gap the whole suite hunts
// for, rather than just generic uniform slowness.
//
// Realistic bounds (not exotic worst-case numbers): a 20-250ms base round-trip, punctuated
// occasionally by a 500-900ms jitter spike (think: a mobile connection or a flaky wifi hop),
// re-rolled every couple of seconds for the life of the context.
// ---------------------------------------------------------------------------
const BASE_LATENCY_MIN_MS = 20;
const BASE_LATENCY_MAX_MS = 250;
const SPIKE_LATENCY_MIN_MS = 500;
const SPIKE_LATENCY_MAX_MS = 900;
const SPIKE_CHANCE = 0.15;
const REROLL_MIN_MS = 1500;
const REROLL_MAX_MS = 3000;

export interface LatencyHandle {
  stop: () => Promise<void>;
}

/** Starts a randomized, continuously-varying latency profile on `page`'s network (via CDP),
 * logging every change so a failing run's console output shows exactly what was in effect at
 * any given moment. Returns a handle whose `stop()` clears the interval and (best-effort)
 * resets network conditions to unthrottled. */
export async function startRandomLatency(context: BrowserContext, page: Page, rng: Rng, label: string): Promise<LatencyHandle> {
  const client: CDPSession = await context.newCDPSession(page);
  let stopped = false;

  async function applyOnce(): Promise<void> {
    if (stopped) return;
    const isSpike = rng() < SPIKE_CHANCE;
    const latency = isSpike ? randRange(rng, SPIKE_LATENCY_MIN_MS, SPIKE_LATENCY_MAX_MS) : randRange(rng, BASE_LATENCY_MIN_MS, BASE_LATENCY_MAX_MS);
    try {
      await client.send('Network.emulateNetworkConditions', {
        offline: false,
        latency,
        downloadThroughput: -1,
        uploadThroughput: -1,
      });
      // eslint-disable-next-line no-console
      console.log(`[latency-fuzz] ${label}: ${Math.round(latency)}ms${isSpike ? ' (jitter spike)' : ''}`);
    } catch {
      // Context/page may already be closing — non-fatal, just stop trying.
    }
  }

  await applyOnce();
  let timer: ReturnType<typeof setTimeout>;
  function scheduleNext() {
    timer = setTimeout(() => {
      void applyOnce().finally(scheduleNext);
    }, randRange(rng, REROLL_MIN_MS, REROLL_MAX_MS));
  }
  scheduleNext();

  return {
    stop: async () => {
      stopped = true;
      clearTimeout(timer);
      try {
        await client.send('Network.emulateNetworkConditions', {
          offline: false,
          latency: 0,
          downloadThroughput: -1,
          uploadThroughput: -1,
        });
      } catch {
        // ignore
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Server-state oracle: reads Firestore directly via firebase-admin, pointed at the same
// Firestore emulator instance the app under test talks to. This is a deliberately *separate*
// path from the app's own onSnapshot listeners (which live inside the CDP-throttled browser
// pages) — admin reads run from the untouched Node test process, so they see authoritative,
// effectively-unthrottled state. That separation is what makes this a real oracle rather than
// a tautological "does the DOM match the client's own (possibly stale) state" check.
// ---------------------------------------------------------------------------
let adminApp: App | null = null;

function getAdminApp(): App {
  if (adminApp) return adminApp;
  process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST ?? '127.0.0.1:8080';
  // No explicit projectId: same as functions/src/db.ts, relies on GCLOUD_PROJECT (set by
  // `firebase emulators:exec --project mikeadair-catan`, which is how this suite is always
  // invoked — see the test:e2e:latency npm script).
  adminApp = getApps().length > 0 ? getApps()[0] : initializeApp();
  return adminApp;
}

function adminDb(): Firestore {
  return getFirestore(getAdminApp());
}

/** The app never puts the Firestore room *document id* in the URL (no router — see
 * App.tsx/Lobby.tsx, everything lives in the Zustand store) so the only thing a test can read
 * back off the page is the human-facing `code` (`.lobby__code`). Looks up the doc id behind
 * that code directly via the oracle's admin connection. */
export async function fetchRoomIdByCode(code: string): Promise<string> {
  const snap = await adminDb().collection('rooms').where('code', '==', code).limit(1).get();
  if (snap.empty) throw new Error(`Oracle: no room found with code ${code}`);
  return snap.docs[0].id;
}

export async function fetchRoom(roomId: string): Promise<RoomState> {
  const snap = await adminDb().doc(`rooms/${roomId}`).get();
  if (!snap.exists) throw new Error(`Oracle: room ${roomId} does not exist`);
  return { id: snap.id, ...(snap.data() as Omit<RoomState, 'id'>) };
}

export async function fetchPlayers(roomId: string): Promise<Record<string, PublicPlayer>> {
  const snap = await adminDb().collection(`rooms/${roomId}/players`).get();
  const out: Record<string, PublicPlayer> = {};
  snap.forEach((d) => {
    out[d.id] = d.data() as PublicPlayer;
  });
  return out;
}

export async function fetchHand(roomId: string, uid: string): Promise<PrivateHand | null> {
  const snap = await adminDb().doc(`rooms/${roomId}/players/${uid}/private/hand`).get();
  return snap.exists ? (snap.data() as PrivateHand) : null;
}

export async function fetchTrades(roomId: string): Promise<TradeOffer[]> {
  const snap = await adminDb().collection(`rooms/${roomId}/trades`).get();
  return snap.docs.map((d) => d.data() as TradeOffer);
}

/** Test-only escape hatch for deterministically forcing a room into a specific phase/timer
 * state (e.g. "robber phase, about to time out") without waiting on real dice/bot RNG to get
 * there — bypasses firestore.rules (admin SDK) same as the real submitAction Cloud Function
 * does, so it's exercising the same trust boundary, just skipping straight to the state under
 * test. Only ever used from this suite, never from application code. */
export async function forceRoomFields(roomId: string, patch: Partial<RoomState>): Promise<void> {
  await adminDb().doc(`rooms/${roomId}`).update(patch as UpdateData<Partial<RoomState>>);
}

export async function forceHand(roomId: string, uid: string, hand: PrivateHand): Promise<void> {
  await adminDb().doc(`rooms/${roomId}/players/${uid}/private/hand`).set(hand);
}

export async function closeAdminApp(): Promise<void> {
  if (adminApp) {
    await deleteApp(adminApp).catch(() => {});
    adminApp = null;
  }
}

// ---------------------------------------------------------------------------
// DOM readers — pull the rendered-state side of the comparison. Keyed off the data-testid/
// data-* hooks added to Board.tsx/TradeOffers.tsx/ResourceHand.tsx specifically for this
// suite (see those files' comments) — inert in normal rendering, just query surface here.
// ---------------------------------------------------------------------------
export async function readRenderedRoads(page: Page): Promise<Map<string, string>> {
  const raw = await page.$$eval('g[data-testid]', (els) =>
    els
      .filter((el) => {
        const t = el.getAttribute('data-testid') ?? '';
        return t.startsWith('road-') && !t.startsWith('road-preview-');
      })
      .map((el) => [el.getAttribute('data-testid')!.slice('road-'.length), el.getAttribute('data-owner-uid') ?? ''] as [string, string]),
  );
  return new Map(raw);
}

export interface RenderedBuilding {
  ownerUid: string;
  type: string;
}

export async function readRenderedBuildings(page: Page): Promise<Map<string, RenderedBuilding>> {
  const raw = await page.$$eval('[data-testid]', (els) =>
    els
      .filter((el) => (el.getAttribute('data-testid') ?? '').startsWith('building-'))
      .map(
        (el) =>
          [
            el.getAttribute('data-testid')!.slice('building-'.length),
            { ownerUid: el.getAttribute('data-owner-uid') ?? '', type: el.getAttribute('data-building-type') ?? '' },
          ] as [string, RenderedBuilding],
      ),
  );
  return new Map(raw);
}

export async function readRenderedRobberHex(page: Page): Promise<string | null> {
  const els = await page.$$('[data-testid="robber"]');
  if (els.length === 0) return null;
  return els[0].getAttribute('data-hex-id');
}

/** Whether *any* visual indication currently exists for the given edge/vertex — the real
 * committed piece, a road-building preview, or the two-step tap-to-confirm "armed" preview.
 * Used by the build-action gap check to assert the original invisible-piece bug (see
 * Board.tsx's comment on the road-render fix) never recurs: something must always be
 * rendered at the acted-on spot from the moment of confirmation onward. */
export async function isEdgeVisuallyRepresented(page: Page, edgeId: string): Promise<boolean> {
  const real = await page.$(`[data-testid="road-${edgeId}"]`);
  if (real) return true;
  const preview = await page.$(`[data-testid="road-preview-${edgeId}"]`);
  if (preview) return true;
  const armed = await page.$(`[data-testid="armed-preview-edge"][data-armed-id="${edgeId}"]`);
  return armed !== null;
}

export async function isVertexVisuallyRepresented(page: Page, vertexId: string): Promise<boolean> {
  const real = await page.$(`[data-testid="building-${vertexId}"]`);
  if (real) return true;
  const armed = await page.$(`[data-testid="armed-preview-vertex"][data-armed-id="${vertexId}"]`);
  return armed !== null;
}

export interface RenderedTrade {
  status: string;
}

export async function readRenderedTrades(page: Page): Promise<Map<string, RenderedTrade>> {
  const raw = await page.$$eval('[data-testid]', (els) =>
    els
      .filter((el) => (el.getAttribute('data-testid') ?? '').startsWith('trade-') && !(el.getAttribute('data-testid') ?? '').includes('responder'))
      .map((el) => [el.getAttribute('data-testid')!.slice('trade-'.length), { status: el.getAttribute('data-trade-status') ?? '' }] as [string, RenderedTrade]),
  );
  return new Map(raw);
}

export async function readRenderedResponderStatus(page: Page, tradeId: string, responderUid: string): Promise<string | null> {
  const el = await page.$(`[data-testid="responder-${tradeId}-${responderUid}"]`);
  if (!el) return null;
  return el.getAttribute('data-responder-status');
}

/** Sum of rendered hand-card faces for a given resource, reading the `data-resource-count`
 * hook set once per resource on ResourceHand's 'cards' variant (see that file). Returns null
 * if no cards of that resource are rendered (count is 0, so nothing to read the count off
 * of) — callers should treat that as 0. */
export async function readRenderedResourceCount(page: Page, resource: string): Promise<number | null> {
  const el = await page.$(`[data-testid="hand-card"][data-resource="${resource}"]`);
  if (!el) return null;
  const raw = await el.getAttribute('data-resource-count');
  return raw ? Number(raw) : null;
}

// ---------------------------------------------------------------------------
// Comparators — accumulate every mismatch found rather than stopping at the first one, so a
// single run's failure output is a complete report instead of "fix one, rerun, find the next".
// ---------------------------------------------------------------------------
export function diffRoadsAndBuildings(
  room: RoomState,
  domRoads: Map<string, string>,
  domBuildings: Map<string, RenderedBuilding>,
): string[] {
  const mismatches: string[] = [];

  for (const [edgeId, ownerUid] of Object.entries(room.edges)) {
    const rendered = domRoads.get(edgeId);
    if (rendered === undefined) {
      mismatches.push(`missing road: edge ${edgeId} is owned by ${ownerUid} in room.edges but no road is rendered`);
    } else if (rendered !== ownerUid) {
      mismatches.push(`wrong road owner: edge ${edgeId} owned by ${ownerUid} in room.edges but rendered in ${rendered}'s color`);
    }
  }
  for (const edgeId of domRoads.keys()) {
    if (!room.edges[edgeId]) {
      mismatches.push(`phantom road: edge ${edgeId} is rendered but not present in room.edges`);
    }
  }

  for (const [vertexId, building] of Object.entries(room.vertices)) {
    const rendered = domBuildings.get(vertexId);
    if (!rendered) {
      mismatches.push(`missing building: vertex ${vertexId} is a ${building.type} owned by ${building.uid} in room.vertices but nothing is rendered`);
    } else {
      if (rendered.ownerUid !== building.uid) {
        mismatches.push(`wrong building owner: vertex ${vertexId} owned by ${building.uid} but rendered in ${rendered.ownerUid}'s color`);
      }
      if (rendered.type !== building.type) {
        mismatches.push(`wrong building type: vertex ${vertexId} is a ${building.type} in room.vertices but rendered as a ${rendered.type}`);
      }
    }
  }
  for (const vertexId of domBuildings.keys()) {
    if (!room.vertices[vertexId]) {
      mismatches.push(`phantom building: vertex ${vertexId} is rendered but not present in room.vertices`);
    }
  }

  return mismatches;
}

export function diffRobber(room: RoomState, domRobberHex: string | null): string[] {
  if (!room.board) return [];
  if (domRobberHex !== room.board.robberHexId) {
    return [`robber position mismatch: room.board.robberHexId=${room.board.robberHexId} but DOM shows it on ${domRobberHex ?? '(nothing rendered)'}`];
  }
  return [];
}

/** Mirrors TradeOffers.tsx's own responderStatus() logic — duplicated (not imported; that
 * component isn't set up to export it) purely to compute the *expected* status the same way
 * the component does, so this stays a true "does rendering match the rule" check rather than
 * a tautology. Keep in sync if TradeOffers.tsx's own logic changes. */
function expectedResponderStatus(trade: TradeOffer, responderUid: string): 'pending' | 'accepted' | 'rejected' {
  if (trade.targetUid !== null) {
    if (trade.status === 'accepted') return 'accepted';
    if (trade.status === 'rejected') return 'rejected';
    return 'pending';
  }
  if (trade.interestedUids?.includes(responderUid)) return 'accepted';
  if (trade.rejectedUids?.includes(responderUid)) return 'rejected';
  return 'pending';
}

export async function diffTrades(
  page: Page,
  trades: TradeOffer[],
  players: Record<string, PublicPlayer>,
  uid: string,
): Promise<string[]> {
  const mismatches: string[] = [];
  const domTrades = await readRenderedTrades(page);
  const relevant = trades.filter((t) => t.proposerUid === uid || t.targetUid === uid || t.targetUid === null);

  for (const t of relevant) {
    if (t.status !== 'pending') continue; // TradeOffers.tsx only ever renders pending trades (plus a brief all-rejected flash it owns itself)
    const rendered = domTrades.get(t.id);
    if (!rendered) continue; // may legitimately be in its all-rejected flash-then-hide window; not checked here
    if (rendered.status !== t.status) {
      mismatches.push(`trade ${t.id} status mismatch: server=${t.status} dom=${rendered.status}`);
    }
    const responders = t.targetUid !== null ? [t.targetUid] : Object.keys(players).filter((p) => p !== t.proposerUid);
    for (const responderUid of responders) {
      const domStatus = await readRenderedResponderStatus(page, t.id, responderUid);
      if (domStatus === null) continue; // responder dot not rendered for this viewer/trade shape
      const expected = expectedResponderStatus(t, responderUid);
      if (domStatus !== expected) {
        mismatches.push(`trade ${t.id} responder ${responderUid} status mismatch: expected=${expected} dom=${domStatus}`);
      }
    }
  }
  return mismatches;
}

/** Full sweep: roads, buildings, and robber position, in one combined report. This is the
 * "settled" comparator — call it once the app has had a reasonable window to catch up on
 * whatever latency is in effect (the oracle read itself is instantaneous; only the DOM side
 * can lag). */
export async function diffBoardState(page: Page, roomId: string): Promise<string[]> {
  const room = await fetchRoom(roomId);
  const [domRoads, domBuildings, domRobberHex] = await Promise.all([
    readRenderedRoads(page),
    readRenderedBuildings(page),
    readRenderedRobberHex(page),
  ]);
  return [...diffRoadsAndBuildings(room, domRoads, domBuildings), ...diffRobber(room, domRobberHex)];
}

/** Polls `diffBoardState` until it reports no mismatches or `timeoutMs` elapses, returning the
 * last-seen mismatch list (empty on success). Use this instead of a single point-in-time check
 * after any action, since the DOM side is always allowed a bounded catch-up window under
 * injected latency before a divergence counts as a real bug. */
export async function waitForBoardStateToSettle(page: Page, roomId: string, timeoutMs: number, pollMs = 150): Promise<string[]> {
  const deadline = Date.now() + timeoutMs;
  let last: string[] = [];
  do {
    last = await diffBoardState(page, roomId);
    if (last.length === 0) return [];
    await new Promise((r) => setTimeout(r, pollMs));
  } while (Date.now() < deadline);
  return last;
}

/** Finds the uid of the player seated under `displayName` — used to translate a Playwright
 * page (identified by the display name it signed up with) into the uid keying room.edges/
 * room.vertices/players/etc, without needing to reach into the app's own auth internals. */
export function findUidByDisplayName(players: Record<string, PublicPlayer>, displayName: string): string {
  const found = Object.values(players).find((p) => p.displayName === displayName);
  if (!found) throw new Error(`No player with displayName ${displayName} found in ${JSON.stringify(Object.keys(players))}`);
  return found.uid;
}

export async function newContextAndPage(browser: Browser): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext();
  const page = await context.newPage();
  return { context, page };
}

// ---------------------------------------------------------------------------
// Ad hoc screenshots — a complementary, human-review signal alongside the automated oracle
// above. Captured at a handful of points through each driven game/action sequence, gated by
// the same seeded `rng` so which points actually get captured is reproducible (not every
// checkpoint fires every run — see CAPTURE_CHANCE) rather than snapshotting everything, which
// would produce a huge pile of near-duplicate images per run. These are NOT assertions and
// NOT auto-analyzed by anything in this suite — purely saved for a person to look at.
// ---------------------------------------------------------------------------
const SCREENSHOT_DIR = 'e2e/latency-fuzz-screenshots'; // relative to web/ (the suite's cwd) — gitignored, see .gitignore
const CAPTURE_CHANCE = 0.6;
let screenshotDirReady = false;

function ensureScreenshotDir(): void {
  if (screenshotDirReady) return;
  mkdirSync(SCREENSHOT_DIR, { recursive: true });
  screenshotDirReady = true;
}

function sanitizeForFilename(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]+/g, '-');
}

/**
 * Maybe takes a full-page screenshot of `page`, named so a human can orient without running
 * anything: seed, which test/scenario, which checkpoint within it, and which simulated
 * player's view it is. Whether this particular call actually captures is itself decided by
 * `rng` (see CAPTURE_CHANCE) — pass the same suite-seeded rng used for latency injection so a
 * rerun with the same LATENCY_SEED captures the same points.
 */
export async function maybeCaptureScreenshot(
  rng: Rng,
  page: Page,
  seed: number,
  scenario: string,
  checkpoint: string,
  playerLabel: string,
): Promise<void> {
  if (rng() >= CAPTURE_CHANCE) return;
  ensureScreenshotDir();
  const file = `${SCREENSHOT_DIR}/seed${seed}_${sanitizeForFilename(scenario)}_${sanitizeForFilename(checkpoint)}_${sanitizeForFilename(playerLabel)}.png`;
  try {
    await page.screenshot({ path: file, fullPage: true });
    // eslint-disable-next-line no-console
    console.log(`[latency-fuzz] screenshot saved: ${file}`);
  } catch {
    // Best-effort only — a screenshot failure (e.g. page mid-navigation) should never fail
    // the actual test.
  }
}

// ---------------------------------------------------------------------------
// Failure-triggered before/after screenshot pairs — deliberately separate from
// maybeCaptureScreenshot above (which always saves, for general skim-review). Every real
// oracle checkpoint (a DOM-vs-server comparison) in the suite is wrapped in
// withFailureScreenshots: it takes an in-memory (not written to disk) screenshot of every
// relevant page immediately before running the checkpoint's action/wait/diff, and another
// immediately after, and ONLY persists either pair to disk if the checkpoint actually found a
// divergence. A normal passing run writes none of these. The point is to hand a human
// debugging a caught failure the exact visual transition that produced it — e.g. "before: the
// armed preview was visible in the player's own color; after: nothing rendered at all, even
// though the oracle says room.edges now has this road" — rather than just the end state.
// ---------------------------------------------------------------------------

async function captureInMemory(pages: Record<string, Page>): Promise<Record<string, Buffer>> {
  const out: Record<string, Buffer> = {};
  for (const [label, page] of Object.entries(pages)) {
    try {
      out[label] = await page.screenshot({ fullPage: true });
    } catch {
      // Best-effort — a page mid-navigation shouldn't block the actual checkpoint.
    }
  }
  return out;
}

function persistBuffers(buffers: Record<string, Buffer>, filePrefix: string, phase: 'before' | 'after'): void {
  for (const [label, buf] of Object.entries(buffers)) {
    writeFileSync(`${filePrefix}_${sanitizeForFilename(label)}_${phase}.png`, buf);
  }
}

/**
 * Runs `check` (which performs whatever action/settle-wait a given checkpoint covers and
 * returns a list of oracle-diff strings — empty means the checkpoint passed) bracketed by an
 * in-memory before/after screenshot of every page in `pages`. Only ever writes those to disk
 * if `check` returns a non-empty list. Returns whatever `check` returned, unchanged, so
 * callers still just `expect(result).toEqual([])` it exactly as before.
 *
 * `label` should uniquely identify this specific checkpoint occurrence within a run (e.g.
 * include an action/turn index if the same checkpoint runs more than once) so failure files
 * from different points in the same run don't collide or overwrite each other.
 */
export async function withFailureScreenshots(
  pages: Record<string, Page>,
  seed: number,
  scenario: string,
  label: string,
  check: () => Promise<string[]>,
): Promise<string[]> {
  const before = await captureInMemory(pages);
  const diffs = await check();
  const after = await captureInMemory(pages);
  if (diffs.length > 0) {
    ensureScreenshotDir();
    const prefix = `${SCREENSHOT_DIR}/FAILURE_seed${seed}_${sanitizeForFilename(scenario)}_${sanitizeForFilename(label)}`;
    persistBuffers(before, prefix, 'before');
    persistBuffers(after, prefix, 'after');
    // eslint-disable-next-line no-console
    console.log(
      `[latency-fuzz] FAILURE at checkpoint "${label}" (${scenario}, seed ${seed}): ${diffs.length} issue(s) — ` +
        `before/after screenshots saved to ${prefix}_<player>_{before,after}.png`,
    );
  }
  return diffs;
}
