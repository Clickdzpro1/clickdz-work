// ClickDz Work — merchant onboarding (/welcome)
//
// ONE screen, three fields: shop name, WhatsApp number, language. Then straight
// into the app, where the shop wizard picks up the handoff and finishes the job.
//
// What this replaced, and why: the previous /welcome was a workspace wizard —
// name, language, a 20-niche grid (law office, NGO, HR…) and doc-template packs
// ("Command Center, Workflow, Tracker"). It never mentioned the shop, never
// asked for the WhatsApp number the whole business runs on, and then dropped
// the merchant onto a documents list. Two minutes of questions about the wrong
// product. A merchant should be looking at their own storefront in about three.
//
// The language picker now actually switches the app language. It previously
// wrote a value nothing read, so a merchant who picked "Français" still got
// English chrome everywhere.
//
// Self-contained: no engine services, inline styles only.
import { getOrCreateI18n } from '@affine/i18n';
import { useCallback, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { ONBOARDED_KEY } from '../../clickdz/niches';

/**
 * Handoff payload for the shop wizard, written here and consumed exactly once
 * on the other side (see readPendingShop in shoperp/wizard.tsx).
 */
export const PENDING_SHOP_KEY = 'clickdz:pending-shop:v1';

export interface PendingShop {
  shopName: string;
  /** Digits only, international, no '+'. */
  whatsapp: string;
  lang: 'fr' | 'ar';
}

const C = {
  primary: '#2B7FFF',
  sky: '#0EA5E9',
  fg: '#0F172A',
  muted: '#5B6B82',
  border: '#E2E8F0',
  soft: '#F0F6FC',
  danger: '#DC2626',
};

const T = {
  fr: {
    badge: 'Votre boutique en ligne — par clickdz.ai',
    title: 'Bienvenue ! On ouvre votre boutique',
    subtitle:
      'Trois minutes, pas plus : votre boutique en ligne, avec paiement à la livraison et commandes sur WhatsApp. Le reste se règle après, tranquillement.',
    nameLabel: 'Le nom de votre boutique',
    namePh: 'Ex. : Boutique Amina',
    nameErr: 'Donnez un nom à votre boutique (60 caractères maximum).',
    waLabel: 'Votre numéro WhatsApp',
    waHint:
      'Les commandes de vos clients arrivent sur ce numéro. Chiffres uniquement, sans « + ». Ex. : 213661234567.',
    waErr: 'Numéro invalide — 8 à 15 chiffres, sans « + ».',
    langLabel: 'Langue',
    go: 'Ouvrir ma boutique →',
    later: "Je veux d'abord explorer l'espace de travail",
    darja: 'دير حانوتك فـ3 دقايق — الدفع عند الاستلام و الطلبات على واتساب.',
  },
  ar: {
    badge: 'متجرك على الإنترنت — من clickdz.ai',
    title: 'مرحباً! لنفتح متجرك',
    subtitle:
      'ثلاث دقائق فقط: متجرك مع الدفع عند الاستلام والطلب عبر واتساب. الباقي يُضبط لاحقاً بهدوء.',
    nameLabel: 'اسم متجرك',
    namePh: 'مثال: بوتيك أمينة',
    nameErr: 'أعطِ اسماً لمتجرك (60 حرفاً كحد أقصى).',
    waLabel: 'رقم الواتساب',
    waHint:
      'طلبات زبائنك تصل إلى هذا الرقم. أرقام فقط، بدون «+». مثال: 213661234567.',
    waErr: 'رقم غير صالح — من 8 إلى 15 رقماً، بدون «+».',
    langLabel: 'اللغة',
    go: 'افتح متجري ←',
    later: 'أريد استكشاف مساحة العمل أولاً',
    darja: '',
  },
};

const WA_RE = /^[0-9]{8,15}$/;

const pageStyle: React.CSSProperties = {
  minHeight: '100vh',
  background:
    'radial-gradient(1100px 480px at 70% -10%, #E8F1FF 0%, transparent 60%), linear-gradient(180deg,#FFFFFF,#F7FAFF 55%,#FFFFFF)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  // 360px-safe: fixed padding that cannot squeeze the card off-screen.
  padding: 16,
  fontFamily:
    "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
  color: C.fg,
};

const cardStyle: React.CSSProperties = {
  width: '100%',
  maxWidth: 560,
  background: '#fff',
  border: `1px solid ${C.border}`,
  borderRadius: 20,
  boxShadow: '0 18px 60px rgba(15,23,42,.08)',
  padding: 'clamp(20px, 5vw, 40px)',
  boxSizing: 'border-box',
};

const inputStyle: React.CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  padding: '13px 16px',
  // >=16px so Android and iOS do not zoom the viewport when the field focuses.
  fontSize: 16,
  borderRadius: 12,
  border: `1.5px solid ${C.border}`,
  outline: 'none',
  color: '#1a1a1a',
  backgroundColor: '#fff',
};

const labelStyle: React.CSSProperties = {
  display: 'block',
  fontWeight: 600,
  fontSize: 14,
  marginBottom: 8,
};

export const Component = () => {
  const navigate = useNavigate();
  const [lang, setLang] = useState<'fr' | 'ar'>('fr');
  const [shopName, setShopName] = useState('');
  const [whatsapp, setWhatsapp] = useState('');
  const [touched, setTouched] = useState(false);
  const t = T[lang];

  const nameOk = shopName.trim().length > 0 && shopName.trim().length <= 60;
  const waOk = WA_RE.test(whatsapp);

  const applyLang = useCallback((next: 'fr' | 'ar') => {
    setLang(next);
    // A real language switch: the I18n entity listens for 'languageChanged'
    // and persists to GlobalCache 'i18n_lng', so the choice sticks for the
    // whole app rather than only restyling this page.
    getOrCreateI18n()
      .changeLanguage(next)
      .catch(() => {
        /* a failed language switch must never block onboarding */
      });
  }, []);

  const finish = useCallback(
    (withShop: boolean) => {
      // Commit the language on the way out, not only when a pill is tapped.
      // 'fr' is pre-selected and the whole page is already French, so a
      // merchant who simply accepts it never clicks anything — and would
      // otherwise land in an app whose chrome is English, because i18next's
      // own default is 'en'. applyLang is idempotent.
      applyLang(lang);
      try {
        if (withShop) {
          const pending: PendingShop = {
            shopName: shopName.trim(),
            whatsapp,
            lang,
          };
          localStorage.setItem(PENDING_SHOP_KEY, JSON.stringify(pending));
        }
        localStorage.setItem(ONBOARDED_KEY, '1');
      } catch {
        /* storage unavailable (private mode) — just enter the app */
      }
      navigate('/', { replace: true });
    },
    [shopName, whatsapp, lang, applyLang, navigate]
  );

  const submit = useCallback(() => {
    setTouched(true);
    if (nameOk && waOk) finish(true);
  }, [nameOk, waOk, finish]);

  return (
    <div style={pageStyle} dir={lang === 'ar' ? 'rtl' : 'ltr'}>
      <div style={cardStyle} className="clickdz-welcome-page">
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            marginBottom: 22,
            flexWrap: 'wrap',
          }}
        >
          <img
            src="/favicon-96.png"
            alt=""
            width={34}
            height={34}
            style={{ borderRadius: 9 }}
          />
          <span style={{ fontWeight: 700, fontSize: 17 }}>
            ClickDz&nbsp;Work
          </span>
          <span
            style={{
              marginInlineStart: 'auto',
              fontSize: 12,
              color: C.muted,
              background: C.soft,
              border: `1px solid ${C.border}`,
              borderRadius: 999,
              padding: '4px 12px',
            }}
          >
            {t.badge}
          </span>
        </div>

        <h1
          style={{
            fontSize: 'clamp(24px, 6vw, 32px)',
            lineHeight: 1.15,
            margin: '6px 0',
          }}
        >
          {t.title}{' '}
          <span
            style={{
              background: `linear-gradient(135deg, ${C.sky}, ${C.primary})`,
              WebkitBackgroundClip: 'text',
              color: 'transparent',
            }}
          >
            🛍️
          </span>
        </h1>
        <p
          style={{
            color: C.muted,
            margin: '0 0 10px',
            fontSize: 14.5,
            lineHeight: 1.55,
          }}
        >
          {t.subtitle}
        </p>
        {t.darja ? (
          <p
            dir="rtl"
            style={{ color: C.muted, margin: '0 0 22px', fontSize: 13 }}
          >
            {t.darja}
          </p>
        ) : (
          <div style={{ height: 12 }} />
        )}

        <label htmlFor="cdz-shop-name" style={labelStyle}>
          {t.nameLabel}
        </label>
        <input
          id="cdz-shop-name"
          value={shopName}
          maxLength={60}
          onChange={e => setShopName(e.target.value)}
          placeholder={t.namePh}
          style={inputStyle}
          autoFocus
        />
        {touched && !nameOk ? (
          <div style={{ color: C.danger, fontSize: 12.5, marginTop: 6 }}>
            {t.nameErr}
          </div>
        ) : null}

        <label
          htmlFor="cdz-shop-whatsapp"
          style={{ ...labelStyle, marginTop: 18 }}
        >
          {t.waLabel}
        </label>
        <input
          id="cdz-shop-whatsapp"
          value={whatsapp}
          inputMode="numeric"
          autoComplete="tel"
          onChange={e =>
            setWhatsapp(e.target.value.replace(/[^0-9]/g, '').slice(0, 15))
          }
          placeholder="213661234567"
          // The number stays LTR even when the page is Arabic.
          style={{ ...inputStyle, direction: 'ltr' }}
        />
        <div
          style={{
            color: touched && !waOk ? C.danger : C.muted,
            fontSize: 12.5,
            marginTop: 6,
            lineHeight: 1.5,
          }}
        >
          {touched && !waOk ? t.waErr : t.waHint}
        </div>

        <div style={{ ...labelStyle, marginTop: 18 }}>{t.langLabel}</div>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          {(['fr', 'ar'] as const).map(l => (
            <button
              key={l}
              type="button"
              onClick={() => applyLang(l)}
              aria-pressed={lang === l}
              style={{
                background: '#fff',
                borderRadius: 999,
                padding: '10px 22px',
                fontSize: 14,
                cursor: 'pointer',
                border: `1.5px solid ${lang === l ? C.primary : C.border}`,
                color: lang === l ? C.primary : C.muted,
                fontWeight: lang === l ? 700 : 500,
              }}
            >
              {l === 'fr' ? '🇫🇷 Français' : '🇩🇿 العربية'}
            </button>
          ))}
        </div>

        <button
          type="button"
          onClick={submit}
          style={{
            marginTop: 26,
            width: '100%',
            background: `linear-gradient(135deg, ${C.primary}, #1D4ED8)`,
            color: '#fff',
            border: 'none',
            borderRadius: 999,
            padding: '15px 30px',
            fontSize: 16,
            fontWeight: 700,
            cursor: 'pointer',
            boxShadow: '0 6px 18px rgba(43,127,255,.28)',
            // Never disabled: clicking tells the merchant what is missing,
            // rather than leaving them staring at a dead button.
            opacity: nameOk && waOk ? 1 : 0.85,
          }}
        >
          {t.go}
        </button>
        <button
          type="button"
          onClick={() => finish(false)}
          style={{
            marginTop: 14,
            width: '100%',
            background: 'none',
            border: 'none',
            color: C.muted,
            fontSize: 13,
            cursor: 'pointer',
            textDecoration: 'underline',
          }}
        >
          {t.later}
        </button>
      </div>
    </div>
  );
};
