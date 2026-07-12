import { describe, expect, it } from 'vitest';
import { createGame, type GameStateBundle } from './rules';
import { decideBotAction } from './bots';

// Regression test for a real production bug: a bot deciding a robber move (after rolling a
// 7, or playing a knight) scored/picked opponents via their PRIVATE hand
// (hands[opponentUid].resources), but the decision bundle passed to decideBotAction in
// firebase/rooms.ts's claimAndRunBotAction only ever contains the acting bot's OWN hand
// (by design — bots shouldn't see hidden opponent card types any more than a human could).
// That crashed with "Cannot read properties of undefined (reading 'resources')", which
// decideBotAction's try/catch silently swallowed into `null` — permanently stalling the
// game the instant a bot rolled a 7, since every retry hit the same crash.

function makeGame(): GameStateBundle {
  return createGame(
    { id: 'r1', code: 'ABCDE', hostUid: 'p0', mapPreset: 'official-beginner', seed: 'bots-robber-test' },
    [
      { uid: 'p0', displayName: 'Bot A', isBot: true, botDifficulty: 'normal' },
      { uid: 'p1', displayName: 'Bot B', isBot: true, botDifficulty: 'normal' },
      { uid: 'p2', displayName: 'Human', isBot: false },
    ],
  );
}

/** Mirrors exactly what claimAndRunBotAction builds: full public players, only the acting
 * bot's own private hand. */
function decisionBundleFor(bundle: GameStateBundle, actingUid: string): GameStateBundle {
  return {
    room: bundle.room,
    players: bundle.players,
    hands: { [actingUid]: bundle.hands[actingUid] },
    trades: [],
  };
}

describe('decideBotAction: robber phase', () => {
  it('decides a moveRobber action without opponent hand data (empty board)', () => {
    const bundle = makeGame();
    bundle.room.phase = 'robber';
    const botUid = bundle.room.turnOrder.find((u) => bundle.players[u].isBot)!;
    bundle.room.currentPlayerIndex = bundle.room.turnOrder.indexOf(botUid);

    const action = decideBotAction(decisionBundleFor(bundle, botUid), botUid);
    expect(action).not.toBeNull();
    expect(action?.type).toBe('moveRobber');
  });

  it('picks a steal target using public resourceCount, not private hands', () => {
    const bundle = makeGame();
    const botUid = bundle.room.turnOrder.find((u) => bundle.players[u].isBot)!;
    const otherUid = bundle.room.turnOrder.find((u) => u !== botUid)!;

    // Give the bot a hex to target: put an opponent settlement on a vertex adjacent to a
    // non-desert hex, with a healthy public resourceCount so it's a worthwhile steal target.
    const board = bundle.room.board!;
    const hex = board.hexes.find((h) => h.terrain !== 'desert')!;
    const vertex = Object.values(board.vertices).find((v) => v.adjacentHexIds.includes(hex.id))!;
    bundle.room.vertices[vertex.id] = { type: 'settlement', uid: otherUid };
    bundle.players[otherUid].resourceCount = 5;
    bundle.hands[otherUid].resources = { brick: 5, lumber: 0, ore: 0, grain: 0, wool: 0 };

    bundle.room.phase = 'robber';
    bundle.room.currentPlayerIndex = bundle.room.turnOrder.indexOf(botUid);

    const action = decideBotAction(decisionBundleFor(bundle, botUid), botUid);
    expect(action).not.toBeNull();
    expect(action?.type).toBe('moveRobber');
  });
});
