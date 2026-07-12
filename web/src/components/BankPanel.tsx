import type { JSX } from 'react';
import type { ResourceCount } from '@catan/engine';
import ResourceHand from './ResourceHand';
import './BankPanel.css';

export interface BankPanelProps {
  bank: ResourceCount;
  devCardsRemaining: number;
}

export default function BankPanel({ bank, devCardsRemaining }: BankPanelProps): JSX.Element {
  return (
    <div className="bank-panel">
      <div className="bank-panel__header">Bank</div>
      <ResourceHand resources={bank} />
      <div className="bank-panel__devcards" title="Development cards remaining in the deck">
        <span className="bank-panel__devcards-icon">🃏</span>
        <span>{devCardsRemaining} left</span>
      </div>
    </div>
  );
}
