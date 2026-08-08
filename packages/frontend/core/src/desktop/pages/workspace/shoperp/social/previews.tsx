// social/previews.tsx — per-network post preview cards. Pure presentational.

import type { SocialMedia } from './api';
import { C } from '../shoperp-shared';
import { getNetworkMeta } from './api';

interface PreviewProps {
  network: string;
  text: string;
  media: SocialMedia[];
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '...' : s;
}

const mediaThumb = (m: SocialMedia) => (
  <div
    key={m.url}
    style={{
      width: 64,
      height: 64,
      borderRadius: 8,
      overflow: 'hidden',
      background: C.border,
      flexShrink: 0,
    }}
  >
    {m.kind === 'image' ? (
      <img src={m.url} alt={m.alt ?? ''} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
    ) : (
      <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 22 }}>
        {'▶'}
      </div>
    )}
  </div>
);

export const NetworkPreview = ({ network, text, media }: PreviewProps) => {
  const meta = getNetworkMeta(network);
  const label = meta?.label ?? network;
  const icon = meta?.icon ?? network[0].toUpperCase();
  const charLimit = meta?.charLimit ?? 5000;
  const preview = truncate(text, charLimit);
  const over = text.length > charLimit;

  const avatarStyle = {
    width: 32,
    height: 32,
    borderRadius: '50%',
    background: C.accent,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 12,
    fontWeight: 700,
    color: '#fff',
    flexShrink: 0,
  };

  return (
    <div
      style={{
        borderRadius: 12,
        border: `1px solid ${C.border}`,
        background: C.panel,
        padding: 12,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        minWidth: 220,
        maxWidth: 320,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <div style={avatarStyle}>{icon}</div>
        <div>
          <div style={{ fontSize: 12.5, fontWeight: 700, color: C.text }}>{label}</div>
          <div style={{ fontSize: 10.5, color: C.muted }}>Preview</div>
        </div>
      </div>
      {media.length > 0 && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {media.slice(0, 4).map(m => mediaThumb(m))}
        </div>
      )}
      <div style={{ fontSize: 12.5, color: over ? '#c8283a' : C.text, whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 140, overflow: 'hidden' }}>
        {preview || <span style={{ color: C.muted, fontStyle: 'italic' }}>No text yet...</span>}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 6 }}>
        <span style={{ fontSize: 10.5, color: over ? '#c8283a' : C.muted }}>
          {text.length}/{charLimit}
        </span>
      </div>
    </div>
  );
};

interface MultiPreviewProps {
  networks: string[];
  texts: Record<string, string>;
  baseText: string;
  media: SocialMedia[];
}

export const MultiNetworkPreview = ({ networks, texts, baseText, media }: MultiPreviewProps) => {
  if (networks.length === 0) return null;
  return (
    <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
      {networks.map(slug => (
        <NetworkPreview
          key={slug}
          network={slug}
          text={texts[slug] ?? baseText}
          media={media}
        />
      ))}
    </div>
  );
};
