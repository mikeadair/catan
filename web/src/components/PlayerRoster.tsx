import type { CSSProperties, JSX } from 'react';
import type { PrivateHand, PublicPlayer } from '@catan/engine';
import { PLAYER_COLOR_HEX } from './playerColors';
import {
  KnightIcon,
  LargestArmyIcon,
  LongestRoadIcon,
  ResourceCardsIcon,
  DevCardIcon,
  RoadIcon,
  VictoryPointIcon,
  BlockTradeIcon,
} from './gameIcons';
import './PlayerRoster.css';

export interface PlayerRosterProps {
  players: Record<string, PublicPlayer>;
  turnOrder: string[];
  currentUid: string | null;
  localUid: string | null;
  longestRoadUid: string | null;
  largestArmyUid: string | null;
  ownHand: PrivateHand | null;
  victoryPointsToWin: number;
  /** Per-player current longest road *chain* length (not piece count) — computed by the
   * caller from public board state via the engine's longestRoadForPlayer. */
  longestRoadLengths: Record<string, number>;
  /** Toggles blockAllTrades for the local player — refuses every player-to-player trade
   * (bank trades unaffected) until switched off again. */
  onToggleBlockAllTrades: () => void;
  /** Toggles whether `targetUid` is in the local player's blockedTradeUids. */
  onToggleBlockPlayer: (targetUid: string) => void;
}

export default function PlayerRoster({
  players,
  turnOrder,
  currentUid,
  localUid,
  longestRoadUid,
  largestArmyUid,
  ownHand,
  victoryPointsToWin,
  longestRoadLengths,
  onToggleBlockAllTrades,
  onToggleBlockPlayer,
}: PlayerRosterProps): JSX.Element {
  const hiddenVp = ownHand ? ownHand.devCards.filter((c) => c.type === 'victoryPoint').length : 0;
  const localPlayer = localUid ? players[localUid] : null;
  const blockAllTrades = localPlayer?.blockAllTrades ?? false;
  const blockedTradeUids = localPlayer?.blockedTradeUids ?? [];

  return (
    <div className="player-roster">
      <div className="player-roster__header">
        Players
        <div className="player-roster__header-right">
          {/* The win condition is a lobby setting guests may never have seen — surfacing it here
              keeps "how close is everyone?" answerable from the roster alone. */}
          <span className="player-roster__win-target" title={`First player to ${victoryPointsToWin} victory points wins`}>
            first to {victoryPointsToWin} <VictoryPointIcon className="player-roster__win-target-icon" />
          </span>
          {localPlayer && (
            <button
              type="button"
              className={`player-roster__block-all${blockAllTrades ? ' player-roster__block-all--active' : ''}`}
              onClick={onToggleBlockAllTrades}
              title={blockAllTrades ? 'Trades from other players are blocked — click to allow them again' : 'Block all player-to-player trades (bank trades still work)'}
              aria-pressed={blockAllTrades}
            >
              <BlockTradeIcon className="player-roster__block-all-icon" />
              {blockAllTrades ? 'Trades blocked' : 'Block all trades'}
            </button>
          )}
        </div>
      </div>
      <ul className="player-roster__list">
        {turnOrder.map((uid) => {
          const p = players[uid];
          if (!p) return null;
          const isTurn = uid === currentUid;
          const isYou = uid === localUid;
          const color = PLAYER_COLOR_HEX[p.color];
          const vpTotal = p.visibleVictoryPoints + (isYou ? hiddenVp : 0);
          const rowStyle = { '--player-color': color } as CSSProperties;
          return (
            <li
              key={uid}
              className={`player-roster__row${isTurn ? ' player-roster__row--active' : ''}${
                isYou ? ' player-roster__row--you' : ''
              }${p.connected ? '' : ' player-roster__row--disconnected'}`}
              style={rowStyle}
            >
              <div className="player-roster__avatar-col">
                <div className="player-roster__avatar" title={p.displayName}>
                  <span className="player-roster__avatar-initial">{p.displayName.trim().charAt(0).toUpperCase() || '?'}</span>
                </div>
                <div className="player-roster__vp-ribbon" title="Victory points">
                  <VictoryPointIcon className="player-roster__vp-ribbon-icon" />
                  <span>{vpTotal}</span>
                </div>
              </div>

              <div className="player-roster__body">
                <div className="player-roster__name-row">
                  <span className="player-roster__name">{p.displayName}</span>
                  {p.isBot && <span className="player-roster__badge">bot</span>}
                  {isYou && <span className="player-roster__badge player-roster__badge--you">you</span>}
                  {!p.connected && <span className="player-roster__badge player-roster__badge--offline">offline</span>}
                  {!isYou && (
                    <button
                      type="button"
                      className={`player-roster__block-player${blockedTradeUids.includes(uid) ? ' player-roster__block-player--active' : ''}`}
                      onClick={() => onToggleBlockPlayer(uid)}
                      disabled={blockAllTrades}
                      title={
                        blockAllTrades
                          ? 'All trades are already blocked'
                          : blockedTradeUids.includes(uid)
                            ? `Trades with ${p.displayName} are blocked — click to allow them again`
                            : `Block trades with ${p.displayName}`
                      }
                      aria-pressed={blockedTradeUids.includes(uid)}
                    >
                      <BlockTradeIcon className="player-roster__block-player-icon" />
                    </button>
                  )}
                </div>

                <div className="player-roster__cards-row">
                  <div className="player-roster__card-badge player-roster__card-badge--resource" title="Resource cards in hand">
                    <ResourceCardsIcon className="player-roster__card-badge-icon" />
                    <span className="player-roster__card-badge-count">{p.resourceCount}</span>
                  </div>
                  <div className="player-roster__card-badge player-roster__card-badge--dev" title="Development cards in hand">
                    <DevCardIcon className="player-roster__card-badge-icon" />
                    <span className="player-roster__card-badge-count">{p.devCardCount}</span>
                  </div>

                  <div className="player-roster__mini-stats">
                    <span className="player-roster__mini-stat" title="Knights played">
                      <KnightIcon className="player-roster__mini-stat-icon" />
                      {p.knightsPlayed}
                      {largestArmyUid === uid && (
                        <LargestArmyIcon className="player-roster__award-icon" aria-label="Largest Army" />
                      )}
                    </span>
                    <span
                      className="player-roster__mini-stat"
                      title={`Longest road chain: ${longestRoadLengths[uid] ?? 0} (award at 5+) — ${p.roadsBuilt} road piece${p.roadsBuilt === 1 ? '' : 's'} built`}
                    >
                      <RoadIcon className="player-roster__mini-stat-icon" />
                      {longestRoadLengths[uid] ?? 0}
                      {longestRoadUid === uid && (
                        <LongestRoadIcon className="player-roster__award-icon" aria-label="Longest Road" />
                      )}
                    </span>
                  </div>
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
