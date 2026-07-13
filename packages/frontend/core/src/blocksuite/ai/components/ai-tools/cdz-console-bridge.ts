/**
 * Console bridge — captures the preview iframe's runtime console + errors and
 * relays them to the parent Studio's Problems panel (shared brief §1, §2).
 *
 * Two halves live here:
 *
 *  1. `CDZ_CONSOLE_BRIDGE` — a self-contained IIFE *string* injected into the
 *     preview `<head>` FIRST (before the app's own scripts run) so it can catch
 *     early errors. It runs inside the sandboxed iframe (`allow-scripts`, NO
 *     `allow-same-origin`), so it talks to the parent ONLY via
 *     `window.parent.postMessage(msg, '*')`. Written with plain string
 *     concatenation (single quotes, NO nested backticks / template literals) so
 *     it composes cleanly inside this module — mirrors how `buildBridgeScript`
 *     is authored in clickdz-builder-studio.ts.
 *
 *  2. Parent-side helpers — `normalizeConsoleMessage` validates/sanitizes an
 *     incoming `cdz-console` wire message (the parent already gates on
 *     `event.source === frame.contentWindow` before calling us, exactly like
 *     the studio's `handleMessage`), and `coalesceProblem` folds a fresh entry
 *     into the accumulated `CdzProblem[]` (consecutive-duplicate coalescing,
 *     bounded retention). Both are pure/deterministic and dependency-free.
 *
 * ── Wire contract (preview iframe → parent), shared brief §1 ─────────────────
 *   { type: 'cdz-console', level: 'error' | 'warn' | 'log',
 *     text: string, source?: string, line?: number }
 */

/** The three console levels the bridge captures (shared brief §1). */
export type CdzConsoleLevel = 'error' | 'warn' | 'log';

/**
 * A single accumulated problem on the parent side (shared brief §1). Owned by
 * this module; the studio holds a `CdzProblem[]` and renders it in the Problems
 * panel.
 */
export interface CdzProblem {
  level: CdzConsoleLevel;
  /** Sanitized message text, always <= `TEXT_CAP` (500) chars. */
  text: string;
  /** Best-effort origin (filename/url) when the iframe could resolve one. */
  source?: string;
  /** 1-based line number when available. */
  line?: number;
  /** Consecutive-duplicate coalescing count (>= 1). */
  count: number;
  /** `Date.now()` of the FIRST occurrence in the current run. */
  ts: number;
}

/** Hard cap on a single message's text length (both sides enforce it). */
const TEXT_CAP = 500;

/** The valid wire levels, as a lookup for O(1) validation on the parent side. */
const VALID_LEVELS: Readonly<Record<string, CdzConsoleLevel>> = {
  error: 'error',
  warn: 'warn',
  log: 'log',
};

/* ─────────────────── injected capture snippet ─────────────────── */

/**
 * Self-contained IIFE string injected into the preview `<head>` FIRST. It:
 *  - installs a capture-phase `error` listener (script errors via
 *    `event.message/filename/lineno`, plus resource load failures via
 *    `event.target` → a terse "Failed to load <tag> <src>");
 *  - installs an `unhandledrejection` listener (reports `reason`);
 *  - wraps `console.error/warn/log` — posts an entry AND calls the original
 *    through, so the app's console is never broken;
 *  - posts `{ type:'cdz-console', level, text, source?, line? }` to
 *    `window.parent` via `postMessage(msg, '*')`;
 *  - is defensive: truncates text to 500 chars, hard-caps total posts (~200) so
 *    an error loop can't flood the parent, and wraps its whole body in
 *    try/catch so the capture can NEVER throw into the app.
 *
 * NOTE: keep this in sync with the parent-side `normalizeConsoleMessage`, which
 * re-validates every field defensively.
 */
export const CDZ_CONSOLE_BRIDGE: string =
  '(function(){' +
  'try{' +
  // ── config / state ──────────────────────────────────────────
  'var TEXT_CAP=500;' + // truncate every posted message body to this
  'var POST_CAP=200;' + // hard cap on total posts (flood guard)
  'var posts=0;' + // running count of posts made so far
  // Coerce an arbitrary value to a bounded, single-string message body.
  'function toText(v){' +
  'var s;' +
  'try{' +
  'if(typeof v==="string"){s=v;}' +
  'else if(v instanceof Error){s=(v.name||"Error")+": "+(v.message||"");}' +
  'else if(v===null){s="null";}' +
  'else if(v===undefined){s="undefined";}' +
  'else{s=String(v);}' +
  '}catch(_e){s="[unserializable]";}' +
  'if(typeof s!=="string"){s="";}' +
  'if(s.length>TEXT_CAP){s=s.slice(0,TEXT_CAP);}' +
  'return s;}' +
  // Join a console call's arguments into one bounded body.
  'function argsToText(args){' +
  'var parts=[];' +
  'for(var i=0;i<args.length;i++){parts.push(toText(args[i]));}' +
  'var s=parts.join(" ");' +
  'if(s.length>TEXT_CAP){s=s.slice(0,TEXT_CAP);}' +
  'return s;}' +
  // The single choke-point for talking to the parent. Enforces the flood cap
  // and swallows any postMessage error (e.g. a detached frame).
  'function post(level,text,source,line){' +
  'if(posts>=POST_CAP)return;' +
  'posts++;' +
  'var msg={type:"cdz-console",level:level,text:toText(text)};' +
  'if(typeof source==="string"&&source){msg.source=source.slice(0,TEXT_CAP);}' +
  'if(typeof line==="number"&&isFinite(line)){msg.line=line;}' +
  'try{window.parent.postMessage(msg,"*");}catch(_e){}}' +
  // ── window error (capture phase) ─────────────────────────────
  // Handles BOTH uncaught script errors and failed resource loads. A resource
  // error has no `message`; its `target` is the failing <img>/<script>/<link>.
  'window.addEventListener("error",function(e){' +
  'try{' +
  'var t=e&&e.target;' +
  'if(t&&t!==window&&t.tagName){' +
  'var tag=(t.tagName||"").toLowerCase();' +
  'var src=t.src||t.href||"";' +
  'post("error","Failed to load "+tag+(src?(" "+src):""),src||undefined,undefined);' +
  'return;}' +
  'var text=(e&&e.message)?e.message:"Script error";' +
  'post("error",text,(e&&e.filename)||undefined,' +
  '(e&&typeof e.lineno==="number")?e.lineno:undefined);' +
  '}catch(_e){}' +
  '},true);' +
  // ── unhandled promise rejection ──────────────────────────────
  'window.addEventListener("unhandledrejection",function(e){' +
  'try{' +
  'var r=e?e.reason:undefined;' +
  'var text=(r&&r.message)?((r.name||"Error")+": "+r.message):toText(r);' +
  'post("error","Unhandled rejection: "+text,undefined,undefined);' +
  '}catch(_e){}' +
  '});' +
  // ── console.error / warn / log wrappers ──────────────────────
  // Post an entry AND call the original through so the app's console is intact.
  'try{' +
  'var levels=["error","warn","log"];' +
  'for(var li=0;li<levels.length;li++){' +
  '(function(level){' +
  'var orig=console[level];' +
  'if(typeof orig!=="function")return;' +
  'console[level]=function(){' +
  'try{post(level,argsToText(arguments),undefined,undefined);}catch(_e){}' +
  'try{return orig.apply(console,arguments);}catch(_e){}' +
  '};' +
  '})(levels[li]);' +
  '}' +
  '}catch(_e){}' +
  '}catch(_e){}' + // outermost guard: capture must never throw into the app
  '})();';

/* ─────────────────── parent-side validation ─────────────────── */

/**
 * Validate + sanitize an incoming `cdz-console` wire message on the parent
 * side. Returns a clean `{ level, text, source?, line? }` (text clamped to
 * 500), or `null` when the payload is malformed (wrong shape, unknown level,
 * empty text). The caller is expected to have already confirmed the message
 * originated from the trusted preview frame (`event.source` check).
 */
export function normalizeConsoleMessage(
  data: unknown
): { level: CdzConsoleLevel; text: string; source?: string; line?: number } | null {
  if (typeof data !== 'object' || data === null) return null;
  const msg = data as Record<string, unknown>;
  if (msg.type !== 'cdz-console') return null;

  const level =
    typeof msg.level === 'string' ? VALID_LEVELS[msg.level] : undefined;
  if (!level) return null;

  if (typeof msg.text !== 'string') return null;
  const text = msg.text.length > TEXT_CAP ? msg.text.slice(0, TEXT_CAP) : msg.text;
  if (text.length === 0) return null;

  const out: {
    level: CdzConsoleLevel;
    text: string;
    source?: string;
    line?: number;
  } = { level, text };

  if (typeof msg.source === 'string' && msg.source.length > 0) {
    out.source =
      msg.source.length > TEXT_CAP ? msg.source.slice(0, TEXT_CAP) : msg.source;
  }
  if (typeof msg.line === 'number' && Number.isFinite(msg.line)) {
    out.line = msg.line;
  }

  return out;
}

/**
 * Fold `incoming` into the accumulated problem list, returning a NEW array
 * (pure — never mutates `list`):
 *  - if `incoming` matches the LAST entry (same `level` AND `text`), bump that
 *    entry's `count` (a consecutive-duplicate) rather than appending;
 *  - otherwise append `{ ...incoming, count: 1, ts: Date.now() }`;
 *  - retain only the last `cap` entries (oldest dropped) when `cap > 0`.
 *
 * `source`/`line` of the first occurrence are preserved on a coalesce (the
 * shared identity is level+text, matching the panel's `×N` grouping).
 */
export function coalesceProblem(
  list: CdzProblem[],
  incoming: { level: CdzConsoleLevel; text: string; source?: string; line?: number },
  cap: number
): CdzProblem[] {
  const last = list.length > 0 ? list[list.length - 1] : undefined;

  let next: CdzProblem[];
  if (last && last.level === incoming.level && last.text === incoming.text) {
    // Consecutive duplicate → copy all but the last, then push a bumped clone.
    next = list.slice(0, list.length - 1);
    next.push({ ...last, count: last.count + 1 });
  } else {
    next = list.slice();
    const entry: CdzProblem = {
      level: incoming.level,
      text: incoming.text,
      count: 1,
      ts: Date.now(),
    };
    if (incoming.source !== undefined) entry.source = incoming.source;
    if (incoming.line !== undefined) entry.line = incoming.line;
    next.push(entry);
  }

  if (cap > 0 && next.length > cap) {
    return next.slice(next.length - cap);
  }
  return next;
}
