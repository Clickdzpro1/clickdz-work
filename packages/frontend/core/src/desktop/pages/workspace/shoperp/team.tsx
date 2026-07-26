import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  Banner,
  btnStyle,
  C,
  createStaff,
  EmptyNote,
  type ErpSettings,
  fetchStaff,
  Field,
  hintStyle,
  inputStyle,
  labelStyle,
  miniBtnStyle,
  Panel,
  postErpSettings,
  revokeStaff,
  type StaffListOutcome,
  type StaffMember,
  type StaffRoleId,
  Spinner,
  STAFF_ROLE_META,
  tdStyle,
  thStyle,
  updateStaff,
  waHref,
} from './shoperp-shared';

// ---------------------------------------------------------------------------
// Équipe (WSE-13 studio) — staff & roles management for the PUBLISHED ERP app.
//
// The owner creates per-employee access tokens here; each employee pastes their
// token into the published ERP's staff-login screen (which the owner enables
// with the "activer l'accès équipe" toggle below → writes settings.staffAuth).
// The token is shown ONCE, in a success modal, with a big copy button and a
// pre-built wa.me link (darja message) so the owner can WhatsApp it straight to
// the employee. Revoke rotates the server-side nonce → every old token for that
// employee dies immediately (the owner gets a fresh one to re-share).
//
// Backend: GET/POST /api/v1/apps/:slug/erp/staff, PUT .../staff/:id,
// POST .../staff/:id/revoke — ALL gated by CDZ_ERP_STAFF_AUTH. While that flag
// is OFF the routes return 404, so this page renders a quiet "activation en
// attente" state (never an error) and keeps the explainer + toggle usable.
// Owner-authed (session cookie via credentials:'include' in the wrappers).
// Inline styles only, FR labels + darja hints, mirroring the other shoperp
// pages (Panel/Field/Banner/Spinner/btnStyle from shoperp-shared).
// ---------------------------------------------------------------------------

const ROLE_IDS: StaffRoleId[] = ['owner', 'manager', 'staff'];

/** Digits-only WhatsApp normalization for display (waHref does the linking). */
function fmtPhone(p: string): string {
  return String(p || '').trim();
}

export const TeamPanel = ({
  slug,
  settings,
  readOnly,
  onWritesBlocked,
  onMutated,
}: {
  /** The store's slug — its data namespace + the pairing key with the app. */
  slug: string;
  /** The live settings singleton (for the current staffAuth toggle state). */
  settings: ErpSettings;
  readOnly: boolean;
  onWritesBlocked: () => void;
  onMutated: () => void;
}) => {
  // ---- List state ----------------------------------------------------------
  const [loading, setLoading] = useState(true);
  const [outcome, setOutcome] = useState<StaffListOutcome | null>(null);
  const [notice, setNotice] = useState<{
    tone: 'ok' | 'error' | 'info';
    text: string;
  } | null>(null);

  // ---- Create-form state ---------------------------------------------------
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [role, setRole] = useState<StaffRoleId>('staff');
  const [creating, setCreating] = useState(false);

  // ---- One-time token modal ------------------------------------------------
  const [tokenModal, setTokenModal] = useState<{
    member: StaffMember;
    token: string;
    reissue: boolean;
  } | null>(null);
  const [copied, setCopied] = useState(false);

  // ---- Per-row busy flags (role change / active toggle / revoke) -----------
  const [busyId, setBusyId] = useState<string | null>(null);

  // ---- Enable-toggle state (writes settings.staffAuth) ---------------------
  const staffAuthOn = String(settings.staffAuth ?? '') === '1';
  const [togglingAuth, setTogglingAuth] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const out = await fetchStaff(slug);
    setOutcome(out);
    setLoading(false);
  }, [slug]);

  useEffect(() => {
    void load();
  }, [load]);

  const staff = useMemo<StaffMember[]>(
    () => (outcome && outcome.status === 'ok' ? outcome.staff : []),
    [outcome]
  );
  const disabled = outcome?.status === 'disabled';
  const writeBlocked = readOnly;

  // ---- Create --------------------------------------------------------------
  const doCreate = useCallback(async () => {
    if (creating || writeBlocked) return;
    const trimmed = name.trim();
    if (!trimmed) {
      setNotice({ tone: 'error', text: 'Le nom de l’employé est requis.' });
      return;
    }
    setNotice(null);
    setCreating(true);
    const out = await createStaff(slug, {
      name: trimmed,
      phone: phone.trim(),
      role,
    });
    setCreating(false);
    if (out.status === 'ok') {
      setName('');
      setPhone('');
      setRole('staff');
      if (out.data.staffToken && out.data.staff) {
        setCopied(false);
        setTokenModal({
          member: out.data.staff,
          token: out.data.staffToken,
          reissue: false,
        });
      }
      setNotice({
        tone: 'ok',
        text: `Employé « ${trimmed} » ajouté. Envoyez-lui son jeton d’accès.`,
      });
      onMutated();
      void load();
    } else if (out.status === 'unavailable') {
      onWritesBlocked();
    } else if (out.status === 'disabled') {
      setOutcome({ status: 'disabled' });
    } else {
      setNotice({ tone: 'error', text: out.message });
    }
  }, [creating, writeBlocked, name, phone, role, slug, onMutated, onWritesBlocked, load]);

  // ---- Update role / active ------------------------------------------------
  const doUpdate = useCallback(
    async (m: StaffMember, patch: { role?: StaffRoleId; active?: boolean }) => {
      if (busyId || writeBlocked) return;
      setNotice(null);
      setBusyId(m.id);
      const out = await updateStaff(slug, m.id, patch);
      setBusyId(null);
      if (out.status === 'ok') {
        setNotice({
          tone: 'ok',
          text:
            patch.role != null
              ? `Rôle de « ${m.name} » mis à jour. Révoquez son jeton pour appliquer une rétrogradation immédiatement.`
              : `« ${m.name} » ${patch.active === false ? 'désactivé' : 'réactivé'}.`,
        });
        onMutated();
        void load();
      } else if (out.status === 'unavailable') {
        onWritesBlocked();
      } else if (out.status === 'disabled') {
        setOutcome({ status: 'disabled' });
      } else {
        setNotice({ tone: 'error', text: out.message });
      }
    },
    [busyId, writeBlocked, slug, onMutated, onWritesBlocked, load]
  );

  // ---- Revoke (rotate nonce → old tokens die; new one returned) ------------
  const doRevoke = useCallback(
    async (m: StaffMember) => {
      if (busyId || writeBlocked) return;
      const ok = window.confirm(
        `Révoquer l’accès de « ${m.name} » ?\n\nSon jeton actuel cessera immédiatement de fonctionner. Un nouveau jeton sera généré à partager.`
      );
      if (!ok) return;
      setNotice(null);
      setBusyId(m.id);
      const out = await revokeStaff(slug, m.id);
      setBusyId(null);
      if (out.status === 'ok') {
        if (out.data.staffToken) {
          setCopied(false);
          setTokenModal({ member: m, token: out.data.staffToken, reissue: true });
        }
        setNotice({
          tone: 'ok',
          text: `Ancien jeton de « ${m.name} » révoqué. Partagez le nouveau.`,
        });
        onMutated();
        void load();
      } else if (out.status === 'unavailable') {
        onWritesBlocked();
      } else if (out.status === 'disabled') {
        setOutcome({ status: 'disabled' });
      } else {
        setNotice({ tone: 'error', text: out.message });
      }
    },
    [busyId, writeBlocked, slug, onMutated, onWritesBlocked, load]
  );

  // ---- Enable / disable the published staff login (settings.staffAuth) -----
  const toggleStaffAuth = useCallback(
    async (next: boolean) => {
      if (togglingAuth || writeBlocked) return;
      setNotice(null);
      setTogglingAuth(true);
      const out = await postErpSettings(slug, { staffAuth: next ? '1' : '0' });
      setTogglingAuth(false);
      if (out.status === 'ok') {
        setNotice({
          tone: 'ok',
          text: next
            ? 'Connexion équipe activée dans l’app. Vos employés se connecteront avec leur jeton.'
            : 'Connexion équipe désactivée. L’app repasse au code PIN unique.',
        });
        onMutated();
      } else if (out.status === 'unavailable') {
        onWritesBlocked();
      } else {
        setNotice({ tone: 'error', text: out.message });
      }
    },
    [togglingAuth, writeBlocked, slug, onMutated, onWritesBlocked]
  );

  // ---- Render --------------------------------------------------------------
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {notice ? <Banner tone={notice.tone}>{notice.text}</Banner> : null}

      {writeBlocked ? (
        <Banner tone="warn">
          Les modifications d’équipe sont indisponibles sur ce serveur pour le
          moment — cette page est en <strong>lecture seule</strong>.
        </Banner>
      ) : null}

      {/* ---- Activation toggle (writes settings.staffAuth) --------------- */}
      <Panel title="Accès équipe dans l’application">
        <div
          style={{
            display: 'flex',
            gap: 12,
            alignItems: 'flex-start',
            flexWrap: 'wrap',
          }}
        >
          <div style={{ flex: 1, minWidth: 220 }}>
            <div style={{ fontSize: 13.5, color: C.text, lineHeight: 1.5 }}>
              {staffAuthOn
                ? 'Activé — l’app demande un jeton d’accès personnel à chaque employé.'
                : 'Désactivé — l’app utilise le code PIN unique (comportement par défaut).'}
            </div>
            <div style={{ ...hintStyle, marginTop: 4 }}>
              Quand c’est activé, chaque employé se connecte avec son propre
              jeton (kol wahed b code taعو) et ne voit que ses onglets autorisés.
            </div>
          </div>
          <button
            style={btnStyle(staffAuthOn ? 'secondary' : 'primary', togglingAuth || writeBlocked)}
            disabled={togglingAuth || writeBlocked}
            onClick={() => void toggleStaffAuth(!staffAuthOn)}
          >
            {togglingAuth ? (
              <Spinner dark={!staffAuthOn} />
            ) : staffAuthOn ? (
              'Désactiver'
            ) : (
              'Activer l’accès équipe'
            )}
          </button>
        </div>
      </Panel>

      {/* ---- Loading / disabled / content ------------------------------- */}
      {loading ? (
        <Panel title="Équipe">
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '8px 2px' }}>
            <Spinner /> <span style={{ fontSize: 13, color: C.muted }}>Chargement…</span>
          </div>
        </Panel>
      ) : disabled ? (
        <Panel title="Équipe">
          <div style={{ textAlign: 'center', padding: '22px 12px' }}>
            <div style={{ fontSize: 30, marginBottom: 8 }}>🕒</div>
            <div style={{ fontSize: 15, fontWeight: 700, color: C.text }}>
              Activation en attente
            </div>
            <div style={{ ...hintStyle, maxWidth: 420, margin: '6px auto 0' }}>
              La gestion d’équipe sera disponible dès que l’accès équipe sera
              activé sur ce serveur. Vous pourrez alors créer des employés et
              leur envoyer un jeton d’accès. En attendant, l’app reste protégée
              par le code PIN.
            </div>
          </div>
        </Panel>
      ) : outcome?.status === 'error' ? (
        <Panel title="Équipe">
          <Banner tone="error">
            {outcome.message}{' '}
            <button style={miniBtnStyle('secondary')} onClick={() => void load()}>
              Réessayer
            </button>
          </Banner>
        </Panel>
      ) : (
        <>
          {/* ---- Create form -------------------------------------------- */}
          <Panel title="Ajouter un employé">
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
                gap: 12,
                alignItems: 'end',
              }}
            >
              <Field label="Nom">
                <input
                  style={inputStyle}
                  value={name}
                  placeholder="Ex : Amine"
                  disabled={writeBlocked || creating}
                  onChange={e => setName(e.target.value)}
                />
              </Field>
              <Field label="Téléphone" hint="Pour l’envoi WhatsApp du jeton">
                <input
                  style={inputStyle}
                  value={phone}
                  placeholder="0555 12 34 56"
                  inputMode="tel"
                  disabled={writeBlocked || creating}
                  onChange={e => setPhone(e.target.value)}
                />
              </Field>
              <Field label="Rôle">
                <select
                  style={{ ...inputStyle, cursor: 'pointer' }}
                  value={role}
                  disabled={writeBlocked || creating}
                  onChange={e => setRole(e.target.value as StaffRoleId)}
                >
                  {ROLE_IDS.map(r => (
                    <option key={r} value={r}>
                      {STAFF_ROLE_META[r].label}
                    </option>
                  ))}
                </select>
              </Field>
              <button
                style={btnStyle('primary', creating || writeBlocked)}
                disabled={creating || writeBlocked}
                onClick={() => void doCreate()}
              >
                {creating ? <Spinner dark /> : 'Créer + jeton'}
              </button>
            </div>
          </Panel>

          {/* ---- Staff list --------------------------------------------- */}
          <Panel title={`Employés${staff.length ? ` · ${staff.length}` : ''}`}>
            {staff.length === 0 ? (
              <EmptyNote>
                Aucun employé pour l’instant. Créez-en un ci-dessus : un jeton
                d’accès unique sera généré à lui envoyer.
              </EmptyNote>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 560 }}>
                  <thead>
                    <tr>
                      <th style={thStyle}>Nom</th>
                      <th style={thStyle}>Téléphone</th>
                      <th style={thStyle}>Rôle</th>
                      <th style={thStyle}>Actif</th>
                      <th style={{ ...thStyle, textAlign: 'right' }}>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {staff.map(m => {
                      const rowBusy = busyId === m.id;
                      return (
                        <tr key={m.id}>
                          <td style={tdStyle}>
                            <span style={{ fontWeight: 600 }}>{m.name || '—'}</span>
                          </td>
                          <td style={{ ...tdStyle, color: C.muted }}>
                            {m.phone ? (
                              <a
                                href={waHref(m.phone)}
                                target="_blank"
                                rel="noopener noreferrer"
                                style={{ color: C.accent }}
                              >
                                {fmtPhone(m.phone)}
                              </a>
                            ) : (
                              '—'
                            )}
                          </td>
                          <td style={tdStyle}>
                            <select
                              style={{
                                ...inputStyle,
                                padding: '5px 8px',
                                fontSize: 12.5,
                                width: 'auto',
                                cursor: rowBusy || writeBlocked ? 'default' : 'pointer',
                              }}
                              value={
                                ROLE_IDS.indexOf(m.role as StaffRoleId) >= 0
                                  ? (m.role as StaffRoleId)
                                  : 'staff'
                              }
                              disabled={rowBusy || writeBlocked}
                              onChange={e =>
                                void doUpdate(m, { role: e.target.value as StaffRoleId })
                              }
                            >
                              {ROLE_IDS.map(r => (
                                <option key={r} value={r}>
                                  {STAFF_ROLE_META[r].label}
                                </option>
                              ))}
                            </select>
                          </td>
                          <td style={tdStyle}>
                            <button
                              style={miniBtnStyle(
                                m.active ? 'secondary' : 'danger',
                                rowBusy || writeBlocked
                              )}
                              disabled={rowBusy || writeBlocked}
                              onClick={() => void doUpdate(m, { active: !m.active })}
                              title={m.active ? 'Désactiver' : 'Réactiver'}
                            >
                              {m.active ? 'Actif' : 'Inactif'}
                            </button>
                          </td>
                          <td style={{ ...tdStyle, textAlign: 'right' }}>
                            <button
                              style={miniBtnStyle('danger', rowBusy || writeBlocked)}
                              disabled={rowBusy || writeBlocked}
                              onClick={() => void doRevoke(m)}
                            >
                              {rowBusy ? <Spinner /> : 'Révoquer'}
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>
        </>
      )}

      {/* ---- Roles explainer (always shown) ----------------------------- */}
      <Panel title="Rôles & permissions">
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 420 }}>
            <thead>
              <tr>
                <th style={thStyle}>Rôle</th>
                <th style={thStyle}>Accès dans l’app</th>
              </tr>
            </thead>
            <tbody>
              {ROLE_IDS.map(r => (
                <tr key={r}>
                  <td style={{ ...tdStyle, whiteSpace: 'nowrap' }}>
                    <span style={{ fontWeight: 700 }}>{STAFF_ROLE_META[r].label}</span>
                  </td>
                  <td style={{ ...tdStyle, color: C.muted, lineHeight: 1.5 }}>
                    {STAFF_ROLE_META[r].scope}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div style={{ ...hintStyle, marginTop: 10 }}>
          Le jeton n’est affiché qu’une seule fois à la création. En cas de perte
          ou de départ d’un employé, utilisez « Révoquer » : l’ancien jeton
          cesse aussitôt de fonctionner.
        </div>
      </Panel>

      {/* ---- One-time token modal --------------------------------------- */}
      {tokenModal ? (
        <TokenModal
          storeName={settings.shopName || slug}
          member={tokenModal.member}
          token={tokenModal.token}
          reissue={tokenModal.reissue}
          copied={copied}
          onCopied={() => setCopied(true)}
          onClose={() => setTokenModal(null)}
        />
      ) : null}
    </div>
  );
};

// ---------------------------------------------------------------------------
// One-time token modal — a big copy button + a pre-built WhatsApp link so the
// owner can send the darja access message straight to the employee's phone.
// The token is shown ONCE (the list route never re-exposes it), so we make
// copying + sharing frictionless and warn that it won't be shown again.
// ---------------------------------------------------------------------------
const TokenModal = ({
  storeName,
  member,
  token,
  reissue,
  copied,
  onCopied,
  onClose,
}: {
  storeName: string;
  member: StaffMember;
  token: string;
  reissue: boolean;
  copied: boolean;
  onCopied: () => void;
  onClose: () => void;
}) => {
  // Darja WhatsApp message: greet + what it is + the token + a hint to paste it
  // in the app's staff login. Kept short; the app link is the published store.
  const waMessage = useMemo(() => {
    const lines = [
      `Salam ${member.name},`,
      `Hada howa jeton dyalek bach tdkhol l tableau de bord "${storeName}".`,
      '',
      `Jeton: ${token}`,
      '',
      'Dir login f l’app w llsa9 l jeton f khanet "Espace équipe".',
    ];
    return lines.join('\n');
  }, [member.name, storeName, token]);

  const waLink = useMemo(() => {
    const digits = String(member.phone || '').replace(/[^0-9]/g, '');
    const base = digits
      ? waHref(member.phone)
      : 'https://wa.me/';
    return `${base}?text=${encodeURIComponent(waMessage)}`;
  }, [member.phone, waMessage]);

  const copy = useCallback(() => {
    const done = () => onCopied();
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        void navigator.clipboard.writeText(token).then(done, done);
        return;
      }
    } catch {
      /* fall through to the manual-select fallback below */
    }
    done();
  }, [token, onCopied]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1000,
        background: 'rgba(0,0,0,0.5)',
        display: 'grid',
        placeItems: 'center',
        padding: 20,
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          width: '100%',
          maxWidth: 440,
          background: C.panel,
          border: `1px solid ${C.border}`,
          borderRadius: 14,
          overflow: 'hidden',
          boxShadow: '0 10px 40px rgba(0,0,0,0.4)',
        }}
      >
        <div
          style={{
            padding: '14px 18px',
            borderBottom: `1px solid ${C.border}`,
            background: C.panel2,
            display: 'flex',
            alignItems: 'center',
            gap: 8,
          }}
        >
          <span style={{ fontSize: 18 }}>🔑</span>
          <div style={{ fontSize: 15, fontWeight: 750, color: C.text }}>
            {reissue ? 'Nouveau jeton' : 'Jeton d’accès créé'}
          </div>
        </div>
        <div style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ fontSize: 13.5, color: C.text, lineHeight: 1.5 }}>
            Voici le jeton d’accès de <strong>{member.name}</strong> (
            {STAFF_ROLE_META[
              ROLE_IDS.indexOf(member.role as StaffRoleId) >= 0
                ? (member.role as StaffRoleId)
                : 'staff'
            ].label}
            ). Il n’est affiché <strong>qu’une seule fois</strong> — copiez-le ou
            envoyez-le maintenant.
          </div>

          <div>
            <div style={{ ...labelStyle, marginBottom: 6 }}>Jeton</div>
            <div
              style={{
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                fontSize: 12.5,
                wordBreak: 'break-all',
                padding: '10px 12px',
                borderRadius: 8,
                background: C.bg,
                border: `1px solid ${C.border}`,
                color: C.text,
              }}
            >
              {token}
            </div>
          </div>

          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <button style={btnStyle('primary')} onClick={copy}>
              {copied ? '✓ Copié' : 'Copier le jeton'}
            </button>
            <a
              href={waLink}
              target="_blank"
              rel="noopener noreferrer"
              style={{ ...btnStyle('secondary'), textDecoration: 'none' }}
            >
              💬 Envoyer sur WhatsApp
            </a>
          </div>

          {!member.phone ? (
            <div style={hintStyle}>
              Aucun numéro enregistré — le lien WhatsApp s’ouvrira sans
              destinataire. Ajoutez un téléphone à l’employé pour un envoi
              direct.
            </div>
          ) : null}

          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <button style={btnStyle('secondary')} onClick={onClose}>
              Fermer
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default TeamPanel;
