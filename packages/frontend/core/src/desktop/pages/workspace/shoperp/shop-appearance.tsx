import { cdzApiUrl } from '@affine/core/blocksuite/ai/provider/ai-provider';
import {
  type CSSProperties,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react';

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
  RADIUS_OPTIONS,
  DEFAULT_RADIUS,
  resolveRadius,
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
//
// WSB-7 — CONVERGENCE / REBASE UX. Appearance is runtime-settings-driven
// (theme / font / accent / sections are read at load by SHOP-TEMPLATE's
// applyTheme), so those changes COMPOSE with any AI-authored HTML patch and are
// saved SILENTLY — exactly today's behavior. The one control that changes the
// storefront's STRUCTURE is the layout `template` switch (standard ↔ boutique):
// if this store has a staged AI patch (ShopState.hasAiPatch), a clean template
// swap can be MASKED by that patch. So when — and ONLY when — the template
// actually changes AND an AI patch is staged, we interpose a keep/discard
// dialog before saving:
//   • Garder  → save as usual (the AI patch stays; the new gabarit may be
//     hidden until the AI layer is re-done) — byte-identical to current save.
//   • Repartir → additionally POST /apps/:slug/state/note documenting the reset
//     (the actual clean re-mint lands via the existing Re-publish path), then
//     save. The note is the audit trail that the owner chose the clean gabarit.
// Detection is fail-soft: GET /state 404 (flag off) / any error ⇒ hasAiPatch
// false ⇒ NO dialog, exactly current behavior. The state read is a tiny
// file-local helper (kept out of the shared client to avoid a parallel-build
// symbol race with the WSB-5 wrappers) that only ever reads the boolean flag.
// ---------------------------------------------------------------------------

// The client-safe ShopState projection GET /api/v1/apps/:slug/state returns
// (clickdz-shop-state.ts → publicShopState). We only consume `hasAiPatch`.
interface ShopStateMeta {
  hasAiPatch: boolean;
}

/**
 * GET /api/v1/apps/:slug/state — read ONLY the `hasAiPatch` flag. Never throws:
 * a 404 (CDZ_SHOP_STATE off / route absent / app not found), a non-OK status,
 * or a network error all resolve to `{ hasAiPatch: false }` so the appearance
 * editor behaves byte-identically to today whenever ShopState isn't available.
 */
async function fetchShopStateMeta(slug: string): Promise<ShopStateMeta> {
  let res: Response;
  try {
    res = await fetch(
      cdzApiUrl(`/api/v1/apps/${encodeURIComponent(slug)}/state`),
      { method: 'GET', headers: { Accept: 'application/json' }, credentials: 'include' }
    );
  } catch {
    return { hasAiPatch: false };
  }
  if (!res.ok) return { hasAiPatch: false };
  const data = (await res.json().catch(() => null)) as
    | { ok?: boolean; state?: { hasAiPatch?: unknown } }
    | null;
  return { hasAiPatch: data?.state?.hasAiPatch === true };
}

/**
 * POST /api/v1/apps/:slug/state/note {note} — append a free-text entry to the
 * ShopState activity log (documents the "repartir du gabarit propre" choice).
 * Best-effort: any failure is swallowed (the save/re-publish is the money path
 * and must never be blocked by a missing/again-flagged-off state route).
 */
async function postShopStateNote(slug: string, note: string): Promise<void> {
  try {
    await fetch(
      cdzApiUrl(`/api/v1/apps/${encodeURIComponent(slug)}/state/note`),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ note }),
      }
    );
  } catch {
    /* audit note is best-effort — never block the save */
  }
}

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

  // HERO-1: the line under the shop name in the storefront hero. The template
  // already honored settings.heroLine (falling back to the tagline) — there was
  // just no way to set it, so every shop showed its tagline there forever.
  const [heroLine, setHeroLine] = useState<string>(
    typeof settings.heroLine === 'string' ? settings.heroLine : ''
  );
  const [radius, setRadius] = useState<string>(
    resolveRadius(settings.radius).id
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

  // WSB-7 — whether this store has a staged AI-authored HTML patch (ShopState).
  // Read once, fail-soft (false whenever the state route is unavailable). Only
  // used to decide if a STRUCTURAL (template) switch needs the keep/discard
  // dialog; appearance-only changes never consult it.
  const [hasAiPatch, setHasAiPatch] = useState(false);
  // Non-null while the keep/discard dialog is up (a template swap + AI patch).
  const [rebasePrompt, setRebasePrompt] = useState<{
    from: string;
    to: string;
  } | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const meta = await fetchShopStateMeta(slug);
      if (alive) setHasAiPatch(meta.hasAiPatch);
    })();
    return () => {
      alive = false;
    };
  }, [slug]);

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

  // Does the current draft change the STRUCTURAL layout template? (standard ↔
  // boutique). This is the only appearance control that alters the storefront's
  // HTML structure — the one that an AI patch can mask.
  const templateChanged = template !== resolveTemplate(settings.template).id;

  // Commit the settings patch to the server (the money path). `rebaseNote`, when
  // present, is first appended to the ShopState log (best-effort) to document a
  // "repartir du gabarit propre" choice. Everything after the note is identical
  // to the original save, so a plain appearance save is byte-for-byte unchanged.
  const commitSave = useCallback(
    async (rebaseNote?: string) => {
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
      if (draftSectionsCsv !== storedSectionsCsv) {
        patch.sections = draftSectionsCsv;
      }
      if (radius !== resolveRadius(settings.radius).id) patch.radius = radius;
      const storedHero =
        typeof settings.heroLine === 'string' ? settings.heroLine : '';
      if (heroLine !== storedHero) patch.heroLine = heroLine.slice(0, 200);

      if (Object.keys(patch).length === 0) {
        setNotice({ tone: 'info', text: 'Rien à enregistrer — aucune modification.' });
        return;
      }

      setSaving(true);
      // Document the reset BEFORE saving so the audit order reads naturally.
      // Best-effort + fire-first: never blocks or fails the save below.
      if (rebaseNote) {
        await postShopStateNote(slug, rebaseNote);
      }
      const out = await postErpSettings(slug, patch);
      if (out.status === 'ok') {
        setSaved(true);
        setRepublished(null);
        setNotice({
          tone: 'ok',
          text: rebaseNote
            ? 'Apparence enregistrée sur le gabarit propre — republiez pour supprimer la couche IA et l’appliquer.'
            : 'Apparence enregistrée. Republiez la boutique pour l’appliquer au site en ligne.',
        });
        onMutated(); // refresh the summary so the stored settings stay in sync
      } else if (out.status === 'unavailable') {
        onWritesBlocked();
      } else {
        // A rejected id (e.g. server allowlist mismatch) surfaces here.
        setNotice({ tone: 'error', text: out.message });
      }
      setSaving(false);
    },
    [
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
    ]
  );

  // Save entry point. When the ONLY-structural template switch would collide
  // with a staged AI patch, interpose the keep/discard dialog first; otherwise
  // (appearance-only change, or no AI patch, or state unavailable) save straight
  // through — byte-identical to the pre-WSB-7 behavior.
  const save = useCallback(async () => {
    if (disabled) return;
    if (templateChanged && hasAiPatch) {
      setRebasePrompt({
        from: resolveTemplate(settings.template).label,
        to: resolveTemplate(template).label,
      });
      return;
    }
    await commitSave();
  }, [disabled, templateChanged, hasAiPatch, settings, template, commitSave]);

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
        text: 'Republié — le site en ligne reflète maintenant votre apparence.',
      });
    } else if (out.status === 'no-source') {
      setNotice({
        tone: 'info',
        text: 'Enregistré. Pour le mettre en ligne, ouvrez la boutique dans votre Studio et republiez (sa source n’est pas chargée dans cette session).',
      });
    } else if (out.status === 'cap') {
      setNotice({
        tone: 'error',
        text: 'Vous avez atteint la limite de publication — libérez un emplacement depuis Gérer, puis republiez.',
      });
    } else if (out.status === 'upgrade') {
      setNotice({
        tone: 'error',
        text: 'La republication nécessite un plan Pro sur cet espace de travail.',
      });
    } else {
      setNotice({ tone: 'error', text: out.message });
    }
    setRepublishing(false);
  }, [republishing, slug, storeSlug, url]);

  const shopName = settings.shopName || slug;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* WSB-7 — keep/discard dialog: a structural template switch on a shop
          that carries a staged AI patch. */}
      {rebasePrompt ? (
        <RebaseDialog
          fromLabel={rebasePrompt.from}
          toLabel={rebasePrompt.to}
          busy={saving}
          onKeep={() => {
            setRebasePrompt(null);
            void commitSave();
          }}
          onReset={() => {
            const note = `Apparence : repartir du gabarit propre (${rebasePrompt.from} → ${rebasePrompt.to}) — modifications IA à supprimer à la prochaine re-publication.`;
            setRebasePrompt(null);
            void commitSave(note);
          }}
          onCancel={() => setRebasePrompt(null)}
        />
      ) : null}

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
                Republier maintenant
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
                Voir en ligne ↗
              </a>
            </>
          ) : null}
        </Banner>
      ) : null}

      {readOnly ? (
        <Banner tone="warn">
          Les modifications d’apparence sont indisponibles sur ce serveur pour
          le moment — cet éditeur est en <strong>lecture seule</strong>. Vous
          pouvez toujours prévisualiser les thèmes ; publiez le style depuis
          l’admin de la boutique déployée quand les écritures reviendront.
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
          <Panel title="Thème">
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

          <Panel title="Gabarit de mise en page">
            <div style={optionGridStyle}>
              {TEMPLATE_OPTIONS.map(t => (
                <ChoiceCard
                  key={t.id}
                  active={template === t.id}
                  disabled={disabled}
                  onClick={() => setTemplate(t.id)}
                  title={t.label}
                  hint={t.hint}
                  glyph={TEMPLATE_GLYPHS[t.id] ?? '▤'}
                  isDefault={t.id === DEFAULT_TEMPLATE}
                />
              ))}
            </div>
          </Panel>

          {/* Corner style — overrides the theme preset's radius. 'Selon le
              thème' is the default and leaves it untouched, which is what every
              shop had before this control existed. Also reshapes buttons. */}
          <Panel title="Coins">
            <div style={optionGridStyle}>
              {RADIUS_OPTIONS.map(r => (
                <ChoiceCard
                  key={r.id}
                  active={radius === r.id}
                  disabled={disabled}
                  onClick={() => setRadius(r.id)}
                  title={r.label}
                  hint={r.hint}
                  glyph={RADIUS_GLYPHS[r.id] ?? '\u25a2'}
                  isDefault={r.id === DEFAULT_RADIUS}
                />
              ))}
            </div>
          </Panel>

          <Panel title="Police">
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
                        <span style={defaultTagStyle}>défaut</span>
                      ) : null}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          </Panel>

          <Panel title="Couleur d'accent">
            <Field
              label="Accent"
              hint="Utilisée pour les boutons, les mises en avant et l’en-tête. Hex, ex. #0f766e."
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

          {/* HERO-1 — the storefront template already rendered settings.heroLine
              (falling back to the tagline); this is the first way to set it. */}
          <Panel title="Phrase d'accroche">
            <Field
              label="Hero"
              hint="La ligne sous le nom de la boutique, dans le hero. Vide = votre slogan."
            >
              <input
                style={inputStyle}
                value={heroLine}
                maxLength={200}
                placeholder="Livraison 58 wilayas &middot; paiement &agrave; la livraison"
                disabled={disabled}
                onChange={e => setHeroLine(e.target.value.slice(0, 200))}
              />
            </Field>
          </Panel>

          <Panel title="Sections">
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <div style={{ ...hintStyle, marginBottom: 4 }}>
                Activez ou désactivez les sections facultatives de la boutique. Toutes sont activées par défaut.
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
                  <Spinner dark /> Enregistrement…
                </>
              ) : (
                'Enregistrer l’apparence'
              )}
            </button>
            {dirty && !saving ? (
              <button style={btnStyle('secondary')} onClick={resetDraft}>
                Réinitialiser
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
                    <Spinner /> Republication…
                  </>
                ) : (
                  '🚀 Republier la boutique'
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
            <span style={labelStyle}>Aperçu</span>
            <div style={{ flex: 1 }} />
            <div style={{ display: 'inline-flex', gap: 4 }}>
              <button
                style={segStyle(previewMode === 'mock')}
                onClick={() => setPreviewMode('mock')}
              >
                Brouillon
              </button>
              <button
                style={segStyle(previewMode === 'live')}
                onClick={() => setPreviewMode('live')}
                disabled={!url}
                title={url ? 'La boutique actuellement publiée' : 'Pas encore d’URL en ligne'}
              >
                En ligne
              </button>
            </div>
          </div>

          {previewMode === 'live' ? (
            url ? (
              <div
                style={{
                  borderRadius: 14,
                  overflow: 'hidden',
                  border: `1px solid ${C.border}`,
                  background: C.panel,
                  boxShadow: '0 1px 4px rgba(0,0,0,0.12)',
                }}
              >
                <iframe
                  title="Aperçu de la boutique en ligne"
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
                  Voici ce qui est en ligne actuellement — republiez après avoir enregistré pour le mettre à jour.
                </div>
              </div>
            ) : (
              <Banner tone="info">
                Pas encore d’URL en ligne — publiez d’abord la boutique, puis l’aperçu en direct
                apparaîtra ici.
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
            L’aperçu du brouillon est une approximation. Le style exact de la
            boutique publiée est appliqué par le gabarit de la boutique à
            partir de vos paramètres enregistrés.
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

// One glyph per layout id. Was a binary `id === 'boutique' ? ... : ...`, which
// silently gave every other layout the Standard glyph — fine while only two
// layouts were exposed, wrong the moment grid-dense/editorial-split appeared.
const RADIUS_GLYPHS: Record<string, string> = {
  auto: '\u25a2',
  carre: '\u25a0',
  doux: '\u25a3',
  arrondi: '\u25cf',
};

const TEMPLATE_GLYPHS: Record<string, string> = {
  standard: '\u25a4',
  boutique: '\u25a6',
  'grid-dense': '\u25a9',
  'editorial-split': '\u25eb',
  landing: '\u25ad',
};

const THEME_PALETTE: Record<
  string,
  { bg: string; card: string; ink: string; sub: string; line: string; radius: number; heroFlat?: boolean }
> = {
  classic: { bg: '#f6f7f9', card: '#ffffff', ink: '#0f172a', sub: '#64748b', line: '#e5e7eb', radius: 12 },
  dark: { bg: '#0b0f19', card: '#151b2b', ink: '#e8ecf4', sub: '#93a0bd', line: '#26304a', radius: 12 },
  vibrant: { bg: '#fff7ed', card: '#ffffff', ink: '#1f130a', sub: '#8a5a33', line: '#f3d9bf', radius: 16 },
  minimal: { bg: '#ffffff', card: '#ffffff', ink: '#111111', sub: '#777777', line: '#ececec', radius: 4, heroFlat: true },
  sahara: { bg: '#faf5ec', card: '#fffdf8', ink: '#3b2f23', sub: '#6f5f4b', line: '#eadfcc', radius: 14 },
  'nuit-doree': { bg: '#101014', card: '#1a1a20', ink: '#ece7db', sub: '#b7ae99', line: '#2a2a31', radius: 16 },
  olive: { bg: '#f8f7f2', card: '#ffffff', ink: '#26301c', sub: '#5c6650', line: '#e4e4d8', radius: 10 },
  azur: { bg: '#f1f5f9', card: '#ffffff', ink: '#0c1a2b', sub: '#42566e', line: '#dbe4ee', radius: 8 },
  flash: { bg: '#0d0d0f', card: '#17171b', ink: '#f4f4f5', sub: '#b9b9c0', line: '#26262c', radius: 18 },
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
  // The mock approximates each layout by card count + whether the hero band is
  // drawn. `boutique` used to be the only branch, so grid-dense and
  // editorial-split would both have previewed as Standard.
  const boutique = template === 'boutique' || template === 'editorial-split';
  const showHero = sections.includes('hero') && template !== 'grid-dense';
  const showTrust = sections.includes('trust');
  const showCats = sections.includes('categories');

  const cardCount =
    template === 'landing'
      ? 1
      : template === 'grid-dense'
        ? 9
        : template === 'editorial-split'
          ? 4
          : boutique
            ? 3
            : 6;
  const cards = useMemo(
    () => Array.from({ length: cardCount }, (_, i) => i),
    [cardCount]
  );

  return (
    <div
      style={{
        borderRadius: 14,
        overflow: 'hidden',
        border: `1px solid ${C.border}`,
        background: pal.bg,
        fontFamily: fontStack,
        color: pal.ink,
        maxHeight: 520,
        overflowY: 'auto',
        boxShadow: '0 1px 4px rgba(0,0,0,0.12)',
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
// WSB-7 — the keep/discard (rebase) dialog. Shown only when a structural
// template switch would collide with a staged AI patch. Modal-lite: a dark
// scrim + a centered card, FR copy + a short darja hint. No deps, inline styles.
// ---------------------------------------------------------------------------

const RebaseDialog = ({
  fromLabel,
  toLabel,
  busy,
  onKeep,
  onReset,
  onCancel,
}: {
  fromLabel: string;
  toLabel: string;
  busy: boolean;
  onKeep: () => void;
  onReset: () => void;
  onCancel: () => void;
}) => (
  <div
    role="dialog"
    aria-modal="true"
    aria-label="Modifications IA"
    style={{
      position: 'fixed',
      inset: 0,
      zIndex: 2147483000,
      display: 'grid',
      placeItems: 'center',
      padding: 16,
      background: 'rgba(0,0,0,0.65)',
    }}
    onClick={onCancel}
  >
    <style>{'@keyframes cdz-pop-in{from{opacity:0;transform:scale(0.96) translateY(8px)}to{opacity:1;transform:none}}'}</style>
    <div
      style={{
        width: '100%',
        maxWidth: 460,
        boxSizing: 'border-box',
        background: C.panel,
        border: `1px solid ${C.border}`,
        borderRadius: 16,
        padding: 20,
        boxShadow: '0 16px 48px rgba(0,0,0,0.5)',
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        animation: 'cdz-pop-in 220ms cubic-bezier(0.2,0,0,1)',
      }}
      onClick={e => e.stopPropagation()}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span aria-hidden style={{ width: 36, height: 36, borderRadius: 11, display: 'grid', placeItems: 'center', fontSize: 18, flexShrink: 0, background: 'linear-gradient(135deg, #e8a33d, #c97d1f)', border: `1px solid ${C.border}` }}>
          ⚠️
        </span>
        <div style={{ fontSize: 17, fontWeight: 800, color: C.text }}>
          Cette boutique a des modifications IA
        </div>
      </div>
      <p style={{ margin: 0, fontSize: 13.5, color: C.muted, lineHeight: 1.6 }}>
        Vous changez le gabarit&nbsp;: <strong style={{ color: C.text }}>{fromLabel}</strong>{' '}
        →&nbsp;<strong style={{ color: C.text }}>{toLabel}</strong>. Vos
        modifications IA peuvent <strong>masquer</strong> le nouveau gabarit.
        Voulez-vous les garder, ou repartir du gabarit propre&nbsp;?
      </p>
      <div
        dir="rtl"
        style={{
          fontSize: 12.5,
          color: C.text,
          lineHeight: 1.6,
          padding: '8px 11px',
          borderRadius: 8,
          background: C.accentSoft,
          border: `1px solid ${C.border}`,
        }}
      >
        الحانوت فيه تبديلات بالذكاء الاصطناعي — تنجم تخبّي القالب الجديد. تخلّيهم
        ولا تبدا من القالب النظيف؟
      </div>
      <div
        style={{
          display: 'flex',
          gap: 10,
          flexWrap: 'wrap',
          marginTop: 4,
          alignItems: 'center',
        }}
      >
        <button
          style={btnStyle('secondary', busy)}
          disabled={busy}
          onClick={onCancel}
        >
          Annuler
        </button>
        <div style={{ flex: 1 }} />
        <button
          style={btnStyle('secondary', busy)}
          disabled={busy}
          onClick={onReset}
          title="Repartir du gabarit propre — les modifications IA seront supprimées à la prochaine re-publication."
        >
          {busy ? (
            <>
              <Spinner /> …
            </>
          ) : (
            'Repartir du gabarit propre'
          )}
        </button>
        <button
          style={btnStyle('primary', busy)}
          disabled={busy}
          onClick={onKeep}
          title="Garder les modifications IA (elles peuvent masquer le nouveau gabarit)."
        >
          {busy ? (
            <>
              <Spinner dark /> …
            </>
          ) : (
            'Garder les modifications IA'
          )}
        </button>
      </div>
    </div>
  </div>
);

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
    borderRadius: 12,
    cursor: disabled ? 'default' : 'pointer',
    opacity: disabled ? 0.6 : 1,
    background: active ? C.accentSoft : C.bg,
    border: `1px solid ${active ? C.accent : C.border}`,
    color: C.text,
    transition: 'border-color 160ms ease, background 160ms ease, box-shadow 200ms ease',
    textAlign: 'center',
    boxShadow: active ? '0 1px 4px rgba(0,0,0,0.12)' : 'none',
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
      {isDefault ? <span style={defaultTagStyle}>défaut</span> : null}
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
      {isDefault ? <span style={defaultTagStyle}>défaut</span> : null}
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
