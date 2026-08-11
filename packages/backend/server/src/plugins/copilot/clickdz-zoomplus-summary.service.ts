// ClickDz Work — ZOOM+ meeting-summary service.
//
// Wires up the EXISTING but previously UNWIRED post-call meeting-summary prompt
// (clickdz-zoomplus-prompt.ts) to the cdz-ai direct chat/completions path. Takes
// a meeting transcript + target language, builds the prompt, sends it to
// `cdz-architect` via `${CDZ_AI_BASE_URL}/v1/chat/completions`, parses the strict
// JSON {summary, decisions, actionItems, nextSteps}, and returns the structured
// résumé.
//
// FLAG-GATED + FAIL-OPEN: the whole path is inert until CDZ_ZOOMPLUS_ENABLED=1
// AND a CDZ_AI_KEY is present. Any error (gate off, no key, network, timeout,
// non-2xx, malformed JSON, invalid shape) returns a structured {ok:false,error}
// — the service NEVER throws. Mirrors the fail-closed idiom the peer
// clickdz-agent-memory.ts (L552-660) + clickdz-voice-ai.controller.ts use for
// their CDZ_AI calls.

import { Injectable } from '@nestjs/common';

import {
  buildZoomPlusSummaryTurn,
  MAX_ZOOMPLUS_TRANSCRIPT_CHARS,
  ZOOMPLUS_SUMMARY_SYSTEM_PROMPT,
  type ZoomPlusLang,
} from './clickdz-zoomplus-prompt';

// ---------------------------------------------------------------------------
// Result types — exported so the resolver can type its ObjectTypes against the
// exact shape the service returns.
// ---------------------------------------------------------------------------

/** One action item with an owner + a task. The prompt allows an empty owner. */
export interface ZoomPlusActionItem {
  owner: string;
  task: string;
}

/** The structured summary the model is contracted to return. */
export interface ZoomPlusStructuredSummary {
  summary: string;
  decisions: string[];
  actionItems: ZoomPlusActionItem[];
  nextSteps: string[];
}

/** The service's union result — ok:true carries the summary, ok:false an error. */
export interface ZoomPlusSummaryResult {
  ok: boolean;
  error?: string;
  summary?: ZoomPlusStructuredSummary;
  model?: string;
  lang?: ZoomPlusLang;
  /** Always 1 for v1 (no chunking yet). Present so the frontend can plan. */
  chunksUsed?: number;
  /** True when the transcript exceeded MAX_ZOOMPLUS_TRANSCRIPT_CHARS and was trimmed. */
  truncated?: boolean;
}

// ---------------------------------------------------------------------------
// Engine envs — the SAME normalization the peer CDZ_AI callers use (strip
// trailing slashes THEN a trailing /v1, because production sets the base URL
// with a /v1 suffix). Read once at module load; the ctor does NOT throw on a
// missing key — the gate is re-checked at call time.
// ---------------------------------------------------------------------------

const CDZ_AI_BASE_URL = (process.env.CDZ_AI_BASE_URL || 'https://api.clickdz.ai')
  .replace(/\/+$/, '')
  .replace(/\/v1$/, '')
  .replace(/\/+$/, '');
const CDZ_AI_KEY = process.env.CDZ_AI_KEY || '';

// Master gate — OFF unless explicitly enabled. The service is byte-inert until
// CDZ_ZOOMPLUS_ENABLED=1 (AND a key is present).
const CDZ_ZOOMPLUS_ENABLED = process.env.CDZ_ZOOMPLUS_ENABLED || '';
// The structured-summary model (per the prompt file header). Overridable via env.
const CDZ_ZOOMPLUS_SUMMARY_MODEL =
  process.env.CDZ_ZOOMPLUS_SUMMARY_MODEL || 'cdz-architect';
// Summarization can be slow (long transcript + structured output); allow a
// generous timeout but stay well under the bridge's 240s ceiling.
const CDZ_ZOOMPLUS_SUMMARY_TIMEOUT_MS = Number.parseInt(
  process.env.CDZ_ZOOMPLUS_SUMMARY_TIMEOUT_MS || '',
  10
) || 45_000;

// Token budget for the structured summary. The prompt asks for a tight summary
// + arrays, so 1200 tokens is enough headroom without over-spending.
const ZOOMPLUS_SUMMARY_MAX_TOKENS = 1_200;

@Injectable()
export class ClickDzZoomPlusSummaryService {
  /**
   * Summarize a meeting transcript. Returns a structured result — NEVER throws.
   *
   * Flow:
   *  a. Gate on CDZ_ZOOMPLUS_ENABLED + CDZ_AI_KEY.
   *  b. Cap the transcript to MAX_ZOOMPLUS_TRANSCRIPT_CHARS (with a marker when
   *     truncated; chunking is a future improvement).
   *  c. Build the system prompt (ZOOMPLUS_SUMMARY_SYSTEM_PROMPT.join('\n')).
   *  d. Build the user turn via buildZoomPlusSummaryTurn.
   *  e. POST to cdz-ai chat/completions (model, temperature 0.2, timeout).
   *  f. Parse choices[0].message.content as a STRING, strip accidental fences,
   *     JSON.parse, validate the shape.
   *  g. On success return {ok:true, summary, model, lang, chunksUsed:1, truncated}.
   *  h. FAIL-CLOSED: any error -> {ok:false, error}. Never throws.
   */
  async summarizeMeeting(input: {
    transcript: string;
    lang: ZoomPlusLang;
    title?: string;
  }): Promise<ZoomPlusSummaryResult> {
    // a. Gate — inert until the flag is flipped AND a key is present.
    if (CDZ_ZOOMPLUS_ENABLED !== '1' || !CDZ_AI_KEY) {
      return {
        ok: false,
        error:
          "ZOOM+ summary disabled (set CDZ_ZOOMPLUS_ENABLED=1 + CDZ_AI_KEY)",
      };
    }

    // b. Cap the transcript (v1: truncate with a marker; chunking is future).
    let transcript = input.transcript;
    let truncated = false;
    if (transcript.length > MAX_ZOOMPLUS_TRANSCRIPT_CHARS) {
      truncated = true;
      transcript =
        transcript.slice(0, MAX_ZOOMPLUS_TRANSCRIPT_CHARS) +
        '\n\n[…transcript truncated at ' +
        MAX_ZOOMPLUS_TRANSCRIPT_CHARS +
        ' chars…]';
    }

    // c. System prompt — the array is already joined in the prompt module, but
    // the contract says JOIN with '\n' when sending. ZOOMPLUS_SUMMARY_SYSTEM_PROMPT
    // is exported as a single joined string, so use it directly.
    const systemContent = ZOOMPLUS_SUMMARY_SYSTEM_PROMPT;

    // d. User turn.
    const userContent = buildZoomPlusSummaryTurn({
      transcript,
      lang: input.lang,
      title: input.title,
    });

    // e. Call cdz-ai. Fail-closed on any network/timeout error.
    let response: Response;
    try {
      response = (await fetch(`${CDZ_AI_BASE_URL}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${CDZ_AI_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: CDZ_ZOOMPLUS_SUMMARY_MODEL,
          messages: [
            { role: 'system', content: systemContent },
            { role: 'user', content: userContent },
          ],
          max_tokens: ZOOMPLUS_SUMMARY_MAX_TOKENS,
          temperature: 0.2,
        }),
        signal: AbortSignal.timeout(CDZ_ZOOMPLUS_SUMMARY_TIMEOUT_MS),
      })) as unknown as Response;
    } catch (err) {
      return {
        ok: false,
        error: `Échec de la requête au modèle de résumé (${this.errMsg(err)}).`,
      };
    }

    // f. Parse the OpenAI-compatible envelope. Fail-closed on a non-2xx or a
    // missing/empty content string.
    const data = (await response.json().catch(() => null)) as {
      choices?: Array<{ message?: { content?: unknown } }>;
    } | null;
    const content = data?.choices?.[0]?.message?.content;
    if (!response.ok || typeof content !== 'string' || !content.trim()) {
      return {
        ok: false,
        error:
          "Le modèle n'a pas renvoyé un résumé valide (réponse vide ou non-OK).",
      };
    }

    // Strip accidental markdown fences (```json ... ```) defensively — the
    // prompt forbids them but a model may still emit them.
    const cleaned = content
      .trim()
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/i, '');

    let parsed: unknown;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      return {
        ok: false,
        error:
          "Le modèle n'a pas renvoyé un résumé valide (JSON invalide).",
      };
    }

    // Validate the shape: {summary:string, decisions:string[], actionItems:[{owner,task}], nextSteps:string[]}.
    const summary = this.validateSummary(parsed);
    if (!summary) {
      return {
        ok: false,
        error:
          "Le modèle n'a pas renvoyé un résumé valide (structure JSON incorrecte).",
      };
    }

    // g. Success.
    return {
      ok: true,
      summary,
      model: CDZ_ZOOMPLUS_SUMMARY_MODEL,
      lang: input.lang,
      chunksUsed: 1,
      truncated,
    };
  }

  /**
   * Validate the parsed JSON against the contracted shape. Returns the typed
   * summary or null if the shape is invalid. Never throws.
   */
  private validateSummary(raw: unknown): ZoomPlusStructuredSummary | null {
    if (!raw || typeof raw !== 'object') return null;
    const obj = raw as Record<string, unknown>;

    const summary = typeof obj.summary === 'string' ? obj.summary.trim() : '';
    if (!summary) return null;

    const decisions = Array.isArray(obj.decisions)
      ? obj.decisions
          .map(d => (typeof d === 'string' ? d.trim() : ''))
          .filter(Boolean)
      : [];
    if (!Array.isArray(obj.decisions)) return null;

    const nextSteps = Array.isArray(obj.nextSteps)
      ? obj.nextSteps
          .map(s => (typeof s === 'string' ? s.trim() : ''))
          .filter(Boolean)
      : [];
    if (!Array.isArray(obj.nextSteps)) return null;

    if (!Array.isArray(obj.actionItems)) return null;
    const actionItems: ZoomPlusActionItem[] = [];
    for (const item of obj.actionItems) {
      if (!item || typeof item !== 'object') return null;
      const ai = item as Record<string, unknown>;
      const owner = typeof ai.owner === 'string' ? ai.owner.trim() : '';
      const task = typeof ai.task === 'string' ? ai.task.trim() : '';
      // owner may be empty (the prompt allows it), but task must be non-empty.
      if (!task) continue;
      actionItems.push({ owner, task });
    }

    return { summary, decisions, actionItems, nextSteps };
  }

  /** Coerce an unknown error into a short, safe message (never logs the key). */
  private errMsg(err: unknown): string {
    if (err && typeof err === 'object' && 'name' in err) {
      const name = (err as { name?: unknown }).name;
      if (typeof name === 'string' && name === 'TimeoutError') {
        return 'délai dépassé';
      }
    }
    if (err instanceof Error && err.message) {
      return err.message.slice(0, 120);
    }
    return 'erreur inconnue';
  }
}
