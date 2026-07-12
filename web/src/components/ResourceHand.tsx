// Reusable resource display/picker. Used read-only for the bank strip and the
// player's own hand, and interactively (via `selected`/`onChange`) for
// discard, bank-trade, player-trade, and Year of Plenty resource pickers.
import type { JSX } from 'react';
import type { Resource, ResourceCount } from '../game/types';
import { RESOURCES } from '../game/types';
import { RESOURCE_ICON, RESOURCE_LABEL } from './resourceIcons';
import './ResourceHand.css';

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
}

export default function ResourceHand({
  resources,
  selected,
  onChange,
  max,
  unlimited,
}: ResourceHandProps): JSX.Element {
  const interactive = !!onChange;
  const sel = selected ?? {};
  const selectedTotal = RESOURCES.reduce((sum, r) => sum + (sel[r] ?? 0), 0);

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
