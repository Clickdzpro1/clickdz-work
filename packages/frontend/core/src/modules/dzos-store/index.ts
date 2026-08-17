/**
 * DzOS ERP local-first store — barrel export.
 *
 * The single import surface for DzOS ERP panels:
 *   import { getErpRepo, useErpQuery, useErpMutation, SyncStatusPill } from
 *     '@affine/core/modules/dzos-store';
 *
 * The module is additive (new files under packages/frontend/core/src/modules/
 * dzos-store/); no existing file is touched by the scaffold. Pages opt in one
 * at a time (caisse first) — the rest keep using shoperp-shared's fetch
 * helpers until migrated.
 */

export { ErpRepo, getErpRepo, getErpRepoSync, dropErpRepo } from './repo';
export type { MutateOptions } from './repo';
export { DzosIdbStorage, openDzosIdb } from './storage';
export { DzosSqliteStorage } from './sqlite-storage';
export type { DzosStorage } from './storage';
export { useErpQuery, useErpMutation, useErpPendingCount } from './hooks';
export { SyncEngine, getSyncEngine, dropSyncEngine } from './sync';
export type { ErpConflict } from './sync';
export { SyncStatusPill } from './pill';
export { ulid } from './ulid';
export type {
  ErpCollection,
  ErpOp,
  ErpOutboxOp,
  ErpRecordWrapper,
  ErpChange,
  ErpChangesResponse,
  ErpSyncBatchResponse,
  ErpSyncResult,
  ErpSyncMeta,
  SyncStatus,
} from './types';
