// A one-shot celebratory burst for the local player's own win — see Game.tsx's game-over
// screen. Purely decorative (aria-hidden) and deterministic (index-based placement, not
// Math.random()) so repeated renders — including the snap-screenshot harness — stay stable.
// prefers-reduced-motion is handled in CSS (ConfettiBurst.css hides the whole layer rather than
// freezing pieces mid-fall, since a static scatter of dots conveys nothing on its own).
import type { CSSProperties, JSX } from 'react';
import { PLAYER_COLORS, type PlayerColor } from '@catan/engine';
import { PLAYER_COLOR_HEX } from './playerColors';
import './ConfettiBurst.css';

const PIECE_COUNT = 24;

export default function ConfettiBurst(): JSX.Element {
  const pieces = Array.from({ length: PIECE_COUNT }, (_, i) => {
    const color: PlayerColor = PLAYER_COLORS[i % PLAYER_COLORS.length];
    const left = (i * 41) % 100;
    const delay = ((i * 137) % 900) / 1000;
    const duration = 1.6 + ((i * 53) % 700) / 1000;
    const rotate = (i * 77) % 360;
    const drift = ((i * 31) % 60) - 30;
    return { key: i, color, left, delay, duration, rotate, drift };
  });

  return (
    <div className="confetti-burst" aria-hidden="true">
      {pieces.map((p) => (
        <span
          key={p.key}
          className="confetti-burst__piece"
          style={
            {
              left: `${p.left}%`,
              '--confetti-color': PLAYER_COLOR_HEX[p.color],
              '--confetti-delay': `${p.delay}s`,
              '--confetti-duration': `${p.duration}s`,
              '--confetti-rotate': `${p.rotate}deg`,
              '--confetti-drift': `${p.drift}px`,
            } as CSSProperties
          }
        />
      ))}
    </div>
  );
}
