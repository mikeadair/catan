// Temporary, local-only preview harness (same spirit as DevPreview.tsx) for iterating on the
// trade UI rework without a live Firebase room or a second browser tab: seeds the real
// zustand store directly with a fake room/players/hand/trades and mounts the real <Game/>
// route, so TradeBar/TradeOffers/ResourceHand all run exactly as they do in production.
// Wired in from main.tsx behind ?preview=trade. Delete before shipping.
//
// ?preview=trade&state=<name> overrides a handful of room fields after the base state below is
// built, to reach modal/end-state UI that the default 'main' phase never shows — see the
// `stateOverrides` map. Kept as a flat field-merge (not a second full RoomState literal per
// state) so every state variant still gets the same board/players/hand as the default preview.
import { useEffect, type JSX } from 'react';
import { generateBoard } from '@catan/engine';
import type { RoomState, PublicPlayer, PrivateHand, TradeOffer } from '@catan/engine';
import {
  PLAYER_COLORS,
  DEFAULT_VICTORY_POINTS_TO_WIN,
  DEFAULT_DISCARD_LIMIT,
  DEFAULT_TURN_TIMER_SECONDS,
  DEFAULT_TRADE_RESPONSE_TIMER_SECONDS,
} from '@catan/engine';
import { useGameStore } from './state/store';
import Game from './routes/Game';

const stateOverrides: Record<string, Partial<RoomState>> = {
  discard: { phase: 'discard', pendingDiscardUids: ['p0'], discardPhaseStartedAt: Date.now() - 5_000 },
  'robber-hex': { phase: 'robber', robberPhaseStartedAt: Date.now() - 5_000 },
  'gold-pick': { phase: 'goldPick', pendingGoldPicks: [{ uid: 'p0', amount: 2 }] },
  'game-over': { phase: 'gameOver', winnerUid: 'p0' },
  'road-building': { pendingRoadBuilding: { uid: 'p0', roadsRemaining: 2 } },
  paused: { paused: true, pausedAt: Date.now() - 3_000 },
  // Not-yet-paused but a vote is already in ("Pausing… (X/Y)") / paused with a resume vote
  // already in ("Paused (X/Y to resume)") — PauseControl's two remaining label variants beyond
  // the plain 'Pause' / 'Paused — Resume?' defaults.
  pausing: { paused: false, pauseVotes: ['p0'] },
  'paused-voted': { paused: true, pausedAt: Date.now() - 3_000, pauseVotes: ['p0'] },
  // setup1/setup2 free-placement UI never shows up in the default 'main'-phase preview — these
  // clear the seeded vertices/edges (Object.assign replaces the whole object, not a merge) so
  // Game.tsx's setupNeedsSettlement/setupNeedsRoad derivation sees an empty board for p0 again.
  // 'setup1-road' additionally needs `vertices`/`lastSetupSettlementVertexId` populated with a
  // real board-generated vertex id, which isn't known until generateBoard() runs — see the
  // stateName === 'setup1-road' special-case below instead of here.
  'setup1-settlement': { phase: 'setup1', setupRound: 1, vertices: {}, edges: {} },
  'setup1-road': { phase: 'setup1', setupRound: 1, edges: {} },
};

// Separate from stateOverrides (room-phase variants) — this overrides the local player's own
// hand instead, for harness variants about hand *contents* rather than game phase. Applied via
// `?hand=<name>`, independent of `?state=` so either can be combined with the default 'main'
// phase or with each other.
const handOverrides: Record<string, Partial<PrivateHand>> = {
  // Every resource pinned at the bank's own max (19, matching the default bank fixture below)
  // so all five of ResourceHand's 'cards' groups hit the overlap-fan + overflow-stepper look at
  // once (the default hand only does this for ore), plus one of every dev card type so
  // DevCardPanel renders its full 5-card row instead of just the single default Knight.
  maxed: {
    resources: { brick: 19, lumber: 19, ore: 19, grain: 19, wool: 19 },
    devCards: [
      { id: 'dc-knight', type: 'knight', boughtTurn: 1 },
      { id: 'dc-road-building', type: 'roadBuilding', boughtTurn: 1 },
      { id: 'dc-yop', type: 'yearOfPlenty', boughtTurn: 1 },
      { id: 'dc-monopoly', type: 'monopoly', boughtTurn: 1 },
      { id: 'dc-vp', type: 'victoryPoint', boughtTurn: 1 },
    ],
  },
};

export default function TradePreview(): JSX.Element {
  useEffect(() => {
    const board = generateBoard('official-beginner', 'preview-seed');

    const room: RoomState = {
      id: 'preview',
      code: 'PREVW',
      hostUid: 'p0',
      status: 'playing',
      mapPreset: 'official-beginner',
      seed: 'preview-seed',
      board,
      vertices: {},
      edges: {},
      turnOrder: ['p0', 'p1', 'p2'],
      currentPlayerIndex: 0,
      phase: 'main',
      diceRoll: [3, 4],
      bank: { brick: 14, lumber: 9, ore: 19, grain: 5, wool: 0 },
      devCardDeck: [],
      devCardDeckCount: 12,
      longestRoadUid: null,
      largestArmyUid: null,
      winnerUid: null,
      turnNumber: 5,
      turnStartedAt: Date.now(),
      setupRound: null,
      pendingDiscardUids: [],
      discardPhaseStartedAt: null,
      robberPhaseStartedAt: null,
      setupTurnStartedAt: null,
      botActionClaim: null,
      // A few structured entries so log-derived UI (RollStats, GameLog's turn dividers,
      // GameOverStandings' totals) has something to render in the harness.
      log: [
        { id: 'l1', ts: Date.now() - 60_000, message: 'You rolled a 8.', meta: { kind: 'diceRoll', roll: [3, 5], gains: { p0: { ore: 1 }, p1: { grain: 2 } } } },
        { id: 'l2', ts: Date.now() - 45_000, message: 'Bot Alice built a road.' },
        { id: 'l3', ts: Date.now() - 30_000, message: 'Bot Alice rolled a 6.', meta: { kind: 'diceRoll', roll: [2, 4], gains: { p2: { lumber: 1 } } } },
        { id: 'l4', ts: Date.now() - 15_000, message: 'Bot Bob rolled a 7.', meta: { kind: 'diceRoll', roll: [3, 4] } },
      ],
      createdAt: Date.now(),
      victoryPointsToWin: DEFAULT_VICTORY_POINTS_TO_WIN,
      discardLimit: DEFAULT_DISCARD_LIMIT,
      turnTimerSeconds: DEFAULT_TURN_TIMER_SECONDS,
      tradeResponseTimerSeconds: DEFAULT_TRADE_RESPONSE_TIMER_SECONDS,
      safeMode: false,
      paused: false,
      pausedAt: null,
      pauseVotes: [],
      discoveredHexIds: null,
      pendingGoldPicks: [],
    };

    const players: Record<string, PublicPlayer> = {
      p0: {
        uid: 'p0',
        displayName: 'You',
        color: PLAYER_COLORS[0],
        isBot: false,
        seatIndex: 0,
        resourceCount: 7,
        devCardCount: 1,
        visibleVictoryPoints: 3,
        knightsPlayed: 0,
        roadsBuilt: 2,
        settlementsBuilt: 2,
        citiesBuilt: 0,
        connected: true,
        lastSeen: Date.now(),
      },
      p1: {
        uid: 'p1',
        displayName: 'Bot Alice',
        color: PLAYER_COLORS[1],
        isBot: true,
        seatIndex: 1,
        resourceCount: 5,
        devCardCount: 0,
        visibleVictoryPoints: 2,
        knightsPlayed: 1,
        roadsBuilt: 2,
        settlementsBuilt: 1,
        citiesBuilt: 0,
        connected: true,
        lastSeen: Date.now(),
      },
      p2: {
        uid: 'p2',
        displayName: 'Bot Bob',
        color: PLAYER_COLORS[2],
        isBot: true,
        seatIndex: 2,
        resourceCount: 4,
        devCardCount: 0,
        visibleVictoryPoints: 2,
        knightsPlayed: 0,
        roadsBuilt: 2,
        settlementsBuilt: 1,
        citiesBuilt: 0,
        connected: true,
        lastSeen: Date.now(),
      },
    };

    const vertexIds = Object.keys(board.vertices);
    room.vertices[vertexIds[3]] = { type: 'settlement', uid: 'p0' };
    room.vertices[vertexIds[10]] = { type: 'city', uid: 'p0' };
    room.vertices[vertexIds[15]] = { type: 'settlement', uid: 'p1' };
    // Also adjacent to hex '-1,-1' alongside p1's settlement (vertexIds[15]) — gives that hex two
    // eligible robber victims (p1 + p2) so the robber-victim-modal snap component (hex hotspot
    // click) actually reaches RobberModal's 'victim' step instead of auto-resolving to a single
    // eligible uid. Fixes p2's settlementsBuilt:1 vs. zero-actual-vertices mismatch below too.
    room.vertices['-1732051_-2000000'] = { type: 'settlement', uid: 'p2' };
    const edgeIds = Object.keys(board.edges);
    room.edges[edgeIds[5]] = 'p0';
    room.edges[edgeIds[6]] = 'p0';

    const ownHand: PrivateHand = {
      // ore intentionally over ResourceHand's RESOURCE_GROUP_CAP (6) so the 'cards' hand variant's
      // overlap fan + trailing overflow/counter slot both render by default — otherwise every snap
      // of the hand/toolbar components would only ever show the plain under-cap look.
      resources: { brick: 2, lumber: 2, ore: 12, grain: 1, wool: 1 },
      devCards: [{ id: 'dc1', type: 'knight', boughtTurn: 1 }],
    };

    const trades: TradeOffer[] = [
      {
        id: 't1',
        proposerUid: 'p1',
        targetUid: 'p0',
        give: { ore: 2 },
        receive: { wool: 1, grain: 1 },
        status: 'pending',
        counterOf: null,
        createdAt: Date.now(),
      },
      {
        id: 't2',
        proposerUid: 'p0',
        targetUid: null,
        give: { lumber: 2 },
        receive: { brick: 1 },
        status: 'pending',
        counterOf: null,
        createdAt: Date.now(),
        interestedUids: ['p2'],
      },
      // Demonstrates the per-responder status circles for an open trade with a mixed
      // response (p1 hasn't answered, p2 has rejected) plus the "everyone rejected" red
      // flash-then-dismiss: both other players have rejected this one, so it should show
      // red and disappear shortly after mount (see TradeOffers.tsx's ALL_REJECTED_FLASH_MS).
      {
        id: 't3',
        proposerUid: 'p1',
        targetUid: null,
        give: { grain: 1 },
        receive: { ore: 1 },
        status: 'pending',
        counterOf: null,
        createdAt: Date.now(),
        interestedUids: [],
        rejectedUids: ['p0', 'p2'],
      },
    ];

    const params = new URLSearchParams(window.location.search);
    const stateName = params.get('state');
    if (stateName) {
      const overrides = stateOverrides[stateName];
      if (!overrides) throw new Error(`[TradePreview] unknown ?state=${stateName} — known: ${Object.keys(stateOverrides).join(', ')}`);
      Object.assign(room, overrides);
      if (stateName === 'setup1-road') {
        // p0 has one settlement placed and needs its free setup road — Board.tsx's freeSetup
        // candidateEdges computation anchors off room.lastSetupSettlementVertexId (empty
        // candidate set without it), which isn't known until generateBoard() has run above, so
        // this can't live in the static stateOverrides map.
        const anchorVertexId = vertexIds[3];
        room.vertices = { [anchorVertexId]: { type: 'settlement', uid: 'p0' } };
        room.lastSetupSettlementVertexId = anchorVertexId;
      }
    }
    const handName = params.get('hand');
    if (handName) {
      const overrides = handOverrides[handName];
      if (!overrides) throw new Error(`[TradePreview] unknown ?hand=${handName} — known: ${Object.keys(handOverrides).join(', ')}`);
      Object.assign(ownHand, overrides);
    }

    useGameStore.setState({
      uid: 'p0',
      roomId: 'preview',
      room,
      players,
      ownHand,
      trades,
      chat: [],
      error: null,
      // Stub out network dispatch entirely — this harness is for visual/layout iteration,
      // not exercising server-authoritative rules, so button clicks just log instead of
      // round-tripping to Firebase (which isn't running here at all).
      dispatch: async (action) => {
        console.log('[TradePreview] dispatch (stubbed, no-op):', action);
      },
      dispatchQuiet: async () => {},
      sendChatMessage: async () => {},
    });
  }, []);

  return <Game />;
}
