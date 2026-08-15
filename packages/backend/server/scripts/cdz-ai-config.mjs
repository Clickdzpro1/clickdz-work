/**
 * CDZ AI provider bootstrap — idempotent, fail-safe.
 *
 * Runs before the server starts and merges copilot provider profiles into
 * the on-volume config at ~/.affine/config/config.json:
 *
 *   - `cdz-ai` (when CDZ_AI_GATEWAY_KEY is set): the Vercel AI Gateway,
 *     OpenAI-compatible, scoped to the single chat model
 *     `zai/glm-4.6v-flash` (9B vision-language, 128K ctx, streaming).
 *     Mirrors CDZ_CHAT_MODEL in clickdz-bridge.controller.ts so the native
 *     copilot and the REST bridge speak one model on one billing line.
 *   - `openai-images` (when OPENAI_IMAGE_API_KEY is set): scoped to
 *     gpt-image-1/2. Still required after WS14 — Flux is text-to-image
 *     only, so image-to-image and edit actions must land on a gpt-image-*
 *     tier. NOTE: no `oldApiStyle` here — gpt-image-1 resolves under the
 *     openai_responses backend kind and routes to the OpenAI Images API.
 *
 * WS14 removed the legacy Make-engine catalog (the seven cdz- supermodels plus
 * the claude, gemini and gpt passthrough ids) and the Gemini (Nano Banana)
 * image profile. `cdz-gemini-images` stays in `managedIds` below so any profile
 * a previous boot wrote to the config volume is pruned on the next start.
 *
 * CDZ_MODELS is an ALLOWLIST, not a catalog: the Gateway exposes hundreds of
 * models and anything not named here must never reach the copilot registry.
 * Enforcement is two-sided — see CLICKDZ_PROVIDER_MODELS in
 * providers/provider-registry.ts, which filters the same set at load time so
 * a stale DB or volume profile cannot smuggle an extra model back in.
 *
 * Preserves everything else in the file. Never throws: any failure logs a
 * warning and lets the server boot with whatever config already exists
 * (safe rollback = unset the env vars).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

// WS14: credentials mirror clickdz-bridge.controller.ts exactly, so the native
// copilot and the REST bridge share one Gateway key. Deliberately NOT falling
// back to CDZ_AI_KEY / CDZ_AI_BASE_URL — those still hold legacy
// api.clickdz.ai values in some environments, and forwarding a legacy key to
// the Gateway fails auth in a way that reads like a model error.
const KEY =
  process.env.CDZ_AI_GATEWAY_KEY || process.env.CUSTOM_LLM_API_KEY || '';
const BASE_URL =
  process.env.CDZ_AI_GATEWAY_BASE || 'https://ai-gateway.vercel.sh';
const LEGACY_KEY = process.env.CDZ_AI_KEY || '';
const IMAGE_KEY = process.env.OPENAI_IMAGE_API_KEY || '';

// WS14 allowlist — the single chat model. Keep in sync with CDZ_CHAT_MODEL in
// clickdz-bridge.controller.ts and CLICKDZ_PROVIDER_MODELS in
// providers/provider-registry.ts.
const CDZ_MODELS = ['zai/glm-4.6v-flash'];

const IMAGE_MODELS = ['gpt-image-1', 'gpt-image-2'];

function main() {
  // WS14: a legacy-only environment is a misconfiguration, not a no-op. Say so
  // loudly — otherwise the symptom surfaces much later as "native AI has no
  // provider" with nothing in the boot log pointing at the cause.
  if (!KEY && LEGACY_KEY) {
    console.warn(
      '[cdz-ai-config] CDZ_AI_KEY is set but CDZ_AI_GATEWAY_KEY / CUSTOM_LLM_API_KEY is not. ' +
        'WS14 routes the copilot through the Vercel AI Gateway and does NOT forward the legacy ' +
        'key. Set CDZ_AI_GATEWAY_KEY or native copilot chat will have no provider.'
    );
  }
  if (!KEY && !IMAGE_KEY) {
    console.log(
      '[cdz-ai-config] CDZ_AI_GATEWAY_KEY / OPENAI_IMAGE_API_KEY not set — skipping provider bootstrap.'
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
  // `cdz-gemini-images` is still listed even though WS14 no longer writes it:
  // these ids are filtered out before the rebuild, so keeping it here is what
  // prunes a Gemini profile left on the config volume by an earlier boot.
  const managedIds = new Set(['cdz-ai', 'openai-images', 'cdz-gemini-images']);
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
        // The Gateway is OpenAI-compatible on /v1/chat/completions (same path
        // clickdz-bridge.controller.ts posts to), not the Responses API.
        oldApiStyle: true,
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
  // WS14 removed the Gemini (Nano Banana) image profile that used to be built
  // here. Prodia Flux Schnell via the Gateway replaced it at ~1/33rd the cost,
  // and the bridge owns that path (cdzimage-flux -> prodia/flux-fast-schnell),
  // so no Gemini provider profile is written. `cdz-gemini-images` remains in
  // `managedIds` above so a profile from an earlier boot is pruned rather than
  // left behind on the config volume.
  cfg.copilot.providers.profiles = profiles;

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(cfg, null, 2), 'utf8');
  console.log(
    `[cdz-ai-config] wrote provider profiles -> ${path} ` +
      `(cdz-ai: ${KEY ? `${CDZ_MODELS.join(',')} @ ${BASE_URL}` : 'off'}, ` +
      `openai-images: ${IMAGE_KEY ? IMAGE_MODELS.join(',') : 'off'})`
  );
}

try {
  main();
} catch (e) {
  console.warn('[cdz-ai-config] bootstrap failed (server will start with existing config):', e?.message || e);
}
