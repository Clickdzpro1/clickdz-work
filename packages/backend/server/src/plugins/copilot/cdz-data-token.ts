import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Per-slug write token for the ClickDz Data API (P0 safety).
 *
 * Stateless HMAC so there is no storage to manage: the bridge mints the token
 * when it injects the Data URL into a generated app, and the data controller
 * re-derives + verifies it on writes/deletes. The secret falls back to the
 * existing bridge token so this works in production without provisioning a new
 * env var (set CDZ_DATA_SECRET to rotate independently later).
 *
 * NOTE: the token is embedded in the generated app's client JS, so it is
 * per-app (not a cross-app master key) and gates casual/anonymous tampering +
 * the destructive "clear" op — it is not a defense against someone who views a
 * specific app's source. True per-user auth is out of scope for anonymous
 * static apps; this is the pragmatic P0 that stops "wipe any app by guessing
 * its slug" and cross-app writes.
 */
const DATA_SECRET =
  process.env.CDZ_DATA_SECRET || process.env.CLICKDZ_BRIDGE_TOKEN || '';

// ---------------------------------------------------------------------------
// SEC-3 — SCOPED data tokens (collection + action + expiry).
//
// The original data token above ("legacy": HMAC over `appdata:${slug}`) is
// bound to the slug ONLY — no collection, no action, no expiry. Because it is
// embedded in every published app's HTML, anyone who views a storefront's
// source holds a credential that can create/upsert/delete/CLEAR every
// collection of that slug, forever. Scoped tokens close that: the payload now
// carries the allowed collections, the allowed actions and an absolute expiry,
// all folded into the signature (same versioned-blob shape as the staff token
// below — see STAFF_TOKEN_V — so the two formats never collide: a scoped token
// is base64url("d1." + …), a legacy token is a bare 32-char base64url slice).
//
// Two mint profiles:
//   • dataWriteToken(slug)  — SERVER-INTERNAL. Every bridge/courier/agents
//     call site mints this immediately before a server→server fetch, so it is
//     now a full-scope ('*'/'*') but SHORT-LIVED token (10 min). Signature and
//     truthiness contract are unchanged ('' when no secret), so the ~40
//     existing call sites keep working untouched — and keep working after the
//     legacy format is retired.
//   • publicDataToken(slug) — EMBEDDED in generated/template app HTML. Wildcard
//     collections (templates use dynamic monthly partitions), every action
//     EXCEPT the destructive `clear` (no generated app calls it), and a long
//     but FINITE expiry (CDZ_DATA_TOKEN_TTL_DAYS, default 365d — republishing
//     re-mints, so a leaked token now dies on its own).
//
// BACK-COMPAT: already-published storefronts still carry legacy tokens.
// verifyDataToken therefore ALSO accepts the legacy format while
// CDZ_DATA_TOKEN_LEGACY is not '0' (default ON — nothing breaks on deploy).
// Once every live storefront has been re-served/re-published with a scoped
// token, set CDZ_DATA_TOKEN_LEGACY=0 to retire the unscoped format for good.
// ---------------------------------------------------------------------------

/** The five Data API operations a scoped token can be minted for. */
export type DataAction = 'read' | 'create' | 'upsert' | 'delete' | 'clear';

/** Current scoped-token format tag (payload versioning, mirrors 's1'/'v1'). */
const DATA_TOKEN_V = 'd1';
/** Every action, for internal full-scope mints. */
const ALL_DATA_ACTIONS: readonly DataAction[] = [
  'read',
  'create',
  'upsert',
  'delete',
  'clear',
];
/** Public (HTML-embedded) profile: everything EXCEPT the collection wipe. */
const PUBLIC_DATA_ACTIONS: readonly DataAction[] = [
  'read',
  'create',
  'upsert',
  'delete',
];
/** Server-internal tokens are minted per request — keep them short-lived. */
const INTERNAL_TOKEN_TTL_MS = 10 * 60 * 1000;
/** Embedded-token lifetime (days). Clamped to [1, 730]; default 365. */
const PUBLIC_TOKEN_TTL_DAYS = Math.min(
  Math.max(Math.floor(Number(process.env.CDZ_DATA_TOKEN_TTL_DAYS) || 365), 1),
  730
);
/** Legacy (slug-only) tokens accepted unless explicitly retired with '0'. */
const LEGACY_TOKENS_OK = process.env.CDZ_DATA_TOKEN_LEGACY !== '0';
/** Monthly partition suffix (`invoices-202607`) — matches the data controller. */
const DATA_PARTITION_SUFFIX_RE = /-\d{6}$/;

/** The legacy slug-only mint (kept verbatim for the back-compat verify path). */
function legacyDataToken(slug: string): string {
  if (!DATA_SECRET) return '';
  return createHmac('sha256', DATA_SECRET)
    .update(`appdata:${slug}`)
    .digest('base64url')
    .slice(0, 32);
}

/**
 * Sign the canonical scoped payload → base64url HMAC-SHA256 signature. Binds
 * slug + collections + actions + exp so a signature is valid for EXACTLY that
 * tuple. Returns '' when no secret is configured (fail closed, like every
 * other sign helper in this file).
 */
function signDataScope(
  slug: string,
  collections: string,
  actions: string,
  exp: number
): string {
  if (!DATA_SECRET) return '';
  return createHmac('sha256', DATA_SECRET)
    .update(`datascope:${slug}:${collections}:${actions}:${exp}`)
    .digest('base64url');
}

/**
 * Mint a scoped data token for `slug`. `collections` is '*' or an explicit
 * list (each must match the data controller's collection charset — anything
 * else is dropped); `actions` is '*' or a subset of DataAction. Returns '' when
 * no secret is configured or the scope normalizes to empty. The result is a
 * single base64url blob, safe in a Bearer header, a `?t=` query or client JS.
 */
export function scopedDataToken(
  slug: string,
  collections: '*' | readonly string[],
  actions: '*' | readonly DataAction[],
  ttlMs: number
): string {
  if (!DATA_SECRET) return '';
  const cols =
    collections === '*'
      ? '*'
      : collections
          .filter(c => /^[a-z0-9_-]{1,32}$/.test(c))
          .slice(0, 32)
          .join(',');
  const acts =
    actions === '*'
      ? '*'
      : actions
          .filter(a => (ALL_DATA_ACTIONS as readonly string[]).includes(a))
          .join(',');
  if (!cols || !acts) return '';
  const exp = Date.now() + Math.max(1000, Math.floor(ttlMs));
  const sig = signDataScope(slug, cols, acts, exp);
  if (!sig) return '';
  const payload = `${DATA_TOKEN_V}.${cols}.${acts}.${exp}.${sig}`;
  return Buffer.from(payload, 'utf8').toString('base64url');
}

/**
 * SERVER-INTERNAL mint — full scope, 10-minute expiry. Same name/signature/
 * truthiness as the historical export so the ~40 bridge/courier/agents call
 * sites (which all mint immediately before a server→server fetch) stay
 * untouched. NOT for embedding in HTML — use publicDataToken for that.
 */
export function dataWriteToken(slug: string): string {
  return scopedDataToken(slug, '*', '*', INTERNAL_TOKEN_TTL_MS);
}

/**
 * PUBLIC mint — the token baked into generated/template app HTML
 * (`__CLICKDZ_DATA_TOKEN__`). Wildcard collections, no `clear`, finite expiry
 * (CDZ_DATA_TOKEN_TTL_DAYS, default 365d). Re-serving/republishing an app
 * re-mints it, which is the rotation story for leaked tokens.
 */
export function publicDataToken(slug: string): string {
  return scopedDataToken(
    slug,
    '*',
    PUBLIC_DATA_ACTIONS,
    PUBLIC_TOKEN_TTL_DAYS * 86_400_000
  );
}

/** Decoded scope of a verified `d1.` token. */
interface DataTokenScope {
  collections: string;
  actions: string;
}

/**
 * Cryptographically verify a `d1.` scoped token for `slug` (constant-time sig
 * compare + expiry check). Returns the embedded scope on success, null for ANY
 * problem — not a d1 blob, malformed, expired, bad signature. Never throws.
 */
function verifyScopedDataToken(
  slug: string,
  token: string
): DataTokenScope | null {
  if (!DATA_SECRET || !token) return null;
  let payload: string;
  try {
    payload = Buffer.from(token, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  // EXACTLY 5 fields; collections/actions never contain '.', the sig cannot
  // either, so a plain split is unambiguous (same idiom as the staff token).
  const parts = payload.split('.');
  if (parts.length !== 5) return null;
  const [ver, cols, acts, expRaw, sig] = parts;
  if (ver !== DATA_TOKEN_V || !cols || !acts || !sig) return null;
  const exp = Number(expRaw);
  if (!Number.isFinite(exp) || exp < Date.now()) return null;
  const expected = signDataScope(slug, cols, acts, exp);
  if (!expected || !safeEqual(expected, sig)) return null;
  return { collections: cols, actions: acts };
}

/**
 * Whether a verified scope covers `collection`. '*' covers everything; an
 * explicit list matches the exact name OR its partition base (`invoices`
 * covers `invoices-202607` — same suffix rule the data controller applies).
 */
function scopeAllowsCollection(scope: string, collection: string): boolean {
  if (scope === '*') return true;
  const base = collection.replace(DATA_PARTITION_SUFFIX_RE, '');
  return scope.split(',').some(c => c === collection || c === base);
}

/** Whether a verified scope covers `action`. '*' covers everything. */
function scopeAllowsAction(scope: string, action: DataAction): boolean {
  return scope === '*' || scope.split(',').includes(action);
}

/**
 * Constant-time string comparison. Both inputs are hashed to a fixed-length
 * digest first, so unequal-length inputs neither throw nor leak their length
 * through timing — then compared with timingSafeEqual.
 */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHmac('sha256', 'cdz-cmp')
    .update(a ?? '')
    .digest();
  const hb = createHmac('sha256', 'cdz-cmp')
    .update(b ?? '')
    .digest();
  return timingSafeEqual(ha, hb);
}

/**
 * Verify a caller-supplied token for `slug` (constant-time).
 *
 * SEC-3: accepts BOTH formats —
 *   • a scoped `d1.` token: signature + expiry are always enforced; when the
 *     caller also passes `collection`/`action`, the embedded scope must cover
 *     them (callers that pass neither — e.g. the /pay/checkout gate — only
 *     prove "this request comes from this app", which is all they need);
 *   • a legacy slug-only token: accepted while CDZ_DATA_TOKEN_LEGACY is not
 *     '0' (default ON). Legacy tokens carry no scope, so they authorize every
 *     collection/action — exactly their historical behaviour. Set the flag to
 *     '0' once all live storefronts are re-minted to retire them.
 *
 * The optional parameters keep every existing `verifyDataToken(slug, token)`
 * call site source-compatible.
 */
export function verifyDataToken(
  slug: string,
  token: string,
  collection?: string,
  action?: DataAction
): boolean {
  if (!token) return false;
  const scope = verifyScopedDataToken(slug, token);
  if (scope) {
    if (collection && !scopeAllowsCollection(scope.collections, collection)) {
      return false;
    }
    if (action && !scopeAllowsAction(scope.actions, action)) {
      return false;
    }
    return true;
  }
  if (!LEGACY_TOKENS_OK) return false;
  const expected = legacyDataToken(slug);
  if (!expected) return false;
  return safeEqual(expected, token);
}

// ---------------------------------------------------------------------------
// Vdz signed blob token (C3 — worker→app blob serve).
//
// A stateless, EXPIRING variant of the data token above. It gates the @Public()
// `GET /api/v1/vdz/blob/:workspaceId/:blobId` route so the Remotion worker
// (which has NO app cookie/session) can fetch uploaded workspace blobs over
// HTTPS using only a signed, short-lived URL. The `exp` timestamp is folded
// INTO the signed payload (unlike the data token, which never expires), so a
// leaked URL dies on its own and cannot be replayed past its window.
//
// Same secret + constant-time compare as the data token (reuses safeEqual),
// so this works in production without provisioning a new env var. `exp` is a
// millisecond epoch (Date.now() domain) to match the `exp < Date.now()` check.
// ---------------------------------------------------------------------------

/**
 * Sign a `(workspaceId, blobId, exp)` triple → base64url HMAC-SHA256 signature.
 * `exp` is an absolute expiry as a millisecond epoch (`Date.now()` domain); the
 * caller owns choosing it (e.g. now + 45min). Returns '' when no secret is
 * configured — the verifier treats an empty expected/candidate sig as invalid,
 * so an unconfigured deployment fails closed rather than serving unsigned URLs.
 */
export function signBlobToken(
  workspaceId: string,
  blobId: string,
  exp: number
): string {
  if (!DATA_SECRET) return '';
  return createHmac('sha256', DATA_SECRET)
    .update(`blob:${workspaceId}:${blobId}:${exp}`)
    .digest('base64url');
}

/**
 * Verify a caller-supplied blob token (constant-time) AND that it has not
 * expired. Returns false when the secret is unset, the sig is missing/empty,
 * `exp` is not a finite timestamp, `exp` is already in the past, or the sig does
 * not match the re-derived expected value. Never throws (so the route maps a
 * false result to a typed 401/403 rather than a raw 500).
 */
export function verifyBlobToken(
  workspaceId: string,
  blobId: string,
  exp: number,
  sig: string
): boolean {
  if (!Number.isFinite(exp) || exp < Date.now()) return false;
  const expected = signBlobToken(workspaceId, blobId, exp);
  if (!expected || !sig) return false;
  return safeEqual(expected, sig);
}

// ---------------------------------------------------------------------------
// WSE-12 (R2-e) — ERP staff auth token (owner → staff scoped session token).
//
// A stateless, EXPIRING, ROLE-scoped variant of the tokens above. It is what
// the PUBLISHED ERP app calls at login (R3): the owner creates a staff record
// in the studio, the bridge mints ONE staffToken for that staff member, and
// the published app stores it and presents it to `POST /apps-staff/verify` on
// each login/session to learn its role + permission set. The published SPA
// hides tabs/actions by role, and every mutating bridge route ALSO re-checks
// the role server-side (defense in depth — never trust a client-hidden button).
//
// Same secret derivation + `.digest('base64url')` encoding style as
// dataWriteToken / signBlobToken (reuses DATA_SECRET + safeEqual), so this
// works in production with NO new env var. Everything here is inert unless the
// bridge routes are enabled by CDZ_ERP_STAFF_AUTH; when that flag is OFF the
// legacy single-PIN path stays byte-identical (these exports are simply
// unused). This module NEVER reads CDZ_ERP_STAFF_AUTH itself — the flag gating
// lives on the routes so this file has no new env coupling and no behavioural
// change to any existing caller.
//
// Token format (compact, opaque, self-describing — a single base64url blob):
//   base64url( "s1." + staffId + "." + role + "." + nonce + "." + exp + "." + sig )
// where
//   s1        = format/version tag (lets us evolve the payload later)
//   staffId   = the staff record's business-key id (kebab-case slug)
//   role      = 'owner' | 'manager' | 'staff'
//   nonce     = the staff record's CURRENT revocation nonce (see below)
//   exp       = absolute expiry, millisecond epoch (Date.now() domain)
//   sig       = HMAC-SHA256 over "staff:{slug}:{staffId}:{role}:{nonce}:{exp}"
//               base64url — binds EVERY field (incl. slug) so a token minted
//               for one app/staff/role cannot be replayed for another.
//
// REVOCATION (rotate): the `nonce` is embedded in the signed payload. To revoke
// a staff member's outstanding tokens WITHOUT server-side session storage, the
// bump the staff record's stored nonce (POST .../staff/:id/revoke): the verifier
// re-derives the expected sig using the record's CURRENT nonce, so any token
// carrying the OLD nonce now fails safeEqual and dies immediately. This keeps
// the scheme stateless-per-token while still supporting instant kill of a lost
// device — the only server state is the small nonce stored on the staff record.
// ---------------------------------------------------------------------------

/** The three ERP roles, in descending privilege (Mason WSE-12). */
export type StaffRole = 'owner' | 'manager' | 'staff';

/** Gated, mutating ERP actions a role may or may not perform (Mason WSE-12). */
export type StaffAction =
  | 'orders.read'
  | 'orders.write'
  | 'products.write'
  | 'invoices.write'
  | 'caisse.write'
  | 'settings.write'
  | 'staff.manage';

/** Hard cap on token lifetime — DZ SMB staff sessions, ≤90 days (R2 contract). */
const STAFF_TOKEN_MAX_EXP_DAYS = 90;
/** Default lifetime when the caller does not pass one (30 days). */
const STAFF_TOKEN_DEFAULT_EXP_DAYS = 30;
const DAY_MS = 86_400_000;
/** Current token format tag (payload versioning for forward-compat). */
const STAFF_TOKEN_V = 's1';
/** Belt-and-braces caps on the compact fields we sign (kept tiny). */
const STAFF_ID_MAX = 80;
const STAFF_NONCE_MAX = 64;

const STAFF_ROLES: readonly StaffRole[] = ['owner', 'manager', 'staff'];

/**
 * Role → permission set (Mason WSE-12):
 *   owner   = every action.
 *   manager = every action EXCEPT staff.manage + settings.write.
 *   staff   = orders.read + orders.write ONLY.
 * Ordered lists (used verbatim by `staffPermissions` for the verify route).
 */
const OWNER_ACTIONS: readonly StaffAction[] = [
  'orders.read',
  'orders.write',
  'products.write',
  'invoices.write',
  'caisse.write',
  'settings.write',
  'staff.manage',
];
const MANAGER_ACTIONS: readonly StaffAction[] = [
  'orders.read',
  'orders.write',
  'products.write',
  'invoices.write',
  'caisse.write',
];
const STAFF_ACTIONS: readonly StaffAction[] = ['orders.read', 'orders.write'];

/**
 * Whether `role` may perform `action`. The single source of truth for role
 * gating — used BOTH server-side (the bridge re-checks every mutating route)
 * and to build the permission array the verify route hands the published app.
 * An unknown role or action ⇒ false (fail-closed).
 */
export function staffCan(role: string, action: string): boolean {
  const set =
    role === 'owner'
      ? OWNER_ACTIONS
      : role === 'manager'
        ? MANAGER_ACTIONS
        : role === 'staff'
          ? STAFF_ACTIONS
          : null;
  if (!set) return false;
  return (set as readonly string[]).includes(action);
}

/** The full permission list for a role (empty for an unknown role). */
export function staffPermissions(role: string): StaffAction[] {
  if (role === 'owner') return [...OWNER_ACTIONS];
  if (role === 'manager') return [...MANAGER_ACTIONS];
  if (role === 'staff') return [...STAFF_ACTIONS];
  return [];
}

/** Type guard: a caller-supplied string is one of the three known roles. */
function isStaffRole(v: unknown): v is StaffRole {
  return typeof v === 'string' && (STAFF_ROLES as readonly string[]).includes(v);
}

/**
 * Sign the canonical staff payload → base64url HMAC-SHA256 signature. Binds
 * slug + staffId + role + nonce + exp so a signature is valid for EXACTLY that
 * tuple (no cross-app / cross-role / post-revoke replay). Returns '' when no
 * secret is configured — the verifier treats an empty sig as invalid, so an
 * unconfigured deployment fails closed rather than accepting unsigned tokens.
 * Mirrors signBlobToken's derivation exactly (same secret, same encoding).
 */
function signStaffPayload(
  slug: string,
  staffId: string,
  role: StaffRole,
  nonce: string,
  exp: number
): string {
  if (!DATA_SECRET) return '';
  return createHmac('sha256', DATA_SECRET)
    .update(`staff:${slug}:${staffId}:${role}:${nonce}:${exp}`)
    .digest('base64url');
}

/**
 * Mint a compact, opaque staff session token for `(slug, staffId, role)`.
 *
 * `nonce` is the staff record's CURRENT revocation nonce (bumping it on the
 * record invalidates every previously-minted token — see module header). It is
 * folded into the signature so an old token dies the instant the record rotates.
 *
 * `expDays` is clamped to (0, 90]; omitted ⇒ 30 days. Returns '' when no secret
 * is configured (so the bridge can surface a typed "staff auth unavailable"
 * body rather than handing out an unverifiable token). The result is a single
 * base64url blob — safe to embed in JSON, a header, or client storage.
 */
export function staffToken(
  slug: string,
  staffId: string,
  role: StaffRole,
  nonce: string,
  expDays?: number
): string {
  if (!DATA_SECRET) return '';
  if (!isStaffRole(role)) return '';
  const id = String(staffId ?? '').slice(0, STAFF_ID_MAX);
  const nc = String(nonce ?? '').slice(0, STAFF_NONCE_MAX);
  if (!id || !nc) return '';
  const days = Number.isFinite(expDays as number)
    ? (expDays as number)
    : STAFF_TOKEN_DEFAULT_EXP_DAYS;
  // Clamp to (0, 90] days — never mint a token that outlives the contract cap.
  const clampedDays = Math.max(1, Math.min(days, STAFF_TOKEN_MAX_EXP_DAYS));
  const exp = Date.now() + Math.floor(clampedDays * DAY_MS);
  const sig = signStaffPayload(slug, id, role, nc, exp);
  if (!sig) return '';
  const payload = `${STAFF_TOKEN_V}.${id}.${role}.${nc}.${exp}.${sig}`;
  return Buffer.from(payload, 'utf8').toString('base64url');
}

/** The shape `verifyStaffToken` returns (ok:false carries no fields). */
export interface StaffTokenResult {
  ok: boolean;
  staffId?: string;
  role?: StaffRole;
  /** The nonce embedded in the token (so callers can compare to the record). */
  nonce?: string;
}

/**
 * Verify a caller-supplied staff token for `slug` (constant-time) AND that it
 * has not expired. Returns `{ ok: true, staffId, role, nonce }` on success, or
 * `{ ok: false }` for ANY problem — no secret configured, malformed blob,
 * unknown role, non-finite/expired `exp`, over-cap `exp`, or a signature that
 * does not match the re-derived expected value. Never throws (so a route maps a
 * false result to a typed 401 rather than a raw 500).
 *
 * REVOCATION is enforced by the CALLER: this function proves the token was
 * signed for `(slug, staffId, role, nonce, exp)` and returns the embedded
 * `nonce`; the bridge then checks that nonce still equals the staff record's
 * CURRENT nonce (a revoke bumps the record's nonce, so a stale token verifies
 * cryptographically but is rejected on the nonce mismatch). This keeps the
 * signature check pure/stateless while supporting instant kill of a device.
 */
export function verifyStaffToken(slug: string, token: string): StaffTokenResult {
  if (!DATA_SECRET || !token || typeof token !== 'string') {
    return { ok: false };
  }
  let payload: string;
  try {
    payload = Buffer.from(token, 'base64url').toString('utf8');
  } catch {
    return { ok: false };
  }
  // Split into EXACTLY 6 fields; the sig may not contain a '.', so a plain
  // split is unambiguous. Anything else is malformed → fail closed.
  const parts = payload.split('.');
  if (parts.length !== 6) return { ok: false };
  const [ver, staffId, role, nonce, expRaw, sig] = parts;
  if (ver !== STAFF_TOKEN_V) return { ok: false };
  if (!staffId || !role || !nonce || !sig) return { ok: false };
  if (!isStaffRole(role)) return { ok: false };
  const exp = Number(expRaw);
  // Reject non-finite, already-past, and over-cap expiries (a token claiming a
  // lifetime beyond the 90-day contract is treated as forged).
  if (!Number.isFinite(exp)) return { ok: false };
  if (exp < Date.now()) return { ok: false };
  if (exp > Date.now() + STAFF_TOKEN_MAX_EXP_DAYS * DAY_MS) return { ok: false };
  const expected = signStaffPayload(slug, staffId, role, nonce, exp);
  if (!expected || !safeEqual(expected, sig)) return { ok: false };
  return { ok: true, staffId, role, nonce };
}
