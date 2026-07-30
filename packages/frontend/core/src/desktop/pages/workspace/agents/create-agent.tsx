// ---------------------------------------------------------------------------
// "Créer un agent" — the R12 custom-agent creator (router lazy target at
// /agents/new; Aiguille/Poste wires the route). Where the R7/R8 « hire » wizard
// provisions a BUILT-IN (hermes/openclaw) config, THIS flow lets a user mint
// their OWN named agent that CLONES a built-in archetype: pick which archetype it
// reuses, give it a name + emoji + persona, review, and POST it. The backend
// (Fonderie's registry) returns an opaque `cz_`-prefixed id; every unified
// surface (run view, connections, triggers) already keys by that id, so the new
// agent works everywhere with no extra plumbing.
//
//   Step 1  Archetype — two big cards:
//             🤝 Opérateur (comme Hermès)  → archetype 'hermes'
//             🛠️ Ingénieur (comme OpenClaw) → archetype 'openclaw'
//   Step 2  Identité — name + emoji picker + persona textarea
//   Step 3  Récap — review → createCustomAgent() → on success open the new
//             agent's unified run surface (/agents/runs?agent=<id>), else /agents
//
// API REUSE (no new endpoint invented): Fonderie's `createCustomAgent(body)` from
//   modules/agents/api (POST /api/v1/agents/custom {archetype,name,emoji?,
//   persona?} → AgentDef). Gated on the backend by CDZ_AGENT_CUSTOM_ENABLED — a
//   404 there means the feature is dark. This page ALSO gates its whole UI on
//   `caps.customEnabled` (from Annuaire's useAgents()): off ⇒ a quiet "bientôt"
//   fallback rather than a dead form.
//
// Consumed sibling contracts (by name): Fonderie — `createCustomAgent`,
//   `AgentDef`, `CreateCustomAgentInput`, `AgentApiError`; Annuaire —
//   `useAgents()` → { caps, loading, error, disabled, reload } with
//   `caps.customEnabled`; Locale — `useAgentLang()` → { lang, setLang, t, dir };
//   the shared kit — `AgentPalette`, `accentFor(archetype)`, `Spinner`, `Chip`.
//   These may not resolve in an isolated single-file esbuild check (same pattern
//   the sibling agents pages use) — they are consumed by contract name.
//
// House rules: default export (+ a `Component` alias for the router's lazy
// convention), inline styles only (reuse the shared AgentPalette + primitives),
// no .css.ts, no new deps, FR primary + darja hints, mobile single-column, and
// loading / disabled / error states.
// ---------------------------------------------------------------------------

import {
  AgentApiError,
  type AgentDef,
  createCustomAgent,
} from '@affine/core/modules/agents/api';
import {
  accentFor,
  AgentPalette,
  Chip,
  Spinner,
} from '@affine/core/modules/agents/components';
// Locale (R8, WSU-7) owns this i18n module: `useAgentLang()` → { lang, setLang,
// t, dir }. `t(key, vars?)` is fail-soft — an unknown key returns the key
// itself, so any string not yet catalogued degrades to readable text rather than
// throwing. Consumed by contract name.
import {
  AGENT_LANG_LABELS,
  type AgentLang,
  type TFunc,
  useAgentLang,
} from '@affine/core/modules/agents/i18n';
import type { AgentName } from '@affine/core/modules/agents/types';
// Annuaire (R7) owns this hook; it may not resolve in an isolated single-file
// esbuild check — expected, same pattern the sibling pages use. Consumed by
// contract name.
import { useAgents } from '@affine/core/modules/agents/use-agents';
import {
  ViewBody,
  ViewHeader,
  ViewIcon,
  ViewTitle,
  WorkbenchService,
} from '@affine/core/modules/workbench';
import { AiIcon } from '@blocksuite/icons/rc';
import { useService } from '@toeverything/infra';
import {
  type CSSProperties,
  useCallback,
  useMemo,
  useState,
} from 'react';
import { ensureClickDzResponsiveCss } from '@affine/core/clickdz/responsive';

// Inject the CDZ responsive stylesheet once per document (idempotent + SSR-safe).
const CdzResponsive = () => { ensureClickDzResponsiveCss(); return null; };

const C = AgentPalette.color;
const R = AgentPalette.radius;

// The unified run surface a freshly-created agent lands on. This is the SAME
// route the /agents home opens an agent with (index.tsx `runsRoute`) — a real
// registered route (`/agents/runs?agent=<id>`), so no route drift. The custom
// `cz_`-prefixed id is passed through as the `?agent=` value.
function runsRoute(id: string): string {
  return `/agents/runs?agent=${encodeURIComponent(id)}`;
}

// The /agents home (fallback nav target + the "Annuler" destination).
const HOME_ROUTE = '/agents';

// Validation limits — mirror the backend registry (name 1..40, persona ≤2000,
// emoji ≤8) so the client rejects the same shapes the server would 400 on.
const NAME_MAX = 40;
const PERSONA_MAX = 2000;
const EMOJI_MAX = 8;

// ---------------------------------------------------------------------------
// Archetype presentation. The two choices map 1:1 to the backend `archetype`
// union; the emoji + accent match the run.tsx / home identity (🤝 Hermes,
// 🛠️ OpenClaw) so the new agent reads consistently with the built-ins.
// ---------------------------------------------------------------------------
interface ArchetypeMeta {
  archetype: AgentName;
  emoji: string;
  titleKey: string;
  descKey: string;
}

const ARCHETYPES: ArchetypeMeta[] = [
  {
    archetype: 'hermes',
    emoji: '🤝',
    titleKey: 'create.archetype.operator.title',
    descKey: 'create.archetype.operator.desc',
  },
  {
    archetype: 'openclaw',
    emoji: '🛠️',
    titleKey: 'create.archetype.engineer.title',
    descKey: 'create.archetype.engineer.desc',
  },
];

// A small curated emoji palette for the picker (no new deps, no native picker
// dependency). Purely a convenience — the free-text field accepts any glyph.
const EMOJI_CHOICES = [
  '🤖', '🤝', '🛠️', '📦', '🚚', '💬', '📞', '🧾', '💰', '📊',
  '🛒', '🏷️', '📣', '🧠', '⚡', '🔧', '🗂️', '✅', '🌙', '🦾',
];

// ---------------------------------------------------------------------------
// Language toggle — the same small FR/عربية segmented control the home uses
// (AGENT_LANG_LABELS + setLang). Purely presentational; flipping it re-renders
// the whole studio via the module-level broadcast.
// ---------------------------------------------------------------------------
const LANG_ORDER: AgentLang[] = ['fr', 'ar'];

function LangToggle({
  lang,
  setLang,
  t,
}: {
  lang: AgentLang;
  setLang: (l: AgentLang) => void;
  t: TFunc;
}) {
  return (
    <div
      role="group"
      aria-label={t('lang.toggleTitle')}
      title={t('lang.toggleTitle')}
      dir="ltr"
      style={{
        display: 'inline-flex',
        flex: '0 0 auto',
        padding: 2,
        gap: 2,
        borderRadius: R.pill,
        border: `1px solid ${C.border}`,
        background: C.panel,
      }}
    >
      {LANG_ORDER.map(l => {
        const active = l === lang;
        return (
          <button
            key={l}
            type="button"
            aria-pressed={active}
            onClick={() => setLang(l)}
            style={{
              appearance: 'none',
              cursor: 'pointer',
              fontFamily: 'inherit',
              fontSize: 12,
              fontWeight: 700,
              lineHeight: 1.2,
              padding: '4px 12px',
              borderRadius: R.pill,
              border: 'none',
              whiteSpace: 'nowrap',
              color: active ? C.onAccent : C.muted,
              background: active ? C.accent : 'transparent',
              transition: 'background 150ms ease, color 150ms ease',
            }}
          >
            {AGENT_LANG_LABELS[l]}
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Stepper — a compact 3-dot progress row (mirrors the wizard.progress idiom).
// ---------------------------------------------------------------------------
const STEP_LABEL_KEYS = [
  'create.step.archetype',
  'create.step.identity',
  'create.step.review',
];

function Stepper({ step, t }: { step: number; t: TFunc }) {
  return (
    <div
      dir="ltr"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        flexWrap: 'wrap',
      }}
    >
      {STEP_LABEL_KEYS.map((k, i) => {
        const active = i === step;
        const done = i < step;
        return (
          <div
            key={k}
            style={{ display: 'flex', alignItems: 'center', gap: 8 }}
          >
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: 22,
                height: 22,
                borderRadius: '50%',
                fontSize: 11,
                fontWeight: 800,
                flex: '0 0 auto',
                color: active || done ? C.onAccent : C.muted,
                background: active || done ? C.accent : 'transparent',
                border: `1px solid ${active || done ? C.accent : C.border}`,
              }}
            >
              {done ? '✓' : i + 1}
            </span>
            <span
              style={{
                fontSize: 12.5,
                fontWeight: active ? 800 : 600,
                color: active ? C.text : C.muted,
                whiteSpace: 'nowrap',
              }}
            >
              {t(k)}
            </span>
            {i < STEP_LABEL_KEYS.length - 1 ? (
              <span
                aria-hidden
                style={{
                  width: 18,
                  height: 1,
                  background: C.border,
                  flex: '0 0 auto',
                }}
              />
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The wizard body — owns the local form state machine. Reached only when
// `caps.customEnabled` is on (the shell gates it); still degrades safely.
// ---------------------------------------------------------------------------
const CreateAgentBody = () => {
  const workbench = useService(WorkbenchService).workbench;
  const { lang, setLang, t, dir } = useAgentLang();

  const go = useCallback(
    (path: string) => {
      workbench.open(path, { at: 'active' });
    },
    [workbench]
  );

  const [step, setStep] = useState(0);
  const [archetype, setArchetype] = useState<AgentName | null>(null);
  const [name, setName] = useState('');
  const [emoji, setEmoji] = useState('');
  const [persona, setPersona] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const accent = useMemo(() => accentFor(archetype ?? undefined), [archetype]);
  const trimmedName = name.trim();
  const nameValid = trimmedName.length >= 1 && trimmedName.length <= NAME_MAX;

  const back = useCallback(() => {
    setErr(null);
    setStep(s => Math.max(0, s - 1));
  }, []);

  const next = useCallback(() => {
    setErr(null);
    setStep(s => Math.min(STEP_LABEL_KEYS.length - 1, s + 1));
  }, []);

  const chooseArchetype = useCallback((a: AgentName) => {
    setArchetype(a);
    setErr(null);
    setStep(1);
  }, []);

  const submit = useCallback(async () => {
    if (!archetype || !nameValid || submitting) return;
    setSubmitting(true);
    setErr(null);
    try {
      const body = {
        archetype,
        name: trimmedName,
        // Only send optional fields when non-empty (the backend treats an absent
        // field as "unset" — matches the AgentDef optional shape).
        ...(emoji.trim() ? { emoji: emoji.trim() } : {}),
        ...(persona.trim() ? { persona: persona.trim() } : {}),
      };
      const created: AgentDef = await createCustomAgent(body);
      const id = created && typeof created.id === 'string' ? created.id : '';
      // Refreshing the roster is the home's job on its next mount; here we just
      // navigate straight to the new agent's unified run surface. Fall back to
      // the home if the backend didn't echo an id (defensive — it always does).
      go(id ? runsRoute(id) : HOME_ROUTE);
    } catch (e) {
      // Map the known failures to catalogued copy; anything else surfaces its
      // message verbatim (AgentApiError carries a human-readable string).
      if (e instanceof AgentApiError) {
        if (e.status === 404) {
          setErr(t('create.err.404'));
        } else if (
          e.status === 400 &&
          /limit|cap|max/i.test(e.message || '')
        ) {
          setErr(t('create.err.limit'));
        } else if (e.status === 400) {
          setErr(e.message || t('create.err.generic'));
        } else {
          setErr(e.message || t('create.err.generic'));
        }
      } else {
        setErr(e instanceof Error ? e.message : t('create.err.generic'));
      }
      setSubmitting(false);
    }
  }, [archetype, nameValid, submitting, trimmedName, emoji, persona, go, t]);

  const archetypeMeta = ARCHETYPES.find(a => a.archetype === archetype) ?? null;

  return (
    <div dir={dir} style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
      {/* Header + subtitle + language toggle. */}
      <header
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          gap: 14,
          flexWrap: 'wrap',
        }}
      >
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
            flex: '1 1 260px',
            minWidth: 0,
          }}
        >
          <h1
            style={{
              margin: 0,
              fontSize: 24,
              fontWeight: 800,
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              color: C.text,
            }}
          >
            <AiIcon style={{ fontSize: 22 }} /> {t('create.title')}
          </h1>
          <p
            style={{
              margin: 0,
              fontSize: 13.5,
              color: C.muted,
              lineHeight: 1.5,
            }}
          >
            {t('create.subtitle')}
          </p>
        </div>
        <LangToggle lang={lang} setLang={setLang} t={t} />
      </header>

      <Stepper step={step} t={t} />

      {/* Error banner (submit failures). */}
      {err ? (
        <div
          role="alert"
          style={{
            padding: '12px 14px',
            borderRadius: R.lg,
            border: `1px solid ${C.errBorder}`,
            background: C.errBg,
            color: C.text,
            fontSize: 13,
            lineHeight: 1.5,
            wordBreak: 'break-word',
          }}
        >
          {err}
        </div>
      ) : null}

      {/* ---- Step 1: archetype ------------------------------------------- */}
      {step === 0 ? (
        <section style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={sectionTitleStyle}>{t('create.archetype.heading')}</div>
          <div
            className="cdz-create-archetypes"
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
              gap: 16,
            }}
          >
            {ARCHETYPES.map(meta => {
              const a = accentFor(meta.archetype);
              const selected = archetype === meta.archetype;
              return (
                <button
                  key={meta.archetype}
                  type="button"
                  onClick={() => chooseArchetype(meta.archetype)}
                  style={{
                    appearance: 'none',
                    cursor: 'pointer',
                    textAlign: 'start',
                    fontFamily: 'inherit',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 12,
                    padding: 20,
                    borderRadius: R.lg,
                    background: selected ? a.accentSoft : C.panel,
                    border: `1px solid ${selected ? a.accent : C.border}`,
                    boxShadow: selected ? `0 0 0 3px ${a.glow}` : 'none',
                    transition: 'border 150ms ease, background 150ms ease',
                    minWidth: 0,
                  }}
                >
                  <div
                    aria-hidden
                    style={{
                      display: 'grid',
                      placeItems: 'center',
                      width: 52,
                      height: 52,
                      fontSize: 28,
                      borderRadius: R.md,
                      background: a.accentSoft,
                      border: `1px solid ${a.accent}`,
                    }}
                  >
                    {meta.emoji}
                  </div>
                  <div
                    style={{
                      fontSize: 17,
                      fontWeight: 800,
                      color: C.text,
                      lineHeight: 1.2,
                    }}
                  >
                    {t(meta.titleKey)}
                  </div>
                  <p
                    style={{
                      margin: 0,
                      fontSize: 13,
                      color: C.muted,
                      lineHeight: 1.5,
                    }}
                  >
                    {t(meta.descKey)}
                  </p>
                </button>
              );
            })}
          </div>
          <div style={{ display: 'flex', gap: 10, marginTop: 2 }}>
            <button type="button" onClick={() => go(HOME_ROUTE)} style={ghostBtn}>
              {t('common.cancel')}
            </button>
          </div>
        </section>
      ) : null}

      {/* ---- Step 2: identity (name + emoji + persona) ------------------- */}
      {step === 1 ? (
        <section style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
          <div style={sectionTitleStyle}>{t('create.identity.heading')}</div>

          {/* Name + emoji row. */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <label style={labelStyle} htmlFor="cdz-create-name">
              {t('create.identity.name.label')}
            </label>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <span
                aria-hidden
                style={{
                  display: 'grid',
                  placeItems: 'center',
                  width: 44,
                  height: 44,
                  flex: '0 0 auto',
                  fontSize: 24,
                  borderRadius: R.md,
                  background: accent.accentSoft,
                  border: `1px solid ${accent.accent}`,
                }}
              >
                {emoji.trim() || archetypeMeta?.emoji || '🤖'}
              </span>
              <input
                id="cdz-create-name"
                type="text"
                value={name}
                maxLength={NAME_MAX}
                onChange={e => setName(e.target.value)}
                placeholder={t('create.identity.name.placeholder')}
                style={{
                  ...inputStyle,
                  flex: '1 1 200px',
                }}
              />
            </div>
            <div style={hintStyle}>
              {t('create.identity.name.hint', {
                n: NAME_MAX - trimmedName.length,
              })}
            </div>
          </div>

          {/* Emoji picker. */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <label style={labelStyle}>{t('create.identity.emoji.label')}</label>
            <div
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                gap: 6,
              }}
            >
              {EMOJI_CHOICES.map(e => {
                const active = emoji.trim() === e;
                return (
                  <button
                    key={e}
                    type="button"
                    aria-pressed={active}
                    onClick={() => setEmoji(active ? '' : e)}
                    style={{
                      appearance: 'none',
                      cursor: 'pointer',
                      width: 38,
                      height: 38,
                      fontSize: 20,
                      lineHeight: 1,
                      display: 'grid',
                      placeItems: 'center',
                      borderRadius: R.sm,
                      background: active ? accent.accentSoft : 'transparent',
                      border: `1px solid ${active ? accent.accent : C.border}`,
                      transition: 'background 120ms ease, border 120ms ease',
                    }}
                  >
                    {e}
                  </button>
                );
              })}
            </div>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <input
                type="text"
                value={emoji}
                maxLength={EMOJI_MAX}
                onChange={ev => setEmoji(ev.target.value)}
                placeholder={t('create.identity.emoji.placeholder')}
                aria-label={t('create.identity.emoji.label')}
                style={{ ...inputStyle, width: 120, flex: '0 0 auto' }}
              />
              <span style={hintStyle}>{t('create.identity.emoji.hint')}</span>
            </div>
          </div>

          {/* Persona textarea. */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <label style={labelStyle} htmlFor="cdz-create-persona">
              {t('create.identity.persona.label')}
            </label>
            <textarea
              id="cdz-create-persona"
              value={persona}
              maxLength={PERSONA_MAX}
              rows={5}
              onChange={e => setPersona(e.target.value)}
              placeholder={t('create.identity.persona.placeholder')}
              style={{
                ...inputStyle,
                resize: 'vertical',
                minHeight: 108,
                lineHeight: 1.5,
              }}
            />
            <div dir="rtl" style={hintStyle}>
              {t('create.identity.persona.hint')}
            </div>
          </div>

          {/* Nav. */}
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 2 }}>
            <button type="button" onClick={back} style={ghostBtn}>
              {t('common.back')}
            </button>
            <button
              type="button"
              onClick={next}
              disabled={!nameValid}
              style={{ ...primaryBtn, opacity: nameValid ? 1 : 0.5, cursor: nameValid ? 'pointer' : 'default' }}
            >
              {t('common.continue')}
            </button>
          </div>
        </section>
      ) : null}

      {/* ---- Step 3: review --------------------------------------------- */}
      {step === 2 ? (
        <section style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
          <div style={sectionTitleStyle}>{t('create.review.heading')}</div>

          <div
            style={{
              display: 'flex',
              gap: 14,
              alignItems: 'flex-start',
              padding: 18,
              borderRadius: R.lg,
              background: C.panel,
              border: `1px solid ${C.border}`,
              flexWrap: 'wrap',
            }}
          >
            <span
              aria-hidden
              style={{
                display: 'grid',
                placeItems: 'center',
                width: 52,
                height: 52,
                flex: '0 0 auto',
                fontSize: 28,
                borderRadius: R.md,
                background: accent.accentSoft,
                border: `1px solid ${accent.accent}`,
              }}
            >
              {emoji.trim() || archetypeMeta?.emoji || '🤖'}
            </span>
            <div style={{ flex: '1 1 200px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 18, fontWeight: 800, color: C.text }}>
                  {trimmedName || t('create.review.unnamed')}
                </span>
                {archetypeMeta ? (
                  <Chip color={accent.accent} bg={accent.accentSoft} border={accent.accent}>
                    {t(archetypeMeta.titleKey)}
                  </Chip>
                ) : null}
              </div>
              <div style={{ fontSize: 12.5, color: C.muted }}>
                {t('create.review.archetypeLine', {
                  archetype: archetypeMeta ? t(archetypeMeta.titleKey) : '',
                })}
              </div>
              {persona.trim() ? (
                <p
                  style={{
                    margin: '2px 0 0',
                    fontSize: 13,
                    color: C.text,
                    lineHeight: 1.5,
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                  }}
                >
                  {persona.trim()}
                </p>
              ) : (
                <span style={{ fontSize: 12.5, color: C.muted, fontStyle: 'italic' }}>
                  {t('create.review.noPersona')}
                </span>
              )}
            </div>
          </div>

          <div dir="rtl" style={hintStyle}>
            {t('create.review.hint')}
          </div>

          {/* Nav. */}
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 2 }}>
            <button
              type="button"
              onClick={back}
              disabled={submitting}
              style={{ ...ghostBtn, opacity: submitting ? 0.6 : 1 }}
            >
              {t('common.back')}
            </button>
            <button
              type="button"
              onClick={submit}
              disabled={submitting || !nameValid || !archetype}
              style={{
                ...primaryBtn,
                fontSize: 14.5,
                padding: '11px 20px',
                opacity: submitting || !nameValid || !archetype ? 0.6 : 1,
                cursor: submitting || !nameValid || !archetype ? 'default' : 'pointer',
              }}
            >
              {submitting ? (
                <>
                  <Spinner size={14} color={C.onAccent} /> {t('create.submitting')}
                </>
              ) : (
                t('create.submit')
              )}
            </button>
          </div>
        </section>
      ) : null}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Feature-gate + lifecycle wrapper. Reads Annuaire's useAgents() for
// caps.customEnabled + the load lifecycle, and renders the loading / dark /
// error states before the wizard body. When the custom feature is OFF (dark) we
// show a quiet "bientôt" panel rather than a dead form (mirrors the home's
// disabled state), so the page is safe even if a user deep-links here.
// ---------------------------------------------------------------------------
const CreateAgentGate = () => {
  const { t, dir } = useAgentLang();
  const workbench = useService(WorkbenchService).workbench;
  const { caps, loading, error, disabled, reload } = useAgents();

  const go = useCallback(
    (path: string) => workbench.open(path, { at: 'active' }),
    [workbench]
  );

  // ---- loading (first roster fetch in flight) ----------------------------
  if (loading && !error) {
    return (
      <div
        dir={dir}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '28px 4px',
          color: C.muted,
        }}
      >
        <Spinner /> {t('create.loading')}
      </div>
    );
  }

  // ---- error (real failure: auth/network/5xx) ----------------------------
  if (error) {
    return (
      <div
        dir={dir}
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
          maxWidth: 520,
          padding: '18px 20px',
          borderRadius: R.lg,
          border: `1px solid ${C.errBorder}`,
          background: C.errBg,
        }}
      >
        <div style={{ fontSize: 14, fontWeight: 700, color: C.text }}>
          {t('home.error.title')}
        </div>
        <p style={{ margin: 0, fontSize: 12.5, color: C.muted, lineHeight: 1.5, wordBreak: 'break-word' }}>
          {error}
        </p>
        <div style={{ display: 'flex', gap: 10 }}>
          <button type="button" onClick={() => reload()} style={primaryBtn}>
            {t('common.retry')}
          </button>
          <button type="button" onClick={() => go(HOME_ROUTE)} style={ghostBtn}>
            {t('common.back')}
          </button>
        </div>
      </div>
    );
  }

  // ---- feature dark: custom agents off (or the whole roster 404'd) -------
  if (disabled || !caps.customEnabled) {
    return (
      <div
        dir={dir}
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
          maxWidth: 520,
          padding: '18px 20px',
          borderRadius: R.lg,
          border: `1px dashed ${C.border}`,
          background: C.panel,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: C.text }}>
            {t('create.soon.title')}
          </div>
          <Chip
            color={C.muted}
            bg="color-mix(in srgb, var(--affine-text-secondary-color, #9aa0a6) 16%, transparent)"
            border="transparent"
          >
            {t('common.soon')}
          </Chip>
        </div>
        <p style={{ margin: 0, fontSize: 13, color: C.muted, lineHeight: 1.5 }}>
          {t('create.soon.body')}
        </p>
        <div style={{ marginTop: 4 }}>
          <button type="button" onClick={() => go(HOME_ROUTE)} style={ghostBtn}>
            {t('common.back')}
          </button>
        </div>
      </div>
    );
  }

  // ---- ready --------------------------------------------------------------
  return <CreateAgentBody />;
};

// ---------------------------------------------------------------------------
// The page shell — the studio scaffold (ViewTitle/…/ViewBody), matching the
// /agents home + hermes/shoperp idiom so /agents/new reads as a first-class
// studio page.
// ---------------------------------------------------------------------------
const CreateAgentPage = () => {
  const { t } = useAgentLang();
  return (
    <>
      <ViewTitle title={t('create.tabTitle')} />
      <ViewIcon icon="edgeless" />
      <ViewHeader>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            height: '100%',
            padding: '0 16px',
            fontSize: 14,
            fontWeight: 600,
            color: C.text,
          }}
        >
          <AiIcon style={{ fontSize: 16 }} />
          {t('create.tabTitle')}
        </div>
      </ViewHeader>
      <ViewBody>
        <div
          data-cdz-surface=""
          style={{
            height: '100%',
            width: '100%',
            overflow: 'auto',
            background: C.bg,
            color: C.text,
            fontSize: 13,
            lineHeight: 1.5,
          }}
        >
          <CdzResponsive />
          <style>{CREATE_CSS}</style>
          <div
            className="cdz-create-canvas"
            style={{
              maxWidth: 860,
              margin: '0 auto',
              padding: '28px 24px 48px',
            }}
          >
            <CreateAgentGate />
          </div>
        </div>
      </ViewBody>
    </>
  );
};

// Mobile polish: tighten the canvas padding and collapse the archetype grid to
// one column on phones.
const CREATE_CSS = `
@media (max-width: 560px){
  .cdz-create-canvas{padding:18px 14px 40px !important;}
  .cdz-create-archetypes{grid-template-columns:1fr !important;}
}
`;

// ---------------------------------------------------------------------------
// Shared inline styles (page-scoped; mirror the home/card button idiom).
// ---------------------------------------------------------------------------
const sectionTitleStyle: CSSProperties = {
  fontSize: 12,
  fontWeight: 800,
  letterSpacing: '0.04em',
  textTransform: 'uppercase',
  color: C.muted,
};

const labelStyle: CSSProperties = {
  fontSize: 12.5,
  fontWeight: 700,
  color: C.text,
};

const hintStyle: CSSProperties = {
  fontSize: 12,
  color: C.muted,
  lineHeight: 1.5,
};

const inputStyle: CSSProperties = {
  appearance: 'none',
  fontFamily: 'inherit',
  fontSize: 14,
  color: C.text,
  background: C.bg,
  border: `1px solid ${C.border}`,
  borderRadius: R.sm,
  padding: '9px 12px',
  outline: 'none',
  boxSizing: 'border-box',
};

const baseBtn: CSSProperties = {
  appearance: 'none',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 6,
  padding: '9px 18px',
  borderRadius: R.sm,
  fontSize: 13.5,
  fontWeight: 700,
  fontFamily: 'inherit',
  cursor: 'pointer',
  lineHeight: 1.2,
  whiteSpace: 'nowrap',
};

const primaryBtn: CSSProperties = {
  ...baseBtn,
  color: C.onAccent,
  background: C.accent,
  border: `1px solid ${C.accent}`,
};

const ghostBtn: CSSProperties = {
  ...baseBtn,
  color: C.text,
  background: 'transparent',
  border: `1px solid ${C.border}`,
};

// Router lazy target: the route loader renders `Component` (same convention as
// every sibling workspace page — hermes/shoperp/agents export `Component`). Also
// provide a default export for the "default-export the page" requirement.
export const Component = () => {
  return <CreateAgentPage />;
};

export default CreateAgentPage;
