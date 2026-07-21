import { type CSSProperties, useCallback, useEffect, useMemo, useState } from 'react';

import {
  aiEditShop,
  type AiEditOutcome,
  Banner,
  btnStyle,
  C,
  deployApp,
  EmptyNote,
  Field,
  fetchShopSource,
  fetchShopState,
  fetchStaleness,
  hintStyle,
  inputStyle,
  labelStyle,
  miniBtnStyle,
  rollbackShopState,
  type ShopStateVersion,
  Spinner,
} from './shoperp-shared';

// ---------------------------------------------------------------------------
// "Modifier avec l'IA" — the AI-edit experience for a published storefront
// (WSB-4 + WSB-5, R3-h). A SELF-CONTAINED panel that reuses the builder-studio
// UX ideas (srcdoc preview + device toggle) without touching that Lit element,
// per the R3 plan (Bridger's mode="shop" embed is satisfied by this dedicated
// React panel). Flow:
//   1. Compose an instruction (textarea + FR/darja suggestion chips) → POST
//      /api/v1/apps/:slug/ai-edit {instruction}. Progress states surface the
//      backend's two phases: génération (LLM) then vérification du contrat (the
//      shop-contract lint + single auto-retry).
//   2. 422 contract_violation → a friendly FR error listing the violations +
//      "réessayer" (re-send the same instruction).
//   3. On success → a sandboxed srcdoc <iframe> preview (mobile/desktop toggle,
//      mirroring clickdz-builder-studio's IFRAME_SANDBOX + max-width wrapper)
//      with Publier / Annuler. The preview is null-origin (no allow-same-origin)
//      so it is a READ-ONLY visual — live data round-trips only happen on the
//      deployed origin (noted in a hint banner).
//   4. Publier → the EXISTING deployApp (same slug = idempotent, never trips the
//      publish cap) → success banner w/ link → refresh the version rail.
//
// Historique / versions rail: GET /state → version list (date, note, bytes)
// with Restaurer (POST /state/rollback → confirm dialog) + a staleness banner
// (GET /staleness → "Nouvelle version du modèle disponible" hint when stale).
//
// Quiet-gates by design (never crashes):
//   - flag OFF (CDZ_SHOP_AI_EDIT) → /source + /ai-edit 404 → "bientôt" state.
//   - no published shop yet (url missing) → composer disabled + hint.
//   - writes-blocked → surfaced via onWritesBlocked, publish disabled.
// Inline styles only (mirrors shop-appearance.tsx); FR labels + darja hints.
// ---------------------------------------------------------------------------

// Suggestion chips — FR with darja hints, tuned for the Algeria SMB storefront.
// Each `text` is the exact instruction sent to the model; `hint` is the darja
// gloss shown under the label so a darija-first seller recognizes it instantly.
const SUGGESTIONS: Array<{ text: string; hint: string }> = [
  {
    text: 'Ajoute une section promo Ramadan en haut de la page',
    hint: 'زيد قسم تخفيضات رمضان',
  },
  {
    text: 'Change les couleurs en bleu nuit',
    hint: 'بدّل الألوان للأزرق الغامق',
  },
  {
    text: 'Ajoute un bandeau livraison gratuite +5000 DA',
    hint: 'بانير توصيل فابور فوق 5000 دج',
  },
  {
    text: 'Ajoute un compte à rebours pour la promo',
    hint: 'زيد عداد تنازلي للتخفيضات',
  },
  {
    text: 'Agrandis les photos des produits et le bouton commander',
    hint: 'كبّر تصاور المنتجات وزر الطلب',
  },
  {
    text: 'Ajoute une section avis clients avec 3 témoignages',
    hint: 'زيد قسم آراء الزبائن (3 شهادات)',
  },
];

// Preview device presets — mirror clickdz-builder-studio / cdz-export's
// desktop/mobile toggle (width null = full, mobile = 390px portrait).
const DEVICES: Array<{ id: 'desktop' | 'mobile'; label: string; width: number | null }> = [
  { id: 'desktop', label: 'Bureau', width: null },
  { id: 'mobile', label: 'Mobile', width: 390 },
];

// Preview sandbox — EXACTLY the builder-studio's IFRAME_SANDBOX for srcdoc
// previews (allow-scripts allow-forms allow-popups allow-modals). Deliberately
// WITHOUT allow-same-origin: the AI HTML is rendered null-origin so it cannot
// reach the live Data API from the preview (read-only visual, per the plan).
const PREVIEW_SANDBOX = 'allow-scripts allow-forms allow-popups allow-modals';

type Phase =
  | 'idle'
  | 'generating'
  | 'linting'
  | 'preview'
  | 'publishing'
  | 'published';

type GateState = 'checking' | 'ready' | 'soon' | 'no-shop';

// A short, human FR date for the version rail (from an ISO timestamp).
function frDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso || '—';
  try {
    return d.toLocaleString('fr-DZ', {
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return d.toISOString().slice(0, 16).replace('T', ' ');
  }
}

// Compact byte size for the version rail (12345 → '12 ko').
function frBytes(n: number): string {
  const v = Number(n) || 0;
  if (v < 1024) return `${v} o`;
  return `${Math.round(v / 102.4) / 10} ko`;
}

export const ShopAiEdit = ({
  slug,
  url,
  onWritesBlocked,
}: {
  /** The store's slug — its data-API namespace + publish slug. */
  slug: string;
  /** Live storefront URL, when known (absent = no published shop yet). */
  url?: string;
  /** Called once any mutation returns admin_writes_unavailable. */
  onWritesBlocked?: () => void;
}) => {
  // ----- gate / availability ------------------------------------------------
  const [gate, setGate] = useState<GateState>('checking');

  // ----- composer -----------------------------------------------------------
  const [instruction, setInstruction] = useState('');
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState('');
  const [violations, setViolations] = useState<string[]>([]);
  // The instruction that produced the current preview — replayed on "réessayer".
  const [lastInstruction, setLastInstruction] = useState('');

  // ----- preview ------------------------------------------------------------
  const [previewHtml, setPreviewHtml] = useState('');
  const [editSummary, setEditSummary] = useState('');
  const [device, setDevice] = useState<'desktop' | 'mobile'>('desktop');
  const [publishedUrl, setPublishedUrl] = useState('');

  // ----- versions rail ------------------------------------------------------
  const [versions, setVersions] = useState<ShopStateVersion[]>([]);
  const [stateAvailable, setStateAvailable] = useState(false);
  const [confirmVersion, setConfirmVersion] = useState<ShopStateVersion | null>(
    null
  );
  const [rollingBack, setRollingBack] = useState(false);
  const [railMsg, setRailMsg] = useState('');

  // ----- staleness ----------------------------------------------------------
  const [stale, setStale] = useState(false);

  const hasShop = !!url;

  // A srcdoc preview is null-origin; wrap the iframe in a max-width column so the
  // device toggle clamps it (desktop = full, mobile = 390px), mirroring the
  // builder studio's .cdz-frame-wrap max-width behaviour.
  const previewMaxWidth = useMemo(() => {
    const preset = DEVICES.find(d => d.id === device);
    return preset && preset.width ? `${preset.width}px` : '100%';
  }, [device]);

  // Load the version rail + staleness. Fail-soft: a 404 (flag off) just leaves
  // the rail hidden; never throws.
  const loadState = useCallback(async () => {
    if (!hasShop) return;
    const [stateOut, staleOut] = await Promise.all([
      fetchShopState(slug),
      fetchStaleness(slug),
    ]);
    if (stateOut.status === 'ok') {
      setStateAvailable(true);
      setVersions(stateOut.state.versions);
    } else {
      setStateAvailable(false);
      setVersions([]);
    }
    setStale(staleOut.status === 'ok' ? staleOut.stale : false);
  }, [slug, hasShop]);

  // Availability probe on mount: GET /source tells us whether the feature flag
  // is on (200/502 = on; 404 = off → "bientôt"). No published shop short-circuits.
  useEffect(() => {
    let alive = true;
    void (async () => {
      if (!hasShop) {
        if (alive) setGate('no-shop');
        return;
      }
      const src = await fetchShopSource(slug);
      if (!alive) return;
      // 'unavailable' == route 404 (flag OFF) → quiet "bientôt". 'ok' or a
      // transient 'error' (e.g. 502 recovery) both mean the feature is live.
      setGate(src.status === 'unavailable' ? 'soon' : 'ready');
      if (src.status !== 'unavailable') {
        void loadState();
      }
    })();
    return () => {
      alive = false;
    };
  }, [slug, hasShop, loadState]);

  // ----- send an edit -------------------------------------------------------
  const runEdit = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || phase === 'generating' || phase === 'linting') return;
      setError('');
      setViolations([]);
      setPublishedUrl('');
      setLastInstruction(trimmed);
      setPhase('generating');
      // The backend runs the LLM then the contract lint (+ one auto-retry); flip
      // the label to "vérification du contrat" after a short beat so the two
      // phases read as progress even though it is a single request.
      const flip = setTimeout(() => {
        setPhase(prev => (prev === 'generating' ? 'linting' : prev));
      }, 1200);
      const out: AiEditOutcome = await aiEditShop(slug, trimmed);
      clearTimeout(flip);
      if (out.status === 'ok') {
        setPreviewHtml(out.html);
        setEditSummary(out.summary || '');
        setPhase('preview');
        return;
      }
      if (out.status === 'contract') {
        setViolations(out.violations);
        setPhase('idle');
        return;
      }
      if (out.status === 'unavailable') {
        setGate('soon');
        setPhase('idle');
        return;
      }
      setError(out.message);
      setPhase('idle');
    },
    [slug, phase]
  );

  const onPickSuggestion = useCallback((text: string) => {
    setInstruction(text);
  }, []);

  // ----- publish the previewed HTML (existing deployApp, same slug) ---------
  const publish = useCallback(async () => {
    if (!previewHtml || phase === 'publishing') return;
    setPhase('publishing');
    setError('');
    const outcome = await deployApp({
      html: previewHtml,
      slug,
      kind: 'shop',
      // The managed shop's slug IS its store/pairing key + publish slug.
      storeSlug: slug,
    });
    if (outcome.status === 'ok') {
      setPublishedUrl(outcome.result.url || url || '');
      setPhase('published');
      // Reflect the new live version in the rail (best-effort).
      void loadState();
      return;
    }
    if (outcome.status === 'cap') {
      // Same-slug re-publish should never trip the cap; if it somehow does,
      // surface it plainly rather than silently.
      setError(
        'La limite de publication a été atteinte. Réessayez ou libérez un emplacement dans « Mes apps ».'
      );
      setPhase('preview');
      return;
    }
    if (outcome.status === 'upgrade') {
      setError('Cette action nécessite une offre supérieure.');
      setPhase('preview');
      return;
    }
    setError(outcome.message);
    setPhase('preview');
  }, [previewHtml, slug, url, phase, loadState]);

  const cancelPreview = useCallback(() => {
    setPreviewHtml('');
    setEditSummary('');
    setPublishedUrl('');
    setPhase('idle');
  }, []);

  // ----- rollback (confirm → POST /state/rollback) --------------------------
  const doRollback = useCallback(async () => {
    if (!confirmVersion || rollingBack) return;
    setRollingBack(true);
    setRailMsg('');
    const out = await rollbackShopState(slug, confirmVersion.id);
    setRollingBack(false);
    if (out.status === 'ok') {
      setConfirmVersion(null);
      setRailMsg('Version restaurée et publiée ✓');
      void loadState();
      return;
    }
    if (out.status === 'writes-blocked') {
      onWritesBlocked?.();
      setConfirmVersion(null);
      setRailMsg('');
      return;
    }
    setRailMsg(
      out.status === 'not-found'
        ? 'Cette version n’est plus disponible.'
        : out.message
    );
  }, [confirmVersion, rollingBack, slug, loadState, onWritesBlocked]);

  const busy = phase === 'generating' || phase === 'linting';

  // ----- quiet gates --------------------------------------------------------
  if (gate === 'checking') {
    return (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '28px 4px',
          color: C.muted,
        }}
      >
        <Spinner /> Chargement…
      </div>
    );
  }

  if (gate === 'no-shop') {
    return (
      <Banner tone="info">
        Publiez d’abord votre boutique, puis revenez ici pour la{' '}
        <strong>modifier avec l’IA</strong> — décrivez le changement et l’IA
        s’occupe du reste.
      </Banner>
    );
  }

  if (gate === 'soon') {
    return (
      <Banner tone="info">
        ✨ La modification par l’IA arrive <strong>bientôt</strong> sur votre
        espace. Elle vous laissera transformer votre boutique en une phrase.
      </Banner>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {stale ? (
        <Banner tone="info">
          🔄 <strong>Nouvelle version du modèle disponible</strong> — republiez
          votre boutique pour profiter des dernières améliorations.
        </Banner>
      ) : null}

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 300px)',
          gap: 16,
          alignItems: 'start',
        }}
      >
        {/* ── main column: composer / progress / preview ─────────────── */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14, minWidth: 0 }}>
          {phase === 'preview' || phase === 'publishing' || phase === 'published' ? (
            <PreviewCard
              html={previewHtml}
              summary={editSummary}
              device={device}
              onDevice={setDevice}
              maxWidth={previewMaxWidth}
              onPublish={publish}
              onCancel={cancelPreview}
              publishing={phase === 'publishing'}
              published={phase === 'published'}
              publishedUrl={publishedUrl || url || ''}
              error={error}
            />
          ) : (
            <Composer
              instruction={instruction}
              onInstruction={setInstruction}
              onSend={() => void runEdit(instruction)}
              onPick={onPickSuggestion}
              busy={busy}
              phase={phase}
              error={error}
              violations={violations}
              onRetry={() => void runEdit(lastInstruction || instruction)}
            />
          )}
        </div>

        {/* ── side rail: historique / versions ───────────────────────── */}
        <VersionRail
          available={stateAvailable}
          versions={versions}
          message={railMsg}
          onRestore={v => setConfirmVersion(v)}
        />
      </div>

      {/* ── rollback confirm dialog ──────────────────────────────────── */}
      {confirmVersion ? (
        <ConfirmDialog
          version={confirmVersion}
          busy={rollingBack}
          onCancel={() => setConfirmVersion(null)}
          onConfirm={() => void doRollback()}
        />
      ) : null}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Composer — instruction textarea + suggestion chips + Envoyer, with inline
// progress + contract-violation error.
// ---------------------------------------------------------------------------

const Composer = ({
  instruction,
  onInstruction,
  onSend,
  onPick,
  busy,
  phase,
  error,
  violations,
  onRetry,
}: {
  instruction: string;
  onInstruction: (v: string) => void;
  onSend: () => void;
  onPick: (text: string) => void;
  busy: boolean;
  phase: Phase;
  error: string;
  violations: string[];
  onRetry: () => void;
}) => {
  const canSend = instruction.trim().length > 0 && !busy;
  return (
    <div
      style={{
        background: C.panel,
        border: `1px solid ${C.border}`,
        borderRadius: 12,
        padding: 16,
        display: 'flex',
        flexDirection: 'column',
        gap: 14,
      }}
    >
      <div>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            fontSize: 16,
            fontWeight: 800,
            color: C.text,
          }}
        >
          <span aria-hidden>✨</span> Modifier avec l’IA
        </div>
        <div style={{ ...hintStyle, marginTop: 4 }}>
          Décrivez le changement en une phrase (français ou darja). L’IA réécrit
          votre boutique et vous montre un aperçu avant publication.
        </div>
      </div>

      <Field
        label="Votre instruction"
        hint="Ex. « Ajoute une bannière soldes d’été et mets l’accent en orange »."
      >
        <textarea
          value={instruction}
          onChange={e => onInstruction(e.target.value)}
          onKeyDown={e => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && canSend) {
              e.preventDefault();
              onSend();
            }
          }}
          disabled={busy}
          rows={3}
          placeholder="Ajoute une section promo Ramadan…"
          style={{
            ...inputStyle,
            minHeight: 72,
            resize: 'vertical',
            fontFamily: 'inherit',
            opacity: busy ? 0.6 : 1,
          }}
        />
      </Field>

      {/* Suggestion chips */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <span style={labelStyle}>Suggestions</span>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {SUGGESTIONS.map(s => (
            <button
              key={s.text}
              type="button"
              disabled={busy}
              onClick={() => onPick(s.text)}
              title={s.text}
              style={chipStyle(busy)}
            >
              <span>{s.text}</span>
              <span dir="rtl" style={{ color: C.muted, fontSize: 11 }}>
                {s.hint}
              </span>
            </button>
          ))}
        </div>
      </div>

      {/* Contract-violation error (422) */}
      {violations.length > 0 ? (
        <Banner tone="error">
          <div style={{ fontWeight: 700, marginBottom: 6 }}>
            L’IA a proposé une version qui casserait votre boutique. Elle n’a pas
            été appliquée.
          </div>
          <ul style={{ margin: '0 0 8px', paddingLeft: 18, lineHeight: 1.5 }}>
            {violations.map((v, i) => (
              <li key={i}>{v}</li>
            ))}
          </ul>
          <div style={{ fontSize: 12, color: C.muted, marginBottom: 8 }}>
            Reformulez votre demande (par ex. sans toucher au paiement ni au
            formulaire de commande), puis réessayez.
          </div>
          <button type="button" style={miniBtnStyle('secondary')} onClick={onRetry}>
            Réessayer
          </button>
        </Banner>
      ) : null}

      {/* Generic error */}
      {error && violations.length === 0 ? (
        <Banner tone="error">{error}</Banner>
      ) : null}

      {/* Send + progress */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <button
          type="button"
          onClick={onSend}
          disabled={!canSend}
          style={btnStyle('primary', !canSend)}
        >
          {busy ? <Spinner dark /> : <span aria-hidden>✨</span>}
          {busy ? 'Génération…' : 'Envoyer'}
        </button>
        {busy ? (
          <span style={{ fontSize: 12.5, color: C.muted }}>
            {phase === 'linting'
              ? 'Vérification du contrat…'
              : 'Génération en cours…'}
          </span>
        ) : null}
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// PreviewCard — sandboxed srcdoc iframe + device toggle + Publier / Annuler.
// ---------------------------------------------------------------------------

const PreviewCard = ({
  html,
  summary,
  device,
  onDevice,
  maxWidth,
  onPublish,
  onCancel,
  publishing,
  published,
  publishedUrl,
  error,
}: {
  html: string;
  summary: string;
  device: 'desktop' | 'mobile';
  onDevice: (d: 'desktop' | 'mobile') => void;
  maxWidth: string;
  onPublish: () => void;
  onCancel: () => void;
  publishing: boolean;
  published: boolean;
  publishedUrl: string;
  error: string;
}) => (
  <div
    style={{
      background: C.panel,
      border: `1px solid ${C.border}`,
      borderRadius: 12,
      overflow: 'hidden',
      display: 'flex',
      flexDirection: 'column',
    }}
  >
    {/* Header: title + device toggle */}
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '10px 14px',
        borderBottom: `1px solid ${C.border}`,
        background: C.panel2,
        flexWrap: 'wrap',
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 800, color: C.text }}>
          Aperçu — avant publication
        </div>
        {summary ? (
          <div
            style={{
              fontSize: 11.5,
              color: C.muted,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
            title={summary}
          >
            {summary}
          </div>
        ) : null}
      </div>
      <div
        style={{
          display: 'inline-flex',
          gap: 2,
          padding: 3,
          borderRadius: 9,
          background: C.panel,
          border: `1px solid ${C.border}`,
        }}
      >
        {DEVICES.map(d => (
          <button
            key={d.id}
            type="button"
            onClick={() => onDevice(d.id)}
            style={segBtnStyle(device === d.id)}
          >
            {d.label}
          </button>
        ))}
      </div>
    </div>

    {/* Frame */}
    <div
      style={{
        background: '#0d0d0f',
        padding: device === 'mobile' ? 16 : 0,
        display: 'flex',
        justifyContent: 'center',
      }}
    >
      <div
        style={{
          width: '100%',
          maxWidth,
          transition: 'max-width 0.2s ease',
          background: '#fff',
          ...(device === 'mobile'
            ? { borderRadius: 12, overflow: 'hidden', border: `1px solid ${C.border}` }
            : {}),
        }}
      >
        <iframe
          title="Aperçu de la boutique modifiée"
          srcDoc={html}
          sandbox={PREVIEW_SANDBOX}
          style={{
            width: '100%',
            height: 520,
            border: 'none',
            display: 'block',
            background: '#fff',
          }}
        />
      </div>
    </div>

    {/* Footer: read-only note + actions */}
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        padding: 14,
        borderTop: `1px solid ${C.border}`,
      }}
    >
      <div style={{ ...hintStyle, fontSize: 11.5 }}>
        Cet aperçu est visuel uniquement — les commandes et les données réelles
        fonctionneront une fois la boutique publiée.
      </div>

      {error ? <Banner tone="error">{error}</Banner> : null}

      {published ? (
        <Banner tone="ok">
          ✅ Boutique mise à jour et publiée.{' '}
          {publishedUrl ? (
            <a
              href={publishedUrl}
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: C.accent, fontWeight: 700 }}
            >
              Voir la boutique en ligne ↗
            </a>
          ) : null}
        </Banner>
      ) : (
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <button
            type="button"
            onClick={onPublish}
            disabled={publishing}
            style={btnStyle('primary', publishing)}
          >
            {publishing ? <Spinner dark /> : <span aria-hidden>🚀</span>}
            {publishing ? 'Publication…' : 'Publier'}
          </button>
          <button
            type="button"
            onClick={onCancel}
            disabled={publishing}
            style={btnStyle('secondary', publishing)}
          >
            Annuler
          </button>
        </div>
      )}
    </div>
  </div>
);

// ---------------------------------------------------------------------------
// VersionRail — historique of published versions (date, note, bytes) + Restaurer.
// ---------------------------------------------------------------------------

const VersionRail = ({
  available,
  versions,
  message,
  onRestore,
}: {
  available: boolean;
  versions: ShopStateVersion[];
  message: string;
  onRestore: (v: ShopStateVersion) => void;
}) => (
  <div
    style={{
      background: C.panel,
      border: `1px solid ${C.border}`,
      borderRadius: 12,
      overflow: 'hidden',
      minWidth: 0,
      position: 'sticky',
      top: 8,
    }}
  >
    <div
      style={{
        padding: '9px 14px',
        borderBottom: `1px solid ${C.border}`,
        background: C.panel2,
        fontSize: 11,
        fontWeight: 700,
        letterSpacing: '0.04em',
        textTransform: 'uppercase',
        color: C.muted,
      }}
    >
      🕑 Historique
    </div>
    <div style={{ padding: 12 }}>
      {message ? (
        <div style={{ marginBottom: 10 }}>
          <Banner tone="ok">{message}</Banner>
        </div>
      ) : null}
      {!available ? (
        <EmptyNote>
          L’historique des versions apparaîtra ici dès qu’il sera activé sur
          votre espace.
        </EmptyNote>
      ) : versions.length === 0 ? (
        <EmptyNote>
          Aucune version enregistrée pour l’instant. Chaque publication ajoutera
          un point de restauration ici.
        </EmptyNote>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {versions.map((v, i) => (
            <div
              key={v.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '9px 0',
                ...(i > 0 ? { borderTop: `1px solid ${C.border}` } : {}),
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div
                  style={{
                    fontSize: 12.5,
                    fontWeight: 600,
                    color: C.text,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                  title={v.note || undefined}
                >
                  {v.note || 'Version'}
                </div>
                <div style={{ fontSize: 11, color: C.muted, marginTop: 1 }}>
                  {frDateTime(v.at)} · {frBytes(v.bytes)}
                </div>
              </div>
              <button
                type="button"
                onClick={() => onRestore(v)}
                style={miniBtnStyle('secondary')}
              >
                Restaurer
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  </div>
);

// ---------------------------------------------------------------------------
// ConfirmDialog — modal overlay confirming a rollback (re-publishes that HTML).
// ---------------------------------------------------------------------------

const ConfirmDialog = ({
  version,
  busy,
  onCancel,
  onConfirm,
}: {
  version: ShopStateVersion;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) => (
  <div
    role="dialog"
    aria-modal="true"
    style={{
      position: 'fixed',
      inset: 0,
      zIndex: 1000,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: 'rgba(8,9,11,0.6)',
      padding: 16,
    }}
    onClick={() => {
      if (!busy) onCancel();
    }}
  >
    <div
      onClick={e => e.stopPropagation()}
      style={{
        width: 'min(420px, 100%)',
        background: C.panel,
        border: `1px solid ${C.border}`,
        borderRadius: 14,
        overflow: 'hidden',
        boxShadow: '0 24px 80px rgba(0,0,0,0.5)',
      }}
    >
      <div
        style={{
          padding: '12px 16px',
          borderBottom: `1px solid ${C.border}`,
          background: C.panel2,
          fontSize: 13,
          fontWeight: 800,
          color: C.text,
        }}
      >
        Restaurer cette version ?
      </div>
      <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ fontSize: 12.5, color: C.muted, lineHeight: 1.5 }}>
          La version «{' '}
          <strong style={{ color: C.text }}>{version.note || 'Version'}</strong>{' '}
          » ({frDateTime(version.at)}) sera republiée sur votre boutique en
          ligne. La version actuelle reste dans l’historique.
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            style={btnStyle('secondary', busy)}
          >
            Annuler
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            style={btnStyle('primary', busy)}
          >
            {busy ? <Spinner dark /> : null}
            {busy ? 'Restauration…' : 'Restaurer'}
          </button>
        </div>
      </div>
    </div>
  </div>
);

// ---------------------------------------------------------------------------
// Inline style helpers (local to this panel).
// ---------------------------------------------------------------------------

function chipStyle(disabled: boolean): CSSProperties {
  return {
    appearance: 'none',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
    gap: 2,
    textAlign: 'left',
    padding: '7px 11px',
    borderRadius: 9,
    border: `1px solid ${C.border}`,
    background: C.panel2,
    color: C.text,
    fontSize: 12,
    fontWeight: 600,
    cursor: disabled ? 'default' : 'pointer',
    opacity: disabled ? 0.5 : 1,
    maxWidth: 260,
  };
}

function segBtnStyle(active: boolean): CSSProperties {
  return {
    appearance: 'none',
    border: 0,
    borderRadius: 6,
    padding: '5px 12px',
    cursor: 'pointer',
    fontSize: 12,
    fontWeight: 700,
    color: active ? C.text : C.muted,
    background: active ? C.panel2 : 'transparent',
  };
}
