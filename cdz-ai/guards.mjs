const DEFAULT_MAX_TOKENS = 4000;
const MAX_MAX_TOKENS = 16000;
const MAX_REMOTE_URL_LENGTH = 2048;

const FILE_URL_FEATURES = new Set([
  'ocr_describe',
  'ocr_detect_objects',
  'ocr_extract_doc',
  'ocr_caption',
  'ocr_caption_adv',
  'ocr_invoice',
  'ocr_receipt',
  'ocr_tags',
  'ocr_audio',
]);

function invalid(message) {
  return Object.assign(new Error(message), { status: 400 });
}

function isPrivateIpv4(hostname) {
  const parts = hostname.split('.');
  if (parts.length !== 4 || parts.some(part => !/^\d+$/.test(part))) {
    return false;
  }
  const octets = parts.map(Number);
  if (octets.some(n => n < 0 || n > 255)) return true;
  const [a, b] = octets;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function isPrivateIpv6(hostname) {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host.includes(':')) return false;
  if (host === '::' || host === '::1') return true;
  if (
    host.startsWith('fc') ||
    host.startsWith('fd') ||
    host.startsWith('fe8') ||
    host.startsWith('fe9') ||
    host.startsWith('fea') ||
    host.startsWith('feb')
  ) {
    return true;
  }
  if (host.startsWith('::ffff:')) {
    const suffix = host.slice('::ffff:'.length);
    const dotted = suffix.match(/(\d+\.\d+\.\d+\.\d+)$/)?.[1];
    if (dotted) return isPrivateIpv4(dotted);
    const parts = suffix.split(':').filter(Boolean);
    if (parts.length >= 2) {
      const high = Number.parseInt(parts.at(-2), 16);
      const low = Number.parseInt(parts.at(-1), 16);
      if (Number.isFinite(high) && Number.isFinite(low)) {
        return isPrivateIpv4(
          [high >> 8, high & 255, low >> 8, low & 255].join('.')
        );
      }
    }
    return true;
  }
  return false;
}

export function normalizeMaxTokens(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_MAX_TOKENS;
  return Math.min(Math.max(Math.trunc(parsed), 1), MAX_MAX_TOKENS);
}

export function assertPublicHttpUrl(value, field = 'url') {
  if (typeof value !== 'string' || !value.trim()) {
    throw invalid(`${field} is required`);
  }
  if (value.length > MAX_REMOTE_URL_LENGTH) {
    throw invalid(`${field} is too long`);
  }

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw invalid(`${field} must be a valid public HTTP(S) URL`);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw invalid(`${field} must use HTTP or HTTPS`);
  }
  if (parsed.username || parsed.password) {
    throw invalid(`${field} must not contain credentials`);
  }

  const hostname = parsed.hostname
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '')
    .toLowerCase();
  if (
    !hostname ||
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal') ||
    hostname.endsWith('.lan') ||
    hostname.endsWith('.home') ||
    isPrivateIpv4(hostname) ||
    isPrivateIpv6(hostname)
  ) {
    throw invalid(`${field} must resolve to a public host`);
  }

  return parsed.toString();
}

export function validateEngineFields(feature, fields = {}) {
  if (feature === 'ocr_extract_text') {
    return {
      ...fields,
      image_url: assertPublicHttpUrl(fields.image_url, 'image_url'),
    };
  }
  if (FILE_URL_FEATURES.has(feature)) {
    return {
      ...fields,
      file_url: assertPublicHttpUrl(fields.file_url, 'file_url'),
    };
  }
  return fields;
}
