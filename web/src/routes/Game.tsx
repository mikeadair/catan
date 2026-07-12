import { useEffect, useState, type JSX } from 'react';
import { useGameStore } from '../state/store';
import { legalActionTypes, type GameStateBundle } from '../game/rules';
import type { DevCardType, EdgeId, GameAction, Resource, ResourceCount, VertexId } from '../game/types';
import { RESOURCES } from '../game/types';
import Board, { type BoardInteractionMode } from '../components/Board';
import PlayerRoster from '../components/PlayerRoster';
import BankPanel from '../components/BankPanel';
import GameLog from '../components/GameLog';
import DiceRoller from '../components/DiceRoller';
import BuildToolbar, { type BuildMode } from '../components/BuildToolbar';
import DevCardPanel from '../components/DevCardPanel';
import TradePanel from '../components/TradePanel';
import ResourceHand from '../components/ResourceHand';
import DiscardModal from '../components/DiscardModal';
import RobberModal, { type RobberStep } from '../components/RobberModal';
import './Game.css';

interface RoadBuildingPending {
  devCardId: string;
  edges: EdgeId[];
}

interface RobberVictimStep {
  hexId: string;
  eligible: string[];
  viaCardId?: string;
}

export default function Game(): JSX.Element {
  const uid = useGameStore((s) => s.uid);
  const room = useGameStore((s) => s.room);
  const players = useGameStore((s) => s.players);
  const ownHand = useGameStore((s) => s.ownHand);
  const trades = useGameStore((s) => s.trades);
  const chat = useGameStore((s) => s.chat);
  const dispatch = useGameStore((s) => s.dispatch);
  const sendChatMessage = useGameStore((s) => s.sendChatMessage);
  const leaveRoom = useGameStore((s) => s.leaveRoom);

  const [buildMode, setBuildMode] = useState<BuildMode>(null);
  const [knightPending, setKnightPending] = useState<string | null>(null);
  const [roadBuildingPending, setRoadBuildingPending] = useState<RoadBuildingPending | null>(null);
  const [yopPending, setYopPending] = useState<string | null>(null);
  const [yopSelection, setYopSelection] = useState<Partial<ResourceCount>>({});
  const [monopolyPending, setMonopolyPending] = useState<string | null>(null);
  const [robberVictimStep, setRobberVictimStep] = useState<RobberVictimStep | null>(null);
  const [showDevCards, setShowDevCards] = useState(false);
  const [showTrade, setShowTrade] = useState(false);

  // Clear transient, per-turn UI selection state whenever the phase or the
  // active player changes underneath us (e.g. an illegal click didn't clear
  // it, or the turn simply moved on).
  useEffect(() => {
    setBuildMode(null);
  }, [room?.phase, room?.currentPlayerIndex, room?.turnNumber]);

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
    try {
      await dispatch(action);
      return true;
    } catch {
      // The store surfaces dispatch errors globally via App.tsx's toast.
      return false;
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
    setShowDevCards(false);
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

  if (setupNeedsSettlement) {
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

  let phaseBanner: string | null = null;
  if (setupNeedsSettlement) phaseBanner = 'Place your first settlement.';
  else if (setupNeedsRoad) phaseBanner = 'Place a road connected to your new settlement.';
  else if ((room.phase === 'setup1' || room.phase === 'setup2') && !isCurrentPlayer) {
    const waitingOn = players[room.turnOrder[room.currentPlayerIndex]];
    phaseBanner = waitingOn ? `Waiting for ${waitingOn.displayName} to set up…` : null;
  }

  const showBottomBar = room.phase === 'roll' || room.phase === 'main';

  return (
    <div className="game">
      <div className="game__board-area">
        {phaseBanner && <div className="game__phase-banner">{phaseBanner}</div>}
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
      </div>

      <aside className="game__sidebar">
        <BankPanel bank={room.bank} devCardsRemaining={room.devCardDeck.length} />
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

      {showBottomBar && (
        <footer className="game__toolbar">
          <div className="game__toolbar-hand">
            <div className="game__toolbar-label">Your hand</div>
            <ResourceHand resources={resources} />
          </div>
          <DiceRoller diceRoll={room.diceRoll} canRoll={legalTypes.includes('rollDice')} onRoll={() => void runAction({ type: 'rollDice', uid })} />
          <BuildToolbar
            resources={resources}
            legalTypes={legalTypes}
            activeMode={buildMode}
            devCardsRemaining={room.devCardDeck.length}
            onToggleMode={(mode) => setBuildMode((cur) => (cur === mode ? null : mode))}
            onBuyDevCard={() => void runAction({ type: 'buyDevCard', uid })}
            onEndTurn={() => void runAction({ type: 'endTurn', uid })}
          />
          <div className="game__toolbar-popovers">
            <button type="button" className="game__toolbar-toggle" onClick={() => setShowDevCards((v) => !v)}>
              Dev Cards ({ownHand?.devCards.length ?? 0})
            </button>
            <button type="button" className="game__toolbar-toggle" onClick={() => setShowTrade((v) => !v)}>
              Trade
            </button>
            {showDevCards && (
              <div className="game__popover game__popover--devcards">
                <DevCardPanel
                  devCards={ownHand?.devCards ?? []}
                  turnNumber={room.turnNumber}
                  canPlayAny={isCurrentPlayer && !room.devCardPlayedThisTurn && (room.phase === 'roll' || room.phase === 'main')}
                  onPlay={handlePlayDevCard}
                />
              </div>
            )}
            {showTrade && (
              <div className="game__popover game__popover--trade">
                <TradePanel
                  room={room}
                  players={players}
                  uid={uid}
                  ownResources={resources}
                  trades={trades}
                  canTrade={legalTypes.includes('bankTrade') || legalTypes.includes('proposeTrade')}
                  onBankTrade={(give, giveAmount, receive) =>
                    void runAction({ type: 'bankTrade', uid, give, giveAmount, receive })
                  }
                  onProposeTrade={(give, receive, targetUid) =>
                    void runAction({ type: 'proposeTrade', uid, give, receive, targetUid })
                  }
                  onRespondTrade={(tradeId, accept) => void runAction({ type: 'respondTrade', uid, tradeId, accept })}
                  onCancelTrade={(tradeId) => void runAction({ type: 'cancelTrade', uid, tradeId })}
                />
              </div>
            )}
          </div>
        </footer>
      )}

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
    </div>
  );
}
