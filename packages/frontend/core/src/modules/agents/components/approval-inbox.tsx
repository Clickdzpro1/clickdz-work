// ApprovalInbox — the "à approuver" desk in Hermès' Bureau (R11, WS11-7). A flat
// list of runs paused on a consequential action (backend `waiting_approval`
// runs), each with a one-tap ✓ Approuver / ✗ Refuser. It is the batch cousin of
// the inline ApprovalPrompt (approval-prompt.tsx): same warn palette + ✓/✗
// vocabulary, but a compact row per pending item so the owner clears the queue
// from one place. Pure presentational — Bureau supplies `items` + `onApprove`
// (wraps approveAgentRun) and the `loading` flag; it NEVER fetches.
//
// Shape (contract): `items = { id, runId, title, detail?, at }[]`,
// `onApprove(id, approved: boolean)`. Empty list ⇒ a calm "Rien à approuver"
// (the good state, not an error). Each row locks its buttons the instant a
// decision is tapped (optimistic) so a double-tap can't fire twice; the parent
// removing the item on success is what actually clears the row.
//
// i18n via useAgentLang() (`bureau.approve.*`). RTL-safe (flips for 'ar').

import { useState } from 'react';

import { useAgentLang } from '../i18n';
import { AgentPalette as P, ensureAgentKeyframes } from './palette';

export interface ApprovalInboxItem {
  /** Stable approval id (what `onApprove` echoes back). */
  id: string;
  /** The run this approval belongs to (for the row's "run" caption / linking). */
  runId: string;
  /** Short human title of what needs approval. */
  title: string;
  /** Optional longer detail line (a summary of the pending action). */
  detail?: string;
  /** ms-since-epoch the approval was raised (shown as a relative time). */
  at: number;
}

export interface ApprovalInboxProps {
  items: ApprovalInboxItem[];
  /** Decision handler: `approved` = true for ✓, false for ✗. */
  onApprove: (id: string, approved: boolean) => void;
  loading?: boolean;
}

// Local relative-time formatter using the shared `time.*` keys (same idiom the
// rest of the studio uses). Keeps ApprovalInbox self-contained.
function relTime(t: (k: string, v?: Record<string, string | number>) => string, at: number): string {
  const ms = Date.now() - (Number.isFinite(at) ? at : Date.now());
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return t('time.now');
  const m = Math.floor(s / 60);
  if (m < 60) return t('time.minAgo', { n: m });
  const h = Math.floor(m / 60);
  if (h < 24) return t('time.hrAgo', { n: h });
  const d = Math.floor(h / 24);
  return t('time.dayAgo', { n: d });
}

export function ApprovalInbox({ items, onApprove, loading }: ApprovalInboxProps) {
  ensureAgentKeyframes();
  const { t, dir } = useAgentLang();
  // Track locally-decided ids so a row's buttons lock immediately on tap even
  // before the parent removes the item.
  const [decided, setDecided] = useState<Record<string, 'approve' | 'deny'>>({});

  const decide = (id: string, approved: boolean) => {
    if (decided[id]) return;
    setDecided(prev => ({ ...prev, [id]: approved ? 'approve' : 'deny' }));
    onApprove(id, approved);
  };

  const list = Array.isArray(items) ? items : [];

  const header = (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: P.space.sm,
        marginBottom: P.space.sm,
      }}
    >
      <span
        style={{
          flex: 1,
          minWidth: 0,
          fontSize: P.font.size.xs,
          fontWeight: 700,
          letterSpacing: '0.05em',
          textTransform: 'uppercase',
          color: P.color.muted,
        }}
      >
        {t('bureau.approve.title')}
      </span>
      {list.length > 0 ? (
        <span
          dir="ltr"
          style={{
            fontSize: P.font.size.xs,
            fontWeight: 800,
            fontFamily: P.font.mono,
            color: P.color.warn,
            padding: '0 8px',
            borderRadius: P.radius.pill,
            border: `1px solid ${P.color.warnBorder}`,
            background: P.color.warnBg,
          }}
        >
          {list.length}
        </span>
      ) : null}
    </div>
  );

  // ── Empty (good) state: nothing to approve ────────────────────────────────
  if (list.length === 0) {
    return (
      <div dir={dir}>
        {header}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 8,
            padding: `${P.space.lg}px ${P.space.md}px`,
            borderRadius: P.radius.md,
            border: `1px dashed ${P.color.border}`,
            background: P.color.panelRaised,
            color: P.color.muted,
            fontSize: P.font.size.md,
            opacity: loading ? 0.6 : 1,
          }}
        >
          <span aria-hidden="true" style={{ color: P.color.ok }}>
            ✓
          </span>
          <span>{t('bureau.approve.empty')}</span>
        </div>
      </div>
    );
  }

  return (
    <div dir={dir}>
      {header}
      <div style={{ display: 'flex', flexDirection: 'column', gap: P.space.sm }}>
        {list.map(item => {
          const state = decided[item.id];
          const locked = !!state;
          return (
            <div
              key={item.id}
              className="cdz-agent-fade"
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: P.space.md,
                padding: `${P.space.md}px ${P.space.md}px`,
                borderRadius: P.radius.md,
                border: `1px solid ${P.color.warnBorder}`,
                background: P.color.warnBg,
                opacity: locked ? 0.55 : 1,
                transition: `opacity ${P.motion.base} ${P.motion.ease}`,
                boxSizing: 'border-box',
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'baseline',
                    gap: 8,
                    flexWrap: 'wrap',
                  }}
                >
                  <span
                    style={{
                      fontSize: P.font.size.md,
                      fontWeight: 700,
                      color: P.color.text,
                      minWidth: 0,
                    }}
                  >
                    {item.title || t('bureau.approve.fallbackTitle')}
                  </span>
                  <span
                    dir="ltr"
                    style={{
                      fontSize: P.font.size.xs,
                      color: P.color.muted,
                      fontFamily: P.font.mono,
                    }}
                  >
                    {relTime(t, item.at)}
                  </span>
                </div>
                {item.detail ? (
                  <div
                    style={{
                      marginTop: 3,
                      fontSize: P.font.size.sm,
                      color: P.color.muted,
                      lineHeight: 1.5,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      display: '-webkit-box',
                      WebkitLineClamp: 2,
                      WebkitBoxOrient: 'vertical',
                    }}
                  >
                    {item.detail}
                  </div>
                ) : null}
              </div>

              <div style={{ display: 'flex', gap: 6, flex: '0 0 auto' }}>
                <button
                  type="button"
                  onClick={() => decide(item.id, false)}
                  disabled={locked}
                  aria-label={t('bureau.approve.deny')}
                  title={t('bureau.approve.deny')}
                  className="cdz-agent-motion"
                  style={{
                    appearance: 'none',
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    width: 30,
                    height: 30,
                    borderRadius: P.radius.sm,
                    border: `1px solid ${
                      state === 'deny' ? P.color.errBorder : P.color.border
                    }`,
                    background: state === 'deny' ? P.color.errBg : 'transparent',
                    color: P.color.errText,
                    fontSize: 15,
                    lineHeight: 1,
                    cursor: locked ? 'default' : 'pointer',
                    opacity: locked && state !== 'deny' ? 0.4 : 1,
                  }}
                >
                  ✗
                </button>
                <button
                  type="button"
                  onClick={() => decide(item.id, true)}
                  disabled={locked}
                  aria-label={t('bureau.approve.approve')}
                  title={t('bureau.approve.approve')}
                  className="cdz-agent-motion"
                  style={{
                    appearance: 'none',
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    width: 30,
                    height: 30,
                    borderRadius: P.radius.sm,
                    border: '1px solid transparent',
                    background: state === 'approve' ? P.color.okBg : P.color.ok,
                    color: state === 'approve' ? P.color.okText : P.color.onAccent,
                    fontSize: 15,
                    fontWeight: 700,
                    lineHeight: 1,
                    cursor: locked ? 'default' : 'pointer',
                    opacity: locked && state !== 'approve' ? 0.5 : 1,
                  }}
                >
                  ✓
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default ApprovalInbox;
