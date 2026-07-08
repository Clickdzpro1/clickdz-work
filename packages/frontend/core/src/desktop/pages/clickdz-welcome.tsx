// ClickDz Work — onboarding wizard (/welcome)
// Collects the user's name, language and business niche, lets them pick
// template packs, saves the selection for the in-workspace installer, then
// enters the app. Self-contained: no engine services, inline styles only.
import { useCallback, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import {
  NICHES,
  ONBOARDED_KEY,
  PENDING_KEY,
  type PendingSelection,
} from '../../clickdz/niches';

const C = {
  primary: '#2B7FFF',
  sky: '#0EA5E9',
  navy: '#0B1F3B',
  fg: '#0F172A',
  muted: '#5B6B82',
  border: '#E2E8F0',
  soft: '#F0F6FC',
};

const T = {
  fr: {
    badge: "L'espace de travail IA — par clickdz.ai",
    title1: 'Bienvenue sur',
    subtitle:
      'Deux minutes pour préparer un espace de travail fait pour vous.',
    nameLabel: 'Comment vous appelez-vous ?',
    namePh: 'Votre prénom ou le nom de votre équipe',
    langLabel: 'Langue préférée',
    next: 'Continuer',
    back: 'Retour',
    nicheTitle: 'Quel est votre domaine ?',
    nicheSub: 'On prépare votre espace selon votre activité.',
    packTitle: 'Vos documents de départ',
    packSub:
      'Sélectionnés pour votre domaine — décochez ce que vous ne voulez pas, ou ajoutez d’autres packs.',
    docs: '3 documents : Command Center, Workflow, Tracker',
    finish: 'Créer mon espace ✨',
    skip: 'Commencer vide',
    building: 'Préparation de votre espace…',
  },
  en: {
    badge: 'The AI workspace — by clickdz.ai',
    title1: 'Welcome to',
    subtitle: 'Two minutes to set up a workspace built for you.',
    nameLabel: 'What should we call you?',
    namePh: 'Your name or your team name',
    langLabel: 'Preferred language',
    next: 'Continue',
    back: 'Back',
    nicheTitle: 'What do you do?',
    nicheSub: 'We prepare your workspace around your business.',
    packTitle: 'Your starter documents',
    packSub:
      'Picked for your niche — untick anything, or add more packs.',
    docs: '3 documents: Command Center, Workflow, Tracker',
    finish: 'Create my workspace ✨',
    skip: 'Start empty',
    building: 'Preparing your workspace…',
  },
};

const page: React.CSSProperties = {
  minHeight: '100vh',
  background:
    'radial-gradient(1100px 480px at 70% -10%, #E8F1FF 0%, transparent 60%), linear-gradient(180deg,#FFFFFF,#F7FAFF 55%,#FFFFFF)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 24,
  fontFamily:
    "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
  color: C.fg,
};

const card: React.CSSProperties = {
  width: '100%',
  maxWidth: 760,
  background: '#fff',
  border: `1px solid ${C.border}`,
  borderRadius: 20,
  boxShadow: '0 18px 60px rgba(15,23,42,.08)',
  padding: '40px 44px',
};

const btnPrimary: React.CSSProperties = {
  background: `linear-gradient(135deg, ${C.primary}, #1D4ED8)`,
  color: '#fff',
  border: 'none',
  borderRadius: 999,
  padding: '13px 30px',
  fontSize: 15.5,
  fontWeight: 600,
  cursor: 'pointer',
  boxShadow: '0 6px 18px rgba(43,127,255,.28)',
};

const btnGhost: React.CSSProperties = {
  background: '#fff',
  color: C.muted,
  border: `1.5px solid ${C.border}`,
  borderRadius: 999,
  padding: '12px 24px',
  fontSize: 14.5,
  fontWeight: 500,
  cursor: 'pointer',
};

export const Component = () => {
  const navigate = useNavigate();
  const [step, setStep] = useState(0);
  const [lang, setLang] = useState<'fr' | 'en'>('fr');
  const [name, setName] = useState('');
  const [niche, setNiche] = useState<string | null>(null);
  const [packs, setPacks] = useState<string[]>([]);
  const t = T[lang];

  const orderedNiches = useMemo(() => NICHES, []);

  const chooseNiche = useCallback((id: string) => {
    setNiche(id);
    setPacks(prev => {
      const base = new Set(prev);
      base.add(id);
      return Array.from(base);
    });
    setStep(2);
  }, []);

  const togglePack = useCallback((id: string) => {
    setPacks(prev =>
      prev.includes(id) ? prev.filter(p => p !== id) : [...prev, id]
    );
  }, []);

  const finish = useCallback(
    (selected: string[]) => {
      try {
        const pending: PendingSelection = { name, lang, niches: selected };
        if (selected.length) {
          localStorage.setItem(PENDING_KEY, JSON.stringify(pending));
        }
        localStorage.setItem(ONBOARDED_KEY, '1');
      } catch {
        /* storage unavailable — just enter the app */
      }
      navigate('/', { replace: true });
    },
    [name, lang, navigate]
  );

  return (
    <div style={page}>
      <div style={card}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 26 }}>
          <img src="/favicon-96.png" alt="" width={34} height={34} style={{ borderRadius: 9 }} />
          <span style={{ fontWeight: 700, fontSize: 17 }}>ClickDz&nbsp;Work</span>
          <span style={{ marginLeft: 'auto', fontSize: 12.5, color: C.muted, background: C.soft, border: `1px solid ${C.border}`, borderRadius: 999, padding: '4px 12px' }}>
            {t.badge}
          </span>
        </div>

        {step === 0 && (
          <div>
            <h1 style={{ fontSize: 34, lineHeight: 1.15, margin: '10px 0 6px' }}>
              {t.title1}{' '}
              <span style={{ background: `linear-gradient(135deg, ${C.sky}, ${C.primary})`, WebkitBackgroundClip: 'text', color: 'transparent' }}>
                ClickDz Work
              </span>{' '}
              👋
            </h1>
            <p style={{ color: C.muted, margin: '0 0 28px' }}>{t.subtitle}</p>

            <label style={{ display: 'block', fontWeight: 600, fontSize: 14, marginBottom: 8 }}>
              {t.nameLabel}
            </label>
            <input
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder={t.namePh}
              style={{ width: '100%', boxSizing: 'border-box', padding: '13px 16px', fontSize: 15, borderRadius: 12, border: `1.5px solid ${C.border}`, outline: 'none', marginBottom: 22 }}
            />

            <label style={{ display: 'block', fontWeight: 600, fontSize: 14, marginBottom: 8 }}>
              {t.langLabel}
            </label>
            <div style={{ display: 'flex', gap: 10, marginBottom: 30 }}>
              {(['fr', 'en'] as const).map(l => (
                <button
                  key={l}
                  onClick={() => setLang(l)}
                  style={{
                    ...btnGhost,
                    ...(lang === l
                      ? { borderColor: C.primary, color: C.primary, fontWeight: 700 }
                      : {}),
                  }}
                >
                  {l === 'fr' ? '🇫🇷 Français' : '🇬🇧 English'}
                </button>
              ))}
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button style={btnPrimary} onClick={() => setStep(1)}>
                {t.next} →
              </button>
            </div>
          </div>
        )}

        {step === 1 && (
          <div>
            <h2 style={{ fontSize: 26, margin: '4px 0 4px' }}>{t.nicheTitle}</h2>
            <p style={{ color: C.muted, margin: '0 0 22px' }}>{t.nicheSub}</p>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 10, maxHeight: 380, overflowY: 'auto', paddingRight: 4 }}>
              {orderedNiches.map(n => (
                <button
                  key={n.id}
                  onClick={() => chooseNiche(n.id)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 10,
                    padding: '13px 14px', borderRadius: 14, cursor: 'pointer',
                    border: `1.5px solid ${niche === n.id ? C.primary : C.border}`,
                    background: niche === n.id ? C.soft : '#fff',
                    fontSize: 14, fontWeight: 600, color: C.fg, textAlign: 'left',
                  }}
                >
                  <span style={{ fontSize: 20 }}>{n.emoji}</span>
                  {lang === 'fr' ? n.fr : n.en}
                </button>
              ))}
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 24 }}>
              <button style={btnGhost} onClick={() => setStep(0)}>
                ← {t.back}
              </button>
              <button style={btnGhost} onClick={() => finish([])}>
                {t.skip}
              </button>
            </div>
          </div>
        )}

        {step === 2 && (
          <div>
            <h2 style={{ fontSize: 26, margin: '4px 0 4px' }}>{t.packTitle}</h2>
            <p style={{ color: C.muted, margin: '0 0 20px' }}>{t.packSub}</p>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(210px, 1fr))', gap: 10, maxHeight: 340, overflowY: 'auto', paddingRight: 4, marginBottom: 8 }}>
              {orderedNiches.map(n => {
                const on = packs.includes(n.id);
                return (
                  <button
                    key={n.id}
                    onClick={() => togglePack(n.id)}
                    style={{
                      display: 'flex', flexDirection: 'column', gap: 4,
                      padding: '13px 15px', borderRadius: 14, cursor: 'pointer',
                      border: `1.5px solid ${on ? C.primary : C.border}`,
                      background: on ? C.soft : '#fff', textAlign: 'left',
                    }}
                  >
                    <span style={{ fontWeight: 700, fontSize: 14 }}>
                      {on ? '✅' : '⬜'} {n.emoji}{' '}
                      {lang === 'fr' ? n.fr : n.en}
                    </span>
                    <span style={{ fontSize: 12, color: C.muted }}>{t.docs}</span>
                  </button>
                );
              })}
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 20 }}>
              <button style={btnGhost} onClick={() => setStep(1)}>
                ← {t.back}
              </button>
              <button style={btnPrimary} onClick={() => finish(packs)}>
                {t.finish}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
