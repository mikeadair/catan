// A compact 2x2 grid of map preset cards for the lobby's game-settings panel. Each card
// shows a small static board thumbnail (reusing MapPreview/Board, same as the single big
// live preview) plus the preset's name and description. Clicking a card selects that preset;
// when `onSelect` is omitted the grid is read-only (non-host viewers).
import type { JSX, KeyboardEvent } from 'react';
import { MAP_PRESETS, type MapPresetId } from '@catan/engine';
import MapPreview from './MapPreview';
import './MapPickerGrid.css';

export interface MapPickerGridProps {
  selected: MapPresetId;
  onSelect?: (id: MapPresetId) => void;
  disabled?: boolean;
}

function activateOnEnterOrSpace(e: KeyboardEvent, activate: () => void): void {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    activate();
  }
}

export default function MapPickerGrid({ selected, onSelect, disabled }: MapPickerGridProps): JSX.Element {
  const interactive = !!onSelect && !disabled;

  return (
    <div className="map-picker-grid">
      {MAP_PRESETS.map((p) => {
        const isSelected = p.id === selected;
        const select = () => onSelect?.(p.id);
        return (
          <div
            key={p.id}
            className={`map-picker-card${isSelected ? ' map-picker-card--selected' : ''}${interactive ? ' map-picker-card--interactive' : ''}`}
            role={interactive ? 'button' : undefined}
            tabIndex={interactive ? 0 : undefined}
            aria-pressed={interactive ? isSelected : undefined}
            onClick={interactive ? select : undefined}
            onKeyDown={interactive ? (e) => activateOnEnterOrSpace(e, select) : undefined}
          >
            <MapPreview mapPreset={p.id} variant="thumbnail" />
            <div className="map-picker-card__name">{p.name}</div>
            <div className="map-picker-card__desc">{p.description}</div>
          </div>
        );
      })}
    </div>
  );
}
