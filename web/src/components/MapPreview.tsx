// A small, non-interactive board rendering for the lobby's map picker — illustrative only
// (a fixed preview seed, not the real game's board, which is generated fresh server-side by
// startGame). Reuses the real Board component so the preview always matches what actually
// renders in-game.
import { useMemo, type JSX } from 'react';
import { generateBoard, initialFogRevealHexIds, type MapPresetId, type RoomState } from '@catan/engine';
import Board from './Board';
import './MapPreview.css';

export interface MapPreviewProps {
  mapPreset: MapPresetId;
  /** 'thumbnail' renders a small, fixed-height card suitable for a picker grid. */
  variant?: 'full' | 'thumbnail';
}

export default function MapPreview({ mapPreset, variant = 'full' }: MapPreviewProps): JSX.Element {
  const room = useMemo<RoomState>(() => {
    const board = generateBoard(mapPreset, `lobby-preview:${mapPreset}`);
    return {
      id: 'preview',
      code: '',
      hostUid: '',
      status: 'lobby',
      mapPreset,
      seed: '',
      board,
      vertices: {},
      edges: {},
      turnOrder: [],
      currentPlayerIndex: 0,
      phase: 'lobby',
      diceRoll: null,
      devCardDeck: [],
      devCardDeckCount: 0,
      bank: { brick: 19, lumber: 19, ore: 19, grain: 19, wool: 19 },
      longestRoadUid: null,
      largestArmyUid: null,
      winnerUid: null,
      turnNumber: 0,
      turnStartedAt: 0,
      setupRound: null,
      pendingDiscardUids: [],
      discardPhaseStartedAt: null,
      robberPhaseStartedAt: null,
      setupTurnStartedAt: null,
      botActionClaim: null,
      log: [],
      createdAt: 0,
      victoryPointsToWin: 10,
      discardLimit: 7,
      turnTimerSeconds: null,
      safeMode: false,
      paused: false,
      pausedAt: null,
      pauseVotes: [],
      discoveredHexIds: mapPreset === 'fog-of-war' ? initialFogRevealHexIds(board.hexes) : null,
      pendingGoldPicks: [],
    };
  }, [mapPreset]);

  return (
    <div className={`map-preview${variant === 'thumbnail' ? ' map-preview--thumbnail' : ''}`}>
      <Board room={room} players={{}} uid={null} interactionMode="none" />
    </div>
  );
}
