import type { JSX } from 'react';
import type { PrivateHand, PublicPlayer } from '../game/types';
import { PLAYER_COLOR_HEX } from './playerColors';
import './PlayerRoster.css';

export interface PlayerRosterProps {
  players: Record<string, PublicPlayer>;
  turnOrder: string[];
  currentUid: string | null;
  localUid: string | null;
  longestRoadUid: string | null;
  largestArmyUid: string | null;
  ownHand: PrivateHand | null;
}

export default function PlayerRoster({
  players,
  turnOrder,
  currentUid,
  localUid,
  longestRoadUid,
  largestArmyUid,
  ownHand,
}: PlayerRosterProps): JSX.Element {
  const hiddenVp = ownHand ? ownHand.devCards.filter((c) => c.type === 'victoryPoint').length : 0;

  return (
    <div className="player-roster">
      <div className="player-roster__header">Players</div>
      <ul className="player-roster__list">
        {turnOrder.map((uid) => {
          const p = players[uid];
          if (!p) return null;
          const isTurn = uid === currentUid;
          const isYou = uid === localUid;
          return (
            <li
              key={uid}
              className={`player-roster__row${isTurn ? ' player-roster__row--active' : ''}${
                p.connected ? '' : ' player-roster__row--disconnected'
              }`}
            >
              <span className="player-roster__swatch" style={{ background: PLAYER_COLOR_HEX[p.color] }} />
              <div className="player-roster__info">
                <div className="player-roster__name-row">
                  <span className="player-roster__name">{p.displayName}</span>
                  {p.isBot && <span className="player-roster__badge">bot</span>}
                  {isYou && <span className="player-roster__badge player-roster__badge--you">you</span>}
                  {!p.connected && <span className="player-roster__badge player-roster__badge--offline">offline</span>}
                </div>
                <div className="player-roster__stats">
                  <span className="player-roster__stat" title="Resource cards">
                    🂠 {p.resourceCount}
                  </span>
                  <span className="player-roster__stat" title="Development cards">
                    🃏 {p.devCardCount}
                  </span>
                  <span className="player-roster__stat" title="Victory points">
                    🏆 {p.visibleVictoryPoints}
                    {isYou && hiddenVp > 0 ? ` (+${hiddenVp} hidden)` : ''}
                  </span>
                  <span className="player-roster__stat" title="Knights played">
                    ⚔️ {p.knightsPlayed}
                    {largestArmyUid === uid && <span className="player-roster__icon-badge" title="Largest Army">🎖️</span>}
                  </span>
                  <span className="player-roster__stat" title="Roads built">
                    🛤️ {p.roadsBuilt}
                    {longestRoadUid === uid && <span className="player-roster__icon-badge" title="Longest Road">🏅</span>}
                  </span>
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
