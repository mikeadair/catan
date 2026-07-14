import type { JSX } from 'react';
import type { DevCard, DevCardType } from '@catan/engine';
import { KnightIcon, MonopolyIcon, RoadBuildingIcon, VictoryPointIcon, YearOfPlentyIcon } from './gameIcons';
import './DevCardPanel.css';

const CARD_LABEL: Record<DevCardType, string> = {
  knight: 'Knight',
  roadBuilding: 'Road Building',
  yearOfPlenty: 'Year of Plenty',
  monopoly: 'Monopoly',
  victoryPoint: 'Victory Point',
};

// Was raw emoji (⚔️ 🛤️ 🌾 💰 🏆) — inconsistent rendering across platforms/fonts (and outright
// missing/tofu glyphs in some environments, this repo's own CI runner among them) — swapped
// for the app's existing custom SVG icon set (gameIcons.tsx), already used correctly elsewhere
// (e.g. PlayerRoster's knights-played stat).
const CARD_ICON: Record<DevCardType, (props: { className?: string }) => JSX.Element> = {
  knight: KnightIcon,
  roadBuilding: RoadBuildingIcon,
  yearOfPlenty: YearOfPlentyIcon,
  monopoly: MonopolyIcon,
  victoryPoint: VictoryPointIcon,
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

/** One button-card per owned dev-card *type* (not per copy) — same compact icon/label shell as
 * BuildToolbar's buttons, so a hand's worth of playable cards reads as part of the same "things
 * you can do right now" row instead of a separately-framed panel with its own inline rules text
 * (previously this could run to ~500px wide for even a single card). The rules text hasn't gone
 * away, just moved to the card's hover title — see the description/disabledReason `title`s below. */
export default function DevCardPanel({ devCards, turnNumber, canPlayAny, blocked, onPlay }: DevCardPanelProps): JSX.Element | null {
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
  if (nonEmpty.length === 0) return null;

  return (
    <div className="dev-card-panel">
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
        const Icon = CARD_ICON[type];
        return (
          <div key={type} className="dev-card-panel__card" title={CARD_DESCRIPTION[type]}>
            <Icon className="dev-card-panel__icon-svg" />
            <span className="dev-card-panel__name">{CARD_LABEL[type]}</span>
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
  );
}
