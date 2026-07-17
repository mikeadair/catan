import { useEffect, useRef, useState } from 'react';
import { useAuthUid } from './firebase/auth';
import { useGameStore, getLastRoomId } from './state/store';
import { unlockAudio, isMuted, setMuted, playSfx } from './audio/sfx';
import { SoundOnIcon, SoundOffIcon } from './components/gameIcons';
import Home from './routes/Home';
import Lobby from './routes/Lobby';
import Game from './routes/Game';
import './App.css';

function App() {
  const { uid, loading } = useAuthUid();
  const roomId = useGameStore((s) => s.roomId);
  const room = useGameStore((s) => s.room);
  const setUid = useGameStore((s) => s.setUid);
  const enterRoom = useGameStore((s) => s.enterRoom);
  const error = useGameStore((s) => s.error);
  const clearError = useGameStore((s) => s.clearError);
  const [muted, setMutedState] = useState(isMuted);

  useEffect(() => {
    if (uid) setUid(uid);
  }, [uid, setUid]);

  // Auto-rejoin the last room this browser was in, unless a room is already active.
  useEffect(() => {
    if (!uid || roomId) return;
    const last = getLastRoomId();
    if (last) enterRoom(last);
  }, [uid, roomId, enterRoom]);

  // Browsers suspend AudioContext until a user gesture; unlock on the first one.
  useEffect(() => {
    const handler = () => unlockAudio();
    window.addEventListener('pointerdown', handler, { once: true });
    return () => window.removeEventListener('pointerdown', handler);
  }, []);

  const lastErrorRef = useRef<string | null>(null);
  useEffect(() => {
    if (error && error !== lastErrorRef.current) playSfx('error');
    lastErrorRef.current = error;
  }, [error]);

  // Auto-dismiss the error toast so a missed click doesn't leave a stale error sitting on
  // screen indefinitely; a new error arriving resets the timer.
  useEffect(() => {
    if (!error) return;
    const timer = setTimeout(clearError, 4000);
    return () => clearTimeout(timer);
  }, [error, clearError]);

  function toggleMute() {
    const next = !muted;
    setMuted(next);
    setMutedState(next);
  }

  if (loading || !uid) {
    return (
      <div className="app-loading">
        <div className="app-loading__spinner" />
        <p>Connecting…</p>
      </div>
    );
  }

  return (
    <>
      {error && (
        <div key={error} className="toast toast--error" onClick={clearError} role="alert">
          {error}
        </div>
      )}
      <button
        type="button"
        className="sound-toggle"
        onClick={toggleMute}
        aria-label={muted ? 'Unmute sound' : 'Mute sound'}
        title={muted ? 'Unmute sound' : 'Mute sound'}
      >
        {muted ? <SoundOffIcon className="sound-toggle__icon" /> : <SoundOnIcon className="sound-toggle__icon" />}
      </button>
      {!roomId || !room ? <Home uid={uid} /> : room.status === 'lobby' ? <Lobby /> : <Game />}
    </>
  );
}

export default App;
