/**
 * CDZ AI provider bootstrap — idempotent, fail-safe.
 *
 * Runs before the server starts. If CDZ_AI_KEY is set, it merges a
 * `cdz-ai` OpenAI-compatible copilot provider profile (pointing at CDZ AI)
 * into the on-volume config at ~/.affine/config/config.json, scoped to the
 * 7 cdz-* supermodel ids only. Preserves everything else in the file.
 *
 * Never throws: any failure logs a warning and lets the server boot with
 * whatever config already exists (safe rollback = unset the env var).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const KEY = process.env.CDZ_AI_KEY || '';
const BASE_URL =
  process.env.CDZ_AI_BASE_URL || 'https://cdz-ai-production.up.railway.app/v1';
const CDZ_MODELS = [
  'cdz-ultra',
  'cdz-council',
  'cdz-sage',
  'cdz-architect',
  'cdz-scholar',
  'cdz-flash',
  'cdz-polyglot',
];

function main() {
  if (!KEY) {
    console.log('[cdz-ai-config] CDZ_AI_KEY not set — skipping provider bootstrap.');
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
  const profiles = Array.isArray(cfg.copilot.providers.profiles)
    ? cfg.copilot.providers.profiles.filter(p => p && p.id !== 'cdz-ai')
    : [];
  profiles.push({
    id: 'cdz-ai',
    type: 'openai',
    priority: 100,
    enabled: true,
    models: CDZ_MODELS,
    config: {
      apiKey: KEY,
      baseURL: BASE_URL,
      oldApiStyle: true, // CDZ AI speaks classic chat-completions, not Responses
    },
  });
  cfg.copilot.providers.profiles = profiles;

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(cfg, null, 2), 'utf8');
  console.log(
    `[cdz-ai-config] wrote cdz-ai provider profile -> ${path} (${CDZ_MODELS.length} models, base ${BASE_URL})`
  );
}

try {
  main();
} catch (e) {
  console.warn('[cdz-ai-config] bootstrap failed (server will start with existing config):', e?.message || e);
}
