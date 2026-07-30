// ClickDz responsive layer — one scoped stylesheet for every custom CDZ
// surface (Hermes, OpenClaw, Agents, Vdz, VPic, Voice, Integrations, Apps,
// ShopERP).
//
// WHY THIS EXISTS
// These surfaces were all authored desktop-first: fixed-width rails, two-pane
// flex shells, and horizontal card rows. On a phone that produces exactly the
// two failure modes seen in production on 2026-07-30:
//
//   1. Hermes/OpenClaw — a 264px thread rail beside `flex:1` main content. At
//      390px viewport the rail eats 68% of the width and the conversation pane
//      is squeezed to ~120px, wrapping one word per line with the composer
//      buttons overlapping each other.
//   2. Vdz Studio — fixed-width inspector/media panels overflow the viewport,
//      clipping the header actions, the panel close button and the right-hand
//      column of every card grid.
//
// WHY A SHARED STYLESHEET RATHER THAN PER-FILE EDITS
// The surfaces use three different styling systems (inline style objects,
// vanilla-extract `.css.ts`, and Lit custom elements). A single stylesheet
// scoped by `[data-cdz-surface]` reaches all three, keeps the breakpoint in one
// place, and cannot leak into the AFFiNE editor chrome — which matters, because
// the doc/edgeless editor must keep its own desktop-tuned layout.
//
// CONTRACT
// Add `data-cdz-surface=""` to a CDZ page's outermost element and call
// `ensureClickDzResponsiveCss()` in an effect. Add `data-cdz-shell=""` to the
// element whose `display:flex` performs the rail/main split, and
// `data-cdz-rail=""` to the fixed-width rail itself.
//
// Everything below is inside a max-width query, so desktop is untouched by
// construction.

const STYLE_ID = 'cdz-responsive-css';

/** Phones and small foldables. Tablets keep the desktop two-pane layout. */
const PHONE = 600;

const CSS = `
/* ── Rail/main shells: stack instead of competing for width ────────────── */
@media (max-width: ${PHONE}px) {
  [data-cdz-shell] {
    flex-direction: column !important;
    overflow-y: auto !important;
    overflow-x: hidden !important;
  }
  /* The rail was a fixed 248-264px column. Full width, capped height, and a
     bottom border instead of a right border now that it sits above content. */
  [data-cdz-rail] {
    width: 100% !important;
    max-width: 100% !important;
    flex: 0 0 auto !important;
    max-height: 38vh;
    overflow-y: auto;
    border-right: none !important;
    border-bottom: 1px solid var(--affine-border-color, rgba(0,0,0,.1)) !important;
  }
  /* Main pane must be allowed to shrink below its content width. */
  [data-cdz-shell] > main,
  [data-cdz-shell] > [data-cdz-main] {
    min-width: 0 !important;
    width: 100% !important;
    flex: 1 1 auto !important;
  }
}

/* ── Global overflow guards for every CDZ surface ──────────────────────── */
@media (max-width: ${PHONE}px) {
  [data-cdz-surface] {
    max-width: 100vw;
    overflow-x: hidden;
  }
  /* Nothing inside a CDZ surface may force the page wider than the viewport. */
  [data-cdz-surface] * {
    max-width: 100%;
    box-sizing: border-box;
  }
  /* ...but tables and code blocks legitimately scroll instead of squashing. */
  [data-cdz-surface] table,
  [data-cdz-surface] pre {
    display: block;
    max-width: 100%;
    overflow-x: auto;
  }
  /* Fixed-width panels (inspector, media bin, project bar) become fluid. */
  [data-cdz-panel],
  [data-cdz-surface] aside {
    width: 100% !important;
    min-width: 0 !important;
  }
  /* Card grids collapse to a single column rather than clipping the last one. */
  [data-cdz-surface] [style*="repeat(2,"],
  [data-cdz-surface] [style*="repeat(3,"],
  [data-cdz-surface] [style*="repeat(4,"] {
    grid-template-columns: 1fr !important;
  }
  /* Header action clusters wrap instead of pushing content off-screen. */
  [data-cdz-actions] {
    flex-wrap: wrap !important;
    row-gap: 8px !important;
  }
  /* Comfortable touch targets everywhere. */
  [data-cdz-surface] button,
  [data-cdz-surface] a[role="button"] {
    min-height: 40px;
  }
}

/* ── Very narrow phones ────────────────────────────────────────────────── */
@media (max-width: 380px) {
  [data-cdz-rail] { max-height: 32vh; }
}
`;

/**
 * Inject the CDZ responsive stylesheet once per document. Idempotent and
 * SSR-safe, mirroring `ensureShoperpMotionCss()`.
 */
export function ensureClickDzResponsiveCss(): void {
  if (typeof document === 'undefined') return;
  if (document.getElementById(STYLE_ID)) return;
  const el = document.createElement('style');
  el.id = STYLE_ID;
  el.textContent = CSS;
  document.head.appendChild(el);
}
