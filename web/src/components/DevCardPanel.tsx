import type { JSX } from 'react';
import type { DevCard, DevCardType } from '@catan/engine';
import './DevCardPanel.css';

const CARD_LABEL: Record<DevCardType, string> = {
  knight: 'Knight',
  roadBuilding: 'Road Building',
  yearOfPlenty: 'Year of Plenty',
  monopoly: 'Monopoly',
  victoryPoint: 'Victory Point',
};

const CARD_ICON: Record<DevCardType, string> = {
  knight: '⚔️',
  roadBuilding: '🛤️',
  yearOfPlenty: '🌾',
  monopoly: '💰',
  victoryPoint: '🏆',
};

const CARD_DESCRIPTION: Record<DevCardType, string> = {
  knight: 'Move the robber and steal a resource from an adjacent player.',
  roadBuilding: 'Build 2 roads for free.',
  yearOfPlenty: 'Take any 2 resources from the bank.',
  monopoly: 'Take all of one resource type from every other player.',
  victoryPoint: 'Worth 1 hidden victory point.',
};

const PLAYABLE_TYPES: Exclude<DevCardType, 'victoryPoint'>[] = ['knight', 'roadBuilding', 'yearOfPlenty', 'monopoly'];

export interface DevCardPanelProps {
  devCards: DevCard[];
  turnNumber: number;
  canPlayAny: boolean;
  /** True while a different action is already in flight — blocks playing another card. */
  blocked: boolean;
  onPlay: (type: Exclude<DevCardType, 'victoryPoint'>, devCardId: string) => void;
}

export default function DevCardPanel({ devCards, turnNumber, canPlayAny, blocked, onPlay }: DevCardPanelProps): JSX.Element {
  const grouped: Record<DevCardType, DevCard[]> = {
    knight: [],
    roadBuilding: [],
    yearOfPlenty: [],
    monopoly: [],
    victoryPoint: [],
  };
  for (const c of devCards) grouped[c.type].push(c);

  const order: DevCardType[] = ['knight', 'roadBuilding', 'yearOfPlenty', 'monopoly', 'victoryPoint'];
  const nonEmpty = order.filter((t) => grouped[t].length > 0);

  return (
    <div className="dev-card-panel">
      <div className="dev-card-panel__header">Development Cards</div>
      {nonEmpty.length === 0 && <div className="dev-card-panel__empty">No development cards yet.</div>}
      <div className="dev-card-panel__list">
        {nonEmpty.map((type) => {
          const cards = grouped[type];
          const isPlayable = PLAYABLE_TYPES.includes(type as Exclude<DevCardType, 'victoryPoint'>);
          const playableCard = isPlayable ? cards.find((c) => c.boughtTurn !== turnNumber) : undefined;
          const disabledReason = blocked
            ? 'Waiting for previous action…'
            : !canPlayAny
              ? 'Not your turn or already played a card this turn'
              : !playableCard
                ? 'Cannot play a card the same turn it was bought'
                : null;
          return (
            <div key={type} className="dev-card-panel__card">
              <span className="dev-card-panel__icon">{CARD_ICON[type]}</span>
              <div className="dev-card-panel__info">
                <span className="dev-card-panel__name">{CARD_LABEL[type]}</span>
                <span className="dev-card-panel__desc">{CARD_DESCRIPTION[type]}</span>
              </div>
              <span className="dev-card-panel__count">×{cards.length}</span>
              {isPlayable && (
                <button
                  type="button"
                  className="dev-card-panel__play"
                  disabled={!canPlayAny || !playableCard || blocked}
                  title={disabledReason ?? undefined}
                  onClick={() => playableCard && onPlay(type as Exclude<DevCardType, 'victoryPoint'>, playableCard.id)}
                >
                  Play
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
