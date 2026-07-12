import { useState, type JSX } from 'react';
import type { ResourceCount } from '../game/types';
import { RESOURCES } from '../game/types';
import ResourceHand from './ResourceHand';
import './DiscardModal.css';

export interface DiscardModalProps {
  visible: boolean;
  resources: ResourceCount;
  onDiscard: (resources: Partial<ResourceCount>) => void;
}

export default function DiscardModal({ visible, resources, onDiscard }: DiscardModalProps): JSX.Element | null {
  const [selected, setSelected] = useState<Partial<ResourceCount>>({});

  if (!visible) return null;

  const handSize = RESOURCES.reduce((sum, r) => sum + (resources[r] ?? 0), 0);
  const required = Math.floor(handSize / 2);
  const selectedTotal = RESOURCES.reduce((sum, r) => sum + (selected[r] ?? 0), 0);

  function handleConfirm() {
    onDiscard(selected);
    setSelected({});
  }

  return (
    <div className="modal-overlay">
      <div className="modal discard-modal">
        <h3>Rolled a 7 — discard cards</h3>
        <p>
          You must discard {required} card{required === 1 ? '' : 's'} ({selectedTotal}/{required} selected).
        </p>
        <ResourceHand resources={resources} selected={selected} onChange={setSelected} max={required} />
        <div className="modal__actions">
          <button type="button" className="modal__confirm" onClick={handleConfirm} disabled={selectedTotal !== required}>
            Discard
          </button>
        </div>
      </div>
    </div>
  );
}
