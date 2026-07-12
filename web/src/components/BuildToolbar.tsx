import type { JSX } from 'react';
import type { GameAction, ResourceCount } from '../game/types';
import { BUILD_COSTS } from '../game/types';
import { RESOURCE_ICON, RESOURCE_LABEL } from './resourceIcons';
import './BuildToolbar.css';

function CostChips({ cost }: { cost: Partial<ResourceCount> }): JSX.Element {
  return (
    <span className="build-toolbar__cost">
      {(Object.keys(cost) as (keyof ResourceCount)[]).map((r) => (
        <span key={r} className="build-toolbar__cost-chip">
          <img src={RESOURCE_ICON[r]} alt={RESOURCE_LABEL[r]} className="build-toolbar__cost-icon" />
          {cost[r]}
        </span>
      ))}
    </span>
  );
}

export type BuildMode = 'road' | 'settlement' | 'city' | null;

export interface BuildToolbarProps {
  resources: ResourceCount;
  legalTypes: GameAction['type'][];
  activeMode: BuildMode;
  devCardsRemaining: number;
  onToggleMode: (mode: 'road' | 'settlement' | 'city') => void;
  onBuyDevCard: () => void;
  onEndTurn: () => void;
}

function canAfford(resources: ResourceCount, cost: Partial<ResourceCount>): boolean {
  return (Object.keys(cost) as (keyof ResourceCount)[]).every((r) => resources[r] >= (cost[r] ?? 0));
}

export default function BuildToolbar({
  resources,
  legalTypes,
  activeMode,
  devCardsRemaining,
  onToggleMode,
  onBuyDevCard,
  onEndTurn,
}: BuildToolbarProps): JSX.Element {
  const canRoad = legalTypes.includes('buildRoad') && canAfford(resources, BUILD_COSTS.road);
  const canSettlement = legalTypes.includes('buildSettlement') && canAfford(resources, BUILD_COSTS.settlement);
  const canCity = legalTypes.includes('buildCity') && canAfford(resources, BUILD_COSTS.city);
  const canBuyDevCard =
    legalTypes.includes('buyDevCard') && canAfford(resources, BUILD_COSTS.devCard) && devCardsRemaining > 0;
  const canEndTurn = legalTypes.includes('endTurn');

  return (
    <div className="build-toolbar">
      <button
        type="button"
        className={`build-toolbar__button${activeMode === 'road' ? ' build-toolbar__button--active' : ''}`}
        disabled={!canRoad}
        onClick={() => onToggleMode('road')}
      >
        <span className="build-toolbar__label">Road</span>
        <CostChips cost={BUILD_COSTS.road} />
      </button>
      <button
        type="button"
        className={`build-toolbar__button${activeMode === 'settlement' ? ' build-toolbar__button--active' : ''}`}
        disabled={!canSettlement}
        onClick={() => onToggleMode('settlement')}
      >
        <span className="build-toolbar__label">Settlement</span>
        <CostChips cost={BUILD_COSTS.settlement} />
      </button>
      <button
        type="button"
        className={`build-toolbar__button${activeMode === 'city' ? ' build-toolbar__button--active' : ''}`}
        disabled={!canCity}
        onClick={() => onToggleMode('city')}
      >
        <span className="build-toolbar__label">City</span>
        <CostChips cost={BUILD_COSTS.city} />
      </button>
      <button type="button" className="build-toolbar__button" disabled={!canBuyDevCard} onClick={onBuyDevCard}>
        <span className="build-toolbar__label">Dev Card</span>
        <CostChips cost={BUILD_COSTS.devCard} />
      </button>
      <button
        type="button"
        className="build-toolbar__button build-toolbar__button--end-turn"
        disabled={!canEndTurn}
        onClick={onEndTurn}
      >
        End Turn
      </button>
    </div>
  );
}
