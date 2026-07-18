import { Fragment, useEffect, useRef, useState, type JSX } from 'react';
import type { LogEntry, LogEntryMeta, PublicPlayer, ResourceCount } from '@catan/engine';
import { RESOURCES } from '@catan/engine';
import type { ChatMessage } from '../firebase/rooms';
import { RESOURCE_ICON, RESOURCE_LABEL } from './resourceIcons';
import { PLAYER_COLOR_HEX } from './playerColors';
import { PauseIcon } from './gameIcons';
import './GameLog.css';

export interface GameLogProps {
  log: LogEntry[];
  chat: ChatMessage[];
  players: Record<string, PublicPlayer>;
  /**
   * Seat order (room.turnOrder). Used to render multi-player gain rows (see `LogMeta`'s
   * `diceRoll` case) in a fixed, deterministic order instead of relying on
   * `Object.entries` key-iteration order — which sorts any integer-like string keys in
   * ascending numeric order regardless of insertion order — so row order can't shift
   * depending on uid string shape.
   */
  turnOrder: string[];
  onSend: (text: string) => void;
}

type TimelineItem =
  | { kind: 'log'; id: string; ts: number; message: string; meta?: LogEntryMeta }
  | { kind: 'chat'; id: string; ts: number; displayName: string; text: string };

const LOG_FILTERS = ['all', 'events', 'chat'] as const;
type LogFilter = (typeof LOG_FILTERS)[number];
const LOG_FILTER_LABEL: Record<LogFilter, string> = { all: 'All', events: 'Game', chat: 'Chat' };

const LOG_SIZES = ['small', 'medium', 'large'] as const;
type LogSize = (typeof LOG_SIZES)[number];
const LOG_SIZE_LABEL: Record<LogSize, string> = { small: 'S', medium: 'M', large: 'L' };

// Standard 3x3 pip layout per die face, indices into a 9-cell grid (row-major).
const DIE_PIPS: Record<number, number[]> = {
  1: [4],
  2: [0, 8],
  3: [0, 4, 8],
  4: [0, 2, 6, 8],
  5: [0, 2, 4, 6, 8],
  6: [0, 2, 3, 5, 6, 8],
};

function Die({ value }: { value: number }): JSX.Element {
  const active = new Set(DIE_PIPS[value] ?? []);
  return (
    <span className="game-log__die">
      {Array.from({ length: 9 }, (_, i) => (
        <span key={i} className={active.has(i) ? 'game-log__die-pip game-log__die-pip--on' : 'game-log__die-pip'} />
      ))}
    </span>
  );
}

function DicePips({ roll }: { roll: [number, number] }): JSX.Element {
  return (
    <span className="game-log__dice" role="img" aria-label={`Rolled ${roll[0]} and ${roll[1]}`}>
      <Die value={roll[0]} />
      <Die value={roll[1]} />
    </span>
  );
}

/** Small resource-card icons with ×N badges, reusing the same art as the hand/bank views. */
function MiniResources({ resources }: { resources: Partial<ResourceCount> }): JSX.Element {
  return (
    <span className="game-log__resources">
      {RESOURCES.filter((r) => (resources[r] ?? 0) > 0).map((r) => (
        <span key={r} className="game-log__resource" title={RESOURCE_LABEL[r]}>
          <img src={RESOURCE_ICON[r]} alt={RESOURCE_LABEL[r]} className="game-log__resource-icon" />
          {(resources[r] ?? 0) > 1 && <span className="game-log__resource-count">×{resources[r]}</span>}
        </span>
      ))}
    </span>
  );
}

function playerLabel(uid: string, players: Record<string, PublicPlayer>): JSX.Element {
  const p = players[uid];
  return (
    <span className="game-log__gain-name" style={p ? { color: PLAYER_COLOR_HEX[p.color] } : undefined}>
      {p?.displayName ?? 'Someone'}
    </span>
  );
}

/** Renders the small inline graphics for a structured log entry, alongside its fallback text. */
function LogMeta({
  meta,
  players,
  turnOrder,
}: {
  meta: LogEntryMeta;
  players: Record<string, PublicPlayer>;
  turnOrder: string[];
}): JSX.Element | null {
  switch (meta.kind) {
    case 'diceRoll': {
      // Iterate the room's fixed seat order and look up each uid in meta.gains, rather
      // than Object.entries(meta.gains) — Object.entries iterates integer-like string
      // keys in ascending numeric order regardless of insertion order, which would make
      // this row's internal player order depend on uid string shape (and could appear to
      // shift as unrelated state elsewhere changes key shape). Seat order is stable for
      // the life of the room, so this guarantees a consistent render order every time.
      const gains = meta.gains;
      const gainEntries = gains ? turnOrder.filter((uid) => gains[uid]).map((uid): [string, Partial<ResourceCount>] => [uid, gains[uid]!]) : [];
      return (
        <>
          <DicePips roll={meta.roll} />
          {gainEntries.length > 0 && (
            <div className="game-log__gains">
              {gainEntries.map(([uid, resources]) => (
                <span key={uid} className="game-log__gain-row">
                  {playerLabel(uid, players)}
                  <MiniResources resources={resources} />
                </span>
              ))}
            </div>
          )}
        </>
      );
    }
    case 'resourceGain':
      return <MiniResources resources={meta.resources} />;
    case 'resourceTrade':
      return (
        <span className="game-log__trade">
          <MiniResources resources={meta.give} />
          <span className="game-log__trade-arrow">→</span>
          <MiniResources resources={meta.receive} />
        </span>
      );
    default:
      return null;
  }
}

// How close to the bottom (in px) counts as "at the bottom" for the purposes of
// re-enabling auto-scroll when the user scrolls back down themselves.
const AUTO_SCROLL_RESUME_THRESHOLD_PX = 24;

export default function GameLog({ log, chat, players, turnOrder, onSend }: GameLogProps): JSX.Element {
  const [draft, setDraft] = useState('');
  const [autoScroll, setAutoScroll] = useState(true);
  const [logSize, setLogSize] = useState<LogSize>('medium');
  const [filter, setFilter] = useState<LogFilter>('all');
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // Set right before the effect below programmatically corrects scrollTop, cleared on the next
  // frame. Assigning scrollTop fires a native 'scroll' event same as a real user scroll would,
  // so without this, handleScroll reacts to our *own* correction — and if it fires a frame late
  // (e.g. a font/layout settle after paint) scrollHeight can have grown further in the meantime,
  // making the correction look short of the bottom and incorrectly flipping autoScroll off right
  // after a message that should have kept it on.
  const isAutoScrollingRef = useRef(false);

  const items: TimelineItem[] = [
    ...log.map((l): TimelineItem => ({ kind: 'log', id: l.id, ts: l.ts, message: l.message, meta: l.meta })),
    ...chat.map((c): TimelineItem => ({ kind: 'chat', id: c.id, ts: c.ts, displayName: c.displayName, text: c.text })),
  ].sort((a, b) => a.ts - b.ts);
  const visibleItems = filter === 'all' ? items : items.filter((i) => (filter === 'chat' ? i.kind === 'chat' : i.kind === 'log'));

  // Only force-scroll to the bottom on new entries while auto-scroll is on. Re-running
  // this whenever autoScroll flips back to true also handles "snap to bottom" the moment
  // the user re-enables it (either via the toggle button or by scrolling to the bottom
  // themselves, see handleScroll below). logSize is also a dependency: growing the text
  // size increases each row's height (and so scrollHeight) without touching items.length,
  // so without this a pinned-to-bottom view would otherwise fall a line or two short of
  // the true bottom right after sizing up.
  //
  // Keyed on the LAST item's id, not just the count: the engine caps room.log at 50
  // entries (addLog splices the oldest out), so once a game is long enough the list
  // *rotates* — every new entry arrives at a constant length, which is exactly when a
  // length-only dependency stops firing and auto-scroll silently dies mid-game.
  const lastItemId = visibleItems.length > 0 ? visibleItems[visibleItems.length - 1].id : null;
  useEffect(() => {
    if (!autoScroll) return;
    const el = scrollRef.current;
    if (!el) return;
    isAutoScrollingRef.current = true;
    el.scrollTop = el.scrollHeight;
    // Fallback in case the scrollTop assignment above turns out to be a no-op (already at the
    // bottom) and so never fires a native 'scroll' event for handleScroll to consume below —
    // without this, the flag would stay stuck "true" and swallow the next genuine user scroll.
    // Cancelled/rescheduled on every re-run so only the latest correction's fallback is live.
    const raf = requestAnimationFrame(() => {
      isAutoScrollingRef.current = false;
    });
    return () => cancelAnimationFrame(raf);
  }, [lastItemId, visibleItems.length, autoScroll, logSize, filter]);

  function handleScroll() {
    if (isAutoScrollingRef.current) {
      // The next 'scroll' event after we programmatically set scrollTop above is our own
      // correction, not user input — consume exactly that one event instead of racing a fixed
      // rAF window against it. A fixed-window race is what let this fall over in practice: a
      // scroll event arriving a frame late (bursts of new log entries during a bot's turn, or
      // residual scroll momentum right as the user clicks the toggle) landed after the rAF
      // fallback above had already cleared the flag, got misread as "the user scrolled away",
      // and flipped autoScroll back off moments after it was turned on.
      isAutoScrollingRef.current = false;
      return;
    }
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    setAutoScroll(distanceFromBottom <= AUTO_SCROLL_RESUME_THRESHOLD_PX);
  }

  function cycleLogSize() {
    setLogSize((prev) => LOG_SIZES[(LOG_SIZES.indexOf(prev) + 1) % LOG_SIZES.length]);
  }

  function cycleFilter() {
    setFilter((prev) => LOG_FILTERS[(LOG_FILTERS.indexOf(prev) + 1) % LOG_FILTERS.length]);
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const text = draft.trim();
    if (!text) return;
    onSend(text);
    setDraft('');
  }

  return (
    <div className="game-log" data-log-size={logSize}>
      <div className="game-log__header-row">
        <div className="game-log__header">Log &amp; Chat</div>
        <div className="game-log__header-actions">
          <button
            type="button"
            className="game-log__icon-btn"
            aria-pressed={autoScroll}
            aria-label={autoScroll ? 'Auto-scroll is on — click to pause' : 'Auto-scroll is off — click to resume'}
            title={autoScroll ? 'Auto-scroll is on — click to pause' : 'Auto-scroll is off — click to resume'}
            onClick={() => setAutoScroll((prev) => !prev)}
          >
            {autoScroll ? '⬇' : <PauseIcon className="game-log__icon-svg" />}
          </button>
          <button
            type="button"
            className="game-log__icon-btn game-log__icon-btn--filter"
            aria-label={`Showing: ${LOG_FILTER_LABEL[filter]} — click to cycle (all / game events / chat)`}
            title={`Showing: ${LOG_FILTER_LABEL[filter]} — click to cycle (all / game events / chat)`}
            onClick={cycleFilter}
          >
            {LOG_FILTER_LABEL[filter]}
          </button>
          <button
            type="button"
            className="game-log__icon-btn game-log__icon-btn--size"
            aria-label={`Text size: ${logSize} — click to cycle`}
            title={`Text size: ${logSize} — click to cycle`}
            onClick={cycleLogSize}
          >
            {LOG_SIZE_LABEL[logSize]}
          </button>
        </div>
      </div>
      <div className="game-log__scroll" ref={scrollRef} onScroll={handleScroll}>
        {visibleItems.length === 0 && <div className="game-log__empty">No activity yet.</div>}
        {(() => {
          // Each turn opens with exactly one dice roll, so a roll entry doubles as a turn
          // boundary — number the dividers by counting rolls rather than threading a real
          // turnNumber through every log entry.
          let rollCount = 0;
          return visibleItems.map((item) => {
            const isRoll = item.kind === 'log' && item.meta?.kind === 'diceRoll';
            if (isRoll) rollCount++;
            return (
              <Fragment key={item.id}>
                {isRoll && <div className="game-log__turn-divider">Turn {rollCount}</div>}
                {item.kind === 'log' ? (
                  <div className="game-log__entry game-log__entry--system">
                    <span className="game-log__entry-row">
                      <span className="game-log__entry-text">{item.message}</span>
                      {item.meta && <LogMeta meta={item.meta} players={players} turnOrder={turnOrder} />}
                    </span>
                  </div>
                ) : (
                  <div className="game-log__entry game-log__entry--chat">
                    <span className="game-log__chat-name">{item.displayName}:</span> {item.text}
                  </div>
                )}
              </Fragment>
            );
          });
        })()}
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
