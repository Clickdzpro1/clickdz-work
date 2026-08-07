// Social — native AI social media studio for ClickDz Work.
// Channel connections + publishing are powered by CDZ Connect (Composio managed
// auth — no per-platform developer app needed); each user connects and posts
// under their OWN Composio entity (user_id = ClickDz user.id) beneath ONE
// project-wide COMPOSIO_API_KEY. Post copy is drafted by cdz-flash via the
// /api/v1/social/compose endpoint. There is no third-party embed.

import { cdzApiUrl } from '@affine/core/blocksuite/ai/provider/ai-provider';
import { useCallback, useEffect, useState } from 'react';
import { C, ensureShoperpResponsiveCss, Spinner, Banner, miniBtnStyle } from './shoperp-shared';

// The social channels we surface, keyed by their Composio toolkit slug. Composio
// provides MANAGED auth for these, so the user connects with one click and never
// has to register a developer app themselves.
const CHANNELS: { slug: string; label: string; icon: string }[] = [
  { slug: 'twitter', label: 'X / Twitter', icon: '𝕏' },
  { slug: 'linkedin', label: 'LinkedIn', icon: 'in' },
  { slug: 'instagram', label: 'Instagram', icon: '📸' },
  { slug: 'facebook', label: 'Facebook', icon: 'f' },
  { slug: 'youtube', label: 'YouTube', icon: '▶' },
  { slug: 'tiktok', label: 'TikTok', icon: '♪' },
  { slug: 'reddit', label: 'Reddit', icon: '👽' },
  { slug: 'pinterest', label: 'Pinterest', icon: '📌' },
  { slug: 'telegram', label: 'Telegram', icon: '✈' },
  { slug: 'discord', label: 'Discord', icon: '🎮' },
];

export const SocialPlusPanel = ({ slug, readOnly, onWritesBlocked, onMutated }: {
  slug: string; readOnly: boolean; onWritesBlocked: () => void; onMutated: () => void;
}) => {
  // --- CDZ Connect (Composio) channel state --------------------------------
  const [connectEnabled, setConnectEnabled] = useState<boolean | null>(null);
  const [connected, setConnected] = useState<Record<string, boolean>>({});
  const [connecting, setConnecting] = useState<string | null>(null);
  const [connectNote, setConnectNote] = useState<string | null>(null);

  // --- Compose & publish (via Composio /run) --------------------------------
  const [composeText, setComposeText] = useState('');
  const [selectedChannels, setSelectedChannels] = useState<string[]>([]);
  const [publishing, setPublishing] = useState(false);
  const [pubResults, setPubResults] = useState<Record<string, 'ok' | 'fail' | 'pending'>>({});

  // --- AI content generation (cdz-flash via /api/v1/social/compose) ---------
  const [brief, setBrief] = useState('');
  const [generating, setGenerating] = useState(false);
  const [genNote, setGenNote] = useState<string | null>(null);

  // Load the per-user connected state for each channel (best-effort). The
  // toolkits endpoint returns a `connected` flag per toolkit for THIS user.
  const refreshChannels = useCallback(async () => {
    try {
      const s = await fetch(cdzApiUrl('/api/v1/integrations/status'), { credentials: 'include' });
      const sj = await s.json().catch(() => ({}));
      if (!sj?.enabled) { setConnectEnabled(false); return; }
      setConnectEnabled(true);
      const results = await Promise.allSettled(
        CHANNELS.map(async c => {
          const r = await fetch(cdzApiUrl(`/api/v1/integrations/toolkits?search=${encodeURIComponent(c.slug)}&limit=5`), { credentials: 'include' });
          const j = await r.json().catch(() => ({}));
          const hit = (j?.toolkits || []).find((t: any) => t?.slug === c.slug);
          return [c.slug, !!hit?.connected] as const;
        })
      );
      const next: Record<string, boolean> = {};
      for (const res of results) if (res.status === 'fulfilled') next[res.value[0]] = res.value[1];
      setConnected(next);
    } catch {
      setConnectEnabled(false);
    }
  }, []);

  const connectChannel = useCallback(async (chSlug: string) => {
    setConnecting(chSlug);
    setConnectNote(null);
    try {
      const res = await fetch(cdzApiUrl('/api/v1/integrations/connect'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ toolkit: chSlug }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.redirectUrl) {
        // Hosted Composio auth opens in a new tab (sandbox allows popups); the
        // OAuth completes there against Composio's managed app.
        window.open(data.redirectUrl, '_blank', 'noopener,noreferrer');
        setConnectNote('Autorisation ouverte dans un nouvel onglet — terminez la connexion, puis revenez et cliquez « Actualiser ».');
      } else if (data.error === 'not_configured') {
        setConnectNote('CDZ Connect n’est pas encore configuré (COMPOSIO_API_KEY manquant).');
      } else if (data.error === 'toolkit_auth_unconfigured') {
        setConnectNote(`« ${chSlug} » n’est pas encore disponible côté CDZ Connect. Réessayez plus tard.`);
      } else {
        setConnectNote(data.detail || `Connexion à « ${chSlug} » impossible pour le moment.`);
      }
    } catch {
      setConnectNote(`Connexion à « ${chSlug} » impossible pour le moment.`);
    } finally {
      setConnecting(null);
      setTimeout(() => void refreshChannels(), 1500);
    }
  }, [refreshChannels]);

  // Draft post copy with cdz-flash. The generated text lands in the compose box
  // so the owner can edit it before publishing — this route never touches a
  // connected account, so per-user Composio isolation is unaffected.
  const generateContent = useCallback(async () => {
    const b = brief.trim();
    if (!b || generating) return;
    setGenerating(true);
    setGenNote(null);
    try {
      const res = await fetch(cdzApiUrl('/api/v1/social/compose'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ brief: b, channels: selectedChannels }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && typeof data.content === 'string' && data.content.trim()) {
        setComposeText(data.content.trim());
        setGenNote('Brouillon généré — relisez et modifiez avant de publier.');
      } else if (data.error === 'not_configured') {
        setGenNote('La génération IA n’est pas encore configurée sur ce serveur.');
      } else {
        setGenNote('Génération impossible pour le moment — réessayez.');
      }
    } catch {
      setGenNote('Génération impossible pour le moment — réessayez.');
    } finally {
      setGenerating(false);
    }
  }, [brief, generating, selectedChannels]);

  const publish = useCallback(async () => {
    const text = composeText.trim();
    if (!text || selectedChannels.length === 0 || publishing) return;
    setPublishing(true);
    setPubResults(Object.fromEntries(selectedChannels.map(s => [s, 'pending' as const])));
    // Publish to each selected channel via the Composio agent (/run): a strict
    // verbatim instruction so the planner posts the exact text, no paraphrase.
    // /run injects the caller's user_id on every execute → strictly per-user.
    await Promise.all(selectedChannels.map(async chSlug => {
      try {
        const res = await fetch(cdzApiUrl('/api/v1/integrations/run'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            prompt: `Publish the following post to my ${chSlug} account, EXACTLY as written, verbatim, with no changes, no commentary and no extra hashtags:\n\n"""${text}"""`,
            toolkits: [chSlug],
          }),
        });
        setPubResults(prev => ({ ...prev, [chSlug]: res.ok ? 'ok' : 'fail' }));
      } catch {
        setPubResults(prev => ({ ...prev, [chSlug]: 'fail' }));
      }
    }));
    setPublishing(false);
  }, [composeText, selectedChannels, publishing]);

  useEffect(() => {
    ensureShoperpResponsiveCss();
    void refreshChannels();
  }, [slug, refreshChannels]);

  const anyConnected = Object.values(connected).some(Boolean);

  return (
    <div data-cdz-surface="" style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', borderBottom: `1px solid ${C.border}`, background: C.panel2, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 20 }}>📱</span>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 15, fontWeight: 800, color: C.text }}>Social</div>
          <div style={{ fontSize: 11.5, color: C.muted }}>Réseaux sociaux IA · Connexion &amp; publication via CDZ Connect · Contenu par cdz-flash</div>
        </div>
        <button style={miniBtnStyle('secondary')} onClick={() => { void refreshChannels(); }}>↻ Actualiser</button>
      </div>

      <div style={{ flex: 1, overflow: 'auto', padding: '16px 20px', background: C.bg }}>
        {connectEnabled === null ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: C.muted, padding: '40px 0' }}><Spinner /> Chargement de vos réseaux…</div>
        ) : connectEnabled === false ? (
          <Banner tone="error">CDZ Connect n’est pas encore configuré (COMPOSIO_API_KEY manquant côté serveur).</Banner>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {/* --- Connect channels (Composio managed auth) --- */}
            <div style={{ padding: '14px 16px', borderRadius: 12, border: `1px solid ${C.border}`, background: C.panel }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 13, fontWeight: 800, color: C.text }}>Connectez vos réseaux</span>
                <span style={{ fontSize: 11.5, color: C.muted }}>en un clic via CDZ Connect — aucune app développeur requise</span>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 8 }}>
                {CHANNELS.map(ch => {
                  const isConn = connected[ch.slug];
                  const isBusy = connecting === ch.slug;
                  return (
                    <button
                      key={ch.slug}
                      onClick={() => !isConn && connectChannel(ch.slug)}
                      disabled={isBusy || isConn}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', borderRadius: 10,
                        border: `1px solid ${isConn ? C.accent + '55' : C.border}`,
                        background: isConn ? C.accentSoft : C.panel2,
                        cursor: isConn ? 'default' : 'pointer', textAlign: 'left', width: '100%',
                      }}
                    >
                      <span style={{ fontSize: 16, width: 20, textAlign: 'center', fontWeight: 800 }}>{ch.icon}</span>
                      <span style={{ flex: 1, fontSize: 12.5, fontWeight: 600, color: C.text }}>{ch.label}</span>
                      <span style={{ fontSize: 11, fontWeight: 700, color: isConn ? C.accent : C.muted }}>
                        {isBusy ? '…' : isConn ? '✓ Connecté' : 'Connecter'}
                      </span>
                    </button>
                  );
                })}
              </div>
              {connectNote && <div style={{ marginTop: 10, fontSize: 12, color: C.muted }}>{connectNote}</div>}
            </div>

            {/* --- Compose & publish to CONNECTED channels via Composio --- */}
            {anyConnected ? (
              <div style={{ padding: '14px 16px', borderRadius: 12, border: `1px solid ${C.border}`, background: C.panel }}>
                <div style={{ fontSize: 13, fontWeight: 800, color: C.text, marginBottom: 8 }}>Composer &amp; publier</div>

                {/* AI content generation (cdz-flash) */}
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
                  <input
                    value={brief}
                    onChange={e => setBrief(e.target.value)}
                    placeholder="Décrivez la publication à générer (ex : « promo -20% sur les baskets ce week-end »)…"
                    style={{ flex: 1, minWidth: 220, borderRadius: 10, border: `1px solid ${C.border}`, background: C.panel2, color: C.text, padding: '9px 12px', fontSize: 12.5, fontFamily: 'inherit', boxSizing: 'border-box' }}
                  />
                  <button
                    onClick={() => void generateContent()}
                    disabled={generating || !brief.trim()}
                    style={{ ...miniBtnStyle('secondary'), opacity: (generating || !brief.trim()) ? 0.5 : 1 }}>
                    {generating ? 'Génération…' : '✨ Générer le contenu'}
                  </button>
                </div>
                {genNote && <div style={{ marginBottom: 10, fontSize: 12, color: C.muted }}>{genNote}</div>}

                <textarea
                  value={composeText}
                  onChange={e => setComposeText(e.target.value)}
                  placeholder="Écrivez votre publication…"
                  rows={4}
                  style={{ width: '100%', resize: 'vertical', borderRadius: 10, border: `1px solid ${C.border}`, background: C.panel2, color: C.text, padding: '10px 12px', fontSize: 13, fontFamily: 'inherit', boxSizing: 'border-box' }}
                />
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
                  <span style={{ fontSize: 11.5, color: C.muted }}>Publier sur :</span>
                  {CHANNELS.filter(c => connected[c.slug]).map(c => {
                    const on = selectedChannels.includes(c.slug);
                    const r = pubResults[c.slug];
                    return (
                      <button key={c.slug}
                        onClick={() => setSelectedChannels(prev => on ? prev.filter(s => s !== c.slug) : [...prev, c.slug])}
                        style={{ fontSize: 11.5, fontWeight: 700, padding: '5px 10px', borderRadius: 999, cursor: 'pointer',
                          border: `1px solid ${on ? C.accent : C.border}`, background: on ? C.accentSoft : C.panel2,
                          color: r === 'ok' ? C.accent : r === 'fail' ? '#c8283a' : C.text }}>
                        {c.icon} {c.label}{r === 'ok' ? ' ✓' : r === 'fail' ? ' ✕' : r === 'pending' ? ' …' : ''}
                      </button>
                    );
                  })}
                  <button
                    onClick={() => void publish()}
                    disabled={publishing || !composeText.trim() || selectedChannels.length === 0}
                    style={{ marginLeft: 'auto', ...miniBtnStyle('primary'), opacity: (publishing || !composeText.trim() || selectedChannels.length === 0) ? 0.5 : 1 }}>
                    {publishing ? 'Publication…' : 'Publier'}
                  </button>
                </div>
              </div>
            ) : (
              <div style={{ borderRadius: 10, border: `1px solid ${C.border}`, background: C.panel, padding: '12px 14px', display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ fontSize: 12, color: C.muted, flex: 1 }}>🚀 Connectez au moins un réseau ci-dessus pour composer et publier · Propulsé par vos modèles CDZ AI</span>
                {['Instagram','TikTok','LinkedIn','YouTube','X','Facebook'].map(t=><span key={t} style={{ fontSize: 10.5, fontWeight: 600, color: C.accent, padding: '3px 8px', borderRadius: 999, background: `${C.accentSoft}`, border: `1px solid ${C.accent}30` }}>{t}</span>)}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
