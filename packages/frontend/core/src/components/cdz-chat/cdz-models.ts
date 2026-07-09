/**
 * CDZ model registry — the single source of truth for the models offered in
 * the CDZ chat selectors (sidechat ai-chat-input + main claude-style-chat-input).
 *
 * Each entry maps a display label to a real CDZ AI model id served by
 * api.clickdz.ai / cdz-ai-production.up.railway.app (OpenAI-compatible).
 *
 * The 7 cdz-* "supermodels" (from cdz-ai/index.mjs SUPERMODELS):
 *   cdz-ultra     — smart router (auto-selects best vendor)
 *   cdz-council   — real 3-vendor fan-out (Claude + GPT + Gemini) + synthesis
 *   cdz-sage      — Claude Opus 4.8 (deepest reasoning)
 *   cdz-architect — GPT-5.5 (code / structured output)
 *   cdz-scholar   — Gemini 3.1 Pro (knowledge / long context / vision)
 *   cdz-flash     — Gemini 3.5 Flash (fast / cheap)
 *   cdz-polyglot  — GPT-5.4 (multilingual)
 *
 * `kind` discriminates special dispatch behavior:
 *   - 'model'    -> single-model chat completion (POST /v1/chat/completions)
 *   - 'council'  -> multi-vendor fan-out (same endpoint, model=cdz-council)
 *   - 'workers'  -> opens the Workers picker (502 skills) instead of sending
 *
 * Badges drive the per-model accent color via the --cdz-badge-* tokens.
 */

export type CdModelKind = 'model' | 'council' | 'workers';

export interface CdzModelOption {
  /** CDZ AI model id sent to the API (e.g. 'cdz-ultra'). For 'workers' this is a sentinel. */
  id: string;
  /** Display label shown in the selector (MorphingText). */
  label: string;
  /** One-line description for tooltips / accessibility. */
  description: string;
  /** Dispatch behavior. */
  kind: CdzModelKind;
  /** Badge color token name (maps to --cdz-badge-*). */
  badge: string;
  /** Optional vendor glyph key for the model icon. */
  vendor?: 'anthropic' | 'openai' | 'google' | 'cdz';
}

/**
 * The default model list shown in the sidechat selector, in display order.
 * Council and Workers are appended as special dispatch entries so the user can
 * reach them from the same control.
 */
export const CDZ_MODELS: CdzModelOption[] = [
  {
    id: 'cdz-ultra',
    label: 'CDZ Ultra',
    description: 'Smart router — auto-selects the best model for the task.',
    kind: 'model',
    badge: 'badge-ultra',
    vendor: 'cdz',
  },
  {
    id: 'cdz-council',
    label: 'CDZ Council',
    description: '3-vendor fan-out (Claude + GPT + Gemini) with synthesis.',
    kind: 'council',
    badge: 'badge-council',
    vendor: 'cdz',
  },
  {
    id: 'cdz-sage',
    label: 'CDZ Sage',
    description: 'Claude Opus 4.8 — deepest reasoning & research.',
    kind: 'model',
    badge: 'badge-sage',
    vendor: 'anthropic',
  },
  {
    id: 'cdz-architect',
    label: 'CDZ Architect',
    description: 'GPT-5.5 — code generation & structured output.',
    kind: 'model',
    badge: 'badge-architect',
    vendor: 'openai',
  },
  {
    id: 'cdz-scholar',
    label: 'CDZ Scholar',
    description: 'Gemini 3.1 Pro — knowledge, long context & vision.',
    kind: 'model',
    badge: 'badge-scholar',
    vendor: 'google',
  },
  {
    id: 'cdz-flash',
    label: 'CDZ Flash',
    description: 'Gemini 3.5 Flash — fastest, most affordable.',
    kind: 'model',
    badge: 'badge-flash',
    vendor: 'google',
  },
  {
    id: 'cdz-polyglot',
    label: 'CDZ Polyglot',
    description: 'GPT-5.4 — multilingual & translation.',
    kind: 'model',
    badge: 'badge-polyglot',
    vendor: 'openai',
  },
];

/** Effort levels for the sidechat effort selector (unchanged from upstream). */
export const CDZ_EFFORTS = ['Low', 'Medium', 'Max Effort'] as const;
export type CdzEffort = (typeof CDZ_EFFORTS)[number];

/** Default selected model id. */
export const CDZ_DEFAULT_MODEL_ID = 'cdz-ultra';

/** Find a model option by id. */
export function getCdzModel(id: string): CdzModelOption | undefined {
  return CDZ_MODELS.find(m => m.id === id);
}
