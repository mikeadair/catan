// Compact dice-roll distribution for the sidebar: one bar per sum (2–12) with a tick at the
// statistically expected count, derived purely from room.log's diceRoll metas — no engine or
// server involvement. Collapsed by default (native <details>) so it costs the sidebar nothing
// until someone wants it.
import type { JSX } from 'react';
import type { RoomState } from '@catan/engine';
import './RollStats.css';

// Ways to roll each sum 2..12 with two dice, out of 36.
const WAYS = [1, 2, 3, 4, 5, 6, 5, 4, 3, 2, 1];

export default function RollStats({ log }: { log: RoomState['log'] }): JSX.Element | null {
  const counts = new Array<number>(11).fill(0);
  let total = 0;
  for (const entry of log) {
    if (entry.meta?.kind === 'diceRoll') {
      counts[entry.meta.roll[0] + entry.meta.roll[1] - 2]++;
      total++;
    }
  }
  if (total === 0) return null;

  const max = Math.max(...counts, 1);
  return (
    <details className="roll-stats">
      <summary className="roll-stats__summary">
        Roll stats ({total} roll{total === 1 ? '' : 's'})
      </summary>
      <div className="roll-stats__bars">
        {counts.map((count, i) => {
          const sum = i + 2;
          const expected = (WAYS[i] / 36) * total;
          return (
            <div
              key={sum}
              className="roll-stats__col"
              title={`${sum}: rolled ${count}× (expected ~${expected.toFixed(1)})`}
            >
              <div className="roll-stats__bar-area">
                <div className="roll-stats__bar" style={{ height: `${(count / max) * 100}%` }} />
                <div
                  className="roll-stats__expected"
                  style={{ bottom: `${Math.min(100, (expected / max) * 100)}%` }}
                />
              </div>
              <span className={`roll-stats__label${sum === 6 || sum === 8 ? ' roll-stats__label--hot' : ''}`}>
                {sum}
              </span>
            </div>
          );
        })}
      </div>
    </details>
  );
}
