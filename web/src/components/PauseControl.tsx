import type { JSX } from 'react';
import type { PublicPlayer, RoomState } from '@catan/engine';
import { PauseIcon } from './gameIcons';
import './PauseControl.css';

export interface PauseControlProps {
  room: RoomState;
  players: Record<string, PublicPlayer>;
  uid: string;
  blocked: boolean;
  onVote: () => void;
}

export default function PauseControl({ room, players, uid, blocked, onVote }: PauseControlProps): JSX.Element | null {
  const self = players[uid];
  if (!self || self.isBot) return null;

  const nonBotUids = room.turnOrder.filter((u) => !players[u]?.isBot);
  const votesNeeded = Math.ceil(nonBotUids.length / 2);
  const votesSoFar = room.pauseVotes.filter((u) => nonBotUids.includes(u)).length;
  const hasVoted = room.pauseVotes.includes(uid);

  if (room.paused) {
    return (
      <button
        type="button"
        className="pause-control pause-control--paused"
        onClick={onVote}
        disabled={blocked || hasVoted}
        title={hasVoted ? 'Waiting for enough players to resume' : 'Vote to resume the game'}
      >
        <PauseIcon className="pause-control__icon" /> Paused {hasVoted ? `(${votesSoFar}/${votesNeeded} to resume)` : '— Resume?'}
      </button>
    );
  }

  return (
    <button
      type="button"
      className="pause-control"
      onClick={onVote}
      disabled={blocked || hasVoted}
      title={hasVoted ? 'Waiting for enough players to pause' : 'Vote to pause the game'}
    >
      {hasVoted ? `Pausing… (${votesSoFar}/${votesNeeded})` : 'Pause'}
    </button>
  );
}
