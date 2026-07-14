// Temporary, local-only preview harness (same spirit as DevPreview.tsx) for iterating on the
// trade UI rework without a live Firebase room or a second browser tab: seeds the real
// zustand store directly with a fake room/players/hand/trades and mounts the real <Game/>
// route, so TradeBar/TradeOffers/ResourceHand all run exactly as they do in production.
// Wired in from main.tsx behind ?preview=trade. Delete before shipping.
import { useEffect, type JSX } from 'react';
import { generateBoard } from '@catan/engine';
import type { RoomState, PublicPlayer, PrivateHand, TradeOffer } from '@catan/engine';
import { PLAYER_COLORS, DEFAULT_VICTORY_POINTS_TO_WIN, DEFAULT_DISCARD_LIMIT, DEFAULT_TURN_TIMER_SECONDS } from '@catan/engine';
import { useGameStore } from './state/store';
import Game from './routes/Game';

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
      log: [],
      createdAt: Date.now(),
      victoryPointsToWin: DEFAULT_VICTORY_POINTS_TO_WIN,
      discardLimit: DEFAULT_DISCARD_LIMIT,
      turnTimerSeconds: DEFAULT_TURN_TIMER_SECONDS,
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
    const edgeIds = Object.keys(board.edges);
    room.edges[edgeIds[5]] = 'p0';
    room.edges[edgeIds[6]] = 'p0';

    const ownHand: PrivateHand = {
      resources: { brick: 2, lumber: 2, ore: 1, grain: 1, wool: 1 },
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
