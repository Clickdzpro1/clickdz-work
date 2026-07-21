// ---------------------------------------------------------------------------
// CDZ AGENT — WHATSAPP GATEWAY CLIENT + SEND TOOL (WSA-7, owner: Wassila).
//
// A framework-light module (NO Nest decorators — the AgentToolDef shape is
// mirrored locally, type-only) that fronts the Railway whatsapp-gateway for the
// agents. It exposes:
//   · waEnabled()            — the master gate (URL + token env + WA flag).
//   · waClient               — a tiny bearer HTTP client (sendText/sessionStatus/qr).
//   · createWhatsappSendTool — the outbound `whatsapp_send` AgentToolDef,
//                              registered fail-soft into Regis's default registry
//                              (see the mirrored import block in clickdz-agent-tools.ts).
//   · waCapsEnabled()        — an env-ONLY read (no fetch) for Fanal's GET /agents caps.
//
// EVERYTHING is fail-soft DARK today: the gateway env pair (CDZ_WA_URL +
// CDZ_WA_TOKEN) is deliberately UNSET in prod and CDZ_AGENT_WHATSAPP_ENABLED is
// off, so every client method resolves `{ok:false, reason:'wa_dark'}` WITHOUT
// touching the network, the tool advertises available:false, and caps report
// false. No SDK — plain fetch with a bearer header, the SAME self-contained,
// env-driven stance as the peer ClickDz proxy controllers (clickdz-vdz-render:
// CDZ_X_URL/CDZ_X_TOKEN pair, `.replace(/\/+$/,'')`, AbortSignal.timeout) and the
// telegram client (a class whose methods degrade instead of throwing). Imports
// nothing from the frontend; never throws.
//
// GATEWAY ENDPOINT PATHS ARE **ASSUMED** — chosen from the R4 plan
// /agent/workspace/ws10plan/out/05-whatsapp.md §"Target design" (the proxy
// controller endpoint list, which targets the wweb-gateway whatsapp-web.js
// stack). They are NOT yet verified against the live gateway (its Railway
// domain + exact REST surface are Open Q1/Q4 in that plan). When the real
// gateway is wired these three constants get confirmed/adjusted in ONE place:
//   · WA_PATH_SEND    'POST /send'    — from POST /api/v1/wa/send   {chatId|phone,text}
//   · WA_PATH_SESSION 'GET  /session' — from GET  /api/v1/wa/session {state,phone,since}
//   · WA_PATH_QR      'GET  /qr'      — from GET  /api/v1/wa/qr      (current QR string/data-URL)
// The monolith-facing routes in that plan are stripped of their `/api/v1/wa`
// prefix here — this client talks to the GATEWAY directly (its bare REST paths),
// not to the monolith proxy.
// ---------------------------------------------------------------------------

// --- Config (read once at module load, same idiom as the sibling controllers).
// Trailing slashes trimmed exactly like the render controller's CDZ_RENDER_URL
// so `${WA_URL}${path}` never doubles a slash.
const WA_URL = (process.env.CDZ_WA_URL || '').replace(/\/+$/, '');
const WA_TOKEN = process.env.CDZ_WA_TOKEN || '';
// Master WA-tool gate that sits ON TOP of the URL pair (R8-CONTRACT): the
// gateway can be provisioned (URL+token set) while the agent-facing send tool
// stays dark until this '1' flag flips. Read as a string, '1' = on.
const CDZ_AGENT_WHATSAPP_ENABLED = process.env.CDZ_AGENT_WHATSAPP_ENABLED || '';

// Bounded timeout for every gateway call — quick control-plane calls (send / a
// status poll / a QR fetch), never a long poll. Guards a hung upstream from
// taking a request thread with it. Matches the telegram client's 10s ceiling.
const WA_TIMEOUT_MS = 10_000;
// The send tool trims text well inside the contract's 1000-char arg cap so an
// agent's long message is delivered (truncated) rather than rejected upstream.
const WA_MAX_TEXT = 1000;

// --- ASSUMED gateway endpoint paths (see the header note). Kept as named
// constants so the real paths are verified/edited in ONE place when wired.
const WA_PATH_SEND = '/send';
const WA_PATH_SESSION = '/session';
const WA_PATH_QR = '/qr';

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
 * The master gate. True only when BOTH gateway env vars are present AND the
 * WhatsApp tool flag is '1'. Absent/off ⇒ everything dark (no fetch, tool
 * unavailable, caps false). Pure + synchronous — safe to call from a tool's
 * `available()` predicate and from caps reads.
 */
export function waEnabled(): boolean {
  return !!WA_URL && !!WA_TOKEN && CDZ_AGENT_WHATSAPP_ENABLED === '1';
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

// ---------------------------------------------------------------------------
// Minimal WhatsApp gateway client (fail-soft). Every method resolves the dark
// envelope (`{ok:false, reason:'wa_dark'}`) WITHOUT any network traffic when the
// gateway is not wired (waEnabled() false) — so the whole feature is inert dark
// until the env pair + flag are provisioned. No throwing: a network / gateway
// hiccup also resolves a typed `{ok:false, reason:...}` (callers degrade, never
// 500). Bearer CDZ_WA_TOKEN on CDZ_WA_URL, 10s timeout (AbortSignal.timeout),
// mirroring the render controller's upstream() idiom.
// ---------------------------------------------------------------------------
export class WhatsappClient {
  /** True when the gateway is wired AND the WA tool flag is on. */
  get configured(): boolean {
    return waEnabled();
  }

  /** Bearer auth header for every gateway call (mirrors remotionHeaders). */
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
   * Send a text message to a phone (digits, 213-normalized by the caller).
   * ASSUMED endpoint `POST /send` {to, text} (from the R4 plan's POST
   * /api/v1/wa/send). Text is trimmed to WA_MAX_TEXT. Dark ⇒ WA_DARK.
   */
  async sendText(to: string, text: string): Promise<WaResult> {
    if (!waEnabled()) return { ...WA_DARK };
    const trimmed = String(text ?? '').slice(0, WA_MAX_TEXT);
    return this.call(WA_PATH_SEND, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ to, text: trimmed }),
    });
  }

  /**
   * Current session state. ASSUMED endpoint `GET /session` → the gateway's
   * {state: disconnected|pairing|connected|banned, phone?, since} (from the R4
   * plan's GET /api/v1/wa/session). Dark ⇒ WA_DARK.
   */
  async sessionStatus(): Promise<WaResult> {
    if (!waEnabled()) return { ...WA_DARK };
    return this.call(WA_PATH_SESSION, { method: 'GET' });
  }

  /**
   * Current QR string / data-URL for pairing. ASSUMED endpoint `GET /qr` (from
   * the R4 plan's GET /api/v1/wa/qr; wweb regenerates it ~every 20s). Dark ⇒
   * WA_DARK.
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
// simply absent from the catalog/loop until the gateway pair + flag are set.
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
