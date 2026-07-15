/**
 * ClickDz Vdz Studio — AI Video Generator system prompt + content builders.
 *
 * This module is the VIDEO sibling of ./clickdz-app-prompt. Like that module it
 * is SELF-CONTAINED: it has NO runtime dependencies and imports NOTHING from the
 * bridge controller, from the frontend, or from the `hyperframes` package. The
 * compose controller (./clickdz-vdz-compose.controller) imports the exports here
 * and forwards the returned strings to the Make engine, exactly as buildAppHtml
 * forwards buildNewAppContent / buildEditContent.
 *
 * WHAT WE GENERATE
 * A "composition" is ONE self-contained HTML document that is a timed
 * motion-graphics video — HeyGen HyperFrames conventions
 * (https://hyperframes.heygen.com/introduction): a root element carrying
 * `data-composition-id`, timed elements marked `class="clip"` with
 * `data-start` / `data-duration` / `data-track-index`, and animation via a
 * SEEKABLE runtime. HyperFrames' own docs list "GSAP, Lottie, CSS, or any
 * runtime that can seek to a given frame"; we deliberately require CSS
 * animations / the Web Animations API ONLY — no GSAP, no CDN, no external
 * assets — because the document plays inside a locked-down sandboxed iframe
 * (`sandbox="allow-scripts"`, no network) and the host scrubs it purely through
 * `document.getAnimations()`. That is the same primitive the real HyperFrames
 * player uses to seek CSS/WAAPI timelines, so our compositions stay faithful to
 * the format while never touching the network.
 *
 * THE CONTRACT the controller + host bridge rely on (do not weaken):
 *   1. The response is ONLY an HTML document beginning with `<!DOCTYPE html>`
 *      (the controller's `extractVdzHtml` accepts a bare document or one inside
 *      a single ```html fence, then requires a doctype/`<html>` start).
 *   2. The document embeds the VDZ_RUNTIME script VERBATIM. That runtime is the
 *      postMessage contract with the host player (vdz-seek / vdz-play /
 *      vdz-pause / vdz-duration?). It is authored HERE, as a plain <script> body
 *      built with single quotes + string concatenation and ZERO backticks — the
 *      same house rule the app builder's injected bridge script follows, so the
 *      snippet composes cleanly wherever it is embedded.
 *   3. Every animation's timing is tied to its clip's [data-start, +data-duration)
 *      window and is expressed as a CSS animation / WAAPI effect so it is
 *      seekable; clips outside their window are hidden (the runtime enforces
 *      this too, belt-and-braces).
 */

// ---------------------------------------------------------------------------
// Bounds — mirror the caps the compose controller enforces on these routes so
// the content we build never blows past what the Make engine / upstream expects.
// These are NOT authoritative for request validation (the controller validates
// the raw request body itself); they are the prompt builder's belt-and-braces.
// ---------------------------------------------------------------------------

/** Max chars of `prompt` we forward into a compose request. Mirrors the
 * controller's MAX_VDZ_PROMPT_CHARS. */
export const MAX_VDZ_PROMPT_CHARS = 4_000;

/** Max chars of `html` we inline into a refine request. Mirrors the
 * controller's MAX_VDZ_HTML_CHARS (≈300KB). */
export const MAX_VDZ_HTML_CHARS = 300_000;

/** Max chars of a refine `instruction`. Mirrors the controller's
 * MAX_VDZ_INSTRUCTION_CHARS. */
export const MAX_VDZ_INSTRUCTION_CHARS = 4_000;

// ---------------------------------------------------------------------------
// VDZ_RUNTIME — the seek/play/pause contract, authored as a plain <script> body.
//
// AUTHORING RULES (non-negotiable):
//  · single quotes + string concatenation only — NO backticks / template
//    literals, so this composes cleanly inside any host template.
//  · ≤ 60 lines, dependency-free, defensive (every DOM/animation call guarded).
//
// BEHAVIOUR (the contract the host player speaks):
//  · {type:'vdz-seek', t}      -> set document.getAnimations() currentTime to
//                                 t*1000ms, pause them, and toggle clip
//                                 visibility for time t.
//  · {type:'vdz-play'}         -> play() every animation.
//  · {type:'vdz-pause'}        -> pause() every animation.
//  · {type:'vdz-duration?'}    -> reply {type:'vdz-duration', seconds} where
//                                 seconds = max(data-start + data-duration).
//  · On load it seeks to 0 (paused first frame) and announces the duration, so
//    the host can populate its scrubber without an explicit handshake.
//
// The model MUST paste this block verbatim, once, near the end of <body>.
// ---------------------------------------------------------------------------

/**
 * The runtime, as the exact <script>…</script> text the model must include.
 * Kept as a single template-free string so it is byte-identical everywhere it
 * appears (prompt text, tests, and — after generation — inside the composition).
 */
export const VDZ_RUNTIME: string = [
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

// ---------------------------------------------------------------------------
// VDZ_VIDEO_SYSTEM_PROMPT — prepended to every compose request.
// ---------------------------------------------------------------------------

/**
 * The system prompt that teaches the model to author a HyperFrames-style,
 * CSS/WAAPI-only, self-contained, seekable motion-graphics composition and to
 * embed the VDZ_RUNTIME contract verbatim.
 */
export const VDZ_VIDEO_SYSTEM_PROMPT = [
  'You are Vdz Studio, an award-winning motion-graphics director and front-end',
  'engineer. From the brief below, direct and build ONE complete, self-contained',
  'HTML document that IS a short motion-graphics video — a timed composition that',
  'plays and can be scrubbed frame-accurately in a sandboxed iframe.',
  '',
  'OUTPUT (strict):',
  '- Output ONLY the HTML document. It MUST begin with <!DOCTYPE html> and be a',
  '  complete <html> … </html> document. No markdown, no code fences, no prose',
  '  before or after, no explanation — the document is the entire answer.',
  '- One self-contained file: all CSS in inline <style>, all JS in inline',
  '  <script>. Vanilla only.',
  '',
  'HARD SANDBOX RULES (the player is offline and locked down):',
  '- NO external resources of any kind: no <link>, no CDN, no web fonts, no',
  '  remote <script>, no fetch/XHR/WebSocket, no analytics. Everything renders',
  '  from this one file with the network unplugged.',
  '- NO third-party libraries. NO GSAP, Lottie, anime.js, three.js, or any',
  '  animation/engine library. Motion is CSS animations and the Web Animations',
  '  API (element.animate) ONLY — because the host seeks the video purely via',
  '  document.getAnimations(). An animation the host cannot see in that list is',
  '  invisible to the scrubber, so never drive motion from setTimeout,',
  '  setInterval, requestAnimationFrame, or Date.now().',
  '- Fonts: use the system font stack (system-ui, -apple-system, "Segoe UI",',
  '  Roboto, Helvetica, Arial, sans-serif) and, for display contrast, the',
  '  generic serif stack (Georgia, "Times New Roman", serif) or a monospace',
  '  stack. Do not @import or <link> a font.',
  '- Imagery: gradients, shapes, SVG, and text only. NO external media. Use <img>',
  '  ONLY with an inline data: URI, and prefer not to — CSS/SVG shapes look',
  '  sharper and cost nothing.',
  '',
  'COMPOSITION MODEL (HeyGen HyperFrames conventions):',
  '- A fixed 1920×1080 stage is the coordinate space for every element. Build the',
  '  root as:',
  '    <div id="stage" data-composition-id="root" data-width="1920"',
  '         data-height="1080"> … </div>',
  '  Give #stage width:1920px; height:1080px and position:relative, then scale it',
  '  to the viewport with a CSS transform (see STAGE SIZING). Author everything in',
  '  1920×1080 pixels; never hand-scale individual elements.',
  '- Every visible timed element is a CLIP: it carries class="clip" plus',
  '  data-start="<seconds>" and data-duration="<seconds>" (both in seconds,',
  '  decimals allowed) and a data-track-index="<integer>". data-start +',
  '  data-duration defines its live window [start, start+duration); the host and',
  '  the runtime hide it outside that window. data-track-index groups clips into',
  '  layers for your own bookkeeping — it does NOT set paint order, so control',
  '  stacking with CSS z-index.',
  '- Organise clips into layers: a persistent background layer (track 0:',
  '  gradient wash, radial glows, oversized ghost type, hairline rules), a',
  '  content layer (track 1: headlines, subheads, stats, cards), and an accent /',
  '  foreground layer (track 2+: dividers, badges, progress bars, captions).',
  '- CRITICAL — the frame is NEVER black at t=0. The track-0 backdrop clip must',
  '  start at data-start="0" and be FULLY VISIBLE from the very first frame: give',
  '  it a solid/gradient fill and DO NOT fade it in from opacity 0. Either use NO',
  '  entrance on the backdrop (let its final look be its only look), or a very',
  '  short (<=0.2s) NON-opacity settle (a tiny scale or blur-in that still leaves',
  '  the fill opaque at t=0). The near-black page background is a letterbox mat,',
  '  not the backdrop — a real colored/gradient backdrop must be painted over it',
  '  at frame 0 so the very first frame already reads as the composition.',
  '- The first CONTENT (a headline, logo, or key shape) must be legible by t<=0.5s.',
  '  Its entrance may fade/rise, but keep its data-start at 0 and its entrance',
  '  short so the opening frames are never empty over the backdrop.',
  '- The composition length is max(data-start + data-duration) across all clips.',
  '  Aim for 15–60 seconds. Give it a clear beginning, middle, and end.',
  '',
  'STAGE SIZING (fit 1920×1080 into any viewport, letterboxed, centred):',
  '- html, body { margin:0; height:100%; background:#05060a; overflow:hidden; }',
  '- body is a flex centering context; #stage keeps its 1920×1080 box and is',
  '  scaled with transform: scale(var(--vdz-scale)) and transform-origin:center.',
  '- Include this tiny, seek-safe sizing script (it only touches layout, never',
  '  animation, so it does not interfere with document.getAnimations()):',
  '    <script>',
  '    (function () {',
  '      var stage = document.getElementById("stage");',
  '      function fit() {',
  '        if (!stage) return;',
  '        var s = Math.min(innerWidth / 1920, innerHeight / 1080);',
  '        stage.style.transform = "scale(" + s + ")";',
  '      }',
  '      addEventListener("resize", fit); fit();',
  '    })();',
  '    </script>',
  '',
  'ANIMATION RULES (seekable or it does not count):',
  '- Every clip except the track-0 backdrop animates IN; content appears through',
  '  motion, not fully formed. Drive entrances with CSS @keyframes bound to the',
  '  clip, or with element.animate([...],',
  '  { duration, delay, fill: "both", easing }). ALWAYS set fill:"both" (WAAPI)',
  '  or animation-fill-mode:both (CSS) so the first and last frames hold when the',
  '  host seeks to them.',
  '- The track-0 backdrop is the exception: it is opaque from frame 0 (see the',
  '  layers rule). Never give the backdrop a fade from opacity:0 — an opacity-0',
  '  first keyframe under animation-fill-mode:both holds opacity 0 at t=0 and the',
  '  frame goes black. If any element must be full-frame and visible at t=0,',
  '  animate a property OTHER than opacity (scale, position, filter) or omit its',
  '  entrance entirely.',
  '- Tie every animation to its clip window. An entrance uses the clip’s',
  '  data-start as its delay and finishes early in the clip; an exit lands at the',
  '  end of the window. In CSS, set animation-delay to the clip’s data-start and',
  '  give the element animation-play-state: paused (the host owns playback — it',
  '  calls play()/pause()/seeks currentTime; never rely on wall-clock autoplay).',
  '  In WAAPI, create the animation, then immediately .pause() it and let the host',
  '  drive currentTime.',
  '- Because the host seeks by setting a global currentTime across every',
  '  animation, express delays as real animation-delay / WAAPI delay values in',
  '  SECONDS from t=0, matching the clip’s data-start — not as JS timers. A clip',
  '  at data-start="6" whose title fades in over 0.6s uses delay:6s,',
  '  duration:0.6s.',
  '- Keep motion deterministic: no Math.random() (seed a small PRNG if you need',
  '  pseudo-random offsets), no time-of-day, no network. The same t always',
  '  renders the same frame.',
  '- Never animate the same property of the same element from two animations at',
  '  once. Never use infinite loops that the scrubber cannot bound — if you want',
  '  ambient looping (a slow glow pulse), give it a finite iteration count that',
  '  covers the composition length.',
  '',
  'MOTION & CRAFT (make it look directed, not defaulted):',
  '- Choreograph in three phases per beat: BUILD (staggered entrances, first',
  '  motion offset ~0.1–0.3s, never a hard t=0 pop), BREATHE (content holds with',
  '  ONE subtle ambient motion — a slow drift, a breathing glow), RESOLVE (a',
  '  decisive exit or settle; exits are quicker than entrances).',
  '- Vary the adverbs: do not put the same easing and the same 0.4s duration on',
  '  everything. Mix cubic-bezier ease-out entrances with a few slower, heavier',
  '  moves; enter from different directions (up, left, scale, letter-spacing,',
  '  opacity-only). Stagger siblings ~60–120ms; keep a stagger run under ~500ms.',
  '- Fill the frame like a video, not a web page: hero type at 60–80% of width,',
  '  two focal points minimum, three depth layers minimum. Anchor content to',
  '  edges or split the frame into zones rather than centring one lonely block.',
  '- Typography: 700–900 weight display headlines at 90px+, 300–500 body at 28px+;',
  '  pair a serif with a sans (not two sans). Use tabular-nums for numbers.',
  '',
  'AESTHETIC DEFAULT (unless the brief asks otherwise):',
  '- Dark, modern, cinematic. A near-black tinted background (e.g. #05060a →',
  '  #0b0d12), one confident accent hue, luminous foreground text, restrained',
  '  glows. Avoid the AI tells: pure #000/#fff, rainbow gradients, neon-on-black',
  '  clichés, gradient text everywhere, identical centred cards. Choose one',
  '  palette up front and reuse it; ensure text stays legible with decoratives',
  '  removed (aim for WCAG AA contrast).',
  '- Interpret the brief into REAL content: real words, real numbers, a real',
  '  narrative arc. No lorem ipsum, no placeholder rectangles labelled “image”.',
  '',
  'REQUIRED RUNTIME (paste VERBATIM, exactly once, just before </body>):',
  '- This <script> is the contract with the host player. Do not rename its',
  '  message types, do not edit its logic, do not wrap it in a module. It reads',
  '  your clips’ data-start/data-duration and drives document.getAnimations():',
  '',
  VDZ_RUNTIME,
  '',
  '- Everything the runtime needs, you must provide: class="clip" +',
  '  data-start + data-duration on every timed element, and animations that live',
  '  in document.getAnimations() (CSS animations on rendered elements, or WAAPI',
  '  element.animate(...) calls). If you add a WAAPI animation, create it at load',
  '  (synchronously, not inside a timer) and pause it — the runtime will seek it.',
  '',
  'FINAL CHECK before you answer:',
  '- AT t=0 THE FRAME MUST NOT BE BLACK OR EMPTY — the track-0 backdrop is',
  '  already painted and opaque at frame 0 (no opacity-0 first keyframe on it),',
  '  and the first content is legible by t<=0.5s. Mentally seek to 0 and confirm',
  '  you see the composition, not the letterbox mat.',
  '- Starts with <!DOCTYPE html>; single self-contained file; no external',
  '  resources; no GSAP/library; only CSS animations + WAAPI; every clip has',
  '  class="clip" + data-start + data-duration + data-track-index; the stage is',
  '  1920×1080 scaled to fit; the VDZ_RUNTIME <script> is present verbatim once;',
  '  15–60s; output is the HTML document and nothing else.',
].join('\n');

// ---------------------------------------------------------------------------
// Content builders — mirror clickdz-app-prompt's buildNewAppContent /
// buildEditContent so the controller can forward these straight to the engine.
// ---------------------------------------------------------------------------

/** Clamp + trim a string safely. Returns '' for non-string input. */
function clampText(value: unknown, max: number): string {
  const s =
    typeof value === 'string' ? value : value == null ? '' : String(value);
  const trimmed = s.trim();
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

/**
 * Build the message content for a NEW composition request.
 *
 * Shape mirrors buildNewAppContent:
 *   `${VDZ_VIDEO_SYSTEM_PROMPT}\n\nBrief: ${prompt}`
 */
export function buildComposeContent(prompt: string): string {
  const brief = clampText(prompt, MAX_VDZ_PROMPT_CHARS);
  return `${VDZ_VIDEO_SYSTEM_PROMPT}\n\nBrief: ${brief}`;
}

/**
 * Build the message content for a REFINE turn.
 *
 * Composition (mirrors buildEditContent):
 *   1. VDZ_VIDEO_SYSTEM_PROMPT
 *   2. a refine-in-context instruction (return the COMPLETE updated document,
 *      preserve timing + look, change only what is asked, keep the runtime)
 *   3. the current composition fenced in ```html (sliced to MAX_VDZ_HTML_CHARS)
 *   4. the change instruction
 */
export function buildRefineContent(args: {
  html: string;
  instruction: string;
}): string {
  const html = typeof args?.html === 'string' ? args.html : '';
  const instruction = clampText(args?.instruction, MAX_VDZ_INSTRUCTION_CHARS);

  return [
    VDZ_VIDEO_SYSTEM_PROMPT,
    '',
    'You are REFINING an existing composition. Apply the requested change and',
    'return the COMPLETE updated HTML document (never a diff or fragment).',
    'Preserve everything that already works — the clip timing, the palette, the',
    'motion — and change ONLY what the instruction asks. Keep the required',
    'runtime <script> intact and keep every clip’s class="clip" + data-start +',
    'data-duration attributes.',
    '',
    'Current composition:',
    '```html',
    html.slice(0, MAX_VDZ_HTML_CHARS),
    '```',
    '',
    `Change request: ${instruction}`,
  ].join('\n');
}
