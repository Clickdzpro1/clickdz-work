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
