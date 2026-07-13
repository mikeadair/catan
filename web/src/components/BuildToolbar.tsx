import type { JSX } from 'react';
import { BUILD_COSTS, type GameAction, type ResourceCount } from '@catan/engine';
import { RESOURCE_ICON, RESOURCE_LABEL } from './resourceIcons';
import { CityIcon, DevCardIcon, RoadIcon, SettlementIcon } from './gameIcons';
import './BuildToolbar.css';

function CostChips({ cost, resources }: { cost: Partial<ResourceCount>; resources: ResourceCount }): JSX.Element {
  return (
    <span className="build-toolbar__cost">
      {(Object.keys(cost) as (keyof ResourceCount)[]).map((r) => {
        const have = resources[r] >= (cost[r] ?? 0);
        return (
          <span
            key={r}
            className={`build-toolbar__cost-chip${have ? '' : ' build-toolbar__cost-chip--short'}`}
            title={`${RESOURCE_LABEL[r]}: have ${resources[r]}, need ${cost[r]}`}
          >
            <img src={RESOURCE_ICON[r]} alt={RESOURCE_LABEL[r]} className="build-toolbar__cost-icon" />
            {cost[r]}
          </span>
        );
      })}
    </span>
  );
}

export type BuildMode = 'road' | 'settlement' | 'city' | null;

export interface BuildToolbarProps {
  resources: ResourceCount;
  legalTypes: GameAction['type'][];
  activeMode: BuildMode;
  devCardsRemaining: number;
  isCurrentPlayer: boolean;
  /** Pieces the local player still has left to place — shown as a badge next to the
   * matching build button instead of in the player roster. */
  piecesLeft: { roads: number; settlements: number; cities: number };
  /** Action type currently in flight (a real network round-trip), or null. Blocks starting
   * a new action while one is already pending, and relabels the specific button involved. */
  pendingActionType: GameAction['type'] | null;
  onToggleMode: (mode: 'road' | 'settlement' | 'city') => void;
  onBuyDevCard: () => void;
  onEndTurn: () => void;
}

function canAfford(resources: ResourceCount, cost: Partial<ResourceCount>): boolean {
  return (Object.keys(cost) as (keyof ResourceCount)[]).every((r) => resources[r] >= (cost[r] ?? 0));
}

function costLabel(cost: Partial<ResourceCount>): string {
  return (Object.keys(cost) as (keyof ResourceCount)[])
    .map((r) => `${cost[r]} ${RESOURCE_LABEL[r].toLowerCase()}`)
    .join(', ');
}

/** Best-effort explanation for why a build/buy button is disabled — legalTypes already
 * bakes affordability into its check, so an unaffordable hand and "not your turn" both
 * just show up as "not in legalTypes"; disambiguate using what we can see client-side. */
function disabledReason(
  legal: boolean,
  isCurrentPlayer: boolean,
  afford: boolean,
  cost: Partial<ResourceCount>,
): string | undefined {
  if (legal) return undefined;
  if (!isCurrentPlayer) return 'Not your turn';
  if (!afford) return `Need ${costLabel(cost)}`;
  return 'Not available right now';
}

export default function BuildToolbar({
  resources,
  legalTypes,
  activeMode,
  devCardsRemaining,
  isCurrentPlayer,
  piecesLeft,
  pendingActionType,
  onToggleMode,
  onBuyDevCard,
  onEndTurn,
}: BuildToolbarProps): JSX.Element {
  const isPending = pendingActionType !== null;
  const affordRoad = canAfford(resources, BUILD_COSTS.road);
  const affordSettlement = canAfford(resources, BUILD_COSTS.settlement);
  const affordCity = canAfford(resources, BUILD_COSTS.city);
  const affordDevCard = canAfford(resources, BUILD_COSTS.devCard);

  const canRoad = legalTypes.includes('buildRoad') && affordRoad && !isPending;
  const canSettlement = legalTypes.includes('buildSettlement') && affordSettlement && !isPending;
  const canCity = legalTypes.includes('buildCity') && affordCity && !isPending;
  const canBuyDevCard = legalTypes.includes('buyDevCard') && affordDevCard && devCardsRemaining > 0 && !isPending;
  const canEndTurn = legalTypes.includes('endTurn') && !isPending;
  const isBuyingDevCard = pendingActionType === 'buyDevCard';
  const isEndingTurn = pendingActionType === 'endTurn';

  const devCardReason = isBuyingDevCard
    ? 'Buying…'
    : devCardsRemaining <= 0 && legalTypes.includes('buyDevCard')
      ? 'No development cards left in the deck'
      : disabledReason(canBuyDevCard, isCurrentPlayer, affordDevCard, BUILD_COSTS.devCard);

  return (
    <div className="build-toolbar">
      <button
        type="button"
        className={`build-toolbar__button${activeMode === 'road' ? ' build-toolbar__button--active' : ''}`}
        disabled={!canRoad}
        title={isPending ? 'Waiting for previous action…' : disabledReason(canRoad, isCurrentPlayer, affordRoad, BUILD_COSTS.road)}
        onClick={() => onToggleMode('road')}
      >
        <RoadIcon className="build-toolbar__icon" />
        <span className="build-toolbar__label">Road</span>
        <CostChips cost={BUILD_COSTS.road} resources={resources} />
        <span className="build-toolbar__left">{piecesLeft.roads} left</span>
      </button>
      <button
        type="button"
        className={`build-toolbar__button${activeMode === 'settlement' ? ' build-toolbar__button--active' : ''}`}
        disabled={!canSettlement}
        title={isPending ? 'Waiting for previous action…' : disabledReason(canSettlement, isCurrentPlayer, affordSettlement, BUILD_COSTS.settlement)}
        onClick={() => onToggleMode('settlement')}
      >
        <SettlementIcon className="build-toolbar__icon" />
        <span className="build-toolbar__label">Settlement</span>
        <CostChips cost={BUILD_COSTS.settlement} resources={resources} />
        <span className="build-toolbar__left">{piecesLeft.settlements} left</span>
      </button>
      <button
        type="button"
        className={`build-toolbar__button${activeMode === 'city' ? ' build-toolbar__button--active' : ''}`}
        disabled={!canCity}
        title={isPending ? 'Waiting for previous action…' : disabledReason(canCity, isCurrentPlayer, affordCity, BUILD_COSTS.city)}
        onClick={() => onToggleMode('city')}
      >
        <CityIcon className="build-toolbar__icon" />
        <span className="build-toolbar__label">City</span>
        <CostChips cost={BUILD_COSTS.city} resources={resources} />
        <span className="build-toolbar__left">{piecesLeft.cities} left</span>
      </button>
      <button
        type="button"
        className="build-toolbar__button"
        disabled={!canBuyDevCard}
        title={devCardReason}
        onClick={onBuyDevCard}
      >
        <DevCardIcon className="build-toolbar__icon" />
        <span className="build-toolbar__label">{isBuyingDevCard ? 'Buying…' : 'Dev Card'}</span>
        <CostChips cost={BUILD_COSTS.devCard} resources={resources} />
        <span className="build-toolbar__left">{devCardsRemaining} left</span>
      </button>
      <button
        type="button"
        className="build-toolbar__button build-toolbar__button--end-turn"
        disabled={!canEndTurn}
        title={isEndingTurn ? 'Ending turn…' : canEndTurn ? undefined : !isCurrentPlayer ? 'Not your turn' : 'Roll the dice first'}
        onClick={onEndTurn}
      >
        {isEndingTurn ? 'Ending…' : 'End Turn'}
      </button>
    </div>
  );
}
