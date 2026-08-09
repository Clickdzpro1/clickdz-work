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

// ShopERP onboarding wizard. Walks a first-time user through a per-store
// customization, then hits the REAL backend.
// Labels: boutique→ERP. Default name: empty (was 'Ma Boutique').
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

const SWATCHES = [
  '#0f766e', '#2563eb', '#7c3aed', '#db2777', '#dc2626', '#16a34a',
] as const;

type Step = 'welcome' | 'template' | 'name' | 'whatsapp' | 'accent' | 'pin' | 'review';
const BASE_FLOW: Step[] = ['welcome', 'name', 'whatsapp', 'accent', 'pin', 'review'];
const TEMPLATE_FLOW: Step[] = ['welcome', 'template', ...BASE_FLOW.slice(1)];

type Phase =
  | { kind: 'idle' }
  | { kind: 'creating'; label: string }
  | { kind: 'cap'; info: PublishCapInfo }
  | { kind: 'done'; result: CreateResult }
  | { kind: 'error'; message: string };

interface CreateResult {
  storeName: string;
  shopSlug: string;
  erpSlug: string;
  storeSlug: string;
  shopUrl: string;
  erpPublished: boolean;
  erpUrl: string;
}

function saveArtifact(input: {
  slug: string; title: string; html: string; storeSlug: string; kind: 'shop' | 'erp'; url?: string;
}) {
  const id = 'app_' + input.slug;
  const existing = artifactStore.get(id);
  artifactStore.upsert({
    ...(existing ?? { id, type: 'app', sessionId: 'draft', mimeType: 'text/html', prompt: input.kind === 'shop' ? 'DzOS — storefront' : 'DzOS — ERP' }),
    id, type: 'app', title: input.title, payload: input.html, slug: input.slug,
    storeSlug: input.storeSlug, kind: input.kind, ...(input.url ? { url: input.url } : {}),
  });
}

export const ShopWizard = ({ onDone, onCancel, hasExistingApps }: {
  onDone: () => void; onCancel?: () => void; hasExistingApps: boolean;
}) => {
  const [stepIdx, setStepIdx] = useState(0);
  const templatesState = useShopTemplates();
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(null);

  const lockedFlowRef = useRef<Step[] | null>(null);
  const FLOW = useMemo<Step[]>(() => {
    if (lockedFlowRef.current) return lockedFlowRef.current;
    return templatesState.kind === 'ready' ? TEMPLATE_FLOW : BASE_FLOW;
  }, [templatesState.kind]);
  const flowRef = useRef<Step[]>(FLOW);
  flowRef.current = FLOW;
  const step = FLOW[Math.min(stepIdx, FLOW.length - 1)];

  const [pending] = useState<PendingShop | null>(readPendingShop);
  const [storeName, setStoreName] = useState(pending?.shopName || '');
  const [whatsapp, setWhatsapp] = useState(pending?.whatsapp || '');
  const [accent, setAccent] = useState<string>('#0f766e');
  const [pin, setPin] = useState('');
  const [pinConfirm, setPinConfirm] = useState('');
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [blockReason, setBlockReason] = useState<string | null>(null);
  // Non-fatal: set when the ERP copy could not be prepared. The shop still
  // publishes; the DoneCard warns the user the ERP step failed and can be retried.
  const [erpPrepFailed, setErpPrepFailed] = useState(false);

  const nameErr = validateStoreName(storeName);
  const waErr = validateWhatsapp(whatsapp);
  const accentErr = validateAccent(accent);
  const pinErr = validatePin(pin);
  const pinMatchErr = !pinErr && pin !== pinConfirm ? 'Les deux PIN ne correspondent pas.' : null;

  const settings: ShopSettings = useMemo(() => ({
    storeName: storeName.trim(), whatsapp, accentColor: accent, adminPin: pin,
  }), [storeName, whatsapp, accent, pin]);

  const gateFor = useCallback((s: Step): string | null => {
    switch (s) {
      case 'name': return nameErr;
      case 'whatsapp': return waErr;
      case 'accent': return accentErr;
      case 'pin': return pinErr ?? pinMatchErr;
      default: return null;
    }
  }, [nameErr, waErr, accentErr, pinErr, pinMatchErr]);

  const canAdvance = gateFor(step) == null;

  const next = useCallback(() => {
    const flow = flowRef.current;
    const cur = flow[Math.min(stepIdx, flow.length - 1)];
    const reason = gateFor(cur);
    if (reason) { setBlockReason(reason); return; }
    setBlockReason(null);
    setStepIdx(i => {
      const f = flowRef.current;
      if (i === 0 && !lockedFlowRef.current) lockedFlowRef.current = f;
      return Math.min(i + 1, f.length - 1);
    });
  }, [stepIdx, gateFor]);

  const back = useCallback(() => { setBlockReason(null); setStepIdx(i => Math.max(i - 1, 0)); }, []);
  const goToStep = useCallback((s: Step) => { setBlockReason(null); const idx = flowRef.current.indexOf(s); if (idx >= 0) setStepIdx(idx); }, []);

  const create = useCallback(async (replaceSlug?: string) => {
    setPhase({ kind: 'creating', label: 'Création de votre ERP…' });
    try {
      const shop = await fetchTemplate({
        kind: 'shop', settings,
        ...(selectedTemplateId ? { templateId: selectedTemplateId } : {}),
      });
      const storeSlug = shop.storeSlug || shop.slug;
      saveArtifact({ slug: shop.slug, title: settings.storeName, html: shop.html, storeSlug, kind: 'shop' });

      setPhase({ kind: 'creating', label: 'Préparation de l'ERP associé…' });
      let erpSlug = '';
      setErpPrepFailed(false);
      try {
        const erp = await fetchTemplate({ kind: 'erp', storeSlug, settings });
        erpSlug = erp.slug;
        saveArtifact({ slug: erp.slug, title: 'ERP — ' + settings.storeName, html: erp.html, storeSlug, kind: 'erp' });
      } catch {
        // Non-fatal: the shop still publishes. Surface it on the DoneCard so the
        // user is not left silently broken (the ERP is prepared/stored again on
        // a retry or from the Studio).
        setErpPrepFailed(true);
      }

      setPhase({ kind: 'creating', label: 'Publication de votre ERP…' });
      const outcome = await deployApp({
        html: shop.html, slug: shop.slug, kind: 'shop', storeSlug,
        ...(replaceSlug ? { replaceSlug } : {}),
      });

      if (outcome.status === 'cap') { setPhase({ kind: 'cap', info: outcome.info }); return; }
      if (outcome.status === 'upgrade') {
        setPhase({ kind: 'error', message: 'La publication demande un plan Pro.' });
        return;
      }
      if (outcome.status === 'error') { setPhase({ kind: 'error', message: outcome.message }); return; }

      const deployed: DeployResult = outcome.result;
      saveArtifact({ slug: shop.slug, title: settings.storeName, html: shop.html, storeSlug, kind: 'shop', url: deployed.url });
      setPhase({ kind: 'done', result: { storeName: settings.storeName, shopSlug: shop.slug, erpSlug, storeSlug, shopUrl: deployed.url, erpPublished: false, erpUrl: '' } });
    } catch (err) {
      setPhase({ kind: 'error', message: err instanceof Error ? err.message : 'Une erreur est survenue.' });
    }
  }, [settings, selectedTemplateId]);

  if (phase.kind === 'creating') {
    return <Card><div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16, padding: '32px 8px' }}><Spinner /><div style={{ fontSize: 15, fontWeight: 600, color: C.text }}>{phase.label}</div><div style={hintStyle}>Cela prend quelques secondes.</div></div></Card>;
  }
  if (phase.kind === 'cap') { return <ReplaceCap info={phase.info} onReplace={slug => void create(slug)} onCancel={() => setPhase({ kind: 'idle' })} />; }
  if (phase.kind === 'error') {
    return <Card><Banner tone="error">{phase.message}</Banner><div style={{ display: 'flex', gap: 10, marginTop: 16 }}><button style={btnStyle('primary')} onClick={() => void create()}>Réessayer</button><button style={btnStyle('secondary')} onClick={() => setPhase({ kind: 'idle' })}>Retour</button></div></Card>;
  }
  if (phase.kind === 'done') { return <DoneCard result={phase.result} settings={settings} onFinish={onDone} erpPrepFailed={erpPrepFailed} />; }

  return (
    <Card>
      <StepDots total={FLOW.length} current={stepIdx} />
      {step === 'welcome' ? <StepShell emoji="🛍️" title="Créez votre ERP" subtitle="On prépare votre ERP en ligne — paiement à la livraison, commande par WhatsApp et un tableau de bord assorti. Quelques questions rapides et vous êtes en ligne."><ul style={{ margin: '4px 0 0', paddingInlineStart: 18, color: C.muted, fontSize: 13, lineHeight: 1.7 }}><li>Le nom de votre ERP &amp; sa couleur</li><li>Un numéro WhatsApp pour les commandes</li><li>Un PIN gérant pour protéger l'espace admin</li></ul></StepShell> : null}
      {step === 'template' ? <StepShell emoji="🎨" title="Choisissez un modèle" subtitle="Un point de départ adapté à votre activité — couleurs, catégories et produits d'exemple. Vous pourrez tout changer ensuite.">{templatesState.kind === 'ready' ? <TemplatePicker templates={templatesState.templates} selectedTemplateId={selectedTemplateId} onSelect={setSelectedTemplateId} /> : <TemplatePickerLoading />}</StepShell> : null}
      {step === 'name' ? <StepShell emoji="🏷️" title="Nom de votre ERP" subtitle="Quel nom vos clients verront-ils en haut de votre site ?"><Field label="Nom de votre ERP" hint="Jusqu'à 60 caractères." error={touchedErr(storeName, nameErr, '')}><input style={inputStyle} value={storeName} maxLength={60} placeholder="Mon ERP" onChange={e => { setStoreName(e.target.value); setBlockReason(null); }} autoFocus /></Field></StepShell> : null}
      {step === 'whatsapp' ? <StepShell emoji="💬" title="Numéro WhatsApp" subtitle="Les commandes arrivent sur ce numéro en message WhatsApp. Vos clients l'utilisent aussi pour vous joindre."><Field label="Numéro WhatsApp" hint="Format international, chiffres uniquement, sans « + ». Exemple : 213600000000 (Algérie)." error={touchedErr(whatsapp, waErr, '')}><input style={inputStyle} value={whatsapp} inputMode="numeric" placeholder="213600000000" onChange={e => { setWhatsapp(e.target.value.replace(/[^0-9]/g, '').slice(0, 15)); setBlockReason(null); }} autoFocus /></Field></StepShell> : null}
      {step === 'accent' ? <StepShell emoji="🎨" title="Couleur d'accent" subtitle="Vos boutons, vos accents et l'en-tête utilisent cette couleur."><div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}><div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>{SWATCHES.map(sw => { const on = accent.toLowerCase() === sw.toLowerCase(); return <button key={sw} type="button" onClick={() => { setAccent(sw); setBlockReason(null); }} aria-label={sw} title={sw} style={{ width: 38, height: 38, borderRadius: 10, cursor: 'pointer', background: sw, border: on ? '3px solid #fff' : '2px solid ' + C.border, boxShadow: on ? '0 0 0 2px ' + C.accent : 'none', transition: 'box-shadow 150ms ease' }} />; })}</div><Field label="Hex personnalisé" hint="Ou saisissez la vôtre." error={accentErr}><div style={{ display: 'flex', alignItems: 'center', gap: 10 }}><span aria-hidden style={{ width: 34, height: 34, flexShrink: 0, borderRadius: 8, background: accentErr ? C.panel2 : accent, border: '1px solid ' + C.border }} /><input style={{ ...inputStyle, maxWidth: 160 }} value={accent} maxLength={7} placeholder="#0f766e" onChange={e => { let v = e.target.value.trim(); if (v && !v.startsWith('#')) v = '#' + v; setAccent(v.slice(0, 7)); setBlockReason(null); }} /></div></Field></div></StepShell> : null}
      {step === 'pin' ? <StepShell emoji="🔑" title="PIN du gérant" subtitle="Il déverrouille l'espace admin de votre ERP. Choisissez un code facile à retenir."><div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}><Field label="PIN" hint="4–8 chiffres." error={touchedErr(pin, pinErr, '')}><input style={inputStyle} value={pin} inputMode="numeric" type="password" placeholder="4–8 chiffres" onChange={e => { setPin(e.target.value.replace(/[^0-9]/g, '').slice(0, 8)); setBlockReason(null); }} autoFocus /></Field><Field label="Confirmez le PIN" error={pinConfirm.length > 0 ? pinMatchErr : null}><input style={inputStyle} value={pinConfirm} inputMode="numeric" type="password" placeholder="Saisissez le PIN à nouveau" onChange={e => { setPinConfirm(e.target.value.replace(/[^0-9]/g, '').slice(0, 8)); setBlockReason(null); }} /></Field></div></StepShell> : null}
      {step === 'review' ? <StepShell emoji="✅" title="Récapitulatif" subtitle="Voici votre ERP. Vous pourrez tout changer plus tard depuis l'espace admin."><div style={{ display: 'flex', flexDirection: 'column', gap: 2, borderRadius: 10, overflow: 'hidden', border: '1px solid ' + C.border }}><ReviewRow label="Nom de votre ERP" value={settings.storeName} onEdit={() => goToStep('name')} /><ReviewRow label="WhatsApp" value={settings.whatsapp} onEdit={() => goToStep('whatsapp')} /><ReviewRow label="Couleur" value={settings.accentColor} swatch={settings.accentColor} onEdit={() => goToStep('accent')} /><ReviewRow label="PIN du gérant" value={'•'.repeat(settings.adminPin.length)} onEdit={() => goToStep('pin')} /></div><Banner tone="info">Votre ERP sera publié en ligne et son tableau de bord sera prêt dans votre Studio.</Banner></StepShell> : null}
      {blockReason ? <div style={{ marginTop: 14 }}><Banner tone="error">{blockReason}</Banner></div> : null}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 22 }}>
        {stepIdx > 0 ? <button style={btnStyle('secondary')} onClick={back}>← Retour</button> : hasExistingApps && onCancel ? <button style={btnStyle('secondary')} onClick={onCancel}>Annuler</button> : <span />}
        <div style={{ flex: 1 }} />
        {step === 'review' ? <button style={btnStyle('primary')} onClick={() => void create()}>🚀 Créer mon ERP</button> : <button style={btnStyle('primary', !canAdvance)} aria-disabled={!canAdvance} onClick={next}>{step === 'welcome' ? 'Commencer' : 'Continuer'} →</button>}
      </div>
    </Card>
  );
};

function touchedErr(value: string, err: string | null, seed: string): string | null {
  if (!err) return null;
  return value === seed ? null : err;
}

const Card = ({ children }: { children: ReactNode }) => (
  <div style={{ maxWidth: 560, margin: '0 auto', padding: 24, borderRadius: 14, background: C.panel, border: '1px solid ' + C.border, display: 'flex', flexDirection: 'column' }}>{children}</div>
);

const StepShell = ({ emoji, title, subtitle, children }: { emoji: string; title: string; subtitle: string; children?: ReactNode }) => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ fontSize: 30 }} aria-hidden>{emoji}</div>
      <h2 style={{ margin: 0, fontSize: 20, fontWeight: 800, color: C.text }}>{title}</h2>
      <p style={{ margin: 0, fontSize: 13.5, color: C.muted, lineHeight: 1.55 }}>{subtitle}</p>
    </div>
    {children}
  </div>
);

const StepDots = ({ total, current }: { total: number; current: number }) => (
  <div style={{ display: 'flex', gap: 6, marginBottom: 20 }}>{Array.from({ length: total }).map((_, i) => <span key={i} style={{ height: 4, flex: 1, borderRadius: 2, background: i <= current ? C.accent : C.border, transition: 'background 200ms ease' }} />)}</div>
);

const ReviewRow = ({ label, value, swatch, onEdit }: { label: string; value: string; swatch?: string; onEdit: () => void }) => (
  <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '11px 14px', background: C.bg }}>
    <span style={{ fontSize: 12, color: C.muted, width: 108, flexShrink: 0 }}>{label}</span>
    {swatch ? <span aria-hidden style={{ width: 16, height: 16, borderRadius: 4, background: swatch, border: '1px solid ' + C.border }} /> : null}
    <span style={{ flex: 1, fontSize: 13.5, fontWeight: 600, color: C.text, wordBreak: 'break-word' }}>{value || '—'}</span>
    <button style={{ appearance: 'none', background: 'none', border: 'none', cursor: 'pointer', color: C.accent, fontSize: 12, fontWeight: 600, padding: 0 }} onClick={onEdit}>Modifier</button>
  </div>
);

const ReplaceCap = ({ info, onReplace, onCancel }: { info: PublishCapInfo; onReplace: (slug: string) => void; onCancel: () => void }) => {
  const [chosen, setChosen] = useState('');
  const [confirming, setConfirming] = useState(false);
  return (
    <Card>
      <StepShell emoji="⚠️" title="Limite de publication atteinte" subtitle={'Votre workspace peut garder ' + info.limit + ' application' + (info.limit === 1 ? '' : 's') + ' publiée' + (info.limit === 1 ? '' : 's') + '. Choisissez une à remplacer.'}>
        {info.existing.length === 0 ? <Banner tone="warn">Aucune application à remplacer.</Banner> : <div style={{ display: 'flex', flexDirection: 'column', gap: 2, borderRadius: 10, overflow: 'hidden', border: '1px solid ' + C.border }}>{info.existing.map(app => { const on = chosen === app.slug; return <button key={app.slug} type="button" onClick={() => setChosen(app.slug)} style={{ appearance: 'none', textAlign: 'left', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 10, padding: '11px 14px', background: on ? C.accentSoft : C.bg, border: 'none', borderInlineStart: '3px solid ' + (on ? C.accent : 'transparent'), color: C.text }}><span style={{ width: 14, height: 14, borderRadius: '50%', flexShrink: 0, border: '2px solid ' + (on ? C.accent : C.border), background: on ? C.accent : 'transparent' }} /><span style={{ flex: 1, fontSize: 13, fontWeight: 600, fontFamily: 'var(--affine-font-code-family, monospace)' }}>{app.slug}</span></button>; })}</div>}
        {confirming && chosen ? <Banner tone="error">Cette action dépublie définitivement <strong>{chosen}</strong>.</Banner> : null}
      </StepShell>
      <div style={{ display: 'flex', gap: 10, marginTop: 20 }}>
        <button style={btnStyle('secondary')} onClick={onCancel}>← Retour</button>
        <div style={{ flex: 1 }} />
        {!confirming ? <button style={btnStyle('danger', !chosen)} disabled={!chosen} onClick={() => setConfirming(true)}>Remplacer &amp; publier</button> : <button style={btnStyle('danger')} onClick={() => onReplace(chosen)}>Oui, remplacer {chosen}</button>}
      </div>
    </Card>
  );
};

// The ERP-publishing state machine and its publishErp() callback lived here and
// went with the tile below — the dashboard is an in-app admin surface, so
// "publishing" it was never a real action.
const DoneCard = ({ result, settings, onFinish, erpPrepFailed }: { result: CreateResult; settings: ShopSettings; onFinish: () => void; erpPrepFailed: boolean }) => {
  return (
    <Card>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'center', textAlign: 'center' }}>
        <div style={{ fontSize: 40 }} aria-hidden>🎉</div>
        <h2 style={{ margin: 0, fontSize: 22, fontWeight: 800, color: C.text }}>{result.storeName} est en ligne !</h2>
        <p style={{ margin: 0, fontSize: 13.5, color: C.muted }}>Votre ERP est en ligne et son tableau de bord vous attend dans votre Studio.</p>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 22 }}>
        <ResultTile emoji="🛍️" title="Site en ligne" subtitle={result.shopUrl || 'Publié'} accent={settings.accentColor}>
          {result.shopUrl ? <a href={result.shopUrl} target="_blank" rel="noopener noreferrer" style={{ ...btnStyle('primary'), textDecoration: 'none' }}>Voir le site ↗</a> : null}
        </ResultTile>
        {/* The « Tableau de bord ERP · Publier l'ERP » tile used to sit here and
            was removed on purpose. The ERP dashboard is the merchant's own admin
            surface inside this app — there is nothing to "publish" about it, so
            the button offered an action with no meaning, and its « Préparé dans
            votre Studio — publiez-le » subtitle implied the ERP was somehow not
            ready yet. « Accéder à mon ERP → » below already goes there. */}
        <Banner tone="info">Votre boutique est sur votre shelf <strong>Studio</strong> — ouvrez-la pour continuer l'édition.</Banner>
        {erpPrepFailed ? (
          <Banner tone="warn">Votre boutique est publiée, mais l'étape ERP a échoué et peut être retentée. Accédez à votre ERP depuis le Studio pour la relancer.</Banner>
        ) : null}
      </div>
      <div style={{ display: 'flex', marginTop: 22 }}>
        <div style={{ flex: 1 }} />
        <button style={btnStyle('primary')} onClick={onFinish}>Accéder à mon ERP →</button>
      </div>
    </Card>
  );
};

const ResultTile = ({ emoji, title, subtitle, accent, children }: { emoji: string; title: string; subtitle: string; accent: string; children?: ReactNode }) => (
  <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: 14, borderRadius: 12, background: C.bg, border: '1px solid ' + C.border }}>
    <div style={{ width: 40, height: 40, borderRadius: 10, flexShrink: 0, display: 'grid', placeItems: 'center', fontSize: 20, background: 'color-mix(in srgb, ' + accent + ' 22%, transparent)' }} aria-hidden>{emoji}</div>
    <div style={{ flex: 1, minWidth: 0 }}>
      <div style={{ fontSize: 13.5, fontWeight: 700, color: C.text }}>{title}</div>
      <div style={{ fontSize: 12, color: C.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={subtitle}>{subtitle}</div>
    </div>
    {children}
  </div>
);
