import { artifactStore } from '@affine/core/modules/ai-artifacts/store';
import { type ReactNode, useCallback, useMemo, useState } from 'react';

import {
  Banner,
  btnStyle,
  C,
  deployApp,
  type DeployResult,
  Field,
  fetchTemplate,
  hintStyle,
  inputStyle,
  type MineApp,
  type PublishCapInfo,
  type ShopSettings,
  Spinner,
  validateAccent,
  validatePin,
  validateStoreName,
  validateWhatsapp,
} from './shoperp-shared';
import {
  TemplatePicker,
  TemplatePickerLoading,
  useShopTemplates,
} from './template-picker';

// ---------------------------------------------------------------------------
// ShopERP onboarding wizard. Walks a first-time user through a per-store
// customization, then hits the REAL backend: mint the shop template (with the
// C5 settings), stage the paired ERP, and publish the shop (with the 409
// publish-cap replace flow). Every artifact is saved to the shared studio shelf
// (artifactStore) so the shop/ERP also show up in the AI Builder Studio.
// ---------------------------------------------------------------------------

// Six curated swatches (the same tasteful palette the shop admin offers) + a
// custom hex input. First value is the shop template default (teal).
const SWATCHES = [
  '#0f766e',
  '#2563eb',
  '#7c3aed',
  '#db2777',
  '#dc2626',
  '#16a34a',
] as const;

type Step =
  | 'welcome'
  | 'template'
  | 'name'
  | 'whatsapp'
  | 'accent'
  | 'pin'
  | 'review';
// Base flow (no template step) — the exact pre-catalog order. The `template`
// step is spliced in at runtime only when the catalog endpoint returns ≥1
// template (see the derived `FLOW` below), so a server with the catalog flag
// OFF walks this identical flow and mints a byte-identical (no-templateId) shop.
const BASE_FLOW: Step[] = [
  'welcome',
  'name',
  'whatsapp',
  'accent',
  'pin',
  'review',
];

// The create phase after the user confirms on the Review step.
type Phase =
  | { kind: 'idle' }
  | { kind: 'creating'; label: string }
  | { kind: 'cap'; info: PublishCapInfo } // publish limit reached — pick a replace
  | { kind: 'done'; result: CreateResult }
  | { kind: 'error'; message: string };

interface CreateResult {
  storeName: string;
  shopSlug: string;
  erpSlug: string;
  // The shared pairing key (== the shop slug). Threaded to the ERP publish so
  // the ERP's publish record carries the same storeSlug.
  storeSlug: string;
  shopUrl: string; // published storefront URL ('' if not yet published)
  erpPublished: boolean;
  erpUrl: string;
}

// Save an app artifact to the shared shelf, mirroring the Ready-Shop button's
// saveAppArtifact (canonical `app_<slug>` id so a later publish upserts it).
function saveArtifact(input: {
  slug: string;
  title: string;
  html: string;
  storeSlug: string;
  kind: 'shop' | 'erp';
  url?: string;
}) {
  const id = `app_${input.slug}`;
  const existing = artifactStore.get(id);
  artifactStore.upsert({
    ...(existing ?? {
      id,
      type: 'app',
      sessionId: 'draft',
      mimeType: 'text/html',
      prompt: input.kind === 'shop' ? 'ShopERP — storefront' : 'ShopERP — ERP',
    }),
    id,
    type: 'app',
    title: input.title,
    payload: input.html,
    slug: input.slug,
    storeSlug: input.storeSlug,
    kind: input.kind,
    ...(input.url ? { url: input.url } : {}),
  });
}

export const ShopWizard = ({
  onDone,
  onCancel,
  hasExistingApps,
}: {
  // Called after a successful creation once the user leaves the result screen.
  onDone: () => void;
  // Called to abandon the wizard (only shown when apps already exist).
  onCancel?: () => void;
  hasExistingApps: boolean;
}) => {
  const [stepIdx, setStepIdx] = useState(0);

  // WS4-5: the shop-template catalog (fetched once). `ready` with ≥1 template
  // inserts the picker step after `welcome`; `loading`/`unavailable` leave the
  // base flow untouched (today's exact flow). `selectedTemplateId` (null =
  // "Sans modèle") is forwarded into the mint call ONLY when set.
  const templatesState = useShopTemplates();
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(
    null
  );
  const FLOW = useMemo<Step[]>(() => {
    if (templatesState.kind !== 'ready') return BASE_FLOW;
    // Splice `template` right after `welcome`.
    return [
      'welcome',
      'template',
      ...BASE_FLOW.slice(1),
    ] as Step[];
  }, [templatesState.kind]);

  // Clamp the cursor if the flow length changed under us (e.g. the catalog
  // resolved while the user sat on `welcome`): keep the same logical step.
  const step = FLOW[Math.min(stepIdx, FLOW.length - 1)];

  // Settings model — seeded with the template defaults so a user who clicks
  // straight through gets a valid, byte-default shop.
  const [storeName, setStoreName] = useState('Ma Boutique');
  const [whatsapp, setWhatsapp] = useState('213600000000');
  const [accent, setAccent] = useState<string>('#0f766e');
  const [pin, setPin] = useState('1234');
  const [pinConfirm, setPinConfirm] = useState('1234');

  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });

  // Per-field validation (client mirror of the C5 server rules).
  const nameErr = validateStoreName(storeName);
  const waErr = validateWhatsapp(whatsapp);
  const accentErr = validateAccent(accent);
  const pinErr = validatePin(pin);
  const pinMatchErr =
    !pinErr && pin !== pinConfirm ? 'The two PINs don’t match.' : null;

  const settings: ShopSettings = useMemo(
    () => ({
      storeName: storeName.trim(),
      whatsapp,
      accentColor: accent,
      adminPin: pin,
    }),
    [storeName, whatsapp, accent, pin]
  );

  const canAdvance = ((): boolean => {
    switch (step) {
      case 'name':
        return !nameErr;
      case 'whatsapp':
        return !waErr;
      case 'accent':
        return !accentErr;
      case 'pin':
        return !pinErr && !pinMatchErr;
      default:
        return true;
    }
  })();

  const next = useCallback(() => {
    setStepIdx(i => Math.min(i + 1, FLOW.length - 1));
  }, []);
  const back = useCallback(() => {
    setStepIdx(i => Math.max(i - 1, 0));
  }, []);

  // ---- The real creation pipeline ----------------------------------------
  // 1) mint shop template (settings) 2) mint paired ERP (same storeSlug)
  // 3) stage both on the studio shelf 4) publish the shop (deploy). A 409 puts
  // us into the cap-replace phase; the user picks a slug to replace then we
  // retry the shop deploy with replaceSlug.
  const create = useCallback(
    async (replaceSlug?: string) => {
      setPhase({ kind: 'creating', label: 'Creating your storefront…' });
      try {
        // 1) Storefront template with the chosen settings. WS4-5: forward
        // the chosen templateId ONLY when set — an absent templateId keeps the
        // request byte-identical to the pre-catalog mint.
        const shop = await fetchTemplate({
          kind: 'shop',
          settings,
          ...(selectedTemplateId ? { templateId: selectedTemplateId } : {}),
        });
        const storeSlug = shop.storeSlug || shop.slug;
        saveArtifact({
          slug: shop.slug,
          title: settings.storeName,
          html: shop.html,
          storeSlug,
          kind: 'shop',
        });

        // 2) Paired ERP (same storeSlug + same settings so name/accent match).
        setPhase({ kind: 'creating', label: 'Preparing the paired ERP…' });
        let erpSlug = '';
        try {
          const erp = await fetchTemplate({
            kind: 'erp',
            storeSlug,
            settings,
          });
          erpSlug = erp.slug;
          saveArtifact({
            slug: erp.slug,
            title: `ERP — ${settings.storeName}`,
            html: erp.html,
            storeSlug,
            kind: 'erp',
          });
        } catch {
          // The storefront still succeeds; the ERP can be created later from
          // the management view. Don't unwind — just leave erpSlug empty.
        }

        // 3) Publish the storefront (this is what returns a live URL + counts
        // toward the publish cap). The ERP is staged, not auto-published, to
        // avoid tripping a cap of 1 on the very first run (mirrors Ready Shop).
        setPhase({ kind: 'creating', label: 'Publishing your storefront…' });
        const outcome = await deployApp({
          html: shop.html,
          slug: shop.slug,
          kind: 'shop',
          storeSlug,
          ...(replaceSlug ? { replaceSlug } : {}),
        });

        if (outcome.status === 'cap') {
          setPhase({ kind: 'cap', info: outcome.info });
          return;
        }
        if (outcome.status === 'upgrade') {
          setPhase({
            kind: 'error',
            message:
              'Publishing needs a Pro plan on this workspace. Your shop is saved in your Studio — upgrade to publish it live.',
          });
          return;
        }
        if (outcome.status === 'error') {
          setPhase({ kind: 'error', message: outcome.message });
          return;
        }

        const deployed: DeployResult = outcome.result;
        // Persist the live URL onto the shelf artifact.
        saveArtifact({
          slug: shop.slug,
          title: settings.storeName,
          html: shop.html,
          storeSlug,
          kind: 'shop',
          url: deployed.url,
        });
        setPhase({
          kind: 'done',
          result: {
            storeName: settings.storeName,
            shopSlug: shop.slug,
            erpSlug,
            storeSlug,
            shopUrl: deployed.url,
            erpPublished: false,
            erpUrl: '',
          },
        });
      } catch (err) {
        setPhase({
          kind: 'error',
          message:
            err instanceof Error ? err.message : 'Something went wrong. Please try again.',
        });
      }
    },
    [settings, selectedTemplateId]
  );

  // ----- Terminal phases (creating / cap / done / error) render standalone --
  if (phase.kind === 'creating') {
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
            {phase.label}
          </div>
          <div style={hintStyle}>This usually takes a few seconds.</div>
        </div>
      </Card>
    );
  }

  if (phase.kind === 'cap') {
    return (
      <ReplaceCap
        info={phase.info}
        onReplace={slug => void create(slug)}
        onCancel={() => setPhase({ kind: 'idle' })}
      />
    );
  }

  if (phase.kind === 'error') {
    return (
      <Card>
        <Banner tone="error">{phase.message}</Banner>
        <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
          <button style={btnStyle('primary')} onClick={() => void create()}>
            Try again
          </button>
          <button style={btnStyle('secondary')} onClick={() => setPhase({ kind: 'idle' })}>
            Back to review
          </button>
        </div>
      </Card>
    );
  }

  if (phase.kind === 'done') {
    return (
      <DoneCard
        result={phase.result}
        settings={settings}
        onFinish={onDone}
      />
    );
  }

  // ----- Wizard steps -------------------------------------------------------
  return (
    <Card>
      {/* Progress: dots for the customization steps (welcome + review framed) */}
      <StepDots total={FLOW.length} current={stepIdx} />

      {step === 'welcome' ? (
        <StepShell
          emoji="🛍️"
          title="Create your shop"
          subtitle="Let’s set up your online storefront — cash-on-delivery, WhatsApp checkout, and a matching back-office ERP. A few quick questions and you’re live."
        >
          <ul style={{ margin: '4px 0 0', paddingInlineStart: 18, color: C.muted, fontSize: 13, lineHeight: 1.7 }}>
            <li>Your store name &amp; brand color</li>
            <li>A WhatsApp number for orders</li>
            <li>A manager PIN to protect the admin</li>
          </ul>
        </StepShell>
      ) : null}

      {step === 'template' ? (
        <StepShell
          emoji="🎨"
          title="Choisissez un modèle"
          subtitle="Un point de départ adapté à votre activité — couleurs, catégories et produits d’exemple. Vous pourrez tout changer ensuite."
        >
          {templatesState.kind === 'ready' ? (
            <TemplatePicker
              templates={templatesState.templates}
              selectedTemplateId={selectedTemplateId}
              onSelect={setSelectedTemplateId}
            />
          ) : (
            <TemplatePickerLoading />
          )}
        </StepShell>
      ) : null}

      {step === 'name' ? (
        <StepShell emoji="🏷️" title="Store name" subtitle="What should customers see at the top of your shop?">
          <Field label="Store name" hint="Up to 60 characters." error={touchedErr(storeName, nameErr, 'Ma Boutique')}>
            <input
              style={inputStyle}
              value={storeName}
              maxLength={60}
              placeholder="Ma Boutique"
              onChange={e => setStoreName(e.target.value)}
              autoFocus
            />
          </Field>
        </StepShell>
      ) : null}

      {step === 'whatsapp' ? (
        <StepShell emoji="💬" title="WhatsApp number" subtitle="Orders are sent to this number as a WhatsApp message. Customers also use it to reach you.">
          <Field
            label="WhatsApp number"
            hint="International format, digits only, no “+”. Example: 213600000000 (Algeria)."
            error={touchedErr(whatsapp, waErr, '213600000000')}
          >
            <input
              style={inputStyle}
              value={whatsapp}
              inputMode="numeric"
              placeholder="213600000000"
              onChange={e => setWhatsapp(e.target.value.replace(/[^0-9]/g, '').slice(0, 15))}
              autoFocus
            />
          </Field>
        </StepShell>
      ) : null}

      {step === 'accent' ? (
        <StepShell emoji="🎨" title="Accent color" subtitle="Your buttons, highlights and header use this color.">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
              {SWATCHES.map(sw => {
                const on = accent.toLowerCase() === sw.toLowerCase();
                return (
                  <button
                    key={sw}
                    type="button"
                    onClick={() => setAccent(sw)}
                    aria-label={sw}
                    title={sw}
                    style={{
                      width: 38,
                      height: 38,
                      borderRadius: 10,
                      cursor: 'pointer',
                      background: sw,
                      border: on ? '3px solid #fff' : `2px solid ${C.border}`,
                      boxShadow: on ? `0 0 0 2px ${C.accent}` : 'none',
                      transition: 'box-shadow 150ms ease, border-color 150ms ease',
                    }}
                  />
                );
              })}
            </div>
            <Field label="Custom hex" hint="Or type your own, like #0f766e." error={accentErr}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span
                  aria-hidden
                  style={{
                    width: 34,
                    height: 34,
                    flexShrink: 0,
                    borderRadius: 8,
                    background: accentErr ? C.panel2 : accent,
                    border: `1px solid ${C.border}`,
                  }}
                />
                <input
                  style={{ ...inputStyle, maxWidth: 160 }}
                  value={accent}
                  maxLength={7}
                  placeholder="#0f766e"
                  onChange={e => {
                    let v = e.target.value.trim();
                    if (v && !v.startsWith('#')) v = `#${v}`;
                    setAccent(v.slice(0, 7));
                  }}
                />
              </div>
            </Field>
          </div>
        </StepShell>
      ) : null}

      {step === 'pin' ? (
        <StepShell emoji="🔑" title="Manager PIN" subtitle="This unlocks the admin area of your shop. Pick something you’ll remember.">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <Field label="PIN" hint="4–8 digits." error={touchedErr(pin, pinErr, '1234')}>
              <input
                style={inputStyle}
                value={pin}
                inputMode="numeric"
                type="password"
                placeholder="4–8 digits"
                onChange={e => setPin(e.target.value.replace(/[^0-9]/g, '').slice(0, 8))}
                autoFocus
              />
            </Field>
            <Field label="Confirm PIN" error={pinConfirm.length > 0 ? pinMatchErr : null}>
              <input
                style={inputStyle}
                value={pinConfirm}
                inputMode="numeric"
                type="password"
                placeholder="Re-enter your PIN"
                onChange={e => setPinConfirm(e.target.value.replace(/[^0-9]/g, '').slice(0, 8))}
              />
            </Field>
          </div>
        </StepShell>
      ) : null}

      {step === 'review' ? (
        <StepShell emoji="✅" title="Review" subtitle="Here’s your shop. You can change any of this later from the shop’s admin area.">
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
            <ReviewRow label="Store name" value={settings.storeName} onEdit={() => setStepIdx(FLOW.indexOf('name'))} />
            <ReviewRow label="WhatsApp" value={settings.whatsapp} onEdit={() => setStepIdx(FLOW.indexOf('whatsapp'))} />
            <ReviewRow
              label="Accent"
              value={settings.accentColor}
              swatch={settings.accentColor}
              onEdit={() => setStepIdx(FLOW.indexOf('accent'))}
            />
            <ReviewRow label="Manager PIN" value={'•'.repeat(settings.adminPin.length)} onEdit={() => setStepIdx(FLOW.indexOf('pin'))} />
          </div>
          <Banner tone="info">
            We’ll publish your storefront live and prepare a matching ERP
            dashboard in your Studio.
          </Banner>
        </StepShell>
      ) : null}

      {/* Footer nav */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 22 }}>
        {stepIdx > 0 ? (
          <button style={btnStyle('secondary')} onClick={back}>
            ← Back
          </button>
        ) : hasExistingApps && onCancel ? (
          <button style={btnStyle('secondary')} onClick={onCancel}>
            Cancel
          </button>
        ) : (
          <span />
        )}
        <div style={{ flex: 1 }} />
        {step === 'review' ? (
          <button style={btnStyle('primary')} onClick={() => void create()}>
            🚀 Create my shop
          </button>
        ) : (
          <button
            style={btnStyle('primary', !canAdvance)}
            disabled={!canAdvance}
            onClick={next}
          >
            {step === 'welcome' ? 'Get started' : 'Continue'} →
          </button>
        )}
      </div>
    </Card>
  );
};

// Show a field error only once the user has diverged from the seeded default
// (so the wizard doesn't scream red at first paint on the pre-filled defaults).
function touchedErr(value: string, err: string | null, seed: string): string | null {
  if (!err) return null;
  return value === seed ? null : err;
}

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
  emoji,
  title,
  subtitle,
  children,
}: {
  emoji: string;
  title: string;
  subtitle: string;
  children?: ReactNode;
}) => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ fontSize: 30 }} aria-hidden>
        {emoji}
      </div>
      <h2 style={{ margin: 0, fontSize: 20, fontWeight: 800, color: C.text }}>{title}</h2>
      <p style={{ margin: 0, fontSize: 13.5, color: C.muted, lineHeight: 1.55 }}>{subtitle}</p>
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

const ReviewRow = ({
  label,
  value,
  swatch,
  onEdit,
}: {
  label: string;
  value: string;
  swatch?: string;
  onEdit: () => void;
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
    <span style={{ fontSize: 12, color: C.muted, width: 108, flexShrink: 0 }}>{label}</span>
    {swatch ? (
      <span
        aria-hidden
        style={{ width: 16, height: 16, borderRadius: 4, background: swatch, border: `1px solid ${C.border}` }}
      />
    ) : null}
    <span style={{ flex: 1, fontSize: 13.5, fontWeight: 600, color: C.text, wordBreak: 'break-word' }}>
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
      Edit
    </button>
  </div>
);

// The 409 publish-cap replace flow: list the existing apps and let the user
// pick one to replace (destructive — it deletes that published app first).
const ReplaceCap = ({
  info,
  onReplace,
  onCancel,
}: {
  info: PublishCapInfo;
  onReplace: (slug: string) => void;
  onCancel: () => void;
}) => {
  const [chosen, setChosen] = useState<string>('');
  const [confirming, setConfirming] = useState(false);
  return (
    <Card>
      <StepShell
        emoji="⚠️"
        title="Publish limit reached"
        subtitle={`Your workspace can keep ${info.limit} published app${info.limit === 1 ? '' : 's'} at a time. To publish your new shop, pick one to replace — it will be unpublished.`}
      >
        {info.existing.length === 0 ? (
          <Banner tone="warn">
            No replaceable apps were returned. Delete an app from the management
            view, then try again.
          </Banner>
        ) : (
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
            {info.existing.map(app => {
              const on = chosen === app.slug;
              return (
                <button
                  key={app.slug}
                  type="button"
                  onClick={() => setChosen(app.slug)}
                  style={{
                    appearance: 'none',
                    textAlign: 'left',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    padding: '11px 14px',
                    background: on ? C.accentSoft : C.bg,
                    border: 'none',
                    borderInlineStart: `3px solid ${on ? C.accent : 'transparent'}`,
                    color: C.text,
                  }}
                >
                  <span
                    style={{
                      width: 14,
                      height: 14,
                      borderRadius: '50%',
                      flexShrink: 0,
                      border: `2px solid ${on ? C.accent : C.border}`,
                      background: on ? C.accent : 'transparent',
                    }}
                  />
                  <span style={{ flex: 1, fontSize: 13, fontWeight: 600, fontFamily: 'var(--affine-font-code-family, monospace)' }}>
                    {app.slug}
                  </span>
                  <span style={{ fontSize: 11, color: C.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 200 }}>
                    {app.url}
                  </span>
                </button>
              );
            })}
          </div>
        )}
        {confirming && chosen ? (
          <Banner tone="error">
            This permanently unpublishes <strong>{chosen}</strong>. This can’t be
            undone. Continue?
          </Banner>
        ) : null}
      </StepShell>
      <div style={{ display: 'flex', gap: 10, marginTop: 20 }}>
        <button style={btnStyle('secondary')} onClick={onCancel}>
          ← Back
        </button>
        <div style={{ flex: 1 }} />
        {!confirming ? (
          <button
            style={btnStyle('danger', !chosen)}
            disabled={!chosen}
            onClick={() => setConfirming(true)}
          >
            Replace &amp; publish
          </button>
        ) : (
          <button style={btnStyle('danger')} onClick={() => onReplace(chosen)}>
            Yes, replace {chosen}
          </button>
        )}
      </div>
    </Card>
  );
};

// The success screen: live shop link, ERP link/publish, "in your Studio" note.
const DoneCard = ({
  result,
  settings,
  onFinish,
}: {
  result: CreateResult;
  settings: ShopSettings;
  onFinish: () => void;
}) => {
  // Publish the (staged) ERP on demand. Reuses the same deploy + cap contract.
  const [erpState, setErpState] = useState<
    | { kind: 'idle' }
    | { kind: 'publishing' }
    | { kind: 'published'; url: string }
    | { kind: 'cap' }
    | { kind: 'error'; message: string }
  >(result.erpPublished ? { kind: 'published', url: result.erpUrl } : { kind: 'idle' });

  const publishErp = useCallback(async () => {
    if (!result.erpSlug) return;
    setErpState({ kind: 'publishing' });
    // We need the ERP HTML to deploy; read it back from the shelf artifact.
    const art = artifactStore.get(`app_${result.erpSlug}`);
    const html = art?.payload;
    if (!html) {
      setErpState({ kind: 'error', message: 'ERP source not found — open it from Manage.' });
      return;
    }
    const outcome = await deployApp({
      html,
      slug: result.erpSlug,
      kind: 'erp',
      storeSlug: result.storeSlug,
    });
    if (outcome.status === 'ok') {
      setErpState({ kind: 'published', url: outcome.result.url });
      artifactStore.upsert({
        ...(art as NonNullable<typeof art>),
        url: outcome.result.url,
      });
    } else if (outcome.status === 'cap') {
      setErpState({ kind: 'cap' });
    } else if (outcome.status === 'upgrade') {
      setErpState({ kind: 'error', message: 'Publishing the ERP needs a Pro plan.' });
    } else {
      setErpState({ kind: 'error', message: outcome.message });
    }
  }, [result.erpSlug, result.storeSlug]);

  return (
    <Card>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'center', textAlign: 'center' }}>
        <div style={{ fontSize: 40 }} aria-hidden>
          🎉
        </div>
        <h2 style={{ margin: 0, fontSize: 22, fontWeight: 800, color: C.text }}>
          {result.storeName} is ready
        </h2>
        <p style={{ margin: 0, fontSize: 13.5, color: C.muted }}>
          Your storefront is live and a matching ERP is waiting in your Studio.
        </p>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 22 }}>
        {/* Shop */}
        <ResultTile
          emoji="🛍️"
          title="Storefront"
          subtitle={result.shopUrl || 'Published'}
          accent={settings.accentColor}
        >
          {result.shopUrl ? (
            <a
              href={result.shopUrl}
              target="_blank"
              rel="noopener noreferrer"
              style={{ ...btnStyle('primary'), textDecoration: 'none' }}
            >
              Open shop ↗
            </a>
          ) : null}
        </ResultTile>

        {/* ERP */}
        <ResultTile
          emoji="📊"
          title="ERP dashboard"
          subtitle={
            erpState.kind === 'published'
              ? erpState.url
              : result.erpSlug
                ? 'Staged in your Studio — publish to get a live link'
                : 'Not created — add it from Manage'
          }
          accent="#2f6bff"
        >
          {erpState.kind === 'published' && erpState.url ? (
            <a
              href={erpState.url}
              target="_blank"
              rel="noopener noreferrer"
              style={{ ...btnStyle('primary'), textDecoration: 'none' }}
            >
              Open ERP ↗
            </a>
          ) : result.erpSlug ? (
            <button
              style={btnStyle('secondary', erpState.kind === 'publishing')}
              disabled={erpState.kind === 'publishing'}
              onClick={() => void publishErp()}
            >
              {erpState.kind === 'publishing' ? (
                <>
                  <Spinner /> Publishing…
                </>
              ) : (
                'Publish ERP'
              )}
            </button>
          ) : null}
        </ResultTile>

        {erpState.kind === 'cap' ? (
          <Banner tone="warn">
            You’re at the publish limit. Free a slot from{' '}
            <strong>Manage</strong>, then publish the ERP.
          </Banner>
        ) : erpState.kind === 'error' ? (
          <Banner tone="error">{erpState.message}</Banner>
        ) : null}

        <Banner tone="info">
          Both apps live on the shared shelf in your AI Builder{' '}
          <strong>Studio</strong> — open them there to keep editing.
        </Banner>
      </div>

      <div style={{ display: 'flex', marginTop: 22 }}>
        <div style={{ flex: 1 }} />
        <button style={btnStyle('primary')} onClick={onFinish}>
          Go to my shops →
        </button>
      </div>
    </Card>
  );
};

const ResultTile = ({
  emoji,
  title,
  subtitle,
  accent,
  children,
}: {
  emoji: string;
  title: string;
  subtitle: string;
  accent: string;
  children?: ReactNode;
}) => (
  <div
    style={{
      display: 'flex',
      alignItems: 'center',
      gap: 12,
      padding: 14,
      borderRadius: 12,
      background: C.bg,
      border: `1px solid ${C.border}`,
    }}
  >
    <div
      style={{
        width: 40,
        height: 40,
        borderRadius: 10,
        flexShrink: 0,
        display: 'grid',
        placeItems: 'center',
        fontSize: 20,
        background: `color-mix(in srgb, ${accent} 22%, transparent)`,
      }}
      aria-hidden
    >
      {emoji}
    </div>
    <div style={{ flex: 1, minWidth: 0 }}>
      <div style={{ fontSize: 13.5, fontWeight: 700, color: C.text }}>{title}</div>
      <div
        style={{
          fontSize: 12,
          color: C.muted,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
        title={subtitle}
      >
        {subtitle}
      </div>
    </div>
    {children}
  </div>
);
