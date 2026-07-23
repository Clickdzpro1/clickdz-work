import { AgentPalette } from '@affine/core/modules/agents/components';
import {
  AgentApiError,
  type AgentTrigger,
  createTrigger,
  deleteTrigger,
  listTriggers,
  toggleTrigger,
} from '@affine/core/modules/agents/api';
// Locale (R8, WSU-7) owns this i18n module: `useAgentLang()` → { lang, setLang,
// t, dir }. `t(key, vars?)` is fail-soft — an unknown key returns the key
// itself, so any string we haven't catalogued degrades to readable text rather
// than throwing. Consumed by contract name; may not resolve in an isolated
// single-file esbuild check.
import { type TFunc, useAgentLang } from '@affine/core/modules/agents/i18n';
import type { AgentName } from '@affine/core/modules/agents/types';
import {
  ViewBody,
  ViewHeader,
  ViewIcon,
  ViewTitle,
} from '@affine/core/modules/workbench';
import {
  type CSSProperties,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { useSearchParams } from 'react-router-dom';

// ---------------------------------------------------------------------------
// ClickDz Agents — Planification (triggers), full page (route /agents/triggers).
//
// Turns an agent into something that runs ITSELF: on a preset schedule (Horloge's
// cron sweep fires it) or on an inbound webhook POST. This page lists a user's
// triggers per agent (tabs hermes / openclaw), lets them create a scheduled
// trigger (Chaque heure / Chaque jour à HH:MM / Chaque lundi à HH:MM) or a
// webhook trigger, toggle active/paused, delete (with confirm), and copy a
// webhook URL (secret masked in the row; the real URL copied to clipboard,
// shown in full once at creation).
//
// Data (modules/agents/api.ts, mirrors the run-console REST idiom):
//   · listTriggers(agent)                    → AgentTrigger[]   (GET)
//   · createTrigger(agent, {kind,preset?,prompt}) → AgentTrigger (POST)
//   · toggleTrigger(agent, id)               → AgentTrigger     (POST /toggle)
//   · deleteTrigger(agent, id)               → void             (DELETE)
// Every call doubles as a capability probe: a 404 means CDZ_AGENT_TRIGGERS_ENABLED
// (or CDZ_AGENTS_ENABLED) is off, so we show a quiet "Planification non activée"
// fallback instead of an error (flag-off / 404 quiet fallback, per the R7/R8
// rules). Every surface has loading / empty / error states.
//
// Agent selection rides the `?agent=` search param (shareable/bookmarkable),
// default `hermes`. Preset ids are EXACTLY Horloge's contract:
//   'hourly' | 'daily@HH:MM' | 'weekly@D@HH:MM' (D=1=Mon .. 7=Sun).
//
// House rules: inline styles only (no .css.ts), no new deps, shared AgentPalette
// tokens, FR primary + darja via Locale's i18n, mobile single-column, boot-safe.
// Exports BOTH `Component` (the react-router lazy convention every sibling page
// uses) and a default export.
// ---------------------------------------------------------------------------

const C = AgentPalette.color;
const R = AgentPalette.radius;
const mono = AgentPalette.font.mono;

// The agents that own triggers. Kept local (not imported as a runtime const) so
// this file never hard-depends on a registry export — same stance as runs.tsx.
const AGENTS: { id: AgentName; label: string; emoji: string }[] = [
  { id: 'hermes', label: 'Hermes', emoji: '🤝' },
  { id: 'openclaw', label: 'OpenClaw', emoji: '🛠️' },
];

type LoadState = 'loading' | 'ready' | 'error';

// The create-form kind + cadence model. 'cron' triggers carry a preset; the
// picker builds it from a coarse cadence + (daily/weekly) an HH:MM + (weekly) a
// day-of-week. 'webhook' triggers have no schedule (they fire on inbound POST).
type TriggerKind = 'cron' | 'webhook';
type Cadence = 'hourly' | 'daily' | 'weekly';

// Day-of-week options (D = 1..7, Mon..Sun — Horloge's convention).
const DOW_OPTIONS: { value: number; fr: string }[] = [
  { value: 1, fr: 'Lundi' },
  { value: 2, fr: 'Mardi' },
  { value: 3, fr: 'Mercredi' },
  { value: 4, fr: 'Jeudi' },
  { value: 5, fr: 'Vendredi' },
  { value: 6, fr: 'Samedi' },
  { value: 7, fr: 'Dimanche' },
];

// ---- preset id build / parse (EXACTLY Horloge's shapes) --------------------

function isValidTime(hhmm: string): boolean {
  const m = /^(\d{1,2}):(\d{2})$/.exec((hhmm || '').trim());
  if (!m) return false;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h >= 0 && h <= 23 && min >= 0 && min <= 59;
}

function padTime(hhmm: string): string {
  const m = /^(\d{1,2}):(\d{2})$/.exec((hhmm || '').trim());
  if (!m) return '09:00';
  return `${String(Number(m[1])).padStart(2, '0')}:${m[2]}`;
}

/** Build a preset id from the picker state, or null for an invalid time. */
function buildPreset(cadence: Cadence, time: string, dow: number): string | null {
  switch (cadence) {
    case 'hourly':
      return 'hourly';
    case 'daily':
      return isValidTime(time) ? `daily@${padTime(time)}` : null;
    case 'weekly': {
      const d = dow >= 1 && dow <= 7 ? dow : 1;
      return isValidTime(time) ? `weekly@${d}@${padTime(time)}` : null;
    }
    default:
      return null;
  }
}

/** FR day name for D (1..7). */
function dowLabel(d: number): string {
  return DOW_OPTIONS.find(o => o.value === d)?.fr ?? '—';
}

/**
 * Render a stored preset id as a human label. Parses the three shapes; anything
 * unrecognized echoes verbatim (fail-soft). Uses `t()` for the base cadence
 * words and interpolates the concrete time / day.
 */
function presetLabel(preset: string | undefined, t: TFunc): string {
  const s = (preset || '').trim();
  if (!s) return '—';
  if (s === 'hourly') return t('triggers.preset.hourly');
  let m = /^daily@(\d{1,2}):(\d{2})$/.exec(s);
  if (m) {
    const hh = `${String(Number(m[1])).padStart(2, '0')}:${m[2]}`;
    // "Chaque jour à HH:MM" — derive from the daily label by swapping the time.
    return t('triggers.preset.daily').replace(/09:00/, hh);
  }
  m = /^weekly@([1-7])@(\d{1,2}):(\d{2})$/.exec(s);
  if (m) {
    const d = Number(m[1]);
    const hh = `${String(Number(m[2])).padStart(2, '0')}:${m[3]}`;
    // "Chaque {jour} à HH:MM" — swap both the weekday and the time.
    return t('triggers.preset.weekly')
      .replace(/lundi|الإثنين/i, dowLabel(d))
      .replace(/09:00/, hh);
  }
  return s;
}

/** Mask a webhook URL's secret half for display (copy still uses the real URL). */
function maskWebhookUrl(url: string | undefined): string {
  const u = (url || '').trim();
  if (!u) return '';
  // URL ends with `/{id}.{secret}` — mask everything after the LAST dot.
  const dot = u.lastIndexOf('.');
  if (dot <= 0 || dot >= u.length - 1) return u;
  return `${u.slice(0, dot + 1)}••••••••`;
}

// R15: pass the real agent id through — a built-in NAME ('hermes'/'openclaw') OR
// an owned custom `cz_` id — instead of clamping every non-'openclaw' value to
// 'hermes' (which silently pointed a custom agent's triggers at Hermes). The id
// flows straight into listTriggers/createTrigger/toggleTrigger/deleteTrigger,
// which interpolate it into the `/api/v1/agents/:agent/triggers` URL, so a
// deep-linked `?agent=cz_…` now reaches ITS OWN triggers. Empty ⇒ 'hermes'
// default. Return type widens to `AgentName | string` (AgentSummary.id is already
// this union), assignable from the built-in literals so `selectAgent` + the
// built-in AGENTS tabs stay valid. Mirrors R12's backend AgentName→AgentId widen.
function coerceAgent(v: string | null): AgentName | string {
  return v && v.trim() ? v.trim() : 'hermes';
}

// Relative-time formatter (mirrors runs.tsx timeAgo). Uses `t()` so it follows
// the active language; empty for absent timestamps.
function timeAgo(ts: number | undefined, t: TFunc): string {
  if (typeof ts !== 'number' || !Number.isFinite(ts) || ts <= 0) return '';
  const diff = Date.now() - ts;
  if (diff < 0) return t('time.now');
  const s = Math.floor(diff / 1000);
  if (s < 45) return t('time.now');
  const mn = Math.floor(s / 60);
  if (mn < 60) return t('time.minAgo', { n: mn });
  const h = Math.floor(mn / 60);
  if (h < 24) return t('time.hrAgo', { n: h });
  const d = Math.floor(h / 24);
  if (d < 30) return t('time.dayAgo', { n: d });
  const mo = Math.floor(d / 30);
  if (mo < 12) return t('time.monthAgo', { n: mo });
  return t('time.yearAgo', { n: Math.floor(mo / 12) });
}

// Absolute "when" for a FUTURE nextFireAt (short, locale-agnostic clock). Falls
// back to the relative formatter for anything already-past / invalid.
function nextWhen(ts: number | undefined, t: TFunc): string {
  if (typeof ts !== 'number' || !Number.isFinite(ts) || ts <= 0) return '—';
  try {
    const d = new Date(ts);
    // Short: "22/07 09:00" (day/month + zero-padded HH:MM), 24h.
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    const mi = String(d.getMinutes()).padStart(2, '0');
    return `${dd}/${mm} ${hh}:${mi}`;
  } catch {
    return timeAgo(ts, t) || '—';
  }
}

// ---------------------------------------------------------------------------
// Page component.
// ---------------------------------------------------------------------------
const AgentsTriggersPage = () => {
  const [params, setParams] = useSearchParams();
  const agent = coerceAgent(params.get('agent'));

  const { t, dir } = useAgentLang();

  const [state, setState] = useState<LoadState>('loading');
  const [triggers, setTriggers] = useState<AgentTrigger[]>([]);
  // One-shot capability probe: null = probing, true = API answered, false = 404
  // (feature off) → the quiet "Planification non activée" fallback.
  const [enabled, setEnabled] = useState<boolean | null>(null);
  // Whether the create form is expanded.
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    setState('loading');
    try {
      const rows = await listTriggers(agent);
      const sorted = [...rows].sort(
        (a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0)
      );
      setTriggers(sorted);
      setEnabled(true);
      setState('ready');
    } catch (err) {
      // 404 ⇒ feature flag off: quiet fallback, no error surfaced.
      if (err instanceof AgentApiError && err.status === 404) {
        setEnabled(false);
        setTriggers([]);
        setState('ready');
        return;
      }
      setEnabled(prev => (prev === true ? true : prev));
      setState('error');
    }
  }, [agent]);

  useEffect(() => {
    void load();
  }, [load]);

  const selectAgent = useCallback(
    (next: AgentName) => {
      const p = new URLSearchParams(params);
      p.set('agent', next);
      setParams(p, { replace: true });
      setCreating(false);
    },
    [params, setParams]
  );

  // ---- toggle (optimistic-ish: reflect the server's returned record) -------
  const onToggle = useCallback(
    async (id: string) => {
      try {
        const updated = await toggleTrigger(agent, id);
        if (updated && updated.id) {
          setTriggers(prev => prev.map(r => (r.id === id ? updated : r)));
        } else {
          await load();
        }
      } catch {
        // Best-effort: reload to resync on any failure.
        await load();
      }
    },
    [agent, load]
  );

  // ---- delete (confirm handled in the row) ---------------------------------
  const onDelete = useCallback(
    async (id: string) => {
      // Remove locally first for a snappy feel; reload settles the truth.
      setTriggers(prev => prev.filter(r => r.id !== id));
      try {
        await deleteTrigger(agent, id);
      } catch {
        await load();
      }
    },
    [agent, load]
  );

  // ---- create (from the form). Returns the created record for the webhook
  // one-time URL reveal; throws are surfaced by the form. --------------------
  const onCreate = useCallback(
    async (input: { kind: TriggerKind; preset?: string; prompt: string }) => {
      const rec = await createTrigger(agent, input);
      // Prepend the new record so it shows at the top immediately.
      setTriggers(prev => [rec, ...prev.filter(r => r.id !== rec.id)]);
      return rec;
    },
    [agent]
  );

  const showQuietFallback = enabled === false;

  return (
    <>
      <ViewTitle title={t('triggers.tabTitle')} />
      <ViewIcon icon="edgeless" />
      <ViewHeader>
        <div style={headerStyle}>
          <span aria-hidden style={{ fontSize: 16 }}>
            ⏰
          </span>
          {t('triggers.tabTitle')}
          <span style={betaBadgeStyle}>{t('common.beta')}</span>
        </div>
      </ViewHeader>
      <ViewBody>
        <div style={scrollStyle} dir={dir}>
          <div style={innerStyle}>
            {/* Header + refresh */}
            <div
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: 14,
                flexWrap: 'wrap',
              }}
            >
              <div style={{ flex: 1, minWidth: 220 }}>
                <h1
                  style={{
                    margin: 0,
                    fontSize: 22,
                    fontWeight: 800,
                    color: C.text,
                    lineHeight: 1.2,
                  }}
                >
                  {t('triggers.title')}
                </h1>
                <p style={{ margin: '4px 0 0', fontSize: 12.5, color: C.muted }}>
                  {t('triggers.subtitle')}
                </p>
              </div>
              <button
                type="button"
                onClick={() => void load()}
                title={t('common.refresh')}
                style={iconBtnStyle}
              >
                ↻
              </button>
            </div>

            {/* Agent tabs */}
            <div
              role="tablist"
              aria-label={t('runs.filter.label')}
              style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}
            >
              {AGENTS.map(a => {
                const activeAgent = a.id === agent;
                return (
                  <button
                    key={a.id}
                    type="button"
                    role="tab"
                    aria-selected={activeAgent}
                    onClick={() => selectAgent(a.id)}
                    style={{
                      appearance: 'none',
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 7,
                      padding: '7px 14px',
                      borderRadius: R.pill,
                      cursor: 'pointer',
                      fontSize: 13,
                      fontWeight: 700,
                      color: activeAgent ? C.accent : C.muted,
                      background: activeAgent ? C.accentSoft : 'transparent',
                      border: `1px solid ${activeAgent ? C.accentBorder : C.border}`,
                      transition: 'background 150ms ease, color 150ms ease',
                    }}
                  >
                    <span aria-hidden style={{ fontSize: 15 }}>
                      {a.emoji}
                    </span>
                    {a.label}
                  </button>
                );
              })}
            </div>

            {/* Body: quiet fallback | loading | error | (create + list) */}
            {showQuietFallback ? (
              <QuietFallback t={t} />
            ) : state === 'loading' ? (
              <LoadingRow t={t} />
            ) : state === 'error' ? (
              <ErrorRow t={t} onRetry={() => void load()} />
            ) : (
              <>
                {/* Create toggle / form */}
                {creating ? (
                  <CreateForm
                    t={t}
                    onCancel={() => setCreating(false)}
                    onCreate={onCreate}
                  />
                ) : (
                  <div>
                    <button
                      type="button"
                      style={primaryBtnStyle(false)}
                      onClick={() => setCreating(true)}
                    >
                      {t('triggers.create')}
                    </button>
                  </div>
                )}

                {/* List | empty */}
                {triggers.length === 0 ? (
                  <EmptyRow t={t} />
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {triggers.map(trig => (
                      <TriggerRow
                        key={trig.id}
                        t={t}
                        trig={trig}
                        onToggle={() => void onToggle(trig.id)}
                        onDelete={() => void onDelete(trig.id)}
                      />
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </ViewBody>
    </>
  );
};

// ---------------------------------------------------------------------------
// A single trigger row: kind icon, human label / masked webhook URL, prompt
// preview, next/last-run times, active toggle, delete (with inline confirm).
// ---------------------------------------------------------------------------
const TriggerRow = ({
  t,
  trig,
  onToggle,
  onDelete,
}: {
  t: TFunc;
  trig: AgentTrigger;
  onToggle: () => void;
  onDelete: () => void;
}) => {
  const [confirming, setConfirming] = useState(false);
  const [copied, setCopied] = useState(false);
  const isWebhook = trig.kind === 'webhook';
  const active = trig.active !== false;

  const copyUrl = useCallback(() => {
    const url = (trig.webhookUrl || '').trim();
    if (!url) return;
    try {
      void navigator.clipboard?.writeText(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard unavailable — the masked URL is still visible; no-op.
    }
  }, [trig.webhookUrl]);

  return (
    <div style={rowStyle}>
      {/* kind icon */}
      <span aria-hidden style={rowIconStyle}>
        {isWebhook ? '🪝' : '⏰'}
      </span>

      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
        {/* title line: preset label OR webhook URL (masked) + copy */}
        {isWebhook ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 12, fontFamily: mono, color: C.muted, wordBreak: 'break-all' }}>
              {maskWebhookUrl(trig.webhookUrl)}
            </span>
            {trig.webhookUrl ? (
              <button type="button" onClick={copyUrl} style={miniBtnStyle}>
                {copied ? t('triggers.webhook.copied') : t('triggers.webhook.copy')}
              </button>
            ) : null}
          </div>
        ) : (
          <span style={{ fontSize: 13.5, fontWeight: 700, color: C.text }}>
            {presetLabel(trig.preset, t)}
          </span>
        )}

        {/* prompt preview */}
        <span
          style={{
            fontSize: 12.5,
            color: C.muted,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            display: '-webkit-box',
            WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical',
          }}
        >
          {(trig.prompt || '').trim()}
        </span>

        {/* times (cron only shows nextRun; both show lastRun when present) */}
        <span style={{ display: 'flex', gap: 10, flexWrap: 'wrap', fontSize: 11, color: C.muted }}>
          {!isWebhook && active && trig.nextFireAt ? (
            <span>{t('triggers.nextRun', { when: nextWhen(trig.nextFireAt, t) })}</span>
          ) : null}
          {trig.lastFiredAt ? (
            <span>{t('triggers.lastRun', { when: timeAgo(trig.lastFiredAt, t) })}</span>
          ) : null}
        </span>
      </div>

      {/* status + actions */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
        <span
          style={pillStyle(
            active ? C.okText : C.muted,
            active ? C.okBg : 'transparent',
            active ? C.okBorder : C.border
          )}
        >
          {active ? t('triggers.status.active') : t('triggers.status.paused')}
        </span>
        <button
          type="button"
          onClick={onToggle}
          title={active ? t('triggers.toggle.pause') : t('triggers.toggle.activate')}
          style={miniBtnStyle}
        >
          {active ? '⏸' : '▶️'}
        </button>
        {confirming ? (
          <>
            <button
              type="button"
              onClick={onDelete}
              style={{ ...miniBtnStyle, color: C.errText, borderColor: C.errBorder }}
            >
              {t('triggers.delete')}
            </button>
            <button type="button" onClick={() => setConfirming(false)} style={miniBtnStyle}>
              {t('common.cancel')}
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={() => setConfirming(true)}
            title={t('triggers.delete')}
            style={miniBtnStyle}
          >
            🗑
          </button>
        )}
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Create form: kind (Planifié / Webhook), preset picker (for cron), prompt, and
// submit. On a webhook create, the returned URL is revealed ONCE (full, with a
// copy button + darja hint) — it is masked everywhere else.
// ---------------------------------------------------------------------------
const CreateForm = ({
  t,
  onCancel,
  onCreate,
}: {
  t: TFunc;
  onCancel: () => void;
  onCreate: (input: {
    kind: TriggerKind;
    preset?: string;
    prompt: string;
  }) => Promise<AgentTrigger>;
}) => {
  const [kind, setKind] = useState<TriggerKind>('cron');
  const [cadence, setCadence] = useState<Cadence>('daily');
  const [time, setTime] = useState('09:00');
  const [dow, setDow] = useState(1);
  const [prompt, setPrompt] = useState('');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // The freshly-created webhook URL (revealed once). null = not shown.
  const [webhookUrl, setWebhookUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const preset = useMemo(
    () => buildPreset(cadence, time, dow),
    [cadence, time, dow]
  );

  const canSubmit =
    prompt.trim().length >= 2 && (kind === 'webhook' || preset !== null);

  const submit = useCallback(async () => {
    if (!canSubmit || saving) return;
    setSaving(true);
    setErr(null);
    try {
      const rec = await onCreate({
        kind,
        preset: kind === 'cron' ? preset ?? undefined : undefined,
        prompt: prompt.trim(),
      });
      if (rec.kind === 'webhook' && rec.webhookUrl) {
        // Reveal the URL once; keep the form open so the user can copy it.
        setWebhookUrl(rec.webhookUrl);
        setPrompt('');
      } else {
        // Scheduled trigger created — collapse the form.
        onCancel();
      }
    } catch {
      setErr(t('triggers.create.err'));
    } finally {
      setSaving(false);
    }
  }, [canSubmit, saving, onCreate, kind, preset, prompt, onCancel, t]);

  const copyUrl = useCallback(() => {
    if (!webhookUrl) return;
    try {
      void navigator.clipboard?.writeText(webhookUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard unavailable — URL text is selectable */
    }
  }, [webhookUrl]);

  // After a webhook was created, show the one-time URL reveal instead of the
  // form fields.
  if (webhookUrl) {
    return (
      <div style={formCardStyle}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <span style={{ fontSize: 14, fontWeight: 800, color: C.text }}>
            {t('triggers.webhook.title')}
          </span>
          <span style={{ fontSize: 12.5, color: C.muted }}>
            {t('triggers.webhook.hint')}
          </span>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              flexWrap: 'wrap',
              padding: '10px 12px',
              borderRadius: R.md,
              background: C.bg,
              border: `1px solid ${C.border}`,
            }}
          >
            <code
              style={{
                flex: 1,
                minWidth: 200,
                fontSize: 12,
                fontFamily: mono,
                color: C.text,
                wordBreak: 'break-all',
              }}
            >
              {webhookUrl}
            </code>
            <button type="button" onClick={copyUrl} style={miniBtnStyle}>
              {copied ? t('triggers.webhook.copied') : t('triggers.webhook.copy')}
            </button>
          </div>
          {/* darja hint — keeps the DZ bilingual register */}
          <span style={{ fontSize: 11.5, color: C.muted }} dir="rtl">
            صيفط طلب POST لهاد الرابط باش تشغّل الوكيل. خلّيه سرّي.
          </span>
          <div style={{ marginTop: 4 }}>
            <button type="button" style={secondaryBtnStyle} onClick={onCancel}>
              {t('common.back')}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={formCardStyle}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <span style={{ fontSize: 14, fontWeight: 800, color: C.text }}>
          {t('triggers.create.title')}
        </span>

        {/* kind picker */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={labelStyle}>{t('triggers.kind.label')}</span>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <SegBtn
              on={kind === 'cron'}
              emoji="⏰"
              label={t('triggers.kind.cron')}
              onClick={() => setKind('cron')}
            />
            <SegBtn
              on={kind === 'webhook'}
              emoji="🪝"
              label={t('triggers.kind.webhook')}
              onClick={() => setKind('webhook')}
            />
          </div>
        </div>

        {/* preset picker (cron only) */}
        {kind === 'cron' ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={labelStyle}>{t('triggers.preset.label')}</span>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <SegBtn
                on={cadence === 'hourly'}
                label={t('triggers.preset.hourly')}
                onClick={() => setCadence('hourly')}
              />
              <SegBtn
                on={cadence === 'daily'}
                label={t('triggers.preset.daily')}
                onClick={() => setCadence('daily')}
              />
              <SegBtn
                on={cadence === 'weekly'}
                label={t('triggers.preset.weekly')}
                onClick={() => setCadence('weekly')}
              />
            </div>

            {cadence === 'daily' || cadence === 'weekly' ? (
              <div
                style={{
                  display: 'flex',
                  flexWrap: 'wrap',
                  gap: 12,
                  marginTop: 4,
                }}
              >
                {cadence === 'weekly' ? (
                  <label style={{ display: 'flex', flexDirection: 'column', gap: 6, flex: 1, minWidth: 140 }}>
                    <span style={labelStyle}>{t('wizard.step.trigger')}</span>
                    <select
                      value={dow}
                      onChange={e => setDow(Number(e.target.value))}
                      style={selectStyle}
                    >
                      {DOW_OPTIONS.map(d => (
                        <option key={d.value} value={d.value}>
                          {d.fr}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : null}
                <label style={{ display: 'flex', flexDirection: 'column', gap: 6, flex: 1, minWidth: 120 }}>
                  <span style={labelStyle}>{t('triggers.preset.label')}</span>
                  <input
                    type="time"
                    value={time}
                    onChange={e => setTime(e.target.value)}
                    style={{ ...inputStyle, fontFamily: mono }}
                  />
                </label>
              </div>
            ) : null}
          </div>
        ) : null}

        {/* prompt */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={labelStyle}>{t('triggers.prompt.label')}</span>
          <textarea
            value={prompt}
            maxLength={8000}
            placeholder={t('triggers.prompt.placeholder')}
            onChange={e => setPrompt(e.target.value)}
            style={textareaStyle}
          />
          <span style={{ fontSize: 11.5, color: C.muted }}>
            {t('triggers.prompt.hint')}
          </span>
        </div>

        {err ? (
          <div
            style={{
              borderRadius: R.md,
              border: `1px solid ${C.errBorder}`,
              background: C.errBg,
              padding: '10px 12px',
              fontSize: 12.5,
              color: C.text,
            }}
          >
            {err}
          </div>
        ) : null}

        {/* actions */}
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <button
            type="button"
            style={primaryBtnStyle(!canSubmit || saving)}
            disabled={!canSubmit || saving}
            onClick={() => void submit()}
          >
            {saving ? t('triggers.creating') : t('triggers.create')}
          </button>
          <button type="button" style={secondaryBtnStyle} onClick={onCancel} disabled={saving}>
            {t('common.cancel')}
          </button>
        </div>
      </div>
    </div>
  );
};

// A small segmented button (kind + cadence pickers).
const SegBtn = ({
  on,
  emoji,
  label,
  onClick,
}: {
  on: boolean;
  emoji?: string;
  label: string;
  onClick: () => void;
}) => (
  <button
    type="button"
    onClick={onClick}
    style={{
      appearance: 'none',
      display: 'inline-flex',
      alignItems: 'center',
      gap: 7,
      padding: '7px 13px',
      borderRadius: R.pill,
      cursor: 'pointer',
      fontSize: 12.5,
      fontWeight: 700,
      color: on ? C.accent : C.muted,
      background: on ? C.accentSoft : 'transparent',
      border: `1px solid ${on ? C.accentBorder : C.border}`,
      transition: 'background 150ms ease, color 150ms ease',
    }}
  >
    {emoji ? (
      <span aria-hidden style={{ fontSize: 14 }}>
        {emoji}
      </span>
    ) : null}
    {label}
  </button>
);

// ---- states -----------------------------------------------------------------

const LoadingRow = ({ t }: { t: TFunc }) => (
  <div
    style={{
      display: 'flex',
      alignItems: 'center',
      gap: 10,
      padding: '18px 4px',
      color: C.muted,
    }}
  >
    <Spinner /> {t('triggers.loading')}
  </div>
);

const ErrorRow = ({ t, onRetry }: { t: TFunc; onRetry: () => void }) => (
  <div
    style={{
      borderRadius: R.lg,
      border: `1px solid ${C.errBorder}`,
      background: C.errBg,
      padding: '14px 16px',
      display: 'flex',
      alignItems: 'center',
      gap: 12,
      flexWrap: 'wrap',
    }}
  >
    <span style={{ flex: 1, minWidth: 180, fontSize: 13, color: C.text }}>
      {t('triggers.error.load')}
    </span>
    <button type="button" onClick={onRetry} style={secondaryBtnStyle}>
      {t('common.retry')}
    </button>
  </div>
);

const EmptyRow = ({ t }: { t: TFunc }) => (
  <div
    style={{
      borderRadius: R.lg,
      border: `1px dashed ${C.border}`,
      background: C.panel,
      padding: '26px 20px',
      textAlign: 'center',
      color: C.muted,
      display: 'flex',
      flexDirection: 'column',
      gap: 6,
    }}
  >
    <span aria-hidden style={{ fontSize: 28, opacity: 0.7 }}>
      ⏰
    </span>
    <span style={{ fontSize: 14, fontWeight: 700, color: C.text }}>
      {t('triggers.empty.title')}
    </span>
    <span style={{ fontSize: 12.5, maxWidth: 440, margin: '0 auto' }}>
      {t('triggers.empty.body')}
    </span>
  </div>
);

// Flag-off / 404 quiet fallback — the whole feature is dark server-side.
const QuietFallback = ({ t }: { t: TFunc }) => (
  <div
    style={{
      borderRadius: R.lg,
      border: `1px solid ${C.border}`,
      background: C.panel,
      padding: '26px 20px',
      textAlign: 'center',
      color: C.muted,
      display: 'flex',
      flexDirection: 'column',
      gap: 6,
    }}
  >
    <span aria-hidden style={{ fontSize: 26, opacity: 0.7 }}>
      🔒
    </span>
    <span style={{ fontSize: 14, fontWeight: 700, color: C.text }}>
      {t('triggers.quiet.title')}
    </span>
    <span style={{ fontSize: 12.5, maxWidth: 400, margin: '0 auto' }}>
      {t('triggers.quiet.body')}
    </span>
  </div>
);

// Minimal local spinner (reuses the shared keyframe injected by the kit; falls
// back to a static ring if the keyframe isn't present).
const Spinner = () => (
  <span
    aria-hidden
    style={{
      display: 'inline-block',
      width: 14,
      height: 14,
      borderRadius: '50%',
      border: `2px solid color-mix(in srgb, ${C.accent} 30%, transparent)`,
      borderTopColor: C.accent,
      animation: 'cdz-agent-spin 0.7s linear infinite',
      flex: '0 0 auto',
    }}
  />
);

// ---------------------------------------------------------------------------
// Styles (inline; mobile single-column — the list rows + form wrap naturally,
// and every flex container sets flexWrap so narrow viewports collapse to 1-col).
// ---------------------------------------------------------------------------
const scrollStyle: CSSProperties = {
  height: '100%',
  width: '100%',
  overflow: 'auto',
  background: C.bg,
  color: C.text,
  fontSize: 13,
  lineHeight: 1.5,
};

const innerStyle: CSSProperties = {
  maxWidth: 920,
  margin: '0 auto',
  padding: '28px 16px 48px',
  display: 'flex',
  flexDirection: 'column',
  gap: 18,
  boxSizing: 'border-box',
};

const headerStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  height: '100%',
  padding: '0 16px',
  fontSize: 14,
  fontWeight: 600,
  color: C.text,
};

const betaBadgeStyle: CSSProperties = {
  fontSize: 10,
  fontWeight: 700,
  lineHeight: '15px',
  padding: '0 6px',
  borderRadius: 5,
  letterSpacing: '0.05em',
  color: C.muted,
  backgroundColor:
    'color-mix(in srgb, var(--affine-text-secondary-color, #9aa0a6) 16%, transparent)',
};

const iconBtnStyle: CSSProperties = {
  appearance: 'none',
  flexShrink: 0,
  width: 32,
  height: 32,
  borderRadius: R.md,
  border: `1px solid ${C.border}`,
  background: C.panel,
  color: C.muted,
  cursor: 'pointer',
  fontSize: 15,
  lineHeight: 1,
};

const rowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  gap: 12,
  padding: '12px 13px',
  borderRadius: R.lg,
  background: C.panel,
  border: `1px solid ${C.border}`,
  color: C.text,
  flexWrap: 'wrap',
};

const rowIconStyle: CSSProperties = {
  width: 30,
  height: 30,
  flexShrink: 0,
  borderRadius: R.md,
  display: 'grid',
  placeItems: 'center',
  fontSize: 14,
  background: C.bg,
  border: `1px solid ${C.border}`,
  color: C.muted,
};

const formCardStyle: CSSProperties = {
  padding: 16,
  borderRadius: R.lg,
  background: C.panel,
  border: `1px solid ${C.accentBorder}`,
};

const labelStyle: CSSProperties = {
  fontSize: 12,
  fontWeight: 700,
  letterSpacing: '0.04em',
  textTransform: 'uppercase',
  color: C.muted,
};

const inputStyle: CSSProperties = {
  appearance: 'none',
  width: '100%',
  boxSizing: 'border-box',
  padding: '9px 11px',
  borderRadius: R.md,
  background: C.bg,
  border: `1px solid ${C.border}`,
  color: C.text,
  fontSize: 13.5,
  fontFamily: 'inherit',
};

const selectStyle: CSSProperties = {
  ...inputStyle,
  background: C.panel,
  cursor: 'pointer',
};

const textareaStyle: CSSProperties = {
  ...inputStyle,
  minHeight: 88,
  resize: 'vertical',
  lineHeight: 1.5,
};

function primaryBtnStyle(disabled: boolean): CSSProperties {
  return {
    appearance: 'none',
    padding: '9px 16px',
    borderRadius: R.md,
    border: `1px solid ${C.accentBorder}`,
    background: disabled ? 'transparent' : C.accentSoft,
    color: disabled ? C.muted : C.accent,
    cursor: disabled ? 'default' : 'pointer',
    opacity: disabled ? 0.65 : 1,
    fontSize: 13,
    fontWeight: 700,
  };
}

const secondaryBtnStyle: CSSProperties = {
  appearance: 'none',
  padding: '9px 16px',
  borderRadius: R.md,
  border: `1px solid ${C.border}`,
  background: C.panel,
  color: C.text,
  cursor: 'pointer',
  fontSize: 13,
  fontWeight: 600,
};

const miniBtnStyle: CSSProperties = {
  appearance: 'none',
  padding: '5px 10px',
  borderRadius: R.md,
  border: `1px solid ${C.border}`,
  background: C.bg,
  color: C.text,
  cursor: 'pointer',
  fontSize: 12,
  fontWeight: 600,
  flexShrink: 0,
};

function pillStyle(color: string, bg: string, border: string): CSSProperties {
  return {
    flexShrink: 0,
    fontSize: 10,
    fontWeight: 700,
    letterSpacing: '0.04em',
    textTransform: 'uppercase',
    padding: '2px 9px',
    borderRadius: R.pill,
    color,
    background: bg,
    border: `1px solid ${border}`,
    whiteSpace: 'nowrap',
  };
}

// Default export + `Component` alias so the router's lazy convention (every
// sibling agents page uses `export const Component`) can wire it either way.
export default AgentsTriggersPage;
export const Component = AgentsTriggersPage;
