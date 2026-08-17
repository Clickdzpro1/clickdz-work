import {
  type CSSProperties,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
} from 'react';
import { createPortal } from 'react-dom';

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

/**
 * Where the merchant got to, so a reload resumes mid-tour instead of dragging
 * them back through steps they already read. Only completion was persisted
 * before, which on a flaky mobile connection meant restarting from step 0
 * every time the page reloaded.
 */
function tourStepKey(slug: string): string {
  return `cdz.shoperp.tour.step.${slug}`;
}

/**
 * How long a resume marker stays trustworthy. Resuming is only kind while the
 * merchant is still in the same sitting — coming back days later, a spotlight
 * parked on step 6 reads as "the tour is broken", because they experience it as
 * the tour's opening step. Past this window we start from the top instead.
 */
const TOUR_RESUME_TTL_MS = 12 * 60 * 60 * 1000; // 12h

/**
 * Read the resume index, honouring the TTL above.
 *
 * The marker used to be a bare integer with no timestamp, so a stale index was
 * indistinguishable from a fresh one and got restored forever. That is the bug
 * where an abandoned tour reopened with the spotlight on « Livraison » (step 6)
 * rather than « Aperçu »: only finish() clears the marker, so a tour left by
 * navigating away kept its index while `isShopTourDone` stayed false and the
 * tour auto-reopened. Bare-integer markers are therefore treated as stale,
 * which also self-heals every merchant currently stuck mid-tour.
 */
function readResumeStep(slug: string): number {
  try {
    const raw = globalThis.localStorage?.getItem(tourStepKey(slug));
    if (!raw) return 0;
    const [idxPart, tsPart] = raw.split(':');
    // No timestamp => legacy marker of unknown age => start fresh.
    if (!tsPart) return 0;
    const idx = parseInt(idxPart, 10);
    const ts = parseInt(tsPart, 10);
    if (!Number.isFinite(idx) || !Number.isFinite(ts) || idx <= 0) return 0;
    if (Date.now() - ts > TOUR_RESUME_TTL_MS) return 0;
    return idx;
  } catch {
    return 0;
  }
}

/**
 * Forget where the merchant got to. Called when the tour is replayed on purpose
 * from the dashboard header — an explicit « Visite guidée » click means "show me
 * this from the beginning", not "drop me back where I abandoned it".
 */
export function resetShopTourProgress(slug: string): void {
  try {
    globalThis.localStorage?.removeItem(tourStepKey(slug));
  } catch {
    /* storage unavailable — the tour just starts at 0 anyway; harmless */
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
  /** Short EN heading (falls back to `title` if absent). */
  titleEn?: string;
  /** One or two EN sentences of guidance (falls back to `body` if absent). */
  bodyEn?: string;
  /** Short AR heading (falls back to `title` if absent). */
  titleAr?: string;
  /** One or two AR sentences of guidance (falls back to `body` if absent). */
  bodyAr?: string;
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
    body: "Votre tableau de bord : chiffre d'affaires, commandes en attente et stock faible, en direct.",
    titleEn: 'Overview',
    bodyEn: 'Your dashboard: live revenue, pending orders and low-stock alerts all in one place.',
    titleAr: 'نظرة عامة',
    bodyAr: 'لوحة التحكم: الإيرادات، الطلبات المعلقة والمخزون المنخفض دفعةً واحدة.',
    darja: 'هنا تشوف كلش على بلاصة — الفلوس، الكوموندات و الستوك.',
  },
  {
    section: 'orders',
    title: 'Commandes',
    body: 'Gérez chaque commande — de « Nouvelle » à « Livrée ». Confirmez, expédiez et suivez vos clients.',
    titleEn: 'Orders',
    bodyEn: 'Manage every order from New to Delivered — confirm, ship, and keep your customers updated.',
    titleAr: 'الطلبات',
    bodyAr: 'تابع كل طلب من "جديد" حتى "تم التسليم" — تأكيد، شحن، ومتابعة الزبائن.',
    darja: 'الكوموندات تع الزبائن، تأكدها و تبعتها من هنا.',
  },
  {
    // Third, right after Commandes: this is where a merchant adds their first
    // product, which is the one thing they must do before anything else in the
    // tour matters. The tour used to skip Stock entirely and walk from orders
    // straight to invoicing, AI and team — day-30 features shown ahead of the
    // day-1 job.
    section: 'stock',
    title: 'Stock',
    body: "Ajoutez vos produits ici — nom, prix, photo et quantité. C'est la première étape pour vendre.",
    titleEn: 'Inventory',
    bodyEn: 'Add your products here — name, price, photo and quantity. This is your first step to start selling.',
    titleAr: 'المخزون',
    bodyAr: 'أضف منتجاتك هنا — الاسم والسعر والصورة والكمية. هذه هي خطوتك الأولى للبيع.',
    darja: 'زيد السلعة تاعك هنا — الاسم، السومة و التصويرة.',
  },
  {
    section: 'appearance',
    title: 'Apparence',
    body: 'Changez le thème, les couleurs, la police et les sections de votre boutique, puis republiez.',
    titleEn: 'Appearance',
    bodyEn: 'Change your shop\'s theme, colours, fonts and sections, then republish in one click.',
    titleAr: 'المظهر',
    bodyAr: 'غيّر ثيم متجرك، الألوان، الخطوط والأقسام، ثم انشر التغييرات بنقرة.',
    darja: 'بدّل الألوان و الستيل تع الحانوت كيما يعجبك.',
  },
  {
    section: 'features',
    title: 'Fonctionnalités',
    body: 'Activez ou désactivez des modules — livraison, paiement en ligne, avis clients… en un clic.',
    titleEn: 'Features',
    bodyEn: 'Turn modules on or off — delivery, online payment, customer reviews… with a single click.',
    titleAr: 'الميزات',
    bodyAr: 'شغّل أو أوقف الوحدات — التوصيل، الدفع الإلكتروني، آراء الزبائن… بنقرة واحدة.',
    darja: 'زيد ولا نقّص الخدمات تع الحانوت بضغطة وحدة.',
  },
  {
    section: 'shipping',
    title: 'Livraison',
    body: 'Configurez vos transporteurs et vos tarifs pour les 69 wilayas.',
    titleEn: 'Shipping',
    bodyEn: 'Set up your delivery partners and rates for all 69 wilayas.',
    titleAr: 'التوصيل',
    bodyAr: 'هيّئ شركات التوصيل وأسعارها لجميع الـ58 ولاية.',
    darja: '58 ولاية — حضّر التوصيل و الأثمنة تاعهم.',
  },
  {
    section: 'invoicing',
    title: 'Facturation',
    body: 'Devis, bons de livraison et factures conformes — prêts à imprimer en A4.',
    titleEn: 'Invoicing',
    bodyEn: 'Quotes, delivery notes and compliant invoices — ready to print on A4.',
    titleAr: 'الفوترة',
    bodyAr: 'عروض الأسعار وبوالص التسليم والفواتير القانونية — جاهزة للطباعة على A4.',
    darja: 'فاتورات و بونات بالقانون، تطبعهم كي تحب.',
  },
  {
    section: 'ai-edit',
    title: "Modifier avec l'IA",
    body: "Décrivez ce que vous voulez et l'IA modifie votre boutique — mise en page, textes, style.",
    titleEn: 'Edit with AI',
    bodyEn: 'Describe what you want and the AI updates your shop — layout, text, style.',
    titleAr: 'التعديل بالذكاء الاصطناعي',
    bodyAr: 'صف ما تريد والذكاء الاصطناعي يعدّل متجرك — التخطيط، النصوص، الأسلوب.',
    darja: 'قول برك واش تحب، و الذكاء الاصطناعي يبدّلهالك.',
  },
  {
    section: 'team',
    title: 'Équipe',
    body: 'Ajoutez vos employés avec des rôles (gérant, employé) et gérez leurs accès.',
    titleEn: 'Team',
    bodyEn: 'Add your staff with roles (manager, employee) and control what each person can access.',
    titleAr: 'الفريق',
    bodyAr: 'أضف موظفيك بأدوارهم (مدير، موظف) وتحكّم في صلاحية كل شخص.',
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
  lang,
  onGoTo,
  onDone,
}: {
  /** The store slug — drives the localStorage completion flag. */
  slug: string;
  /** Ordered tour steps (default: DEFAULT_SHOP_TOUR_STEPS). */
  steps?: ShopTourStep[];
  /** The section ids actually rendered as tabs right now (present-tab filter). */
  sections: string[];
  /**
   * Display language for the tour card. Defaults to 'fr' when omitted so
   * existing callers that don't pass lang are unaffected.
   */
  lang?: 'fr' | 'en' | 'ar';
  /** Switch the dashboard's active tab to `section` (called as the tour moves). */
  onGoTo: (section: string) => void;
  /** Fired exactly once when the tour finishes or is skipped. */
  onDone: () => void;
}) => {
  const activeLang = lang ?? 'fr';
  // Keep only steps whose tab is actually present on this server, preserving the
  // authored order. This is what makes the script a safe superset across flags.
  const present = useMemo(() => {
    const set = new Set(sections);
    const source = steps && steps.length ? steps : DEFAULT_SHOP_TOUR_STEPS;
    return source.filter(s => set.has(s.section));
  }, [steps, sections]);

  // Resume where the merchant left off, but only within the TTL and only for a
  // timestamped marker (see readResumeStep). Clamped below against the
  // present-steps list, so a stale index from a server with more tabs enabled
  // can never point past the end.
  const [idx, setIdx] = useState(() => readResumeStep(slug));
  const [rect, setRect] = useState<Rect | null>(null);
  const [closed, setClosed] = useState(false);

  const total = present.length;
  // One clamped index feeding BOTH the rendered step and the "n/total" badge.
  // These used to disagree: the step clamped but the badge printed `idx + 1`
  // raw, so a marker left over from a server with more tabs enabled rendered
  // the last step under a caption like "11/9".
  const safeIdx = Math.min(Math.max(idx, 0), Math.max(0, total - 1));
  const step = present[safeIdx];

  // Pull an out-of-range index back into range so what we persist (and every
  // subsequent +1/-1) starts from the step actually on screen.
  useEffect(() => {
    if (closed) return;
    if (idx !== safeIdx) setIdx(safeIdx);
  }, [closed, idx, safeIdx]);

  // Persist progress so a reload picks the tour back up mid-way — stamped with
  // the time so readResumeStep can expire it (see TOUR_RESUME_TTL_MS).
  useEffect(() => {
    if (closed) return;
    try {
      globalThis.localStorage?.setItem(
        tourStepKey(slug),
        `${safeIdx}:${Date.now()}`
      );
    } catch {
      /* storage unavailable — the tour just restarts; harmless */
    }
  }, [slug, safeIdx, closed]);

  // Finish (complete or skip): persist, notify the parent once, unmount.
  const finish = useCallback(() => {
    if (closed) return;
    setClosed(true);
    markShopTourDone(slug);
    // Drop the resume marker: a replay should start at the beginning.
    try {
      globalThis.localStorage?.removeItem(tourStepKey(slug));
    } catch {
      /* ignore */
    }
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
    const measure = () => {
      // Bring the target into view before measuring. On a phone the 15 tabs
      // wrap over several rows, so a later step's tab can sit below the fold —
      // the spotlight would then frame something the merchant cannot see.
      try {
        document
          .querySelector(`[data-cdz-tour="${CSS.escape(step.section)}"]`)
          ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      } catch {
        /* CSS.escape is unsupported on very old browsers — measuring still works */
      }
      setRect(readTargetRect(step.section));
    };
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

  const isLast = safeIdx >= total - 1;
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
  const vw = typeof window !== 'undefined' ? window.innerWidth : 360;
  const vh = typeof window !== 'undefined' ? window.innerHeight : 640;
  const cardW = Math.min(320, vw - 24);
  const cardLeft = hasRect
    ? Math.max(12, Math.min(spot.left, vw - cardW - 12))
    : Math.max(12, (vw - cardW) / 2);
  // Clamp vertically too. A target low in the wrapped tab row — which is most
  // of them on a 360px phone, where 15 tabs wrap to four or five lines — put
  // the card below the fold with its Suivant button unreachable. CARD_EST_H is
  // a deliberate over-estimate: pushing the card slightly high is harmless,
  // pushing it off-screen is not.
  const CARD_EST_H = 240;
  const cardTop = hasRect
    ? Math.min(spot.top + spot.height + 10, Math.max(12, vh - CARD_EST_H - 12))
    : 90;

  const next = () => (isLast ? finish() : setIdx(i => i + 1));
  const back = () => setIdx(i => Math.max(0, i - 1));

  // Derive the displayed title/body for the current step and language.
  const stepTitle =
    activeLang === 'en'
      ? (step.titleEn ?? step.title)
      : activeLang === 'ar'
        ? (step.titleAr ?? step.title)
        : step.title;
  const stepBody =
    activeLang === 'en'
      ? (step.bodyEn ?? step.body)
      : activeLang === 'ar'
        ? (step.bodyAr ?? step.body)
        : step.body;

  // Tour UI labels keyed by language.
  const tourLabels = {
    fr: { badge: 'Visite', skip: 'Passer', skipAria: 'Passer la visite', back: '← Retour', next: 'Suivant →', finish: 'Terminer' },
    en: { badge: 'Tour', skip: 'Skip', skipAria: 'Skip the tour', back: '← Back', next: 'Next →', finish: 'Done' },
    ar: { badge: 'جولة', skip: 'تخطي', skipAria: 'تخطي الجولة', back: 'رجوع →', next: '← التالي', finish: 'إنهاء' },
  } as const;
  const lbl = tourLabels[activeLang];
  const isRtl = activeLang === 'ar';

  // Portalled to <body> ON PURPOSE — this is the whole reason the spotlight used
  // to frame the wrong tab.
  //
  // The workbench route container sets `contain: strict`
  // (modules/workbench/view/route-container.css.ts), and `contain` implies
  // `layout`, which makes that element a containing block for position:fixed
  // descendants. Rendered in place, every `position: fixed` coordinate below was
  // therefore resolved against the route container's box — which starts to the
  // right of the sidebar and below the header — while readTargetRect's
  // getBoundingClientRect() correctly returns VIEWPORT coordinates. The two
  // disagreed by exactly (sidebar width, header height), so the cut-out landed
  // roughly one tab-row down and two tabs across: the card said « Commandes »
  // while the spotlight framed « Caisse ».
  //
  // The measuring code was never the bug, which is why tweaking it never fixed
  // this. Portalling to document.body puts the overlay outside every contained
  // ancestor, so position:fixed is viewport-relative again and agrees with the
  // measured rect. Keep it portalled.
  return createPortal(
    <div style={rootStyle} role="dialog" aria-modal="true" aria-label={lbl.skipAria}>
      <style>{'@keyframes cdz-pop-in{from{opacity:0;transform:scale(0.96) translateY(8px)}to{opacity:1;transform:none}}'}</style>
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
        dir={isRtl ? 'rtl' : 'ltr'}
        style={{
          position: 'fixed',
          top: cardTop,
          left: cardLeft,
          width: cardW,
          boxSizing: 'border-box',
          background: C.panel,
          border: '1px solid ' + C.border,
          borderRadius: 16,
          padding: 16,
          boxShadow: '0 16px 48px rgba(0,0,0,0.55)',
          pointerEvents: 'auto',
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
          animation: 'cdz-pop-in 220ms cubic-bezier(0.2,0,0,1)',
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
            {lbl.badge} · {safeIdx + 1}/{total}
          </span>
          <div style={{ flex: 1 }} />
          <button style={skipStyle} onClick={finish} aria-label={lbl.skipAria}>
            {lbl.skip}
          </button>
        </div>

        <div style={{ fontSize: 16, fontWeight: 800, color: C.text }}>
          {stepTitle}
        </div>
        <div style={{ fontSize: 13, color: C.muted, lineHeight: 1.55 }}>
          {stepBody}
        </div>
        {/* Darja one-liner: shown for FR and AR only (not for EN). Always RTL. */}
        {step.darja && activeLang !== 'en' ? (
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
                background: i <= safeIdx ? C.accent : C.border,
                transition: 'background 200ms ease',
              }}
            />
          ))}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
          {safeIdx > 0 ? (
            <button style={btnStyle('secondary')} onClick={back}>
              {lbl.back}
            </button>
          ) : (
            <span />
          )}
          <div style={{ flex: 1 }} />
          <button style={btnStyle('primary')} onClick={next}>
            {isLast ? lbl.finish : lbl.next}
          </button>
        </div>
      </div>
    </div>,
    document.body
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
