import { useState, type JSX } from 'react';
import { useGameStore } from '../state/store';
import { addBot, removeSeat, startGame } from '../firebase/rooms';
import { MAP_PRESETS } from '@catan/engine';
import { PLAYER_COLORS } from '@catan/engine';
import { PLAYER_COLOR_HEX } from '../components/playerColors';
import './Lobby.css';

const MAX_SEATS = PLAYER_COLORS.length;

export default function Lobby(): JSX.Element {
  const uid = useGameStore((s) => s.uid);
  const roomId = useGameStore((s) => s.roomId);
  const room = useGameStore((s) => s.room);
  const players = useGameStore((s) => s.players);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

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
          {seats.map((p) => (
            <li key={p.uid} className="lobby__seat">
              <span
                className="lobby__swatch"
                style={{ background: PLAYER_COLOR_HEX[p.color] }}
              />
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
            </li>
          ))}
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
        <h2>Game settings</h2>
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
      </div>
    </div>
  );
}
