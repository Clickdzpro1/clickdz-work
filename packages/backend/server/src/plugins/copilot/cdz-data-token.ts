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
