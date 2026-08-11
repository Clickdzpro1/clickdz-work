import { useCallback, useEffect, useState } from 'react';

import {
  Banner,
  btnStyle,
  C,
  fetchCaisse,
  fetchErpCollection,
  fetchErpInventory,
  fetchInvoices,
  fetchPurchaseOrders,
  fetchSuppliers,
  miniBtnStyle,
  Spinner,
} from './shoperp-shared';

// ---------------------------------------------------------------------------
// Local backup — "DzOS needs a local backup and can be running offline,
// especially the ERP." This panel gives the owner a manual, dependency-free
// export of the key ERP datasets to a single JSON file on their machine, plus
// a silent 24h localStorage safety snapshot. Import is READ-ONLY in this
// version: a bad automated restore on the money path (orders/caisse/invoices)
// is worse than no restore, so the file is only validated and summarized —
// applying it back requires support/owner-assisted restore (not shipped here).
// ---------------------------------------------------------------------------

const AUTOBACKUP_PREFIX = 'cdz:erp-autobackup:';
const AUTOBACKUP_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const AUTOBACKUP_MAX_BYTES = 500_000;

interface BackupDataset {
  key: string;
  label: string;
  records: unknown[];
}

interface BackupFile {
  kind: 'clickdz-erp-backup';
  version: 1;
  slug: string;
  generatedAt: string;
  datasets: BackupDataset[];
}

interface AutoSnapshot {
  cachedAt: number;
  file: BackupFile;
}

function autobackupKey(slug: string): string {
  return `${AUTOBACKUP_PREFIX}${slug}`;
}

function readAutoSnapshot(slug: string): AutoSnapshot | null {
  try {
    const raw = window.localStorage.getItem(autobackupKey(slug));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as AutoSnapshot;
    if (!parsed || typeof parsed.cachedAt !== 'number' || !parsed.file) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function writeAutoSnapshot(slug: string, file: BackupFile): void {
  try {
    const snapshot: AutoSnapshot = { cachedAt: Date.now(), file };
    const serialized = JSON.stringify(snapshot);
    if (serialized.length > AUTOBACKUP_MAX_BYTES) return;
    window.localStorage.setItem(autobackupKey(slug), serialized);
  } catch {
    // Quota exceeded or storage disabled — the manual "Exporter" button
    // still works, this is only the silent convenience snapshot.
  }
}

/** Pull every dataset we know how to export for one shop, tolerating gaps. */
async function collectDatasets(
  slug: string,
  onProgress?: (label: string, done: number, total: number) => void
): Promise<BackupDataset[]> {
  const jobs: Array<{ label: string; key: string; load: () => Promise<unknown[]> }> = [
    {
      label: 'Produits & stock',
      key: 'products',
      load: () => fetchErpCollection(slug, 'products'),
    },
    {
      label: 'Commandes',
      key: 'orders',
      load: () => fetchErpCollection(slug, 'orders'),
    },
    {
      label: 'Clients',
      key: 'customers',
      load: () => fetchErpCollection(slug, 'customers'),
    },
    {
      label: 'Créances',
      key: 'creances',
      load: () => fetchErpCollection(slug, 'creances'),
    },
    {
      label: 'Entrepôts & inventaire',
      key: 'inventory',
      load: async () => {
        const outcome = await fetchErpInventory(slug);
        return outcome.status === 'ok'
          ? [outcome.inventory as unknown]
          : [];
      },
    },
    {
      label: 'Fournisseurs',
      key: 'suppliers',
      load: async () => {
        const outcome = await fetchSuppliers(slug);
        return outcome.status === 'ok' ? outcome.suppliers : [];
      },
    },
    {
      label: 'Bons de commande (achats)',
      key: 'purchase-orders',
      load: async () => {
        const outcome = await fetchPurchaseOrders(slug);
        return outcome.status === 'ok' ? outcome.purchaseOrders : [];
      },
    },
    {
      label: 'Factures',
      key: 'invoices',
      load: async () => {
        const outcome = await fetchInvoices(slug);
        return outcome.status === 'ok' ? outcome.invoices : [];
      },
    },
    {
      label: 'Caisse',
      key: 'caisse',
      load: async () => {
        const outcome = await fetchCaisse(slug);
        return outcome.status === 'ok' ? outcome.entries : [];
      },
    },
  ];

  const datasets: BackupDataset[] = [];
  for (let i = 0; i < jobs.length; i++) {
    const job = jobs[i];
    onProgress?.(job.label, i, jobs.length);
    try {
      const records = await job.load();
      datasets.push({ key: job.key, label: job.label, records });
    } catch {
      // One dataset failing (offline, flag off, route absent) must not abort
      // the whole export — record it as empty rather than losing the rest.
      datasets.push({ key: job.key, label: job.label, records: [] });
    }
  }
  onProgress?.('', jobs.length, jobs.length);
  return datasets;
}

function totalRecords(datasets: BackupDataset[]): number {
  return datasets.reduce((sum, d) => sum + d.records.length, 0);
}

function todayStamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function downloadBackupFile(slug: string, file: BackupFile): void {
  const blob = new Blob([JSON.stringify(file, null, 2)], {
    type: 'application/json',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `clickdz-erp-backup-${slug}-${todayStamp()}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function fmtDateTime(ms: number): string {
  try {
    return new Date(ms).toLocaleString('fr-DZ', {
      dateStyle: 'short',
      timeStyle: 'short',
    });
  } catch {
    return new Date(ms).toISOString();
  }
}

function fmtCount(n: number): string {
  try {
    return n.toLocaleString('fr-DZ');
  } catch {
    return String(n);
  }
}

type ImportSummary =
  | { status: 'ok'; file: BackupFile; totalRecords: number }
  | { status: 'invalid'; reason: string };

function parseImportedFile(raw: string): ImportSummary {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { status: 'invalid', reason: 'Ce fichier n’est pas un JSON valide.' };
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    (parsed as { kind?: unknown }).kind !== 'clickdz-erp-backup' ||
    !Array.isArray((parsed as { datasets?: unknown }).datasets)
  ) {
    return {
      status: 'invalid',
      reason:
        'Ce fichier ne ressemble pas à une sauvegarde ClickDz ERP (format non reconnu).',
    };
  }
  const file = parsed as BackupFile;
  return { status: 'ok', file, totalRecords: totalRecords(file.datasets) };
}

/**
 * "Sauvegarde locale" panel: manual JSON export of the key ERP datasets, a
 * read-only import/validation flow, and a silent 24h auto-snapshot kept in
 * localStorage so the owner always has *something* to fall back on even if
 * they never click "Exporter" themselves.
 */
export const LocalBackupPanel = ({ slug }: { slug: string }) => {
  const [exporting, setExporting] = useState(false);
  const [progress, setProgress] = useState<{ label: string; done: number; total: number } | null>(
    null
  );
  const [lastExport, setLastExport] = useState<{ datasets: number; records: number } | null>(
    null
  );
  const [exportError, setExportError] = useState<string | null>(null);

  const [autoSnapshot, setAutoSnapshot] = useState<AutoSnapshot | null>(null);

  const [importSummary, setImportSummary] = useState<ImportSummary | null>(null);
  const [importFileName, setImportFileName] = useState<string | null>(null);

  // Silent 24h auto-snapshot: on mount, if the last one is stale (or absent),
  // fetch the same datasets and stash them — no UI noise on success, the
  // panel just shows the refreshed "dernier instantané" time afterwards.
  useEffect(() => {
    let cancelled = false;
    const existing = readAutoSnapshot(slug);
    if (existing) setAutoSnapshot(existing);
    const stale = !existing || Date.now() - existing.cachedAt > AUTOBACKUP_MAX_AGE_MS;
    if (!stale) return;
    (async () => {
      try {
        const datasets = await collectDatasets(slug);
        if (cancelled) return;
        const file: BackupFile = {
          kind: 'clickdz-erp-backup',
          version: 1,
          slug,
          generatedAt: new Date().toISOString(),
          datasets,
        };
        writeAutoSnapshot(slug, file);
        const fresh = readAutoSnapshot(slug);
        if (fresh) setAutoSnapshot(fresh);
      } catch {
        // Offline or all datasets failed — leave the previous snapshot (if
        // any) as the visible fallback; this is a best-effort convenience.
      }
    })();
    return () => {
      cancelled = true;
    };
    // Re-run only when the shop changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug]);

  const runExport = useCallback(async () => {
    setExporting(true);
    setExportError(null);
    setProgress(null);
    try {
      const datasets = await collectDatasets(slug, (label, done, total) =>
        setProgress({ label, done, total })
      );
      const file: BackupFile = {
        kind: 'clickdz-erp-backup',
        version: 1,
        slug,
        generatedAt: new Date().toISOString(),
        datasets,
      };
      downloadBackupFile(slug, file);
      writeAutoSnapshot(slug, file);
      const fresh = readAutoSnapshot(slug);
      if (fresh) setAutoSnapshot(fresh);
      setLastExport({ datasets: datasets.length, records: totalRecords(datasets) });
    } catch {
      setExportError(
        'Erreur réseau — l’export n’a pas pu être terminé. Réessayez une fois la connexion rétablie.'
      );
    } finally {
      setExporting(false);
      setProgress(null);
    }
  }, [slug]);

  const downloadAutoSnapshot = useCallback(() => {
    if (autoSnapshot) downloadBackupFile(slug, autoSnapshot.file);
  }, [autoSnapshot, slug]);

  const onImportFile = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const input = e.target;
    const f = input.files?.[0];
    if (!f) return;
    setImportFileName(f.name);
    const reader = new FileReader();
    reader.onload = () => {
      const text = typeof reader.result === 'string' ? reader.result : '';
      setImportSummary(parseImportedFile(text));
    };
    reader.onerror = () => {
      setImportSummary({
        status: 'invalid',
        reason: 'Impossible de lire ce fichier.',
      });
    };
    reader.readAsText(f);
    // Allow re-selecting the same file later.
    input.value = '';
  }, []);

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 14,
        borderRadius: 14,
        background: C.panel,
        border: `1px solid ${C.border}`,
        padding: 16,
        boxShadow: '0 1px 3px rgba(0,0,0,0.12)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
        <span
          aria-hidden
          style={{
            width: 36,
            height: 36,
            borderRadius: 11,
            background: 'linear-gradient(135deg, #0f766e, #115e59)',
            display: 'grid',
            placeItems: 'center',
            fontSize: 17,
            flexShrink: 0,
            boxShadow: '0 2px 8px rgba(15, 118, 110, 0.25)',
          }}
        >
          💾
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: C.text }}>
            Sauvegarde locale
          </div>
          <div style={{ fontSize: 12.5, color: C.muted, marginTop: 2, lineHeight: 1.5 }}>
            Exportez vos données ERP (produits, commandes, stock, clients,
            fournisseurs, factures, caisse…) dans un seul fichier gardé sur
            votre machine — utile hors ligne ou en cas de problème serveur.
          </div>
        </div>
      </div>

      {/* Manual export */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <button
            style={btnStyle('primary', exporting)}
            disabled={exporting}
            onClick={() => void runExport()}
          >
            {exporting ? (
              <>
                <Spinner dark /> Export en cours…
              </>
            ) : (
              '⬇ Exporter une sauvegarde'
            )}
          </button>
          {lastExport ? (
            <span style={{ fontSize: 12, color: C.muted }}>
              {lastExport.datasets} jeux de données,{' '}
              {fmtCount(lastExport.records)} enregistrements
            </span>
          ) : null}
        </div>
        {progress && progress.label ? (
          <div style={{ fontSize: 12, color: C.muted }}>
            {progress.label}… ({progress.done + 1}/{progress.total})
          </div>
        ) : null}
        {exportError ? <Banner tone="error">{exportError}</Banner> : null}
      </div>

      {/* Automatic safety snapshot */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '12px 14px',
          borderRadius: 12,
          background: C.panel2,
          border: `1px solid ${C.border}`,
        }}
      >
        <span
          aria-hidden
          style={{
            width: 28,
            height: 28,
            borderRadius: 8,
            background: 'color-mix(in srgb, #0f766e 18%, transparent)',
            display: 'grid',
            placeItems: 'center',
            fontSize: 14,
            flexShrink: 0,
          }}
        >
          🛟
        </span>
        <div style={{ flex: 1, fontSize: 12.5, color: C.text }}>
          {autoSnapshot ? (
            <>
              Dernier instantané automatique : {fmtDateTime(autoSnapshot.cachedAt)}
              {' — '}
              {fmtCount(totalRecords(autoSnapshot.file.datasets))} enregistrements.
            </>
          ) : (
            'Aucun instantané automatique encore disponible pour cette boutique.'
          )}
        </div>
        {autoSnapshot ? (
          <button style={miniBtnStyle('secondary')} onClick={downloadAutoSnapshot}>
            Télécharger
          </button>
        ) : null}
      </div>

      {/* Import / validate (no automated restore) */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
          paddingTop: 6,
          borderTop: `1px solid ${C.border}`,
        }}
      >
        <div style={{ fontSize: 13, fontWeight: 600, color: C.text }}>
          Importer une sauvegarde (vérification uniquement)
        </div>
        <label
          style={{
            ...btnStyle('secondary'),
            display: 'inline-flex',
            width: 'fit-content',
            cursor: 'pointer',
          }}
        >
          Choisir un fichier…
          <input
            type="file"
            accept="application/json"
            onChange={onImportFile}
            style={{ display: 'none' }}
          />
        </label>
        {importFileName ? (
          <div style={{ fontSize: 12, color: C.muted }}>{importFileName}</div>
        ) : null}
        {importSummary ? (
          importSummary.status === 'invalid' ? (
            <Banner tone="error">{importSummary.reason}</Banner>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <Banner tone="info">
                Sauvegarde du {new Date(importSummary.file.generatedAt).toLocaleString('fr-DZ')} pour la
                boutique « {importSummary.file.slug} » —{' '}
                {importSummary.file.datasets.length} jeux de données,{' '}
                {fmtCount(importSummary.totalRecords)} enregistrements :{' '}
                {importSummary.file.datasets
                  .map(d => `${d.label} (${fmtCount(d.records.length)})`)
                  .join(', ')}
                .
              </Banner>
              <Banner tone="warn">
                La restauration automatique n’est pas activée dans cette
                version : réinjecter ces données pourrait écraser des
                commandes, factures ou mouvements de caisse plus récents.
                Contactez le support ou le propriétaire de la boutique pour
                une restauration assistée.
              </Banner>
              <button style={btnStyle('secondary', true)} disabled title="Bientôt disponible">
                Restauration assistée — bientôt disponible
              </button>
            </div>
          )
        ) : null}
      </div>
    </div>
  );
};
