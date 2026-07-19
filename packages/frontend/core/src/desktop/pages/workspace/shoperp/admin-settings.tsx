import { useCallback, useState } from 'react';

import {
  ACCENT_RE,
  Banner,
  btnStyle,
  C,
  type ErpSettings,
  Field,
  inputStyle,
  num,
  Panel,
  postErpSettings,
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
        tagline.length > 140 ? 'Keep the tagline under 140 characters.' : null,
      whatsapp: validateWhatsapp(whatsapp.trim()),
      deliveryFee:
        feeStr === '' || !Number.isFinite(feeN) || feeN < 0
          ? 'Enter a delivery fee of 0 or more.'
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
      setNotice({ tone: 'info', text: 'Nothing to save — no changes.' });
      return;
    }

    setSaving(true);
    const out = await postErpSettings(slug, patch);
    if (out.status === 'ok') {
      setNotice({
        tone: 'ok',
        text: 'Settings saved — the live shop picks them up on next load.',
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

      <Panel title="Store settings">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
              gap: 14,
            }}
          >
            <Field label="Store name" error={errors.shopName}>
              <input
                style={inputStyle}
                value={shopName}
                maxLength={60}
                onChange={e => setShopName(e.target.value)}
                disabled={disabled}
              />
            </Field>
            <Field
              label="Tagline"
              hint="Short line under the store name."
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
              label="Delivery fee (DZD)"
              hint="Added to every cash-on-delivery order."
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
              label="Accent color"
              hint="Hex color, e.g. #0f766e."
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
              label="Admin PIN"
              hint="4–8 digits — gates the deployed shop’s admin page."
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
                  <Spinner dark /> Saving…
                </>
              ) : (
                'Save settings'
              )}
            </button>
            {readOnly ? (
              <span style={{ fontSize: 12, color: C.muted }}>
                Read-only — admin changes are unavailable right now.
              </span>
            ) : null}
          </div>
        </div>
      </Panel>
    </div>
  );
};
