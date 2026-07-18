import { describe, expect, it } from 'vitest';
import { assertValidActionShape } from './actionValidation';

describe('assertValidActionShape', () => {
  it('accepts a well-formed action of every type', () => {
    const valid: unknown[] = [
      { type: 'rollDice', uid: 'p0' },
      { type: 'buildRoad', uid: 'p0', edgeId: 'e1' },
      { type: 'buildSettlement', uid: 'p0', vertexId: 'v1' },
      { type: 'buildCity', uid: 'p0', vertexId: 'v1' },
      { type: 'buyDevCard', uid: 'p0' },
      { type: 'playKnight', uid: 'p0', devCardId: 'c1', robberHexId: 'h1', stealFromUid: null },
      { type: 'playKnight', uid: 'p0', devCardId: 'c1', robberHexId: 'h1', stealFromUid: 'p1' },
      { type: 'playRoadBuilding', uid: 'p0', devCardId: 'c1' },
      { type: 'playYearOfPlenty', uid: 'p0', devCardId: 'c1', resources: ['ore', 'grain'] },
      { type: 'playMonopoly', uid: 'p0', devCardId: 'c1', resource: 'ore' },
      { type: 'moveRobber', uid: 'p0', robberHexId: 'h1', stealFromUid: null },
      { type: 'discard', uid: 'p0', resources: { ore: 2 } },
      { type: 'timeoutDiscard', uid: 'p0' },
      { type: 'bankTrade', uid: 'p0', give: 'ore', giveAmount: 4, receive: 'grain' },
      { type: 'proposeTrade', uid: 'p0', give: { ore: 1 }, receive: { grain: 1 }, targetUid: null },
      { type: 'respondTrade', uid: 'p0', tradeId: 't1', accept: true },
      { type: 'cancelTrade', uid: 'p0', tradeId: 't1' },
      { type: 'endTurn', uid: 'p0' },
      { type: 'removeSeat', uid: 'p0', targetUid: 'p0' },
      { type: 'timeoutEndTurn', uid: 'p0' },
      { type: 'expireTrades', uid: 'p0' },
      { type: 'timeoutTradeResponse', uid: 'p0' },
      { type: 'voteToPause', uid: 'p0' },
      { type: 'voteToUnpause', uid: 'p0' },
    ];
    for (const action of valid) {
      expect(() => assertValidActionShape(action)).not.toThrow();
    }
  });

  it('rejects non-object input', () => {
    expect(() => assertValidActionShape(null)).toThrow();
    expect(() => assertValidActionShape('rollDice')).toThrow();
    expect(() => assertValidActionShape(undefined)).toThrow();
  });

  it('rejects an unknown action type', () => {
    expect(() => assertValidActionShape({ type: 'teleport', uid: 'p0' })).toThrow(/unknown action type/i);
  });

  it('rejects a missing or non-string uid', () => {
    expect(() => assertValidActionShape({ type: 'rollDice' })).toThrow(/uid/i);
    expect(() => assertValidActionShape({ type: 'rollDice', uid: 5 })).toThrow(/uid/i);
  });

  it('rejects a build action missing its target id', () => {
    expect(() => assertValidActionShape({ type: 'buildRoad', uid: 'p0' })).toThrow(/edgeId/);
  });

  it('rejects malformed resource payloads', () => {
    expect(() => assertValidActionShape({ type: 'discard', uid: 'p0', resources: { ore: 'two' } })).toThrow();
    expect(() =>
      assertValidActionShape({ type: 'bankTrade', uid: 'p0', give: 'notAResource', giveAmount: 4, receive: 'ore' }),
    ).toThrow();
  });
});
