import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useVdzCompose } from '../../../../modules/vdz/use-vdz-compose';
import { useVdzExport } from '../../../../modules/vdz/use-vdz-export';
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
 */

/** Format seconds as m:ss.d (one decimal) for the timecode readout. */
function fmt(t: number): string {
  if (!isFinite(t) || t < 0) t = 0;
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}

export const VdzGeneratePanel = () => {
  const { busy, error, compose, refine, clearError } = useVdzCompose();
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

  // Playback state, driven by the postMessage handshake with the frame.
  const [duration, setDuration] = useState(0);
  const [current, setCurrent] = useState(0);
  const [playing, setPlaying] = useState(false);

  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  // requestAnimationFrame handle for advancing the scrubber during playback.
  const rafRef = useRef<number | null>(null);
  // wall-clock anchor: (performance.now ms at play start) minus (t at play start).
  const playAnchorRef = useRef<number>(0);

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
    stopRaf();
    resetExport();
  }, [html, stopRaf, resetExport]);

  // Once the fresh frame has loaded, explicitly ask for its duration (belt-and-
  // braces alongside the unprompted announce, in case we mounted after it).
  const onIframeLoad = useCallback(() => {
    postToFrame({ type: 'vdz-duration?' });
    // Ensure the frame shows its first frame, paused.
    postToFrame({ type: 'vdz-pause' });
    postToFrame({ type: 'vdz-seek', t: 0 });
  }, [postToFrame]);

  const onGenerate = useCallback(async () => {
    const trimmed = prompt.trim();
    if (!trimmed || busy) return;
    try {
      const next = await compose(trimmed);
      setHtml(next);
    } catch {
      // error surfaced via hook state
    }
  }, [prompt, busy, compose]);

  const onRefine = useCallback(async () => {
    const trimmed = instruction.trim();
    if (!trimmed || busy || !html) return;
    try {
      const next = await refine(html, trimmed);
      setHtml(next);
      setInstruction('');
    } catch {
      // error surfaced via hook state
    }
  }, [instruction, busy, html, refine]);

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

  const canGenerate = prompt.trim().length > 0 && !busy;
  const canRefine = instruction.trim().length > 0 && !busy && !!html;
  const hasVideo = !!html;
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
          Describe a video and watch it play — then refine it in words.
        </p>
      </div>

      <div className={styles.promptRow}>
        <textarea
          className={styles.textarea}
          placeholder="e.g. A 20-second dark, cinematic product teaser for a running shoe called AERO — bold type reveals, three key specs, a closing logo lockup."
          value={prompt}
          disabled={busy}
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
            {busy && !hasVideo ? (
              <>
                <span className={styles.spinner} aria-hidden="true" />
                Generating…
              </>
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

      {error ? (
        <div className={styles.errorBanner} role="alert">
          {error}
        </div>
      ) : null}

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
          </>
        ) : null}
      </div>
    </div>
  );
};

export default VdzGeneratePanel;
