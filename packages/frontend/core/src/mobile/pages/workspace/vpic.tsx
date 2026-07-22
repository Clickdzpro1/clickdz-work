import {
  dirFor,
  useVpicLang,
} from '@affine/core/modules/vpic/i18n';
import { useEffect, useState } from 'react';

/**
 * Mobile VPIC — READ-ONLY stub (R14). Lists your saved image-editor projects
 * and points at desktop for editing; the full canvas editor needs pointer
 * precision this screen doesn't have (same stance as mobile Vdz). Registered
 * at /vpic in the mobile workbench (before the '/:pageId' catch route) so the
 * lazy route target exists — WITHOUT pulling the engine or editor panel into
 * the mobile bundle (this file imports only the i18n module).
 *
 * Caps-gated exactly like the desktop page: `GET /api/v1/vpic/caps` reports
 * {enabled}; when the CDZ_VPIC_ENABLED flag is off the page renders the
 * friendly gated-off card — byte-identical spirit to the ERP
 * activation-pending cards. Reads are fail-soft: any fetch error degrades to
 * an empty list, never a crash (house rule).
 */

interface VpicProjectRow {
  id: string;
  name: string;
  updatedAt: number;
}

const S = {
  page: {
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
    padding: '16px 16px 32px',
    minHeight: '100%',
  },
  h1: { fontSize: 18, fontWeight: 700 },
  sub: { fontSize: 12.5, opacity: 0.6, lineHeight: 1.5 },
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    width: '100%',
    minHeight: 52,
    padding: '10px 12px',
    borderRadius: 10,
    border: '1px solid var(--affine-border-color, #333)',
    background: 'transparent',
    color: 'inherit',
    textAlign: 'left' as const,
  },
  rowName: {
    fontSize: 14,
    fontWeight: 600,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
    flex: 1,
    minWidth: 0,
  },
  rowDate: { fontSize: 11, opacity: 0.55, flexShrink: 0 },
  note: { fontSize: 12, opacity: 0.55, lineHeight: 1.6 },
} as const;

const MobileVpicPage = () => {
  const { lang, t } = useVpicLang();
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [list, setList] = useState<VpicProjectRow[] | null>(null);

  // Caps first, then the project list — both fail-soft (an error is just
  // "disabled" / "empty", never a thrown render).
  useEffect(() => {
    let alive = true;
    void fetch('/api/v1/vpic/caps', { credentials: 'include' })
      .then(res => (res.ok ? res.json() : { enabled: false }))
      .catch(() => ({ enabled: false }))
      .then((caps: { enabled?: boolean }) => {
        if (!alive) return;
        const on = caps?.enabled === true;
        setEnabled(on);
        if (!on) return;
        void fetch('/api/v1/vpic/projects', { credentials: 'include' })
          .then(res => (res.ok ? res.json() : []))
          .catch(() => [])
          .then((rows: VpicProjectRow[]) => {
            if (alive) setList(Array.isArray(rows) ? rows : []);
          });
      });
    return () => {
      alive = false;
    };
  }, []);

  return (
    <div style={S.page} dir={dirFor(lang)}>
      <div style={S.h1}>{t('vpic.title')}</div>
      {enabled === null ? (
        <div style={S.note}>{t('vpic.loading')}</div>
      ) : !enabled ? (
        <>
          <div style={S.sub}>{t('vpic.gatedOffTitle')}</div>
          <div style={S.note}>{t('vpic.gatedOffBody')}</div>
        </>
      ) : (
        <>
          <div style={S.sub}>{t('vpic.subtitle')}</div>
          <div style={S.h1}>{t('vpic.myProjects')}</div>
          {list === null ? (
            <div style={S.note}>{t('vpic.loading')}</div>
          ) : list.length === 0 ? (
            <div style={S.note}>{t('vpic.emptyProjects')}</div>
          ) : (
            list.map(row => (
              <div key={row.id} style={S.row}>
                <span style={S.rowName}>{row.name}</span>
                <span style={S.rowDate}>
                  {new Date(row.updatedAt).toLocaleDateString()}
                </span>
              </div>
            ))
          )}
          {/* Editing is desktop-only in R14 — same stance as mobile Vdz. */}
          <div style={S.note}>{t('vpic.gatedOffBody')}</div>
        </>
      )}
    </div>
  );
};

export const Component = () => {
  return <MobileVpicPage />;
};
