// ---------------------------------------------------------------------------
// Agent-reset key builders — the exact Redis keys POST /agents/:agent/reset
// removes.
//
// This is a PURE module: no imports, no framework, no I/O — the same stance as
// clickdz-erp-caisse.ts / clickdz-erp-shipping.ts. That is deliberate and load
// bearing: it is what lets the guard spec import these builders directly and
// assert the blast radius in milliseconds, with no app bootstrap, no Redis, and
// no dependency on the Rust native addon (importing the controller pulls that
// in, and the fast guards job does not build it).
//
// WHY THIS IS INDEX-DRIVEN, NOT GLOB-DRIVEN — the whole safety story:
//
// Agent state and the LIVE SHOP share one Redis database and one `clickdz:`
// prefix. `clickdz:appdata:<slug>:orders` is a merchant's order book. A key
// pattern one segment too loose does not fail loudly; it deletes a business.
//
// The intuitive patterns are also simply WRONG. Threads and runs are keyed
// per-USER, with the agent stored INSIDE the record:
//
//     clickdz:agent:<userId>:<threadId>      thread.agent names the agent
//     clickdz:agentrun:<userId>:<runId>      record.agentId names the agent
//
// So `clickdz:agent:<userId>:*` sweeps up the OTHER agent's threads too —
// resetting Hermes would silently destroy OpenClaw's history. Redis `*` spans
// `:` as well, so such globs reach further than they appear to.
//
// The route therefore reads each agent's OWN index (a per-agent thread-id list
// and a per-agent run-id zset) and builds keys for only those ids, using the
// helpers below. Nothing is guessed, and the shop namespace is unreachable by
// construction rather than by careful pattern-writing.
// ---------------------------------------------------------------------------

/** The two built-in agents. Mirrors AgentName without importing it. */
export type ResetAgent = 'hermes' | 'openclaw';

/**
 * The fixed, per-agent singleton keys — the ones that CAN be named exactly
 * because the agent is part of the key rather than the value.
 */
export function resetSingletonKeys(
  userId: string,
  agent: ResetAgent
): string[] {
  return [
    // The thread-id index for this agent.
    `clickdz:agent:index:${userId}:${agent}`,
    // The provisioning record. Removing it is what returns the merchant to the
    // setup wizard — there is no other way to un-provision, since every config
    // PUT forces provisioned:true.
    `clickdz:agent:config:${userId}:${agent}`,
    // The run-id index (zset) for this agent.
    `clickdz:agentruns:${userId}:${agent}`,
    // Long-term memory: facts, preferences, summaries.
    `clickdz:agentmem:${userId}:${agent}`,
    // The informational enable flag.
    `clickdz:agentstate:${userId}:${agent}`,
  ];
}

/**
 * One thread's key. Carries NO agent segment — which is exactly why the id must
 * come from the per-agent index and never from a glob.
 */
export function resetThreadKey(userId: string, threadId: string): string {
  return `clickdz:agent:${userId}:${threadId}`;
}

/** One run's record plus its SSE replay list. Same per-user keying caveat. */
export function resetRunKeys(userId: string, runId: string): string[] {
  return [
    `clickdz:agentrun:${userId}:${runId}`,
    `clickdz:agentrun:${userId}:${runId}:events`,
  ];
}

/**
 * The invariant the route's defence-in-depth filter enforces before UNLINK:
 * every key must be agent-namespaced AND owner-scoped. A key failing this is
 * dropped rather than deleted, so a future bug in a caller degrades to "reset
 * did less than expected" instead of "shop data is gone".
 */
export function isResetSafeKey(key: string, userId: string): boolean {
  return (
    !!userId && key.startsWith('clickdz:agent') && key.includes(userId)
  );
}

/** Upper bound on ids pulled from an index, so a reset is always bounded. */
export const RESET_MAX_IDS = 500;
