import { useEffect } from 'react';
import { useAuthUid } from './firebase/auth';
import { useGameStore, getLastRoomId } from './state/store';
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

  useEffect(() => {
    if (uid) setUid(uid);
  }, [uid, setUid]);

  // Auto-rejoin the last room this browser was in, unless a room is already active.
  useEffect(() => {
    if (!uid || roomId) return;
    const last = getLastRoomId();
    if (last) enterRoom(last);
  }, [uid, roomId, enterRoom]);

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
        <div className="toast toast--error" onClick={clearError} role="alert">
          {error}
        </div>
      )}
      {!roomId || !room ? <Home uid={uid} /> : room.status === 'lobby' ? <Lobby /> : <Game />}
    </>
  );
}

export default App;
