// ClickDz Work onboarding — the 20 supported niches.
export interface Niche {
  id: string;
  emoji: string;
  fr: string;
  en: string;
  ar: string;
  descriptionFr: string;
  descriptionEn: string;
  descriptionAr: string;
}

export const NICHES: Niche[] = [
  { id: 'digital-agency', emoji: '🚀', fr: 'Agence digitale', en: 'Digital agency', ar: 'وكالة رقمية', descriptionFr: 'Clients, campagnes, KPIs, devis et facturation', descriptionEn: 'Clients, campaigns, KPIs, quotes and billing', descriptionAr: 'عملاء، حملات، مؤشرات أداء، عروض أسعار وفوترة' },
  { id: 'ecommerce', emoji: '🛒', fr: 'E-commerce / COD', en: 'E-commerce', ar: 'تجارة إلكترونية', descriptionFr: 'Commandes, stock, paiement à la livraison, retours', descriptionEn: 'Orders, inventory, cash on delivery, returns', descriptionAr: 'طلبات، مخزون، الدفع عند الاستلام، إرجاع' },
  { id: 'restaurant', emoji: '🍽️', fr: 'Restaurant / Café', en: 'Restaurant', ar: 'مطعم / مقهى', descriptionFr: 'Menu, réservations, stock cuisine, service', descriptionEn: 'Menu, reservations, kitchen stock, service', descriptionAr: 'قائمة، حجوزات، مخزون المطبخ، خدمة' },
  { id: 'real-estate', emoji: '🏠', fr: 'Immobilier', en: 'Real estate', ar: 'عقارات', descriptionFr: 'Biens, leads, visites, négociations', descriptionEn: 'Properties, leads, visits, negotiations', descriptionAr: 'عقارات، عملاء محتملون، زيارات، تفاوض' },
  { id: 'freelancer', emoji: '💼', fr: 'Freelance / Créateur', en: 'Freelancer', ar: 'مستقل / مبدع', descriptionFr: 'Missions, deadlines, portfolio, facturation', descriptionEn: 'Projects, deadlines, portfolio, invoicing', descriptionAr: 'مشاريع، مواعيد نهائية، أعمال، فوترة' },
  { id: 'startup', emoji: '⚡', fr: 'Startup / SaaS', en: 'Startup', ar: 'شركة ناشئة', descriptionFr: 'Roadmap, sprints, feedback utilisateurs, métriques', descriptionEn: 'Roadmap, sprints, user feedback, metrics', descriptionAr: 'خارطة طريق، sprint، ملاحظات المستخدمين، مؤشرات' },
  { id: 'clinic', emoji: '🩺', fr: 'Cabinet médical', en: 'Medical clinic', ar: 'عيادة طبية', descriptionFr: 'Patients, rendez-vous, dossiers médicaux, ordonnances', descriptionEn: 'Patients, appointments, medical records, prescriptions', descriptionAr: 'مرضى، مواعيد، سجلات طبية، وصفات طبية' },
  { id: 'law-office', emoji: '⚖️', fr: "Cabinet d'avocat", en: 'Law office', ar: 'مكتب محاماة', descriptionFr: 'Dossiers, échéances, jurisprudence, plaidoiries', descriptionEn: 'Cases, deadlines, case law, pleadings', descriptionAr: 'قضايا، مواعيد نهائية، أحكام، مرافعات' },
  { id: 'construction', emoji: '🏗️', fr: 'BTP / Construction', en: 'Construction', ar: 'بناء / مقاولات', descriptionFr: 'Chantiers, fournisseurs, situations, devis', descriptionEn: 'Sites, suppliers, progress reports, quotes', descriptionAr: 'مواقع، موردين، تقارير تقدم، عروض أسعار' },
  { id: 'education', emoji: '🎓', fr: 'Éducation / Formation', en: 'Education', ar: 'تعليم / تدريب', descriptionFr: 'Classes, élèves, supports, progression', descriptionEn: 'Classes, students, materials, progress', descriptionAr: 'فصول، طلاب، مواد تعليمية، تقدم' },
  { id: 'retail', emoji: '🛍️', fr: 'Boutique / Retail', en: 'Retail shop', ar: 'متجر / تجزئة', descriptionFr: 'Stock, ventes, fournisseurs, inventaire', descriptionEn: 'Inventory, sales, suppliers, stocktaking', descriptionAr: 'مخزون، مبيعات، موردين، جرد' },
  { id: 'import-export', emoji: '🚢', fr: 'Import-Export', en: 'Import-Export', ar: 'استيراد وتصدير', descriptionFr: 'Expéditions, douane, devises, fournisseurs', descriptionEn: 'Shipments, customs, currencies, suppliers', descriptionAr: 'شحنات، جمارك، عملات، موردين' },
  { id: 'marketing-team', emoji: '📣', fr: 'Équipe marketing', en: 'Marketing team', ar: 'فريق تسويق', descriptionFr: 'Campagnes, calendrier éditorial, KPIs, contenu', descriptionEn: 'Campaigns, editorial calendar, KPIs, content', descriptionAr: 'حملات، تقويم تحريري، مؤشرات أداء، محتوى' },
  { id: 'hr-recruiting', emoji: '👥', fr: 'RH & Recrutement', en: 'HR & Recruiting', ar: 'موارد بشرية', descriptionFr: 'Postes, candidats, entretiens, onboarding', descriptionEn: 'Positions, candidates, interviews, onboarding', descriptionAr: 'وظائف، مرشحين، مقابلات، إدماج' },
  { id: 'finance', emoji: '💰', fr: 'Comptabilité / Finance', en: 'Finance', ar: 'محاسبة / مالية', descriptionFr: 'Factures, TVA, trésorerie, déclarations', descriptionEn: 'Invoices, VAT, cash flow, tax returns', descriptionAr: 'فواتير، ضريبة قيمة مضافة، تدفق نقدي، إقرارات' },
  { id: 'events', emoji: '🎉', fr: 'Événementiel', en: 'Events', ar: 'تنظيم فعاليات', descriptionFr: 'Mariages, corporate, prestataires, planning', descriptionEn: 'Weddings, corporate, vendors, planning', descriptionAr: 'أعراس، شركات، موردين، تخطيط' },
  { id: 'ngo', emoji: '🤝', fr: 'Association / ONG', en: 'NGO', ar: 'جمعية / منظمة', descriptionFr: 'Projets, adhérents, subventions, bilan', descriptionEn: 'Projects, members, grants, reports', descriptionAr: 'مشاريع، أعضاء، منح، تقارير' },
  { id: 'creative-studio', emoji: '🎬', fr: 'Studio créatif', en: 'Creative studio', ar: 'استوديو إبداعي', descriptionFr: 'Shootings, livrables, matériel, post-prod', descriptionEn: 'Shoots, deliverables, gear, post-production', descriptionAr: 'تصوير، تسليمات، معدات، ما بعد الإنتاج' },
  { id: 'it-services', emoji: '💻', fr: 'Services IT / Dev', en: 'IT services', ar: 'خدمات تكنولوجيا', descriptionFr: 'Sprints, tickets, support, infrastructure', descriptionEn: 'Sprints, tickets, support, infrastructure', descriptionAr: 'sprint، تذاكر، دعم، بنية تحتية' },
  { id: 'personal', emoji: '🌱', fr: 'Personnel / Étudiant', en: 'Personal', ar: 'شخصي / طالب', descriptionFr: 'Objectifs, notes, emploi du temps, projets', descriptionEn: 'Goals, notes, schedule, projects', descriptionAr: 'أهداف، ملاحظات، جدول، مشاريع' },
];

export const ONBOARDED_KEY = 'clickdz:onboarded:v1';
export const PENDING_KEY = 'clickdz:pending-templates:v1';

// ─── E2: Personalization profile ─────────────────────────────────────────────

/** Durable localStorage mirror of the onboarding profile. */
export const CDZ_PROFILE_KEY = 'clickdz:profile:v1';

/** One-shot trigger: workspace-boot consumes this to POST personalize. */
export const PENDING_PERSONALIZE_KEY = 'clickdz:pending-personalize:v1';

/** Primary-goal options shown on the profile step (fr/en/ar). */
export interface Goal {
  id: string;
  fr: string;
  en: string;
  ar: string;
}

export const GOALS: Goal[] = [
  { id: 'sell_online',       fr: 'Vendre en ligne',          en: 'Sell online',          ar: 'البيع عبر الإنترنت' },
  { id: 'create_content',    fr: 'Créer du contenu',         en: 'Create content',        ar: 'إنشاء المحتوى' },
  { id: 'manage_business',   fr: 'Gérer mon business',       en: 'Manage my business',    ar: 'إدارة عملي' },
  { id: 'automate',          fr: 'Automatiser mes tâches',   en: 'Automate my tasks',     ar: 'أتمتة مهامي' },
  { id: 'find_clients',      fr: 'Trouver des clients',      en: 'Find clients',          ar: 'إيجاد عملاء' },
];

/**
 * Canonical onboarding profile — written during welcome finish() and stored
 * server-side via UserSettingsModel (clickdzProfile) + as a localStorage mirror.
 */
export interface CdzOnboardingProfile {
  v: 1;
  lang: 'fr' | 'en' | 'ar';
  brandName: string;
  bizOneLiner?: string;
  niches: string[];
  goals: string[];
  level?: 'beginner' | 'intermediate' | 'pro';
  updatedAt: string;
}

export interface PendingSelection {
  name: string;
  lang: 'fr' | 'en' | 'ar';
  niches: string[]; // niche ids whose 3 docs get installed
}

// ClickDz onboarding CSS fix — dark text on light backgrounds
// Injected via the app bootstrap to ensure readability
export const ONBOARDING_CSS_FIX = `
.clickdz-onboarding-wrapper input,
.clickdz-onboarding-wrapper textarea,
.clickdz-onboarding-wrapper [role="textbox"],
.clickdz-welcome-page input,
.clickdz-welcome-page textarea,
.clickdz-welcome-page [role="textbox"],
.clickdz-setup input,
.clickdz-setup textarea,
.clickdz-setup [role="textbox"] {
  color: #1a1a1a !important;
  -webkit-text-fill-color: #1a1a1a !important;
}
.clickdz-onboarding-wrapper input::placeholder,
.clickdz-welcome-page input::placeholder,
.clickdz-setup input::placeholder {
  color: #666 !important;
  -webkit-text-fill-color: #666 !important;
}
.clickdz-onboarding-wrapper,
.clickdz-welcome-page,
.clickdz-setup {
  --affine-text-primary-color: #1a1a1a !important;
  --affine-input-color: #1a1a1a !important;
}
`; // injected by workspace-boot.tsx into the document head

export const CLICKDZ_ARABIC_ONBOARDING = {
  welcome: 'مرحباً بك في ClickDz Work 👋',
  subtitle: 'دقيقتان لإعداد مساحة عمل مخصصة لك.',
  nameLabel: 'ما اسمك؟',
  namePlaceholder: 'محمد',
  langLabel: 'اللغة المفضلة',
  langFr: '🇫🇷 Français',
  langEn: '🇬🇧 English',
  langAr: '🇸🇦 العربية',
  continue: 'استمر →',
  back: '← رجوع',
  docsTitle: 'مستندات البداية',
  docsSubtitle: 'مختارة لمجالك — أزل التحديد عن ما لا تريده، أو أضف حزمات أخرى.',
  createSpace: 'إنشاء مساحتي ✨',
  commandCenter: 'مركز القيادة',
  workflow: 'سير العمل',
  tracker: 'المتتبع',
  commandCenterDesc: 'لوحة تحكم مركزية لإدارة عملك اليومي، المشاريع، والفريق.',
  workflowDesc: 'خطوات عمل محددة مسبقاً لتنظيم سير العمل لديك.',
  trackerDesc: 'قاعدة بيانات تفاعلية لتتبع العملاء، المبيعات، أو المهام.',
};
