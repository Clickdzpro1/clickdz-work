// social/queue.tsx — Posts/queue list filtered by status.
// Handles retry, edit (opens composer), delete.

import { useCallback, useEffect, useState } from 'react';
import { C, miniBtnStyle, Spinner } from '../shoperp-shared';
import {
  approvePost,
  deletePost,
  getNetworkMeta,
  listPosts,
  retryPost,
  type SocialPost,
  type SocialPostSummary,
  type SocialStatus,
} from './api';

interface Props {
  lang: 'fr' | 'ar' | 'en';
  dict: Record<string, string>;
  onEdit: (post: SocialPost) => void;
  refresh?: number;
}

const STATUS_TABS: Array<SocialStatus | 'all'> = [
  'all',
  'draft',
  'pending-approval',
  'scheduled',
  'publishing',
  'published',
  'partial',
  'failed',
];

function fmtTime(ms?: number): string {
  if (!ms) return '-';
  return new Date(ms).toLocaleString();
}

const statusColor: Record<string, string> = {
  draft: '#9aa0a6',
  'pending-approval': '#a855f7',
  scheduled: '#1e96eb',
  publishing: '#e8a33d',
  published: '#4cae4c',
  partial: '#e8a33d',
  failed: '#c8283a',
};

export const QueueView = ({ lang, dict, onEdit, refresh }: Props) => {
  const rtl = lang === 'ar';
  const [filter, setFilter] = useState<SocialStatus | 'all'>('all');
  const [posts, setPosts] = useState<SocialPostSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<Record<string, 'retry' | 'delete' | 'approve'>>({});
  const [note, setNote] = useState<{ id: string; text: string; tone: 'ok' | 'err' } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const all = await listPosts(filter !== 'all' ? { status: filter } : undefined);
      setPosts(all);
    } catch {
      setPosts([]);
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => {
    void load();
  }, [load, refresh]);

  const handleRetry = useCallback(async (id: string) => {
    setBusy(b => ({ ...b, [id]: 'retry' }));
    setNote(null);
    try {
      const res = await retryPost(id);
      if (res.ok) {
        setNote({ id, text: dict.retryStarted ?? 'Nouvelle tentative lancée.', tone: 'ok' });
        await load();
      } else {
        setNote({ id, text: res.error ?? dict.retryFail ?? 'La nouvelle tentative a échoué.', tone: 'err' });
      }
    } catch {
      setNote({ id, text: dict.retryFail ?? 'La nouvelle tentative a échoué.', tone: 'err' });
    } finally {
      setBusy(b => { const n = { ...b }; delete n[id]; return n; });
    }
  }, [dict, load]);

  // UP1 — approve a pending-approval post (publish now or enqueue schedule).
  const handleApprove = useCallback(async (id: string) => {
    setBusy(b => ({ ...b, [id]: 'approve' }));
    setNote(null);
    try {
      const res = await approvePost(id);
      if (res.ok) {
        setNote({ id, text: dict.approved ?? 'Approuvé.', tone: 'ok' });
        await load();
      } else {
        setNote({ id, text: res.detail ?? res.error ?? dict.approveFail ?? "L'approbation a échoué.", tone: 'err' });
      }
    } catch {
      setNote({ id, text: dict.approveFail ?? "L'approbation a échoué.", tone: 'err' });
    } finally {
      setBusy(b => { const n = { ...b }; delete n[id]; return n; });
    }
  }, [dict, load]);

  const handleDelete = useCallback(async (id: string) => {
    if (!window.confirm(dict.confirmDelete ?? 'Supprimer cette publication ?')) return;
    setBusy(b => ({ ...b, [id]: 'delete' }));
    setNote(null);
    try {
      const ok = await deletePost(id);
      if (ok) {
        await load();
      } else {
        setNote({ id, text: dict.deleteFail ?? 'La suppression a échoué.', tone: 'err' });
      }
    } catch {
      setNote({ id, text: dict.deleteFail ?? 'La suppression a échoué.', tone: 'err' });
    } finally {
      setBusy(b => { const n = { ...b }; delete n[id]; return n; });
    }
  }, [dict, load]);

  const handleEdit = useCallback(async (id: string) => {
    // Fetch the full post then open composer
    const { getPost } = await import('./api');
    const res = await getPost(id);
    if (res.ok && res.post) onEdit(res.post);
  }, [onEdit]);

  const tabStyle = (t: string) => ({
    fontSize: 11.5,
    fontWeight: filter === t ? 700 : 500,
    padding: '4px 10px',
    borderRadius: 8,
    border: 'none',
    cursor: 'pointer',
    background: filter === t ? C.accent : 'transparent',
    color: filter === t ? '#fff' : C.muted,
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        {STATUS_TABS.map(s => (
          <button key={s} style={tabStyle(s)} onClick={() => setFilter(s)}>
            {dict[`status_${s}`] ?? s}
          </button>
        ))}
        <button style={{ ...miniBtnStyle('secondary'), marginLeft: 'auto' }} onClick={() => void load()}>
          {dict.refresh ?? 'Actualiser'}
        </button>
      </div>

      {loading ? (
        <div style={{ display: 'flex', gap: 8, color: C.muted, padding: '20px 0' }}>
          <Spinner /> {dict.loading ?? 'Chargement…'}
        </div>
      ) : posts.length === 0 ? (
        <div style={{ color: C.muted, fontSize: 13, padding: '20px 0' }}>
          {dict.noPostsFilter ?? 'Aucune publication ne correspond à ce filtre.'}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {posts.map(p => {
            const myNote = note?.id === p.id ? note : null;
            const isBusy = !!busy[p.id];
            const canRetry = p.status === 'failed' || p.status === 'partial';
            const canEdit = p.status === 'draft' || p.status === 'scheduled' || p.status === 'pending-approval';
            const canApprove = p.status === 'pending-approval';
            return (
              <div
                key={p.id}
                style={{
                  borderRadius: 10,
                  border: `1px solid ${C.border}`,
                  background: C.panel,
                  padding: '12px 14px',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 6,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                  <span
                    style={{
                      fontSize: 10.5,
                      fontWeight: 700,
                      padding: '2px 8px',
                      borderRadius: 999,
                      background: statusColor[p.status] + '22',
                      color: statusColor[p.status] ?? C.muted,
                      flexShrink: 0,
                    }}
                  >
                    {dict[`status_${p.status}`] ?? p.status}
                  </span>
                  <div style={{ flex: 1, fontSize: 12.5, color: C.text, wordBreak: 'break-word', direction: rtl ? 'rtl' : undefined }}>
                    {p.text}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', fontSize: 11, color: C.muted }}>
                  {p.networks.map(slug => {
                    const meta = getNetworkMeta(slug);
                    return (
                      <span key={slug} style={{ padding: '1px 6px', borderRadius: 6, background: C.panel2 }}>
                        {meta?.icon ?? slug[0].toUpperCase()} {meta?.label ?? slug}
                      </span>
                    );
                  })}
                  {p.scheduledAt && (
                    <span>{dict.scheduledAt ?? 'Planifié :'} {fmtTime(p.scheduledAt)}</span>
                  )}
                  {p.publishedAt && (
                    <span>{dict.publishedAt ?? 'Publié :'} {fmtTime(p.publishedAt)}</span>
                  )}
                  {p.hasMedia && (
                    <span>{dict.hasMedia ?? 'Contient un média'}</span>
                  )}
                </div>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {canApprove && (
                    <button
                      disabled={isBusy}
                      onClick={() => void handleApprove(p.id)}
                      style={{ ...miniBtnStyle('primary'), opacity: isBusy ? 0.5 : 1 }}
                    >
                      {busy[p.id] === 'approve' ? (dict.approving ?? 'Approbation…') : (dict.approve ?? 'Approuver')}
                    </button>
                  )}
                  {canEdit && (
                    <button
                      disabled={isBusy}
                      onClick={() => void handleEdit(p.id)}
                      style={{ ...miniBtnStyle('secondary'), opacity: isBusy ? 0.5 : 1 }}
                    >
                      {dict.edit ?? 'Modifier'}
                    </button>
                  )}
                  {canRetry && (
                    <button
                      disabled={isBusy}
                      onClick={() => void handleRetry(p.id)}
                      style={{ ...miniBtnStyle('secondary'), opacity: isBusy ? 0.5 : 1 }}
                    >
                      {busy[p.id] === 'retry' ? (dict.retrying ?? 'Nouvelle tentative…') : (dict.retry ?? 'Réessayer')}
                    </button>
                  )}
                  <button
                    disabled={isBusy}
                    onClick={() => void handleDelete(p.id)}
                    style={{
                      fontSize: 11.5,
                      fontWeight: 600,
                      padding: '5px 12px',
                      borderRadius: 8,
                      border: `1px solid #c8283a55`,
                      background: '#c8283a11',
                      color: '#c8283a',
                      cursor: 'pointer',
                      opacity: isBusy ? 0.5 : 1,
                    }}
                  >
                    {busy[p.id] === 'delete' ? '…' : (dict.delete ?? 'Supprimer')}
                  </button>
                </div>
                {myNote && (
                  <div style={{ fontSize: 11, color: myNote.tone === 'ok' ? C.okText : '#c8283a' }}>{myNote.text}</div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
