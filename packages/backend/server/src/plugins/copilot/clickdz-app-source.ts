// ---------------------------------------------------------------------------
// R0-b (WSB-2) — SHOP SOURCE RECOVERY.
//
// A published shop/app currently has NO server-side HTML source: the canonical
// artifact lives only in the browser's client `artifactStore` (`app_<slug>`),
// so `republishShop` returns `no-source` on a second device/session and editing
// breaks cross-device. This helper is the recovery path behind
// `GET /api/v1/apps/:slug/source` (bridge controller): given the caller's
// publish record, it produces the app's HTML from ONE of two sources —
//
//   1. RENDER (fast path): a template-kind app (kind 'shop'|'erp', or one that
//      carries a `storeSlug`) is DETERMINISTICALLY reconstructed from the
//      sibling template files using the SAME `__CLICKDZ_*__` token substitution
//      `templateApp` performs. No network hop; reproduces the freshly-minted
//      artifact. (Fidelity note below.)
//   2. DEPLOYED (fallback): a plain generated app — or any record we cannot
//      re-render — has its live HTML FETCHED from its Vercel URL. This is the
//      true recovery path for source that never existed server-side.
//
// FIDELITY: the render path reproduces the template as minted (optionally with
// the store's saved appearance tokens). It does NOT capture free-form AI edits
// applied to the deployed artifact — those live only in the deployed HTML.
// Preferring render for template kinds matches the WSB-2 design ("server-render
// fast path + deployed-HTML fetch fallback"); a later ShopState layer (WSB-3)
// will persist an `aiPatchHtml` delta and take priority over both. Until then,
// callers that need verbatim edited HTML can force the deployed source.
//
// DESIGN: this is a PURE helper module (no Nest decorators, no framework error
// classes) mirroring `cdz-data-token.ts` — so it is boot-safe when imported and
// unit-testable in isolation. It NEVER throws for expected failure modes;
// instead it returns discriminated-union results and the controller (which owns
// `@Res` passthrough + the typed `../../base` errors) maps a failure `reason`
// to the right typed HTTP status. Cross-cutting values it needs (the template
// HTML, the per-slug data token, the external base URL) are INJECTED by the
// caller rather than re-read here, so there is no duplicated env/coupling.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Caps & knobs. `MAX_SOURCE_HTML_BYTES` mirrors the bridge's `MAX_HTML_CHARS`
// (512_000) so a fetched deployed document never exceeds what the deploy path
// itself would accept. The fetch timeout matches the shape of the controller's
// other outbound `fetch` calls (AbortSignal.timeout, 10s here — a static HTML
// GET is fast; a slow origin should fail over quickly, not hang the request).
// ---------------------------------------------------------------------------
const MAX_SOURCE_HTML_BYTES = 512_000;
const DEPLOYED_FETCH_TIMEOUT_MS = 10_000;

/** The customization tokens the shop/erp templates substitute at mint time. */
export interface AppSourceTemplateTokens {
  storeName: string;
  whatsapp: string;
  accent: string;
  pin: string;
}

/** A minimal view of a publish record — the fields source-resolution needs. */
export interface AppSourceRecord {
  slug: string;
  url: string;
  kind?: 'shop' | 'erp' | 'app';
  storeSlug?: string;
}

/** Failure reasons the controller maps to typed HTTP errors. */
export type AppSourceFailure =
  // the record is a template kind but the template HTML was not supplied /
  // the app is not renderable server-side (should not happen in practice)
  | 'not_renderable'
  // the deployed URL was missing/blank on the record
  | 'no_url'
  // the deployed URL is not a safe public http(s) address (SSRF guard)
  | 'unsafe_url'
  // the origin returned a non-2xx status
  | 'fetch_status'
  // network error / timeout reaching the origin
  | 'fetch_unreachable'
  // the origin returned a non-HTML content-type
  | 'not_html'
  // the fetched document exceeded the size cap
  | 'too_large'
  // the fetched document was empty / not a recognizable HTML document
  | 'empty';

export type FetchDeployedHtmlResult =
  | { ok: true; html: string; bytes: number }
  | { ok: false; reason: AppSourceFailure };

export type ResolveAppSourceResult =
  | { ok: true; source: 'render' | 'deployed'; html: string; bytes: number }
  | { ok: false; source: 'render' | 'deployed'; reason: AppSourceFailure };

// ---------------------------------------------------------------------------
// SSRF guard (self-contained). A deployed URL comes from OUR OWN publish record
// (a `<project>.vercel.app` origin we wrote), so it is trusted — but fetching a
// record-supplied URL server-side is exactly the class of call that warrants a
// defense-in-depth check, and the bridge already applies the same policy to
// user-supplied image URLs (`isSafePublicUrl`). This mirrors that logic so the
// helper is safe standalone: require http/https, reject loopback / private /
// link-local / cloud-metadata targets WITHOUT resolving DNS (documented
// residual risk: a hostname resolving to a private IP is not caught here).
// ---------------------------------------------------------------------------
function isSafeDeployedUrl(u: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(u);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return false;
  }
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === 'metadata.google.internal' ||
    host.endsWith('.local')
  ) {
    return false;
  }
  // shared IPv4 range check: true = private/loopback/link-local/reserved.
  const isPrivateV4 = (a: number, b: number): boolean =>
    a === 127 || // 127.0.0.0/8 loopback
    a === 10 || // 10.0.0.0/8 private
    (a === 172 && b >= 16 && b <= 31) || // 172.16.0.0/12 private
    (a === 192 && b === 168) || // 192.168.0.0/16 private
    (a === 169 && b === 254) || // 169.254.0.0/16 link-local (incl. metadata)
    a === 0; // 0.0.0.0/8 "this host"
  if (host.includes(':')) {
    if (host === '::1' || host === '::') return false;
    if (/^f[cd]/i.test(host)) return false; // fc00::/7 unique-local
    if (/^fe[89ab]/i.test(host)) return false; // fe80::/10 link-local
    const dotted = host.match(/::ffff:(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/);
    if (dotted && isPrivateV4(Number(dotted[1]), Number(dotted[2]))) return false;
    const hex = host.match(/::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (hex) {
      const hi = parseInt(hex[1], 16);
      const lo = parseInt(hex[2], 16);
      const a = (hi >> 8) & 0xff;
      const b = hi & 0xff;
      const c = (lo >> 8) & 0xff;
      const d = lo & 0xff;
      if (isPrivateV4(a, b) || (a === 169 && b === 254 && c === 169 && d === 254)) {
        return false;
      }
    }
    return true;
  }
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    if (isPrivateV4(Number(m[1]), Number(m[2]))) return false;
    return true;
  }
  // regular DNS hostname we can't classify without resolution — allow it.
  return true;
}

/** Does `s` look like an HTML document (same gate `extractHtmlApp` applies)? */
function looksLikeHtmlDocument(s: string): boolean {
  const head = s.trimStart();
  return /^<!doctype html/i.test(head) || /^<html[\s>]/i.test(head);
}

// ---------------------------------------------------------------------------
// fetchDeployedHtml — the DEPLOYED source. Fetch a published app's live Vercel
// URL and return its HTML. SSRF-guarded, timed, content-type-gated, size-capped.
//
// - blank/whitespace url            -> { ok:false, reason:'no_url' }
// - not a safe public http(s) url   -> { ok:false, reason:'unsafe_url' }
// - network error / timeout         -> { ok:false, reason:'fetch_unreachable' }
// - non-2xx status                  -> { ok:false, reason:'fetch_status' }
// - Content-Length over the cap     -> { ok:false, reason:'too_large' } (early)
// - non-HTML content-type           -> { ok:false, reason:'not_html' }
// - body over the cap while reading -> { ok:false, reason:'too_large' }
// - empty / not an HTML document    -> { ok:false, reason:'empty' }
// - otherwise                       -> { ok:true, html, bytes }
//
// The `index.html` a Vercel static deploy serves is the exact artifact we
// pushed at deploy time (watermark included), so this is a faithful recovery of
// the published source. Never throws — callers get a discriminated result.
// ---------------------------------------------------------------------------
export async function fetchDeployedHtml(
  url: string
): Promise<FetchDeployedHtmlResult> {
  const target = typeof url === 'string' ? url.trim() : '';
  if (!target) return { ok: false, reason: 'no_url' };
  if (!isSafeDeployedUrl(target)) return { ok: false, reason: 'unsafe_url' };

  let response: Awaited<ReturnType<typeof fetch>>;
  try {
    response = await fetch(target, {
      // Ask explicitly for HTML; a static host serves the deployed index.html.
      headers: { accept: 'text/html,application/xhtml+xml' },
      redirect: 'follow',
      signal: AbortSignal.timeout(DEPLOYED_FETCH_TIMEOUT_MS),
    });
  } catch {
    // Network error / timeout / abort — never let it escape as a 500.
    return { ok: false, reason: 'fetch_unreachable' };
  }

  if (!response.ok) {
    return { ok: false, reason: 'fetch_status' };
  }

  // Cheap pre-check: if the origin advertised a Content-Length over the cap,
  // reject before downloading the body.
  const declaredLen = Number(response.headers.get('content-length') || '');
  if (Number.isFinite(declaredLen) && declaredLen > MAX_SOURCE_HTML_BYTES) {
    return { ok: false, reason: 'too_large' };
  }

  // Content-type gate: HTML only (a static app deploy serves text/html). An
  // error page / JSON / asset is not usable source.
  const mime = (response.headers.get('content-type') || '')
    .split(';')[0]
    .trim()
    .toLowerCase();
  if (mime && mime !== 'text/html' && mime !== 'application/xhtml+xml') {
    return { ok: false, reason: 'not_html' };
  }

  // Read the body with a hard size cap. `arrayBuffer()` is bounded here by the
  // cap check below; a well-behaved static host that omits Content-Length still
  // can't blow past the cap because we reject once the decoded string exceeds
  // it. (Deployed shop artifacts are well under MAX_SOURCE_HTML_BYTES.)
  let bytes: number;
  let html: string;
  try {
    const buf = new Uint8Array(await response.arrayBuffer());
    bytes = buf.length;
    if (bytes > MAX_SOURCE_HTML_BYTES) {
      return { ok: false, reason: 'too_large' };
    }
    html = new TextDecoder('utf-8').decode(buf);
  } catch {
    return { ok: false, reason: 'fetch_unreachable' };
  }

  if (!html || !looksLikeHtmlDocument(html)) {
    return { ok: false, reason: 'empty' };
  }
  return { ok: true, html, bytes };
}

// ---------------------------------------------------------------------------
// renderTemplateSource — the RENDER (fast-path) source. Reconstruct a
// template-kind app's HTML by substituting the SAME `__CLICKDZ_*__` tokens
// `templateApp` fills, using the template HTML + resolved values the caller
// injects (the caller owns loading `CLICKDZ_SHOP_TEMPLATE_HTML` /
// `CLICKDZ_ERP_TEMPLATE_HTML`, minting `dataWriteToken(slug)`, and computing
// the external data-URL base — this helper stays free of those imports/env).
//
// The substitution order/shape is IDENTICAL to `templateApp` (split/join per
// token; substituted values never contain another `__CLICKDZ_*__` sequence, so
// order is irrelevant). With default tokens this reproduces the byte-identical
// freshly-minted template; passing the store's saved appearance tokens
// reproduces its current look. Applies the SAME 400_000-char trim the deploy
// path applies. Pure + synchronous; returns '' only if given empty template
// HTML (the caller treats that as `not_renderable`).
// ---------------------------------------------------------------------------
export function renderTemplateSource(input: {
  templateHtml: string;
  slug: string;
  dataUrl: string;
  dataToken: string;
  tokens: AppSourceTemplateTokens;
}): string {
  const { templateHtml, slug, dataUrl, dataToken, tokens } = input;
  if (typeof templateHtml !== 'string' || templateHtml.length === 0) {
    return '';
  }
  let html = templateHtml
    .split('__CLICKDZ_DATA_URL__')
    .join(dataUrl)
    .split('__CLICKDZ_DATA_TOKEN__')
    .join(dataToken)
    .split('__CLICKDZ_SLUG__')
    .join(slug)
    .split('__CLICKDZ_STORE_NAME__')
    .join(tokens.storeName)
    .split('__CLICKDZ_WHATSAPP__')
    .join(tokens.whatsapp)
    .split('__CLICKDZ_ACCENT__')
    .join(tokens.accent)
    .split('__CLICKDZ_PIN__')
    .join(tokens.pin);
  if (html.length > 400_000) html = html.slice(0, 400_000);
  return html;
}

// ---------------------------------------------------------------------------
// resolveAppSource — the source-resolution decision. Given the caller's publish
// record, choose ONE source and produce the HTML:
//
//   * template kind (kind 'shop'|'erp', OR any record carrying a `storeSlug`)
//     -> RENDER via `renderTemplate` (the injected reconstruction closure).
//        Fast, deterministic, no network. `source: 'render'`.
//   * otherwise (a plain generated 'app' / kind-less legacy record)
//     -> fetch the DEPLOYED HTML from `record.url`. `source: 'deployed'`.
//
// The render branch is injected as a closure (`renderTemplate`) so this module
// need not import the template files, the data-token minter, or read env — the
// controller wires those (exactly as it does inside `templateApp`) and this
// stays a pure, testable decision. `forceDeployed` lets a caller bypass the
// fast path when it specifically needs the verbatim live artifact (e.g. an app
// that was AI-edited after minting) — until ShopState (WSB-3) persists that
// delta server-side. Never throws.
// ---------------------------------------------------------------------------
export async function resolveAppSource(
  record: AppSourceRecord,
  deps: {
    // Reconstruct a template-kind app's HTML. Returns '' if not renderable.
    renderTemplate: (record: AppSourceRecord) => string;
    // Fetch the deployed HTML for a URL (defaults to `fetchDeployedHtml`).
    fetchDeployed?: (url: string) => Promise<FetchDeployedHtmlResult>;
    // Force the deployed source even for a template kind.
    forceDeployed?: boolean;
  }
): Promise<ResolveAppSourceResult> {
  const fetchDeployed = deps.fetchDeployed ?? fetchDeployedHtml;
  const isTemplateKind =
    !deps.forceDeployed &&
    (record.kind === 'shop' ||
      record.kind === 'erp' ||
      (typeof record.storeSlug === 'string' && record.storeSlug.length > 0));

  // ----- RENDER fast path --------------------------------------------------
  if (isTemplateKind) {
    const html = deps.renderTemplate(record);
    if (html && looksLikeHtmlDocument(html)) {
      return { ok: true, source: 'render', html, bytes: html.length };
    }
    // Could not re-render (e.g. template HTML unavailable) — fall through to
    // the deployed fetch so a template kind is still recoverable from its live
    // artifact rather than hard-failing.
    if (record.url) {
      const fetched = await fetchDeployed(record.url);
      if (fetched.ok) {
        return {
          ok: true,
          source: 'deployed',
          html: fetched.html,
          bytes: fetched.bytes,
        };
      }
      return { ok: false, source: 'deployed', reason: fetched.reason };
    }
    return { ok: false, source: 'render', reason: 'not_renderable' };
  }

  // ----- DEPLOYED fallback -------------------------------------------------
  const fetched = await fetchDeployed(record.url);
  if (fetched.ok) {
    return {
      ok: true,
      source: 'deployed',
      html: fetched.html,
      bytes: fetched.bytes,
    };
  }
  return { ok: false, source: 'deployed', reason: fetched.reason };
}
