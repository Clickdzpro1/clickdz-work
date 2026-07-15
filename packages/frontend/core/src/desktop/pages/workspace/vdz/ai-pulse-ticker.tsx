import clsx from 'clsx';

import * as styles from './ai-pulse-ticker.css';

/**
 * ClickDz Pulse — reasoning-animation ticker.
 *
 * A slim animated status row for AI busy states: a soft pulsing dot plus a
 * single reasoning line that crossfades whenever `line` changes. Pair it with
 * the `useAiPulse()` hook (modules/vdz/use-ai-pulse), which supplies the line
 * stream and drives the reveal timer:
 *
 *   const pulse = useAiPulse();
 *   // on generate start:  pulse.start(promptSummary, 'video');
 *   // in the busy UI:     <AiPulseTicker line={pulse.currentLine} active={pulse.active} done={pulse.done} />
 *   // on response/unmount: pulse.stop();
 *
 * Purely presentational and self-contained (imports only clsx + its own styles).
 * The crossfade is driven by React re-keying the line element on its text, so
 * there's no imperative animation state to manage here.
 */

export interface AiPulseTickerProps {
  /** The reasoning line to show right now (from useAiPulse().currentLine). */
  line: string;
  /** Whether the animation is live. When false, the ticker renders nothing. */
  active?: boolean;
  /** True once the reveal has looped into its tail — dims the line slightly. */
  done?: boolean;
  /** Optional extra className on the root pill (layout tweaks by the host). */
  className?: string;
}

export const AiPulseTicker = ({
  line,
  active = true,
  done = false,
  className,
}: AiPulseTickerProps) => {
  // Nothing to show until the animation is live and has a first line.
  if (!active || !line) return null;

  return (
    <div
      className={clsx(styles.root, className)}
      role="status"
      aria-live="polite"
    >
      <span className={styles.dot} aria-hidden="true" />
      <span className={styles.lineWrap}>
        {/*
          Re-key on the line text so each new line remounts and replays the
          crossfade-in animation. The wrapper's fixed height keeps layout still.
        */}
        <span
          key={line}
          className={clsx(styles.line, done && styles.lineDone)}
        >
          {line}
        </span>
      </span>
    </div>
  );
};

export default AiPulseTicker;
