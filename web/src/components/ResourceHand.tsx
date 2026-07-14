// Reusable resource display/picker. Used read-only for the bank strip and the
// player's own hand, and interactively (via `selected`/`onChange`) for
// discard, bank-trade, player-trade, and Year of Plenty resource pickers.
import { useEffect, type JSX } from 'react';
import type { Resource, ResourceCount } from '@catan/engine';
import { RESOURCES } from '@catan/engine';
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
  /** 'chip' (default): compact icon+count, used for pickers and the bank strip (where counts
   * run up to 19 and individual card faces would be unusable). 'cards': one card-styled
   * *stack* per resource type actually held (at most 5 — one per resource — regardless of how
   * many of each a player holds, so the hand never grows past a single row). Read-only (no
   * `onChange`) for a player's own hand display shows the owned count; with `selected`/
   * `onChange` it becomes interactive — tapping a stack adds one of that resource to the
   * selection (up to what's owned/`max`), and a small ± stepper on the stack gives precise
   * control including removing — used by the trade bar and discard modal so players pick
   * straight from their actual hand instead of a bare stepper-only picker. */
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

  // `resources` (the actual hand) can shrink out from under an in-progress selection — e.g. a
  // player has cards staged for a trade proposal, then spends those exact cards on a build, or
  // loses them to a robber/discard/another trade, all while the composer stays open. Without
  // this, `selected` (owned by the parent, e.g. Game.tsx's tradeGive) would keep claiming a
  // count the hand no longer actually has — a phantom selection. Clamp it down to whatever's
  // still there. Skipped for `unlimited` pickers (Year of Plenty draws from the bank, not this
  // hand, so there's nothing to clamp against).
  useEffect(() => {
    if (unlimited || !onChange) return;
    let changed = false;
    const next: Partial<ResourceCount> = { ...sel };
    for (const r of RESOURCES) {
      const avail = resources[r] ?? 0;
      if ((sel[r] ?? 0) > avail) {
        next[r] = avail;
        changed = true;
      }
    }
    if (changed) onChange(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resources]);

  if (variant === 'cards') {
    // One stack per resource actually held (at most 5 total, one per resource type) rather
    // than one element per unit — a hand of 20 cards renders exactly as many stacks as
    // distinct resources it holds, so the hand's footprint never grows past a single row
    // regardless of count. Tapping the stack body adds one of that resource to the
    // selection; the small ± stepper gives precise add/remove control (including removing,
    // which a bare tap can't express once more than one is already selected).
    function stepSelection(r: Resource, delta: number) {
      if (!onChange) return;
      const cur = sel[r] ?? 0;
      if (delta > 0) {
        const avail = unlimited ? Infinity : (resources[r] ?? 0);
        if (cur >= avail) return;
        if (max !== undefined && selectedTotal >= max) return;
        onChange({ ...sel, [r]: cur + 1 });
      } else {
        if (cur <= 0) return;
        onChange({ ...sel, [r]: cur - 1 });
      }
    }

    return (
      <div className="resource-hand resource-hand--cards">
        {RESOURCES.flatMap((r) => {
          const count = resources[r] ?? 0;
          if (count === 0) return [];
          const selCount = sel[r] ?? 0;
          const isSelected = interactive && selCount > 0;
          const atCap = (max !== undefined && selectedTotal >= max) || selCount >= (unlimited ? Infinity : count);
          return (
            <div
              key={r}
              className={`resource-card resource-card--${r}${isSelected ? ' resource-card--selected' : ''}${interactive ? ' resource-card--interactive' : ''}`}
              data-testid="hand-card"
              data-resource={r}
              data-resource-count={count}
              data-selected-count={selCount}
              onClick={interactive ? () => stepSelection(r, 1) : undefined}
              role={interactive ? 'button' : undefined}
              tabIndex={interactive ? 0 : undefined}
              onKeyDown={
                interactive
                  ? (e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        stepSelection(r, 1);
                      }
                    }
                  : undefined
              }
            >
              <img src={RESOURCE_ICON[r]} alt={RESOURCE_LABEL[r]} className="resource-card__icon" />
              <span className="resource-card__label">{RESOURCE_LABEL[r]}</span>
              <span className="resource-card__count">{count}</span>
              {interactive && (
                <div
                  className="resource-card__stepper"
                  // Keep taps on the stepper's own +/- buttons from also bubbling up to the
                  // card body's onClick (which would double-add on top of whichever button fired).
                  onClick={(e) => e.stopPropagation()}
                >
                  <button
                    type="button"
                    onClick={() => stepSelection(r, -1)}
                    disabled={selCount <= 0}
                    aria-label={`Remove one ${RESOURCE_LABEL[r]} from trade`}
                  >
                    −
                  </button>
                  <span className="resource-card__selected">{selCount}</span>
                  <button
                    type="button"
                    onClick={() => stepSelection(r, 1)}
                    disabled={atCap}
                    aria-label={`Add one ${RESOURCE_LABEL[r]} to trade`}
                  >
                    +
                  </button>
                </div>
              )}
            </div>
          );
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
