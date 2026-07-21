/**
 * ClickDz Builder Studio — system prompt + message-content builders for the
 * single-file-HTML app editor.
 *
 * This module is SELF-CONTAINED: it has no runtime dependencies and imports
 * nothing from the bridge controller. The controller imports the exports here
 * and forwards the returned strings to the code agent (see how `buildAppHtml`
 * builds its `content` today).
 *
 * Contract the controller relies on (unchanged): the model MUST return ONE
 * self-contained `index.html` inside a single ```html code block and nothing
 * else, so the controller's `extractHtmlApp` can parse it. `extractHtmlApp`
 * pulls the first ```html fence and then requires the content to start with
 * `<!doctype html>` or `<html …>`; the guidelines below enforce exactly that.
 *
 * Design note: this is an "adapted-Lovable" prompt — it keeps the spirit
 * (edit-in-context, design-system discipline, beautiful/responsive/accessible,
 * minimal scope, in-app feedback) but DROPS the Lovable stack entirely. There
 * is NO React / Vite / Tailwind / shadcn / TypeScript project / Supabase /
 * multi-file / build step here: the output is always ONE vanilla-HTML file
 * rendered in a sandboxed iframe. The ClickDz Data API + dashboards guidance
 * is preserved verbatim from the controller's original constant so the
 * `__CLICKDZ_DATA_URL__` placeholder wiring keeps working.
 */

// ---------------------------------------------------------------------------
// Bounds — mirror the caps the controller already enforces on this route so
// the content we build never blows past what the agent / upstream expects.
// These are safe to import and reuse; they are not authoritative for request
// validation (the controller still validates the raw request body itself).
// ---------------------------------------------------------------------------

/** Max chars of `currentHtml` we inline into an edit prompt (matches the
 * controller's original 300_000 slice in `buildAppHtml`). */
export const MAX_EDIT_HTML_CHARS = 300_000;

/** Max recent history turns we render into an edit prompt. Mirrors the
 * canonical request bound (`history` ≤ 6 turns). */
export const MAX_HISTORY_TURNS = 6;

/** Max chars of a single rendered history turn's text. Mirrors the canonical
 * `CdzTurn.text` bound (≤ 2000 chars). */
export const MAX_HISTORY_TURN_CHARS = 2_000;

/** Max chars of the selection text snippet we surface. Mirrors the canonical
 * `CdzSelectionCtx.text` bound (≤ 200 chars). */
export const MAX_SELECTION_TEXT_CHARS = 200;

/** Max chars of the selection descriptor we surface. Mirrors the canonical
 * `CdzSelectionCtx.descriptor` bound (≤ 500 chars). */
export const MAX_SELECTION_DESCRIPTOR_CHARS = 500;

// ---------------------------------------------------------------------------
// Types — mirror the canonical request shapes (CdzTurn / CdzSelectionCtx) so
// callers can pass request fields straight through. Kept local (no import from
// the controller) to keep this module self-contained.
// ---------------------------------------------------------------------------

/** A single prior conversation turn, oldest→newest when in an array. */
export interface AppHistoryTurn {
  role: 'user' | 'assistant';
  text: string;
}

/** Context about the element the user inspected/selected in the live preview. */
export interface AppSelectionContext {
  /** e.g. "button" */
  tag: string;
  /** trimmed direct text of the element */
  text: string;
  /** optional richer locator (tag + key attrs + text snippet) */
  descriptor?: string;
}

// ---------------------------------------------------------------------------
// APP_BUILDER_GUIDELINES — the system prompt prepended to every request.
// ---------------------------------------------------------------------------

/**
 * The adapted-Lovable guidelines for the single-file vanilla-HTML app editor.
 *
 * KEEPS: edit-in-context spirit, design-system discipline (tokens in :root),
 * beautiful/modern/responsive/accessible, semantic HTML + SEO basics, minimal
 * scope, in-app feedback, RTL-on-Arabic, and the ClickDz Data API + dashboards
 * sections (verbatim from the controller's original constant).
 *
 * DROPS: React / Vite / Tailwind / shadcn / TypeScript project / Supabase /
 * multi-file / VITE_* env / imports / build tools.
 */
export const APP_BUILDER_GUIDELINES = [
  'You are ClickDz Apps, an elite front-end engineer. Build ONE complete,',
  'production-quality single-file web app for the request below.',
  '',
  'OUTPUT (strict):',
  '- Output ONLY the code, inside a single ```html code block. No commentary,',
  '  no prose before or after, no explanations.',
  '- The block MUST start with <!doctype html> and be a complete document',
  '  (<html> … </html>) — never a diff, fragment, or partial snippet.',
  '- One self-contained index.html: all CSS in a single inline <style> and all',
  '  JS in inline <script> tags, vanilla JavaScript only.',
  '',
  'RUNTIME (this is NOT a bundler project — respect the sandbox):',
  '- No build step and no framework: no React/Vue/Svelte, no JSX, no Tailwind,',
  '  no shadcn, no TypeScript, no imports, no npm packages, no VITE_* env.',
  '- The app runs in a sandboxed iframe. No external network calls or CDNs,',
  '  with two exceptions: Google Fonts via <link> is allowed, and the ClickDz',
  '  Data API described below. Do NOT reference Supabase or any other backend.',
  '- Everything must work from this single file with no external assets.',
  '',
  'DESIGN SYSTEM (be disciplined, not ad-hoc):',
  '- Define a small design system as CSS custom properties in :root (color',
  '  palette, surfaces, text, accent, spacing scale, radius, shadow, font',
  '  stack) and REUSE those tokens everywhere. No one-off hardcoded colors',
  '  scattered through the CSS.',
  '- Beautiful and modern: thoughtful typography, generous spacing, a coherent',
  '  palette that also works on dark screens, subtle motion and hover states.',
  '- Responsive mobile-first; looks intentional at every width.',
  '',
  'QUALITY BAR:',
  '- Fully functional interactivity on first load; design empty, loading and',
  '  error states rather than leaving blanks.',
  '- Give in-app feedback: toasts / inline messages on save, delete and',
  '  failure; confirm destructive actions.',
  '- Accessible: semantic HTML, real labels for inputs, keyboard focus states,',
  '  sufficient contrast, alt text on meaningful images.',
  '- SEO basics: a descriptive <title>, a <meta name="description">, exactly',
  '  one <h1>, and a lang attribute on <html>.',
  '',
  'SCOPE:',
  '- Build exactly what is asked — do not invent unrequested features, pages,',
  '  or settings. Prefer one focused, polished screen over a sprawling app.',
  '- If the request is in Arabic, build the interface right-to-left: set',
  '  dir="rtl" and lang="ar" on <html> and mirror the layout accordingly.',
  '',
  'DATA — the ClickDz Data API (shared, persistent, multi-user storage):',
  '- When the app benefits from data that survives reloads and is shared',
  '  between users/devices (dashboards, trackers, forms, leaderboards,',
  '  mini-CRMs, bookings), use the platform Data API with plain fetch. The',
  '  platform injects the endpoint AND a write token — no user keys needed:',
  "  const DATA  = '__CLICKDZ_DATA_URL__';   // injected by the platform",
  "  const TOKEN = '__CLICKDZ_DATA_TOKEN__'; // injected write token",
  '  const WRITE = { "Content-Type": "application/json",',
  '                  "Authorization": `Bearer ${TOKEN}` };',
  '  save:   await (await fetch(`${DATA}/items`, { method: "POST",',
  '            headers: WRITE, body: JSON.stringify(record) })).json()',
  '  load:   await (await fetch(`${DATA}/items`)).json() // newest first, no auth',
  '  remove: await fetch(`${DATA}/items/${id}`, { method: "DELETE",',
  '            headers: { "Authorization": `Bearer ${TOKEN}` } })',
  '- IMPORTANT: writes (POST) and deletes (DELETE) MUST send the',
  '  Authorization: Bearer ${TOKEN} header shown above, or they return 401.',
  '  Reads (GET) need no auth. Always keep the injected TOKEN placeholder.',
  '- Collections are free-form lowercase names (items, sales, entries…).',
  '  Every saved record gains auto id + createdAt. Limits: 8KB per record,',
  '  500 records per collection. Handle fetch errors gracefully.',
  '- Use localStorage only for device-local preferences (theme, filters).',
  '',
  'DASHBOARDS:',
  '- Structure: a KPI stat-card row on top, then charts and a data table.',
  '- Draw charts with inline SVG or <canvas> (bars, lines, donuts) — no chart',
  '  libraries; animate values counting up on load.',
  '- Feed everything from Data API collections; provide an obvious way to add',
  '  records and a "Seed demo data" button when the collection is empty.',
].join('\n');

// ---------------------------------------------------------------------------
// Content builders
// ---------------------------------------------------------------------------

/**
 * Build the message content for a NEW app request.
 *
 * Mirrors the controller's original non-edit branch:
 *   `${APP_BUILDER_GUIDELINES}\n\nRequest: ${prompt}`
 */
export function buildNewAppContent(prompt: string): string {
  return `${APP_BUILDER_GUIDELINES}\n\nRequest: ${String(prompt ?? '')}`;
}

/**
 * Clamp + trim a string safely. Returns '' for non-string input.
 */
function clampText(value: unknown, max: number): string {
  const s = typeof value === 'string' ? value : value == null ? '' : String(value);
  const trimmed = s.trim();
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

/**
 * Render recent history turns into a compact transcript block, oldest→newest.
 * Keeps only the last MAX_HISTORY_TURNS and clamps each turn's text. Returns
 * '' when there is nothing useful to render (so the caller can omit the block).
 */
function renderHistory(history: AppHistoryTurn[] | undefined): string {
  if (!Array.isArray(history) || history.length === 0) return '';
  const recent = history.slice(-MAX_HISTORY_TURNS);
  const lines: string[] = [];
  for (const turn of recent) {
    if (!turn || typeof turn !== 'object') continue;
    const text = clampText(turn.text, MAX_HISTORY_TURN_CHARS);
    if (!text) continue;
    const label = turn.role === 'assistant' ? 'Assistant' : 'User';
    lines.push(`${label}: ${text}`);
  }
  return lines.join('\n');
}

/**
 * Render the optional "focus on this selected element" block. Returns '' when
 * there is no usable selection, so the caller can omit the block entirely.
 */
function renderSelection(selection: AppSelectionContext | null | undefined): string {
  if (!selection || typeof selection !== 'object') return '';
  const tag = clampText(selection.tag, 64);
  const text = clampText(selection.text, MAX_SELECTION_TEXT_CHARS);
  const descriptor = clampText(selection.descriptor, MAX_SELECTION_DESCRIPTOR_CHARS);
  // Prefer the richer descriptor when present; fall back to tag + text.
  let locator = descriptor;
  if (!locator) {
    if (tag && text) locator = `<${tag}> "${text}"`;
    else if (tag) locator = `<${tag}>`;
    else if (text) locator = `"${text}"`;
  }
  if (!locator) return '';
  return `Focus your change on this selected element: ${locator}`;
}

/**
 * Build the message content for an EDIT (edit-in-context) request.
 *
 * Composition (mirrors + extends the controller's original edit branch in
 * `buildAppHtml`, adding the history + selection blocks from the canonical
 * request contract):
 *   1. APP_BUILDER_GUIDELINES
 *   2. an edit-in-context instruction (return the COMPLETE updated index.html,
 *      preserve what works, change only what is asked)
 *   3. a compact rendering of recent history turns (optional)
 *   4. a "focus on this selected element" block from `selection` (optional)
 *   5. the current app fenced in ```html (sliced to MAX_EDIT_HTML_CHARS)
 *   6. the change request
 */
export function buildEditContent(args: {
  prompt: string;
  currentHtml: string;
  history?: AppHistoryTurn[];
  selection?: AppSelectionContext | null;
}): string {
  const prompt = String(args?.prompt ?? '');
  const currentHtml = typeof args?.currentHtml === 'string' ? args.currentHtml : '';

  const parts: string[] = [
    APP_BUILDER_GUIDELINES,
    '',
    'You are EDITING an existing app. Apply the requested change and',
    'return the COMPLETE updated index.html (never a diff or fragment).',
    'Preserve everything that already works; change only what the request asks.',
  ];

  const historyBlock = renderHistory(args?.history);
  if (historyBlock) {
    parts.push('', 'Recent conversation (oldest first, for context):', historyBlock);
  }

  const selectionBlock = renderSelection(args?.selection);
  if (selectionBlock) {
    parts.push('', selectionBlock);
  }

  parts.push(
    '',
    'Current app:',
    '```html',
    currentHtml.slice(0, MAX_EDIT_HTML_CHARS),
    '```',
    '',
    `Change request: ${prompt}`
  );

  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// R2-g (WSB-1) — SHOP-AWARE EDIT PROMPT.
//
// The generic APP_BUILDER_GUIDELINES above teach the model how to build/edit
// ANY single-file app. A published ClickDz storefront is a special kind of app:
// its HTML carries a fixed CONTRACT the storefront + admin runtime depends on
// (the ClickDz Data API wiring, the COD order pipeline, the settings singleton,
// the feature/section gating). A free-form AI edit that silently rewrites any
// of that produces a DEAD shop (orders stop persisting, the admin can't read
// them, the token 401s). `clickdz-shop-contract.ts` lints for exactly these
// invariants after an edit; this prompt is the FRONT-LINE defense that teaches
// the model to preserve them verbatim in the first place so the lint passes.
//
// Design: this is ADDITIVE and disjoint from APP_BUILDER_GUIDELINES — the
// generic builder studio keeps using the generic prompt byte-for-byte; only the
// shop "Modifier avec l'IA" flow calls `buildShopEditContent`. It composes the
// SAME edit-in-context scaffold `buildEditContent` uses (guidelines + history +
// selection + fenced current HTML + change request) and INSERTS the shop
// contract block between the edit instruction and the transcript. The optional
// `violations` list feeds the bridge's single auto-retry: when the first output
// fails `lintShopContract`, the bridge re-invokes with the concrete violation
// messages appended so the model repairs exactly what it dropped.
// ---------------------------------------------------------------------------

/**
 * The SHOP CONTRACT — the invariants the storefront/admin runtime depends on,
 * phrased as hard "preserve verbatim" rules the model must obey when editing a
 * live ClickDz storefront. Kept as a `\n`-joined string (same style as
 * APP_BUILDER_GUIDELINES) so it drops straight into the edit content.
 *
 * These mirror, one-to-one, the checks `lintShopContract` enforces mechanically
 * on the returned HTML — so following the prompt makes the lint pass and the
 * shop keeps working. It is intentionally concrete about the exact call shapes
 * as they appear in the minted storefront (the `api` data client, the
 * `api.create('orders', …)` submit, `api.list('settings')`, the STATUSES array,
 * `featureOn`/`sectionOn`) so the model preserves the real code, not a lookalike.
 */
export const SHOP_CONTRACT_RULES = [
  'SHOP CONTRACT — YOU ARE EDITING A LIVE ClickDz STOREFRONT (READ CAREFULLY):',
  'This HTML is a published, working Algerian storefront + PIN-gated admin. It',
  'is NOT a blank canvas. Real buyers place cash-on-delivery orders through it',
  'and the merchant manages those orders in the admin. You are making a SURGICAL',
  'edit: change ONLY the layout, copy, styling, colours, or sections the user',
  'asks for, and PRESERVE EVERYTHING ELSE EXACTLY AS-IS. Return the FULL updated',
  'index.html (a complete document, never a diff, fragment, or partial snippet).',
  '',
  'YOU MUST PRESERVE VERBATIM (removing or rewriting ANY of these breaks the shop',
  'and your edit will be REJECTED):',
  '1. THE DATA API WIRING. Keep the injected constants and their values exactly:',
  "     var DATA_URL = '…/api/v2/apps-data/<slug>';  // already substituted",
  "     var DATA_TOKEN = '…';                        // the injected write token",
  '   Never delete, rename, blank, or hardcode-over these. Every data call must',
  '   still hit the same /api/v2/apps-data/ endpoint. Do NOT point fetches at',
  '   any other origin, and do NOT introduce Supabase/Firebase/any other backend.',
  '2. THE BEARER WRITE AUTH. All writes (POST) and deletes (DELETE) MUST keep',
  '     the Authorization: Bearer <DATA_TOKEN> header (in the storefront this is',
  "     h['Authorization'] = 'Bearer ' + DATA_TOKEN; inside the api client).",
  '   Reads (GET) need no auth. Dropping the Bearer header makes writes 401 and',
  '   silently loses every order. Keep the api data-client object intact.',
  '3. THE ORDER PIPELINE. Keep the checkout POST that saves an order to the',
  "     orders collection (api.create('orders', order)), and keep the five",
  '   status literals EXACTLY, with their French accents, in the STATUSES list:',
  '     Nouvelle, Confirmée, Expédiée, Livrée, Retournée',
  '   The admin renders and advances orders through these; renaming/translating',
  '   any one of them breaks status filtering and the fulfilment flow.',
  '4. THE SETTINGS SINGLETON. Keep the settings read on load',
  "     (api.list('settings')) and the single settings record the shop reads",
  '   its name / WhatsApp number / delivery fee / accent / theme / PIN from. The',
  '   admin edits this one row; do not split it, remove it, or change its key.',
  '5. THE FEATURE / SECTION GATING. Keep the featureOn(id) and sectionOn(id)',
  '   helpers and every featureOn(...) / sectionOn(...) guard already in the',
  '   markup. They read the settings singleton so the owner can toggle add-ons',
  '   and home bands at runtime; removing a guard force-enables or deletes a',
  '   feature the merchant controls. Do not hardcode their result.',
  '6. THE PIN ADMIN GATE and the wa.me WhatsApp checkout hand-off: leave the',
  '   admin PIN lock and the WhatsApp order link working as they are unless the',
  '   user explicitly asks to change them.',
  '',
  'OUTPUT SAFETY (the storefront ships as a String.raw template — respect it):',
  '- Do NOT introduce JavaScript template literals: no backtick strings and no',
  '  dollar-brace interpolation ANYWHERE in the returned HTML/JS. The existing',
  '  code uses string concatenation with + and single/double quotes on purpose',
  '  — keep that style for any JS you add or change. (CSS and plain text are',
  '  unaffected; this rule is about not adding backticks or dollar-brace pairs.)',
  '- Keep it a single self-contained index.html: all CSS inline in <style>, all',
  '  JS inline in <script>, vanilla JavaScript only, no imports, no CDNs beyond',
  '  the Google Fonts <link> the guidelines already allow.',
  '',
  'If a requested change would require touching any contract item above, keep the',
  'contract intact and adapt around it (e.g. restyle the order form without',
  'changing what it POSTs). When in doubt, preserve.',
].join('\n');

/**
 * Render the optional "your previous attempt violated the contract" block used
 * by the bridge's single auto-retry. Given the `violations` array returned by
 * `lintShopContract`, produces a terse, imperative correction block instructing
 * the model to regenerate while restoring exactly what it dropped. Returns ''
 * when there is nothing to report (so the first attempt omits the block).
 */
function renderContractViolations(violations: string[] | undefined): string {
  if (!Array.isArray(violations) || violations.length === 0) return '';
  const lines: string[] = [
    'YOUR PREVIOUS OUTPUT BROKE THE SHOP CONTRACT and was rejected. It dropped or',
    'altered the following required elements. Regenerate the COMPLETE index.html,',
    'applying the same change request, but RESTORE every item below verbatim:',
  ];
  for (const v of violations) {
    const text = clampText(v, 300);
    if (text) lines.push(`- ${text}`);
  }
  return lines.join('\n');
}

/**
 * Build the message content for a SHOP EDIT (edit-in-context) request against a
 * LIVE published storefront.
 *
 * Composition (mirrors `buildEditContent`, plus the shop contract + optional
 * retry-violations block):
 *   1. APP_BUILDER_GUIDELINES  (the generic single-file-app discipline)
 *   2. an edit-in-context instruction (return the COMPLETE updated index.html)
 *   3. SHOP_CONTRACT_RULES     (the preserve-verbatim storefront contract)
 *   4. (optional) a "your last output broke the contract — restore X" block,
 *      driven by `violations` from `lintShopContract` (the single auto-retry)
 *   5. a compact rendering of recent history turns (optional)
 *   6. a "focus on this selected element" block from `selection` (optional)
 *   7. the current storefront fenced in ```html (sliced to MAX_EDIT_HTML_CHARS)
 *   8. the change request
 *
 * The output contract is unchanged from the generic path: the model returns ONE
 * complete `index.html` in a single ```html fence, so the controller's
 * `extractHtmlApp` parses it identically. This function has NO runtime deps and
 * imports nothing — the bridge forwards the returned string to the same code
 * agent it uses for `buildEditContent`.
 */
export function buildShopEditContent(args: {
  prompt: string;
  currentHtml: string;
  history?: AppHistoryTurn[];
  selection?: AppSelectionContext | null;
  /** Violations from a prior `lintShopContract` run — drives the auto-retry. */
  violations?: string[];
}): string {
  const prompt = String(args?.prompt ?? '');
  const currentHtml =
    typeof args?.currentHtml === 'string' ? args.currentHtml : '';

  const parts: string[] = [
    APP_BUILDER_GUIDELINES,
    '',
    'You are EDITING an existing, LIVE ClickDz storefront. Apply the requested',
    'change and return the COMPLETE updated index.html (never a diff or fragment).',
    'Preserve everything that already works; change only what the request asks.',
    '',
    SHOP_CONTRACT_RULES,
  ];

  const violationsBlock = renderContractViolations(args?.violations);
  if (violationsBlock) {
    parts.push('', violationsBlock);
  }

  const historyBlock = renderHistory(args?.history);
  if (historyBlock) {
    parts.push('', 'Recent conversation (oldest first, for context):', historyBlock);
  }

  const selectionBlock = renderSelection(args?.selection);
  if (selectionBlock) {
    parts.push('', selectionBlock);
  }

  parts.push(
    '',
    'Current storefront:',
    '```html',
    currentHtml.slice(0, MAX_EDIT_HTML_CHARS),
    '```',
    '',
    `Change request: ${prompt}`
  );

  return parts.join('\n');
}
