import { useState, type JSX } from 'react';
import type { ResourceCount } from '@catan/engine';
import { DISCARD_TIMEOUT_SECONDS, RESOURCES } from '@catan/engine';
import ResourceHand from './ResourceHand';
import TurnTimer from './TurnTimer';
import './DiscardModal.css';

export interface DiscardModalProps {
  visible: boolean;
  resources: ResourceCount;
  onDiscard: (resources: Partial<ResourceCount>) => void;
  /** Date.now() the room entered the 'discard' phase, driving the shared DISCARD_TIMEOUT_SECONDS
   * countdown (see 'timeoutDiscard' in rules.ts) — null hides the timer entirely. */
  discardPhaseStartedAt: number | null;
  paused: boolean;
  pausedAt: number | null;
}

export default function DiscardModal({
  visible,
  resources,
  onDiscard,
  discardPhaseStartedAt,
  paused,
  pausedAt,
}: DiscardModalProps): JSX.Element | null {
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
      <div className="modal discard-modal modal--danger">
        <div className="discard-modal__header">
          <h3>Rolled a 7 — discard cards</h3>
          {discardPhaseStartedAt !== null && (
            <TurnTimer
              turnStartedAt={discardPhaseStartedAt}
              turnTimerSeconds={DISCARD_TIMEOUT_SECONDS}
              paused={paused}
              pausedAt={pausedAt}
              label="Discard timer"
            />
          )}
        </div>
        <p>
          You must discard {required} card{required === 1 ? '' : 's'} ({selectedTotal}/{required} selected) —
          an unanswered discard is picked at random once the timer runs out.
        </p>
        <ResourceHand resources={resources} variant="cards" selected={selected} onChange={setSelected} max={required} />
        <div className="modal__actions">
          <button type="button" className="modal__confirm" onClick={handleConfirm} disabled={selectedTotal !== required}>
            Discard
          </button>
        </div>
      </div>
    </div>
  );
}
