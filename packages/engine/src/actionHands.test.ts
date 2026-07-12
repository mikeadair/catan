import { describe, expect, it } from 'vitest';
import { neededHandUidsFor } from './actionHands';

// Regression test for a real production bug: rollDice's distributeResources (rules.ts)
// can credit ANY player with a settlement/city adjacent to the rolled number, not just
// the roller. neededHandUidsFor decides which hands get loaded into the Firestore
// transaction bundle before applyAction runs — if it only loaded the roller's hand,
// crediting another player threw "Cannot read properties of undefined (reading
// 'resources')" as soon as a roll happened to benefit someone other than the roller
// (which a first roll can easily miss triggering, only to surface on a later turn).

describe('neededHandUidsFor', () => {
  const turnOrder = ['p0', 'p1', 'p2'];

  it('loads every player hand for rollDice, since any of them may be credited', () => {
    const uids = neededHandUidsFor({ type: 'rollDice', uid: 'p1' }, turnOrder);
    expect([...uids].sort()).toEqual(['p0', 'p1', 'p2']);
  });

  it('loads every player hand for playMonopoly', () => {
    const uids = neededHandUidsFor({ type: 'playMonopoly', uid: 'p0', devCardId: 'c1', resource: 'ore' }, turnOrder);
    expect([...uids].sort()).toEqual(['p0', 'p1', 'p2']);
  });

  it('loads only the actor for a plain build action', () => {
    const uids = neededHandUidsFor({ type: 'buildRoad', uid: 'p2', edgeId: 'e1' }, turnOrder);
    expect([...uids]).toEqual(['p2']);
  });

  it('loads the actor and steal target for playKnight/moveRobber', () => {
    const uids = neededHandUidsFor(
      { type: 'playKnight', uid: 'p0', devCardId: 'c1', robberHexId: 'h1', stealFromUid: 'p1' },
      turnOrder,
    );
    expect([...uids].sort()).toEqual(['p0', 'p1']);
  });
});
