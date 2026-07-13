// Reusable resource display/picker. Used read-only for the bank strip and the
// player's own hand, and interactively (via `selected`/`onChange`) for
// discard, bank-trade, player-trade, and Year of Plenty resource pickers.
import { useEffect, useState, type JSX } from 'react';
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
   * per unit owned. Read-only (no `onChange`) for a player's own hand display; with
   * `selected`/`onChange` it becomes clickable — tapping a specific face toggles exactly that
   * face (not just "some face of that type" derived from a count), so the card a player
   * actually taps stays highlighted regardless of its position, used by the trade bar and
   * discard modal so players pick straight from their actual hand instead of a stepper. */
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

  // Which exact card faces are toggled, per resource — tracked by face index rather than
  // derived from `sel[r]`'s count, so the specific card a player taps is what stays
  // highlighted (not just however many of the leftmost faces of that type). `selected` is
  // still the source of truth for parents (they only care about counts); this is purely
  // "which visual face(s) currently represent that count" bookkeeping.
  const [faceSelection, setFaceSelection] = useState<Partial<Record<Resource, number[]>>>({});

  // External resets (a "Clear" button, closing the trade composer, confirming a discard) always
  // zero out the whole `selected` map at once — reconcile our per-face tracking to match rather
  // than leaving stale highlighted faces behind after the count they represented is gone.
  useEffect(() => {
    if (selectedTotal > 0) return;
    setFaceSelection((cur) => (Object.values(cur).some((faces) => faces && faces.length > 0) ? {} : cur));
  }, [selectedTotal]);

  if (variant === 'cards') {
    function toggleCardFace(r: Resource, faceIndex: number) {
      if (!onChange) return;
      const current = faceSelection[r] ?? [];
      const isCurrentlySelected = current.includes(faceIndex);
      let nextFaces: number[];
      if (isCurrentlySelected) {
        nextFaces = current.filter((i) => i !== faceIndex);
      } else {
        const avail = unlimited ? Infinity : resources[r];
        if (current.length >= avail) return;
        if (max !== undefined && selectedTotal >= max) return;
        nextFaces = [...current, faceIndex];
      }
      setFaceSelection({ ...faceSelection, [r]: nextFaces });
      onChange({ ...sel, [r]: nextFaces.length });
    }

    return (
      <div className="resource-hand resource-hand--cards">
        {RESOURCES.flatMap((r) => {
          const count = resources[r] ?? 0;
          if (count === 0) return [];
          const faceCount = Math.min(count, MAX_CARD_FACES_PER_RESOURCE);
          const overflow = count - faceCount;
          const selectedFaces = faceSelection[r] ?? [];
          return Array.from({ length: faceCount }, (_, i) => {
            const isSelected = interactive && selectedFaces.includes(i);
            return (
              <div
                key={`${r}-${i}`}
                className={`resource-card resource-card--${r}${isSelected ? ' resource-card--selected' : ''}${interactive ? ' resource-card--interactive' : ''}`}
                onClick={interactive ? () => toggleCardFace(r, i) : undefined}
                role={interactive ? 'button' : undefined}
                tabIndex={interactive ? 0 : undefined}
                onKeyDown={
                  interactive
                    ? (e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          toggleCardFace(r, i);
                        }
                      }
                    : undefined
                }
              >
                <img src={RESOURCE_ICON[r]} alt={RESOURCE_LABEL[r]} className="resource-card__icon" />
                <span className="resource-card__label">{RESOURCE_LABEL[r]}</span>
                {i === faceCount - 1 && overflow > 0 && <span className="resource-card__overflow">+{overflow}</span>}
                {isSelected && <span className="resource-card__check">✓</span>}
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
