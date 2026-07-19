import { useEffect, useRef, useState, type JSX } from 'react';
import { customAlphabet } from 'nanoid';
import { createRoom, joinRoom } from '../firebase/rooms';
import {
  setDisplayName,
  useAuthUser,
  signInOrLinkWithPassword,
  sendEmailSignInLink,
  isEmailLinkPending,
  getStoredEmailForSignIn,
  completeEmailLinkSignIn,
  signOutToGuest,
} from '../firebase/auth';
import { getUserProfile, saveUserProfile } from '../firebase/users';
import { useGameStore } from '../state/store';
import { PLAYER_COLORS, type MapPresetId, type PlayerColor } from '@catan/engine';
import { PLAYER_COLOR_HEX } from '../components/playerColors';
import MapPickerGrid from '../components/MapPickerGrid';
import SailingShip from '../components/SailingShip';
import './Home.css';

const DISPLAY_NAME_KEY = 'catan.displayName';
const COLOR_KEY = 'catan.preferredColor';
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

function loadStoredColor(): PlayerColor {
  try {
    const stored = localStorage.getItem(COLOR_KEY) as PlayerColor | null;
    if (stored && (PLAYER_COLORS as readonly string[]).includes(stored)) return stored;
  } catch {
    // localStorage unavailable — fall through to the default.
  }
  return PLAYER_COLORS[0];
}

function persistColor(color: PlayerColor) {
  try {
    localStorage.setItem(COLOR_KEY, color);
  } catch {
    // non-fatal
  }
}

export default function Home({ uid }: { uid: string }): JSX.Element {
  const [name, setName] = useState<string>(loadStoredName);
  const [color, setColor] = useState<PlayerColor>(loadStoredColor);

  const [selectedPreset, setSelectedPreset] = useState<MapPresetId>('official-beginner');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const [joinCode, setJoinCode] = useState('');
  const [joining, setJoining] = useState(false);
  const [joinError, setJoinError] = useState<string | null>(null);
  const joinInputRef = useRef<HTMLInputElement | null>(null);

  // --- Account (optional upgrade from the default anonymous/guest session) ---
  const authUser = useAuthUser();
  const [authOpen, setAuthOpen] = useState(false);
  const [authMode, setAuthMode] = useState<'password' | 'link'>('password');
  const [authEmail, setAuthEmail] = useState('');
  const [authPassword, setAuthPassword] = useState('');
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [authMessage, setAuthMessage] = useState<string | null>(null);
  // Set once we've detected a completed email-sign-in link but don't have a stored email
  // for it (i.e. the link is being opened on a different device than it was sent from).
  const [needsEmailForLink, setNeedsEmailForLink] = useState(false);

  const profileFetchedForUid = useRef<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const codeFromUrl = params.get('join');
    if (codeFromUrl) {
      setJoinCode(codeFromUrl.toUpperCase());
      joinInputRef.current?.focus();
    }
  }, []);

  // Completing an email sign-in link: on load, if the current URL is a sign-in link,
  // finish the flow with the email stashed in localStorage before the link was sent
  // (same-device case), or prompt for it inline (different-device case).
  useEffect(() => {
    if (!isEmailLinkPending()) return;
    setAuthOpen(true);
    setAuthMode('link');
    const storedEmail = getStoredEmailForSignIn();
    if (!storedEmail) {
      setNeedsEmailForLink(true);
      return;
    }
    setAuthBusy(true);
    completeEmailLinkSignIn(storedEmail)
      .then(() => {
        setAuthMessage('Signed in.');
        setAuthOpen(false);
      })
      .catch((err: unknown) => {
        setAuthError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setAuthBusy(false));
  }, []);

  // Once signed in with a real (non-anonymous) account, prefill name/color from the
  // persisted users/{uid} profile, if one exists.
  useEffect(() => {
    if (authUser.isAnonymous || !authUser.uid) return;
    if (profileFetchedForUid.current === authUser.uid) return;
    profileFetchedForUid.current = authUser.uid;
    getUserProfile(authUser.uid)
      .then((profile) => {
        if (!profile) return;
        setName(profile.displayName);
        persistName(profile.displayName);
        setColor(profile.color);
        persistColor(profile.color);
      })
      .catch(() => {
        // Non-fatal — just keep whatever was already in the form.
      });
  }, [authUser.isAnonymous, authUser.uid]);

  /** Strips a consumed ?join=CODE from the URL once a room has actually been entered, so a
   * later refresh auto-rejoins (App.tsx) instead of deferring to the invite link and dumping
   * the player back here. Deliberately NOT done on mount when the code is merely prefilled —
   * until the join succeeds, the param still needs to win over a stale last-room auto-rejoin. */
  function clearJoinParamFromUrl() {
    const params = new URLSearchParams(window.location.search);
    if (!params.has('join')) return;
    params.delete('join');
    const qs = params.toString();
    window.history.replaceState({}, '', qs ? `${window.location.pathname}?${qs}` : window.location.pathname);
  }

  function handleNameChange(value: string) {
    setName(value);
    persistName(value);
  }

  function handleColorChange(value: PlayerColor) {
    setColor(value);
    persistColor(value);
  }

  function effectiveName(): string {
    const trimmed = name.trim();
    return trimmed || loadStoredName();
  }

  /** Persists name/color to the account profile — only meaningful once signed in for real. */
  async function saveProfileIfSignedIn(finalName: string) {
    if (authUser.isAnonymous || !authUser.uid) return;
    try {
      await saveUserProfile(authUser.uid, { displayName: finalName, color });
    } catch {
      // Non-fatal — room create/join already succeeded.
    }
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setCreateError(null);
    setCreating(true);
    try {
      const finalName = effectiveName();
      persistName(finalName);
      setDisplayName(finalName).catch(() => {});
      // Other room settings (victory points, discard limit, turn timer, safe mode) are left
      // at createRoom's own sensible defaults — the host can change them from the lobby's
      // "Game settings" panel once the room exists (see Lobby.tsx), rather than choosing them
      // up front before there's even a room to configure.
      const { roomId } = await createRoom(uid, finalName, selectedPreset, {
        preferredColor: color,
      });
      await saveProfileIfSignedIn(finalName);
      clearJoinParamFromUrl();
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
      const roomId = await joinRoom(joinCode, uid, finalName, color);
      await saveProfileIfSignedIn(finalName);
      clearJoinParamFromUrl();
      useGameStore.getState().enterRoom(roomId);
    } catch (err) {
      setJoinError(err instanceof Error ? err.message : String(err));
    } finally {
      setJoining(false);
    }
  }

  async function handlePasswordAuth(e: React.FormEvent) {
    e.preventDefault();
    setAuthError(null);
    setAuthMessage(null);
    setAuthBusy(true);
    try {
      await signInOrLinkWithPassword(authEmail.trim(), authPassword);
      setAuthMessage('Signed in.');
      setAuthPassword('');
      setAuthOpen(false);
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : String(err));
    } finally {
      setAuthBusy(false);
    }
  }

  async function handleSendLink(e: React.FormEvent) {
    e.preventDefault();
    setAuthError(null);
    setAuthMessage(null);
    setAuthBusy(true);
    try {
      await sendEmailSignInLink(authEmail.trim());
      setAuthMessage('Check your email for a sign-in link.');
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : String(err));
    } finally {
      setAuthBusy(false);
    }
  }

  async function handleCompleteLinkWithEmail(e: React.FormEvent) {
    e.preventDefault();
    setAuthError(null);
    setAuthBusy(true);
    try {
      await completeEmailLinkSignIn(authEmail.trim());
      setAuthMessage('Signed in.');
      setNeedsEmailForLink(false);
      setAuthOpen(false);
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : String(err));
    } finally {
      setAuthBusy(false);
    }
  }

  async function handleSignOut() {
    setAuthBusy(true);
    setAuthError(null);
    try {
      await signOutToGuest();
      setAuthMessage(null);
      profileFetchedForUid.current = null;
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : String(err));
    } finally {
      setAuthBusy(false);
    }
  }

  return (
    <div className="home">
      <SailingShip layerClassName="home__ship-layer" topRange={[6, 20]} />

      <div className="home__intro">
        <h1 className="home__title">Settlers of Catan</h1>
        <p className="home__subtitle">Trade, build, and settle with friends — online.</p>
      </div>

      <div className="home__card home__card--name">
        <div className="home__card-header">
          <h2>Play as</h2>
          {!authUser.isAnonymous && authUser.email ? (
            <div className="home__account-badge">
              <span className="home__account-badge-label">Signed in as</span>
              <span className="home__account-badge-email" title={authUser.email}>
                {authUser.email}
              </span>
              <button type="button" className="home__link-button" onClick={handleSignOut} disabled={authBusy}>
                Sign out
              </button>
            </div>
          ) : (
            <button
              type="button"
              className="home__link-button"
              onClick={() => setAuthOpen((v) => !v)}
              aria-expanded={authOpen}
            >
              Sign in / create account
            </button>
          )}
        </div>

        {authOpen && authUser.isAnonymous && (
          <div className="home__auth-panel">
            {needsEmailForLink ? (
              <form className="home__auth-form" onSubmit={handleCompleteLinkWithEmail}>
                <p className="home__field-hint">
                  Confirm the email this sign-in link was sent to, to finish signing in.
                </p>
                <input
                  className="home__input"
                  type="email"
                  required
                  placeholder="you@example.com"
                  value={authEmail}
                  onChange={(e) => setAuthEmail(e.target.value)}
                />
                <button type="submit" className="home__button home__button--primary" disabled={authBusy}>
                  {authBusy ? 'Signing in…' : 'Finish sign-in'}
                </button>
              </form>
            ) : (
              <>
                <div className="home__auth-tabs">
                  <button
                    type="button"
                    className={`home__auth-tab${authMode === 'password' ? ' home__auth-tab--active' : ''}`}
                    onClick={() => setAuthMode('password')}
                  >
                    Email &amp; password
                  </button>
                  <button
                    type="button"
                    className={`home__auth-tab${authMode === 'link' ? ' home__auth-tab--active' : ''}`}
                    onClick={() => setAuthMode('link')}
                  >
                    Email link
                  </button>
                </div>

                {authMode === 'password' ? (
                  <form className="home__auth-form" onSubmit={handlePasswordAuth}>
                    <input
                      className="home__input"
                      type="email"
                      required
                      placeholder="you@example.com"
                      value={authEmail}
                      onChange={(e) => setAuthEmail(e.target.value)}
                      autoComplete="email"
                    />
                    <input
                      className="home__input"
                      type="password"
                      required
                      minLength={6}
                      placeholder="Password"
                      value={authPassword}
                      onChange={(e) => setAuthPassword(e.target.value)}
                      autoComplete="current-password"
                    />
                    <span className="home__field-hint">
                      New here? This creates your account. Already signed up? This logs you in.
                    </span>
                    <button type="submit" className="home__button home__button--primary" disabled={authBusy}>
                      {authBusy ? 'Working…' : 'Continue'}
                    </button>
                  </form>
                ) : (
                  <form className="home__auth-form" onSubmit={handleSendLink}>
                    <input
                      className="home__input"
                      type="email"
                      required
                      placeholder="you@example.com"
                      value={authEmail}
                      onChange={(e) => setAuthEmail(e.target.value)}
                      autoComplete="email"
                    />
                    <span className="home__field-hint">We'll email you a link — no password needed.</span>
                    <button type="submit" className="home__button home__button--primary" disabled={authBusy}>
                      {authBusy ? 'Sending…' : 'Send sign-in link'}
                    </button>
                  </form>
                )}
              </>
            )}

            {authError && <div className="home__error">{authError}</div>}
            {authMessage && <div className="home__auth-message">{authMessage}</div>}
          </div>
        )}

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

        <span className="home__label">Preferred color</span>
        <div className="home__color-row">
          {PLAYER_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              className={`home__swatch${c === color ? ' home__swatch--selected' : ''}`}
              style={{ background: PLAYER_COLOR_HEX[c] }}
              onClick={() => handleColorChange(c)}
              aria-label={`Use ${c}`}
              title={c}
            />
          ))}
        </div>
      </div>

      <div className="home__grid">
        <form className="home__card" onSubmit={handleCreate}>
          <h2>Create a room</h2>

          <div className="home__fieldset">
            <span className="home__label">Map</span>
            <MapPickerGrid selected={selectedPreset} onSelect={setSelectedPreset} />
          </div>

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
