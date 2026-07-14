import { useEffect, useState, type JSX } from 'react';
import { PauseIcon } from './gameIcons';
import './TurnTimer.css';

export interface TurnTimerProps {
  turnStartedAt: number;
  turnTimerSeconds: number | null;
  paused: boolean;
  /** Date.now() when `paused` flipped true — used to freeze the displayed remaining time
   * at exactly what it was the instant the game paused, instead of continuing to count
   * down a clock the server has actually stopped enforcing. */
  pausedAt: number | null;
  /** Tooltip/aria label prefix — defaults to "Turn timer", but this same countdown display
   * is reused for other server-enforced clocks (e.g. DiscardModal's discard timer). */
  label?: string;
}

/** Countdown display for a server-enforced clock (turn timer via 'timeoutEndTurn', discard
 * timer via 'timeoutDiscard' — see rules.ts); frozen while the game is paused. Despite the
 * prop names (kept from this component's original turn-timer-only use), it works for any
 * "started at X, expires after N seconds" clock. */
export default function TurnTimer({
  turnStartedAt,
  turnTimerSeconds,
  paused,
  pausedAt,
  label = 'Turn timer',
}: TurnTimerProps): JSX.Element | null {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (turnTimerSeconds === null || paused) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [turnTimerSeconds, paused]);

  if (turnTimerSeconds === null) return null;

  const clockNow = paused && pausedAt !== null ? pausedAt : now;
  const elapsed = Math.floor((clockNow - turnStartedAt) / 1000);
  const remaining = Math.max(0, turnTimerSeconds - elapsed);
  const minutes = Math.floor(remaining / 60);
  const seconds = remaining % 60;
  const low = remaining <= 10;

  return (
    <div
      className={`turn-timer${low ? ' turn-timer--low' : ''}${paused ? ' turn-timer--paused' : ''}`}
      title={paused ? `${label} (paused)` : label}
    >
      {paused && <PauseIcon className="turn-timer__icon" />}
      {minutes}:{seconds.toString().padStart(2, '0')}
    </div>
  );
}
