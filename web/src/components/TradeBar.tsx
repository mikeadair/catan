// Inline trade bar that lives directly above the hand in the bottom toolbar (replaces the
// old expand/collapse popover). "You want" is built here via a BankPanel-style row of
// resource cards with a +/- stepper per type. The "give" side is *not* duplicated here —
// composing it happens by tapping cards directly in the hand rendered just below this bar
// (see Game.tsx, which lifts the shared `give`/`receive`/`targetUid` composer state so both
// this component and the hand's <ResourceHand variant="cards"> can read/write it). Bank
// Trade only lights up once the current give/receive selection is a valid N:1 offer.
import type { JSX } from 'react';
import type { PublicPlayer, Resource, ResourceCount, RoomState } from '@catan/engine';
import { RESOURCES } from '@catan/engine';
import { RESOURCE_ICON, RESOURCE_LABEL } from './resourceIcons';
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

export interface TradeBarProps {
  room: RoomState;
  players: Record<string, PublicPlayer>;
  uid: string;
  /** Staged "give" side, sourced from tapping cards in the hand rendered below this bar —
   * owned by Game.tsx so both components can see it. */
  give: Partial<ResourceCount>;
  /** Staged "want" side, built and owned right here via the stepper row. */
  receive: Partial<ResourceCount>;
  onReceiveChange: (next: Partial<ResourceCount>) => void;
  targetUid: string;
  onTargetUidChange: (uid: string) => void;
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
  give,
  receive,
  onReceiveChange,
  targetUid,
  onTargetUidChange,
  canTrade,
  blocked,
  onBankTrade,
  onProposeTrade,
}: TradeBarProps): JSX.Element {
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
          ? 'Tap cards in your hand below to choose what to give'
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

  function handlePropose() {
    onProposeTrade(give, receive, targetUid || null);
  }

  function handleBankTrade() {
    if (!givenOne || !receivedOne || bankRate === null) return;
    onBankTrade(givenOne.resource, bankRate, receivedOne.resource);
  }

  function stepReceive(r: Resource, delta: number) {
    onReceiveChange({ ...receive, [r]: Math.max(0, (receive[r] ?? 0) + delta) });
  }

  return (
    <div className="trade-bar">
      <div className="trade-bar__want">
        <span className="trade-bar__want-label">You want</span>
        <div className="trade-bar__want-cards">
          {RESOURCES.map((r) => {
            const count = receive[r] ?? 0;
            return (
              <div key={r} className={`trade-bar__want-card trade-bar__want-card--${r}`}>
                <img src={RESOURCE_ICON[r]} alt={RESOURCE_LABEL[r]} className="trade-bar__want-icon" />
                <span className="trade-bar__want-name">{RESOURCE_LABEL[r]}</span>
                <span className="trade-bar__want-stepper">
                  <button
                    type="button"
                    onClick={() => stepReceive(r, -1)}
                    disabled={count <= 0}
                    aria-label={`Remove ${RESOURCE_LABEL[r]} from what you want`}
                  >
                    −
                  </button>
                  <span className="trade-bar__want-count">{count}</span>
                  <button
                    type="button"
                    onClick={() => stepReceive(r, 1)}
                    aria-label={`Add ${RESOURCE_LABEL[r]} to what you want`}
                  >
                    +
                  </button>
                </span>
              </div>
            );
          })}
        </div>
      </div>

      <div className="trade-bar__actions">
        <select value={targetUid} onChange={(e) => onTargetUidChange(e.target.value)} aria-label="Trade target">
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
  );
}
