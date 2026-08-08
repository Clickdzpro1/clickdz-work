// ---------------------------------------------------------------------------
// WS13 — PAYMENT CORE: the pluggable per-merchant BYO-key payment abstraction.
//
// This is a PURE logic module (interface + shared types + tiny pure helpers +
// the two concrete providers' network I/O) — NO Nest decorators, NO framework
// error classes. It mirrors `clickdz-courier.ts` (the courier core) one-for-one
// so the payment controller can clone the courier controller's discipline: a
// fail-soft `PaymentResult<T>` discriminated union (never throw, never leak a
// merchant's secret key), a registry of providers keyed by id, and per-provider
// credential shapes.
//
// Unlike couriers (which self-register from separate files) the two payment
// providers are small enough to live in THIS file and register at module load,
// so importing this module makes both `slickpay` and `stripe` resolvable via
// `getPaymentProvider(id)`.
//
// WHY BYO-key: each merchant pastes THEIR OWN gateway keys (SlickPay PUBLIC_KEY
// / Stripe sk_). The controller seals them (clickdz-secret-box.ts) before Redis
// and unseals only inside an owner-gated route — the exact courier model. This
// module never seals/opens/persists a key; a provider receives the already
// unsealed `PaymentCredentials` and must never echo/log a secret.
//
// FAIL-SOFT CONTRACT (pinned, identical to CourierResult): every network method
// resolves `PaymentResult<T>` — { ok:true, value } on success, or a TYPED error
// { ok:false, error, status?, retryAfter? } on ANY failure (network, timeout,
// non-2xx, rate-limit, malformed body). NEVER a raw throw; NEVER a secret in the
// payload. The controller maps the typed error to a clean HTTP body.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Provider identity. The registry key + the credential record's authoritative
// `provider` field. `slickpay` (Algerian, SATIM-backed) + `stripe` (BYO sk_).
// ---------------------------------------------------------------------------
export const PAYMENT_PROVIDERS = ['slickpay', 'stripe'] as const;
export type PaymentProviderId = (typeof PAYMENT_PROVIDERS)[number];

/** Type guard: a caller-supplied string is a known payment provider id. */
export function isPaymentProviderId(v: unknown): v is PaymentProviderId {
  return (
    typeof v === 'string' &&
    (PAYMENT_PROVIDERS as readonly string[]).includes(v)
  );
}

// ---------------------------------------------------------------------------
// Credentials. The UNSEALED per-merchant keys a provider sends on every call.
// Resolved ONLY inside an owner-gated route (openSecret on the sealed record)
// and passed straight into a provider call — this module never seals/opens/
// persists them, and a provider must never echo them back or log them.
//
//   · SlickPay: `secretKey` = the merchant's PUBLIC_KEY (used as a Bearer token
//     on every SlickPay call). `mode` picks the sandbox vs prod base URL.
//   · Stripe: `secretKey` = the merchant's `sk_…` (server-only). `publishableKey`
//     = the merchant's `pk_…` (safe to surface to the FE). `webhookSecret` is
//     the optional signing secret used to verify the Stripe-Signature header.
// ---------------------------------------------------------------------------
export interface PaymentCredentials {
  /** The server-only secret. SlickPay: the PUBLIC_KEY (Bearer). Stripe: sk_. */
  secretKey: string;
  /** Stripe publishable key (pk_) — safe to return to the FE. Optional. */
  publishableKey?: string;
  /** Stripe webhook signing secret (whsec_) — for Stripe-Signature verify. */
  webhookSecret?: string;
  /** SlickPay environment: 'sandbox' | 'prod'. Ignored by Stripe. */
  mode?: PaymentMode;
}

/** SlickPay environment selector (also stored on the cred record). */
export type PaymentMode = 'sandbox' | 'prod';

export function isPaymentMode(v: unknown): v is PaymentMode {
  return v === 'sandbox' || v === 'prod';
}

// ---------------------------------------------------------------------------
// Checkout. `CheckoutInput` is the provider-agnostic order shape the caller
// assembles from an order record; a provider maps it onto its own API. Amounts
// are in DZD/currency MINOR units where the provider needs them (Stripe), or the
// provider's own unit (SlickPay invoices take a decimal amount) — each provider
// converts internally. `CheckoutResult` is the normalized outcome: a payUrl to
// redirect the customer to, plus the provider's own payment id (persisted so
// `getPaymentStatus` + the webhook can correlate).
// ---------------------------------------------------------------------------

/** One line item for the checkout (name + unit price + quantity). */
export interface CheckoutItem {
  name: string;
  /** Unit price in the smallest sane unit for the provider (see amount note). */
  price: number;
  quantity: number;
}

/** The provider-agnostic checkout to create (assembled from an order record). */
export interface CheckoutInput {
  /** Merchant's order reference — echoed back so the caller can correlate. */
  orderId: string;
  /** Total amount to charge. Integer, non-negative. Currency minor units. */
  amount: number;
  /** ISO 4217 currency (default 'dzd' for SlickPay; Stripe honors it). */
  currency: string;
  /** Line items (optional; a provider falls back to a single amount line). */
  items: CheckoutItem[];
  /** Where the customer returns after paying (success + cancel share it). */
  returnUrl: string;
}

/** The normalized result of a successful checkout create. */
export interface CheckoutResult {
  /** The gateway's hosted-payment URL (redirect the customer here). */
  payUrl: string;
  /** The gateway's own payment/session id (persisted for status/webhook). */
  paymentId: string;
}

// ---------------------------------------------------------------------------
// Payment status. Collapsed to a tiny closed set the order UI keys off, exactly
// like the courier sub-states. Unknown ⇒ 'pending' (never spuriously 'paid').
// ---------------------------------------------------------------------------
export const PAYMENT_STATUSES = ['paid', 'unpaid', 'pending'] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export function isPaymentStatus(v: unknown): v is PaymentStatus {
  return v === 'paid' || v === 'unpaid' || v === 'pending';
}

// ---------------------------------------------------------------------------
// Typed error + result union. The FAIL-SOFT contract every provider method
// obeys: resolve `PaymentResult<T>`, never throw. `error` is a small closed set
// the controller maps to HTTP (byte-identical mapping intent to CourierError):
//   'rate_limited'    → 429 upstream (Retry-After surfaced in `retryAfter`)
//   'unauthorized'    → bad/absent merchant key (401/403 from the gateway)
//   'not_found'       → 404 from the gateway (unknown payment, etc.)
//   'bad_request'     → 400 from the gateway (validation) — carries `status`
//   'unreachable'     → network/timeout/abort (no HTTP response)
//   'upstream_error'  → any other non-2xx (carries the numeric `status`)
//   'malformed'       → 2xx but the body could not be parsed/shaped
// NONE of these ever carry secret material.
// ---------------------------------------------------------------------------
export type PaymentErrorCode =
  | 'rate_limited'
  | 'unauthorized'
  | 'not_found'
  | 'bad_request'
  | 'unreachable'
  | 'upstream_error'
  | 'malformed';

/** A typed provider failure (never thrown — always returned). */
export interface PaymentError {
  ok: false;
  error: PaymentErrorCode;
  /** The upstream HTTP status when there was an HTTP response. */
  status?: number;
  /** Seconds to wait, parsed from a 429 Retry-After header, when present. */
  retryAfter?: number;
  /** A short, SECRET-FREE upstream message (safe to surface/log). */
  message?: string;
}

/** Success wrapper. */
export interface PaymentOk<T> {
  ok: true;
  value: T;
}

/** The fail-soft result every provider method resolves. */
export type PaymentResult<T> = PaymentOk<T> | PaymentError;

/** Tiny constructors so providers stay terse + consistent. */
export function paymentOk<T>(value: T): PaymentOk<T> {
  return { ok: true, value };
}
export function paymentErr(
  error: PaymentErrorCode,
  extra?: { status?: number; retryAfter?: number; message?: string }
): PaymentError {
  const e: PaymentError = { ok: false, error };
  if (extra?.status !== undefined) e.status = extra.status;
  if (extra?.retryAfter !== undefined) e.retryAfter = extra.retryAfter;
  if (extra?.message !== undefined) e.message = extra.message;
  return e;
}

/**
 * Map a raw HTTP status → a PaymentErrorCode (shared by both providers so the
 * error mapping stays consistent). 429 → rate_limited; 401/403 → unauthorized;
 * 404 → not_found; 400/422 → bad_request; anything else non-2xx → upstream_error.
 */
export function statusToPaymentError(status: number): PaymentErrorCode {
  if (status === 429) return 'rate_limited';
  if (status === 401 || status === 403) return 'unauthorized';
  if (status === 404) return 'not_found';
  if (status === 400 || status === 422) return 'bad_request';
  return 'upstream_error';
}

// ---------------------------------------------------------------------------
// THE PROVIDER CONTRACT. A payment integration implements this. Every network
// method resolves a fail-soft `PaymentResult<T>` (never throws, never leaks a
// key). `creds` is the unsealed set, resolved + passed by the owner-gated
// controller. `verifyWebhook` is SYNC + pure (HMAC/signature check, no I/O) and
// optional — SlickPay has no strong webhook (the controller re-checks status on
// the return URL instead); Stripe implements it (Stripe-Signature).
// ---------------------------------------------------------------------------
export interface PaymentProvider {
  /** The provider id — matches the credential record's `provider` field. */
  readonly id: PaymentProviderId;

  /**
   * Whether this provider needs a publishable key alongside the secret. `true`
   * (Stripe: sk_ + pk_) ⇒ the connect route requires + seals both. `false`
   * (SlickPay: a single PUBLIC_KEY) ⇒ only the secret is required.
   */
  readonly requiresPublishableKey: boolean;

  /**
   * A cheap live call the connect route uses to VALIDATE pasted keys before
   * sealing them (SlickPay: list invoices; Stripe: retrieve balance). Returns ok
   * on valid creds, a typed error (incl. 'unauthorized' on a bad key) otherwise.
   */
  validate(creds: PaymentCredentials): Promise<PaymentResult<true>>;

  /** Create a hosted checkout → { payUrl, paymentId }. */
  createCheckout(
    creds: PaymentCredentials,
    input: CheckoutInput
  ): Promise<PaymentResult<CheckoutResult>>;

  /** Look up a payment's current status by the provider's own payment id. */
  getPaymentStatus(
    creds: PaymentCredentials,
    paymentId: string
  ): Promise<PaymentResult<PaymentStatus>>;

  /**
   * OPTIONAL — verify a signed webhook. SYNC + pure (HMAC over the raw bytes, no
   * network). Returns the resolved event { paymentId, status } on a valid
   * signature, or null on ANY failure (bad/absent signature, malformed body).
   * A provider without a strong webhook (SlickPay) omits this and the controller
   * answers a typed 'webhook_unsupported' + re-checks status on return.
   */
  verifyWebhook?(
    creds: PaymentCredentials,
    rawBody: Buffer,
    signatureHeader: string
  ): WebhookEvent | null;
}

/** The normalized outcome of a verified webhook. */
export interface WebhookEvent {
  /** The provider's payment/session id the event refers to. */
  paymentId: string;
  /** The normalized status the event conveys. */
  status: PaymentStatus;
}

// ---------------------------------------------------------------------------
// PROVIDER REGISTRY. `getPaymentProvider(id)` resolves the concrete singleton
// for a provider id, or null. The credential record's `provider` field is
// authoritative; the controller calls this to pick the impl. Registration
// happens at THIS module's load (the two impls below call registerPaymentProvider).
// ---------------------------------------------------------------------------
const REGISTRY = new Map<PaymentProviderId, PaymentProvider>();

/** Register a concrete provider impl (called once at module load). */
export function registerPaymentProvider(provider: PaymentProvider): void {
  if (provider && isPaymentProviderId(provider.id)) {
    REGISTRY.set(provider.id, provider);
  }
}

/** Resolve the provider for an id, or null when unknown. */
export function getPaymentProvider(id: unknown): PaymentProvider | null {
  if (!isPaymentProviderId(id)) return null;
  return REGISTRY.get(id) ?? null;
}

// ---------------------------------------------------------------------------
// Shared network helpers (pure, fail-soft). A bounded fetch with a JSON parse
// that never throws — providers use these so the error mapping is uniform.
// ---------------------------------------------------------------------------

/** Per-request timeout for a gateway call — quick control-plane calls. */
const PAYMENT_TIMEOUT_MS = 15_000;

/** A parsed HTTP outcome, or null on a network/timeout error (no response). */
interface HttpOutcome {
  status: number;
  body: any;
}

/**
 * Fetch + parse JSON, fail-soft. Returns null on a network/timeout/abort (no
 * HTTP response) so a provider maps it to 'unreachable'; otherwise the status +
 * parsed body (body = {} when the response has no/again-unparseable JSON).
 * NEVER throws. The caller must NOT log `init.headers` (they carry the key).
 */
async function httpJson(
  url: string,
  init: RequestInit
): Promise<HttpOutcome | null> {
  try {
    const res = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(PAYMENT_TIMEOUT_MS),
    });
    const body = (await res.json().catch(() => ({}))) as any;
    return { status: res.status, body };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// SLICKPAY PROVIDER (Algerian, SATIM-backed). Auth: `Authorization: Bearer
// {PUBLIC_KEY}` on every call. Bases: sandbox devapi / prod prodapi (v2).
//   · Create invoice: POST /users/invoices { amount, url, items:[{name,price,
//     quantity}] } → data.url = the SATIM payment URL (redirect customer there);
//     data.id = the invoice id (persisted as paymentId).
//   · Check status: GET /users/invoices/{id} → data.payment_status ('paid'|…).
//   · No strong webhook — the controller re-checks status on the return URL, so
//     verifyWebhook is intentionally omitted.
// ---------------------------------------------------------------------------
const SLICKPAY_BASE: Record<PaymentMode, string> = {
  sandbox: 'https://devapi.slick-pay.com/api/v2',
  prod: 'https://prodapi.slick-pay.com/api/v2',
};

function slickpayBase(mode: PaymentMode | undefined): string {
  return SLICKPAY_BASE[mode === 'prod' ? 'prod' : 'sandbox'];
}

/** Loose string read: null/undefined → ''. */
function s(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}

const slickpayProvider: PaymentProvider = {
  id: 'slickpay',
  requiresPublishableKey: false,

  async validate(creds) {
    // Cheap live call: list the merchant's invoices. A 200/2xx (even an empty
    // list) proves the PUBLIC_KEY is accepted; a 401/403 ⇒ unauthorized.
    const out = await httpJson(`${slickpayBase(creds.mode)}/users/invoices`, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${creds.secretKey}`,
        accept: 'application/json',
      },
    });
    if (!out) return paymentErr('unreachable');
    if (out.status < 200 || out.status >= 300) {
      return paymentErr(statusToPaymentError(out.status), {
        status: out.status,
      });
    }
    return paymentOk(true);
  },

  async createCheckout(creds, input) {
    // SlickPay invoices take a decimal amount in the account currency; the
    // caller passes an integer minor-unit amount, but DZD has no minor unit in
    // practice for SATIM invoices, so we send the amount as-is (integer DZD).
    const items = (input.items || []).map(it => ({
      name: s(it.name).slice(0, 120) || 'Article',
      price: Math.max(0, Math.round(Number(it.price) || 0)),
      quantity: Math.max(1, Math.round(Number(it.quantity) || 1)),
    }));
    const payload: Record<string, unknown> = {
      amount: Math.max(0, Math.round(input.amount)),
      url: input.returnUrl,
    };
    if (items.length) payload.items = items;
    const out = await httpJson(`${slickpayBase(creds.mode)}/users/invoices`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${creds.secretKey}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify(payload),
    });
    if (!out) return paymentErr('unreachable');
    if (out.status < 200 || out.status >= 300) {
      return paymentErr(statusToPaymentError(out.status), {
        status: out.status,
      });
    }
    // Success shape: { success, data: { id, url, ... } } (SlickPay wraps in data).
    const data = (out.body && (out.body.data ?? out.body)) || {};
    const payUrl = s(data.url);
    const paymentId = s(data.id) || s(data.invoice) || s(data.uuid);
    if (!payUrl || !paymentId) return paymentErr('malformed');
    return paymentOk({ payUrl, paymentId });
  },

  async getPaymentStatus(creds, paymentId) {
    const out = await httpJson(
      `${slickpayBase(creds.mode)}/users/invoices/${encodeURIComponent(
        paymentId
      )}`,
      {
        method: 'GET',
        headers: {
          authorization: `Bearer ${creds.secretKey}`,
          accept: 'application/json',
        },
      }
    );
    if (!out) return paymentErr('unreachable');
    if (out.status < 200 || out.status >= 300) {
      return paymentErr(statusToPaymentError(out.status), {
        status: out.status,
      });
    }
    const data = (out.body && (out.body.data ?? out.body)) || {};
    const raw = s(data.payment_status || data.status).toLowerCase();
    // SlickPay reports 'paid' | 'unpaid'; anything else ⇒ pending (safe default).
    const status: PaymentStatus =
      raw === 'paid' ? 'paid' : raw === 'unpaid' ? 'unpaid' : 'pending';
    return paymentOk(status);
  },
  // No verifyWebhook — SlickPay has no strong webhook; the controller re-checks
  // status on the return URL (getPaymentStatus) instead.
};
registerPaymentProvider(slickpayProvider);

// ---------------------------------------------------------------------------
// STRIPE PROVIDER (BYO merchant sk_). Uses the `stripe` SDK (already a backend
// dependency — it also backs AFFiNE's own billing; we instantiate a FRESH client
// per call with the MERCHANT's key, never the platform key).
//   · Validate: stripe.balance.retrieve() — cheapest authenticated read.
//   · Checkout: stripe.checkout.sessions.create({ mode:'payment', line_items,
//     success_url, cancel_url }) → session.url + session.id.
//   · Status: stripe.checkout.sessions.retrieve(id) → payment_status.
//   · Webhook: stripe.webhooks.constructEvent(raw, sig, whsec) — but we avoid a
//     hard SDK dependency in the pure path by verifying the Stripe-Signature
//     HMAC ourselves (constant-time) so verifyWebhook stays sync + pure.
// The SDK is required LAZILY inside each method (never at module load) so this
// pure module stays boot-safe even if the dep is somehow absent — a load failure
// degrades to a typed 'unreachable', never a boot crash.
// ---------------------------------------------------------------------------

/** Lazily construct a merchant-scoped Stripe client; null on any failure. */
function stripeClient(secretKey: string): any | null {
  if (!secretKey) return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Stripe = require('stripe');
    const ctor = Stripe && (Stripe.default || Stripe);
    return new ctor(secretKey);
  } catch {
    return null;
  }
}

/** Map a thrown Stripe error → a typed PaymentError (never re-throws). */
function stripeErr(e: any): PaymentError {
  const status = typeof e?.statusCode === 'number' ? e.statusCode : undefined;
  if (e?.type === 'StripeAuthenticationError') {
    return paymentErr('unauthorized', status !== undefined ? { status } : undefined);
  }
  if (status !== undefined) {
    return paymentErr(statusToPaymentError(status), { status });
  }
  return paymentErr('unreachable');
}

const stripeProvider: PaymentProvider = {
  id: 'stripe',
  requiresPublishableKey: true,

  async validate(creds) {
    const client = stripeClient(creds.secretKey);
    if (!client) return paymentErr('unreachable');
    try {
      await client.balance.retrieve();
      return paymentOk(true);
    } catch (e) {
      return stripeErr(e);
    }
  },

  async createCheckout(creds, input) {
    const client = stripeClient(creds.secretKey);
    if (!client) return paymentErr('unreachable');
    const currency = (input.currency || 'usd').toLowerCase();
    // Build line_items from the checkout items; fall back to one amount line.
    const lineItems =
      input.items && input.items.length
        ? input.items.map(it => ({
            price_data: {
              currency,
              product_data: { name: s(it.name).slice(0, 120) || 'Article' },
              unit_amount: Math.max(0, Math.round(Number(it.price) || 0)),
            },
            quantity: Math.max(1, Math.round(Number(it.quantity) || 1)),
          }))
        : [
            {
              price_data: {
                currency,
                product_data: { name: `Commande ${input.orderId}` },
                unit_amount: Math.max(0, Math.round(input.amount)),
              },
              quantity: 1,
            },
          ];
    try {
      const session = await client.checkout.sessions.create({
        mode: 'payment',
        line_items: lineItems,
        success_url: input.returnUrl,
        cancel_url: input.returnUrl,
        client_reference_id: input.orderId,
      });
      const payUrl = s(session?.url);
      const paymentId = s(session?.id);
      if (!payUrl || !paymentId) return paymentErr('malformed');
      return paymentOk({ payUrl, paymentId });
    } catch (e) {
      return stripeErr(e);
    }
  },

  async getPaymentStatus(creds, paymentId) {
    const client = stripeClient(creds.secretKey);
    if (!client) return paymentErr('unreachable');
    try {
      const session = await client.checkout.sessions.retrieve(paymentId);
      const raw = s(session?.payment_status).toLowerCase();
      // Stripe: 'paid' | 'unpaid' | 'no_payment_required'. Map to our tri-state.
      const status: PaymentStatus =
        raw === 'paid' || raw === 'no_payment_required'
          ? 'paid'
          : raw === 'unpaid'
            ? 'unpaid'
            : 'pending';
      return paymentOk(status);
    } catch (e) {
      return stripeErr(e);
    }
  },

  verifyWebhook(creds, rawBody, signatureHeader) {
    // Verify the Stripe-Signature header ourselves (sync + pure, no SDK) so the
    // pure module never does I/O in this path. Header format:
    //   t=<ts>,v1=<hex-hmac>,v0=<...>
    // signed_payload = `${t}.${rawBody}`; expected = HMAC-SHA256(whsec, payload).
    const whsec = creds.webhookSecret || '';
    if (!whsec || !rawBody || !rawBody.length || !signatureHeader) return null;
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { createHmac, timingSafeEqual } = require('node:crypto');
      const parts = signatureHeader.split(',');
      let ts = '';
      const v1: string[] = [];
      for (const p of parts) {
        const [k, v] = p.split('=');
        if (k === 't') ts = v;
        else if (k === 'v1' && v) v1.push(v);
      }
      if (!ts || !v1.length) return null;
      const signedPayload = `${ts}.${rawBody.toString('utf8')}`;
      const expected = createHmac('sha256', whsec)
        .update(signedPayload, 'utf8')
        .digest('hex');
      const expBuf = Buffer.from(expected, 'utf8');
      const matched = v1.some(candidate => {
        try {
          const candBuf = Buffer.from(candidate, 'utf8');
          return (
            candBuf.length === expBuf.length && timingSafeEqual(candBuf, expBuf)
          );
        } catch {
          return false;
        }
      });
      if (!matched) return null;
      // Signature valid — parse the event body for the session + its status.
      const event = JSON.parse(rawBody.toString('utf8')) as any;
      const obj = event?.data?.object || {};
      const paymentId = s(obj.id);
      if (!paymentId) return null;
      const evtType = s(event?.type);
      const rawStatus = s(obj.payment_status).toLowerCase();
      const status: PaymentStatus =
        evtType === 'checkout.session.completed' ||
        rawStatus === 'paid' ||
        rawStatus === 'no_payment_required'
          ? 'paid'
          : rawStatus === 'unpaid'
            ? 'unpaid'
            : 'pending';
      return { paymentId, status };
    } catch {
      return null;
    }
  },
};
registerPaymentProvider(stripeProvider);
