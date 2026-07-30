import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from 'node:crypto';

/**
 * Authenticated secret box for per-user secrets at rest (R10 — BYOT).
 *
 * ClickDz Work is going multi-tenant: instead of ONE global platform bot token
 * in an env var, every user connects their OWN Telegram bot (BotFather) to a
 * specific agent. That per-user bot token must be stored server-side, so it
 * has to be encrypted — a leaked Redis dump must not hand an attacker live bot
 * tokens. This module is the sealing primitive Trousseau's channel store uses:
 * `sealSecret` before writing to Redis, `openSecret` after reading.
 *
 * Design (deliberately tiny, zero deps beyond node:crypto):
 *   - AES-256-GCM (authenticated: any bit-flip of iv/tag/ciphertext fails the
 *     GCM auth check, so tampering is detected — not just decrypted to garbage).
 *   - Key = scryptSync(MASTER, 'cdz-secretbox-v1', 32) where MASTER =
 *     process.env.CDZ_DATA_SECRET. That secret is ALREADY provisioned in prod
 *     (it also backs cdz-data-token.ts), so BYOT ships with NO new env var. The
 *     static salt 'cdz-secretbox-v1' domain-separates this key from any other
 *     use of CDZ_DATA_SECRET and versions the derivation (bump the salt to
 *     rotate the scheme later). The derived key is computed ONCE and cached
 *     in-module (scrypt is intentionally slow — never per-call).
 *   - Fail-soft: when CDZ_DATA_SECRET is unset the feature runs dark —
 *     `sealSecret` returns null (caller stores nothing / disables the channel)
 *     and `secretBoxReady()` is false. `openSecret` returns null on ANY problem
 *     (no key, wrong format, bad base64url, wrong version tag, or a failed GCM
 *     auth tag) and NEVER throws, so a webhook/route maps a null to a typed
 *     "not connected" rather than a raw 500.
 *
 * Sealed format (a single opaque, self-describing string):
 *   v1.{ivB64url}.{tagB64url}.{ctB64url}
 * where each part is base64url WITHOUT padding (matching cdz-data-token.ts's
 * `.digest('base64url')` convention). `v1` is a format/version tag so the
 * payload can evolve; iv is a fresh 12-byte random nonce per seal (so two seals
 * of the SAME plaintext differ — no plaintext-equality leak); tag is the 16-byte
 * GCM auth tag; ct is the AES-256-GCM ciphertext of the UTF-8 plaintext.
 */

// SEC-4: the box now prefers its OWN key env var, CDZ_SECRETBOX_KEY, so the
// key that decrypts courier API keys / bot tokens at rest is no longer the
// same value that signs HMAC tokens handed to browsers. Back-compat is
// preserved in both directions:
//   • CDZ_SECRETBOX_KEY unset → MASTER falls back to CDZ_DATA_SECRET, i.e.
//     byte-identical behaviour to before this change (nothing to re-seal).
//   • CDZ_SECRETBOX_KEY set  → NEW seals use it, while openSecret() ALSO tries
//     the legacy key (CDZ_SECRETBOX_LEGACY_KEY, defaulting to CDZ_DATA_SECRET)
//     so every value sealed before the switch still opens. GCM's auth tag
//     makes the two-key try safe: a wrong key fails authentication, it never
//     yields garbage plaintext.
// RE-SEAL / ROTATION PATH: after setting CDZ_SECRETBOX_KEY, existing sealed
// values keep opening via the legacy key indefinitely; to finish the rotation,
// re-save each connection (re-connect couriers / re-submit bot tokens — every
// save calls sealSecret with the new key), then drop CDZ_SECRETBOX_LEGACY_KEY
// (or, if it was implicit, rotate CDZ_DATA_SECRET). Never delete the old key
// before re-sealing — sealed values it protects would become unreadable.

/** PRIMARY key material: dedicated var, falling back to the data secret. */
const MASTER =
  process.env.CDZ_SECRETBOX_KEY || process.env.CDZ_DATA_SECRET || '';

/**
 * LEGACY key material, tried on open() only. Explicit CDZ_SECRETBOX_LEGACY_KEY
 * wins; otherwise, when a dedicated primary is set, the previous implicit
 * master (CDZ_DATA_SECRET) is the natural legacy. Empty/same-as-primary ⇒ no
 * legacy attempt.
 */
const LEGACY_MASTER =
  process.env.CDZ_SECRETBOX_LEGACY_KEY ||
  (process.env.CDZ_SECRETBOX_KEY ? process.env.CDZ_DATA_SECRET || '' : '');

/** Static salt — domain-separates + versions the derived key (bump to rotate). */
const KEY_SALT = 'cdz-secretbox-v1';
/** Sealed-format version tag (payload versioning for forward-compat). */
const BOX_V = 'v1';
/** AES-256 ⇒ 32-byte key. */
const KEY_LEN = 32;
/** GCM standard nonce length: 12 bytes, fresh + random per seal. */
const IV_LEN = 12;
/** GCM auth tag length: 16 bytes. */
const TAG_LEN = 16;

/**
 * Derive-once cache for the AES key. scryptSync is CPU-hard by design, so we
 * pay it a single time (lazily, on first seal/open) and reuse the buffer. `null`
 * means "not yet derived"; when MASTER is unset it stays null forever and every
 * public function fails soft.
 */
let cachedKey: Buffer | null = null;
/** Same derive-once cache for the LEGACY key (open()-only, see SEC-4 above). */
let cachedLegacyKey: Buffer | null = null;

/**
 * Return the cached 32-byte AES key, deriving it once via scrypt. Returns null
 * when no MASTER secret is configured (feature dark). Never throws.
 */
function getKey(): Buffer | null {
  if (cachedKey) return cachedKey;
  if (!MASTER) return null;
  try {
    cachedKey = scryptSync(MASTER, KEY_SALT, KEY_LEN);
    return cachedKey;
  } catch {
    // scrypt can throw only on absurd params; treat as "no key" (fail soft).
    return null;
  }
}

/**
 * The legacy decrypt-only key (SEC-4 rotation). null when no distinct legacy
 * secret is configured — the common case. Never throws.
 */
function getLegacyKey(): Buffer | null {
  if (cachedLegacyKey) return cachedLegacyKey;
  if (!LEGACY_MASTER || LEGACY_MASTER === MASTER) return null;
  try {
    cachedLegacyKey = scryptSync(LEGACY_MASTER, KEY_SALT, KEY_LEN);
    return cachedLegacyKey;
  } catch {
    return null;
  }
}

/**
 * Whether the secret box is usable (i.e. CDZ_DATA_SECRET is set and a key could
 * be derived). Trousseau gates the whole BYOT channels feature on this:
 * `channelsEnabled() = CDZ_AGENT_TELEGRAM_ENABLED==='1' && secretBoxReady()`.
 */
export function secretBoxReady(): boolean {
  return getKey() !== null;
}

/**
 * Seal a UTF-8 plaintext into `v1.{iv}.{tag}.{ct}` (base64url, no padding).
 *
 * A fresh 12-byte random IV is generated per call, so sealing the same value
 * twice yields two different strings (no equality leak at rest). Returns null
 * when no key is configured (feature dark) — the caller stores nothing. Never
 * throws.
 */
export function sealSecret(plain: string): string | null {
  const key = getKey();
  if (!key) return null;
  try {
    const iv = randomBytes(IV_LEN);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const ct = Buffer.concat([
      cipher.update(String(plain ?? ''), 'utf8'),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    return [
      BOX_V,
      iv.toString('base64url'),
      tag.toString('base64url'),
      ct.toString('base64url'),
    ].join('.');
  } catch {
    return null;
  }
}

/**
 * Open a sealed string back to its UTF-8 plaintext. Returns null for ANY
 * problem — no key configured, wrong number of parts, wrong version tag, bad
 * base64url, wrong-length iv/tag, or a failed GCM authentication (tampered
 * iv/tag/ciphertext). Never throws, so a route maps null to a typed
 * "not connected / unavailable" rather than a raw 500.
 */
export function openSecret(sealed: string): string | null {
  const key = getKey();
  if (!key) return null;
  if (!sealed || typeof sealed !== 'string') return null;
  // Split into EXACTLY 4 fields: version + 3 base64url blobs. base64url has no
  // '.' in its charset, so a plain split is unambiguous; anything else is
  // malformed → fail closed.
  const parts = sealed.split('.');
  if (parts.length !== 4) return null;
  const [ver, ivRaw, tagRaw, ctRaw] = parts;
  if (ver !== BOX_V) return null;
  // iv + tag are ALWAYS non-empty for a real seal; ct MAY be empty (sealing the
  // empty string yields empty ciphertext but a valid 16-byte tag), so only iv
  // and tag are required to be present here. `ctRaw` is guaranteed defined by
  // the parts.length === 4 check above.
  if (!ivRaw || !tagRaw) return null;
  try {
    const iv = Buffer.from(ivRaw, 'base64url');
    const tag = Buffer.from(tagRaw, 'base64url');
    const ct = Buffer.from(ctRaw, 'base64url');
    // Reject malformed nonce/tag lengths before touching the cipher — GCM would
    // throw on these anyway, but an explicit check keeps the failure a clean
    // null and documents the invariants.
    if (iv.length !== IV_LEN || tag.length !== TAG_LEN) return null;
    // SEC-4: primary key first; on a failed GCM auth, the legacy key (values
    // sealed before a key rotation). The auth tag guarantees a wrong key can
    // only fail cleanly — it can never decrypt to garbage.
    const primary = tryDecrypt(key, iv, tag, ct);
    if (primary !== null) return primary;
    const legacyKey = getLegacyKey();
    if (legacyKey) return tryDecrypt(legacyKey, iv, tag, ct);
    return null;
  } catch {
    return null;
  }
}

/**
 * Attempt one AES-256-GCM decrypt with `key`. Returns the UTF-8 plaintext, or
 * null when the GCM auth tag does not verify (any tamper of iv/tag/ct, or a
 * wrong key — `decipher.final()` throws in that case). Never throws.
 */
function tryDecrypt(
  key: Buffer,
  iv: Buffer,
  tag: Buffer,
  ct: Buffer
): string | null {
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(ct), decipher.final()]);
    return plain.toString('utf8');
  } catch {
    return null;
  }
}
