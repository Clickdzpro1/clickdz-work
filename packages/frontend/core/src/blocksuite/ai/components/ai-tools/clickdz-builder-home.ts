// ClickDz Work — App Builder home (the /apps studio landing surface).
//
// Why this exists: "ClickDz Apps" used to route to `/chat`, the exact same
// destination as the sidebar's plain AI entry. A merchant with zero projects
// therefore saw a blank AI chat and no builder at all — the Builder Studio
// only ever mounted *after* a generation completed inside that chat, and only
// if the user first discovered the small "🚀 Builder" chip in the composer.
//
// This element is the missing front door. With zero projects it shows what you
// can build (a prompt composer + starters + the business-template gallery);
// with projects it shows them too. Picking anything opens the existing
// <clickdz-builder-studio> overlay directly — no chat detour.
//
// Lit, matching the rest of ai-tools (the studio it hosts is a Lit element and
// is self-contained by design). Inline styles in a static stylesheet, French
// copy, no new dependencies.
import { css, html, LitElement, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

import {
  artifactStore,
  type CdzArtifact,
} from '../../../../modules/ai-artifacts/store';
import { cdzApiUrl } from '../../provider';
// Side-effect import: registers <clickdz-builder-studio>.
import './clickdz-builder-studio';

/**
 * One row of GET /api/v1/apps/mine. The server returns slug/url/createdAt plus
 * an optional kind/storeSlug — notably NOT a title, so published-only cards
 * fall back to displaying the slug.
 */
interface CdzMineApp {
  slug: string;
  url?: string;
  title?: string;
  kind?: string;
  storeSlug?: string;
}

/** One row of GET /api/v1/apps/templates (the 20-vertical shop catalog). */
interface CdzTemplateSummary {
  id: string;
  name: string;
  nameDarja?: string;
  vertical?: string;
  accent?: string;
  heroLine?: string;
  emoji?: string;
  gradient?: [string, string];
}

/**
 * One row of GET /api/v1/apps/app-templates — the APP catalog (business tools,
 * not storefronts). Display metadata only: the generation brief stays
 * server-side and is reached by sending this `id` as `templateId` to
 * POST /apps/generate.
 */
interface CdzAppTemplateSummary {
  id: string;
  name: string;
  nameDarja?: string;
  emoji?: string;
  category?: string;
  pitch?: string;
  accent?: string;
  gradient?: [string, string];
}

/** The app currently open in the studio overlay. */
interface CdzOpenApp {
  slug: string;
  title: string;
  html: string;
  url?: string;
}

/**
 * Prompt starters. Deliberately concrete and Algerian: a merchant staring at
 * an empty box does not know what this tool can do, and "build me an app" is
 * not a useful hint. Each one is a complete brief that produces a real app.
 */
const CDZ_STARTERS: ReadonlyArray<{ label: string; prompt: string }> = [
  {
    label: '📅 Prise de rendez-vous',
    prompt:
      "Une app de prise de rendez-vous pour un salon de coiffure : liste des prestations avec durée et prix en DZD, choix d'un jour et d'un créneau libre, formulaire nom + téléphone, confirmation avec lien WhatsApp pré-rempli. Espace gérant protégé par un code PIN à 4 chiffres avec le planning du jour. Interface en français.",
  },
  {
    label: '🚚 Suivi des livraisons',
    prompt:
      "Un tableau de suivi des livraisons paiement à la livraison : saisie d'un colis (client, téléphone, wilaya parmi les 58, montant à encaisser), statuts Préparé / Expédié / Livré / Retour, regroupement par tournée du jour, totaux encaissés, recherche par téléphone, bouton WhatsApp vers le client. Interface en français.",
  },
  {
    label: '🧾 Facturier algérien',
    prompt:
      "Un générateur de factures algérien : coordonnées de l'entreprise (RC, NIF, ART), clients, lignes de facture (désignation, quantité, prix unitaire HT), TVA 19% par défaut, totaux HT / TVA / TTC, montant en toutes lettres, numérotation automatique, vue impression A4 propre. Interface en français.",
  },
  {
    label: '📦 Inventaire express',
    prompt:
      "Un outil d'inventaire simple : liste d'articles avec code, nom et stock théorique, mode comptage plein écran optimisé mobile, écarts calculés en direct (rouge si manquant, vert si surplus), clôture de session qui enregistre le comptage, historique des inventaires. Interface en français.",
  },
  {
    label: '🗂️ Carnet clients',
    prompt:
      "Un mini-CRM : fiches clients (nom, téléphone, wilaya, étiquettes, note), historique des appels et commandes par client, écran « Relances du jour » avec les relances en retard en premier, bouton WhatsApp depuis chaque fiche. Interface en français.",
  },
  {
    label: '🎓 Registre de cours',
    prompt:
      "Un registre pour professeur de soutien scolaire : groupes avec jour, heure et tarif mensuel, appel de présence en un tap, suivi des paiements par mois avec les impayés en rouge, rappel WhatsApp au parent. Interface en français.",
  },
];

@customElement('clickdz-builder-home')
export class ClickDzBuilderHome extends LitElement {
  static override styles = css`
    :host {
      display: block;
      height: 100%;
      overflow-y: auto;
      background: var(--affine-background-primary-color, #fff);
      color: var(--affine-text-primary-color, #141414);
      font-family: var(
        --affine-font-family,
        -apple-system,
        BlinkMacSystemFont,
        'Segoe UI',
        Roboto,
        sans-serif
      );
    }
    .wrap {
      max-width: 1000px;
      margin: 0 auto;
      /* 360px-safe: percentage-free horizontal padding that never collapses */
      padding: 40px 20px 72px;
      box-sizing: border-box;
    }
    .hero h1 {
      margin: 0 0 6px;
      font-size: clamp(22px, 4.6vw, 30px);
      font-weight: 800;
      letter-spacing: -0.02em;
    }
    .hero .sub {
      margin: 0 0 20px;
      color: var(--affine-text-secondary-color, #8e8d91);
      font-size: 14px;
      line-height: 1.55;
    }
    .composer {
      display: flex;
      flex-direction: column;
      gap: 10px;
      padding: 12px;
      border: 1px solid var(--affine-border-color, #e3e2e4);
      border-radius: 14px;
      background: var(--affine-background-secondary-color, #f4f4f5);
    }
    .composer textarea {
      width: 100%;
      box-sizing: border-box;
      min-height: 74px;
      resize: vertical;
      border: 0;
      outline: 0;
      background: transparent;
      color: inherit;
      font: inherit;
      /* >=16px so Android/iOS do not zoom the viewport on focus */
      font-size: 16px;
      line-height: 1.5;
    }
    .composer .row {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: 10px;
    }
    .btn {
      appearance: none;
      border: 0;
      border-radius: 10px;
      padding: 11px 20px;
      font-size: 14px;
      font-weight: 700;
      cursor: pointer;
      background: var(--affine-primary-color, #1e96eb);
      color: #fff;
    }
    .btn:disabled {
      opacity: 0.6;
      cursor: wait;
    }
    .starters {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 14px;
    }
    .starters button {
      appearance: none;
      border: 1px solid var(--affine-border-color, #e3e2e4);
      border-radius: 999px;
      padding: 7px 14px;
      background: var(--affine-background-primary-color, #fff);
      color: var(--affine-text-primary-color, #141414);
      font-size: 12.5px;
      cursor: pointer;
      text-align: start;
    }
    .starters button:hover:not(:disabled) {
      border-color: var(--affine-primary-color, #1e96eb);
    }
    .starters button:disabled {
      opacity: 0.55;
      cursor: wait;
    }
    h2 {
      margin: 36px 0 6px;
      font-size: 15px;
      font-weight: 700;
    }
    .section-sub {
      margin: 0 0 14px;
      font-size: 12.5px;
      color: var(--affine-text-secondary-color, #8e8d91);
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(210px, 1fr));
      gap: 12px;
    }
    .card {
      appearance: none;
      border: 1px solid var(--affine-border-color, #e3e2e4);
      border-radius: 14px;
      background: var(--affine-background-primary-color, #fff);
      padding: 14px;
      cursor: pointer;
      text-align: start;
      color: inherit;
      font: inherit;
      display: block;
    }
    .card:hover:not(:disabled) {
      border-color: var(--affine-primary-color, #1e96eb);
    }
    .card:disabled {
      opacity: 0.55;
      cursor: wait;
    }
    .card .thumb {
      height: 62px;
      border-radius: 10px;
      margin-bottom: 10px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 26px;
    }
    .card .name {
      font-size: 13px;
      font-weight: 700;
    }
    .card .sub {
      margin-top: 3px;
      font-size: 11.5px;
      color: var(--affine-text-secondary-color, #8e8d91);
      line-height: 1.45;
    }
    .badge {
      display: inline-block;
      margin-top: 8px;
      font-size: 10.5px;
      font-weight: 700;
      border-radius: 999px;
      padding: 2px 8px;
      background: var(--affine-background-secondary-color, #f4f4f5);
      color: var(--affine-text-secondary-color, #8e8d91);
    }
    .badge.live {
      background: rgba(16, 185, 129, 0.14);
      color: #059669;
    }
    .err {
      margin-top: 12px;
      padding: 10px 12px;
      border-radius: 10px;
      background: rgba(239, 68, 68, 0.1);
      color: #b91c1c;
      font-size: 12.5px;
    }
    .busy {
      margin-top: 12px;
      font-size: 12.5px;
      color: var(--affine-text-secondary-color, #8e8d91);
    }
    /* Live build preview — only present while a stream is running. */
    .live {
      margin-top: 14px;
      border: 1px solid var(--affine-border-color, #e3e2e4);
      border-radius: 14px;
      overflow: hidden;
      background: #fff;
    }
    .live-head {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 12px;
      font-size: 11.5px;
      font-weight: 700;
      color: var(--affine-text-secondary-color, #8e8d91);
      border-bottom: 1px solid var(--affine-border-color, #e3e2e4);
      background: var(--affine-background-secondary-color, #f4f4f5);
    }
    .live-dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: #10a37f;
      animation: cdz-live-pulse 1.1s ease-in-out infinite;
    }
    @keyframes cdz-live-pulse {
      0%,
      100% {
        opacity: 1;
      }
      50% {
        opacity: 0.35;
      }
    }
    @media (prefers-reduced-motion: reduce) {
      .live-dot {
        animation: none;
      }
    }
    .live iframe {
      display: block;
      width: 100%;
      height: 320px;
      border: 0;
      background: #fff;
    }
  `;

  /** Optional deep-link: a prompt to prefill the composer with. */
  @property({ attribute: false })
  accessor initialPrompt = '';

  @state()
  private accessor prompt = '';

  @state()
  private accessor busy = false;

  @state()
  private accessor busyLabel = '';

  @state()
  private accessor error = '';

  @state()
  private accessor templates: CdzTemplateSummary[] = [];

  @state()
  private accessor appTemplates: CdzAppTemplateSummary[] = [];

  /**
   * Partial app HTML while a streamed build is in flight, painted into a
   * sandboxed iframe so the merchant watches their app take shape. Empty
   * except during a stream.
   */
  @state()
  private accessor livePreview = '';

  @state()
  private accessor drafts: CdzArtifact[] = [];

  @state()
  private accessor mine: CdzMineApp[] = [];

  @state()
  private accessor studioOpen = false;

  @state()
  private accessor app: CdzOpenApp | null = null;

  private unsubscribe: (() => void) | null = null;

  override connectedCallback() {
    super.connectedCallback();
    if (this.initialPrompt && !this.prompt) this.prompt = this.initialPrompt;
    // subscribe() invokes the listener immediately with the current snapshot,
    // so this both seeds and keeps `drafts` live.
    this.unsubscribe = artifactStore.subscribe(items => {
      this.drafts = items.filter(a => a.type === 'app');
    });
    void this.loadTemplates();
    void this.loadAppTemplates();
    void this.loadMine();
  }

  override disconnectedCallback() {
    this.unsubscribe?.();
    this.unsubscribe = null;
    super.disconnectedCallback();
  }

  /**
   * The vertical catalog. Typed 404 when CDZ_TEMPLATE_CATALOG is off — in that
   * case the gallery section simply does not render (never an empty gallery).
   */
  private async loadTemplates() {
    try {
      const res = await fetch(cdzApiUrl('/api/v1/apps/templates'));
      if (!res.ok) return;
      const data = (await res.json().catch(() => null)) as {
        templates?: CdzTemplateSummary[];
      } | null;
      if (Array.isArray(data?.templates)) this.templates = data.templates;
    } catch {
      /* the gallery is additive — a failure just hides it */
    }
  }

  /**
   * The APP catalog — business tools rather than storefronts (rendez-vous,
   * suivi COD, facturier, inventaire…). Same fail-soft stance as the shop
   * gallery: a typed 404 means CDZ_APP_TEMPLATE_CATALOG is off, so the section
   * hides itself rather than rendering an empty shelf.
   */
  private async loadAppTemplates() {
    try {
      const res = await fetch(cdzApiUrl('/api/v1/apps/app-templates'));
      if (!res.ok) return;
      const data = (await res.json().catch(() => null)) as {
        templates?: CdzAppTemplateSummary[];
      } | null;
      if (Array.isArray(data?.templates)) this.appTemplates = data.templates;
    } catch {
      /* additive — a failure just hides the section */
    }
  }

  private async loadMine() {
    try {
      const res = await fetch(cdzApiUrl('/api/v1/apps/mine'));
      if (!res.ok) return;
      const data = (await res.json().catch(() => null)) as {
        apps?: CdzMineApp[];
      } | null;
      if (Array.isArray(data?.apps)) this.mine = data.apps;
    } catch {
      /* published list is additive */
    }
  }

  /** Freeform build. Mirrors the composer path's endpoint + error handling. */
  /**
   * Stream a build over SSE, painting a live preview as the code arrives.
   *
   * Returns TRUE when it owned the build (success or a reported error), FALSE
   * when the caller should fall back to the buffered route — which happens if
   * the route is absent (older server), the response is not an event-stream (a
   * proxy rewrote it), or the stream dies before a single byte of app HTML.
   * That distinction matters: falling back after a partial success would run the
   * paid code agent twice for one request.
   *
   * Deliberately hand-rolled over fetch + a reader rather than EventSource:
   * EventSource cannot POST, and this needs a request body.
   */
  private async generateStreaming(
    text: string,
    opts?: { templateId?: string; title?: string }
  ): Promise<boolean> {
    let res: Response;
    try {
      res = await fetch(cdzApiUrl('/api/v1/apps/generate/stream'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
        },
        body: JSON.stringify({
          prompt: text,
          ...(opts?.templateId ? { templateId: opts.templateId } : {}),
        }),
      });
    } catch {
      return false; // never opened — let the buffered path try
    }
    // 404 = server predates this route; 401 is worth surfacing rather than
    // retrying, since the buffered route would fail identically.
    if (res.status === 401) {
      // Returning true means "handled"; the CALLER clears busy for that case,
      // so this must not also clear it (one owner for the flag).
      this.error = 'Connectez-vous pour créer une application.';
      return true;
    }
    const ctype = res.headers.get('content-type') || '';
    if (!res.ok || !res.body || !ctype.includes('text/event-stream')) {
      try {
        await res.body?.cancel();
      } catch {
        /* ignore */
      }
      return false;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let raw = '';
    let lastPaint = 0;
    let settled = false;
    // Did the server ever send real content, or at least admit it had started?
    // These decide whether a broken stream is safe to retry (see the catch).
    let sawDelta = false;
    let sawPhase = false;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        // Same blank-line framing the server writes; a frame can straddle
        // chunks, so only complete ones are consumed.
        let sep: number;
        while ((sep = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          let event = 'message';
          let data = '';
          for (const line of frame.split('\n')) {
            if (line.startsWith('event:')) event = line.slice(6).trim();
            else if (line.startsWith('data:')) data += line.slice(5).trim();
          }
          if (!data) continue;
          let payload: any;
          try {
            payload = JSON.parse(data);
          } catch {
            continue; // unknown frame — never break the stream over it
          }
          if (event === 'phase') {
            sawPhase = true;
            const secs =
              typeof payload?.seconds === 'number' ? ` (${payload.seconds}s)` : '';
            this.busyLabel = `${payload?.label || 'Création…'}${secs}`;
          } else if (event === 'delta') {
            sawDelta = true;
            raw += String(payload?.text ?? '');
            // Paint from the document start once it appears. Throttled to ~2/s:
            // browsers render truncated HTML fine, but re-parsing on every token
            // would burn the phone's CPU for no visible gain.
            const at = raw.search(/<!doctype html|<html[\s>]/i);
            const now = Date.now();
            if (at !== -1 && now - lastPaint > 450) {
              lastPaint = now;
              this.livePreview = raw.slice(at);
            }
          } else if (event === 'done') {
            settled = true;
            if (payload?.slug && payload?.html) {
              this.openInStudio({
                slug: payload.slug,
                title: opts?.title || text.slice(0, 64),
                html: payload.html,
              });
            } else {
              this.error = 'Réponse invalide du générateur.';
            }
          } else if (event === 'error') {
            settled = true;
            this.error = String(payload?.message || 'Génération échouée');
          }
        }
      }
    } catch {
      // Mid-stream break. `sawDelta` is the honest signal, NOT `raw`:
      //
      // On the token-streaming path a break before any delta means the server
      // produced nothing, so the buffered route is a genuinely clean retry. But
      // on the heartbeat path (no CDZ_AI_KEY) there are never any deltas — the
      // server commits the PAID agent run up front and the app arrives only in
      // the final `done`. Retrying there always starts a second billed
      // generation while the first is still running and uncancellable. So we
      // only fall back when we know a stream was really carrying content and
      // died early; otherwise we report and let the merchant decide.
      if (!settled && !sawDelta && !sawPhase) return false;
      if (!settled) {
        this.error =
          'La connexion a été interrompue pendant la génération. Vérifiez vos applications avant de relancer — le travail est peut-être déjà terminé.';
      }
    } finally {
      // Deliberately NOT clearing `busy` here. The CALLER owns that flag for
      // the whole operation, including the buffered fallback that runs after a
      // `false` return — clearing it here re-enabled every button while a paid
      // 1-4 minute generation was still in flight, so a merchant seeing an idle
      // screen could start a second and third concurrent build.
      this.busyLabel = '';
      this.livePreview = '';
    }
    // Stream ended cleanly but with no done/error frame. Same reasoning as the
    // catch above: only hand back to the buffered route when we are confident
    // the server never started billable work.
    if (!settled && !sawDelta && !sawPhase) return false;
    if (!settled) {
      this.error =
        'La génération s\'est interrompue avant la fin. Vérifiez vos applications avant de relancer.';
    }
    return true;
  }

  /**
   * Freeform build, or a catalog pick when `opts.templateId` is given.
   *
   * One method rather than two: a template pick is the SAME generate call with a
   * server-side brief prepended (the backend resolves `templateId` and prepends
   * it — the brief never travels to the browser), so duplicating the error
   * handling and studio hand-off would only invite the two paths to drift.
   */
  private async generate(
    prompt: string,
    opts?: { templateId?: string; title?: string }
  ) {
    const text = prompt.trim();
    if (!text || this.busy) return;
    this.busy = true;
    this.busyLabel = opts?.title
      ? `Création de « ${opts.title} »…`
      : 'Création de votre application…';
    this.error = '';
    this.livePreview = '';
    // Try the streaming route first: the merchant sees their app being written
    // instead of a spinner. It falls back to the buffered route on ANY failure
    // (route missing on an older server, a proxy that eats event-streams), so
    // this can only ever add feedback, never remove the ability to build.
    // The helper owns the stream but NOT the busy flag (see its finally): when
    // it handled the build we clear here, and when it hands back we keep busy
    // true straight through the buffered fallback so no second build can start.
    if (await this.generateStreaming(text, opts)) {
      this.busy = false;
      this.busyLabel = '';
      return;
    }
    try {
      const res = await fetch(cdzApiUrl('/api/v1/apps/generate'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: text,
          // Omitted (not sent empty) when there is no pick, so a freeform
          // request stays byte-identical to what it has always been.
          ...(opts?.templateId ? { templateId: opts.templateId } : {}),
        }),
      });
      const data = (await res.json().catch(() => null)) as {
        slug?: string;
        html?: string;
        error?: { message?: string };
        message?: string;
      } | null;
      if (!res.ok) {
        if (res.status === 401) {
          throw new Error('Connectez-vous pour créer une application.');
        }
        throw new Error(
          data?.error?.message ||
            data?.message ||
            `Génération échouée (${res.status})`
        );
      }
      if (!data?.slug || !data?.html) {
        throw new Error('Réponse invalide du générateur.');
      }
      this.openInStudio({
        slug: data.slug,
        title: opts?.title || text.slice(0, 64),
        html: data.html,
      });
    } catch (err) {
      this.error = err instanceof Error ? err.message : 'Génération échouée';
    } finally {
      this.busy = false;
      this.busyLabel = '';
    }
  }

  /**
   * Instant mint from the vertical catalog. `templateId` IS honoured by
   * POST /api/v1/apps/template for `kind: 'shop'`, so a gallery pick produces
   * that vertical's storefront rather than the generic default.
   */
  private async mint(templateId: string, name: string) {
    if (this.busy) return;
    this.busy = true;
    this.busyLabel = `Création de « ${name} »…`;
    this.error = '';
    try {
      const res = await fetch(cdzApiUrl('/api/v1/apps/template'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'shop', templateId }),
      });
      const data = (await res.json().catch(() => null)) as {
        slug?: string;
        html?: string;
        title?: string;
        error?: { message?: string };
        message?: string;
      } | null;
      if (!res.ok) {
        if (res.status === 401) {
          throw new Error('Connectez-vous pour créer une boutique.');
        }
        throw new Error(
          data?.error?.message ||
            data?.message ||
            `Création échouée (${res.status})`
        );
      }
      if (!data?.slug || !data?.html) {
        throw new Error('Réponse de template invalide.');
      }
      this.openInStudio({
        slug: data.slug,
        title: data.title?.trim() || name,
        html: data.html,
      });
    } catch (err) {
      this.error = err instanceof Error ? err.message : 'Création échouée';
    } finally {
      this.busy = false;
      this.busyLabel = '';
    }
  }

  /**
   * Persist to the artifact shelf under the canonical `app_<slug>` id (the same
   * id the studio and the chat result card use) so a later publish updates THIS
   * record rather than creating a duplicate, then open the studio overlay.
   */
  private openInStudio(app: CdzOpenApp) {
    const id = `app_${app.slug}`;
    const existing = artifactStore.get(id);
    // Same shape as clickdz-app-result's persistApp: spread the existing
    // record (or a fresh skeleton) first, then overwrite the mutable fields.
    artifactStore.upsert({
      ...(existing ?? {
        id,
        type: 'app' as const,
        title: app.title,
        prompt: app.title,
        sessionId: 'draft',
        slug: app.slug,
        mimeType: 'text/html',
      }),
      title: app.title,
      payload: app.html,
      url: app.url ?? existing?.url,
    });
    this.app = app;
    this.studioOpen = true;
  }

  /**
   * The APP gallery — business tools rather than storefronts. A pick calls the
   * same generate route with `templateId`, so the server prepends the brief and
   * the studio hand-off is identical to a freeform build.
   */
  private renderAppTemplates() {
    if (!this.appTemplates.length) return nothing;
    return html`
      <h2>Modèles d'application</h2>
      <p class="section-sub">
        Des outils pour votre métier : rendez-vous, livraisons, factures,
        inventaire… Choisissez, puis ajustez comme vous voulez.
      </p>
      <div class="grid">
        ${this.appTemplates.map(t => {
          const from = t.gradient?.[0] ?? t.accent ?? '#1e96eb';
          const to = t.gradient?.[1] ?? t.accent ?? '#1e96eb';
          return html`<button
            class="card"
            ?disabled=${this.busy}
            title=${t.pitch ?? t.name}
            @click=${() =>
              void this.generate(t.pitch || t.name, {
                templateId: t.id,
                title: t.name,
              })}
          >
            <div
              class="thumb"
              style=${`background:linear-gradient(135deg, ${from}, ${to})`}
            >
              ${t.emoji ?? '🧩'}
            </div>
            <div class="name">${t.name}</div>
            ${t.pitch ? html`<div class="sub">${t.pitch}</div>` : nothing}
            ${t.category
              ? html`<span class="badge">${t.category}</span>`
              : nothing}
          </button>`;
        })}
      </div>
    `;
  }

  private renderTemplates() {
    if (!this.templates.length) return nothing;
    return html`
      <h2>Modèles de business</h2>
      <p class="section-sub">
        Une boutique complète, prête à vendre, créée en quelques secondes.
      </p>
      <div class="grid">
        ${this.templates.map(t => {
          const from = t.gradient?.[0] ?? t.accent ?? '#1e96eb';
          const to = t.gradient?.[1] ?? t.accent ?? '#1e96eb';
          return html`<button
            class="card"
            ?disabled=${this.busy}
            @click=${() => void this.mint(t.id, t.name)}
          >
            <div
              class="thumb"
              style=${`background:linear-gradient(135deg, ${from}, ${to})`}
            >
              ${t.emoji ?? '🛍️'}
            </div>
            <div class="name">${t.name}</div>
            ${t.heroLine
              ? html`<div class="sub">${t.heroLine}</div>`
              : nothing}
          </button>`;
        })}
      </div>
    `;
  }

  private renderMine() {
    // Drafts live in the local shelf; `mine` is the server's published list.
    // Merge on slug so a published app is not listed twice, and prefer the
    // draft (it carries the current HTML we can open instantly).
    const draftSlugs = new Set(
      this.drafts.map(d => d.slug ?? d.id.replace(/^app_/, ''))
    );
    const publishedOnly = this.mine.filter(m => !draftSlugs.has(m.slug));
    if (!this.drafts.length && !publishedOnly.length) return nothing;
    return html`
      <h2>Vos applications</h2>
      <p class="section-sub">Reprenez là où vous vous êtes arrêté.</p>
      <div class="grid">
        ${this.drafts.map(a => {
          const slug = a.slug ?? a.id.replace(/^app_/, '');
          return html`<button
            class="card"
            ?disabled=${this.busy}
            @click=${() =>
              this.openInStudio({
                slug,
                title: a.title,
                html: a.payload,
                ...(a.url ? { url: a.url } : {}),
              })}
          >
            <div class="name">${a.title}</div>
            <div class="sub">/${slug}</div>
            <span class=${a.url ? 'badge live' : 'badge'}>
              ${a.url ? 'En ligne' : 'Brouillon'}
            </span>
          </button>`;
        })}
        ${publishedOnly.map(
          m => html`<button
            class="card"
            ?disabled=${this.busy}
            @click=${() => void this.openPublished(m.slug, m.title || m.slug)}
          >
            <div class="name">${m.title || m.slug}</div>
            <div class="sub">/${m.slug}</div>
            <span class="badge live">En ligne</span>
          </button>`
        )}
      </div>
    `;
  }

  /**
   * Open an app that is published but absent from this browser's shelf (a
   * different device, or cleared storage) by recovering its source.
   */
  private async openPublished(slug: string, title: string) {
    if (this.busy) return;
    this.busy = true;
    this.busyLabel = 'Récupération du code…';
    this.error = '';
    try {
      const res = await fetch(
        cdzApiUrl(`/api/v1/apps/${encodeURIComponent(slug)}/source`)
      );
      const data = (await res.json().catch(() => null)) as {
        html?: string;
        message?: string;
        error?: string;
      } | null;
      if (!res.ok || !data?.html) {
        throw new Error(
          data?.message || 'Impossible de récupérer le code de cette app.'
        );
      }
      const found = this.mine.find(m => m.slug === slug);
      this.openInStudio({
        slug,
        title,
        html: data.html,
        ...(found?.url ? { url: found.url } : {}),
      });
    } catch (err) {
      this.error = err instanceof Error ? err.message : 'Récupération échouée';
    } finally {
      this.busy = false;
      this.busyLabel = '';
    }
  }

  protected override render() {
    const app = this.app;
    return html`
      <div class="wrap">
        <div class="hero">
          <h1>Créez votre application</h1>
          <p class="sub">
            Décrivez ce dont vous avez besoin, ou partez d'un modèle. Vous
            verrez le résultat tout de suite et pourrez le modifier en direct.
          </p>
          <div class="composer">
            <textarea
              placeholder="Que voulez-vous construire ? Ex : une app de rendez-vous pour mon salon, avec confirmation WhatsApp…"
              .value=${this.prompt}
              ?disabled=${this.busy}
              @input=${(e: Event) => {
                this.prompt = (e.target as HTMLTextAreaElement).value;
              }}
            ></textarea>
            <div class="row">
              <button
                class="btn"
                ?disabled=${this.busy || !this.prompt.trim()}
                @click=${() => void this.generate(this.prompt)}
              >
                ${this.busy ? 'Création…' : 'Créer mon application'}
              </button>
            </div>
          </div>
          <div class="starters">
            ${CDZ_STARTERS.map(
              s => html`<button
                ?disabled=${this.busy}
                @click=${() => void this.generate(s.prompt)}
              >
                ${s.label}
              </button>`
            )}
          </div>
          ${this.busy && this.busyLabel
            ? html`<div class="busy">${this.busyLabel}</div>`
            : nothing}
          ${this.livePreview
            ? html`<div class="live">
                <div class="live-head">
                  <span class="live-dot" aria-hidden></span>
                  Aperçu en direct — votre application s'écrit
                </div>
                <!-- srcdoc + a locked-down sandbox: this is partial, unfinished
                     model output, so it gets scripts (the app needs them to
                     render) but no same-origin, no forms, no top-level
                     navigation. The final app is re-mounted by the studio. -->
                <iframe
                  title="Aperçu en direct"
                  sandbox="allow-scripts"
                  .srcdoc=${this.livePreview}
                ></iframe>
              </div>`
            : nothing}
          ${this.error ? html`<div class="err">${this.error}</div>` : nothing}
        </div>

        ${this.renderMine()} ${this.renderAppTemplates()}
        ${this.renderTemplates()}
      </div>

      ${app
        ? html`<clickdz-builder-studio
            .open=${this.studioOpen}
            .slug=${app.slug}
            .title=${app.title}
            .html=${app.html}
            .publishedUrl=${app.url ?? ''}
            @studio-close=${() => {
              this.studioOpen = false;
            }}
            @studio-html-change=${(e: CustomEvent<{ html: string }>) => {
              if (this.app) this.app = { ...this.app, html: e.detail.html };
            }}
            @studio-title-change=${(e: CustomEvent<{ title: string }>) => {
              if (this.app) this.app = { ...this.app, title: e.detail.title };
            }}
            @studio-app-loaded=${(
              e: CustomEvent<{ slug: string; title: string; html: string }>
            ) => {
              this.app = { ...e.detail };
              void this.loadMine();
            }}
            @studio-published=${(e: CustomEvent<{ url: string }>) => {
              if (this.app) this.app = { ...this.app, url: e.detail.url };
              void this.loadMine();
            }}
          ></clickdz-builder-studio>`
        : nothing}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'clickdz-builder-home': ClickDzBuilderHome;
  }
}
