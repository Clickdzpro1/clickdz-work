import { type CSSProperties, useCallback, useEffect, useState } from 'react';

import {
  ACCENT_RE,
  Banner,
  btnStyle,
  C,
  type ChargilyMode,
  type ChargilyStatus,
  EmptyNote,
  type ErpSettings,
  fetchChargilyStatus,
  Field,
  hintStyle,
  inputStyle,
  linkBtnStyle,
  num,
  Panel,
  postErpSettings,
  putChargily,
  Spinner,
  validateAccent,
  validatePin,
  validateStoreName,
  validateWhatsapp,
} from './shoperp-shared';

// ---------------------------------------------------------------------------
// Store settings admin — edits the live settings singleton the deployed shop
// reads (shopName / tagline / whatsapp / deliveryFee / accent / adminPin) via
// the authed bridge route POST /api/v1/apps/:slug/erp/settings {patch}. Only
// CHANGED fields are sent; the backend merges them into the singleton
// (delete + recreate of the key:'settings' record). Client-side validation
// mirrors the wizard's rules; the server re-validates anyway.
// Note: the PIN only gates the deployed shop's admin page client-side — this
// in-app surface is already behind the workspace session.
// ---------------------------------------------------------------------------

export const SettingsAdmin = ({
  slug,
  settings,
  readOnly,
  onWritesBlocked,
  onMutated,
}: {
  slug: string;
  settings: ErpSettings;
  readOnly: boolean;
  onWritesBlocked: () => void;
  onMutated: () => void;
}) => {
  const [shopName, setShopName] = useState(String(settings.shopName ?? ''));
  const [tagline, setTagline] = useState(String(settings.tagline ?? ''));
  const [whatsapp, setWhatsapp] = useState(String(settings.whatsapp ?? ''));
  const [deliveryFee, setDeliveryFee] = useState(
    settings.deliveryFee != null ? String(num(settings.deliveryFee)) : ''
  );
  const [accent, setAccent] = useState(String(settings.accent ?? ''));
  const [adminPin, setAdminPin] = useState(String(settings.adminPin ?? ''));
  const [errors, setErrors] = useState<Record<string, string | null>>({});
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<{
    tone: 'ok' | 'error' | 'info';
    text: string;
  } | null>(null);

  const save = useCallback(async () => {
    if (readOnly || saving) return;
    setNotice(null);

    const feeStr = deliveryFee.trim();
    const feeN = Math.round(Number(feeStr));
    const errs: Record<string, string | null> = {
      shopName: validateStoreName(shopName),
      tagline:
        tagline.length > 140 ? 'Gardez le slogan sous 140 caractères.' : null,
      whatsapp: validateWhatsapp(whatsapp.trim()),
      deliveryFee:
        feeStr === '' || !Number.isFinite(feeN) || feeN < 0
          ? 'Entrez des frais de livraison de 0 ou plus.'
          : null,
      accent: validateAccent(accent.trim()),
      adminPin: validatePin(adminPin.trim()),
    };
    setErrors(errs);
    if (Object.values(errs).some(Boolean)) return;

    // Send only the fields that actually changed.
    const patch: Partial<ErpSettings> = {};
    if (shopName.trim() !== String(settings.shopName ?? '')) {
      patch.shopName = shopName.trim();
    }
    if (tagline.trim() !== String(settings.tagline ?? '')) {
      patch.tagline = tagline.trim();
    }
    if (whatsapp.trim() !== String(settings.whatsapp ?? '')) {
      patch.whatsapp = whatsapp.trim();
    }
    if (feeN !== num(settings.deliveryFee)) {
      patch.deliveryFee = feeN;
    }
    if (accent.trim() !== String(settings.accent ?? '')) {
      patch.accent = accent.trim();
    }
    if (adminPin.trim() !== String(settings.adminPin ?? '')) {
      patch.adminPin = adminPin.trim();
    }
    if (Object.keys(patch).length === 0) {
      setNotice({ tone: 'info', text: 'Rien à enregistrer — aucun changement.' });
      return;
    }

    setSaving(true);
    const out = await postErpSettings(slug, patch);
    if (out.status === 'ok') {
      setNotice({
        tone: 'ok',
        text: 'Réglages enregistrés — la boutique en ligne les applique au prochain chargement.',
      });
      onMutated(); // refresh the summary so the header/name stay in sync
    } else if (out.status === 'unavailable') {
      onWritesBlocked();
    } else {
      setNotice({ tone: 'error', text: out.message });
    }
    setSaving(false);
  }, [
    readOnly,
    saving,
    shopName,
    tagline,
    whatsapp,
    deliveryFee,
    accent,
    adminPin,
    settings,
    slug,
    onMutated,
    onWritesBlocked,
  ]);

  const disabled = readOnly || saving;
  const accentValid = ACCENT_RE.test(accent.trim());

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {notice ? (
        <Banner
          tone={
            notice.tone === 'ok'
              ? 'ok'
              : notice.tone === 'info'
                ? 'info'
                : 'error'
          }
        >
          {notice.text}
        </Banner>
      ) : null}

      <Panel title="Réglages de la boutique">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
              gap: 14,
            }}
          >
            <Field label="Nom de la boutique" error={errors.shopName}>
              <input
                style={inputStyle}
                value={shopName}
                maxLength={60}
                onChange={e => setShopName(e.target.value)}
                disabled={disabled}
              />
            </Field>
            <Field
              label="Slogan"
              hint="Petite phrase sous le nom de la boutique."
              error={errors.tagline}
            >
              <input
                style={inputStyle}
                value={tagline}
                maxLength={140}
                onChange={e => setTagline(e.target.value)}
                disabled={disabled}
              />
            </Field>
            <Field
              label="WhatsApp"
              hint="Digits only, 8–15, no “+” (e.g. 213600000000)."
              error={errors.whatsapp}
            >
              <input
                style={{
                  ...inputStyle,
                  fontFamily: 'var(--affine-font-code-family, monospace)',
                }}
                value={whatsapp}
                inputMode="numeric"
                maxLength={15}
                onChange={e => setWhatsapp(e.target.value)}
                disabled={disabled}
              />
            </Field>
            <Field
              label="Frais de livraison (DZD)"
              hint="Ajoutés à chaque commande en paiement à la livraison."
              error={errors.deliveryFee}
            >
              <input
                type="number"
                min={0}
                step={1}
                style={inputStyle}
                value={deliveryFee}
                onChange={e => setDeliveryFee(e.target.value)}
                disabled={disabled}
              />
            </Field>
            <Field
              label="Couleur d’accent"
              hint="Couleur hex, ex : #0f766e."
              error={errors.accent}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span
                  aria-hidden
                  style={{
                    width: 26,
                    height: 26,
                    borderRadius: 7,
                    flexShrink: 0,
                    border: `1px solid ${C.border}`,
                    background: accentValid ? accent.trim() : 'transparent',
                  }}
                />
                <input
                  style={{
                    ...inputStyle,
                    fontFamily: 'var(--affine-font-code-family, monospace)',
                  }}
                  value={accent}
                  maxLength={7}
                  placeholder="#0f766e"
                  onChange={e => setAccent(e.target.value)}
                  disabled={disabled}
                />
              </div>
            </Field>
            <Field
              label="PIN admin"
              hint="4–8 chiffres — protège la page admin de votre boutique en ligne."
              error={errors.adminPin}
            >
              <input
                style={{
                  ...inputStyle,
                  fontFamily: 'var(--affine-font-code-family, monospace)',
                }}
                value={adminPin}
                inputMode="numeric"
                maxLength={8}
                onChange={e => setAdminPin(e.target.value)}
                disabled={disabled}
              />
            </Field>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <button
              style={btnStyle('primary', disabled)}
              disabled={disabled}
              onClick={() => void save()}
            >
              {saving ? (
                <>
                  <Spinner dark /> Enregistrement…
                </>
              ) : (
                'Enregistrer les réglages'
              )}
            </button>
            {readOnly ? (
              <span style={{ fontSize: 12, color: C.muted }}>
                Lecture seule — les modifications admin sont indisponibles pour le moment.
              </span>
            ) : null}
          </div>
        </div>
      </Panel>

      {/* Chargily online payments (C6) */}
      <PaymentsSection
        slug={slug}
        settings={settings}
        readOnly={readOnly}
        onWritesBlocked={onWritesBlocked}
        onMutated={onMutated}
      />
    </div>
  );
};

// ---------------------------------------------------------------------------
// Payments section (C6) — Chargily keys + an "accept online payments" toggle.
//   • The merchant SECRET lives in a PRIVATE store server-side; the FE only
//     ever sends it (PUT /pay/chargily) and reads a MASKED view
//     (GET /pay/chargily → {configured, mode, enabled, maskedKey}). The secret
//     is never echoed back in full.
//   • The "Accepter le paiement en ligne" flag is NON-sensitive → it rides the
//     EXISTING erp/settings route as settings.onlinePay (postErpSettings).
// Degrades gracefully:
//   • Route not present on the server → a quiet "not available" note (the shop
//     stays cash-on-delivery only); nothing breaks.
//   • Not yet configured → a setup prompt (enter a secret to enable).
// ---------------------------------------------------------------------------

const toggleTrackStyle = (on: boolean, disabled: boolean): CSSProperties => ({
  position: 'relative',
  width: 42,
  height: 24,
  borderRadius: 999,
  flexShrink: 0,
  border: 'none',
  cursor: disabled ? 'default' : 'pointer',
  padding: 0,
  background: on ? C.accent : C.panel2,
  opacity: disabled ? 0.5 : 1,
  transition: 'background 160ms ease',
});

const toggleKnobStyle = (on: boolean): CSSProperties => ({
  position: 'absolute',
  top: 2,
  left: on ? 20 : 2,
  width: 20,
  height: 20,
  borderRadius: '50%',
  background: '#fff',
  boxShadow: '0 1px 3px rgba(0,0,0,0.4)',
  transition: 'left 160ms ease',
});

const Toggle = ({
  on,
  disabled,
  onChange,
  label,
}: {
  on: boolean;
  disabled: boolean;
  onChange: (next: boolean) => void;
  label: string;
}) => (
  <button
    type="button"
    role="switch"
    aria-checked={on}
    aria-label={label}
    disabled={disabled}
    style={toggleTrackStyle(on, disabled)}
    onClick={() => onChange(!on)}
  >
    <span aria-hidden style={toggleKnobStyle(on)} />
  </button>
);

const selectStyle: CSSProperties = {
  ...inputStyle,
  padding: '9px 12px',
  cursor: 'pointer',
};

const PaymentsSection = ({
  slug,
  settings,
  readOnly,
  onWritesBlocked,
  onMutated,
}: {
  slug: string;
  settings: ErpSettings;
  readOnly: boolean;
  onWritesBlocked: () => void;
  onMutated: () => void;
}) => {
  const [phase, setPhase] = useState<
    'loading' | 'ready' | 'unavailable' | 'error'
  >('loading');
  const [errMsg, setErrMsg] = useState('');
  const [chargily, setChargily] = useState<ChargilyStatus | null>(null);

  // Draft controls.
  const [secret, setSecret] = useState('');
  const [mode, setMode] = useState<ChargilyMode>('test');
  const [enabled, setEnabled] = useState(false);
  const [saving, setSaving] = useState(false);

  // Online-pay flag (settings.onlinePay via the existing erp/settings route).
  const [onlinePay, setOnlinePay] = useState(settings.onlinePay === true);
  const [payToggling, setPayToggling] = useState(false);

  const [notice, setNotice] = useState<{
    tone: 'ok' | 'error';
    text: string;
  } | null>(null);

  const load = useCallback(async () => {
    setPhase('loading');
    const out = await fetchChargilyStatus(slug);
    if (out.status === 'ok') {
      setChargily(out.chargily);
      setMode(out.chargily.mode);
      setEnabled(out.chargily.enabled);
      setPhase('ready');
    } else if (out.status === 'unavailable') {
      setPhase('unavailable');
    } else {
      setErrMsg(out.message);
      setPhase('error');
    }
  }, [slug]);

  useEffect(() => {
    void load();
  }, [load]);

  // Keep the local flag in sync if the summary refreshes with a new value.
  useEffect(() => {
    setOnlinePay(settings.onlinePay === true);
  }, [settings.onlinePay]);

  const saveChargily = useCallback(async () => {
    if (readOnly || saving) return;
    const trimmed = secret.trim();
    // On first setup a secret is required; on update it's optional (keep stored).
    if (!chargily?.configured && !trimmed) {
      setNotice({
        tone: 'error',
        text: 'Entrez votre clé secrète API Chargily pour activer le paiement en ligne.',
      });
      return;
    }
    setSaving(true);
    setNotice(null);
    const out = await putChargily(slug, {
      ...(trimmed ? { apiSecret: trimmed } : {}),
      mode,
      enabled,
    });
    if (out.status === 'ok') {
      setChargily(out.chargily);
      setSecret(''); // never keep the raw secret around after a successful save
      setNotice({ tone: 'ok', text: 'Réglages de paiement enregistrés.' });
    } else if (out.status === 'unavailable') {
      setPhase('unavailable');
    } else {
      setNotice({ tone: 'error', text: out.message });
    }
    setSaving(false);
  }, [readOnly, saving, secret, chargily, slug, mode, enabled]);

  const toggleOnlinePay = useCallback(
    async (next: boolean) => {
      if (readOnly || payToggling) return;
      setPayToggling(true);
      setNotice(null);
      // Optimistic — revert on failure.
      setOnlinePay(next);
      const out = await postErpSettings(slug, { onlinePay: next });
      if (out.status === 'ok') {
        setNotice({
          tone: 'ok',
          text: next
            ? 'Online payments enabled — the storefront shows a « Payer en ligne » option on next load.'
            : 'Online payments disabled — the storefront stays cash-on-delivery only.',
        });
        onMutated();
      } else if (out.status === 'unavailable') {
        setOnlinePay(!next);
        onWritesBlocked();
      } else {
        setOnlinePay(!next);
        setNotice({ tone: 'error', text: out.message });
      }
      setPayToggling(false);
    },
    [readOnly, payToggling, slug, onMutated, onWritesBlocked]
  );

  return (
    <Panel title="Paiement en ligne (Chargily)">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {notice ? (
          <Banner tone={notice.tone === 'ok' ? 'ok' : 'error'}>
            {notice.text}
          </Banner>
        ) : null}

        {phase === 'loading' ? (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              padding: '16px 4px',
              color: C.muted,
            }}
          >
            <Spinner /> Chargement des réglages de paiement…
          </div>
        ) : phase === 'unavailable' ? (
          <EmptyNote>
            Online payments aren’t available on this server — your shop keeps
            taking <strong>cash on delivery</strong> as usual.
          </EmptyNote>
        ) : phase === 'error' ? (
          <Banner tone="error">
            {errMsg}{' '}
            <button style={linkBtnStyle} onClick={() => void load()}>
              Retry
            </button>
          </Banner>
        ) : (
          <>
            {/* Configured / setup status */}
            {chargily?.configured ? (
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  flexWrap: 'wrap',
                  fontSize: 12.5,
                  color: C.muted,
                }}
              >
                <span
                  style={{
                    fontSize: 11,
                    fontWeight: 700,
                    letterSpacing: '0.04em',
                    textTransform: 'uppercase',
                    padding: '2px 9px',
                    borderRadius: 999,
                    color: '#fff',
                    background: chargily.enabled ? C.accent : C.muted,
                  }}
                >
                  {chargily.enabled ? 'Activé' : 'Désactivé'}
                </span>
                <span>
                  Clé enregistrée :{' '}
                  <span
                    style={{
                      fontFamily: 'var(--affine-font-code-family, monospace)',
                      color: C.text,
                    }}
                  >
                    {chargily.maskedKey || '••••'}
                  </span>{' '}
                  · mode <strong style={{ color: C.text }}>{chargily.mode}</strong>
                </span>
              </div>
            ) : (
              <Banner tone="info">
                Connect your Chargily account to accept card / Edahabia / CIB
                payments. Paste your API secret below — it’s stored securely and
                never shown again in full.
              </Banner>
            )}

            <Field
              label={
                chargily?.configured
                  ? 'Remplacer la clé secrète (facultatif)'
                  : 'Clé secrète API Chargily'
              }
              hint={
                chargily?.configured
                  ? 'Leave blank to keep the stored key; enter a new one to replace it.'
                  : 'From your Chargily dashboard → Developers → API keys.'
              }
            >
              <input
                style={{
                  ...inputStyle,
                  fontFamily: 'var(--affine-font-code-family, monospace)',
                }}
                type="password"
                autoComplete="off"
                value={secret}
                placeholder={
                  chargily?.configured ? '•••••••••••••••' : 'live_sk_… ou test_sk_…'
                }
                onChange={e => setSecret(e.target.value)}
                disabled={readOnly || saving}
              />
            </Field>

            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
                gap: 14,
                alignItems: 'end',
              }}
            >
              <Field label="Mode" hint="Use test until you’re ready to go live.">
                <select
                  style={selectStyle}
                  value={mode}
                  disabled={readOnly || saving}
                  onChange={e => setMode(e.target.value as ChargilyMode)}
                >
                  <option value="test">Test</option>
                  <option value="live">Live</option>
                </select>
              </Field>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  paddingBottom: 2,
                }}
              >
                <Toggle
                  on={enabled}
                  disabled={readOnly || saving}
                  onChange={setEnabled}
                  label="Activer le paiement Chargily"
                />
                <span style={{ fontSize: 13, color: C.text, fontWeight: 600 }}>
                  Activer le paiement Chargily
                </span>
              </div>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <button
                style={btnStyle('primary', readOnly || saving)}
                disabled={readOnly || saving}
                onClick={() => void saveChargily()}
              >
                {saving ? (
                  <>
                    <Spinner dark /> Enregistrement…
                  </>
                ) : (
                  'Enregistrer les réglages de paiement'
                )}
              </button>
              {readOnly ? (
                <span style={{ fontSize: 12, color: C.muted }}>
                  Lecture seule — les modifications admin sont indisponibles pour le moment.
                </span>
              ) : null}
            </div>

            {/* Accept-online-payments storefront toggle (settings.onlinePay) */}
            <div
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: 12,
                padding: '12px 14px',
                borderRadius: 10,
                background: C.panel2,
                border: `1px solid ${C.border}`,
              }}
            >
              <Toggle
                on={onlinePay}
                disabled={readOnly || payToggling}
                onChange={next => void toggleOnlinePay(next)}
                label="Accepter le paiement en ligne on the storefront"
              />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div
                  style={{
                    fontSize: 13,
                    fontWeight: 700,
                    color: C.text,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                  }}
                >
                  Accepter le paiement en ligne
                  {payToggling ? <Spinner /> : null}
                </div>
                <div style={{ ...hintStyle, marginTop: 2 }}>
                  Shows a « Payer en ligne » button at checkout on your live shop.
                  {!chargily?.configured || !chargily?.enabled ? (
                    <>
                      {' '}
                      Configure and enable Chargily above first, or shoppers will
                      fall back to cash on delivery.
                    </>
                  ) : null}
                </div>
              </div>
            </div>
          </>
        )}
      </div>
    </Panel>
  );
};
