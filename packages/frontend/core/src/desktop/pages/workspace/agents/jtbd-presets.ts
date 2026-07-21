// ---------------------------------------------------------------------------
// JTBD presets — the "job-to-be-done" catalogue that opens the hire-an-employee
// wizard (wizard.tsx). Each card frames the agent as an EMPLOYEE you hire for a
// concrete job ("confirme mes commandes COD", "réponds aux clients WhatsApp"),
// not a cron to configure. Picking a card prefills the wizard's name, persona,
// suggested tools/channels and a starter prompt so a click-through yields a
// useful agent for a real DZ shop.
//
// Pure data — NO React, NO fetching, NO side effects. The wizard imports
// JTBD_PRESETS and maps `agent` to the matching provisioning call:
//   · agent:'hermes'   → saveConfig() (PUT /api/v1/hermes/config)   [ops agent]
//   · agent:'openclaw' → putConfig()  (PUT /api/v1/openclaw/config) [coding]
// Both are the EXISTING per-user config endpoints (see hermes-shared.saveConfig
// and openclaw-shared.putConfig) — this file invents no new API.
//
// Strings are FR primary with a short darja hint (`titleDarja`) the wizard shows
// under the FR title, matching the bilingual register the DZ shop pages use.
// Suggested tool slugs mirror the Hermes capability slugs (internal shop/ERP
// reads + the composio* / whatsapp connectors surfaced by GET
// /api/v1/hermes/capabilities); they are SUGGESTIONS the review step reconciles
// against the live catalogue (unknown/unavailable slugs simply stay unchecked).
// ---------------------------------------------------------------------------

import type { AgentName } from '@affine/core/modules/agents/types';

/**
 * A channel a JTBD card suggests wiring up. `web` and `telegram` map to the
 * agents-endpoint caps (`caps.webEnabled` / `caps.telegramEnabled`); `whatsapp`
 * has no capability flag yet, so the wizard always renders it as "bientôt"
 * (coming soon) — honest, never a fake toggle.
 */
export type JtbdChannel = 'web' | 'telegram' | 'whatsapp';

/**
 * One job-to-be-done card. Pure data — the wizard reads every field; nothing
 * here performs I/O.
 */
export interface JtbdPreset {
  /** Stable id (used as the selection key + review anchor). */
  id: string;
  /** Emoji glyph shown on the card. */
  emoji: string;
  /** French headline — the primary label. */
  titleFr: string;
  /** Algerian-darja hint shown under the FR title (bilingual register). */
  titleDarja: string;
  /** One-line description of the job, in FR. */
  desc: string;
  /** Which agent does this job → picks the provisioning endpoint. */
  agent: AgentName;
  /**
   * Suggested tool slugs to pre-enable (Hermes capability slugs). Reconciled
   * against the live catalogue in the review step; unknown slugs stay off.
   * Empty for OpenClaw (coding agent — tools are the sandbox, not connectors).
   */
  suggestedTools: string[];
  /** Channels this job wants wired up (rendered against live caps). */
  suggestedChannels: JtbdChannel[];
  /** A ready-to-run first task, phrased the way you'd ask the employee. */
  starterPrompt: string;
}

// The curated catalogue. Order is intentional: the highest-leverage DZ shop
// jobs first (COD confirmation, WhatsApp support), then monitoring / reporting,
// then the coding agent, then a general-purpose fallback.
export const JTBD_PRESETS: JtbdPreset[] = [
  {
    id: 'cod-confirm',
    emoji: '📦',
    titleFr: 'Confirme mes commandes COD',
    titleDarja: 'أكّدلي الكوموندات تاع الدفع عند الاستلام',
    desc: 'Passe en revue les nouvelles commandes, contacte les clients sur WhatsApp et confirme le paiement à la livraison avant l’expédition.',
    agent: 'hermes',
    suggestedTools: ['shop-orders', 'shop-list', 'erp-orders', 'whatsapp-send'],
    suggestedChannels: ['whatsapp', 'web'],
    starterPrompt:
      'Liste mes nouvelles commandes (statut « Nouvelle ») sur toutes mes boutiques, puis pour chacune prépare un message WhatsApp court et poli en darja pour confirmer la commande et le paiement à la livraison. Montre-moi les messages avant tout envoi.',
  },
  {
    id: 'whatsapp-support',
    emoji: '💬',
    titleFr: 'Réponds aux clients WhatsApp',
    titleDarja: 'جاوب الكليان على واتساب',
    desc: 'Un agent support qui lit les questions des clients et prépare des réponses claires en darja/français — livraison, prix, disponibilité.',
    agent: 'hermes',
    suggestedTools: ['shop-list', 'shop-products', 'whatsapp-send'],
    suggestedChannels: ['whatsapp', 'web'],
    starterPrompt:
      'Tu es mon agent support client. Quand un client pose une question sur WhatsApp (prix, disponibilité, délai de livraison, wilaya), rédige une réponse courte, polie et exacte en darja ou en français selon la langue du client. Montre-moi chaque réponse avant l’envoi.',
  },
  {
    id: 'competitor-watch',
    emoji: '🔎',
    titleFr: 'Surveille mes concurrents',
    titleDarja: 'راقبلي لكونكيران',
    desc: 'Suit les prix, promos et nouveaux produits de tes concurrents sur le web et te fait un résumé.',
    agent: 'hermes',
    suggestedTools: ['web-search', 'web-fetch'],
    suggestedChannels: ['web'],
    starterPrompt:
      'Recherche sur le web mes principaux concurrents en Algérie pour mes produits, puis résume leurs prix actuels, leurs promotions en cours et tout nouveau produit. Termine par 3 recommandations concrètes pour rester compétitif.',
  },
  {
    id: 'daily-sales-report',
    emoji: '📊',
    titleFr: 'Rapport quotidien des ventes',
    titleDarja: 'راپور تاع لبيع كل نهار',
    desc: 'Un brief chaque jour : commandes, chiffre d’affaires, statuts et ce qui demande attention — sur toutes tes boutiques.',
    agent: 'hermes',
    suggestedTools: ['shop-orders', 'shop-list', 'erp-orders', 'erp-kpis'],
    suggestedChannels: ['web', 'telegram'],
    starterPrompt:
      'Fais-moi le brief des ventes d’aujourd’hui sur toutes mes boutiques : nombre de commandes, chiffre d’affaires, répartition par statut (Nouvelle / Confirmée / Expédiée / Livrée / Retournée) et les produits en rupture. Garde un résumé court en puces et signale ce qui demande mon attention.',
  },
  {
    id: 'code-a-tool',
    emoji: '🛠️',
    titleFr: 'Code-moi un outil',
    titleDarja: 'ديرلي أداة بالكود',
    desc: 'Un agent développeur qui écrit, exécute et prévisualise un petit outil ou script dans un sandbox isolé.',
    agent: 'openclaw',
    suggestedTools: [],
    suggestedChannels: ['web'],
    starterPrompt:
      'Crée une petite page web (HTML/JS) qui calcule les frais de livraison par wilaya à partir d’un tableau que je peux modifier. Lance-la et montre-moi un aperçu en direct.',
  },
  {
    id: 'general-assistant',
    emoji: '✨',
    titleFr: 'Assistant polyvalent',
    titleDarja: 'مساعد يدير كلش',
    desc: 'Un assistant à tout faire : recherche web, résumés, brouillons et petites tâches du quotidien.',
    agent: 'hermes',
    suggestedTools: ['web-search', 'web-fetch', 'shop-list'],
    suggestedChannels: ['web'],
    starterPrompt:
      'Tu es mon assistant polyvalent. Aide-moi sur les tâches du quotidien : recherche sur le web, résumés, brouillons de messages et petites analyses. Commence par te présenter et propose 3 façons de m’aider aujourd’hui.',
  },
];

/** Look up a preset by id (undefined for the "start from scratch" flow). */
export function getJtbdPreset(id: string | null | undefined): JtbdPreset | undefined {
  if (!id) return undefined;
  return JTBD_PRESETS.find(p => p.id === id);
}
