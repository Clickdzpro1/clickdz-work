// ClickDz Work — Premium app onboarding (/welcome)
// Redesigned: workspace name + language + a suite-level app showcase driven by
// the canonical studio registry (single source of truth), grouped by area.
// No shop creation here — that happens in DzOS ERP tab when the user is ready.
import { getOrCreateI18n } from '@affine/i18n';
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { cdzApiUrl } from '../../blocksuite/ai/provider';
import {
  CDZ_PROFILE_KEY,
  GOALS,
  NICHES,
  ONBOARDED_KEY,
  PENDING_PERSONALIZE_KEY,
  type CdzOnboardingProfile,
  type Goal,
} from '../../clickdz/niches';
import {
  type StudioDef,
  type StudioGroup,
  type StudioId,
  visibleStudios,
} from '../../modules/studio/registry';

export const PENDING_SHOP_KEY = 'clickdz:pending-shop:v1';
export interface PendingShop { shopName: string; whatsapp: string; lang: 'fr' | 'en' | 'ar'; }

// ─── Responsive CSS injector ─────────────────────────────────────────────────
// Scoped under .clickdz-welcome-page (the card element).
// Breakpoint 640px: covers portrait tablet + phone; landscape tablet ≥768 keeps
// the desktop 2-column grid. Follows the same idempotent injector shape as
// ensureClickDzResponsiveCss() in clickdz/responsive.ts.
const WELCOME_STYLE_ID = 'cdz-welcome-css';

const WELCOME_CSS = `
/* ── Welcome grid: base (2 col auto-fill) and 1-col collapse ──────────── */
.cdz-welcome-grid {
  grid-template-columns: repeat(auto-fill, minmax(210px, 1fr));
}
@media (max-width: 640px) {
  .cdz-welcome-grid {
    grid-template-columns: 1fr !important;
  }
}

/* ── Action bar: static in-flow on desktop/tablet ─────────────────────── */
.cdz-welcome-actionbar {
  position: static;
}

/* ── Action bar: sticky footer on small screens ───────────────────────── */
@media (max-width: 640px) {
  .cdz-welcome-actionbar {
    position: sticky;
    bottom: 0;
    /* Symmetric negative margins cancel card padding on both sides (RTL-safe). */
    margin-block-start: 12px;
    margin-inline: calc(-1 * clamp(20px, 5vw, 44px));
    margin-block-end: calc(-1 * clamp(20px, 5vw, 44px));
    padding-inline: 16px;
    padding-block-start: 12px;
    padding-block-end: max(12px, env(safe-area-inset-bottom));
    background: rgba(255, 255, 255, 0.92);
    backdrop-filter: blur(8px);
    -webkit-backdrop-filter: blur(8px);
    border-top: 1px solid #E2E8F0;
  }
}

/* ── Card padding/radius reduction on small screens ──────────────────── */
@media (max-width: 640px) {
  .clickdz-welcome-page {
    padding: 20px 16px !important;
    border-radius: 16px !important;
  }
}
`;

/**
 * Inject the welcome page responsive stylesheet once per document. Idempotent
 * and SSR-safe — mirrors the shape of ensureClickDzResponsiveCss().
 */
function ensureWelcomeCss(): void {
  if (typeof document === 'undefined') return;
  if (document.getElementById(WELCOME_STYLE_ID)) return;
  const el = document.createElement('style');
  el.id = WELCOME_STYLE_ID;
  el.textContent = WELCOME_CSS;
  document.head.appendChild(el);
}
// ─────────────────────────────────────────────────────────────────────────────

const C = {
  primary: '#2B7FFF', sky: '#0EA5E9', fg: '#0F172A', muted: '#5B6B82',
  border: '#E2E8F0', soft: '#F0F6FC', danger: '#DC2626',
  accent: '#0f766e', accentSoft: '#ecfdf5',
};

type Lang = 'fr' | 'en' | 'ar';

// -----------------------------------------------------------------------------
// Per-studio short one-liner descriptions, co-located here (the registry is
// icon/route-only and carries no copy). Keyed by StudioId so copy stays
// translatable and can never drift from the roster: a studio without an entry
// falls back to its label, so adding a studio to the registry never crashes
// this page — it just shows the label until a description is added here.
// -----------------------------------------------------------------------------
const STUDIO_DESC: Partial<Record<StudioId, { fr: string; en: string; ar: string }>> = {
  vdz: {
    fr: 'Création vidéo IA : scripts, montage, voix et rendu automatique.',
    en: 'AI video creation: scripts, editing, voice and automatic rendering.',
    ar: 'إنشاء فيديو بالذكاء الاصطناعي: نصوص، مونتاج، صوت وتصيير تلقائي.',
  },
  apps: {
    fr: 'Construisez des mini-apps, pages de vente et boutiques (COD) avec l\'IA.',
    en: 'Build mini-apps, sales pages and shops (COD) with AI.',
    ar: 'أنشئ تطبيقات مصغرة، صفحات بيع ومتاجر (الدفع عند الاستلام) بالذكاء الاصطناعي.',
  },
  integrations: {
    fr: 'Connectez WhatsApp, Make.com et vos outils préférés.',
    en: 'Connect WhatsApp, Make.com and your favorite tools.',
    ar: 'اربط واتساب و Make.com وأدواتك المفضلة.',
  },
  shoperp: {
    fr: 'Gérez votre business : commandes, stock, caisse, clients, facturation.',
    en: 'Run your business: orders, inventory, cash register, clients, invoicing.',
    ar: 'أدر عملك: الطلبات، المخزون، الصندوق، الزبائن، الفواتير.',
  },
  voice: {
    fr: 'Voix off, narration et TTS en français et arabe, avec transcription.',
    en: 'Voiceover, narration and TTS in French & Arabic, with transcription.',
    ar: 'تعليق صوتي، سرد وتحويل النص إلى كلام بالفرنسية والعربية، مع النسخ.',
  },
  hermes: {
    fr: 'Assistant IA conversationnel pour votre entreprise.',
    en: 'Conversational AI assistant for your business.',
    ar: 'مساعد ذكاء اصطناعي محادثة لعملك.',
  },
  openclaw: {
    fr: 'Sandbox de code IA : exécutez Python, Node, et plus.',
    en: 'AI code sandbox: run Python, Node, and more.',
    ar: 'صندوق رمز ذكاء اصطناعي: شغّل Python و Node والمزيد.',
  },
  agents: {
    fr: 'Créez des agents IA qui travaillent pour vous 24/7.',
    en: 'Create AI agents that work for you 24/7.',
    ar: 'أنشئ وكلاء ذكاء اصطناعي يعملون لك على مدار الساعة.',
  },
  vpic: {
    fr: 'Génération et retouche d\'images par IA.',
    en: 'AI-powered image generation and editing.',
    ar: 'توليد وتعديل الصور بالذكاء الاصطناعي.',
  },
  slidepro: {
    fr: 'Générez des présentations professionnelles avec l\'IA.',
    en: 'Generate professional presentations with AI.',
    ar: 'أنشئ عروضاً تقديمية احترافية بالذكاء الاصطناعي.',
  },
  coursepro: {
    fr: 'Créez des formations et cours en ligne assistés par IA.',
    en: 'Create AI-assisted online courses and training.',
    ar: 'أنشئ دورات وتكوينات عبر الإنترنت بمساعدة الذكاء الاصطناعي.',
  },
  socialplus: {
    fr: 'Créez et publiez du contenu pour vos réseaux sociaux.',
    en: 'Create and publish content for your social media.',
    ar: 'أنشئ وانشر محتوى لشبكاتك الاجتماعية.',
  },
  zoomplus: {
    fr: 'Réunions et appels vidéo intégrés à votre espace de travail.',
    en: 'Meetings and video calls built into your workspace.',
    ar: 'اجتماعات ومكالمات فيديو مدمجة في مساحة عملك.',
  },
};

// Curated emoji per studio id — a warmer visual than the boot-safe rc icons the
// registry ships (those are reused across studios, so several would collide).
const STUDIO_EMOJI: Partial<Record<StudioId, string>> = {
  vdz: '🎬', apps: '🚀', integrations: '🔗', shoperp: '🛍️', voice: '🎙️',
  hermes: '💬', openclaw: '🔧', agents: '🤖', vpic: '🎨', slidepro: '📽️',
  coursepro: '🎓', socialplus: '📣', zoomplus: '📹',
};

// Group display order + per-language group headings.
const GROUP_ORDER: StudioGroup[] = ['create', 'commerce', 'agents', 'connect'];
const GROUP_LABEL: Record<StudioGroup, { fr: string; en: string; ar: string }> = {
  create: { fr: 'Créer', en: 'Create', ar: 'إبداع' },
  commerce: { fr: 'Commerce', en: 'Commerce', ar: 'تجارة' },
  agents: { fr: 'Agents IA', en: 'AI Agents', ar: 'وكلاء الذكاء' },
  connect: { fr: 'Connecter', en: 'Connect', ar: 'ربط' },
};

// Strip a leading emoji/glyph the registry bakes into some labels (e.g.
// '🔌 Integrations', '🛍️ DzOS') so the card shows the curated emoji + a clean
// text label without a doubled glyph.
function cleanLabel(label: string): string {
  return label.replace(/^[^\p{L}\p{N}]+/u, '').trim() || label;
}

function studioDesc(id: StudioId, lang: Lang, fallback: string): string {
  const d = STUDIO_DESC[id];
  if (!d) return fallback;
  return lang === 'en' ? d.en : lang === 'ar' ? d.ar : d.fr;
}

const T = {
  fr: {
    badge: 'Votre espace de travail — par clickdz.ai',
    title: 'Bienvenue sur ClickDz Work',
    subtitle: 'La suite tout-en-un pour créer avec l\'IA, gérer votre business et vendre en ligne — vidéo, apps, voix, agents, commerce et plus.',
    nameLabel: 'Nom de votre espace de travail',
    namePh: 'Ex. : Mon Business',
    nameErr: 'Donnez un nom à votre espace (60 caractères max).',
    langLabel: 'Langue préférée',
    featuresTitle: 'Tout ce que vous pouvez faire',
    featuresSub: 'Un aperçu de la suite. Vous explorerez chaque outil quand vous serez prêt.',
    go: 'Commencer →',
    step1: 'Votre espace',
    step2: 'Personnalisation',
    step3: 'Découverte',
    darja: 'دير بزنسك من قاع واحد — الفيديو، الأبس، الصوت، الوكلاء، البيع و كلش.',
    profileTitle: 'Personnalisez votre espace',
    profileSub: 'Quelques secondes pour adapter ClickDz Work à votre activité.',
    nicheLabel: 'Votre secteur d\'activité',
    nicheHint: 'Choisissez jusqu\'à 3 secteurs.',
    goalsLabel: 'Vos objectifs principaux',
    oneLinerLabel: 'Ce que vous vendez / faites (facultatif)',
    oneLinerPh: 'Ex. : Je vends des vêtements en ligne avec livraison COD',
    skip: 'Passer cette étape',
    next: 'Suivant →',
    profileErr: 'Une erreur est survenue, mais vous pouvez continuer.',
  },
  en: {
    badge: 'Your workspace — by clickdz.ai',
    title: 'Welcome to ClickDz Work',
    subtitle: 'The all-in-one suite to create with AI, run your business and sell online — video, apps, voice, agents, commerce and more.',
    nameLabel: 'Your workspace name',
    namePh: 'e.g. My Business',
    nameErr: 'Give your workspace a name (60 characters max).',
    langLabel: 'Preferred language',
    featuresTitle: 'Everything you can do',
    featuresSub: 'A quick tour of the suite. You\'ll explore each tool when you\'re ready.',
    go: 'Get started →',
    step1: 'Your workspace',
    step2: 'Personalization',
    step3: 'Discovery',
    darja: '',
    profileTitle: 'Personalize your workspace',
    profileSub: 'A few seconds to tailor ClickDz Work to your business.',
    nicheLabel: 'Your industry / niche',
    nicheHint: 'Choose up to 3 niches.',
    goalsLabel: 'Your main goals',
    oneLinerLabel: 'What you sell / do (optional)',
    oneLinerPh: 'e.g. I sell clothes online with COD delivery',
    skip: 'Skip this step',
    next: 'Next →',
    profileErr: 'Something went wrong, but you can still continue.',
  },
  ar: {
    badge: 'مساحة عملك — من clickdz.ai',
    title: 'مرحباً بك في ClickDz Work',
    subtitle: 'الحزمة المتكاملة للإبداع بالذكاء الاصطناعي، إدارة عملك والبيع عبر الإنترنت — فيديو، تطبيقات، صوت، وكلاء، تجارة والمزيد.',
    nameLabel: 'اسم مساحة عملك',
    namePh: 'مثال: عملي',
    nameErr: 'أعطِ اسماً لمساحتك (60 حرفاً كحد أقصى).',
    langLabel: 'اللغة المفضلة',
    featuresTitle: 'كل ما يمكنك فعله',
    featuresSub: 'جولة سريعة في الحزمة. ستستكشف كل أداة عندما تكون جاهزاً.',
    go: 'ابدأ ←',
    step1: 'مساحتك',
    step2: 'التخصيص',
    step3: 'الاكتشاف',
    darja: '',
    profileTitle: 'خصّص مساحتك',
    profileSub: 'ثوانٍ لتكييف ClickDz Work مع نشاطك التجاري.',
    nicheLabel: 'قطاع نشاطك',
    nicheHint: 'اختر حتى 3 قطاعات.',
    goalsLabel: 'أهدافك الرئيسية',
    oneLinerLabel: 'ما تبيعه / ما تفعله (اختياري)',
    oneLinerPh: 'مثال: أبيع ملابس عبر الإنترنت مع توصيل COD',
    skip: 'تخطّ هذه الخطوة',
    next: 'التالي ←',
    profileErr: 'حدث خطأ، لكن يمكنك الاستمرار.',
  },
};

const pageStyle: React.CSSProperties = {
  minHeight: '100vh',
  background: 'radial-gradient(1100px 480px at 70% -10%, #E8F1FF 0%, transparent 60%), linear-gradient(180deg,#FFFFFF,#F7FAFF 55%,#FFFFFF)',
  // Changed from alignItems:'center' to 'flex-start' + overflowY:'auto' to fix
  // the centered-overflow root cause: a flex child taller than the viewport when
  // centered overflows equally above AND below, making the bottom (finish button)
  // unreachable — there is effectively no scroll distance. Top-aligned + auto
  // overflow makes the page scroll normally so every element is reachable.
  display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
  overflowY: 'auto',
  paddingInline: 16,
  paddingBlock: 'clamp(16px, 4vh, 48px)',
  fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif", color: C.fg,
};

const cardStyle: React.CSSProperties = {
  width: '100%', maxWidth: 720, background: '#fff', border: '1px solid ' + C.border,
  borderRadius: 24, boxShadow: '0 18px 60px rgba(15,23,42,.08)',
  padding: 'clamp(20px, 5vw, 44px)', boxSizing: 'border-box',
};

const inputStyle: React.CSSProperties = {
  width: '100%', boxSizing: 'border-box', padding: '13px 16px', fontSize: 16,
  borderRadius: 12, border: '1.5px solid ' + C.border, outline: 'none',
  color: '#1a1a1a', backgroundColor: '#fff',
};

const labelStyle: React.CSSProperties = { display: 'block', fontWeight: 600, fontSize: 14, marginBottom: 8 };

type Step = 'name' | 'profile' | 'features';

export const Component = () => {
  const navigate = useNavigate();
  const [lang, setLang] = useState<Lang>('fr');
  const [workspaceName, setWorkspaceName] = useState('');
  const [step, setStep] = useState<Step>('name');
  const [touched, setTouched] = useState(false);
  // E2 profile state
  const [selectedNiches, setSelectedNiches] = useState<string[]>([]);
  const [selectedGoals, setSelectedGoals] = useState<string[]>([]);
  const [bizOneLiner, setBizOneLiner] = useState('');
  // Visible fallback: the profile step must NEVER trap the user. This surfaces
  // a French hint if anything unexpected happens while advancing/skipping, but
  // the step transition itself always proceeds regardless (fail-open).
  const [profileError, setProfileError] = useState(false);
  const t = T[lang];
  const nameOk = workspaceName.trim().length > 0 && workspaceName.trim().length <= 60;

  // Inject responsive CSS once (idempotent). Must be in an effect so it only
  // runs client-side (document is unavailable during SSR/prerender).
  useEffect(() => { ensureWelcomeCss(); }, []);

  const applyLang = useCallback((next: Lang) => {
    setLang(next);
    getOrCreateI18n().changeLanguage(next).catch(() => {});
  }, []);

  // Toggle a niche chip (max 3 primary + secondary selections)
  const toggleNiche = useCallback((id: string) => {
    setSelectedNiches(prev => {
      if (prev.includes(id)) return prev.filter(n => n !== id);
      if (prev.length >= 3) return prev;
      return [...prev, id];
    });
  }, []);

  // Toggle a goal chip (multi-select, no cap)
  const toggleGoal = useCallback((id: string) => {
    setSelectedGoals(prev =>
      prev.includes(id) ? prev.filter(g => g !== id) : [...prev, id]
    );
  }, []);

  const finish = useCallback(() => {
    applyLang(lang);
    // Build and persist the profile
    const profile: CdzOnboardingProfile = {
      v: 1,
      lang,
      brandName: workspaceName.trim(),
      bizOneLiner: bizOneLiner.trim() || undefined,
      niches: selectedNiches,
      goals: selectedGoals,
      updatedAt: new Date().toISOString(),
    };
    try {
      localStorage.setItem(ONBOARDED_KEY, '1');
      localStorage.setItem('cdz:workspace-name', workspaceName.trim());
      localStorage.setItem(CDZ_PROFILE_KEY, JSON.stringify(profile));
      // One-shot trigger: workspace-boot will POST this to personalize/templates
      localStorage.setItem(PENDING_PERSONALIZE_KEY, JSON.stringify(profile));
    } catch {}
    // Fire-and-forget PUT profile to backend (best-effort, never blocks finish)
    fetch(cdzApiUrl('/api/v1/cdz/profile'), {
      method: 'PUT',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(profile),
    }).catch(() => {});
    navigate('/', { replace: true });
  }, [workspaceName, lang, bizOneLiner, selectedNiches, selectedGoals, applyLang, navigate]);

  const nextFromName = () => {
    setTouched(true);
    if (nameOk) { setStep('profile'); setTouched(false); }
  };

  // Profile step is always skippable/advanceable: no selection is required and
  // no network call gates this transition. Wrapped in try/catch so that even
  // an unforeseen synchronous throw (e.g. a future change to a dependency)
  // cannot leave the click looking like a no-op — the step still advances in
  // the finally branch, and a French hint appears instead of silence.
  const nextFromProfile = () => {
    try {
      setStep('features');
      setProfileError(false);
    } catch {
      setProfileError(true);
      setStep('features');
    }
  };

  const skipProfile = () => {
    // Unconditional: "Passer cette étape" must always move the user onward,
    // regardless of selections, in-flight requests, or errors.
    try {
      setStep('features');
      setProfileError(false);
    } catch {
      setProfileError(true);
      setStep('features');
    }
  };

  const isRtl = lang === 'ar';

  // The visible roster, straight from the registry (single source of truth).
  // caps are not resolved this early in onboarding, so pass none: visibleStudios
  // then returns the legacy always-visible roster (drops the two flag-gated
  // studios — agents/vpic — exactly as the sidebar would with flags off).
  // Defensive: never let a registry-side failure take down the whole wizard
  // and strand the user on whatever step they just clicked into. Falls back
  // to an empty roster (the features step still renders its header + finish
  // button) rather than throwing during render.
  let studios: StudioDef[] = [];
  try {
    studios = visibleStudios();
  } catch {
    studios = [];
  }
  const grouped: { group: StudioGroup; items: StudioDef[] }[] = GROUP_ORDER
    .map(group => ({ group, items: studios.filter(s => s.group === group) }))
    .filter(g => g.items.length > 0);

  return (
    <div style={pageStyle} dir={isRtl ? 'rtl' : 'ltr'} lang={lang === 'ar' ? 'ar' : lang === 'en' ? 'en' : 'fr'}>
      <div style={cardStyle} className="clickdz-welcome-page">
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 20, flexWrap: 'wrap' }}>
          <img src="/favicon-96.png" alt="" width={36} height={36} style={{ borderRadius: 10 }} />
          <span style={{ fontWeight: 700, fontSize: 18 }}>ClickDz Work</span>
          <span style={{ marginInlineStart: 'auto', fontSize: 12, color: C.muted, background: C.soft, border: '1px solid ' + C.border, borderRadius: 999, padding: '4px 12px' }}>{t.badge}</span>
        </div>

        {/* Step indicator — 3 steps: name, profile, features */}
        <div style={{ display: 'flex', gap: 8, marginBottom: 24 }}>
          {/* WS17: completed steps STAY filled (was: only the current step was
              highlighted, so going to step 2 greyed-out step 1 — looked broken). */}
          <div style={{ flex: 1, height: 4, borderRadius: 2, background: (step === 'name' || step === 'profile' || step === 'features') ? C.primary : C.border, transition: 'background 200ms' }} />
          <div style={{ flex: 1, height: 4, borderRadius: 2, background: (step === 'profile' || step === 'features') ? C.primary : C.border, transition: 'background 200ms' }} />
          <div style={{ flex: 1, height: 4, borderRadius: 2, background: step === 'features' ? C.primary : C.border, transition: 'background 200ms' }} />
        </div>

        {step === 'name' ? (
          <>
            <h1 style={{ fontSize: 'clamp(24px, 6vw, 34px)', lineHeight: 1.15, margin: '6px 0', fontWeight: 800 }}>
              {t.title}{' '}
              <span style={{ background: 'linear-gradient(135deg, ' + C.sky + ', ' + C.primary + ')', WebkitBackgroundClip: 'text', color: 'transparent' }}>⚡</span>
            </h1>
            <p style={{ color: C.muted, margin: '0 0 10px', fontSize: 14.5, lineHeight: 1.55 }}>{t.subtitle}</p>
            {t.darja ? <p dir="rtl" style={{ color: C.muted, margin: '0 0 22px', fontSize: 13 }}>{t.darja}</p> : <div style={{ height: 12 }} />}

            <label htmlFor="cdz-ws-name" style={labelStyle}>{t.nameLabel}</label>
            <input id="cdz-ws-name" value={workspaceName} maxLength={60} onChange={e => setWorkspaceName(e.target.value)} placeholder={t.namePh} style={inputStyle} autoFocus onKeyDown={e => { if (e.key === 'Enter') nextFromName(); }} />
            {touched && !nameOk ? <div style={{ color: C.danger, fontSize: 12.5, marginTop: 6 }}>{t.nameErr}</div> : null}

            <div style={{ ...labelStyle, marginTop: 20 }}>{t.langLabel}</div>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              {(['fr', 'en', 'ar'] as const).map(l => (
                <button key={l} type="button" onClick={() => applyLang(l)} aria-pressed={lang === l} style={{
                  background: '#fff', borderRadius: 999, padding: '10px 22px', fontSize: 14, cursor: 'pointer',
                  border: '1.5px solid ' + (lang === l ? C.primary : C.border), color: lang === l ? C.primary : C.muted, fontWeight: lang === l ? 700 : 500,
                }}>{l === 'fr' ? '🇫🇷 Français' : l === 'en' ? '🇬🇧 English' : '🇩🇿 العربية'}</button>
              ))}
            </div>

            <div className="cdz-welcome-actionbar" style={{ marginTop: 28 }}>
              <button type="button" onClick={nextFromName} className="cdz-welcome-cta" style={{
                width: '100%', background: 'linear-gradient(135deg, ' + C.primary + ', #1D4ED8)',
                color: '#fff', border: 'none', borderRadius: 999, padding: '15px 30px', fontSize: 16, fontWeight: 700,
                cursor: 'pointer', boxShadow: '0 6px 18px rgba(43,127,255,.28)', opacity: nameOk ? 1 : 0.85,
              }}>{t.go}</button>
            </div>
          </>
        ) : step === 'profile' ? (
          <>
            {/* E2 Profile step — niche chips, goal chips, optional biz one-liner */}
            <h2 style={{ fontSize: 22, fontWeight: 800, margin: '0 0 4px' }}>{t.profileTitle}</h2>
            <p style={{ color: C.muted, fontSize: 13.5, margin: '0 0 20px' }}>{t.profileSub}</p>

            {/* Niche chips */}
            <div style={{ marginBottom: 20 }}>
              <div style={{ ...labelStyle, marginBottom: 4 }}>{t.nicheLabel}</div>
              <div style={{ fontSize: 12, color: C.muted, marginBottom: 10 }}>{t.nicheHint}</div>
              <div className="cdz-welcome-grid" style={{ display: 'grid', gap: 8 }}>
                {NICHES.map(niche => {
                  const label = lang === 'en' ? niche.en : lang === 'ar' ? niche.ar : niche.fr;
                  const selected = selectedNiches.includes(niche.id);
                  return (
                    <button
                      key={niche.id}
                      type="button"
                      onClick={() => toggleNiche(niche.id)}
                      aria-pressed={selected}
                      data-testid={`niche-chip-${niche.id}`}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px',
                        borderRadius: 12, border: '1.5px solid ' + (selected ? C.primary : C.border),
                        background: selected ? '#EEF5FF' : '#fff', cursor: 'pointer',
                        color: selected ? C.primary : C.fg, fontWeight: selected ? 700 : 500,
                        fontSize: 13, textAlign: isRtl ? 'right' : 'left', transition: 'border-color 120ms, background 120ms',
                      }}
                    >
                      <span style={{ fontSize: 18, flexShrink: 0 }}>{niche.emoji}</span>
                      <span style={{ flex: 1, minWidth: 0 }}>{label}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Goal chips */}
            <div style={{ marginBottom: 20 }}>
              <div style={labelStyle}>{t.goalsLabel}</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 4 }}>
                {GOALS.map((goal: Goal) => {
                  const label = lang === 'en' ? goal.en : lang === 'ar' ? goal.ar : goal.fr;
                  const selected = selectedGoals.includes(goal.id);
                  return (
                    <button
                      key={goal.id}
                      type="button"
                      onClick={() => toggleGoal(goal.id)}
                      aria-pressed={selected}
                      data-testid={`goal-chip-${goal.id}`}
                      style={{
                        padding: '9px 16px', borderRadius: 999, fontSize: 13, cursor: 'pointer',
                        border: '1.5px solid ' + (selected ? C.primary : C.border),
                        background: selected ? '#EEF5FF' : '#fff',
                        color: selected ? C.primary : C.fg, fontWeight: selected ? 700 : 500,
                        transition: 'border-color 120ms, background 120ms',
                      }}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Optional biz one-liner */}
            <div style={{ marginBottom: 24 }}>
              <label htmlFor="cdz-biz-oneliner" style={labelStyle}>{t.oneLinerLabel}</label>
              <input
                id="cdz-biz-oneliner"
                value={bizOneLiner}
                maxLength={120}
                onChange={e => setBizOneLiner(e.target.value)}
                placeholder={t.oneLinerPh}
                style={inputStyle}
              />
            </div>

            {profileError ? (
              <div style={{ color: C.danger, fontSize: 12.5, marginBottom: 10 }}>{t.profileErr}</div>
            ) : null}

            <div className="cdz-welcome-actionbar" style={{ marginTop: 4 }}>
              <button type="button" onClick={nextFromProfile} className="cdz-welcome-cta" style={{
                width: '100%', background: 'linear-gradient(135deg, ' + C.primary + ', #1D4ED8)',
                color: '#fff', border: 'none', borderRadius: 999, padding: '15px 30px', fontSize: 16, fontWeight: 700,
                cursor: 'pointer', boxShadow: '0 6px 18px rgba(43,127,255,.28)',
              }}>{t.next}</button>
              <button type="button" onClick={skipProfile} style={{
                width: '100%', marginTop: 10, background: 'none', border: 'none', color: C.muted,
                fontSize: 13.5, cursor: 'pointer', padding: '8px', textDecoration: 'underline',
              }}>{t.skip}</button>
            </div>
          </>
        ) : (
          <>
            {/* Feature showcase — a per-app card grid grouped by area, driven by
                the registry so it can never drift from the real roster. */}
            <h2 style={{ fontSize: 22, fontWeight: 800, margin: '0 0 4px' }}>{t.featuresTitle}</h2>
            <p style={{ color: C.muted, fontSize: 13.5, margin: '0 0 20px' }}>{t.featuresSub}</p>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
              {grouped.map(({ group, items }) => {
                const heading = GROUP_LABEL[group];
                return (
                  <div key={group}>
                    <div style={{
                      fontSize: 12, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase',
                      color: C.accent, marginBottom: 10,
                    }}>
                      {lang === 'en' ? heading.en : lang === 'ar' ? heading.ar : heading.fr}
                    </div>
                    <div className="cdz-welcome-grid" style={{
                      display: 'grid',
                      // gridTemplateColumns is driven by .cdz-welcome-grid in WELCOME_CSS
                      // so the media query can override to 1fr at ≤640px.
                      gap: 12,
                    }}>
                      {items.map(studio => {
                        const label = cleanLabel(studio.label);
                        const desc = studioDesc(studio.id, lang, label);
                        const emoji = STUDIO_EMOJI[studio.id] ?? '✨';
                        return (
                          <div key={studio.id} data-testid={`welcome-studio-${studio.id}`} style={{
                            display: 'flex', alignItems: 'flex-start', gap: 12, padding: '13px 14px',
                            borderRadius: 14, border: '1px solid ' + C.border, background: '#fff',
                            transition: 'border-color 160ms, box-shadow 160ms',
                          }}>
                            <div style={{
                              fontSize: 22, flexShrink: 0, width: 42, height: 42, borderRadius: 11,
                              display: 'grid', placeItems: 'center',
                              background: 'linear-gradient(135deg, ' + C.soft + ', #fff)',
                            }}>{emoji}</div>
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{ fontSize: 14.5, fontWeight: 700, color: C.fg, marginBottom: 3 }}>{label}</div>
                              <div style={{ fontSize: 12.5, color: C.muted, lineHeight: 1.5 }}>{desc}</div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="cdz-welcome-actionbar" style={{ marginTop: 26 }}>
              <button type="button" onClick={finish} className="cdz-welcome-cta" style={{
                width: '100%', background: 'linear-gradient(135deg, ' + C.primary + ', #1D4ED8)',
                color: '#fff', border: 'none', borderRadius: 999, padding: '15px 30px', fontSize: 16, fontWeight: 700,
                cursor: 'pointer', boxShadow: '0 6px 18px rgba(43,127,255,.28)',
              }}>{t.go}</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
};
