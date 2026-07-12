// Reusable resource display/picker. Used read-only for the bank strip and the
// player's own hand, and interactively (via `selected`/`onChange`) for
// discard, bank-trade, player-trade, and Year of Plenty resource pickers.
import type { CSSProperties, JSX } from 'react';
import type { Resource, ResourceCount } from '@catan/engine';
import { RESOURCES } from '@catan/engine';
import { RESOURCE_ICON, RESOURCE_LABEL } from './resourceIcons';
import './ResourceHand.css';

// A hand can (rarely) hold well over a dozen of one resource; past this many individual
// card faces the fanned display stops reading as "a hand of cards" and just becomes visual
// noise, so further copies collapse into a "+N" tag on the last card instead.
const MAX_CARD_FACES_PER_RESOURCE = 8;

export interface ResourceHandProps {
  /** Pool of resources to display counts for / to bound selection by. */
  resources: ResourceCount;
  /** Current selection, for interactive pickers. Omit for read-only display. */
  selected?: Partial<ResourceCount>;
  /** Presence of this callback turns the component interactive. */
  onChange?: (next: Partial<ResourceCount>) => void;
  /** Cap on total selected count across all resource types. */
  max?: number;
  /** When true, selection isn't bounded by `resources` (e.g. Year of Plenty draws from the bank). */
  unlimited?: boolean;
  /** 'chip' (default): compact icon+count, used for pickers and the bank strip (where counts
   * run up to 19 and individual card faces would be unusable). 'cards': one card-styled face
   * per unit owned, fanned like a real hand — for a player's own read-only hand display. */
  variant?: 'chip' | 'cards';
}

export default function ResourceHand({
  resources,
  selected,
  onChange,
  max,
  unlimited,
  variant = 'chip',
}: ResourceHandProps): JSX.Element {
  const interactive = !!onChange;
  const sel = selected ?? {};
  const selectedTotal = RESOURCES.reduce((sum, r) => sum + (sel[r] ?? 0), 0);

  if (variant === 'cards') {
    let globalIndex = 0;
    return (
      <div className="resource-hand resource-hand--cards">
        {RESOURCES.flatMap((r) => {
          const count = resources[r] ?? 0;
          if (count === 0) return [];
          const faceCount = Math.min(count, MAX_CARD_FACES_PER_RESOURCE);
          const overflow = count - faceCount;
          return Array.from({ length: faceCount }, (_, i) => {
            const idx = globalIndex++;
            return (
              <div
                key={`${r}-${i}`}
                className={`resource-card resource-card--${r}`}
                style={
                  {
                    zIndex: idx,
                    marginLeft: idx === 0 ? 0 : -22,
                    '--card-rotate': `${(idx % 2 === 0 ? -1 : 1) * 2}deg`,
                  } as CSSProperties
                }
              >
                <img src={RESOURCE_ICON[r]} alt={RESOURCE_LABEL[r]} className="resource-card__icon" />
                <span className="resource-card__label">{RESOURCE_LABEL[r]}</span>
                {i === faceCount - 1 && overflow > 0 && (
                  <span className="resource-card__overflow">+{overflow}</span>
                )}
              </div>
            );
          });
        })}
      </div>
    );
  }

  function inc(r: Resource) {
    if (!onChange) return;
    const avail = unlimited ? Infinity : resources[r];
    const cur = sel[r] ?? 0;
    if (cur >= avail) return;
    if (max !== undefined && selectedTotal >= max) return;
    onChange({ ...sel, [r]: cur + 1 });
  }

  function dec(r: Resource) {
    if (!onChange) return;
    const cur = sel[r] ?? 0;
    if (cur <= 0) return;
    onChange({ ...sel, [r]: cur - 1 });
  }

  return (
    <div className="resource-hand">
      {RESOURCES.map((r) => {
        const count = resources[r] ?? 0;
        const selCount = sel[r] ?? 0;
        const incDisabled = (!unlimited && selCount >= count) || (max !== undefined && selectedTotal >= max);
        return (
          <div key={r} className={`resource-chip resource-chip--${r}${interactive ? ' resource-chip--interactive' : ''}`}>
            <span className="resource-chip__icon" title={RESOURCE_LABEL[r]}>
              <img src={RESOURCE_ICON[r]} alt={RESOURCE_LABEL[r]} className="resource-chip__icon-img" />
            </span>
            <span className="resource-chip__count">{count}</span>
            {interactive && (
              <span className="resource-chip__stepper">
                <button type="button" onClick={() => dec(r)} disabled={selCount <= 0} aria-label={`Remove ${RESOURCE_LABEL[r]}`}>
                  −
                </button>
                <span className="resource-chip__selected">{selCount}</span>
                <button type="button" onClick={() => inc(r)} disabled={incDisabled} aria-label={`Add ${RESOURCE_LABEL[r]}`}>
                  +
                </button>
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
