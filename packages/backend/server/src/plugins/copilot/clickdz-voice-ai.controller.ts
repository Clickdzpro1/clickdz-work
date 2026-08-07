import { Body, Controller, Post } from '@nestjs/common';

// Typed AFFiNE errors so the global exception filter emits proper 4xx/5xx (a
// raw @nestjs/common HttpException is coerced to a generic 500 by base/nestjs/
// exception.ts). NotFound = the gated-OFF "feature disabled" 404 — the SAME
// stance the sibling clickdz-vpic controller takes for its master gate;
// BadRequest = a bad body (missing/oversized text); InternalServerError = an
// unconfigured or failed engine (a server-side precondition). Throttle = the
// house rate-limit decorator, the SAME one the peer vdz/vpic controllers use.
import {
  BadRequest,
  InternalServerError,
  NotFound,
  Throttle,
} from '../../base';
// CurrentUser decorates + types the cookie-session user, from core/auth like
// every peer. These are FIRST-PARTY web-app routes (NOT @Public): the global
// AuthGuard requires a signed-in session, exactly like the vdz dock.
import { CurrentUser } from '../../core/auth';
import {
  buildVoiceScriptTurn,
  MAX_VOICE_SCRIPT_INPUT_CHARS,
  MAX_VOICE_TONE_CHARS,
  VOICE_SCRIPT_SYSTEM_PROMPT,
  type VoiceScriptLang,
  type VoiceScriptMode,
} from './clickdz-voice-prompt';

// ---------------------------------------------------------------------------
// CDZ VOICE AI — AI SCRIPT WRITER for Voice Studio.
//
//   · POST /api/v1/voice/script — turn a brief into a narration-ready script,
//     clean a rough transcript, or condense one. Body:
//       { mode?: 'write'|'clean'|'summarize',
//         text: string,
//         lang?: 'fr'|'ar'|'darija'|'auto',
//         tone?: string,
//         seconds?: number }
//     Returns { script }. Session-authed, @Throttle('strict') (a paid model
//     call), never streams (short output), fail-soft typed errors.
//
// GATE: CDZ_VOICE_AI_ENABLED. OFF (unset / not '1') ⇒ a typed 404, byte-
// identical to the route not existing — so merging + shipping this controller
// is inert until the owner flips the flag. This mirrors the vpic controller's
// assertEnabled() stance exactly.
//
// ENGINE: the SAME cdz-ai direct fast path the vdz dock uses — a direct
// OpenAI-compatible POST to `${CDZ_AI_BASE_URL}/v1/chat/completions` with model
// `cdz-flash` and `Bearer CDZ_AI_KEY`. The bridge does not export these helpers,
// so the minimal call shape is duplicated here (the backend must compile without
// importing the frontend and we do NOT edit the bridge controller). No Make
// fallback: the script writer fails fast with a typed 5xx if the direct model
// is down (a script pass is optional UX, not a load-bearing path).
// ---------------------------------------------------------------------------

// Master gate (read once at module load — env is fixed for the process).
const CDZ_VOICE_AI_ENABLED = process.env.CDZ_VOICE_AI_ENABLED || '';

// Engine config — the SAME env consts the vdz controller reads, normalized the
// SAME way (strip trailing slashes THEN a trailing `/v1`, because every call
// site appends `/v1/chat/completions`; production sets the base URL with a `/v1`
// suffix, which would otherwise produce `.../v1/v1/...` → 404).
const CDZ_AI_BASE_URL = (process.env.CDZ_AI_BASE_URL || 'https://api.clickdz.ai')
  .replace(/\/+$/, '')
  .replace(/\/v1$/, '');
const CDZ_AI_KEY = process.env.CDZ_AI_KEY || '';
// The fast model for a short script pass. Overridable via env, default cdz-flash
// (the same model the vdz dock uses on its direct fast path).
const VOICE_FAST_MODEL = process.env.CDZ_FAST_MODEL || 'cdz-flash';

// Output/response bounds. A narration script is short; keep the token budget
// tight and the timeout well under the bridge's 240s so the panel fails fast.
const VOICE_MODEL_MAX_TOKENS = 1_200;
const VOICE_MODEL_TIMEOUT_MS = 60_000;
// Upper bound on the target-duration hint (10 minutes). Beyond this the length
// target is meaningless for a single TTS read.
const MAX_VOICE_SECONDS = 600;

// Allowlists for the enum-ish body fields (defensive — an unknown value falls
// back to the safe default rather than reaching the model).
const VOICE_MODES: readonly VoiceScriptMode[] = ['write', 'clean', 'summarize'];
const VOICE_LANGS: readonly VoiceScriptLang[] = ['fr', 'ar', 'darija', 'auto'];

@Controller()
export class ClickDzVoiceAiController {
  /**
   * Typed 404 when the master gate is off — never leaks that the route exists.
   * Mirrors the vpic controller's assertEnabled() exactly.
   */
  private assertEnabled(): void {
    if (CDZ_VOICE_AI_ENABLED !== '1') {
      throw new NotFound('Voice AI is not enabled');
    }
  }

  // POST /api/v1/voice/script — narration script writer. Session-authed
  // (global guard, no @Public — like the vdz dock), @Throttle('strict') (a paid
  // model call), gated by assertEnabled (typed 404 when off). Validates + caps
  // the input at the edge, then calls the cdz-ai direct fast path and returns
  // the raw spoken script. Fail-soft: a missing key / failed / empty upstream
  // surfaces a typed 5xx, never a bare 500.
  @Throttle('strict')
  @Post('/api/v1/voice/script')
  async script(
    @CurrentUser() _user: CurrentUser,
    @Body() body: unknown
  ): Promise<{ script: string }> {
    this.assertEnabled();

    if (!CDZ_AI_KEY) {
      throw new InternalServerError('Voice AI engine is not configured');
    }

    const payload = (body ?? {}) as Record<string, unknown>;

    const text = typeof payload.text === 'string' ? payload.text.trim() : '';
    if (!text) {
      throw new BadRequest('A non-empty "text" is required');
    }
    if (text.length > MAX_VOICE_SCRIPT_INPUT_CHARS) {
      throw new BadRequest(
        `"text" is too long (max ${MAX_VOICE_SCRIPT_INPUT_CHARS} characters)`
      );
    }

    const mode: VoiceScriptMode =
      typeof payload.mode === 'string' &&
      (VOICE_MODES as readonly string[]).includes(payload.mode)
        ? (payload.mode as VoiceScriptMode)
        : 'write';
    const lang: VoiceScriptLang =
      typeof payload.lang === 'string' &&
      (VOICE_LANGS as readonly string[]).includes(payload.lang)
        ? (payload.lang as VoiceScriptLang)
        : 'auto';
    const tone =
      typeof payload.tone === 'string'
        ? payload.tone.slice(0, MAX_VOICE_TONE_CHARS)
        : '';
    const seconds =
      typeof payload.seconds === 'number' &&
      Number.isFinite(payload.seconds) &&
      payload.seconds > 0
        ? Math.min(payload.seconds, MAX_VOICE_SECONDS)
        : undefined;

    const messages = [
      { role: 'system', content: VOICE_SCRIPT_SYSTEM_PROMPT },
      {
        role: 'user',
        content: buildVoiceScriptTurn({ mode, text, lang, tone, seconds }),
      },
    ];

    let response: Response | null;
    try {
      response = (await fetch(`${CDZ_AI_BASE_URL}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${CDZ_AI_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: VOICE_FAST_MODEL,
          messages,
          max_tokens: VOICE_MODEL_MAX_TOKENS,
        }),
        signal: AbortSignal.timeout(VOICE_MODEL_TIMEOUT_MS),
      })) as unknown as Response;
    } catch {
      throw new InternalServerError('Voice AI engine request failed');
    }

    const data = (await response.json().catch(() => null)) as {
      choices?: Array<{ message?: { content?: unknown } }>;
    } | null;
    const out = data?.choices?.[0]?.message?.content;
    if (!response.ok || typeof out !== 'string' || !out.trim()) {
      throw new InternalServerError('Voice AI produced no script');
    }
    return { script: out.trim() };
  }
}
