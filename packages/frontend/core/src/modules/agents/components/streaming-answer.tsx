// StreamingAnswer — the single source of truth for rendering a growing AI
// answer. THE fix for "streamed output has no animation": while a run is
// `live` it renders a time-based reveal of the raw text with a soft blinking
// cursor; once the run settles (`live` becomes false) it hands off to
// `MarkdownLite` so the final answer gets correct markdown formatting. This
// sequencing (animate-while-live, then markdown-once-settled) is what avoids
// the markdown-vs-animation tradeoff: `MarkdownLite` never has to parse a
// half-formed partial-markdown string, and the reveal engine never has to
// understand markdown.
//
// Replaces the two near-duplicate reveal components:
//   - clickdz/cdz-animations.tsx#CdzStreamingText (setInterval per chunk)
//   - modules/agents/components/streaming-text.tsx (no reveal — text appears
//     instantly, just a cursor)
// Both call sites that render a live final answer (Hermes dashboard's
// background-run overlay and RunTimeline) now go through this component, and
// message-bubble.tsx's live assistant bubble does too.
//
// Reveal engine, in plain terms:
//   - We keep how many characters are currently "revealed" as a plain number
//     in state (`revealedLen`), not the substring itself, and drive it purely
//     off elapsed wall-clock time via requestAnimationFrame. This means we
//     are NOT calling setState once per character (which would cause a
//     render storm on fast token bursts) — we call setState at most once per
//     animation frame (~60Hz ceiling), and only when the integer actually
//     changed.
//   - The reveal speed is time-based (chars/second), not tick-based, so it
//     reads at a constant pace regardless of how choppy/bursty the upstream
//     token stream is.
//   - Catch-up: if the source `text` races ahead of what's been revealed (a
//     big paste-like token burst arrives), the backlog
//     (text.length - revealedLen) grows. Rather than queuing that backlog and
//     playing it back later at the same fixed pace (which would fall further
//     and further behind forever), the per-frame budget scales up with the
//     backlog size, so the reveal always converges back to "caught up"
//     quickly instead of drifting into a multi-second lag. There's also a
//     hard cap: once the backlog exceeds a small multiple of one frame's
//     worth of catch-up budget, we simply snap to fully revealed. Net effect:
//     the visible text can never trail the real answer by more than a
//     fraction of a second, no matter how it arrives.
//   - If `text` is not a superset of what was already displayed (shrank, or
//     changed to something unrelated — e.g. a new run reused the same
//     component instance), we reset the reveal to the new text's length
//     immediately rather than trying to diff/animate a rewrite.
//
// Accessibility: prefers-reduced-motion skips the reveal engine entirely —
// the full text is shown immediately, with no per-frame animation and no
// blinking cursor, per the task's explicit requirement (not just the softer
// "steady cursor" treatment StreamingText used before).

import { memo, useEffect, useMemo, useRef, useState } from 'react';

import { MarkdownLite } from './markdown-lite';
import { AgentPalette as P, ensureAgentKeyframes } from './palette';

// Baseline reveal pace, in characters per second, once caught up. Tuned to
// read as a smooth "typing" cadence rather than a toy typewriter — fast
// enough that a normal sentence-sized token doesn't visibly lag behind its
// arrival, slow enough to still look like a reveal rather than a flash.
const BASE_CHARS_PER_SEC = 220;

// Once the gap between arrived text and revealed text exceeds this many
// characters, we stop trying to "catch up smoothly" and just snap forward.
// Keeps a long paste-like burst (e.g. a whole code block arriving in one
// token) from turning into a multi-second animation queue.
const SNAP_THRESHOLD_CHARS = 400;

// How strongly the per-frame reveal budget scales with the current backlog.
// At backlog 0 this contributes nothing; as backlog grows the extra budget
// grows with it, so the reveal accelerates smoothly toward "caught up"
// instead of trailing at a constant fixed rate forever.
const CATCH_UP_FACTOR = 2.2;

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

/**
 * Time-based reveal hook. Returns how much of `text` should currently be
 * shown. Consumers just slice `text.slice(0, revealedLen)` — kept as a
 * number (not a derived string) so this hook never allocates a new string
 * itself; the one unavoidable slice happens once in the render below.
 */
function useRevealedLength(text: string, live: boolean): number {
  const [revealedLen, setRevealedLen] = useState(() =>
    live && !prefersReducedMotion() ? 0 : text.length
  );
  const revealedLenRef = useRef(revealedLen);
  revealedLenRef.current = revealedLen;

  const prevTextRef = useRef(text);
  const rafRef = useRef<number | null>(null);
  const lastFrameTsRef = useRef<number | null>(null);
  const reducedMotionRef = useRef(prefersReducedMotion());

  // Text identity/superset handling: reset instantly on shrink or unrelated
  // change so we never try to animate a rewrite; on growth (the normal
  // streaming case) leave revealedLen where it is and let the rAF loop below
  // eat the new backlog at catch-up speed.
  useEffect(() => {
    const prev = prevTextRef.current;
    prevTextRef.current = text;
    if (text === prev) return;
    const isGrowth = text.startsWith(prev);
    if (!isGrowth) {
      // Shrank or changed to something unrelated (new answer reusing this
      // component instance, edited/regenerated text, etc). Don't animate a
      // diff — just resync immediately.
      setRevealedLen(live && !reducedMotionRef.current ? 0 : text.length);
    }
    // If it grew, do nothing here: revealedLen already points at a valid
    // prefix of the new (longer) text, and the rAF loop will advance it.
  }, [text, live]);

  // Once a run settles, reveal instantly — there is nothing left to "catch
  // up" to animate toward, and holding back already-arrived text after the
  // run is done would just look like a bug.
  useEffect(() => {
    if (!live) {
      setRevealedLen(text.length);
    }
  }, [live, text.length]);

  useEffect(() => {
    if (!live || reducedMotionRef.current) {
      return;
    }
    let cancelled = false;

    const tick = (ts: number) => {
      if (cancelled) return;
      const last = lastFrameTsRef.current;
      lastFrameTsRef.current = ts;
      const dt = last === null ? 0 : Math.max(0, ts - last) / 1000; // seconds

      const currentText = prevTextRef.current;
      const current = revealedLenRef.current;
      const backlog = currentText.length - current;

      if (backlog > 0 && dt > 0) {
        if (backlog > SNAP_THRESHOLD_CHARS) {
          // Way behind (huge burst) — snap fully caught up rather than
          // grinding through a long queued animation.
          revealedLenRef.current = currentText.length;
          setRevealedLen(currentText.length);
        } else {
          // Time-based budget, boosted by how far behind we are so the
          // reveal accelerates toward "caught up" instead of trailing at a
          // fixed pace forever.
          const budget =
            (BASE_CHARS_PER_SEC + backlog * CATCH_UP_FACTOR) * dt;
          const next = Math.min(
            currentText.length,
            current + Math.max(1, Math.ceil(budget))
          );
          if (next !== current) {
            revealedLenRef.current = next;
            setRevealedLen(next);
          }
        }
      }

      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => {
      cancelled = true;
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      lastFrameTsRef.current = null;
    };
    // Intentionally NOT depending on `text` — the loop reads the latest
    // value via prevTextRef every frame instead of restarting the rAF loop
    // (and its dt baseline) on every token.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live]);

  return Math.min(revealedLen, text.length);
}

const cursorStyle = {
  display: 'inline-block',
  width: '0.55em',
  height: '1.05em',
  marginLeft: 2,
  transform: 'translateY(0.18em)',
  background: P.color.accent,
  borderRadius: 1,
  animation: 'cdz-agent-blink 1s steps(1) infinite',
} as const;

// Size of the trailing slice that gets the cheap fade-in treatment. Small and
// fixed so the fade cost never scales with total answer length — only the
// most-recently-revealed tail is ever wrapped in its own span.
const FADE_TAIL_CHARS = 24;

function StreamingAnswerImpl({ text, live }: { text: string; live: boolean }) {
  ensureAgentKeyframes();
  const revealedLen = useRevealedLength(text, live);
  const reducedMotion = useMemo(() => prefersReducedMotion(), []);

  if (!live) {
    return <MarkdownLite text={text} />;
  }

  const shown = text.slice(0, revealedLen);

  // Split into a stable head + a small animated tail so the fade-in only
  // ever touches a bounded slice of text, not the whole growing answer.
  const splitAt = Math.max(0, shown.length - FADE_TAIL_CHARS);
  const head = shown.slice(0, splitAt);
  const tail = shown.slice(splitAt);

  return (
    <span
      style={{
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        color: P.color.text,
        fontSize: P.font.size.lg,
        lineHeight: 1.6,
      }}
    >
      {head}
      {tail ? (
        reducedMotion ? (
          tail
        ) : (
          // Re-keyed on length so each newly-grown tail replays a fresh,
          // short fade rather than animating character-by-character.
          <span
            key={shown.length}
            className="cdz-agent-motion"
            style={{ animation: 'cdz-agent-fade-in 220ms ease both' }}
          >
            {tail}
          </span>
        )
      ) : null}
      {!reducedMotion ? (
        <span
          className="cdz-agent-cursor cdz-agent-motion"
          aria-hidden="true"
          style={cursorStyle}
        />
      ) : null}
      {/* Reduced-motion still needs *a* cursor so the live state doesn't read
          as frozen/broken, but with the blink neutralised by the shared
          .cdz-agent-cursor reduced-motion rule (steady, not flashing). */}
      {reducedMotion ? (
        <span
          className="cdz-agent-cursor"
          aria-hidden="true"
          style={cursorStyle}
        />
      ) : null}
    </span>
  );
}

export const StreamingAnswer = memo(StreamingAnswerImpl);
