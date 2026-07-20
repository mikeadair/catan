// Compact dice-roll distribution: one bar per sum (2–12) with a tick at the statistically
// expected count, derived purely from room.log's diceRoll metas — no engine or server
// involvement. Lives in the sidebar's top icon row as a small trigger (native <details>, so
// still zero JS state) rather than its own always-present panel — the bars themselves float
// as a popover (position: absolute, see RollStats.css) so opening/closing them never resizes
// the sidebar the way an inline panel did.
import type { JSX } from 'react';
import type { RoomState } from '@catan/engine';
import { BarChartIcon } from './gameIcons';
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
      <summary
        className="game__sidebar-side-toggle roll-stats__summary"
        title={`Roll stats (${total} roll${total === 1 ? '' : 's'})`}
        aria-label={`Roll stats (${total} roll${total === 1 ? '' : 's'})`}
      >
        <BarChartIcon className="game__sidebar-side-toggle-icon" />
      </summary>
      <div className="roll-stats__bars">
        <div className="roll-stats__title">
          {total} roll{total === 1 ? '' : 's'}
        </div>
        <div className="roll-stats__grid">
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
      </div>
    </details>
  );
}
