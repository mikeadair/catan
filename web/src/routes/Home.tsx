import { useEffect, useRef, useState, type JSX } from 'react';
import { customAlphabet } from 'nanoid';
import { createRoom, joinRoom } from '../firebase/rooms';
import { setDisplayName } from '../firebase/auth';
import { useGameStore } from '../state/store';
import { MAP_PRESETS } from '../game/mapPresets';
import {
  DEFAULT_VICTORY_POINTS_TO_WIN,
  DEFAULT_DISCARD_LIMIT,
  type MapPresetId,
} from '../game/types';
import './Home.css';

const DISPLAY_NAME_KEY = 'catan.displayName';
const randomSuffix = customAlphabet('0123456789', 4);

function loadStoredName(): string {
  try {
    const stored = localStorage.getItem(DISPLAY_NAME_KEY);
    if (stored && stored.trim()) return stored;
  } catch {
    // localStorage unavailable — fall through to a generated default.
  }
  return `Player${randomSuffix()}`;
}

function persistName(name: string) {
  try {
    localStorage.setItem(DISPLAY_NAME_KEY, name);
  } catch {
    // non-fatal
  }
}

const VP_MIN = 5;
const VP_MAX = 15;
const DISCARD_MIN = 4;
const DISCARD_MAX = 12;

export default function Home({ uid }: { uid: string }): JSX.Element {
  const [name, setName] = useState<string>(loadStoredName);

  const [selectedPreset, setSelectedPreset] = useState<MapPresetId>('official-beginner');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [victoryPointsToWin, setVictoryPointsToWin] = useState(DEFAULT_VICTORY_POINTS_TO_WIN);
  const [discardLimit, setDiscardLimit] = useState(DEFAULT_DISCARD_LIMIT);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const [joinCode, setJoinCode] = useState('');
  const [joining, setJoining] = useState(false);
  const [joinError, setJoinError] = useState<string | null>(null);
  const joinInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const codeFromUrl = params.get('join');
    if (codeFromUrl) {
      setJoinCode(codeFromUrl.toUpperCase());
      joinInputRef.current?.focus();
    }
  }, []);

  function handleNameChange(value: string) {
    setName(value);
    persistName(value);
  }

  function effectiveName(): string {
    const trimmed = name.trim();
    return trimmed || loadStoredName();
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setCreateError(null);
    setCreating(true);
    try {
      const finalName = effectiveName();
      persistName(finalName);
      setDisplayName(finalName).catch(() => {});
      const { roomId } = await createRoom(uid, finalName, selectedPreset, {
        victoryPointsToWin,
        discardLimit,
      });
      useGameStore.getState().enterRoom(roomId);
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  }

  async function handleJoin(e: React.FormEvent) {
    e.preventDefault();
    setJoinError(null);
    setJoining(true);
    try {
      const finalName = effectiveName();
      persistName(finalName);
      setDisplayName(finalName).catch(() => {});
      const roomId = await joinRoom(joinCode, uid, finalName);
      useGameStore.getState().enterRoom(roomId);
    } catch (err) {
      setJoinError(err instanceof Error ? err.message : String(err));
    } finally {
      setJoining(false);
    }
  }

  return (
    <div className="home">
      <div className="home__intro">
        <h1 className="home__title">Settlers of Catan</h1>
        <p className="home__subtitle">Trade, build, and settle with friends — online.</p>
      </div>

      <div className="home__card home__card--name">
        <label className="home__label" htmlFor="display-name">
          Your name
        </label>
        <input
          id="display-name"
          className="home__input"
          type="text"
          maxLength={24}
          value={name}
          onChange={(e) => handleNameChange(e.target.value)}
          placeholder="Player name"
        />
      </div>

      <div className="home__grid">
        <form className="home__card" onSubmit={handleCreate}>
          <h2>Create a room</h2>

          <fieldset className="home__fieldset">
            <legend className="home__label">Map</legend>
            <div className="home__preset-list">
              {MAP_PRESETS.map((preset) => (
                <label
                  key={preset.id}
                  className={`home__preset-card${
                    selectedPreset === preset.id ? ' home__preset-card--selected' : ''
                  }`}
                >
                  <input
                    type="radio"
                    name="map-preset"
                    value={preset.id}
                    checked={selectedPreset === preset.id}
                    onChange={() => setSelectedPreset(preset.id)}
                  />
                  <div className="home__preset-card-body">
                    <div className="home__preset-card-name">{preset.name}</div>
                    <div className="home__preset-card-desc">{preset.description}</div>
                  </div>
                </label>
              ))}
            </div>
          </fieldset>

          <button
            type="button"
            className="home__advanced-toggle"
            onClick={() => setShowAdvanced((v) => !v)}
            aria-expanded={showAdvanced}
          >
            {showAdvanced ? 'Hide' : 'Show'} house rules
          </button>

          {showAdvanced && (
            <div className="home__advanced">
              <label className="home__field">
                <span className="home__label">Victory points to win</span>
                <input
                  type="number"
                  min={VP_MIN}
                  max={VP_MAX}
                  value={victoryPointsToWin}
                  onChange={(e) =>
                    setVictoryPointsToWin(
                      Math.min(VP_MAX, Math.max(VP_MIN, Number(e.target.value) || VP_MIN))
                    )
                  }
                />
              </label>
              <label className="home__field">
                <span className="home__label">Discard limit (hand size on a 7)</span>
                <input
                  type="number"
                  min={DISCARD_MIN}
                  max={DISCARD_MAX}
                  value={discardLimit}
                  onChange={(e) =>
                    setDiscardLimit(
                      Math.min(DISCARD_MAX, Math.max(DISCARD_MIN, Number(e.target.value) || DISCARD_MIN))
                    )
                  }
                />
              </label>
            </div>
          )}

          {createError && <div className="home__error">{createError}</div>}

          <button type="submit" className="home__button home__button--primary" disabled={creating}>
            {creating ? 'Creating…' : 'Create room'}
          </button>
        </form>

        <form className="home__card" onSubmit={handleJoin}>
          <h2>Join a room</h2>
          <label className="home__field">
            <span className="home__label">Room code</span>
            <input
              ref={joinInputRef}
              className="home__input home__input--code"
              type="text"
              maxLength={5}
              value={joinCode}
              onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
              placeholder="ABCDE"
              autoCapitalize="characters"
              autoCorrect="off"
              spellCheck={false}
            />
          </label>

          {joinError && <div className="home__error">{joinError}</div>}

          <button
            type="submit"
            className="home__button home__button--primary"
            disabled={joining || joinCode.trim().length !== 5}
          >
            {joining ? 'Joining…' : 'Join room'}
          </button>
        </form>
      </div>
    </div>
  );
}
