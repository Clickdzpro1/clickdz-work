// SlidePro — fullscreen present overlay. Renders the current slide edge-to-edge
// on a black backdrop with keyboard navigation (←/→/Space/Home/End), Escape to
// exit, a slide counter, prev/next click zones, and an auto-hiding control bar.
// Requests the browser Fullscreen API on mount (best-effort) and releases it on
// exit. Purely a viewer — it never mutates the deck.

import { useCallback, useEffect, useRef, useState } from 'react';

import { ResponsiveSlide } from './SlideView';
import type { Deck } from './types';

export interface PresentModeProps {
  deck: Deck;
  /** Index to start on. */
  startIndex?: number;
  onExit: () => void;
}

export function PresentMode({ deck, startIndex = 0, onExit }: PresentModeProps) {
  const [index, setIndex] = useState(
    Math.min(Math.max(0, startIndex), Math.max(0, deck.slides.length - 1))
  );
  const [controlsVisible, setControlsVisible] = useState(true);
  const [showNotes, setShowNotes] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const total = deck.slides.length;
  const clamp = useCallback(
    (n: number) => Math.min(Math.max(0, n), Math.max(0, total - 1)),
    [total]
  );
  const next = useCallback(() => setIndex(i => clamp(i + 1)), [clamp]);
  const prev = useCallback(() => setIndex(i => clamp(i - 1)), [clamp]);

  // Enter fullscreen on mount (best-effort — some browsers require the click
  // that opened present mode to count as a user gesture, which it does here).
  useEffect(() => {
    const el = rootRef.current;
    if (el && el.requestFullscreen) {
      el.requestFullscreen().catch(() => {
        /* fullscreen denied — the overlay still covers the viewport */
      });
    }
    return () => {
      if (document.fullscreenElement) {
        document.exitFullscreen?.().catch(() => {});
      }
    };
  }, []);

  // Exiting fullscreen (e.g. the user hits the browser's own Esc) closes present
  // mode so we never get stuck in a windowed overlay with no chrome.
  useEffect(() => {
    const onFsChange = () => {
      if (!document.fullscreenElement) onExit();
    };
    document.addEventListener('fullscreenchange', onFsChange);
    return () => document.removeEventListener('fullscreenchange', onFsChange);
  }, [onExit]);

  // Keyboard navigation.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      switch (e.key) {
        case 'ArrowRight':
        case 'PageDown':
        case ' ':
          e.preventDefault();
          next();
          break;
        case 'ArrowLeft':
        case 'PageUp':
          e.preventDefault();
          prev();
          break;
        case 'Home':
          e.preventDefault();
          setIndex(0);
          break;
        case 'End':
          e.preventDefault();
          setIndex(total - 1);
          break;
        case 'Escape':
          e.preventDefault();
          onExit();
          break;
        case 'n':
        case 'N':
          setShowNotes(s => !s);
          break;
        default:
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [next, prev, onExit, total]);

  // Auto-hide the control bar after inactivity; reveal on mouse move.
  const pokeControls = useCallback(() => {
    setControlsVisible(true);
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setControlsVisible(false), 2600);
  }, []);
  useEffect(() => {
    pokeControls();
    return () => {
      if (hideTimer.current) clearTimeout(hideTimer.current);
    };
  }, [pokeControls, index]);

  const slide = deck.slides[index];
  if (!slide) {
    // Empty deck — nothing to present.
    return (
      <div
        ref={rootRef}
        style={overlayStyle}
        onClick={onExit}
        role="button"
        tabIndex={0}
      >
        <div style={{ color: '#fff', fontSize: 18 }}>
          Aucune diapositive à présenter.
        </div>
      </div>
    );
  }

  return (
    <div
      ref={rootRef}
      style={overlayStyle}
      onMouseMove={pokeControls}
      aria-label="Mode présentation"
    >
      {/* Click zones: left third = prev, right two-thirds = next. */}
      <button
        aria-label="Diapositive précédente"
        onClick={prev}
        style={{
          ...zoneStyle,
          left: 0,
          width: '30%',
          cursor: index > 0 ? 'w-resize' : 'default',
        }}
      />
      <button
        aria-label="Diapositive suivante"
        onClick={next}
        style={{
          ...zoneStyle,
          right: 0,
          width: '70%',
          cursor: index < total - 1 ? 'e-resize' : 'default',
        }}
      />

      {/* Slide, centred, filling the viewport at 16:9. */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '3vh 3vw',
          pointerEvents: 'none',
        }}
      >
        <div style={{ width: '100%', maxWidth: '92vw' }}>
          <ResponsiveSlide
            slide={slide}
            themeId={deck.themeId}
            maxWidth={Math.min(window.innerWidth * 0.92, window.innerHeight * 1.6)}
          />
        </div>
        {showNotes && slide.notes ? (
          <div
            style={{
              marginTop: 16,
              maxWidth: '80vw',
              maxHeight: '18vh',
              overflow: 'auto',
              background: 'rgba(0,0,0,0.6)',
              border: '1px solid rgba(255,255,255,0.15)',
              borderRadius: 10,
              padding: '12px 16px',
              color: '#e6e6e6',
              fontSize: 15,
              lineHeight: 1.5,
              pointerEvents: 'auto',
            }}
          >
            {slide.notes}
          </div>
        ) : null}
      </div>

      {/* Control bar (auto-hides). */}
      <div
        style={{
          position: 'absolute',
          bottom: 0,
          left: 0,
          right: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 14,
          padding: '14px 18px',
          background: 'linear-gradient(0deg, rgba(0,0,0,0.55), transparent)',
          opacity: controlsVisible ? 1 : 0,
          transition: 'opacity 240ms ease',
          pointerEvents: controlsVisible ? 'auto' : 'none',
        }}
      >
        <button style={ctrlBtn} onClick={prev} disabled={index === 0}>
          ‹
        </button>
        <span
          style={{
            color: '#fff',
            fontSize: 13,
            fontVariantNumeric: 'tabular-nums',
            minWidth: 64,
            textAlign: 'center',
          }}
        >
          {index + 1} / {total}
        </span>
        <button style={ctrlBtn} onClick={next} disabled={index === total - 1}>
          ›
        </button>
        <span style={{ width: 1, height: 22, background: 'rgba(255,255,255,0.2)' }} />
        <button
          style={{ ...ctrlBtn, width: 'auto', padding: '0 12px', fontSize: 12 }}
          onClick={() => setShowNotes(s => !s)}
          title="Afficher/masquer les notes (N)"
        >
          Notes
        </button>
        <button
          style={{ ...ctrlBtn, width: 'auto', padding: '0 12px', fontSize: 12 }}
          onClick={onExit}
          title="Quitter (Échap)"
        >
          Quitter
        </button>
      </div>
    </div>
  );
}

const overlayStyle = {
  position: 'fixed' as const,
  inset: 0,
  zIndex: 9999,
  background: '#000',
  overflow: 'hidden',
};

const zoneStyle = {
  position: 'absolute' as const,
  top: 0,
  bottom: 0,
  zIndex: 1,
  appearance: 'none' as const,
  border: 'none',
  background: 'transparent',
  padding: 0,
};

const ctrlBtn = {
  appearance: 'none' as const,
  width: 34,
  height: 34,
  borderRadius: 8,
  border: '1px solid rgba(255,255,255,0.25)',
  background: 'rgba(255,255,255,0.08)',
  color: '#fff',
  fontSize: 20,
  lineHeight: '1',
  cursor: 'pointer',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
};
