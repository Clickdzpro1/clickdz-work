// social/calendar.tsx — Calendar view (month grid) of scheduled+published posts.
// Click a day to open composer with scheduledAt; click a post to view/reschedule.

import { useCallback, useEffect, useState } from 'react';
import { C, miniBtnStyle, Spinner } from '../shoperp-shared';
import {
  getNetworkMeta,
  listPosts,
  reschedulePost,
  type SocialPostSummary,
} from './api';

interface Props {
  lang: 'fr' | 'ar' | 'en';
  dict: Record<string, string>;
  onNewAtTime: (scheduledAt: number) => void;
  refresh?: number;
}

function daysInMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate();
}

function startDayOfMonth(year: number, month: number): number {
  return new Date(year, month, 1).getDay();
}

const STATUS_COLOR: Record<string, string> = {
  scheduled: '#1e96eb',
  publishing: '#e8a33d',
  published: '#4cae4c',
  partial: '#e8a33d',
  failed: '#c8283a',
  draft: '#9aa0a6',
};

const MONTH_NAMES_FR = [
  'Janvier','Février','Mars','Avril','Mai','Juin',
  'Juillet','Août','Septembre','Octobre','Novembre','Décembre',
];
const MONTH_NAMES_EN = [
  'January','February','March','April','May','June',
  'July','August','September','October','November','December',
];
const MONTH_NAMES_AR = [
  'يناير','فبراير','مارس','أبريل','مايو','يونيو',
  'يوليو','أغسطس','سبتمبر','أكتوبر','نوفمبر','ديسمبر',
];

export const CalendarView = ({ lang, dict, onNewAtTime, refresh }: Props) => {
  const rtl = lang === 'ar';
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth());
  const [posts, setPosts] = useState<SocialPostSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<SocialPostSummary | null>(null);
  const [reschedAt, setReschedAt] = useState('');
  const [reschedBusy, setReschedBusy] = useState(false);
  const [reschedNote, setReschedNote] = useState<string | null>(null);

  const monthNames =
    lang === 'ar' ? MONTH_NAMES_AR : lang === 'fr' ? MONTH_NAMES_FR : MONTH_NAMES_EN;

  const load = useCallback(async () => {
    setLoading(true);
    const from = new Date(year, month, 1).getTime();
    const to = new Date(year, month + 1, 0, 23, 59, 59, 999).getTime();
    try {
      const all = await listPosts({ from, to });
      setPosts(all);
    } catch {
      setPosts([]);
    } finally {
      setLoading(false);
    }
  }, [year, month]);

  useEffect(() => {
    void load();
  }, [load, refresh]);

  const prevMonth = () => {
    if (month === 0) { setYear(y => y - 1); setMonth(11); }
    else setMonth(m => m - 1);
  };
  const nextMonth = () => {
    if (month === 11) { setYear(y => y + 1); setMonth(0); }
    else setMonth(m => m + 1);
  };

  const totalDays = daysInMonth(year, month);
  const startDay = startDayOfMonth(year, month);

  // Build map: day -> posts
  const dayPosts: Record<number, SocialPostSummary[]> = {};
  for (const p of posts) {
    const ts = p.scheduledAt ?? p.publishedAt;
    if (!ts) continue;
    const d = new Date(ts);
    if (d.getFullYear() === year && d.getMonth() === month) {
      const day = d.getDate();
      if (!dayPosts[day]) dayPosts[day] = [];
      dayPosts[day].push(p);
    }
  }

  const handleReschedule = useCallback(async () => {
    if (!selected || !reschedAt) return;
    const epoch = new Date(reschedAt).getTime();
    if (isNaN(epoch) || epoch <= Date.now()) {
      setReschedNote(dict.scheduleFuture ?? 'Doit être dans le futur.');
      return;
    }
    setReschedBusy(true);
    setReschedNote(null);
    try {
      const res = await reschedulePost(selected.id, epoch);
      if (res.ok) {
        setReschedNote(dict.rescheduled ?? 'Replanifié.');
        setSelected(null);
        await load();
      } else {
        setReschedNote(res.error ?? dict.reschedFail ?? 'La replanification a échoué.');
      }
    } catch {
      setReschedNote(dict.reschedFail ?? 'La replanification a échoué.');
    } finally {
      setReschedBusy(false);
    }
  }, [selected, reschedAt, dict, load]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* Month navigation */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <button style={miniBtnStyle('secondary')} onClick={prevMonth}>{'<'}</button>
        <span style={{ fontSize: 14, fontWeight: 700, color: C.text, flex: 1, textAlign: 'center' }}>
          {monthNames[month]} {year}
        </span>
        <button style={miniBtnStyle('secondary')} onClick={nextMonth}>{'>'}</button>
        <button style={miniBtnStyle('secondary')} onClick={() => void load()}>
          {dict.refresh ?? 'Actualiser'}
        </button>
      </div>

      {loading && (
        <div style={{ display: 'flex', gap: 8, color: C.muted }}>
          <Spinner /> {dict.loading ?? 'Chargement…'}
        </div>
      )}

      {/* Calendar grid */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 2 }}>
        {['Dim','Lun','Mar','Mer','Jeu','Ven','Sam'].map(d => (
          <div key={d} style={{ fontSize: 10.5, fontWeight: 700, color: C.muted, textAlign: 'center', padding: '4px 0' }}>
            {d}
          </div>
        ))}
        {/* Empty cells for offset */}
        {Array.from({ length: startDay }).map((_, i) => (
          <div key={'e' + i} />
        ))}
        {/* Day cells */}
        {Array.from({ length: totalDays }, (_, i) => {
          const day = i + 1;
          const dayPost = dayPosts[day] ?? [];
          const isToday = year === now.getFullYear() && month === now.getMonth() && day === now.getDate();
          const epoch = new Date(year, month, day, 9, 0, 0).getTime();
          return (
            <div
              key={day}
              onClick={() => {
                if (dayPost.length === 0) {
                  onNewAtTime(epoch);
                }
              }}
              style={{
                borderRadius: 8,
                border: `1px solid ${isToday ? C.accent : C.border}`,
                background: isToday ? C.accentSoft : C.panel,
                minHeight: 64,
                padding: 6,
                cursor: dayPost.length === 0 ? 'pointer' : 'default',
                display: 'flex',
                flexDirection: 'column',
                gap: 3,
              }}
            >
              <div style={{ fontSize: 11.5, fontWeight: isToday ? 800 : 500, color: isToday ? C.accent : C.text, textAlign: 'right' }}>
                {day}
              </div>
              {dayPost.slice(0, 3).map(p => {
                const meta = p.networks[0] ? getNetworkMeta(p.networks[0]) : undefined;
                return (
                  <div
                    key={p.id}
                    onClick={e => { e.stopPropagation(); setSelected(p); setReschedAt(''); setReschedNote(null); }}
                    style={{
                      fontSize: 9.5,
                      borderRadius: 4,
                      padding: '1px 5px',
                      background: (STATUS_COLOR[p.status] ?? C.accent) + '22',
                      color: STATUS_COLOR[p.status] ?? C.accent,
                      cursor: 'pointer',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                    title={p.text}
                  >
                    {meta?.icon ?? ''} {p.text.slice(0, 18)}...
                  </div>
                );
              })}
              {dayPost.length > 3 && (
                <div style={{ fontSize: 9.5, color: C.muted }}>+{dayPost.length - 3}</div>
              )}
            </div>
          );
        })}
      </div>

      {/* Post detail / reschedule panel */}
      {selected && (
        <div style={{ borderRadius: 12, border: `1px solid ${C.border}`, background: C.panel, padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={{ fontSize: 13, fontWeight: 700, color: C.text }}>{dict.postDetail ?? 'Détail de la publication'}</span>
            <button style={miniBtnStyle('secondary')} onClick={() => setSelected(null)}>
              {dict.close ?? 'Fermer'}
            </button>
          </div>
          <div style={{ fontSize: 12.5, color: C.text, direction: rtl ? 'rtl' : undefined, wordBreak: 'break-word' }}>{selected.text}</div>
          <div style={{ fontSize: 11, color: C.muted }}>
            {dict.networks ?? 'Réseaux :'} {selected.networks.map(s => getNetworkMeta(s)?.label ?? s).join(', ')}
          </div>
          <div style={{ fontSize: 11, color: STATUS_COLOR[selected.status] ?? C.muted }}>
            {dict[`status_${selected.status}`] ?? selected.status}
          </div>
          {(selected.status === 'scheduled' || selected.status === 'draft') && (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <span style={{ fontSize: 11.5, color: C.muted }}>{dict.reschedule ?? 'Replanifier :'}</span>
              <input
                type="datetime-local"
                value={reschedAt}
                onChange={e => setReschedAt(e.target.value)}
                style={{ fontSize: 12, borderRadius: 8, border: `1px solid ${C.border}`, background: C.panel2, color: C.text, padding: '5px 8px' }}
              />
              <button
                onClick={() => void handleReschedule()}
                disabled={reschedBusy || !reschedAt}
                style={{ ...miniBtnStyle('primary'), opacity: (reschedBusy || !reschedAt) ? 0.5 : 1 }}
              >
                {reschedBusy ? '…' : (dict.rescheduleBtn ?? 'Replanifier')}
              </button>
            </div>
          )}
          {reschedNote && <div style={{ fontSize: 11.5, color: C.muted }}>{reschedNote}</div>}
        </div>
      )}
    </div>
  );
};
