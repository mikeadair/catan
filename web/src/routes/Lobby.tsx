import { useState, type JSX } from 'react';
import { useGameStore } from '../state/store';
import { addBot, removeSeat, startGame, updatePlayerColor, updateRoomSettings } from '../firebase/rooms';
import { PLAYER_COLORS, type BotDifficulty, type MapPresetId, type PlayerColor } from '@catan/engine';
import { PLAYER_COLOR_HEX } from '../components/playerColors';
import MapPreview from '../components/MapPreview';
import MapPickerGrid from '../components/MapPickerGrid';
import './Lobby.css';

const MAX_SEATS = PLAYER_COLORS.length;
const VP_MIN = 5;
const VP_MAX = 15;
const DISCARD_MIN = 4;
const DISCARD_MAX = 12;
const TURN_TIMER_MIN = 30;
const TURN_TIMER_MAX = 600;
const DEFAULT_TURN_TIMER_SECONDS_FALLBACK = 120;
const TRADE_RESPONSE_TIMER_MIN = 5;
const TRADE_RESPONSE_TIMER_MAX = 60;
const DEFAULT_TRADE_RESPONSE_TIMER_SECONDS_FALLBACK = 15;
const BOT_DIFFICULTIES: BotDifficulty[] = ['easy', 'normal', 'hard'];
const BOT_DIFFICULTY_LABEL: Record<BotDifficulty, string> = { easy: 'Easy', normal: 'Normal', hard: 'Hard' };

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export default function Lobby(): JSX.Element {
  const uid = useGameStore((s) => s.uid);
  const roomId = useGameStore((s) => s.roomId);
  const room = useGameStore((s) => s.room);
  const players = useGameStore((s) => s.players);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [colorPickerOpen, setColorPickerOpen] = useState(false);
  const [botDifficulty, setBotDifficulty] = useState<BotDifficulty>('normal');

  if (!room || !roomId || !uid) {
    return (
      <div className="lobby-loading">
        <div className="lobby-loading__spinner" />
      </div>
    );
  }

  const isHost = uid === room.hostUid;
  const canStart = room.turnOrder.length >= 2;

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
    run(() => addBot(roomId!, botDifficulty));
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

  function handleChangeMap(id: MapPresetId) {
    run(() => updateRoomSettings(roomId!, { mapPreset: id }));
  }

  function handleChangeVictoryPoints(value: number) {
    run(() => updateRoomSettings(roomId!, { victoryPointsToWin: clamp(value, VP_MIN, VP_MAX) }));
  }

  function handleChangeDiscardLimit(value: number) {
    run(() => updateRoomSettings(roomId!, { discardLimit: clamp(value, DISCARD_MIN, DISCARD_MAX) }));
  }

  function handleToggleTurnTimer(enabled: boolean) {
    run(() =>
      updateRoomSettings(roomId!, { turnTimerSeconds: enabled ? DEFAULT_TURN_TIMER_SECONDS_FALLBACK : null }),
    );
  }

  function handleChangeTurnTimerSeconds(value: number) {
    run(() => updateRoomSettings(roomId!, { turnTimerSeconds: clamp(value, TURN_TIMER_MIN, TURN_TIMER_MAX) }));
  }

  function handleToggleTradeResponseTimer(enabled: boolean) {
    run(() =>
      updateRoomSettings(roomId!, {
        tradeResponseTimerSeconds: enabled ? DEFAULT_TRADE_RESPONSE_TIMER_SECONDS_FALLBACK : null,
      }),
    );
  }

  function handleChangeTradeResponseTimerSeconds(value: number) {
    run(() =>
      updateRoomSettings(roomId!, {
        tradeResponseTimerSeconds: clamp(value, TRADE_RESPONSE_TIMER_MIN, TRADE_RESPONSE_TIMER_MAX),
      }),
    );
  }

  function handleToggleSafeMode(enabled: boolean) {
    run(() => updateRoomSettings(roomId!, { safeMode: enabled }));
  }

  const seats = room.turnOrder
    .map((seatUid) => players[seatUid])
    .filter((p): p is NonNullable<typeof p> => !!p)
    .sort((a, b) => a.seatIndex - b.seatIndex);

  const openSeatCount = Math.max(0, MAX_SEATS - room.turnOrder.length);
  const fieldsDisabled = !isHost || busy;

  return (
    <div className="lobby">
      <div className="lobby__column lobby__column--left">
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
                  {p.isBot && (
                    <span className={`lobby__badge lobby__badge--difficulty-${p.botDifficulty ?? 'normal'}`}>
                      {BOT_DIFFICULTY_LABEL[p.botDifficulty ?? 'normal']}
                    </span>
                  )}
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
                <select
                  className="lobby__bot-difficulty"
                  value={botDifficulty}
                  disabled={busy || room.turnOrder.length >= MAX_SEATS}
                  onChange={(e) => setBotDifficulty(e.target.value as BotDifficulty)}
                  aria-label="Bot difficulty"
                >
                  {BOT_DIFFICULTIES.map((d) => (
                    <option key={d} value={d}>
                      {BOT_DIFFICULTY_LABEL[d]}
                    </option>
                  ))}
                </select>
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
                <button className="lobby__button lobby__button--danger" onClick={handleLeave} disabled={busy}>
                  Leave
                </button>
              </>
            ) : (
              <button className="lobby__button lobby__button--danger" onClick={handleLeave} disabled={busy}>
                Leave
              </button>
            )}
          </div>
        </div>
      </div>

      <div className="lobby__column lobby__column--right">
        <div className="lobby__card">
          <h2>Game settings</h2>

          <MapPreview mapPreset={room.mapPreset} />

          <MapPickerGrid
            selected={room.mapPreset}
            onSelect={isHost ? handleChangeMap : undefined}
            disabled={busy}
          />

          <div className="lobby__settings-form">
            <label className="lobby__field">
              <span>
                Victory points to win ({VP_MIN}–{VP_MAX})
              </span>
              <input
                type="number"
                min={VP_MIN}
                max={VP_MAX}
                value={room.victoryPointsToWin}
                disabled={fieldsDisabled}
                onChange={(e) => handleChangeVictoryPoints(Number(e.target.value) || VP_MIN)}
              />
            </label>
            <label className="lobby__field">
              <span>
                Discard limit ({DISCARD_MIN}–{DISCARD_MAX})
              </span>
              <input
                type="number"
                min={DISCARD_MIN}
                max={DISCARD_MAX}
                value={room.discardLimit}
                disabled={fieldsDisabled}
                onChange={(e) => handleChangeDiscardLimit(Number(e.target.value) || DISCARD_MIN)}
              />
            </label>
            <label className="lobby__field lobby__field--checkbox">
              <input
                type="checkbox"
                checked={room.turnTimerSeconds !== null}
                disabled={fieldsDisabled}
                onChange={(e) => handleToggleTurnTimer(e.target.checked)}
              />
              <span>Turn timer</span>
            </label>
            {room.turnTimerSeconds !== null && (
              <label className="lobby__field">
                <span>
                  Seconds per turn ({TURN_TIMER_MIN}–{TURN_TIMER_MAX})
                </span>
                <input
                  type="number"
                  min={TURN_TIMER_MIN}
                  max={TURN_TIMER_MAX}
                  value={room.turnTimerSeconds}
                  disabled={fieldsDisabled}
                  onChange={(e) => handleChangeTurnTimerSeconds(Number(e.target.value) || TURN_TIMER_MIN)}
                />
              </label>
            )}
            <label className="lobby__field lobby__field--checkbox">
              <input
                type="checkbox"
                checked={room.tradeResponseTimerSeconds !== null}
                disabled={fieldsDisabled}
                onChange={(e) => handleToggleTradeResponseTimer(e.target.checked)}
              />
              <span>Trade response timer</span>
            </label>
            {room.tradeResponseTimerSeconds !== null && (
              <label className="lobby__field">
                <span>
                  Seconds to respond to a trade ({TRADE_RESPONSE_TIMER_MIN}–{TRADE_RESPONSE_TIMER_MAX})
                </span>
                <input
                  type="number"
                  min={TRADE_RESPONSE_TIMER_MIN}
                  max={TRADE_RESPONSE_TIMER_MAX}
                  value={room.tradeResponseTimerSeconds}
                  disabled={fieldsDisabled}
                  onChange={(e) =>
                    handleChangeTradeResponseTimerSeconds(Number(e.target.value) || TRADE_RESPONSE_TIMER_MIN)
                  }
                />
              </label>
            )}
            <label className="lobby__field lobby__field--checkbox">
              <input
                type="checkbox"
                checked={room.safeMode}
                disabled={fieldsDisabled}
                onChange={(e) => handleToggleSafeMode(e.target.checked)}
              />
              <span title="The robber can't target a player with fewer than 3 victory points">Safe mode</span>
            </label>
          </div>
        </div>
      </div>
    </div>
  );
}
