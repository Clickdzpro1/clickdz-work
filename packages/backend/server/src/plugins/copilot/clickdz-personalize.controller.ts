import { Body, Controller, Get, Logger, Post, Put } from '@nestjs/common';

import { Throttle } from '../../base';
import { CurrentUser } from '../../core/auth';
import { Models } from '../../models';

/**
 * ClickDz Personalization — profile CRUD + AI-powered starter template generation.
 *
 * E2 (workstream P1, welcome-driven personalization):
 *   GET  /api/v1/cdz/profile                  -- returns stored profile or null
 *   PUT  /api/v1/cdz/profile                  -- persists CdzOnboardingProfile
 *   POST /api/v1/cdz/personalize/templates    -- cdz-flash tailored starter artifacts
 *
 * Auth stance: session-gated, NOT @Public. @CurrentUser is ALWAYS used for the
 * user id — never a request-supplied id (CDZ invariant, see clickdz-agent-registry).
 *
 * Failure stance: ALWAYS 200 + a deterministic fallback (mirrors
 * clickdz-prompt-suggestions.controller.ts). Template generation degrades
 * gracefully to TEMPLATE_CONTENT niche packs when cdz-flash is unavailable.
 *
 * Engine: same CDZ_AI_BASE_URL / CDZ_AI_KEY / cdz-flash constants as the
 * suggestions / pulse / prompt-suggestions routes — kept literally identical.
 */

// ---------------------------------------------------------------------------
// Engine config — identical to clickdz-prompt-suggestions.controller.ts
// ---------------------------------------------------------------------------
// WS14: the Vercel AI Gateway — the same env pair the bridge reads (the
// legacy CDZ_AI_BASE_URL/CDZ_AI_KEY api.clickdz.ai pair is deliberately
// not read; a legacy key fails Gateway auth looking like a model error).
const CDZ_AI_BASE_URL = (
  process.env.CDZ_AI_GATEWAY_BASE || 'https://ai-gateway.vercel.sh'
)
  .replace(/\/+$/, '')
  .replace(/\/v1$/, '');
const CDZ_AI_KEY =
  process.env.CDZ_AI_GATEWAY_KEY || process.env.CUSTOM_LLM_API_KEY || '';
// WS14 default: the Gateway single chat model. NOTE: this is a bare literal
// (no env-override on this route) — unset any legacy value elsewhere.
const CDZ_FAST_MODEL = 'zai/glm-4.6v-flash';

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------
const MAX_TOKENS = 900;
const TEMPERATURE = 0.7;
const TIMEOUT_MS = 12_000;
const MAX_DOCS = 5;
const MAX_SLIDES = 3;
const MAX_APPS = 3;
const MAX_WB = 2;
const MAX_TITLE_CHARS = 120;
const MAX_MARKDOWN_CHARS = 2_000;
const MAX_ONELINER_CHARS = 120;

// ---------------------------------------------------------------------------
// Profile shape (mirrors frontend CdzOnboardingProfile — no shared package dep)
// ---------------------------------------------------------------------------
interface CdzProfile {
  v: 1;
  lang: 'fr' | 'en' | 'ar';
  brandName: string;
  bizOneLiner?: string;
  niches: string[];
  goals: string[];
  level?: 'beginner' | 'intermediate' | 'pro';
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Compact per-niche fallback — titles + short body for the 20 supported niches.
// The frontend has the rich TEMPLATE_CONTENT (~130KB); the backend fallback is
// intentionally thin: just enough to produce a useful docs[] bundle without the
// cross-package import. The AI path produces the tailored delta on top.
// ---------------------------------------------------------------------------
const NICHE_FALLBACK: Record<
  string,
  { hub: string; workflow: string; tracker: string }
> = {
  'digital-agency':    { hub: 'Hub Agence Digitale',       workflow: 'Workflow Campagne',        tracker: 'Tracker Clients' },
  ecommerce:           { hub: 'Hub E-commerce',            workflow: 'Workflow Commandes',       tracker: 'Tracker Produits' },
  restaurant:          { hub: 'Hub Restaurant',            workflow: 'Workflow Service',          tracker: 'Tracker Réservations' },
  'real-estate':       { hub: 'Hub Immobilier',            workflow: 'Workflow Visites',          tracker: 'Tracker Biens' },
  freelancer:          { hub: 'Hub Freelance',             workflow: 'Workflow Mission',          tracker: 'Tracker Projets' },
  startup:             { hub: 'Hub Startup',               workflow: 'Workflow Sprint',           tracker: 'Tracker Métriques' },
  clinic:              { hub: 'Hub Cabinet Médical',       workflow: 'Workflow Consultation',     tracker: 'Tracker Patients' },
  'law-office':        { hub: 'Hub Cabinet Avocat',        workflow: 'Workflow Dossier',          tracker: 'Tracker Affaires' },
  construction:        { hub: 'Hub BTP',                   workflow: 'Workflow Chantier',         tracker: 'Tracker Chantiers' },
  education:           { hub: 'Hub Formation',             workflow: 'Workflow Cours',            tracker: 'Tracker Élèves' },
  retail:              { hub: 'Hub Boutique',              workflow: 'Workflow Stock',            tracker: 'Tracker Ventes' },
  'import-export':     { hub: 'Hub Import-Export',         workflow: 'Workflow Expédition',       tracker: 'Tracker Commandes' },
  'marketing-team':    { hub: 'Hub Marketing',             workflow: 'Workflow Campagne',         tracker: 'Tracker KPIs' },
  'hr-recruiting':     { hub: 'Hub RH',                   workflow: 'Workflow Recrutement',      tracker: 'Tracker Candidats' },
  finance:             { hub: 'Hub Finance',               workflow: 'Workflow Facturation',      tracker: 'Tracker Trésorerie' },
  events:              { hub: 'Hub Événementiel',          workflow: 'Workflow Événement',        tracker: 'Tracker Prestataires' },
  ngo:                 { hub: 'Hub Association',           workflow: 'Workflow Projet',           tracker: 'Tracker Adhérents' },
  'creative-studio':   { hub: 'Hub Studio Créatif',        workflow: 'Workflow Production',       tracker: 'Tracker Livrables' },
  'it-services':       { hub: 'Hub Services IT',           workflow: 'Workflow Sprint',           tracker: 'Tracker Tickets' },
  personal:            { hub: 'Hub Personnel',             workflow: 'Workflow Objectifs',        tracker: 'Tracker Tâches' },
};

// Goal-to-app-prompt static fallback (used when AI unavailable)
const GOAL_APP_PROMPTS: Record<string, { name: string; prompt: string }> = {
  sell_online:     { name: 'Page de vente COD', prompt: 'Crée une page de vente COD avec formulaire de commande : nom, téléphone, wilaya.' },
  create_content:  { name: 'Générateur de posts', prompt: 'Crée un générateur de posts pour réseaux sociaux avec champ niche et langue.' },
  manage_business: { name: 'Dashboard Business', prompt: 'Crée un dashboard business simple avec KPIs : chiffre d\'affaires, commandes, clients.' },
  automate:        { name: 'Automatisation tâches', prompt: 'Crée un formulaire d\'automatisation de tâches répétitives avec intégration WhatsApp.' },
  find_clients:    { name: 'Capture de leads', prompt: 'Crée une landing page de capture de leads avec formulaire et message WhatsApp automatique.' },
};

// ---------------------------------------------------------------------------
// Build deterministic fallback from profile (never throws)
// ---------------------------------------------------------------------------
function buildFallback(profile: CdzProfile | null): PersonalizeResult {
  const docs: DocArtifact[] = [];
  const apps: AppArtifact[] = [];
  const slidepro: SlideArtifact[] = [];
  const whiteboard: WhiteboardArtifact[] = [];
  const studioEmphasis: string[] = [];

  if (profile) {
    // docs from niche pack titles
    const primaryNiche = profile.niches[0];
    if (primaryNiche && NICHE_FALLBACK[primaryNiche]) {
      const pack = NICHE_FALLBACK[primaryNiche];
      docs.push(
        { kind: 'hub',      title: pack.hub,      markdown: `# ${pack.hub}\n\nVotre tableau de bord central pour ${profile.brandName}.` },
        { kind: 'workflow', title: pack.workflow,  markdown: `# ${pack.workflow}\n\nSuivez chaque étape de votre processus métier.` },
        { kind: 'tracker',  title: pack.tracker,   markdown: `# ${pack.tracker}\n\nSuivi de vos données clés pour ${profile.brandName}.` }
      );
    }
    // apps from goal map
    for (const goal of (profile.goals ?? []).slice(0, MAX_APPS)) {
      const ap = GOAL_APP_PROMPTS[goal];
      if (ap) apps.push(ap);
    }
    // studio emphasis from goals
    if (profile.goals.includes('sell_online')) studioEmphasis.push('apps', 'shoperp');
    if (profile.goals.includes('create_content')) studioEmphasis.push('vdz', 'socialplus');
    if (profile.goals.includes('automate')) studioEmphasis.push('agents', 'integrations');
    if (profile.goals.includes('manage_business')) studioEmphasis.push('shoperp');
    if (profile.goals.includes('find_clients')) studioEmphasis.push('apps', 'hermes');
    // deduplicate emphasis
    const seen = new Set<string>();
    const uniqueEmphasis: string[] = [];
    for (const s of studioEmphasis) {
      if (!seen.has(s)) { seen.add(s); uniqueEmphasis.push(s); }
    }
    return { docs, slidepro, apps, whiteboard, studioEmphasis: uniqueEmphasis };
  }
  // No profile — generic defaults
  return {
    docs: [],
    slidepro: [],
    apps: [GOAL_APP_PROMPTS.sell_online],
    whiteboard: [],
    studioEmphasis: ['apps', 'shoperp'],
  };
}

// ---------------------------------------------------------------------------
// Artifact types (output schema for POST /personalize/templates)
// ---------------------------------------------------------------------------
interface DocArtifact {
  kind: 'hub' | 'workflow' | 'tracker';
  title: string;
  markdown: string;
}

interface SlideArtifact {
  title: string;
  outline: string[];
}

interface AppArtifact {
  name: string;
  prompt: string;
}

interface WhiteboardArtifact {
  title: string;
  seedNotes: string[];
}

interface PersonalizeResult {
  docs: DocArtifact[];
  slidepro: SlideArtifact[];
  apps: AppArtifact[];
  whiteboard: WhiteboardArtifact[];
  studioEmphasis: string[];
}

// ---------------------------------------------------------------------------
// Defensive JSON field cleaning (mirrors prompt-suggestions parser)
// ---------------------------------------------------------------------------
function cleanStr(input: unknown, max: number): string {
  let s = typeof input === 'string' ? input : String(input ?? '');
  s = s.trim().replace(/^["'`]+/, '').replace(/["'`]+$/, '').replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max).trim() : s;
}

/**
 * Parse the AI response (JSON object) into a PersonalizeResult.
 * Falls back to empty arrays for any missing/malformed field — never throws.
 */
function parsePersonalizeResponse(raw: string, fallback: PersonalizeResult): PersonalizeResult {
  const text = (raw ?? '').trim();
  if (!text) return fallback;

  let obj: Record<string, unknown> | null = null;
  const attempts = [text, text.replace(/```(?:json)?/gi, '').replace(/```/g, '').trim()];
  for (const attempt of attempts) {
    try { obj = JSON.parse(attempt) as Record<string, unknown>; break; } catch { /* next */ }
  }
  if (!obj) {
    const start = text.indexOf('{'), end = text.lastIndexOf('}');
    if (start !== -1 && end > start) {
      try { obj = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>; } catch { /* ignore */ }
    }
  }
  if (!obj || typeof obj !== 'object') return fallback;

  // docs
  const docs: DocArtifact[] = [];
  if (Array.isArray(obj.docs)) {
    for (const item of obj.docs) {
      if (!item || typeof item !== 'object') continue;
      const kind = (item as any).kind;
      if (kind !== 'hub' && kind !== 'workflow' && kind !== 'tracker') continue;
      const title = cleanStr((item as any).title, MAX_TITLE_CHARS);
      const markdown = cleanStr((item as any).markdown, MAX_MARKDOWN_CHARS);
      if (title) docs.push({ kind, title, markdown: markdown || `# ${title}` });
      if (docs.length >= MAX_DOCS) break;
    }
  }

  // slidepro
  const slidepro: SlideArtifact[] = [];
  if (Array.isArray(obj.slidepro)) {
    for (const item of obj.slidepro) {
      if (!item || typeof item !== 'object') continue;
      const title = cleanStr((item as any).title, MAX_TITLE_CHARS);
      const outline = Array.isArray((item as any).outline)
        ? (item as any).outline.filter((s: unknown) => typeof s === 'string').map((s: string) => cleanStr(s, 100)).slice(0, 10)
        : [];
      if (title) slidepro.push({ title, outline });
      if (slidepro.length >= MAX_SLIDES) break;
    }
  }

  // apps
  const apps: AppArtifact[] = [];
  if (Array.isArray(obj.apps)) {
    for (const item of obj.apps) {
      if (!item || typeof item !== 'object') continue;
      const name = cleanStr((item as any).name, 80);
      const prompt = cleanStr((item as any).prompt, 400);
      if (name && prompt) apps.push({ name, prompt });
      if (apps.length >= MAX_APPS) break;
    }
  }

  // whiteboard
  const whiteboard: WhiteboardArtifact[] = [];
  if (Array.isArray(obj.whiteboard)) {
    for (const item of obj.whiteboard) {
      if (!item || typeof item !== 'object') continue;
      const title = cleanStr((item as any).title, MAX_TITLE_CHARS);
      const seedNotes = Array.isArray((item as any).seedNotes)
        ? (item as any).seedNotes.filter((s: unknown) => typeof s === 'string').map((s: string) => cleanStr(s, 200)).slice(0, 6)
        : [];
      if (title) whiteboard.push({ title, seedNotes });
      if (whiteboard.length >= MAX_WB) break;
    }
  }

  // studioEmphasis
  const studioEmphasis: string[] = Array.isArray(obj.studioEmphasis)
    ? obj.studioEmphasis.filter((s: unknown) => typeof s === 'string').slice(0, 8)
    : fallback.studioEmphasis;

  return {
    docs: docs.length ? docs : fallback.docs,
    slidepro: slidepro.length ? slidepro : fallback.slidepro,
    apps: apps.length ? apps : fallback.apps,
    whiteboard: whiteboard.length ? whiteboard : fallback.whiteboard,
    studioEmphasis,
  };
}

// ---------------------------------------------------------------------------
// System prompt builder
// ---------------------------------------------------------------------------
function buildPersonalizePrompt(profile: CdzProfile): string {
  const nicheLabels = profile.niches.length ? profile.niches.join(', ') : 'unknown';
  const goalLabels = profile.goals.length ? profile.goals.join(', ') : 'general';
  const lang = profile.lang === 'ar' ? 'Arabic' : profile.lang === 'en' ? 'English' : 'French';

  const lines = [
    'You generate STARTER workspace content for an Algerian merchant using ClickDz Work.',
    `Business name: "${profile.brandName}".`,
    profile.bizOneLiner ? `What they do: "${profile.bizOneLiner.slice(0, MAX_ONELINER_CHARS)}".` : '',
    `Business type(s): ${nicheLabels}.`,
    `Goals: ${goalLabels}.`,
    `Language preference: ${lang} — write all content in this language.`,
    '',
    'Produce a JSON OBJECT (no markdown fences) with these keys:',
    '  "docs": array of up to 3 starter docs — each { "kind": "hub"|"workflow"|"tracker", "title": string, "markdown": string }.',
    '  "slidepro": array of up to 2 starter slides — each { "title": string, "outline": [strings] }.',
    '  "apps": array of up to 3 app builder prompts — each { "name": string, "prompt": string }. Prompts must be self-contained French instructions.',
    '  "whiteboard": array of up to 1 whiteboard seed — { "title": string, "seedNotes": [strings] }.',
    '  "studioEmphasis": array of up to 5 studio ids to spotlight — from: vdz,apps,integrations,shoperp,voice,hermes,openclaw,agents,vpic,slidepro,coursepro,socialplus,zoomplus.',
    '',
    'Tailor every artifact to the business type and goals. Make the content immediately actionable.',
    'Output ONLY the JSON object — no commentary, no markdown fences, no extra text.',
  ];
  return lines.filter(Boolean).join('\n');
}

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------
@Controller()
export class ClickDzPersonalizeController {
  private readonly logger = new Logger(ClickDzPersonalizeController.name);

  constructor(private readonly models: Models) {}

  /**
   * GET /api/v1/cdz/profile
   * Returns the stored CdzOnboardingProfile for the session user, or null.
   */
  @Get('/api/v1/cdz/profile')
  async getProfile(
    @CurrentUser() user: CurrentUser
  ): Promise<{ profile: CdzProfile | null }> {
    const settings = await this.models.userSettings.get(user.id);
    return { profile: (settings as any).clickdzProfile ?? null };
  }

  /**
   * PUT /api/v1/cdz/profile
   * Body: CdzOnboardingProfile. Validated + persisted via UserSettingsModel.
   * Returns the stored profile.
   */
  @Throttle('strict')
  @Put('/api/v1/cdz/profile')
  async putProfile(
    @CurrentUser() user: CurrentUser,
    @Body() body: unknown
  ): Promise<{ profile: CdzProfile | null }> {
    if (!body || typeof body !== 'object') {
      return { profile: null };
    }
    const payload = body as Record<string, unknown>;

    // Basic field coercion — Zod validates the rest in UserSettingsModel.set
    const profile: Partial<CdzProfile> = {
      v: 1,
      lang: (['fr', 'en', 'ar'] as const).includes(payload.lang as any)
        ? (payload.lang as CdzProfile['lang'])
        : 'fr',
      brandName: typeof payload.brandName === 'string' ? payload.brandName.slice(0, 200) : '',
      bizOneLiner:
        typeof payload.bizOneLiner === 'string'
          ? payload.bizOneLiner.slice(0, MAX_ONELINER_CHARS) || undefined
          : undefined,
      niches: Array.isArray(payload.niches)
        ? payload.niches.filter((n): n is string => typeof n === 'string').slice(0, 5)
        : [],
      goals: Array.isArray(payload.goals)
        ? payload.goals.filter((g): g is string => typeof g === 'string').slice(0, 10)
        : [],
      level: (['beginner', 'intermediate', 'pro'] as const).includes(payload.level as any)
        ? (payload.level as CdzProfile['level'])
        : undefined,
      updatedAt: typeof payload.updatedAt === 'string' ? payload.updatedAt : new Date().toISOString(),
    };

    try {
      await this.models.userSettings.set(user.id, {
        clickdzProfile: profile as CdzProfile,
      });
    } catch (err) {
      this.logger.warn(`[personalize] failed to persist profile for ${user.id}: ${err}`);
      return { profile: null };
    }
    return { profile: profile as CdzProfile };
  }

  /**
   * POST /api/v1/cdz/personalize/templates
   * Body: { profile?: CdzOnboardingProfile, target?: string }
   *
   * Calls cdz-flash to generate tailored starter artifacts (docs, slidepro,
   * apps, whiteboard, studioEmphasis). Always 200 — falls back to
   * NICHE_FALLBACK + GOAL_APP_PROMPTS when AI is unavailable.
   */
  @Throttle('strict')
  @Post('/api/v1/cdz/personalize/templates')
  async personalizeTemplates(
    @CurrentUser() user: CurrentUser,
    @Body() body: unknown
  ): Promise<PersonalizeResult> {
    // 1. Resolve profile: prefer body-supplied, else load from UserSettings
    let profile: CdzProfile | null = null;
    if (body && typeof body === 'object') {
      const bp = (body as Record<string, unknown>).profile;
      if (bp && typeof bp === 'object') {
        profile = bp as CdzProfile;
      }
    }
    if (!profile) {
      try {
        const settings = await this.models.userSettings.get(user.id);
        profile = (settings as any).clickdzProfile ?? null;
      } catch {
        profile = null;
      }
    }

    const fallback = buildFallback(profile);

    if (!CDZ_AI_KEY || !profile) {
      return fallback;
    }

    // 2. Call cdz-flash (identical calling convention to clickdz-prompt-suggestions)
    try {
      const response = await fetch(`${CDZ_AI_BASE_URL}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${CDZ_AI_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: CDZ_FAST_MODEL,
          messages: [
            { role: 'system', content: buildPersonalizePrompt(profile) },
            {
              role: 'user',
              content: `Brand: ${profile.brandName}\nNiches: ${profile.niches.join(', ')}\nGoals: ${profile.goals.join(', ')}\nLang: ${profile.lang}`,
            },
          ],
          max_tokens: MAX_TOKENS,
          temperature: TEMPERATURE,
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });

      const data = (await response.json()) as {
        choices?: Array<{ message?: { content?: unknown } }>;
      };
      const content = data?.choices?.[0]?.message?.content;

      if (response.ok && typeof content === 'string' && content.trim()) {
        const parsed = parsePersonalizeResponse(content, fallback);
        return parsed;
      }
    } catch {
      // Network error, timeout, model down — swallow, serve fallback.
      this.logger.debug(
        `[personalize] cdz-flash unavailable for user ${user.id}; serving niche fallback`
      );
    }

    return fallback;
  }
}
