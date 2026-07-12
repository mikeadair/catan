import type { JSX } from 'react';
import type { PublicPlayer } from '@catan/engine';
import { PLAYER_COLOR_HEX } from './playerColors';
import './RobberModal.css';

export type RobberStep = 'hex' | 'victim' | null;

export interface RobberModalProps {
  step: RobberStep;
  players: Record<string, PublicPlayer>;
  eligibleUids: string[];
  onSelectVictim: (uid: string | null) => void;
}

export default function RobberModal({ step, players, eligibleUids, onSelectVictim }: RobberModalProps): JSX.Element | null {
  if (step === 'hex') {
    return <div className="robber-banner">Choose a hex to move the robber to.</div>;
  }

  if (step === 'victim') {
    return (
      <div className="modal-overlay">
        <div className="modal robber-modal">
          <h3>Steal a card</h3>
          <p>Choose a player to steal a random resource card from.</p>
          <div className="robber-modal__list">
            {eligibleUids.map((uid) => {
              const p = players[uid];
              if (!p) return null;
              return (
                <button key={uid} type="button" className="robber-modal__victim" onClick={() => onSelectVictim(uid)}>
                  <span className="robber-modal__swatch" style={{ background: PLAYER_COLOR_HEX[p.color] }} />
                  {p.displayName}
                </button>
              );
            })}
          </div>
          <div className="modal__actions">
            <button type="button" onClick={() => onSelectVictim(null)}>
              Steal from no one
            </button>
          </div>
        </div>
      </div>
    );
  }

  return null;
}
