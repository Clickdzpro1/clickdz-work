/**
 * CDZ AI provider bootstrap — idempotent, fail-safe.
 *
 * Runs before the server starts and merges copilot provider profiles into
 * the on-volume config at ~/.affine/config/config.json:
 *
 *   - `cdz-ai` (when CDZ_AI_KEY is set): the OpenAI-compatible CDZ AI
 *     platform serving the 7 cdz-* supermodels PLUS the raw engine
 *     passthrough models (Claude Opus 4.8, Gemini 3.1 Pro, GPT 5.5, …) —
 *     all running on the Make engine, no vendor API bills.
 *   - `openai-images` (when OPENAI_IMAGE_API_KEY is set): scoped to
 *     gpt-image-1 ONLY, so every image prompt (edgeless "Generate image",
 *     style filters, upscale/remove-background/sticker) lights up. This is
 *     the same key the in-chat ClickDz 1.0 image button already uses.
 *     NOTE: no `oldApiStyle` here — gpt-image-1 resolves under the
 *     openai_responses backend kind and routes to the OpenAI Images API.
 *
 * Preserves everything else in the file. Never throws: any failure logs a
 * warning and lets the server boot with whatever config already exists
 * (safe rollback = unset the env vars).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const KEY = process.env.CDZ_AI_KEY || '';
const BASE_URL = process.env.CDZ_AI_BASE_URL || 'https://api.clickdz.ai/v1';
const IMAGE_KEY = process.env.OPENAI_IMAGE_API_KEY || '';

const CDZ_MODELS = [
  // supermodels
  'cdz-ultra',
  'cdz-council',
  'cdz-sage',
  'cdz-architect',
  'cdz-scholar',
  'cdz-flash',
  'cdz-polyglot',
  // raw engine passthrough (served by the same CDZ AI endpoint)
  'claude-opus-4-8',
  'claude-sonnet-4-6',
  'claude-haiku-4-5',
  'gemini-3.1-pro-preview',
  'gemini-3.5-flash',
  'gpt-5.5',
  'gpt-5.4',
  'gpt-5.4-mini',
];

const IMAGE_MODELS = ['gpt-image-1'];

function main() {
  if (!KEY && !IMAGE_KEY) {
    console.log(
      '[cdz-ai-config] CDZ_AI_KEY / OPENAI_IMAGE_API_KEY not set — skipping provider bootstrap.'
    );
    return;
  }
  const path = join(homedir(), '.affine', 'config', 'config.json');
  let cfg = {};
  if (existsSync(path)) {
    try {
      cfg = JSON.parse(readFileSync(path, 'utf8')) || {};
    } catch (e) {
      console.warn('[cdz-ai-config] existing config unreadable, starting fresh:', e.message);
      cfg = {};
    }
  }
  cfg.copilot ??= {};
  cfg.copilot.providers ??= {};
  const managedIds = new Set(['cdz-ai', 'openai-images']);
  const profiles = Array.isArray(cfg.copilot.providers.profiles)
    ? cfg.copilot.providers.profiles.filter(p => p && !managedIds.has(p.id))
    : [];
  if (KEY) {
    profiles.push({
      id: 'cdz-ai',
      type: 'openai',
      priority: 100,
      enabled: true,
      models: CDZ_MODELS,
      // Explicit middleware: the default rust.stream chain for `openai` is
      // EMPTY, and the oldApiStyle (chat-completions) decode path delivers
      // answers as one block without stream normalization — killing the
      // progressive typing animation. `stream_event_normalize` splits the
      // chat-completions SSE into canonical per-token deltas and
      // `openai_request_compat` keeps `stream: true` intact on the wire.
      // node.text repeats the provider defaults (setting `middleware`
      // replaces them, so they must be restated to keep citations/callouts).
      middleware: {
        rust: {
          request: ['openai_request_compat'],
          stream: ['stream_event_normalize'],
        },
        node: { text: ['citation_footnote', 'callout'] },
      },
      config: {
        apiKey: KEY,
        baseURL: BASE_URL,
        oldApiStyle: true, // CDZ AI speaks classic chat-completions, not Responses
      },
    });
  }
  if (IMAGE_KEY) {
    profiles.push({
      id: 'openai-images',
      type: 'openai',
      priority: 90,
      enabled: true,
      models: IMAGE_MODELS,
      config: {
        apiKey: IMAGE_KEY,
        // default baseURL (api.openai.com) — Images API lives there
      },
    });
  }
  cfg.copilot.providers.profiles = profiles;

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(cfg, null, 2), 'utf8');
  console.log(
    `[cdz-ai-config] wrote provider profiles -> ${path} ` +
      `(cdz-ai: ${KEY ? `${CDZ_MODELS.length} models @ ${BASE_URL}` : 'off'}, ` +
      `openai-images: ${IMAGE_KEY ? IMAGE_MODELS.join(',') : 'off'})`
  );
}

try {
  main();
} catch (e) {
  console.warn('[cdz-ai-config] bootstrap failed (server will start with existing config):', e?.message || e);
}
