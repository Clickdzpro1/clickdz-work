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
  lang: 'fr' | 'en';
  niches: string[]; // niche ids whose 3 docs get installed
}
