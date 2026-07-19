import { Fragment, useEffect } from 'react';
import { createPortal } from 'react-dom';

import * as styles from './shortcut-cheatsheet.css';
import {
  VDZ_PANEL_IDS,
  VDZ_PANEL_META,
  vdzPanelShortcut,
} from './use-vdz-layout';

/**
 * Vdz Studio — keyboard-shortcut cheatsheet overlay (QUILL / WS11).
 *
 * A read-only reference for every studio shortcut, opened by the `?` key (see
 * the page's handleKeyDown) or the toolbar's "⌨ Keys" button. It performs NO
 * timeline mutation whatsoever — the catalog below mirrors the bindings that
 * already exist in index.tsx (playback / edit / selection), project-bar.tsx
 * (⌘S save, window-capture) and the panel registry in use-vdz-layout.ts.
 *
 * The Panels section is DERIVED from `VDZ_PANEL_META` / `vdzPanelShortcut` —
 * the same single source of truth the View menu and the Cmd/Ctrl+N key handler
 * read — so it can never drift when a panel is added or a digit changes.
 *
 * Portaled to document.body so its fixed backdrop escapes the studio header's
 * containing block (mirrors export-dialog.tsx); the backdrop carries the
 * `vdzTheme` marker via its stylesheet so the `--vdz-*` tokens resolve.
 * Escape and backdrop click close; entrance animation is opacity/transform
 * only and disabled under prefers-reduced-motion (see the .css.ts).
 */

interface ShortcutRow {
  /** Key combos; chips within a combo joined by "+", combos by "or". */
  combos: string[][];
  /** What the shortcut does. */
  label: string;
}

interface ShortcutSection {
  title: string;
  rows: ShortcutRow[];
}

/** The static (non-panel) shortcut catalog — mirrors index.tsx/project-bar.tsx. */
const STATIC_SECTIONS: ShortcutSection[] = [
  {
    title: 'Playback',
    rows: [
      { combos: [['Space']], label: 'Play / pause' },
      { combos: [['←'], ['→']], label: 'Nudge selected clip ±0.1s' },
      { combos: [['Shift', '←'], ['Shift', '→']], label: 'Nudge ±1s' },
    ],
  },
  {
    title: 'Editing',
    rows: [
      { combos: [['S']], label: 'Split selected clip at playhead' },
      { combos: [['Delete']], label: 'Delete selection' },
      {
        combos: [['Shift', 'Delete']],
        label: 'Ripple delete — close the gap',
      },
      { combos: [['Cmd/Ctrl', 'Z']], label: 'Undo' },
      {
        combos: [['Cmd/Ctrl', 'Shift', 'Z'], ['Cmd/Ctrl', 'Y']],
        label: 'Redo',
      },
    ],
  },
  {
    title: 'Selection',
    rows: [
      { combos: [['Shift', 'Click']], label: 'Add / remove clip from selection' },
      { combos: [['Esc']], label: 'Clear selection' },
    ],
  },
  {
    title: 'Project',
    rows: [
      { combos: [['Cmd/Ctrl', 'S']], label: 'Save project' },
      { combos: [['Cmd/Ctrl', 'Shift', 'S']], label: 'Save As…' },
    ],
  },
];

/** Panels section, derived from the shared panel registry (never drifts). */
function panelSection(): ShortcutSection {
  return {
    title: 'Panels',
    rows: VDZ_PANEL_IDS.map(id => ({
      combos: [vdzPanelShortcut(id).split('+')],
      label: `Toggle ${VDZ_PANEL_META[id].label} panel`,
    })),
  };
}

const HELP_SECTION: ShortcutSection = {
  title: 'Help',
  rows: [
    { combos: [['?']], label: 'Open this cheatsheet' },
    { combos: [['Esc']], label: 'Close it' },
  ],
};

/** Render one combo list: chips joined by "+", alternatives by "or". */
function Combo({ combos }: { combos: string[][] }) {
  return (
    <span className={styles.keys}>
      {combos.map((combo, comboIndex) => (
        <Fragment key={comboIndex}>
          {comboIndex > 0 ? (
            <span className={styles.keyJoin}>or</span>
          ) : null}
          {combo.map((key, keyIndex) => (
            <Fragment key={keyIndex}>
              {keyIndex > 0 ? (
                <span className={styles.keyJoin} aria-hidden="true">
                  +
                </span>
              ) : null}
              <kbd className={styles.kbd}>{key}</kbd>
            </Fragment>
          ))}
        </Fragment>
      ))}
    </span>
  );
}

interface VdzShortcutCheatsheetProps {
  open: boolean;
  /** Close the overlay (Escape / backdrop click / × button). */
  onClose: () => void;
}

export function VdzShortcutCheatsheet({
  open,
  onClose,
}: VdzShortcutCheatsheetProps) {
  // Escape closes (the backdrop click does too) — mirrors export-dialog.tsx.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open || typeof document === 'undefined') return null;

  const sections: ShortcutSection[] = [
    ...STATIC_SECTIONS,
    panelSection(),
    HELP_SECTION,
  ];

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
        aria-label="Keyboard shortcuts"
      >
        <div className={styles.headRow}>
          <div>
            <div className={styles.title}>Keyboard shortcuts</div>
            <div className={styles.subtitle}>
              Everything the studio answers to. Shortcuts pause while you type
              in a text field.
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

        <div className={styles.sectionsGrid}>
          {sections.map(section => (
            <div key={section.title} className={styles.section}>
              <div className={styles.sectionTitle}>{section.title}</div>
              {section.rows.map(row => (
                <div key={row.label} className={styles.row}>
                  <span className={styles.rowLabel}>{row.label}</span>
                  <Combo combos={row.combos} />
                </div>
              ))}
            </div>
          ))}
        </div>

        <div className={styles.footHint}>
          Press <kbd className={styles.kbd}>?</kbd> anytime to reopen ·{' '}
          <kbd className={styles.kbd}>Esc</kbd> closes
        </div>
      </div>
    </div>,
    document.body
  );
}
