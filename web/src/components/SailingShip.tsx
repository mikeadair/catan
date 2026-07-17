// Shared decorative sailing ship — purely cosmetic, no game state. Originally lived only on
// the home screen (Home.tsx); factored out so the in-game ocean (Game.tsx's board area, by far
// the largest expanse of open water visible for an entire match) can reuse the same asset and
// animation instead of sitting flat the whole game. The wrapping layer's own position/inset/
// z-index is owned by the caller (each screen already has its own layout concerns there) — this
// component only owns the ship image, its randomized path, and its animation.
import { useState, type CSSProperties, type JSX } from 'react';
import shipIcon from '../assets/decor/ship.png';
import './SailingShip.css';

export interface SailingShipProps {
  /** Class name for the positioned wrapper layer (e.g. 'home__ship-layer') — defines where
   * the ship's containing block sits (fixed to the viewport, absolute within a board area,
   * ...). This component only styles the <img> itself. */
  layerClassName: string;
  /** [min, max] % from the top of the layer the ship's path is randomized within. */
  topRange?: [number, number];
}

export default function SailingShip({ layerClassName, topRange = [6, 20] }: SailingShipProps): JSX.Element {
  // Randomized once per mount so it doesn't look identical on every visit/game.
  const [config] = useState(() => {
    const duration = 32 + Math.random() * 22; // seconds for a full crossing
    const [minTop, maxTop] = topRange;
    return {
      top: minTop + Math.random() * (maxTop - minTop),
      duration,
      // Negative delay starts the animation partway through its cycle so the ship doesn't
      // always begin at the edge on load.
      delay: -(Math.random() * duration),
    };
  });

  return (
    <div className={layerClassName} aria-hidden="true">
      <img
        src={shipIcon}
        className="sailing-ship"
        alt=""
        style={
          {
            top: `${config.top}%`,
            // Comma-separated: first value targets the "sail" (travel) keyframes, second
            // targets the constant "bob" (wobble) ones — matches the animation-name order in
            // SailingShip.css.
            animationDuration: `${config.duration}s, 3.6s`,
            animationDelay: `${config.delay}s, 0s`,
          } as CSSProperties
        }
      />
    </div>
  );
}
