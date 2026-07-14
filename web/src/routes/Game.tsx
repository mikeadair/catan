import { useEffect, useRef, useState, type JSX } from 'react';
import { useGameStore } from '../state/store';
import { computeRollGains, legalActionTypes, type GameStateBundle } from '@catan/engine';
import type { DevCardType, EdgeId, GameAction, Resource, ResourceCount, VertexId } from '@catan/engine';
import { DISCARD_TIMEOUT_SECONDS, MAX_CITIES, MAX_ROADS, MAX_SETTLEMENTS, RESOURCES, ROBBER_TIMEOUT_SECONDS, SETUP_TIMEOUT_SECONDS } from '@catan/engine';
import { RESOURCE_LABEL } from '../components/resourceIcons';
import { playSfx, type SfxKind } from '../audio/sfx';
import Board, { type BoardInteractionMode } from '../components/Board';
import PlayerRoster from '../components/PlayerRoster';
import BankPanel from '../components/BankPanel';
import GameLog from '../components/GameLog';
import DiceRoller from '../components/DiceRoller';
import TurnTimer from '../components/TurnTimer';
import PauseControl from '../components/PauseControl';
import BuildToolbar, { type BuildMode } from '../components/BuildToolbar';
import EndTurnButton from '../components/EndTurnButton';
import DevCardPanel from '../components/DevCardPanel';
import TradeBar from '../components/TradeBar';
import TradeOffers from '../components/TradeOffers';
import ResourceHand from '../components/ResourceHand';
import { PauseIcon, TradeIcon } from '../components/gameIcons';
import DiscardModal from '../components/DiscardModal';
import GoldPickModal from '../components/GoldPickModal';
import RobberModal, { type RobberStep } from '../components/RobberModal';
import './Game.css';

const AFK_AUTO_ROLL_MS = 15000;

interface RoadBuildingPending {
  devCardId: string;
  edges: EdgeId[];
}

interface RobberVictimStep {
  hexId: string;
  eligible: string[];
  viaCardId?: string;
}

/** Maps a game/rules.ts log message to the sound it should trigger, if any. */
function sfxForLogMessage(message: string): SfxKind | null {
  if (/ wins the game!$/.test(message)) return 'win';
  if (/ stole a card from /.test(message)) return 'robber';
  if (/ discarded \d+ cards\.$/.test(message)) return 'discard';
  if (/ rolled \d+\.$/.test(message)) return 'dice';
  if (/ built a (road|settlement|city)\.$/.test(message)) return 'build';
  if (/ placed a settlement\.$/.test(message)) return 'build';
  if (/ bought a development card\.$/.test(message)) return 'card';
  if (/ played (Road Building|Year of Plenty|Monopoly)/.test(message)) return 'card';
  if (/ traded .* with the bank\.$/.test(message)) return 'trade';
  if (/ accepted a trade from /.test(message)) return 'trade';
  return null;
}

export default function Game(): JSX.Element {
  const uid = useGameStore((s) => s.uid);
  const room = useGameStore((s) => s.room);
  const players = useGameStore((s) => s.players);
  const ownHand = useGameStore((s) => s.ownHand);
  const trades = useGameStore((s) => s.trades);
  const chat = useGameStore((s) => s.chat);
  const dispatch = useGameStore((s) => s.dispatch);
  const dispatchQuiet = useGameStore((s) => s.dispatchQuiet);
  const sendChatMessage = useGameStore((s) => s.sendChatMessage);
  const leaveRoom = useGameStore((s) => s.leaveRoom);

  const [buildMode, setBuildMode] = useState<BuildMode>(null);
  // The specific edge/vertex a buildMode confirm just targeted — watched against room.edges/
  // room.vertices directly to close buildMode (see the effects below), rather than any
  // listener-derived proxy for "did a build happen." Cleared once that effect fires, or by
  // the phase/turn-change effect below on anything else that invalidates it.
  const [pendingBuild, setPendingBuild] = useState<{ type: 'road'; edgeId: EdgeId } | { type: 'settlement' | 'city'; vertexId: VertexId } | null>(null);
  const [knightPending, setKnightPending] = useState<string | null>(null);
  const [roadBuildingPending, setRoadBuildingPending] = useState<RoadBuildingPending | null>(null);
  const [yopPending, setYopPending] = useState<string | null>(null);
  const [yopSelection, setYopSelection] = useState<Partial<ResourceCount>>({});
  const [monopolyPending, setMonopolyPending] = useState<string | null>(null);
  const [robberVictimStep, setRobberVictimStep] = useState<RobberVictimStep | null>(null);
  // Guards against the hex-picker (and its "choose a hex" banner) re-opening the instant a
  // plain (no-dev-card) robber move's dispatch resolves but the client's own local `room`
  // snapshot hasn't yet caught up past 'robber' phase — same shape of gap as the invisible-
  // road bug fixed in Board.tsx, just manifesting as a *re-arm* here instead of a vanish.
  // Without this, robberHexStep re-derives `true` from the still-stale room.phase the moment
  // finishRobberMove clears robberVictimStep on success, inviting a second (server-rejected)
  // moveRobber submission. Cleared reactively once room.phase actually leaves 'robber' —
  // mirroring the fixed pattern of deriving from confirmed room state rather than the
  // dispatch promise. (Playing a Knight card never needs this: DevCardPanel only allows it
  // during 'roll'/'main', never while already in 'robber' phase, so knightPending's own
  // clearing can't suffer the same staleness.)
  const [robberMoveSubmitted, setRobberMoveSubmitted] = useState(false);
  const [leaveConfirmOpen, setLeaveConfirmOpen] = useState(false);
  // Trade composer state, lifted up here (rather than owned inside TradeBar) because the
  // "give" side is staged by tapping cards in the hand — a sibling rendered separately below
  // TradeBar in the toolbar — so both components need to read/write the same selection.
  const [tradeGive, setTradeGive] = useState<Partial<ResourceCount>>({});
  const [tradeReceive, setTradeReceive] = useState<Partial<ResourceCount>>({});
  const [tradeTargetUid, setTradeTargetUid] = useState<string>('');
  function resetTradeComposer() {
    setTradeGive({});
    setTradeReceive({});
    setTradeTargetUid('');
  }
  // Whether the trade composer (TradeBar's "you want" row/steppers/target-select/Offer/Bank
  // buttons, plus the hand's tap-to-select mode) is showing. Off by default — the composer
  // used to always render, eating vertical space even when nobody was mid-trade. Toggling off
  // resets any in-progress composition rather than leaving staged (but invisible) cards behind.
  const [tradeComposerOpen, setTradeComposerOpen] = useState(false);
  function toggleTradeComposer() {
    setTradeComposerOpen((cur) => {
      if (cur) resetTradeComposer();
      return !cur;
    });
  }
  const [sidebarSide, setSidebarSide] = useState<'left' | 'right'>(() => {
    try {
      return localStorage.getItem('catan.sidebarSide') === 'left' ? 'left' : 'right';
    } catch {
      return 'right';
    }
  });
  function toggleSidebarSide() {
    setSidebarSide((cur) => {
      const next = cur === 'left' ? 'right' : 'left';
      try {
        localStorage.setItem('catan.sidebarSide', next);
      } catch {
        // non-fatal
      }
      return next;
    });
  }
  // Every dispatched action is a real network round-trip; track which one (if any) is
  // in flight so controls can show pending state instead of just going inert with no
  // feedback until the promise settles.
  const [pendingActionType, setPendingActionType] = useState<GameAction['type'] | null>(null);
  const [resourceGrantMessage, setResourceGrantMessage] = useState<string | null>(null);
  const [rollGainsMessage, setRollGainsMessage] = useState<string | null>(null);

  // Clear transient, per-turn UI selection state whenever the phase or the
  // active player changes underneath us (e.g. an illegal click didn't clear
  // it, or the turn simply moved on). Trade composer selections are deliberately excluded —
  // they should only clear when the player explicitly closes the composer (toggleTradeComposer
  // -> resetTradeComposer), not because a turn ended or anything else happened underneath them.
  useEffect(() => {
    setBuildMode(null);
    setPendingBuild(null);
  }, [room?.phase, room?.currentPlayerIndex, room?.turnNumber]);

  // Also cleared once the specific piece just confirmed actually lands in room.edges/
  // room.vertices — this is what actually closes buildMode after a successful build (see
  // onEdgeClick/onVertexClick below, which record the target here instead of clearing
  // buildMode themselves). Two things this used to get wrong, both variants of the same
  // invisible-piece bug the original Board.tsx armed-preview fix addressed:
  //   1. Clearing eagerly via `.then((ok) => ok && setBuildMode(null))` the instant the
  //      dispatch *promise* resolved, before the room listener had caught up.
  //   2. Clearing off players[uid]'s roadsBuilt/settlementsBuilt/citiesBuilt counts instead —
  //      `players` is a *separate* Firestore listener from `room` (see firebase/rooms.ts:
  //      onSnapshot(roomRef(...)) vs onSnapshot(collection(..., 'players'))), written
  //      atomically together server-side but with no ordering guarantee for when each
  //      listener's snapshot actually arrives on the client. Under latency, the players
  //      snapshot can land first, closing buildMode (and so Board's interactionMode/
  //      candidateEdges/candidateVertices) before room.edges/room.vertices has the new piece —
  //      reopening the exact same gap via a third path. Both had the same shape: something
  //      other than room.edges/room.vertices itself deciding when to stop showing the armed
  //      preview. Watching the specific target directly in room here guarantees this effect
  //      fires in the very same render where Board's own candidate-set effect does, off the
  //      identical room snapshot — no cross-listener race possible.
  const pendingBuildEdgeId = pendingBuild?.type === 'road' ? pendingBuild.edgeId : null;
  const pendingBuildVertexId = pendingBuild && pendingBuild.type !== 'road' ? pendingBuild.vertexId : null;
  useEffect(() => {
    if (pendingBuildEdgeId && room?.edges[pendingBuildEdgeId]) {
      setBuildMode(null);
      setPendingBuild(null);
    }
  }, [room?.edges, pendingBuildEdgeId]);
  useEffect(() => {
    if (pendingBuildVertexId && room?.vertices[pendingBuildVertexId]) {
      setBuildMode(null);
      setPendingBuild(null);
    }
  }, [room?.vertices, pendingBuildVertexId]);

  // See robberMoveSubmitted's declaration above — reset the guard once the room's own phase
  // confirms the move actually landed (or, for a rejected/failed submission that never
  // changes phase, the next real robber phase starts it fresh anyway).
  useEffect(() => {
    if (room?.phase !== 'robber') setRobberMoveSubmitted(false);
  }, [room?.phase]);

  // Sound effects: play a cue for the newest log entry (covers rolls, builds, trades,
  // robber steals, discards, dev cards, and the win announcement).
  const lastLogIdRef = useRef<string | null>(null);
  useEffect(() => {
    const log = room?.log;
    if (!log || log.length === 0) return;
    const newest = log[log.length - 1];
    if (lastLogIdRef.current === null) {
      lastLogIdRef.current = newest.id; // don't sound off for history on first mount
      return;
    }
    if (newest.id !== lastLogIdRef.current) {
      lastLogIdRef.current = newest.id;
      const kind = sfxForLogMessage(newest.message);
      if (kind) playSfx(kind);
    }
  }, [room?.log]);

  // Callout when the setup-phase second-settlement resource grant lands — otherwise it's a
  // silent, easy-to-miss state change (the resource hand isn't even shown during setup).
  //
  // The clearing timer is tracked in a ref rather than via this effect's own cleanup
  // function, deliberately: React runs an effect's cleanup from the *previous* invocation
  // every time any dependency changes, not just when the component unmounts. ownHand changes
  // on almost any board action anywhere in the game, so a re-render with no new gain (the
  // common case) used to fire the cleanup — cancelling the pending clear — then hit the
  // `gains.length === 0` early return before scheduling a replacement, leaving the message
  // stuck on screen with nothing left to ever clear it. Explicitly clearing/rescheduling only
  // when there's an actual new gain to show avoids that: the timer's lifetime is now tied to
  // "is there a newer message to protect," not to "did some unrelated dependency change."
  const prevResourcesRef = useRef<ResourceCount | null>(null);
  const resourceGrantTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const current = ownHand?.resources ?? null;
    const prev = prevResourcesRef.current;
    prevResourcesRef.current = current;
    if (!current || !prev) return;
    if (room?.phase !== 'setup1' && room?.phase !== 'setup2') return;
    const gains = RESOURCES.filter((r) => current[r] > prev[r]).map(
      (r) => `+${current[r] - prev[r]} ${RESOURCE_LABEL[r]}`,
    );
    if (gains.length === 0) return;
    if (resourceGrantTimerRef.current) clearTimeout(resourceGrantTimerRef.current);
    setResourceGrantMessage(gains.join(', '));
    resourceGrantTimerRef.current = setTimeout(() => {
      setResourceGrantMessage(null);
      resourceGrantTimerRef.current = null;
    }, 2800);
  }, [ownHand, room?.phase]);
  useEffect(() => {
    return () => {
      if (resourceGrantTimerRef.current) clearTimeout(resourceGrantTimerRef.current);
    };
  }, []);

  // Callout showing what EVERY player gained on the latest roll, not just yourself — board
  // layout, building ownership, and the roll itself are all already public, so this is a
  // pure client-side recomputation of the same claim rules.ts already applied server-side
  // (computeRollGains), not a new information exposure.
  //
  // Same ref-tracked-timer fix as the resource-grant callout above, and for the identical
  // reason: room?.vertices/players change on nearly every action in the game, which used to
  // cancel the pending clear on every such change without necessarily scheduling a new one.
  const prevDiceRollRef = useRef<[number, number] | null>(null);
  const rollGainsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const current = room?.diceRoll ?? null;
    const prev = prevDiceRollRef.current;
    prevDiceRollRef.current = current;
    if (!current || !room?.board) return;
    if (prev && prev[0] === current[0] && prev[1] === current[1]) return; // same roll, not a new one

    const gains = computeRollGains(room.board, room.vertices, current[0] + current[1]);
    const parts = Object.entries(gains)
      .map(([gainUid, byResource]) => {
        const name = players[gainUid]?.displayName ?? 'Someone';
        const resourceParts = RESOURCES.filter((r) => byResource[r]).map((r) => `+${byResource[r]} ${RESOURCE_LABEL[r]}`);
        return resourceParts.length > 0 ? `${name}: ${resourceParts.join(', ')}` : null;
      })
      .filter((s): s is string => s !== null);
    if (parts.length === 0) return;

    if (rollGainsTimerRef.current) clearTimeout(rollGainsTimerRef.current);
    setRollGainsMessage(parts.join('   •   '));
    rollGainsTimerRef.current = setTimeout(() => {
      setRollGainsMessage(null);
      rollGainsTimerRef.current = null;
    }, 4000);
  }, [room?.diceRoll, room?.board, room?.vertices, players]);
  useEffect(() => {
    return () => {
      if (rollGainsTimerRef.current) clearTimeout(rollGainsTimerRef.current);
    };
  }, []);

  // Trades were easy to miss entirely — tucked behind a toggle button with no cue that
  // anything changed. Pending trades relevant to you now render persistently in the
  // sidebar (<TradeOffers>), always visible and directly actionable; this effect just adds
  // a sound cue the moment a NEW one shows up, since the sidebar itself is always present.
  const seenTradeIdsRef = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (!uid) return;
    const relevant = trades.filter(
      (t) => t.status === 'pending' && t.proposerUid !== uid && (t.targetUid === uid || t.targetUid === null),
    );
    const seen = seenTradeIdsRef.current;
    if (seen === null) {
      // First load: mark whatever's already pending as seen, no sound for history.
      seenTradeIdsRef.current = new Set(relevant.map((t) => t.id));
      return;
    }
    const fresh = relevant.filter((t) => !seen.has(t.id));
    for (const t of relevant) seen.add(t.id);
    if (fresh.length > 0) playSfx('trade');
  }, [trades, uid]);

  // Sound effect: a short chime whenever it becomes this player's turn.
  const wasCurrentPlayerRef = useRef<boolean | null>(null);
  useEffect(() => {
    if (!room || !uid) return;
    const isNowCurrent = room.turnOrder[room.currentPlayerIndex] === uid;
    if (wasCurrentPlayerRef.current === null) {
      wasCurrentPlayerRef.current = isNowCurrent; // no sound on first mount
      return;
    }
    if (isNowCurrent && !wasCurrentPlayerRef.current) playSfx('yourTurn');
    wasCurrentPlayerRef.current = isNowCurrent;
  }, [room?.turnOrder, room?.currentPlayerIndex, uid]);

  // AFK auto-roll: if it's your turn to roll and you haven't within 15s, roll for you —
  // keeps the game moving without anyone having to notice and nudge you. Only the current
  // player's own client fires this (each client re-derives the same deadline from the
  // shared turnStartedAt, so no coordination between clients is needed).
  useEffect(() => {
    if (!room || !uid) return;
    if (room.paused || room.phase !== 'roll' || pendingActionType !== null) return;
    if (room.turnOrder[room.currentPlayerIndex] !== uid) return;
    const remaining = Math.max(0, AFK_AUTO_ROLL_MS - (Date.now() - room.turnStartedAt));
    const timer = setTimeout(() => {
      void dispatchQuiet({ type: 'rollDice', uid });
    }, remaining);
    return () => clearTimeout(timer);
  }, [room?.paused, room?.phase, room?.turnStartedAt, room?.currentPlayerIndex, room?.turnOrder, uid, pendingActionType, dispatchQuiet]);

  // Turn-timer expiry skips the turn. Any connected client (not just the current player's
  // own, which may be the one that's gone AFK/offline) can report the timeout — the server
  // re-validates elapsed time itself, so duplicate reports from multiple clients just race
  // harmlessly (dispatchQuiet swallows the loser's rejection instead of toasting it).
  useEffect(() => {
    if (!room || !uid) return;
    if (room.paused || room.turnTimerSeconds === null) return;
    if (room.phase !== 'roll' && room.phase !== 'main') return;
    const remaining = Math.max(0, room.turnTimerSeconds * 1000 - (Date.now() - room.turnStartedAt));
    const timer = setTimeout(() => {
      void dispatchQuiet({ type: 'timeoutEndTurn', uid });
    }, remaining);
    return () => clearTimeout(timer);
  }, [room?.paused, room?.phase, room?.turnStartedAt, room?.turnTimerSeconds, uid, dispatchQuiet]);

  // Discard-timer expiry auto-discards a random selection for every pending player at once
  // (see 'timeoutDiscard' in rules.ts) — same "any connected client may report it, server
  // re-validates elapsed time" pattern as the turn timer above, fixed at DISCARD_TIMEOUT_SECONDS
  // rather than a configurable house rule.
  useEffect(() => {
    if (!room || !uid) return;
    if (room.paused || room.phase !== 'discard' || room.discardPhaseStartedAt === null) return;
    const remaining = Math.max(0, DISCARD_TIMEOUT_SECONDS * 1000 - (Date.now() - room.discardPhaseStartedAt));
    const timer = setTimeout(() => {
      void dispatchQuiet({ type: 'timeoutDiscard', uid });
    }, remaining);
    return () => clearTimeout(timer);
  }, [room?.paused, room?.phase, room?.discardPhaseStartedAt, uid, dispatchQuiet]);

  // Robber-timer expiry auto-places the robber on a random hex on the current player's
  // behalf (see 'timeoutRobber' in rules.ts) — same pattern as the discard timer above, so a
  // current player who's gone AFK/stuck deciding where to place the robber doesn't stall the
  // game for everyone else.
  useEffect(() => {
    if (!room || !uid) return;
    if (room.paused || room.phase !== 'robber' || room.robberPhaseStartedAt === null) return;
    const remaining = Math.max(0, ROBBER_TIMEOUT_SECONDS * 1000 - (Date.now() - room.robberPhaseStartedAt));
    const timer = setTimeout(() => {
      void dispatchQuiet({ type: 'timeoutRobber', uid });
    }, remaining);
    return () => clearTimeout(timer);
  }, [room?.paused, room?.phase, room?.robberPhaseStartedAt, uid, dispatchQuiet]);

  // Setup-timer expiry auto-places a random legal settlement/road for the current player's
  // setup turn (see 'timeoutSetupPlacement' in rules.ts) — same pattern as the discard/robber
  // timers above, so a current player who's gone AFK/stuck during setup doesn't stall the
  // game before it's even started for everyone else.
  useEffect(() => {
    if (!room || !uid) return;
    if (room.paused || (room.phase !== 'setup1' && room.phase !== 'setup2') || room.setupTurnStartedAt === null) return;
    const remaining = Math.max(0, SETUP_TIMEOUT_SECONDS * 1000 - (Date.now() - room.setupTurnStartedAt));
    const timer = setTimeout(() => {
      void dispatchQuiet({ type: 'timeoutSetupPlacement', uid });
    }, remaining);
    return () => clearTimeout(timer);
  }, [room?.paused, room?.phase, room?.setupTurnStartedAt, uid, dispatchQuiet]);

  if (!uid || !room) {
    return <div className="game-loading">Loading game…</div>;
  }

  if (room.phase === 'gameOver') {
    const winner = room.winnerUid ? players[room.winnerUid] : null;
    return (
      <div className="game-over">
        <div className="game-over__card">
          <h1>{winner ? (room.winnerUid === uid ? 'You win!' : `${winner.displayName} wins!`) : 'Game over'}</h1>
          <p>Victory points reached {room.victoryPointsToWin}.</p>
          <button type="button" className="game-over__button" onClick={() => leaveRoom()}>
            Back to home
          </button>
        </div>
      </div>
    );
  }

  if (!room.board) {
    return <div className="game-loading">Loading board…</div>;
  }

  const board = room.board;
  const isCurrentPlayer = room.turnOrder[room.currentPlayerIndex] === uid;
  const bundle: GameStateBundle = { room, players, hands: ownHand ? { [uid]: ownHand } : {}, trades };
  const legalTypes = legalActionTypes(bundle, uid);
  const resources = ownHand?.resources ?? { brick: 0, lumber: 0, ore: 0, grain: 0, wool: 0 };
  const tradeGiveTotal = RESOURCES.reduce((s, r) => s + (tradeGive[r] ?? 0), 0);

  async function runAction(action: GameAction): Promise<boolean> {
    setPendingActionType(action.type);
    try {
      await dispatch(action);
      return true;
    } catch {
      // The store surfaces dispatch errors globally via App.tsx's toast.
      return false;
    } finally {
      setPendingActionType(null);
    }
  }

  // Resets the composer's give/receive/target selection once a trade actually goes through —
  // otherwise the same stale selection (and, for proposeTrade, the same resources you may no
  // longer even have) sits there after every trade, forcing a manual clear before starting the
  // next one. Left untouched on failure so a rejected/errored attempt doesn't lose the
  // player's in-progress selection.
  async function handleProposeTrade(give: Partial<ResourceCount>, receive: Partial<ResourceCount>, targetUid: string | null) {
    const ok = await runAction({ type: 'proposeTrade', uid: uid!, give, receive, targetUid });
    if (ok) resetTradeComposer();
  }

  async function handleBankTrade(give: Resource, giveAmount: number, receive: Resource) {
    const ok = await runAction({ type: 'bankTrade', uid: uid!, give, giveAmount, receive });
    if (ok) resetTradeComposer();
  }

  function computeEligibleVictims(hexId: string): string[] {
    const adjVertexIds = Object.values(board.vertices)
      .filter((v) => v.adjacentHexIds.includes(hexId))
      .map((v) => v.id);
    const victims = new Set<string>();
    for (const vId of adjVertexIds) {
      const b = room!.vertices[vId];
      if (b && b.uid !== uid) victims.add(b.uid);
    }
    return Array.from(victims);
  }

  async function finishRobberMove(hexId: string, stealFromUid: string | null, viaCardId?: string) {
    const cardId = viaCardId ?? robberVictimStep?.viaCardId ?? knightPending ?? undefined;
    if (!cardId) setRobberMoveSubmitted(true); // plain robber-phase move — see the flag's declaration
    const ok = cardId
      ? await runAction({ type: 'playKnight', uid: uid!, devCardId: cardId, robberHexId: hexId, stealFromUid })
      : await runAction({ type: 'moveRobber', uid: uid!, robberHexId: hexId, stealFromUid });
    if (ok) {
      setKnightPending(null);
      setRobberVictimStep(null);
    } else if (!cardId) {
      setRobberMoveSubmitted(false); // failed — allow the player to try again
    }
  }

  async function handleRobberHexClick(hexId: string) {
    if (hexId === board.robberHexId) return;
    const eligible = computeEligibleVictims(hexId);
    const cardId = knightPending ?? undefined;
    if (eligible.length <= 1) {
      await finishRobberMove(hexId, eligible[0] ?? null, cardId);
    } else {
      setRobberVictimStep({ hexId, eligible, viaCardId: cardId });
    }
  }

  async function handleRoadBuildingEdgeClick(edgeId: EdgeId) {
    if (!roadBuildingPending) return;
    const edges = [...roadBuildingPending.edges, edgeId];
    if (edges.length < 2) {
      setRoadBuildingPending({ ...roadBuildingPending, edges });
      return;
    }
    const ok = await runAction({
      type: 'playRoadBuilding',
      uid: uid!,
      devCardId: roadBuildingPending.devCardId,
      edgeIds: [edges[0], edges[1]],
    });
    setRoadBuildingPending(ok ? null : { ...roadBuildingPending, edges: [] });
  }

  function handlePlayDevCard(type: Exclude<DevCardType, 'victoryPoint'>, devCardId: string) {
    if (type === 'knight') setKnightPending(devCardId);
    else if (type === 'roadBuilding') setRoadBuildingPending({ devCardId, edges: [] });
    else if (type === 'yearOfPlenty') setYopPending(devCardId);
    else if (type === 'monopoly') setMonopolyPending(devCardId);
  }

  async function confirmYearOfPlenty() {
    if (!yopPending) return;
    const chosen: Resource[] = [];
    for (const r of RESOURCES) {
      for (let i = 0; i < (yopSelection[r] ?? 0); i++) chosen.push(r);
    }
    if (chosen.length !== 2) return;
    const ok = await runAction({
      type: 'playYearOfPlenty',
      uid: uid!,
      devCardId: yopPending,
      resources: [chosen[0], chosen[1]],
    });
    if (ok) {
      setYopPending(null);
      setYopSelection({});
    }
  }

  async function confirmMonopoly(resource: Resource) {
    if (!monopolyPending) return;
    const ok = await runAction({ type: 'playMonopoly', uid: uid!, devCardId: monopolyPending, resource });
    if (ok) setMonopolyPending(null);
  }

  // --- Setup-phase flow: derived from the player's actual pieces in room.vertices/room.edges
  // — the same data Board's own candidateEdges/candidateVertices use — rather than
  // players[uid]'s settlementsBuilt/roadsBuilt counts. players is a *separate* Firestore
  // listener from room (see firebase/rooms.ts), written atomically together server-side but
  // with no ordering guarantee for when each listener's snapshot arrives on the client. Under
  // latency, the players snapshot landing first would flip setupNeedsRoad/setupNeedsSettlement
  // (and so Board's interactionMode/candidateEdges/candidateVertices) before room.edges/
  // room.vertices actually had the new piece — the exact same invisible-piece race as the
  // buildMode fix elsewhere in this file (see the pendingBuild effects above), just in the
  // setup-phase path, which every player hits on every game (hence "still sometimes" after
  // that other fix landed). Counting from room here guarantees this and Board's own un-arm
  // effect fire off the identical room snapshot.
  const setupActive = (room.phase === 'setup1' || room.phase === 'setup2') && isCurrentPlayer;
  const selfRoadsFromRoom = Object.values(room.edges).filter((ownerUid) => ownerUid === uid).length;
  const selfSettlementsFromRoom = Object.values(room.vertices).filter((v) => v.uid === uid).length;
  const setupNeedsSettlement = setupActive && selfSettlementsFromRoom === selfRoadsFromRoom;
  const setupNeedsRoad = setupActive && !setupNeedsSettlement;

  const robberHexStep = !robberMoveSubmitted && ((room.phase === 'robber' && isCurrentPlayer) || !!knightPending);

  // --- Resolve the Board's interaction mode + click handlers, in priority order.
  let interactionMode: BoardInteractionMode = 'none';
  let freeSetup = false;
  let extraOwnedEdgeIds: EdgeId[] | undefined;
  let onVertexClick: ((v: VertexId) => void) | undefined;
  let onEdgeClick: ((e: EdgeId) => void) | undefined;
  let onHexClick: ((h: string) => void) | undefined;

  if (room.paused) {
    // Board stays visible but unresponsive while paused — see PauseControl/phaseBanner.
  } else if (setupNeedsSettlement) {
    interactionMode = 'placeSettlement';
    freeSetup = true;
    onVertexClick = (vertexId) => {
      void runAction({ type: 'buildSettlement', uid, vertexId, free: true });
    };
  } else if (setupNeedsRoad) {
    interactionMode = 'placeRoad';
    freeSetup = true;
    onEdgeClick = (edgeId) => {
      void runAction({ type: 'buildRoad', uid, edgeId, free: true });
    };
  } else if (robberHexStep && !robberVictimStep) {
    interactionMode = 'placeRobber';
    onHexClick = (hexId) => {
      void handleRobberHexClick(hexId);
    };
  } else if (roadBuildingPending) {
    interactionMode = 'placeRoad';
    extraOwnedEdgeIds = roadBuildingPending.edges;
    onEdgeClick = (edgeId) => {
      void handleRoadBuildingEdgeClick(edgeId);
    };
  } else if (buildMode === 'road') {
    interactionMode = 'placeRoad';
    // Deliberately doesn't clear buildMode here on success — see the pendingBuild effects
    // above, which now own that instead (watching room.edges directly for this exact edge).
    onEdgeClick = (edgeId) => {
      setPendingBuild({ type: 'road', edgeId });
      void runAction({ type: 'buildRoad', uid, edgeId });
    };
  } else if (buildMode === 'settlement') {
    interactionMode = 'placeSettlement';
    onVertexClick = (vertexId) => {
      setPendingBuild({ type: 'settlement', vertexId });
      void runAction({ type: 'buildSettlement', uid, vertexId });
    };
  } else if (buildMode === 'city') {
    interactionMode = 'placeCity';
    onVertexClick = (vertexId) => {
      setPendingBuild({ type: 'city', vertexId });
      void runAction({ type: 'buildCity', uid, vertexId });
    };
  }

  const robberStep: RobberStep = robberVictimStep ? 'victim' : interactionMode === 'placeRobber' ? 'hex' : null;

  const setupRoundLabel = room.setupRound
    ? `Round ${room.setupRound} of 2${room.setupRound === 2 ? ' (reversed order)' : ''} — `
    : '';

  let phaseBanner: JSX.Element | string | null = null;
  if (room.paused) {
    phaseBanner = (
      <>
        <PauseIcon className="game__phase-banner-icon" /> Game paused
      </>
    );
  }
  else if (setupNeedsSettlement) phaseBanner = `${setupRoundLabel}Place your ${room.setupRound === 2 ? 'second' : 'first'} settlement.`;
  else if (setupNeedsRoad) phaseBanner = `${setupRoundLabel}Place a road connected to your new settlement.`;
  else if (room.phase === 'roll' && isCurrentPlayer) phaseBanner = 'Your turn — roll the dice!';
  else if ((room.phase === 'setup1' || room.phase === 'setup2') && !isCurrentPlayer) {
    const waitingOn = players[room.turnOrder[room.currentPlayerIndex]];
    phaseBanner = waitingOn ? `${setupRoundLabel}Waiting for ${waitingOn.displayName} to set up…` : null;
  } else if (room.phase === 'robber' && !isCurrentPlayer && !robberVictimStep) {
    const waitingOn = players[room.turnOrder[room.currentPlayerIndex]];
    phaseBanner = waitingOn ? `Waiting for ${waitingOn.displayName} to move the robber…` : null;
  } else if (room.phase === 'discard' && !room.pendingDiscardUids.includes(uid) && room.pendingDiscardUids.length > 0) {
    const names = room.pendingDiscardUids.map((u) => players[u]?.displayName ?? 'someone');
    phaseBanner = `Waiting for ${names.join(', ')} to discard…`;
  } else if (room.phase === 'goldPick' && !room.pendingGoldPicks.some((p) => p.uid === uid) && room.pendingGoldPicks.length > 0) {
    const names = room.pendingGoldPicks.map((p) => players[p.uid]?.displayName ?? 'someone');
    phaseBanner = `Waiting for ${names.join(', ')} to pick their gold…`;
  }

  // Dice rolling only makes sense in roll/main; the toolbar itself (build/trade/hand) is
  // relevant throughout the whole live game now, so it's always mounted below.
  const showDiceRoller = room.phase === 'roll' || room.phase === 'main';
  const selfPlayer = players[uid];
  const piecesLeft = {
    roads: selfPlayer ? MAX_ROADS - selfPlayer.roadsBuilt : 0,
    settlements: selfPlayer ? MAX_SETTLEMENTS - selfPlayer.settlementsBuilt : 0,
    cities: selfPlayer ? MAX_CITIES - selfPlayer.citiesBuilt : 0,
  };

  // Fog-of-war boards benefit from extra screen real estate — the "?" fog tiles and the
  // reveal-on-road-build feel are easier to read with more room, even though the underlying
  // hex geometry/size stays the same (see Board.tsx's SIZE constant). Widen the board's grid
  // track and shrink the sidebar's proportionally via a modifier class rather than touching
  // hex-size math.
  const isFogMap = room.mapPreset === 'fog-of-war';

  return (
    <div
      className={`game${sidebarSide === 'left' ? ' game--sidebar-left' : ''}${isFogMap ? ' game--fog' : ''}`}
    >
      <div className="game__board-area">
        {phaseBanner && <div className="game__phase-banner">{phaseBanner}</div>}
        {resourceGrantMessage && (
          <div key={resourceGrantMessage} className="game__resource-grant">
            {resourceGrantMessage}
          </div>
        )}
        {rollGainsMessage && (
          <div key={rollGainsMessage} className="game__roll-gains">
            {rollGainsMessage}
          </div>
        )}
        <Board
          room={room}
          players={players}
          uid={uid}
          interactionMode={interactionMode}
          freeSetup={freeSetup}
          extraOwnedEdgeIds={extraOwnedEdgeIds}
          onVertexClick={onVertexClick}
          onEdgeClick={onEdgeClick}
          onHexClick={onHexClick}
        />
        {showDiceRoller && (
          <DiceRoller
            diceRoll={room.diceRoll}
            canRoll={legalTypes.includes('rollDice')}
            isCurrentPlayer={isCurrentPlayer}
            isPending={pendingActionType === 'rollDice'}
            onRoll={() => void runAction({ type: 'rollDice', uid })}
          />
        )}
        {/* Rendered as an overlay anchored in the board's own empty water margin (the `pad`
            space around the hex grid in Board.tsx) rather than a layout-participating grid
            column — a grid column's width changes with its content (zero when no trades are
            pending, real width once one appears), which used to visibly resize/reflow the
            board every time a trade appeared or disappeared. Positioned absolutely, so it
            never affects the board's or toolbar's layout regardless of how many trades are
            showing. Still returns null internally when there's nothing pending. */}
        <div className="game__trades-overlay">
          <TradeOffers
            uid={uid}
            players={players}
            ownResources={resources}
            trades={trades}
            blocked={pendingActionType !== null}
            onRespondTrade={(tradeId, accept) => void runAction({ type: 'respondTrade', uid, tradeId, accept })}
            onCancelTrade={(tradeId) => void runAction({ type: 'cancelTrade', uid, tradeId })}
            onFinalizeTrade={(tradeId, withUid) => void runAction({ type: 'finalizeTrade', uid, tradeId, withUid })}
          />
        </div>
      </div>

      <aside className="game__sidebar">
        <div className="game__sidebar-top">
          <button
            type="button"
            className="game__sidebar-side-toggle"
            onClick={toggleSidebarSide}
            title={`Move sidebar to the ${sidebarSide === 'left' ? 'right' : 'left'}`}
            aria-label={`Move sidebar to the ${sidebarSide === 'left' ? 'right' : 'left'}`}
          >
            {sidebarSide === 'left' ? '⇥' : '⇤'}
          </button>
          <PauseControl
            room={room}
            players={players}
            uid={uid}
            blocked={pendingActionType !== null}
            onVote={() => void runAction({ type: room.paused ? 'voteToUnpause' : 'voteToPause', uid })}
          />
          <button type="button" className="game__leave-button" onClick={() => setLeaveConfirmOpen(true)}>
            Leave game
          </button>
        </div>
        <BankPanel bank={room.bank} devCardsRemaining={room.devCardDeckCount} />
        <PlayerRoster
          players={players}
          turnOrder={room.turnOrder}
          currentUid={room.turnOrder[room.currentPlayerIndex] ?? null}
          localUid={uid}
          longestRoadUid={room.longestRoadUid}
          largestArmyUid={room.largestArmyUid}
          ownHand={ownHand}
        />
        <GameLog log={room.log} chat={chat} players={players} turnOrder={room.turnOrder} onSend={(text) => void sendChatMessage(text)} />
      </aside>

      <footer className="game__toolbar">
        {tradeComposerOpen && (
          <TradeBar
            room={room}
            players={players}
            uid={uid}
            give={tradeGive}
            receive={tradeReceive}
            onReceiveChange={setTradeReceive}
            targetUid={tradeTargetUid}
            onTargetUidChange={setTradeTargetUid}
            canTrade={legalTypes.includes('bankTrade') || legalTypes.includes('proposeTrade')}
            blocked={pendingActionType !== null}
            onBankTrade={(give, giveAmount, receive) => void handleBankTrade(give, giveAmount, receive)}
            onProposeTrade={(give, receive, targetUid) => void handleProposeTrade(give, receive, targetUid)}
          />
        )}
        <div className="game__toolbar-main">
          <div className="game__toolbar-hand">
            <div className="game__toolbar-label-row">
              <span className="game__toolbar-label">
                {tradeComposerOpen
                  ? tradeGiveTotal > 0
                    ? 'Your hand — tap to add/remove from trade'
                    : 'Your hand — tap cards to give in a trade'
                  : 'Your hand'}
              </span>
              {tradeComposerOpen && tradeGiveTotal > 0 && (
                <button type="button" className="game__toolbar-clear-give" onClick={() => setTradeGive({})}>
                  Clear ({tradeGiveTotal})
                </button>
              )}
            </div>
            {tradeComposerOpen ? (
              <ResourceHand resources={resources} variant="cards" selected={tradeGive} onChange={setTradeGive} />
            ) : (
              <ResourceHand resources={resources} variant="cards" />
            )}
          </div>
          <button
            type="button"
            className={`build-toolbar__button${tradeComposerOpen ? ' build-toolbar__button--active' : ''}`}
            onClick={toggleTradeComposer}
            aria-pressed={tradeComposerOpen}
          >
            <TradeIcon className="build-toolbar__icon" />
            <span className="build-toolbar__label">Trade</span>
          </button>
          <DevCardPanel
            devCards={ownHand?.devCards ?? []}
            turnNumber={room.turnNumber}
            canPlayAny={isCurrentPlayer && !room.devCardPlayedThisTurn && (room.phase === 'roll' || room.phase === 'main')}
            blocked={pendingActionType !== null}
            onPlay={handlePlayDevCard}
          />
          <BuildToolbar
            resources={resources}
            legalTypes={legalTypes}
            activeMode={buildMode}
            devCardsRemaining={room.devCardDeckCount}
            isCurrentPlayer={isCurrentPlayer}
            piecesLeft={piecesLeft}
            pendingActionType={pendingActionType}
            onToggleMode={(mode) => setBuildMode((cur) => (cur === mode ? null : mode))}
            onBuyDevCard={() => void runAction({ type: 'buyDevCard', uid })}
          />
          <div className="game__toolbar-right">
            <TurnTimer
              turnStartedAt={room.turnStartedAt}
              turnTimerSeconds={room.turnTimerSeconds}
              paused={room.paused}
              pausedAt={room.pausedAt}
            />
            <EndTurnButton
              legalTypes={legalTypes}
              isCurrentPlayer={isCurrentPlayer}
              pendingActionType={pendingActionType}
              onEndTurn={() => void runAction({ type: 'endTurn', uid })}
            />
          </div>
        </div>
      </footer>

      <DiscardModal
        visible={room.phase === 'discard' && room.pendingDiscardUids.includes(uid)}
        resources={resources}
        onDiscard={(discarded) => void runAction({ type: 'discard', uid, resources: discarded })}
        discardPhaseStartedAt={room.discardPhaseStartedAt}
        paused={room.paused}
        pausedAt={room.pausedAt}
      />

      <GoldPickModal
        visible={room.phase === 'goldPick' && room.pendingGoldPicks.some((p) => p.uid === uid)}
        amount={room.pendingGoldPicks.find((p) => p.uid === uid)?.amount ?? 0}
        bank={room.bank}
        onPick={(picked) => void runAction({ type: 'pickGoldResources', uid, resources: picked })}
      />

      <RobberModal
        step={robberStep}
        players={players}
        eligibleUids={robberVictimStep?.eligible ?? []}
        onSelectVictim={(victimUid) => {
          if (!robberVictimStep) return;
          void finishRobberMove(robberVictimStep.hexId, victimUid);
        }}
      />

      {yopPending && (
        <div className="modal-overlay">
          <div className="modal">
            <h3>Year of Plenty</h3>
            <p>Pick two resources to take from the bank.</p>
            <ResourceHand resources={room.bank} selected={yopSelection} onChange={setYopSelection} max={2} />
            <div className="modal__actions">
              <button
                type="button"
                onClick={() => {
                  setYopPending(null);
                  setYopSelection({});
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                className="modal__confirm"
                disabled={RESOURCES.reduce((s, r) => s + (yopSelection[r] ?? 0), 0) !== 2}
                onClick={() => void confirmYearOfPlenty()}
              >
                Confirm
              </button>
            </div>
          </div>
        </div>
      )}

      {monopolyPending && (
        <div className="modal-overlay">
          <div className="modal">
            <h3>Monopoly</h3>
            <p>Pick a resource — every opponent hands over all of theirs.</p>
            <div className="game__monopoly-choices">
              {RESOURCES.map((r) => (
                <button key={r} type="button" onClick={() => void confirmMonopoly(r)}>
                  {r}
                </button>
              ))}
            </div>
            <div className="modal__actions">
              <button type="button" onClick={() => setMonopolyPending(null)}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {leaveConfirmOpen && (
        <div className="modal-overlay">
          <div className="modal">
            <h3>Leave game?</h3>
            <p>Your seat stays active — you can rejoin anytime with the room code.</p>
            <div className="modal__actions">
              <button type="button" onClick={() => setLeaveConfirmOpen(false)}>
                Cancel
              </button>
              <button type="button" className="modal__confirm" onClick={() => leaveRoom()}>
                Leave
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
