import { cdzApiUrl } from '@affine/core/blocksuite/ai/provider/ai-provider';
import { useCallback, useEffect, useState } from 'react';

import {
  Banner,
  btnStyle,
  C,
  Field,
  hintStyle,
  inputStyle,
  Panel,
  Spinner,
} from './shoperp-shared';

// ---------------------------------------------------------------------------
// WS13 — PAYMENTS settings tab (BYO-key). A self-contained panel that mirrors
// the courier connect-card idiom (shipping.tsx's ConnectCard): per-provider
// connect form where the merchant enters THEIR OWN gateway keys, a status pill,
// and disconnect. Two providers:
//   · SlickPay (Algerian, SATIM) — a single PUBLIC_KEY + a sandbox toggle.
//   · Stripe (BYO) — a secret key (sk_) + a publishable key (pk_) + an optional
//     webhook signing secret (whsec_).
//
// Every route is behind CDZ_PAYMENTS_ENABLED + per-provider CDZ_PAY_<ID>
// (default OFF ⇒ a 404 the FE treats as "feature dark": the panel shows a quiet
// "bientôt" note, never an error). Keys are sealed server-side (never plaintext);
// the secret is NEVER echoed back (Stripe's publishable key MAY be — it is
// public by design).
//
// This panel is exported as `PaymentsPanel` so it can be rendered as a shoperp
// settings tab. It intentionally lives in its own file with its own fetch
// helpers (shoperp-shared.tsx is not touched by this change).
// ---------------------------------------------------------------------------

type PaymentProviderId = 'slickpay' | 'stripe';

interface ProviderMeta {
  id: PaymentProviderId;
  label: string;
  /** Whether the provider needs a publishable key alongside the secret. */
  requiresPublishable: boolean;
  /** Label + hint for the secret field. */
  secretLabel: string;
  secretHint: string;
  /** Label + hint for the publishable field (Stripe only). */
  publishableLabel?: string;
  publishableHint?: string;
  /** Whether to show the SlickPay sandbox toggle. */
  showSandbox: boolean;
  /** Whether to show the optional Stripe webhook-secret field. */
  showWebhookSecret: boolean;
  connectHint: string;
}

const PROVIDERS: ProviderMeta[] = [
  {
    id: 'slickpay',
    label: 'SlickPay',
    requiresPublishable: false,
    secretLabel: 'Clé publique (PUBLIC_KEY)',
    secretHint: 'Depuis votre tableau de bord SlickPay → API.',
    showSandbox: true,
    showWebhookSecret: false,
    connectHint:
      'Collez votre PUBLIC_KEY SlickPay. Ajoutez votre compte SATIM et vos coordonnées bancaires directement dans SlickPay (hors de cette page).',
  },
  {
    id: 'stripe',
    label: 'Stripe',
    requiresPublishable: true,
    secretLabel: 'Clé secrète (sk_…)',
    secretHint: 'Depuis Stripe → Developers → API keys.',
    publishableLabel: 'Clé publiable (pk_…)',
    publishableHint: 'Sûre à partager — utilisée pour la redirection de paiement.',
    showSandbox: false,
    showWebhookSecret: true,
    connectHint:
      'Collez votre clé secrète Stripe (sk_) et votre clé publiable (pk_). La clé secrète est chiffrée côté serveur et jamais réaffichée.',
  },
];

// ---- Fail-soft API helpers (dark-aware: a 404 = feature flag OFF) ----------

type Dark = { dark: true };
function isDark(v: unknown): v is Dark {
  return !!v && typeof v === 'object' && (v as Dark).dark === true;
}

function payBase(slug: string, provider: PaymentProviderId): string {
  return `/api/v1/apps/${encodeURIComponent(slug)}/payment/${encodeURIComponent(
    provider
  )}`;
}

interface StatusResp {
  connected: boolean;
  enabled: boolean;
  mode?: 'sandbox' | 'prod';
  publishableKey?: string;
}

/** Map the typed error body → human FR copy (never a raw HTTP status). */
function errMessage(code: string, httpStatus: number, label: string): string {
  switch (code) {
    case 'invalid_credentials':
      return `Clés ${label} refusées — vérifiez-les puis réessayez.`;
    case 'rate_limited':
      return `Trop de requêtes vers ${label} — patientez un instant.`;
    case 'gateway_unreachable':
      return `${label} est injoignable pour le moment. Réessayez.`;
    case 'gateway_bad_response':
    case 'gateway_error':
      return `Réponse inattendue de ${label}. Réessayez.`;
    case 'not_connected':
      return `Passerelle non connectée — connectez ${label} d’abord.`;
    case 'store_unavailable':
    case 'payment_unavailable':
      return 'Service indisponible — réessayez dans un instant.';
    default:
      break;
  }
  if (httpStatus === 401) return 'Reconnectez-vous pour continuer.';
  if (httpStatus === 403) return 'Cette boutique appartient à un autre compte.';
  return `L’opération a échoué (${httpStatus}).`;
}

async function fetchStatus(
  slug: string,
  provider: PaymentProviderId
): Promise<StatusResp | Dark | { error: string }> {
  let res: Response;
  try {
    res = await fetch(cdzApiUrl(payBase(slug, provider)), {
      method: 'GET',
      headers: { Accept: 'application/json' },
      credentials: 'include',
    });
  } catch {
    return { error: 'Erreur réseau — impossible de vérifier la passerelle.' };
  }
  if (res.status === 404) return { dark: true };
  const data = (await res.json().catch(() => null)) as
    | (Record<string, unknown> & { error?: unknown })
    | null;
  if (!res.ok) {
    const code = typeof data?.error === 'string' ? data.error : '';
    return { error: errMessage(code, res.status, provider) };
  }
  return {
    connected: data?.connected === true,
    enabled: data?.enabled === true,
    mode: data?.mode === 'sandbox' ? 'sandbox' : data?.mode === 'prod' ? 'prod' : undefined,
    publishableKey:
      typeof data?.publishableKey === 'string' ? data.publishableKey : undefined,
  };
}

async function connect(
  slug: string,
  provider: PaymentProviderId,
  body: { secretKey: string; publishableKey?: string; webhookSecret?: string; sandbox?: boolean }
): Promise<StatusResp | Dark | { error: string }> {
  let res: Response;
  try {
    res = await fetch(cdzApiUrl(`${payBase(slug, provider)}/connect`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(body),
    });
  } catch {
    return { error: 'Erreur réseau — rien n’a été enregistré.' };
  }
  if (res.status === 404) return { dark: true };
  const data = (await res.json().catch(() => null)) as
    | (Record<string, unknown> & { error?: unknown })
    | null;
  if (!res.ok) {
    const code = typeof data?.error === 'string' ? data.error : '';
    return { error: errMessage(code, res.status, provider) };
  }
  return {
    connected: data?.connected === true,
    enabled: data?.enabled === true,
    mode: data?.mode === 'sandbox' ? 'sandbox' : data?.mode === 'prod' ? 'prod' : undefined,
    publishableKey:
      typeof data?.publishableKey === 'string' ? data.publishableKey : undefined,
  };
}

async function disconnect(
  slug: string,
  provider: PaymentProviderId
): Promise<{ ok: true } | Dark | { error: string }> {
  let res: Response;
  try {
    res = await fetch(cdzApiUrl(`${payBase(slug, provider)}/disconnect`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
    });
  } catch {
    return { error: 'Erreur réseau — rien n’a été modifié.' };
  }
  if (res.status === 404) return { dark: true };
  if (!res.ok) {
    const data = (await res.json().catch(() => null)) as { error?: unknown } | null;
    const code = typeof data?.error === 'string' ? data.error : '';
    return { error: errMessage(code, res.status, provider) };
  }
  return { ok: true };
}

// ---- Per-provider connect card (mirrors the courier ConnectCard) -----------

const ProviderCard = ({
  meta,
  slug,
  readOnly,
}: {
  meta: ProviderMeta;
  slug: string;
  readOnly: boolean;
}) => {
  const [status, setStatus] = useState<StatusResp | null>(null);
  const [dark, setDark] = useState(false);
  const [loading, setLoading] = useState(true);
  const [secretKey, setSecretKey] = useState('');
  const [publishableKey, setPublishableKey] = useState('');
  const [webhookSecret, setWebhookSecret] = useState('');
  const [sandbox, setSandbox] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [confirmDisc, setConfirmDisc] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    const out = await fetchStatus(slug, meta.id);
    setLoading(false);
    if (isDark(out)) {
      setDark(true);
      return;
    }
    if ('error' in out) {
      setErr(out.error);
      return;
    }
    setStatus(out);
  }, [slug, meta.id]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const submit = useCallback(async () => {
    if (readOnly || busy) return;
    const s = secretKey.trim();
    const p = publishableKey.trim();
    if (!s || (meta.requiresPublishable && !p)) {
      setErr(
        meta.requiresPublishable
          ? `Saisissez votre clé secrète et votre clé publiable ${meta.label}.`
          : `Saisissez votre ${meta.secretLabel}.`
      );
      return;
    }
    setErr(null);
    setBusy(true);
    const out = await connect(slug, meta.id, {
      secretKey: s,
      ...(p ? { publishableKey: p } : {}),
      ...(webhookSecret.trim() ? { webhookSecret: webhookSecret.trim() } : {}),
      ...(meta.showSandbox ? { sandbox } : {}),
    });
    setBusy(false);
    if (isDark(out)) return setDark(true);
    if ('error' in out) return setErr(out.error);
    setSecretKey('');
    setPublishableKey('');
    setWebhookSecret('');
    setStatus(out);
  }, [readOnly, busy, secretKey, publishableKey, webhookSecret, sandbox, meta, slug]);

  const doDisconnect = useCallback(async () => {
    if (readOnly || busy) return;
    setErr(null);
    setBusy(true);
    const out = await disconnect(slug, meta.id);
    setBusy(false);
    if (isDark(out)) return setDark(true);
    if ('error' in out) return setErr(out.error);
    setConfirmDisc(false);
    setStatus({ connected: false, enabled: false });
  }, [readOnly, busy, slug, meta.id]);

  if (dark) {
    return (
      <Panel title={`${meta.label}`}>
        <div style={hintStyle}>
          {meta.label} n’est pas encore activé sur ce serveur.
        </div>
      </Panel>
    );
  }

  if (loading) {
    return (
      <Panel title={`${meta.label}`}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Spinner /> <span style={hintStyle}>Vérification…</span>
        </div>
      </Panel>
    );
  }

  if (status?.connected) {
    return (
      <Panel title={`${meta.label} · connecté`}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <span
              style={{
                background: '#22c55e',
                color: '#04210f',
                borderRadius: 999,
                padding: '2px 10px',
                fontSize: 12,
                fontWeight: 700,
              }}
            >
              Connecté
            </span>
            <span style={{ fontSize: 12.5, color: C.muted }}>
              {status.enabled
                ? `Passerelle ${meta.label} active.`
                : 'Connectée mais désactivée.'}
              {status.mode ? ` (${status.mode === 'sandbox' ? 'test' : 'production'})` : ''}
              {status.publishableKey ? ` · ${status.publishableKey.slice(0, 12)}…` : ''}
            </span>
            <span style={{ flex: 1 }} />
            <button
              style={btnStyle('danger', busy || readOnly)}
              disabled={busy || readOnly}
              onClick={() => setConfirmDisc(v => !v)}
            >
              Déconnecter
            </button>
          </div>
          {confirmDisc ? (
            <Banner tone="warn">
              Déconnecter {meta.label} ? Vos clés seront supprimées.
              <div style={{ display: 'flex', gap: 10, marginTop: 10, flexWrap: 'wrap' }}>
                <button
                  style={btnStyle('danger', busy)}
                  disabled={busy}
                  onClick={() => void doDisconnect()}
                >
                  {busy ? (
                    <>
                      <Spinner dark /> Déconnexion…
                    </>
                  ) : (
                    'Oui, déconnecter'
                  )}
                </button>
                <button
                  style={btnStyle('secondary', busy)}
                  disabled={busy}
                  onClick={() => setConfirmDisc(false)}
                >
                  Annuler
                </button>
              </div>
            </Banner>
          ) : null}
          {err ? <Banner tone="error">{err}</Banner> : null}
        </div>
      </Panel>
    );
  }

  return (
    <Panel title={`Connecter ${meta.label}`}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={hintStyle}>{meta.connectHint}</div>
        <Field label={meta.secretLabel} hint={meta.secretHint}>
          <input
            style={inputStyle}
            type="password"
            value={secretKey}
            maxLength={512}
            disabled={busy || readOnly}
            autoComplete="off"
            spellCheck={false}
            placeholder="Collez la clé"
            onChange={e => setSecretKey(e.target.value)}
          />
        </Field>
        {meta.requiresPublishable ? (
          <Field label={meta.publishableLabel ?? 'Clé publiable'} hint={meta.publishableHint}>
            <input
              style={inputStyle}
              value={publishableKey}
              maxLength={512}
              disabled={busy || readOnly}
              autoComplete="off"
              spellCheck={false}
              placeholder="pk_…"
              onChange={e => setPublishableKey(e.target.value)}
            />
          </Field>
        ) : null}
        {meta.showWebhookSecret ? (
          <Field
            label="Secret webhook (optionnel)"
            hint="whsec_… — requis pour vérifier les notifications de paiement Stripe."
          >
            <input
              style={inputStyle}
              type="password"
              value={webhookSecret}
              maxLength={512}
              disabled={busy || readOnly}
              autoComplete="off"
              spellCheck={false}
              placeholder="whsec_…"
              onChange={e => setWebhookSecret(e.target.value)}
            />
          </Field>
        ) : null}
        {meta.showSandbox ? (
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, color: C.muted, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={sandbox}
              disabled={busy || readOnly}
              onChange={e => setSandbox(e.target.checked)}
            />
            Mode test (sandbox)
          </label>
        ) : null}
        {err ? <Banner tone="error">{err}</Banner> : null}
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <button
            style={btnStyle('primary', busy || readOnly || !secretKey.trim())}
            disabled={busy || readOnly || !secretKey.trim()}
            onClick={() => void submit()}
          >
            {busy ? (
              <>
                <Spinner dark /> Connexion…
              </>
            ) : (
              `Connecter ${meta.label}`
            )}
          </button>
        </div>
      </div>
    </Panel>
  );
};

/**
 * The Payments settings panel — one connect card per provider (SlickPay +
 * Stripe). `readOnly` mirrors the courier panel's writes-blocked flag. Rendered
 * as a shoperp settings tab (self-contained; the merchant enters THEIR OWN keys).
 */
export const PaymentsPanel = ({
  slug,
  readOnly = false,
}: {
  slug: string;
  readOnly?: boolean;
}) => {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={hintStyle}>
        Connectez votre propre passerelle de paiement. Vos clés sont chiffrées
        côté serveur et ne sont jamais réaffichées.
      </div>
      {PROVIDERS.map(meta => (
        <ProviderCard key={meta.id} meta={meta} slug={slug} readOnly={readOnly} />
      ))}
    </div>
  );
};

export default PaymentsPanel;
