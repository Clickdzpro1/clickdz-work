import { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';

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
 *
 * Category chips across the top filter the grid; the chip set is DERIVED from
 * the template data (never hardcoded), so adding a template with a new
 * category surfaces its filter automatically. Each card shows a small ratio
 * badge (e.g. 16:9 / 9:16), derived from the template's built canvas size.
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

const ALL = 'All';

/** Greatest common divisor for reducing width:height to a tidy ratio label. */
function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

/**
 * Marketed labels for the studio's canvas presets, so a 2560×1080 cinema
 * canvas badges as "21:9" rather than its literal 64:27 reduction. Keyed by
 * `${width}x${height}`; anything not a known preset falls back to GCD.
 */
const RATIO_LABELS: Record<string, string> = {
  '1920x1080': '16:9',
  '1080x1920': '9:16',
  '1080x1080': '1:1',
  '1080x1350': '4:5',
  '2560x1080': '21:9',
};

/** "1920×1080" → "16:9". Uses a preset label when known, else reduces by GCD. */
function ratioLabel(width: number, height: number): string {
  if (!width || !height) return '';
  const preset = RATIO_LABELS[`${width}x${height}`];
  if (preset) return preset;
  const g = gcd(width, height) || 1;
  return `${Math.round(width / g)}:${Math.round(height / g)}`;
}

export function TemplateGallery({
  open,
  welcome,
  onClose,
  onPick,
  onBlank,
}: TemplateGalleryProps) {
  const [category, setCategory] = useState<string>(ALL);

  // Escape closes (window-level while open; the backdrop click does too).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  // Reopening the gallery starts back on "All".
  useEffect(() => {
    if (open) setCategory(ALL);
  }, [open]);

  const pick = useCallback(
    (template: VdzTemplate) => () => onPick(template.build()),
    [onPick]
  );

  // Ratio badge per template, memoized: build() once to read the canvas size.
  // Builders are pure and cheap; ids are throwaway here (we don't keep them).
  const ratioById = useMemo(() => {
    const map: Record<string, string> = {};
    for (const t of VDZ_TEMPLATES) {
      const tl = t.build();
      map[t.id] = ratioLabel(tl.width, tl.height);
    }
    return map;
  }, []);

  // Category chips derived from the data, in first-seen order, "All" first.
  const categories = useMemo(() => {
    const seen: string[] = [];
    for (const t of VDZ_TEMPLATES) {
      if (!seen.includes(t.category)) seen.push(t.category);
    }
    return [ALL, ...seen];
  }, []);

  const visible = useMemo(
    () =>
      category === ALL
        ? VDZ_TEMPLATES
        : VDZ_TEMPLATES.filter(t => t.category === category),
    [category]
  );

  if (!open || typeof document === 'undefined') return null;

  // Portal to <body> so the fixed backdrop escapes the studio header's
  // containing block (which was clipping this modal to a top strip).
  return createPortal(
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

        <div
          className={styles.filterRow}
          role="tablist"
          aria-label="Filter templates by category"
        >
          {categories.map(cat => {
            const active = cat === category;
            return (
              <button
                key={cat}
                type="button"
                role="tab"
                aria-selected={active}
                className={styles.chip}
                onClick={() => setCategory(cat)}
                style={{
                  color: active ? 'var(--vdz-text, #e6e8ef)' : undefined,
                  borderColor: active
                    ? 'var(--vdz-accent, #5b8cff)'
                    : undefined,
                  background: active
                    ? 'var(--vdz-raised, #171a22)'
                    : 'transparent',
                }}
              >
                {cat}
              </button>
            );
          })}
        </div>

        <div className={styles.grid}>
          {visible.map(template => (
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
                  position: 'relative',
                }}
                aria-hidden="true"
              >
                {template.emoji}
                {ratioById[template.id] ? (
                  <span
                    className={styles.ratioBadge}
                    aria-hidden="true"
                  >
                    {ratioById[template.id]}
                  </span>
                ) : null}
              </div>
              <span className={styles.tplName}>{template.name}</span>
              <span className={styles.tplDesc}>{template.description}</span>
            </button>
          ))}

          {category === ALL ? (
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
          ) : null}
        </div>
      </div>
    </div>,
    document.body
  );
}
