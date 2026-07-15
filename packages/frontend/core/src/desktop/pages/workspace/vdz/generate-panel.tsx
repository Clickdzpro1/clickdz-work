import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useAiPulse } from '../../../../modules/vdz/use-ai-pulse';
import { useVdzCompose } from '../../../../modules/vdz/use-vdz-compose';
import { useVdzExport } from '../../../../modules/vdz/use-vdz-export';
import { AiPulseTicker } from './ai-pulse-ticker';
import * as styles from './generate-panel.css';

/**
 * Vdz Studio — AI Video Generator panel.
 *
 * Describe a video → the backend returns ONE self-contained HTML motion-graphics
 * composition (HeyGen HyperFrames conventions) → it plays LIVE in a sandboxed
 * iframe, scrubbed / played / paused over postMessage → refine conversationally.
 *
 * The generated document embeds a fixed runtime (authored server-side in
 * clickdz-vdz-video-prompt) that speaks this message contract:
 *   host → frame:  {type:'vdz-seek', t}, {type:'vdz-play'}, {type:'vdz-pause'},
 *                  {type:'vdz-duration?'}
 *   frame → host:  {type:'vdz-duration', seconds}
 * On load the frame announces its duration unprompted; we also ask explicitly
 * once it loads so the scrubber is populated even if we missed the first post.
 *
 * SELF-CONTAINED: this file imports only React, the compose hook, and its own
 * styles. It does NOT touch the vdz page's index.tsx / index.css.ts (owned by
 * parallel workers) — the integrator wires it in per WIRING-GENERATE.md.
 *
 * TWO GENERATION MODES (top-of-panel switch):
 *   · "In editor"   — the recommended path. The brief is handed to the host
 *     (onGenerateInEditor), which switches to the timeline editor and runs it
 *     through the AI dock's text-to-timeline pipeline, landing as an editable
 *     proposal. This panel does not render a preview in that mode.
 *   · "Motion HTML" — the original path: the backend returns ONE self-contained
 *     HTML motion-graphics composition that plays LIVE in the sandboxed iframe
 *     below and can be refined / exported to MP4.
 */

/** Format seconds as m:ss.d (one decimal) for the timecode readout. */
function fmt(t: number): string {
  if (!isFinite(t) || t < 0) t = 0;
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}

/** Which generation surface the panel is offering. */
type GenMode = 'editor' | 'html';

export interface VdzGeneratePanelProps {
  /**
   * Hand a brief to the timeline editor's AI pipeline ("In editor" mode). The
   * host switches to Edit and feeds this through the same send path the AI dock
   * uses, producing a pending, editable proposal. Optional: when absent, the
   * mode switch is hidden and the panel behaves as the pure "Motion HTML" tool.
   */
  onGenerateInEditor?: (prompt: string) => void;
}

export const VdzGeneratePanel = ({
  onGenerateInEditor,
}: VdzGeneratePanelProps = {}) => {
  const { busy, error, compose, refine, clearError } = useVdzCompose();
  // Reasoning animation: while the (slow) Motion-HTML compose/refine runs, a
  // FAST model streams request-tailored "thinking" lines into the ticker below
  // so the busy state feels alive instead of a bare spinner.
  const pulse = useAiPulse();
  // MP4 export (real render) — runs on the standalone cdz-render service via the
  // session-authed /api/v1/vdz/render proxy. Degrades gracefully when the render
  // service is not configured on this deployment.
  const {
    status: exportStatus,
    progress: exportProgress,
    error: exportError,
    fileUrl: exportFileUrl,
    unavailable: exportUnavailable,
    start: startExport,
    reset: resetExport,
  } = useVdzExport();

  const [prompt, setPrompt] = useState('');
  const [instruction, setInstruction] = useState('');
  // The current composition HTML (state, so the iframe re-mounts on change).
  const [html, setHtml] = useState<string | null>(null);

  // Generation surface. Default to the recommended "In editor" path when the
  // host wired the callback; otherwise the switch is hidden and we stay on the
  // standalone "Motion HTML" tool.
  const canGenerateInEditor = typeof onGenerateInEditor === 'function';
  const [genMode, setGenMode] = useState<GenMode>(
    canGenerateInEditor ? 'editor' : 'html'
  );

  // Playback state, driven by the postMessage handshake with the frame.
  const [duration, setDuration] = useState(0);
  const [current, setCurrent] = useState(0);
  const [playing, setPlaying] = useState(false);

  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  // requestAnimationFrame handle for advancing the scrubber during playback.
  const rafRef = useRef<number | null>(null);
  // wall-clock anchor: (performance.now ms at play start) minus (t at play start).
  const playAnchorRef = useRef<number>(0);
  // Set true when a freshly-loaded frame is waiting for its duration handshake so
  // we can auto-play it ONCE (so the user instantly sees motion instead of the
  // paused first frame). Consumed by the duration-watch effect below.
  const autoPlayPendingRef = useRef(false);

  /**
   * Post a message into the sandboxed frame.
   *
   * Target origin is '*' ON PURPOSE: the frame is loaded via `srcDoc` with a
   * `sandbox="allow-scripts"` attribute and NO `allow-same-origin`, so its
   * document runs in an opaque, unique origin ("null"). A concrete target
   * origin can never match "null", so a specific string would silently drop
   * every message. '*' is safe here because the payload is control-only
   * (seek/play/pause) and the frame can neither read our origin nor reach the
   * network. We still validate the SOURCE of inbound messages below.
   */
  const postToFrame = useCallback((message: unknown) => {
    iframeRef.current?.contentWindow?.postMessage(message, '*');
  }, []);

  const stopRaf = useCallback(() => {
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  }, []);

  // Advance the scrubber locally while the frame plays, so the UI stays in sync
  // without polling the frame. Stops (and rewinds transport) at the end.
  const tick = useCallback(() => {
    const now =
      typeof performance !== 'undefined' ? performance.now() : Date.now();
    const t = (now - playAnchorRef.current) / 1000;
    if (t >= duration) {
      setCurrent(duration);
      setPlaying(false);
      stopRaf();
      postToFrame({ type: 'vdz-pause' });
      return;
    }
    setCurrent(t);
    rafRef.current = requestAnimationFrame(tick);
  }, [duration, postToFrame, stopRaf]);

  const doPlay = useCallback(() => {
    if (!html || duration <= 0) return;
    // If we're at (or past) the end, restart from 0.
    const startAt = current >= duration ? 0 : current;
    const now =
      typeof performance !== 'undefined' ? performance.now() : Date.now();
    playAnchorRef.current = now - startAt * 1000;
    if (startAt !== current) {
      setCurrent(startAt);
      postToFrame({ type: 'vdz-seek', t: startAt });
    }
    setPlaying(true);
    postToFrame({ type: 'vdz-play' });
    stopRaf();
    rafRef.current = requestAnimationFrame(tick);
  }, [html, duration, current, postToFrame, stopRaf, tick]);

  const doPause = useCallback(() => {
    setPlaying(false);
    stopRaf();
    postToFrame({ type: 'vdz-pause' });
  }, [postToFrame, stopRaf]);

  const togglePlay = useCallback(() => {
    if (playing) doPause();
    else doPlay();
  }, [playing, doPause, doPlay]);

  const onScrub = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const t = Number(e.target.value);
      // Scrubbing always pauses playback and seeks the frame to t.
      setPlaying(false);
      stopRaf();
      setCurrent(t);
      postToFrame({ type: 'vdz-pause' });
      postToFrame({ type: 'vdz-seek', t });
    },
    [postToFrame, stopRaf]
  );

  // Listen for the frame's duration handshake. We accept a message only when it
  // originates from OUR iframe's contentWindow (the frame can't spoof source).
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const frameWin = iframeRef.current?.contentWindow;
      if (!frameWin || event.source !== frameWin) return;
      const data = event.data as { type?: unknown; seconds?: unknown } | null;
      if (!data || typeof data.type !== 'string') return;
      if (data.type === 'vdz-duration') {
        const secs = Number(data.seconds);
        if (isFinite(secs) && secs > 0) {
          setDuration(secs);
        }
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  // Clean up the RAF loop on unmount.
  useEffect(() => stopRaf, [stopRaf]);

  // When new HTML loads, reset transport; the frame re-mounts (keyed on html).
  // Also discard any prior export state — a stale MP4 must not attach to a fresh
  // composition (regenerate / refine both produce a new document).
  useEffect(() => {
    setDuration(0);
    setCurrent(0);
    setPlaying(false);
    // Disarm any auto-play left over from a prior frame; the new frame's onLoad
    // re-arms it. (The new iframe mounts keyed on html, so onLoad always fires.)
    autoPlayPendingRef.current = false;
    stopRaf();
    resetExport();
  }, [html, stopRaf, resetExport]);

  // Once the fresh frame has loaded, explicitly ask for its duration (belt-and-
  // braces alongside the unprompted announce, in case we mounted after it) and
  // pin it to its first frame while we wait. We ARM a one-shot auto-play here;
  // the duration-watch effect fires it the moment we know the length, so the
  // user sees motion immediately (the paused first frame — which a fade-in
  // composition renders near-black — is never what greets them).
  const onIframeLoad = useCallback(() => {
    autoPlayPendingRef.current = true;
    postToFrame({ type: 'vdz-duration?' });
    postToFrame({ type: 'vdz-pause' });
    postToFrame({ type: 'vdz-seek', t: 0 });
  }, [postToFrame]);

  // Auto-play a freshly-loaded composition once its duration is known. Runs only
  // when a load armed autoPlayPendingRef, so scrubbing/refine re-renders that
  // merely change `current`/`duration` don't hijack playback. doPlay reads
  // `current` via its own closure; we call it after clearing the flag so it
  // fires exactly once per load and the pause button is immediately usable.
  useEffect(() => {
    if (!autoPlayPendingRef.current || duration <= 0 || !html) return;
    autoPlayPendingRef.current = false;
    doPlay();
  }, [duration, html, doPlay]);

  const onGenerate = useCallback(async () => {
    const trimmed = prompt.trim();
    if (!trimmed || busy) return;
    // "In editor" mode delegates to the host (switch to Edit + run through the
    // AI dock pipeline). We don't clear the prompt so it's still there if the
    // user flips back to the HTML tool.
    if (genMode === 'editor' && onGenerateInEditor) {
      onGenerateInEditor(trimmed);
      return;
    }
    // Motion-HTML compose is the slow path — kick off the reasoning animation
    // tailored to this brief, and always stop it once the request settles.
    pulse.start(trimmed, 'video');
    try {
      const next = await compose(trimmed);
      setHtml(next);
    } catch {
      // error surfaced via hook state
    } finally {
      pulse.stop();
    }
  }, [prompt, busy, genMode, onGenerateInEditor, compose, pulse]);

  const onRefine = useCallback(async () => {
    const trimmed = instruction.trim();
    if (!trimmed || busy || !html) return;
    // Refine is also a slow model turn — animate a "reasoning" ticker for it.
    pulse.start(`Refine the video: ${trimmed}`, 'video');
    try {
      const next = await refine(html, trimmed);
      setHtml(next);
      setInstruction('');
    } catch {
      // error surfaced via hook state
    } finally {
      pulse.stop();
    }
  }, [instruction, busy, html, refine, pulse]);

  const onDownload = useCallback(() => {
    if (!html) return;
    const blob = new Blob([html], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'vdz-video.html';
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Release the object URL on the next tick so the download can start.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }, [html]);

  const onExport = useCallback(() => {
    if (!html) return;
    void startExport(html);
  }, [html, startExport]);

  const editorMode = genMode === 'editor' && canGenerateInEditor;
  // In editor mode the compose hook is idle (busy tracks HTML compose/refine),
  // so a submit is gated only on having text.
  const canGenerate =
    prompt.trim().length > 0 && (editorMode || !busy);
  const canRefine = instruction.trim().length > 0 && !busy && !!html;
  // The live preview + refine/export controls belong to the HTML tool only.
  const hasVideo = !editorMode && !!html;
  const exporting =
    exportStatus === 'starting' || exportStatus === 'rendering';
  const exportPct = Math.round(exportProgress * 100);

  const timecodeText = useMemo(
    () => `${fmt(current)} / ${fmt(duration)}`,
    [current, duration]
  );

  return (
    <div className={styles.root}>
      <div className={styles.header}>
        <h2 className={styles.title}>AI Video Generator</h2>
        <p className={styles.subtitle}>
          {editorMode
            ? 'Describe a video — land in the timeline editor with an editable AI proposal.'
            : 'Describe a video and watch it play — then refine it in words.'}
        </p>
      </div>

      {canGenerateInEditor ? (
        <div
          className={styles.modeSwitch}
          role="radiogroup"
          aria-label="Generation mode"
        >
          <button
            type="button"
            role="radio"
            aria-checked={genMode === 'editor'}
            className={styles.modeOption}
            data-active={genMode === 'editor'}
            onClick={() => setGenMode('editor')}
          >
            <span className={styles.modeOptionTitle}>In editor</span>
            <span className={styles.modeOptionHint}>
              Editable timeline — recommended
            </span>
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={genMode === 'html'}
            className={styles.modeOption}
            data-active={genMode === 'html'}
            onClick={() => setGenMode('html')}
          >
            <span className={styles.modeOptionTitle}>Motion HTML</span>
            <span className={styles.modeOptionHint}>
              Export-quality composition
            </span>
          </button>
        </div>
      ) : null}

      <div className={styles.promptRow}>
        <textarea
          className={styles.textarea}
          placeholder={
            editorMode
              ? 'e.g. Make a 20s product promo for a running shoe called AERO — title reveal, three specs, a closing logo.'
              : 'e.g. A 20-second dark, cinematic product teaser for a running shoe called AERO — bold type reveals, three key specs, a closing logo lockup.'
          }
          value={prompt}
          disabled={busy && !editorMode}
          onChange={e => {
            setPrompt(e.target.value);
            if (error) clearError();
          }}
        />
        <div className={styles.actionsRow}>
          <button
            className={styles.primaryButton}
            onClick={onGenerate}
            disabled={!canGenerate}
            type="button"
          >
            {busy && !hasVideo && !editorMode ? (
              <>
                <span className={styles.spinner} aria-hidden="true" />
                Generating…
              </>
            ) : editorMode ? (
              'Generate in editor'
            ) : hasVideo ? (
              'Regenerate'
            ) : (
              'Generate video'
            )}
          </button>
          {hasVideo ? (
            <button
              className={styles.ghostButton}
              onClick={onDownload}
              disabled={busy}
              type="button"
            >
              Download .html
            </button>
          ) : null}
          {hasVideo ? (
            <button
              className={styles.ghostButton}
              onClick={onExport}
              disabled={busy || exporting || exportUnavailable}
              type="button"
              title={
                exportUnavailable
                  ? 'Render service coming online soon'
                  : 'Render this composition to an MP4 video'
              }
            >
              {exporting ? (
                <>
                  <span className={styles.spinner} aria-hidden="true" />
                  Rendering…
                </>
              ) : (
                'Export MP4'
              )}
            </button>
          ) : null}
        </div>

        {/* Export progress / result — only while exporting or once resolved. */}
        {hasVideo &&
        (exporting ||
          exportStatus === 'done' ||
          exportStatus === 'error' ||
          exportUnavailable) ? (
          <div className={styles.exportRow}>
            {exporting ? (
              <>
                <div className={styles.progressTrack}>
                  <div
                    className={styles.progressFill}
                    style={{ width: `${Math.max(4, exportPct)}%` }}
                  />
                </div>
                <span className={styles.exportHint}>{exportPct}%</span>
              </>
            ) : exportStatus === 'done' && exportFileUrl ? (
              <a
                className={styles.downloadLink}
                href={exportFileUrl}
                download
              >
                ⬇ Download MP4
              </a>
            ) : exportUnavailable ? (
              <span className={styles.exportHint}>
                MP4 export is coming online soon.
              </span>
            ) : exportStatus === 'error' ? (
              <span className={styles.exportHint}>
                {exportError || 'Export failed. Please try again.'}
              </span>
            ) : null}
          </div>
        ) : null}
      </div>

      {error && !editorMode ? (
        <div className={styles.errorBanner} role="alert">
          {error}
        </div>
      ) : null}

      {editorMode ? (
        <div className={styles.result}>
          <div className={styles.stageWrap}>
            <div className={styles.empty}>
              <span>
                Your video is built as an editable timeline in the editor.
              </span>
              <span>
                Hit Generate and you’ll jump to Edit with an AI proposal to
                Accept or tweak.
              </span>
            </div>
          </div>
        </div>
      ) : (
      <div className={styles.result}>
        <div className={styles.stageWrap}>
          {hasVideo ? (
            <iframe
              // Re-mount the frame whenever the HTML changes so the runtime and
              // its animations boot fresh (no stale getAnimations state).
              key={html}
              ref={iframeRef}
              className={styles.iframe}
              title="Vdz video preview"
              // allow-scripts ONLY: the composition runs JS but has no network,
              // no forms, no same-origin — it can only talk to us via postMessage.
              sandbox="allow-scripts"
              srcDoc={html ?? ''}
              onLoad={onIframeLoad}
            />
          ) : busy ? (
            // Compose in flight, no preview yet → play the reasoning animation
            // in the empty stage instead of a static placeholder.
            <div className={styles.empty}>
              <AiPulseTicker
                line={pulse.currentLine}
                active={pulse.active}
                done={pulse.done}
              />
            </div>
          ) : (
            <div className={styles.empty}>
              <span>Your generated video will play here.</span>
              <span>Write a brief above and hit Generate.</span>
            </div>
          )}
        </div>

        {hasVideo ? (
          <>
            <div className={styles.controlBar}>
              <button
                className={styles.transportButton}
                onClick={togglePlay}
                disabled={duration <= 0}
                type="button"
                aria-label={playing ? 'Pause' : 'Play'}
              >
                {playing ? '❚❚' : '►'}
              </button>
              <input
                className={styles.scrubber}
                type="range"
                min={0}
                max={duration > 0 ? duration : 0}
                step={0.05}
                value={Math.min(current, duration)}
                disabled={duration <= 0}
                onChange={onScrub}
                aria-label="Scrub timeline"
              />
              <span className={styles.timecode}>{timecodeText}</span>
            </div>

            <div className={styles.refineRow}>
              <input
                className={styles.refineInput}
                placeholder="Refine: e.g. make the title bigger, slow the intro, use a teal accent"
                value={instruction}
                disabled={busy}
                onChange={e => {
                  setInstruction(e.target.value);
                  if (error) clearError();
                }}
                onKeyDown={e => {
                  if (e.key === 'Enter') onRefine();
                }}
              />
              <button
                className={styles.primaryButton}
                onClick={onRefine}
                disabled={!canRefine}
                type="button"
              >
                {busy && hasVideo ? (
                  <>
                    <span className={styles.spinner} aria-hidden="true" />
                    Refining…
                  </>
                ) : (
                  'Refine'
                )}
              </button>
            </div>

            {/* Reasoning animation while a refine turn is in flight. */}
            {busy ? (
              <AiPulseTicker
                line={pulse.currentLine}
                active={pulse.active}
                done={pulse.done}
              />
            ) : null}
          </>
        ) : null}
      </div>
      )}
    </div>
  );
};

export default VdzGeneratePanel;
