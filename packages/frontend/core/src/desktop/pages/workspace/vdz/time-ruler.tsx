import { memo, useMemo } from 'react';

import * as ex from './timeline-extras.css';

interface TimeRulerProps {
  /** Total ruler span in seconds (>= timeline duration, padded a little). */
  spanSeconds: number;
  pxPerSec: number;
  /** Frames-per-second (from the timeline doc) — drives sub-second labels. */
  fps: number;
}

/**
 * A ladder of candidate MAJOR-tick intervals, in seconds, ascending. The ruler
 * picks the smallest interval whose on-screen spacing clears the target below,
 * so major ticks stay ~60–110px apart at any zoom (professional-editor feel,
 * à la CapCut / Premiere). Sub-second rungs enable frame-scale labels when
 * zoomed all the way in; the minute+ rungs keep long timelines legible.
 */
const MAJOR_LADDER = [
  0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600,
] as const;

/** Aim to keep major ticks at least this many px apart (upper bound ~2x). */
const TARGET_MAJOR_PX = 72;

/**
 * How many equal minor subdivisions sit between two majors for a given major
 * interval. Chosen so minors land on "nice" values (halves / quarters / fifths)
 * and never crowd (the component still drops minors if they'd be < ~7px apart).
 */
function minorDivisions(major: number): number {
  // Sub-second rungs subdivide by their natural factor.
  if (major === 0.1) return 2; // 0.05
  if (major === 0.25) return 5; // 0.05
  if (major === 0.5) return 5; // 0.1
  if (major === 1) return 4; // 0.25
  if (major === 2) return 4; // 0.5
  if (major === 5) return 5; // 1
  if (major === 10) return 5; // 2
  if (major === 15) return 3; // 5
  if (major === 30) return 6; // 5
  if (major === 60) return 4; // 15
  if (major === 120) return 4; // 30
  if (major === 300) return 5; // 60
  if (major === 600) return 5; // 120
  if (major === 1800) return 6; // 300
  return 6; // 3600 → 600
}

/** `mm:ss` for a whole-ish second value (used for >= 1s major intervals). */
function fmtMinSec(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const mins = Math.floor(s / 60);
  const secs = s % 60;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

/**
 * `s.ff` sub-second label (used when the major interval is < 1s): whole seconds
 * with a two-digit FRAME remainder derived from fps, e.g. `2.15` = 2s + 15
 * frames. Snaps to the nearest frame so labels sit exactly on frame boundaries.
 */
function fmtSecFrames(seconds: number, fps: number): string {
  const safeFps = fps > 0 ? fps : 30;
  const totalFrames = Math.round(seconds * safeFps);
  const whole = Math.floor(totalFrames / safeFps);
  const frame = totalFrames - whole * safeFps;
  return `${whole}.${String(frame).padStart(2, '0')}`;
}

/**
 * Adaptive timeline ruler. Tick density is derived purely from the zoom value
 * (`pxPerSec`) and the span, so majors stay comfortably spaced and labelled at
 * every zoom while minors fill in between. Tick geometry is memoized on
 * `pxPerSec` + `spanSeconds` + `fps` so it is NOT recomputed on a playhead tick
 * (the moving playhead/hover chrome live in the parent lanes component). All
 * positions are integer-rounded for crisp 1px hairlines (no blurry half-pixels).
 *
 * Wrapped in `memo` (props are primitives) so it skips re-rendering entirely on
 * a playhead tick — during playback only the parent's playhead/readout update.
 */
function TimeRulerImpl({ spanSeconds, pxPerSec, fps }: TimeRulerProps) {
  const ticks = useMemo(() => {
    // Pick the smallest ladder interval that keeps majors >= the target apart.
    let major = MAJOR_LADDER[MAJOR_LADDER.length - 1];
    for (const step of MAJOR_LADDER) {
      if (step * pxPerSec >= TARGET_MAJOR_PX) {
        major = step;
        break;
      }
    }
    const isSubSecond = major < 1;

    const divisions = minorDivisions(major);
    const minorStep = major / divisions;
    const total = Math.max(0, spanSeconds);
    // Only draw minors if they won't crowd into an unreadable smear AND the
    // resulting node count stays bounded — a very long span at high zoom could
    // otherwise emit tens of thousands of tick divs (this ruler is not
    // virtualized). Past the budget we keep majors/mids only (always few), so
    // the ruler stays crisp and cheap at any span/zoom combination.
    const MINOR_TICK_BUDGET = 4000;
    const projectedMinors = total / minorStep;
    const drawMinors =
      minorStep * pxPerSec >= 7 && projectedMinors <= MINOR_TICK_BUDGET;
    // A mid-level tick sits on the halfway subdivision when there are enough
    // minors to warrant a visual hierarchy (even split into >= 4 divisions).
    const midEvery = divisions >= 4 && divisions % 2 === 0 ? divisions / 2 : -1;

    const out: {
      key: number;
      left: number;
      kind: 'major' | 'mid' | 'minor';
      label: string | null;
    }[] = [];

    // Iterate in minor-steps; classify each tick by its index within a major.
    // Using an index counter (not repeated float mult) keeps the tick times
    // exact enough for stable rounding across the whole span.
    const stepCount = Math.floor(total / minorStep + 1e-6);
    for (let i = 0; i <= stepCount; i++) {
      const t = i * minorStep;
      const withinMajor = i % divisions;
      const isMajor = withinMajor === 0;
      const isMid = !isMajor && withinMajor === midEvery;
      if (!isMajor && !isMid && !drawMinors) continue;

      const kind: 'major' | 'mid' | 'minor' = isMajor
        ? 'major'
        : isMid
          ? 'mid'
          : 'minor';
      out.push({
        key: i,
        left: Math.round(t * pxPerSec),
        kind,
        label: isMajor
          ? isSubSecond
            ? fmtSecFrames(t, fps)
            : fmtMinSec(t)
          : null,
      });
    }
    return out;
  }, [spanSeconds, pxPerSec, fps]);

  const width = Math.round(spanSeconds * pxPerSec);

  return (
    <div className={ex.ruler} style={{ width }} aria-hidden="true">
      {ticks.map(tick => {
        const cls =
          tick.kind === 'major'
            ? `${ex.tick} ${ex.tickMajor}`
            : tick.kind === 'mid'
              ? `${ex.tick} ${ex.tickMid}`
              : `${ex.tick} ${ex.tickMinor}`;
        return (
          <div key={tick.key} className={cls} style={{ left: tick.left }}>
            {tick.label !== null ? (
              <span className={ex.label}>{tick.label}</span>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

/**
 * Public ruler component. `memo` keeps it inert during playback (its props —
 * span, zoom, fps — don't change frame-to-frame), so the tick DOM is not
 * reconciled every rAF.
 */
export const TimeRuler = memo(TimeRulerImpl);
