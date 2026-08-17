import ava, { type TestFn } from 'ava';

// These tests cover the pure, framework-free core of dzos-store:
//   • ulid — monotonicity + uniqueness + sortability
//   • ErpRepo.applyPulledChange — the LWW merge rule (the heart of the sync engine)
//   • ErpRepo.upsert/remove — the outbox-append contract
//
// They use an in-memory DzosStorage stub (no IDB, no SQLite, no Electron) so they
// run in milliseconds with zero external deps. The repo + ulid + types are
// framework-free by design (storage.ts's DzosStorage is an interface; repo.ts
// takes any DzosStorage). The IDB + SQLite adapters are NOT exercised here —
// their contract is the same interface, validated separately by the app.
//
// The dzos-store module lives in the frontend core, so these tests import across
// packages. The repo's ava config + tsconfig resolve @affine/core/* in CI; in an
// isolated install they run via the esbuild-bundle + ava-shim runner (the same
// pattern as the Phase 0 timbre/collections/wilayas tests — see
// /agent/workspace/runtest/), which bundles the cross-package imports.

import { ErpRepo } from '@affine/core/modules/dzos-store/repo';
import { ulid } from '@affine/core/modules/dzos-store/ulid';
import type { DzosStorage } from '@affine/core/modules/dzos-store/storage';
import type {
  ErpOutboxOp,
  ErpRecordWrapper,
  ErpSyncMeta,
} from '@affine/core/modules/dzos-store/types';

const test = ava as TestFn;

// ---------------------------------------------------------------------------
// In-memory DzosStorage stub — implements the contract with Maps. No I/O, no
// async delays. Used by every repo test below.
// ---------------------------------------------------------------------------

class MemoryStorage implements DzosStorage {
  records = new Map<string, ErpRecordWrapper>();
  outbox: ErpOutboxOp[] = [];
  meta: ErpSyncMeta | null = null;

  private rkey(c: string, id: string) {
    return `${c}\u0000${id}`;
  }

  async getRecord(collection: string, id: string): Promise<ErpRecordWrapper | null> {
    return this.records.get(this.rkey(collection, id)) ?? null;
  }
  async listRecords(collection: string): Promise<ErpRecordWrapper[]> {
    return [...this.records.values()]
      .filter((r) => r.collection === collection && !r.deleted)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  async putRecord(wrapper: ErpRecordWrapper): Promise<void> {
    this.records.set(this.rkey(wrapper.collection, wrapper.id), wrapper);
  }
  async tombstoneRecord(
    collection: string,
    id: string,
    rev: number,
    updatedAt: string
  ): Promise<void> {
    const existing = this.records.get(this.rkey(collection, id));
    this.records.set(this.rkey(collection, id), {
      collection,
      id,
      data: existing?.data ?? {},
      rev,
      updatedAt,
      createdAt: existing?.createdAt ?? updatedAt,
      pending: false,
      deleted: true,
    });
  }
  async purgeRecord(collection: string, id: string): Promise<void> {
    this.records.delete(this.rkey(collection, id));
  }
  async appendOutbox(op: ErpOutboxOp): Promise<void> {
    this.outbox.push(op);
  }
  async listOutbox(): Promise<ErpOutboxOp[]> {
    return [...this.outbox].sort((a, b) => a.ts.localeCompare(b.ts));
  }
  async removeOutbox(opId: string): Promise<void> {
    this.outbox = this.outbox.filter((o) => o.opId !== opId);
  }
  async updateOutbox(opId: string, attempts: number, lastError?: string): Promise<void> {
    const op = this.outbox.find((o) => o.opId === opId);
    if (op) {
      op.attempts = attempts;
      op.lastError = lastError;
    }
  }
  async getMeta(slug: string): Promise<ErpSyncMeta | null> {
    return this.meta;
  }
  async putMeta(meta: ErpSyncMeta): Promise<void> {
    this.meta = meta;
  }
  close(): void {}
}

/** Build a repo backed by a fresh MemoryStorage. */
function freshRepo(slug = 'test-shop'): { repo: ErpRepo; storage: MemoryStorage } {
  const storage = new MemoryStorage();
  const repo = new ErpRepo(slug, storage);
  return { repo, storage };
}

// ===========================================================================
// ulid
// ===========================================================================

test('ulid: generates 26-char Crockford-base32 strings', t => {
  const id = ulid();
  t.is(id.length, 26);
  // Crockford alphabet (no I/L/O/U)
  t.true(/^[0-9A-HJKMNP-TV-Z]{26}$/.test(id), `${id} must be Crockford base32`);
});

test('ulid: 10,000 generated ids are unique', t => {
  const seen = new Set<string>();
  for (let i = 0; i < 10_000; i++) {
    const id = ulid();
    t.false(seen.has(id), `duplicate ulid: ${id}`);
    seen.add(id);
  }
  t.is(seen.size, 10_000);
});

test('ulid: ids generated in sequence are monotonically increasing (sortable)', t => {
  const ids: string[] = [];
  for (let i = 0; i < 1000; i++) ids.push(ulid());
  const sorted = [...ids].sort();
  // A sequence generated in the same ms (or across ms) must already be sorted:
  // ULID's time prefix + in-place random increment guarantees this.
  t.deepEqual(ids, sorted);
});

test('ulid: ids generated across a delay stay sortable (time prefix advances)', async t => {
  const a = ulid();
  await new Promise((r) => setTimeout(r, 5));
  const b = ulid();
  t.true(a < b, `${a} must sort before ${b}`);
});

// ===========================================================================
// ErpRepo.upsert — the outbox-append contract
// ===========================================================================

test('upsert: writes the record + appends an outbox op + marks pending', async t => {
  const { repo, storage } = freshRepo();
  const w = await repo.upsert('orders', 'ord-1', { ref: 'CMD-001', total: 4500 });
  t.is(w.id, 'ord-1');
  t.is(w.rev, 1);
  t.true(w.pending);
  t.false(w.deleted);
  // The record is in storage.
  const stored = await storage.getRecord('orders', 'ord-1');
  t.truthy(stored);
  t.is(stored!.data.ref, 'CMD-001');
  // An outbox op was appended.
  t.is(storage.outbox.length, 1);
  t.is(storage.outbox[0].op, 'upsert');
  t.is(storage.outbox[0].recordId, 'ord-1');
  t.is(storage.outbox[0].baseRev, 0);
});

test('upsert: a second upsert of the same id bumps rev + appends a new op', async t => {
  const { repo, storage } = freshRepo();
  await repo.upsert('orders', 'ord-1', { status: 'Nouvelle' });
  await repo.upsert('orders', 'ord-1', { status: 'Confirmée' });
  const stored = await storage.getRecord('orders', 'ord-1');
  t.is(stored!.rev, 2);
  t.is(stored!.data.status, 'Confirmée');
  t.is(storage.outbox.length, 2);
  // The second op's baseRev is the rev BEFORE the second write (1).
  t.is(storage.outbox[1].baseRev, 1);
});

test('upsert: collectionOverride writes to the partition, not the base', async t => {
  const { repo, storage } = freshRepo();
  await repo.upsert('caisse', 'c-1', { amount: 1000 }, { collectionOverride: 'caisse-202608' });
  const stored = await storage.getRecord('caisse-202608', 'c-1');
  t.truthy(stored);
  t.is(stored!.data.amount, 1000);
  // The base 'caisse' collection is empty.
  const baseList = await storage.listRecords('caisse');
  t.is(baseList.length, 0);
});

test('remove: tombstones the record + appends a remove op', async t => {
  const { repo, storage } = freshRepo();
  await repo.upsert('orders', 'ord-1', { status: 'Nouvelle' });
  await repo.remove('orders', 'ord-1');
  const stored = await storage.getRecord('orders', 'ord-1');
  t.true(stored!.deleted);
  t.is(stored!.rev, 2); // remove bumps rev
  // remove op appended (in addition to the upsert op).
  t.is(storage.outbox.length, 2);
  t.is(storage.outbox[1].op, 'remove');
});

test('remove: idempotent on a missing record (no op, no tombstone)', async t => {
  const { repo, storage } = freshRepo();
  await repo.remove('orders', 'never-existed');
  t.is(storage.outbox.length, 0);
  const stored = await storage.getRecord('orders', 'never-existed');
  t.is(stored, null);
});

// ===========================================================================
// ErpRepo.applyPulledChange — the LWW merge rule (the heart of the sync engine)
// ===========================================================================

test('applyPulledChange: server upsert with higher rev overwrites a non-pending local', async t => {
  const { repo, storage } = freshRepo();
  // Seed a local record at rev 1, NOT pending (e.g. an earlier pull).
  await storage.putRecord({
    collection: 'orders', id: 'ord-1', data: { status: 'Nouvelle' },
    rev: 1, updatedAt: '2026-08-17T10:00:00Z', createdAt: '2026-08-17T10:00:00Z',
    pending: false, deleted: false,
  });
  const applied = await repo.applyPulledChange({
    kind: 'upsert', collection: 'orders', id: 'ord-1',
    data: { status: 'Confirmée' }, rev: 2, updatedAt: '2026-08-17T11:00:00Z',
    createdAt: '2026-08-17T10:00:00Z',
  });
  t.true(applied);
  const stored = await storage.getRecord('orders', 'ord-1');
  t.is(stored!.rev, 2);
  t.is(stored!.data.status, 'Confirmée');
  t.false(stored!.pending);
});

test('applyPulledChange: server upsert with LOWER rev is ignored (local is newer)', async t => {
  const { repo, storage } = freshRepo();
  await storage.putRecord({
    collection: 'orders', id: 'ord-1', data: { status: 'Confirmée' },
    rev: 3, updatedAt: '2026-08-17T12:00:00Z', createdAt: '2026-08-17T10:00:00Z',
    pending: false, deleted: false,
  });
  const applied = await repo.applyPulledChange({
    kind: 'upsert', collection: 'orders', id: 'ord-1',
    data: { status: 'Nouvelle' }, rev: 2, updatedAt: '2026-08-17T11:00:00Z',
    createdAt: '2026-08-17T10:00:00Z',
  });
  t.false(applied);
  const stored = await storage.getRecord('orders', 'ord-1');
  t.is(stored!.rev, 3);
  t.is(stored!.data.status, 'Confirmée'); // unchanged
});

test('applyPulledChange: a PENDING local record is NOT overwritten by an older server rev', async t => {
  // The key offline-first invariant: an unpushed local edit (pending) must not
  // be clobbered by a stale server change. The sync engine resolves the conflict
  // after the outbox push settles.
  const { repo, storage } = freshRepo();
  await storage.putRecord({
    collection: 'orders', id: 'ord-1', data: { status: 'Confirmée (local edit)' },
    rev: 5, updatedAt: '2026-08-17T12:00:00Z', createdAt: '2026-08-17T10:00:00Z',
    pending: true, deleted: false,
  });
  const applied = await repo.applyPulledChange({
    kind: 'upsert', collection: 'orders', id: 'ord-1',
    data: { status: 'Nouvelle' }, rev: 4, updatedAt: '2026-08-17T11:00:00Z',
    createdAt: '2026-08-17T10:00:00Z',
  });
  t.false(applied);
  const stored = await storage.getRecord('orders', 'ord-1');
  t.is(stored!.data.status, 'Confirmée (local edit)'); // local edit preserved
  t.true(stored!.pending);
});

test('applyPulledChange: equal rev, newer server updatedAt → server wins', async t => {
  const { repo, storage } = freshRepo();
  await storage.putRecord({
    collection: 'orders', id: 'ord-1', data: { status: 'Local' },
    rev: 2, updatedAt: '2026-08-17T10:00:00Z', createdAt: '2026-08-17T09:00:00Z',
    pending: false, deleted: false,
  });
  const applied = await repo.applyPulledChange({
    kind: 'upsert', collection: 'orders', id: 'ord-1',
    data: { status: 'Server' }, rev: 2, updatedAt: '2026-08-17T11:00:00Z',
    createdAt: '2026-08-17T09:00:00Z',
  });
  t.true(applied);
  const stored = await storage.getRecord('orders', 'ord-1');
  t.is(stored!.data.status, 'Server');
});

test('applyPulledChange: equal rev + equal/older updatedAt → ignored (local wins ties)', async t => {
  const { repo, storage } = freshRepo();
  await storage.putRecord({
    collection: 'orders', id: 'ord-1', data: { status: 'Local' },
    rev: 2, updatedAt: '2026-08-17T11:00:00Z', createdAt: '2026-08-17T09:00:00Z',
    pending: false, deleted: false,
  });
  const applied = await repo.applyPulledChange({
    kind: 'upsert', collection: 'orders', id: 'ord-1',
    data: { status: 'Server' }, rev: 2, updatedAt: '2026-08-17T11:00:00Z',
    createdAt: '2026-08-17T09:00:00Z',
  });
  t.false(applied);
  const stored = await storage.getRecord('orders', 'ord-1');
  t.is(stored!.data.status, 'Local');
});

test('applyPulledChange: a tombstone with higher rev marks the record deleted', async t => {
  const { repo, storage } = freshRepo();
  await storage.putRecord({
    collection: 'orders', id: 'ord-1', data: { status: 'Nouvelle' },
    rev: 1, updatedAt: '2026-08-17T10:00:00Z', createdAt: '2026-08-17T10:00:00Z',
    pending: false, deleted: false,
  });
  const applied = await repo.applyPulledChange({
    kind: 'tombstone', collection: 'orders', id: 'ord-1',
    rev: 2, updatedAt: '2026-08-17T11:00:00Z',
  });
  t.true(applied);
  const stored = await storage.getRecord('orders', 'ord-1');
  t.true(stored!.deleted);
  t.is(stored!.rev, 2);
  // listRecords excludes deleted → the collection is now empty.
  const list = await storage.listRecords('orders');
  t.is(list.length, 0);
});

test('applyPulledChange: a tombstone with LOWER rev than a non-pending local is ignored', async t => {
  const { repo, storage } = freshRepo();
  await storage.putRecord({
    collection: 'orders', id: 'ord-1', data: { status: 'Confirmée' },
    rev: 3, updatedAt: '2026-08-17T12:00:00Z', createdAt: '2026-08-17T10:00:00Z',
    pending: false, deleted: false,
  });
  const applied = await repo.applyPulledChange({
    kind: 'tombstone', collection: 'orders', id: 'ord-1',
    rev: 2, updatedAt: '2026-08-17T11:00:00Z',
  });
  t.false(applied);
  const stored = await storage.getRecord('orders', 'ord-1');
  t.false(stored!.deleted);
  t.is(stored!.data.status, 'Confirmée');
});

test('applyPulledChange: a tombstone for a non-existent record creates the tombstone', async t => {
  const { repo, storage } = freshRepo();
  const applied = await repo.applyPulledChange({
    kind: 'tombstone', collection: 'orders', id: 'gone-1',
    rev: 1, updatedAt: '2026-08-17T11:00:00Z',
  });
  t.true(applied);
  const stored = await storage.getRecord('orders', 'gone-1');
  t.true(stored!.deleted);
});

// ===========================================================================
// ErpRepo.list + subscribe — the live-query contract
// ===========================================================================

test('list: returns non-deleted records newest-first, excludes tombstones', async t => {
  const { repo, storage } = freshRepo();
  await storage.putRecord({
    collection: 'orders', id: 'old', data: { n: 1 },
    rev: 1, updatedAt: '2026-08-17T09:00:00Z', createdAt: '2026-08-17T09:00:00Z',
    pending: false, deleted: false,
  });
  await storage.putRecord({
    collection: 'orders', id: 'new', data: { n: 2 },
    rev: 1, updatedAt: '2026-08-17T11:00:00Z', createdAt: '2026-08-17T11:00:00Z',
    pending: false, deleted: false,
  });
  await storage.putRecord({
    collection: 'orders', id: 'dead', data: { n: 3 },
    rev: 1, updatedAt: '2026-08-17T10:00:00Z', createdAt: '2026-08-17T10:00:00Z',
    pending: false, deleted: true,
  });
  const list = await repo.list('orders');
  t.is(list.length, 2);
  t.is(list[0].id, 'new'); // newest first
  t.is(list[1].id, 'old');
});

test('subscribe: fires immediately with the cached list, then on mutation', async t => {
  const { repo, storage } = freshRepo();
  await storage.putRecord({
    collection: 'orders', id: 'ord-1', data: { s: 'Nouvelle' },
    rev: 1, updatedAt: '2026-08-17T10:00:00Z', createdAt: '2026-08-17T10:00:00Z',
    pending: false, deleted: false,
  });
  // Hydrate the cache (list first so subscribe has a cached value to fire).
  await repo.list('orders');
  const seen: ErpRecordWrapper[][] = [];
  const unsub = repo.subscribe('orders', (rows) => seen.push(rows));
  // Immediate fire with the cached list.
  t.is(seen.length, 1);
  t.is(seen[0].length, 1);
  t.is(seen[0][0].id, 'ord-1');
  // A mutation re-fires (async — repo.invalidate re-reads storage).
  await repo.upsert('orders', 'ord-2', { s: 'Confirmée' });
  // Allow the invalidate microtask to settle.
  await new Promise((r) => setTimeout(r, 5));
  t.true(seen.length >= 2);
  const last = seen[seen.length - 1];
  t.true(last.some((r) => r.id === 'ord-2'));
  unsub();
});

// ===========================================================================
// Regression: the offline-first invariant (the whole point of Phase 1)
// ===========================================================================

test('regression: an offline write (pending) survives a stale server pull', async t => {
  // The scenario: merchant edits an order offline (pending, rev bumped), then
  // reconnects and the sync engine pulls a stale server change (older rev). The
  // local edit MUST survive until the outbox push settles the conflict.
  const { repo, storage } = freshRepo();
  // Offline edit.
  await repo.upsert('orders', 'ord-1', { status: 'Livrée (offline edit)' });
  const local = await storage.getRecord('orders', 'ord-1');
  t.true(local!.pending);
  t.is(local!.rev, 1);
  // Stale server pull (rev 0 from a pre-edit snapshot).
  const applied = await repo.applyPulledChange({
    kind: 'upsert', collection: 'orders', id: 'ord-1',
    data: { status: 'Nouvelle' }, rev: 0, updatedAt: '2026-08-17T08:00:00Z',
    createdAt: '2026-08-17T08:00:00Z',
  });
  t.false(applied); // held — the pending local edit is newer
  const after = await storage.getRecord('orders', 'ord-1');
  t.is(after!.data.status, 'Livrée (offline edit)');
  t.true(after!.pending);
  // The outbox op is still there (the sync engine will push it).
  t.is(storage.outbox.length, 1);
});
