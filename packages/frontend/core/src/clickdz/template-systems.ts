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

// ─── map niche id → schema ────────────────────────────────────────────
export const TRACKER_SCHEMAS: Record<string, DatabaseSchema> = {
  'digital-agency': digitalAgencySchema,
  'ecommerce': ecommerceSchema,
  'real-estate': realEstateSchema,
  'clinic': clinicSchema,
  'construction': constructionSchema,
  // remaining 15 niches fall back to markdown-only for now
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
