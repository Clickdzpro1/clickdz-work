// ClickDz unified agent tool registry (R6 / WSA-1, owner: Regis).
//
// A framework-light module (NO Nest decorators — types are imported type-only)
// that both Hermes and OpenClaw agent loops dispatch through instead of their
// hand-rolled tool switches. It gives every agent tool ONE shape (AgentToolDef),
// ONE dispatch path (never throws — a tool crash must not kill a run), and ONE
// condensed catalog format for planner prompts (matching Hermes's legacy
// `buildToolBlock` so R6 planner prompts stay byte-consistent).
//
// The default registry wires the FIRST-PARTY web tools (Exa search/crawl — which
// today only reach the native chat copilot via runtime/tool-runtime.ts) into the
// agents, gated behind CDZ_AGENT_WEB_ENABLED + the exa key being present in
// config. Telegram's outbound send tool is registered fail-soft: it is built by
// Telegramme's `createTelegramSendTool(deps)` in a sibling module and imported
// only if present, so this file builds and boots whether or not that file exists
// yet (parallel build).
//
// All new behavior is flag-gated (default OFF/absent ⇒ tools simply report
// unavailable and are excluded from the catalog/loop).

import type { CopilotTool } from './tools/tool';
// R16 (WhatsApp BYOT): the WhatsApp send tool resolves the run's per-(user,agent)
// gateway instance from the JSON channel record — which is written via the Cache
// provider (JSON.stringify at rest). buildDefaultRegistry's deps carry only the
// raw `redis` handle (see the hermes/openclaw ctor callsites: no `cache` is
// passed), so registerWhatsappFailSoft below WRAPS deps.redis in a `Cache` and
// hands `{ cache }` to createWhatsappSendTool — the "pass a Cache handle" the
// design calls for. `Cache` is a plain provider class (new Cache(redis) ===
// new CacheProvider(redis)); value-importing it is lint-nest-safe (it resolves
// at boot; it is not a decorator). This is the one place the otherwise
// framework-light registry touches a base provider, and only to bridge the
// record store the WA tool reads.
import { Cache } from '../../base';

// ---------------------------------------------------------------------------
// Pinned interfaces (R6-CONTRACT §"Tool registry") — exact names.
// ---------------------------------------------------------------------------

export interface AgentToolCtx {
  userId: string;
  agent: 'hermes' | 'openclaw';
  runId?: string;
  threadId?: string;
  signal?: AbortSignal;
  log: (m: string) => void;
  services: { redis: any; config: any };
}

export interface AgentToolDef {
  name: string;
  description: string;
  scope: 'hermes' | 'openclaw' | 'all';
  consequential: boolean;
  available(ctx: AgentToolCtx): boolean;
  inputSummary?: string;
  run(
    args: Record<string, unknown>,
    ctx: AgentToolCtx
  ): Promise<{ ok: boolean; result: unknown; preview?: string }>;
}

/** One condensed catalog entry handed to the planner prompt. */
export interface AgentToolCatalogEntry {
  name: string;
  description: string;
  consequential: boolean;
}

/**
 * Dependencies for `buildDefaultRegistry`. Kept deliberately small and structural
 * (no DI decorators) so Moteur (run engine) and Filaire (hermes port) can build
 * one identical registry from the values they already hold. See REGISTRY-DEPS in
 * NOTES.md for the canonical documentation of this shape.
 */
export interface AgentToolRegistryDeps {
  /** Redis-backed JSON cache provider (the runtime's `Cache`/`CacheRedis`). */
  redis: any;
  /** AFFiNE copilot `Config` (has `.copilot.exa.key`). */
  config: any;
  /**
   * Optional planner handle passed through to tools that need to sub-call the
   * planner (e.g. a future make_agent_run replacement). The web tools do not use
   * it; Telegramme's factory and hermes-specific tool defs may. Opaque here.
   */
  planner?: any;
  /** Optional extra tool defs to register after the built-ins (e.g. hermes defs). */
  extraTools?: AgentToolDef[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Hard cap on the serialized catalog handed to the planner prompt. */
const CATALOG_MAX_BYTES = 6 * 1024;
/** Preview strings are trimmed to keep step records compact. */
const PREVIEW_MAX = 600;

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export class ClickDzToolRegistry {
  private readonly defs = new Map<string, AgentToolDef>();

  /** Register (or replace) a tool def. Last registration for a name wins. */
  register(def: AgentToolDef): void {
    if (!def || typeof def.name !== 'string' || !def.name) return;
    this.defs.set(def.name, def);
  }

  /** All defs in scope for this ctx AND currently available (env/key gates). */
  listFor(ctx: AgentToolCtx): AgentToolDef[] {
    const out: AgentToolDef[] = [];
    for (const def of this.defs.values()) {
      if (def.scope !== 'all' && def.scope !== ctx.agent) continue;
      let ok = false;
      try {
        ok = def.available(ctx);
      } catch {
        ok = false;
      }
      if (ok) out.push(def);
    }
    return out;
  }

  /**
   * The condensed, planner-prompt-ready catalog (≤6KB serialized). Mirrors the
   * name + description + consequential flag surface of Hermes's `buildToolBlock`.
   * If the serialized form would exceed CATALOG_MAX_BYTES, descriptions are
   * progressively trimmed (never names) so the array always fits.
   */
  catalogFor(ctx: AgentToolCtx): AgentToolCatalogEntry[] {
    const defs = this.listFor(ctx);
    let entries: AgentToolCatalogEntry[] = defs.map(d => ({
      name: d.name,
      description: d.description,
      consequential: !!d.consequential,
    }));

    // Fits? done.
    if (serializedBytes(entries) <= CATALOG_MAX_BYTES) return entries;

    // Trim descriptions in rounds until it fits (or we run out of slack).
    for (let cap = 240; cap >= 40; cap -= 40) {
      entries = entries.map(e => ({
        name: e.name,
        description: clip(e.description, cap),
        consequential: e.consequential,
      }));
      if (serializedBytes(entries) <= CATALOG_MAX_BYTES) return entries;
    }
    return entries;
  }

  /**
   * Render the in-scope tools as the compact prompt block Hermes uses today:
   *   `- <name>: <description>` (one per line, consequential marked).
   * Kept ≤6KB. Provided so Filaire's planner prompt string stays byte-consistent
   * with the legacy `buildToolBlock` output shape.
   */
  catalogText(ctx: AgentToolCtx): string {
    return this.catalogFor(ctx)
      .map(
        e =>
          `- ${e.name}: ${e.description}${
            e.consequential ? ' [consequential]' : ''
          }`
      )
      .join('\n');
  }

  /**
   * Dispatch a tool by name. NEVER throws:
   *  - unknown tool           → { ok:false, result:{error:'unknown_tool'} }
   *  - out-of-scope / gated   → { ok:false, result:{error:'unavailable'} }
   *  - tool run() throws       → { ok:false, result:{error:'tool_error', message} }
   * A tool crash must not kill the run.
   */
  async dispatch(
    name: string,
    args: Record<string, unknown>,
    ctx: AgentToolCtx
  ): Promise<{ ok: boolean; result: unknown; preview?: string }> {
    const def = this.defs.get(name);
    if (!def) {
      return { ok: false, result: { error: 'unknown_tool', tool: name } };
    }
    if (def.scope !== 'all' && def.scope !== ctx.agent) {
      return { ok: false, result: { error: 'unavailable', tool: name } };
    }
    try {
      if (!def.available(ctx)) {
        return { ok: false, result: { error: 'unavailable', tool: name } };
      }
    } catch {
      return { ok: false, result: { error: 'unavailable', tool: name } };
    }
    try {
      const res = await def.run(args || {}, ctx);
      // Defensive: a def must return the envelope; coerce a stray value.
      if (!res || typeof res !== 'object' || typeof res.ok !== 'boolean') {
        return { ok: true, result: res, preview: clip(previewOf(res), PREVIEW_MAX) };
      }
      return {
        ok: res.ok,
        result: res.result,
        preview:
          typeof res.preview === 'string'
            ? clip(res.preview, PREVIEW_MAX)
            : clip(previewOf(res.result), PREVIEW_MAX),
      };
    } catch (e: any) {
      try {
        ctx.log(`tool ${name} threw: ${e?.message || e}`);
      } catch {
        /* logging must never throw */
      }
      return {
        ok: false,
        result: { error: 'tool_error', tool: name, message: String(e?.message || e) },
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Default registry builder
// ---------------------------------------------------------------------------

/**
 * Build the registry every agent shares. Registers:
 *  - web_search  (wraps createExaSearchTool)   — gated CDZ_AGENT_WEB_ENABLED + exa key
 *  - web_fetch   (wraps createExaCrawlTool)     — same gate  (alias web_crawl also registered)
 *  - telegram_send                              — fail-soft import of Telegramme's factory
 *  - ...deps.extraTools                         — hermes-specific defs (Filaire), etc.
 *
 * Fully synchronous + fail-soft: absence of the exa key, the web flag, or the
 * Telegram module never throws — those tools just report unavailable.
 */
export function buildDefaultRegistry(
  deps: AgentToolRegistryDeps
): ClickDzToolRegistry {
  const registry = new ClickDzToolRegistry();

  registry.register(makeWebSearchTool(deps));
  registry.register(makeWebFetchTool('web_fetch', deps));
  // Back-compat alias: the contract names it web_fetch; the legacy native copilot
  // slug was web_crawl_exa. Register a `web_crawl` alias so either planner vocab hits.
  registry.register(makeWebFetchTool('web_crawl', deps));

  // telegram_send — built by Telegramme in a sibling module. Imported fail-soft
  // so this file boots whether or not that file exists yet (parallel build).
  // This module is ESM ("type":"module"), so we use dynamic import(), not require.
  // buildDefaultRegistry must stay synchronous (pinned signature), so the import
  // runs as a fire-and-forget promise that registers the tool when it resolves;
  // the registry is a live object and the catalog is read per-run (well after
  // construction), so a tool landing a few ms later is fine.
  void registerTelegramFailSoft(registry, deps).catch(() => {});

  // whatsapp_send — built by the WhatsApp BYOT controller module
  // (clickdz-agent-whatsapp, R16 — the twin of clickdz-agent-telegram).
  // Imported fail-soft on the SAME terms as telegram above: a missing module,
  // a non-function export, or a factory throw all resolve to a silent no-op, so
  // this file boots whether or not that module is present. Fire-and-forget from
  // the synchronous builder; the tool lands on the live registry a few ms later
  // (the catalog is read per-run, well after construction).
  void registerWhatsappFailSoft(registry, deps).catch(() => {});

  if (Array.isArray(deps.extraTools)) {
    for (const def of deps.extraTools) {
      if (def) registry.register(def);
    }
  }

  return registry;
}

// ---------------------------------------------------------------------------
// Built-in web tools (wrap the existing Exa CopilotTools)
// ---------------------------------------------------------------------------

/**
 * True only when the agent-web flag (CDZ_AGENT_WEB_ENABLED='1') is on AND an exa
 * key is present. The key is read from the build-time deps config (authoritative
 * — it is the Config the registry was constructed with), falling back to the
 * per-run ctx config when deps carried none. In production both are the same
 * Config singleton; the fallback just keeps the gate robust.
 */
function webEnabled(depsConfig: any, ctx: AgentToolCtx): boolean {
  if (process.env.CDZ_AGENT_WEB_ENABLED !== '1') return false;
  return !!(exaKeyOf(depsConfig) || exaKeyOf(ctx.services?.config));
}

/** Resolve the exa Config the tool should use: deps first, then ctx. */
function resolveConfig(depsConfig: any, ctx: AgentToolCtx): any {
  return exaKeyOf(depsConfig) ? depsConfig : ctx.services?.config ?? depsConfig;
}

function exaKeyOf(config: any): string {
  try {
    const key = config?.copilot?.exa?.key;
    return typeof key === 'string' ? key : '';
  } catch {
    return '';
  }
}

/**
 * Lazily build the underlying Exa CopilotTool from config and run it, normalizing
 * to the registry envelope. The Exa tools (tools/exa-search.ts, tools/exa-crawl.ts)
 * are `(config) => CopilotTool`; on failure they return a ToolError
 * `{type:'error', name, message}` rather than throwing — we map that to ok:false.
 */
async function runExa(
  build: (config: any) => CopilotTool,
  config: any,
  args: Record<string, unknown>,
  ctx: AgentToolCtx
): Promise<{ ok: boolean; result: unknown; preview?: string }> {
  const tool = build(config);
  const exec = tool?.execute;
  if (typeof exec !== 'function') {
    return { ok: false, result: { error: 'tool_unavailable' } };
  }
  const raw = await exec(args, { signal: ctx.signal });
  // ToolError shape → failure.
  if (raw && typeof raw === 'object' && (raw as any).type === 'error') {
    const te = raw as any;
    return {
      ok: false,
      result: raw,
      preview: clip(`${te.name || 'error'}: ${te.message || ''}`, PREVIEW_MAX),
    };
  }
  return { ok: true, result: raw, preview: clip(previewOf(raw), PREVIEW_MAX) };
}

function makeWebSearchTool(deps: AgentToolRegistryDeps): AgentToolDef {
  const depsConfig = deps?.config;
  return {
    name: 'web_search',
    description:
      'Search the web using Exa (one of the best web search APIs for AI). Returns up to 10 results with title, url and a summary. Use for fresh/external facts.',
    scope: 'all',
    consequential: false,
    inputSummary: '{"query":"<search query>","mode":"AUTO"}',
    available: ctx => webEnabled(depsConfig, ctx),
    run: async (args, ctx) => {
      // Import lazily to keep this module framework-light and avoid pulling exa-js
      // at module load when web is disabled.
      const { createExaSearchTool } = await import('./tools/exa-search');
      const a: Record<string, unknown> = { ...args };
      if (a.mode !== 'MUST' && a.mode !== 'AUTO') a.mode = 'AUTO';
      return runExa(createExaSearchTool as any, resolveConfig(depsConfig, ctx), a, ctx);
    },
  };
}

function makeWebFetchTool(name: string, deps: AgentToolRegistryDeps): AgentToolDef {
  const depsConfig = deps?.config;
  return {
    name,
    description:
      'Fetch (crawl) a single web URL and return its extracted text content. Provide the full URL including http:// or https://.',
    scope: 'all',
    consequential: false,
    inputSummary: '{"url":"https://..."}',
    available: ctx => webEnabled(depsConfig, ctx),
    run: async (args, ctx) => {
      const { createExaCrawlTool } = await import('./tools/exa-crawl');
      return runExa(
        createExaCrawlTool as any,
        resolveConfig(depsConfig, ctx),
        args || {},
        ctx
      );
    },
  };
}

// ---------------------------------------------------------------------------
// Fail-soft Telegram module loader
// ---------------------------------------------------------------------------

/**
 * Attempt to load Telegramme's sibling module and, if it exports
 * `createTelegramSendTool(deps) => AgentToolDef`, register that tool. Everything
 * here is fail-soft: a missing module (parallel build), a non-function export, or
 * a factory throw all resolve to a silent no-op. Returns a promise that callers
 * may ignore (fire-and-forget from the synchronous builder) or await (tests).
 */
export async function registerTelegramFailSoft(
  registry: ClickDzToolRegistry,
  deps: AgentToolRegistryDeps
): Promise<void> {
  try {
    const mod: any = await import('./clickdz-agent-telegram');
    if (mod && typeof mod.createTelegramSendTool === 'function') {
      // WS17: wrap redis in a Cache so the tool can resolve the per-(user,agent)
      // channel record it needs to send. Previously `deps` was passed straight
      // through, so `deps.cache` was undefined in the detached-run path and
      // every telegram_send call hit a TypeError -> silent {ok:false}. Mirrors
      // the WhatsApp loader below. NOTE: createTelegramSendTool expects a
      // { cache } object, NOT a bare Cache — passing `cache as any` (the p2
      // attempt) left deps.cache undefined and the tool still failed.
      const cache = deps?.redis ? new Cache(deps.redis as any) : undefined;
      const def = mod.createTelegramSendTool({ cache: cache as any });
      if (def && typeof def.name === 'string') {
        registry.register(def as AgentToolDef);
      }
    }
  } catch {
    /* Telegram module absent or errored — silently skip. */
  }
}

/**
 * WhatsApp twin of registerTelegramFailSoft: load Réseau's sibling module
 * (clickdz-agent-whatsapp — the per-user BYOT controller that OWNS the WA send
 * tool, exactly as clickdz-agent-telegram owns telegram_send) and, if it exports
 * `createWhatsappSendTool({cache}) => AgentToolDef`, register that tool. Fail-soft
 * on every failure mode (absent module, non-function export, factory throw).
 * Returns a promise callers may ignore (fire-and-forget from the synchronous
 * builder) or await (tests).
 *
 * UNLIKE the telegram loader (which passes `deps` straight through, so its tool's
 * `deps.cache` is undefined in the detached-run path — a latent no-op), this
 * wraps deps.redis in a `Cache` so the WA tool can actually resolve the
 * per-(user,agent) instance record it needs to send. The record is a JSON blob
 * written by the controller via Cache; a `new Cache(redis)` reads it identically.
 */
export async function registerWhatsappFailSoft(
  registry: ClickDzToolRegistry,
  deps: AgentToolRegistryDeps
): Promise<void> {
  try {
    const mod: any = await import('./clickdz-agent-whatsapp');
    if (mod && typeof mod.createWhatsappSendTool === 'function') {
      // Bridge the raw redis handle into a Cache the WA tool reads records from.
      // Guarded: a missing/incompatible redis simply yields a Cache whose
      // fail-soft get() returns undefined ⇒ the tool reports no_connection.
      const cache = deps?.redis ? new Cache(deps.redis as any) : undefined;
      const def = mod.createWhatsappSendTool({ cache });
      if (def && typeof def.name === 'string') {
        registry.register(def as AgentToolDef);
      }
    }
  } catch {
    /* WhatsApp module absent or errored — silently skip. */
  }
}

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

/** UTF-8 byte length of the JSON serialization of a value. */
function serializedBytes(v: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(v) || '', 'utf8');
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

/** Clip a string to n chars (adds an ellipsis marker when truncated). */
function clip(s: string, n: number): string {
  if (typeof s !== 'string') return '';
  if (s.length <= n) return s;
  return s.slice(0, Math.max(0, n - 1)) + '…';
}

/** A compact human/string preview of an arbitrary tool result. */
function previewOf(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
