import { useCallback, useEffect } from 'react';

import type { VdzTimeline } from '../../../../modules/vdz';
import {
  VDZ_TEMPLATES,
  type VdzTemplate,
} from '../../../../modules/vdz/templates';
import * as styles from './template-gallery.css';

/**
 * Template gallery — also the first-run welcome.
 *
 * A modal grid of prebuilt timelines (plus "Blank project"). Picking one
 * hands a freshly-built `VdzTimeline` to the host, which loads it as a new
 * history baseline exactly like New/Open do. In `welcome` mode the header
 * greets first-time users and shows three quick tips; the gallery itself is
 * identical — learning the studio IS picking a starting point.
 */

interface TemplateGalleryProps {
  open: boolean;
  /** Welcome framing (first run) vs plain "Templates" framing. */
  welcome: boolean;
  onClose: () => void;
  /** Load the picked timeline as a fresh working project. */
  onPick: (timeline: VdzTimeline) => void;
  /** Start from a blank/sample project instead. */
  onBlank: () => void;
}

const TIPS = [
  '⎵ Space plays / pauses',
  '🎞 Drop files straight onto the lanes',
  '🤖 Ask the AI dock to edit for you',
] as const;

export function TemplateGallery({
  open,
  welcome,
  onClose,
  onPick,
  onBlank,
}: TemplateGalleryProps) {
  // Escape closes (window-level while open; the backdrop click does too).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const pick = useCallback(
    (template: VdzTemplate) => () => onPick(template.build()),
    [onPick]
  );

  if (!open) return null;

  return (
    <div
      className={styles.backdrop}
      role="presentation"
      onClick={e => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className={styles.card}
        role="dialog"
        aria-modal="true"
        aria-label={welcome ? 'Welcome to Vdz Studio' : 'Templates'}
      >
        <div className={styles.headRow}>
          <div>
            <div className={styles.title}>
              {welcome ? 'Welcome to Vdz Studio 👋' : 'Start from a template'}
            </div>
            <div className={styles.subtitle}>
              {welcome
                ? 'Pick a starting point — every template is a real, editable timeline with placeholder slots for your media.'
                : 'Templates load as a new unsaved project; your current work is replaced (save it first if it matters).'}
            </div>
          </div>
          <button
            type="button"
            className={styles.closeBtn}
            onClick={onClose}
            title="Close"
            aria-label="Close"
          >
            ×
          </button>
        </div>

        {welcome ? (
          <div className={styles.tipsRow}>
            {TIPS.map(tip => (
              <span key={tip} className={styles.tip}>
                {tip}
              </span>
            ))}
          </div>
        ) : null}

        <div className={styles.grid}>
          {VDZ_TEMPLATES.map(template => (
            <button
              key={template.id}
              type="button"
              className={styles.tplCard}
              onClick={pick(template)}
            >
              <div
                className={styles.thumb}
                style={{
                  background: `linear-gradient(135deg, ${template.accent[0]}, ${template.accent[1]})`,
                }}
                aria-hidden="true"
              >
                {template.emoji}
              </div>
              <span className={styles.tplName}>{template.name}</span>
              <span className={styles.tplDesc}>{template.description}</span>
            </button>
          ))}

          <button
            type="button"
            className={styles.tplCard}
            onClick={onBlank}
          >
            <div
              className={styles.thumb}
              style={{
                background: 'var(--vdz-bg, #0b0d12)',
                border: '1px dashed var(--vdz-border, #262a35)',
              }}
              aria-hidden="true"
            >
              ✚
            </div>
            <span className={styles.tplName}>Blank project</span>
            <span className={styles.tplDesc}>
              The sample timeline — start from scratch.
            </span>
          </button>
        </div>
      </div>
    </div>
  );
}
