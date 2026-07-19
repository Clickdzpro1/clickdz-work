// ThreadSidebar — the conversation history rail. New-thread button, active
// highlight, inline rename (double-click or pencil → text field, Enter commits /
// Esc cancels), delete-with-inline-confirm, loading skeleton, and an empty
// state. Typed against AgentThreadSummary (C2). Pure — all mutations via props.

import { useEffect, useRef, useState } from 'react';

import type { AgentThreadSummary } from '../types';
import { AgentPalette as P, ensureAgentKeyframes } from './palette';
import { IconButton, Spinner } from './primitives';

function relTime(ts: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d`;
  return new Date(ts).toLocaleDateString();
}

function ThreadRow({
  thread,
  active,
  onSelect,
  onRename,
  onDelete,
}: {
  thread: AgentThreadSummary;
  active: boolean;
  onSelect: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [draft, setDraft] = useState(thread.title);
  const [hover, setHover] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  const commit = () => {
    const next = draft.trim();
    if (next && next !== thread.title) onRename(thread.id, next);
    setEditing(false);
  };

  const showActions = hover || active || confirming;

  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 4,
        padding: '2px 4px 2px 8px',
        borderRadius: P.radius.sm,
        background: active ? P.color.accentSoft : 'transparent',
        border: `1px solid ${active ? P.color.accentBorder : 'transparent'}`,
        transition: `background ${P.motion.fast} ${P.motion.ease}`,
        cursor: 'pointer',
      }}
      onMouseOver={e => {
        if (!active) e.currentTarget.style.background = P.color.panelRaised;
      }}
      onMouseOut={e => {
        if (!active) e.currentTarget.style.background = 'transparent';
      }}
    >
      {editing ? (
        <input
          ref={inputRef}
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={e => {
            if (e.key === 'Enter') {
              e.preventDefault();
              commit();
            } else if (e.key === 'Escape') {
              setDraft(thread.title);
              setEditing(false);
            }
          }}
          aria-label="Rename conversation"
          style={{
            flex: 1,
            minWidth: 0,
            appearance: 'none',
            background: P.color.bg,
            border: `1px solid ${P.color.accentBorder}`,
            borderRadius: P.radius.xs,
            color: P.color.text,
            fontSize: P.font.size.md,
            padding: '5px 7px',
            outline: 'none',
          }}
        />
      ) : (
        <button
          type="button"
          onClick={() => onSelect(thread.id)}
          onDoubleClick={() => {
            setDraft(thread.title);
            setEditing(true);
          }}
          aria-current={active ? 'true' : undefined}
          title={thread.title}
          style={{
            appearance: 'none',
            flex: 1,
            minWidth: 0,
            display: 'flex',
            flexDirection: 'column',
            gap: 1,
            padding: '5px 2px',
            background: 'transparent',
            border: 'none',
            cursor: 'pointer',
            textAlign: 'left',
            color: active ? P.color.text : P.color.muted,
            font: 'inherit',
          }}
        >
          <span
            style={{
              fontSize: P.font.size.md,
              fontWeight: active ? 600 : 500,
              color: active ? P.color.text : P.color.text,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {thread.title || 'Untitled'}
          </span>
          <span style={{ fontSize: P.font.size.xs, color: P.color.muted }}>
            {relTime(thread.updatedAt)}
            {thread.messageCount
              ? ` · ${thread.messageCount} msg${thread.messageCount === 1 ? '' : 's'}`
              : ''}
          </span>
        </button>
      )}

      {!editing && showActions ? (
        confirming ? (
          <div
            style={{ display: 'flex', alignItems: 'center', gap: 2 }}
            className="cdz-agent-fade"
          >
            <IconButton
              label="Confirm delete"
              danger
              onClick={e => {
                e.stopPropagation();
                onDelete(thread.id);
              }}
            >
              ✓
            </IconButton>
            <IconButton
              label="Cancel delete"
              onClick={e => {
                e.stopPropagation();
                setConfirming(false);
              }}
            >
              ✕
            </IconButton>
          </div>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', gap: 0 }}>
            <IconButton
              label="Rename conversation"
              onClick={e => {
                e.stopPropagation();
                setDraft(thread.title);
                setEditing(true);
              }}
            >
              ✎
            </IconButton>
            <IconButton
              label="Delete conversation"
              danger
              onClick={e => {
                e.stopPropagation();
                setConfirming(true);
              }}
            >
              🗑
            </IconButton>
          </div>
        )
      ) : null}
    </div>
  );
}

export function ThreadSidebar({
  threads,
  activeId,
  onSelect,
  onNew,
  onRename,
  onDelete,
  loading,
  title,
  width,
}: {
  threads: AgentThreadSummary[];
  activeId?: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
  loading?: boolean;
  title?: string;
  width?: number;
}) {
  ensureAgentKeyframes();
  return (
    <aside
      aria-label={title ?? 'Conversation history'}
      style={{
        width: width ?? 248,
        flex: '0 0 auto',
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
        borderRight: `1px solid ${P.color.border}`,
        background: P.color.bg,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '12px 12px 10px',
        }}
      >
        <span
          style={{
            flex: 1,
            fontSize: P.font.size.sm,
            fontWeight: 700,
            letterSpacing: '0.05em',
            textTransform: 'uppercase',
            color: P.color.muted,
          }}
        >
          {title ?? 'History'}
        </span>
        <button
          type="button"
          onClick={onNew}
          className="cdz-agent-motion"
          aria-label="New conversation"
          style={{
            appearance: 'none',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            padding: '5px 10px',
            borderRadius: P.radius.sm,
            border: `1px solid ${P.color.border}`,
            background: P.color.panel,
            color: P.color.text,
            fontSize: P.font.size.sm,
            fontWeight: 600,
            cursor: 'pointer',
            transition: `background ${P.motion.fast} ${P.motion.ease}`,
          }}
          onMouseEnter={e => {
            e.currentTarget.style.background = P.color.accentSoft;
          }}
          onMouseLeave={e => {
            e.currentTarget.style.background = P.color.panel;
          }}
        >
          <span aria-hidden="true" style={{ fontSize: 14, lineHeight: 1 }}>
            +
          </span>
          New
        </button>
      </div>

      <div
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          padding: '0 8px 12px',
          display: 'flex',
          flexDirection: 'column',
          gap: 2,
        }}
      >
        {loading && threads.length === 0 ? (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '12px 8px',
              color: P.color.muted,
              fontSize: P.font.size.md,
            }}
          >
            <Spinner size={13} />
            Loading…
          </div>
        ) : threads.length === 0 ? (
          <div
            style={{
              padding: '18px 10px',
              color: P.color.muted,
              fontSize: P.font.size.md,
              lineHeight: 1.5,
              textAlign: 'center',
            }}
          >
            No conversations yet.
            <br />
            Start one with <b style={{ color: P.color.text }}>+ New</b>.
          </div>
        ) : (
          threads.map(t => (
            <ThreadRow
              key={t.id}
              thread={t}
              active={t.id === activeId}
              onSelect={onSelect}
              onRename={onRename}
              onDelete={onDelete}
            />
          ))
        )}
      </div>
    </aside>
  );
}
