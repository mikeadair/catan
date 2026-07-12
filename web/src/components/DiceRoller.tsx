import type { JSX } from 'react';
import './DiceRoller.css';

const DIE_FACE = ['', '⚀', '⚁', '⚂', '⚃', '⚄', '⚅'];

export interface DiceRollerProps {
  diceRoll: [number, number] | null;
  canRoll: boolean;
  isCurrentPlayer: boolean;
  onRoll: () => void;
}

export default function DiceRoller({ diceRoll, canRoll, isCurrentPlayer, onRoll }: DiceRollerProps): JSX.Element {
  const disabledReason = canRoll ? undefined : !isCurrentPlayer ? 'Not your turn' : 'Already rolled this turn';
  return (
    <div className="dice-roller">
      <div className="dice-roller__dice">
        <span className="dice-roller__die">{diceRoll ? DIE_FACE[diceRoll[0]] : '⚀'}</span>
        <span className="dice-roller__die">{diceRoll ? DIE_FACE[diceRoll[1]] : '⚀'}</span>
      </div>
      {diceRoll && <div className="dice-roller__total">{diceRoll[0] + diceRoll[1]}</div>}
      <button
        type="button"
        className="dice-roller__button"
        onClick={onRoll}
        disabled={!canRoll}
        title={disabledReason}
      >
        Roll
      </button>
    </div>
  );
}
