import type { GameAction, Resource, ResourceCount } from './types';
import { RESOURCES } from './types';

const ACTION_TYPES: GameAction['type'][] = [
  'rollDice',
  'buildRoad',
  'buildSettlement',
  'buildCity',
  'buyDevCard',
  'playKnight',
  'playRoadBuilding',
  'playYearOfPlenty',
  'playMonopoly',
  'moveRobber',
  'discard',
  'bankTrade',
  'proposeTrade',
  'respondTrade',
  'cancelTrade',
  'finalizeTrade',
  'endTurn',
  'removeSeat',
  'timeoutEndTurn',
  'expireTrades',
  'voteToPause',
  'voteToUnpause',
  'pickGoldResources',
];

function isString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}
function isResource(v: unknown): v is Resource {
  return typeof v === 'string' && (RESOURCES as string[]).includes(v);
}
function isPartialResourceCount(v: unknown): v is Partial<ResourceCount> {
  if (typeof v !== 'object' || v === null) return false;
  return Object.entries(v).every(([k, n]) => (RESOURCES as string[]).includes(k) && typeof n === 'number');
}

/**
 * Shallow, wire-contract-only validation: is this shaped enough for applyAction to run
 * without crashing on undefined property access? Never re-implements game legality —
 * that's applyAction's job. Throws a plain Error(message) on failure so callers (the
 * submitAction Cloud Function) can map it to their own error type.
 */
export function assertValidActionShape(action: unknown): asserts action is GameAction {
  if (typeof action !== 'object' || action === null) {
    throw new Error('action must be an object');
  }
  const a = action as Record<string, unknown>;
  if (!isString(a.type) || !ACTION_TYPES.includes(a.type as GameAction['type'])) {
    throw new Error(`Unknown action type: ${String(a.type)}`);
  }
  if (!isString(a.uid)) {
    throw new Error('action.uid must be a non-empty string');
  }

  switch (a.type as GameAction['type']) {
    case 'rollDice':
    case 'buyDevCard':
    case 'endTurn':
    case 'timeoutEndTurn':
    case 'expireTrades':
    case 'voteToPause':
    case 'voteToUnpause':
      return;
    case 'buildRoad':
      if (!isString(a.edgeId)) throw new Error('buildRoad requires edgeId');
      return;
    case 'buildSettlement':
      if (!isString(a.vertexId)) throw new Error('buildSettlement requires vertexId');
      return;
    case 'buildCity':
      if (!isString(a.vertexId)) throw new Error('buildCity requires vertexId');
      return;
    case 'playKnight':
    case 'moveRobber':
      if (!isString(a.robberHexId)) throw new Error(`${a.type} requires robberHexId`);
      if (a.stealFromUid !== null && !isString(a.stealFromUid)) {
        throw new Error(`${a.type} requires stealFromUid to be a string or null`);
      }
      if (a.type === 'playKnight' && !isString(a.devCardId)) throw new Error('playKnight requires devCardId');
      return;
    case 'playRoadBuilding':
      if (!isString(a.devCardId)) throw new Error('playRoadBuilding requires devCardId');
      if (!Array.isArray(a.edgeIds) || a.edgeIds.length !== 2 || !a.edgeIds.every(isString)) {
        throw new Error('playRoadBuilding requires edgeIds: [EdgeId, EdgeId]');
      }
      return;
    case 'playYearOfPlenty':
      if (!isString(a.devCardId)) throw new Error('playYearOfPlenty requires devCardId');
      if (!Array.isArray(a.resources) || a.resources.length !== 2 || !a.resources.every(isResource)) {
        throw new Error('playYearOfPlenty requires resources: [Resource, Resource]');
      }
      return;
    case 'playMonopoly':
      if (!isString(a.devCardId)) throw new Error('playMonopoly requires devCardId');
      if (!isResource(a.resource)) throw new Error('playMonopoly requires a valid resource');
      return;
    case 'discard':
      if (!isPartialResourceCount(a.resources)) throw new Error('discard requires resources');
      return;
    case 'pickGoldResources':
      if (!Array.isArray(a.resources) || a.resources.length === 0 || !a.resources.every(isResource)) {
        throw new Error('pickGoldResources requires resources: Resource[]');
      }
      return;
    case 'bankTrade':
      if (!isResource(a.give)) throw new Error('bankTrade requires give');
      if (typeof a.giveAmount !== 'number') throw new Error('bankTrade requires giveAmount');
      if (!isResource(a.receive)) throw new Error('bankTrade requires receive');
      return;
    case 'proposeTrade':
      if (!isPartialResourceCount(a.give)) throw new Error('proposeTrade requires give');
      if (!isPartialResourceCount(a.receive)) throw new Error('proposeTrade requires receive');
      if (a.targetUid !== null && !isString(a.targetUid)) {
        throw new Error('proposeTrade requires targetUid to be a string or null');
      }
      return;
    case 'respondTrade':
      if (!isString(a.tradeId)) throw new Error('respondTrade requires tradeId');
      if (typeof a.accept !== 'boolean') throw new Error('respondTrade requires accept: boolean');
      return;
    case 'cancelTrade':
      if (!isString(a.tradeId)) throw new Error('cancelTrade requires tradeId');
      return;
    case 'finalizeTrade':
      if (!isString(a.tradeId)) throw new Error('finalizeTrade requires tradeId');
      if (!isString(a.withUid)) throw new Error('finalizeTrade requires withUid');
      return;
    case 'removeSeat':
      if (!isString(a.targetUid)) throw new Error('removeSeat requires targetUid');
      return;
  }
}
