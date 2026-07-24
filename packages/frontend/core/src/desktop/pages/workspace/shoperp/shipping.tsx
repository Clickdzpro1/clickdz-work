import { type CSSProperties, useCallback, useEffect, useMemo, useState } from 'react';

import {
  assignCourier,
  Banner,
  btnStyle,
  C,
  connectCourier,
  COURIER_STATUS_COLORS,
  COURIER_STATUS_LABELS,
  type CourierStatus,
  type CourierWilaya,
  courierFees,
  courierRefresh,
  courierShip,
  courierSync,
  disconnectCourier,
  EmptyNote,
  type ErpOrder,
  type ErpSettings,
  fetchCouriers,
  fetchCourierReference,
  fetchCourierStatus,
  fetchErpCollection,
  fetchShippingRates,
  fetchWilayas,
  Field,
  fmtDZD,
  hintStyle,
  importRatesCsv,
  inputStyle,
  labelStyle,
  miniBtnStyle,
  num,
  orderDate,
  orderTotal,
  Panel,
  parseCourierWilayas,
  postErpSettings,
  postShippingRates,
  postTracking,
  saveCourier,
  type ShipCourier,
  type ShipDeliveryMode,
  type ShipMatrixRow,
  type ShipRateInput,
  type ShipTrackingStatus,
  type ShipWilaya,
  Spinner,
  StatusBadge,
  STATUS_COLORS,
  tdStyle,
  thStyle,
  updateCourier,
} from './shoperp-shared';

// ---------------------------------------------------------------------------
// LIVRAISON studio page (WSE-7, R3-c). The owner's shipping cockpit for one
// store, over the R2 shipping bridge routes (all owner-only, authed). Four
// sub-tabs:
//   • Transporteurs — R17. Connect the merchant's OWN Yalidine account (BYO API
//                  keys, sealed server-side), then ship orders + track parcels
//                  from here over the owner-authed /courier/:provider routes.
//                  Ships DARK: a 404 on the GET-status probe = feature flag off
//                  → a calm "bientôt disponible", never an error.
//   • Livreurs   — courier list / create / edit (name, phone, codFee, active)
//                  + a wa.me tap link (open WhatsApp to the courier).
//   • Tarifs     — per-courier 58-wilaya rate matrix editor (fee/homeFee/
//                  deskFee), CSV paste import, "remplir tout" quick-fill,
//                  and a copy-to-clipboard matrix export.
//   • Expéditions — recent orders with a courier-assignment select + a tracking
//                  stepper (pris-en-charge → en-route → livre / retour);
//                  advancing to livre/retour also moves the order's main status
//                  (STATUS_COLORS chips reflect it).
// Plus an "Afficher dans l'app" toggle that adds/removes the `livraison` module
// id in the settings `erpBackends` CSV (published-app tab activation, per the
// R3 contract). Inline styles only (mirror shop-appearance.tsx: Panel/Field/
// Banner/Spinner/btnStyle/inputStyle/C from shoperp-shared); mobile single-
// column; FR labels + short darja hints; loading/error/empty states; and full
// read-only safety — when the server reports admin_writes_unavailable every
// read stays usable and writes disable with a clear notice.
// ---------------------------------------------------------------------------

type Tab = 'transporteurs' | 'couriers' | 'rates' | 'shipments';

const TABS: Array<{ id: Tab; label: string; icon: string }> = [
  { id: 'transporteurs', label: 'Transporteurs', icon: '🔗' },
  { id: 'couriers', label: 'Livreurs', icon: '🚚' },
  { id: 'rates', label: 'Tarifs par wilaya', icon: '🗺️' },
  { id: 'shipments', label: 'Expéditions', icon: '📦' },
];

export const ShippingPanel = ({
  slug,
  settings,
  readOnly,
  onWritesBlocked,
  onMutated,
}: {
  /** The store's slug — its data-API namespace + owner-route target. */
  slug: string;
  /** The live settings singleton (from the ERP summary) — for erpBackends. */
  settings?: ErpSettings;
  readOnly: boolean;
  onWritesBlocked: () => void;
  onMutated?: () => void;
}) => {
  const [tab, setTab] = useState<Tab>('couriers');

  // Couriers are loaded once here and shared by all three tabs (the rate editor
  // + the assignment select both need the courier list). A local mutation
  // re-fetches so every tab stays in sync without a full dashboard reload.
  const [couriers, setCouriers] = useState<ShipCourier[] | null>(null);
  const [couriersPhase, setCouriersPhase] = useState<'loading' | 'ready' | 'error'>(
    'loading'
  );
  const [couriersErr, setCouriersErr] = useState('');

  const loadCouriers = useCallback(async () => {
    setCouriersPhase(couriers === null ? 'loading' : 'ready');
    const out = await fetchCouriers(slug);
    if (out.status === 'ok') {
      setCouriers(out.couriers);
      setCouriersPhase('ready');
    } else {
      setCouriersErr(out.message);
      if (couriers === null) setCouriersPhase('error');
    }
  }, [slug, couriers]);

  useEffect(() => {
    void loadCouriers();
    // Load once on mount; explicit refreshes go through the returned callback.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug]);

  const reloadCouriers = useCallback(() => {
    void loadCouriers();
  }, [loadCouriers]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <AppVisibilityToggle
        slug={slug}
        settings={settings}
        readOnly={readOnly}
        onWritesBlocked={onWritesBlocked}
        onMutated={onMutated}
      />

      {/* Sub-tabs */}
      <div
        style={{
          display: 'flex',
          gap: 4,
          flexWrap: 'wrap',
          borderBottom: `1px solid ${C.border}`,
        }}
      >
        {TABS.map(t => (
          <button
            key={t.id}
            style={subTabStyle(tab === t.id)}
            onClick={() => setTab(t.id)}
          >
            <span aria-hidden>{t.icon}</span>
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'transporteurs' ? (
        <TransporteursTab
          slug={slug}
          settings={settings}
          readOnly={readOnly}
          onWritesBlocked={onWritesBlocked}
          onMutated={onMutated}
        />
      ) : tab === 'couriers' ? (
        <CouriersTab
          slug={slug}
          couriers={couriers}
          phase={couriersPhase}
          errMsg={couriersErr}
          readOnly={readOnly}
          onWritesBlocked={onWritesBlocked}
          onReload={reloadCouriers}
        />
      ) : tab === 'rates' ? (
        <RatesTab
          slug={slug}
          couriers={couriers}
          phase={couriersPhase}
          readOnly={readOnly}
          onWritesBlocked={onWritesBlocked}
        />
      ) : (
        <ShipmentsTab
          slug={slug}
          couriers={couriers}
          readOnly={readOnly}
          onWritesBlocked={onWritesBlocked}
          onMutated={onMutated}
        />
      )}
    </div>
  );
};

export default ShippingPanel;

// ===========================================================================
// "Afficher dans l'app" toggle — adds/removes `livraison` in settings.erpBackends
// (CSV of module ids). The published template shows the Livraison tab only when
// the module is on AND erpBackends contains the id (R3 contract). Writes via the
// existing settings primitive; read-only + unavailable safe.
// ===========================================================================

const MODULE_ID = 'livraison';

function parseBackends(csv: unknown): string[] {
  return String(csv || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

const AppVisibilityToggle = ({
  slug,
  settings,
  readOnly,
  onWritesBlocked,
  onMutated,
}: {
  slug: string;
  settings?: ErpSettings;
  readOnly: boolean;
  onWritesBlocked: () => void;
  onMutated?: () => void;
}) => {
  const stored = useMemo(
    () => parseBackends((settings as Record<string, unknown> | undefined)?.erpBackends),
    [settings]
  );
  const [on, setOn] = useState<boolean>(stored.includes(MODULE_ID));
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  // Keep the local switch in sync if the parent re-loads the settings.
  useEffect(() => {
    setOn(stored.includes(MODULE_ID));
  }, [stored]);

  const toggle = useCallback(async () => {
    if (readOnly || saving) {
      if (readOnly) onWritesBlocked();
      return;
    }
    const next = !on;
    setSaving(true);
    setNotice(null);
    const set = new Set(stored);
    if (next) set.add(MODULE_ID);
    else set.delete(MODULE_ID);
    const out = await postErpSettings(slug, {
      erpBackends: [...set].join(','),
    } as Partial<ErpSettings>);
    if (out.status === 'ok') {
      setOn(next);
      setNotice(
        next
          ? 'La Livraison est visible dans l’app publiée.'
          : 'La Livraison est masquée dans l’app publiée.'
      );
      onMutated?.();
    } else if (out.status === 'unavailable') {
      onWritesBlocked();
    } else {
      setNotice(out.message);
    }
    setSaving(false);
  }, [readOnly, saving, on, stored, slug, onWritesBlocked, onMutated]);

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        flexWrap: 'wrap',
        padding: '11px 14px',
        borderRadius: 12,
        background: C.panel,
        border: `1px solid ${C.border}`,
      }}
    >
      <span aria-hidden style={{ fontSize: 18 }}>
        🚚
      </span>
      <div style={{ flex: 1, minWidth: 180 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: C.text }}>
          Afficher dans l’app publiée
        </div>
        <div style={{ fontSize: 11.5, color: C.muted }}>
          Ajoute l’onglet « Livraison » (livreurs + suivi) à l’app de vos vendeurs.
        </div>
        {notice ? (
          <div style={{ fontSize: 11.5, color: C.muted, marginTop: 4 }}>{notice}</div>
        ) : null}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        disabled={readOnly || saving}
        onClick={() => void toggle()}
        style={switchStyle(on, readOnly || saving)}
        title={readOnly ? 'Lecture seule sur ce serveur' : undefined}
      >
        {saving ? <Spinner /> : null}
        <span style={switchKnobStyle(on)} aria-hidden />
        <span style={{ fontSize: 12, fontWeight: 700 }}>{on ? 'Activé' : 'Masqué'}</span>
      </button>
    </div>
  );
};

// ===========================================================================
// TRANSPORTEURS tab (R17) — connect a merchant's OWN Yalidine account, then
// ship orders + track parcels straight from the studio. The whole tab is gated
// on a GET-status probe: when CDZ_COURIERS_ENABLED is OFF the backend returns a
// typed 404, which the client surfaces as 'dark' → we render a subtle "bientôt
// disponible" note and STOP (no error spam). When ON:
//   • ConnectCard   — API ID + API Token → connect (validated live server-side);
//                     shows connected state + disconnect. Inline FR errors only.
//   • Pickup wilaya — the merchant's parcel origin (from the reference wilayas
//                     list), remembered per-shop in localStorage (the backend
//                     ship route takes fromWilaya per call; no cred field for it).
//   • FeesPreview   — from/to wilaya → a live delivery-fee quote.
//   • CourierOrders — shippable orders (Confirmée/Expédiée, no tracking yet) get
//                     an "Expédier" button → tracking no. + label link; shipped
//                     orders show a live status chip + "Rafraîchir le suivi", and
//                     a batch "Synchroniser" polls them all (button-driven only).
// Mirrors the R16 connections-card state machine (connect / status / disconnect,
// inline errors not toasts) + the R15 studio patterns (Panel/Field/Banner/…).
// ===========================================================================

const COURIER_PROVIDER_LABEL = 'Yalidine';

/** Per-shop pickup-wilaya memory (the backend ship route wants it per call; the
 *  sealed cred record deliberately does NOT store it). localStorage keeps the
 *  merchant from re-picking it on every visit — a pure client convenience. */
function pickupStorageKey(slug: string): string {
  return `cdz.courier.pickupWilaya.${slug}`;
}
function readPickupWilaya(slug: string): number | null {
  try {
    const v = window.localStorage.getItem(pickupStorageKey(slug));
    const n = v ? Number(v) : NaN;
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}
function writePickupWilaya(slug: string, wilaya: number): void {
  try {
    window.localStorage.setItem(pickupStorageKey(slug), String(wilaya));
  } catch {
    // best-effort — a blocked localStorage just means re-picking next visit.
  }
}

type ConnPhase = 'loading' | 'dark' | 'connected' | 'disconnected' | 'error';

const TransporteursTab = ({
  slug,
  settings,
  readOnly,
  onWritesBlocked,
  onMutated,
}: {
  slug: string;
  settings?: ErpSettings;
  readOnly: boolean;
  onWritesBlocked: () => void;
  onMutated?: () => void;
}) => {
  const [phase, setPhase] = useState<ConnPhase>('loading');
  const [enabled, setEnabled] = useState(false);
  const [statusErr, setStatusErr] = useState('');

  // The merchant's pickup wilaya (parcel origin). Seeded from localStorage; the
  // wilaya reference list (below) resolves its name for display.
  const [pickupWilaya, setPickupWilaya] = useState<number | null>(() =>
    readPickupWilaya(slug)
  );

  // Reference wilayas (loaded once a connection exists) — drives the pickup +
  // fees pickers. Loaded lazily so a disconnected shop makes no courier calls.
  const [wilayas, setWilayas] = useState<CourierWilaya[]>([]);
  const [wilayasPhase, setWilayasPhase] = useState<'idle' | 'loading' | 'ready' | 'error'>(
    'idle'
  );

  const probe = useCallback(async () => {
    setPhase('loading');
    setStatusErr('');
    const out = await fetchCourierStatus(slug);
    if (out.status === 'dark') {
      setPhase('dark');
      return;
    }
    if (out.status === 'error') {
      setStatusErr(out.message);
      setPhase('error');
      return;
    }
    setEnabled(out.enabled);
    setPhase(out.connected ? 'connected' : 'disconnected');
  }, [slug]);

  useEffect(() => {
    void probe();
  }, [probe]);

  const loadWilayas = useCallback(async () => {
    setWilayasPhase('loading');
    const out = await fetchCourierReference(slug, 'wilayas');
    if (out.status === 'ok') {
      const list = parseCourierWilayas(out.items);
      setWilayas(list);
      setWilayasPhase('ready');
      // Seed a default pickup wilaya (Alger=16 if present, else the first) so a
      // fresh connection is immediately shippable without a manual pick.
      setPickupWilaya(cur => {
        if (cur && list.some(w => w.id === cur)) return cur;
        const fallback = list.find(w => w.id === 16) || list[0];
        return fallback ? fallback.id : cur;
      });
    } else if (out.status === 'dark') {
      setPhase('dark');
    } else {
      setWilayasPhase('error');
    }
  }, [slug]);

  // Load the wilaya reference once we know a connection exists (skip otherwise).
  useEffect(() => {
    if (phase === 'connected' && wilayasPhase === 'idle') {
      void loadWilayas();
    }
  }, [phase, wilayasPhase, loadWilayas]);

  const onPickupChange = useCallback(
    (w: number) => {
      setPickupWilaya(w);
      writePickupWilaya(slug, w);
    },
    [slug]
  );

  const onConnected = useCallback(
    (isEnabled: boolean) => {
      setEnabled(isEnabled);
      setPhase('connected');
      setWilayasPhase('idle'); // trigger a fresh reference load
      onMutated?.();
    },
    [onMutated]
  );

  const onDisconnected = useCallback(() => {
    setPhase('disconnected');
    setWilayas([]);
    setWilayasPhase('idle');
    onMutated?.();
  }, [onMutated]);

  if (phase === 'loading') {
    return <LoadingRow label="Vérification du transporteur…" />;
  }

  // Feature dark (flag off on this server) — a calm "bientôt", never an error.
  if (phase === 'dark') {
    return (
      <Panel title="Transporteurs">
        <EmptyNote>
          <span aria-hidden style={{ fontSize: 22, display: 'block', marginBottom: 6 }}>
            🔗
          </span>
          Intégration transporteur bientôt disponible. Connectez bientôt votre
          compte Yalidine pour expédier vos commandes et suivre les colis
          automatiquement — sans quitter votre tableau de bord.
        </EmptyNote>
      </Panel>
    );
  }

  if (phase === 'error') {
    return (
      <Banner tone="error">
        {statusErr}{' '}
        <button style={linkRetryStyle} onClick={() => void probe()}>
          Réessayer
        </button>
      </Banner>
    );
  }

  const connected = phase === 'connected';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <ConnectCard
        slug={slug}
        connected={connected}
        enabled={enabled}
        readOnly={readOnly}
        onWritesBlocked={onWritesBlocked}
        onConnected={onConnected}
        onDisconnected={onDisconnected}
      />

      {connected ? (
        <>
          <PickupWilayaCard
            wilayas={wilayas}
            wilayasPhase={wilayasPhase}
            pickupWilaya={pickupWilaya}
            onPickupChange={onPickupChange}
            onRetryWilayas={() => void loadWilayas()}
          />
          <FeesPreview slug={slug} wilayas={wilayas} pickupWilaya={pickupWilaya} />
          <CourierOrders
            slug={slug}
            settings={settings}
            pickupWilaya={pickupWilaya}
            readOnly={readOnly}
            onWritesBlocked={onWritesBlocked}
            onMutated={onMutated}
          />
        </>
      ) : null}
    </div>
  );
};

// ---- Connect / status / disconnect card (R16 connections-card state machine) --

const ConnectCard = ({
  slug,
  connected,
  enabled,
  readOnly,
  onWritesBlocked,
  onConnected,
  onDisconnected,
}: {
  slug: string;
  connected: boolean;
  enabled: boolean;
  readOnly: boolean;
  onWritesBlocked: () => void;
  onConnected: (enabled: boolean) => void;
  onDisconnected: () => void;
}) => {
  const [apiId, setApiId] = useState('');
  const [apiToken, setApiToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [confirmDisc, setConfirmDisc] = useState(false);

  const disabled = readOnly || busy;

  const submit = useCallback(async () => {
    if (disabled) {
      if (readOnly) onWritesBlocked();
      return;
    }
    const id = apiId.trim();
    const token = apiToken.trim();
    if (!id || !token) {
      setErr('Saisissez votre API ID et votre API Token Yalidine.');
      return;
    }
    setErr(null);
    setBusy(true);
    const out = await connectCourier(slug, id, token);
    if (out.status === 'ok') {
      setApiId('');
      setApiToken('');
      onConnected(out.enabled);
    } else if (out.status === 'dark') {
      // Flag flipped off between the probe and now — bubble up as a soft error.
      setErr('Intégration transporteur indisponible sur ce serveur.');
    } else {
      setErr(out.message);
    }
    setBusy(false);
  }, [disabled, readOnly, apiId, apiToken, slug, onConnected, onWritesBlocked]);

  const doDisconnect = useCallback(async () => {
    if (disabled) {
      if (readOnly) onWritesBlocked();
      return;
    }
    setErr(null);
    setBusy(true);
    const out = await disconnectCourier(slug);
    if (out.status === 'ok') {
      setConfirmDisc(false);
      onDisconnected();
    } else if (out.status === 'dark') {
      setErr('Intégration transporteur indisponible sur ce serveur.');
    } else {
      setErr(out.message);
    }
    setBusy(false);
  }, [disabled, readOnly, slug, onDisconnected, onWritesBlocked]);

  if (connected) {
    return (
      <Panel title={`${COURIER_PROVIDER_LABEL} · connecté`}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              flexWrap: 'wrap',
            }}
          >
            <ConnectedBadge />
            <span style={{ fontSize: 12.5, color: C.muted }}>
              {enabled
                ? 'Votre compte Yalidine est actif — vous pouvez expédier vos commandes.'
                : 'Compte connecté mais désactivé.'}
            </span>
            <span style={{ flex: 1 }} />
            <button
              style={miniBtnStyle('danger', disabled)}
              disabled={disabled}
              onClick={() => {
                if (readOnly) return onWritesBlocked();
                setConfirmDisc(v => !v);
              }}
            >
              Déconnecter
            </button>
          </div>
          {confirmDisc ? (
            <Banner tone="warn">
              Déconnecter Yalidine ? Vos clés seront supprimées ; les commandes
              déjà expédiées gardent leur suivi.
              <div style={{ display: 'flex', gap: 10, marginTop: 10, flexWrap: 'wrap' }}>
                <button
                  style={btnStyle('danger', disabled)}
                  disabled={disabled}
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
    <Panel title={`Connecter ${COURIER_PROVIDER_LABEL}`}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={hintStyle}>
          Collez vos identifiants API depuis votre espace Yalidine (Développeurs →
          API). Vos clés sont chiffrées et ne sont jamais réaffichées. Rana
          nخزنوهم مشفّرين — matbanwelkch.
        </div>
        <div style={twoColStyle}>
          <Field label="API ID" hint="Identifiant API Yalidine (X-API-ID).">
            <input
              style={inputStyle}
              value={apiId}
              maxLength={64}
              disabled={disabled}
              autoComplete="off"
              spellCheck={false}
              placeholder="Ex. 12345678"
              onChange={e => setApiId(e.target.value)}
            />
          </Field>
          <Field label="API Token" hint="Jeton API Yalidine (X-API-TOKEN).">
            <input
              style={inputStyle}
              type="password"
              value={apiToken}
              maxLength={512}
              disabled={disabled}
              autoComplete="off"
              spellCheck={false}
              placeholder="Collez le token"
              onChange={e => setApiToken(e.target.value)}
            />
          </Field>
        </div>
        {err ? <Banner tone="error">{err}</Banner> : null}
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <button
            style={btnStyle('primary', disabled || !apiId.trim() || !apiToken.trim())}
            disabled={disabled || !apiId.trim() || !apiToken.trim()}
            onClick={() => void submit()}
          >
            {busy ? (
              <>
                <Spinner dark /> Connexion…
              </>
            ) : (
              'Connecter Yalidine'
            )}
          </button>
        </div>
      </div>
    </Panel>
  );
};

// ---- Pickup-wilaya picker (parcel origin, per-shop) -------------------------

const PickupWilayaCard = ({
  wilayas,
  wilayasPhase,
  pickupWilaya,
  onPickupChange,
  onRetryWilayas,
}: {
  wilayas: CourierWilaya[];
  wilayasPhase: 'idle' | 'loading' | 'ready' | 'error';
  pickupWilaya: number | null;
  onPickupChange: (w: number) => void;
  onRetryWilayas: () => void;
}) => {
  return (
    <Panel title="Wilaya de départ">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={hintStyle}>
          D’où partent vos colis ? Cette wilaya sert d’origine pour l’expédition et
          le calcul des frais. Men win yطلعو الكوليات.
        </div>
        {wilayasPhase === 'loading' ? (
          <LoadingRow label="Chargement des wilayas…" />
        ) : wilayasPhase === 'error' ? (
          <Banner tone="error">
            Impossible de charger les wilayas.{' '}
            <button style={linkRetryStyle} onClick={onRetryWilayas}>
              Réessayer
            </button>
          </Banner>
        ) : (
          <div style={{ maxWidth: 320 }}>
            <select
              style={{ ...inputStyle, cursor: 'pointer' }}
              value={pickupWilaya ? String(pickupWilaya) : ''}
              onChange={e => onPickupChange(Number(e.target.value))}
            >
              <option value="" disabled>
                Choisir une wilaya…
              </option>
              {wilayas.map(w => (
                <option key={w.id} value={w.id}>
                  {String(w.id).padStart(2, '0')} — {w.name}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>
    </Panel>
  );
};

// ---- Fees preview (from/to wilaya → live quote) -----------------------------

const FeesPreview = ({
  slug,
  wilayas,
  pickupWilaya,
}: {
  slug: string;
  wilayas: CourierWilaya[];
  pickupWilaya: number | null;
}) => {
  const [toWilaya, setToWilaya] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const run = useCallback(async () => {
    if (busy) return;
    if (!pickupWilaya) {
      setErr('Choisissez d’abord votre wilaya de départ.');
      return;
    }
    if (!toWilaya) {
      setErr('Choisissez la wilaya de destination.');
      return;
    }
    setErr(null);
    setResult(null);
    setBusy(true);
    const out = await courierFees(slug, pickupWilaya, toWilaya);
    if (out.status === 'ok') {
      setResult(summarizeFees(out.fees));
    } else if (out.status === 'dark') {
      setErr('Intégration transporteur indisponible sur ce serveur.');
    } else {
      setErr(out.message);
    }
    setBusy(false);
  }, [busy, pickupWilaya, toWilaya, slug]);

  return (
    <Panel title="Estimer les frais">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={hintStyle}>
          Un aperçu rapide du tarif de livraison Yalidine entre deux wilayas.
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div style={{ minWidth: 200, flex: '1 1 200px' }}>
            <span style={labelStyle}>Vers la wilaya</span>
            <select
              style={{ ...inputStyle, marginTop: 6, cursor: 'pointer' }}
              value={toWilaya ? String(toWilaya) : ''}
              onChange={e => setToWilaya(Number(e.target.value))}
            >
              <option value="" disabled>
                Destination…
              </option>
              {wilayas.map(w => (
                <option key={w.id} value={w.id}>
                  {String(w.id).padStart(2, '0')} — {w.name}
                </option>
              ))}
            </select>
          </div>
          <button
            style={btnStyle('secondary', busy || !toWilaya || !pickupWilaya)}
            disabled={busy || !toWilaya || !pickupWilaya}
            onClick={() => void run()}
          >
            {busy ? (
              <>
                <Spinner /> Calcul…
              </>
            ) : (
              'Calculer'
            )}
          </button>
        </div>
        {err ? <Banner tone="error">{err}</Banner> : null}
        {result ? <Banner tone="info">{result}</Banner> : null}
      </div>
    </Panel>
  );
};

/**
 * Fold Yalidine's fees payload into one readable FR line. The shape is a
 * per-commune matrix ({ delivery_fee, cod, … } or nested {home,desk}); we probe
 * the common numeric fields defensively and show a from…to range in DZD, or a
 * plain "reçu" when the shape is unfamiliar (never throws).
 */
function summarizeFees(fees: unknown): string {
  const nums: number[] = [];
  const walk = (v: unknown, depth: number) => {
    if (depth > 4 || v == null) return;
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) {
      nums.push(v);
      return;
    }
    if (Array.isArray(v)) {
      for (const it of v) walk(it, depth + 1);
      return;
    }
    if (typeof v === 'object') {
      for (const key of Object.keys(v as Record<string, unknown>)) {
        // Only follow fee-ish fields to avoid folding weights/ids into the range.
        if (/fee|price|tarif|cost|livraison|delivery|home|desk/i.test(key)) {
          walk((v as Record<string, unknown>)[key], depth + 1);
        }
      }
    }
  };
  walk(fees, 0);
  if (nums.length === 0) {
    return 'Tarif reçu de Yalidine — variable selon la commune.';
  }
  const min = Math.min(...nums);
  const max = Math.max(...nums);
  return min === max
    ? `Frais de livraison : ${fmtDZD(min)}.`
    : `Frais de livraison : ${fmtDZD(min)} à ${fmtDZD(max)} selon la commune.`;
}

// ---- Courier orders: ship shippable orders + track shipped ones -------------

const CourierOrders = ({
  slug,
  settings,
  pickupWilaya,
  readOnly,
  onWritesBlocked,
  onMutated,
}: {
  slug: string;
  settings?: ErpSettings;
  pickupWilaya: number | null;
  readOnly: boolean;
  onWritesBlocked: () => void;
  onMutated?: () => void;
}) => {
  const [orders, setOrders] = useState<ErpOrder[] | null>(null);
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading');
  const [errMsg, setErrMsg] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [rowNotice, setRowNotice] = useState<{ id: string; text: string; bad?: boolean } | null>(
    null
  );
  const [banner, setBanner] = useState<{ tone: 'ok' | 'info' | 'error'; text: string } | null>(
    null
  );

  // `settings` is accepted for future default-wilaya wiring; touch it so the
  // prop isn't flagged unused while it stays reserved.
  void settings;

  const load = useCallback(async () => {
    setPhase(orders === null ? 'loading' : 'ready');
    try {
      const all = await fetchErpCollection<ErpOrder>(slug, 'orders');
      // Dedupe on the business ref (order-status replace = delete+recreate),
      // keeping the newest copy so a freshly-shipped order shows its tracking.
      const byRef = new Map<string, ErpOrder>();
      for (const o of all) {
        const key = String(o?.ref || o?.id || '');
        if (!key) continue;
        const prev = byRef.get(key);
        if (!prev || String(o.createdAt || '') > String(prev.createdAt || '')) {
          byRef.set(key, o);
        }
      }
      setOrders([...byRef.values()].slice(0, 60));
      setPhase('ready');
    } catch (e) {
      setErrMsg(e instanceof Error ? e.message : 'Chargement des commandes impossible.');
      if (orders === null) setPhase('error');
    }
  }, [slug, orders]);

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug]);

  const { toShip, shipped } = useMemo(() => splitOrders(orders ?? []), [orders]);

  const onShip = useCallback(
    async (order: ErpOrder) => {
      const oid = String(order.id || order.ref || '');
      if (!oid) return;
      if (readOnly) return onWritesBlocked();
      if (!pickupWilaya) {
        setRowNotice({ id: oid, text: 'Choisissez votre wilaya de départ d’abord.', bad: true });
        return;
      }
      setBusyId(oid);
      setRowNotice(null);
      setBanner(null);
      const isStopdesk =
        String((order as Record<string, unknown>).deliveryMode || '').toLowerCase() === 'desk';
      const out = await courierShip(slug, oid, pickupWilaya, { isStopdesk });
      if (out.status === 'ok') {
        if (out.persisted === false) {
          setRowNotice({
            id: oid,
            text: `Colis créé (suivi ${out.tracking}) mais non enregistré — réessayez « Expédier » pour finaliser.`,
            bad: true,
          });
        } else {
          setRowNotice({
            id: oid,
            text: out.alreadyShipped
              ? `Déjà expédié — suivi ${out.tracking}.`
              : `Expédié ! Suivi ${out.tracking}.`,
          });
        }
        await load();
        onMutated?.();
      } else if (out.status === 'dark') {
        setBanner({ tone: 'error', text: 'Intégration transporteur indisponible sur ce serveur.' });
      } else {
        setRowNotice({ id: oid, text: out.message, bad: true });
      }
      setBusyId(null);
    },
    [readOnly, pickupWilaya, slug, load, onMutated, onWritesBlocked]
  );

  const onRefreshOne = useCallback(
    async (order: ErpOrder) => {
      const oid = String(order.id || order.ref || '');
      if (!oid) return;
      setBusyId(oid);
      setRowNotice(null);
      const out = await courierRefresh(slug, oid);
      if (out.status === 'ok') {
        const label = out.courierStatus ? COURIER_STATUS_LABELS[out.courierStatus] : 'à jour';
        setRowNotice({ id: oid, text: `Suivi : ${label}.` });
        await load();
        onMutated?.();
      } else if (out.status === 'dark') {
        setBanner({ tone: 'error', text: 'Intégration transporteur indisponible sur ce serveur.' });
      } else {
        setRowNotice({ id: oid, text: out.message, bad: true });
      }
      setBusyId(null);
    },
    [slug, load, onMutated]
  );

  const onSyncAll = useCallback(async () => {
    if (syncing) return;
    setSyncing(true);
    setBanner(null);
    setRowNotice(null);
    const out = await courierSync(slug);
    if (out.status === 'ok') {
      setBanner({
        tone: out.updated > 0 ? 'ok' : 'info',
        text:
          out.scanned === 0
            ? 'Aucun colis en cours à synchroniser.'
            : `${out.scanned} colis vérifié(s) · ${out.updated} mis à jour${
                out.delivered ? ` · ${out.delivered} livré(s)` : ''
              }${out.capped ? ` (sur ${out.total}, relancez pour la suite)` : ''}.`,
      });
      await load();
      onMutated?.();
    } else if (out.status === 'dark') {
      setBanner({ tone: 'error', text: 'Intégration transporteur indisponible sur ce serveur.' });
    } else {
      setBanner({ tone: 'error', text: out.message });
    }
    setSyncing(false);
  }, [syncing, slug, load, onMutated]);

  if (phase === 'loading' && orders === null) {
    return <LoadingRow label="Chargement des commandes…" />;
  }
  if (phase === 'error' && orders === null) {
    return (
      <Banner tone="error">
        {errMsg}{' '}
        <button style={linkRetryStyle} onClick={() => void load()}>
          Réessayer
        </button>
      </Banner>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {banner ? <Banner tone={banner.tone}>{banner.text}</Banner> : null}

      {/* Shippable orders */}
      <Panel
        title={`À expédier${toShip.length ? ` · ${toShip.length}` : ''}`}
        action={
          <button style={miniBtnStyle('secondary')} onClick={() => void load()}>
            ↻ Actualiser
          </button>
        }
      >
        {toShip.length === 0 ? (
          <EmptyNote>
            Aucune commande prête à expédier. Confirmez une commande (onglet
            Commandes) pour l’envoyer via Yalidine.
          </EmptyNote>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {toShip.map(o => {
              const oid = String(o.id || o.ref || '');
              const busy = busyId === oid;
              return (
                <div key={oid || Math.random()} style={shipmentCardStyle}>
                  <OrderHead order={o} />
                  <div
                    style={{
                      display: 'flex',
                      gap: 8,
                      alignItems: 'center',
                      flexWrap: 'wrap',
                    }}
                  >
                    <button
                      style={miniBtnStyle('primary', busy || readOnly || !pickupWilaya)}
                      disabled={busy || readOnly || !pickupWilaya}
                      onClick={() => void onShip(o)}
                      title={
                        !pickupWilaya
                          ? 'Choisissez votre wilaya de départ'
                          : 'Créer le colis Yalidine'
                      }
                    >
                      {busy ? (
                        <>
                          <Spinner dark /> Expédition…
                        </>
                      ) : (
                        '📦 Expédier'
                      )}
                    </button>
                    {!pickupWilaya ? (
                      <span style={{ fontSize: 11.5, color: C.muted }}>
                        wilaya de départ requise
                      </span>
                    ) : null}
                  </div>
                  {rowNotice && rowNotice.id === oid ? (
                    <RowNote text={rowNotice.text} bad={rowNotice.bad} />
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
      </Panel>

      {/* Shipped / tracking */}
      <Panel
        title={`Colis en cours${shipped.length ? ` · ${shipped.length}` : ''}`}
        action={
          <button
            style={miniBtnStyle('secondary', syncing)}
            disabled={syncing}
            onClick={() => void onSyncAll()}
            title="Interroger Yalidine pour tous les colis en cours"
          >
            {syncing ? (
              <>
                <Spinner /> Synchro…
              </>
            ) : (
              '⟳ Synchroniser'
            )}
          </button>
        }
      >
        {shipped.length === 0 ? (
          <EmptyNote>Aucun colis expédié pour le moment.</EmptyNote>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {shipped.map(o => {
              const oid = String(o.id || o.ref || '');
              const busy = busyId === oid;
              const rec = o as Record<string, unknown>;
              const tracking = String(rec.trackingNumber || '');
              const labelUrl = String(rec.labelUrl || '');
              const csRaw = String(rec.courierStatus || 'pending');
              const cs = (['pending', 'shipped', 'delivered', 'returned'].includes(csRaw)
                ? csRaw
                : 'pending') as CourierStatus;
              return (
                <div key={oid || Math.random()} style={shipmentCardStyle}>
                  <OrderHead order={o} />
                  <div
                    style={{
                      display: 'flex',
                      gap: 8,
                      alignItems: 'center',
                      flexWrap: 'wrap',
                    }}
                  >
                    <CourierStatusChip status={cs} />
                    <span
                      style={{
                        fontFamily: 'var(--affine-font-code-family, monospace)',
                        fontSize: 12,
                        color: C.text,
                      }}
                      title="Numéro de suivi"
                    >
                      {tracking || '—'}
                    </span>
                    {labelUrl ? (
                      <a
                        href={labelUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{
                          color: C.accent,
                          textDecoration: 'none',
                          fontWeight: 700,
                          fontSize: 12,
                        }}
                        title="Télécharger l’étiquette (PDF)"
                      >
                        🏷️ Télécharger l’étiquette
                      </a>
                    ) : null}
                    <span style={{ flex: 1 }} />
                    <button
                      style={miniBtnStyle('secondary', busy)}
                      disabled={busy}
                      onClick={() => void onRefreshOne(o)}
                      title="Interroger Yalidine pour ce colis"
                    >
                      {busy ? (
                        <>
                          <Spinner /> Suivi…
                        </>
                      ) : (
                        '⟳ Rafraîchir le suivi'
                      )}
                    </button>
                  </div>
                  {rowNotice && rowNotice.id === oid ? (
                    <RowNote text={rowNotice.text} bad={rowNotice.bad} />
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
      </Panel>
    </div>
  );
};

/**
 * Split the order list into shippable vs shipped. Shippable = a confirmed/paid
 * order with NO tracking number yet (Confirmée or Expédiée status, or a paid
 * flag). Shipped = anything carrying a trackingNumber (courier parcel created).
 */
function splitOrders(orders: ErpOrder[]): { toShip: ErpOrder[]; shipped: ErpOrder[] } {
  const toShip: ErpOrder[] = [];
  const shipped: ErpOrder[] = [];
  for (const o of orders) {
    const rec = o as Record<string, unknown>;
    const hasTracking = !!String(rec.trackingNumber || '').trim();
    if (hasTracking) {
      shipped.push(o);
      continue;
    }
    const status = String(o.status || '');
    const paid = rec.paid === true;
    if (status === 'Confirmée' || status === 'Expédiée' || paid) {
      toShip.push(o);
    }
  }
  return { toShip, shipped };
}

const OrderHead = ({ order: o }: { order: ErpOrder }) => (
  <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
    <span
      style={{
        fontFamily: 'var(--affine-font-code-family, monospace)',
        fontWeight: 700,
        fontSize: 12.5,
      }}
    >
      {o.ref || '—'}
    </span>
    <StatusBadge status={o.status} />
    <span style={{ fontSize: 12, color: C.muted }}>{orderDate(o) || '—'}</span>
    <span style={{ fontSize: 12.5, fontWeight: 600 }}>{o.customer || '—'}</span>
    {o.wilaya ? <span style={{ fontSize: 12, color: C.muted }}>· {o.wilaya}</span> : null}
    <span style={{ flex: 1 }} />
    <span style={{ fontSize: 12.5, fontWeight: 700, whiteSpace: 'nowrap' }}>
      {fmtDZD(orderTotal(o))}
    </span>
  </div>
);

const RowNote = ({ text, bad }: { text: string; bad?: boolean }) => (
  <div
    style={{
      fontSize: 11.5,
      color: bad ? 'var(--affine-error-color, #eb4b4b)' : C.muted,
    }}
  >
    {text}
  </div>
);

const ConnectedBadge = () => {
  const color = STATUS_COLORS['Livrée'];
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        fontSize: 11,
        fontWeight: 700,
        padding: '2px 9px',
        borderRadius: 999,
        whiteSpace: 'nowrap',
        color,
        background: `color-mix(in srgb, ${color} 15%, transparent)`,
        border: `1px solid color-mix(in srgb, ${color} 35%, transparent)`,
      }}
    >
      ● Connecté
    </span>
  );
};

const CourierStatusChip = ({ status }: { status: CourierStatus }) => {
  const color = COURIER_STATUS_COLORS[status];
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        fontSize: 11,
        fontWeight: 700,
        padding: '2px 9px',
        borderRadius: 999,
        whiteSpace: 'nowrap',
        color,
        background: `color-mix(in srgb, ${color} 15%, transparent)`,
        border: `1px solid color-mix(in srgb, ${color} 35%, transparent)`,
      }}
    >
      {COURIER_STATUS_LABELS[status]}
    </span>
  );
};

// ===========================================================================
// LIVREURS tab — list + create + edit couriers, each with a wa.me tap link.
// ===========================================================================

const CouriersTab = ({
  slug,
  couriers,
  phase,
  errMsg,
  readOnly,
  onWritesBlocked,
  onReload,
}: {
  slug: string;
  couriers: ShipCourier[] | null;
  phase: 'loading' | 'ready' | 'error';
  errMsg: string;
  readOnly: boolean;
  onWritesBlocked: () => void;
  onReload: () => void;
}) => {
  const [editing, setEditing] = useState<ShipCourier | null>(null);
  const [creating, setCreating] = useState(false);

  if (phase === 'loading' && couriers === null) {
    return <LoadingRow label="Chargement des livreurs…" />;
  }
  if (phase === 'error' && couriers === null) {
    return (
      <Banner tone="error">
        {errMsg}{' '}
        <button style={linkRetryStyle} onClick={onReload}>
          Réessayer
        </button>
      </Banner>
    );
  }

  const list = couriers ?? [];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <Panel
        title={`Livreurs${list.length ? ` · ${list.length}` : ''}`}
        action={
          <button
            style={miniBtnStyle('primary', readOnly)}
            disabled={readOnly}
            onClick={() => {
              if (readOnly) return onWritesBlocked();
              setEditing(null);
              setCreating(true);
            }}
          >
            + Ajouter
          </button>
        }
      >
        {list.length === 0 ? (
          <EmptyNote>
            Aucun livreur — ajoutez Yalidine, ZR Express, Noest… ou votre livreur
            local pour assigner les commandes.
          </EmptyNote>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
              <thead>
                <tr>
                  {['Nom', 'Téléphone', 'Frais COD', 'Statut', ''].map((h, i) => (
                    <th key={i} style={thStyle}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {list.map(c => (
                  <tr key={c.id}>
                    <td style={{ ...tdStyle, fontWeight: 700 }}>{c.name}</td>
                    <td style={{ ...tdStyle, whiteSpace: 'nowrap' }}>
                      {c.phone ? (
                        <a
                          href={waMeLink(c.phone)}
                          target="_blank"
                          rel="noopener noreferrer"
                          style={{ color: C.accent, textDecoration: 'none', fontWeight: 600 }}
                          title="Ouvrir WhatsApp"
                        >
                          💬 {c.phone}
                        </a>
                      ) : (
                        <span style={{ color: C.muted }}>—</span>
                      )}
                    </td>
                    <td style={{ ...tdStyle, whiteSpace: 'nowrap' }}>
                      {c.codFee != null ? fmtDZD(c.codFee) : '—'}
                    </td>
                    <td style={tdStyle}>
                      <ActiveBadge active={c.active} />
                    </td>
                    <td style={{ ...tdStyle, textAlign: 'right', whiteSpace: 'nowrap' }}>
                      <button
                        style={miniBtnStyle('secondary', readOnly)}
                        disabled={readOnly}
                        onClick={() => {
                          if (readOnly) return onWritesBlocked();
                          setCreating(false);
                          setEditing(c);
                        }}
                      >
                        Modifier
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      {creating || editing ? (
        <CourierForm
          key={editing ? editing.id : 'new'}
          slug={slug}
          courier={editing}
          readOnly={readOnly}
          onWritesBlocked={onWritesBlocked}
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
          onSaved={() => {
            setCreating(false);
            setEditing(null);
            onReload();
          }}
        />
      ) : null}
    </div>
  );
};

const CourierForm = ({
  slug,
  courier,
  readOnly,
  onWritesBlocked,
  onClose,
  onSaved,
}: {
  slug: string;
  courier: ShipCourier | null;
  readOnly: boolean;
  onWritesBlocked: () => void;
  onClose: () => void;
  onSaved: () => void;
}) => {
  const isEdit = !!courier;
  const [name, setName] = useState(courier?.name ?? '');
  const [phone, setPhone] = useState(courier?.phone ?? '');
  const [codFee, setCodFee] = useState(
    courier?.codFee != null ? String(courier.codFee) : ''
  );
  const [active, setActive] = useState<boolean>(courier?.active ?? true);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const disabled = readOnly || saving;

  const submit = useCallback(async () => {
    if (disabled) return;
    const trimmed = name.trim();
    if (!trimmed) {
      setErr('Le nom du livreur est requis.');
      return;
    }
    setErr(null);
    setSaving(true);
    const codNum = codFee.trim() === '' ? undefined : Math.max(0, Math.round(num(codFee)));
    const out = isEdit
      ? await updateCourier(slug, courier!.id, {
          name: trimmed,
          phone: phone.trim(),
          ...(codNum !== undefined ? { codFee: codNum } : {}),
          active,
        })
      : await saveCourier(slug, {
          name: trimmed,
          ...(phone.trim() ? { phone: phone.trim() } : {}),
          ...(codNum !== undefined ? { codFee: codNum } : {}),
          active,
        });
    if (out.status === 'ok') {
      onSaved();
    } else if (out.status === 'unavailable') {
      onWritesBlocked();
    } else {
      setErr(out.message);
    }
    setSaving(false);
  }, [disabled, name, phone, codFee, active, isEdit, slug, courier, onSaved, onWritesBlocked]);

  return (
    <Panel title={isEdit ? `Modifier · ${courier!.name}` : 'Nouveau livreur'}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={twoColStyle}>
          <Field label="Nom" hint="Ex. Yalidine, ZR Express, livreur local…">
            <input
              style={inputStyle}
              value={name}
              maxLength={60}
              disabled={disabled}
              placeholder="Nom du livreur"
              onChange={e => setName(e.target.value)}
            />
          </Field>
          <Field label="Téléphone" hint="Numéro WhatsApp (tap = ouvre le chat).">
            <input
              style={inputStyle}
              value={phone}
              maxLength={20}
              inputMode="tel"
              disabled={disabled}
              placeholder="06 xx xx xx xx"
              onChange={e => setPhone(e.target.value)}
            />
          </Field>
        </div>
        <div style={twoColStyle}>
          <Field label="Frais COD (DZD)" hint="Commission encaissement — optionnel.">
            <input
              style={inputStyle}
              value={codFee}
              inputMode="numeric"
              disabled={disabled}
              placeholder="0"
              onChange={e => setCodFee(e.target.value.replace(/[^\d]/g, ''))}
            />
          </Field>
          <Field label="Statut" hint="Un livreur inactif reste masqué à l’assignation.">
            <label
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 8,
                cursor: disabled ? 'default' : 'pointer',
                opacity: disabled ? 0.6 : 1,
                fontSize: 13,
                color: C.text,
                paddingTop: 6,
              }}
            >
              <input
                type="checkbox"
                checked={active}
                disabled={disabled}
                onChange={e => setActive(e.target.checked)}
                style={{ width: 16, height: 16, accentColor: C.accent }}
              />
              Actif
            </label>
          </Field>
        </div>
        {err ? <Banner tone="error">{err}</Banner> : null}
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <button
            style={btnStyle('primary', disabled || !name.trim())}
            disabled={disabled || !name.trim()}
            onClick={() => void submit()}
          >
            {saving ? (
              <>
                <Spinner dark /> Enregistrement…
              </>
            ) : isEdit ? (
              'Enregistrer'
            ) : (
              'Créer le livreur'
            )}
          </button>
          <button style={btnStyle('secondary', saving)} disabled={saving} onClick={onClose}>
            Annuler
          </button>
        </div>
      </div>
    </Panel>
  );
};

// ===========================================================================
// TARIFS tab — per-courier 58-wilaya matrix editor. Sticky header + compact
// inputs so the 58 rows collapse gracefully on mobile. Bulk paste CSV import,
// "remplir tout" quick-fill (one fee → all rows, client-side, then one bulk
// POST), and a copy-to-clipboard matrix export.
// ===========================================================================

interface EditRow {
  wilaya: number;
  name: string;
  fee: string;
  homeFee: string;
  deskFee: string;
}

function toEditRows(matrix: ShipMatrixRow[]): EditRow[] {
  return matrix.map(m => ({
    wilaya: m.wilaya,
    name: m.name,
    fee: m.fee == null ? '' : String(m.fee),
    homeFee: m.homeFee == null ? '' : String(m.homeFee),
    deskFee: m.deskFee == null ? '' : String(m.deskFee),
  }));
}

const RatesTab = ({
  slug,
  couriers,
  phase,
  readOnly,
  onWritesBlocked,
}: {
  slug: string;
  couriers: ShipCourier[] | null;
  phase: 'loading' | 'ready' | 'error';
  readOnly: boolean;
  onWritesBlocked: () => void;
}) => {
  const [courierId, setCourierId] = useState<string>('');
  const [rows, setRows] = useState<EditRow[] | null>(null);
  const [wilayas, setWilayas] = useState<ShipWilaya[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadErr, setLoadErr] = useState('');
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'error' | 'info'; text: string } | null>(
    null
  );
  const [quickFee, setQuickFee] = useState('');
  const [copied, setCopied] = useState(false);
  const [showCsv, setShowCsv] = useState(false);
  const [csv, setCsv] = useState('');
  const [importing, setImporting] = useState(false);

  const list = couriers ?? [];

  // Default the courier select to the first courier once the list arrives.
  useEffect(() => {
    if (!courierId && list.length > 0) setCourierId(list[0].id);
  }, [list, courierId]);

  // Fetch the wilaya reference table once (names are the fallback if the
  // matrix rows ever lack a name — the matrix already carries names).
  useEffect(() => {
    let alive = true;
    void (async () => {
      const out = await fetchWilayas(slug);
      if (alive && out.status === 'ok') setWilayas(out.wilayas);
    })();
    return () => {
      alive = false;
    };
  }, [slug]);

  const loadRates = useCallback(
    async (cid: string) => {
      if (!cid) return;
      setLoading(true);
      setLoadErr('');
      setNotice(null);
      const out = await fetchShippingRates(slug, cid);
      if (out.status === 'ok') {
        const matrix =
          out.matrix.length > 0
            ? out.matrix
            : wilayas.map(w => ({
                wilaya: w.code,
                name: w.name,
                fee: null,
                homeFee: null,
                deskFee: null,
              }));
        setRows(toEditRows(matrix));
      } else {
        setLoadErr(out.message);
        setRows(null);
      }
      setLoading(false);
    },
    [slug, wilayas]
  );

  useEffect(() => {
    if (courierId) void loadRates(courierId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [courierId]);

  const setCell = useCallback(
    (wilaya: number, field: 'fee' | 'homeFee' | 'deskFee', value: string) => {
      const v = value.replace(/[^\d]/g, '');
      setRows(cur =>
        cur ? cur.map(r => (r.wilaya === wilaya ? { ...r, [field]: v } : r)) : cur
      );
    },
    []
  );

  const fillAll = useCallback(() => {
    const v = quickFee.replace(/[^\d]/g, '');
    if (!v) return;
    setRows(cur => (cur ? cur.map(r => ({ ...r, fee: v })) : cur));
    setNotice({ tone: 'info', text: `Frais ${v} DZD appliqué à toutes les wilayas — enregistrez pour valider.` });
  }, [quickFee]);

  const buildInputs = useCallback((): ShipRateInput[] => {
    if (!rows) return [];
    const out: ShipRateInput[] = [];
    for (const r of rows) {
      const hasFee = r.fee.trim() !== '';
      const hasHome = r.homeFee.trim() !== '';
      const hasDesk = r.deskFee.trim() !== '';
      if (!hasFee && !hasHome && !hasDesk) continue; // skip empty rows
      const row: ShipRateInput = { wilaya: r.wilaya };
      if (hasFee) row.fee = num(r.fee);
      if (hasHome) row.homeFee = num(r.homeFee);
      if (hasDesk) row.deskFee = num(r.deskFee);
      out.push(row);
    }
    return out;
  }, [rows]);

  const save = useCallback(async () => {
    if (readOnly || saving || !courierId) {
      if (readOnly) onWritesBlocked();
      return;
    }
    const inputs = buildInputs();
    if (inputs.length === 0) {
      setNotice({ tone: 'error', text: 'Renseignez au moins un tarif avant d’enregistrer.' });
      return;
    }
    setSaving(true);
    setNotice(null);
    const out = await postShippingRates(slug, courierId, inputs);
    if (out.status === 'ok') {
      setNotice({
        tone: 'ok',
        text: `${out.data?.written ?? inputs.length} tarif(s) enregistré(s).`,
      });
      await loadRates(courierId);
    } else if (out.status === 'unavailable') {
      onWritesBlocked();
    } else {
      setNotice({ tone: 'error', text: out.message });
    }
    setSaving(false);
  }, [readOnly, saving, courierId, buildInputs, slug, loadRates, onWritesBlocked]);

  const doImport = useCallback(async () => {
    if (readOnly || importing || !courierId) {
      if (readOnly) onWritesBlocked();
      return;
    }
    if (!csv.trim()) {
      setNotice({ tone: 'error', text: 'Collez le CSV (wilaya,frais,domicile,bureau) d’abord.' });
      return;
    }
    setImporting(true);
    setNotice(null);
    const out = await importRatesCsv(slug, courierId, csv);
    if (out.status === 'ok') {
      const written = out.data?.written ?? 0;
      const skipped = out.data?.skipped ?? 0;
      setNotice({
        tone: 'ok',
        text: `Import réussi : ${written} ligne(s)${skipped ? `, ${skipped} ignorée(s)` : ''}.`,
      });
      setCsv('');
      setShowCsv(false);
      await loadRates(courierId);
    } else if (out.status === 'unavailable') {
      onWritesBlocked();
    } else {
      setNotice({ tone: 'error', text: out.message });
    }
    setImporting(false);
  }, [readOnly, importing, courierId, csv, slug, loadRates, onWritesBlocked]);

  const copyMatrix = useCallback(async () => {
    if (!rows) return;
    const header = 'wilaya,nom,frais,domicile,bureau';
    const lines = rows.map(
      r => `${r.wilaya},${r.name},${r.fee || ''},${r.homeFee || ''},${r.deskFee || ''}`
    );
    const text = [header, ...lines].join('\n');
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setNotice({ tone: 'error', text: 'Copie impossible — sélectionnez et copiez manuellement.' });
    }
  }, [rows]);

  if (phase === 'loading' && couriers === null) {
    return <LoadingRow label="Chargement…" />;
  }
  if (list.length === 0) {
    return (
      <Banner tone="info">
        Ajoutez d’abord un livreur dans l’onglet « Livreurs » pour définir sa grille
        tarifaire par wilaya.
      </Banner>
    );
  }

  const filledCount = rows ? rows.filter(r => r.fee || r.homeFee || r.deskFee).length : 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* Courier selector + toolbar */}
      <div
        style={{
          display: 'flex',
          gap: 10,
          alignItems: 'flex-end',
          flexWrap: 'wrap',
        }}
      >
        <div style={{ minWidth: 200, flex: '1 1 200px' }}>
          <span style={labelStyle}>Livreur</span>
          <select
            style={{ ...inputStyle, marginTop: 6, cursor: 'pointer' }}
            value={courierId}
            onChange={e => setCourierId(e.target.value)}
          >
            {list.map(c => (
              <option key={c.id} value={c.id}>
                {c.name}
                {c.active ? '' : ' (inactif)'}
              </option>
            ))}
          </select>
        </div>
        <button
          style={miniBtnStyle('secondary')}
          onClick={() => void copyMatrix()}
          disabled={!rows}
          title="Copier la matrice (CSV) dans le presse-papiers"
        >
          {copied ? '✓ Copié' : '⧉ Exporter'}
        </button>
        <button
          style={miniBtnStyle('secondary', readOnly)}
          disabled={readOnly}
          onClick={() => {
            if (readOnly) return onWritesBlocked();
            setShowCsv(s => !s);
          }}
        >
          {showCsv ? 'Fermer l’import' : '⇪ Importer CSV'}
        </button>
      </div>

      {notice ? (
        <Banner tone={notice.tone === 'ok' ? 'ok' : notice.tone === 'info' ? 'info' : 'error'}>
          {notice.text}
        </Banner>
      ) : null}

      {/* CSV paste import */}
      {showCsv ? (
        <Panel title="Importer un CSV">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={hintStyle}>
              Une ligne par wilaya : <code style={csvCodeStyle}>code,frais,domicile,bureau</code>{' '}
              (frais/domicile/bureau optionnels). Collez le tarif de votre livreur —
              l’en-tête est ignoré automatiquement.
            </div>
            <textarea
              style={{
                ...inputStyle,
                minHeight: 120,
                fontFamily: 'var(--affine-font-code-family, monospace)',
                fontSize: 12.5,
                resize: 'vertical',
              }}
              value={csv}
              disabled={readOnly || importing}
              placeholder={'16,400,400,250\n31,600,600,400\n…'}
              onChange={e => setCsv(e.target.value)}
            />
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              <button
                style={btnStyle('primary', readOnly || importing || !csv.trim())}
                disabled={readOnly || importing || !csv.trim()}
                onClick={() => void doImport()}
              >
                {importing ? (
                  <>
                    <Spinner dark /> Import…
                  </>
                ) : (
                  'Importer les tarifs'
                )}
              </button>
            </div>
          </div>
        </Panel>
      ) : null}

      {/* Quick-fill + save toolbar */}
      <div
        style={{
          display: 'flex',
          gap: 10,
          alignItems: 'flex-end',
          flexWrap: 'wrap',
        }}
      >
        <div style={{ minWidth: 150 }}>
          <span style={labelStyle}>Remplir tout (frais)</span>
          <input
            style={{ ...inputStyle, marginTop: 6 }}
            value={quickFee}
            inputMode="numeric"
            disabled={readOnly}
            placeholder="Ex. 500"
            onChange={e => setQuickFee(e.target.value.replace(/[^\d]/g, ''))}
          />
        </div>
        <button
          style={miniBtnStyle('secondary', readOnly || !quickFee.trim())}
          disabled={readOnly || !quickFee.trim()}
          onClick={fillAll}
          title="Applique ce frais à toutes les wilayas (avant enregistrement)"
        >
          Appliquer à toutes
        </button>
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: 11.5, color: C.muted, alignSelf: 'center' }}>
          {filledCount}/58 renseignées
        </span>
        <button
          style={btnStyle('primary', readOnly || saving || !rows)}
          disabled={readOnly || saving || !rows}
          onClick={() => void save()}
        >
          {saving ? (
            <>
              <Spinner dark /> Enregistrement…
            </>
          ) : (
            'Enregistrer la grille'
          )}
        </button>
      </div>

      {/* The 58-row matrix */}
      {loading ? (
        <LoadingRow label="Chargement de la grille…" />
      ) : loadErr ? (
        <Banner tone="error">
          {loadErr}{' '}
          <button style={linkRetryStyle} onClick={() => void loadRates(courierId)}>
            Réessayer
          </button>
        </Banner>
      ) : rows ? (
        <div style={matrixWrapStyle}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
            <thead>
              <tr>
                <th style={{ ...matrixThStyle, textAlign: 'left', minWidth: 128 }}>Wilaya</th>
                <th style={matrixThStyle}>Frais</th>
                <th style={matrixThStyle}>Domicile</th>
                <th style={matrixThStyle}>Bureau</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.wilaya}>
                  <td style={matrixWilayaTdStyle}>
                    <span style={{ color: C.muted, fontWeight: 700 }}>
                      {String(r.wilaya).padStart(2, '0')}
                    </span>{' '}
                    {r.name}
                  </td>
                  <td style={matrixCellTdStyle}>
                    <input
                      style={matrixInputStyle}
                      value={r.fee}
                      inputMode="numeric"
                      disabled={readOnly}
                      placeholder="—"
                      aria-label={`Frais ${r.name}`}
                      onChange={e => setCell(r.wilaya, 'fee', e.target.value)}
                    />
                  </td>
                  <td style={matrixCellTdStyle}>
                    <input
                      style={matrixInputStyle}
                      value={r.homeFee}
                      inputMode="numeric"
                      disabled={readOnly}
                      placeholder="—"
                      aria-label={`Domicile ${r.name}`}
                      onChange={e => setCell(r.wilaya, 'homeFee', e.target.value)}
                    />
                  </td>
                  <td style={matrixCellTdStyle}>
                    <input
                      style={matrixInputStyle}
                      value={r.deskFee}
                      inputMode="numeric"
                      disabled={readOnly}
                      placeholder="—"
                      aria-label={`Bureau ${r.name}`}
                      onChange={e => setCell(r.wilaya, 'deskFee', e.target.value)}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <EmptyNote>Sélectionnez un livreur pour éditer sa grille.</EmptyNote>
      )}
    </div>
  );
};

// ===========================================================================
// EXPÉDITIONS tab — recent orders with a courier-assignment select + tracking
// stepper. Reads the full orders collection (newest-first, capped) so each row
// has its data-API record id (assign/tracking target). STATUS_COLORS chips.
// ===========================================================================

const TRACKING_STEPS: Array<{ id: ShipTrackingStatus; label: string; hint: string }> = [
  { id: 'pris-en-charge', label: 'Pris en charge', hint: 'ramassé' },
  { id: 'en-route', label: 'En route', hint: 'en livraison' },
  { id: 'livre', label: 'Livré', hint: '→ Livrée' },
  { id: 'retour', label: 'Retour', hint: '→ Retournée' },
];

const ShipmentsTab = ({
  slug,
  couriers,
  readOnly,
  onWritesBlocked,
  onMutated,
}: {
  slug: string;
  couriers: ShipCourier[] | null;
  readOnly: boolean;
  onWritesBlocked: () => void;
  onMutated?: () => void;
}) => {
  const [orders, setOrders] = useState<ErpOrder[] | null>(null);
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading');
  const [errMsg, setErrMsg] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rowNotice, setRowNotice] = useState<{ id: string; text: string; bad?: boolean } | null>(
    null
  );

  const load = useCallback(async () => {
    setPhase(orders === null ? 'loading' : 'ready');
    try {
      const all = await fetchErpCollection<ErpOrder>(slug, 'orders');
      // Newest-first, capped for a manageable "recent" view.
      setOrders(all.slice(0, 40));
      setPhase('ready');
    } catch (e) {
      setErrMsg(e instanceof Error ? e.message : 'Chargement des commandes impossible.');
      if (orders === null) setPhase('error');
    }
  }, [slug, orders]);

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug]);

  const activeCouriers = (couriers ?? []).filter(c => c.active);
  const courierNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of couriers ?? []) m.set(c.id, c.name);
    return m;
  }, [couriers]);

  const onAssign = useCallback(
    async (order: ErpOrder, courierId: string, mode: ShipDeliveryMode) => {
      const oid = String(order.id || '');
      if (!oid) return;
      if (readOnly) return onWritesBlocked();
      setBusyId(oid);
      setRowNotice(null);
      const out = await assignCourier(slug, oid, courierId, mode);
      if (out.status === 'ok') {
        setRowNotice({ id: oid, text: 'Livreur assigné.' });
        await load();
        onMutated?.();
      } else if (out.status === 'unavailable') {
        onWritesBlocked();
      } else {
        setRowNotice({ id: oid, text: out.message, bad: true });
      }
      setBusyId(null);
    },
    [readOnly, slug, load, onMutated, onWritesBlocked]
  );

  const onTrack = useCallback(
    async (order: ErpOrder, status: ShipTrackingStatus) => {
      const oid = String(order.id || '');
      if (!oid) return;
      if (readOnly) return onWritesBlocked();
      setBusyId(oid);
      setRowNotice(null);
      const out = await postTracking(slug, oid, status);
      if (out.status === 'ok') {
        setRowNotice({ id: oid, text: 'Suivi mis à jour.' });
        await load();
        onMutated?.();
      } else if (out.status === 'unavailable') {
        onWritesBlocked();
      } else {
        setRowNotice({ id: oid, text: out.message, bad: true });
      }
      setBusyId(null);
    },
    [readOnly, slug, load, onMutated, onWritesBlocked]
  );

  if (phase === 'loading' && orders === null) {
    return <LoadingRow label="Chargement des commandes…" />;
  }
  if (phase === 'error' && orders === null) {
    return (
      <Banner tone="error">
        {errMsg}{' '}
        <button style={linkRetryStyle} onClick={() => void load()}>
          Réessayer
        </button>
      </Banner>
    );
  }

  const list = orders ?? [];

  return (
    <Panel
      title={`Expéditions récentes${list.length ? ` · ${list.length}` : ''}`}
      action={
        <button style={miniBtnStyle('secondary')} onClick={() => void load()}>
          ↻ Actualiser
        </button>
      }
    >
      {activeCouriers.length === 0 ? (
        <Banner tone="info">
          Ajoutez un livreur actif (onglet « Livreurs ») pour pouvoir assigner et
          suivre les expéditions.
        </Banner>
      ) : null}
      {list.length === 0 ? (
        <EmptyNote>Aucune commande — partagez votre boutique pour vendre.</EmptyNote>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {list.map(o => {
            const oid = String(o.id || o.ref || '');
            const assignedId = String((o as Record<string, unknown>).courierId || '');
            const tracking = String((o as Record<string, unknown>).tracking || '');
            const mode = ((o as Record<string, unknown>).deliveryMode as ShipDeliveryMode) || 'home';
            const busy = busyId === oid;
            return (
              <div key={oid || Math.random()} style={shipmentCardStyle}>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    flexWrap: 'wrap',
                  }}
                >
                  <span
                    style={{
                      fontFamily: 'var(--affine-font-code-family, monospace)',
                      fontWeight: 700,
                      fontSize: 12.5,
                    }}
                  >
                    {o.ref || '—'}
                  </span>
                  <StatusBadge status={o.status} />
                  <span style={{ fontSize: 12, color: C.muted }}>
                    {orderDate(o) || '—'}
                  </span>
                  <span style={{ fontSize: 12.5, fontWeight: 600 }}>{o.customer || '—'}</span>
                  {o.wilaya ? (
                    <span style={{ fontSize: 12, color: C.muted }}>· {o.wilaya}</span>
                  ) : null}
                  <span style={{ flex: 1 }} />
                  <span style={{ fontSize: 12.5, fontWeight: 700, whiteSpace: 'nowrap' }}>
                    {fmtDZD(orderTotal(o))}
                  </span>
                </div>

                {/* Courier assignment */}
                <div
                  style={{
                    display: 'flex',
                    gap: 8,
                    alignItems: 'center',
                    flexWrap: 'wrap',
                  }}
                >
                  <span style={{ fontSize: 11.5, color: C.muted, minWidth: 56 }}>Livreur</span>
                  <select
                    style={{
                      ...inputStyle,
                      width: 'auto',
                      minWidth: 150,
                      padding: '6px 10px',
                      fontSize: 12.5,
                      cursor: busy || readOnly ? 'default' : 'pointer',
                      opacity: busy ? 0.6 : 1,
                    }}
                    value={assignedId}
                    disabled={busy || readOnly}
                    onChange={e => void onAssign(o, e.target.value, mode)}
                  >
                    <option value="" disabled>
                      Choisir…
                    </option>
                    {activeCouriers.map(c => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                    {/* Keep a stale/inactive assignment visible so it isn't lost. */}
                    {assignedId && !activeCouriers.some(c => c.id === assignedId) ? (
                      <option value={assignedId}>
                        {courierNameById.get(assignedId) || assignedId} (inactif)
                      </option>
                    ) : null}
                  </select>
                  <div style={{ display: 'inline-flex', gap: 4 }}>
                    {(['home', 'desk'] as ShipDeliveryMode[]).map(m => (
                      <button
                        key={m}
                        style={modePillStyle(mode === m)}
                        disabled={busy || readOnly || !assignedId}
                        onClick={() => void onAssign(o, assignedId, m)}
                        title={m === 'home' ? 'À domicile' : 'Stop-desk (bureau)'}
                      >
                        {m === 'home' ? 'Domicile' : 'Bureau'}
                      </button>
                    ))}
                  </div>
                  {busy ? <Spinner /> : null}
                </div>

                {/* Tracking stepper */}
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                  <span style={{ fontSize: 11.5, color: C.muted, minWidth: 56 }}>Suivi</span>
                  {TRACKING_STEPS.map(step => {
                    const done = tracking === step.id;
                    const isReturn = step.id === 'retour';
                    return (
                      <button
                        key={step.id}
                        style={trackStepStyle(done, isReturn, busy || readOnly || !assignedId)}
                        disabled={busy || readOnly || !assignedId}
                        onClick={() => void onTrack(o, step.id)}
                        title={step.hint}
                      >
                        {done ? '● ' : ''}
                        {step.label}
                      </button>
                    );
                  })}
                </div>

                {rowNotice && rowNotice.id === oid ? (
                  <div
                    style={{
                      fontSize: 11.5,
                      color: rowNotice.bad ? 'var(--affine-error-color, #eb4b4b)' : C.muted,
                    }}
                  >
                    {rowNotice.text}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </Panel>
  );
};

// ===========================================================================
// Small presentational helpers (inline styles only, per house rules).
// ===========================================================================

const LoadingRow = ({ label }: { label: string }) => (
  <div
    style={{
      display: 'flex',
      alignItems: 'center',
      gap: 10,
      padding: '24px 4px',
      color: C.muted,
    }}
  >
    <Spinner /> {label}
  </div>
);

const linkRetryStyle: CSSProperties = {
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

const twoColStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
  gap: 12,
};

const csvCodeStyle: CSSProperties = {
  fontFamily: 'var(--affine-font-code-family, monospace)',
  fontSize: 11.5,
  padding: '1px 5px',
  borderRadius: 4,
  background: C.accentSoft,
  color: C.text,
};

function subTabStyle(active: boolean): CSSProperties {
  return {
    appearance: 'none',
    background: 'none',
    border: 'none',
    borderBottom: active ? `2px solid ${C.accent}` : '2px solid transparent',
    padding: '8px 12px',
    fontSize: 13,
    fontWeight: 700,
    cursor: 'pointer',
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    color: active ? C.text : C.muted,
    transition: 'color 160ms ease, border-color 160ms ease',
  };
}

function switchStyle(on: boolean, disabled: boolean): CSSProperties {
  return {
    appearance: 'none',
    display: 'inline-flex',
    alignItems: 'center',
    gap: 8,
    padding: '6px 12px 6px 8px',
    borderRadius: 999,
    cursor: disabled ? 'default' : 'pointer',
    opacity: disabled ? 0.6 : 1,
    color: on ? '#fff' : C.text,
    background: on ? C.accent : 'transparent',
    border: `1px solid ${on ? C.accent : C.border}`,
    transition: 'background 160ms ease, border-color 160ms ease',
  };
}

function switchKnobStyle(on: boolean): CSSProperties {
  return {
    width: 14,
    height: 14,
    borderRadius: '50%',
    background: on ? '#fff' : C.muted,
    boxShadow: on ? '0 0 0 2px rgba(255,255,255,0.3)' : 'none',
    transition: 'background 160ms ease',
  };
}

function modePillStyle(active: boolean): CSSProperties {
  return {
    appearance: 'none',
    cursor: 'pointer',
    borderRadius: 7,
    padding: '5px 10px',
    fontSize: 11.5,
    fontWeight: 700,
    color: active ? '#fff' : C.muted,
    background: active ? C.accent : 'transparent',
    border: `1px solid ${active ? C.accent : C.border}`,
    whiteSpace: 'nowrap',
  };
}

function trackStepStyle(done: boolean, isReturn: boolean, disabled: boolean): CSSProperties {
  const accent = isReturn ? STATUS_COLORS['Retournée'] : C.accent;
  return {
    appearance: 'none',
    cursor: disabled ? 'default' : 'pointer',
    opacity: disabled ? 0.55 : 1,
    borderRadius: 999,
    padding: '4px 10px',
    fontSize: 11.5,
    fontWeight: 700,
    whiteSpace: 'nowrap',
    color: done ? '#fff' : isReturn ? STATUS_COLORS['Retournée'] : C.text,
    background: done ? accent : isReturn ? 'transparent' : C.bg,
    border: `1px solid ${done ? accent : isReturn ? STATUS_COLORS['Retournée'] : C.border}`,
    transition: 'background 160ms ease, color 160ms ease',
  };
}

const ActiveBadge = ({ active }: { active: boolean }) => {
  const color = active ? STATUS_COLORS['Livrée'] : '#9aa0a6';
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        fontSize: 11,
        fontWeight: 700,
        padding: '2px 9px',
        borderRadius: 999,
        whiteSpace: 'nowrap',
        color,
        background: `color-mix(in srgb, ${color} 15%, transparent)`,
        border: `1px solid color-mix(in srgb, ${color} 35%, transparent)`,
      }}
    >
      {active ? 'Actif' : 'Inactif'}
    </span>
  );
};

// ---- Rate-matrix table styles: sticky header + compact inputs so the 58 rows
// collapse gracefully on mobile (the table lives in a capped-height scroller). --

const matrixWrapStyle: CSSProperties = {
  border: `1px solid ${C.border}`,
  borderRadius: 12,
  overflow: 'auto',
  maxHeight: 460,
  background: C.panel,
};

const matrixThStyle: CSSProperties = {
  position: 'sticky',
  top: 0,
  zIndex: 1,
  textAlign: 'center',
  fontSize: 10.5,
  fontWeight: 700,
  letterSpacing: '0.04em',
  textTransform: 'uppercase',
  color: C.muted,
  padding: '8px 8px',
  background: C.panel2,
  borderBottom: `1px solid ${C.border}`,
  whiteSpace: 'nowrap',
};

const matrixWilayaTdStyle: CSSProperties = {
  padding: '4px 10px',
  borderTop: `1px solid ${C.border}`,
  color: C.text,
  fontSize: 12,
  whiteSpace: 'nowrap',
  position: 'sticky',
  left: 0,
  background: C.panel,
};

const matrixCellTdStyle: CSSProperties = {
  padding: '4px 6px',
  borderTop: `1px solid ${C.border}`,
  textAlign: 'center',
};

const matrixInputStyle: CSSProperties = {
  width: 72,
  maxWidth: '100%',
  boxSizing: 'border-box',
  padding: '5px 7px',
  borderRadius: 6,
  fontSize: 12.5,
  fontFamily: 'inherit',
  textAlign: 'right',
  color: C.text,
  background: C.bg,
  border: `1px solid ${C.border}`,
  outline: 'none',
};

const shipmentCardStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  padding: '11px 12px',
  borderRadius: 10,
  background: C.bg,
  border: `1px solid ${C.border}`,
};

// ---- wa.me link builder: strip non-digits, keep a bare international number.
// A leading 0 (local DZ format) is swapped for the 213 country code so the
// WhatsApp deep-link resolves; an already-international number is kept as-is. --

function waMeLink(phone: string): string {
  let d = String(phone).replace(/[^\d]/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  if (d.startsWith('0')) d = `213${d.slice(1)}`;
  return `https://wa.me/${d}`;
}
