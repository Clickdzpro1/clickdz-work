import { useCallback, useEffect, useState } from 'react';

import { cdzApiUrl } from '@affine/core/blocksuite/ai/provider/ai-provider';

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
// a silent 24h localStorage safety snapshot. DzOS Phase 0 (backup v2) adds a
// NON-DESTRUCTIVE restore: a dry-run diffs the backup against the current
// server state and reports which records are missing; the apply then creates
// ONLY the missing records (never overwrites a newer one) via the bridge's
// restore route. Export now iterates ALL monthly partitions (invoices/caisse
// for the last 36 months), not just the current month.
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
  // DzOS Phase 0 (backup v2): invoices/caisse/compta/movements are stored
  // month-partitioned (invoices-YYYYMM, caisse-YYYYMM, …). The pre-Phase-0
  // export only fetched the CURRENT month, silently losing every past month
  // of legal invoices + caisse entries. Iterate the last BACKUP_MONTH_SPAN
  // months and collect each non-empty partition as its own dataset so a
  // restore can replay them per-month. 36 months covers ~3 years of DZ
  // fiscal records (well beyond the fiscal-document retention requirement).
  const BACKUP_MONTH_SPAN = 36;
  const monthList = ((): string[] => {
    const out: string[] = [];
    const now = new Date();
    for (let i = 0; i < BACKUP_MONTH_SPAN; i++) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      out.push(`${y}${m}`);
    }
    return out;
  })();

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
    // Month-partitioned datasets — ALL months, not just the current one.
    // Each non-empty month becomes its own dataset keyed `invoices-YYYYMM` /
    // `caisse-YYYYMM` so a restore can replay it to the right partition.
    ...monthList.flatMap((month) => [
      {
        label: `Factures ${month.slice(0, 4)}-${month.slice(4)}`,
        key: `invoices-${month}`,
        load: async () => {
          const outcome = await fetchInvoices(slug, { month });
          return outcome.status === 'ok' ? outcome.invoices : [];
        },
      },
      {
        label: `Caisse ${month.slice(0, 4)}-${month.slice(4)}`,
        key: `caisse-${month}`,
        load: async () => {
          const outcome = await fetchCaisse(slug, month);
          return outcome.status === 'ok' ? outcome.entries : [];
        },
      },
    ]),
  ];

  const datasets: BackupDataset[] = [];
  for (let i = 0; i < jobs.length; i++) {
    const job = jobs[i];
    onProgress?.(job.label, i, jobs.length);
    try {
      const records = await job.load();
      // Skip empty month partitions — they add noise without value (a month
      // with no invoices isn't a dataset to restore). Non-partition datasets
      // are kept even when empty so the backup shows it tried.
      if (records.length === 0 && job.key.includes('-')) {
        // month partition with no records: skip
        continue;
      }
      datasets.push({ key: job.key, label: job.label, records });
    } catch {
      // One dataset failing (offline, flag off, route absent) must not abort
      // the whole export — record it as empty rather than losing the rest.
      // (Month partitions that error are skipped like empty ones.)
      if (job.key.includes('-')) continue;
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

// DzOS Phase 0 (backup v2): non-destructive restore. The restore ONLY creates
// records that are MISSING on the server — it never overwrites a newer record.
// This is the safe recovery path for the main restore use case (TTL expiry,
// accidental deletion, bad sync) without the risk of clobbering orders/invoices
// that were created AFTER the backup was taken. A full bidirectional merge is a
// Phase 1 concern (needs the sync engine's LWW + conflict UI).
//
// The dry-run fetches the current server state for each dataset, diffs by id,
// and reports exactly which records would be created. The apply then writes
// each missing record via the public data API PUT (atomic upsert, idempotent —
// a record that re-appears on the server mid-apply is a no-op on conflict).
//
// Dataset key → collection mapping: non-partition datasets use their key as the
// collection name; month-partitioned datasets (invoices-YYYYMM, caisse-YYYYMM)
// use the full key as the collection (the data API accepts partitioned names).
type RestorePlanDataset = {
  key: string;
  label: string;
  totalInBackup: number;
  presentOnServer: number;
  missing: number; // records that would be created
};
type RestorePlan =
  | { status: 'planning' }
  | { status: 'ready'; datasets: RestorePlanDataset[]; totalMissing: number }
  | { status: 'error'; reason: string };

/** Fetch the current server ids for one dataset (for the dry-run diff). */
async function serverIdsForDataset(
  slug: string,
  dataset: BackupDataset
): Promise<Set<string>> {
  // Month-partitioned datasets (invoices-YYYYMM, caisse-YYYYMM) are fetched via
  // their dedicated bridge routes; non-partition via the generic collection GET.
  const isPartition = dataset.key.includes('-');
  let records: unknown[];
  try {
    if (dataset.key.startsWith('invoices-')) {
      const month = dataset.key.split('-')[1];
      const outcome = await fetchInvoices(slug, { month });
      records = outcome.status === 'ok' ? outcome.invoices : [];
    } else if (dataset.key.startsWith('caisse-')) {
      const month = dataset.key.split('-')[1];
      const outcome = await fetchCaisse(slug, month);
      records = outcome.status === 'ok' ? outcome.entries : [];
    } else {
      records = await fetchErpCollection(slug, dataset.key);
    }
  } catch {
    return new Set();
  }
  return new Set(
    records
      .map((r) => String((r as { id?: unknown })?.id ?? ''))
      .filter(Boolean)
  );
}

/** Build a non-destructive restore plan (dry-run): which records are missing. */
async function buildRestorePlan(
  slug: string,
  file: BackupFile,
  onProgress?: (label: string, done: number, total: number) => void
): Promise<RestorePlan> {
  const datasets: RestorePlanDataset[] = [];
  let totalMissing = 0;
  for (let i = 0; i < file.datasets.length; i++) {
    const d = file.datasets[i];
    onProgress?.(d.label, i, file.datasets.length);
    const backupIds = new Set(
      d.records
        .map((r) => String((r as { id?: unknown })?.id ?? ''))
        .filter(Boolean)
    );
    const serverIds = await serverIdsForDataset(slug, d);
    const missing = [...backupIds].filter((id) => !serverIds.has(id)).length;
    datasets.push({
      key: d.key,
      label: d.label,
      totalInBackup: d.records.length,
      presentOnServer: backupIds.size - missing,
      missing,
    });
    totalMissing += missing;
  }
  return { status: 'ready', datasets, totalMissing };
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

  // DzOS Phase 0 (backup v2): non-destructive restore state.
  const [restorePlan, setRestorePlan] = useState<RestorePlan | null>(null);
  const [planning, setPlanning] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [restoreResult, setRestoreResult] = useState<
    | { status: 'done'; created: number; skipped: number; errors: number }
    | { status: 'error'; reason: string }
    | null
  >(null);

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
    // Reset the restore flow when a new file is loaded.
    setRestorePlan(null);
    setRestoreResult(null);
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

  // DzOS Phase 0 (backup v2): dry-run — diff the backup against the current
  // server state and report which records are missing (would be created).
  const runRestoreDryRun = useCallback(async () => {
    if (!importSummary || importSummary.status !== 'ok') return;
    setPlanning(true);
    setRestorePlan({ status: 'planning' });
    setRestoreResult(null);
    try {
      const plan = await buildRestorePlan(slug, importSummary.file, (label, done, total) =>
        setProgress({ label, done, total })
      );
      setRestorePlan(plan);
    } catch {
      setRestorePlan({
        status: 'error',
        reason: 'Erreur réseau — la comparaison avec le serveur a échoué.',
      });
    } finally {
      setPlanning(false);
      setProgress(null);
    }
  }, [importSummary, slug]);

  // DzOS Phase 0 (backup v2): apply — create ONLY the missing records via the
  // public data API PUT (atomic upsert, idempotent). Non-destructive: a record
  // that re-appeared on the server mid-apply is a no-op on conflict. Each
  // missing record is PUT at its backup id; the server preserves createdAt from
  // the backup body and stamps updatedAt.
  const applyRestore = useCallback(async () => {
    if (!importSummary || importSummary.status !== 'ok') return;
    if (!window.confirm(
      'Confirmer la restauration ? Seuls les enregistrements manquants seront créés ' +
      '(aucun enregistrement existant ne sera écrasé).'
    )) return;
    setRestoring(true);
    setRestoreResult(null);
    let created = 0;
    let skipped = 0;
    let errors = 0;
    try {
      for (const d of importSummary.file.datasets) {
        const serverIds = await serverIdsForDataset(slug, d);
        for (const rec of d.records) {
          const id = String((rec as { id?: unknown })?.id ?? '');
          if (!id) { skipped++; continue; }
          if (serverIds.has(id)) { skipped++; continue; }
          try {
            // PUT to the public data API. The slug's dataWriteToken is
            // attached by the bridge on the server side; the studio calls
            // the bridge's restore-safe route OR the public PUT. The public
            // PUT requires the Bearer token — fetch it from the bridge.
            // For Phase 0 we use the bridge's owner-authed passthrough by
            // POSTing to the owner-authed collection create route which
            // re-derives the token server-side. Simpler + token-safe.
            const url = cdzApiUrl(
              `/api/v1/apps/${encodeURIComponent(slug)}/erp/restore/${encodeURIComponent(d.key)}/${encodeURIComponent(id)}`
            );
            const res = await fetch(url, {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
              credentials: 'include',
              body: JSON.stringify(rec),
            });
            if (res.ok) created++;
            else errors++;
          } catch {
            errors++;
          }
        }
      }
      setRestoreResult({ status: 'done', created, skipped, errors });
    } catch {
      setRestoreResult({ status: 'error', reason: 'Erreur réseau pendant la restauration.' });
    } finally {
      setRestoring(false);
    }
  }, [importSummary, slug]);

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
          Importer & restaurer une sauvegarde
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
              {/* DzOS Phase 0 (backup v2): non-destructive restore.
                  The restore ONLY creates records missing on the server —
                  it never overwrites a newer record. Dry-run first. */}
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button
                  style={btnStyle('secondary', planning)}
                  disabled={planning}
                  onClick={() => void runRestoreDryRun()}
                >
                  {planning ? (<><Spinner dark /> Comparaison…</>) : 'Comparer au serveur'}
                </button>
                {restorePlan && restorePlan.status === 'ready' && restorePlan.totalMissing > 0 ? (
                  <button
                    style={btnStyle('primary', restoring)}
                    disabled={restoring}
                    onClick={() => void applyRestore()}
                  >
                    {restoring ? (<><Spinner dark /> Restauration…</>) : `Restaurer ${restorePlan.totalMissing} enregistrement(s) manquant(s)`}
                  </button>
                ) : null}
              </div>
              {restorePlan && restorePlan.status === 'planning' ? (
                <div style={{ fontSize: 12, color: C.muted }}>
                  {progress?.label ? `${progress.label}… (${progress.done + 1}/${progress.total})` : 'Analyse…'}
                </div>
              ) : null}
              {restorePlan && restorePlan.status === 'ready' ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <div style={{ fontSize: 12.5, color: C.text }}>
                    {restorePlan.totalMissing === 0
                      ? '✓ Aucun enregistrement manquant — la boutique est déjà à jour par rapport à cette sauvegarde.'
                      : `${restorePlan.totalMissing} enregistrement(s) manquant(s) seraient créés (aucun écrasement) :`}
                  </div>
                  {restorePlan.totalMissing > 0 ? (
                    <div style={{ fontSize: 12, color: C.muted, lineHeight: 1.6 }}>
                      {restorePlan.datasets
                        .filter(d => d.missing > 0)
                        .map(d => `${d.label}: ${d.missing} manquant(s) / ${d.totalInBackup} dans la sauvegarde`)
                        .join(' · ')}
                    </div>
                  ) : null}
                </div>
              ) : null}
              {restorePlan && restorePlan.status === 'error' ? (
                <Banner tone="error">{restorePlan.reason}</Banner>
              ) : null}
              {restoreResult ? (
                restoreResult.status === 'done' ? (
                  <Banner tone={restoreResult.errors > 0 ? 'warn' : 'ok'}>
                    Restauration terminée : {restoreResult.created} créé(s),{' '}
                    {restoreResult.skipped} déjà présent(s),{' '}
                    {restoreResult.errors} erreur(s).
                  </Banner>
                ) : (
                  <Banner tone="error">{restoreResult.reason}</Banner>
                )
              ) : null}
            </div>
          )
        ) : null}
      </div>
    </div>
  );
};
