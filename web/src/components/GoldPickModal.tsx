import { useState, type JSX } from 'react';
import type { Resource, ResourceCount } from '@catan/engine';
import { RESOURCES } from '@catan/engine';
import ResourceHand from './ResourceHand';
import './DiscardModal.css';

export interface GoldPickModalProps {
  visible: boolean;
  amount: number;
  bank: ResourceCount;
  onPick: (resources: Resource[]) => void;
}

export default function GoldPickModal({ visible, amount, bank, onPick }: GoldPickModalProps): JSX.Element | null {
  const [selected, setSelected] = useState<Partial<ResourceCount>>({});

  if (!visible) return null;

  const selectedTotal = RESOURCES.reduce((sum, r) => sum + (selected[r] ?? 0), 0);

  function handleConfirm() {
    const resources: Resource[] = [];
    for (const r of RESOURCES) {
      for (let i = 0; i < (selected[r] ?? 0); i++) resources.push(r);
    }
    onPick(resources);
    setSelected({});
  }

  return (
    <div className="modal-overlay">
      <div className="modal discard-modal">
        <h3>Struck gold!</h3>
        <p>
          Pick {amount} resource{amount === 1 ? '' : 's'} from the bank ({selectedTotal}/{amount} selected).
        </p>
        <ResourceHand resources={bank} selected={selected} onChange={setSelected} max={amount} variant="card-steppers" />
        <div className="modal__actions">
          <button type="button" className="modal__confirm" onClick={handleConfirm} disabled={selectedTotal !== amount}>
            Take
          </button>
        </div>
      </div>
    </div>
  );
}
