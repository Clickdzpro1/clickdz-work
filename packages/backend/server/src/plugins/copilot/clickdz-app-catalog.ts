// ClickDz App Builder — the 10-template APP catalog (PURE DATA).
//
// The SHOP catalog (`clickdz-shop-catalog.ts`) presets a storefront that already
// exists as a single String.raw template. THIS catalog is different in kind: the
// App Builder has no pre-built HTML — POST /api/v1/apps/generate asks the code
// agent for a fresh single-file app every time. So an APP "template" is NOT an
// appearance preset; it is a curated GENERATION BRIEF (French, structured,
// Algeria-specific) plus the gallery metadata to render a picker card. The
// bridge resolves a def by id and PREPENDS `brief` to the user's prompt before
// `buildNewAppContent` (clickdz-app-prompt.ts) wraps it — the brief therefore
// rides inside the existing `Request:` seam and needs no new prompt plumbing.
//
// This module is intentionally framework-free and side-effect-free: no NestJS
// decorators, no DOM, no imports at all — mirroring the purity convention of
// `clickdz-erp-shipping.ts` / `clickdz-erp-caisse.ts` (zero-import pure logic
// modules) and the plain-data-array style of `clickdz-shop-catalog.ts`.
//
// ── Structural contracts (do not drift) ─────────────────────────────────────
// • Every brief RESTATES the Data API hard contract from APP_BUILDER_GUIDELINES
//   (clickdz-app-prompt.ts): the Authorization: Bearer header goes on EVERY
//   request, reads included — writes 401 without it and reads of customer-data
//   collections are refused too. The generated app must keep the injected
//   __CLICKDZ_DATA_URL__ / __CLICKDZ_DATA_TOKEN__ placeholders.
// • `collections[]` documents each template's Data API collections. Where a
//   collection holds personal data (names/phones), `personalData: true`. NOTE:
//   the server-side read gate (SENSITIVE_COLLECTIONS + the invoice* prefix in
//   clickdz-data.controller.ts) only recognises a fixed name set — briefs use
//   the canonical protected names (`clients`, `invoices`) whenever the domain
//   allows; other PII collections (rendezvous, membres, eleves…) are flagged
//   here so a follow-up can extend the server set.
// • Gate: `appTemplateCatalogEnabled()` reads CDZ_APP_TEMPLATE_CATALOG === '1'
//   (default OFF), the exact idiom of `templateCatalogEnabled()` in
//   clickdz-template-mint.ts. `getAppTemplateDef` and `listAppTemplateCatalog`
//   honor the gate themselves (null / []) so the bridge call sites stay thin.
// • Briefs are plain prompt text: they are NEVER injected into a String.raw
//   template literal (unlike shop seed packs), so French accents and
//   apostrophes are fine. They must stay self-contained: the model sees only
//   guidelines + brief + the merchant's one-liner.

/* ---------------------------------------------------------------------------
 * Types
 * ------------------------------------------------------------------------- */

/** Gallery category buckets (the app picker's derived tabs). */
export type AppTemplateCategory =
  | 'Services'
  | 'Commerce'
  | 'Finance'
  | 'Éducation'
  | 'Immobilier'
  | 'Santé'
  | 'Marketing'
  | 'Restauration'
  | 'Événements';

/**
 * One Data API collection a template's brief instructs the app to use.
 * Documentation data (surfaced in admin/help copy and future privacy review) —
 * the Data API itself is schemaless and needs no registration.
 */
export interface AppCollectionDef {
  /** Free-form lowercase collection name, exactly as the brief spells it. */
  name: string;
  /** One-line purpose (FR). */
  purpose: string;
  /**
   * True when records hold personal data (names, phone numbers). Reads of such
   * collections must carry the bearer token — and only the canonical names in
   * clickdz-data.controller.ts's SENSITIVE_COLLECTIONS (+ invoice*) are ALSO
   * refused server-side without it. Flagged here regardless of that set.
   */
  personalData: boolean;
}

/**
 * One app template = gallery card metadata + a structured French generation
 * brief. Data only; no logic. The gallery card is built from the metadata
 * fields (`emoji`, `gradient`, `name`, `nameDarja`, `category`, `pitch`); the
 * generate route uses `brief`.
 */
export interface AppTemplateDef {
  /** Stable id, e.g. 'rendez-vous' | 'factures-dz'. Lowercase kebab. */
  id: string;
  /** FR display name (gallery card title). */
  name: string;
  /** Darja label for the picker chip (Arabic script). */
  nameDarja: string;
  /** Single glyph for the gallery card. */
  emoji: string;
  /** Picker category bucket. */
  category: AppTemplateCategory;
  /** One-line pitch shown under the card title (FR). */
  pitch: string;
  /** Accent #RRGGBB for the card swatch. */
  accent: string;
  /** Two colors for the gallery thumbnail gradient (card only). */
  gradient: [string, string];
  /** The Data API collections the brief tells the app to create/use. */
  collections: AppCollectionDef[];
  /**
   * The structured generation brief (FR), prepended to the merchant's prompt
   * by POST /api/v1/apps/generate when `templateId` resolves. This is the
   * product: concrete screens, Algerian specifics (69 wilayas, DZD, 05/06/07
   * phones, wa.me, RC/NIF/ART, TVA 19 %), a PIN-gated admin, empty/loading/
   * error states and a « Données de démo » seeding button.
   */
  brief: string;
}

/* ---------------------------------------------------------------------------
 * Catalog version — bump when template ids/briefs change materially so clients
 * can detect a stale gallery. Mirrors TEMPLATE_CATALOG_VERSION (shop catalog).
 * ------------------------------------------------------------------------- */
export const APP_TEMPLATE_CATALOG_VERSION = 2 as const;

/* ---------------------------------------------------------------------------
 * Env gate — the exact idiom of templateCatalogEnabled() in
 * clickdz-template-mint.ts ('1' = on, anything else = off; house convention).
 * Exposed as a function so call sites read intent-fully and tests can stub
 * process.env before first call.
 * ------------------------------------------------------------------------- */

/** Gate the whole APP template gallery + `templateId` handling. Default OFF. */
export function appTemplateCatalogEnabled(): boolean {
  return process.env.CDZ_APP_TEMPLATE_CATALOG === '1';
}

/* ---------------------------------------------------------------------------
 * Shared brief fragments — repeated verbatim in every brief so each brief
 * stays self-contained even if a future refactor sends briefs individually.
 * Kept as consts only to avoid 10× hand-copy drift INSIDE this file; they are
 * concatenated at module load, so exported briefs are plain complete strings.
 * ------------------------------------------------------------------------- */

// The Data API hard contract, restated in French (source of truth:
// APP_BUILDER_GUIDELINES in clickdz-app-prompt.ts — Bearer on EVERY request).
const BRIEF_DATA_RULES =
  'RÈGLES DATA API (obligatoires) :\n' +
  '- Utilise la Data API ClickDz (fetch vers __CLICKDZ_DATA_URL__) pour toutes les données partagées ; conserve les placeholders __CLICKDZ_DATA_URL__ et __CLICKDZ_DATA_TOKEN__ tels quels.\n' +
  '- Envoie le header Authorization: Bearer avec le token injecté sur CHAQUE requête, LECTURES COMPRISES (les écritures sont refusées en 401 sans lui, et les lectures des collections de données clients aussi).\n' +
  '- Limites : 8 Ko par enregistrement, 500 enregistrements par collection — reste sobre (pas de photos en base64, uniquement des URLs).\n' +
  '- Pas de PUT : une modification = DELETE puis re-création (garde l\'id serveur de chaque enregistrement).\n' +
  '- Gère proprement les erreurs réseau (message en français + bouton Réessayer).';

// The PIN-gated admin convention (mirrors the shop template: the PIN lives in
// the `settings` singleton, default 1234, editable in the admin's Réglages).
const BRIEF_ADMIN_RULES =
  'ADMIN PROTÉGÉ PAR PIN :\n' +
  '- L\'espace gestion est derrière un écran PIN (clavier numérique large, adapté au pouce). PIN par défaut 1234, modifiable dans Réglages ; stocke le PIN et les réglages dans la collection `settings` (enregistrement unique, même convention que la boutique ClickDz).\n' +
  '- Le PIN mémorisé pour la session via sessionStorage uniquement (jamais le token).';

// The quality floor every template restates (the task-critical trio + demo).
const BRIEF_QUALITY_RULES =
  'QUALITÉ (non négociable) :\n' +
  '- Mobile-first : pensé pour un Android milieu de gamme, boutons ≥ 44 px, une seule colonne par défaut.\n' +
  '- Chaque liste a TROIS états soignés : chargement (squelettes), vide (illustration emoji + phrase d\'aide + action), erreur (message FR + Réessayer).\n' +
  '- Un bouton « Données de démo » bien visible quand tout est vide : il insère des exemples réalistes algériens (prénoms locaux, wilayas variées, prix ronds en DZD) puis recharge la liste.\n' +
  '- Interface 100 % en français simple, avec quelques clins d\'œil darja discrets (ex. « Saha ! » après un succès). Dinars affichés « 1 500 DZD » (espace milliers).\n' +
  '- Téléphones algériens : 10 chiffres commençant par 05, 06 ou 07 (valide la saisie) ; les liens WhatsApp utilisent https://wa.me/213 + numéro sans le 0 initial.';

/* ---------------------------------------------------------------------------
 * The 14 templates.
 *
 * Order = gallery order (most-wanted first). Ids are stable; briefs are the
 * product. Prices DZD. Every brief is structured: CONTEXTE → ÉCRANS → DONNÉES →
 * SPÉCIFICITÉS DZ → shared rule blocks.
 * ------------------------------------------------------------------------- */
export const APP_TEMPLATE_CATALOG: AppTemplateDef[] = [
  /* ── 1 · Services — Rendez-vous (salon / cabinet) ──────────────────────── */
  {
    id: 'rendez-vous',
    name: 'Rendez-vous',
    nameDarja: 'المواعيد',
    emoji: '📅',
    category: 'Services',
    pitch: 'Prise de rendez-vous en ligne pour salon, coiffeur ou cabinet — fini le carnet papier.',
    accent: '#8b5cf6',
    gradient: ['#8b5cf6', '#6d28d9'],
    collections: [
      { name: 'rendezvous', purpose: 'Les réservations (nom, téléphone, prestation, date, créneau, statut).', personalData: true },
      { name: 'prestations', purpose: 'Les prestations proposées (nom, durée en minutes, prix DZD).', personalData: false },
      { name: 'settings', purpose: 'Réglages : PIN admin, nom du salon, WhatsApp, horaires, jours fermés.', personalData: false },
    ],
    brief: `MODÈLE « Rendez-vous » — application de prise de rendez-vous pour un salon de coiffure / institut / cabinet en Algérie.

CONTEXTE : le gérant note aujourd'hui ses rendez-vous dans un carnet ; les clients appellent ou envoient un message. L'app remplace le carnet et laisse le client réserver seul.

ÉCRAN PUBLIC (accueil) :
- En-tête avec le nom du salon (depuis les réglages) et un bouton WhatsApp.
- Parcours de réservation en 3 étapes : 1) choisir une prestation (carte avec nom, durée, prix en DZD) ; 2) choisir un jour (7 prochains jours, vendredi marqué fermé si les réglages le disent) ; 3) choisir un créneau libre (grille 09:00→19:00 par pas de 30 min, les créneaux déjà pris ou bloqués sont grisés — recharge la collection juste avant d'enregistrer pour éviter les doubles réservations).
- Formulaire final : nom + téléphone (05/06/07). Après confirmation : écran de succès avec récapitulatif + bouton « Confirmer sur WhatsApp » qui ouvre wa.me du salon avec un message pré-rempli (prestation, jour, heure, nom).

ADMIN (derrière PIN) :
- Agenda du jour : liste chronologique des rendez-vous avec nom, téléphone (lien tel: et wa.me), prestation, statut Confirmé / Annulé / Absent — changement de statut en un tap.
- Vue semaine compacte (compteur de RDV par jour).
- Bloquer un créneau (pause, absence) : crée un rendez-vous interne « Bloqué ».
- Gestion des prestations (ajouter / modifier / désactiver) et Réglages (nom, WhatsApp, horaires, jours fermés, PIN).
- Mini-stats en haut : RDV aujourd'hui, RDV cette semaine, taux d'absence.

DONNÉES : collections \`rendezvous\` (contient noms + téléphones : toujours lue avec le token), \`prestations\`, \`settings\` (enregistrement unique).

${BRIEF_DATA_RULES}

${BRIEF_ADMIN_RULES}

${BRIEF_QUALITY_RULES}
- Données de démo : 4 prestations (ex. Coupe homme 800 DZD / 30 min, Brushing 1 200 DZD / 45 min) et 6 rendez-vous répartis sur 2 jours avec des prénoms algériens (Amine, Meriem, Sofiane, Lina…).`,
  },

  /* ── 2 · Commerce — Suivi livraisons COD ───────────────────────────────── */
  {
    id: 'suivi-livraisons',
    name: 'Suivi livraisons',
    nameDarja: 'وين الطرد',
    emoji: '📦',
    category: 'Commerce',
    pitch: 'Suivez vos colis COD wilaya par wilaya et laissez le client vérifier « où est mon colis ».',
    accent: '#f97316',
    gradient: ['#f97316', '#c2410c'],
    collections: [
      { name: 'colis', purpose: 'Les envois (destinataire, téléphone, wilaya, montant COD, transporteur, statut, code de suivi).', personalData: true },
      { name: 'settings', purpose: 'Réglages : PIN admin, nom de la boutique, WhatsApp.', personalData: false },
    ],
    brief: `MODÈLE « Suivi livraisons » — tableau de bord de suivi des colis paiement-à-la-livraison (COD) pour un vendeur e-commerce algérien.

CONTEXTE : le vendeur expédie via Yalidine, ZR Express, Maystro ou NOEST et perd le fil de « qui a reçu quoi ». Les clients demandent sans arrêt « وين الطرد ؟ ». L'app centralise les envois et donne au client une page de suivi.

ÉCRAN PUBLIC « Suivre mon colis » :
- Un champ unique : le code de suivi (format court généré par l'app, ex. DZ-4F7K9). Résultat : frise verticale des 5 statuts — En préparation → Expédié → En livraison → Livré, avec la branche Retour en rouge — plus wilaya de destination et montant à préparer en DZD. Aucune donnée d'autrui n'est listée : recherche par code exact uniquement.

ADMIN (derrière PIN) :
- Tableau des colis : destinataire, téléphone (liens tel: / wa.me), wilaya (menu des 69 wilayas, code + nom, ex. « 16 — Alger »), montant COD en DZD, transporteur (choix libre : Yalidine, ZR Express, Maystro, NOEST, autre), statut coloré.
- Changement de statut en un tap ; bouton 💬 « Prévenir le client » : wa.me pré-rempli avec le statut et le code de suivi.
- Filtres : par statut, par wilaya ; recherche par nom / téléphone / code.
- KPI en haut : colis en cours, livrés ce mois-ci, montant COD à encaisser (somme des « En livraison » + « Expédié »), taux de retour (retours / terminés) — le chiffre qui fait mal en COD, affiche-le franchement.
- Création d'un colis : le code de suivi est généré automatiquement (2 lettres + 4 caractères), copiable en un tap.

DONNÉES : \`colis\` (noms + téléphones : lecture toujours avec le token), \`settings\` (unique).

${BRIEF_DATA_RULES}

${BRIEF_ADMIN_RULES}

${BRIEF_QUALITY_RULES}
- Données de démo : 8 colis répartis sur 5 wilayas (Alger, Oran, Sétif, Constantine, Blida) et les 5 statuts, montants COD entre 2 500 et 12 000 DZD.`,
  },

  /* ── 3 · Commerce — Carnet clients (mini CRM) ──────────────────────────── */
  {
    id: 'carnet-clients',
    name: 'Carnet clients',
    nameDarja: 'الكليان',
    emoji: '👥',
    category: 'Commerce',
    pitch: 'Tous vos clients, leurs numéros et leurs habitudes — avec les relances à ne pas rater.',
    accent: '#0ea5e9',
    gradient: ['#0ea5e9', '#0369a1'],
    collections: [
      { name: 'clients', purpose: 'Les fiches clients (nom, téléphone, wilaya, étiquettes, notes, dernier contact, total acheté DZD). Nom canonique protégé côté serveur.', personalData: true },
      { name: 'settings', purpose: 'Réglages : PIN admin, nom du commerce, délai de relance en jours.', personalData: false },
    ],
    brief: `MODÈLE « Carnet clients » — mini-CRM pour un commerçant algérien qui gère ses clients sur WhatsApp et dans sa tête.

CONTEXTE : les numéros sont éparpillés entre le téléphone et Messenger. L'app est un carnet unique : qui est fidèle, qui doit être relancé, qu'est-ce qu'il achète.

APP INTERNE : tout est derrière le PIN (aucun écran public).

ÉCRANS :
- Liste clients : recherche instantanée (nom ou téléphone), tri par « dernier contact » ; chaque ligne montre le nom, la wilaya, les étiquettes colorées (Fidèle, Nouveau, Grossiste, Difficile) et deux boutons directs 📞 (tel:) et 💬 (wa.me).
- Fiche client : nom, téléphone (05/06/07), wilaya (liste des 58), étiquettes, total acheté cumulé en DZD, notes libres (« préfère la livraison bureau », « négocie toujours »), historique des contacts (bouton « Contacté aujourd'hui » qui horodate).
- Vue « À relancer » : clients sans contact depuis N jours (N réglable, 30 par défaut) — c'est l'écran qui rapporte de l'argent, mets-le en avant avec un badge compteur ; bouton wa.me pré-rempli gentil (« Salam {nom}, on a du nouveau… »).
- KPI en haut : total clients, nouveaux ce mois-ci, à relancer.

DONNÉES : collection \`clients\` — nom canonique EXPRÈS : c'est une collection protégée côté serveur, sa lecture exige le token (envoie-le partout de toute façon) ; \`settings\` (unique).

${BRIEF_DATA_RULES}

${BRIEF_ADMIN_RULES}

${BRIEF_QUALITY_RULES}
- Données de démo : 10 clients aux prénoms algériens variés, wilayas mélangées, 3 « à relancer » d'office pour montrer l'écran clé.`,
  },

  /* ── 4 · Finance — Factures DZ ─────────────────────────────────────────── */
  {
    id: 'factures-dz',
    name: 'Factures DZ',
    nameDarja: 'الفاتورة',
    emoji: '🧾',
    category: 'Finance',
    pitch: 'Des factures propres aux normes algériennes : RC, NIF, ART, TVA 19 % et impression A4.',
    accent: '#16a34a',
    gradient: ['#16a34a', '#166534'],
    collections: [
      { name: 'invoices', purpose: 'Les factures (client, lignes, totaux HT/TVA/TTC, numéro, date, statut). Préfixe canonique protégé côté serveur.', personalData: true },
      { name: 'settings', purpose: 'Identité de l\'entreprise : raison sociale, adresse, RC, NIF, ART, NIS, téléphone, PIN.', personalData: false },
    ],
    brief: `MODÈLE « Factures DZ » — facturier pour une petite entreprise algérienne (SARL, EURL ou personne physique).

CONTEXTE : les clients pros exigent une facture avec les identifiants fiscaux ; Excel fait des factures moches et personne ne retrouve rien. L'app fait des factures propres, numérotées, imprimables.

APP INTERNE : tout est derrière le PIN.

ÉCRANS :
- Réglages (première visite guidée) : raison sociale, adresse, téléphone, RC (registre de commerce), NIF, ART (article d'imposition), NIS (facultatif) — affichés dans l'en-tête de chaque facture.
- Nouvelle facture : bloc client (nom / raison sociale, adresse, et RC + NIF du client si c'est une société) ; lignes (désignation, quantité, prix unitaire HT en DZD) ; TVA par ligne : 19 % par défaut, choix 9 % ou 0 % (exonéré) ; remise globale optionnelle en % ; totaux calculés — Total HT, Total TVA, Total TTC.
- Le montant TTC est aussi écrit EN LETTRES en français (« quarante-cinq mille six cents dinars algériens ») — écris une vraie fonction nombre→lettres, c'est obligatoire sur les factures.
- Numérotation automatique FAC-AAAA-NNN (remise à 001 chaque année), date modifiable, statut Payée / Impayée.
- Liste des factures : recherche par client / numéro, filtre par statut et par mois, total du mois affiché.
- Impression : bouton Imprimer → mise en page A4 sobre via CSS @media print (en-tête entreprise, tableau des lignes, totaux encadrés, montant en lettres, pied « Facture établie en un exemplaire »), le reste de l'interface masqué.
- KPI : chiffre d'affaires TTC du mois, montant impayé total, nombre de factures du mois.

DONNÉES : \`invoices\` — préfixe canonique EXPRÈS (collection protégée côté serveur : lecture avec token obligatoire) ; \`settings\` (unique).

${BRIEF_DATA_RULES}

${BRIEF_ADMIN_RULES}

${BRIEF_QUALITY_RULES}
- Données de démo : identité d'exemple (SARL Exemple Commerce, RC 16/00-123456B25, NIF 002516123456789, ART 16012345678) + 5 factures sur 2 mois, dont 2 impayées.`,
  },

  /* ── 5 · Commerce — Inventaire ─────────────────────────────────────────── */
  {
    id: 'inventaire',
    name: 'Inventaire',
    nameDarja: 'السطوك',
    emoji: '📋',
    category: 'Commerce',
    pitch: 'Comptez votre stock, traquez les écarts et ne tombez plus jamais en rupture surprise.',
    accent: '#64748b',
    gradient: ['#64748b', '#334155'],
    collections: [
      { name: 'articles', purpose: 'Les articles (nom, référence, catégorie, quantité, seuil d\'alerte, prix achat/vente DZD, emplacement).', personalData: false },
      { name: 'mouvements', purpose: 'Le journal des ajustements (article, delta, motif, date).', personalData: false },
      { name: 'settings', purpose: 'Réglages : PIN admin, nom du commerce.', personalData: false },
    ],
    brief: `MODÈLE « Inventaire » — gestion de stock simple pour une boutique, un dépôt ou un magasin algérien.

CONTEXTE : le stock vit dans un cahier et dans la mémoire du vendeur ; les ruptures se découvrent devant le client. L'app tient le compte et alerte avant la rupture.

APP INTERNE : tout est derrière le PIN.

ÉCRANS :
- Liste articles : recherche (nom / référence), filtre par catégorie, chaque ligne montre nom, référence, quantité en gros et coloré (vert / orange si ≤ seuil / rouge si 0), prix de vente DZD et emplacement (ex. « Rayon B, étagère 2 »).
- Ajustement rapide depuis la liste : boutons − / + qui ouvrent un mini-dialogue (quantité + motif : Réception, Vente, Casse, Correction) ; chaque ajustement est journalisé dans \`mouvements\` (article, delta signé, motif, date) — affiche l'historique dans la fiche article.
- Fiche article : tous les champs + prix d'achat et de vente en DZD, marge calculée, historique des mouvements.
- Vue « Stock bas » : les références sous leur seuil, triées par gravité — badge compteur dans la navigation.
- Mode « Comptage » : parcours toute la liste, saisis la quantité réellement comptée, l'app affiche l'écart par rapport au stock théorique et applique la correction (motif Correction) en un bouton en fin de comptage.
- KPI : nombre de références, valeur totale du stock au prix d'achat en DZD, références en alerte, ruptures.

DONNÉES : \`articles\`, \`mouvements\`, \`settings\` (unique). Pas de données personnelles ici, mais envoie quand même le token sur chaque requête (contrat plateforme).

${BRIEF_DATA_RULES}

${BRIEF_ADMIN_RULES}

${BRIEF_QUALITY_RULES}
- Données de démo : 12 articles sur 3 catégories, dont 2 sous le seuil et 1 en rupture, prix cohérents en DZD.`,
  },

  /* ── 6 · Éducation — Registre école / cours particuliers ───────────────── */
  {
    id: 'registre-ecole',
    name: 'Registre école',
    nameDarja: 'الطلبة',
    emoji: '🎓',
    category: 'Éducation',
    pitch: 'Élèves, groupes et paiements du mois pour école privée ou cours de soutien.',
    accent: '#2563eb',
    gradient: ['#2563eb', '#1e40af'],
    collections: [
      { name: 'eleves', purpose: 'Les élèves (nom, téléphone du parent, groupes).', personalData: true },
      { name: 'groupes', purpose: 'Les groupes (matière, niveau, professeur, tarif mensuel DZD, créneau).', personalData: false },
      { name: 'paiements', purpose: 'Les paiements mensuels (élève, groupe, mois AAAA-MM, montant DZD, date).', personalData: true },
      { name: 'settings', purpose: 'Réglages : PIN admin, nom de l\'école, WhatsApp.', personalData: false },
    ],
    brief: `MODÈLE « Registre école » — registre d'élèves et de paiements pour une école privée de soutien scolaire (cours particuliers) en Algérie.

CONTEXTE : le gérant coche les paiements sur un registre papier ; en fin de mois, impossible de savoir vite qui n'a pas payé. L'app tient les groupes, les élèves et la matrice des mois payés.

APP INTERNE : tout est derrière le PIN (données d'enfants — aucun écran public).

ÉCRANS :
- Groupes : matière (Maths, Physique, Français, Anglais…), niveau (ex. 3AS, 4AM, BEM, BAC), professeur, tarif mensuel en DZD, créneau (ex. « Samedi 14h ») ; compteur d'élèves par groupe.
- Élèves : nom, téléphone du parent (05/06/07 — liens tel: et wa.me), groupe(s) d'inscription ; recherche instantanée.
- Paiements — L'ÉCRAN CLÉ : choisis un groupe et un mois (AAAA-MM, mois courant par défaut) → tableau des élèves du groupe avec pastille Payé (verte, montant + date) ou Impayé (rouge) ; un tap sur Impayé enregistre le paiement (montant pré-rempli avec le tarif du groupe, modifiable).
- Bouton 💬 sur chaque impayé : wa.me au parent, message poli pré-rempli (« Salam, rappel du règlement du mois de {mois} pour {élève}, {montant} DZD. Merci ! »).
- KPI : élèves actifs, encaissé ce mois-ci en DZD, impayés du mois (nombre + manque à gagner).

DONNÉES : \`eleves\` et \`paiements\` contiennent des données personnelles (téléphones de parents) — lecture TOUJOURS avec le token ; \`groupes\`, \`settings\` (unique).

${BRIEF_DATA_RULES}

${BRIEF_ADMIN_RULES}

${BRIEF_QUALITY_RULES}
- Données de démo : 3 groupes (Maths BAC 2 500 DZD, Physique BAC 2 500 DZD, Français BEM 1 800 DZD), 9 élèves, paiements du mois courant remplis aux deux tiers pour montrer les impayés.`,
  },

  /* ── 7 · Services — Abonnements salle de sport ─────────────────────────── */
  {
    id: 'abonnements-gym',
    name: 'Abonnements gym',
    nameDarja: 'الأبونمة',
    emoji: '🏋️',
    category: 'Services',
    pitch: 'Qui est à jour, qui expire cette semaine : la salle de sport sans cahier ni disputes.',
    accent: '#dc2626',
    gradient: ['#dc2626', '#991b1b'],
    collections: [
      { name: 'membres', purpose: 'Les adhérents (nom, téléphone, formule, dates de début/fin, montant DZD, historique de renouvellements).', personalData: true },
      { name: 'settings', purpose: 'Réglages : PIN admin, nom de la salle, formules et tarifs.', personalData: false },
    ],
    brief: `MODÈLE « Abonnements gym » — suivi des adhérents d'une salle de sport / musculation algérienne.

CONTEXTE : à l'entrée, le coach doit savoir en 3 secondes si l'abonnement du membre est encore valable. Aujourd'hui c'est un cahier ; les fins d'abonnement passent inaperçues et la salle perd de l'argent.

APP INTERNE : tout est derrière le PIN.

ÉCRANS :
- Accueil = CONTRÔLE D'ENTRÉE : un grand champ de recherche (nom ou téléphone) ; le résultat affiche la carte du membre avec un ÉNORME badge visuel — vert « À jour, expire le {date} », orange « Expire dans {n} jours », rouge « Expiré depuis {n} jours » — lisible à un mètre.
- Fiche membre : nom, téléphone (05/06/07), formule (1 mois / 3 mois / 6 mois / 12 mois — tarifs DZD réglables dans Réglages), date de début, date de fin CALCULÉE automatiquement, montant payé ; bouton « Renouveler » en un tap (repart de la date de fin si encore à jour, sinon d'aujourd'hui) avec historique des renouvellements.
- Liste membres : filtres Actifs / Expirent ≤ 7 jours / Expirés ; tri par date de fin.
- Vue « Relances » : les expirés récents et ceux qui expirent sous 7 jours, chacun avec un bouton 💬 wa.me pré-rempli (« Salam {nom} ! Ton abonnement {formule} expire le {date}. On t'attend 💪 »).
- KPI : membres actifs, encaissé ce mois-ci en DZD, expirent cette semaine.

DONNÉES : \`membres\` (noms + téléphones : lecture toujours avec le token) ; \`settings\` (unique, contient aussi les formules/tarifs).

${BRIEF_DATA_RULES}

${BRIEF_ADMIN_RULES}

${BRIEF_QUALITY_RULES}
- Données de démo : 8 membres — 5 à jour, 2 qui expirent dans la semaine, 1 expiré — formules variées (1 mois 2 000 DZD, 3 mois 5 000 DZD, 12 mois 16 000 DZD).`,
  },

  /* ── 8 · Immobilier — Vitrine immo ─────────────────────────────────────── */
  {
    id: 'vitrine-immo',
    name: 'Vitrine immo',
    nameDarja: 'الديار',
    emoji: '🏠',
    category: 'Immobilier',
    pitch: 'Vos biens en vente et location, filtrables par wilaya et budget, avec contact WhatsApp direct.',
    accent: '#0d9488',
    gradient: ['#0d9488', '#115e59'],
    collections: [
      { name: 'biens', purpose: 'Les annonces (type, transaction, wilaya, commune, surface, pièces, prix DZD, photos URL, statut).', personalData: false },
      { name: 'demandes', purpose: 'Les demandes de contact (nom, téléphone, bien visé).', personalData: true },
      { name: 'settings', purpose: 'Réglages : PIN admin, nom de l\'agence, WhatsApp, téléphone.', personalData: false },
    ],
    brief: `MODÈLE « Vitrine immo » — vitrine d'annonces pour une agence immobilière ou un courtier (semsar) algérien.

CONTEXTE : les biens sont postés en vrac sur Facebook et disparaissent dans le fil. L'app est une vitrine propre et filtrable que l'agent partage en un lien.

ÉCRAN PUBLIC :
- Grille de cartes : photo (URL, avec vignette de secours 🏠 si l'image casse), type (Appartement F2/F3/F4/F5, Villa, Terrain, Local), transaction (Vente / Location), wilaya + commune, surface m², prix.
- AFFICHAGE DES PRIX À L'ALGÉRIENNE : en vente, montre le prix en DZD ET son équivalent parlé en millions de centimes — ex. « 12 000 000 DZD (1 200 millions) » ; en location, « 45 000 DZD/mois ». C'est ainsi que les gens comprennent les prix, ne saute pas ce détail.
- Filtres : transaction, type, wilaya (les 58), budget max ; badges « Nouveau » (moins de 7 jours) et « Vendu / Loué » (carte grisée, conservée pour la crédibilité).
- Fiche bien : galerie (défilement horizontal des photos), description, caractéristiques (étage, papiers : acte / livret foncier — champ libre), boutons « 💬 WhatsApp » (wa.me avec référence du bien pré-remplie) et « 📞 Appeler » ; petit formulaire « Je suis intéressé » (nom + téléphone 05/06/07) qui enregistre une demande.

ADMIN (derrière PIN) :
- CRUD des biens (photos = URLs collées, 5 max), marquer Vendu / Loué, mettre en avant (épinglé en tête).
- Liste des demandes reçues, par bien, avec liens tel: / wa.me — badge compteur des nouvelles demandes.

DONNÉES : \`biens\` (public), \`demandes\` (noms + téléphones : lecture toujours avec le token), \`settings\` (unique).

${BRIEF_DATA_RULES}

${BRIEF_ADMIN_RULES}

${BRIEF_QUALITY_RULES}
- Données de démo : 6 biens variés (F3 à Alger-centre 12 000 000 DZD, villa à Oran, terrain à Blida, F2 en location à Sétif 35 000 DZD/mois…), 1 vendu, photos Unsplash.`,
  },

  /* ── 9 · Finance — Devis artisan ───────────────────────────────────────── */
  {
    id: 'devis-artisan',
    name: 'Devis artisan',
    nameDarja: 'الديفي',
    emoji: '🛠️',
    category: 'Finance',
    pitch: 'Des devis pro en 2 minutes pour plombier, électricien ou menuisier — envoyés sur WhatsApp.',
    accent: '#b45309',
    gradient: ['#b45309', '#92400e'],
    collections: [
      { name: 'devis', purpose: 'Les devis (client, chantier, lignes, totaux, validité, statut).', personalData: true },
      { name: 'settings', purpose: 'Identité de l\'artisan : nom, métier, téléphone, RC/NIF/ART facultatifs, PIN.', personalData: false },
    ],
    brief: `MODÈLE « Devis artisan » — création de devis pour un artisan algérien (plombier, électricien, menuisier, peintre, maçon).

CONTEXTE : le client demande « combien ça va me coûter ? » ; l'artisan griffonne sur un papier et le client négocie dans le flou. Un devis propre inspire confiance et fait gagner des chantiers.

APP INTERNE : tout est derrière le PIN.

ÉCRANS :
- Réglages : nom / raison sociale, métier, téléphone, et RC / NIF / ART FACULTATIFS (beaucoup d'artisans sont auto-entrepreneurs ou non assujettis — l'app doit rester utilisable sans).
- Nouveau devis : client (nom, téléphone 05/06/07, adresse du chantier) ; lignes de travaux avec désignation, quantité, UNITÉ (m², ml, unité, forfait, jour) et prix unitaire DZD ; remise optionnelle ; TVA en option — interrupteur « Devis avec TVA (19 %) » désactivé par défaut : sans TVA on affiche un total simple, avec TVA on affiche HT / TVA / TTC.
- Validité du devis : 15 ou 30 jours (date limite calculée et affichée).
- Numérotation DEV-AAAA-NNN, statuts Brouillon / Envoyé / Accepté / Refusé.
- Envoi : bouton 💬 « Envoyer sur WhatsApp » qui compose un wa.me au client avec le devis en texte clair (lignes, total, validité) ; bouton Imprimer (A4 propre via @media print, en-tête artisan, tableau, total encadré, signature « Bon pour accord »).
- Liste des devis : filtre par statut, recherche par client ; passer un devis en Accepté / Refusé en un tap.
- KPI : devis du mois, taux d'acceptation, montant total accepté en DZD.

DONNÉES : \`devis\` (noms + téléphones : lecture toujours avec le token), \`settings\` (unique).

${BRIEF_DATA_RULES}

${BRIEF_ADMIN_RULES}

${BRIEF_QUALITY_RULES}
- Données de démo : 4 devis (ex. installation sanitaire 48 000 DZD accepté, peinture appartement F3 85 000 DZD envoyé…) avec unités variées.`,
  },

  /* ── 10 · Santé — File d'attente cabinet ───────────────────────────────── */
  {
    id: 'file-attente',
    name: "File d'attente",
    nameDarja: 'لاشان',
    emoji: '🎟️',
    category: 'Santé',
    pitch: 'Tickets numérotés et écran « au suivant » pour cabinet médical — la salle d\'attente respire.',
    accent: '#0891b2',
    gradient: ['#0891b2', '#155e75'],
    collections: [
      { name: 'tickets', purpose: 'Les tickets du jour (numéro, nom facultatif, téléphone facultatif, statut, horodatage).', personalData: true },
      { name: 'settings', purpose: 'Réglages : PIN admin, nom du cabinet, message d\'accueil.', personalData: false },
    ],
    brief: `MODÈLE « File d'attente » — gestion de la file d'un cabinet médical (ou laboratoire / administration) en Algérie.

CONTEXTE : la salle d'attente déborde et tout le monde demande « c'est à qui le tour ? ». La secrétaire distribue des numéros ; le médecin appelle le suivant. L'app remplace les bouts de papier.

TROIS SURFACES DANS LA MÊME APP :
1) RÉCEPTION (derrière PIN) : bouton géant « + Nouveau ticket » → numéro auto-incrémenté du jour (repart à 1 chaque jour : filtre les tickets sur la date du jour), nom facultatif, téléphone facultatif (05/06/07) ; liste du jour avec statuts En attente / En consultation / Passé / Absent ; boutons « Appeler le suivant » (le premier En attente passe En consultation, le précédent passe Passé) et « Absent » ; correction possible (re-mettre un Absent en attente en fin de file).
2) ÉCRAN SALLE D'ATTENTE (mode plein écran, pensé pour une TV) : ÉNORME numéro en consultation (taille pleine page), les 3 prochains numéros en dessous, nom du cabinet et message d'accueil (depuis Réglages) ; rafraîchissement automatique toutes les 10 secondes ; quand le numéro change, animation flash visible de loin.
3) PAGE PATIENT (publique, via le même lien) : « Quel est votre numéro ? » → position actuelle dans la file, numéro en cours, estimation d'attente = (positions restantes) × durée moyenne des consultations déjà terminées aujourd'hui (affiche « ~25 min », arrondi aux 5 min) ; rafraîchissement auto toutes les 15 secondes.

KPI réception : patients reçus aujourd'hui, en attente, durée moyenne de consultation.

DONNÉES : \`tickets\` (peut contenir noms/téléphones : lecture toujours avec le token), \`settings\` (unique). Les tickets portent la date du jour (AAAA-MM-JJ) — la « remise à zéro » quotidienne est un simple filtre, ne supprime rien.

${BRIEF_DATA_RULES}

${BRIEF_ADMIN_RULES}

${BRIEF_QUALITY_RULES}
- Données de démo : 7 tickets du jour (n° 1 à 7) — 3 passés, 1 en consultation, 2 en attente, 1 absent — pour que l'écran TV et la page patient montrent tout de suite quelque chose de vivant.`,
  },

  /* ── 11 · Marketing — Campagnes agence ─────────────────────────────────── */
  {
    id: 'agence-marketing',
    name: 'Agence marketing',
    nameDarja: 'الماركتينغ',
    emoji: '📣',
    category: 'Marketing',
    pitch: 'Clients, campagnes et relances pour agence ou freelance marketing — les leads à ne pas perdre.',
    accent: '#db2777',
    gradient: ['#db2777', '#9d174d'],
    collections: [
      { name: 'clients', purpose: 'Les fiches clients de l\'agence (nom, téléphone, entreprise, secteur, statut). Nom canonique protégé côté serveur.', personalData: true },
      { name: 'campagnes', purpose: 'Les campagnes (client, canal, budget DZD, dates, statut, notes).', personalData: false },
      { name: 'taches', purpose: 'Les actions à faire (campagne, tâche, échéance, fait).', personalData: false },
      { name: 'settings', purpose: 'Réglages : PIN admin, nom de l\'agence, WhatsApp.', personalData: false },
    ],
    brief: `MODÈLE « Agence marketing » — mini-pipeline pour une agence marketing ou un freelance (social media, pub, référencement) en Algérie.

CONTEXTE : les clients arrivent par WhatsApp et Instagram, les campagnes se suivent dans la tête et les factures oubliées restent impayées. L'app centralise clients, campagnes et relances.

APP INTERNE : tout est derrière le PIN.

ÉCRANS :
- Tableau de bord : KPI en haut — clients actifs, campagnes en cours, à relancer, chiffre affiché en DZD (encaissé ce mois-ci pour les plans suivis).
- Clients : liste avec recherche (nom ou téléphone) ; chaque fiche porte nom, téléphone (05/06/07, liens tel: / wa.me), entreprise, secteur (Resto, E-commerce, Service, Santé…), statut coloré (Prospect / Actif / En pause / Perdu) ; bouton 💬 WhatsApp pré-rempli.
- Campagnes : une campagne = client + canal (Instagram, Facebook, TikTok, Google, WhatsApp, Presse) + budget en DZD + dates de début/fin + statut (Brouillon / En cours / En pause / Terminée) ; liste filtrable par statut et par client, KPI total dépensé du mois.
- Tâches / relances : liste d'actions avec échéance (appeler le prospect, envoyer le rapport, relancer la facture) ; la vue « À relancer » regroupe celles en retard en premier, badge compteur, bouton wa.me vers le client concerné.
- KPI agence : clients actifs, campagnes en cours, montant total des campagnes en cours en DZD, tâches en retard.

DONNÉES : \`clients\` — nom canonique EXPRÈS (collection protégée côté serveur, lecture avec le token obligatoire) ; \`campagnes\`, \`taches\`, \`settings\` (unique).

${BRIEF_DATA_RULES}

${BRIEF_ADMIN_RULES}

${BRIEF_QUALITY_RULES}
- Données de démo : 8 clients (dont 2 à relancer), 5 campagnes (Instagram resto 60 000 DZD en cours, TikTok e-commerce…), 6 tâches dont 2 en retard.`,
  },

  /* ── 12 · Restauration — Menu / carte ──────────────────────────────────── */
  {
    id: 'resto-menu',
    name: 'Menu resto',
    nameDarja: 'المنيو',
    emoji: '🍽️',
    category: 'Restauration',
    pitch: 'Une carte numérique pour votre resto ou fast-food, avec commande par WhatsApp en un tap.',
    accent: '#ea580c',
    gradient: ['#ea580c', '#9a3412'],
    collections: [
      { name: 'plats', purpose: 'Les plats et boissons (nom, catégorie, prix DZD, description, URL image, disponible).', personalData: false },
      { name: 'commandes', purpose: 'Les commandes reçues (client, téléphone, plats, montant DZD, statut).', personalData: true },
      { name: 'settings', purpose: 'Réglages : PIN admin, nom du resto, numéro WhatsApp, adresse.', personalData: false },
    ],
    brief: `MODÈLE « Menu resto » — carte numérique pour un restaurant, fast-food ou food-truck algérien, avec commande WhatsApp.

CONTEXTE : la carte est une photo floue dans les stories ; le client hésite et n'ose pas appeler. L'app est une carte propre, consultable, qui envoie la commande direct sur WhatsApp.

ÉCRAN PUBLIC (carte) :
- En-tête : nom du resto, horaires (depuis les réglages), bouton « 🛵 Commander sur WhatsApp » avec le panier.
- Catégories en onglets (Entrées, Plats, Grillades, Pizzas, Desserts, Boissons…).
- Chaque plat : nom, description courte, prix en DZD (« 1 200 DZD »), badge « Nouveau » / « Populaire », petit bouton « + » pour l'ajouter au panier.
- Panier flottant en bas : liste des plats et quantités, total en DZD, bouton « Envoyer la commande » → ouvre wa.me du resto avec la commande écrite en clair (plat × quantité + total) ; tout est géré côté client, aucune inscription nécessaire.

ADMIN (derrière PIN) :
- CRUD des plats (nom, catégorie, prix DZD, description, URL image, disponible / épuisé).
- Commandes reçues : les commandes enregistrées par le client laissent ici leur trace (clients qui préfèrent un parcours en ligne) — nom, téléphone, plat, montant DZD, statut Reçue / En préparation / Prête / Servie, bouton wa.me pour confirmer.
- KPI : plats au menu, commandes aujourd'hui, montant des commandes du jour en DZD.

DONNÉES : \`plats\` (public), \`commandes\` (noms + téléphones : lecture TOUJOURS avec le token), \`settings\` (unique).

${BRIEF_DATA_RULES}

${BRIEF_ADMIN_RULES}

${BRIEF_QUALITY_RULES}
- Données de démo : 10 plats sur 4 catégories (couscous 900 DZD, pizza 1 100 DZD, tajine 1 200 DZD, thé 100 DZD…) et 3 commandes du jour dont 1 en préparation.`,
  },

  /* ── 13 · Santé — Carnet de suivi santé ────────────────────────────────── */
  {
    id: 'sante-bienetre',
    name: 'Bien-être',
    nameDarja: 'الصحة',
    emoji: '💚',
    category: 'Santé',
    pitch: 'Suivi de poids, activité et habitudes pour coach, nutritionniste ou usage personnel.',
    accent: '#059669',
    gradient: ['#059669', '#065f46'],
    collections: [
      { name: 'releves', purpose: 'Les relevés (jour, poids kg, activité, humeur, notes).', personalData: true },
      { name: 'objectifs', purpose: 'Les objectifs (type, valeur cible, date visée).', personalData: false },
      { name: 'settings', purpose: 'Réglages : PIN admin, nom du profil, unités.', personalData: false },
    ],
    brief: `MODÈLE « Bien-être » — carnet de suivi santé et forme pour un coach, un nutritionniste ou un usage personnel en Algérie.

CONTEXTE : suivre son poids et son activité dans un cahier revient vite à abandonner. L'app rend le suivi visuel et motivant avec des courbes et des rappels discrets.

APP INTERNE : derrière un PIN léger (usage personnel ou coach avec ses clients).

ÉCRANS :
- Accueil : carte du jour — poids actuel, objectif restant, activité d'aujourd'hui ; grande frise des derniers relevés.
- Saisie rapide : poids en kg, activité du jour, humeur (émojis), note libre ; chaque relevé est horodaté dans \`releves\`.
- Courbe : graphique de l'évolution du poids et de l'activité sur 30 jours (dessiné en SVG ou en barres HTML/CSS inline — pas de librairie, tout doit marcher dans le fichier seul).
- Objectifs : type (poids, pas, séances) + valeur cible + date visée ; l'acceuil affiche la progression en % et un badge quand l'objectif est atteint ou en retard.
- Séries / habitudes : compteur de jours consécutifs (streak) avec flammes, petit message motivant en darja (ex. « رانا هنا ! Continue 💪 »).

DONNÉES : \`releves\` (données personnelles de santé : lecture TOUJOURS avec le token), \`objectifs\`, \`settings\` (unique).

${BRIEF_DATA_RULES}

${BRIEF_ADMIN_RULES}

${BRIEF_QUALITY_RULES}
- Données de démo : 15 relevés sur les 30 derniers jours avec une tendance réaliste (ex. 86,4 → 84,1 kg), 1 objectif en cours et 1 atteint.`,
  },

  /* ── 14 · Événements — Gestion d'événement ─────────────────────────────── */
  {
    id: 'evenementiel',
    name: 'Événementiel',
    nameDarja: 'الحدث',
    emoji: '🎪',
    category: 'Événements',
    pitch: 'Invités, places et paiements pour un mariage, un gala ou un concert — tout suivi.',
    accent: '#7c3aed',
    gradient: ['#7c3aed', '#5b21b6'],
    collections: [
      { name: 'invites', purpose: 'Les invités (nom, téléphone, catégorie, statut réponse, nombre de places).', personalData: true },
      { name: 'tables', purpose: 'Les tables / catégories de places (nom, capacité, prix DZD si payant).', personalData: false },
      { name: 'settings', purpose: 'Réglages : PIN admin, nom de l\'événement, date, lieu.', personalData: false },
    ],
    brief: `MODÈLE « Événementiel » — gestion des invités et des places d'un événement algérien (mariage, gala, conférence, concert).

CONTEXTE : les réponses affluent par téléphone et WhatsApp, personne n'a la liste à jour le jour J. L'app tient la liste des invités, leurs réponses et le compte des places.

APP INTERNE : tout est derrière le PIN.

ÉCRANS :
- Tableau de bord (le jour J) : liste des invités attendus, confirmés, présents ; badge compteur « sur 150 places ».
- Invités : nom, téléphone (05/06/07), catégorie (Famille, Ami, Table VIP, Orateur, Presse…), statut en un tap (Invité / Confirmé / Présent / Absent / Annulé), nombre de places par invité.
- Listes pratiques : « Liste d'attente » (non confirmés à relancer), « Liste du jour » (à vérifier à l'entrée) ; chaque invité a un bouton 💬 wa.me pré-rempli de confirmation.
- Tables / places : tables avec capacité et prix DZD (si événement payant), suivi des places restantes par catégorie ; un invité confirme sur une table.
- KPI : invités confirmés, places restantes, présents le jour J, montant encaissé en DZD (si billetterie).

DONNÉES : \`invites\` (noms + téléphones : lecture TOUJOURS avec le token), \`tables\`, \`settings\` (unique).

${BRIEF_DATA_RULES}

${BRIEF_ADMIN_RULES}

${BRIEF_QUALITY_RULES}
- Données de démo : 12 invités (8 confirmés, 2 en attente, 1 absent, 1 annulé) sur 3 tables + 150 places annoncées, pour montrer la liste du jour dès l'ouverture.`,
  },
];

/* ---------------------------------------------------------------------------
 * Tiny pure helpers (no side effects). Mirror the shop catalog's accessors,
 * but SELF-GATED: this catalog owns its env gate (the shop one is gated in
 * clickdz-template-mint.ts), so bridge call sites stay one-liners.
 * ------------------------------------------------------------------------- */

/**
 * Lightweight gallery metadata for the `GET /api/v1/apps/app-templates`
 * endpoint. Deliberately excludes the long `brief` and the `collections` doc
 * so the list payload stays small — the brief is prepended server-side at
 * generate time, never sent to the picker.
 */
export interface AppTemplateMeta {
  id: string;
  name: string;
  nameDarja: string;
  emoji: string;
  category: AppTemplateCategory;
  pitch: string;
  accent: string;
  gradient: [string, string];
}

/**
 * Return the small gallery metadata for every template, in catalog order.
 * Honors the env gate: returns [] when CDZ_APP_TEMPLATE_CATALOG is not '1'
 * (mirrors listTemplateCatalog() in clickdz-template-mint.ts).
 */
export function listAppTemplateCatalog(): AppTemplateMeta[] {
  if (!appTemplateCatalogEnabled()) return [];
  return APP_TEMPLATE_CATALOG.map(function (t): AppTemplateMeta {
    return {
      id: t.id,
      name: t.name,
      nameDarja: t.nameDarja,
      emoji: t.emoji,
      category: t.category,
      pitch: t.pitch,
      accent: t.accent,
      gradient: t.gradient,
    };
  });
}

/**
 * Resolve a template def by id, honoring the env gate. Returns null when the
 * catalog is disabled, the id is absent/blank/not a string, or the id is
 * unknown — callers then fall back to a plain (un-templated) generate. NEVER
 * throws (a bad templateId must degrade to today's behavior, not 500) —
 * mirrors resolveTemplateDef() in clickdz-template-mint.ts.
 */
export function getAppTemplateDef(id: string | null | undefined): AppTemplateDef | null {
  if (!appTemplateCatalogEnabled()) return null;
  if (typeof id !== 'string') return null;
  const key = id.trim().toLowerCase();
  if (!key) return null;
  for (let i = 0; i < APP_TEMPLATE_CATALOG.length; i++) {
    if (APP_TEMPLATE_CATALOG[i].id === key) return APP_TEMPLATE_CATALOG[i];
  }
  return null;
}

/** The distinct gallery category buckets, in first-seen catalog order. */
export function listAppTemplateCategories(): AppTemplateCategory[] {
  const seen: Record<string, boolean> = {};
  const out: AppTemplateCategory[] = [];
  for (let i = 0; i < APP_TEMPLATE_CATALOG.length; i++) {
    const c = APP_TEMPLATE_CATALOG[i].category;
    if (!seen[c]) {
      seen[c] = true;
      out.push(c);
    }
  }
  return out;
}
