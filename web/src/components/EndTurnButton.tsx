import type { JSX } from 'react';
import type { GameAction } from '@catan/engine';
import './EndTurnButton.css';

export interface EndTurnButtonProps {
  legalTypes: GameAction['type'][];
  isCurrentPlayer: boolean;
  pendingActionType: GameAction['type'] | null;
  onEndTurn: () => void;
}

export default function EndTurnButton({ legalTypes, isCurrentPlayer, pendingActionType, onEndTurn }: EndTurnButtonProps): JSX.Element {
  const isPending = pendingActionType !== null;
  const canEndTurn = legalTypes.includes('endTurn') && !isPending;
  const isEndingTurn = pendingActionType === 'endTurn';

  return (
    <button
      type="button"
      className="end-turn-button"
      disabled={!canEndTurn}
      title={isEndingTurn ? 'Ending turn…' : canEndTurn ? undefined : !isCurrentPlayer ? 'Not your turn' : 'Roll the dice first'}
      onClick={onEndTurn}
    >
      {isEndingTurn ? 'Ending…' : 'End Turn'}
    </button>
  );
}
