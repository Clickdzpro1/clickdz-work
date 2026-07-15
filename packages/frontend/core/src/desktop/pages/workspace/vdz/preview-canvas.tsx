import type { VdzClip } from '../../../../modules/vdz';
import { formatTimecode } from './constants';
import * as styles from './index.css';

/** Render a single clip inside the 16:9 preview at the current playhead. */
function PreviewClip({ clip }: { clip: VdzClip }) {
  switch (clip.type) {
    case 'text':
      return (
        <div
          className={styles.previewText}
          style={{
            left: `${(clip.x ?? 0.5) * 100}%`,
            top: `${(clip.y ?? 0.5) * 100}%`,
            fontSize: `${(clip.fontSize ?? 0.08) * 100}cqh`,
            color: clip.color ?? '#fff',
            textAlign: clip.align ?? 'center',
          }}
        >
          {clip.text}
        </div>
      );
    case 'shape':
      return (
        <div
          className={styles.previewLayer}
          style={{
            left: `${(clip.x ?? 0) * 100}%`,
            top: `${(clip.y ?? 0) * 100}%`,
            width: `${(clip.w ?? 1) * 100}%`,
            height: `${(clip.h ?? 1) * 100}%`,
            background: clip.color ?? '#5b8cff',
            borderRadius: clip.shape === 'circle' ? '50%' : 4,
          }}
        />
      );
    case 'image':
      return clip.src ? (
        <img
          className={styles.previewImage}
          src={clip.src}
          alt={clip.name ?? 'image clip'}
          style={{ objectFit: clip.fit ?? 'cover' }}
        />
      ) : (
        <div className={styles.previewImagePlaceholder}>image · empty src</div>
      );
    case 'video': {
      const label = clip.name ?? 'video';
      return (
        <div className={styles.previewVideoBlock}>
          {clip.src ? `▶ ${label}` : `video · ${label}`}
        </div>
      );
    }
    case 'audio':
      // Audio is not visible in the preview.
      return null;
    default:
      return null;
  }
}

interface PreviewCanvasProps {
  /** Clips visible at the current playhead, back-to-front. */
  layers: VdzClip[];
  playheadSeconds: number;
}

/** The 16:9 preview stage: composited layers at the current playhead. */
export function PreviewCanvas({ layers, playheadSeconds }: PreviewCanvasProps) {
  return (
    <div className={styles.previewWrapper}>
      <div className={styles.preview}>
        {layers.length === 0 ? (
          <div className={styles.previewEmpty}>
            no clips at {formatTimecode(playheadSeconds)}
          </div>
        ) : (
          layers.map(clip => <PreviewClip key={clip.id} clip={clip} />)
        )}
      </div>
    </div>
  );
}
