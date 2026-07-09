/** Serves the CDZ AI documentation / marketing page (docs.html). */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dir = dirname(fileURLToPath(import.meta.url));
const WHATSAPP =
  'https://wa.me/213558794243?text=' +
  encodeURIComponent("Hi ClickDz — I'd like a CDZ AI API key.");

let TEMPLATE = '';
try {
  TEMPLATE = readFileSync(join(__dir, 'docs.html'), 'utf8');
} catch {
  TEMPLATE = '<!DOCTYPE html><title>CDZ AI</title><h1>CDZ AI</h1>';
}

/** Returns the full HTML page, wired to the requesting host + WhatsApp CTA. */
export function docsPage(host = 'api.clickdz.ai') {
  const safeHost = String(host).replace(/[^a-z0-9.\-:]/gi, '') || 'api.clickdz.ai';
  return TEMPLATE.replaceAll('__HOST__', safeHost).replaceAll('__WA__', WHATSAPP);
}
