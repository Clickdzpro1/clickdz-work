// ---------------------------------------------------------------------------
// CDZ AGENT — WHATSAPP GATEWAY CLIENT + SEND TOOL (WSA-7, owner: Wassila).
//
// A framework-light module (NO Nest decorators — the AgentToolDef shape is
// mirrored locally, type-only) that fronts the Railway whatsapp-gateway for the
// agents. It exposes:
//   · waEnabled()            — the master gate (URL + token + instance id env,
//                              + the WA flag).
//   · waClient               — a tiny bearer HTTP client (sendText/sessionStatus/qr).
//   · createWhatsappSendTool — the outbound `whatsapp_send` AgentToolDef,
//                              registered fail-soft into Regis's default registry
//                              (see the mirrored import block in clickdz-agent-tools.ts).
//   · waCapsEnabled()        — an env-ONLY read (no fetch) for Fanal's GET /agents caps.
//
// EVERYTHING is fail-soft DARK today: the gateway env pair (CDZ_WA_URL +
// CDZ_WA_TOKEN + CDZ_WA_INSTANCE_ID) is deliberately UNSET in prod and
// CDZ_AGENT_WHATSAPP_ENABLED is off, so every client method resolves
// `{ok:false, reason:'wa_dark'}` WITHOUT touching the network, the tool
// advertises available:false, and caps report false. No SDK — plain fetch with
// a bearer header, the SAME self-contained, env-driven stance as the peer
// ClickDz proxy controllers (clickdz-vdz-render: CDZ_X_URL/CDZ_X_TOKEN pair,
// `.replace(/\/+$/,'')`, AbortSignal.timeout) and the telegram client (a class
// whose methods degrade instead of throwing). Imports nothing from the
// frontend; never throws.
//
// GATEWAY ENDPOINT PATHS — VERIFIED (superseding the R8 "ASSUMED" paths from
// the ws10plan/out/05-whatsapp.md draft, which guessed a flat /send /session
// /qr surface that the built gateway does NOT expose). The live
// `whatsapp-gateway` repo (Railway services wweb-gateway + a Baileys sibling,
// same route code) is TENANT/INSTANCE-scoped, not flat:
//   · WA_PATH_MESSAGES  'POST /instances/:id/messages/text'  {to, text} → {ok, messageId}
//   · WA_PATH_STATUS    'GET  /instances/:id'                          → instance object
//   · WA_PATH_QR        'GET  /instances/:id/qr'                       → {status, qr}
// `:id` is CDZ_WA_INSTANCE_ID (below) — the gateway has no notion of "the"
// session, only a specific instance created ahead of time via its admin API
// (POST /admin/tenants with the gateway's ADMIN_API_KEY, then POST /instances
// with the returned per-tenant key). CDZ_WA_TOKEN below is that PER-TENANT key
// — NOT the gateway's ADMIN_API_KEY, which only authorizes /admin/*, never
// /instances/*. The gateway also requires the destination phone as a JID
// (`<digits>@s.whatsapp.net`), not bare digits — see `toJid()`.
// ---------------------------------------------------------------------------

// --- Config (read once at module load, same idiom as the sibling controllers).
// Trailing slashes trimmed exactly like the render controller's CDZ_RENDER_URL
// so `${WA_URL}${path}` never doubles a slash.
const WA_URL = (process.env.CDZ_WA_URL || '').replace(/\/+$/, '');
// The gateway's PER-TENANT API key (returned once by POST /admin/tenants, then
// bound to an instance via POST /instances) — see the header note. Sent as a
// Bearer token; the gateway also accepts `x-api-key`, but Bearer matches this
// client's existing header idiom and the gateway takes either.
const WA_TOKEN = process.env.CDZ_WA_TOKEN || '';
// The gateway instance id (an existing WhatsApp session created ahead of time
// via the gateway's admin API — see the header note). Every real gateway route
// is scoped under /instances/:id, so this is required alongside the URL+token
// pair; absent ⇒ dark, same as an absent URL or token.
const WA_INSTANCE_ID = process.env.CDZ_WA_INSTANCE_ID || '';
// Master WA-tool gate that sits ON TOP of the URL/token/instance triple
// (R8-CONTRACT, extended): the gateway can be fully provisioned while the
// agent-facing send tool stays dark until this '1' flag flips. Read as a
// string, '1' = on.
const CDZ_AGENT_WHATSAPP_ENABLED = process.env.CDZ_AGENT_WHATSAPP_ENABLED || '';

// Bounded timeout for every gateway call — quick control-plane calls (send / a
// status poll / a QR fetch), never a long poll. Guards a hung upstream from
// taking a request thread with it. Matches the telegram client's 10s ceiling.
const WA_TIMEOUT_MS = 10_000;
// The send tool trims text well inside the contract's 1000-char arg cap so an
// agent's long message is delivered (truncated) rather than rejected upstream.
const WA_MAX_TEXT = 1000;

// --- VERIFIED gateway endpoint paths (see the header note). Precomputed once
// from WA_INSTANCE_ID at module load, same idiom as WA_URL/WA_TOKEN. When
// WA_INSTANCE_ID is empty these are malformed (`/instances//qr`) but harmless —
// waEnabled() gates every call before any of these strings are used.
const WA_PATH_MESSAGES = `/instances/${WA_INSTANCE_ID}/messages/text`;
const WA_PATH_STATUS = `/instances/${WA_INSTANCE_ID}`;
const WA_PATH_QR = `/instances/${WA_INSTANCE_ID}/qr`;

// The dark envelope every method returns when the gateway is not wired. A fixed
// shape (`ok:false, reason:'wa_dark'`) the callers (tool + caps + future proxy)
// key off to degrade gracefully — never an exception, never a network call.
export interface WaResult {
  ok: boolean;
  reason?: string;
  result?: unknown;
  [k: string]: unknown;
}

const WA_DARK: WaResult = { ok: false, reason: 'wa_dark' };

/**
 * The master gate. True only when the URL, the per-tenant token, AND the
 * instance id are all present, AND the WhatsApp tool flag is '1'. Absent/off ⇒
 * everything dark (no fetch, tool unavailable, caps false). Pure + synchronous
 * — safe to call from a tool's `available()` predicate and from caps reads.
 */
export function waEnabled(): boolean {
  return (
    !!WA_URL &&
    !!WA_TOKEN &&
    !!WA_INSTANCE_ID &&
    CDZ_AGENT_WHATSAPP_ENABLED === '1'
  );
}

/**
 * Env-ONLY caps read for Fanal's GET /api/v1/agents caps. Structurally the same
 * predicate as waEnabled() but named separately per the contract so the caps
 * surface has a stable, fetch-free hook (it must NEVER touch the network — a
 * caps read is on the hot path of the agents home load). Today: false.
 */
export function waCapsEnabled(): boolean {
  return waEnabled();
}

/**
 * Normalize a user-supplied phone to Algeria E.164 DIGITS (no `+`, no spaces):
 *   · strip everything but digits (drops `+`, spaces, dashes, parens),
 *   · a leading `00` international prefix → dropped (00213… → 213…),
 *   · a leading local `0` → replaced with the Algeria country code `213`
 *     (0550… → 213550…), the DZ mobile convention,
 *   · an already-`213`-prefixed number passes through unchanged,
 *   · a bare `+213…` (the `+` stripped) is already `213…` ⇒ passthrough.
 * Returns '' for empty/garbage input so the caller can reject before sending.
 * Pure + deterministic; no network. Exported so the tool + future proxy share
 * ONE normalization (matches the shop template's digits-only WhatsApp stance).
 */
export function normalizePhone(raw: unknown): string {
  let s = String(raw ?? '').replace(/[^\d]/g, '');
  if (!s) return '';
  // International `00` prefix (e.g. 00213…) → strip to the bare country form.
  if (s.startsWith('00')) s = s.slice(2);
  if (s.startsWith('213')) return s; // already country-prefixed
  if (s.startsWith('0')) return '213' + s.slice(1); // local 0-prefix → 213
  return s; // some other shape — leave the digits as-is (upstream validates)
}

/**
 * The gateway addresses recipients by WhatsApp JID
 * (`<countrycode+digits>@s.whatsapp.net`), not bare digits. `normalizePhone()`
 * only produces digits (it is shared with future non-WA consumers), so this is
 * a separate, WA-gateway-specific step applied right before the request body
 * is built. Defensive: a value that already carries an `@` (a caller passing a
 * pre-built JID straight into `sendText`) is passed through unchanged.
 */
function toJid(digits: string): string {
  return digits.includes('@') ? digits : `${digits}@s.whatsapp.net`;
}

// ---------------------------------------------------------------------------
// Minimal WhatsApp gateway client (fail-soft). Every method resolves the dark
// envelope (`{ok:false, reason:'wa_dark'}`) WITHOUT any network traffic when the
// gateway is not wired (waEnabled() false) — so the whole feature is inert dark
// until the env quadruple + flag are provisioned. No throwing: a network /
// gateway hiccup also resolves a typed `{ok:false, reason:...}` (callers
// degrade, never 500). Bearer CDZ_WA_TOKEN on CDZ_WA_URL, 10s timeout
// (AbortSignal.timeout), mirroring the render controller's upstream() idiom.
// ---------------------------------------------------------------------------
export class WhatsappClient {
  /** True when the gateway is wired AND the WA tool flag is on. */
  get configured(): boolean {
    return waEnabled();
  }

  /** Bearer auth header for every gateway call (mirrors remotionHeaders). The
   * gateway's /instances/* routes accept this OR `x-api-key`; Bearer is kept
   * for continuity with the rest of this client's header idiom. */
  private headers(extra?: Record<string, string>): Record<string, string> {
    return { authorization: `Bearer ${WA_TOKEN}`, ...extra };
  }

  /**
   * Wrap a fetch to the gateway. Resolves:
   *   · WA_DARK                                  when !waEnabled() (no network),
   *   · {ok:true, result}                        on a 2xx (parsed JSON body),
   *   · {ok:false, reason:'wa_http', status}     on a non-2xx,
   *   · {ok:false, reason:'wa_network', message} on a network/timeout error.
   * NEVER throws — a WhatsApp hiccup must not kill an agent run or a caps read.
   */
  private async call(
    path: string,
    init: RequestInit
  ): Promise<WaResult> {
    if (!waEnabled()) return { ...WA_DARK };
    try {
      const res = await fetch(`${WA_URL}${path}`, {
        ...init,
        headers: this.headers(
          (init.headers as Record<string, string>) || undefined
        ),
        signal: AbortSignal.timeout(WA_TIMEOUT_MS),
      });
      // Body is best-effort JSON; a non-JSON body resolves to {}.
      const body = (await res.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;
      if (!res.ok) {
        return { ok: false, reason: 'wa_http', status: res.status, result: body };
      }
      return { ok: true, result: body };
    } catch (cause) {
      return {
        ok: false,
        reason: 'wa_network',
        message:
          cause instanceof Error
            ? cause.message
            : 'WhatsApp gateway request failed',
      };
    }
  }

  /**
   * Send a text message to a phone (digits, 213-normalized by the caller;
   * converted to a JID here — see `toJid()`). VERIFIED endpoint
   * `POST /instances/:id/messages/text` {to, text} → {ok, messageId}. Text is
   * trimmed to WA_MAX_TEXT. Dark ⇒ WA_DARK.
   */
  async sendText(to: string, text: string): Promise<WaResult> {
    if (!waEnabled()) return { ...WA_DARK };
    const trimmed = String(text ?? '').slice(0, WA_MAX_TEXT);
    return this.call(WA_PATH_MESSAGES, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ to: toJid(to), text: trimmed }),
    });
  }

  /**
   * Current instance status. VERIFIED endpoint `GET /instances/:id` → the
   * gateway's instance object (id/name/status/…). Dark ⇒ WA_DARK.
   */
  async sessionStatus(): Promise<WaResult> {
    if (!waEnabled()) return { ...WA_DARK };
    return this.call(WA_PATH_STATUS, { method: 'GET' });
  }

  /**
   * Current QR for pairing. VERIFIED endpoint `GET /instances/:id/qr` →
   * {status, qr}. (The gateway also serves a PNG at `/qr.png` — not used here,
   * this client only needs the JSON form.) Dark ⇒ WA_DARK.
   */
  async qr(): Promise<WaResult> {
    if (!waEnabled()) return { ...WA_DARK };
    return this.call(WA_PATH_QR, { method: 'GET' });
  }
}

// A single shared client instance for the module (tool + any future consumer).
export const waClient = new WhatsappClient();

// ---------------------------------------------------------------------------
// OUTBOUND TOOL — `whatsapp_send` {to, text}. Registered into Regis's default
// registry via this factory (imported fail-soft in buildDefaultRegistry, mirror
// of the telegram_send wiring). consequential:true (it messages a human),
// scope:'all' (both agents may use it). available() = waEnabled() so the tool is
// simply absent from the catalog/loop until the gateway triple + flag are set.
//
// `deps` mirrors the shape Regis passes its factories (AgentToolRegistryDeps).
// The WA client is env-driven (no per-user binding to resolve, unlike telegram),
// so we don't read anything off deps here — the parameter is kept for signature
// parity with the other factories and future needs.
// ---------------------------------------------------------------------------
export interface WhatsappToolDeps {
  redis?: any;
  config?: any;
  planner?: any;
  extraTools?: any[];
  [k: string]: unknown;
}

// Structural mirror of Regis's AgentToolDef / AgentToolCtx (R6/R8 pinned shape).
// Kept LOCAL (not imported) so this file compiles standalone under the
// transpile-only build even independently of clickdz-agent-tools.ts; Regis's
// real interface is structurally identical, so the returned object satisfies it.
interface WaToolCtx {
  userId: string;
  agent: 'hermes' | 'openclaw';
  runId?: string;
  threadId?: string;
  signal?: AbortSignal;
  log: (m: string) => void;
  services: { redis: any; config: any };
}
interface WaToolDef {
  name: string;
  description: string;
  scope: 'hermes' | 'openclaw' | 'all';
  consequential: boolean;
  available(ctx: WaToolCtx): boolean;
  inputSummary?: string;
  run(
    args: Record<string, unknown>,
    ctx: WaToolCtx
  ): Promise<{ ok: boolean; result: unknown; preview?: string }>;
}

export function createWhatsappSendTool(_deps: WhatsappToolDeps): WaToolDef {
  return {
    name: 'whatsapp_send',
    description:
      "Envoie un message WhatsApp à un numéro (chiffres, format Algérie). À utiliser pour notifier un client ou livrer un résultat. Le numéro est normalisé (0… → 213…).",
    scope: 'all',
    consequential: true,
    inputSummary: '{"to":"0550…|213…","text":"…"}',
    // Gate on the master WA gate. run() re-checks + returns the dark envelope
    // (never throws) if the feature was toggled off between listing and dispatch.
    available: (_ctx: WaToolCtx) => waEnabled(),
    run: async (args: Record<string, unknown>, ctx: WaToolCtx) => {
      if (!waEnabled()) {
        return { ok: false, result: { error: 'wa_dark' } };
      }
      const to = normalizePhone(args?.to);
      if (!to) {
        return { ok: false, result: { error: 'to is required (phone digits)' } };
      }
      const text = typeof args?.text === 'string' ? args.text.trim() : '';
      if (!text) {
        return { ok: false, result: { error: 'text is required' } };
      }
      if (text.length > WA_MAX_TEXT) {
        return {
          ok: false,
          result: { error: `text too long (max ${WA_MAX_TEXT})` },
        };
      }
      const sent = await waClient.sendText(to, text);
      if (sent.ok) {
        return {
          ok: true,
          result: { delivered: true, to },
          // Preview is truncated (the dispatcher clips again to PREVIEW_MAX).
          preview: `→ ${to}: ${text.slice(0, 180)}`,
        };
      }
      ctx.log(`whatsapp_send failed: ${sent.reason || 'unknown'}`);
      return {
        ok: false,
        result: { error: sent.reason || 'send_failed', to },
      };
    },
  };
}
