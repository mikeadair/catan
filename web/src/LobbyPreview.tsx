// Temporary, local-only preview harness (same spirit as TradePreview.tsx) for snapping the
// lobby screen without a live Firebase room. Seeds the real zustand store directly with a fake
// 'lobby'-status room + players and mounts the real <Lobby/> route — no network calls, no bot
// AI, dispatch-driving actions (addBot/updateRoomSettings/etc.) go straight to Firebase in real
// use but Lobby.tsx itself only reads from the store, so nothing here needs stubbing.
//
// ?preview=lobby&seats=full fills every seat (vs. the default 2 seated + open slots).
// ?preview=lobby&role=guest views as a non-host seated player (host-only controls hidden).
// Wired in from main.tsx behind ?preview=lobby.
import { useEffect, type JSX } from 'react';
import type { RoomState, PublicPlayer } from '@catan/engine';
import {
  PLAYER_COLORS,
  DEFAULT_VICTORY_POINTS_TO_WIN,
  DEFAULT_DISCARD_LIMIT,
  DEFAULT_TURN_TIMER_SECONDS,
  DEFAULT_TRADE_RESPONSE_TIMER_SECONDS,
} from '@catan/engine';
import { useGameStore } from './state/store';
import Lobby from './routes/Lobby';

export default function LobbyPreview(): JSX.Element {
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const full = params.get('seats') === 'full';
    const asGuest = params.get('role') === 'guest';

    const seatCount = full ? PLAYER_COLORS.length : 2;
    const uids = Array.from({ length: seatCount }, (_, i) => `p${i}`);

    const room: RoomState = {
      id: 'preview',
      code: 'PREVW',
      hostUid: 'p0',
      status: 'lobby',
      mapPreset: 'official-beginner',
      seed: 'preview-seed',
      board: null,
      vertices: {},
      edges: {},
      turnOrder: uids,
      currentPlayerIndex: 0,
      phase: 'setup1',
      diceRoll: null,
      bank: { brick: 19, lumber: 19, ore: 19, grain: 19, wool: 19 },
      devCardDeck: [],
      devCardDeckCount: 25,
      longestRoadUid: null,
      largestArmyUid: null,
      winnerUid: null,
      turnNumber: 0,
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
      tradeResponseTimerSeconds: DEFAULT_TRADE_RESPONSE_TIMER_SECONDS,
      safeMode: false,
      paused: false,
      pausedAt: null,
      pauseVotes: [],
      discoveredHexIds: null,
      pendingGoldPicks: [],
    };

    const players: Record<string, PublicPlayer> = {};
    uids.forEach((uid, i) => {
      // In the 'guest' role, seat 1 (not seat 0) is the viewer — a human, not a bot, since a
      // bot never actually views its own lobby — so name/isBot swap for that one seat.
      const isViewer = asGuest ? i === 1 : i === 0;
      const isBot = !isViewer && i > 0;
      players[uid] = {
        uid,
        displayName: isViewer ? 'You' : isBot ? `Bot ${PLAYER_COLORS[i]}` : 'Host',
        color: PLAYER_COLORS[i],
        isBot,
        botDifficulty: isBot ? 'normal' : undefined,
        seatIndex: i,
        resourceCount: 0,
        devCardCount: 0,
        visibleVictoryPoints: 0,
        knightsPlayed: 0,
        roadsBuilt: 0,
        settlementsBuilt: 0,
        citiesBuilt: 0,
        connected: true,
        lastSeen: Date.now(),
      };
    });

    useGameStore.setState({
      uid: asGuest ? uids[1] : 'p0',
      roomId: 'preview',
      room,
      players,
      ownHand: { resources: { brick: 0, lumber: 0, ore: 0, grain: 0, wool: 0 }, devCards: [] },
      trades: [],
      chat: [],
      error: null,
      dispatch: async (action) => {
        console.log('[LobbyPreview] dispatch (stubbed, no-op):', action);
      },
      dispatchQuiet: async () => {},
      sendChatMessage: async () => {},
    });
  }, []);

  return <Lobby />;
}
