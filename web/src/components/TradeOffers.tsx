// Pending trades relevant to the current player, shown persistently as an overlay in the
// board's own water margin (not tucked behind a popover, and not a layout-participating grid
// column — see Game.css's .game__trades-overlay) so they're impossible to miss and directly
// actionable by whoever proposed them (Cancel, or finalize with a chosen interested player)
// or anyone else who could accept/reject them.
import { useEffect, useRef, useState, type CSSProperties, type JSX } from 'react';
import type { PublicPlayer, Resource, ResourceCount, TradeOffer } from '@catan/engine';
import { RESOURCES, tradeBlocked } from '@catan/engine';
import { RESOURCE_ICON, RESOURCE_LABEL } from './resourceIcons';
import { PLAYER_COLOR_HEX } from './playerColors';
import './TradeOffers.css';

// How long a trade whose responders have *all* rejected it stays visible (with a red
// outline) before it's dropped from view — long enough to register as "this got rejected"
// rather than the card just silently vanishing, short enough not to clutter the overlay.
const ALL_REJECTED_FLASH_MS = 1800;

function canAffordCost(resources: ResourceCount, cost: Partial<ResourceCount>): boolean {
  return RESOURCES.every((r) => (resources[r] ?? 0) >= (cost[r] ?? 0));
}

function describeResources(r: Partial<ResourceCount>): string {
  const parts = RESOURCES.filter((res) => (r[res] ?? 0) > 0).map((res) => `${r[res]} ${res}`);
  return parts.length > 0 ? parts.join(', ') : 'nothing';
}

/** True if `t` should show up at all for `uid`, regardless of status. */
function isRelevant(t: TradeOffer, uid: string): boolean {
  return t.proposerUid === uid || t.targetUid === uid || t.targetUid === null;
}

/** Every uid who needs to respond to this trade — the single target for a targeted trade, or
 * every other player in the room for an open one. Used to render one status circle per
 * responder and to detect "everyone said no". */
function respondersFor(trade: TradeOffer, players: Record<string, PublicPlayer>): string[] {
  if (trade.targetUid !== null) return [trade.targetUid];
  return Object.values(players)
    .filter((p) => p.uid !== trade.proposerUid)
    .sort((a, b) => a.seatIndex - b.seatIndex)
    .map((p) => p.uid);
}

type ResponderStatus = 'pending' | 'accepted' | 'rejected';

/** A targeted trade has only one possible responder, so their answer is just `status` —
 * accepting/rejecting it resolves the trade directly (see respondTrade in rules.ts). An open
 * trade can draw a mix of responses from several players at once, tracked via
 * interestedUids/rejectedUids while `status` itself stays 'pending' until the proposer
 * finalizes or cancels. */
function responderStatus(trade: TradeOffer, responderUid: string): ResponderStatus {
  if (trade.targetUid !== null) {
    if (trade.status === 'accepted') return 'accepted';
    if (trade.status === 'rejected') return 'rejected';
    return 'pending';
  }
  if (trade.interestedUids?.includes(responderUid)) return 'accepted';
  if (trade.rejectedUids?.includes(responderUid)) return 'rejected';
  return 'pending';
}

/** Compact row of small resource-card icons + counts, in the spirit of BankPanel/ResourceHand's
 * card faces but scaled down to fit a narrow trade-offer line. Used for both the "give" and
 * "receive" side of an offer. */
function ResourceIconRow({ resources }: { resources: Partial<ResourceCount> }): JSX.Element {
  const entries = RESOURCES.filter((r) => (resources[r] ?? 0) > 0);
  if (entries.length === 0) {
    return <span className="trade-offers__resource-row trade-offers__resource-row--empty">nothing</span>;
  }
  return (
    <span className="trade-offers__resource-row">
      {entries.map((r: Resource) => (
        <span key={r} className={`trade-offers__resource-chip trade-offers__resource-chip--${r}`}>
          <img src={RESOURCE_ICON[r]} alt={RESOURCE_LABEL[r]} className="trade-offers__resource-icon" />
          <span className="trade-offers__resource-count">{resources[r]}</span>
        </span>
      ))}
    </span>
  );
}

/** One small circle per player who needs to respond to this trade, in that player's color
 * with their initial inside — a check or x mark overlays it once they've actually responded. */
function ResponderDots({
  trade,
  players,
}: {
  trade: TradeOffer;
  players: Record<string, PublicPlayer>;
}): JSX.Element | null {
  const responders = respondersFor(trade, players);
  if (responders.length === 0) return null;
  return (
    <div className="trade-offers__responders">
      {responders.map((responderUid) => {
        const p = players[responderUid];
        const status = responderStatus(trade, responderUid);
        const style = { '--player-color': p ? PLAYER_COLOR_HEX[p.color] : '#888' } as CSSProperties;
        const initial = p?.displayName.trim().charAt(0).toUpperCase() || '?';
        const statusLabel = status === 'accepted' ? 'accepted' : status === 'rejected' ? 'rejected' : 'awaiting response';
        return (
          <span
            key={responderUid}
            className={`trade-offers__responder trade-offers__responder--${status}`}
            style={style}
            title={`${p?.displayName ?? 'Player'} — ${statusLabel}`}
            data-testid={`responder-${trade.id}-${responderUid}`}
            data-responder-status={status}
          >
            <span className="trade-offers__responder-initial">{initial}</span>
            {status === 'accepted' && (
              <span className="trade-offers__responder-badge trade-offers__responder-badge--accept" aria-hidden>
                ✓
              </span>
            )}
            {status === 'rejected' && (
              <span className="trade-offers__responder-badge trade-offers__responder-badge--reject" aria-hidden>
                ✗
              </span>
            )}
          </span>
        );
      })}
    </div>
  );
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
  /** Opens the trade composer pre-seeded as a counter to this trade (see Game.tsx's
   * startCounterOffer) — nothing is submitted until the player sends the counter. */
  onCounterTrade: (trade: TradeOffer) => void;
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
  onCounterTrade,
  onCancelTrade,
  onFinalizeTrade,
}: TradeOffersProps): JSX.Element | null {
  // tradeId -> timestamp after which a trade every responder rejected should stop rendering.
  // Populated below the moment "everyone said no" is detected, so the card can flash red for
  // a bit instead of just disappearing the instant its last responder rejects.
  const [dismissAt, setDismissAt] = useState<Record<string, number>>({});
  // Guards against re-issuing cancelTrade for the same open trade every time this effect
  // re-runs while we wait for the server round-trip to land.
  const calledCancelRef = useRef<Set<string>>(new Set());
  // No state is read here — just forces a re-render so expired dismiss windows actually drop
  // their trade out of the list instead of lingering until some unrelated prop changes.
  const [, forceTick] = useState(0);

  useEffect(() => {
    const now = Date.now();
    const toSchedule: string[] = [];
    for (const t of trades) {
      if (!isRelevant(t, uid) || dismissAt[t.id] !== undefined) continue;
      const responders = respondersFor(t, players);
      if (responders.length === 0) continue;
      const allRejected = responders.every((r) => responderStatus(t, r) === 'rejected');
      if (!allRejected) continue;
      toSchedule.push(t.id);
      // A targeted trade's single rejection already flips `status` to 'rejected' via
      // respondTrade — but an open trade's `status` stays 'pending' even once every possible
      // responder has said no (there's no counterparty to "reject" against). Only the
      // proposer's own client may legally cancel it, and only once.
      if (t.status === 'pending' && t.proposerUid === uid && !blocked && !calledCancelRef.current.has(t.id)) {
        calledCancelRef.current.add(t.id);
        onCancelTrade(t.id);
      }
    }
    if (toSchedule.length === 0) return;
    setDismissAt((cur) => {
      const next = { ...cur };
      for (const id of toSchedule) next[id] = now + ALL_REJECTED_FLASH_MS;
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trades, players, uid, blocked]);

  useEffect(() => {
    if (Object.keys(dismissAt).length === 0) return;
    const interval = setInterval(() => forceTick((x) => x + 1), 250);
    return () => clearInterval(interval);
  }, [dismissAt]);

  // Guards against re-issuing respondTrade(false) for the same trade every time this effect
  // re-runs while we wait for the server round-trip to land.
  const calledAutoRejectRef = useRef<Set<string>>(new Set());

  // A responder who plainly cannot afford a trade's ask (Accept is disabled below for exactly
  // this reason) shouldn't have to notice that and click Reject themselves — auto-reject on
  // their behalf the moment it's detected, same as a bot would (see decideTradeResponse in
  // bots.ts, which always returns an explicit accept/reject and never just leaves a trade
  // hanging). This also speeds up the "everyone rejected" flash/auto-cancel effect above for
  // open trades: without it, a human responder who can't afford the trade but never gets
  // around to clicking Reject keeps that trade from ever reading as fully rejected.
  useEffect(() => {
    for (const t of trades) {
      if (t.status !== 'pending' || t.proposerUid === uid || !isRelevant(t, uid)) continue;
      // Targeted trades are exempt: this player is the *only* responder, and not being able
      // to afford the ask is precisely when a counter-offer makes sense — auto-rejecting
      // here would kill the Counter button's window before the player could use it. The
      // room's trade-response timer still resolves a targeted trade nobody answers.
      if (t.targetUid !== null) continue;
      if (blocked || calledAutoRejectRef.current.has(t.id)) continue;
      if (responderStatus(t, uid) !== 'pending') continue;
      if (canAffordCost(ownResources, t.receive)) continue;
      calledAutoRejectRef.current.add(t.id);
      onRespondTrade(t.id, false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trades, uid, ownResources, blocked]);

  const relevantTrades = trades.filter((t) => {
    const until = dismissAt[t.id];
    if (until !== undefined) {
      // A scheduled dismiss window (every responder rejected) governs visibility once set,
      // regardless of `status` — an *open* trade whose every responder said no can otherwise
      // stay 'pending' forever from this viewer's perspective (only the proposer's own client
      // ever calls cancelTrade, and it may be blocked/offline/not this client at all), which
      // would leave the red flash on screen indefinitely instead of it actually dismissing.
      return Date.now() < until;
    }
    if (t.status !== 'pending' || !isRelevant(t, uid)) return false;
    // Someone else's incoming offer, from a player this viewer has blocked (or vice versa) —
    // respondTrade would just reject the accept server-side (see tradeBlocked in rules.ts), so
    // don't bother showing it. The proposer's own client still sees/cancels its own trades
    // regardless of a block added after the fact.
    if (t.proposerUid !== uid && tradeBlocked(players, uid, t.proposerUid)) return false;
    return true;
  });
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
          const isDismissing = dismissAt[t.id] !== undefined;
          const actionsDisabled = blocked || isDismissing;
          const actionsDisabledTitle = isDismissing ? 'Everyone rejected this trade' : disabledTitle;

          return (
            <div
              key={t.id}
              className={`trade-offers__trade${isDismissing ? ' trade-offers__trade--all-rejected' : ''}`}
              data-testid={`trade-${t.id}`}
              data-trade-status={t.status}
            >
              <div className="trade-offers__desc">
                <div className="trade-offers__desc-who">
                  <strong>{isMine ? 'You' : (proposer?.displayName ?? 'Someone')}</strong> offer{isMine ? '' : 's'}
                  {isOpen && !isMine ? <span className="trade-offers__open-tag">open to all</span> : null}
                </div>
                {/* Always from the VIEWER's perspective, with explicit gain/loss labels — the
                    old proposer-perspective `give → receive` arrow made the responder mentally
                    flip the trade around before knowing whether Accept was good for them. */}
                <div className="trade-offers__exchange">
                  <div className="trade-offers__exchange-row">
                    <span className="trade-offers__exchange-label trade-offers__exchange-label--get">You get</span>
                    <ResourceIconRow resources={isMine ? t.receive : t.give} />
                  </div>
                  <div className="trade-offers__exchange-row">
                    <span className="trade-offers__exchange-label trade-offers__exchange-label--give">You give</span>
                    <ResourceIconRow resources={isMine ? t.give : t.receive} />
                  </div>
                </div>
                <ResponderDots trade={t} players={players} />
              </div>

              {isMine && isOpen && interested.length > 0 && (
                <div className="trade-offers__interested">
                  {interested.filter((interestedUid) => !tradeBlocked(players, uid, interestedUid)).map((interestedUid) => (
                    <button
                      key={interestedUid}
                      type="button"
                      onClick={() => onFinalizeTrade(t.id, interestedUid)}
                      disabled={actionsDisabled}
                      title={actionsDisabledTitle}
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
                    <button
                      type="button"
                      onClick={() => onCancelTrade(t.id)}
                      disabled={actionsDisabled}
                      title={actionsDisabledTitle}
                    >
                      Cancel
                    </button>
                  </>
                ) : isOpen && iAmInterested ? (
                  <>
                    <span className="trade-offers__waiting">Waiting for {proposer?.displayName ?? 'proposer'} to choose…</span>
                    <button
                      type="button"
                      onClick={() => onRespondTrade(t.id, false)}
                      disabled={actionsDisabled}
                      title={actionsDisabledTitle}
                    >
                      Withdraw
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      type="button"
                      className="trade-offers__action--accept"
                      onClick={() => onRespondTrade(t.id, true)}
                      disabled={actionsDisabled || !canAffordCost(ownResources, t.receive)}
                      title={
                        actionsDisabled
                          ? actionsDisabledTitle
                          : !canAffordCost(ownResources, t.receive)
                            ? `You don't have ${describeResources(t.receive)}`
                            : undefined
                      }
                    >
                      Accept
                    </button>
                    <button
                      type="button"
                      onClick={() => onCounterTrade(t)}
                      disabled={actionsDisabled}
                      title={actionsDisabledTitle ?? 'Open the composer pre-filled with this offer flipped around'}
                    >
                      Counter
                    </button>
                    <button
                      type="button"
                      className="trade-offers__action--reject"
                      onClick={() => onRespondTrade(t.id, false)}
                      disabled={actionsDisabled}
                      title={actionsDisabledTitle}
                    >
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
