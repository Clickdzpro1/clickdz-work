// ClickDz Work — Template Systems v2.
// Defines per-niche database schemas for real interactive database blocks.
// Each schema = columns + views + initial rows.
// Used by the installer v2 to create affine:database blocks alongside markdown content.

import { Text } from '@blocksuite/affine/store';

// ─── helper id generator ───────────────────────────────────────────────
function id(): string {
  // 10-char alphanum, similar to BlockSuite internal ids
  return Array.from({ length: 10 }, () =>
    Math.random().toString(36).charAt(2)
  ).join('');
}

// ─── column types ───────────────────────────────────────────────────────
export type ColumnType = 'rich-text' | 'select' | 'number' | 'date' | 'link';

export interface ColumnDef {
  id: string;
  type: ColumnType;
  name: string;
  data?: Record<string, any>;
}

export interface SelectOption {
  id: string;
  value: string;
  color: string;
}

export interface RowData {
  title: string;
  cells: Record<string, any>;
}

export interface ViewDef {
  id: string;
  name: string;
  mode: 'kanban' | 'table';
  columns: { id: string; hide: boolean; width?: number }[];
  groupBy?: { columnId: string; name: string };
  groupProperties?: Array<{ key: string; hide: boolean; manuallyCardSort: string[] }>;
}

export interface DatabaseSchema {
  title: string;
  columns: ColumnDef[];
  views: ViewDef[];
  rows: RowData[];
}

// ─── select color constants ────────────────────────────────────────────
const COL = {
  white: 'var(--affine-v2-chip-label-white)',
  blue: 'var(--affine-v2-chip-label-blue)',
  green: 'var(--affine-v2-chip-label-green)',
  yellow: 'var(--affine-v2-chip-label-yellow)',
  red: 'var(--affine-v2-chip-label-red)',
  purple: 'var(--affine-v2-chip-label-purple)',
  orange: 'var(--affine-v2-chip-label-orange)',
};

// ─── Agence Digitale — Client Pipeline ─────────────────────────────────
const STATUS_PIPELINE: SelectOption[] = [
  { id: id(), value: 'Nouveau', color: COL.white },
  { id: id(), value: 'Devis envoyé', color: COL.yellow },
  { id: id(), value: 'Acompte reçu', color: COL.blue },
  { id: id(), value: 'En production', color: COL.purple },
  { id: id(), value: 'Livré', color: COL.green },
  { id: id(), value: 'Fermé', color: COL.red },
];

const digitalAgencySchema: DatabaseSchema = {
  title: 'Client Pipeline — Agence Digitale',
  columns: [
    { id: 'title', type: 'rich-text', name: 'Client' },
    { id: id(), type: 'select', name: 'Statut', data: { options: STATUS_PIPELINE } },
    { id: id(), type: 'rich-text', name: 'Prestation' },
    { id: id(), type: 'rich-text', name: 'Montant (DZD)' },
    { id: id(), type: 'rich-text', name: 'Wilaya' },
  ],
  views: [
    {
      id: id(), name: 'Kanban', mode: 'kanban',
      columns: [{ id: 'title', hide: false }, { id: STATUS_PIPELINE[0].id, hide: false }],
      groupBy: { columnId: STATUS_PIPELINE[0].id, name: 'select' },
      groupProperties: STATUS_PIPELINE.map(o => ({ key: o.id, hide: false, manuallyCardSort: [] })).concat([{ key: 'Ungroups', hide: false, manuallyCardSort: [] }]),
    },
    {
      id: id(), name: 'Table', mode: 'table',
      columns: [
        { id: 'title', hide: false, width: 260 },
        { id: STATUS_PIPELINE[0].id, hide: false, width: 180 },
        { id: 'title', hide: false, width: 200 },
      ],
    },
  ],
  rows: [
    { title: 'Sarl TechnoPlus', cells: { [STATUS_PIPELINE[0].id]: STATUS_PIPELINE[4].id } },
    { title: 'Café Le Diwan', cells: { [STATUS_PIPELINE[0].id]: STATUS_PIPELINE[1].id } },
    { title: 'Groupe Benali Immo', cells: { [STATUS_PIPELINE[0].id]: STATUS_PIPELINE[3].id } },
    { title: 'Boutique Amira Mode', cells: { [STATUS_PIPELINE[0].id]: STATUS_PIPELINE[0].id } },
    { title: 'Auto Pièces Sétif', cells: { [STATUS_PIPELINE[0].id]: STATUS_PIPELINE[1].id } },
  ],
};

// ─── E-commerce / COD — Commandes Pipeline ──────────────────────────────
const STATUS_ORDERS: SelectOption[] = [
  { id: id(), value: 'Nouvelle', color: COL.white },
  { id: id(), value: 'Confirmée', color: COL.yellow },
  { id: id(), value: 'Expédiée', color: COL.blue },
  { id: id(), value: 'Livrée', color: COL.green },
  { id: id(), value: 'Retournée', color: COL.red },
];

const ecommerceSchema: DatabaseSchema = {
  title: 'Commandes COD — Suivi',
  columns: [
    { id: 'title', type: 'rich-text', name: 'Commande' },
    { id: id(), type: 'select', name: 'Statut', data: { options: STATUS_ORDERS } },
    { id: id(), type: 'rich-text', name: 'Client' },
    { id: id(), type: 'rich-text', name: 'Produit' },
    { id: id(), type: 'rich-text', name: 'Montant (DZD)' },
    { id: id(), type: 'rich-text', name: 'Wilaya' },
  ],
  views: [
    {
      id: id(), name: 'Pipeline Kanban', mode: 'kanban',
      columns: [{ id: 'title', hide: false }, { id: STATUS_ORDERS[0].id, hide: false }],
      groupBy: { columnId: STATUS_ORDERS[0].id, name: 'select' },
      groupProperties: STATUS_ORDERS.map(o => ({ key: o.id, hide: false, manuallyCardSort: [] })).concat([{ key: 'Ungroups', hide: false, manuallyCardSort: [] }]),
    },
    {
      id: id(), name: 'Table', mode: 'table',
      columns: [
        { id: 'title', hide: false, width: 180 },
        { id: STATUS_ORDERS[0].id, hide: false, width: 180 },
        { id: 'title', hide: false, width: 200 },
      ],
    },
  ],
  rows: [
    { title: 'CMD-1042', cells: { [STATUS_ORDERS[0].id]: STATUS_ORDERS[3].id } },
    { title: 'CMD-1043', cells: { [STATUS_ORDERS[0].id]: STATUS_ORDERS[2].id } },
    { title: 'CMD-1044', cells: { [STATUS_ORDERS[0].id]: STATUS_ORDERS[1].id } },
    { title: 'CMD-1045', cells: { [STATUS_ORDERS[0].id]: STATUS_ORDERS[0].id } },
    { title: 'CMD-1046', cells: { [STATUS_ORDERS[0].id]: STATUS_ORDERS[0].id } },
  ],
};

// ─── Immobilier — Biens & Leads ───────────────────────────────────────
const STATUS_BIENS: SelectOption[] = [
  { id: id(), value: 'Disponible', color: COL.green },
  { id: id(), value: 'Réservé', color: COL.yellow },
  { id: id(), value: 'Vendu', color: COL.blue },
  { id: id(), value: 'Retiré', color: COL.red },
];

const realEstateSchema: DatabaseSchema = {
  title: 'Biens Immobiliers — Suivi',
  columns: [
    { id: 'title', type: 'rich-text', name: 'Bien' },
    { id: id(), type: 'select', name: 'Statut', data: { options: STATUS_BIENS } },
    { id: id(), type: 'rich-text', name: 'Type' },
    { id: id(), type: 'rich-text', name: 'Wilaya' },
    { id: id(), type: 'rich-text', name: 'Prix (DZD)' },
  ],
  views: [
    {
      id: id(), name: 'Kanban', mode: 'kanban',
      columns: [{ id: 'title', hide: false }, { id: STATUS_BIENS[0].id, hide: false }],
      groupBy: { columnId: STATUS_BIENS[0].id, name: 'select' },
      groupProperties: STATUS_BIENS.map(o => ({ key: o.id, hide: false, manuallyCardSort: [] })).concat([{ key: 'Ungroups', hide: false, manuallyCardSort: [] }]),
    },
    {
      id: id(), name: 'Table', mode: 'table',
      columns: [
        { id: 'title', hide: false, width: 260 },
        { id: STATUS_BIENS[0].id, hide: false, width: 180 },
        { id: 'title', hide: false, width: 200 },
      ],
    },
  ],
  rows: [
    { title: 'Villa Hydra — 4 chambres', cells: { [STATUS_BIENS[0].id]: STATUS_BIENS[0].id } },
    { title: 'Appartement Oran — 3 pièces', cells: { [STATUS_BIENS[0].id]: STATUS_BIENS[0].id } },
    { title: 'Terrain Blida — 500m²', cells: { [STATUS_BIENS[0].id]: STATUS_BIENS[0].id } },
    { title: 'Résidence Constantine — 2F2', cells: { [STATUS_BIENS[0].id]: STATUS_BIENS[1].id } },
  ],
};

// ─── Cabinet Médical — Patients & Rendez-vous ────────────────────────
const STATUS_RDV: SelectOption[] = [
  { id: id(), value: 'Confirmé', color: COL.green },
  { id: id(), value: 'En attente', color: COL.yellow },
  { id: id(), value: 'Annulé', color: COL.red },
  { id: id(), value: 'Passé', color: COL.blue },
];

const clinicSchema: DatabaseSchema = {
  title: 'Rendez-vous & Patients — Suivi',
  columns: [
    { id: 'title', type: 'rich-text', name: 'Patient' },
    { id: id(), type: 'select', name: 'Statut RDV', data: { options: STATUS_RDV } },
    { id: id(), type: 'rich-text', name: 'Motif' },
    { id: id(), type: 'rich-text', name: 'Date' },
    { id: id(), type: 'rich-text', name: 'Priorité' },
  ],
  views: [
    {
      id: id(), name: 'Kanban', mode: 'kanban',
      columns: [{ id: 'title', hide: false }, { id: STATUS_RDV[0].id, hide: false }],
      groupBy: { columnId: STATUS_RDV[0].id, name: 'select' },
      groupProperties: STATUS_RDV.map(o => ({ key: o.id, hide: false, manuallyCardSort: [] })).concat([{ key: 'Ungroups', hide: false, manuallyCardSort: [] }]),
    },
    {
      id: id(), name: 'Table', mode: 'table',
      columns: [
        { id: 'title', hide: false, width: 260 },
        { id: STATUS_RDV[0].id, hide: false, width: 180 },
      ],
    },
  ],
  rows: [
    { title: 'Patient A.', cells: { [STATUS_RDV[0].id]: STATUS_RDV[0].id } },
    { title: 'Patient B.', cells: { [STATUS_RDV[0].id]: STATUS_RDV[0].id } },
    { title: 'Patient C.', cells: { [STATUS_RDV[0].id]: STATUS_RDV[1].id } },
    { title: 'Patient D.', cells: { [STATUS_RDV[0].id]: STATUS_RDV[3].id } },
  ],
};

// ─── Construction — Chantiers & Fournisseurs ──────────────────────────
const STATUS_CHANTIER: SelectOption[] = [
  { id: id(), value: 'Fondations', color: COL.white },
  { id: id(), value: 'Gros œuvre', color: COL.yellow },
  { id: id(), value: 'Second œuvre', color: COL.blue },
  { id: id(), value: 'Finitions', color: COL.purple },
  { id: id(), value: 'Réception', color: COL.green },
  { id: id(), value: 'Clôturé', color: COL.red },
];

const constructionSchema: DatabaseSchema = {
  title: 'Chantiers — Suivi Avancement',
  columns: [
    { id: 'title', type: 'rich-text', name: 'Chantier' },
    { id: id(), type: 'select', name: 'Phase', data: { options: STATUS_CHANTIER } },
    { id: id(), type: 'rich-text', name: 'Client' },
    { id: id(), type: 'rich-text', name: 'Wilaya' },
    { id: id(), type: 'rich-text', name: 'Avancement %' },
  ],
  views: [
    {
      id: id(), name: 'Kanban', mode: 'kanban',
      columns: [{ id: 'title', hide: false }, { id: STATUS_CHANTIER[0].id, hide: false }],
      groupBy: { columnId: STATUS_CHANTIER[0].id, name: 'select' },
      groupProperties: STATUS_CHANTIER.map(o => ({ key: o.id, hide: false, manuallyCardSort: [] })).concat([{ key: 'Ungroups', hide: false, manuallyCardSort: [] }]),
    },
    {
      id: id(), name: 'Table', mode: 'table',
      columns: [
        { id: 'title', hide: false, width: 260 },
        { id: STATUS_CHANTIER[0].id, hide: false, width: 180 },
      ],
    },
  ],
  rows: [
    { title: 'Villa Hydra', cells: { [STATUS_CHANTIER[0].id]: STATUS_CHANTIER[2].id } },
    { title: 'Immeuble R+4 Bir Mourad Raïs', cells: { [STATUS_CHANTIER[0].id]: STATUS_CHANTIER[1].id } },
    { title: 'Lotissement Ain Benian', cells: { [STATUS_CHANTIER[0].id]: STATUS_CHANTIER[0].id } },
    { title: 'Extension usine agroalimentaire', cells: { [STATUS_CHANTIER[0].id]: STATUS_CHANTIER[3].id } },
  ],
};

// ─── CRM / ERP — Leads & Contacts ─────────────────────────────────────
const STATUS_CRM: SelectOption[] = [
  { id: id(), value: 'Nouveau lead', color: COL.white },
  { id: id(), value: 'Contacté', color: COL.yellow },
  { id: id(), value: 'Qualifié', color: COL.blue },
  { id: id(), value: 'Proposition', color: COL.purple },
  { id: id(), value: 'Gagné', color: COL.green },
  { id: id(), value: 'Perdu', color: COL.red },
];

const crmSchema: DatabaseSchema = {
  title: 'CRM — Pipeline Commercial',
  columns: [
    { id: 'title', type: 'rich-text', name: 'Nom / Entreprise' },
    { id: id(), type: 'select', name: 'Statut', data: { options: STATUS_CRM } },
    { id: id(), type: 'rich-text', name: 'Téléphone' },
    { id: id(), type: 'rich-text', name: 'Email' },
    { id: id(), type: 'rich-text', name: 'Montant estimé (DZD)' },
    { id: id(), type: 'rich-text', name: 'Assigné à' },
  ],
  views: [
    {
      id: id(), name: 'Pipeline Kanban', mode: 'kanban',
      columns: [{ id: 'title', hide: false }, { id: STATUS_CRM[0].id, hide: false }],
      groupBy: { columnId: STATUS_CRM[0].id, name: 'select' },
      groupProperties: STATUS_CRM.map(o => ({ key: o.id, hide: false, manuallyCardSort: [] })).concat([{ key: 'Ungroups', hide: false, manuallyCardSort: [] }]),
    },
    {
      id: id(), name: 'Table', mode: 'table',
      columns: [
        { id: 'title', hide: false, width: 260 },
        { id: STATUS_CRM[0].id, hide: false, width: 180 },
      ],
    },
  ],
  rows: [
    { title: 'Sarl TechnoPlus', cells: { [STATUS_CRM[0].id]: STATUS_CRM[3].id } },
    { title: 'Auto Pièces Sétif', cells: { [STATUS_CRM[0].id]: STATUS_CRM[1].id } },
    { title: 'Café Le Diwan', cells: { [STATUS_CRM[0].id]: STATUS_CRM[0].id } },
    { title: 'Groupe Benali Immo', cells: { [STATUS_CRM[0].id]: STATUS_CRM[4].id } },
  ],
};

// ─── HR / Recrutement — Candidatures ──────────────────────────────────
const STATUS_RECRUIT: SelectOption[] = [
  { id: id(), value: 'Candidature', color: COL.white },
  { id: id(), value: 'Entretien', color: COL.yellow },
  { id: id(), value: 'Test technique', color: COL.blue },
  { id: id(), value: 'Offre envoyée', color: COL.purple },
  { id: id(), value: 'Embauché', color: COL.green },
  { id: id(), value: 'Refusé', color: COL.red },
];

const hrSchema: DatabaseSchema = {
  title: 'Recrutement — Suivi Candidats',
  columns: [
    { id: 'title', type: 'rich-text', name: 'Candidat' },
    { id: id(), type: 'select', name: 'Statut', data: { options: STATUS_RECRUIT } },
    { id: id(), type: 'rich-text', name: 'Poste' },
    { id: id(), type: 'rich-text', name: 'Expérience' },
    { id: id(), type: 'rich-text', name: 'Date entretien' },
  ],
  views: [
    {
      id: id(), name: 'Pipeline Kanban', mode: 'kanban',
      columns: [{ id: 'title', hide: false }, { id: STATUS_RECRUIT[0].id, hide: false }],
      groupBy: { columnId: STATUS_RECRUIT[0].id, name: 'select' },
      groupProperties: STATUS_RECRUIT.map(o => ({ key: o.id, hide: false, manuallyCardSort: [] })).concat([{ key: 'Ungroups', hide: false, manuallyCardSort: [] }]),
    },
    {
      id: id(), name: 'Table', mode: 'table',
      columns: [
        { id: 'title', hide: false, width: 260 },
        { id: STATUS_RECRUIT[0].id, hide: false, width: 180 },
      ],
    },
  ],
  rows: [
    { title: 'Ahmed Benali', cells: { [STATUS_RECRUIT[0].id]: STATUS_RECRUIT[2].id } },
    { title: 'Fatima Zohra', cells: { [STATUS_RECRUIT[0].id]: STATUS_RECRUIT[1].id } },
    { title: 'Karim Amara', cells: { [STATUS_RECRUIT[0].id]: STATUS_RECRUIT[0].id } },
  ],
};

// ─── Inventory / Stock — Gestion des stocks ───────────────────────────
const STATUS_STOCK: SelectOption[] = [
  { id: id(), value: 'En stock', color: COL.green },
  { id: id(), value: 'Stock faible', color: COL.yellow },
  { id: id(), value: 'Rupture', color: COL.red },
  { id: id(), value: 'En commande', color: COL.blue },
];

const inventorySchema: DatabaseSchema = {
  title: 'Stock & Inventaire',
  columns: [
    { id: 'title', type: 'rich-text', name: 'Produit' },
    { id: id(), type: 'select', name: 'Statut', data: { options: STATUS_STOCK } },
    { id: id(), type: 'rich-text', name: 'Catégorie' },
    { id: id(), type: 'rich-text', name: 'Quantité' },
    { id: id(), type: 'rich-text', name: 'Prix unitaire (DZD)' },
    { id: id(), type: 'rich-text', name: 'Fournisseur' },
  ],
  views: [
    {
      id: id(), name: 'Table', mode: 'table',
      columns: [
        { id: 'title', hide: false, width: 260 },
        { id: STATUS_STOCK[0].id, hide: false, width: 180 },
        { id: 'title', hide: false, width: 200 },
      ],
    },
    {
      id: id(), name: 'Alertes Kanban', mode: 'kanban',
      columns: [{ id: 'title', hide: false }, { id: STATUS_STOCK[0].id, hide: false }],
      groupBy: { columnId: STATUS_STOCK[0].id, name: 'select' },
      groupProperties: STATUS_STOCK.map(o => ({ key: o.id, hide: false, manuallyCardSort: [] })).concat([{ key: 'Ungroups', hide: false, manuallyCardSort: [] }]),
    },
  ],
  rows: [
    { title: 'iPhone 15 Pro', cells: { [STATUS_STOCK[0].id]: STATUS_STOCK[0].id } },
    { title: 'Samsung Galaxy S24', cells: { [STATUS_STOCK[0].id]: STATUS_STOCK[1].id } },
    { title: 'Chargeur USB-C', cells: { [STATUS_STOCK[0].id]: STATUS_STOCK[2].id } },
  ],
};

// ─── SaaS / Développement — Bugs & Features ───────────────────────────
const STATUS_DEV: SelectOption[] = [
  { id: id(), value: 'Backlog', color: COL.white },
  { id: id(), value: 'En cours', color: COL.yellow },
  { id: id(), value: 'Review', color: COL.blue },
  { id: id(), value: 'Test', color: COL.purple },
  { id: id(), value: 'Livré', color: COL.green },
  { id: id(), value: 'Bloqué', color: COL.red },
];

const devSchema: DatabaseSchema = {
  title: 'Dev — Bugs & Features',
  columns: [
    { id: 'title', type: 'rich-text', name: 'Titre' },
    { id: id(), type: 'select', name: 'Statut', data: { options: STATUS_DEV } },
    { id: id(), type: 'rich-text', name: 'Type' },
    { id: id(), type: 'rich-text', name: 'Priorité' },
    { id: id(), type: 'rich-text', name: 'Assigné à' },
    { id: id(), type: 'rich-text', name: 'Sprint' },
  ],
  views: [
    {
      id: id(), name: 'Sprint Kanban', mode: 'kanban',
      columns: [{ id: 'title', hide: false }, { id: STATUS_DEV[0].id, hide: false }],
      groupBy: { columnId: STATUS_DEV[0].id, name: 'select' },
      groupProperties: STATUS_DEV.map(o => ({ key: o.id, hide: false, manuallyCardSort: [] })).concat([{ key: 'Ungroups', hide: false, manuallyCardSort: [] }]),
    },
    {
      id: id(), name: 'Table', mode: 'table',
      columns: [
        { id: 'title', hide: false, width: 260 },
        { id: STATUS_DEV[0].id, hide: false, width: 180 },
      ],
    },
  ],
  rows: [
    { title: 'API auth JWT refresh', cells: { [STATUS_DEV[0].id]: STATUS_DEV[2].id } },
    { title: 'Dashboard dark mode', cells: { [STATUS_DEV[0].id]: STATUS_DEV[1].id } },
    { title: 'Mobile responsive fix', cells: { [STATUS_DEV[0].id]: STATUS_DEV[0].id } },
  ],
};

// ─── Restaurant / Horeca — Réservations & Commandes ───────────────────
const STATUS_RES: SelectOption[] = [
  { id: id(), value: 'Réservé', color: COL.blue },
  { id: id(), value: 'Confirmé', color: COL.green },
  { id: id(), value: 'Annulé', color: COL.red },
  { id: id(), value: 'Terminé', color: COL.purple },
];

const restaurantSchema: DatabaseSchema = {
  title: 'Réservations & Tables',
  columns: [
    { id: 'title', type: 'rich-text', name: 'Client' },
    { id: id(), type: 'select', name: 'Statut', data: { options: STATUS_RES } },
    { id: id(), type: 'rich-text', name: 'Table' },
    { id: id(), type: 'rich-text', name: 'Date / Heure' },
    { id: id(), type: 'rich-text', name: 'Nombre de personnes' },
    { id: id(), type: 'rich-text', name: 'Notes' },
  ],
  views: [
    {
      id: id(), name: 'Tableau', mode: 'table',
      columns: [
        { id: 'title', hide: false, width: 260 },
        { id: STATUS_RES[0].id, hide: false, width: 180 },
      ],
    },
    {
      id: id(), name: 'Kanban', mode: 'kanban',
      columns: [{ id: 'title', hide: false }, { id: STATUS_RES[0].id, hide: false }],
      groupBy: { columnId: STATUS_RES[0].id, name: 'select' },
      groupProperties: STATUS_RES.map(o => ({ key: o.id, hide: false, manuallyCardSort: [] })).concat([{ key: 'Ungroups', hide: false, manuallyCardSort: [] }]),
    },
  ],
  rows: [
    { title: 'Famille Benali', cells: { [STATUS_RES[0].id]: STATUS_RES[1].id } },
    { title: 'M. Amara', cells: { [STATUS_RES[0].id]: STATUS_RES[0].id } },
  ],
};

// ─── Transport / Logistique — Livraisons ────────────────────────────────
const STATUS_SHIP: SelectOption[] = [
  { id: id(), value: 'En préparation', color: COL.white },
  { id: id(), value: 'En transit', color: COL.yellow },
  { id: id(), value: 'Livré', color: COL.green },
  { id: id(), value: 'Retourné', color: COL.red },
];

const logisticsSchema: DatabaseSchema = {
  title: 'Livraisons & Expéditions',
  columns: [
    { id: 'title', type: 'rich-text', name: 'N° Commande' },
    { id: id(), type: 'select', name: 'Statut', data: { options: STATUS_SHIP } },
    { id: id(), type: 'rich-text', name: 'Client' },
    { id: id(), type: 'rich-text', name: 'Destination' },
    { id: id(), type: 'rich-text', name: 'Transporteur' },
    { id: id(), type: 'rich-text', name: 'Date estimée' },
  ],
  views: [
    {
      id: id(), name: 'Tracking Kanban', mode: 'kanban',
      columns: [{ id: 'title', hide: false }, { id: STATUS_SHIP[0].id, hide: false }],
      groupBy: { columnId: STATUS_SHIP[0].id, name: 'select' },
      groupProperties: STATUS_SHIP.map(o => ({ key: o.id, hide: false, manuallyCardSort: [] })).concat([{ key: 'Ungroups', hide: false, manuallyCardSort: [] }]),
    },
    {
      id: id(), name: 'Table', mode: 'table',
      columns: [
        { id: 'title', hide: false, width: 200 },
        { id: STATUS_SHIP[0].id, hide: false, width: 180 },
      ],
    },
  ],
  rows: [
    { title: 'LIV-1024', cells: { [STATUS_SHIP[0].id]: STATUS_SHIP[1].id } },
    { title: 'LIV-1025', cells: { [STATUS_SHIP[0].id]: STATUS_SHIP[2].id } },
  ],
};

// ─── Éducation / Formation — Cours & Élèves ────────────────────────────
const STATUS_EDU: SelectOption[] = [
  { id: id(), value: 'Inscrit', color: COL.blue },
  { id: id(), value: 'Actif', color: COL.green },
  { id: id(), value: 'En pause', color: COL.yellow },
  { id: id(), value: 'Terminé', color: COL.purple },
  { id: id(), value: 'Abandonné', color: COL.red },
];

const educationSchema: DatabaseSchema = {
  title: 'Formation — Suivi Apprenants',
  columns: [
    { id: 'title', type: 'rich-text', name: 'Apprenant' },
    { id: id(), type: 'select', name: 'Statut', data: { options: STATUS_EDU } },
    { id: id(), type: 'rich-text', name: 'Cours' },
    { id: id(), type: 'rich-text', name: 'Progression %' },
    { id: id(), type: 'rich-text', name: 'Date début' },
  ],
  views: [
    {
      id: id(), name: 'Kanban', mode: 'kanban',
      columns: [{ id: 'title', hide: false }, { id: STATUS_EDU[0].id, hide: false }],
      groupBy: { columnId: STATUS_EDU[0].id, name: 'select' },
      groupProperties: STATUS_EDU.map(o => ({ key: o.id, hide: false, manuallyCardSort: [] })).concat([{ key: 'Ungroups', hide: false, manuallyCardSort: [] }]),
    },
    {
      id: id(), name: 'Table', mode: 'table',
      columns: [
        { id: 'title', hide: false, width: 260 },
        { id: STATUS_EDU[0].id, hide: false, width: 180 },
      ],
    },
  ],
  rows: [
    { title: 'Amine K.', cells: { [STATUS_EDU[0].id]: STATUS_EDU[1].id } },
    { title: 'Sofia B.', cells: { [STATUS_EDU[0].id]: STATUS_EDU[0].id } },
  ],
};

// ─── Cabinet d'Avocats / Juridique — Dossiers ───────────────────────────
const STATUS_LAW: SelectOption[] = [
  { id: id(), value: 'Ouvert', color: COL.blue },
  { id: id(), value: 'En instruction', color: COL.yellow },
  { id: id(), value: 'Audience fixée', color: COL.purple },
  { id: id(), value: 'Clôturé', color: COL.green },
  { id: id(), value: 'Archivé', color: COL.red },
];

const legalSchema: DatabaseSchema = {
  title: 'Dossiers Juridiques',
  columns: [
    { id: 'title', type: 'rich-text', name: 'Dossier' },
    { id: id(), type: 'select', name: 'Statut', data: { options: STATUS_LAW } },
    { id: id(), type: 'rich-text', name: 'Client' },
    { id: id(), type: 'rich-text', name: 'Type affaire' },
    { id: id(), type: 'rich-text', name: 'Date audience' },
    { id: id(), type: 'rich-text', name: 'Avocat' },
  ],
  views: [
    {
      id: id(), name: 'Kanban', mode: 'kanban',
      columns: [{ id: 'title', hide: false }, { id: STATUS_LAW[0].id, hide: false }],
      groupBy: { columnId: STATUS_LAW[0].id, name: 'select' },
      groupProperties: STATUS_LAW.map(o => ({ key: o.id, hide: false, manuallyCardSort: [] })).concat([{ key: 'Ungroups', hide: false, manuallyCardSort: [] }]),
    },
    {
      id: id(), name: 'Table', mode: 'table',
      columns: [
        { id: 'title', hide: false, width: 260 },
        { id: STATUS_LAW[0].id, hide: false, width: 180 },
      ],
    },
  ],
  rows: [
    { title: 'Dossier 2024-042', cells: { [STATUS_LAW[0].id]: STATUS_LAW[1].id } },
    { title: 'Dossier 2024-043', cells: { [STATUS_LAW[0].id]: STATUS_LAW[0].id } },
  ],
};

// ─── Comptabilité / Finance — Factures & Dépenses ──────────────────────
const STATUS_INV: SelectOption[] = [
  { id: id(), value: 'Brouillon', color: COL.white },
  { id: id(), value: 'Envoyée', color: COL.yellow },
  { id: id(), value: 'Payée', color: COL.green },
  { id: id(), value: 'En retard', color: COL.red },
  { id: id(), value: 'Annulée', color: COL.purple },
];

const financeSchema: DatabaseSchema = {
  title: 'Comptabilité — Factures & Dépenses',
  columns: [
    { id: 'title', type: 'rich-text', name: 'N° Facture' },
    { id: id(), type: 'select', name: 'Statut', data: { options: STATUS_INV } },
    { id: id(), type: 'rich-text', name: 'Client / Fournisseur' },
    { id: id(), type: 'rich-text', name: 'Montant (DZD)' },
    { id: id(), type: 'rich-text', name: 'Date émission' },
    { id: id(), type: 'rich-text', name: 'Date échéance' },
  ],
  views: [
    {
      id: id(), name: 'Suivi Kanban', mode: 'kanban',
      columns: [{ id: 'title', hide: false }, { id: STATUS_INV[0].id, hide: false }],
      groupBy: { columnId: STATUS_INV[0].id, name: 'select' },
      groupProperties: STATUS_INV.map(o => ({ key: o.id, hide: false, manuallyCardSort: [] })).concat([{ key: 'Ungroups', hide: false, manuallyCardSort: [] }]),
    },
    {
      id: id(), name: 'Table', mode: 'table',
      columns: [
        { id: 'title', hide: false, width: 200 },
        { id: STATUS_INV[0].id, hide: false, width: 180 },
      ],
    },
  ],
  rows: [
    { title: 'FAC-2024-105', cells: { [STATUS_INV[0].id]: STATUS_INV[2].id } },
    { title: 'FAC-2024-106', cells: { [STATUS_INV[0].id]: STATUS_INV[1].id } },
  ],
};

// ─── Marketing / Social Media — Campagnes ───────────────────────────────
const STATUS_MKT: SelectOption[] = [
  { id: id(), value: 'Planifiée', color: COL.white },
  { id: id(), value: 'En cours', color: COL.yellow },
  { id: id(), value: 'Publiée', color: COL.blue },
  { id: id(), value: 'Analysée', color: COL.green },
  { id: id(), value: 'Annulée', color: COL.red },
];

const marketingSchema: DatabaseSchema = {
  title: 'Marketing — Campagnes & Posts',
  columns: [
    { id: 'title', type: 'rich-text', name: 'Campagne' },
    { id: id(), type: 'select', name: 'Statut', data: { options: STATUS_MKT } },
    { id: id(), type: 'rich-text', name: 'Canal' },
    { id: id(), type: 'rich-text', name: 'Budget (DZD)' },
    { id: id(), type: 'rich-text', name: 'Date de lancement' },
    { id: id(), type: 'rich-text', name: 'Responsable' },
  ],
  views: [
    {
      id: id(), name: 'Kanban', mode: 'kanban',
      columns: [{ id: 'title', hide: false }, { id: STATUS_MKT[0].id, hide: false }],
      groupBy: { columnId: STATUS_MKT[0].id, name: 'select' },
      groupProperties: STATUS_MKT.map(o => ({ key: o.id, hide: false, manuallyCardSort: [] })).concat([{ key: 'Ungroups', hide: false, manuallyCardSort: [] }]),
    },
    {
      id: id(), name: 'Table', mode: 'table',
      columns: [
        { id: 'title', hide: false, width: 260 },
        { id: STATUS_MKT[0].id, hide: false, width: 180 },
      ],
    },
  ],
  rows: [
    { title: 'Campagne Ramadan 2025', cells: { [STATUS_MKT[0].id]: STATUS_MKT[2].id } },
    { title: 'Lancement Produit X', cells: { [STATUS_MKT[0].id]: STATUS_MKT[1].id } },
  ],
};

// ─── Event Planning — Événements ────────────────────────────────────────
const STATUS_EVT: SelectOption[] = [
  { id: id(), value: 'Idée', color: COL.white },
  { id: id(), value: 'Planification', color: COL.yellow },
  { id: id(), value: 'Ventes', color: COL.blue },
  { id: id(), value: 'En cours', color: COL.purple },
  { id: id(), value: 'Terminé', color: COL.green },
  { id: id(), value: 'Annulé', color: COL.red },
];

const eventSchema: DatabaseSchema = {
  title: 'Événements — Planification',
  columns: [
    { id: 'title', type: 'rich-text', name: 'Événement' },
    { id: id(), type: 'select', name: 'Statut', data: { options: STATUS_EVT } },
    { id: id(), type: 'rich-text', name: 'Date' },
    { id: id(), type: 'rich-text', name: 'Lieu' },
    { id: id(), type: 'rich-text', name: 'Budget (DZD)' },
    { id: id(), type: 'rich-text', name: 'Organisateur' },
  ],
  views: [
    {
      id: id(), name: 'Kanban', mode: 'kanban',
      columns: [{ id: 'title', hide: false }, { id: STATUS_EVT[0].id, hide: false }],
      groupBy: { columnId: STATUS_EVT[0].id, name: 'select' },
      groupProperties: STATUS_EVT.map(o => ({ key: o.id, hide: false, manuallyCardSort: [] })).concat([{ key: 'Ungroups', hide: false, manuallyCardSort: [] }]),
    },
    {
      id: id(), name: 'Table', mode: 'table',
      columns: [
        { id: 'title', hide: false, width: 260 },
        { id: STATUS_EVT[0].id, hide: false, width: 180 },
      ],
    },
  ],
  rows: [
    { title: 'Conférence Tech Dz 2025', cells: { [STATUS_EVT[0].id]: STATUS_EVT[1].id } },
    { title: 'Workshop AI Alger', cells: { [STATUS_EVT[0].id]: STATUS_EVT[0].id } },
  ],
};

// ─── Freelance / Consulting — Projets & Facturation ───────────────────
const STATUS_FREEL: SelectOption[] = [
  { id: id(), value: 'Prospect', color: COL.white },
  { id: id(), value: 'Devis envoyé', color: COL.yellow },
  { id: id(), value: 'En cours', color: COL.blue },
  { id: id(), value: 'Livré', color: COL.green },
  { id: id(), value: 'Facturé', color: COL.purple },
  { id: id(), value: 'Payé', color: COL.green },
];

const freelanceSchema: DatabaseSchema = {
  title: 'Freelance — Projets & Facturation',
  columns: [
    { id: 'title', type: 'rich-text', name: 'Projet' },
    { id: id(), type: 'select', name: 'Statut', data: { options: STATUS_FREEL } },
    { id: id(), type: 'rich-text', name: 'Client' },
    { id: id(), type: 'rich-text', name: 'Tarif (DZD)' },
    { id: id(), type: 'rich-text', name: 'Heures' },
    { id: id(), type: 'rich-text', name: 'Date deadline' },
  ],
  views: [
    {
      id: id(), name: 'Kanban', mode: 'kanban',
      columns: [{ id: 'title', hide: false }, { id: STATUS_FREEL[0].id, hide: false }],
      groupBy: { columnId: STATUS_FREEL[0].id, name: 'select' },
      groupProperties: STATUS_FREEL.map(o => ({ key: o.id, hide: false, manuallyCardSort: [] })).concat([{ key: 'Ungroups', hide: false, manuallyCardSort: [] }]),
    },
    {
      id: id(), name: 'Table', mode: 'table',
      columns: [
        { id: 'title', hide: false, width: 260 },
        { id: STATUS_FREEL[0].id, hide: false, width: 180 },
      ],
    },
  ],
  rows: [
    { title: 'Site e-commerce Sarl X', cells: { [STATUS_FREEL[0].id]: STATUS_FREEL[2].id } },
    { title: 'Branding Café Y', cells: { [STATUS_FREEL[0].id]: STATUS_FREEL[1].id } },
  ],
};

// ─── Manufacturing / Production — Ordres de fabrication ─────────────────
const STATUS_MFG: SelectOption[] = [
  { id: id(), value: 'Planifié', color: COL.white },
  { id: id(), value: 'En production', color: COL.yellow },
  { id: id(), value: 'Contrôle qualité', color: COL.blue },
  { id: id(), value: 'Terminé', color: COL.green },
  { id: id(), value: 'Rebut', color: COL.red },
];

const manufacturingSchema: DatabaseSchema = {
  title: 'Production — Ordres de Fabrication',
  columns: [
    { id: 'title', type: 'rich-text', name: 'OF N°' },
    { id: id(), type: 'select', name: 'Statut', data: { options: STATUS_MFG } },
    { id: id(), type: 'rich-text', name: 'Produit' },
    { id: id(), type: 'rich-text', name: 'Quantité' },
    { id: id(), type: 'rich-text', name: 'Machine' },
    { id: id(), type: 'rich-text', name: 'Opérateur' },
  ],
  views: [
    {
      id: id(), name: 'Kanban', mode: 'kanban',
      columns: [{ id: 'title', hide: false }, { id: STATUS_MFG[0].id, hide: false }],
      groupBy: { columnId: STATUS_MFG[0].id, name: 'select' },
      groupProperties: STATUS_MFG.map(o => ({ key: o.id, hide: false, manuallyCardSort: [] })).concat([{ key: 'Ungroups', hide: false, manuallyCardSort: [] }]),
    },
    {
      id: id(), name: 'Table', mode: 'table',
      columns: [
        { id: 'title', hide: false, width: 200 },
        { id: STATUS_MFG[0].id, hide: false, width: 180 },
      ],
    },
  ],
  rows: [
    { title: 'OF-2024-301', cells: { [STATUS_MFG[0].id]: STATUS_MFG[1].id } },
    { title: 'OF-2024-302', cells: { [STATUS_MFG[0].id]: STATUS_MFG[2].id } },
  ],
};

// ─── Agriculture / Élevage — Suivi Parcelles ──────────────────────────
const STATUS_AGRI: SelectOption[] = [
  { id: id(), value: 'Préparation', color: COL.white },
  { id: id(), value: 'Semé', color: COL.yellow },
  { id: id(), value: 'Croissance', color: COL.blue },
  { id: id(), value: 'Récolte', color: COL.green },
  { id: id(), value: 'Stocké', color: COL.purple },
];

const agricultureSchema: DatabaseSchema = {
  title: 'Agriculture — Suivi Parcelles',
  columns: [
    { id: 'title', type: 'rich-text', name: 'Parcelle' },
    { id: id(), type: 'select', name: 'Statut', data: { options: STATUS_AGRI } },
    { id: id(), type: 'rich-text', name: 'Culture' },
    { id: id(), type: 'rich-text', name: 'Surface (ha)' },
    { id: id(), type: 'rich-text', name: 'Rendement estimé' },
    { id: id(), type: 'rich-text', name: 'Date semis' },
  ],
  views: [
    {
      id: id(), name: 'Kanban', mode: 'kanban',
      columns: [{ id: 'title', hide: false }, { id: STATUS_AGRI[0].id, hide: false }],
      groupBy: { columnId: STATUS_AGRI[0].id, name: 'select' },
      groupProperties: STATUS_AGRI.map(o => ({ key: o.id, hide: false, manuallyCardSort: [] })).concat([{ key: 'Ungroups', hide: false, manuallyCardSort: [] }]),
    },
    {
      id: id(), name: 'Table', mode: 'table',
      columns: [
        { id: 'title', hide: false, width: 260 },
        { id: STATUS_AGRI[0].id, hide: false, width: 180 },
      ],
    },
  ],
  rows: [
    { title: 'Parcelle A — Blé', cells: { [STATUS_AGRI[0].id]: STATUS_AGRI[3].id } },
    { title: 'Parcelle B — Oliviers', cells: { [STATUS_AGRI[0].id]: STATUS_AGRI[2].id } },
  ],
};

// ─── map niche id → schema (20 total) ─────────────────────────────────
export const TRACKER_SCHEMAS: Record<string, DatabaseSchema> = {
  'digital-agency': digitalAgencySchema,
  'ecommerce': ecommerceSchema,
  'real-estate': realEstateSchema,
  'clinic': clinicSchema,
  'construction': constructionSchema,
  'restaurant': restaurantSchema,
  'freelancer': freelanceSchema,
  'startup': devSchema,        // SaaS / dev uses devSchema
  'it-services': devSchema,    // IT services also uses devSchema
  'law-office': legalSchema,
  'hr-recruiting': hrSchema,
  'finance': financeSchema,
  'marketing-team': marketingSchema,
  'events': eventSchema,
  'retail': inventorySchema,   // retail/boutique uses inventory
  'import-export': logisticsSchema,
  'education': educationSchema,
  'creative-studio': freelanceSchema,  // creative studio reuses freelance project tracking
  'ngo': crmSchema,            // NGOs use CRM for donor/partner tracking
  'personal': educationSchema, // personal reuse education for learning tracking
};

// ─── builder: creates a real affine:database block in a store ───────
export function buildDatabaseBlock(
  store: any,
  parentId: string,
  schema: DatabaseSchema
): string {
  // collect column ids
  const colIdMap: Record<string, string> = {};
  const columns = schema.columns.map(c => {
    const colId = c.id;
    colIdMap[c.name] = colId;
    return {
      type: c.type,
      name: c.name,
      data: c.data || {},
      id: colId,
    };
  });

  // build cells dict keyed by row block id
  const cells: Record<string, Record<string, any>> = {};

  // first add the database block itself (with empty cells, will update after rows)
  const dbBlockId = store.addBlock(
    'affine:database',
    {
      title: new Text(schema.title),
      views: schema.views.map(v => ({
        ...v,
        columns: v.columns.map(c => ({ ...c })),
        filter: { type: 'group', op: 'and', conditions: [] },
        header: { titleColumn: 'title', iconColumn: 'type' },
      })),
      columns,
      cells,
    },
    parentId
  );

  // add rows as children of the database block
  for (const row of schema.rows) {
    const rowId = store.addBlock(
      'affine:paragraph',
      {
        type: 'text',
        text: new Text(row.title),
      },
      dbBlockId
    );
    cells[rowId] = {};
    for (const [cellName, value] of Object.entries(row.cells)) {
      const colId = columns.find(c => c.id === cellName)?.id;
      if (colId) {
        cells[rowId][colId] = {
          columnId: colId,
          value,
        };
      }
    }
  }

  // update the database block with the populated cells
  const dbModel = store.getBlock(dbBlockId);
  if (dbModel) {
    store.updateBlock(dbModel, { cells });
  }

  return dbBlockId;
}
