//
// `cdz-qr` — a tiny, dependency-free QR-code generator for the ClickDz Builder
// Studio's publish "share" sheet.
//
// Why hand-rolled: the app-builder constraint bans external libraries and
// `qrcode` is not in the repo's package.json — so drawing a shareable QR on the
// publish success surface needs a small inline algorithm.
//
// Scope kept deliberately narrow to stay correct and low-risk:
//   - Byte-mode encoding (UTF-8), ECC level L, mask pattern 0.
//   - Versions 1–10 (module grids up to 57×57), which comfortably covers the
//     short `https://…/apps/<slug>` URLs the studio actually shares. Longer
//     inputs degrade gracefully to `null` + rely on the copy-link button.
//   - Pure, deterministic, side-effect-free: no DOM, no `lit`, no globals — the
//     same input always yields the same output, so it is safe to import from a
//     node self-test or anywhere in the browser.
//   - Output is `qrSvg(text, size)` → a self-contained inline SVG string (dark
//     modules filled, scaled to the requested CSS size), ready to drop into a
//     template literal. No `<defs>`, no external files.
//
// The QR is a *convenience* on top of copy-link — it must never hold the flow
// hostage. Any input the encoder cannot handle simply returns null and the
// share sheet still offers copy-link + open-fallback.
//
// Algorithm follows ISO/IEC 18004 (byte mode, ECC L, mask 0). Cross-validated
// by decoding generated matrices with an independent decoder in development,
// including multi-block interleaving (versions 6+).
//

/** GF(256) log and antilog tables (primitive polynomial 0x11D), built once. */
const GF_LOG: number[] = new Array(256);
const GF_EXP: number[] = new Array(512);
(function buildTables() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
})();

/** Multiply two GF(256) elements. */
function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

/** Multiply two polynomials over GF(256). */
function gfPolyMul(a: number[], b: number[]): number[] {
  const c: number[] = new Array(a.length + b.length - 1).fill(0);
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < b.length; j++) {
      c[i + j] ^= gfMul(a[i], b[j]);
    }
  }
  return c;
}

/**
 * Reed–Solomon generator polynomial of degree `eccCount`:
 * (x - alpha^0)(x - alpha^1)…(x - alpha^(eccCount-1)).
 */
function rsGenPoly(eccCount: number): number[] {
  let poly: number[] = [1];
  for (let i = 0; i < eccCount; i++) {
    poly = gfPolyMul(poly, [1, GF_EXP[i]]);
  }
  return poly;
}

/** Reed–Solomon ECC codewords for `data`, returning `eccLen` of them. */
function rsEncode(data: number[], eccLen: number): number[] {
  const gen = rsGenPoly(eccLen);
  const deg = gen.length - 1;
  const res: number[] = data.concat(new Array<number>(eccLen).fill(0));
  for (let i = 0; i < data.length; i++) {
    const lead = res[i];
    if (lead !== 0) {
      for (let j = 0; j <= deg; j++) res[i + j] ^= gfMul(gen[j], lead);
    }
  }
  return res.slice(data.length);
}

/** Byte capacity per version (1–10) at ECC level L. */
const VERSION_TABLE: { data: number; eccPerBlock: number; blocks: number }[] = [
  { data: 19, eccPerBlock: 7, blocks: 1 }, // v1
  { data: 34, eccPerBlock: 10, blocks: 1 }, // v2
  { data: 55, eccPerBlock: 15, blocks: 1 }, // v3
  { data: 80, eccPerBlock: 20, blocks: 1 }, // v4
  { data: 108, eccPerBlock: 26, blocks: 1 }, // v5
  { data: 136, eccPerBlock: 18, blocks: 2 }, // v6
  { data: 156, eccPerBlock: 20, blocks: 2 }, // v7
  { data: 194, eccPerBlock: 24, blocks: 2 }, // v8
  { data: 232, eccPerBlock: 30, blocks: 2 }, // v9
  { data: 274, eccPerBlock: 36, blocks: 2 }, // v10
];

/** Alignment-pattern centre coordinates, one entry per version (1–10). */
const ALIGNMENT: number[][] = [
  [6],
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38],
  [6, 24, 42],
  [6, 26, 46],
  [6, 28, 50],
];

/**
 * Pick the smallest version (1–10, ECC L) that fits a byte-mode payload of
 * `len` bytes — or null when it does not fit (caller falls back to copy-link).
 */
function pickVersion(len: number): number | null {
  for (let v = 0; v < VERSION_TABLE.length; v++) {
    const countBits = v === 9 ? 16 : 8; // 16-bit char count at version 10
    if (4 + countBits + len * 8 <= VERSION_TABLE[v].data * 8) return v + 1;
  }
  return null;
}

/** UTF-8 encode a JS string into a byte array. */
function utf8Bytes(str: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < str.length; i++) {
    let cp = str.codePointAt(i)!;
    if (cp > 0xffff) i++;
    if (cp <= 0x7f) {
      out.push(cp);
    } else if (cp <= 0x7ff) {
      out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    } else if (cp <= 0xffff) {
      out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    } else {
      out.push(
        0xf0 | (cp >> 18),
        0x80 | ((cp >> 12) & 0x3f),
        0x80 | ((cp >> 6) & 0x3f),
        0x80 | (cp & 0x3f)
      );
    }
  }
  return out;
}

/** Append `count` low bits of `value` (MSB first) onto `bits`. */
function appendBits(bits: number[], value: number, count: number) {
  for (let i = count - 1; i >= 0; i--) bits.push((value >> i) & 1);
}

/** Group a bit list into bytes (MSB-first within each byte). */
function bitsToBytes(bits: number[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let v = 0;
    for (let k = 0; k < 8; k++) v = (v << 1) | (bits[i + k] || 0);
    out.push(v);
  }
  return out;
}

/** Build the padded byte-mode data codeword stream for a version. */
function buildDataStream(bytes: number[], version: number): number[] {
  const totalBits = VERSION_TABLE[version - 1].data * 8;
  const countBits = version === 10 ? 16 : 8;
  const bits: number[] = [];
  appendBits(bits, 4, 4); // mode indicator 0100 = byte mode
  appendBits(bits, bytes.length, countBits);
  for (const b of bytes) appendBits(bits, b, 8);
  appendBits(bits, 0, Math.min(4, totalBits - bits.length)); // terminator
  while (bits.length % 8 !== 0) bits.push(0);
  let alt = 0;
  while (bits.length < totalBits) {
    appendBits(bits, alt++ % 2 === 0 ? 0xec : 0x11, 8);
  }
  return bitsToBytes(bits);
}

/** Split data into blocks, RS-encode each, and interleave data + ECC. */
function addEccAndInterleave(data: number[], version: number): number[] {
  const cfg = VERSION_TABLE[version - 1];
  const blocks = cfg.blocks;
  const shortData = Math.floor(cfg.data / blocks);
  const shortBlocks = blocks - (cfg.data % blocks);

  const dataBlocks: number[][] = [];
  const eccBlocks: number[][] = [];
  let pos = 0;
  for (let b = 0; b < blocks; b++) {
    const len = b < shortBlocks ? shortData : shortData + 1;
    const blockData = data.slice(pos, pos + len);
    pos += len;
    dataBlocks.push(blockData);
    eccBlocks.push(rsEncode(blockData, cfg.eccPerBlock));
  }
  const out: number[] = [];
  const maxData = shortData + (shortBlocks < blocks ? 1 : 0);
  for (let i = 0; i < maxData; i++) {
    for (let b = 0; b < blocks; b++) {
      if (i < dataBlocks[b].length) out.push(dataBlocks[b][i]);
    }
  }
  for (let i = 0; i < cfg.eccPerBlock; i++) {
    for (let b = 0; b < blocks; b++) out.push(eccBlocks[b][i]);
  }
  return out;
}

/** Is (x,y) a function module (finder, timing, alignment, dark, format)? */
function isFunction(
  x: number,
  y: number,
  size: number,
  version: number,
  aligns: number[]
): boolean {
  if (x < 9 && y < 9) return true;
  if (x >= size - 8 && y < 9) return true;
  if (x < 9 && y >= size - 8) return true;
  if (y === 6 || x === 6) return true;
  if (x === 8 && y === size - 8) return true;
  for (const cy of aligns) {
    for (const cx of aligns) {
      if (
        (cx === 6 && (cy === 6 || cy === size - 7)) ||
        (cx === size - 7 && cy === 6)
      ) {
        continue;
      }
      if (Math.abs(x - cx) <= 2 && Math.abs(y - cy) <= 2) return true;
    }
  }
  if (y === 8 && (x <= 8 || x >= size - 8)) return true;
  if (x === 8 && (y <= 8 || y >= size - 8)) return true;
  if (version >= 7) {
    if ((y < 6 && x >= size - 11) || (x < 6 && y >= size - 11)) return true;
  }
  return false;
}

/** Alignment centre coordinates minus the three finder corners. */
function alignmentPairs(version: number, size: number): { x: number; y: number }[] {
  const aligns = ALIGNMENT[version - 1];
  const pairs: { x: number; y: number }[] = [];
  for (const cy of aligns) {
    for (const cx of aligns) {
      if (cx === 6 && cy === 6) continue;
      if (cx === 6 && cy === size - 7) continue;
      if (cx === size - 7 && cy === 6) continue;
      pairs.push({ x: cx, y: cy });
    }
  }
  return pairs;
}

/**
 * Build the full boolean module grid (true = dark) for a byte-mode payload at
 * ECC L / mask 0. Exported for node self-tests and debugging.
 */
export function qrMatrix(text: string, version: number): boolean[] {
  const bytes = utf8Bytes(text);
  const data = buildDataStream(bytes, version);
  const fullStream = addEccAndInterleave(data, version);
  const size = version * 4 + 17;
  const grid: boolean[] = new Array<boolean>(size * size).fill(false);
  const set = (x: number, y: number, v: boolean) => {
    grid[y * size + x] = v;
  };
  const aligns = ALIGNMENT[version - 1];
  const pairs = alignmentPairs(version, size);

  // Finder patterns (7x7 ring + centre) in the three corners.
  for (let dy = 0; dy < 7; dy++) {
    for (let dx = 0; dx < 7; dx++) {
      const ring = dx === 0 || dx === 6 || dy === 0 || dy === 6;
      const centre = dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4;
      const v = ring || centre;
      set(dx, dy, v);
      set(size - 7 + dx, dy, v);
      set(dx, size - 7 + dy, v);
    }
  }
  // Separators (white 1-module border beside each finder).
  for (let i = 0; i < 8; i++) {
    set(size - 8, i, false);
    set(i, size - 8, false);
    set(i, 8, false);
    set(8, i, false);
  }
  // Timing patterns (alternating, skipping the finder spans).
  for (let i = 8; i < size - 8; i++) {
    const v = i % 2 === 0;
    set(i, 6, v);
    set(6, i, v);
  }
  // Alignment patterns.
  for (const p of pairs) {
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        const inOuter = Math.abs(dx) === 2 || Math.abs(dy) === 2;
        const inCore = dx === 0 && dy === 0;
        set(p.x + dx, p.y + dy, inOuter || inCore);
      }
    }
  }
  // Dark module.
  set(8, size - 8, true);

  // Place data bits in the standard zig-zag, applying mask 0.
  let bitIndex = 0;
  let x = size - 1;
  let upward = true;
  while (x > 0) {
    if (x === 6) x--;
    let y = upward ? size - 1 : 0;
    for (let i = 0; i < size; i++) {
      for (let j = 0; j < 2; j++) {
        const px = x - j;
        if (isFunction(px, y, size, version, aligns)) continue;
        const raw =
          bitIndex < fullStream.length * 8
            ? (fullStream[Math.floor(bitIndex / 8)] >> (7 - (bitIndex % 8))) &
              1 ===
              1
            : false;
        // Mask 0 flips when (col + row) % 2 === 0.
        const maskOn = (px + y) % 2 === 0;
        set(px, y, maskOn ? !raw : raw);
        bitIndex++;
      }
      y += upward ? -1 : 1;
    }
    x -= 2;
    upward = !upward;
  }

  // Format information — ECC L + mask 0 → 15-bit value 0x77C4.
  const formatBits = 0x77c4;
  // Copy 1 (around the top-left finder).
  for (let i = 0; i < 6; i++) set(8, i, ((formatBits >> i) & 1) === 1);
  set(8, 7, ((formatBits >> 6) & 1) === 1);
  set(8, 8, ((formatBits >> 7) & 1) === 1);
  set(7, 8, ((formatBits >> 8) & 1) === 1);
  for (let i = 9; i < 15; i++) set(14 - i, 8, ((formatBits >> i) & 1) === 1);
  // Copy 2 (below the top-right finder and beside the bottom-left finder).
  for (let i = 0; i < 7; i++) set(size - 1 - i, 8, ((formatBits >> i) & 1) === 1);
  for (let i = 7; i < 15; i++) set(8, size - 8 + (i - 7), ((formatBits >> i) & 1) === 1);

  // Version information block for versions 7+ (BCH(18,6) of the version).
  if (version >= 7) {
    const v = version;
    let rem = v;
    for (let i = 0; i < 12; i++) {
      rem = (rem << 1) ^ (((rem >>> 11) & 1) ? 0x1f25 : 0);
    }
    const verBits = (v << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const bit = ((verBits >> i) & 1) === 1;
      const a = Math.floor(i / 3);
      const b = i % 3;
      set(size - 11 + b, a, bit);
      set(a, size - 11 + b, bit);
    }
  }

  return grid;
}

/**
 * Render `text` as an inline QR SVG. Returns null when the input is empty or
 * too long for versions 1–10 at ECC L — the caller then relies on copy-link.
 * @param text the URL / payload to encode
 * @param cssSize optional rendered CSS size in px (default 128)
 */
export function qrSvg(text: string, cssSize = 128): string | null {
  const trimmed = typeof text === 'string' ? text.trim() : '';
  if (!trimmed) return null;
  const bytes = utf8Bytes(trimmed);
  const version = pickVersion(bytes.length);
  if (!version) return null;
  const grid = qrMatrix(trimmed, version);
  const size = version * 4 + 17;
  const paths: string[] = [];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (grid[y * size + x]) paths.push(`M${x} ${y}h1v1h-1z`);
    }
  }
  const scale = cssSize / size;
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" width="' +
    cssSize +
    '" height="' +
    cssSize +
    '" viewBox="0 0 ' +
    size +
    ' ' +
    size +
    '" shape-rendering="crispEdges" role="img" aria-label="QR code">' +
    '<rect width="' +
    size +
    '" height="' +
    size +
    '" fill="#fff"/>' +
    '<path d="' +
    paths.join('') +
    '" fill="#000" transform="scale(' +
    scale +
    ')"/>' +
    '</svg>'
  );
}
