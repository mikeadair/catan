// Inline trade panel that lives in the bottom toolbar (replaces the old popover-modal
// TradePanel): a Trade toggle to the left of the hand switches the hand into a "give"
// selector, a "you want" row above it builds the receive side, and Offer/Bank Trade sit
// on the right — Bank Trade only lights up once the current selection is a valid N:1 offer.
import { useState, type JSX } from 'react';
import type { PublicPlayer, Resource, ResourceCount, RoomState } from '@catan/engine';
import { RESOURCES } from '@catan/engine';
import ResourceHand from './ResourceHand';
import { TradeIcon } from './gameIcons';
import './TradeBar.css';

function computePortRates(room: RoomState, uid: string): Record<Resource, number> {
  const rates: Record<Resource, number> = { brick: 4, lumber: 4, ore: 4, grain: 4, wool: 4 };
  const board = room.board;
  if (!board) return rates;
  const myVertices = new Set(Object.entries(room.vertices).filter(([, b]) => b.uid === uid).map(([id]) => id));
  for (const port of board.ports) {
    if (!port.vertexIds.some((v) => myVertices.has(v))) continue;
    if (port.type === 'generic') {
      for (const r of RESOURCES) rates[r] = Math.min(rates[r], 3);
    } else {
      rates[port.type] = Math.min(rates[port.type], 2);
    }
  }
  return rates;
}

const UNLIMITED_POOL: ResourceCount = { brick: 99, lumber: 99, ore: 99, grain: 99, wool: 99 };

export interface TradeBarProps {
  room: RoomState;
  players: Record<string, PublicPlayer>;
  uid: string;
  ownResources: ResourceCount;
  canTrade: boolean;
  /** True while a different action is already in flight — blocks new trade actions to
   * avoid double-submits. */
  blocked: boolean;
  onBankTrade: (give: Resource, giveAmount: number, receive: Resource) => void;
  onProposeTrade: (give: Partial<ResourceCount>, receive: Partial<ResourceCount>, targetUid: string | null) => void;
}

function singleSelection(sel: Partial<ResourceCount>): { resource: Resource; amount: number } | null {
  const entries = RESOURCES.filter((r) => (sel[r] ?? 0) > 0);
  if (entries.length !== 1) return null;
  return { resource: entries[0], amount: sel[entries[0]] ?? 0 };
}

export default function TradeBar({
  room,
  players,
  uid,
  ownResources,
  canTrade,
  blocked,
  onBankTrade,
  onProposeTrade,
}: TradeBarProps): JSX.Element {
  const [active, setActive] = useState(false);
  const [give, setGive] = useState<Partial<ResourceCount>>({});
  const [receive, setReceive] = useState<Partial<ResourceCount>>({});
  const [targetUid, setTargetUid] = useState<string>('');

  const rates = computePortRates(room, uid);
  const otherPlayers = Object.values(players).filter((p) => p.uid !== uid);

  const giveTotal = RESOURCES.reduce((s, r) => s + (give[r] ?? 0), 0);
  const receiveTotal = RESOURCES.reduce((s, r) => s + (receive[r] ?? 0), 0);

  const canPropose = canTrade && !blocked && giveTotal > 0 && receiveTotal > 0;
  const proposeReason = blocked
    ? 'Waiting for previous action…'
    : canPropose
      ? undefined
      : !canTrade
        ? 'Not your turn'
        : giveTotal === 0
          ? 'Choose what to give'
          : 'Choose what you want';

  const givenOne = singleSelection(give);
  const receivedOne = singleSelection(receive);
  const bankRate = givenOne ? rates[givenOne.resource] : null;
  const validBankShape =
    givenOne !== null &&
    receivedOne !== null &&
    givenOne.resource !== receivedOne.resource &&
    receivedOne.amount === 1 &&
    givenOne.amount === bankRate;
  const canBankTrade =
    canTrade && !blocked && validBankShape && receivedOne !== null && room.bank[receivedOne.resource] >= 1;
  const bankTradeReason = blocked
    ? 'Waiting for previous action…'
    : canBankTrade
      ? undefined
      : !canTrade
        ? 'Not your turn'
        : !validBankShape
          ? `Select one resource to give (at your ${givenOne ? bankRate : 'bank/port'} rate) and one to receive`
          : `Bank is out of ${receivedOne!.resource}`;

  function reset() {
    setGive({});
    setReceive({});
    setTargetUid('');
  }

  function handlePropose() {
    onProposeTrade(give, receive, targetUid || null);
    reset();
  }

  function handleBankTrade() {
    if (!givenOne || !receivedOne || bankRate === null) return;
    onBankTrade(givenOne.resource, bankRate, receivedOne.resource);
    reset();
  }

  return (
    <div className="trade-bar">
      <button
        type="button"
        className={`trade-bar__toggle${active ? ' trade-bar__toggle--active' : ''}`}
        onClick={() => setActive((v) => !v)}
        title="Trade"
      >
        <TradeIcon className="trade-bar__toggle-icon" />
        <span>Trade</span>
      </button>

      {active && (
        <div className="trade-bar__panel">
          <div className="trade-bar__row">
            <span className="trade-bar__row-label">You want</span>
            <ResourceHand resources={UNLIMITED_POOL} unlimited selected={receive} onChange={setReceive} />
          </div>
          <div className="trade-bar__row">
            <span className="trade-bar__row-label">You give</span>
            <ResourceHand resources={ownResources} selected={give} onChange={setGive} />
          </div>
          <div className="trade-bar__actions">
            <select value={targetUid} onChange={(e) => setTargetUid(e.target.value)}>
              <option value="">Open to all</option>
              {otherPlayers.map((p) => (
                <option key={p.uid} value={p.uid}>
                  {p.displayName}
                </option>
              ))}
            </select>
            <button type="button" onClick={handlePropose} disabled={!canPropose} title={proposeReason}>
              Offer Trade
            </button>
            <button type="button" onClick={handleBankTrade} disabled={!canBankTrade} title={bankTradeReason}>
              Bank Trade
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
