import type { CSSProperties, JSX } from 'react';
import type { LogEntry, PrivateHand, PublicPlayer } from '@catan/engine';
import { RESOURCES } from '@catan/engine';
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
  log: LogEntry[];
}

/** Per-player total resources collected over the game plus a couple of table-wide totals,
 * folded client-side from the log's structured metas — nothing here needs engine support. */
function summarizeLog(log: LogEntry[]): { gainedBy: Record<string, number>; turns: number; hotSum: number | null } {
  const gainedBy: Record<string, number> = {};
  const sumCounts: Record<number, number> = {};
  let turns = 0;
  const addGains = (uid: string, resources: Partial<Record<(typeof RESOURCES)[number], number>>) => {
    gainedBy[uid] = (gainedBy[uid] ?? 0) + RESOURCES.reduce((s, r) => s + (resources[r] ?? 0), 0);
  };
  for (const entry of log) {
    const meta = entry.meta;
    if (!meta) continue;
    if (meta.kind === 'diceRoll') {
      turns++;
      const sum = meta.roll[0] + meta.roll[1];
      sumCounts[sum] = (sumCounts[sum] ?? 0) + 1;
      if (meta.gains) for (const [uid, resources] of Object.entries(meta.gains)) addGains(uid, resources);
    } else if (meta.kind === 'resourceGain') {
      addGains(meta.uid, meta.resources);
    }
  }
  let hotSum: number | null = null;
  for (const [sum, count] of Object.entries(sumCounts)) {
    if (hotSum === null || count > (sumCounts[hotSum] ?? 0)) hotSum = Number(sum);
  }
  return { gainedBy, turns, hotSum };
}

export default function GameOverStandings({
  players,
  turnOrder,
  localUid,
  longestRoadUid,
  largestArmyUid,
  ownHand,
  log,
}: GameOverStandingsProps): JSX.Element {
  const hiddenVp = ownHand ? ownHand.devCards.filter((c) => c.type === 'victoryPoint').length : 0;
  const { gainedBy, turns, hotSum } = summarizeLog(log);

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
                <span className="game-over-standings__stat" title="Total resources collected this game">
                  <ResourceCardsIcon className="game-over-standings__stat-icon game-over-standings__stat-icon--gained" />
                  +{gainedBy[p.uid] ?? 0}
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
      {turns > 0 && (
        <li className="game-over-standings__game-stats" aria-label="Game statistics">
          {turns} turns played{hotSum !== null ? ` — ${hotSum} was the most-rolled number` : ''}
        </li>
      )}
    </ol>
  );
}
