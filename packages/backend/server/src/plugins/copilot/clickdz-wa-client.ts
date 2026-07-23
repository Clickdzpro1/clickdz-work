// ---------------------------------------------------------------------------
// CDZ AGENT — WHATSAPP SHARED HELPERS (R16 — per-user BYOT migration).
//
// HISTORY: R8 stubbed a flat send client; R13 (WSA-7) rewrote it to the real
// gateway's tenant/instance API but bound the WHOLE feature to ONE global
// instance (`CDZ_WA_INSTANCE_ID`) with an arbitrary `to`. R16 makes WhatsApp
// per-user BYOT (mirror of Telegram): each merchant connects THEIR OWN number to
// THEIR agent, and the send path + inbound webhook + run-done push all resolve a
// per-(user, agent) gateway INSTANCE — see `clickdz-agent-whatsapp.ts`, the twin
// of `clickdz-agent-telegram.ts`, which now OWNS:
//   · the per-user channel record + Redis keys,
//   · the instance-parameterized gateway client,
//   · the @Public /wh/:connId inbound webhook (HMAC over rawBody),
//   · the connect/status/disconnect/pair/test routes,
//   · the `whatsapp_send` tool + the run-done hook.
//
// THIS module is now a THIN shared-helpers + back-compat surface:
//   · normalizePhone() / toJid()  — pure phone→digits→JID helpers reused by the
//                                    shop template + any future consumer.
//   · waCapsEnabled()             — the caps read for Fanal's GET /agents caps,
//                                    now === the BYOT gate `channelsEnabled()`
//                                    (NO longer requires a global instance id).
//   · createWhatsappSendTool      — RE-EXPORTED from clickdz-agent-whatsapp so the
//                                    legacy import path (`./clickdz-wa-client`)
//                                    still resolves the per-user tool.
//   · waEnabled() / waClient      — retained for back-compat ONLY; the global
//                                    single-instance SEND path is REMOVED (it
//                                    could not attribute a run and a lingering
//                                    global instance is a cross-tenant leak, R1).
//
// MIGRATION (see clickdz-agent-whatsapp.ts header): CDZ_WA_URL + CDZ_WA_TOKEN
// (the server-side per-tenant apiKey) STAY — they are how the backend creates the
// per-user instances under the shared tenant. CDZ_WA_INSTANCE_ID and
// CDZ_WA_WEBHOOK_SECRET are DEPRECATED no-ops (kept only so an old deployment
// that still sets them does not error; nothing on the per-user path reads them),
// exactly as Telegram kept LEGACY_TG_TOKEN.
// ---------------------------------------------------------------------------

// The per-user BYOT gate + the tool factory live in the WhatsApp channel
// controller module (twin of clickdz-agent-telegram). Re-exported below so the
// caps read + the legacy tool import path resolve here without duplicating logic.
import { channelsEnabled } from './clickdz-agent-whatsapp';
export { createWhatsappSendTool } from './clickdz-agent-whatsapp';
export type { WhatsappToolDeps } from './clickdz-agent-whatsapp';

// --- Config (read once at module load). CDZ_WA_URL + CDZ_WA_TOKEN STAY (server-
// side tenant creds used to CREATE per-user instances). Trailing slashes trimmed.
const WA_URL = (process.env.CDZ_WA_URL || '').replace(/\/+$/, '');
// The gateway's PER-TENANT api key (from POST /admin/tenants) — server-only,
// NEVER browser-facing. Used by clickdz-agent-whatsapp to create instances.
const WA_TOKEN = process.env.CDZ_WA_TOKEN || '';
// The master WA flag. Paired with the secret box in channelsEnabled().
const CDZ_AGENT_WHATSAPP_ENABLED = process.env.CDZ_AGENT_WHATSAPP_ENABLED || '';

// DEPRECATED no-ops (R16). The single global instance id + its global webhook
// secret are gone from the live path — per-(user,agent) instances + per-instance
// sealed secrets replace them (clickdz-agent-whatsapp). Read here ONLY so a stale
// env does not error; nothing below depends on them. Mirror of Telegram's
// LEGACY_TG_TOKEN back-compat const.
const LEGACY_WA_INSTANCE_ID = process.env.CDZ_WA_INSTANCE_ID || '';
const LEGACY_WA_WEBHOOK_SECRET = process.env.CDZ_WA_WEBHOOK_SECRET || '';
// Referenced so the unused-var lint stays quiet while documenting the deprecation.
void LEGACY_WA_INSTANCE_ID;
void LEGACY_WA_WEBHOOK_SECRET;

// The dark envelope any legacy caller keys off. Kept for the back-compat client.
export interface WaResult {
  ok: boolean;
  reason?: string;
  result?: unknown;
  [k: string]: unknown;
}

const WA_DARK: WaResult = { ok: false, reason: 'wa_dark' };

/**
 * The master gate for the SHARED-HELPER surface. R16: NO longer requires a global
 * instance id — just the tenant URL + token + the WA flag. (The per-user routes
 * gate on channelsEnabled(), which additionally requires the secret box.) Pure +
 * synchronous.
 */
export function waEnabled(): boolean {
  return !!WA_URL && !!WA_TOKEN && CDZ_AGENT_WHATSAPP_ENABLED === '1';
}

/**
 * Env-driven caps read for Fanal's GET /api/v1/agents caps. R16: === the BYOT
 * gate `channelsEnabled()` (flag + secret box), so caps report WhatsApp available
 * exactly when a user CAN connect their own number. Fetch-free (hot path). It no
 * longer keys off a global instance id (there is none).
 */
export function waCapsEnabled(): boolean {
  return channelsEnabled();
}

/**
 * Normalize a user-supplied phone to Algeria E.164 DIGITS (no `+`, no spaces):
 *   · strip everything but digits (drops `+`, spaces, dashes, parens),
 *   · a leading `00` international prefix → dropped (00213… → 213…),
 *   · a leading local `0` → replaced with the Algeria country code `213`,
 *   · an already-`213`-prefixed number passes through unchanged.
 * Returns '' for empty/garbage. Pure + deterministic. Kept here (shared with the
 * shop template's digits-only WhatsApp stance). NOTE: the BYOT PAIRING path uses
 * clickdz-agent-whatsapp's `normalizeMsisdn` instead (which does NOT force a
 * country default — pairing needs the exact registered country code).
 */
export function normalizePhone(raw: unknown): string {
  let s = String(raw ?? '').replace(/[^\d]/g, '');
  if (!s) return '';
  if (s.startsWith('00')) s = s.slice(2);
  if (s.startsWith('213')) return s;
  if (s.startsWith('0')) return '213' + s.slice(1);
  return s;
}

/**
 * The gateway addresses recipients by WhatsApp JID (`<digits>@s.whatsapp.net`).
 * Defensive: a value already carrying an `@` is passed through unchanged. Kept
 * exported for compat; the BYOT send path passes bare digits (the gateway's
 * resolveChatId maps either form).
 */
export function toJid(digits: string): string {
  return digits.includes('@') ? digits : `${digits}@s.whatsapp.net`;
}

// ---------------------------------------------------------------------------
// LEGACY back-compat client. The global single-instance SEND path is REMOVED:
// sendText now resolves the dark envelope WITHOUT any network traffic (a run can
// only send through the OWNER's per-(user,agent) instance via clickdz-agent-
// whatsapp's tool — never a global instance). sessionStatus/qr are likewise inert.
// Retained so any lingering importer builds; NOT used by the per-user path.
// ---------------------------------------------------------------------------
export class WhatsappClient {
  get configured(): boolean {
    return false; // the global-instance client is retired
  }

  /** REMOVED global send — always dark (R16). Use the per-user tool instead. */
  async sendText(_to: string, _text: string): Promise<WaResult> {
    return { ...WA_DARK, reason: 'wa_global_removed' };
  }

  /** REMOVED — per-instance status lives on clickdz-agent-whatsapp's GET route. */
  async sessionStatus(): Promise<WaResult> {
    return { ...WA_DARK, reason: 'wa_global_removed' };
  }

  /** REMOVED — pairing lives on clickdz-agent-whatsapp's connect/pair routes. */
  async qr(): Promise<WaResult> {
    return { ...WA_DARK, reason: 'wa_global_removed' };
  }
}

// A single shared (inert) instance for any legacy consumer.
export const waClient = new WhatsappClient();
