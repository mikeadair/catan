import { useEffect, useRef, useState, type JSX } from 'react';
import { useGameStore } from '../state/store';
import { computeRollGains, legalActionTypes, type GameStateBundle } from '@catan/engine';
import type { DevCardType, EdgeId, GameAction, Resource, ResourceCount, VertexId } from '@catan/engine';
import { MAX_CITIES, MAX_ROADS, MAX_SETTLEMENTS, RESOURCES } from '@catan/engine';
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
import DevCardPanel from '../components/DevCardPanel';
import TradeBar from '../components/TradeBar';
import TradeOffers from '../components/TradeOffers';
import ResourceHand from '../components/ResourceHand';
import DiscardModal from '../components/DiscardModal';
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
  const [knightPending, setKnightPending] = useState<string | null>(null);
  const [roadBuildingPending, setRoadBuildingPending] = useState<RoadBuildingPending | null>(null);
  const [yopPending, setYopPending] = useState<string | null>(null);
  const [yopSelection, setYopSelection] = useState<Partial<ResourceCount>>({});
  const [monopolyPending, setMonopolyPending] = useState<string | null>(null);
  const [robberVictimStep, setRobberVictimStep] = useState<RobberVictimStep | null>(null);
  const [leaveConfirmOpen, setLeaveConfirmOpen] = useState(false);
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
  // it, or the turn simply moved on).
  useEffect(() => {
    setBuildMode(null);
  }, [room?.phase, room?.currentPlayerIndex, room?.turnNumber]);

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
  const prevResourcesRef = useRef<ResourceCount | null>(null);
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
    setResourceGrantMessage(gains.join(', '));
    const timer = setTimeout(() => setResourceGrantMessage(null), 2800);
    return () => clearTimeout(timer);
  }, [ownHand, room?.phase]);

  // Callout showing what EVERY player gained on the latest roll, not just yourself — board
  // layout, building ownership, and the roll itself are all already public, so this is a
  // pure client-side recomputation of the same claim rules.ts already applied server-side
  // (computeRollGains), not a new information exposure.
  const prevDiceRollRef = useRef<[number, number] | null>(null);
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

    setRollGainsMessage(parts.join('   •   '));
    const timer = setTimeout(() => setRollGainsMessage(null), 4000);
    return () => clearTimeout(timer);
  }, [room?.diceRoll, room?.board, room?.vertices, players]);

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

  if (!uid || !room) {
    return <div className="game-loading">Loading game…</div>;
  }

  if (room.phase === 'gameOver') {
    const winner = room.winnerUid ? players[room.winnerUid] : null;
    return (
      <div className="game-over">
        <div className="game-over__card">
          <h1>{winner ? `${winner.displayName} wins!` : 'Game over'}</h1>
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
    const ok = cardId
      ? await runAction({ type: 'playKnight', uid: uid!, devCardId: cardId, robberHexId: hexId, stealFromUid })
      : await runAction({ type: 'moveRobber', uid: uid!, robberHexId: hexId, stealFromUid });
    if (ok) {
      setKnightPending(null);
      setRobberVictimStep(null);
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

  // --- Setup-phase flow: fully derived from public player build counts, no local state needed.
  const setupActive = (room.phase === 'setup1' || room.phase === 'setup2') && isCurrentPlayer;
  const setupNeedsSettlement = setupActive && players[uid] && players[uid].settlementsBuilt === players[uid].roadsBuilt;
  const setupNeedsRoad = setupActive && !setupNeedsSettlement;

  const robberHexStep = (room.phase === 'robber' && isCurrentPlayer) || !!knightPending;

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
    onEdgeClick = (edgeId) => {
      void runAction({ type: 'buildRoad', uid, edgeId }).then((ok) => ok && setBuildMode(null));
    };
  } else if (buildMode === 'settlement') {
    interactionMode = 'placeSettlement';
    onVertexClick = (vertexId) => {
      void runAction({ type: 'buildSettlement', uid, vertexId }).then((ok) => ok && setBuildMode(null));
    };
  } else if (buildMode === 'city') {
    interactionMode = 'placeCity';
    onVertexClick = (vertexId) => {
      void runAction({ type: 'buildCity', uid, vertexId }).then((ok) => ok && setBuildMode(null));
    };
  }

  const robberStep: RobberStep = robberVictimStep ? 'victim' : interactionMode === 'placeRobber' ? 'hex' : null;

  const setupRoundLabel = room.setupRound
    ? `Round ${room.setupRound} of 2${room.setupRound === 2 ? ' (reversed order)' : ''} — `
    : '';

  let phaseBanner: string | null = null;
  if (room.paused) phaseBanner = '⏸ Game paused';
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

  return (
    <div className={`game${sidebarSide === 'left' ? ' game--sidebar-left' : ''}`}>
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
        <GameLog log={room.log} chat={chat} onSend={(text) => void sendChatMessage(text)} />
      </aside>

      <footer className="game__toolbar">
          <TradeBar
            room={room}
            players={players}
            uid={uid}
            ownResources={resources}
            canTrade={legalTypes.includes('bankTrade') || legalTypes.includes('proposeTrade')}
            blocked={pendingActionType !== null}
            onBankTrade={(give, giveAmount, receive) =>
              void runAction({ type: 'bankTrade', uid, give, giveAmount, receive })
            }
            onProposeTrade={(give, receive, targetUid) =>
              void runAction({ type: 'proposeTrade', uid, give, receive, targetUid })
            }
          />
          <div className="game__toolbar-hand">
            <div className="game__toolbar-label">Your hand</div>
            <ResourceHand resources={resources} variant="cards" />
            <DevCardPanel
              devCards={ownHand?.devCards ?? []}
              turnNumber={room.turnNumber}
              canPlayAny={isCurrentPlayer && !room.devCardPlayedThisTurn && (room.phase === 'roll' || room.phase === 'main')}
              blocked={pendingActionType !== null}
              onPlay={handlePlayDevCard}
            />
          </div>
          <TurnTimer
            turnStartedAt={room.turnStartedAt}
            turnTimerSeconds={room.turnTimerSeconds}
            paused={room.paused}
            pausedAt={room.pausedAt}
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
            onEndTurn={() => void runAction({ type: 'endTurn', uid })}
          />
      </footer>

      <DiscardModal
        visible={room.phase === 'discard' && room.pendingDiscardUids.includes(uid)}
        resources={resources}
        onDiscard={(discarded) => void runAction({ type: 'discard', uid, resources: discarded })}
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
