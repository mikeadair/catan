// Reusable resource display/picker. Used read-only for the bank strip and the
// player's own hand, and interactively (via `selected`/`onChange`) for
// discard, bank-trade, player-trade, and Year of Plenty resource pickers.
import { useEffect, useState, type CSSProperties, type JSX } from 'react';
import type { Resource, ResourceCount } from '@catan/engine';
import { RESOURCES } from '@catan/engine';
import { RESOURCE_ICON, RESOURCE_LABEL } from './resourceIcons';
import './ResourceHand.css';

// Per resource type, the max number of interactive slots the 'cards' variant will ever render:
// individually-tappable overlapping card faces, plus (once a resource's count reaches this cap)
// one final +/- stepper slot standing in for everything beyond the individual faces. This is
// what bounds each resource's fanned group to a fixed max width regardless of whether a player
// holds 6 or 26 of it — see slotLayout() below and ResourceHand.design-notes.md for why.
const RESOURCE_GROUP_CAP = 6;

// The overflow/counter slot always paints in front of every individual face in its group,
// including a selected face's own front-of-group bump (1000 + up to RESOURCE_GROUP_CAP - 1) —
// see the zIndex comment on the overflow slot below. Comfortably above that ceiling regardless
// of RESOURCE_GROUP_CAP's exact value.
const OVERFLOW_Z_INDEX = 2000;

/** How many of a resource's `count` render as individually-tappable overlapping card faces vs.
 * get folded into a single trailing +/- stepper slot. Below the cap, every unit gets its own
 * face and there's no stepper at all; at/above it, the last slot is always the stepper (e.g. at
 * cap=6: 5 individual faces for units 1-5, then one stepper slot covering unit 6 and up). */
function slotLayout(count: number, cap: number): { individualSlots: number; stepperMax: number } {
  if (count < cap) return { individualSlots: count, stepperMax: 0 };
  return { individualSlots: cap - 1, stepperMax: count - (cap - 1) };
}

/** Bookkeeping for one resource's card group in the 'cards' variant: which individual face
 * indices (0..individualSlots-1) are tapped-selected, plus how much of the selection is
 * represented by the trailing overflow stepper instead. `faces.length + stepper` is always
 * kept equal to the resource's `selected` count — see the reconciliation effect below. */
interface FaceState {
  faces: number[];
  stepper: number;
}

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
   * run up to 19 and individual card faces would be unusable). 'cards': one resource-tinted
   * card per unit owned, fanned with a heavy (~75%) overlap within each resource's group so a
   * handful of cards of the same type take up a fraction of the width fully-separate cards
   * would — capped at `RESOURCE_GROUP_CAP` slots per resource (individually-tappable faces,
   * plus a trailing +/- stepper once a resource's count reaches the cap), so one resource's
   * group never grows past a fixed max width no matter how many of it are held. Each resource's
   * group never wraps internally (see .resource-card-group in ResourceHand.css) — only whole
   * groups wrap onto a new row — which is what makes this safe to bring back after the
   * pre-cap/pre-group version of this same idea was pulled for not wrapping cleanly (see
   * ResourceHand.design-notes.md). Read-only (no `onChange`) for a player's own hand display;
   * with `selected`/`onChange` it becomes interactive — tapping a specific face toggles exactly
   * that face, and the overflow slot's stepper adds/removes from the count it represents — used
   * by the trade bar and discard modal so players pick straight from their actual hand. */
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

  // Which exact card faces are toggled per resource, plus the overflow stepper's own
  // contribution — see FaceState above. `selected` (owned by the parent) is still the source of
  // truth for *counts*; this is purely "which visual face(s)/how much of the stepper currently
  // represent that count" bookkeeping, so a tapped face stays the one that's highlighted rather
  // than highlighting jumping to "whichever face is first" on every render.
  const [faceState, setFaceState] = useState<Partial<Record<Resource, FaceState>>>({});

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

  // Keep the cards variant's per-face/stepper bookkeeping in sync whenever something *external*
  // changes the picture out from under it: the hand shrinking (clamped above, which can also
  // invalidate face indices past the new individualSlots), or a parent doing a full reset (the
  // trade composer's Clear button, closing it, confirming a discard). A tap-driven change never
  // trips this — toggleFace/stepGroup below update faceState and `selected` together in the
  // same tick, so on the next render they already agree and this is a no-op, which is what lets
  // a tapped face stay exactly the one highlighted instead of jumping to "the first N faces".
  useEffect(() => {
    if (variant !== 'cards' || !onChange) return;
    setFaceState((cur) => {
      let changed = false;
      const next: Partial<Record<Resource, FaceState>> = { ...cur };
      for (const r of RESOURCES) {
        const fs = cur[r];
        if (!fs) continue;
        const count = resources[r] ?? 0;
        const { individualSlots, stepperMax } = slotLayout(count, RESOURCE_GROUP_CAP);
        const validFaces = fs.faces.filter((i) => i < individualSlots);
        const validStepper = Math.min(fs.stepper, stepperMax);
        const want = sel[r] ?? 0;
        if (validFaces.length === fs.faces.length && validStepper === fs.stepper && validFaces.length + validStepper === want) {
          continue; // already consistent — leave the exact tapped faces alone
        }
        changed = true;
        if (validFaces.length + validStepper === want) {
          next[r] = { faces: validFaces, stepper: validStepper };
        } else {
          // Total disagrees with what the parent owns (an external reset/clamp) — fall back to
          // a canonical fill: individual faces first, remainder into the stepper.
          const faces = Array.from({ length: Math.min(want, individualSlots) }, (_, i) => i);
          const stepper = Math.max(0, Math.min(want - faces.length, stepperMax));
          next[r] = { faces, stepper };
        }
      }
      return changed ? next : cur;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resources, variant, RESOURCES.map((r) => sel[r] ?? 0).join(',')]);

  if (variant === 'cards') {
    function toggleFace(r: Resource, faceIndex: number) {
      if (!onChange) return;
      const fs = faceState[r] ?? { faces: [], stepper: 0 };
      const isSelected = fs.faces.includes(faceIndex);
      let faces: number[];
      if (isSelected) {
        faces = fs.faces.filter((i) => i !== faceIndex);
      } else {
        if (max !== undefined && selectedTotal >= max) return;
        faces = [...fs.faces, faceIndex];
      }
      setFaceState({ ...faceState, [r]: { ...fs, faces } });
      onChange({ ...sel, [r]: faces.length + fs.stepper });
    }

    // Drives the counter slot's +/- buttons. Unlike toggleFace (which always targets one
    // specific face the user tapped directly), this is index-agnostic: + fills whichever
    // visible face is the *lowest-indexed currently unselected* one first (so it naturally
    // resumes left-to-right from wherever manual taps left off, rather than always starting
    // over at face 0 or fighting a face the user already picked by hand), and only once every
    // visible face is selected does it start climbing the pure-overflow stepper. - (delta < 0)
    // mirrors that: drain the stepper first, then deselect the *highest-indexed currently
    // selected* face. Manual taps via toggleFace are otherwise untouched by this — it just
    // picks up whatever state faceState is already in.
    function stepGroup(r: Resource, delta: number, individualSlots: number, stepperMax: number) {
      if (!onChange) return;
      const fs = faceState[r] ?? { faces: [], stepper: 0 };
      if (delta > 0) {
        if (max !== undefined && selectedTotal >= max) return;
        let lowestUnselected = -1;
        for (let i = 0; i < individualSlots; i++) {
          if (!fs.faces.includes(i)) {
            lowestUnselected = i;
            break;
          }
        }
        if (lowestUnselected !== -1) {
          const faces = [...fs.faces, lowestUnselected].sort((a, b) => a - b);
          setFaceState({ ...faceState, [r]: { ...fs, faces } });
          onChange({ ...sel, [r]: faces.length + fs.stepper });
          return;
        }
        if (fs.stepper >= stepperMax) return;
        const stepper = fs.stepper + 1;
        setFaceState({ ...faceState, [r]: { ...fs, stepper } });
        onChange({ ...sel, [r]: fs.faces.length + stepper });
      } else {
        if (fs.stepper > 0) {
          const stepper = fs.stepper - 1;
          setFaceState({ ...faceState, [r]: { ...fs, stepper } });
          onChange({ ...sel, [r]: fs.faces.length + stepper });
          return;
        }
        if (fs.faces.length === 0) return;
        const highest = Math.max(...fs.faces);
        const faces = fs.faces.filter((i) => i !== highest);
        setFaceState({ ...faceState, [r]: { ...fs, faces } });
        onChange({ ...sel, [r]: faces.length + fs.stepper });
      }
    }

    return (
      <div className="resource-hand resource-hand--cards">
        {RESOURCES.flatMap((r) => {
          const count = resources[r] ?? 0;
          if (count === 0) return [];
          const { individualSlots, stepperMax } = slotLayout(count, RESOURCE_GROUP_CAP);
          const fs = faceState[r] ?? { faces: [], stepper: 0 };
          const selectedFaces = fs.faces;
          const stepperVal = Math.min(fs.stepper, stepperMax);

          return (
            // Its own nowrap flex row — the whole group wraps as one atomic unit (see
            // .resource-card-group/.resource-hand--cards in ResourceHand.css), never splitting
            // a resource's overlapping fan across two rows.
            <div className="resource-card-group" key={r}>
              {Array.from({ length: individualSlots }, (_, i) => {
                const isSelected = interactive && selectedFaces.includes(i);
                return (
                  <div
                    key={i}
                    className={`resource-card resource-card--${r}${isSelected ? ' resource-card--selected' : ''}${interactive ? ' resource-card--interactive' : ''}`}
                    style={
                      {
                        // Descending by index — face 0 (what `.first()` in e2e specs, and a
                        // player's "just tap the pile" instinct, both land on) stays the fully
                        // visible frontmost card; later faces recede behind it, each still
                        // showing a real (if slim) clickable sliver of its own. A tapped
                        // *selected* face jumps to the very front of all of them (base 1000+)
                        // so it stays legible regardless of where in the stack it started.
                        zIndex: isSelected ? 1000 + (individualSlots - i) : individualSlots - i,
                        '--card-rotate': `${(i % 2 === 0 ? -1 : 1) * 2}deg`,
                      } as CSSProperties
                    }
                    data-testid="hand-card"
                    data-resource={r}
                    data-resource-count={count}
                    data-face-index={i}
                    onClick={interactive ? () => toggleFace(r, i) : undefined}
                    role={interactive ? 'button' : undefined}
                    tabIndex={interactive ? 0 : undefined}
                    onKeyDown={
                      interactive
                        ? (e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault();
                              toggleFace(r, i);
                            }
                          }
                        : undefined
                    }
                  >
                    <img src={RESOURCE_ICON[r]} alt={RESOURCE_LABEL[r]} className="resource-card__icon" />
                    <span className="resource-card__label">{RESOURCE_LABEL[r]}</span>
                    {isSelected && <span className="resource-card__check">✓</span>}
                  </div>
                );
              })}
              {stepperMax > 0 &&
                (interactive ? (
                  <div
                    key="overflow"
                    className={`resource-card resource-card--${r} resource-card--overflow${selectedFaces.length + stepperVal > 0 ? ' resource-card--selected' : ''}`}
                    // Joins the same overlap-margin chain as the individual faces (see
                    // .resource-card--overflow in ResourceHand.css) and gets the highest
                    // z-index of anything in the group — it's the group's running-total
                    // display, so it should read as "the one on top", fully visible, rather
                    // than a detached box off to the side.
                    style={{ zIndex: OVERFLOW_Z_INDEX }}
                    data-testid="hand-card-overflow"
                    data-resource={r}
                    data-resource-count={count}
                  >
                    <img src={RESOURCE_ICON[r]} alt={RESOURCE_LABEL[r]} className="resource-card__icon resource-card__icon--small" />
                    <div
                      className="resource-card__stepper"
                      // Keep taps on the stepper's own +/- buttons from also bubbling up to
                      // whatever's behind this slot in the fan.
                      onClick={(e) => e.stopPropagation()}
                    >
                      <button
                        type="button"
                        onClick={() => stepGroup(r, -1, individualSlots, stepperMax)}
                        disabled={selectedFaces.length + stepperVal <= 0}
                        aria-label={`Remove one more ${RESOURCE_LABEL[r]} from trade`}
                      >
                        −
                      </button>
                      {/* Running total across both individually-tapped faces and the pure
                          overflow stepper — not just the stepper's own portion — so this
                          climbs visibly as more of the resource gets selected by any means. */}
                      <span className="resource-card__selected">{selectedFaces.length + stepperVal}</span>
                      <button
                        type="button"
                        onClick={() => stepGroup(r, 1, individualSlots, stepperMax)}
                        disabled={selectedFaces.length + stepperVal >= count || (max !== undefined && selectedTotal >= max)}
                        aria-label={`Add one more ${RESOURCE_LABEL[r]} to trade`}
                      >
                        +
                      </button>
                    </div>
                    <span className="resource-card__overflow-of">of {count}</span>
                  </div>
                ) : (
                  <div
                    key="overflow"
                    className={`resource-card resource-card--${r} resource-card--overflow`}
                    style={{ zIndex: OVERFLOW_Z_INDEX }}
                    data-testid="hand-card-overflow"
                    data-resource={r}
                    data-resource-count={count}
                  >
                    <img src={RESOURCE_ICON[r]} alt={RESOURCE_LABEL[r]} className="resource-card__icon resource-card__icon--small" />
                    <span className="resource-card__label">+{stepperMax}</span>
                  </div>
                ))}
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
