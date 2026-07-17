import { cdzApiUrl } from '@affine/core/blocksuite/ai/provider/ai-provider';
import {
  ViewBody,
  ViewHeader,
  ViewIcon,
  ViewTitle,
} from '@affine/core/modules/workbench';
import {
  type CSSProperties,
  type PropsWithChildren,
  useCallback,
  useEffect,
  useState,
} from 'react';

// ---------------------------------------------------------------------------
// ClickDz Integrations (Composio) — DARK by default.
//
// The whole surface is gated server-side behind COMPOSIO_API_KEY. This page
// simply reflects what /api/v1/integrations/* reports:
//   • {enabled:false}  -> friendly setup state (ask the owner to set the key)
//   • {enabled:true}   -> toolkit grid with Connect buttons
// It is purely additive: with no key the only visible change in the whole app
// is the sidebar item + this informative page. No new .css.ts (inline styles
// only, per house rules — small new UI prefers inline styles).
// ---------------------------------------------------------------------------

interface CdzToolkit {
  slug: string;
  name: string;
  logo?: string;
}

interface ToolkitsResponse {
  enabled: boolean;
  toolkits: CdzToolkit[];
  error?: string;
}

// Dark, app-consistent palette. Each value is an --affine-* theme var with a
// hard dark fallback so the page reads correctly even before theme vars load.
const C = {
  bg: 'var(--affine-background-primary-color, #141414)',
  panel: 'var(--affine-background-secondary-color, #1c1c1e)',
  border: 'var(--affine-border-color, #2a2a2c)',
  text: 'var(--affine-text-primary-color, #ececec)',
  muted: 'var(--affine-text-secondary-color, #9aa0a6)',
  accent: 'var(--affine-primary-color, #1e96eb)',
  accentSoft: 'color-mix(in srgb, var(--affine-primary-color, #1e96eb) 14%, transparent)',
  warnBg: 'color-mix(in srgb, #e8a33d 12%, transparent)',
  warnBorder: 'color-mix(in srgb, #e8a33d 40%, transparent)',
  errBg: 'color-mix(in srgb, var(--affine-error-color, #eb4b4b) 12%, transparent)',
  errBorder: 'color-mix(in srgb, var(--affine-error-color, #eb4b4b) 40%, transparent)',
} as const;

type LoadState = 'loading' | 'ready' | 'error';

const IntegrationsPage = () => {
  const [state, setState] = useState<LoadState>('loading');
  const [enabled, setEnabled] = useState(false);
  const [toolkits, setToolkits] = useState<CdzToolkit[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [connecting, setConnecting] = useState<string | null>(null);

  const load = useCallback(async () => {
    setState('loading');
    setNotice(null);
    try {
      const res = await fetch(cdzApiUrl('/api/v1/integrations/toolkits'), {
        method: 'GET',
        headers: { Accept: 'application/json' },
      });
      if (!res.ok) {
        setState('error');
        return;
      }
      const data = (await res.json()) as ToolkitsResponse;
      setEnabled(!!data.enabled);
      setToolkits(Array.isArray(data.toolkits) ? data.toolkits : []);
      if (data.error === 'composio_unreachable') {
        setNotice("Couldn't reach Composio right now — try again in a moment.");
      }
      setState('ready');
    } catch {
      setState('error');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const connect = useCallback(async (slug: string) => {
    setConnecting(slug);
    setNotice(null);
    try {
      const res = await fetch(cdzApiUrl('/api/v1/integrations/connect'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ toolkit: slug }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        redirectUrl?: string;
        error?: string;
        detail?: string;
      };
      if (res.ok && data.redirectUrl) {
        window.open(data.redirectUrl, '_blank', 'noopener,noreferrer');
        return;
      }
      if (data.error === 'not_configured') {
        setNotice('Integrations are not configured yet — ask the owner to set COMPOSIO_API_KEY.');
      } else {
        setNotice(
          `Could not start the connection${data.detail ? `: ${data.detail}` : ''}. Please try again.`
        );
      }
    } catch {
      setNotice('Could not start the connection. Please try again.');
    } finally {
      setConnecting(null);
    }
  }, []);

  return (
    <>
      <ViewTitle title="Integrations" />
      <ViewIcon icon="edgeless" />
      <ViewHeader>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            height: '100%',
            padding: '0 16px',
            fontSize: 14,
            fontWeight: 600,
            color: C.text,
          }}
        >
          <span style={{ fontSize: 16 }}>🔌</span>
          Integrations
          <span
            style={{
              fontSize: 10,
              fontWeight: 700,
              lineHeight: '15px',
              padding: '0 6px',
              borderRadius: 5,
              letterSpacing: '0.05em',
              color: C.muted,
              backgroundColor:
                'color-mix(in srgb, var(--affine-text-secondary-color, #9aa0a6) 16%, transparent)',
            }}
          >
            béta
          </span>
        </div>
      </ViewHeader>
      <ViewBody>
        <div
          style={{
            height: '100%',
            width: '100%',
            overflow: 'auto',
            background: C.bg,
            color: C.text,
            fontSize: 13,
            lineHeight: 1.5,
          }}
        >
          <div
            style={{
              maxWidth: 960,
              margin: '0 auto',
              padding: '28px 24px 48px',
              display: 'flex',
              flexDirection: 'column',
              gap: 20,
            }}
          >
            <header style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <h1
                style={{
                  margin: 0,
                  fontSize: 24,
                  fontWeight: 700,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  color: C.text,
                }}
              >
                <span>🔌</span> Integrations
              </h1>
              <p style={{ margin: 0, color: C.muted, fontSize: 13 }}>
                Connect ClickDz Work to the tools you already use. Powered by
                Composio.
              </p>
            </header>

            {/* Status banner ------------------------------------------------ */}
            {state === 'loading' ? (
              <Banner tone="info">Loading integrations…</Banner>
            ) : state === 'error' ? (
              <Banner tone="error">
                Couldn&apos;t load integrations.{' '}
                <button style={linkBtnStyle} onClick={() => void load()}>
                  Retry
                </button>
              </Banner>
            ) : !enabled ? (
              <Banner tone="warn">
                <strong>Integrations aren&apos;t set up yet.</strong>
                <br />
                Ask the owner to set <code style={codeStyle}>
                  COMPOSIO_API_KEY
                </code>{' '}
                on the server, then reload this page. Until then this tab stays
                read-only and nothing is connected.
              </Banner>
            ) : (
              <Banner tone="ok">
                Integrations are live. Pick a tool below and press{' '}
                <strong>Connect</strong> to link your account.
              </Banner>
            )}

            {notice ? <Banner tone="info">{notice}</Banner> : null}

            {/* Toolkit grid ------------------------------------------------- */}
            {state === 'ready' && enabled ? (
              toolkits.length > 0 ? (
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns:
                      'repeat(auto-fill, minmax(180px, 1fr))',
                    gap: 12,
                  }}
                >
                  {toolkits.map(tk => (
                    <div
                      key={tk.slug}
                      style={{
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 12,
                        padding: 16,
                        borderRadius: 12,
                        background: C.panel,
                        border: `1px solid ${C.border}`,
                      }}
                    >
                      <div
                        style={{ display: 'flex', alignItems: 'center', gap: 10 }}
                      >
                        <div
                          style={{
                            width: 36,
                            height: 36,
                            borderRadius: 8,
                            flexShrink: 0,
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            background: C.accentSoft,
                            overflow: 'hidden',
                            fontSize: 16,
                          }}
                        >
                          {tk.logo ? (
                            <img
                              src={tk.logo}
                              alt=""
                              width={36}
                              height={36}
                              style={{ objectFit: 'contain' }}
                            />
                          ) : (
                            <span>🧩</span>
                          )}
                        </div>
                        <span
                          style={{
                            fontWeight: 600,
                            fontSize: 13,
                            color: C.text,
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          }}
                          title={tk.name}
                        >
                          {tk.name}
                        </span>
                      </div>
                      <button
                        disabled={connecting === tk.slug}
                        onClick={() => void connect(tk.slug)}
                        style={{
                          appearance: 'none',
                          border: 'none',
                          borderRadius: 8,
                          padding: '8px 12px',
                          fontSize: 13,
                          fontWeight: 600,
                          cursor: connecting === tk.slug ? 'default' : 'pointer',
                          color: '#fff',
                          background: C.accent,
                          opacity: connecting === tk.slug ? 0.6 : 1,
                        }}
                      >
                        {connecting === tk.slug ? 'Connecting…' : 'Connect'}
                      </button>
                    </div>
                  ))}
                </div>
              ) : (
                <Banner tone="info">
                  No toolkits are available right now. Once the owner finishes
                  Composio setup they&apos;ll appear here.
                </Banner>
              )
            ) : null}
          </div>
        </div>
      </ViewBody>
    </>
  );
};

// ---- small inline-styled helpers (no exports from a .css.ts) --------------

const codeStyle: CSSProperties = {
  fontFamily: 'var(--affine-font-code-family, monospace)',
  fontSize: 12,
  padding: '1px 5px',
  borderRadius: 4,
  background: 'color-mix(in srgb, var(--affine-primary-color, #1e96eb) 14%, transparent)',
  color: 'var(--affine-text-primary-color, #ececec)',
};

const linkBtnStyle: CSSProperties = {
  appearance: 'none',
  background: 'none',
  border: 'none',
  padding: 0,
  font: 'inherit',
  cursor: 'pointer',
  color: 'var(--affine-primary-color, #1e96eb)',
  textDecoration: 'underline',
};

const Banner = ({
  tone,
  children,
}: PropsWithChildren<{ tone: 'info' | 'warn' | 'error' | 'ok' }>) => {
  const map = {
    info: { bg: C.accentSoft, border: C.border, color: C.text },
    ok: { bg: C.accentSoft, border: C.border, color: C.text },
    warn: { bg: C.warnBg, border: C.warnBorder, color: C.text },
    error: { bg: C.errBg, border: C.errBorder, color: C.text },
  }[tone];
  return (
    <div
      style={{
        padding: '12px 14px',
        borderRadius: 10,
        fontSize: 13,
        background: map.bg,
        border: `1px solid ${map.border}`,
        color: map.color,
      }}
    >
      {children}
    </div>
  );
};

export const Component = () => {
  return <IntegrationsPage />;
};
