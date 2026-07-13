import { useState, type JSX } from 'react';
import { useGameStore } from '../state/store';
import { addBot, removeSeat, startGame, updatePlayerColor, updateRoomSettings } from '../firebase/rooms';
import { MAP_PRESETS } from '@catan/engine';
import { PLAYER_COLORS, type MapPresetId, type PlayerColor } from '@catan/engine';
import { PLAYER_COLOR_HEX } from '../components/playerColors';
import MapPreview from '../components/MapPreview';
import './Lobby.css';

const MAX_SEATS = PLAYER_COLORS.length;
const VP_MIN = 5;
const VP_MAX = 15;
const DISCARD_MIN = 4;
const DISCARD_MAX = 12;
const TURN_TIMER_MIN = 30;
const TURN_TIMER_MAX = 600;
const DEFAULT_TURN_TIMER_SECONDS_FALLBACK = 120;

export default function Lobby(): JSX.Element {
  const uid = useGameStore((s) => s.uid);
  const roomId = useGameStore((s) => s.roomId);
  const room = useGameStore((s) => s.room);
  const players = useGameStore((s) => s.players);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [colorPickerOpen, setColorPickerOpen] = useState(false);
  const [editingSettings, setEditingSettings] = useState(false);
  const [settingsDraft, setSettingsDraft] = useState<{
    mapPreset: MapPresetId;
    victoryPointsToWin: number;
    discardLimit: number;
    turnTimerSeconds: number | null;
  } | null>(null);

  if (!room || !roomId || !uid) {
    return (
      <div className="lobby-loading">
        <div className="lobby-loading__spinner" />
      </div>
    );
  }

  const isHost = uid === room.hostUid;
  const preset = MAP_PRESETS.find((p) => p.id === room.mapPreset);
  const canStart = room.turnOrder.length >= 2;
  const previewPreset = settingsDraft?.mapPreset ?? room.mapPreset;

  async function run(action: () => Promise<unknown>) {
    setError(null);
    setBusy(true);
    try {
      await action();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleCopyInvite() {
    const link = `${window.location.origin}?join=${room!.code}`;
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setError('Could not copy link to clipboard');
    }
  }

  function handleAddBot() {
    run(() => addBot(roomId!, 'normal'));
  }

  function handleRemoveSeat(targetUid: string) {
    run(() => removeSeat(roomId!, targetUid));
  }

  function handleLeave() {
    run(async () => {
      await removeSeat(roomId!, uid!);
      useGameStore.getState().leaveRoom();
    });
  }

  function handleStart() {
    run(() => startGame(roomId!));
  }

  function handlePickColor(color: PlayerColor) {
    run(() => updatePlayerColor(roomId!, uid!, color));
  }

  function openSettingsEditor() {
    setSettingsDraft({
      mapPreset: room!.mapPreset,
      victoryPointsToWin: room!.victoryPointsToWin,
      discardLimit: room!.discardLimit,
      turnTimerSeconds: room!.turnTimerSeconds,
    });
    setEditingSettings(true);
  }

  function handleSaveSettings() {
    if (!settingsDraft) return;
    run(async () => {
      await updateRoomSettings(roomId!, settingsDraft);
      setEditingSettings(false);
      setSettingsDraft(null);
    });
  }

  const seats = room.turnOrder
    .map((seatUid) => players[seatUid])
    .filter((p): p is NonNullable<typeof p> => !!p)
    .sort((a, b) => a.seatIndex - b.seatIndex);

  const openSeatCount = Math.max(0, MAX_SEATS - room.turnOrder.length);

  return (
    <div className="lobby">
      <div className="lobby__card lobby__card--code">
        <div className="lobby__code-label">Room code</div>
        <div className="lobby__code">{room.code}</div>
        <button className="lobby__button" onClick={handleCopyInvite}>
          {copied ? 'Copied!' : 'Copy invite link'}
        </button>
      </div>

      <div className="lobby__card">
        <h2>Players</h2>
        <ul className="lobby__seats">
          {seats.map((p) => {
            const isMe = p.uid === uid;
            const takenColors = new Set(seats.filter((s) => s.uid !== p.uid).map((s) => s.color));
            return (
              <li key={p.uid} className="lobby__seat">
                {isMe ? (
                  <button
                    type="button"
                    className="lobby__swatch lobby__swatch--pickable"
                    style={{ background: PLAYER_COLOR_HEX[p.color] }}
                    onClick={() => setColorPickerOpen((v) => !v)}
                    disabled={busy}
                    aria-label="Change your color"
                    title="Change your color"
                  />
                ) : (
                  <span className="lobby__swatch" style={{ background: PLAYER_COLOR_HEX[p.color] }} />
                )}
                <span className="lobby__seat-name">{p.displayName}</span>
                {p.isBot && <span className="lobby__badge">bot</span>}
                {p.uid === room.hostUid && <span className="lobby__badge lobby__badge--host">host</span>}
                {isHost && p.isBot && (
                  <button
                    className="lobby__seat-remove"
                    onClick={() => handleRemoveSeat(p.uid)}
                    disabled={busy}
                    aria-label={`Remove ${p.displayName}`}
                  >
                    ✕
                  </button>
                )}
                {isMe && colorPickerOpen && (
                  <div className="lobby__color-picker">
                    {PLAYER_COLORS.map((c) => (
                      <button
                        key={c}
                        type="button"
                        className={`lobby__swatch lobby__swatch--option${c === p.color ? ' lobby__swatch--selected' : ''}`}
                        style={{ background: PLAYER_COLOR_HEX[c] }}
                        disabled={busy || takenColors.has(c)}
                        title={takenColors.has(c) ? 'Already taken' : c}
                        aria-label={c}
                        onClick={() => {
                          handlePickColor(c);
                          setColorPickerOpen(false);
                        }}
                      />
                    ))}
                  </div>
                )}
              </li>
            );
          })}
          {Array.from({ length: openSeatCount }).map((_, i) => (
            <li key={`open-${i}`} className="lobby__seat lobby__seat--open">
              <span className="lobby__swatch lobby__swatch--empty" />
              <span className="lobby__seat-name lobby__seat-name--empty">Open seat</span>
            </li>
          ))}
        </ul>

        {error && <div className="lobby__error">{error}</div>}

        <div className="lobby__actions">
          {isHost ? (
            <>
              <button
                className="lobby__button"
                onClick={handleAddBot}
                disabled={busy || room.turnOrder.length >= MAX_SEATS}
              >
                Add bot
              </button>
              <button
                className="lobby__button lobby__button--primary"
                onClick={handleStart}
                disabled={busy || !canStart}
                title={canStart ? undefined : 'Need at least 2 players to start'}
              >
                Start game
              </button>
              {!canStart && <div className="lobby__hint">Need at least 2 players to start.</div>}
            </>
          ) : (
            <button className="lobby__button lobby__button--danger" onClick={handleLeave} disabled={busy}>
              Leave
            </button>
          )}
        </div>
      </div>

      <div className="lobby__card">
        <div className="lobby__settings-header">
          <h2>Game settings</h2>
          {isHost && !editingSettings && (
            <button type="button" className="lobby__button" onClick={openSettingsEditor} disabled={busy}>
              Edit
            </button>
          )}
        </div>

        <MapPreview mapPreset={previewPreset} />

        {editingSettings && settingsDraft ? (
          <div className="lobby__settings-form">
            <label className="lobby__field">
              <span>Map</span>
              <select
                value={settingsDraft.mapPreset}
                onChange={(e) => setSettingsDraft({ ...settingsDraft, mapPreset: e.target.value as MapPresetId })}
              >
                {MAP_PRESETS.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="lobby__field">
              <span>Victory points to win ({VP_MIN}–{VP_MAX})</span>
              <input
                type="number"
                min={VP_MIN}
                max={VP_MAX}
                value={settingsDraft.victoryPointsToWin}
                onChange={(e) =>
                  setSettingsDraft({
                    ...settingsDraft,
                    victoryPointsToWin: Math.min(VP_MAX, Math.max(VP_MIN, Number(e.target.value) || VP_MIN)),
                  })
                }
              />
            </label>
            <label className="lobby__field">
              <span>Discard limit ({DISCARD_MIN}–{DISCARD_MAX})</span>
              <input
                type="number"
                min={DISCARD_MIN}
                max={DISCARD_MAX}
                value={settingsDraft.discardLimit}
                onChange={(e) =>
                  setSettingsDraft({
                    ...settingsDraft,
                    discardLimit: Math.min(DISCARD_MAX, Math.max(DISCARD_MIN, Number(e.target.value) || DISCARD_MIN)),
                  })
                }
              />
            </label>
            <label className="lobby__field lobby__field--checkbox">
              <input
                type="checkbox"
                checked={settingsDraft.turnTimerSeconds !== null}
                onChange={(e) =>
                  setSettingsDraft({
                    ...settingsDraft,
                    turnTimerSeconds: e.target.checked ? DEFAULT_TURN_TIMER_SECONDS_FALLBACK : null,
                  })
                }
              />
              <span>Turn timer</span>
            </label>
            {settingsDraft.turnTimerSeconds !== null && (
              <label className="lobby__field">
                <span>Seconds per turn ({TURN_TIMER_MIN}–{TURN_TIMER_MAX})</span>
                <input
                  type="number"
                  min={TURN_TIMER_MIN}
                  max={TURN_TIMER_MAX}
                  value={settingsDraft.turnTimerSeconds}
                  onChange={(e) =>
                    setSettingsDraft({
                      ...settingsDraft,
                      turnTimerSeconds: Math.min(
                        TURN_TIMER_MAX,
                        Math.max(TURN_TIMER_MIN, Number(e.target.value) || TURN_TIMER_MIN),
                      ),
                    })
                  }
                />
              </label>
            )}
            <div className="lobby__settings-form-actions">
              <button
                type="button"
                className="lobby__button"
                onClick={() => {
                  setEditingSettings(false);
                  setSettingsDraft(null);
                }}
                disabled={busy}
              >
                Cancel
              </button>
              <button type="button" className="lobby__button lobby__button--primary" onClick={handleSaveSettings} disabled={busy}>
                Save
              </button>
            </div>
          </div>
        ) : (
          <dl className="lobby__settings">
            <div className="lobby__settings-row">
              <dt>Map</dt>
              <dd>
                {preset?.name ?? room.mapPreset}
                {preset && <div className="lobby__settings-desc">{preset.description}</div>}
              </dd>
            </div>
            <div className="lobby__settings-row">
              <dt>Victory points to win</dt>
              <dd>{room.victoryPointsToWin}</dd>
            </div>
            <div className="lobby__settings-row">
              <dt>Discard limit</dt>
              <dd>{room.discardLimit}</dd>
            </div>
            <div className="lobby__settings-row">
              <dt>Turn timer</dt>
              <dd>{room.turnTimerSeconds ? `${room.turnTimerSeconds}s` : 'Off'}</dd>
            </div>
          </dl>
        )}
      </div>
    </div>
  );
}
