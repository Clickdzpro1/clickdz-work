// ---------------------------------------------------------------------------
// R2-g (WSB-1) — SHOP CONTRACT LINT.
//
// A published ClickDz storefront (see `clickdz-shop-template.ts`) carries a
// fixed runtime CONTRACT: the ClickDz Data API wiring, the Bearer write-auth,
// the cash-on-delivery order pipeline, the settings singleton, and the
// feature/section gating. The "Modifier avec l'IA" flow lets the model rewrite
// that HTML freely — so a careless edit can silently drop the write token,
// rename an order status, or delete the settings read, producing a DEAD shop
// (orders stop persisting, the admin can't read them, writes 401). The
// shop-aware prompt (`SHOP_CONTRACT_RULES` in `clickdz-app-prompt.ts`) teaches
// the model to preserve those invariants; THIS module is the mechanical belt-
// and-braces check that runs on the returned HTML before it is ever deployed.
//
// `lintShopContract(html)` runs on a POST-MINT / post-edit artifact (tokens
// ALREADY substituted — so it also asserts no `__CLICKDZ_*__` token leaked
// through unresolved). It returns a discriminated `{ ok, violations }`. The
// bridge's ai-edit route uses it to gate the response: on violations it retries
// ONCE with the violation messages appended to the prompt, and a second failure
// is surfaced to the user as a typed 422 (never deployed).
//
// DESIGN: a PURE module with ZERO imports (mirrors `cdz-data-token.ts` /
// `clickdz-app-source.ts`) so it is boot-safe when imported into the controller
// and unit-testable in isolation. It NEVER throws — non-string / empty input
// yields a populated `violations` list, not an exception. The checks are
// tolerant of quote style and incidental whitespace (the model may reformat)
// but strict about the load-bearing substrings the runtime actually depends on.
// ---------------------------------------------------------------------------

/** The five order-pipeline status literals, WITH their French accents. The
 * admin renders + advances orders through these; a missing/renamed one breaks
 * status filtering and fulfilment. (Mirrors STATUSES in the shop template.) */
export const SHOP_ORDER_STATUSES = [
  'Nouvelle',
  'Confirmée',
  'Expédiée',
  'Livrée',
  'Retournée',
] as const;

/** Stable machine codes for each violation, so callers can branch/telemetry on
 * them without string-matching the human message. Emitted as a prefix inside
 * each violation string (e.g. "data_url_missing: ..."). */
export type ShopContractViolationCode =
  | 'not_a_string'
  | 'empty'
  | 'not_html_document'
  | 'leftover_token'
  | 'data_url_missing'
  | 'bearer_auth_missing'
  | 'order_post_missing'
  | 'order_status_missing'
  | 'settings_singleton_missing'
  | 'feature_gating_missing'
  | 'section_gating_missing';

/** The result of a contract lint. `violations` is empty iff `ok` is true. Each
 * entry is a human-readable message prefixed with its `ShopContractViolationCode`
 * (e.g. "bearer_auth_missing: ..."), so it reads well when surfaced to a user
 * AND is machine-greppable for the auto-retry / telemetry. */
export interface ShopContractLintResult {
  ok: boolean;
  violations: string[];
}

// ---------------------------------------------------------------------------
// Internal matchers. Kept tolerant (case-insensitive where safe, whitespace-
// and quote-agnostic) so a model reformatting the code does not trip a false
// positive — but anchored on the substrings the storefront runtime genuinely
// depends on. Regexes are constructed to be safe against catastrophic
// backtracking (no nested quantifiers over unbounded classes).
// ---------------------------------------------------------------------------

/** Unresolved mint tokens like `__CLICKDZ_DATA_TOKEN__` must NOT survive into a
 * deployed artifact — their presence means substitution was skipped/broken. */
const LEFTOVER_TOKEN_RE = /__CLICKDZ_[A-Z0-9_]+__/;

/** The token-gated Data API path. The minted storefront's `DATA_URL` is
 * `${externalBase}/api/v2/apps-data/${slug}`; every read/write goes through it.
 * We require the `/api/v2/apps-data/` path segment to survive verbatim. */
const DATA_API_PATH_RE = /\/api\/v2\/apps-data\//;

/** Defensive fallback: a bare `/apps-data/` (older /v1 wiring or a reformat that
 * dropped the version segment). Not sufficient on its own for a v2 shop, but its
 * ABSENCE alongside the v2 path is a hard signal the data wiring is gone. */
const DATA_API_LOOSE_RE = /\/apps-data\//;

/** The Bearer write-auth. The storefront sets `h['Authorization'] = 'Bearer ' +
 * DATA_TOKEN;`. We accept any `Authorization` key spelling + a `Bearer ` value
 * that concatenates/embeds the DATA_TOKEN (quote/spacing tolerant). */
const AUTH_HEADER_RE = /authorization/i;
/** `Bearer ` immediately followed by a concatenation onto, or interpolation of,
 * the write token — the shapes an edit is likely to keep. Matches:
 *   'Bearer ' + DATA_TOKEN            (the template's own shape)
 *   "Bearer " + token
 *   `Bearer ${DATA_TOKEN}`            (if the model used a literal despite guidance)
 *   Bearer  <DATA_TOKEN>              (loose)
 * We look for the literal `Bearer ` prefix AND a DATA_TOKEN reference nearby. */
const BEARER_LITERAL_RE = /Bearer\s/;
const DATA_TOKEN_REF_RE = /DATA_TOKEN/;

/** The order-submit POST to the `orders` collection. The storefront calls
 * `api.create('orders', order)` (api.create → fetch method:'POST'). We accept a
 * `create('orders'…)`/`create("orders"…)` call, tolerant of whitespace. */
const ORDER_CREATE_RE = /create\s*\(\s*['"]orders['"]/;
/** Fallback: a raw fetch that POSTs to an `orders` collection endpoint — covers
 * a model that inlined the fetch instead of using the `api` helper. Requires
 * BOTH a POST method AND the `orders` collection addressed as an ENDPOINT PATH
 * (`…/orders'` | `…/orders"` | `…/orders?…`), so an incidental word "orders" in
 * a comment, a CSS class, or `store.orders` can NOT satisfy it — only a real
 * request target does. This keeps the check strict without false-positives on a
 * reformat that still POSTs the order. */
const RAW_POST_RE = /method\s*:\s*['"]POST['"]/i;
const ORDERS_ENDPOINT_RE = /\/orders(?:['"?]|\b\s*['"])/;

/** The settings singleton read on load: `api.list('settings')`. We accept a
 * `list('settings'…)`/`list("settings"…)` call, tolerant of whitespace. */
const SETTINGS_LIST_RE = /list\s*\(\s*['"]settings['"]/;
/** Fallback: the `settings` collection addressed as a CALL ARGUMENT
 * (`('settings'…)`) or an ENDPOINT PATH (`…/settings'` | `…/settings"` |
 * `…/settings?…`) — a model may read it via a differently-named helper or a raw
 * fetch. Deliberately NOT a bare word match: `settings.template='boutique'`,
 * `defaultSettings()`, and comment prose must NOT satisfy it — only a genuine
 * read of the `settings` collection does. */
const SETTINGS_CALL_ARG_RE = /\(\s*['"]settings['"]/;
const SETTINGS_ENDPOINT_RE = /\/settings(?:['"?]|\b\s*['"])/;

/** The runtime feature gate `featureOn(id)` — must survive so the merchant can
 * toggle add-ons from settings. We require at least one `featureOn(` call. */
const FEATURE_ON_RE = /featureOn\s*\(/;
/** The home-band gate `sectionOn(id)` — must survive so the merchant can toggle
 * home sections from settings. We require at least one `sectionOn(` call. */
const SECTION_ON_RE = /sectionOn\s*\(/;

/** Does `s` look like a complete HTML document? Same gate the deploy path and
 * `extractHtmlApp` apply (starts with a doctype or an <html> tag). */
function looksLikeHtmlDocument(s: string): boolean {
  const head = s.trimStart();
  return /^<!doctype html/i.test(head) || /^<html[\s>]/i.test(head);
}

// ---------------------------------------------------------------------------
// lintShopContract — the mechanical contract check.
//
// Runs on the POST-MINT / post-edit artifact HTML. Returns every violation it
// finds (not just the first), so a single auto-retry can be told about ALL the
// dropped invariants at once. Never throws.
//
// Checks (each maps to a rule in SHOP_CONTRACT_RULES and a pinned item in the
// R2 contract):
//   • input is a non-empty string that looks like an HTML document
//   • NO leftover `__CLICKDZ_*__` mint tokens
//   • the `/api/v2/apps-data/` Data API path is present
//   • a Bearer write-auth header referencing the DATA_TOKEN is present
//   • an order-create POST to the `orders` collection is present
//   • ALL five order-status literals are present (accents included)
//   • the `settings` singleton read is present
//   • the `featureOn(` and `sectionOn(` runtime gates are present
// ---------------------------------------------------------------------------
export function lintShopContract(html: string): ShopContractLintResult {
  const violations: string[] = [];

  // ----- input sanity ------------------------------------------------------
  if (typeof html !== 'string') {
    return {
      ok: false,
      violations: [
        'not_a_string: the artifact was not a string, so no HTML contract could be verified.',
      ],
    };
  }
  if (html.trim().length === 0) {
    return {
      ok: false,
      violations: [
        'empty: the artifact was empty, so no HTML contract could be verified.',
      ],
    };
  }
  if (!looksLikeHtmlDocument(html)) {
    // Not fatal to the rest of the checks, but a strong signal the model
    // returned a fragment/diff instead of a full document.
    violations.push(
      'not_html_document: the output must be a COMPLETE index.html starting with <!doctype html> or <html …> (got a fragment or non-HTML text).'
    );
  }

  // ----- no leftover mint tokens ------------------------------------------
  const leftover = html.match(LEFTOVER_TOKEN_RE);
  if (leftover) {
    violations.push(
      `leftover_token: an unresolved mint token "${leftover[0]}" is still present — the __CLICKDZ_*__ placeholders must be substituted (never re-introduced) in a deployed storefront.`
    );
  }

  // ----- Data API wiring ---------------------------------------------------
  if (!DATA_API_PATH_RE.test(html)) {
    // Distinguish "wiring entirely gone" from "downgraded to a bare path".
    if (DATA_API_LOOSE_RE.test(html)) {
      violations.push(
        'data_url_missing: the Data API URL must keep the "/api/v2/apps-data/" path — a bare "/apps-data/" (missing the v2 segment) will not reach the token-gated Data API.'
      );
    } else {
      violations.push(
        'data_url_missing: the ClickDz Data API wiring is gone — the storefront must still call "/api/v2/apps-data/…" for every read/write (keep the DATA_URL constant and the `api` client).'
      );
    }
  }

  // ----- Bearer write-auth -------------------------------------------------
  const hasAuthKey = AUTH_HEADER_RE.test(html);
  const hasBearer = BEARER_LITERAL_RE.test(html);
  const hasTokenRef = DATA_TOKEN_REF_RE.test(html);
  if (!hasAuthKey || !hasBearer || !hasTokenRef) {
    violations.push(
      'bearer_auth_missing: writes/deletes must send the "Authorization: Bearer " header built from DATA_TOKEN (e.g. h[\'Authorization\'] = \'Bearer \' + DATA_TOKEN) — without it every order write returns 401 and is silently lost.'
    );
  }

  // ----- order-create POST to `orders` ------------------------------------
  const hasApiCreateOrders = ORDER_CREATE_RE.test(html);
  const hasRawOrderPost =
    RAW_POST_RE.test(html) && ORDERS_ENDPOINT_RE.test(html);
  if (!hasApiCreateOrders && !hasRawOrderPost) {
    violations.push(
      'order_post_missing: the checkout must POST the order to the "orders" collection (keep api.create(\'orders\', order)) — this is how a buyer\'s order reaches the merchant.'
    );
  }

  // ----- all five order-status literals ------------------------------------
  const missingStatuses = SHOP_ORDER_STATUSES.filter(
    status => !html.includes(status)
  );
  if (missingStatuses.length > 0) {
    violations.push(
      `order_status_missing: the order pipeline status literal(s) ${missingStatuses
        .map(s => `"${s}"`)
        .join(', ')} are missing — keep all five exactly (with accents): ${SHOP_ORDER_STATUSES.map(
        s => `"${s}"`
      ).join(', ')}.`
    );
  }

  // ----- settings singleton read -------------------------------------------
  const hasSettingsList = SETTINGS_LIST_RE.test(html);
  const hasSettingsRef =
    SETTINGS_CALL_ARG_RE.test(html) || SETTINGS_ENDPOINT_RE.test(html);
  if (!hasSettingsList && !hasSettingsRef) {
    violations.push(
      'settings_singleton_missing: the storefront must read its "settings" singleton on load (keep api.list(\'settings\')) — the shop name, WhatsApp, delivery fee, accent, theme and admin PIN all come from that one record.'
    );
  }

  // ----- feature / section gating ------------------------------------------
  if (!FEATURE_ON_RE.test(html)) {
    violations.push(
      'feature_gating_missing: the featureOn(id) runtime gate is gone — keep it and its call sites so the merchant can toggle add-on features from settings.'
    );
  }
  if (!SECTION_ON_RE.test(html)) {
    violations.push(
      'section_gating_missing: the sectionOn(id) runtime gate is gone — keep it and its call sites so the merchant can toggle home sections (hero/trust/categories/featured) from settings.'
    );
  }

  return { ok: violations.length === 0, violations };
}

// ---------------------------------------------------------------------------
// describeViolations — a human-friendly, single-string summary of a violations
// list, for error messages / logs. Each violation already carries a
// `code: message` shape; this joins them into a numbered, readable block and
// prepends a short lead-in. Safe on empty / non-array input (returns '').
// The bridge uses it to build the 422 body message and the retry log line; the
// shop-edit prompt uses the raw `violations` array (not this string) so the
// model gets one clean bullet per item.
// ---------------------------------------------------------------------------
export function describeViolations(violations: string[]): string {
  if (!Array.isArray(violations) || violations.length === 0) return '';
  const cleaned = violations
    .map(v => (typeof v === 'string' ? v.trim() : ''))
    .filter(v => v.length > 0);
  if (cleaned.length === 0) return '';
  const lead =
    cleaned.length === 1
      ? 'The edited storefront broke 1 contract rule:'
      : `The edited storefront broke ${cleaned.length} contract rules:`;
  const numbered = cleaned.map((v, i) => `${i + 1}. ${v}`).join('\n');
  return `${lead}\n${numbered}`;
}
