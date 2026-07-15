import {
  clipVisualStateAt,
  computePreviewFrame,
  effectsFilterCss,
  resolveItemRender,
  type VdzPreviewItem,
  visualTransformCss,
} from '../../desktop/pages/workspace/vdz/anim';
import type { VdzClip, VdzTimeline, VdzTrack } from './schema';
import { computeTimelineDuration } from './schema';

/**
 * Vdz Studio — timeline → HyperFrames HTML compiler (Cluster 2, Option B).
 *
 * A PURE function `compileTimelineToHtml(timeline)` that emits ONE self-contained
 * HTML document in exactly the shape the cdz-render service already renders and
 * the VDZ_RUNTIME already drives (see clickdz-vdz-video-prompt.ts + server.mjs):
 *   · a `#stage` root carrying `data-composition-id` at `width×height`, scaled to
 *     the viewport (the same seek-safe sizing script the AI compositions use);
 *   · one `class="clip"` element per visible clip, carrying `data-start` /
 *     `data-duration` / `data-track-index` on its OPENING tag (so the service's
 *     text-scan duration probe and the runtime's visibility toggle both see it);
 *   · motion expressed as CSS `@keyframes` bound with `animation-play-state:
 *     paused` — SEEKABLE via `document.getAnimations()`, which is the ONLY thing
 *     the host/service scrub through;
 *   · the VDZ_RUNTIME embedded VERBATIM near the end of <body>.
 *
 * PREVIEW PARITY — the load-bearing guarantee.
 * We do NOT re-derive any easing/animation/transition math here. For every clip
 * we SAMPLE the preview's OWN pure functions (`computePreviewFrame` →
 * `resolveItemRender` / `visualTransformCss` / `clipVisualStateAt`, plus
 * `effectsFilterCss`) at N points across the clip's on-screen window and emit
 * those exact opacity / transform / clip-path values as keyframe stops. So the
 * exported frames are byte-identical to what `preview-canvas.tsx` paints at the
 * same playhead — animation curves, effect filters and boundary transitions all
 * come from `anim.ts`, never a fork.
 *
 * VIDEO-CLIP LIMITATION (stated honestly).
 * The host seeks the DOM by driving `document.getAnimations()`; a real <video>
 * element does NOT frame-step in lock-step with that (its `currentTime` is not a
 * WAAPI animation the scrubber owns), so this HTML tier CANNOT composite true
 * uploaded-video frames. We therefore render a video clip's POSTER / first frame
 * (as a still, animated + filtered exactly like an image) and surface a note.
 * Real per-frame video compositing needs the Remotion tier (plan Cluster 7 /
 * P2b: server-side `<OffthreadVideo>` fetch), which is intentionally out of scope
 * for this cluster.
 *
 * AUDIO. Audio tracks contribute nothing visible (identical to
 * `computePreviewFrame`, which skips them). MP4 audio mixing is a Remotion-tier
 * capability; the HTML render is silent. Noted in the compiled document.
 *
 * MEDIA INLINING. cdz-render runs offline headless Chrome with NO network, and
 * clip srcs are workspace-local `vdz-blob:<id>` handles or remote https. The
 * document therefore cannot fetch them at render time — the caller must pre-
 * resolve media to `data:` URIs and pass them via `options.resolveSrc` (a map of
 * clip.src → data URL). Any src absent from the map is emitted verbatim (a remote
 * URL simply won't load offline; a `vdz-blob:` handle is dead off-workspace) and
 * reported in the returned `unresolved` list so the UI can warn.
 */

/** Options for {@link compileTimelineToHtml}. */
export interface CompileTimelineOptions {
  /**
   * Map of a clip `src` (e.g. `vdz-blob:<id>` or a remote https URL) to a
   * directly-embeddable value — a `data:` URI for offline rendering. Srcs not
   * present here are emitted unchanged (and reported as unresolved).
   */
  resolveSrc?: Record<string, string>;
  /**
   * Keyframe sample density per clip window. More samples = smoother motion at
   * the cost of document size. Clamped to [2, 240]. Default 24.
   */
  samplesPerClip?: number;
}

/** The result of a compile: the HTML plus diagnostics for the UI. */
export interface CompileTimelineResult {
  /** The complete, self-contained HTML document (starts with `<!doctype html>`). */
  html: string;
  /** Number of `.clip` elements emitted (visible clips only). */
  clipCount: number;
  /** Composition length in seconds (max clip end, mirrors the runtime). */
  durationSeconds: number;
  /** Distinct srcs that could NOT be resolved to an embeddable value. */
  unresolved: string[];
  /**
   * Names of video clips rendered as a still poster (the video-frame limit). The
   * UI surfaces this so the user knows uploaded video is not truly composited.
   */
  posterOnlyVideoClips: string[];
}

// ---------------------------------------------------------------------------
// VDZ_RUNTIME — copied VERBATIM from the backend clickdz-vdz-video-prompt.ts.
//
// The frontend cannot import from the backend package, so the runtime text is
// duplicated here as a template-free (single-quote + concatenation) string,
// byte-identical to VDZ_RUNTIME on the server. It MUST stay in sync: it is the
// postMessage seek/play/pause contract cdz-render + the host player speak, and
// it is the thing that toggles each `.clip`'s visibility by data-start /
// data-duration. NO backticks appear inside this string (house rule) so it
// composes cleanly wherever it is embedded.
// ---------------------------------------------------------------------------
const VDZ_RUNTIME: string = [
  '<script>',
  '(function () {',
  '  var doc = document;',
  "  function clips() { return Array.prototype.slice.call(doc.querySelectorAll('.clip')); }",
  '  function n(el, a) { var v = parseFloat(el.getAttribute(a)); return isFinite(v) ? v : 0; }',
  '  function anims() { try { return doc.getAnimations ? doc.getAnimations() : []; } catch (e) { return []; } }',
  '  function duration() {',
  '    var end = 0;',
  "    clips().forEach(function (el) { var e = n(el, 'data-start') + n(el, 'data-duration'); if (e > end) end = e; });",
  '    return Math.round(end * 1000) / 1000;',
  '  }',
  '  function visAt(t) {',
  '    clips().forEach(function (el) {',
  "      var s = n(el, 'data-start'), d = n(el, 'data-duration');",
  "      el.style.visibility = (t >= s && t < s + d) ? 'visible' : 'hidden';",
  '    });',
  '  }',
  '  function seek(t) {',
  '    t = Math.max(0, Number(t) || 0);',
  '    anims().forEach(function (a) { try { a.currentTime = t * 1000; } catch (e) {} try { a.pause(); } catch (e) {} });',
  '    visAt(t);',
  '  }',
  '  function setPlay(go) {',
  '    anims().forEach(function (a) { try { go ? a.play() : a.pause(); } catch (e) {} });',
  '  }',
  "  function send(m) { try { (window.parent || window).postMessage(m, '*'); } catch (e) {} }",
  "  window.addEventListener('message', function (ev) {",
  "    var d = ev && ev.data; if (!d || typeof d.type !== 'string') return;",
  "    if (d.type === 'vdz-seek') seek(d.t);",
  "    else if (d.type === 'vdz-play') setPlay(true);",
  "    else if (d.type === 'vdz-pause') setPlay(false);",
  "    else if (d.type === 'vdz-duration?') send({ type: 'vdz-duration', seconds: duration() });",
  '  });',
  '  seek(0);',
  "  send({ type: 'vdz-duration', seconds: duration() });",
  '})();',
  '</script>',
].join('\n');

/**
 * The seek-safe stage-sizing script, copied verbatim from the AI-composition
 * prompt (STAGE SIZING). It only touches layout (a transform: scale on #stage),
 * never animation, so it never appears in `document.getAnimations()` and cannot
 * interfere with the scrubber. Authored template-free (no backticks) so it
 * embeds cleanly. Uses the timeline's own width/height, injected as literals.
 */
function stageSizingScript(width: number, height: number): string {
  return [
    '<script>',
    '(function () {',
    "  var stage = document.getElementById('stage');",
    '  function fit() {',
    '    if (!stage) return;',
    '    var s = Math.min(innerWidth / ' + width + ', innerHeight / ' + height + ');',
    "    stage.style.transform = 'scale(' + s + ')';",
    '  }',
    "  addEventListener('resize', fit); fit();",
    '})();',
    '</script>',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Small, dependency-free HTML/CSS escaping helpers. These never see untrusted
// remote content beyond what the user themselves authored in the timeline, but
// we still escape defensively so text/colors can't break out of the document.
// ---------------------------------------------------------------------------

/** Escape text destined for an HTML text node. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Escape a value destined for a double-quoted HTML attribute. */
function escapeAttr(value: string): string {
  return escapeHtml(value).replace(/"/g, '&quot;');
}

/**
 * Sanitize a value used inside a CSS declaration (a color, a filter). We only
 * allow a conservative character set and strip anything that could terminate the
 * declaration/rule or inject a new one. Falls back to `fallback` when the input
 * is empty or contains a disallowed character.
 */
function safeCssValue(value: string | undefined, fallback: string): string {
  if (!value) return fallback;
  // Allow letters, digits, whitespace and the punctuation legitimate CSS color/
  // filter values use: # % ( ) , . - + / and spaces. Reject ; { } " ' < > \ etc.
  if (/[;{}"'<>\\@]/.test(value)) return fallback;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

/** Round to 3 decimals and drop a trailing `.000` for compact, stable output. */
function num(value: number): string {
  const r = Math.round(value * 1000) / 1000;
  return Number.isFinite(r) ? String(r) : '0';
}

// ---------------------------------------------------------------------------
// Clip window — mirrors anim.ts::clipWindow so a clip is on screen for exactly
// the same span the preview shows it (including the half-windows of an abutting
// transition on either boundary). This is the [data-start, data-duration) we
// emit, so the runtime's visibility toggle and the preview agree frame-for-frame.
// ---------------------------------------------------------------------------
function clipRenderWindow(
  track: VdzTrack,
  clip: VdzClip,
  index: number
): { start: number; end: number } {
  let start = clip.start;
  let end = clip.start + clip.duration;
  const transitions = track.transitions ?? [];

  const next = track.clips[index + 1];
  if (next && Math.abs(end - next.start) < 1e-6) {
    for (const tr of transitions) {
      if (tr.afterClipId === clip.id) end += tr.duration / 2;
    }
  }
  if (index > 0) {
    const prev = track.clips[index - 1];
    if (Math.abs(prev.start + prev.duration - clip.start) < 1e-6) {
      for (const tr of transitions) {
        if (tr.afterClipId === prev.id) start -= tr.duration / 2;
      }
    }
  }
  return { start: Math.max(0, start), end };
}

/** One fully-resolved keyframe stop for a clip's animation timeline. */
interface KeyframeStop {
  /** 0..1 position within the clip's animation (window-relative). */
  offset: number;
  opacity: number;
  transform: string;
  clipPath: string | undefined;
}

/**
 * Sample the PREVIEW's own render for a single clip across its on-screen window,
 * producing keyframe stops. At each sample time we recompute the whole frame
 * with `computePreviewFrame` (so any active transition is folded in exactly as
 * the preview folds it), find THIS clip's item, and read the final opacity /
 * transform / clip-path via `resolveItemRender` + `visualTransformCss` — the
 * identical pipeline `PreviewItem` uses. When the clip is not present at a
 * sample (only possible right at the window edge), we hold opacity 0 so the
 * fill-both animation lands cleanly.
 */
function sampleClipKeyframes(
  timeline: VdzTimeline,
  track: VdzTrack,
  clip: VdzClip,
  win: { start: number; end: number },
  samples: number
): KeyframeStop[] {
  const key = `${track.id}:${clip.id}`;
  const isText = clip.type === 'text';
  const span = win.end - win.start;
  const stops: KeyframeStop[] = [];
  // A tiny epsilon keeps the last sample strictly inside the window so
  // computePreviewFrame (which excludes nowSeconds === end) still returns the
  // clip; the runtime hides the element past the window regardless.
  const eps = Math.min(1e-3, span > 0 ? span / (samples * 4) : 0);

  for (let i = 0; i < samples; i++) {
    const frac = samples > 1 ? i / (samples - 1) : 0;
    let t = win.start + frac * span;
    if (i === samples - 1) t = Math.max(win.start, win.end - eps);

    const frame = computePreviewFrame(timeline, t);
    const item = frame.find(it => it.key === key);

    let opacity: number;
    let transform: string;
    let clipPath: string | undefined;
    if (item) {
      const r = resolveItemRender(item);
      opacity = r.opacity;
      clipPath = r.clipPath;
      const composed = {
        ...item.visual,
        translateX: item.visual.translateX + r.extraTranslateX,
      };
      transform = visualTransformCss(composed, isText ? 'text' : 'clip');
    } else {
      // Edge miss: reproduce the neutral-but-hidden state. Text keeps its
      // centering transform so it doesn't jump if the browser interpolates.
      opacity = 0;
      transform = isText ? 'translate(-50%, -50%)' : 'none';
      clipPath = undefined;
    }
    stops.push({ offset: frac, opacity, transform, clipPath });
  }
  return stops;
}

/**
 * Serialize keyframe stops to a CSS `@keyframes` rule body. Collapses runs of
 * identical stops (so a clip with no motion emits a compact 0%/100% rule).
 */
function keyframesRule(name: string, stops: KeyframeStop[]): string {
  const lines: string[] = [];
  let prev: string | null = null;
  stops.forEach((s, i) => {
    const pct = `${num(s.offset * 100)}%`;
    const decls: string[] = [`opacity:${num(s.opacity)}`];
    // `transform:none` is the browser default; only emit a real transform.
    if (s.transform && s.transform !== 'none') {
      decls.push(`transform:${s.transform}`);
    } else {
      decls.push('transform:none');
    }
    decls.push(`clip-path:${s.clipPath ?? 'none'}`);
    const body = decls.join(';');
    // De-dupe: skip an interior stop identical to the previous one (keep the
    // first and last no matter what so the rule always has both endpoints).
    if (body === prev && i !== 0 && i !== stops.length - 1) return;
    lines.push(`  ${pct} { ${body}; }`);
    prev = body;
  });
  return `@keyframes ${name} {\n${lines.join('\n')}\n}`;
}

/**
 * Resolve a clip `src` to an embeddable value. Returns the resolved string and
 * whether it came from the map. When unresolved, the raw src is returned (a
 * remote URL that will fail offline; a dead `vdz-blob:` handle) so the compiler
 * still produces a valid document and the caller can warn.
 */
function resolveSrc(
  src: string,
  map: Record<string, string> | undefined
): { value: string; resolved: boolean } {
  if (!src) return { value: '', resolved: true };
  const mapped = map?.[src];
  if (typeof mapped === 'string' && mapped) return { value: mapped, resolved: true };
  return { value: src, resolved: false };
}

/** Build the inner HTML for a clip element, mirroring preview-canvas.tsx. */
function clipInnerHtml(
  clip: VdzClip,
  timeline: VdzTimeline,
  map: Record<string, string> | undefined,
  diag: { unresolved: Set<string>; posterVideos: string[] }
): string {
  switch (clip.type) {
    case 'text': {
      // fontSize is a fraction of canvas HEIGHT; on the fixed-px stage that is
      // `fraction * height` px (the preview uses cqh against a fluid box — the
      // same physical size on our 1:1 stage).
      const px = num((clip.fontSize ?? 0.08) * timeline.height);
      const color = safeCssValue(clip.color, '#ffffff');
      const align = clip.align ?? 'center';
      const style =
        `font-size:${px}px;color:${color};text-align:${align};` +
        'font-weight:700;line-height:1.1;';
      return `<div style="${style}">${escapeHtml(clip.text)}</div>`;
    }
    case 'shape': {
      const color = safeCssValue(clip.color, '#5b8cff');
      const radius = clip.shape === 'circle' ? '50%' : '4px';
      return (
        `<div style="width:100%;height:100%;background:${color};` +
        `border-radius:${radius};"></div>`
      );
    }
    case 'image': {
      if (!clip.src) {
        return '<div style="position:absolute;inset:10%;display:flex;align-items:center;justify-content:center;border:2px dashed rgba(255,255,255,0.2);border-radius:8px;color:rgba(255,255,255,0.5);font-size:12px;">image · empty src</div>';
      }
      const { value, resolved } = resolveSrc(clip.src, map);
      if (!resolved) diag.unresolved.add(clip.src);
      const fit = clip.fit ?? 'cover';
      return `<img style="position:absolute;inset:0;width:100%;height:100%;object-fit:${fit};" src="${escapeAttr(value)}" alt="${escapeAttr(clip.name ?? 'image')}" />`;
    }
    case 'video': {
      // VIDEO-CLIP LIMITATION: render the poster/first frame as a still. True
      // per-frame video compositing needs the Remotion tier (see file header).
      diag.posterVideos.push(clip.name ?? 'video');
      if (!clip.src) {
        return '<div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#fff;font-size:13px;font-weight:600;background:repeating-linear-gradient(45deg,rgba(255,255,255,0.04) 0 12px,rgba(255,255,255,0) 12px 24px);">video · ' + escapeHtml(clip.name ?? 'video') + '</div>';
      }
      const { value, resolved } = resolveSrc(clip.src, map);
      if (!resolved) diag.unresolved.add(clip.src);
      // A muted, preload=metadata <video> shows its poster frame as a still.
      // The runtime does not (and cannot) drive its currentTime as an animation.
      return `<video style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;" src="${escapeAttr(value)}" muted preload="metadata" playsinline></video>`;
    }
    default:
      return '';
  }
}

/**
 * The absolute box CSS for a clip, mirroring preview-canvas.tsx positioning:
 *   · text  → a point at (x,y) with the animation transform centering it;
 *   · shape → an (x,y,w,h) fraction box;
 *   · image/video → inset:0 (fills the stage).
 * Returned as a set of CSS declarations (no transform — that is animated).
 */
function clipBoxCss(clip: VdzClip): string {
  if (clip.type === 'text') {
    const left = num((clip.x ?? 0.5) * 100);
    const top = num((clip.y ?? 0.5) * 100);
    // whiteSpace + textShadow mirror styles.previewText.
    return (
      `position:absolute;left:${left}%;top:${top}%;` +
      'white-space:pre-wrap;text-shadow:0 2px 12px rgba(0,0,0,0.6);'
    );
  }
  if (clip.type === 'shape') {
    const left = num((clip.x ?? 0) * 100);
    const top = num((clip.y ?? 0) * 100);
    const w = num((clip.w ?? 1) * 100);
    const h = num((clip.h ?? 1) * 100);
    return `position:absolute;left:${left}%;top:${top}%;width:${w}%;height:${h}%;`;
  }
  // image / video fill the stage.
  return 'position:absolute;inset:0;';
}

/**
 * Compile a {@link VdzTimeline} to a self-contained, seekable HyperFrames HTML
 * document. PURE: depends only on `timeline` + `options`. See the file header
 * for the full contract, parity guarantee and limitations.
 */
export function compileTimelineToHtml(
  timeline: VdzTimeline,
  options: CompileTimelineOptions = {}
): CompileTimelineResult {
  const width = timeline.width || 1920;
  const height = timeline.height || 1080;
  const samples = Math.max(
    2,
    Math.min(240, Math.trunc(options.samplesPerClip ?? 24))
  );
  const map = options.resolveSrc;

  const diag = { unresolved: new Set<string>(), posterVideos: [] as string[] };
  const keyframeRules: string[] = [];
  const clipEls: string[] = [];
  let clipCount = 0;

  timeline.tracks.forEach((track, trackIndex) => {
    // Audio tracks contribute nothing visible (identical to computePreviewFrame).
    if (track.kind === 'audio') return;

    track.clips.forEach((clip, clipIndex) => {
      // audio clips can only live on audio tracks, but guard anyway.
      if (clip.type === 'audio') return;

      const win = clipRenderWindow(track, clip, clipIndex);
      const span = win.end - win.start;
      if (span <= 0) return;

      const animName = `vdz-${track.id}-${clip.id}`.replace(/[^a-zA-Z0-9_-]/g, '_');
      const stops = sampleClipKeyframes(timeline, track, clip, win, samples);
      keyframeRules.push(keyframesRule(animName, stops));

      // Effects are a static CSS filter (the preview applies them outside the
      // animated transform); read straight from anim.ts for parity.
      const filter = effectsFilterCss(clip.effects);
      const filterCss = filter ? `filter:${safeCssValue(filter, 'none')};` : '';

      // The animation runs over the clip's on-screen window, PAUSED (the host
      // seeks it via document.getAnimations()); fill:both holds first/last frame.
      const animCss =
        `animation:${animName} ${num(span)}s linear ${num(win.start)}s 1 both;` +
        'animation-play-state:paused;';

      const box = clipBoxCss(clip);
      const inner = clipInnerHtml(clip, timeline, map, diag);

      // data-start/data-duration/data-track-index on the OPENING tag — required
      // by both the runtime (visibility) and the service's text-scan duration
      // probe. z-index by track order so overlays sit above video (the preview
      // draws in the same back-to-front order).
      clipEls.push(
        `<div class="clip" data-start="${num(win.start)}" ` +
          `data-duration="${num(span)}" data-track-index="${trackIndex}" ` +
          `style="${box}${filterCss}${animCss}z-index:${trackIndex + 1};` +
          'transform-origin:center;will-change:transform,opacity;">' +
          inner +
          '</div>'
      );
      clipCount++;
    });
  });

  const durationSeconds = computeTimelineDuration(timeline);

  // Base document CSS. The near-black mat matches the AI-composition default; the
  // #stage is the timeline's own pixel box, centered + scaled. Clip visibility
  // starts hidden and the runtime reveals per frame (belt-and-braces with anim).
  const css = [
    'html,body{margin:0;height:100%;background:#05060a;overflow:hidden;}',
    'body{display:flex;align-items:center;justify-content:center;}',
    `#stage{position:relative;width:${width}px;height:${height}px;` +
      'transform-origin:center;background:#05060a;overflow:hidden;}',
    '.clip{visibility:hidden;}',
    keyframeRules.join('\n'),
  ].join('\n');

  const html = [
    '<!doctype html>',
    '<html>',
    '<head>',
    '<meta charset="utf-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1" />',
    `<title>${escapeHtml(timeline.name || 'Vdz timeline')}</title>`,
    '<style>',
    css,
    '</style>',
    '</head>',
    '<body>',
    `<div id="stage" data-composition-id="root" data-width="${width}" data-height="${height}">`,
    clipEls.join('\n'),
    '</div>',
    stageSizingScript(width, height),
    VDZ_RUNTIME,
    '</body>',
    '</html>',
  ].join('\n');

  return {
    html,
    clipCount,
    durationSeconds,
    unresolved: [...diag.unresolved],
    posterOnlyVideoClips: diag.posterVideos,
  };
}
