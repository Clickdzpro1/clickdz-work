import ava, { type TestFn } from 'ava';

import {
  isResetSafeKey,
  resetRunKeys,
  resetSingletonKeys,
  resetThreadKey,
} from '../../plugins/copilot/clickdz-agent-reset-keys';

// ---------------------------------------------------------------------------
// Agent-reset blast-radius guards.
//
// POST /api/v1/agents/:agent/reset wipes one user's Hermes or OpenClaw state.
// The agents and the LIVE SHOP share one Redis database and one `clickdz:`
// prefix, so a key set that is one segment too broad does not fail loudly — it
// deletes a merchant's orders.
//
// The route is index-driven precisely BECAUSE the obvious glob is wrong: threads
// and runs are keyed per-USER with the agent stored inside the record
// (`clickdz:agent:<userId>:<threadId>`, `clickdz:agentrun:<userId>:<runId>`), so
// `clickdz:agent:<userId>:*` would sweep up the other agent's threads and
// resetting Hermes would silently destroy OpenClaw. These tests pin that
// property on the key BUILDERS, which are pure — no Redis, no bootstrap, no
// flake.
//
// They exist because reviewing a Redis glob by eye is exactly the kind of check
// a human does correctly nine times out of ten.
// ---------------------------------------------------------------------------

const test = ava as TestFn;

const USER = 'u_abc123';
const OTHER = 'u_zzz999';

/** Every key the route would remove for one agent, given some ids. */
function allKeys(
  userId: string,
  agent: 'hermes' | 'openclaw',
  threadIds: string[],
  runIds: string[]
): string[] {
  return [
    ...threadIds.map(id => resetThreadKey(userId, id)),
    ...runIds.flatMap(id => resetRunKeys(userId, id)),
    ...resetSingletonKeys(userId, agent),
  ];
}

/** Keys that MUST survive a reset — the merchant's actual business. */
const MUST_SURVIVE = [
  // The live shop: orders, products, customers, settings.
  'clickdz:appdata:fatehshop:orders',
  'clickdz:appdata:fatehshop:products',
  'clickdz:appdata:fatehshop:customers',
  'clickdz:appdata:fatehshop:settings',
  'clickdz:appdata:boutique-amina:orders',
  // The published-app registry.
  `clickdz:apps:published:${USER}`,
  // Integration flows.
  'clickdz:flow:abc',
  'clickdz:flows:index',
  // Payment + audit state.
  'clickdz:pay:chargily:fatehshop',
  'clickdz:erp:audit:fatehshop',
  // Channel records: they hold sealed tokens needed to retract external
  // webhooks, so the reset route leaves them to the disconnect routes.
  `clickdz:agentchan:${USER}:hermes:telegram`,
  `clickdz:agentchan:${USER}:hermes:whatsapp`,
  // The GLOBAL cross-user due zset: pruned member-by-member, never deleted.
  'clickdz:agenttrigs:due',
  // Per-user-but-cross-agent accounting: resetting one agent must not clear the
  // other agent's spend, the shared daily cap, or the shared artifact shelf.
  `clickdz:agentspend:${USER}:202607`,
  `clickdz:agentruns:count:${USER}:20260726`,
  `clickdz:agentart:${USER}`,
];

test('reset touches no shop, registry, flow, channel or shared-accounting key', t => {
  for (const agent of ['hermes', 'openclaw'] as const) {
    const keys = new Set(
      allKeys(USER, agent, ['thread-1', 'thread-2'], ['run-1', 'run-2'])
    );
    for (const survivor of MUST_SURVIVE) {
      t.false(keys.has(survivor), `${agent} reset must NOT remove ${survivor}`);
    }
  }
});

test('reset touches no other user’s key', t => {
  const keys = new Set(allKeys(USER, 'hermes', ['t1'], ['r1']));
  for (const key of [
    resetThreadKey(OTHER, 't1'),
    ...resetRunKeys(OTHER, 'r1'),
    ...resetSingletonKeys(OTHER, 'hermes'),
  ]) {
    t.false(keys.has(key), `must NOT remove ${key}`);
  }
});

test('reset does remove the caller’s own threads, runs and singletons', t => {
  const keys = new Set(allKeys(USER, 'hermes', ['t1'], ['r1']));
  t.true(keys.has(`clickdz:agent:${USER}:t1`));
  t.true(keys.has(`clickdz:agentrun:${USER}:r1`));
  t.true(keys.has(`clickdz:agentrun:${USER}:r1:events`));
  t.true(keys.has(`clickdz:agent:index:${USER}:hermes`));
  t.true(keys.has(`clickdz:agent:config:${USER}:hermes`));
  t.true(keys.has(`clickdz:agentruns:${USER}:hermes`));
  t.true(keys.has(`clickdz:agentmem:${USER}:hermes`));
  t.true(keys.has(`clickdz:agentstate:${USER}:hermes`));
});

test('resetting hermes leaves every openclaw singleton alone', t => {
  const keys = new Set(allKeys(USER, 'hermes', [], []));
  for (const key of resetSingletonKeys(USER, 'openclaw')) {
    t.false(keys.has(key), `hermes reset must NOT remove ${key}`);
  }
});

test('a hermes thread id and an openclaw thread id produce different keys', t => {
  // The property that makes the index-driven approach necessary: the key itself
  // carries no agent segment, so the ONLY thing separating the two agents'
  // threads is which index the id came from.
  const hermesThread = resetThreadKey(USER, 'thread-from-hermes');
  const openclawThread = resetThreadKey(USER, 'thread-from-openclaw');
  t.not(hermesThread, openclawThread);
  // Both live in the same namespace — which is exactly why a glob is unsafe.
  t.true(hermesThread.startsWith(`clickdz:agent:${USER}:`));
  t.true(openclawThread.startsWith(`clickdz:agent:${USER}:`));
});

test('every key is anchored on clickdz:agent and the owner id', t => {
  // This is the invariant the route's own defence-in-depth filter relies on: a
  // key failing it is dropped rather than deleted.
  for (const agent of ['hermes', 'openclaw'] as const) {
    for (const key of allKeys(USER, agent, ['t1'], ['r1'])) {
      t.true(
        key.startsWith('clickdz:agent'),
        `${key} must start with clickdz:agent`
      );
      t.true(key.includes(USER), `${key} must contain the owner id`);
    }
  }
});

test('no reset key can ever reach the appdata namespace', t => {
  // Belt and braces: even with adversarial ids, a built key stays inside
  // `clickdz:agent…`. An id containing a colon cannot escape the prefix.
  const nasty = '../appdata:fatehshop:orders';
  for (const key of [
    resetThreadKey(USER, nasty),
    ...resetRunKeys(USER, nasty),
  ]) {
    t.true(key.startsWith('clickdz:agent'), `${key} escaped the namespace`);
    t.false(
      key.startsWith('clickdz:appdata'),
      `${key} reached the shop namespace`
    );
  }
});

test('isResetSafeKey rejects every non-agent and non-owner key', t => {
  const USER_ID = USER;
  // The predicate is the last line of defence before UNLINK, so it is asserted
  // directly rather than only through the builders.
  for (const key of MUST_SURVIVE.filter(k => !k.startsWith('clickdz:agent'))) {
    t.false(isResetSafeKey(key, USER_ID), `${key} must be rejected`);
  }
  t.false(
    isResetSafeKey(resetThreadKey(OTHER, 't1'), USER_ID),
    'another user’s thread must be rejected'
  );
  t.false(isResetSafeKey('clickdz:appdata:fatehshop:orders', USER_ID));
  // An empty user id must never make everything "safe".
  t.false(isResetSafeKey(resetThreadKey(USER_ID, 't1'), ''));
  // And the caller's own agent keys pass.
  t.true(isResetSafeKey(resetThreadKey(USER_ID, 't1'), USER_ID));
  for (const key of resetSingletonKeys(USER_ID, 'hermes')) {
    t.true(isResetSafeKey(key, USER_ID), `${key} must be accepted`);
  }
});
