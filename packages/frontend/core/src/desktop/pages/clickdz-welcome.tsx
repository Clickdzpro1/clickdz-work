// ClickDz Work — Premium app onboarding (/welcome)
// Redesigned: workspace name + language + feature briefing.
// No shop creation here — that happens in DzOS ERP tab when the user is ready.
import { getOrCreateI18n } from '@affine/i18n';
import { useCallback, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ONBOARDED_KEY } from '../../clickdz/niches';

export const PENDING_SHOP_KEY = 'clickdz:pending-shop:v1';
export interface PendingShop { shopName: string; whatsapp: string; lang: 'fr' | 'en' | 'ar'; }

const C = {
  primary: '#2B7FFF', sky: '#0EA5E9', fg: '#0F172A', muted: '#5B6B82',
  border: '#E2E8F0', soft: '#F0F6FC', danger: '#DC2626',
  accent: '#0f766e', accentSoft: '#ecfdf5',
};

// All app features for the briefing carousel
const FEATURES = [
  { icon: '⚡', titleFr: 'DzOS ERP', titleEn: 'DzOS ERP', titleAr: 'DzOS ERP',
    descFr: 'Gérez votre business : commandes, stock, caisse, clients, facturation.',
    descEn: 'Run your business: orders, inventory, cash register, clients, invoicing.',
    descAr: 'أدر عملك: الطلبات، المخزون، الصندوق، الزبائن، الفواتير.' },
  { icon: '🤖', titleFr: 'Agents IA', titleEn: 'AI Agents', titleAr: 'وكلاء الذكاء',
    descFr: 'Créez des agents IA qui travaillent pour vous 24/7.',
    descEn: 'Create AI agents that work for you 24/7.',
    descAr: 'أنشئ وكلاء ذكاء اصطناعي يعملون لك على مدار الساعة.' },
  { icon: '📽️', titleFr: 'SlidePro', titleEn: 'SlidePro', titleAr: 'سلايد برو',
    descFr: 'Générez des présentations professionnelles avec l\'IA.',
    descEn: 'Generate professional presentations with AI.',
    descAr: 'أنشئ عروض تقديمية احترافية بالذكاء الاصطناعي.' },
  { icon: '🎨', titleFr: 'Studio Image', titleEn: 'Image Studio', titleAr: 'استوديو الصور',
    descFr: 'CDZIM3.0 + OpenAI : génération d\'images par IA.',
    descEn: 'CDZIM3.0 + OpenAI: AI-powered image generation.',
    descAr: 'CDZIM3.0 + OpenAI: توليد الصور بالذكاء الاصطناعي.' },
  { icon: '🎬', titleFr: 'Vdz Studio', titleEn: 'Vdz Studio', titleAr: 'استوديو Vdz',
    descFr: 'Création vidéo IA : scripts, voix, et rendu automatique.',
    descEn: 'AI video creation: scripts, voice, and automatic rendering.',
    descAr: 'إنشاء فيديو بالذكاء الاصطناعي: نصوص، صوت، وتصيير تلقائي.' },
  { icon: '💬', titleFr: 'Hermes', titleEn: 'Hermes', titleAr: 'هيرمس',
    descFr: 'Assistant IA conversationnel pour votre entreprise.',
    descEn: 'Conversational AI assistant for your business.',
    descAr: 'مساعد ذكاء اصطناعي محادثة لعملك.' },
  { icon: '🔧', titleFr: 'OpenClaw', titleEn: 'OpenClaw', titleAr: 'أوبنكلو',
    descFr: 'Sandbox de code IA : exécutez Python, Node, et plus.',
    descEn: 'AI code sandbox: run Python, Node, and more.',
    descAr: 'صندوق رمز ذكاء اصطناعي: شغّل Python و Node والمزيد.' },
  { icon: '🔗', titleFr: 'Intégrations', titleEn: 'Integrations', titleAr: 'تكاملات',
    descFr: 'Connectez WhatsApp, Make.com, et vos outils préférés.',
    descEn: 'Connect WhatsApp, Make.com, and your favorite tools.',
    descAr: 'اربط واتساب و Make.com وأدواتك المفضلة.' },
];

const T = {
  fr: {
    badge: 'Votre espace de travail — par clickdz.ai',
    title: 'Bienvenue sur DzOS',
    subtitle: 'Votre plateforme tout-en-un pour gérer votre business, créer avec l\'IA, et vendre en ligne.',
    nameLabel: 'Nom de votre espace de travail',
    namePh: 'Ex. : Mon Business',
    nameErr: 'Donnez un nom à votre espace (60 caractères max).',
    langLabel: 'Langue préférée',
    featuresTitle: 'Tout ce que vous pouvez faire',
    featuresSub: 'Voici un aperçu rapide. Vous explorerez chaque outil quand vous serez prêt.',
    go: 'Commencer →',
    step1: 'Votre espace',
    step2: 'Découverte',
    darja: 'دير بزنسك من قاع واحد — الذكاء الاصطناعي، البيع، و كلش.',
  },
  en: {
    badge: 'Your workspace — by clickdz.ai',
    title: 'Welcome to DzOS',
    subtitle: 'Your all-in-one platform to run your business, create with AI, and sell online.',
    nameLabel: 'Your workspace name',
    namePh: 'e.g. My Business',
    nameErr: 'Give your workspace a name (60 characters max).',
    langLabel: 'Preferred language',
    featuresTitle: 'Everything you can do',
    featuresSub: 'Here\'s a quick overview. You\'ll explore each tool when you\'re ready.',
    go: 'Get started →',
    step1: 'Your workspace',
    step2: 'Discovery',
    darja: '',
  },
  ar: {
    badge: 'مساحة عملك — من clickdz.ai',
    title: 'مرحباً بك في DzOS',
    subtitle: 'منصتك المتكاملة لإدارة عملك، الإبداع بالذكاء الاصطناعي، والبيع عبر الإنترنت.',
    nameLabel: 'اسم مساحة عملك',
    namePh: 'مثال: عملي',
    nameErr: 'أعطِ اسماً لمساحتك (60 حرفاً كحد أقصى).',
    langLabel: 'اللغة المفضلة',
    featuresTitle: 'كل ما يمكنك فعله',
    featuresSub: 'إليك نظرة سريعة. ستستكشف كل أداة عندما تكون جاهزاً.',
    go: 'ابدأ ←',
    step1: 'مساحتك',
    step2: 'الاكتشاف',
    darja: '',
  },
};

const pageStyle: React.CSSProperties = {
  minHeight: '100vh',
  background: 'radial-gradient(1100px 480px at 70% -10%, #E8F1FF 0%, transparent 60%), linear-gradient(180deg,#FFFFFF,#F7FAFF 55%,#FFFFFF)',
  display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
  fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif", color: C.fg,
};

const cardStyle: React.CSSProperties = {
  width: '100%', maxWidth: 600, background: '#fff', border: '1px solid ' + C.border,
  borderRadius: 24, boxShadow: '0 18px 60px rgba(15,23,42,.08)',
  padding: 'clamp(20px, 5vw, 44px)', boxSizing: 'border-box',
};

const inputStyle: React.CSSProperties = {
  width: '100%', boxSizing: 'border-box', padding: '13px 16px', fontSize: 16,
  borderRadius: 12, border: '1.5px solid ' + C.border, outline: 'none',
  color: '#1a1a1a', backgroundColor: '#fff',
};

const labelStyle: React.CSSProperties = { display: 'block', fontWeight: 600, fontSize: 14, marginBottom: 8 };

type Step = 'name' | 'features';

export const Component = () => {
  const navigate = useNavigate();
  const [lang, setLang] = useState<'fr' | 'en' | 'ar'>('fr');
  const [workspaceName, setWorkspaceName] = useState('');
  const [step, setStep] = useState<Step>('name');
  const [touched, setTouched] = useState(false);
  const [featureIdx, setFeatureIdx] = useState(0);
  const t = T[lang];
  const nameOk = workspaceName.trim().length > 0 && workspaceName.trim().length <= 60;

  const applyLang = useCallback((next: 'fr' | 'en' | 'ar') => {
    setLang(next);
    getOrCreateI18n().changeLanguage(next).catch(() => {});
  }, []);

  const finish = useCallback(() => {
    applyLang(lang);
    try {
      localStorage.setItem(ONBOARDED_KEY, '1');
      localStorage.setItem('cdz:workspace-name', workspaceName.trim());
    } catch {}
    navigate('/', { replace: true });
  }, [workspaceName, lang, applyLang, navigate]);

  const nextFromName = () => {
    setTouched(true);
    if (nameOk) { setStep('features'); setTouched(false); }
  };

  const isRtl = lang === 'ar';

  return (
    <div style={pageStyle} dir={isRtl ? 'rtl' : 'ltr'} lang={lang === 'ar' ? 'ar' : lang === 'en' ? 'en' : 'fr'}>
      <div style={cardStyle} className="clickdz-welcome-page">
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 20, flexWrap: 'wrap' }}>
          <img src="/favicon-96.png" alt="" width={36} height={36} style={{ borderRadius: 10 }} />
          <span style={{ fontWeight: 700, fontSize: 18 }}>ClickDz Work</span>
          <span style={{ marginInlineStart: 'auto', fontSize: 12, color: C.muted, background: C.soft, border: '1px solid ' + C.border, borderRadius: 999, padding: '4px 12px' }}>{t.badge}</span>
        </div>

        {/* Step indicator */}
        <div style={{ display: 'flex', gap: 8, marginBottom: 24 }}>
          <div style={{ flex: 1, height: 4, borderRadius: 2, background: step === 'name' ? C.primary : C.border, transition: 'background 200ms' }} />
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

            <button type="button" onClick={nextFromName} style={{
              marginTop: 28, width: '100%', background: 'linear-gradient(135deg, ' + C.primary + ', #1D4ED8)',
              color: '#fff', border: 'none', borderRadius: 999, padding: '15px 30px', fontSize: 16, fontWeight: 700,
              cursor: 'pointer', boxShadow: '0 6px 18px rgba(43,127,255,.28)', opacity: nameOk ? 1 : 0.85,
            }}>{t.go}</button>
          </>
        ) : (
          <>
            {/* Feature briefing — carousel */}
            <h2 style={{ fontSize: 22, fontWeight: 800, margin: '0 0 4px' }}>{t.featuresTitle}</h2>
            <p style={{ color: C.muted, fontSize: 13.5, margin: '0 0 24px' }}>{t.featuresSub}</p>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {FEATURES.map((f, i) => {
                const title = lang === 'en' ? f.titleEn : lang === 'ar' ? f.titleAr : f.titleFr;
                const desc = lang === 'en' ? f.descEn : lang === 'ar' ? f.descAr : f.descFr;
                return (
                  <div key={i} style={{
                    display: 'flex', alignItems: 'flex-start', gap: 14, padding: '14px 16px',
                    borderRadius: 14, border: '1px solid ' + C.border, background: i === featureIdx ? C.soft : '#fff',
                    transition: 'background 200ms', cursor: 'pointer', onClick: () => setFeatureIdx(i),
                  }}>
                    <div style={{ fontSize: 28, flexShrink: 0, width: 48, height: 48, borderRadius: 12, display: 'grid', placeItems: 'center', background: 'linear-gradient(135deg, ' + C.soft + ', #fff)' }}>{f.icon}</div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 15, fontWeight: 700, color: C.fg, marginBottom: 3 }}>{title}</div>
                      <div style={{ fontSize: 13, color: C.muted, lineHeight: 1.5 }}>{desc}</div>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Progress dots */}
            <div style={{ display: 'flex', gap: 5, justifyContent: 'center', marginTop: 20 }}>
              {FEATURES.map((_, i) => <span key={i} style={{ width: 6, height: 6, borderRadius: 3, background: i === featureIdx ? C.primary : C.border, transition: 'background 200ms' }} />)}
            </div>

            <button type="button" onClick={finish} style={{
              marginTop: 24, width: '100%', background: 'linear-gradient(135deg, ' + C.primary + ', #1D4ED8)',
              color: '#fff', border: 'none', borderRadius: 999, padding: '15px 30px', fontSize: 16, fontWeight: 700,
              cursor: 'pointer', boxShadow: '0 6px 18px rgba(43,127,255,.28)',
            }}>{t.go}</button>
          </>
        )}
      </div>
    </div>
  );
};
