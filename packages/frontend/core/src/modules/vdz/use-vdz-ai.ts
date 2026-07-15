import { cdzApiUrl } from '@affine/core/blocksuite/ai/provider/ai-provider';
import { useCallback, useRef, useState } from 'react';

import type { VdzTimeline } from './schema';

/**
 * Schema defaults — a field equal to its default carries no information for the
 * model, so we omit it from the wire payload (see {@link compactTimeline}). Kept
 * in sync with `vdzTimelineSchema` (fps 30 / 1920×1080).
 */
const TIMELINE_DEFAULTS = { fps: 30, width: 1920, height: 1080 } as const;

/**
 * Soft cap on the serialized timeline we send (~256 KB of JSON). Well beyond any
 * realistic hand-built project, but a guard against a pathological doc blowing
 * up the request / model context. We never silently truncate to invalid JSON —
 * past the cap we drop each clip's optional `effects`/`animation` (the heaviest,
 * most repetitive fields) and, if still over, omit `transitions`.
 */
const MAX_TIMELINE_JSON_BYTES = 256 * 1024;

/**
 * Produce a wire-minimal copy of a timeline for the chat payload: strip fields
 * that equal their schema default or are empty/undefined so the model sees only
 * signal. Smaller payload → less to serialize, upload and tokenize → faster
 * turnaround. The result is a plain JSON-safe object (NOT a `VdzTimeline` — it
 * is intentionally lossy on defaults) and the SERVER re-hydrates defaults via
 * the same Zod schema, so the contract is unchanged.
 *
 * Omissions: `fps`/`width`/`height` when default; `name` when empty on a
 * track/clip (timeline `name` is kept — it is meaningful context); empty
 * `transitions: []`; and any `undefined` optional (via JSON round-trip).
 */
export function compactTimeline(timeline: VdzTimeline): Record<string, unknown> {
  const out: Record<string, unknown> = {
    version: timeline.version,
    id: timeline.id,
    name: timeline.name,
  };
  if (timeline.fps !== TIMELINE_DEFAULTS.fps) out.fps = timeline.fps;
  if (timeline.width !== TIMELINE_DEFAULTS.width) out.width = timeline.width;
  if (timeline.height !== TIMELINE_DEFAULTS.height) {
    out.height = timeline.height;
  }

  out.tracks = timeline.tracks.map(track => {
    const t: Record<string, unknown> = {
      id: track.id,
      kind: track.kind,
      // Drop a name that just echoes the kind (e.g. "Video") — no signal.
      clips: track.clips.map(clip => compactValue(clip)),
    };
    if (track.name && track.name !== track.kind) t.name = track.name;
    if (track.transitions && track.transitions.length > 0) {
      t.transitions = track.transitions;
    }
    return t;
  });

  return out;
}

/** JSON round-trip drops `undefined` keys; also trims empty `name` on clips. */
function compactValue(clip: Record<string, unknown>): Record<string, unknown> {
  const copy = JSON.parse(JSON.stringify(clip)) as Record<string, unknown>;
  if (copy.name === '' || copy.name == null) delete copy.name;
  return copy;
}

/**
 * Serialize the compacted timeline, shedding the heaviest optional fields if it
 * exceeds {@link MAX_TIMELINE_JSON_BYTES}. Always returns valid JSON.
 */
function serializeTimelineForWire(timeline: VdzTimeline): Record<
  string,
  unknown
> {
  const compact = compactTimeline(timeline);
  if (JSON.stringify(compact).length <= MAX_TIMELINE_JSON_BYTES) {
    return compact;
  }
  // Over cap: strip per-clip effects/animation (heavy, repetitive).
  const tracks = compact.tracks as Array<Record<string, unknown>>;
  for (const t of tracks) {
    for (const c of t.clips as Array<Record<string, unknown>>) {
      delete c.effects;
      delete c.animation;
    }
  }
  if (JSON.stringify(compact).length <= MAX_TIMELINE_JSON_BYTES) {
    return compact;
  }
  // Still over: drop transitions too.
  for (const t of tracks) delete t.transitions;
  return compact;
}

/**
 * React hook powering the Vdz Studio "AI Dock".
 *
 * Owns the transport + conversation state for the dock; it deliberately does
 * NOT validate or apply ops — that stays with the dock component (which runs
 * `vdzOpSchema.safeParse` per op) and the host (which applies them through the
 * timeline's single `applyOps` path). This keeps the hook a thin, testable
 * fetch wrapper.
 *
 * Desktop parity: the request URL is wrapped with {@link cdzApiUrl} so it
 * resolves against the connected server on desktop/native (where a bare
 * `/api/...` would hit the app bundle) and stays relative on web. (PR #28.)
 */

/** A chat turn we keep in the dock thread and forward as history. */
export interface VdzChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * Which behavior the dock asks the model for on a turn:
 *  • 'edit'        — the default: return `{summary, ops}` timeline edits.
 *  • 'plan'        — return `{summary, plan: [{step, action}]}` (a how-to plan).
 *  • 'suggestions' — return `{summary, suggestions: string[]}` (idea prompts).
 * The server treats an unknown/absent mode as 'edit', and all three responses
 * are supersets of the edit envelope, so an older server that ignores `mode`
 * still returns a valid `{summary, ops}` we handle gracefully.
 */
export type VdzChatMode = 'edit' | 'plan' | 'suggestions';

/** One step of an AI-authored plan (plan mode). */
export interface VdzPlanStep {
  /** Short imperative step title (e.g. "Upload your product footage"). */
  step: string;
  /** The concrete edit-mode message this step sends when the user runs it. */
  action: string;
}

/**
 * The server's chat response envelope. `ops` stay opaque until the dock
 * validates them; `plan` / `suggestions` are OPTIONAL and only present for the
 * matching mode (parsed defensively — a missing or malformed field degrades to
 * undefined / [] rather than throwing).
 */
export interface VdzChatResponse {
  summary: string;
  ops: unknown[];
  /** Present (and non-empty) only for a successful plan-mode turn. */
  plan?: VdzPlanStep[];
  /** Present (and non-empty) only for a successful suggestions-mode turn. */
  suggestions?: string[];
  /** Present only when the model returned something unparseable. */
  raw?: string;
}

/**
 * Defensively coerce an unknown value into a `VdzPlanStep[]`. Accepts the strict
 * `{step, action}` shape and also tolerates `{title/action}` or bare strings so
 * a slightly-off model reply still yields a usable checklist. Returns undefined
 * when nothing plan-shaped is present (so callers can treat the turn as normal).
 */
function coercePlan(value: unknown): VdzPlanStep[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const steps: VdzPlanStep[] = [];
  for (const entry of value) {
    if (typeof entry === 'string') {
      const step = entry.trim();
      if (step) steps.push({ step, action: step });
      continue;
    }
    if (entry && typeof entry === 'object') {
      const obj = entry as Record<string, unknown>;
      const step =
        typeof obj.step === 'string'
          ? obj.step.trim()
          : typeof obj.title === 'string'
            ? obj.title.trim()
            : '';
      const action =
        typeof obj.action === 'string' && obj.action.trim()
          ? obj.action.trim()
          : step;
      if (step) steps.push({ step, action });
    }
  }
  return steps.length ? steps : undefined;
}

/** Defensively coerce an unknown value into a non-empty `string[]` or undefined. */
function coerceSuggestions(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value
    .map(v => (typeof v === 'string' ? v.trim() : ''))
    .filter(v => v.length > 0);
  return out.length ? out : undefined;
}

/** What {@link useVdzAi} exposes to the dock. */
export interface UseVdzAi {
  /** Prior turns, oldest→newest, forwarded as history on the next send. */
  history: VdzChatTurn[];
  /** True while a request is in flight. */
  busy: boolean;
  /** Last error message, or null. */
  error: string | null;
  /**
   * Send a user message with the current timeline + selection. Resolves with
   * the parsed `{summary, ops, plan?, suggestions?}` envelope, or null if the
   * request failed or was aborted. Appends the user turn (and, on success, an
   * assistant summary turn) to {@link history}. `mode` selects the response
   * contract the server should follow (defaults to 'edit').
   */
  send: (
    message: string,
    timeline: VdzTimeline,
    selectedClipIds?: string[],
    mode?: VdzChatMode
  ) => Promise<VdzChatResponse | null>;
  /** Abort an in-flight request, if any. */
  cancel: () => void;
  /** Clear the conversation thread and any error. */
  reset: () => void;
}

/** Max turns of history we forward (mirrors the server cap). */
const MAX_HISTORY_TURNS = 20;

export function useVdzAi(): UseVdzAi {
  const [history, setHistory] = useState<VdzChatTurn[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  // Keep a ref mirror of history so `send` can read the latest turns without
  // being re-created on every message (stable identity for callers).
  const historyRef = useRef<VdzChatTurn[]>([]);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setBusy(false);
  }, []);

  const reset = useCallback(() => {
    cancel();
    historyRef.current = [];
    setHistory([]);
    setError(null);
  }, [cancel]);

  const send = useCallback(
    async (
      message: string,
      timeline: VdzTimeline,
      selectedClipIds?: string[],
      mode: VdzChatMode = 'edit'
    ): Promise<VdzChatResponse | null> => {
      const trimmed = message.trim();
      if (!trimmed || busy) return null;

      // Cancel any prior in-flight request before starting a new one.
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      // Snapshot history to forward, then optimistically append the user turn.
      const priorHistory = historyRef.current.slice(-MAX_HISTORY_TURNS);
      const userTurn: VdzChatTurn = { role: 'user', content: trimmed };
      historyRef.current = [...historyRef.current, userTurn];
      setHistory(historyRef.current);
      setBusy(true);
      setError(null);

      try {
        const response = await fetch(cdzApiUrl('/api/v1/vdz/chat'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message: trimmed,
            // Compacted: default fps/size, empty names and empty transition
            // arrays are stripped (the server re-hydrates via the same Zod
            // schema, so the contract is unchanged) — smaller, faster payload.
            timeline: serializeTimelineForWire(timeline),
            selectedClipIds: selectedClipIds ?? [],
            history: priorHistory,
            // Which response contract to request. An older server ignores this
            // and still returns {summary, ops}, which we handle transparently.
            mode,
          }),
          signal: controller.signal,
        });

        const data = (await response.json().catch(() => null)) as
          | (Partial<VdzChatResponse> & {
              error?: { message?: string };
            })
          | null;

        if (!response.ok) {
          throw new Error(
            data?.error?.message || `Vdz AI request failed (${response.status})`
          );
        }

        const summary =
          typeof data?.summary === 'string' && data.summary.trim()
            ? data.summary.trim()
            : 'Proposed timeline edit';
        const ops = Array.isArray(data?.ops) ? data.ops : [];
        const raw = typeof data?.raw === 'string' ? data.raw : undefined;
        // Optional, mode-specific fields — coerced defensively so a malformed
        // or absent field never throws (it simply degrades to undefined).
        const plan = coercePlan(data?.plan);
        const suggestions = coerceSuggestions(data?.suggestions);

        // Record the assistant summary as a history turn for context on the
        // next send (the op JSON itself is not fed back — the timeline is).
        const assistantTurn: VdzChatTurn = {
          role: 'assistant',
          content: summary,
        };
        historyRef.current = [...historyRef.current, assistantTurn];
        setHistory(historyRef.current);

        return { summary, ops, plan, suggestions, raw };
      } catch (err) {
        // A user-initiated abort is not an error to surface.
        if (controller.signal.aborted) {
          return null;
        }
        const messageText =
          err instanceof Error ? err.message : 'Vdz AI request failed';
        setError(messageText);
        return null;
      } finally {
        if (abortRef.current === controller) {
          abortRef.current = null;
        }
        setBusy(false);
      }
    },
    [busy]
  );

  return { history, busy, error, send, cancel, reset };
}
