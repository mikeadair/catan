// Temporary, local-only preview harness for iterating on Board.tsx visuals without touching
// Firebase at all. Wired in from main.tsx behind a query param; delete before shipping.
import type { JSX } from 'react';
import { generateBoard, initialFogRevealHexIds, GamePhase, RoomStatus } from '@catan/engine';
import Board from './components/Board';
import type { RoomState, PublicPlayer, MapPresetId } from '@catan/engine';
import {
  PLAYER_COLORS,
  DEFAULT_VICTORY_POINTS_TO_WIN,
  DEFAULT_DISCARD_LIMIT,
  DEFAULT_TURN_TIMER_SECONDS,
  DEFAULT_TRADE_RESPONSE_TIMER_SECONDS,
} from '@catan/engine';
import './routes/Game.css';

export default function DevPreview(): JSX.Element {
  // ?preview=board&map=fog-of-war (etc.) to preview a specific preset; defaults to
  // official-beginner. Not meant to cover every param combo, just quick visual iteration.
  const mapPreset = (new URLSearchParams(window.location.search).get('map') as MapPresetId | null) ?? 'official-beginner';
  const board = generateBoard(mapPreset, 'preview-seed');

  const room: RoomState = {
    id: 'preview',
    code: 'PREVW',
    hostUid: 'p0',
    status: RoomStatus.Playing,
    mapPreset,
    seed: 'preview-seed',
    board,
    vertices: {},
    edges: {},
    turnOrder: ['p0', 'p1'],
    currentPlayerIndex: 0,
    phase: GamePhase.Main,
    diceRoll: null,
    bank: { brick: 19, lumber: 19, ore: 19, grain: 19, wool: 19 },
    devCardDeck: [],
    devCardDeckCount: 0,
    longestRoadUid: null,
    largestArmyUid: null,
    winnerUid: null,
    turnNumber: 1,
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
    discoveredHexIds: mapPreset === 'fog-of-war' ? initialFogRevealHexIds(board.hexes) : null,
    pendingGoldPicks: [],
  };

  const players: Record<string, PublicPlayer> = {
    p0: {
      uid: 'p0',
      displayName: 'You',
      color: PLAYER_COLORS[0],
      isBot: false,
      seatIndex: 0,
      resourceCount: 0,
      devCardCount: 0,
      visibleVictoryPoints: 0,
      knightsPlayed: 0,
      roadsBuilt: 0,
      settlementsBuilt: 0,
      citiesBuilt: 0,
      connected: true,
      lastSeen: Date.now(),
    },
  };

  const vertexIds = Object.keys(board.vertices);
  room.vertices[vertexIds[3]] = { type: 'settlement', uid: 'p0' };
  room.vertices[vertexIds[10]] = { type: 'city', uid: 'p0' };
  const edgeIds = Object.keys(board.edges);
  room.edges[edgeIds[5]] = 'p0';
  room.edges[edgeIds[6]] = 'p0';

  return (
    <div style={{ width: '100vw', height: '100vh' }} className="game">
      <div className="game__board-area">
        <Board room={room} players={players} uid="p0" interactionMode="none" />
      </div>
      <aside className="game__sidebar">
        <div style={{ background: 'var(--color-panel)', padding: 12, borderRadius: 8 }}>Sidebar placeholder</div>
      </aside>
      <footer className="game__toolbar">
        <div>Toolbar placeholder</div>
      </footer>
    </div>
  );
}
