import {
  captionAnchorY,
  captionPresetCss,
  computePreviewFrame,
  KARAOKE_ACCENT,
  KARAOKE_UPCOMING_OPACITY,
  karaokeTokens,
  mergeFilters,
  resolveItemRender,
  vignetteOverlayCss,
  visualTransformCss,
} from '../../desktop/pages/workspace/vdz/anim';
import type { VdzClip, VdzTimeline, VdzTrack } from './schema';
// C1: the ONE canonical export-duration rule (max clip end over ALL clips on ALL
// tracks, floored at 1s). Lives in the export-orchestration module so the dialog
// and both render tiers share a single source of truth. The static import is
// safe from a cycle: use-vdz-timeline-export only reaches back here via a dynamic
// `import()` inside its async `start()`, never at module-eval time.
import {
  computeExportDurationSec,
  resolveExportFps,
} from './use-vdz-timeline-export';

/**
 * Vdz Studio — timeline → HyperFrames HTML compiler (Cluster 2, Option B).
 *
 * A PURE function `compileTimelineToHtml(timeline)` that emits ONE self-contained
 * HTML document in exactly the shape the cdz-render service already renders and
 * the VDZ_RUNTIME already drives (see clickdz-vdz-video-prompt.ts + server.mjs):
 *   · a `#stage` root carrying `data-composition-id` at `width×height`, scaled to
 *     the viewport (the same seek-safe sizing script the AI compositions use).
 *     It ALSO carries `data-start="0"` + the C1 `data-duration` (plus `data-fps`
 *     / `data-width` / `data-height`) so the offline `hyperframes` producer
 *     resolves the composition's LENGTH from the root directly — the exact whole-
 *     timeline duration — instead of re-probing a shorter one (see below);
 *   · one `class="clip"` element per visible clip, carrying `data-start` /
 *     `data-duration` / `data-track-index` on its OPENING tag (so the service's
 *     text-scan duration probe and the runtime's visibility toggle both see it);
 *   · motion expressed as CSS `@keyframes` bound with `animation-play-state:
 *     paused` — SEEKABLE via `document.getAnimations()`, which is the ONLY thing
 *     the host/service scrub through;
 *   · the VDZ_RUNTIME embedded VERBATIM near the end of <body>.
 *
 * WHOLE-TIMELINE DURATION — the truncation fix (C1).
 * The classic tier used to derive its recording length purely from the max
 * `class="clip"` window end (the producer's + `probeDurationSeconds`'s DOM scan).
 * That scan omits AUDIO clips entirely (they emit no `.clip` element) and any
 * trailing GAP after the last visual clip, so a timeline whose furthest-right
 * content is on an audio track — or which ends on empty space — recorded SHORT.
 * We now (1) stamp the authoritative C1 duration onto the `#stage` root so the
 * producer uses it verbatim, and (2) emit an invisible full-span ANCHOR clip
 * covering `[0, C1]` WHENEVER the natural max clip-window end falls short of C1,
 * so the runtime's own `duration()` and the server's regex probe both report the
 * full length too. A timeline whose visual clips already reach C1 emits NO anchor
 * and is byte-identical to before.
 *
 * PREVIEW PARITY — the load-bearing guarantee.
 * We do NOT re-derive any easing/animation/transition math here. For every clip
 * we SAMPLE the preview's OWN pure functions (`computePreviewFrame` →
 * `resolveItemRender` / `visualTransformCss`) at N points across the clip's
 * on-screen window and emit those exact opacity / transform / clip-path /
 * filter values as keyframe stops. So the exported frames are byte-identical to
 * what `preview-canvas.tsx` paints at the same playhead — animation curves,
 * effect filters and boundary transitions all come from `anim.ts`, never a fork.
 *
 * Because the sampled pipeline is kind-agnostic, EVERY transition mirrors for
 * free through it: `fade` (opacity), `dissolve` (opacity + a time-varying
 * defocus blur folded into the sampled `filter`), `slide` and `push` (an
 * `extraTranslateX` folded into the transform), and `wipe` and `iris` (an inset
 * / circular `clip-path`). Likewise a clip's static `opacity`/`rotation` ride
 * the sampled transform+opacity. The ONE effect that is NOT a filter — the
 * `vignette` edge-darkening overlay — and the caption presets (`capPreset`
 * chrome + `capPosition` anchor) are the only things emitted directly below,
 * both via the SAME `anim.ts` helpers (`vignetteOverlayCss`, `captionPresetCss`,
 * `captionAnchorY`) the preview uses, so those match frame-for-frame too.
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
  /**
   * Composition length in seconds — the canonical C1 duration (max clip end over
   * ALL clips on ALL tracks, floored at 1s). This is the value stamped on the
   * composition root, so it matches the length the render tier records.
   */
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
// Karaoke word highlighting — PURE CSS, no JS.
//
// Each spoken word is a <span> whose BASE style is the `upcoming` (dimmed) look
// and which carries a single CSS animation bound to the ONE shared @keyframes
// `KARAOKE_KEYFRAMES_NAME` (emitted once per document). Per span:
//   animation: <name> <max(t1-t0,0.12)>s linear <clip.start + t0>s 1 forwards;
//   animation-play-state: paused;
// The delay is ABSOLUTE-timeline seconds (clip-relative t0 shifted by the
// clip's own start), because the runtime seeks EVERY animation to the same
// absolute time via document.getAnimations() → a.currentTime = t*1000. So a
// word's animation sits at 0% exactly when the playhead reaches clip.start+t0.
//
// The keyframes hold the `active` look for the bulk of the word then flip to
// `spoken` at the end; combined with base=upcoming + fill=forwards this yields
// the three discrete states the preview shows (upcoming before, active during,
// spoken after) with NO script — the host's existing seek/pause of
// getAnimations() drives it, so preview and export highlight identically.
// ---------------------------------------------------------------------------

/** Name of the one shared karaoke @keyframes rule (emitted once per document). */
const KARAOKE_KEYFRAMES_NAME = 'vdz-kw';
/** Minimum per-word animation duration so a very short word still shows. */
const KARAOKE_MIN_WORD_SECONDS = 0.12;

/**
 * The single `@keyframes` that every karaoke word span binds to. `0%..80%`
 * holds the ACTIVE look (accent pill + scale + underline + dark text), then
 * `100%` settles to the SPOKEN look (full colour, upright, no pill). The span's
 * own base style supplies the UPCOMING (dimmed) look during the animation's
 * delay (fill:forwards leaves the base showing before it starts). Fixed block —
 * no user input — so it is emitted verbatim.
 */
function karaokeKeyframesRule(): string {
  return (
    `@keyframes ${KARAOKE_KEYFRAMES_NAME} {\n` +
    '  0% { ' +
    `background:${KARAOKE_ACCENT};color:#1a1200;` +
    'transform:scale(1.08);opacity:1;' +
    'text-decoration:underline;text-decoration-thickness:0.06em;' +
    'box-shadow:0 0 0.5em rgba(255,213,74,0.5);' +
    ' }\n' +
    '  80% { ' +
    `background:${KARAOKE_ACCENT};color:#1a1200;` +
    'transform:scale(1.08);opacity:1;' +
    'text-decoration:underline;text-decoration-thickness:0.06em;' +
    'box-shadow:0 0 0.5em rgba(255,213,74,0.5);' +
    ' }\n' +
    '  100% { ' +
    'background:transparent;color:inherit;' +
    'transform:scale(1);opacity:1;' +
    'text-decoration:none;box-shadow:none;' +
    ' }\n' +
    '}'
  );
}

/**
 * Build the inner HTML for a KARAOKE caption clip: one `<span>` per word, each
 * with the upcoming base look + a paused per-word animation (delay/duration
 * from its clip-relative `t0`/`t1`, shifted to absolute-timeline seconds by
 * `clipStart`). Returns `null` when the clip has no usable words so the caller
 * falls back to the plain single-node text render (degrades to boxed). Text is
 * HTML-escaped; the style blocks are fixed (numbers only) and emitted verbatim.
 */
function karaokeInnerHtml(
  clip: Extract<VdzClip, { type: 'text' }>,
  clipStart: number
): string | null {
  const tokens = karaokeTokens(clip);
  if (!tokens || tokens.length === 0) return null;
  // Base (upcoming) look shared by every span; the animation overrides it.
  const spanBase =
    'display:inline-block;border-radius:6px;padding:0 0.12em;' +
    'transform-origin:center bottom;' +
    `opacity:${KARAOKE_UPCOMING_OPACITY};`;
  const spans = tokens.map((tok, i) => {
    const dur = num(Math.max(KARAOKE_MIN_WORD_SECONDS, tok.t1 - tok.t0));
    const delay = num(clipStart + tok.t0);
    const anim =
      `animation:${KARAOKE_KEYFRAMES_NAME} ${dur}s linear ${delay}s 1 forwards;` +
      'animation-play-state:paused;';
    // A trailing space between words (outside the span) so wrapping is natural.
    const sep = i < tokens.length - 1 ? ' ' : '';
    return `<span style="${spanBase}${anim}">${escapeHtml(tok.w)}</span>${sep}`;
  });
  return spans.join('');
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
  /**
   * The per-frame CSS `filter` (a clip's static effects PLUS any time-varying
   * transition defocus — the DISSOLVE blur). Undefined when there is none.
   * Emitted as an animated keyframe property so a dissolve's blur ramps in the
   * export exactly as it does in the preview, instead of a static filter.
   */
  filter: string | undefined;
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
    let filter: string | undefined;
    if (item) {
      const r = resolveItemRender(item);
      opacity = r.opacity;
      clipPath = r.clipPath;
      const composed = {
        ...item.visual,
        translateX: item.visual.translateX + r.extraTranslateX,
      };
      transform = visualTransformCss(composed, isText ? 'text' : 'clip');
      // `computePreviewFrame` has already merged a DISSOLVE's defocus into
      // `item.filter`; belt-and-braces re-merge `extraFilter` so the blur is
      // present even if a caller mutated the item. Static effects + dissolve
      // blur therefore ride the SAME animated `filter` track as the preview.
      filter = mergeFilters(item.filter, r.extraFilter);
    } else {
      // Edge miss: reproduce the neutral-but-hidden state. Text keeps its
      // centering transform so it doesn't jump if the browser interpolates.
      opacity = 0;
      transform = isText ? 'translate(-50%, -50%)' : 'none';
      clipPath = undefined;
      filter = undefined;
    }
    stops.push({ offset: frac, opacity, transform, clipPath, filter });
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
    // Filter rides the keyframes too so a clip's static effects AND a
    // DISSOLVE's time-varying defocus animate in lockstep with the preview.
    // Sanitized (same rules as a color/filter value); `none` is the default.
    decls.push(`filter:${s.filter ? safeCssValue(s.filter, 'none') : 'none'}`);
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
      // Caption preset (capPreset) contributes an inner text-node style — the
      // `outline` ring via -webkit-text-stroke. The wrapper chrome (pill bg,
      // padding, shadow override) is applied on the box in clipBoxCss so both
      // the preview and this compiler read the SAME captionPresetCss helper.
      // capText is a fixed declaration block from our own helper (no user
      // input flows into it), so it is emitted verbatim — safeCssValue is for
      // single user-supplied values (it rejects the ';'/':' a block needs).
      const capText = captionPresetCss(clip).text;
      const style =
        `font-size:${px}px;color:${color};text-align:${align};` +
        'font-weight:700;line-height:1.1;' +
        capText;
      // Karaoke: per-word spans with pure-CSS per-word animations (delay/dur
      // from t0/t1), when the `karaoke` preset carries words. Otherwise (plain
      // caption, or karaoke with no words) render the whole line as one node —
      // the boxed wrapper chrome already applied in clipBoxCss makes karaoke
      // degrade to the familiar boxed look.
      const kw = karaokeInnerHtml(clip, clip.start);
      const body = kw ?? escapeHtml(clip.text);
      return `<div style="${style}">${body}</div>`;
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
    // Vertical anchor: an explicit `y` wins, else the capPosition preset
    // (top/middle/lower) via captionAnchorY — the SAME helper the preview
    // uses, so exported captions sit exactly where the preview shows them.
    const top = num(captionAnchorY(clip) * 100);
    // whiteSpace + textShadow mirror styles.previewText. The caption preset's
    // WRAPPER chrome (capPreset: pill/boxed background+padding+radius, or a
    // shadow/outline text-shadow override) is appended AFTER the default
    // shadow so a preset override wins (CSS keeps the last declaration). It is
    // a fixed block from our helper (no user strings) — emitted verbatim.
    const capWrap = captionPresetCss(clip).wrap;
    return (
      `position:absolute;left:${left}%;top:${top}%;` +
      'white-space:pre-wrap;text-shadow:0 2px 12px rgba(0,0,0,0.6);' +
      capWrap
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
  // Whether any emitted clip uses the karaoke word spans — the one shared
  // @keyframes is only added to the document when true, so a timeline with no
  // karaoke captions produces byte-identical CSS to before.
  let usesKaraoke = false;
  // Furthest-right VISUAL clip-window end actually emitted as a `.clip`. Used to
  // decide whether the timed content already spans the full C1 duration or needs
  // a trailing anchor (audio-only tail / trailing gap → it falls short).
  let maxWindowEnd = 0;

  timeline.tracks.forEach((track, trackIndex) => {
    // Audio tracks contribute nothing visible (identical to computePreviewFrame).
    if (track.kind === 'audio') return;

    track.clips.forEach((clip, clipIndex) => {
      // audio clips can only live on audio tracks, but guard anyway.
      if (clip.type === 'audio') return;

      const win = clipRenderWindow(track, clip, clipIndex);
      const span = win.end - win.start;
      if (span <= 0) return;
      if (win.end > maxWindowEnd) maxWindowEnd = win.end;

      // A karaoke caption with usable words emits per-word spans → mark that the
      // shared @keyframes is needed.
      if (
        clip.type === 'text' &&
        clip.capPreset === 'karaoke' &&
        karaokeTokens(clip)
      ) {
        usesKaraoke = true;
      }

      const animName = `vdz-${track.id}-${clip.id}`.replace(/[^a-zA-Z0-9_-]/g, '_');
      const stops = sampleClipKeyframes(timeline, track, clip, win, samples);
      keyframeRules.push(keyframesRule(animName, stops));

      // Effects (and any DISSOLVE defocus) are emitted as an ANIMATED `filter`
      // inside the keyframes above — sampled from anim.ts for parity — so no
      // static element-level filter is applied here (that would override the
      // animation). The `vignette` effect is the exception: it is NOT a CSS
      // filter but an edge-darkening OVERLAY (see below).
      // vignetteOverlayCss returns a fixed declaration block (only numbers
      // derived from the effect `amount` flow into it — no user strings), so
      // it is emitted verbatim; safeCssValue would reject the ';'/':' it needs.
      const vignette = vignetteOverlayCss(clip.effects);
      const vignetteEl = vignette ? `<div style="${vignette}"></div>` : '';

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
      // draws in the same back-to-front order). The vignette overlay is drawn
      // LAST (after the clip content) so it darkens the corners on top.
      clipEls.push(
        `<div class="clip" data-start="${num(win.start)}" ` +
          `data-duration="${num(span)}" data-track-index="${trackIndex}" ` +
          `style="${box}${animCss}z-index:${trackIndex + 1};` +
          'transform-origin:center;will-change:transform,opacity,filter;">' +
          inner +
          vignetteEl +
          '</div>'
      );
      clipCount++;
    });
  });

  // Emit the ONE shared karaoke @keyframes exactly once, only when a karaoke
  // caption was rendered (keeps non-karaoke documents byte-identical). Every
  // word span across every caption binds to this single rule.
  if (usesKaraoke) {
    keyframeRules.push(karaokeKeyframesRule());
  }

  // C1: the canonical whole-timeline duration (max clip end over ALL clips on
  // ALL tracks — audio included — floored at 1s). The classic tier's own DOM
  // scan (`probeDurationSeconds`) and runtime `duration()` see only VISUAL
  // `.clip` windows, so when the timeline's furthest content is on an audio
  // track — or there's a trailing gap — that scan reports LESS than C1.
  const durationSeconds = computeExportDurationSec(timeline);
  const fps = resolveExportFps(timeline);

  // TRUNCATION FIX: if the emitted visual windows fall short of C1 (with a
  // one-frame tolerance so float noise / a transition tail doesn't trip it),
  // append an INVISIBLE anchor clip spanning the full [0, C1] window. It carries
  // data-start/data-duration so BOTH the server's regex probe and the runtime's
  // `duration()` report the full length; it paints nothing (opacity:0, empty),
  // and is hidden by the runtime's visibility toggle outside its span anyway.
  // No animation is bound to it — it is a pure timing marker. Emitted ONLY when
  // needed, so a timeline whose visuals already reach C1 stays byte-identical.
  const frameTol = fps > 0 ? 1 / fps : 1e-3;
  if (durationSeconds - maxWindowEnd > frameTol) {
    clipEls.push(
      `<div class="clip" data-start="0" data-duration="${num(durationSeconds)}" ` +
        'data-track-index="0" aria-hidden="true" ' +
        'style="position:absolute;inset:0;opacity:0;pointer-events:none;' +
        'z-index:0;"></div>'
    );
  }

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
    // Root composition element. `data-start="0"` + the C1 `data-duration` let the
    // hyperframes producer resolve the FULL timeline length from the root (it is
    // idempotent server-side: server.mjs::prepareRoot leaves an existing
    // data-start/data-duration untouched, so our authoritative values win over
    // its `.clip`-scan fallback). `data-fps`/`data-width`/`data-height` carry the
    // export dimensions + frame rate alongside (C2).
    `<div id="stage" data-composition-id="root" data-start="0" ` +
      `data-duration="${num(durationSeconds)}" data-fps="${num(fps)}" ` +
      `data-width="${width}" data-height="${height}">`,
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
