import { type ReactElement, useCallback, useState } from 'react';

import { dirFor, useVpicLang } from '../../../../modules/vpic/i18n';
import {
  CDZIMAGE_SIZES,
  CDZIMAGE_TIERS,
  type CdzImageSize,
  type CdzImageTier,
  useVpicGenerate,
} from '../../../../modules/vpic/use-vpic-generate';

/**
 * VPIC — text-to-image GENERATE panel ("Générer une image").
 *
 * The user types a prompt (FR or darja), optionally picks a CDZIMAGE tier /
 * format / DZ e-commerce preset, and we hand the prompt to the app's EXISTING
 * image route in TEXT-TO-IMAGE mode (no source image). On success we return the
 * generated image as a Blob via `onApplied(blob)` and the parent (the editor
 * panel) folds it into the engine as a new source — so every edit tool then
 * applies to the generated image, and the mask/gen-fill flow can refine it.
 *
 * The one network call lives in `useVpicGenerate()` — it POSTs
 * `POST /api/v1/images/generations` WITHOUT `image` (the generation branch),
 * the same route the mask panel uses for edits. This panel is UI + wiring only;
 * there is NO backend change.
 *
 * Styling mirrors mask-panel.tsx verbatim (same overlay/modal/btn inline-style
 * idiom, same `useVpicLang`/`dirFor` RTL handling, same fail-soft typed errors),
 * so the two AI modals read as one family.
 */

// DZ e-commerce prompt presets appended to the user's prompt (upgrade #5). Keys
// are pinned in modules/vpic/i18n.ts; the suffix is model-facing (kept English —
// the enhancer handles the user's own language).
const PRESETS: Array<{ key: string; suffix: string }> = [
  {
    key: 'vpic.genPresetPackshot',
    suffix:
      ', product packshot on a clean white studio background, soft shadow, e-commerce',
  },
  {
    key: 'vpic.genPresetLifestyle',
    suffix:
      ', lifestyle product scene, natural light, Algerian home setting',
  },
  {
    key: 'vpic.genPresetPoster',
    suffix:
      ', bold promotional poster, space for Arabic and French text, high contrast',
  },
];

// Pinned prop shape — the editor panel lazy-loads this and passes these exactly.
export interface GeneratePanelProps {
  /** The parent folds the generated image into the engine (saveBlob → load). */
  onApplied: (blob: Blob) => void;
  onClose: () => void;
}

export default function GeneratePanel(props: GeneratePanelProps): ReactElement {
  const { onApplied, onClose } = props;
  const { lang, t } = useVpicLang();
  const dir = dirFor(lang);
  const { working, fail, clearFail, generate } = useVpicGenerate();

  const [prompt, setPrompt] = useState('');
  const [tier, setTier] = useState<CdzImageTier>('cdzimage-2.0');
  const [size, setSize] = useState<CdzImageSize>('1024x1024');
  const [enhance, setEnhance] = useState(true); // prompt-pro on by default
  const [presetSuffix, setPresetSuffix] = useState('');

  const run = useCallback(async () => {
    if (working) return;
    const composed = (prompt.trim() + presetSuffix).trim();
    if (!composed) {
      clearFail();
      return;
    }
    const blob = await generate({
      prompt: composed,
      model: tier,
      size,
      enhance,
    });
    if (blob) onApplied(blob);
  }, [
    working,
    prompt,
    presetSuffix,
    tier,
    size,
    enhance,
    generate,
    onApplied,
    clearFail,
  ]);

  // --- styles (inline, matching mask-panel.tsx for visual consistency) -----
  const overlay: React.CSSProperties = {
    position: 'fixed',
    inset: 0,
    background: 'rgba(0,0,0,0.65)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1000,
    padding: 16,
    backdropFilter: 'blur(4px)',
  };
  const modal: React.CSSProperties = {
    background: 'var(--affine-background-primary-color, #0b0d12)',
    color: 'var(--affine-text-primary-color, #e6e9f0)',
    borderRadius: 16,
    boxShadow: '0 20px 60px rgba(0,0,0,0.55), 0 0 0 1px var(--affine-border-color, #262a35)',
    maxWidth: 'min(96vw, 680px)',
    width: '100%',
    maxHeight: '92vh',
    overflow: 'auto',
    padding: 24,
    display: 'flex',
    flexDirection: 'column',
    gap: 16,
  };
  const headerRow: React.CSSProperties = {
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 12,
  };
  const toolRow: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    flexWrap: 'wrap',
  };
  const chipRow: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    flexWrap: 'wrap',
  };
  const btn: React.CSSProperties = {
    padding: '8px 16px',
    borderRadius: 9,
    border: '1px solid var(--affine-border-color, #262a35)',
    background: 'var(--affine-background-secondary-color, #12141a)',
    color: 'inherit',
    cursor: 'pointer',
    fontSize: 13,
    fontWeight: 500,
    transition: 'background 140ms ease, border-color 140ms ease',
  };
  const primaryBtn: React.CSSProperties = {
    padding: '10px 22px',
    borderRadius: 9,
    border: 'none',
    background: 'var(--affine-primary-color, #5b8cff)',
    color: '#fff',
    fontWeight: 700,
    fontSize: 14,
    cursor: working ? 'not-allowed' : 'pointer',
    opacity: working ? 0.7 : 1,
    boxShadow: working ? 'none' : '0 3px 12px rgba(91,140,255,0.4)',
    transition: 'opacity 150ms ease, box-shadow 150ms ease',
  };
  const chip = (active: boolean): React.CSSProperties => ({
    padding: '7px 14px',
    borderRadius: 20,
    fontSize: 13,
    fontWeight: active ? 700 : 500,
    cursor: 'pointer',
    border: `1px solid ${active ? 'var(--affine-primary-color, #5b8cff)' : 'var(--affine-border-color, #262a35)'}`,
    background: active
      ? 'var(--affine-primary-color, #5b8cff)'
      : 'var(--affine-background-secondary-color, #12141a)',
    color: active ? '#fff' : 'inherit',
    transition: 'background 140ms ease, border-color 140ms ease, color 140ms ease',
    boxShadow: active ? '0 2px 8px rgba(91,140,255,0.35)' : 'none',
  });
  const errorBox: React.CSSProperties = {
    background: 'rgba(255, 76, 76, 0.10)',
    color: 'var(--affine-error-color, #ff6b6b)',
    border: '1px solid rgba(255,76,76,0.30)',
    borderRadius: 10,
    padding: '11px 14px',
    fontSize: 13,
    display: 'flex',
    alignItems: 'center',
    gap: 8,
  };
  const promptInput: React.CSSProperties = {
    width: '100%',
    boxSizing: 'border-box',
    padding: '12px 14px',
    borderRadius: 10,
    border: '1px solid var(--affine-border-color, #262a35)',
    background: 'var(--affine-background-secondary-color, #0e1016)',
    color: 'inherit',
    fontSize: 14,
    lineHeight: 1.55,
    resize: 'vertical',
    fontFamily: 'inherit',
    outline: 'none',
    transition: 'border-color 150ms ease',
  };
  const label: React.CSSProperties = {
    fontSize: 13,
    color: 'var(--affine-text-secondary-color, #8a90a0)',
    display: 'inline-flex',
    alignItems: 'center',
    gap: 7,
  };
  const select: React.CSSProperties = {
    padding: '6px 10px',
    borderRadius: 8,
    border: '1px solid var(--affine-border-color, #262a35)',
    background: 'var(--affine-background-secondary-color, #0e1016)',
    color: 'var(--affine-text-primary-color, #e6e9f0)',
    fontSize: 13,
  };

  // Map the typed failure to a pinned, translated message.
  const failMessage =
    fail === 'aiUnavailable'
      ? t('vpic.aiUnavailable')
      : fail === 'timeout'
        ? t('vpic.timeout')
        : fail === 'error'
          ? t('vpic.error')
          : '';

  return (
    <div
      style={overlay}
      dir={dir}
      role="dialog"
      aria-modal="true"
      onPointerDown={e => {
        // Click the dim backdrop (not the modal) to close, unless working.
        if (e.target === e.currentTarget && !working) onClose();
      }}
    >
      <div style={modal}>
        <div style={headerRow}>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: 38,
                height: 38,
                borderRadius: 11,
                background: 'linear-gradient(135deg, var(--affine-primary-color, #5b8cff) 0%, #06b6d4 100%)',
                fontSize: 18,
                flexShrink: 0,
                boxShadow: '0 4px 14px rgba(91,140,255,0.35)',
              }}
            >
              ✨
            </span>
            <div>
              <div style={{ fontSize: 18, fontWeight: 700, letterSpacing: '-0.01em' }}>
                {t('vpic.generate')}
              </div>
              <div style={{ fontSize: 12.5, color: 'var(--affine-text-secondary-color, #8a90a0)', marginTop: 3 }}>
                {t('vpic.generateHint')}
              </div>
            </div>
          </div>
          <button
            type="button"
            style={btn}
            onClick={onClose}
            disabled={working}
          >
            {t('vpic.close')}
          </button>
        </div>

        {/* Prompt. */}
        <textarea
          style={promptInput}
          value={prompt}
          dir={dir}
          rows={3}
          placeholder={t('vpic.generatePrompt')}
          disabled={working}
          onChange={e => {
            setPrompt(e.target.value);
            if (fail) clearFail();
          }}
        />

        {/* DZ e-commerce presets (toggle a suffix on/off). */}
        <div style={chipRow}>
          {PRESETS.map(pr => (
            <button
              key={pr.key}
              type="button"
              style={chip(presetSuffix === pr.suffix)}
              aria-pressed={presetSuffix === pr.suffix}
              disabled={working}
              onClick={() =>
                setPresetSuffix(s => (s === pr.suffix ? '' : pr.suffix))
              }
            >
              {t(pr.key)}
            </button>
          ))}
        </div>

        {/* Tier + format + enhance. */}
        <div style={toolRow}>
          <label style={label}>
            {t('vpic.quality')}
            <select
              style={select}
              value={tier}
              disabled={working}
              onChange={e => setTier(e.target.value as CdzImageTier)}
            >
              {CDZIMAGE_TIERS.map(x => (
                <option key={x.id} value={x.id}>
                  {x.label}
                </option>
              ))}
            </select>
          </label>
          <label style={label}>
            {t('vpic.format')}
            <select
              style={select}
              value={size}
              disabled={working}
              onChange={e => setSize(e.target.value as CdzImageSize)}
            >
              {CDZIMAGE_SIZES.map(x => (
                <option key={x.id} value={x.id}>
                  {x.label}
                </option>
              ))}
            </select>
          </label>
          <label style={label}>
            <input
              type="checkbox"
              checked={enhance}
              disabled={working}
              onChange={e => setEnhance(e.target.checked)}
            />
            {t('vpic.enhance')}
          </label>
        </div>

        <button
          type="button"
          style={primaryBtn}
          onClick={() => void run()}
          disabled={working || !prompt.trim()}
        >
          {working ? t('vpic.working') : t('vpic.generateGo')}
        </button>

        {failMessage ? <div style={errorBox}>{failMessage}</div> : null}
      </div>
    </div>
  );
}
