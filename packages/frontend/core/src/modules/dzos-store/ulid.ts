/**
 * ULID — Universally Unique Lexicographically Sortable Identifier.
 *
 * Used for outbox opIds (the idempotency key sent as X-Idempotency-Key).
 * Monotonic + sortable + 26 chars + no deps. The sortability means listOutbox
 * by ts and by opId agree, so the sync engine can replay in enqueue order.
 *
 * Minimal stdlib implementation (Crockford base32, 48-bit ms timestamp + 80-bit
 * random). NOT RFC 4122 — ULIDs are their own spec. Good enough for opIds: the
 * server dedupes on the exact string, and sortability is the only property we
 * rely on beyond uniqueness.
 */

const ENCODE = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base32 (no I/L/O/U)

let lastMs = 0;
let lastRand: number[] = new Array(10).fill(0);

/** Encode a 10-byte random tail, incrementing in-place for monotonicity within a ms. */
function encodeRandom(rand: number[]): string {
  let out = '';
  for (let i = 0; i < 16; i++) {
    // Each 5-bit group: byte index = i*5/8, bit offset = i*5%8.
    // Simpler: treat the 10 bytes as a 80-bit big-endian, extract 5-bit chunks.
  }
  // Straightforward 16x 5-bit extraction from the 10-byte buffer.
  const buf = new Uint8Array(rand);
  // Build a 80-bit view as two 40-bit (5-byte) halves, extract 5-bit groups.
  const bits: number[] = [];
  for (let i = 0; i < 10; i++) {
    for (let b = 7; b >= 0; b--) bits.push((buf[i] >> b) & 1);
  }
  for (let i = 0; i < 16; i++) {
    let v = 0;
    for (let b = 0; b < 5; b++) v = (v << 1) | bits[i * 5 + b];
    out += ENCODE[v];
  }
  return out;
}

/** Encode the 48-bit ms timestamp as 10 Crockford chars. */
function encodeTime(ms: number): string {
  let out = '';
  let t = ms;
  for (let i = 9; i >= 0; i--) {
    const mod = t % 32;
    out = ENCODE[mod] + out;
    t = Math.floor(t / 32);
  }
  return out;
}

/** Generate a monotonic ULID (26 chars). */
export function ulid(): string {
  const now = Date.now();
  if (now <= lastMs) {
    // Same ms (or clock regression): increment the random tail in-place.
    let carry = 1;
    for (let i = 9; i >= 0 && carry; i--) {
      lastRand[i] += carry;
      if (lastRand[i] > 0xff) {
        lastRand[i] = 0;
        carry = 1;
      } else {
        carry = 0;
      }
    }
  } else {
    lastMs = now;
    for (let i = 0; i < 10; i++) lastRand[i] = Math.floor(Math.random() * 256);
  }
  return encodeTime(now) + encodeRandom(lastRand);
}
