// Pending trades relevant to the current player, shown persistently in the sidebar (not
// tucked behind a popover) so they're impossible to miss and directly actionable by
// whoever proposed them (Cancel, or finalize with a chosen interested player) or anyone
// else who could accept/reject them.
import type { JSX } from 'react';
import type { PublicPlayer, ResourceCount, TradeOffer } from '@catan/engine';
import { RESOURCES } from '@catan/engine';
import './TradeOffers.css';

function canAffordCost(resources: ResourceCount, cost: Partial<ResourceCount>): boolean {
  return RESOURCES.every((r) => (resources[r] ?? 0) >= (cost[r] ?? 0));
}

function describeResources(r: Partial<ResourceCount>): string {
  const parts = RESOURCES.filter((res) => (r[res] ?? 0) > 0).map((res) => `${r[res]} ${res}`);
  return parts.length > 0 ? parts.join(', ') : 'nothing';
}

export interface TradeOffersProps {
  uid: string;
  players: Record<string, PublicPlayer>;
  ownResources: ResourceCount;
  trades: TradeOffer[];
  /** True while a different action is already in flight — blocks new trade actions to
   * avoid double-submits. */
  blocked: boolean;
  onRespondTrade: (tradeId: string, accept: boolean) => void;
  onCancelTrade: (tradeId: string) => void;
  onFinalizeTrade: (tradeId: string, withUid: string) => void;
}

export default function TradeOffers({
  uid,
  players,
  ownResources,
  trades,
  blocked,
  onRespondTrade,
  onCancelTrade,
  onFinalizeTrade,
}: TradeOffersProps): JSX.Element | null {
  const relevantTrades = trades.filter(
    (t) => t.status === 'pending' && (t.proposerUid === uid || t.targetUid === uid || t.targetUid === null),
  );
  if (relevantTrades.length === 0) return null;

  const disabledTitle = blocked ? 'Waiting for previous action…' : undefined;

  return (
    <div className="trade-offers">
      <div className="trade-offers__header">Trades ({relevantTrades.length})</div>
      <div className="trade-offers__list">
        {relevantTrades.map((t) => {
          const proposer = players[t.proposerUid];
          const isMine = t.proposerUid === uid;
          const isOpen = t.targetUid === null;
          const interested = t.interestedUids ?? [];
          const iAmInterested = interested.includes(uid);

          return (
            <div key={t.id} className="trade-offers__trade">
              <div className="trade-offers__desc">
                <strong>{isMine ? 'You' : (proposer?.displayName ?? 'Someone')}</strong> offer
                {isMine ? '' : 's'} {describeResources(t.give)} for {describeResources(t.receive)}
                {isOpen && !isMine ? ' (open to all)' : ''}
              </div>

              {isMine && isOpen && interested.length > 0 && (
                <div className="trade-offers__interested">
                  {interested.map((interestedUid) => (
                    <button
                      key={interestedUid}
                      type="button"
                      onClick={() => onFinalizeTrade(t.id, interestedUid)}
                      disabled={blocked}
                      title={disabledTitle}
                    >
                      Trade with {players[interestedUid]?.displayName ?? 'them'}
                    </button>
                  ))}
                </div>
              )}

              <div className="trade-offers__actions">
                {isMine ? (
                  <>
                    {isOpen && interested.length === 0 && (
                      <span className="trade-offers__waiting">Waiting for offers…</span>
                    )}
                    <button type="button" onClick={() => onCancelTrade(t.id)} disabled={blocked} title={disabledTitle}>
                      Cancel
                    </button>
                  </>
                ) : isOpen && iAmInterested ? (
                  <>
                    <span className="trade-offers__waiting">Waiting for {proposer?.displayName ?? 'proposer'} to choose…</span>
                    <button type="button" onClick={() => onRespondTrade(t.id, false)} disabled={blocked} title={disabledTitle}>
                      Withdraw
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      type="button"
                      onClick={() => onRespondTrade(t.id, true)}
                      disabled={blocked || !canAffordCost(ownResources, t.receive)}
                      title={
                        blocked
                          ? disabledTitle
                          : !canAffordCost(ownResources, t.receive)
                            ? `You don't have ${describeResources(t.receive)}`
                            : undefined
                      }
                    >
                      Accept
                    </button>
                    <button type="button" onClick={() => onRespondTrade(t.id, false)} disabled={blocked} title={disabledTitle}>
                      Reject
                    </button>
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
