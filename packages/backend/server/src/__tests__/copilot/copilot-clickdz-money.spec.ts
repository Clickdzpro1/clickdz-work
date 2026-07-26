import ava, { type TestFn } from 'ava';

import {
  buildPendingCodEntry,
  type CaisseRecord,
  caisseCollectionForDate,
  hasPendingCodMarker,
  pendingCodMarkerPartitions,
} from '../../plugins/copilot/clickdz-erp-caisse';
import { buildTrackingPatch } from '../../plugins/copilot/clickdz-erp-shipping';

// ---------------------------------------------------------------------------
// MONEY-3 regression guards.
//
// These are the first tests to cover any clickdz-* module. They are deliberately
// PURE: they exercise the date/partition derivation and the tracking patch
// builder directly, with no app bootstrap, no Postgres and no Redis, so they run
// in milliseconds and cannot flake. The defects they lock down were all live in
// production and none had any coverage.
//
// The underlying bug: caisse entries are partitioned BY MONTH, but a delivered
// COD order was dated by when it was PLACED (caisseParseDate resolves
// date || orderedAt || createdAt, and the status handler always backfills
// orderedAt). With Algerian COD delivery lags of 2-7 days, every order near a
// month boundary was filed into the wrong month: the delivery month never saw
// the COD it was owed, and the placement month changed retroactively after it
// may already have been closed.
// ---------------------------------------------------------------------------

const test = ava as TestFn;

/** An order placed 28 June and delivered 3 July — the boundary case. */
const straddlingOrder = (): CaisseRecord => ({
  ref: 'CMD-1001',
  total: 4500,
  status: 'Livrée',
  orderedAt: '2026-06-28T10:00:00.000Z',
  createdAt: '2026-06-28T10:00:00.000Z',
  deliveredAt: '2026-07-03T09:30:00.000Z',
  courierId: 'yalidine',
});

test('pending-COD marker is filed in the DELIVERY month, not the placement month', t => {
  const built = buildPendingCodEntry(straddlingOrder());
  t.truthy(built);
  // Placement is 2026-06, delivery is 2026-07. The marker must follow delivery.
  t.is(built!.collection, 'caisse-202607');
  t.is(built!.entry.date, '2026-07-03');
  t.is(built!.entry.amount, 4500);
  t.is(built!.entry.pending, true);
  t.is(built!.entry.method, 'cod');
  t.is(built!.entry.kind, 'in');
});

test('an order with no deliveredAt keeps the old placement-date behaviour', t => {
  // Orders written before deliveredAt existed must not silently jump partitions.
  const legacy = straddlingOrder();
  delete legacy.deliveredAt;
  const built = buildPendingCodEntry(legacy);
  t.truthy(built);
  t.is(built!.collection, 'caisse-202606');
  t.is(built!.entry.date, '2026-06-28');
});

test('same-month delivery yields exactly one partition to dedupe against', t => {
  const sameMonth = straddlingOrder();
  sameMonth.orderedAt = '2026-07-01T10:00:00.000Z';
  sameMonth.createdAt = '2026-07-01T10:00:00.000Z';
  // The common case must not cost an extra read.
  t.deepEqual(pendingCodMarkerPartitions(sameMonth), ['caisse-202607']);
});

test('a boundary-straddling order dedupes against BOTH months', t => {
  // This is what stops a second marker being written when a courier poll already
  // filed one under the placement month. Delivery month comes first because it is
  // where the new marker would go.
  t.deepEqual(pendingCodMarkerPartitions(straddlingOrder()), [
    'caisse-202607',
    'caisse-202606',
  ]);
});

test('an order with no dates at all still yields a usable partition', t => {
  const bare: CaisseRecord = { ref: 'CMD-BARE', total: 100 };
  const parts = pendingCodMarkerPartitions(bare);
  t.is(parts.length, 1);
  t.regex(parts[0], /^caisse-\d{6}$/);
});

test('hasPendingCodMarker matches only a real pending COD marker for that ref', t => {
  const marker: CaisseRecord = {
    pending: true,
    kind: 'in',
    method: 'cod',
    orderRef: 'CMD-1001',
  };
  t.true(hasPendingCodMarker([marker], 'CMD-1001'));
  // A different ref, a settled (non-pending) row, a cash row, and an outgoing
  // row must all fail to match — otherwise the idempotency guard would suppress
  // a marker that was never written.
  t.false(hasPendingCodMarker([marker], 'CMD-9999'));
  t.false(hasPendingCodMarker([{ ...marker, pending: false }], 'CMD-1001'));
  t.false(hasPendingCodMarker([{ ...marker, method: 'cash' }], 'CMD-1001'));
  t.false(hasPendingCodMarker([{ ...marker, kind: 'out' }], 'CMD-1001'));
  t.false(hasPendingCodMarker([], 'CMD-1001'));
});

test('a zero-total order produces no marker at all', t => {
  const free = straddlingOrder();
  free.total = 0;
  t.is(buildPendingCodEntry(free), null);
});

test('buildTrackingPatch stamps deliveredAt on delivery and only on delivery', t => {
  const now = '2026-07-03T09:30:00.000Z';

  // 'livre' is the courier tracking state that maps to the canonical 'Livrée'.
  // This single builder serves the courier poll AND the manual tracking route,
  // which is why the stamp lives here rather than only in the studio's route —
  // stamping in one place only would have left courier deliveries (the dominant
  // COD path) filing by placement date while studio clicks filed by delivery,
  // i.e. two paths disagreeing about which month a COD belongs to.
  const delivered = buildTrackingPatch('livre', now);
  t.true(delivered.ok);
  if (delivered.ok) {
    t.is(delivered.orderStatus, 'Livrée');
    t.is(delivered.patch.deliveredAt, now);
  }

  // Any non-delivery transition must NOT stamp it.
  for (const state of ['pris-en-charge', 'en-route', 'retour']) {
    const patch = buildTrackingPatch(state, now);
    t.true(patch.ok, `${state} should be a valid tracking state`);
    if (patch.ok) {
      t.is(
        patch.patch.deliveredAt,
        undefined,
        `${state} must not stamp deliveredAt`
      );
    }
  }

  // Garbage in stays rejected — the stamp must not have widened what is accepted.
  t.false(buildTrackingPatch('not-a-state', now).ok);
});

test('caisseCollectionForDate maps a date to its month partition', t => {
  t.is(caisseCollectionForDate('2026-07-03'), 'caisse-202607');
  t.is(caisseCollectionForDate('2026-06-28'), 'caisse-202606');
  t.is(caisseCollectionForDate('2026-01-01'), 'caisse-202601');
  t.is(caisseCollectionForDate('2026-12-31'), 'caisse-202612');
  // Malformed input must fall back to the current month, never throw.
  t.regex(caisseCollectionForDate('garbage'), /^caisse-\d{6}$/);
  t.regex(caisseCollectionForDate(''), /^caisse-\d{6}$/);
});
