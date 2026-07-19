import { type CSSProperties, useCallback, useMemo, useState } from 'react';

import {
  ACCENT_RE,
  Banner,
  btnStyle,
  C,
  DEFAULT_FONT,
  DEFAULT_TEMPLATE,
  DEFAULT_THEME,
  type ErpSettings,
  Field,
  FONT_OPTIONS,
  hintStyle,
  inputStyle,
  labelStyle,
  parseSections,
  Panel,
  postErpSettings,
  type RepublishOutcome,
  republishShop,
  resolveFont,
  resolveTemplate,
  resolveTheme,
  SECTION_OPTIONS,
  serializeSections,
  Spinner,
  TEMPLATE_OPTIONS,
  THEME_OPTIONS,
  validateAccent,
} from './shoperp-shared';

// ---------------------------------------------------------------------------
// Shop Appearance editor (C7). A theme + layout-template + font + accent-color
// + section editor with a LIVE PREVIEW, saving to the settings singleton via
// the authed bridge route POST /api/v1/apps/:slug/erp/settings {patch}. The ids
// it writes (theme/template/font/sections) come from the catalogs in
// shoperp-shared and MUST match SHOP-TEMPLATE (which maps each id → :root vars /
// layout at runtime) + the BRIDGE-BE allowlist (which validates them). We store
// IDS ONLY — never raw CSS — so the 8KB settings cap is never at risk.
//
// Preview: a lightweight, instant in-app mock that re-renders on every draft
// change (the deployed CSS is SHOP-TEMPLATE's; this is an honest approximation,
// clearly labelled "Preview"). A secondary tab embeds the actual published
// storefront in an <iframe> so the owner can compare against what's live.
//
// After Save, the live storefront only reflects the change once it re-fetches
// settings (SHOP-TEMPLATE's runtime applyTheme) — so we surface a clear
// "re-publish to apply" note plus a one-click Re-publish that re-deploys the
// staged storefront HTML under the same slug (see republishShop). Everything is
// read-only-safe: when the server reports admin_writes_unavailable the whole
// editor stays usable, controls disable, and we tell the user why.
// ---------------------------------------------------------------------------

export const ShopAppearance = ({
  slug,
  settings,
  url,
  storeSlug,
  readOnly,
  onWritesBlocked,
  onMutated,
}: {
  /** The store's slug — its data-API namespace + publish slug. */
  slug: string;
  /** The live settings singleton (from the ERP summary). */
  settings: ErpSettings;
  /** Live storefront URL, when known (for the iframe preview + re-publish). */
  url?: string;
  /** Pairing key, forwarded to re-publish so the record stays paired. */
  storeSlug?: string;
  readOnly: boolean;
  onWritesBlocked: () => void;
  onMutated: () => void;
}) => {
  // ---- Draft state, seeded from the stored singleton (with safe defaults) ---
  const [theme, setTheme] = useState<string>(
    resolveTheme(settings.theme).id
  );
  const [template, setTemplate] = useState<string>(
    resolveTemplate(settings.template).id
  );
  const [font, setFont] = useState<string>(resolveFont(settings.font).id);
  const [accent, setAccent] = useState<string>(
    String(settings.accent ?? '#0f766e')
  );
  const [sections, setSections] = useState<string[]>(() =>
    parseSections(settings.sections)
  );

  const [accentErr, setAccentErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false); // a save landed → offer re-publish
  const [notice, setNotice] = useState<{
    tone: 'ok' | 'error' | 'info';
    text: string;
  } | null>(null);
  const [previewMode, setPreviewMode] = useState<'mock' | 'live'>('mock');

  // Re-publish (post-save) state — mirrors the wizard's publish outcomes.
  const [republishing, setRepublishing] = useState(false);
  const [republished, setRepublished] = useState<string | null>(null);

  const disabled = readOnly || saving;

  // ---- Dirty tracking (send only changed fields) ---------------------------
  const storedSectionsCsv = serializeSections(parseSections(settings.sections));
  const draftSectionsCsv = serializeSections(sections);
  const dirty =
    theme !== resolveTheme(settings.theme).id ||
    template !== resolveTemplate(settings.template).id ||
    font !== resolveFont(settings.font).id ||
    accent.trim() !== String(settings.accent ?? '#0f766e').trim() ||
    draftSectionsCsv !== storedSectionsCsv;

  const toggleSection = useCallback((id: string) => {
    setSections(cur =>
      cur.includes(id) ? cur.filter(s => s !== id) : [...cur, id]
    );
  }, []);

  const resetDraft = useCallback(() => {
    setTheme(resolveTheme(settings.theme).id);
    setTemplate(resolveTemplate(settings.template).id);
    setFont(resolveFont(settings.font).id);
    setAccent(String(settings.accent ?? '#0f766e'));
    setSections(parseSections(settings.sections));
    setAccentErr(null);
    setNotice(null);
  }, [settings]);

  const save = useCallback(async () => {
    if (disabled) return;
    setNotice(null);
    const trimmedAccent = accent.trim();
    const aErr = validateAccent(trimmedAccent);
    setAccentErr(aErr);
    if (aErr) return;

    // Build a patch of only the fields that actually changed.
    const patch: Partial<ErpSettings> = {};
    if (theme !== resolveTheme(settings.theme).id) patch.theme = theme;
    if (template !== resolveTemplate(settings.template).id) {
      patch.template = template;
    }
    if (font !== resolveFont(settings.font).id) patch.font = font;
    if (trimmedAccent !== String(settings.accent ?? '#0f766e').trim()) {
      patch.accent = trimmedAccent;
    }
    if (draftSectionsCsv !== storedSectionsCsv) patch.sections = draftSectionsCsv;

    if (Object.keys(patch).length === 0) {
      setNotice({ tone: 'info', text: 'Nothing to save — no changes.' });
      return;
    }

    setSaving(true);
    const out = await postErpSettings(slug, patch);
    if (out.status === 'ok') {
      setSaved(true);
      setRepublished(null);
      setNotice({
        tone: 'ok',
        text: 'Appearance saved. Re-publish the shop to apply it to the live storefront.',
      });
      onMutated(); // refresh the summary so the stored settings stay in sync
    } else if (out.status === 'unavailable') {
      onWritesBlocked();
    } else {
      // A rejected id (e.g. server allowlist mismatch) surfaces here.
      setNotice({ tone: 'error', text: out.message });
    }
    setSaving(false);
  }, [
    disabled,
    accent,
    theme,
    template,
    font,
    draftSectionsCsv,
    storedSectionsCsv,
    settings,
    slug,
    onMutated,
    onWritesBlocked,
  ]);

  const doRepublish = useCallback(async () => {
    if (republishing) return;
    setRepublishing(true);
    setNotice(null);
    const out: RepublishOutcome = await republishShop({
      slug,
      ...(storeSlug ? { storeSlug } : {}),
      kind: 'shop',
    });
    if (out.status === 'ok') {
      setRepublished(out.url || url || '');
      setSaved(false);
      setNotice({
        tone: 'ok',
        text: 'Re-published — the live storefront now reflects your appearance.',
      });
    } else if (out.status === 'no-source') {
      setNotice({
        tone: 'info',
        text: 'Saved. To push it live, open the shop in your Studio and re-publish (its source isn’t staged in this session).',
      });
    } else if (out.status === 'cap') {
      setNotice({
        tone: 'error',
        text: 'You’re at the publish limit — free a slot from Manage, then re-publish.',
      });
    } else if (out.status === 'upgrade') {
      setNotice({
        tone: 'error',
        text: 'Re-publishing needs a Pro plan on this workspace.',
      });
    } else {
      setNotice({ tone: 'error', text: out.message });
    }
    setRepublishing(false);
  }, [republishing, slug, storeSlug, url]);

  const shopName = settings.shopName || slug;

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
          {saved && notice.tone === 'ok' && !republishing ? (
            <>
              {' '}
              <button style={miniPublishStyle} onClick={() => void doRepublish()}>
                Re-publish now
              </button>
            </>
          ) : null}
          {republished ? (
            <>
              {' · '}
              <a
                href={republished}
                target="_blank"
                rel="noopener noreferrer"
                style={{ color: C.accent }}
              >
                Open live ↗
              </a>
            </>
          ) : null}
        </Banner>
      ) : null}

      {readOnly ? (
        <Banner tone="warn">
          Appearance changes are unavailable on this server right now — this
          editor is <strong>read-only</strong>. You can still preview themes;
          publish styling from the deployed shop’s admin when writes return.
        </Banner>
      ) : null}

      {/* Two columns: controls (left) + live preview (right). Wraps on narrow. */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))',
          gap: 12,
          alignItems: 'start',
        }}
      >
        {/* ---- Controls ------------------------------------------------- */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <Panel title="Theme">
            <div style={optionGridStyle}>
              {THEME_OPTIONS.map(t => (
                <SwatchCard
                  key={t.id}
                  active={theme === t.id}
                  disabled={disabled}
                  onClick={() => setTheme(t.id)}
                  title={t.label}
                  hint={t.hint}
                  swatches={[
                    accentValidHex(accent) || '#0f766e',
                    t.preview.bg,
                    t.preview.card,
                    t.preview.ink,
                  ]}
                  isDefault={t.id === DEFAULT_THEME}
                />
              ))}
            </div>
          </Panel>

          <Panel title="Layout template">
            <div style={optionGridStyle}>
              {TEMPLATE_OPTIONS.map(t => (
                <ChoiceCard
                  key={t.id}
                  active={template === t.id}
                  disabled={disabled}
                  onClick={() => setTemplate(t.id)}
                  title={t.label}
                  hint={t.hint}
                  glyph={t.id === 'boutique' ? '▦' : '▤'}
                  isDefault={t.id === DEFAULT_TEMPLATE}
                />
              ))}
            </div>
          </Panel>

          <Panel title="Font">
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div style={optionGridStyle}>
                {FONT_OPTIONS.map(f => (
                  <button
                    key={f.id}
                    type="button"
                    disabled={disabled}
                    onClick={() => setFont(f.id)}
                    style={choiceButtonStyle(font === f.id, disabled)}
                    title={f.label}
                  >
                    <span
                      style={{
                        fontFamily: f.stack,
                        fontSize: 18,
                        fontWeight: 700,
                        color: C.text,
                      }}
                    >
                      Ag
                    </span>
                    <span style={{ fontSize: 12, fontWeight: 700 }}>
                      {f.label}
                      {f.id === DEFAULT_FONT ? (
                        <span style={defaultTagStyle}>default</span>
                      ) : null}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          </Panel>

          <Panel title="Accent color">
            <Field
              label="Accent"
              hint="Buttons, highlights and the header use this. Hex, e.g. #0f766e."
              error={accentErr}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span
                  aria-hidden
                  style={{
                    width: 30,
                    height: 30,
                    borderRadius: 8,
                    flexShrink: 0,
                    border: `1px solid ${C.border}`,
                    background: accentValidHex(accent) || 'transparent',
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
                  disabled={disabled}
                  onChange={e => {
                    let v = e.target.value.trim();
                    if (v && !v.startsWith('#')) v = `#${v}`;
                    setAccent(v.slice(0, 7));
                  }}
                />
              </div>
            </Field>
          </Panel>

          <Panel title="Sections">
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <div style={{ ...hintStyle, marginBottom: 4 }}>
                Toggle optional storefront sections. All are on by default.
              </div>
              {SECTION_OPTIONS.map(s => {
                const on = sections.includes(s.id);
                return (
                  <label
                    key={s.id}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 10,
                      padding: '8px 0',
                      cursor: disabled ? 'default' : 'pointer',
                      opacity: disabled ? 0.6 : 1,
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={on}
                      disabled={disabled}
                      onChange={() => toggleSection(s.id)}
                      style={{ width: 16, height: 16, accentColor: C.accent }}
                    />
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <span
                        style={{ fontSize: 13, fontWeight: 700, color: C.text }}
                      >
                        {s.label}
                      </span>
                      <span
                        style={{ display: 'block', fontSize: 11.5, color: C.muted }}
                      >
                        {s.hint}
                      </span>
                    </span>
                  </label>
                );
              })}
            </div>
          </Panel>

          {/* Save / reset controls */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              flexWrap: 'wrap',
            }}
          >
            <button
              style={btnStyle('primary', disabled || !dirty)}
              disabled={disabled || !dirty}
              onClick={() => void save()}
            >
              {saving ? (
                <>
                  <Spinner dark /> Saving…
                </>
              ) : (
                'Save appearance'
              )}
            </button>
            {dirty && !saving ? (
              <button style={btnStyle('secondary')} onClick={resetDraft}>
                Reset
              </button>
            ) : null}
            {saved && !dirty ? (
              <button
                style={btnStyle('secondary', republishing)}
                disabled={republishing}
                onClick={() => void doRepublish()}
              >
                {republishing ? (
                  <>
                    <Spinner /> Re-publishing…
                  </>
                ) : (
                  '🚀 Re-publish shop'
                )}
              </button>
            ) : null}
          </div>
        </div>

        {/* ---- Live preview -------------------------------------------- */}
        <div
          style={{
            position: 'sticky',
            top: 8,
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={labelStyle}>Preview</span>
            <div style={{ flex: 1 }} />
            <div style={{ display: 'inline-flex', gap: 4 }}>
              <button
                style={segStyle(previewMode === 'mock')}
                onClick={() => setPreviewMode('mock')}
              >
                Draft
              </button>
              <button
                style={segStyle(previewMode === 'live')}
                onClick={() => setPreviewMode('live')}
                disabled={!url}
                title={url ? 'The currently published storefront' : 'No live URL yet'}
              >
                Live
              </button>
            </div>
          </div>

          {previewMode === 'live' ? (
            url ? (
              <div
                style={{
                  borderRadius: 12,
                  overflow: 'hidden',
                  border: `1px solid ${C.border}`,
                  background: C.panel,
                }}
              >
                <iframe
                  title="Live storefront preview"
                  src={url}
                  style={{
                    width: '100%',
                    height: 460,
                    border: 'none',
                    display: 'block',
                    background: '#fff',
                  }}
                  sandbox="allow-scripts allow-same-origin"
                  loading="lazy"
                />
                <div
                  style={{
                    padding: '7px 12px',
                    fontSize: 11.5,
                    color: C.muted,
                    borderTop: `1px solid ${C.border}`,
                  }}
                >
                  This is what’s live now — re-publish after saving to update it.
                </div>
              </div>
            ) : (
              <Banner tone="info">
                No live URL yet — publish the shop first, then the live preview
                appears here.
              </Banner>
            )
          ) : (
            <MockPreview
              shopName={shopName}
              theme={theme}
              template={template}
              font={font}
              accent={accentValidHex(accent) || '#0f766e'}
              sections={sections}
            />
          )}
          <div style={{ ...hintStyle, fontSize: 11.5 }}>
            The draft preview is an approximation. The published storefront’s
            exact styling is applied by the shop template from your saved
            settings.
          </div>
        </div>
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Lightweight in-app storefront mock — re-renders instantly from the draft. It
// mirrors the storefront's structure (header / hero / trust / categories /
// product grid / footer) so theme + template + font + accent + section toggles
// read truthfully, WITHOUT depending on SHOP-TEMPLATE internals.
// ---------------------------------------------------------------------------

const THEME_PALETTE: Record<
  string,
  { bg: string; card: string; ink: string; sub: string; line: string; radius: number; heroFlat?: boolean }
> = {
  classic: { bg: '#f6f7f9', card: '#ffffff', ink: '#0f172a', sub: '#64748b', line: '#e5e7eb', radius: 12 },
  dark: { bg: '#0b0f19', card: '#151b2b', ink: '#e8ecf4', sub: '#93a0bd', line: '#26304a', radius: 12 },
  vibrant: { bg: '#fff7ed', card: '#ffffff', ink: '#1f130a', sub: '#8a5a33', line: '#f3d9bf', radius: 16 },
  minimal: { bg: '#ffffff', card: '#ffffff', ink: '#111111', sub: '#777777', line: '#ececec', radius: 4, heroFlat: true },
};

const MockPreview = ({
  shopName,
  theme,
  template,
  font,
  accent,
  sections,
}: {
  shopName: string;
  theme: string;
  template: string;
  font: string;
  accent: string;
  sections: string[];
}) => {
  const pal = THEME_PALETTE[theme] ?? THEME_PALETTE.classic;
  const fontStack = resolveFont(font).stack;
  const accentD = shadeHex(accent, -0.22);
  const boutique = template === 'boutique';
  const showHero = sections.includes('hero');
  const showTrust = sections.includes('trust');
  const showCats = sections.includes('categories');

  const cardCount = boutique ? 3 : 6;
  const cards = useMemo(
    () => Array.from({ length: cardCount }, (_, i) => i),
    [cardCount]
  );

  return (
    <div
      style={{
        borderRadius: 12,
        overflow: 'hidden',
        border: `1px solid ${C.border}`,
        background: pal.bg,
        fontFamily: fontStack,
        color: pal.ink,
        maxHeight: 520,
        overflowY: 'auto',
      }}
    >
      {/* Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: boutique ? '14px 16px' : '11px 14px',
          background: pal.card,
          borderBottom: `1px solid ${pal.line}`,
        }}
      >
        <span
          style={{
            width: 26,
            height: 26,
            borderRadius: 8,
            display: 'grid',
            placeItems: 'center',
            color: '#fff',
            fontSize: 13,
            fontWeight: 800,
            background: `linear-gradient(135deg, ${accent}, ${accentD})`,
          }}
          aria-hidden
        >
          {String(shopName).slice(0, 1).toUpperCase() || 'S'}
        </span>
        <span
          style={{
            flex: 1,
            minWidth: 0,
            fontWeight: 800,
            fontSize: boutique ? 16 : 14,
            letterSpacing: boutique ? '0.02em' : '-0.01em',
            textAlign: boutique ? 'center' : 'left',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {shopName}
        </span>
        <span
          aria-hidden
          style={{
            width: 22,
            height: 22,
            borderRadius: 7,
            display: 'grid',
            placeItems: 'center',
            fontSize: 12,
            border: `1px solid ${pal.line}`,
            color: pal.sub,
          }}
        >
          🛒
        </span>
      </div>

      {/* Hero */}
      {showHero ? (
        <div
          style={{
            padding: boutique ? '18px 16px' : '22px 16px',
            textAlign: 'center',
            color: pal.heroFlat ? pal.ink : '#fff',
            background: pal.heroFlat
              ? pal.card
              : `linear-gradient(135deg, ${accent}, ${accentD})`,
            borderBottom: pal.heroFlat ? `1px solid ${pal.line}` : 'none',
          }}
        >
          <div
            style={{
              display: 'inline-block',
              fontSize: 10,
              fontWeight: 700,
              padding: '3px 9px',
              borderRadius: 999,
              marginBottom: 8,
              background: pal.heroFlat
                ? `color-mix(in srgb, ${accent} 14%, transparent)`
                : 'rgba(255,255,255,0.18)',
              color: pal.heroFlat ? accentD : '#fff',
            }}
          >
            Paiement à la livraison
          </div>
          <div style={{ fontSize: boutique ? 17 : 20, fontWeight: 900 }}>
            {boutique ? 'La sélection' : 'Bienvenue'}
          </div>
          <div
            style={{
              fontSize: 11.5,
              opacity: pal.heroFlat ? 0.7 : 0.92,
              marginTop: 4,
            }}
          >
            Livraison 58 wilayas · commande via WhatsApp
          </div>
        </div>
      ) : null}

      {/* Trust strip */}
      {showTrust ? (
        <div
          style={{
            display: 'flex',
            gap: 10,
            padding: '9px 14px',
            justifyContent: 'space-around',
            fontSize: 10.5,
            fontWeight: 600,
            color: pal.sub,
            background: pal.card,
            borderBottom: `1px solid ${pal.line}`,
          }}
        >
          <span>🚚 Livraison</span>
          <span>💵 COD</span>
          <span>💬 Support</span>
        </div>
      ) : null}

      {/* Category rail */}
      {showCats ? (
        <div
          style={{
            display: 'flex',
            gap: 6,
            padding: '10px 14px 2px',
            overflow: 'hidden',
          }}
        >
          {['Tous', 'Mode', 'Maison', 'Tech'].map((cName, i) => (
            <span
              key={cName}
              style={{
                fontSize: 10.5,
                fontWeight: 700,
                padding: '4px 10px',
                borderRadius: 999,
                whiteSpace: 'nowrap',
                color: i === 0 ? '#fff' : pal.sub,
                background: i === 0 ? accent : pal.card,
                border: `1px solid ${i === 0 ? accent : pal.line}`,
              }}
            >
              {cName}
            </span>
          ))}
        </div>
      ) : null}

      {/* Product grid */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: boutique ? '1fr 1fr' : '1fr 1fr 1fr',
          gap: 8,
          padding: 12,
        }}
      >
        {cards.map(i => (
          <div
            key={i}
            style={{
              background: pal.card,
              border: `1px solid ${pal.line}`,
              borderRadius: pal.radius,
              overflow: 'hidden',
            }}
          >
            <div
              style={{
                height: boutique ? 58 : 42,
                background: `color-mix(in srgb, ${accent} 12%, ${pal.bg})`,
                display: 'grid',
                placeItems: 'center',
                fontSize: 16,
                color: pal.sub,
              }}
              aria-hidden
            >
              🖼️
            </div>
            <div style={{ padding: '7px 8px' }}>
              <div
                style={{
                  height: 6,
                  width: '80%',
                  borderRadius: 3,
                  background: pal.line,
                  marginBottom: 6,
                }}
              />
              <div
                style={{
                  fontSize: 12,
                  fontWeight: 900,
                  color: accentD,
                }}
              >
                {(i + 1) * 500} DZD
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Footer */}
      <div
        style={{
          padding: '12px 14px',
          textAlign: 'center',
          fontSize: 10.5,
          color: '#94a3b8',
          background: '#0f172a',
        }}
      >
        {shopName} · Paiement à la livraison
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Small presentational helpers (inline styles only).
// ---------------------------------------------------------------------------

const optionGridStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))',
  gap: 8,
};

function choiceButtonStyle(active: boolean, disabled: boolean): CSSProperties {
  return {
    appearance: 'none',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 6,
    padding: '12px 8px',
    borderRadius: 10,
    cursor: disabled ? 'default' : 'pointer',
    opacity: disabled ? 0.6 : 1,
    background: active ? C.accentSoft : C.bg,
    border: `1px solid ${active ? C.accent : C.border}`,
    color: C.text,
    transition: 'border-color 160ms ease, background 160ms ease',
    textAlign: 'center',
  };
}

const defaultTagStyle: CSSProperties = {
  marginLeft: 5,
  fontSize: 9,
  fontWeight: 700,
  letterSpacing: '0.04em',
  textTransform: 'uppercase',
  color: C.muted,
};

const miniPublishStyle: CSSProperties = {
  appearance: 'none',
  background: 'none',
  border: 'none',
  padding: 0,
  font: 'inherit',
  fontWeight: 700,
  cursor: 'pointer',
  color: C.accent,
  textDecoration: 'underline',
};

function segStyle(active: boolean): CSSProperties {
  return {
    appearance: 'none',
    cursor: 'pointer',
    borderRadius: 7,
    padding: '4px 10px',
    fontSize: 12,
    fontWeight: 700,
    color: active ? C.text : C.muted,
    background: active ? C.accentSoft : 'transparent',
    border: `1px solid ${active ? C.accent : C.border}`,
    transition: 'color 160ms ease, border-color 160ms ease',
  };
}

const ChoiceCard = ({
  active,
  disabled,
  onClick,
  title,
  hint,
  glyph,
  isDefault,
}: {
  active: boolean;
  disabled: boolean;
  onClick: () => void;
  title: string;
  hint: string;
  glyph: string;
  isDefault?: boolean;
}) => (
  <button
    type="button"
    disabled={disabled}
    onClick={onClick}
    style={choiceButtonStyle(active, disabled)}
    title={hint}
  >
    <span style={{ fontSize: 20 }} aria-hidden>
      {glyph}
    </span>
    <span style={{ fontSize: 12, fontWeight: 700 }}>
      {title}
      {isDefault ? <span style={defaultTagStyle}>default</span> : null}
    </span>
  </button>
);

const SwatchCard = ({
  active,
  disabled,
  onClick,
  title,
  hint,
  swatches,
  isDefault,
}: {
  active: boolean;
  disabled: boolean;
  onClick: () => void;
  title: string;
  hint: string;
  swatches: string[];
  isDefault?: boolean;
}) => (
  <button
    type="button"
    disabled={disabled}
    onClick={onClick}
    style={choiceButtonStyle(active, disabled)}
    title={hint}
  >
    <span style={{ display: 'inline-flex', gap: 3 }} aria-hidden>
      {swatches.map((c, i) => (
        <span
          key={i}
          style={{
            width: 14,
            height: 14,
            borderRadius: 4,
            background: c,
            border: `1px solid ${C.border}`,
          }}
        />
      ))}
    </span>
    <span style={{ fontSize: 12, fontWeight: 700 }}>
      {title}
      {isDefault ? <span style={defaultTagStyle}>default</span> : null}
    </span>
  </button>
);

/** Return the hex if valid, else null (so the preview never shows garbage). */
function accentValidHex(v: string): string | null {
  const t = v.trim();
  return ACCENT_RE.test(t) ? t : null;
}

/**
 * Darken a #RRGGBB hex by `amt` (-1..1) — a small preview-only mirror of the
 * template's shade(); SHOP-TEMPLATE owns the deployed derivation.
 */
function shadeHex(hex: string, amt: number): string {
  const m = /^#([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  const f = (c: number) =>
    Math.max(0, Math.min(255, Math.round(c + c * amt)));
  const to2 = (c: number) => f(c).toString(16).padStart(2, '0');
  return `#${to2(r)}${to2(g)}${to2(b)}`;
}
