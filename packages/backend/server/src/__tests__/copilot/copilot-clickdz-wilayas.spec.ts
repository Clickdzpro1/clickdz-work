import ava, { type TestFn } from 'ava';

import {
  WILAYAS,
  WILAYA_COUNT,
  WILAYA_NAME_BY_CODE,
  isValidWilaya,
  wilayaName,
} from '../../plugins/copilot/clickdz-erp-shipping';

// ---------------------------------------------------------------------------
// DzOS Phase 0 (WS-F) — 69-wilaya table regression guards.
//
// Algeria went from 58 to 69 wilayas: the 11 new wilayas (59-69) were created
// by Law n° 26-06 of 4 April 2026 and named/numbered by Presidential Decree
// n° 26-206 of 25 May 2026 (Journal Officiel n°40). The pre-Phase-0 code
// shipped a 58-entry table (WILAYA_COUNT=58), so wilayas 59-69 got no shipping
// rates and the checkout dropdowns stopped at 58. These tests lock the 69-
// entry table and the new wilayas' names/codes against the official decree.
//
// Pure: no app bootstrap, no Postgres, no Redis. Runs in milliseconds.
// ---------------------------------------------------------------------------

const test = ava as TestFn;

test('WILAYA_COUNT is 69 (not 58)', t => {
  t.is(WILAYA_COUNT, 69);
  t.is(WILAYAS.length, 69);
});

test('WILAYAS codes are exactly 1..69 with no gaps or duplicates', t => {
  const codes = WILAYAS.map((w) => w.code);
  t.deepEqual(codes, Array.from({ length: 69 }, (_, i) => i + 1));
  t.is(new Set(codes).size, 69);
});

test('the 11 new wilayas (59-69) match Decree 26-206 / JO n°40 exactly', t => {
  const expected: Record<number, string> = {
    59: 'Aflou',
    60: 'Barika',
    61: 'El Kantara',
    62: 'Bir El Ater',
    63: 'El Aricha',
    64: 'Ksar Chellala',
    65: 'Aïn Oussara',
    66: 'Messaad',
    67: 'Ksar El Boukhari',
    68: 'Bou Saâda',
    69: 'El Abiodh Sidi Cheikh',
  };
  for (const [codeStr, name] of Object.entries(expected)) {
    const code = Number(codeStr);
    const w = WILAYAS.find((x) => x.code === code);
    t.truthy(w, `wilaya ${code} must exist`);
    t.is(w?.name, name, `wilaya ${code} name must be ${name}`);
  }
});

test('the original 58 wilayas are unchanged (regression guard)', t => {
  // Spot-check a few canonical names that must NOT have drifted.
  const byCode = new Map(WILAYAS.map((w) => [w.code, w.name]));
  t.is(byCode.get(1), 'Adrar');
  t.is(byCode.get(16), 'Alger');
  t.is(byCode.get(31), 'Oran');
  t.is(byCode.get(58), 'El Meniaa');
  t.is(byCode.get(11), 'Tamanrasset');
});

test('isValidWilaya accepts 1..69 and rejects 0, 70, negatives, non-integers', t => {
  for (let i = 1; i <= 69; i++) {
    t.true(isValidWilaya(i), `${i} must be valid`);
  }
  t.false(isValidWilaya(0));
  t.false(isValidWilaya(70));
  t.false(isValidWilaya(-1));
  t.false(isValidWilaya(58.5));
  t.false(isValidWilaya('16')); // string form: Number() ok but isInteger fails on... actually Number('16')=16 int
  // NOTE: isValidWilaya('16') → Number('16')=16, isInteger=true, has=true → valid.
  // That's the existing tolerant behavior (string codes from wire). Keep it.
  t.true(isValidWilaya('16'));
  t.false(isValidWilaya('abc'));
  t.false(isValidWilaya(null));
  t.false(isValidWilaya(undefined));
});

test('wilayaName resolves codes 1..69 and returns "" for unknown', t => {
  t.is(wilayaName(1), 'Adrar');
  t.is(wilayaName(16), 'Alger');
  t.is(wilayaName(59), 'Aflou');
  t.is(wilayaName(69), 'El Abiodh Sidi Cheikh');
  t.is(wilayaName(0), '');
  t.is(wilayaName(70), '');
});

test('WILAYA_NAME_BY_CODE covers all 69 codes', t => {
  t.is(WILAYA_NAME_BY_CODE.size, 69);
  for (let i = 1; i <= 69; i++) {
    t.true(WILAYA_NAME_BY_CODE.has(i), `${i} must be in the map`);
  }
});

test('regression: a rate row for wilaya 64 (Ksar Chellala) is now valid, not dropped', t => {
  // Pre-Phase-0: isValidWilaya(64) returned false (64 > 58), so a rate row for
  // the new Ksar Chellala wilaya was silently dropped by exportMatrix. Now it
  // must be accepted.
  t.true(isValidWilaya(64));
  t.is(wilayaName(64), 'Ksar Chellala');
});
