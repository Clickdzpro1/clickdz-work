// Social+ — AI social media scheduling tab for ClickDz Work
// Channel connections are powered by CDZ Connect (Composio managed auth — no
// per-platform developer app needed); composing/scheduling is Postiz embedded.

import { cdzApiUrl } from '@affine/core/blocksuite/ai/provider/ai-provider';
import { useCallback, useEffect, useState } from 'react';
import { C, ensureShoperpResponsiveCss, Spinner, Banner, linkBtnStyle, miniBtnStyle } from './shoperp-shared';
import { provisionApp, withBridgeCode } from './app-provision';

const SOCIALPLUS_URL_KEY = 'cdz.socialplus.url';

/**
 * Base URL used ONLY for the bridge-code fallback (and as a last resort). We use
 * the SHIM host as the base so proxying + auth keep working; the shim redeems
 * the bridge_code and lands the user logged in.
 */
const SOCIALPLUS_INSTANCE_URL = 'https://postiz-shim-production.up.railway.app';

function socialPlusInstanceUrl(): string {
  try {
    const override = localStorage.getItem(SOCIALPLUS_URL_KEY);
    if (override) return override.replace(/\/+$/, '');
  } catch {
    /* storage unavailable — fall through to the default */
  }
  return SOCIALPLUS_INSTANCE_URL;
}

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
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [iframeSrc, setIframeSrc] = useState('');

  // --- CDZ Connect (Composio) channel state --------------------------------
  const [connectEnabled, setConnectEnabled] = useState<boolean | null>(null);
  const [connected, setConnected] = useState<Record<string, boolean>>({});
  const [connecting, setConnecting] = useState<string | null>(null);
  const [connectNote, setConnectNote] = useState<string | null>(null);
  const [showChannels, setShowChannels] = useState(true);

  // --- Compose & publish (via Composio /run) --------------------------------
  const [composeText, setComposeText] = useState('');
  const [selectedChannels, setSelectedChannels] = useState<string[]>([]);
  const [publishing, setPublishing] = useState(false);
  const [pubResults, setPubResults] = useState<Record<string, 'ok' | 'fail' | 'pending'>>({});

  // Robust flow: provision the app, then iframe the shim loginUrl (preferred) or
  // the bridge-code URL. The iframe load IS the health check — no CORS probe.
  const load = useCallback(async () => {
    setStatus('loading');
    const p = await provisionApp('socialplus');
    if (!p) {
      setStatus('error');
      return;
    }
    setIframeSrc(p.loginUrl || withBridgeCode(socialPlusInstanceUrl(), p.code));
    setStatus('ready');
  }, []);

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

  const publish = useCallback(async () => {
    const text = composeText.trim();
    if (!text || selectedChannels.length === 0 || publishing) return;
    setPublishing(true);
    setPubResults(Object.fromEntries(selectedChannels.map(s => [s, 'pending' as const])));
    // Publish to each selected channel via the Composio agent (/run): a strict
    // verbatim instruction so the planner posts the exact text, no paraphrase.
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
    void load();
    void refreshChannels();
  }, [slug, load, refreshChannels]);

  return (
    <div data-cdz-surface="" style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', borderBottom: `1px solid ${C.border}`, background: C.panel2, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 20 }}>📱</span>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 15, fontWeight: 800, color: C.text }}>Social+</div>
          <div style={{ fontSize: 11.5, color: C.muted }}>Réseaux sociaux IA · Connexion CDZ + Postiz</div>
        </div>
        <button style={miniBtnStyle('secondary')} onClick={() => setShowChannels(s => !s)}>{showChannels ? 'Masquer les réseaux' : 'Connecter les réseaux'}</button>
        <button style={miniBtnStyle('secondary')} onClick={() => { void load(); void refreshChannels(); }}>↻ Actualiser</button>
      </div>

      {/* --- CDZ Connect channels bar (Composio managed auth) --- */}
      {showChannels && (
        <div style={{ padding: '14px 16px', borderBottom: `1px solid ${C.border}`, background: C.panel, flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 13, fontWeight: 800, color: C.text }}>Connectez vos réseaux</span>
            <span style={{ fontSize: 11.5, color: C.muted }}>en un clic via CDZ Connect — aucune app développeur requise</span>
          </div>
          {connectEnabled === false ? (
            <Banner tone="error">CDZ Connect n’est pas encore configuré (COMPOSIO_API_KEY manquant côté serveur).</Banner>
          ) : (
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
          )}
          {connectNote && <div style={{ marginTop: 10, fontSize: 12, color: C.muted }}>{connectNote}</div>}

          {/* Compose & publish to CONNECTED channels via Composio. This is how
              a channel connected through CDZ Connect actually gets used — Postiz
              can't see Composio connections, so publishing goes through Composio. */}
          {Object.values(connected).some(Boolean) && (
            <div style={{ marginTop: 14, borderTop: `1px solid ${C.border}`, paddingTop: 14 }}>
              <div style={{ fontSize: 13, fontWeight: 800, color: C.text, marginBottom: 8 }}>Composer &amp; publier</div>
              <textarea
                value={composeText}
                onChange={e => setComposeText(e.target.value)}
                placeholder="Écrivez votre publication…"
                rows={3}
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
          )}
        </div>
      )}

      <div style={status === 'ready'
        ? { flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'hidden', padding: '16px 20px', background: C.bg }
        : { flex: 1, overflow: 'auto', padding: '24px 20px', background: C.bg }}>
        {status === 'loading' ? <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: C.muted, padding: '40px 0' }}><Spinner /> Connexion à Social+…</div>
        : status === 'error' ? (
          <Banner tone="error">Impossible de se connecter à Social+ pour le moment. <button style={linkBtnStyle} onClick={() => void load()}>Réessayer</button></Banner>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, flex: 1, minHeight: 0 }}>
            <div style={{ borderRadius: 14, overflow: 'hidden', border: `1px solid ${C.border}`, background: '#fff', flex: 1, minHeight: 0 }}>
              <iframe
                src={iframeSrc}
                style={{ width: '100%', height: '100%', border: 'none', display: 'block' }}
                title="Social+"
                /* Cross-origin iframes need explicit Permissions Policy
                   delegation or clipboard/fullscreen/media silently fail with
                   no prompt (the sandbox attr provided no such grants). */
                allow="clipboard-read *; clipboard-write *; fullscreen *; autoplay *; camera *; microphone *; display-capture *"
                allowFullScreen
              />
            </div>
            <div style={{ borderRadius: 10, border: `1px solid ${C.border}`, background: C.panel, padding: '10px 14px', display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
              <span style={{ fontSize: 12, color: C.muted, flex: 1 }}>🚀 Programmation et publication IA sur tous vos réseaux · Propulsé par vos modèles CDZ AI</span>
              {['Instagram','TikTok','LinkedIn','YouTube','X','Facebook'].map(t=><span key={t} style={{ fontSize: 10.5, fontWeight: 600, color: C.accent, padding: '3px 8px', borderRadius: 999, background: `${C.accentSoft}`, border: `1px solid ${C.accent}30` }}>{t}</span>)}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
