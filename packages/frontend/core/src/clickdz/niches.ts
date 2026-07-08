// ClickDz Work onboarding — the 20 supported niches.
export interface Niche {
  id: string;
  emoji: string;
  fr: string;
  en: string;
}

export const NICHES: Niche[] = [
  { id: 'digital-agency', emoji: '🚀', fr: 'Agence digitale', en: 'Digital agency' },
  { id: 'ecommerce', emoji: '🛒', fr: 'E-commerce / COD', en: 'E-commerce' },
  { id: 'restaurant', emoji: '🍽️', fr: 'Restaurant / Café', en: 'Restaurant' },
  { id: 'real-estate', emoji: '🏠', fr: 'Immobilier', en: 'Real estate' },
  { id: 'freelancer', emoji: '💼', fr: 'Freelance / Créateur', en: 'Freelancer' },
  { id: 'startup', emoji: '⚡', fr: 'Startup / SaaS', en: 'Startup' },
  { id: 'clinic', emoji: '🩺', fr: 'Cabinet médical', en: 'Medical clinic' },
  { id: 'law-office', emoji: '⚖️', fr: "Cabinet d'avocat", en: 'Law office' },
  { id: 'construction', emoji: '🏗️', fr: 'BTP / Construction', en: 'Construction' },
  { id: 'education', emoji: '🎓', fr: 'Éducation / Formation', en: 'Education' },
  { id: 'retail', emoji: '🛍️', fr: 'Boutique / Retail', en: 'Retail shop' },
  { id: 'import-export', emoji: '🚢', fr: 'Import-Export', en: 'Import-Export' },
  { id: 'marketing-team', emoji: '📣', fr: 'Équipe marketing', en: 'Marketing team' },
  { id: 'hr-recruiting', emoji: '👥', fr: 'RH & Recrutement', en: 'HR & Recruiting' },
  { id: 'finance', emoji: '💰', fr: 'Comptabilité / Finance', en: 'Finance' },
  { id: 'events', emoji: '🎉', fr: 'Événementiel', en: 'Events' },
  { id: 'ngo', emoji: '🤝', fr: 'Association / ONG', en: 'NGO' },
  { id: 'creative-studio', emoji: '🎬', fr: 'Studio créatif', en: 'Creative studio' },
  { id: 'it-services', emoji: '💻', fr: 'Services IT / Dev', en: 'IT services' },
  { id: 'personal', emoji: '🌱', fr: 'Personnel / Étudiant', en: 'Personal' },
];

export const ONBOARDED_KEY = 'clickdz:onboarded:v1';
export const PENDING_KEY = 'clickdz:pending-templates:v1';

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
