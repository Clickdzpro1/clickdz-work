import { useCallback, useMemo, useRef, useState } from 'react';

import {
  CDZIMAGE_TIER_OPTIONS,
  type CdzImageRefMode,
  type CdzImageTier,
  type UseVdzMedia,
  type VdzMediaItem,
} from '../../../../modules/vdz/use-vdz-media';
import { VDZ_MEDIA_DND_MIME, type VdzMediaDragPayload } from './constants';
import * as styles from './media-bin.css';

/** Which source tab is showing. */
type MediaTab = 'upload' | 'ai' | 'stock';

interface MediaBinProps {
  /** The shared media hook (owned by the host so state survives re-renders). */
  media: UseVdzMedia;
  /**
   * Add a bin item to the timeline at the current playhead. The host builds the
   * clip and routes it through the single history apply path.
   */
  onAddToTimeline: (item: VdzMediaItem) => void;
  /** Hide this panel (× in the header strip). */
  onCollapse?: () => void;
}

/** Format a seconds duration as m:ss (empty for 0/unknown). */
function fmtDuration(seconds: number): string {
  if (!seconds || !Number.isFinite(seconds)) return '';
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** Serialize a bin item into the drag payload the timeline understands. */
function toDragPayload(item: VdzMediaItem): VdzMediaDragPayload {
  return {
    kind: item.kind,
    name: item.name,
    url: item.url,
    duration: item.duration,
    blobId: item.blobId,
    mime: item.mime,
  };
}

/**
 * Vdz Studio — Media Bin. Left-side panel with three tabs (Upload / AI images /
 * Stock). Every item that lands here is a usable, displayable piece of media
 * (see {@link useVdzMedia}); items are both draggable to the timeline and
 * clickable ("+" adds them at the playhead).
 */
export function MediaBin({
  media,
  onAddToTimeline,
  onCollapse,
}: MediaBinProps) {
  const [tab, setTab] = useState<MediaTab>('upload');

  return (
    <div className={styles.bin} data-testid="vdz-media-bin">
      <div className={styles.header}>
        <span className={styles.headerDot} />
        <span className={styles.headerTitle}>Media</span>
        <span className={styles.headerSpacer} />
        <span className={styles.headerCount}>{media.items.length}</span>
        {onCollapse ? (
          <button
            type="button"
            className={styles.collapseButton}
            onClick={onCollapse}
            title="Hide Media"
            aria-label="Hide Media"
          >
            ×
          </button>
        ) : null}
      </div>

      <div className={styles.tabs} role="tablist" aria-label="Media source">
        <button
          type="button"
          role="tab"
          className={styles.tab}
          data-active={tab === 'upload'}
          aria-selected={tab === 'upload'}
          onClick={() => setTab('upload')}
        >
          Upload
        </button>
        <button
          type="button"
          role="tab"
          className={styles.tab}
          data-active={tab === 'ai'}
          aria-selected={tab === 'ai'}
          onClick={() => setTab('ai')}
        >
          AI images
        </button>
        <button
          type="button"
          role="tab"
          className={styles.tab}
          data-active={tab === 'stock'}
          aria-selected={tab === 'stock'}
          onClick={() => setTab('stock')}
        >
          Stock
        </button>
      </div>

      <div className={styles.body}>
        {tab === 'upload' ? <UploadTab media={media} /> : null}
        {tab === 'ai' ? <AiImagesTab media={media} /> : null}
        {tab === 'stock' ? <StockTab media={media} /> : null}

        {media.error ? (
          <div className={styles.errorBar}>{media.error}</div>
        ) : null}

        {media.items.length > 0 ? (
          <>
            <div className={styles.sectionLabel}>Bin</div>
            <div className={styles.list}>
              {media.items.map(item => (
                <BinRow
                  key={item.id}
                  item={item}
                  onAdd={() => onAddToTimeline(item)}
                  onRemove={() => media.remove(item.id)}
                />
              ))}
            </div>
          </>
        ) : (
          <div className={styles.emptyHint}>
            Nothing here yet. Upload files, generate AI images, or search stock
            — then drag them onto the timeline (or hit +).
          </div>
        )}
      </div>
    </div>
  );
}

// ---- Upload tab ---------------------------------------------------------
function UploadTab({ media }: { media: UseVdzMedia }) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [dragOver, setDragOver] = useState(false);

  const onPick = useCallback(() => inputRef.current?.click(), []);

  const onInputChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const files = event.target.files;
      if (files && files.length > 0) void media.importFiles(files);
      // Reset so re-selecting the same file fires change again.
      event.target.value = '';
    },
    [media]
  );

  const onDrop = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      setDragOver(false);
      const files = event.dataTransfer?.files;
      if (files && files.length > 0) void media.importFiles(files);
    },
    [media]
  );

  const onDragOver = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    // Only react to real file drags (not bin-item drags).
    if (Array.from(event.dataTransfer.types).includes('Files')) {
      event.preventDefault();
      setDragOver(true);
    }
  }, []);

  return (
    <div
      className={styles.dropZone}
      data-dragover={dragOver}
      role="button"
      tabIndex={0}
      onClick={onPick}
      onKeyDown={e => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onPick();
        }
      }}
      onDragOver={onDragOver}
      onDragLeave={() => setDragOver(false)}
      onDrop={onDrop}
    >
      <span className={styles.dropZoneTitle}>Drop media or click</span>
      <span className={styles.dropZoneHint}>
        Video (≤100MB), audio &amp; images (≤25MB)
      </span>
      <input
        ref={inputRef}
        className={styles.hiddenInput}
        type="file"
        accept="video/*,audio/*,image/*"
        multiple
        onChange={onInputChange}
      />
    </div>
  );
}

// ---- AI images tab ------------------------------------------------------
function AiImagesTab({ media }: { media: UseVdzMedia }) {
  const [prompt, setPrompt] = useState('');
  // CDZIMAGE (WS1 PR4): explicit tier on every generation. Vdz is the ONE
  // surface exposing the 1.0 economy tier (cheap bulk storyboard frames).
  const [tier, setTier] = useState<CdzImageTier>('cdzimage-2.0');
  // Optional bin reference: '' = none; otherwise a bin image item id.
  const [refId, setRefId] = useState('');
  const [refMode, setRefMode] = useState<CdzImageRefMode>('edit');

  const referenceCandidates = media.items.filter(
    item => item.kind === 'image'
  );
  const referenceItem =
    referenceCandidates.find(item => item.id === refId) ?? null;

  const onGenerate = useCallback(() => {
    if (!prompt.trim() || media.busy) return;
    void media.generateImages(prompt, {
      tier,
      reference: referenceItem
        ? { item: referenceItem, mode: refMode }
        : undefined,
    });
  }, [prompt, media, tier, referenceItem, refMode]);

  const selectStyle: React.CSSProperties = {
    flex: 1,
    minWidth: 0,
    height: 28,
    fontSize: 11,
    padding: '0 6px',
    borderRadius: 7,
    border: '1px solid var(--vdz-border, #262a35)',
    background: 'var(--vdz-bg, #0b0d12)',
    color: 'var(--vdz-text, #e6e9f0)',
  };

  return (
    <>
      <div className={styles.searchRow}>
        <input
          className={styles.searchInput}
          placeholder="Describe an image…"
          value={prompt}
          disabled={media.busy}
          onChange={e => {
            setPrompt(e.target.value);
            if (media.error) media.clearError();
          }}
          onKeyDown={e => {
            if (e.key === 'Enter') onGenerate();
          }}
          aria-label="AI image prompt"
        />
        <button
          type="button"
          className={styles.primaryButton}
          onClick={onGenerate}
          disabled={!prompt.trim() || media.busy}
        >
          {media.busy ? '…' : 'Generate'}
        </button>
      </div>

      {/* Model tier + optional reference (edit / inspire). */}
      <div className={styles.searchRow}>
        <select
          style={selectStyle}
          value={tier}
          disabled={media.busy}
          onChange={e => setTier(e.target.value as CdzImageTier)}
          aria-label="Image model"
          title="Which CDZIMAGE model generates this image"
        >
          {CDZIMAGE_TIER_OPTIONS.map(option => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
        <select
          style={selectStyle}
          value={refId}
          disabled={media.busy || referenceCandidates.length === 0}
          onChange={e => setRefId(e.target.value)}
          aria-label="Reference image"
          title="Optionally use a bin image as input"
        >
          <option value="">No reference</option>
          {referenceCandidates.map(item => (
            <option key={item.id} value={item.id}>
              📎 {item.name.slice(0, 28)}
            </option>
          ))}
        </select>
        {referenceItem ? (
          <select
            style={{ ...selectStyle, flex: '0 0 auto', width: 110 }}
            value={refMode}
            disabled={media.busy}
            onChange={e => setRefMode(e.target.value as CdzImageRefMode)}
            aria-label="Reference mode"
            title="Edit the image directly, or use it as inspiration for a new one"
          >
            <option value="edit">✏️ Edit it</option>
            <option value="reinterpret">✨ Inspire</option>
          </select>
        ) : null}
      </div>

      {media.busy ? (
        <div className={styles.status}>Generating image…</div>
      ) : (
        <div className={styles.emptyHint}>
          {referenceItem
            ? refMode === 'edit'
              ? 'The model edits the reference image following your prompt.'
              : 'The model draws inspiration from the reference for a new image.'
            : 'Generated images are added straight to the bin below.'}
        </div>
      )}
    </>
  );
}

// ---- Stock (Unsplash) tab ----------------------------------------------
function StockTab({ media }: { media: UseVdzMedia }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<VdzMediaItem[]>([]);

  const onSearch = useCallback(async () => {
    if (media.busy) return;
    const found = await media.searchStock(query);
    setResults(found);
  }, [query, media]);

  const onPick = useCallback(
    (result: VdzMediaItem) => {
      media.addRemote(result.url, result.kind, 'stock', result.name);
    },
    [media]
  );

  return (
    <>
      <div className={styles.searchRow}>
        <input
          className={styles.searchInput}
          placeholder="Search Unsplash…"
          value={query}
          disabled={media.busy}
          onChange={e => {
            setQuery(e.target.value);
            if (media.error) media.clearError();
          }}
          onKeyDown={e => {
            if (e.key === 'Enter') void onSearch();
          }}
          aria-label="Stock photo search"
        />
        <button
          type="button"
          className={styles.primaryButton}
          onClick={() => void onSearch()}
          disabled={media.busy}
        >
          {media.busy ? '…' : 'Search'}
        </button>
      </div>
      {media.busy ? <div className={styles.status}>Searching…</div> : null}
      {results.length > 0 ? (
        <div className={styles.grid}>
          {results.map(result => (
            <button
              key={result.id}
              type="button"
              className={styles.gridCell}
              onClick={() => onPick(result)}
              title={`Add "${result.name}" to bin`}
            >
              <img
                className={styles.gridImage}
                src={result.thumbnail ?? result.url}
                alt={result.name}
                loading="lazy"
              />
              <span className={styles.gridCellOverlay}>Add to bin</span>
            </button>
          ))}
        </div>
      ) : !media.busy ? (
        <div className={styles.emptyHint}>
          Search Unsplash and click a photo to add it to the bin.
        </div>
      ) : null}
    </>
  );
}

// ---- One bin row --------------------------------------------------------
function BinRow({
  item,
  onAdd,
  onRemove,
}: {
  item: VdzMediaItem;
  onAdd: () => void;
  onRemove: () => void;
}) {
  const onDragStart = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      event.dataTransfer.setData(
        VDZ_MEDIA_DND_MIME,
        JSON.stringify(toDragPayload(item))
      );
      event.dataTransfer.effectAllowed = 'copy';
    },
    [item]
  );

  const badgeClass = useMemo(() => {
    if (item.kind === 'video') return styles.badgeVideo;
    if (item.kind === 'audio') return styles.badgeAudio;
    return styles.badgeImage;
  }, [item.kind]);

  const duration = fmtDuration(item.duration);

  return (
    <div
      className={styles.item}
      draggable
      onDragStart={onDragStart}
      title="Drag onto the timeline, or click + to add at the playhead"
    >
      <div className={styles.thumb}>
        {item.thumbnail ? (
          <img
            className={styles.thumbImage}
            src={item.thumbnail}
            alt={item.name}
            loading="lazy"
          />
        ) : item.kind === 'audio' ? (
          <AudioGlyph />
        ) : (
          <span className={styles.thumbGlyph}>
            {item.kind === 'video' ? '▶' : '▦'}
          </span>
        )}
      </div>

      <div className={styles.itemMeta}>
        <span className={styles.itemName}>{item.name}</span>
        <span className={styles.itemSub}>
          <span className={badgeClass}>{item.kind}</span>
          {duration ? <span>{duration}</span> : null}
        </span>
      </div>

      <div className={styles.itemActions}>
        <button
          type="button"
          className={styles.iconButton}
          onClick={onAdd}
          title="Add to timeline at playhead"
          aria-label="Add to timeline"
        >
          +
        </button>
        <button
          type="button"
          className={styles.removeButton}
          onClick={onRemove}
          title="Remove from bin"
          aria-label="Remove from bin"
        >
          ×
        </button>
      </div>
    </div>
  );
}

/** A tiny static "waveform" glyph for audio thumbnails. */
function AudioGlyph() {
  const heights = [6, 12, 9, 16, 8, 13, 7];
  return (
    <div className={styles.audioWave} aria-hidden="true">
      {heights.map((h, i) => (
        <span key={i} className={styles.audioBar} style={{ height: h }} />
      ))}
    </div>
  );
}
