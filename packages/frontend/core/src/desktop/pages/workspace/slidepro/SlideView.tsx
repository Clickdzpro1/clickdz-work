// SlidePro — the single-slide renderer. ONE component draws a slide for the
// editor preview, present mode, and the print sheet, so what you edit is what
// you present is what you export. It renders onto a fixed 16:9 logical canvas
// (BASE_W×BASE_H) and is scaled by the caller via a CSS transform, which keeps
// type sizing + spacing perfectly proportional at any display size.

import { type CSSProperties, useLayoutEffect, useRef, useState } from 'react';

import { getTheme, type SlideTheme } from './themes';
import type { Slide } from './types';

// Logical slide canvas (16:9). All internal sizing is in these px; scaling is
// applied by the wrapper so the numbers below are resolution-independent.
export const BASE_W = 1280;
export const BASE_H = 720;

const PAD = 88; // outer slide padding

function bulletList(
  bullets: string[],
  theme: SlideTheme,
  opts: { size?: number; gap?: number } = {}
) {
  const size = opts.size ?? 30;
  const gap = opts.gap ?? 20;
  return (
    <ul
      style={{
        listStyle: 'none',
        margin: 0,
        padding: 0,
        display: 'flex',
        flexDirection: 'column',
        gap,
      }}
    >
      {bullets.map((b, i) => (
        <li
          key={i}
          style={{
            position: 'relative',
            paddingLeft: 34,
            fontSize: size,
            lineHeight: 1.35,
            color: theme.fg,
            fontFamily: theme.bodyFont,
          }}
        >
          <span
            aria-hidden
            style={{
              position: 'absolute',
              left: 0,
              top: '0.62em',
              width: 12,
              height: 12,
              borderRadius: 3,
              transform: 'translateY(-50%) rotate(45deg)',
              background: theme.accent,
            }}
          />
          {b}
        </li>
      ))}
    </ul>
  );
}

/** The kicker/eyebrow accent bar above a section title. */
function kicker(theme: SlideTheme) {
  return (
    <span
      aria-hidden
      style={{
        display: 'block',
        width: 64,
        height: 5,
        borderRadius: 3,
        background: theme.accent,
        marginBottom: 26,
      }}
    />
  );
}

function renderBody(slide: Slide, theme: SlideTheme) {
  switch (slide.layout) {
    case 'title':
      return (
        <div
          style={{
            height: '100%',
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'center',
          }}
        >
          {kicker(theme)}
          <h1
            style={{
              margin: 0,
              fontSize: 72,
              lineHeight: 1.05,
              fontWeight: 800,
              letterSpacing: '-0.02em',
              color: theme.fg,
              fontFamily: theme.headingFont,
            }}
          >
            {slide.title || 'Titre de la présentation'}
          </h1>
          {slide.bullets[0] ? (
            <p
              style={{
                margin: '28px 0 0',
                fontSize: 32,
                lineHeight: 1.4,
                color: theme.muted,
                fontFamily: theme.bodyFont,
                maxWidth: '80%',
              }}
            >
              {slide.bullets[0]}
            </p>
          ) : null}
        </div>
      );

    case 'quote':
      return (
        <div
          style={{
            height: '100%',
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'center',
          }}
        >
          <div
            style={{
              borderLeft: `6px solid ${theme.accent}`,
              paddingLeft: 40,
            }}
          >
            <p
              style={{
                margin: 0,
                fontSize: 52,
                lineHeight: 1.25,
                fontWeight: 600,
                fontStyle: 'italic',
                color: theme.fg,
                fontFamily: theme.headingFont,
              }}
            >
              {slide.bullets[0] || slide.title || '« Citation »'}
            </p>
            {slide.notes ? (
              <p
                style={{
                  margin: '30px 0 0',
                  fontSize: 26,
                  color: theme.muted,
                  fontFamily: theme.bodyFont,
                }}
              >
                — {slide.notes.split('\n')[0]}
              </p>
            ) : null}
          </div>
        </div>
      );

    case 'two-column': {
      const left = slide.bullets;
      const right = slide.bulletsRight;
      return (
        <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
          {slide.title ? titleBlock(slide.title, theme) : null}
          <div
            style={{
              flex: 1,
              display: 'grid',
              gridTemplateColumns: '1fr 1fr',
              gap: 48,
              alignItems: 'start',
            }}
          >
            <div
              style={{
                background: theme.surface,
                borderRadius: 18,
                padding: '32px 34px',
                height: '100%',
                boxSizing: 'border-box',
              }}
            >
              {bulletList(left, theme, { size: 27, gap: 18 })}
            </div>
            <div
              style={{
                background: theme.surface,
                borderRadius: 18,
                padding: '32px 34px',
                height: '100%',
                boxSizing: 'border-box',
              }}
            >
              {bulletList(right, theme, { size: 27, gap: 18 })}
            </div>
          </div>
        </div>
      );
    }

    case 'image-text':
      return (
        <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
          {slide.title ? titleBlock(slide.title, theme) : null}
          <div
            style={{
              flex: 1,
              display: 'grid',
              gridTemplateColumns: '1fr 1fr',
              gap: 48,
              alignItems: 'center',
              minHeight: 0,
            }}
          >
            <div>{bulletList(slide.bullets, theme, { size: 28, gap: 18 })}</div>
            <div
              style={{
                height: '100%',
                borderRadius: 18,
                overflow: 'hidden',
                background: theme.surface,
                border: `1px solid ${theme.line}`,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              {slide.imageUrl ? (
                <img
                  src={slide.imageUrl}
                  alt={slide.title || 'Illustration'}
                  style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                  crossOrigin="anonymous"
                />
              ) : (
                <span
                  style={{
                    color: theme.muted,
                    fontSize: 22,
                    fontFamily: theme.bodyFont,
                    padding: 24,
                    textAlign: 'center',
                  }}
                >
                  {slide.imagePrompt
                    ? 'Image à générer'
                    : 'Aucune image'}
                </span>
              )}
            </div>
          </div>
        </div>
      );

    case 'title-bullets':
    default:
      return (
        <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
          {titleBlock(slide.title || 'Titre de la diapositive', theme)}
          <div style={{ flex: 1 }}>
            {bulletList(slide.bullets, theme, { size: 31, gap: 22 })}
          </div>
        </div>
      );
  }

  function titleBlock(text: string, t: SlideTheme) {
    return (
      <div style={{ marginBottom: 40 }}>
        {kicker(t)}
        <h2
          style={{
            margin: 0,
            fontSize: 48,
            lineHeight: 1.1,
            fontWeight: 800,
            letterSpacing: '-0.015em',
            color: t.fg,
            fontFamily: t.headingFont,
          }}
        >
          {text}
        </h2>
      </div>
    );
  }
}

export interface SlideViewProps {
  slide: Slide;
  themeId: string;
  /** Displayed width in px; height is derived to keep 16:9. */
  width: number;
  /** 1-based page number for the footer (0 hides the footer). */
  pageNumber?: number;
  /** Total slides, for the "3 / 12" footer. */
  totalPages?: number;
  /** Deck title shown small in the footer (optional). */
  footerLabel?: string;
}

/**
 * A single slide, drawn on the logical canvas and scaled down (or up) to
 * `width`. The outer box reserves the exact scaled height so it participates in
 * normal layout (no absolute overlaps in lists/grids).
 */
export function SlideView({
  slide,
  themeId,
  width,
  pageNumber = 0,
  totalPages = 0,
  footerLabel,
}: SlideViewProps) {
  const theme = getTheme(themeId);
  const scale = width / BASE_W;
  const height = BASE_H * scale;

  const canvasStyle: CSSProperties = {
    position: 'absolute',
    top: 0,
    left: 0,
    width: BASE_W,
    height: BASE_H,
    transform: `scale(${scale})`,
    transformOrigin: 'top left',
    background: theme.bg,
    color: theme.fg,
    boxSizing: 'border-box',
    padding: PAD,
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
  };

  return (
    <div
      style={{
        position: 'relative',
        width,
        height,
        borderRadius: Math.max(6, 14 * scale),
        overflow: 'hidden',
        boxShadow: '0 1px 4px rgba(0,0,0,0.25)',
      }}
    >
      <div style={canvasStyle}>
        <div style={{ flex: 1, minHeight: 0 }}>{renderBody(slide, theme)}</div>
        {pageNumber > 0 ? (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              paddingTop: 20,
              fontSize: 20,
              color: theme.muted,
              fontFamily: theme.bodyFont,
              borderTop: `1px solid ${theme.line}`,
            }}
          >
            <span
              style={{
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                maxWidth: '70%',
              }}
            >
              {footerLabel || ''}
            </span>
            <span>
              {pageNumber}
              {totalPages ? ` / ${totalPages}` : ''}
            </span>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * A slide that auto-fits the width of its parent element (used by the editor's
 * main preview + present mode). Observes the container and re-renders SlideView
 * at the measured width so the slide always fills the available space at 16:9.
 */
export function ResponsiveSlide(
  props: Omit<SlideViewProps, 'width'> & { maxWidth?: number }
) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const avail = el.clientWidth;
      const cap = props.maxWidth ?? Infinity;
      setWidth(Math.min(avail, cap));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [props.maxWidth]);

  return (
    <div ref={ref} style={{ width: '100%', display: 'flex', justifyContent: 'center' }}>
      {width > 0 ? <SlideView {...props} width={width} /> : null}
    </div>
  );
}
