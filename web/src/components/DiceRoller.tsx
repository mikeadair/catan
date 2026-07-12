import type { JSX } from 'react';
import { DIE_FACE_ICON } from './diceIcons';
import './DiceRoller.css';

export interface DiceRollerProps {
  diceRoll: [number, number] | null;
  canRoll: boolean;
  isCurrentPlayer: boolean;
  isPending: boolean;
  onRoll: () => void;
}

export default function DiceRoller({ diceRoll, canRoll, isCurrentPlayer, isPending, onRoll }: DiceRollerProps): JSX.Element {
  const disabledReason = canRoll ? undefined : !isCurrentPlayer ? 'Not your turn' : 'Already rolled this turn';
  const faces: [1 | 2 | 3 | 4 | 5 | 6, 1 | 2 | 3 | 4 | 5 | 6] = diceRoll
    ? (diceRoll as [1 | 2 | 3 | 4 | 5 | 6, 1 | 2 | 3 | 4 | 5 | 6])
    : [1, 1];

  return (
    <button
      type="button"
      className={`dice-roller${canRoll && !isPending ? ' dice-roller--ready' : ''}${isPending ? ' dice-roller--rolling' : ''}`}
      onClick={onRoll}
      disabled={!canRoll || isPending}
      title={isPending ? 'Rolling…' : (disabledReason ?? 'Roll the dice')}
    >
      <span className="dice-roller__dice">
        <img src={DIE_FACE_ICON[faces[0]]} alt="" className="dice-roller__die" />
        <img src={DIE_FACE_ICON[faces[1]]} alt="" className="dice-roller__die" />
      </span>
      <span className="dice-roller__caption">
        {isPending ? 'Rolling…' : diceRoll ? diceRoll[0] + diceRoll[1] : 'Roll'}
      </span>
    </button>
  );
}
