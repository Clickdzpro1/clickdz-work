/**
 * DzOS ERP local-first store — SyncStatusPill UI.
 *
 * A persistent pill shown in the DzOS dashboard header: 「synchronisé · X en
 * attente · hors ligne」. It reads the SyncEngine's status + the live outbox
 * pending count. Never a blocking error — it's informational.
 *
 * Styled to match the DzOS dark palette (mirrors shoperp-shared's C tokens).
 */

import { useEffect, useState } from 'react';

import { getSyncEngine } from './sync';
import type { SyncStatus } from './types';

const PILL_STYLES: Record<SyncStatus['state'], { bg: string; border: string; color: string; label: string; dot: string }> = {
  synced: { bg: 'rgba(34,197,94,0.14)', border: 'rgba(34,197,94,0.35)', color: '#bbf7d0', label: 'Synchronisé', dot: '#22c55e' },
  pending: { bg: 'rgba(234,179,8,0.14)', border: 'rgba(234,179,8,0.35)', color: '#fde68a', label: 'en attente', dot: '#eab308' },
  pushing: { bg: 'rgba(59,130,246,0.14)', border: 'rgba(59,130,246,0.35)', color: '#bfdbfe', label: 'Envoi…', dot: '#3b82f6' },
  pulling: { bg: 'rgba(59,130,246,0.14)', border: 'rgba(59,130,246,0.35)', color: '#bfdbfe', label: 'Sync…', dot: '#3b82f6' },
  offline: { bg: 'rgba(148,163,184,0.14)', border: 'rgba(148,163,184,0.35)', color: '#cbd5e1', label: 'Hors ligne', dot: '#94a3b8' },
  error: { bg: 'rgba(239,68,68,0.14)', border: 'rgba(239,68,68,0.35)', color: '#fecaca', label: 'Erreur sync', dot: '#ef4444' },
};

/**
 * The sync pill. Mount once per open shop (the dashboard header). Reads the
 * engine's status live; shows the pending count when > 0.
 */
export const SyncStatusPill = ({ slug }: { slug: string }) => {
  const [status, setStatus] = useState<SyncStatus>({ state: 'synced' });

  useEffect(() => {
    let unsubscribe: (() => void) | undefined;
    let alive = true;
    // Phase 5 error-shield: getSyncEngine can reject if the repo can't be
    // created (storage backend broken). The pill must stay visible in its
    // default 'synced' state rather than crashing the dashboard header.
    void getSyncEngine(slug)
      .then((engine) => {
        if (!alive) return;
        unsubscribe = engine.onStatus(setStatus);
      })
      .catch((err) => {
        console.error('[dzos-store] SyncStatusPill: getSyncEngine failed', slug, err);
        // Keep the default 'synced' status — the pill is informational, never blocking.
      });
    return () => {
      alive = false;
      unsubscribe?.();
    };
  }, [slug]);

  // Phase 5 error-shield: if the status state is somehow an unexpected value
  // (shouldn't happen with the typed SyncStatus, but defense-in-depth), fall
  // back to the 'synced' style so the pill always renders.
  const style = PILL_STYLES[status.state] ?? PILL_STYLES.synced;
  const count = status.state === 'pending' ? status.count : 0;
  const label =
    status.state === 'pending'
      ? `${count} en attente`
      : status.state === 'error'
        ? `${style.label}${status.message ? ` · ${status.message}` : ''}`
        : style.label;

  return (
    <span
      title={`DzOS sync — ${status.state}`}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '3px 10px',
        borderRadius: 999,
        fontSize: 11.5,
        fontWeight: 600,
        background: style.bg,
        border: `1px solid ${style.border}`,
        color: style.color,
        whiteSpace: 'nowrap',
        userSelect: 'none',
      }}
    >
      <span
        aria-hidden
        style={{
          width: 7,
          height: 7,
          borderRadius: '50%',
          background: style.dot,
          flexShrink: 0,
          boxShadow: status.state === 'pushing' || status.state === 'pulling' ? `0 0 0 0 ${style.dot}40` : 'none',
        }}
      />
      {label}
    </span>
  );
};
