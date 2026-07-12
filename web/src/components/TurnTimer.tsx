import { useEffect, useState, type JSX } from 'react';
import './TurnTimer.css';

export interface TurnTimerProps {
  turnStartedAt: number;
  turnTimerSeconds: number | null;
}

/** Informational countdown only — nothing auto-ends the turn when it hits 0. */
export default function TurnTimer({ turnStartedAt, turnTimerSeconds }: TurnTimerProps): JSX.Element | null {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (turnTimerSeconds === null) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [turnTimerSeconds]);

  if (turnTimerSeconds === null) return null;

  const elapsed = Math.floor((now - turnStartedAt) / 1000);
  const remaining = Math.max(0, turnTimerSeconds - elapsed);
  const minutes = Math.floor(remaining / 60);
  const seconds = remaining % 60;
  const low = remaining <= 10;

  return (
    <div className={`turn-timer${low ? ' turn-timer--low' : ''}`} title="Turn timer (informational — not enforced)">
      {minutes}:{seconds.toString().padStart(2, '0')}
    </div>
  );
}
