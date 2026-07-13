import type { JSX } from 'react';
import type { ResourceCount } from '@catan/engine';
import { RESOURCES } from '@catan/engine';
import { RESOURCE_ICON, RESOURCE_LABEL } from './resourceIcons';
import { DevCardIcon } from './gameIcons';
import './BankPanel.css';

export interface BankPanelProps {
  bank: ResourceCount;
  devCardsRemaining: number;
}

export default function BankPanel({ bank, devCardsRemaining }: BankPanelProps): JSX.Element {
  return (
    <div className="bank-panel">
      <div className="bank-panel__header">Bank</div>
      <div className="bank-panel__cards">
        {RESOURCES.map((r) => (
          <div key={r} className={`bank-card bank-card--${r}`}>
            <img src={RESOURCE_ICON[r]} alt={RESOURCE_LABEL[r]} className="bank-card__icon" />
            <span className="bank-card__count">{bank[r]}</span>
            <span className="bank-card__label">{RESOURCE_LABEL[r]}</span>
          </div>
        ))}
      </div>
      <div className="bank-panel__devcards" title="Development cards remaining in the deck">
        <DevCardIcon className="bank-panel__devcards-icon" />
        <span>{devCardsRemaining} left</span>
      </div>
    </div>
  );
}
