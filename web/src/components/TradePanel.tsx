import { useState, type JSX } from 'react';
import type { PublicPlayer, Resource, ResourceCount, RoomState } from '@catan/engine';
import { RESOURCES } from '@catan/engine';
import ResourceHand from './ResourceHand';
import './TradePanel.css';

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

export interface TradePanelProps {
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

export default function TradePanel({
  room,
  players,
  uid,
  ownResources,
  canTrade,
  blocked,
  onBankTrade,
  onProposeTrade,
}: TradePanelProps): JSX.Element {
  const rates = computePortRates(room, uid);

  const [bankGive, setBankGive] = useState<Resource>('brick');
  const [bankReceive, setBankReceive] = useState<Resource>('lumber');

  const [offerGive, setOfferGive] = useState<Partial<ResourceCount>>({});
  const [offerReceive, setOfferReceive] = useState<Partial<ResourceCount>>({});
  const [targetUid, setTargetUid] = useState<string>('');

  const bankRate = rates[bankGive];
  const canBankTrade =
    canTrade &&
    !blocked &&
    bankGive !== bankReceive &&
    ownResources[bankGive] >= bankRate &&
    room.bank[bankReceive] >= 1;
  const bankTradeReason = blocked
    ? 'Waiting for previous action…'
    : canBankTrade
      ? undefined
      : !canTrade
        ? 'Not your turn'
        : bankGive === bankReceive
          ? 'Choose two different resources'
          : ownResources[bankGive] < bankRate
            ? `Need ${bankRate} ${bankGive}`
            : `Bank is out of ${bankReceive}`;

  function handleBankTrade() {
    onBankTrade(bankGive, bankRate, bankReceive);
  }

  const offerGiveTotal = RESOURCES.reduce((s, r) => s + (offerGive[r] ?? 0), 0);
  const offerReceiveTotal = RESOURCES.reduce((s, r) => s + (offerReceive[r] ?? 0), 0);
  const canPropose = canTrade && !blocked && offerGiveTotal > 0 && offerReceiveTotal > 0;
  const proposeReason = blocked
    ? 'Waiting for previous action…'
    : canPropose
      ? undefined
      : !canTrade
        ? 'Not your turn'
        : offerGiveTotal === 0
          ? 'Choose what to give'
          : 'Choose what to receive';

  function handlePropose() {
    onProposeTrade(offerGive, offerReceive, targetUid || null);
    setOfferGive({});
    setOfferReceive({});
  }

  const otherPlayers = Object.values(players).filter((p) => p.uid !== uid);

  return (
    <div className="trade-panel">
      <div className="trade-panel__section">
        <div className="trade-panel__header">Bank Trade</div>
        <div className="trade-panel__bank-row">
          <select value={bankGive} onChange={(e) => setBankGive(e.target.value as Resource)}>
            {RESOURCES.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
          <span className="trade-panel__rate">{bankRate}:1 →</span>
          <select value={bankReceive} onChange={(e) => setBankReceive(e.target.value as Resource)}>
            {RESOURCES.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
          <button type="button" onClick={handleBankTrade} disabled={!canBankTrade} title={bankTradeReason}>
            Trade
          </button>
        </div>
      </div>

      <div className="trade-panel__section">
        <div className="trade-panel__header">Propose Player Trade</div>
        <div className="trade-panel__label">You give</div>
        <ResourceHand resources={ownResources} selected={offerGive} onChange={setOfferGive} />
        <div className="trade-panel__label">You receive</div>
        <ResourceHand resources={UNLIMITED_POOL} unlimited selected={offerReceive} onChange={setOfferReceive} />
        <div className="trade-panel__target-row">
          <select value={targetUid} onChange={(e) => setTargetUid(e.target.value)}>
            <option value="">Open to all</option>
            {otherPlayers.map((p) => (
              <option key={p.uid} value={p.uid}>
                {p.displayName}
              </option>
            ))}
          </select>
          <button type="button" onClick={handlePropose} disabled={!canPropose} title={proposeReason}>
            Propose
          </button>
        </div>
      </div>
    </div>
  );
}
