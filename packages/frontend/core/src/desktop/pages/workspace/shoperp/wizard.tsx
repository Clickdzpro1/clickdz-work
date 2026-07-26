import { artifactStore } from '@affine/core/modules/ai-artifacts/store';
import { type ReactNode, useCallback, useMemo, useRef, useState } from 'react';

import { PENDING_SHOP_KEY, type PendingShop } from '../../clickdz-welcome';
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

/**
 * Read and CONSUME the /welcome handoff (shop name + WhatsApp). One-shot: the
 * key is removed on read so a later visit to the wizard starts clean rather
 * than silently resurrecting a stale name. Fail-soft in private mode.
 */
function readPendingShop(): PendingShop | null {
  try {
    const raw = localStorage.getItem(PENDING_SHOP_KEY);
    if (!raw) return null;
    localStorage.removeItem(PENDING_SHOP_KEY);
    const parsed = JSON.parse(raw) as PendingShop;
    return parsed && typeof parsed.shopName === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

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

// The flow WITH the template step spliced in right after `welcome`. Precomputed
// as a module constant so both variants are stable references we can switch
// between deterministically (never reshuffled element-by-element under a live
// cursor).
const TEMPLATE_FLOW: Step[] = [
  'welcome',
  'template',
  ...BASE_FLOW.slice(1),
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

  // -------------------------------------------------------------------------
  // FLOW — single source of truth for the step order, captured STABLY.
  //
  // The catalog fetch resolves asynchronously. If we recomputed FLOW on every
  // render and then let it grow (BASE_FLOW→TEMPLATE_FLOW) *after* the user had
  // already walked past `welcome`, the index of every later step would shift
  // under the live cursor — jumping the user backwards mid-wizard. And any
  // navigation closure that captured the *old* length would clamp the cursor
  // short (the original stuck-at-PIN bug: `next` memoized with [] kept the
  // BASE_FLOW cap of 5, so advancing from `pin` clamped back to `pin` and
  // `review` was unreachable while the header still drew 7 dots).
  //
  // Fix: freeze the flow SHAPE the moment the user leaves `welcome` (stepIdx>0).
  // While still on `welcome` we track the live catalog result so the picker
  // step appears/disappears cleanly; once we advance, the shape is locked for
  // the rest of the session. Either way FLOW is a stable module reference, and
  // all navigation reads the CURRENT flow via a ref (never a stale closure).
  // -------------------------------------------------------------------------
  const lockedFlowRef = useRef<Step[] | null>(null);
  const FLOW = useMemo<Step[]>(() => {
    // Once locked (user advanced past welcome), never change the shape.
    if (lockedFlowRef.current) return lockedFlowRef.current;
    return templatesState.kind === 'ready' ? TEMPLATE_FLOW : BASE_FLOW;
  }, [templatesState.kind]);

  // Keep a live ref to the current FLOW so navigation callbacks always clamp
  // against the up-to-date length, independent of when they were memoized.
  const flowRef = useRef<Step[]>(FLOW);
  flowRef.current = FLOW;

  // Clamp the cursor if the flow length changed under us (defensive — with the
  // lock above the shape no longer changes after the first advance, but a
  // welcome→ready transition can still shrink/grow while on step 0): keep the
  // same logical step and never index out of bounds.
  const step = FLOW[Math.min(stepIdx, FLOW.length - 1)];

  // Settings model. Name and colour keep a sensible default; WhatsApp and the
  // PIN deliberately start EMPTY.
  //
  // They used to be seeded '213600000000' and '1234', which both PASS
  // validation — so a merchant could click straight through and publish a live
  // shop whose orders were routed to a placeholder number and whose back
  // office was protected by the most-guessed PIN in existence. They would then
  // reasonably conclude the product does not work. These are the two fields a
  // real shop cannot fake, so the wizard now insists on them.
  //
  // Name and WhatsApp are prefilled from the /welcome handoff when the merchant
  // just came through onboarding, so asking twice never happens.
  const pendingRef = useRef<PendingShop | null | undefined>(undefined);
  if (pendingRef.current === undefined) pendingRef.current = readPendingShop();
  const pending = pendingRef.current;

  const [storeName, setStoreName] = useState(pending?.shopName || 'Ma Boutique');
  const [whatsapp, setWhatsapp] = useState(pending?.whatsapp || '');
  const [accent, setAccent] = useState<string>('#0f766e');
  const [pin, setPin] = useState('');
  const [pinConfirm, setPinConfirm] = useState('');

  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });

  // A transient, human reason shown inline when the user taps Continue while a
  // gate is unmet (so advancing NEVER silently no-ops — the wizard always says
  // why). Cleared on any successful advance or field edit that re-enables.
  const [blockReason, setBlockReason] = useState<string | null>(null);

  // Per-field validation (client mirror of the C5 server rules).
  const nameErr = validateStoreName(storeName);
  const waErr = validateWhatsapp(whatsapp);
  const accentErr = validateAccent(accent);
  const pinErr = validatePin(pin);
  const pinMatchErr =
    !pinErr && pin !== pinConfirm ? 'Les deux PIN ne correspondent pas.' : null;

  const settings: ShopSettings = useMemo(
    () => ({
      storeName: storeName.trim(),
      whatsapp,
      accentColor: accent,
      adminPin: pin,
    }),
    [storeName, whatsapp, accent, pin]
  );

  // The gate for the current step, plus a reason string when it can't pass.
  // Returning the reason (not just a bool) lets Continue surface exactly what's
  // wrong even when the per-field error is masked (e.g. an untouched seed).
  const gateFor = useCallback(
    (s: Step): string | null => {
      switch (s) {
        case 'name':
          return nameErr;
        case 'whatsapp':
          return waErr;
        case 'accent':
          return accentErr;
        case 'pin':
          return pinErr ?? pinMatchErr;
        default:
          return null;
      }
    },
    [nameErr, waErr, accentErr, pinErr, pinMatchErr]
  );

  const canAdvance = gateFor(step) == null;

  const next = useCallback(() => {
    const flow = flowRef.current;
    const cur = flow[Math.min(stepIdx, flow.length - 1)];
    const reason = gateFor(cur);
    if (reason) {
      // Blocked by an unmet gate — SHOW why, and log a dev aid. Never no-op.
      setBlockReason(reason);
      if (process.env.NODE_ENV !== 'production') {
        console.warn(
          `[ShopWizard] blocked transition from "${cur}" (idx ${stepIdx}/${flow.length}): ${reason}`
        );
      }
      return;
    }
    setBlockReason(null);
    setStepIdx(i => {
      const f = flowRef.current;
      const target = Math.min(i + 1, f.length - 1);
      if (target === i && process.env.NODE_ENV !== 'production') {
        // Defensive: we passed the gate but the cursor can't move. This should
        // only ever happen on the last step (review is handled separately), so
        // a warning here would surface any future index-drift regression.
        console.warn(
          `[ShopWizard] advance produced no movement at idx ${i} (flow len ${f.length}, step "${f[i]}")`
        );
      }
      // Lock the flow shape the instant we leave welcome so a late catalog
      // resolve can't reshuffle indices under the cursor for the rest of the
      // session.
      if (i === 0 && !lockedFlowRef.current) {
        lockedFlowRef.current = f;
      }
      return target;
    });
  }, [stepIdx, gateFor]);

  const back = useCallback(() => {
    setBlockReason(null);
    setStepIdx(i => Math.max(i - 1, 0));
  }, []);

  // Jump straight to a named step (used by the Review "Edit" links). Resolves
  // the index against the CURRENT flow and clears any stale block reason.
  const goToStep = useCallback((s: Step) => {
    setBlockReason(null);
    const idx = flowRef.current.indexOf(s);
    if (idx >= 0) setStepIdx(idx);
  }, []);

  // ---- The real creation pipeline ----------------------------------------
  // 1) mint shop template (settings) 2) mint paired ERP (same storeSlug)
  // 3) stage both on the studio shelf 4) publish the shop (deploy). A 409 puts
  // us into the cap-replace phase; the user picks a slug to replace then we
  // retry the shop deploy with replaceSlug.
  const create = useCallback(
    async (replaceSlug?: string) => {
      setPhase({ kind: 'creating', label: 'Création de votre boutique…' });
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
        setPhase({ kind: 'creating', label: 'Préparation de l’ERP associé…' });
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
        setPhase({ kind: 'creating', label: 'Publication de votre boutique…' });
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
              'La publication demande un plan Pro sur cet espace de travail. Votre boutique est enregistrée dans votre Studio — passez au plan Pro pour la mettre en ligne.',
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
            err instanceof Error ? err.message : 'Une erreur est survenue. Réessayez.',
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
          <div style={hintStyle}>Cela prend quelques secondes en général.</div>
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
            Réessayer
          </button>
          <button style={btnStyle('secondary')} onClick={() => setPhase({ kind: 'idle' })}>
            Retour au récapitulatif
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
          title="Créez votre boutique"
          subtitle="On prépare votre boutique en ligne — paiement à la livraison, commande par WhatsApp et un ERP de gestion assorti. Quelques questions rapides et vous êtes en ligne."
        >
          <ul style={{ margin: '4px 0 0', paddingInlineStart: 18, color: C.muted, fontSize: 13, lineHeight: 1.7 }}>
            <li>Le nom de votre boutique &amp; sa couleur</li>
            <li>Un numéro WhatsApp pour les commandes</li>
            <li>Un PIN gérant pour protéger l’espace admin</li>
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
        <StepShell emoji="🏷️" title="Nom de la boutique" subtitle="Quel nom vos clients verront-ils en haut de votre boutique ?">
          <Field label="Nom de la boutique" hint="Jusqu’à 60 caractères." error={touchedErr(storeName, nameErr, 'Ma Boutique')}>
            <input
              style={inputStyle}
              value={storeName}
              maxLength={60}
              placeholder="Ma Boutique"
              onChange={e => {
                setStoreName(e.target.value);
                setBlockReason(null);
              }}
              autoFocus
            />
          </Field>
        </StepShell>
      ) : null}

      {step === 'whatsapp' ? (
        <StepShell emoji="💬" title="Numéro WhatsApp" subtitle="Les commandes arrivent sur ce numéro en message WhatsApp. Vos clients l’utilisent aussi pour vous joindre.">
          <Field
            label="Numéro WhatsApp"
            hint="Format international, chiffres uniquement, sans « + ». Exemple : 213600000000 (Algérie)."
            error={touchedErr(whatsapp, waErr, '')}
          >
            <input
              style={inputStyle}
              value={whatsapp}
              inputMode="numeric"
              placeholder="213600000000"
              onChange={e => {
                setWhatsapp(e.target.value.replace(/[^0-9]/g, '').slice(0, 15));
                setBlockReason(null);
              }}
              autoFocus
            />
          </Field>
        </StepShell>
      ) : null}

      {step === 'accent' ? (
        <StepShell emoji="🎨" title="Couleur d’accent" subtitle="Vos boutons, vos accents et l’en-tête utilisent cette couleur.">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
              {SWATCHES.map(sw => {
                const on = accent.toLowerCase() === sw.toLowerCase();
                return (
                  <button
                    key={sw}
                    type="button"
                    onClick={() => {
                      setAccent(sw);
                      setBlockReason(null);
                    }}
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
            <Field label="Hex personnalisé" hint="Ou saisissez la vôtre, comme #0f766e." error={accentErr}>
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
                    setBlockReason(null);
                  }}
                />
              </div>
            </Field>
          </div>
        </StepShell>
      ) : null}

      {step === 'pin' ? (
        <StepShell emoji="🔑" title="PIN du gérant" subtitle="Il déverrouille l’espace admin de votre boutique. Choisissez un code facile à retenir.">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <Field label="PIN" hint="4–8 chiffres." error={touchedErr(pin, pinErr, '')}>
              <input
                style={inputStyle}
                value={pin}
                inputMode="numeric"
                type="password"
                placeholder="4–8 chiffres"
                onChange={e => {
                  setPin(e.target.value.replace(/[^0-9]/g, '').slice(0, 8));
                  setBlockReason(null);
                }}
                autoFocus
              />
            </Field>
            <Field label="Confirmez le PIN" error={pinConfirm.length > 0 ? pinMatchErr : null}>
              <input
                style={inputStyle}
                value={pinConfirm}
                inputMode="numeric"
                type="password"
                placeholder="Saisissez le PIN à nouveau"
                onChange={e => {
                  setPinConfirm(e.target.value.replace(/[^0-9]/g, '').slice(0, 8));
                  setBlockReason(null);
                }}
              />
            </Field>
          </div>
        </StepShell>
      ) : null}

      {step === 'review' ? (
        <StepShell emoji="✅" title="Récapitulatif" subtitle="Voici votre boutique. Vous pourrez tout changer plus tard depuis l’espace admin.">
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
            <ReviewRow label="Nom de la boutique" value={settings.storeName} onEdit={() => goToStep('name')} />
            <ReviewRow label="WhatsApp" value={settings.whatsapp} onEdit={() => goToStep('whatsapp')} />
            <ReviewRow
              label="Couleur"
              value={settings.accentColor}
              swatch={settings.accentColor}
              onEdit={() => goToStep('accent')}
            />
            <ReviewRow label="PIN du gérant" value={'•'.repeat(settings.adminPin.length)} onEdit={() => goToStep('pin')} />
          </div>
          <Banner tone="info">
            Votre boutique sera publiée en ligne et son tableau de bord ERP
            sera prêt dans votre Studio.
          </Banner>
        </StepShell>
      ) : null}

      {/* Inline block reason — Continue never silently no-ops: a blocked tap
          explains itself here even when the per-field error is masked. */}
      {blockReason ? (
        <div style={{ marginTop: 14 }}>
          <Banner tone="error">{blockReason}</Banner>
        </div>
      ) : null}

      {/* Footer nav */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 22 }}>
        {stepIdx > 0 ? (
          <button style={btnStyle('secondary')} onClick={back}>
            ← Retour
          </button>
        ) : hasExistingApps && onCancel ? (
          <button style={btnStyle('secondary')} onClick={onCancel}>
            Annuler
          </button>
        ) : (
          <span />
        )}
        <div style={{ flex: 1 }} />
        {step === 'review' ? (
          <button style={btnStyle('primary')} onClick={() => void create()}>
            🚀 Créer ma boutique
          </button>
        ) : (
          // NOTE: the button is intentionally NOT `disabled`. A disabled button
          // swallows the click and the user gets no feedback (part of the
          // original stuck-at-PIN confusion). Instead it stays clickable and a
          // blocked tap surfaces the reason inline via `next()`. We keep the
          // dimmed affordance when blocked so the state is still legible.
          <button
            style={btnStyle('primary', !canAdvance)}
            aria-disabled={!canAdvance}
            onClick={next}
          >
            {step === 'welcome' ? 'Commencer' : 'Continuer'} →
          </button>
        )}
      </div>
    </Card>
  );
};

// Show a field error only once the user has diverged from the seeded default
// (so the wizard doesn't scream red at first paint on the pre-filled defaults).
// WhatsApp and the PIN now seed to '' — an untouched empty field is therefore
// quiet here, and the Continue gate is what stops the merchant from advancing
// with it blank (with an inline reason, see blockReason).
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
        title="Limite de publication atteinte"
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
            Cette action dépublie définitivement <strong>{chosen}</strong>. This can’t be
            undone. Continue?
          </Banner>
        ) : null}
      </StepShell>
      <div style={{ display: 'flex', gap: 10, marginTop: 20 }}>
        <button style={btnStyle('secondary')} onClick={onCancel}>
          ← Retour
        </button>
        <div style={{ flex: 1 }} />
        {!confirming ? (
          <button
            style={btnStyle('danger', !chosen)}
            disabled={!chosen}
            onClick={() => setConfirming(true)}
          >
            Remplacer &amp; publier
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
      setErpState({ kind: 'error', message: 'Source de l’ERP introuvable — ouvrez-le depuis « Gérer ».' });
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
      setErpState({ kind: 'error', message: 'La publication de l’ERP demande un plan Pro.' });
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
          {result.storeName} est en ligne !
        </h2>
        <p style={{ margin: 0, fontSize: 13.5, color: C.muted }}>
          Votre boutique est en ligne et son ERP vous attend dans votre Studio.
        </p>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 22 }}>
        {/* Shop */}
        <ResultTile
          emoji="🛍️"
          title="Boutique en ligne"
          subtitle={result.shopUrl || 'Publiée'}
          accent={settings.accentColor}
        >
          {result.shopUrl ? (
            <a
              href={result.shopUrl}
              target="_blank"
              rel="noopener noreferrer"
              style={{ ...btnStyle('primary'), textDecoration: 'none' }}
            >
              Voir la boutique ↗
            </a>
          ) : null}
        </ResultTile>

        {/* ERP */}
        <ResultTile
          emoji="📊"
          title="Tableau de bord ERP"
          subtitle={
            erpState.kind === 'published'
              ? erpState.url
              : result.erpSlug
                ? 'Préparé dans votre Studio — publiez-le pour obtenir un lien en ligne'
                : 'Non créé — ajoutez-le depuis « Gérer »'
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
                  <Spinner /> Publication…
                </>
              ) : (
                'Publier l’ERP'
              )}
            </button>
          ) : null}
        </ResultTile>

        {erpState.kind === 'cap' ? (
          <Banner tone="warn">
            You’re at the publish limit. Free a slot from{' '}
            <strong>Gérer</strong>, puis publiez l’ERP.
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
          Voir mes boutiques →
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
