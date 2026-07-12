import type { GameAction } from './types';

// Decides which players' private hand docs a given action needs loaded into a
// GameStateBundle before applyAction runs. Kept in the shared engine package
// (rather than duplicated per Firestore SDK) because drift here is a real
// correctness bug: forgetting a new action type needs extra hands loaded makes
// applyAction throw trying to credit/debit an unloaded player's hand.
export function neededHandUidsFor(action: GameAction, turnOrder: string[]): Set<string> {
  const uids = new Set<string>([action.uid]);
  if ((action.type === 'playKnight' || action.type === 'moveRobber') && action.stealFromUid) {
    uids.add(action.stealFromUid);
  }
  if (action.type === 'playMonopoly') {
    turnOrder.forEach((u) => uids.add(u));
  }
  if (action.type === 'rollDice') {
    // distributeResources can credit ANY player with a settlement/city adjacent to the
    // rolled number, not just the roller — every hand needs to be loaded into the
    // transaction bundle or rules.ts throws trying to credit an unloaded player's hand.
    turnOrder.forEach((u) => uids.add(u));
  }
  if (action.type === 'finalizeTrade') {
    uids.add(action.withUid);
  }
  return uids;
}
