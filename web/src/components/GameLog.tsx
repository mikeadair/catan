import { useEffect, useRef, useState, type JSX } from 'react';
import type { LogEntry } from '../game/types';
import type { ChatMessage } from '../firebase/rooms';
import './GameLog.css';

export interface GameLogProps {
  log: LogEntry[];
  chat: ChatMessage[];
  onSend: (text: string) => void;
}

type TimelineItem =
  | { kind: 'log'; id: string; ts: number; message: string }
  | { kind: 'chat'; id: string; ts: number; displayName: string; text: string };

export default function GameLog({ log, chat, onSend }: GameLogProps): JSX.Element {
  const [draft, setDraft] = useState('');
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const items: TimelineItem[] = [
    ...log.map((l): TimelineItem => ({ kind: 'log', id: l.id, ts: l.ts, message: l.message })),
    ...chat.map((c): TimelineItem => ({ kind: 'chat', id: c.id, ts: c.ts, displayName: c.displayName, text: c.text })),
  ].sort((a, b) => a.ts - b.ts);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [items.length]);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const text = draft.trim();
    if (!text) return;
    onSend(text);
    setDraft('');
  }

  return (
    <div className="game-log">
      <div className="game-log__header">Log &amp; Chat</div>
      <div className="game-log__scroll" ref={scrollRef}>
        {items.length === 0 && <div className="game-log__empty">No activity yet.</div>}
        {items.map((item) =>
          item.kind === 'log' ? (
            <div key={item.id} className="game-log__entry game-log__entry--system">
              {item.message}
            </div>
          ) : (
            <div key={item.id} className="game-log__entry game-log__entry--chat">
              <span className="game-log__chat-name">{item.displayName}:</span> {item.text}
            </div>
          ),
        )}
      </div>
      <form className="game-log__form" onSubmit={handleSubmit}>
        <input
          className="game-log__input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Say something…"
          maxLength={280}
        />
        <button type="submit" className="game-log__send" disabled={!draft.trim()}>
          Send
        </button>
      </form>
    </div>
  );
}
