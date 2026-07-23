// ---------------------------------------------------------------------------
// OpenClaw onboarding wizard. Mirrors the ShopERP wizard state machine exactly
// (linear step FLOW + a post-confirm create Phase) but for a per-user CODING
// AGENT setup rather than a shop. Each user provisions their own OpenClaw:
//   welcome → default runtime → preview auto-open pref → sandbox-status check →
//   review → PUT /api/v1/openclaw/config → onDone (→ dashboard).
//
// The pipeline is REAL: the review's "Finish setup" calls the C5 PUT config
// route (which upserts + flips provisioned:true). Sandbox availability is read
// honestly from GET /capabilities (passed in by the page): if it isn't enabled
// we show the backend's reason and make it clear the agent still works in
// generate-only mode — no fake "enabling" step. Inline styles only; the palette
// is the shared AgentPalette so the wizard reads like the console.
// ---------------------------------------------------------------------------

import { useAgentLang } from '@affine/core/modules/agents/i18n';
import { type ReactNode, useCallback, useMemo, useState } from 'react';

import {
  Banner,
  btnStyle,
  C,
  type ClawCapabilities,
  hintStyle,
  monoFamily,
  type OpenClawConfig,
  putConfig,
  type Runtime,
  RUNTIME_BLURB,
  RUNTIME_LABELS,
  RUNTIMES,
  SandboxHealthButton,
  SandboxStatus,
  Spinner,
} from './openclaw-shared';

type Step = 'welcome' | 'runtime' | 'preview' | 'sandbox' | 'review';
const FLOW: Step[] = ['welcome', 'runtime', 'preview', 'sandbox', 'review'];

// The save phase after the user confirms on the Review step.
type Phase =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'done'; config: OpenClawConfig }
  | { kind: 'error'; message: string };

export const OpenClawWizard = ({
  caps,
  capsState,
  onReloadCaps,
  onDone,
  onCancel,
  hasExisting,
  initial,
}: {
  /** Live capabilities (honest sandbox status). May be null while loading. */
  caps: ClawCapabilities | null;
  capsState: 'loading' | 'ready' | 'error';
  /** Re-probe capabilities (the sandbox-status step's Recheck button). */
  onReloadCaps: () => void;
  /** Called after a successful save, once the user leaves the done screen. */
  onDone: (config: OpenClawConfig) => void;
  /** Abandon the wizard — only offered when a config already exists. */
  onCancel?: () => void;
  /** True when re-running setup over an existing config. */
  hasExisting: boolean;
  /** Seed values when editing an existing config. */
  initial?: OpenClawConfig | null;
}) => {
  const { t } = useAgentLang();
  const [stepIdx, setStepIdx] = useState(0);
  const step = FLOW[stepIdx];

  // Config model — seeded so a straight click-through yields a valid setup.
  const [runtime, setRuntime] = useState<Runtime>(
    initial?.defaultRuntime ?? 'node24'
  );
  const [previewAutoOpen, setPreviewAutoOpen] = useState<boolean>(
    initial?.previewAutoOpen !== false
  );

  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });

  const config = useMemo(
    () => ({ defaultRuntime: runtime, previewAutoOpen }),
    [runtime, previewAutoOpen]
  );

  const next = useCallback(
    () => setStepIdx(i => Math.min(i + 1, FLOW.length - 1)),
    []
  );
  const back = useCallback(() => setStepIdx(i => Math.max(i - 1, 0)), []);

  // ---- The real save pipeline: PUT the per-user config -------------------
  const save = useCallback(async () => {
    setPhase({ kind: 'saving' });
    try {
      const saved = await putConfig(config);
      setPhase({ kind: 'done', config: saved });
    } catch (err) {
      setPhase({
        kind: 'error',
        message:
          err instanceof Error && err.message
            ? err.message
            : t('openclaw.wizard.saveError'),
      });
    }
  }, [config, t]);

  // ---- Terminal phases render standalone --------------------------------
  if (phase.kind === 'saving') {
    return (
      <Card>
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 16,
            padding: '32px 8px',
          }}
        >
          <Spinner />
          <div style={{ fontSize: 15, fontWeight: 600, color: C.text }}>
            {t('openclaw.wizard.saving')}
          </div>
          <div style={hintStyle}>{t('openclaw.wizard.savingHint')}</div>
        </div>
      </Card>
    );
  }

  if (phase.kind === 'error') {
    return (
      <Card>
        <Banner tone="error">{phase.message}</Banner>
        <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
          <button style={btnStyle('primary')} onClick={() => void save()}>
            {t('openclaw.wizard.tryAgain')}
          </button>
          <button
            style={btnStyle('secondary')}
            onClick={() => setPhase({ kind: 'idle' })}
          >
            {t('openclaw.wizard.backToReview')}
          </button>
        </div>
      </Card>
    );
  }

  if (phase.kind === 'done') {
    return <DoneCard config={phase.config} caps={caps} onFinish={onDone} />;
  }

  // ---- Wizard steps ------------------------------------------------------
  return (
    <Card>
      <StepDots total={FLOW.length} current={stepIdx} />

      {step === 'welcome' ? (
        <StepShell
          glyph=">_"
          title={t('openclaw.wizard.welcomeTitle')}
          subtitle={t('openclaw.wizard.welcomeSubtitle')}
        >
          <ul
            style={{
              margin: '4px 0 0',
              paddingInlineStart: 18,
              color: C.muted,
              fontSize: 13,
              lineHeight: 1.7,
            }}
          >
            <li>{t('openclaw.wizard.welcomeLi1')}</li>
            <li>{t('openclaw.wizard.welcomeLi2')}</li>
            <li>{t('openclaw.wizard.welcomeLi3')}</li>
          </ul>
        </StepShell>
      ) : null}

      {step === 'runtime' ? (
        <StepShell
          glyph="⚙"
          title={t('openclaw.wizard.runtimeTitle')}
          subtitle={t('openclaw.wizard.runtimeSubtitle')}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {RUNTIMES.map(rt => {
              const on = rt === runtime;
              return (
                <button
                  key={rt}
                  type="button"
                  onClick={() => setRuntime(rt)}
                  style={{
                    appearance: 'none',
                    textAlign: 'left',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 12,
                    padding: '13px 14px',
                    borderRadius: 10,
                    background: on ? C.accentSoft : C.bg,
                    border: `1px solid ${on ? C.accentBorder : C.border}`,
                    color: C.text,
                    transition: 'background 150ms ease, border-color 150ms ease',
                  }}
                >
                  <span
                    aria-hidden
                    style={{
                      width: 16,
                      height: 16,
                      flexShrink: 0,
                      borderRadius: '50%',
                      border: `2px solid ${on ? C.accent : C.border}`,
                      background: on ? C.accent : 'transparent',
                    }}
                  />
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span
                      style={{
                        display: 'block',
                        fontSize: 14,
                        fontWeight: 700,
                        color: C.text,
                      }}
                    >
                      {RUNTIME_LABELS[rt] ?? rt}{' '}
                      <span
                        style={{
                          fontFamily: monoFamily,
                          fontSize: 11,
                          fontWeight: 600,
                          color: C.muted,
                        }}
                      >
                        {rt}
                      </span>
                    </span>
                    <span
                      style={{ fontSize: 12.5, color: C.muted, lineHeight: 1.5 }}
                    >
                      {RUNTIME_BLURB[rt] ?? ''}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        </StepShell>
      ) : null}

      {step === 'preview' ? (
        <StepShell
          glyph="🖥"
          title={t('openclaw.wizard.previewTitle')}
          subtitle={t('openclaw.wizard.previewSubtitle')}
        >
          <Toggle
            checked={previewAutoOpen}
            onChange={setPreviewAutoOpen}
            label={t('openclaw.wizard.previewToggle')}
            hint={t('openclaw.wizard.previewHint')}
          />
        </StepShell>
      ) : null}

      {step === 'sandbox' ? (
        <StepShell
          glyph="🔒"
          title={t('openclaw.wizard.sandboxTitle')}
          subtitle={t('openclaw.wizard.sandboxSubtitle')}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {capsState === 'loading' ? (
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  color: C.muted,
                  padding: '8px 2px',
                }}
              >
                <Spinner /> {t('openclaw.sandbox.checking')}
              </div>
            ) : capsState === 'error' ? (
              <Banner tone="error">
                {t('openclaw.sandbox.err.capsLoad')}{' '}
                <button style={{ ...btnStyle('secondary'), padding: '2px 8px', fontSize: 12 }} onClick={onReloadCaps}>
                  {t('openclaw.sandbox.recheck')}
                </button>
              </Banner>
            ) : (
              <>
                <SandboxStatus caps={caps} />
                {!caps?.sandbox ? (
                  <Banner tone="info">
                    {t('openclaw.wizard.sandboxGenerateOnly')}
                  </Banner>
                ) : null}
                {/* Two distinct affordances: the REAL create→exec→teardown probe
                    (honest), and the cheap capability re-read below it. */}
                <SandboxHealthButton />
                <div>
                  <button
                    style={{
                      ...btnStyle('secondary'),
                      padding: '6px 12px',
                      fontSize: 12,
                    }}
                    onClick={onReloadCaps}
                  >
                    {'↻ '}
                    {t('openclaw.sandbox.recheck')}
                  </button>
                </div>
              </>
            )}
          </div>
        </StepShell>
      ) : null}

      {step === 'review' ? (
        <StepShell
          glyph="✅"
          title={t('openclaw.wizard.reviewTitle')}
          subtitle={t('openclaw.wizard.reviewSubtitle')}
        >
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 2,
              borderRadius: 10,
              overflow: 'hidden',
              border: `1px solid ${C.border}`,
            }}
          >
            <ReviewRow
              label={t('openclaw.wizard.rowRuntime')}
              value={`${RUNTIME_LABELS[runtime] ?? runtime} (${runtime})`}
              onEdit={() => setStepIdx(FLOW.indexOf('runtime'))}
              editLabel={t('openclaw.wizard.edit')}
            />
            <ReviewRow
              label={t('openclaw.wizard.rowPreview')}
              value={
                previewAutoOpen
                  ? t('openclaw.wizard.valOn')
                  : t('openclaw.wizard.valOff')
              }
              onEdit={() => setStepIdx(FLOW.indexOf('preview'))}
              editLabel={t('openclaw.wizard.edit')}
            />
            <ReviewRow
              label={t('openclaw.wizard.rowExec')}
              value={
                capsState !== 'ready'
                  ? t('openclaw.wizard.valUnknown')
                  : caps?.sandbox
                    ? t('openclaw.wizard.valExecOn')
                    : t('openclaw.wizard.valExecOff')
              }
              onEdit={() => setStepIdx(FLOW.indexOf('sandbox'))}
              editLabel={t('openclaw.wizard.edit')}
            />
          </div>
          <Banner tone="info">{t('openclaw.wizard.reviewNote')}</Banner>
        </StepShell>
      ) : null}

      {/* Footer nav */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          marginTop: 22,
        }}
      >
        {stepIdx > 0 ? (
          <button style={btnStyle('secondary')} onClick={back}>
            {t('openclaw.wizard.back')}
          </button>
        ) : hasExisting && onCancel ? (
          <button style={btnStyle('secondary')} onClick={onCancel}>
            {t('openclaw.wizard.cancel')}
          </button>
        ) : (
          <span />
        )}
        <div style={{ flex: 1 }} />
        {step === 'review' ? (
          <button style={btnStyle('primary')} onClick={() => void save()}>
            {t('openclaw.wizard.finish')} →
          </button>
        ) : (
          <button style={btnStyle('primary')} onClick={next}>
            {step === 'welcome'
              ? t('openclaw.wizard.getStarted')
              : t('openclaw.wizard.continue')}{' '}
            →
          </button>
        )}
      </div>
    </Card>
  );
};

// ---- sub-components --------------------------------------------------------

const Card = ({ children }: { children: ReactNode }) => (
  <div
    style={{
      maxWidth: 560,
      margin: '0 auto',
      padding: 24,
      borderRadius: 14,
      background: C.panel,
      border: `1px solid ${C.border}`,
      display: 'flex',
      flexDirection: 'column',
    }}
  >
    {children}
  </div>
);

const StepShell = ({
  glyph,
  title,
  subtitle,
  children,
}: {
  glyph: string;
  title: string;
  subtitle: string;
  children?: ReactNode;
}) => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div
        aria-hidden
        style={{
          fontSize: 26,
          fontFamily: monoFamily,
          fontWeight: 700,
          color: C.accent,
        }}
      >
        {glyph}
      </div>
      <h2 style={{ margin: 0, fontSize: 20, fontWeight: 800, color: C.text }}>
        {title}
      </h2>
      <p
        style={{
          margin: 0,
          fontSize: 13.5,
          color: C.muted,
          lineHeight: 1.55,
        }}
      >
        {subtitle}
      </p>
    </div>
    {children}
  </div>
);

const StepDots = ({ total, current }: { total: number; current: number }) => (
  <div style={{ display: 'flex', gap: 6, marginBottom: 20 }}>
    {Array.from({ length: total }).map((_, i) => (
      <span
        key={i}
        style={{
          height: 4,
          flex: 1,
          borderRadius: 2,
          background: i <= current ? C.accent : C.border,
          transition: 'background 200ms ease',
        }}
      />
    ))}
  </div>
);

const Toggle = ({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  hint?: string;
}) => (
  <button
    type="button"
    role="switch"
    aria-checked={checked}
    onClick={() => onChange(!checked)}
    style={{
      appearance: 'none',
      textAlign: 'left',
      cursor: 'pointer',
      display: 'flex',
      alignItems: 'flex-start',
      gap: 12,
      padding: '13px 14px',
      borderRadius: 10,
      background: C.bg,
      border: `1px solid ${checked ? C.accentBorder : C.border}`,
      color: C.text,
      transition: 'border-color 150ms ease',
    }}
  >
    <span
      aria-hidden
      style={{
        width: 38,
        height: 22,
        flexShrink: 0,
        borderRadius: 999,
        padding: 2,
        marginTop: 1,
        background: checked ? C.accent : C.border,
        transition: 'background 160ms ease',
        display: 'inline-flex',
        justifyContent: checked ? 'flex-end' : 'flex-start',
      }}
    >
      <span
        style={{
          width: 18,
          height: 18,
          borderRadius: '50%',
          background: '#fff',
          transition: 'transform 160ms ease',
        }}
      />
    </span>
    <span style={{ flex: 1, minWidth: 0 }}>
      <span
        style={{
          display: 'block',
          fontSize: 14,
          fontWeight: 700,
          color: C.text,
        }}
      >
        {label}
      </span>
      {hint ? (
        <span style={{ fontSize: 12.5, color: C.muted, lineHeight: 1.5 }}>
          {hint}
        </span>
      ) : null}
    </span>
  </button>
);

const ReviewRow = ({
  label,
  value,
  onEdit,
  editLabel,
}: {
  label: string;
  value: string;
  onEdit: () => void;
  editLabel: string;
}) => (
  <div
    style={{
      display: 'flex',
      alignItems: 'center',
      gap: 10,
      padding: '11px 14px',
      background: C.bg,
    }}
  >
    <span style={{ fontSize: 12, color: C.muted, width: 132, flexShrink: 0 }}>
      {label}
    </span>
    <span
      style={{
        flex: 1,
        fontSize: 13.5,
        fontWeight: 600,
        color: C.text,
        wordBreak: 'break-word',
      }}
    >
      {value || '—'}
    </span>
    <button
      style={{
        appearance: 'none',
        background: 'none',
        border: 'none',
        cursor: 'pointer',
        color: C.accent,
        fontSize: 12,
        fontWeight: 600,
        padding: 0,
      }}
      onClick={onEdit}
    >
      {editLabel}
    </button>
  </div>
);

// The success screen: confirms the saved defaults + honest sandbox status, then
// hands off to the dashboard.
const DoneCard = ({
  config,
  caps,
  onFinish,
}: {
  config: OpenClawConfig;
  caps: ClawCapabilities | null;
  onFinish: (config: OpenClawConfig) => void;
}) => {
  const { t } = useAgentLang();
  return (
    <Card>
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
          alignItems: 'center',
          textAlign: 'center',
        }}
      >
        <div style={{ fontSize: 40 }} aria-hidden>
          🎉
        </div>
        <h2 style={{ margin: 0, fontSize: 22, fontWeight: 800, color: C.text }}>
          {t('openclaw.done.title')}
        </h2>
        <p style={{ margin: 0, fontSize: 13.5, color: C.muted }}>
          {t('openclaw.done.subtitle')}
        </p>
      </div>

      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
          marginTop: 22,
        }}
      >
        <div
          style={{
            display: 'flex',
            gap: 10,
            borderRadius: 12,
            overflow: 'hidden',
            border: `1px solid ${C.border}`,
          }}
        >
          <SummaryTile
            label={t('openclaw.done.runtime')}
            value={RUNTIME_LABELS[config.defaultRuntime ?? 'node24'] ?? 'Node.js 24'}
          />
          <SummaryTile
            label={t('openclaw.done.autoPreview')}
            value={
              config.previewAutoOpen
                ? t('openclaw.wizard.valOn')
                : t('openclaw.wizard.valOff')
            }
          />
        </div>
        <SandboxStatus caps={caps} />
      </div>

      <div style={{ display: 'flex', marginTop: 22 }}>
        <div style={{ flex: 1 }} />
        <button style={btnStyle('primary')} onClick={() => onFinish(config)}>
          {t('openclaw.done.goDashboard')} →
        </button>
      </div>
    </Card>
  );
};

const SummaryTile = ({ label, value }: { label: string; value: string }) => (
  <div
    style={{
      flex: 1,
      minWidth: 0,
      padding: '12px 14px',
      background: C.bg,
    }}
  >
    <div
      style={{
        fontSize: 10,
        fontWeight: 700,
        letterSpacing: '0.05em',
        textTransform: 'uppercase',
        color: C.muted,
      }}
    >
      {label}
    </div>
    <div
      style={{
        fontSize: 14,
        fontWeight: 700,
        color: C.text,
        marginTop: 2,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      }}
    >
      {value}
    </div>
  </div>
);
