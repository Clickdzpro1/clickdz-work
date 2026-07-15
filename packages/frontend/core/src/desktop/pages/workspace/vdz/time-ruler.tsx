import { useMemo } from 'react';

import { formatTimecode } from './constants';
import * as styles from './index.css';

interface TimeRulerProps {
  /** Total ruler span in seconds (>= timeline duration, padded a little). */
  spanSeconds: number;
  pxPerSec: number;
}

/**
 * A slim ruler with one tick per second. Labels are thinned out automatically
 * when zoomed out so they never overlap. Rendered inside the shared scroll
 * container so it tracks the lanes 1:1 horizontally.
 */
export function TimeRuler({ spanSeconds, pxPerSec }: TimeRulerProps) {
  const ticks = useMemo(() => {
    const total = Math.ceil(spanSeconds);
    // Show a label roughly every ~56px so they don't collide when zoomed out.
    const labelEvery = Math.max(1, Math.ceil(56 / pxPerSec));
    const out: { second: number; labelled: boolean }[] = [];
    for (let s = 0; s <= total; s++) {
      out.push({ second: s, labelled: s % labelEvery === 0 });
    }
    return out;
  }, [spanSeconds, pxPerSec]);

  return (
    <div
      className={styles.ruler}
      style={{ width: spanSeconds * pxPerSec }}
      aria-hidden="true"
    >
      {ticks.map(tick => (
        <div
          key={tick.second}
          className={tick.labelled ? styles.rulerTickMajor : styles.rulerTick}
          style={{ left: tick.second * pxPerSec }}
        >
          {tick.labelled ? (
            <span className={styles.rulerLabel}>
              {formatTimecode(tick.second)}
            </span>
          ) : null}
        </div>
      ))}
    </div>
  );
}
