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

export function dataWriteToken(slug: string): string {
  if (!DATA_SECRET) return '';
  return createHmac('sha256', DATA_SECRET)
    .update(`appdata:${slug}`)
    .digest('base64url')
    .slice(0, 32);
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

/** Verify a caller-supplied write token for `slug` (constant-time). */
export function verifyDataToken(slug: string, token: string): boolean {
  const expected = dataWriteToken(slug);
  if (!expected || !token) return false;
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
