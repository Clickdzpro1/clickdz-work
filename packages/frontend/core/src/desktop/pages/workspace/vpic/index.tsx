import {
  ViewBody,
  ViewHeader,
  ViewIcon,
  ViewTitle,
} from '@affine/core/modules/workbench';
import { AppAccessGate } from '@affine/core/modules/studio/app-access-gate';
import { lazy, Suspense } from 'react';

import { dirFor, useVpicLang } from '../../../../modules/vpic/i18n';
import { ensureClickDzResponsiveCss } from '@affine/core/clickdz/responsive';
import { ensureCdzMotionCss } from '@affine/core/clickdz/motion';
import { CdzSkeletonList } from '@affine/core/clickdz/skeleton';

const CdzResponsive = () => {
  ensureClickDzResponsiveCss();
  // Additive: inject the shared cdz-motion sheet beside the responsive sheet so
  // the skeleton/enter primitives are available to this surface. Idempotent.
  ensureCdzMotionCss();
  return null;
};

/**
 * VPIC Studio — the page shell (Easel).
 *
 * This file is deliberately THIN. Its only jobs are:
 *   1. Provide the workbench chrome (ViewTitle/ViewIcon + ViewHeader/ViewBody),
 *      copied idiom-for-idiom from the Vdz studio page so VPIC slots into the
 *      workbench exactly like every other studio tab.
 *   2. Own the FR / darja (Arabic-script, RTL) language toggle via the shared
 *      {@link useVpicLang} hook, and stamp the resolved text direction onto the
 *      body wrapper (via {@link dirFor}) so the whole editor lays out RTL-aware
 *      with zero per-component work.
 *   3. Lazy-load the heavy working UI (`editor-panel.tsx`) inside a Suspense
 *      boundary with a small, on-brand loading state.
 *
 * FIRST-PAINT DIET: this module imports NEITHER the Canvas2D engine NOR the
 * editor panel eagerly — the panel (and, transitively, the engine + the media
 * hook + the lazily-nested mask panel) rides in its own route chunk that only
 * downloads once this page mounts. Keeping the shell featherweight means the
 * workbench tab switch is instant; the editor streams in behind the spinner.
 *
 * ROUTER CONTRACT: the desktop/mobile workbench routers load this file with a
 * `lazy: () => import('./pages/workspace/vpic/index')` and render the module's
 * `Component` export (the same shape the Vdz route uses). We MATCH that here —
 * the working component is `VpicStudioPage`, exposed as `Component` at the
 * bottom. Do not rename `Component`: the router looks it up by name.
 */

// ---- Chunk diet: the working editor UI loads on demand -------------------
// The editor panel is the studio's entire heavy surface (toolbar sections,
// canvas preview, the engine, the media hook, and a further-lazy mask panel).
// None of it is needed for the header/title first paint, so it loads in its own
// chunk. The panel is a named export, so we adapt it to a default for `lazy()`.
const VpicEditorPanel = lazy(() =>
  import('./editor-panel').then(m => ({ default: m.VpicEditorPanel }))
);

/**
 * A calm, centered loading state for the Suspense fallback while the editor
 * chunk downloads. It mounts into the already-styled ViewBody, so a single
 * quiet line reads better than a heavy spinner — and it is language-aware so
 * even the brief flash respects FR / darja.
 */
function VpicPanelFallback() {
  const { t } = useVpicLang();
  // A skeleton of the editor's real two-column geometry (canvas stage + tool
  // rail) using the shared cdz-motion `[data-cdz-skeleton]` shimmer, so the
  // streamed editor lands into its own silhouette instead of replacing a bare
  // text line. currentColor drives the tint → themes + RTL for free. The rule
  // needs a [data-cdz-motion] ancestor, which the body wrapper provides.
  return (
    <div
      role="status"
      aria-label={t('vpic.loading')}
      style={{
        display: 'flex',
        flexDirection: 'row',
        gap: 16,
        width: '100%',
        height: '100%',
        minHeight: 240,
        padding: 16,
        boxSizing: 'border-box',
        color: 'var(--affine-text-secondary-color, #8a90a0)',
      }}
    >
      {/* Canvas stage placeholder (grows to fill). */}
      <div style={{ flex: '1 1 auto', minWidth: 0 }}>
        <div
          data-cdz-skeleton=""
          aria-hidden="true"
          style={{ width: '100%', height: '100%', borderRadius: 8 }}
        />
      </div>
      {/* Tool-rail placeholder (fixed-ish column). */}
      <div style={{ flex: '0 0 300px', maxWidth: '40%' }}>
        <CdzSkeletonList rows={7} gap={14} />
      </div>
    </div>
  );
}

/**
 * The VPIC studio page. Header carries the product title/subtitle and the
 * FR/darja language toggle; the body hosts the lazily-loaded editor panel,
 * direction-stamped for RTL-aware layout.
 */
const VpicStudioPage = () => {
  // Shared module-level language state (localStorage-backed; fr default, ar =
  // Algerian darja in Arabic script). `t` is the fail-soft translator; `dirFor`
  // maps the language to a writing direction we stamp onto the body wrapper.
  const { lang, setLang, t } = useVpicLang();
  const dir = dirFor(lang);

  return (
    <>
      {/* Workbench view metadata — mirrors the Vdz page. `edgeless` is a
          canvas-flavored icon already registered by the workbench, so no new
          icon import is pulled into the route chunk. */}
      <ViewTitle title={t('vpic.title')} />
      <ViewIcon icon="edgeless" />

      <ViewHeader>
        <div
          dir={dir}
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
            width: '100%',
            height: '100%',
            padding: '0 12px',
            boxSizing: 'border-box',
          }}
        >
          {/* LEFT: product title + subtitle. */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
            {/* Gradient icon chip for visual anchoring */}
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: 28,
                height: 28,
                borderRadius: 8,
                background: 'linear-gradient(135deg, var(--affine-primary-color, #5b8cff) 0%, #06b6d4 100%)',
                fontSize: 14,
                flexShrink: 0,
                boxShadow: '0 2px 8px rgba(91,140,255,0.35)',
              }}
            >
              🖼
            </span>
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                minWidth: 0,
                lineHeight: 1.2,
              }}
            >
              <span
                style={{
                  fontSize: 14,
                  fontWeight: 700,
                  color: 'var(--affine-text-primary-color, #e6e9f0)',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
              >
                {t('vpic.title')}
              </span>
              <span
                style={{
                  fontSize: 11,
                  color: 'var(--affine-text-secondary-color, #8a90a0)',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
              >
                {t('vpic.subtitle')}
              </span>
            </div>
          </div>

          {/* RIGHT: FR / darja language toggle as one segmented control. The
              toggle itself is always LTR-ordered (FR then darja) regardless of
              the current writing direction — it is a language *picker*, not
              content, so its visual order stays stable. */}
          <div
            dir="ltr"
            role="group"
            aria-label={t('vpic.language')}
            style={{
              display: 'inline-flex',
              flex: '0 0 auto',
              borderRadius: 9,
              overflow: 'hidden',
              border: '1px solid var(--affine-border-color, #262a35)',
              background: 'var(--affine-background-secondary-color, #0e1016)',
              padding: 3,
              gap: 2,
            }}
          >
            <button
              type="button"
              aria-pressed={lang === 'fr'}
              onClick={() => setLang('fr')}
              style={{
                padding: '4px 14px',
                fontSize: 12,
                fontWeight: lang === 'fr' ? 700 : 500,
                cursor: 'pointer',
                border: 'none',
                borderRadius: 7,
                background:
                  lang === 'fr'
                    ? 'var(--affine-primary-color, #5b8cff)'
                    : 'transparent',
                color:
                  lang === 'fr'
                    ? '#ffffff'
                    : 'var(--affine-text-secondary-color, #8a90a0)',
                transition: 'background 150ms ease, color 150ms ease',
                boxShadow: lang === 'fr' ? '0 2px 6px rgba(91,140,255,0.4)' : 'none',
              }}
            >
              FR
            </button>
            <button
              type="button"
              aria-pressed={lang === 'ar'}
              onClick={() => setLang('ar')}
              style={{
                padding: '4px 14px',
                fontSize: 12,
                fontWeight: lang === 'ar' ? 700 : 500,
                cursor: 'pointer',
                border: 'none',
                borderRadius: 7,
                background:
                  lang === 'ar'
                    ? 'var(--affine-primary-color, #5b8cff)'
                    : 'transparent',
                color:
                  lang === 'ar'
                    ? '#ffffff'
                    : 'var(--affine-text-secondary-color, #8a90a0)',
                transition: 'background 150ms ease, color 150ms ease',
                boxShadow: lang === 'ar' ? '0 2px 6px rgba(91,140,255,0.4)' : 'none',
              }}
            >
              {/* Language endonym (the language's own name), shown literally
                  the way every language picker shows "FR" — a proper noun, not
                  a translatable UI string, so it is fixed in both locales. */}
              دارجة
            </button>
          </div>
        </div>
      </ViewHeader>

      <ViewBody>
        <AppAccessGate app="VPIC">
        <CdzResponsive />
        {/* Direction-stamped host so the entire editor lays out RTL-aware in
            darja. The panel and every section inside inherit `dir` from here.
            data-cdz-surface enables the shared responsive stylesheet; the
            shell/rail markers are stamped on the two-column split inside
            editor-panel.tsx (styles.root / styles.rail). */}
        <div
          data-cdz-surface=""
          data-cdz-motion=""
          dir={dir}
          style={{
            display: 'flex',
            flexDirection: 'column',
            width: '100%',
            height: '100%',
            overflow: 'hidden',
          }}
        >
          <Suspense fallback={<VpicPanelFallback />}>
            <VpicEditorPanel />
          </Suspense>
        </div>
        </AppAccessGate>
      </ViewBody>
    </>
  );
};

/**
 * Router entry point. The desktop/mobile workbench routers render this named
 * export from the lazily-imported module (same contract as the Vdz route).
 */
export const Component = () => {
  return <VpicStudioPage />;
};
