import {
  type CSSProperties,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
} from 'react';

import { btnStyle, C } from './shoperp-shared';

// ---------------------------------------------------------------------------
// WSB-7 — Guided tour (coach-marks). A dependency-free, self-contained overlay
// that walks a first-time shop owner through the dashboard tabs. It highlights
// one tab at a time with a dark overlay + a "spotlight" cut-out over the target,
// and a tooltip card carrying FR copy + a short darja one-liner, with
// Suivant / Passer controls.
//
// DESIGN — driven ENTIRELY by props so the dashboard needs only a tiny
// declarative hookup (see NOTES §DASHBOARD-TOUR-HOOK):
//   • It never imports the dashboard's section state; the parent passes the
//     ordered `steps`, the live `sections` list (so a step whose tab isn't
//     rendered on THIS server — e.g. a flag-gated tab — is silently skipped),
//     an `onGoTo(section)` to switch the active tab as the tour advances, and
//     an `onDone()` fired once (completed or skipped).
//   • Targets are located in the DOM via a `data-cdz-tour="<section-id>"`
//     attribute the parent stamps on each tab button. No refs threaded through.
//     If a target can't be found (layout race / missing tab) the card simply
//     centers itself — the tour never blocks.
//   • Completion persists in localStorage under `cdz.shoperp.tour.<slug>` so it
//     shows once per store; `index.tsx` starts it only on the first dashboard
//     visit (same key) and it also self-guards here.
//
// Inline styles only (mirrors the rest of shoperp). position:fixed so it floats
// above the whole viewport; pointer-events are scoped so the backdrop captures
// clicks (advance/skip) without the underlying UI stealing them mid-tour.
// ---------------------------------------------------------------------------

/** localStorage key for a store's tour-completion flag. */
export function shopTourStorageKey(slug: string): string {
  return `cdz.shoperp.tour.${slug}`;
}

/** True once the tour has been completed/skipped for this slug (fail-soft). */
export function isShopTourDone(slug: string): boolean {
  try {
    return globalThis.localStorage?.getItem(shopTourStorageKey(slug)) === '1';
  } catch {
    return false;
  }
}

/** Persist tour completion for this slug (fail-soft — private mode etc.). */
export function markShopTourDone(slug: string): void {
  try {
    globalThis.localStorage?.setItem(shopTourStorageKey(slug), '1');
  } catch {
    /* storage unavailable — the tour just replays next time; harmless */
  }
}

/** One tour step. `section` matches a dashboard tab id + its data-cdz-tour attr. */
export interface ShopTourStep {
  /** The dashboard section/tab id this step points at (spotlight target). */
  section: string;
  /** Short FR heading. */
  title: string;
  /** One or two FR sentences of guidance. */
  body: string;
  /** A short darja one-liner shown under the body (optional, RTL-friendly). */
  darja?: string;
}

/**
 * The default tour script — the canonical tab walk from the work item:
 * Aperçu → Commandes → Apparence → Fonctionnalités → Livraison → Facturation →
 * Modifier avec l'IA → Équipe. Section ids match the dashboard SECTIONS ids
 * (and the R3 DASHBOARD-TAB registrations other builders add). Steps whose tab
 * isn't present on the current server are skipped at runtime, so this stays a
 * safe superset regardless of which feature flags are on.
 */
export const DEFAULT_SHOP_TOUR_STEPS: ShopTourStep[] = [
  {
    section: 'overview',
    title: 'Aperçu',
    body: 'Votre tableau de bord : chiffre d’affaires, commandes en attente et stock faible, en direct.',
    darja: 'هنا تشوف كلش على بلاصة — الفلوس، الكوموندات و الستوك.',
  },
  {
    section: 'orders',
    title: 'Commandes',
    body: 'Gérez chaque commande — de « Nouvelle » à « Livrée ». Confirmez, expédiez et suivez vos clients.',
    darja: 'الكوموندات تع الزبائن، تأكدها و تبعتها من هنا.',
  },
  {
    section: 'appearance',
    title: 'Apparence',
    body: 'Changez le thème, les couleurs, la police et les sections de votre boutique, puis republiez.',
    darja: 'بدّل الألوان و الستيل تع الحانوت كيما يعجبك.',
  },
  {
    section: 'features',
    title: 'Fonctionnalités',
    body: 'Activez ou désactivez des modules — livraison, paiement en ligne, avis clients… en un clic.',
    darja: 'زيد ولا نقّص الخدمات تع الحانوت بضغطة وحدة.',
  },
  {
    section: 'shipping',
    title: 'Livraison',
    body: 'Configurez vos transporteurs et vos tarifs pour les 58 wilayas.',
    darja: '58 ولاية — حضّر التوصيل و الأثمنة تاعهم.',
  },
  {
    section: 'invoicing',
    title: 'Facturation',
    body: 'Devis, bons de livraison et factures conformes — prêts à imprimer en A4.',
    darja: 'فاتورات و بونات بالقانون، تطبعهم كي تحب.',
  },
  {
    section: 'ai-edit',
    title: 'Modifier avec l’IA',
    body: 'Décrivez ce que vous voulez et l’IA modifie votre boutique — mise en page, textes, style.',
    darja: 'قول برك واش تحب، و الذكاء الاصطناعي يبدّلهالك.',
  },
  {
    section: 'team',
    title: 'Équipe',
    body: 'Ajoutez vos employés avec des rôles (vendeur, gérant) et gérez leurs accès.',
    darja: 'زيد العمّال تاعك و أعطي لكل واحد الدور تاعه.',
  },
];

interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}

/** Read a target tab's viewport rect via its data-cdz-tour attribute. */
function readTargetRect(section: string): Rect | null {
  try {
    const el = document.querySelector(
      `[data-cdz-tour="${CSS.escape(section)}"]`
    );
    if (!el) return null;
    const r = (el as HTMLElement).getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return null;
    return { top: r.top, left: r.left, width: r.width, height: r.height };
  } catch {
    return null;
  }
}

export const ShopTour = ({
  slug,
  steps,
  sections,
  onGoTo,
  onDone,
}: {
  /** The store slug — drives the localStorage completion flag. */
  slug: string;
  /** Ordered tour steps (default: DEFAULT_SHOP_TOUR_STEPS). */
  steps?: ShopTourStep[];
  /** The section ids actually rendered as tabs right now (present-tab filter). */
  sections: string[];
  /** Switch the dashboard's active tab to `section` (called as the tour moves). */
  onGoTo: (section: string) => void;
  /** Fired exactly once when the tour finishes or is skipped. */
  onDone: () => void;
}) => {
  // Keep only steps whose tab is actually present on this server, preserving the
  // authored order. This is what makes the script a safe superset across flags.
  const present = useMemo(() => {
    const set = new Set(sections);
    const source = steps && steps.length ? steps : DEFAULT_SHOP_TOUR_STEPS;
    return source.filter(s => set.has(s.section));
  }, [steps, sections]);

  const [idx, setIdx] = useState(0);
  const [rect, setRect] = useState<Rect | null>(null);
  const [closed, setClosed] = useState(false);

  const total = present.length;
  const step = present[Math.min(idx, Math.max(0, total - 1))];

  // Finish (complete or skip): persist, notify the parent once, unmount.
  const finish = useCallback(() => {
    if (closed) return;
    setClosed(true);
    markShopTourDone(slug);
    onDone();
  }, [closed, slug, onDone]);

  // Advance the active tab whenever the step changes so the spotlight lands on a
  // visible tab (and the body under it reflects the step being described).
  useEffect(() => {
    if (closed || !step) return;
    onGoTo(step.section);
  }, [closed, step, onGoTo]);

  // Measure the target after the tab switch paints; re-measure on resize/scroll.
  // useLayoutEffect + a rAF settles the DOM before the first read so the very
  // first spotlight isn't a frame behind.
  useLayoutEffect(() => {
    if (closed || !step) return;
    let raf = 0;
    const measure = () => setRect(readTargetRect(step.section));
    raf = requestAnimationFrame(() => {
      measure();
      // A second tick catches late layout (fonts, wrapping tab row).
      raf = requestAnimationFrame(measure);
    });
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
    };
  }, [closed, step]);

  // Keyboard: Esc skips, →/Enter advances, ← goes back.
  useEffect(() => {
    if (closed) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        finish();
      } else if (e.key === 'ArrowRight' || e.key === 'Enter') {
        e.preventDefault();
        setIdx(i => (i + 1 >= total ? (finish(), i) : i + 1));
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        setIdx(i => Math.max(0, i - 1));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [closed, total, finish]);

  if (closed || total === 0 || !step) return null;

  const isLast = idx >= total - 1;
  const pad = 6; // spotlight padding around the target
  const hasRect = rect !== null;
  const spot: Rect = hasRect
    ? {
        top: Math.max(0, rect.top - pad),
        left: Math.max(0, rect.left - pad),
        width: rect.width + pad * 2,
        height: rect.height + pad * 2,
      }
    : { top: 0, left: 0, width: 0, height: 0 };

  // Position the tooltip just below the spotlight (or centered when unmeasured),
  // clamped into the viewport so it never overflows on a narrow phone.
  const vw =
    typeof window !== 'undefined' ? window.innerWidth : 360;
  const cardW = Math.min(320, vw - 24);
  const cardLeft = hasRect
    ? Math.max(12, Math.min(spot.left, vw - cardW - 12))
    : Math.max(12, (vw - cardW) / 2);
  const cardTop = hasRect ? spot.top + spot.height + 10 : 90;

  const next = () => (isLast ? finish() : setIdx(i => i + 1));
  const back = () => setIdx(i => Math.max(0, i - 1));

  return (
    <div style={rootStyle} role="dialog" aria-modal="true" aria-label="Visite guidée">
      {/* Backdrop — four dark panels framing the spotlight (a cut-out effect
          without SVG masks). Clicking any panel advances (fast-forward feel);
          the underlying UI is covered so no accidental tab clicks leak. When
          unmeasured we fall back to one full dark sheet. */}
      {hasRect ? (
        <>
          <div style={{ ...panelStyle, top: 0, left: 0, right: 0, height: spot.top }} onClick={next} />
          <div
            style={{ ...panelStyle, top: spot.top, left: 0, width: spot.left, height: spot.height }}
            onClick={next}
          />
          <div
            style={{
              ...panelStyle,
              top: spot.top,
              left: spot.left + spot.width,
              right: 0,
              height: spot.height,
            }}
            onClick={next}
          />
          <div
            style={{ ...panelStyle, top: spot.top + spot.height, left: 0, right: 0, bottom: 0 }}
            onClick={next}
          />
          {/* Spotlight ring around the live tab (transparent center). */}
          <div
            aria-hidden
            style={{
              position: 'fixed',
              top: spot.top,
              left: spot.left,
              width: spot.width,
              height: spot.height,
              borderRadius: 10,
              boxShadow: '0 0 0 2px ' + C.accent + ', 0 0 0 9999px rgba(8,10,16,0.62)',
              pointerEvents: 'none',
              transition: 'all 220ms cubic-bezier(0.4,0,0.2,1)',
            }}
          />
        </>
      ) : (
        <div style={{ ...panelStyle, inset: 0 }} onClick={next} />
      )}

      {/* Tooltip card */}
      <div
        style={{
          position: 'fixed',
          top: cardTop,
          left: cardLeft,
          width: cardW,
          boxSizing: 'border-box',
          background: C.panel,
          border: '1px solid ' + C.border,
          borderRadius: 14,
          padding: 16,
          boxShadow: '0 12px 40px rgba(0,0,0,0.5)',
          pointerEvents: 'auto',
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
        }}
        onClick={e => e.stopPropagation()}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span
            style={{
              fontSize: 10,
              fontWeight: 800,
              letterSpacing: '0.06em',
              color: C.accent,
              textTransform: 'uppercase',
            }}
          >
            Visite · {idx + 1}/{total}
          </span>
          <div style={{ flex: 1 }} />
          <button style={skipStyle} onClick={finish} aria-label="Passer la visite">
            Passer
          </button>
        </div>

        <div style={{ fontSize: 16, fontWeight: 800, color: C.text }}>
          {step.title}
        </div>
        <div style={{ fontSize: 13, color: C.muted, lineHeight: 1.55 }}>
          {step.body}
        </div>
        {step.darja ? (
          <div
            dir="rtl"
            style={{
              fontSize: 12.5,
              color: C.text,
              lineHeight: 1.6,
              padding: '7px 10px',
              borderRadius: 8,
              background: C.accentSoft,
              border: '1px solid ' + C.border,
            }}
          >
            {step.darja}
          </div>
        ) : null}

        {/* Progress dots */}
        <div style={{ display: 'flex', gap: 5, margin: '4px 0 2px' }}>
          {present.map((s, i) => (
            <span
              key={s.section}
              style={{
                height: 4,
                flex: 1,
                borderRadius: 2,
                background: i <= idx ? C.accent : C.border,
                transition: 'background 200ms ease',
              }}
            />
          ))}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
          {idx > 0 ? (
            <button style={btnStyle('secondary')} onClick={back}>
              ← Retour
            </button>
          ) : (
            <span />
          )}
          <div style={{ flex: 1 }} />
          <button style={btnStyle('primary')} onClick={next}>
            {isLast ? 'Terminer' : 'Suivant →'}
          </button>
        </div>
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Styles (inline, no .css.ts).
// ---------------------------------------------------------------------------

const rootStyle: CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 2147483000, // above the workbench chrome; below nothing we render
  pointerEvents: 'none', // children re-enable it where they need clicks
};

const panelStyle: CSSProperties = {
  position: 'fixed',
  background: 'rgba(8,10,16,0.62)',
  pointerEvents: 'auto',
  cursor: 'pointer',
};

const skipStyle: CSSProperties = {
  appearance: 'none',
  background: 'none',
  border: 'none',
  padding: '2px 4px',
  font: 'inherit',
  fontSize: 12,
  fontWeight: 700,
  cursor: 'pointer',
  color: C.muted,
  textDecoration: 'underline',
};
