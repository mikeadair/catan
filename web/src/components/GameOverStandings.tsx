import type { CSSProperties, JSX } from 'react';
import type { PrivateHand, PublicPlayer } from '@catan/engine';
import { PLAYER_COLOR_HEX } from './playerColors';
import { KnightIcon, LargestArmyIcon, LongestRoadIcon, ResourceCardsIcon, DevCardIcon, RoadIcon, VictoryPointIcon } from './gameIcons';
import './GameOverStandings.css';

export interface GameOverStandingsProps {
  players: Record<string, PublicPlayer>;
  turnOrder: string[];
  localUid: string;
  longestRoadUid: string | null;
  largestArmyUid: string | null;
  ownHand: PrivateHand | null;
}

export default function GameOverStandings({
  players,
  turnOrder,
  localUid,
  longestRoadUid,
  largestArmyUid,
  ownHand,
}: GameOverStandingsProps): JSX.Element {
  const hiddenVp = ownHand ? ownHand.devCards.filter((c) => c.type === 'victoryPoint').length : 0;

  const ranked = turnOrder
    .map((uid) => players[uid])
    .filter((p): p is PublicPlayer => !!p)
    .map((p) => ({ player: p, vpTotal: p.visibleVictoryPoints + (p.uid === localUid ? hiddenVp : 0) }))
    .sort((a, b) => b.vpTotal - a.vpTotal);

  return (
    <ol className="game-over-standings">
      {ranked.map(({ player: p, vpTotal }, i) => {
        const isYou = p.uid === localUid;
        const color = PLAYER_COLOR_HEX[p.color];
        const rowStyle = { '--player-color': color } as CSSProperties;
        return (
          <li
            key={p.uid}
            className={`game-over-standings__row${i === 0 ? ' game-over-standings__row--winner' : ''}${
              isYou ? ' game-over-standings__row--you' : ''
            }`}
            style={rowStyle}
          >
            <span className="game-over-standings__rank">{i + 1}</span>
            <div className="game-over-standings__avatar" title={p.displayName}>
              <span className="game-over-standings__avatar-initial">{p.displayName.trim().charAt(0).toUpperCase() || '?'}</span>
            </div>
            <div className="game-over-standings__body">
              <div className="game-over-standings__name-row">
                <span className="game-over-standings__name">{p.displayName}</span>
                {p.isBot && <span className="game-over-standings__badge">bot</span>}
                {isYou && <span className="game-over-standings__badge game-over-standings__badge--you">you</span>}
              </div>
              <div className="game-over-standings__stats">
                <span className="game-over-standings__stat" title="Resource cards in hand">
                  <ResourceCardsIcon className="game-over-standings__stat-icon" />
                  {p.resourceCount}
                </span>
                <span className="game-over-standings__stat" title="Development cards in hand">
                  <DevCardIcon className="game-over-standings__stat-icon" />
                  {p.devCardCount}
                </span>
                <span className="game-over-standings__stat" title="Knights played">
                  <KnightIcon className="game-over-standings__stat-icon" />
                  {p.knightsPlayed}
                  {largestArmyUid === p.uid && (
                    <LargestArmyIcon className="game-over-standings__award-icon" aria-label="Largest Army" />
                  )}
                </span>
                <span className="game-over-standings__stat" title="Roads built">
                  <RoadIcon className="game-over-standings__stat-icon" />
                  {p.roadsBuilt}
                  {longestRoadUid === p.uid && (
                    <LongestRoadIcon className="game-over-standings__award-icon" aria-label="Longest Road" />
                  )}
                </span>
              </div>
            </div>
            <div className="game-over-standings__vp" title="Victory points">
              <VictoryPointIcon className="game-over-standings__vp-icon" />
              <span>{vpTotal}</span>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
