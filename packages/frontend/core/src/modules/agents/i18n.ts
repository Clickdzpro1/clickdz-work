// ---------------------------------------------------------------------------
// ClickDz Agents — i18n (R8, WSU-7 / LOCALE). The SINGLE source of truth for
// every user-facing string in the unified /agents studio (home, agent cards,
// hire wizard, run + runs views, connections, the run timeline / artifacts /
// spend / tool-call components) plus the upcoming triggers page.
//
// WHY this file exists: the R7 agents surfaces hard-coded FR copy inline (with a
// scattered darja hint here and there). R8 makes the studio bilingual — French
// (default) + Algerian darja (Arabic script) — via ONE tiny, dependency-free
// module. Consumers (Cadence/Retouche/Poli) import `useAgentLang()` (or the pure
// `tFor(lang)`) and call `t('home.title')` instead of writing literals, so a
// language switch flips the whole studio at once and RTL is applied for Arabic.
//
// DESIGN (house rules honored):
//   · ZERO new deps. Only `react` (useState/useEffect) — already everywhere.
//   · Boot-safe: no top-level throws, all storage access guarded (private mode /
//     SSR / disabled storage are non-fatal). Missing key FAILS SOFT — `t()`
//     returns the FR string if present, else the key itself. It NEVER throws.
//   · No React context / provider: the hook reads MODULE-LEVEL state and
//     subscribes to a module-level listener set, so any number of mounted
//     components (card, timeline, spend chip…) re-render together on setLang —
//     no tree wrapping required. A `storage` event bridges other tabs.
//   · Interpolation is `{var}` style: `t('runs.subtitle', { agent: 'Hermes' })`.
//
// The full dotted-key catalogue (key → FR) is exported in the builder NOTES so
// the consuming builders use EXACT keys. `ar` = short, commerce-appropriate
// Algerian darja in Arabic script (the register the DZ shop pages already use).
// ---------------------------------------------------------------------------

import { useEffect, useState } from 'react';

// ---------------------------------------------------------------------------
// Public types.
// ---------------------------------------------------------------------------

/** The two languages the agents studio speaks. FR is the default. */
export type AgentLang = 'fr' | 'ar';

/** A dotted string key into {@link AGENT_STRINGS}. */
export type AgentStringKey = string;

/** Interpolation variables for `{var}` placeholders. Values are coerced to string. */
export type TVars = Record<string, string | number>;

/** The translator function shape returned by {@link tFor} and exposed by the hook. */
export type TFunc = (key: AgentStringKey, vars?: TVars) => string;

// ---------------------------------------------------------------------------
// Storage + module-level reactive state (no provider).
// ---------------------------------------------------------------------------

/** localStorage key persisting the chosen language across reloads / tabs. */
export const AGENT_LANG_STORAGE_KEY = 'cdz:agent-lang';

/** The default language when nothing is stored (or storage is unavailable). */
export const DEFAULT_AGENT_LANG: AgentLang = 'fr';

/** Human labels for a language toggle (FR button says "عربية", AR says "Français"). */
export const AGENT_LANG_LABELS: Record<AgentLang, string> = {
  fr: 'Français',
  ar: 'العربية',
};

/** Coerce any loose value to a known {@link AgentLang} (defaults to FR). */
export function coerceLang(v: unknown): AgentLang {
  return v === 'ar' ? 'ar' : 'fr';
}

/** Text direction for a language — 'rtl' for Arabic, 'ltr' otherwise. */
export function dirFor(lang: AgentLang): 'rtl' | 'ltr' {
  return lang === 'ar' ? 'rtl' : 'ltr';
}

// Guarded storage helpers — private mode / SSR / disabled storage are non-fatal.
function readStoredLang(): AgentLang {
  try {
    const raw = globalThis.localStorage?.getItem(AGENT_LANG_STORAGE_KEY);
    return coerceLang(raw);
  } catch {
    return DEFAULT_AGENT_LANG;
  }
}

function writeStoredLang(lang: AgentLang): void {
  try {
    globalThis.localStorage?.setItem(AGENT_LANG_STORAGE_KEY, lang);
  } catch {
    // Non-fatal: the in-memory module state still drives this session.
  }
}

// Module-level current language. Seeded from storage at import time (guarded).
let currentLang: AgentLang = readStoredLang();

// Module-level subscriber set: every mounted component's hook registers a
// listener so a single setLang() re-renders them all — the provider-free
// broadcast. A plain Set keeps it dependency-free.
const listeners = new Set<(lang: AgentLang) => void>();

function emit(lang: AgentLang): void {
  for (const fn of Array.from(listeners)) {
    try {
      fn(lang);
    } catch {
      // A misbehaving subscriber must never break the broadcast to the rest.
    }
  }
}

// Bridge other tabs / windows: a `storage` event for our key updates the
// module state + notifies local subscribers. Registered once, guarded.
let storageBridgeArmed = false;
function armStorageBridge(): void {
  if (storageBridgeArmed) return;
  storageBridgeArmed = true;
  try {
    globalThis.addEventListener?.('storage', (e: StorageEvent) => {
      if (e.key !== AGENT_LANG_STORAGE_KEY) return;
      const next = coerceLang(e.newValue);
      if (next === currentLang) return;
      currentLang = next;
      emit(next);
    });
  } catch {
    // No window / addEventListener (SSR) — single-tab reactivity still works.
  }
}
armStorageBridge();

/** Read the current agents-studio language (module state; SSR-safe). */
export function getAgentLang(): AgentLang {
  return currentLang;
}

/**
 * Set the agents-studio language: persist to localStorage, update module state,
 * and notify every mounted hook so the whole studio re-renders. Pure side-effect
 * (no return); a no-op broadcast is skipped when the value is unchanged.
 */
export function setAgentLang(lang: AgentLang): void {
  const next = coerceLang(lang);
  writeStoredLang(next);
  if (next === currentLang) return;
  currentLang = next;
  emit(next);
}

// ---------------------------------------------------------------------------
// Interpolation — pure `{var}` replacement.
// ---------------------------------------------------------------------------

/** Replace `{name}` placeholders in `template` from `vars` (missing → left as-is). */
export function interpolate(template: string, vars?: TVars): string {
  if (!vars || typeof template !== 'string' || template.indexOf('{') === -1) {
    return template;
  }
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => {
    const v = vars[name];
    return v === undefined || v === null ? whole : String(v);
  });
}

// ---------------------------------------------------------------------------
// The pure translator.
// ---------------------------------------------------------------------------

/**
 * Build a pure translator for `lang`. Fail-soft: an unknown key returns the FR
 * string when the entry exists but lacks the language, else the key itself —
 * it NEVER throws, so a missing key can only ever degrade to readable text.
 */
export function tFor(lang: AgentLang): TFunc {
  const safeLang = coerceLang(lang);
  return (key: AgentStringKey, vars?: TVars): string => {
    const entry = AGENT_STRINGS[key];
    if (!entry) {
      // Unknown key: return the key so a typo is visible but never fatal.
      return key;
    }
    // Prefer the requested language; fall back to FR; finally the key.
    const raw =
      (safeLang === 'ar' ? entry.ar : entry.fr) || entry.fr || key;
    return interpolate(raw, vars);
  };
}

// ---------------------------------------------------------------------------
// The hook. Reads module state, subscribes for cross-component re-render.
// ---------------------------------------------------------------------------

export interface UseAgentLang {
  /** The active language. */
  lang: AgentLang;
  /** Switch language (persists + broadcasts to every mounted hook). */
  setLang: (lang: AgentLang) => void;
  /** Translator bound to `lang` (interpolates `{var}`; fail-soft). */
  t: TFunc;
  /** Text direction — 'rtl' for Arabic, 'ltr' otherwise. */
  dir: 'rtl' | 'ltr';
}

/**
 * React hook exposing `{ lang, setLang, t, dir }`. Provider-free: it seeds from
 * the module-level current language and registers a listener so `setLang` from
 * ANY component (or another tab, via the storage bridge) re-renders every mount.
 * The listener is torn down on unmount. `t` is rebuilt per-render bound to the
 * current language (cheap — it closes over the static table).
 */
export function useAgentLang(): UseAgentLang {
  const [lang, setLangState] = useState<AgentLang>(currentLang);

  useEffect(() => {
    // Subscribe. If the module language changed between initial render and this
    // effect (a fast race), sync immediately so we never show a stale language.
    const listener = (next: AgentLang) => setLangState(next);
    listeners.add(listener);
    if (currentLang !== lang) setLangState(currentLang);
    return () => {
      listeners.delete(listener);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    lang,
    setLang: setAgentLang,
    t: tFor(lang),
    dir: dirFor(lang),
  };
}

// ---------------------------------------------------------------------------
// THE STRING CATALOGUE.
//
// fr = the CURRENT R7 strings VERBATIM (scanned from the agents pages +
// components). ar = short, commerce-appropriate Algerian darja in Arabic
// script. Keys are dotted + grouped by surface. Interpolation uses `{var}`.
//
// The full key list (key → fr) is mirrored in NOTES.md §KEY-CATALOG so the
// consuming builders (Cadence / Retouche / Poli) reference EXACT keys.
// ---------------------------------------------------------------------------

export interface AgentStringPair {
  fr: string;
  ar: string;
}

export const AGENT_STRINGS: Record<string, AgentStringPair> = {
  // ── common / shared (buttons, generic states reused across surfaces) ──────
  'common.retry': { fr: 'Réessayer', ar: 'عاود' },
  'common.back': { fr: '← Retour', ar: '← ارجع' },
  'common.cancel': { fr: 'Annuler', ar: 'ألغِ' },
  'common.continue': { fr: 'Continuer →', ar: 'كمّل →' },
  'common.beta': { fr: 'béta', ar: 'تجريبي' },
  'common.open': { fr: 'Ouvrir', ar: 'حل' },
  'common.soon': { fr: 'Bientôt', ar: 'قريب' },
  'common.active': { fr: 'Actif', ar: 'يخدم' },
  'common.view': { fr: 'Voir →', ar: 'شوف →' },
  'common.refresh': { fr: 'Rafraîchir', ar: 'حدّث' },

  // ── language toggle ───────────────────────────────────────────────────────
  'lang.toggleTitle': { fr: 'Changer de langue', ar: 'بدّل اللغة' },
  'lang.fr': { fr: 'Français', ar: 'الفرنسية' },
  'lang.ar': { fr: 'العربية', ar: 'العربية' },

  // ── /agents HOME (index.tsx) ──────────────────────────────────────────────
  'home.tabTitle': { fr: 'Agents', ar: 'الوكلاء' },
  'home.title': { fr: 'Vos agents', ar: 'الوكلاء تاعك' },
  'home.subtitle': {
    fr: 'Vos employés IA — ils travaillent pour vous, jour et nuit.',
    ar: 'الموظفين تاعك بالذكاء الاصطناعي — يخدمو عليك ليل و نهار.',
  },
  'home.loading': { fr: 'Chargement de vos agents…', ar: 'كي نحمّلو الوكلاء تاعك…' },
  'home.disabled.title': {
    fr: 'Les agents ne sont pas activés',
    ar: 'الوكلاء ماشي مفعّلين',
  },
  'home.disabled.body': {
    fr: 'Cette fonctionnalité est désactivée sur ce serveur. Revenez plus tard — vos employés IA vous attendront ici.',
    ar: 'هاد الخاصية مطفية على هاد السيرفور. ارجع من بعد — الموظفين تاعك يستناوك هنا.',
  },
  'home.error.title': {
    fr: 'Impossible de charger vos agents',
    ar: 'ما قدرناش نحمّلو الوكلاء تاعك',
  },
  'home.cta.title': { fr: 'Recrutez un nouvel employé IA', ar: 'وظّف موظّف جديد بالذكاء الاصطناعي' },
  'home.cta.body': {
    fr: 'Choisissez une mission — confirmer vos commandes, répondre sur WhatsApp, surveiller vos concurrents — donnez-lui un nom, ses outils, et lancez un test.',
    ar: 'اختار خدمة — تأكيد الكوموندات، الرد على واتساب، مراقبة لكونكيران — سمّيه، اختارلو الأدوات، و جرّبه.',
  },
  'home.cta.hint': { fr: 'اختار الخدمة، سمّيه، و جرّبه فدقيقة.', ar: 'اختار الخدمة، سمّيه، و جرّبه فدقيقة.' },
  'home.cta.button': { fr: '+ Créer un agent', ar: '+ زيد وكيل' },
  'home.empty': {
    fr: 'Aucun agent pour l’instant. Créez votre premier employé IA ci-dessus.',
    ar: 'ما كاش وكلاء دروك. زيد أول موظّف تاعك من فوق.',
  },
  'home.recent.title': { fr: 'Exécutions récentes', ar: 'العمليات الأخيرة' },
  'home.recent.empty': {
    fr: 'Aucune exécution récente. Ouvrez un agent et donnez-lui une mission.',
    ar: 'ما كاش عمليات أخيرة. حل وكيل و أعطيه خدمة.',
  },

  // ── /agents/new · CREATE CUSTOM AGENT (create-agent.tsx — R12, Atelier) ────
  // The custom-agent creator: pick an archetype (clone Hermès/OpenClaw), give it
  // a name + emoji + persona, review, POST. FR default + short DZ darja (same
  // commerce voice as the shop pages). `{n}` = chars remaining; `{archetype}` =
  // the chosen archetype's title.
  'create.tabTitle': { fr: 'Créer un agent', ar: 'زيد وكيل' },
  'create.title': { fr: 'Créer un agent', ar: 'زيد وكيل' },
  'create.subtitle': {
    fr: 'Créez votre propre employé IA — partez d’un modèle, donnez-lui un nom et une mission.',
    ar: 'اصنع الموظّف تاعك بالذكاء الاصطناعي — ابدا من نموذج، سمّيه و أعطيه مهمة.',
  },
  'create.loading': { fr: 'Chargement…', ar: 'كي نحمّلو…' },
  'create.soon.title': {
    fr: 'La création d’agents arrive bientôt',
    ar: 'صناعة الوكلاء جاية قريب',
  },
  'create.soon.body': {
    fr: 'Cette fonctionnalité n’est pas encore activée sur ce serveur. Bientôt, vous pourrez créer vos propres agents à partir de nos modèles.',
    ar: 'هاد الخاصية لسه ماشي مفعّلة على هاد السيرفور. قريب تقدر تصنع الوكلاء تاعك من النماذج تاعنا.',
  },

  // step labels (3-dot stepper)
  'create.step.archetype': { fr: 'Modèle', ar: 'النموذج' },
  'create.step.identity': { fr: 'Identité', ar: 'الهوية' },
  'create.step.review': { fr: 'Récap', ar: 'المراجعة' },

  // step 1 — archetype
  'create.archetype.heading': { fr: 'Choisissez un modèle', ar: 'اختار نموذج' },
  'create.archetype.operator.title': { fr: 'Opérateur', ar: 'مشغّل' },
  'create.archetype.operator.desc': {
    fr: 'Comme Hermès — commandes, clients, messages. Idéal pour les opérations de votre boutique.',
    ar: 'كيما Hermès — الكوموندات، الكليان، الرسائل. مليح للعمليات تاع المحل.',
  },
  'create.archetype.engineer.title': { fr: 'Ingénieur', ar: 'مهندس' },
  'create.archetype.engineer.desc': {
    fr: 'Comme OpenClaw — écrit et exécute du code dans un sandbox. Pour les outils et automatisations.',
    ar: 'كيما OpenClaw — يكتب و يشغّل الكود ف سandbox. للأدوات و الأتمتة.',
  },

  // step 2 — identity
  'create.identity.heading': { fr: 'Son identité', ar: 'هويتو' },
  'create.identity.name.label': { fr: 'Nom de l’agent', ar: 'اسم الوكيل' },
  'create.identity.name.placeholder': {
    fr: 'Ex. Assistant commandes',
    ar: 'مثلا: مساعد الكوموندات',
  },
  'create.identity.name.hint': {
    fr: '{n} caractères restants — c’est le nom affiché.',
    ar: 'باقي {n} حرف — هذا الاسم اللي يبان.',
  },
  'create.identity.emoji.label': { fr: 'Emoji (optionnel)', ar: 'إيموجي (اختياري)' },
  'create.identity.emoji.hint': {
    fr: 'Choisissez-en un, ou collez le vôtre.',
    ar: 'اختار واحد، ولا الصق تاعك.',
  },
  'create.identity.emoji.placeholder': { fr: 'Emoji', ar: 'إيموجي' },
  'create.identity.persona.label': { fr: 'Mission / persona (optionnel)', ar: 'المهمة / الشخصية (اختياري)' },
  'create.identity.persona.hint': {
    fr: 'Une phrase ou deux sur son rôle. Modifiable plus tard.',
    ar: 'جملة ولا زوج على دورو. تقدر تبدّلها من بعد.',
  },
  'create.identity.persona.placeholder': {
    fr: 'Ex. Tu confirmes les commandes COD et tu réponds aux clients avec politesse.',
    ar: 'مثلا: تأكّد كوموندات الدفع عند الاستلام و تجاوب الكليان بأدب.',
  },

  // step 3 — review
  'create.review.heading': { fr: 'Vérifiez avant de créer', ar: 'راجع قبل ما تصنع' },
  'create.review.hint': {
    fr: 'كلش مليح ؟ اضغط « Créer » و نصنعوه.',
    ar: 'كلش مليح ؟ اضغط « Créer » و نصنعوه.',
  },
  'create.review.noPersona': { fr: 'Aucune mission précisée.', ar: 'ما كاش مهمة محدّدة.' },
  'create.review.unnamed': { fr: 'Agent sans nom', ar: 'وكيل بلا اسم' },
  'create.review.archetypeLine': { fr: 'Basé sur : {archetype}', ar: 'مبني على : {archetype}' },

  // submit + errors
  'create.submit': { fr: '✨ Créer l’agent', ar: '✨ اصنع الوكيل' },
  'create.submitting': { fr: 'Création…', ar: 'كي نصنعو…' },
  'create.err.404': {
    fr: 'La création d’agents n’est pas activée sur ce serveur.',
    ar: 'صناعة الوكلاء ماشي مفعّلة على هاد السيرفور.',
  },
  'create.err.limit': {
    fr: 'Vous avez atteint le nombre maximum d’agents. Supprimez-en un pour en créer un nouveau.',
    ar: 'وصلت العدد الأقصى تاع الوكلاء. امسح واحد باش تصنع جديد.',
  },
  'create.err.generic': {
    fr: 'Impossible de créer l’agent. Réessayez.',
    ar: 'ما قدرناش نصنعو الوكيل. عاود.',
  },

  // ── AGENT CARD (agent-card.tsx) ───────────────────────────────────────────
  'card.hermes.blurb': {
    fr: 'Agent des opérations — commandes, clients, messages.',
    ar: 'وكيل العمليات — الكوموندات، الكليان، الرسائل.',
  },
  'card.hermes.darja': { fr: 'يدبّرلك الخدمة اليومية.', ar: 'يدبّرلك الخدمة اليومية.' },
  'card.openclaw.blurb': {
    fr: 'Agent développeur — code, outils et automatisations.',
    ar: 'وكيل مطوّر — كود، أدوات و أتمتة.',
  },
  'card.openclaw.darja': { fr: 'يكوديلك الأدوات و يأتمت.', ar: 'يكوديلك الأدوات و يأتمت.' },
  'card.fallback.blurb': { fr: 'Agent IA.', ar: 'وكيل بالذكاء الاصطناعي.' },
  'card.status.active': { fr: 'Actif', ar: 'يخدم' },
  'card.status.inactive': { fr: 'Inactif', ar: 'ما يخدمش' },
  'card.channel.web': { fr: 'Web', ar: 'ويب' },
  'card.channel.web.title': { fr: 'Accessible depuis le web', ar: 'تقدر تحلّو من الويب' },
  'card.channel.telegram': { fr: 'Telegram', ar: 'تيليغرام' },
  'card.channel.telegram.on': { fr: 'Telegram connecté', ar: 'تيليغرام مربوط' },
  'card.channel.telegram.off': {
    fr: 'Telegram non connecté — à lier dans les connexions',
    ar: 'تيليغرام ماشي مربوط — اربطو من الاتصالات',
  },
  'card.lastRun': { fr: 'Dernière exécution', ar: 'آخر عملية' },
  'card.lastRun.none': { fr: 'Aucune pour l’instant', ar: 'ما كاش دروك' },
  'card.action.open': { fr: 'Ouvrir', ar: 'حل' },
  'card.action.runs': { fr: 'Exécutions', ar: 'العمليات' },
  'card.action.configure': { fr: 'Configurer', ar: 'إعدادات' },

  // ── relative time (shared by home + card + runs) ──────────────────────────
  'time.now': { fr: "à l'instant", ar: 'دروك' },
  'time.minAgo': { fr: 'il y a {n} min', ar: 'من {n} دقيقة' },
  'time.hrAgo': { fr: 'il y a {n} h', ar: 'من {n} سا' },
  'time.dayAgo': { fr: 'il y a {n} j', ar: 'من {n} يوم' },
  'time.weekAgo': { fr: 'il y a {n} sem', ar: 'من {n} سيمانة' },
  'time.monthAgo': { fr: 'il y a {n} mois', ar: 'من {n} شهر' },
  'time.yearAgo': { fr: 'il y a {n} an(s)', ar: 'من {n} عام' },

  // ── run STATES (shared chips: home / card / runs / run) ───────────────────
  'states.queued': { fr: 'En file', ar: 'فالدور' },
  'states.running': { fr: 'En cours', ar: 'يخدم' },
  'states.waiting_approval': { fr: 'En attente', ar: 'يستنى' },
  'states.waiting_approval.short': { fr: 'Approbation', ar: 'موافقة' },
  'states.done': { fr: 'Terminé', ar: 'كمل' },
  'states.failed': { fr: 'Échoué', ar: 'فشل' },
  'states.failed.short': { fr: 'Échec', ar: 'فشل' },
  'states.stopped': { fr: 'Arrêté', ar: 'موقّف' },
  'states.unknown': { fr: 'Inconnu', ar: 'ماشي معروف' },

  // ── HIRE WIZARD (wizard.tsx) ──────────────────────────────────────────────
  'wizard.tabTitle': { fr: 'Embaucher un agent', ar: 'وظّف وكيل' },
  'wizard.step.job': { fr: 'Le poste', ar: 'المنصب' },
  'wizard.step.identity': { fr: 'Identité', ar: 'الهوية' },
  'wizard.step.tools': { fr: 'Outils & canaux', ar: 'الأدوات و القنوات' },
  'wizard.step.trigger': { fr: 'Déclencheur', ar: 'المشغّل' },
  'wizard.step.test': { fr: 'Essai', ar: 'تجربة' },
  'wizard.progress': { fr: 'Étape {current}/{total} · {label}', ar: 'مرحلة {current}/{total} · {label}' },

  'wizard.job.title': { fr: 'Quel poste voulez-vous pourvoir ?', ar: 'أنهي منصب تحب تعمّر ؟' },
  'wizard.job.subtitle': {
    fr: 'Choisissez le travail à confier — واش تحب يدير ليك. On préremplit tout le reste.',
    ar: 'اختار الخدمة اللي تحب توكّلها — واش تحب يدير ليك. الباقي نعمّروه حنا.',
  },
  'wizard.job.opsTag': { fr: '🪽 Agent opérations', ar: '🪽 وكيل العمليات' },
  'wizard.job.devTag': { fr: '🛠️ Agent développeur', ar: '🛠️ وكيل مطوّر' },
  'wizard.job.scratch.title': { fr: 'Partir de zéro', ar: 'ابدا من الصفر' },
  'wizard.job.scratch.darja': { fr: 'نبدا من الصفر', ar: 'نبدا من الصفر' },
  'wizard.job.scratch.desc': {
    fr: 'Configurez un agent opérations vierge et décrivez son rôle vous-même.',
    ar: 'إعمل وكيل عمليات فارغ و وصّف دورو بيدك.',
  },

  'wizard.identity.title': { fr: 'Présentez votre nouvel employé', ar: 'قدّم الموظّف الجديد تاعك' },
  'wizard.identity.subtitle.preset': {
    fr: 'Pour le poste « {job} » — ajustez son nom et sa mission.',
    ar: 'للمنصب « {job} » — بدّل الاسم و المهمة.',
  },
  'wizard.identity.subtitle.blank': {
    fr: 'Donnez-lui un nom et décrivez sa mission.',
    ar: 'سمّيه و وصّف مهمتو.',
  },
  'wizard.identity.name.label': { fr: 'Nom de l’agent', ar: 'اسم الوكيل' },
  'wizard.identity.name.hint': {
    fr: 'Jusqu’à 40 caractères — c’est le nom affiché.',
    ar: 'حتى 40 حرف — هذا الاسم اللي يبان.',
  },
  'wizard.identity.persona.label': { fr: 'Mission / persona', ar: 'المهمة / الشخصية' },
  'wizard.identity.persona.hint': {
    fr: 'Une phrase ou deux. Modifiable plus tard.',
    ar: 'جملة ولا زوج. تقدر تبدّلها من بعد.',
  },
  'wizard.identity.openclaw.note': {
    fr: 'L’agent développeur écrit et exécute du code dans un sandbox isolé — pas besoin de persona. Vous pourrez ajuster ses préférences après l’embauche.',
    ar: 'الوكيل المطوّر يكتب و يشغّل الكود ف سandbox معزول — ما يلزمش شخصية. تقدر تبدّل الإعدادات من بعد التوظيف.',
  },

  'wizard.tools.title': { fr: 'Outils & canaux', ar: 'الأدوات و القنوات' },
  'wizard.tools.subtitle': {
    fr: 'Ce que votre agent peut utiliser. Vous pourrez tout changer plus tard.',
    ar: 'واش يقدر يستعمل الوكيل تاعك. تقدر تبدّل كلش من بعد.',
  },
  'wizard.tools.web.label': { fr: 'Accès web', ar: 'الوصول للويب' },
  'wizard.tools.web.on': {
    fr: 'Recherche et lecture de pages web en direct.',
    ar: 'يقلّب و يقرا صفحات الويب مباشرة.',
  },
  'wizard.tools.web.off': {
    fr: 'L’accès web n’est pas activé sur ce serveur pour l’instant.',
    ar: 'الوصول للويب ماشي مفعّل على هاد السيرفور دروك.',
  },
  'wizard.tools.channels': { fr: 'Canaux', ar: 'القنوات' },
  'wizard.tools.channels.hint': {
    fr: 'Les canaux se relient après l’embauche depuis la page Connexions. {telegram}WhatsApp arrivent bientôt.',
    ar: 'القنوات تتربط من بعد التوظيف من صفحة الاتصالات. {telegram}واتساب جايين قريب.',
  },
  'wizard.tools.channels.hint.telegramPrefix': { fr: 'Telegram et ', ar: 'تيليغرام و ' },
  'wizard.tools.suggested': { fr: 'Outils suggérés pour ce poste', ar: 'أدوات مقترحة للمنصب' },
  'wizard.tools.suggested.hint': {
    fr: 'Ces outils seront proposés à votre agent selon ce qui est disponible sur votre compte. Gérez les connexions depuis {link}.',
    ar: 'هاد الأدوات تتقترح على الوكيل حسب واش متوفّر ف الكونط تاعك. دبّر الاتصالات من {link}.',
  },
  'wizard.tools.integrationsLink': { fr: 'Intégrations', ar: 'التكاملات' },
  'wizard.tools.noTools': {
    fr: 'Aucun outil spécifique pour ce poste — votre agent planifiera ses actions et vous pourrez connecter des apps depuis Intégrations.',
    ar: 'ما كاش أدوات خاصة للمنصب — الوكيل يخطّط خدمتو و تقدر تربط أبليكاسيونات من التكاملات.',
  },
  'wizard.tools.openclaw.note': {
    fr: 'L’agent développeur travaille dans son sandbox de code — les outils sont l’éditeur, le terminal et l’aperçu en direct.',
    ar: 'الوكيل المطوّر يخدم ف سandbox الكود تاعو — الأدوات هوما المحرّر، التيرمينال و المعاينة المباشرة.',
  },

  'wizard.trigger.title': { fr: 'Quand doit-il travailler ?', ar: 'وقتاش يخدم ؟' },
  'wizard.trigger.subtitle': {
    fr: 'Pour l’instant, votre agent travaille à la demande.',
    ar: 'دروك، الوكيل تاعك يخدم كي تطلب منو.',
  },
  'wizard.trigger.manual.title': { fr: 'Manuel', ar: 'يدوي' },
  'wizard.trigger.manual.hint': {
    fr: 'Vous lancez chaque tâche vous-même depuis la page de l’agent.',
    ar: 'تطلق كل خدمة بيدك من صفحة الوكيل.',
  },
  'wizard.trigger.schedule.title': { fr: 'Planification', ar: 'برمجة' },
  'wizard.trigger.schedule.hint': {
    fr: 'Faire tourner l’agent automatiquement (ex. tous les matins). لسه ماشي جاهز.',
    ar: 'خلّي الوكيل يخدم وحدو (مثلا كل صباح). لسه ماشي جاهز.',
  },
  'wizard.trigger.banner': {
    fr: 'La planification automatique arrive prochainement. Pour l’instant, tout est manuel — vous gardez le contrôle sur chaque exécution.',
    ar: 'البرمجة الأوتوماتيكية جاية قريب. دروك كلش يدوي — راك تتحكّم ف كل عملية.',
  },

  'wizard.test.title': { fr: 'Faites-lui passer un essai', ar: 'جرّبو' },
  'wizard.test.subtitle': {
    fr: 'Lancez une première tâche pour voir {name} à l’œuvre — c’est optionnel avant l’embauche.',
    ar: 'أطلق أول خدمة باش تشوف {name} كيفاش يخدم — اختياري قبل التوظيف.',
  },
  'wizard.test.taskLabel': { fr: 'Tâche d’essai', ar: 'خدمة التجربة' },
  'wizard.test.start': { fr: '▶️ Lancer l’essai', ar: '▶️ أطلق التجربة' },
  'wizard.test.starting': { fr: 'Lancement de l’essai…', ar: 'كي نطلقو التجربة…' },
  'wizard.test.started': {
    fr: 'Essai lancé ✓ — {name} travaille en arrière-plan. Vous pouvez suivre son exécution en direct.',
    ar: 'التجربة تطلقت ✓ — {name} يخدم ف الخلفية. تقدر تتبّع العملية مباشرة.',
  },
  'wizard.test.openRun': { fr: 'Voir l’exécution →', ar: 'شوف العملية →' },
  'wizard.test.banner': {
    fr: 'Prêt ? Cliquez sur « Embaucher » ci-dessous : on enregistre votre agent et on vous emmène à la page des agents.',
    ar: 'واجد ؟ أضغط على « وظّف » من تحت: نسجّلو الوكيل تاعك و نوديوك لصفحة الوكلاء.',
  },
  'wizard.test.err.404': {
    fr: 'Les essais en direct ne sont pas encore activés sur ce serveur — vous pourrez lancer votre agent depuis /agents après l’embauche.',
    ar: 'التجارب المباشرة لسه ماشي مفعّلة على هاد السيرفور — تقدر تطلق الوكيل من /agents من بعد التوظيف.',
  },
  'wizard.test.err.429': {
    fr: 'Limite d’essais atteinte pour aujourd’hui. Réessayez plus tard.',
    ar: 'وصلت حدّ التجارب تاع اليوم. عاود من بعد.',
  },
  'wizard.test.err.generic': { fr: 'Impossible de lancer l’essai. Réessayez.', ar: 'ما قدرناش نطلقو التجربة. عاود.' },

  'wizard.hire.openclaw': { fr: '🛠️ Embaucher mon agent', ar: '🛠️ وظّف الوكيل تاعي' },
  'wizard.hire.hermes': { fr: '🪽 Embaucher mon employé', ar: '🪽 وظّف الموظّف تاعي' },
  'wizard.hire.saving': { fr: 'Embauche…', ar: 'كي نوظّفو…' },
  'wizard.hire.err.generic': {
    fr: 'Impossible de finaliser l’embauche. Réessayez.',
    ar: 'ما قدرناش نكمّلو التوظيف. عاود.',
  },
  'wizard.done.title': { fr: '{name} est embauché !', ar: '{name} تّوظّف !' },
  'wizard.done.openclaw': {
    fr: 'Votre agent développeur est prêt. Confiez-lui une tâche et regardez-le construire.',
    ar: 'الوكيل المطوّر تاعك واجد. أعطيه خدمة و شوفو كيفاش يبني.',
  },
  'wizard.done.hermes': {
    fr: 'Votre employé est prêt. Retrouvez-le sur la page des agents pour lancer des tâches et suivre ses exécutions.',
    ar: 'الموظّف تاعك واجد. تلقاه ف صفحة الوكلاء باش تطلق الخدمات و تتبّع العمليات.',
  },
  'wizard.done.cta': { fr: 'Voir mes agents →', ar: 'شوف الوكلاء تاعي →' },

  // ── SINGLE RUN view (run.tsx) ─────────────────────────────────────────────
  'run.tabTitle': { fr: '{agent} · run', ar: '{agent} · عملية' },
  'run.header.title': { fr: '{agent} · exécution', ar: '{agent} · عملية' },
  'run.header.subtitle': {
    fr: 'Exécution en arrière-plan · run f el background',
    ar: 'عملية ف الخلفية · تخدم و انت مغلّق',
  },
  'run.back.title': { fr: 'Retour aux exécutions', ar: 'ارجع للعمليات' },
  'run.stop': { fr: '⏹ Arrêter', ar: '⏹ وقّف' },
  'run.stop.title': { fr: 'Arrêter l\'exécution', ar: 'وقّف العملية' },
  'run.loading': { fr: "Attache à l'exécution…", ar: 'كي نربطو بالعملية…' },
  'run.error.load': { fr: 'Impossible de charger cette exécution.', ar: 'ما قدرناش نحمّلو هاد العملية.' },
  'run.error.title': { fr: 'Erreur du run.', ar: 'خطأ ف العملية.' },
  'run.sandbox.title': { fr: 'Espace de travail · sandbox', ar: 'فضاء الخدمة · سandbox' },
  'run.openclaw.title': { fr: 'Espace de travail OpenClaw', ar: 'فضاء خدمة OpenClaw' },
  'run.openclaw.body': {
    fr: 'Les fichiers, le terminal et l\'aperçu vivent dans le studio OpenClaw.',
    ar: 'الملفات، التيرمينال و المعاينة يعيشو ف ستوديو OpenClaw.',
  },
  'run.openclaw.open': { fr: 'Ouvrir OpenClaw →', ar: 'حل OpenClaw →' },
  'run.quiet.title': { fr: 'Agents non activés', ar: 'الوكلاء ماشي مفعّلين' },
  'run.quiet.body': {
    fr: 'Cette exécution est introuvable ou les agents ne sont pas activés sur ce serveur.',
    ar: 'هاد العملية ما تلقاتش ولا الوكلاء ماشي مفعّلين على هاد السيرفور.',
  },

  // ── RUNS history (runs.tsx) ───────────────────────────────────────────────
  'runs.tabTitle': { fr: 'Exécutions', ar: 'العمليات' },
  'runs.title': { fr: 'Exécutions', ar: 'العمليات' },
  'runs.subtitle': {
    fr: 'L\'historique de tes runs en arrière-plan · el historique ta3 les runs · streaming en direct au clic.',
    ar: 'تاريخ العمليات تاعك ف الخلفية · شوفها مباشرة كي تكليكي.',
  },
  'runs.filter.label': { fr: 'Filtrer par agent', ar: 'فلتر حسب الوكيل' },
  'runs.loading': { fr: 'Chargement des exécutions…', ar: 'كي نحمّلو العمليات…' },
  'runs.error.load': { fr: 'Impossible de charger les exécutions.', ar: 'ما قدرناش نحمّلو العمليات.' },
  'runs.untitled': { fr: 'Run sans titre', ar: 'عملية بلا عنوان' },
  'runs.empty.title': { fr: 'Pas encore d\'exécutions', ar: 'ما كاش عمليات دروك' },
  'runs.empty.body': {
    fr: 'Lance un run en arrière-plan avec {agent} — makach walou pour l\'instant. Il continue même si tu fermes l\'onglet.',
    ar: 'أطلق عملية ف الخلفية مع {agent} — ما كاش والو دروك. يكمّل حتى كي تغلّق التاب.',
  },
  'runs.quiet.title': { fr: 'Agents non activés', ar: 'الوكلاء ماشي مفعّلين' },
  'runs.quiet.body': {
    fr: 'Les exécutions d\'agents ne sont pas activées sur ce serveur.',
    ar: 'عمليات الوكلاء ماشي مفعّلة على هاد السيرفور.',
  },

  // ── CONNECTIONS (connections.tsx) ─────────────────────────────────────────
  'connections.tabTitle': { fr: 'Connexions', ar: 'الاتصالات' },
  'connections.title': { fr: 'Connexions', ar: 'الاتصالات' },
  'connections.subtitle': {
    fr: 'Branchez vos agents aux canaux de vos clients. Telegram, WhatsApp, accès web et intégrations — koulech f blasa wehda.',
    ar: 'اربط الوكلاء تاعك بقنوات الكليان. تيليغرام، واتساب، الويب و التكاملات — كلش ف بلاصة وحدة.',
  },
  'connections.loading': { fr: 'Chargement des connexions…', ar: 'كي نحمّلو الاتصالات…' },
  'connections.error.load': {
    fr: 'Impossible de charger vos connexions : {error}',
    ar: 'ما قدرناش نحمّلو الاتصالات تاعك : {error}',
  },
  'connections.status.ok': { fr: 'activé', ar: 'مفعّل' },
  'connections.status.off': { fr: 'désactivé', ar: 'مطفي' },
  'connections.status.soon': { fr: 'bientôt', ar: 'قريب' },
  'connections.status.studio': { fr: 'studio', ar: 'ستوديو' },
  'connections.status.connected': { fr: 'en attente', ar: 'يستنى' },
  'connections.status.unconfigured': { fr: 'non-configuré', ar: 'ماشي معدّ' },
  'connections.status.unlinked': { fr: 'non-lié', ar: 'ماشي مربوط' },

  'connections.telegram.title': { fr: 'Telegram', ar: 'تيليغرام' },
  'connections.telegram.subtitle': {
    fr: 'Discutez avec vos agents depuis Telegram — donnez vos tâches men l\'application.',
    ar: 'هدر مع الوكلاء تاعك من تيليغرام — أعطي خدماتك من الأبليكاسيون.',
  },
  'connections.telegram.dark': {
    fr: 'Telegram bientôt disponible — un bot doit être configuré. Reviens bientôt.',
    ar: 'تيليغرام قريب متوفّر — لازم يتعدّ بوت. ارجع قريب.',
  },
  'connections.telegram.link': { fr: 'Lier mon Telegram', ar: 'اربط تيليغرام تاعي' },
  'connections.telegram.linking': { fr: 'Génération du lien…', ar: 'كي نجيبو الرابط…' },
  'connections.telegram.open': { fr: 'Ouvrir Telegram', ar: 'حل تيليغرام' },
  'connections.telegram.copy': { fr: 'Copier le lien', ar: 'إنسخ الرابط' },
  'connections.telegram.copied': { fr: 'Copié', ar: 'تنسخ' },
  'connections.telegram.instructions': {
    fr: 'Ouvre le lien, appuie sur Démarrer (Start) — w rak lié. Le lien expire après 10 minutes.',
    ar: 'حل الرابط، أضغط على Démarrer (Start) — و راك مربوط. الرابط يفوت من بعد 10 دقايق.',
  },
  'connections.telegram.err': {
    fr: 'Liaison Telegram indisponible.',
    ar: 'ربط تيليغرام ماشي متوفّر.',
  },
  'connections.telegram.err.retry': { fr: '{error} — 3awd mera (réessayez).', ar: '{error} — عاود مرة.' },

  'connections.whatsapp.title': { fr: 'WhatsApp', ar: 'واتساب' },
  'connections.whatsapp.subtitle': {
    fr: 'Vos agents répondront aux clients sur WhatsApp — 3la numéro du magasin.',
    ar: 'الوكلاء تاعك يجاوبو الكليان على واتساب — على نيميرو المحل.',
  },
  'connections.whatsapp.soon': {
    fr: 'Bientôt : connectez le numéro WhatsApp de votre boutique via la passerelle ERP. Vos agents confirmeront les commandes COD et répondront aux clients directement sur WhatsApp.',
    ar: 'قريب: اربط نيميرو واتساب تاع المحل عن طريق بوابة ERP. الوكلاء يأكّدو كوموندات الدفع عند الاستلام و يجاوبو الكليان مباشرة على واتساب.',
  },
  'connections.whatsapp.configured': {
    fr: 'WhatsApp connecté via la passerelle ERP — vos agents peuvent envoyer des messages sur votre numéro.',
    ar: 'واتساب مربوط عن طريق بوابة ERP — الوكلاء يقدرو يصيفطو رسائل على النيميرو تاعك.',
  },

  'connections.web.title': { fr: 'Accès web', ar: 'الوصول للويب' },
  'connections.web.subtitle': {
    fr: 'La recherche web pour vos agents — bech ylo9aw l\'info f\'internet.',
    ar: 'البحث ف الويب للوكلاء تاعك — باش يلقاو المعلومة ف الأنترنت.',
  },
  'connections.web.on': {
    fr: 'Vos agents peuvent chercher sur le web pour répondre avec des infos à jour (prix concurrents, actualités, recherche produit).',
    ar: 'الوكلاء يقدرو يقلّبو ف الويب باش يجاوبو بمعلومات جديدة (أسعار لكونكيران، الأخبار، البحث على المنتوج).',
  },
  'connections.web.off': {
    fr: 'L\'accès web est actuellement désactivé pour vos agents. Contactez l\'admin pour l\'activer.',
    ar: 'الوصول للويب مطفي دروك للوكلاء تاعك. اتصل بالأدمين باش يفعّلو.',
  },

  'connections.integrations.title': { fr: 'Intégrations', ar: 'التكاملات' },
  'connections.integrations.subtitle': {
    fr: 'Connectez Gmail, Sheets, et +100 apps via Composio — zid les outils l\'agents.',
    ar: 'اربط Gmail، Sheets و +100 أبليكاسيون عن طريق Composio — زيد أدوات للوكلاء.',
  },
  'connections.integrations.body': {
    fr: 'Ouvrez le studio d\'intégrations pour connecter vos applications externes et donner de nouveaux outils à vos agents.',
    ar: 'حل ستوديو التكاملات باش تربط الأبليكاسيونات الخارجية و تعطي أدوات جديدة للوكلاء.',
  },
  'connections.integrations.open': { fr: 'Ouvrir les intégrations', ar: 'حل التكاملات' },

  'connections.schedule.title': { fr: 'Planification', ar: 'البرمجة' },
  'connections.schedule.subtitle': {
    fr: 'Faites tourner vos agents automatiquement — chaque heure, chaque jour, ou par webhook.',
    ar: 'خلّي الوكلاء يخدمو وحدهم — كل ساعة، كل يوم، ولا بويبهوك.',
  },
  'connections.schedule.body': {
    fr: 'Créez des déclencheurs planifiés ou par webhook pour que vos agents travaillent sans vous.',
    ar: 'إعمل مشغّلات مبرمجة ولا بويبهوك باش الوكلاء يخدمو بلا ما تكون.',
  },
  'connections.schedule.open': { fr: 'Gérer la planification', ar: 'دبّر البرمجة' },

  // ── CHANNELS · BYOT Telegram (channel-card.tsx — R10, per-agent bot) ───────
  'channels.byot.title': { fr: 'Telegram — votre bot', ar: 'تيليغرام — البوت تاعك' },
  'channels.byot.step1': {
    fr: '1. Ouvre @BotFather sur Telegram',
    ar: '1. حل @BotFather على تيليغرام',
  },
  'channels.byot.step2': {
    fr: '2. Envoie /newbot et suis les étapes',
    ar: '2. صيفط /newbot و اتبع الخطوات',
  },
  'channels.byot.step3': { fr: '3. Colle le token ici', ar: '3. الصق التوكن هنا' },
  'channels.byot.tokenPlaceholder': {
    fr: 'Colle le token de ton bot (123456:ABC-…)',
    ar: 'الصق توكن البوت تاعك (123456:ABC-…)',
  },
  'channels.byot.connect': { fr: 'Connecter', ar: 'اربط' },
  'channels.byot.connecting': { fr: 'Vérification du bot…', ar: 'كي نتأكّدو من البوت…' },
  'channels.byot.connected': { fr: 'Connecté', ar: 'مربوط' },
  'channels.byot.since': { fr: 'Connecté le {when}', ar: 'مربوط من {when}' },
  'channels.byot.test': { fr: 'Tester', ar: 'جرّب' },
  'channels.byot.testing': { fr: 'Envoi d’un message test…', ar: 'كي نصيفطو رسالة تجربة…' },
  'channels.byot.tested': { fr: 'Message de test envoyé ✓', ar: 'رسالة التجربة تصيفطت ✓' },
  'channels.byot.testEmpty': {
    fr: 'Envoie d’abord un message à ton bot, puis réessaie.',
    ar: 'صيفط لوّل رسالة للبوت تاعك، من بعد عاود.',
  },
  'channels.byot.disconnect': { fr: 'Déconnecter', ar: 'افصل' },
  'channels.byot.hint': {
    fr: 'Ton token reste privé — chiffré, jamais affiché.',
    ar: 'التوكن تاعك يبقى سرّي — مشفّر، ما يبانش.',
  },
  'channels.byot.invalidToken': {
    fr: 'Token invalide — vérifie et réessaie.',
    ar: 'التوكن ماشي صحيح — تأكّد و عاود.',
  },

  // ── CHANNELS · WhatsApp pair-by-code (whatsapp-channel-card.tsx — R16) ──────
  // Per-(user,agent) WhatsApp pairing. The middle face shows an 8-char code the
  // user types into WhatsApp > Linked Devices > "Link with phone number". Same
  // register as channels.byot.* — short, code-switched FR / Arabic-script darja.
  'channels.wa.title': { fr: 'WhatsApp — votre numéro', ar: 'واتساب — النيميرو تاعك' },
  'channels.wa.subtitle': {
    fr: 'Vos agents répondront aux clients sur WhatsApp — 3la numéro du magasin.',
    ar: 'الوكلاء تاعك يجاوبو الكليان على واتساب — على نيميرو المحل.',
  },
  'channels.wa.step1': {
    fr: '1. Entre le numéro WhatsApp de ta boutique',
    ar: '1. دخّل نيميرو واتساب تاع المحل',
  },
  'channels.wa.step2': {
    fr: '2. On te donne un code à 8 caractères',
    ar: '2. نعطيوك كود من 8 حروف',
  },
  'channels.wa.step3': {
    fr: '3. WhatsApp > Appareils liés > Lier avec le numéro',
    ar: '3. واتساب > الأجهزة المربوطة > اربط بالنيميرو',
  },
  'channels.wa.phonePlaceholder': {
    fr: 'Numéro avec indicatif (+213…)',
    ar: 'النيميرو مع الاندكاتيف (+213…)',
  },
  'channels.wa.connect': { fr: 'Connecter', ar: 'اربط' },
  'channels.wa.hint': {
    fr: 'On n\'envoie aucun message sans ton accord.',
    ar: 'ما نصيفطو حتى رسالة بلا إذنك.',
  },
  'channels.wa.pairing': { fr: 'Génération du code…', ar: 'كي نجيبو الكود…' },
  'channels.wa.codeIntro': {
    fr: 'Ton code (valable 3 min) :',
    ar: 'الكود تاعك (يدوم 3 دقايق) :',
  },
  'channels.wa.codeSteps': {
    fr: 'Ouvre WhatsApp sur ton téléphone → Appareils liés → Lier avec le numéro → tape ce code.',
    ar: 'حل واتساب في التيليفون → الأجهزة المربوطة → اربط بالنيميرو → اكتب هاد الكود.',
  },
  'channels.wa.waiting': { fr: 'En attente de la liaison…', ar: 'كي نستناو الربط…' },
  'channels.wa.reissue': { fr: 'Renvoyer un code', ar: 'عاود صيفط كود' },
  'channels.wa.copy': { fr: 'Copier le code', ar: 'إنسخ الكود' },
  'channels.wa.copied': { fr: 'Copié', ar: 'تنسخ' },
  'channels.wa.connected': { fr: 'Connecté', ar: 'مربوط' },
  'channels.wa.since': { fr: 'Connecté le {when}', ar: 'مربوط من {when}' },
  'channels.wa.test': { fr: 'Tester', ar: 'جرّب' },
  'channels.wa.testing': { fr: 'Envoi d\'un message test…', ar: 'كي نصيفطو رسالة تجربة…' },
  'channels.wa.tested': { fr: 'Message de test envoyé ✓', ar: 'رسالة التجربة تصيفطت ✓' },
  'channels.wa.testEmpty': { fr: 'Ré-essaie dans un instant.', ar: 'عاود من بعد شوية.' },
  'channels.wa.disconnect': { fr: 'Déconnecter', ar: 'افصل' },
  'channels.wa.dark': {
    fr: 'WhatsApp bientôt disponible. Reviens bientôt.',
    ar: 'واتساب قريب متوفّر. ارجع قريب.',
  },
  // Error-message mapping (backend failure → user-facing; never a raw stack/HTTP).
  'channels.wa.err.mintFailed': {
    fr: 'Impossible de générer le code. 3awd mera.',
    ar: 'ما قدرناش نجيبو الكود. عاود مرة.',
  },
  'channels.wa.err.rateLimit': {
    fr: 'Trop de tentatives. Attends un instant w 3awd.',
    ar: 'برشا محاولات. استنى شوية و عاود.',
  },
  'channels.wa.err.badPhone': {
    fr: 'Numéro invalide — vérifie l\'indicatif (+213…).',
    ar: 'النيميرو ماشي صحيح — تأكّد من الاندكاتيف (+213…).',
  },
  'channels.wa.err.expired': {
    fr: 'Code expiré. Renvoie un nouveau code.',
    ar: 'الكود فات. عاود صيفط كود جديد.',
  },
  'channels.wa.err.testFail': {
    fr: 'Envoi impossible pour l\'instant. 3awd mera.',
    ar: 'ما نجّمناش نصيفطو دروك. عاود مرة.',
  },
  'channels.wa.err.signedOut': {
    fr: 'Session expirée — reconnecte-toi.',
    ar: 'الجلسة فاتت — عاود دخّل.',
  },
  'channels.wa.err.generic': {
    fr: 'Une erreur s\'est produite. 3awd mera.',
    ar: 'وقع مشكل. عاود مرة.',
  },

  // ── OPENCLAW SETUP · sandbox + wizard + dashboard (R16 i18n + real probe) ───
  // Replaces the hardcoded English in openclaw-shared.tsx / wizard.tsx /
  // dashboard.tsx. Honest copy: "provisioning" provisions NOTHING (no per-user
  // Vercel account); the sandbox test is a real create→exec→teardown probe.
  'openclaw.sandbox.title': { fr: 'Sandbox', ar: 'الساندبوكس' },
  'openclaw.sandbox.enabled': { fr: 'Sandbox actif', ar: 'الساندبوكس خدّام' },
  'openclaw.sandbox.disabled': { fr: 'Sandbox désactivé', ar: 'الساندبوكس مطفي' },
  'openclaw.sandbox.chipLive': { fr: 'en direct', ar: 'مباشر' },
  'openclaw.sandbox.chipOff': { fr: 'génération seule', ar: 'توليد فقط' },
  'openclaw.sandbox.live': {
    fr: 'Sandbox actif — tes tâches s\'exécutent en vrai.',
    ar: 'الساندبوكس خدّام — الخدمات تتنفّذ بصح.',
  },
  'openclaw.sandbox.liveLong': {
    fr: 'Les tâches s\'exécutent dans un microVM isolé — les fichiers sont écrits, les commandes tournent, et les apps web ont un aperçu en direct.',
    ar: 'الخدمات تتنفّذ ف microVM معزول — الفيشيي يتكتبو، الكوموندات يخدمو، و الأبليكاسيونات ويب عندها معاينة مباشرة.',
  },
  'openclaw.sandbox.off': {
    fr: 'Exécution en direct désactivée : {reason} Le code est écrit et expliqué, mais pas exécuté.',
    ar: 'التنفيذ المباشر مطفي : {reason} الكود يتكتب و يتشرح، بصح ما يتنفّذش.',
  },
  'openclaw.sandbox.offGeneric': {
    fr: 'Exécution en direct désactivée sur ce serveur. Le code est écrit et expliqué, mais pas exécuté.',
    ar: 'التنفيذ المباشر مطفي على هاد السيرفور. الكود يتكتب و يتشرح، بصح ما يتنفّذش.',
  },
  'openclaw.sandbox.checking': {
    fr: 'Vérification de la disponibilité du sandbox…',
    ar: 'كي نتأكّدو من توفّر الساندبوكس…',
  },
  'openclaw.sandbox.testing': { fr: 'Test du sandbox en cours…', ar: 'كي نجرّبو الساندبوكس…' },
  'openclaw.sandbox.testOk': {
    fr: 'Sandbox OK — création + exécution + arrêt réussis.',
    ar: 'الساندبوكس مليح — تصنع، تنفّذ و توقّف بنجاح.',
  },
  'openclaw.sandbox.testOkMs': {
    fr: '✅ Sandbox opérationnel ({ms}ms)',
    ar: '✅ الساندبوكس خدّام ({ms}ms)',
  },
  'openclaw.sandbox.test': { fr: 'Tester le sandbox', ar: 'جرّب الساندبوكس' },
  'openclaw.sandbox.recheck': { fr: 'Revérifier', ar: 'عاود تأكّد' },
  'openclaw.sandbox.retry': { fr: 'Réessayer', ar: 'عاود' },
  // Sandbox reason mapping (classified backend reason → merchant copy; never raw).
  'openclaw.sandbox.err.atCapacity': {
    fr: 'Trop d\'agents actifs en ce moment. Réessaye dans un instant.',
    ar: 'برشا وكلاء خدّامين دروك. عاود من بعد شوية.',
  },
  'openclaw.sandbox.err.coldStart': {
    fr: 'Le sandbox démarre (démarrage à froid). Réessaye dans quelques secondes.',
    ar: 'الساندبوكس كي يبدا (démarrage à froid). عاود بعد شوية سواني.',
  },
  'openclaw.sandbox.err.token': {
    fr: 'Exécution indisponible (compte). Le code est écrit mais pas exécuté.',
    ar: 'التنفيذ ماشي متوفّر (الحساب). الكود يتكتب بصح ما يتنفّذش.',
  },
  'openclaw.sandbox.err.probeFail': {
    fr: 'Sandbox injoignable pour l\'instant. 3awd mera.',
    ar: 'الساندبوكس ماشي موصول دروك. عاود مرة.',
  },
  'openclaw.sandbox.err.capsLoad': {
    fr: 'Impossible de vérifier le sandbox.',
    ar: 'ما قدرناش نتأكّدو من الساندبوكس.',
  },
  // Wizard copy (steps + terminal phases). "Setup" saves DEFAULTS, provisions nothing.
  'openclaw.wizard.saving': { fr: 'Enregistrement de ton OpenClaw…', ar: 'كي نسجّلو OpenClaw تاعك…' },
  'openclaw.wizard.savingHint': { fr: 'Ça prend juste un instant.', ar: 'ياخذ غير شوية.' },
  'openclaw.wizard.tryAgain': { fr: 'Réessayer', ar: 'عاود' },
  'openclaw.wizard.backToReview': { fr: 'Retour au récap', ar: 'ارجع للملخّص' },
  'openclaw.wizard.saveError': {
    fr: 'Impossible d\'enregistrer ton setup. 3awd mera.',
    ar: 'ما قدرناش نسجّلو الإعداد تاعك. عاود مرة.',
  },
  'openclaw.wizard.welcomeTitle': { fr: 'Configure ton agent codeur', ar: 'إعدّ الوكيل الكودور تاعك' },
  'openclaw.wizard.welcomeSubtitle': {
    fr: 'OpenClaw est ton agent codeur IA. Décris une tâche : il écrit les fichiers, les exécute dans un sandbox isolé, streame la sortie et — pour les apps web — montre un aperçu en direct. Choisissons quelques réglages.',
    ar: 'OpenClaw هو الوكيل الكودور تاع الذكاء الاصطناعي تاعك. وصف خدمة : يكتب الفيشيي، ينفّذهم ف ساندبوكس معزول، يستريمي الخرجة و — للأبليكاسيونات ويب — يوري معاينة مباشرة. نختارو شوية إعدادات.',
  },
  'openclaw.wizard.welcomeLi1': { fr: 'Le runtime par défaut de tes tâches', ar: 'الرونتايم الافتراضي تاع خدماتك' },
  'openclaw.wizard.welcomeLi2': { fr: 'Si les aperçus s\'ouvrent automatiquement', ar: 'واش المعاينات يتحلّو وحدهم' },
  'openclaw.wizard.welcomeLi3': { fr: 'Une vérification rapide que l\'exécution est disponible', ar: 'تأكّد سريع بلي التنفيذ متوفّر' },
  'openclaw.wizard.runtimeTitle': { fr: 'Runtime par défaut', ar: 'الرونتايم الافتراضي' },
  'openclaw.wizard.runtimeSubtitle': {
    fr: 'Les nouvelles tâches démarrent dans ce runtime. Tu peux changer par tâche depuis le composer à tout moment.',
    ar: 'الخدمات الجداد يبداو ف هاد الرونتايم. تقدر تبدّل لكل خدمة من الكومبوزور وقت ما تحب.',
  },
  'openclaw.wizard.previewTitle': { fr: 'Aperçu en direct', ar: 'المعاينة المباشرة' },
  'openclaw.wizard.previewSubtitle': {
    fr: 'Quand une tâche démarre un serveur web, OpenClaw expose une URL d\'aperçu en direct. Doit-il basculer automatiquement sur l\'onglet Aperçu quand une est prête ?',
    ar: 'كي خدمة تبدا سيرفور ويب، OpenClaw يعطي URL معاينة مباشرة. لازم يبدّل وحده لللونجلي معاينة كي تكون واحدة حاضرة ؟',
  },
  'openclaw.wizard.previewToggle': { fr: 'Ouvrir l\'aperçu automatiquement', ar: 'حل المعاينة وحدها' },
  'openclaw.wizard.previewHint': {
    fr: 'Recommandé pour les apps web. Désactive si tu préfères rester sur le terminal.',
    ar: 'مستحسن للأبليكاسيونات ويب. طفّي إذا تحب تبقى ف التيرمينال.',
  },
  'openclaw.wizard.sandboxTitle': { fr: 'État du sandbox', ar: 'حالة الساندبوكس' },
  'openclaw.wizard.sandboxSubtitle': {
    fr: 'L\'exécution en direct fait tourner ton code dans un microVM isolé. Voici s\'il est disponible sur ce serveur maintenant.',
    ar: 'التنفيذ المباشر يخلّي الكود تاعك يخدم ف microVM معزول. هاك واش متوفّر على هاد السيرفور دروك.',
  },
  'openclaw.wizard.sandboxGenerateOnly': {
    fr: 'Tu peux quand même configurer et utiliser OpenClaw — il générera et expliquera le code sans l\'exécuter. Si l\'exécution en direct est activée plus tard, tes tâches tournent pour de vrai sans réglage supplémentaire.',
    ar: 'تقدر بلمعقول تعدّ و تستعمل OpenClaw — يولّد و يشرح الكود بلا ما ينفّذه. إذا التنفيذ المباشر يتفعّل من بعد، خدماتك يخدمو بصح بلا إعداد زايد.',
  },
  'openclaw.wizard.reviewTitle': { fr: 'Récapitulatif', ar: 'الملخّص' },
  'openclaw.wizard.reviewSubtitle': {
    fr: 'Voici ton setup. Tu peux tout changer plus tard depuis le dashboard.',
    ar: 'هاك الإعداد تاعك. تقدر تبدّل كلش من بعد من الدашبورد.',
  },
  'openclaw.wizard.rowRuntime': { fr: 'Runtime par défaut', ar: 'الرونتايم الافتراضي' },
  'openclaw.wizard.rowPreview': { fr: 'Ouverture auto de l\'aperçu', ar: 'فتح المعاينة وحدها' },
  'openclaw.wizard.rowExec': { fr: 'Exécution en direct', ar: 'التنفيذ المباشر' },
  'openclaw.wizard.valOn': { fr: 'Oui', ar: 'إيه' },
  'openclaw.wizard.valOff': { fr: 'Non', ar: 'لا' },
  'openclaw.wizard.valUnknown': { fr: 'Inconnu', ar: 'ماعرفناش' },
  'openclaw.wizard.valExecOn': { fr: 'Activée (en direct)', ar: 'مفعّلة (مباشر)' },
  'openclaw.wizard.valExecOff': { fr: 'Désactivée (génération seule)', ar: 'مطفية (توليد فقط)' },
  'openclaw.wizard.reviewNote': {
    fr: 'On enregistre ces réglages sur ton compte et on t\'emmène à ton dashboard OpenClaw.',
    ar: 'نسجّلو هاد الإعدادات على الحساب تاعك و نوصّلوك للدашبورد تاع OpenClaw.',
  },
  'openclaw.wizard.edit': { fr: 'Modifier', ar: 'بدّل' },
  'openclaw.wizard.back': { fr: '← Retour', ar: '← ارجع' },
  'openclaw.wizard.cancel': { fr: 'Annuler', ar: 'ألغِ' },
  'openclaw.wizard.getStarted': { fr: 'Commencer', ar: 'ابدا' },
  'openclaw.wizard.continue': { fr: 'Continuer', ar: 'كمّل' },
  'openclaw.wizard.finish': { fr: 'Terminer la configuration', ar: 'كمّل الإعداد' },
  'openclaw.done.title': { fr: 'OpenClaw est prêt', ar: 'OpenClaw واجد' },
  'openclaw.done.subtitle': {
    fr: 'Ton agent codeur est configuré. Lance une tâche et regarde-le construire.',
    ar: 'الوكيل الكودور تاعك معدّ. أطلق خدمة و شوفه كي يبني.',
  },
  'openclaw.done.runtime': { fr: 'Runtime', ar: 'رونتايم' },
  'openclaw.done.autoPreview': { fr: 'Aperçu auto', ar: 'معاينة أوتو' },
  'openclaw.done.goDashboard': { fr: 'Aller au dashboard', ar: 'روح للدашبورد' },
  // Dashboard copy.
  'openclaw.dash.startTitle': { fr: 'Lancer une tâche de code', ar: 'أطلق خدمة كود' },
  'openclaw.dash.startHint': {
    fr: 'Décris quoi construire — {runtime} · sandbox {mode}.',
    ar: 'وصف واش تبني — {runtime} · الساندبوكس {mode}.',
  },
  'openclaw.dash.newTask': { fr: '+ Nouvelle tâche', ar: '+ خدمة جديدة' },
  'openclaw.dash.yourDefaults': { fr: 'Tes réglages', ar: 'الإعدادات تاعك' },
  'openclaw.dash.probing': { fr: 'Sonde du sandbox…', ar: 'كي نسبرو الساندبوكس…' },
  'openclaw.dash.lampLive': { fr: 'Sandbox en direct — les tâches s\'exécutent.', ar: 'الساندبوكس مباشر — الخدمات تتنفّذ.' },
  'openclaw.dash.lampErr': { fr: 'Échec du chargement des capacités du sandbox.', ar: 'فشل تحميل قدرات الساندبوكس.' },
  'openclaw.dash.edit': { fr: 'Modifier', ar: 'بدّل' },
  'openclaw.dash.plannerOff': {
    fr: 'Le planificateur IA n\'est pas configuré — l\'exécution est désactivée tant que l\'admin n\'a pas défini {key}.',
    ar: 'المخطّط تاع الذكاء الاصطناعي ماشي معدّ — التنفيذ مطفي حتى يعدّ الأدمين {key}.',
  },

  // ── RUN TIMELINE (run-timeline.tsx) ───────────────────────────────────────
  'timeline.stepsLabel': { fr: 'Étapes du run', ar: 'مراحل العملية' },
  'timeline.loading': { fr: 'Chargement du run…', ar: 'كي نحمّلو العملية…' },
  'timeline.queued': { fr: 'En file d’attente…', ar: 'فالدور…' },
  'timeline.starting': { fr: "L'agent démarre…", ar: 'الوكيل كي يبدا…' },
  'timeline.thinking': { fr: "L'agent réfléchit…", ar: 'الوكيل كي يخمّم…' },
  'timeline.noSteps': { fr: 'Aucune étape.', ar: 'ما كاش مراحل.' },
  'timeline.terminalNoSteps': { fr: '{state} — aucune étape enregistrée.', ar: '{state} — ما كاش مراحل مسجّلة.' },
  'timeline.done': { fr: 'Terminé', ar: 'كمل' },
  'timeline.failed': { fr: 'Échec', ar: 'فشل' },
  'timeline.stopped': { fr: 'Arrêté', ar: 'موقّف' },
  'timeline.finalAnswer': { fr: 'Réponse finale', ar: 'الجواب النهائي' },

  // ── TOOL CALL CARD (tool-call-card.tsx) — section labels + status pills ────
  'toolcall.detail': { fr: 'Detail', ar: 'التفصيل' },
  'toolcall.toolCall': { fr: 'Tool call', ar: 'استدعاء أداة' },
  'toolcall.arguments': { fr: 'Arguments', ar: 'الوسائط' },
  'toolcall.result': { fr: 'Result', ar: 'النتيجة' },
  'toolcall.error': { fr: 'Error', ar: 'خطأ' },
  'toolcall.pill.failed': { fr: 'failed', ar: 'فشل' },
  'toolcall.pill.ok': { fr: 'ok', ar: 'مزيان' },
  'toolcall.pill.thinking': { fr: 'thinking', ar: 'يخمّم' },
  'toolcall.pill.pending': { fr: 'pending', ar: 'يستنى' },
  'toolcall.fallback': { fr: 'Outil', ar: 'أداة' },

  // ── VERBS (tool slug → running/done labels; tool-call-card.tsx VERB_MAP) ───
  'verbs.web_search.running': { fr: 'Recherche web…', ar: 'بحث ف الويب…' },
  'verbs.web_search.done': { fr: 'Recherche web', ar: 'بحث ف الويب' },
  'verbs.web_fetch.running': { fr: "Lecture d'une page…", ar: 'قراية صفحة…' },
  'verbs.web_fetch.done': { fr: 'Page lue', ar: 'الصفحة تقرات' },
  'verbs.web_crawl.running': { fr: "Lecture d'une page…", ar: 'قراية صفحة…' },
  'verbs.web_crawl.done': { fr: 'Page lue', ar: 'الصفحة تقرات' },
  'verbs.web_browse.running': { fr: "Lecture d'une page…", ar: 'قراية صفحة…' },
  'verbs.web_browse.done': { fr: 'Page lue', ar: 'الصفحة تقرات' },
  'verbs.telegram_send.running': { fr: 'Envoi Telegram…', ar: 'إرسال تيليغرام…' },
  'verbs.telegram_send.done': { fr: 'Message Telegram envoyé', ar: 'رسالة تيليغرام تصيفطت' },
  'verbs.whatsapp_send.running': { fr: 'Envoi WhatsApp…', ar: 'إرسال واتساب…' },
  'verbs.whatsapp_send.done': { fr: 'Message WhatsApp envoyé', ar: 'رسالة واتساب تصيفطت' },
  'verbs.shop_erp_summary.running': { fr: 'Lecture ERP…', ar: 'قراية ERP…' },
  'verbs.shop_erp_summary.done': { fr: 'ERP consulté', ar: 'ERP تشاف' },
  'verbs.shops_list.running': { fr: 'Liste des boutiques…', ar: 'ليستة المحلات…' },
  'verbs.shops_list.done': { fr: 'Boutiques listées', ar: 'المحلات تلستاو' },
  'verbs.code.running': { fr: 'Exécution…', ar: 'تشغيل…' },
  'verbs.code.done': { fr: 'Code exécuté', ar: 'الكود تشغّل' },
  'verbs.run.running': { fr: 'Exécution…', ar: 'تشغيل…' },
  'verbs.run.done': { fr: 'Commande exécutée', ar: 'الأمر تشغّل' },
  'verbs.shell.running': { fr: 'Exécution…', ar: 'تشغيل…' },
  'verbs.shell.done': { fr: 'Commande exécutée', ar: 'الأمر تشغّل' },

  // ── ARTIFACTS PANEL (artifacts-panel.tsx) ─────────────────────────────────
  'artifacts.title': { fr: 'Livrables', ar: 'المخرجات' },
  'artifacts.group.file': { fr: 'Fichiers', ar: 'الملفات' },
  'artifacts.group.output': { fr: 'Sorties', ar: 'المخرجات' },
  'artifacts.group.link': { fr: 'Liens', ar: 'الروابط' },
  'artifacts.empty.title': { fr: "Aucun livrable pour l'instant", ar: 'ما كاش مخرجات دروك' },
  'artifacts.empty.body': {
    fr: "Les fichiers, pages et liens produits par l'agent apparaîtront ici.",
    ar: 'الملفات، الصفحات و الروابط اللي يديرهم الوكيل يبانو هنا.',
  },
  'artifacts.open': { fr: 'Ouvrir', ar: 'حل' },
  'artifacts.open.newTab': { fr: 'Ouvrir dans un nouvel onglet', ar: 'حل ف تاب جديد' },
  'artifacts.download': { fr: 'Télécharger', ar: 'تحميل' },
  'artifacts.fallback': { fr: 'Livrable', ar: 'مخرج' },
  'artifacts.file.fallback': { fr: 'fichier', ar: 'ملف' },
  'artifacts.output.fallback': { fr: 'Sortie', ar: 'مخرج' },
  'artifacts.link.fallback': { fr: 'Lien', ar: 'رابط' },

  // ── ARTIFACTS LIBRARY page (artifacts.tsx — R10, WS11-6, Musée) ───────────
  // The full-page "Livrables" library: every deliverable (file/output/link)
  // across ALL runs, filterable by agent. Reuses the artifacts.* group above
  // for card fallbacks + open/download affordances; these keys are the PAGE
  // chrome (tab, header, filter, states) — distinct so the page copy can differ
  // from the in-run side panel (artifacts-panel.tsx).
  'artifactslib.tabTitle': { fr: 'Livrables', ar: 'المخرجات' },
  'artifactslib.title': { fr: 'Livrables', ar: 'المخرجات' },
  'artifactslib.subtitle': {
    fr: 'Tous les fichiers, sorties et liens produits par vos agents — koulech f blasa wehda.',
    ar: 'كل الملفات، المخرجات و الروابط اللي داروهم الوكلاء تاعك — كلش ف بلاصة وحدة.',
  },
  'artifactslib.filter.label': { fr: 'Filtrer par agent', ar: 'فلتر حسب الوكيل' },
  'artifactslib.filter.all': { fr: 'Tous', ar: 'الكل' },
  'artifactslib.loading': { fr: 'Chargement des livrables…', ar: 'كي نحمّلو المخرجات…' },
  'artifactslib.error.load': {
    fr: 'Impossible de charger les livrables.',
    ar: 'ما قدرناش نحمّلو المخرجات.',
  },
  'artifactslib.empty.title': { fr: "Aucun livrable pour l'instant", ar: 'ما كاش مخرجات دروك' },
  'artifactslib.empty.body': {
    fr: "Les fichiers, pages et liens produits par vos agents apparaîtront ici — lance un run pour commencer.",
    ar: 'الملفات، الصفحات و الروابط اللي يديرهم الوكلاء يبانو هنا — أطلق عملية باش تبدا.',
  },
  'artifactslib.quiet.title': { fr: 'Agents non activés', ar: 'الوكلاء ماشي مفعّلين' },
  'artifactslib.quiet.body': {
    fr: 'Les livrables des agents ne sont pas activés sur ce serveur.',
    ar: 'مخرجات الوكلاء ماشي مفعّلة على هاد السيرفور.',
  },
  'artifactslib.card.fromRun': { fr: 'Exécution {run}', ar: 'عملية {run}' },
  'artifactslib.card.openRun': { fr: 'Voir l’exécution →', ar: 'شوف العملية →' },

  // ── SPEND METER (spend-meter.tsx) ─────────────────────────────────────────
  'spend.title': { fr: 'Coût estimé', ar: 'التكلفة التقديرية' },
  'spend.toolCall.one': { fr: 'appel d’outil', ar: 'استدعاء أداة' },
  'spend.toolCall.many': { fr: 'appels d’outils', ar: 'استدعاءات أدوات' },
  'spend.tool.one': { fr: 'outil', ar: 'أداة' },
  'spend.tool.many': { fr: 'outils', ar: 'أدوات' },
  'spend.tokens': { fr: '{value} tokens', ar: '{value} توكن' },
  'spend.tokens.est': { fr: '≈ {value} tokens (est.)', ar: '≈ {value} توكن (تقديري)' },
  'spend.perThousand': { fr: '{price} DZD / 1k', ar: '{price} دج / 1k' },
  'spend.note.exact': { fr: 'Estimé — coût indicatif, non facturé ici.', ar: 'تقديري — تكلفة إرشادية، ماشي فاتورة.' },
  'spend.note.estimated': {
    fr: 'Estimé d’après le nombre d’appels d’outils — pas une facture.',
    ar: 'تقديري حسب عدد استدعاءات الأدوات — ماشي فاتورة.',
  },
  'spend.note.unpriced': {
    fr: 'Prix par 1k tokens non configuré : aucun montant affiché.',
    ar: 'السعر لكل 1k توكن ماشي معدّ: ما كاش مبلغ يبان.',
  },
  'spend.title.compact.unpriced': {
    fr: 'Prix par 1k tokens non configuré — appels d’outils uniquement',
    ar: 'السعر لكل 1k توكن ماشي معدّ — استدعاءات الأدوات برك',
  },

  // ── TRIGGERS page (triggers.tsx, upcoming — Cadence owns it) ──────────────
  'triggers.tabTitle': { fr: 'Planification', ar: 'البرمجة' },
  'triggers.title': { fr: 'Planification', ar: 'البرمجة' },
  'triggers.subtitle': {
    fr: 'Faites travailler vos agents automatiquement — chaque heure, chaque jour, ou par webhook.',
    ar: 'خلّي الوكلاء يخدمو وحدهم — كل ساعة، كل يوم، ولا بويبهوك.',
  },
  'triggers.loading': { fr: 'Chargement des déclencheurs…', ar: 'كي نحمّلو المشغّلات…' },
  'triggers.error.load': { fr: 'Impossible de charger les déclencheurs.', ar: 'ما قدرناش نحمّلو المشغّلات.' },
  'triggers.empty.title': { fr: 'Aucun déclencheur', ar: 'ما كاش مشغّلات' },
  'triggers.empty.body': {
    fr: 'Créez un déclencheur pour que votre agent travaille automatiquement, même quand vous êtes absent.',
    ar: 'إعمل مشغّل باش الوكيل يخدم وحدو، حتى كي ما تكونش.',
  },
  'triggers.quiet.title': { fr: 'Planification non activée', ar: 'البرمجة ماشي مفعّلة' },
  'triggers.quiet.body': {
    fr: 'La planification d\'agents n\'est pas activée sur ce serveur.',
    ar: 'برمجة الوكلاء ماشي مفعّلة على هاد السيرفور.',
  },
  'triggers.create.title': { fr: 'Nouveau déclencheur', ar: 'مشغّل جديد' },
  'triggers.create': { fr: '+ Créer un déclencheur', ar: '+ زيد مشغّل' },
  'triggers.creating': { fr: 'Création…', ar: 'كي نصنعو…' },
  'triggers.create.err': { fr: 'Impossible de créer le déclencheur. Réessayez.', ar: 'ما قدرناش نصنعو المشغّل. عاود.' },

  'triggers.kind.label': { fr: 'Type de déclencheur', ar: 'نوع المشغّل' },
  'triggers.kind.cron': { fr: 'Planifié', ar: 'مبرمج' },
  'triggers.kind.webhook': { fr: 'Webhook', ar: 'ويبهوك' },
  'triggers.preset.label': { fr: 'Fréquence', ar: 'الوتيرة' },
  'triggers.preset.hourly': { fr: 'Chaque heure', ar: 'كل ساعة' },
  'triggers.preset.daily': { fr: 'Chaque jour à 09:00', ar: 'كل يوم على 09:00' },
  'triggers.preset.weekly': { fr: 'Chaque lundi à 09:00', ar: 'كل نهار الإثنين على 09:00' },
  'triggers.preset.custom': { fr: 'Personnalisé (HH:MM)', ar: 'مخصّص (سا:دق)' },

  'triggers.prompt.label': { fr: 'Tâche à exécuter', ar: 'الخدمة اللي يدير' },
  'triggers.prompt.hint': {
    fr: 'Ce que l’agent fera à chaque déclenchement — comme une consigne à un employé.',
    ar: 'واش يدير الوكيل ف كل مرة — كيما توصية لموظّف.',
  },
  'triggers.prompt.placeholder': {
    fr: 'Ex. Fais-moi le brief des ventes d’aujourd’hui et signale ce qui demande mon attention.',
    ar: 'مثلا: ديرلي ملخّص البيع تاع اليوم و بيّنلي واش يستاهل انتباهي.',
  },

  'triggers.nextRun': { fr: 'Prochaine exécution : {when}', ar: 'العملية الجاية : {when}' },
  'triggers.lastRun': { fr: 'Dernière : {when}', ar: 'الأخيرة : {when}' },
  'triggers.status.active': { fr: 'Actif', ar: 'يخدم' },
  'triggers.status.paused': { fr: 'En pause', ar: 'موقّف' },
  'triggers.toggle.activate': { fr: 'Activer', ar: 'فعّل' },
  'triggers.toggle.pause': { fr: 'Mettre en pause', ar: 'وقّف' },
  'triggers.delete': { fr: 'Supprimer', ar: 'إمسح' },
  'triggers.deleted': { fr: 'Déclencheur supprimé', ar: 'المشغّل تمسح' },
  'triggers.delete.confirm': {
    fr: 'Supprimer ce déclencheur ? Cette action est définitive.',
    ar: 'تمسح هاد المشغّل ؟ هاد الحاجة ما ترجعش.',
  },

  'triggers.webhook.title': { fr: 'URL du webhook', ar: 'رابط الويبهوك' },
  'triggers.webhook.hint': {
    fr: 'Envoyez une requête POST à cette adresse pour déclencher l’agent. Gardez-la secrète.',
    ar: 'صيفط طلب POST لهاد العنوان باش تشغّل الوكيل. خلّيه سرّي.',
  },
  'triggers.webhook.copy': { fr: 'Copier l’URL', ar: 'إنسخ الرابط' },
  'triggers.webhook.copied': { fr: 'Copié', ar: 'تنسخ' },

  // ── LE BUREAU · Hermès business-pulse hero + desks (R11, WS11-7 — Trame) ──
  // Trame owns this `bureau.*` group (PulseCard / ApprovalInbox / CodDesk /
  // MissionsCard). Business-operations register (commandes COD, wilaya, DZD),
  // FR default + short DZ darja — same commerce voice as the shop pages.
  'bureau.pulse.title': { fr: 'Le pouls du jour', ar: 'نبض اليوم' },
  'card.custom.blurb': { fr: 'Agent personnalisé', ar: 'وكيل مخصّص' },
  'card.custom.delete': { fr: 'Supprimer', ar: 'حذف' },
  'bureau.greeting': { fr: 'Bonjour 👋', ar: 'صباح الخير 👋' },
  'bureau.subtitle': { fr: 'Votre employé des opérations', ar: 'موظّف العمليات تاعك' },
  'bureau.lastSweep': { fr: 'Dernier passage', ar: 'آخر مرّة' },
  'bureau.settings': { fr: 'Réglages', ar: 'الإعدادات' },
  'bureau.talkTo': { fr: 'Parler à Hermès', ar: 'هدر مع Hermès' },
  'bureau.approvals.fallbackTitle': { fr: 'Action à approuver', ar: 'إجراء يحتاج موافقة' },
  'bureau.pulse.ordersToday': { fr: 'Commandes', ar: 'كوموندات' },
  'bureau.pulse.toConfirm': { fr: 'À confirmer', ar: 'باش تأكّد' },
  'bureau.pulse.revenueToday': { fr: 'Chiffre du jour', ar: 'مدخول اليوم' },
  'bureau.pulse.returns': { fr: 'Retours', ar: 'مرجوع' },
  'bureau.pulse.lowStock': { fr: 'Stock bas', ar: 'ستوك ناقص' },
  'bureau.pulse.empty.title': {
    fr: 'Aucune boutique connectée',
    ar: 'ما كاش محل مربوط',
  },
  'bureau.pulse.empty.body': {
    fr: 'Reliez votre boutique et Hermès vous montrera ici les commandes, le chiffre du jour et ce qui demande votre attention.',
    ar: 'اربط المحل تاعك و Hermès يوريك هنا الكوموندات، مدخول اليوم و واش يستاهل انتباهك.',
  },
  'bureau.approve.title': { fr: 'À approuver', ar: 'باش تصادق' },
  'bureau.approve.empty': { fr: 'Rien à approuver', ar: 'ما كاش واش تصادق' },
  'bureau.approve.approve': { fr: 'Approuver', ar: 'صادق' },
  'bureau.approve.deny': { fr: 'Refuser', ar: 'رفض' },
  'bureau.approve.fallbackTitle': { fr: 'Action à valider', ar: 'عملية باش تصادق' },
  'bureau.cod.title': { fr: 'Commandes COD', ar: 'كوموندات الدفع عند الاستلام' },
  'bureau.cod.empty': { fr: 'Aucune commande COD', ar: 'ما كاش كوموندات' },
  'bureau.cod.confirm': { fr: 'Confirmer', ar: 'أكّد' },
  'bureau.cod.advance': { fr: 'Avancer', ar: 'قدّم' },
  'bureau.cod.whatsapp': { fr: 'Écrire sur WhatsApp', ar: 'أكتب على واتساب' },
  'bureau.cod.noName': { fr: 'Client', ar: 'كليان' },
  'bureau.missions.title': { fr: 'Missions programmées', ar: 'مهام مبرمجة' },
  'bureau.missions.manage': { fr: 'Gérer', ar: 'دبّر' },
  'bureau.missions.manual': { fr: 'Manuel', ar: 'يدوي' },
  'bureau.missions.next': { fr: 'dans {when}', ar: 'بعد {when}' },
  'bureau.missions.noPrompt': { fr: 'Sans consigne', ar: 'بلا توصية' },
  'bureau.missions.empty': {
    fr: 'Aucune mission programmée. Planifiez une tâche récurrente et Hermès la fera tout seul.',
    ar: 'ما كاش مهام مبرمجة. برمج خدمة تتعاود و Hermès يديرها وحدو.',
  },

  // ── BUDGET · soft monthly-spend read-out (R11, WS11-11 — Trame) ───────────
  // Trame owns this `budget.*` group (BudgetBar). SOFT wording only — it informs,
  // never blocks (mirrors spend-meter's "non facturé" tone).
  'budget.title': { fr: 'Budget du mois', ar: 'ميزانية الشهر' },
  'budget.noLimit': { fr: 'Sans limite', ar: 'بلا حدّ' },
  'budget.runsToday': { fr: "exéc. aujourd'hui", ar: 'عمليات اليوم' },
  'budget.tokensMonth': { fr: 'tokens ce mois', ar: 'توكن هاد الشهر' },
  'budget.used': { fr: '{pct}% utilisé', ar: 'تستعمل {pct}%' },
  'budget.warn': { fr: '{pct}% — surveillez', ar: '{pct}% — ردّ بالك' },
  'budget.over': { fr: '{pct}% — dépassé', ar: '{pct}% — فات الحدّ' },

  // ── TOOL PERMISSIONS · grouped toggle grid (R11, WS11-10 — Trame) ─────────
  // Trame owns this `toolperms.*` group (ToolPermissions). Consumed by Réglages.
  'toolperms.empty': {
    fr: 'Aucun outil disponible pour cet agent.',
    ar: 'ما كاش أدوات متوفّرة لهاد الوكيل.',
  },
  'toolperms.consequential': {
    fr: 'Action sensible — agit à l’extérieur (envoi, dépense).',
    ar: 'عملية حسّاسة — تدير برّا (إرسال، صرف).',
  },
};

// Default export: the pure translator factory (most common consumer import
// besides the hook), plus everything else via named exports above.
export default tFor;
