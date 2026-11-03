// Server-only PayPal REST client (fetch, no SDK). Sandbox by default, see config.ts.
// - OAuth token cached in memory and refreshed before expiry; concurrent callers share one request.
// - Retries with exponential backoff on 429, 5xx and network errors (Retry-After respected).
// - Every POST carries a PayPal-Request-Id that stays the same across retries (idempotency).
// - Responses are validated with zod. Secrets and tokens never appear in errors.

import "server-only";
import type { z } from "zod";
import { loadPayPalConfig, type PayPalConfig } from "./config";
import type { PayPalMoney } from "./money";
import {
  CaptureRefundSchema,
  DisputeListSchema,
  DisputeSchema,
  InvoiceNumberSchema,
  InvoiceSchema,
  RecordPaymentResponseSchema,
  RecordRefundResponseSchema,
  SearchInvoicesSchema,
  SendInvoiceResponseSchema,
  TokenResponseSchema,
  VerifySignatureResponseSchema,
  type PayPalCaptureRefund,
  type PayPalDispute,
  type PayPalInvoice,
} from "./schemas";

export class PayPalApiError extends Error {
  readonly status: number;
  readonly debugId?: string;
  readonly issue?: string;
  constructor(message: string, status: number, debugId?: string, issue?: string) {
    super(message);
    this.name = "PayPalApiError";
    this.status = status;
    this.debugId = debugId;
    this.issue = issue;
  }
}

export class PayPalSchemaError extends Error {
  constructor(path: string, detail: string) {
    super(`Unexpected PayPal response shape for ${path}: ${detail}`);
    this.name = "PayPalSchemaError";
  }
}

export interface PayPalClientOptions {
  config: PayPalConfig;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  random?: () => number;
  newRequestId?: () => string;
  /** Retries after the first attempt (default 3). */
  maxRetries?: number;
  /** Base backoff in ms (default 300). */
  backoffBaseMs?: number;
}

export interface PostOptions {
  /** Stable idempotency key, e.g. the approved step id. Defaults to a random UUID per logical call. */
  requestId?: string;
}

export interface VerifyWebhookSignatureInput {
  authAlgo: string;
  certUrl: string;
  transmissionId: string;
  transmissionSig: string;
  transmissionTime: string;
  webhookId: string;
  webhookEvent: unknown;
}

const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_RETRY_AFTER_MS = 30_000;

function safeId(id: string, what: string): string {
  if (!ID_RE.test(id)) throw new RangeError(`Invalid ${what}: ${JSON.stringify(id).slice(0, 40)}`);
  return encodeURIComponent(id);
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

interface RequestSpec<S extends z.ZodType> {
  method: "GET" | "POST";
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  schema: S | null;
  requestId?: string;
  headers?: Record<string, string>;
}

export class PayPalClient {
  private readonly cfg: PayPalConfig;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly newRequestId: () => string;
  private readonly maxRetries: number;
  private readonly backoffBaseMs: number;
  private token: { value: string; refreshAt: number } | null = null;
  private tokenInflight: Promise<string> | null = null;

  constructor(opts: PayPalClientOptions) {
    this.cfg = opts.config;
    this.fetchImpl = opts.fetch ?? fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = opts.now ?? Date.now;
    this.random = opts.random ?? Math.random;
    this.newRequestId = opts.newRequestId ?? (() => crypto.randomUUID());
    this.maxRetries = opts.maxRetries ?? 3;
    this.backoffBaseMs = opts.backoffBaseMs ?? 300;
  }

  get env() {
    return this.cfg.env;
  }

  // ---------------------------------------------------------------- auth

  async getAccessToken(): Promise<string> {
    if (this.token && this.now() < this.token.refreshAt) return this.token.value;
    if (!this.tokenInflight) {
      this.tokenInflight = this.fetchToken().finally(() => {
        this.tokenInflight = null;
      });
    }
    return this.tokenInflight;
  }

  /** Drops the cached token (used after a 401). */
  invalidateToken(): void {
    this.token = null;
  }

  private async fetchToken(): Promise<string> {
    const basic = Buffer.from(`${this.cfg.clientId}:${this.cfg.clientSecret}`).toString("base64");
    const res = await this.withRetries("/v1/oauth2/token", () =>
      this.fetchImpl(`${this.cfg.baseUrl}/v1/oauth2/token`, {
        method: "POST",
        headers: {
          Authorization: `Basic ${basic}`,
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: "grant_type=client_credentials",
        cache: "no-store",
      }),
    );
    if (!res.ok) throw await this.toApiError(res, "/v1/oauth2/token");
    const parsed = TokenResponseSchema.safeParse(await res.json().catch(() => null));
    if (!parsed.success) throw new PayPalSchemaError("/v1/oauth2/token", "token response invalid");
    const lifetimeMs = parsed.data.expires_in * 1000;
    // Refresh early: 10 percent of the lifetime, at most 5 minutes.
    const margin = Math.min(300_000, Math.floor(lifetimeMs * 0.1));
    this.token = { value: parsed.data.access_token, refreshAt: this.now() + lifetimeMs - margin };
    return parsed.data.access_token;
  }

  // ---------------------------------------------------------------- transport

  private async withRetries(path: string, send: () => Promise<Response>): Promise<Response> {
    let attempt = 0;
    for (;;) {
      let res: Response | null = null;
      let networkError: unknown = null;
      try {
        res = await send();
      } catch (err) {
        networkError = err;
      }
      const retryable = networkError !== null || (res !== null && isRetryableStatus(res.status));
      if (!retryable || attempt >= this.maxRetries) {
        if (networkError !== null) {
          throw new PayPalApiError(`Network error calling PayPal ${path}`, 0);
        }
        return res as Response;
      }
      await this.sleep(this.backoffDelay(attempt, res));
      attempt++;
    }
  }

  private backoffDelay(attempt: number, res: Response | null): number {
    const ra = res?.headers.get("retry-after");
    if (ra && /^\d+$/.test(ra)) return Math.min(Number(ra) * 1000, MAX_RETRY_AFTER_MS);
    return this.backoffBaseMs * 2 ** attempt + Math.floor(this.random() * 100);
  }

  private async toApiError(res: Response, path: string): Promise<PayPalApiError> {
    let name: string | undefined;
    let message: string | undefined;
    let debugId: string | undefined;
    let issue: string | undefined;
    try {
      const body = (await res.json()) as Record<string, unknown>;
      name = typeof body.name === "string" ? body.name : typeof body.error === "string" ? body.error : undefined;
      message = typeof body.message === "string" ? body.message : undefined;
      debugId = typeof body.debug_id === "string" ? body.debug_id : undefined;
      const details = Array.isArray(body.details) ? (body.details as Record<string, unknown>[]) : [];
      issue = typeof details[0]?.issue === "string" ? (details[0].issue as string) : undefined;
    } catch {
      // body not JSON; keep generic message
    }
    const parts = [`PayPal ${path} failed with HTTP ${res.status}`, name, message, issue].filter(Boolean);
    return new PayPalApiError(parts.join(": "), res.status, debugId ?? res.headers.get("paypal-debug-id") ?? undefined, issue);
  }

  private async request<S extends z.ZodType>(spec: RequestSpec<S>): Promise<z.infer<S> | null> {
    const url = new URL(this.cfg.baseUrl + spec.path);
    for (const [k, v] of Object.entries(spec.query ?? {})) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
    // One request id per logical call, reused by every retry.
    const requestId = spec.method === "POST" ? (spec.requestId ?? this.newRequestId()) : undefined;
    const bodyText = spec.body === undefined ? undefined : JSON.stringify(spec.body);

    let authRetried = false;
    for (;;) {
      const token = await this.getAccessToken();
      const headers: Record<string, string> = {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        ...(spec.headers ?? {}),
      };
      if (bodyText !== undefined) headers["Content-Type"] = "application/json";
      if (requestId) headers["PayPal-Request-Id"] = requestId;

      const res = await this.withRetries(spec.path, () =>
        this.fetchImpl(url.toString(), { method: spec.method, headers, body: bodyText, cache: "no-store" }),
      );

      if (res.status === 401 && !authRetried) {
        authRetried = true;
        this.invalidateToken();
        continue;
      }
      if (!res.ok) throw await this.toApiError(res, spec.path);

      const text = await res.text();
      if (spec.schema === null) return null;
      let json: unknown = null;
      if (text.length > 0) {
        try {
          json = JSON.parse(text);
        } catch {
          throw new PayPalSchemaError(spec.path, "response is not JSON");
        }
      }
      const parsed = spec.schema.safeParse(json);
      if (!parsed.success) {
        throw new PayPalSchemaError(spec.path, parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
      }
      return parsed.data;
    }
  }

  private async requestData<S extends z.ZodType>(spec: RequestSpec<S>): Promise<z.infer<S>> {
    const out = await this.request(spec);
    if (out === null) throw new PayPalSchemaError(spec.path, "empty response");
    return out;
  }

  // ---------------------------------------------------------------- invoicing

  async generateNextInvoiceNumber(opts: PostOptions = {}): Promise<string> {
    const r = await this.requestData({
      method: "POST",
      path: "/v2/invoicing/generate-next-invoice-number",
      schema: InvoiceNumberSchema,
      requestId: opts.requestId,
    });
    return r.invoice_number;
  }

  /** Creates a draft invoice. Returns the full representation. */
  async createInvoice(body: Record<string, unknown>, opts: PostOptions = {}): Promise<PayPalInvoice> {
    return this.requestData({
      method: "POST",
      path: "/v2/invoicing/invoices",
      body,
      schema: InvoiceSchema,
      requestId: opts.requestId,
      headers: { Prefer: "return=representation" },
    });
  }

  async sendInvoice(
    invoiceId: string,
    body: { send_to_invoicer?: boolean; send_to_recipient?: boolean; subject?: string; note?: string } = {},
    opts: PostOptions = {},
  ): Promise<void> {
    await this.request({
      method: "POST",
      path: `/v2/invoicing/invoices/${safeId(invoiceId, "invoice id")}/send`,
      body,
      schema: SendInvoiceResponseSchema,
      requestId: opts.requestId,
    });
  }

  async getInvoice(invoiceId: string): Promise<PayPalInvoice> {
    return this.requestData({
      method: "GET",
      path: `/v2/invoicing/invoices/${safeId(invoiceId, "invoice id")}`,
      schema: InvoiceSchema,
    });
  }

  /** Sandbox limit: 2 reminders per day per API caller. Quota is enforced by the caller (api_quota). */
  async remindInvoice(
    invoiceId: string,
    body: { subject?: string; note?: string; send_to_invoicer?: boolean } = {},
    opts: PostOptions = {},
  ): Promise<void> {
    await this.request({
      method: "POST",
      path: `/v2/invoicing/invoices/${safeId(invoiceId, "invoice id")}/remind`,
      body,
      schema: null,
      requestId: opts.requestId,
    });
  }

  async recordPayment(
    invoiceId: string,
    body: { method: string; payment_date: string; amount: PayPalMoney; note?: string },
    opts: PostOptions = {},
  ): Promise<string> {
    const r = await this.requestData({
      method: "POST",
      path: `/v2/invoicing/invoices/${safeId(invoiceId, "invoice id")}/payments`,
      body,
      schema: RecordPaymentResponseSchema,
      requestId: opts.requestId,
    });
    return r.payment_id;
  }

  async recordRefund(
    invoiceId: string,
    body: { method: string; refund_date: string; amount: PayPalMoney },
    opts: PostOptions = {},
  ): Promise<string> {
    const r = await this.requestData({
      method: "POST",
      path: `/v2/invoicing/invoices/${safeId(invoiceId, "invoice id")}/refunds`,
      body,
      schema: RecordRefundResponseSchema,
      requestId: opts.requestId,
    });
    return r.refund_id;
  }

  async cancelInvoice(
    invoiceId: string,
    body: { subject?: string; note?: string; send_to_invoicer?: boolean; send_to_recipient?: boolean } = {},
    opts: PostOptions = {},
  ): Promise<void> {
    await this.request({
      method: "POST",
      path: `/v2/invoicing/invoices/${safeId(invoiceId, "invoice id")}/cancel`,
      body,
      schema: null,
      requestId: opts.requestId,
    });
  }

  async searchInvoices(
    criteria: Record<string, unknown>,
    page: { page?: number; pageSize?: number } = {},
    opts: PostOptions = {},
  ) {
    return this.requestData({
      method: "POST",
      path: "/v2/invoicing/search-invoices",
      query: { page: page.page ?? 1, page_size: page.pageSize ?? 20, total_required: true },
      body: criteria,
      schema: SearchInvoicesSchema,
      requestId: opts.requestId,
    });
  }

  // ---------------------------------------------------------------- disputes and payments (read)

  async listDisputes(params: { start_time?: string; disputed_transaction_id?: string; page_size?: number; next_page_token?: string } = {}) {
    return this.requestData({ method: "GET", path: "/v1/customer/disputes", query: params, schema: DisputeListSchema });
  }

  async getDispute(disputeId: string): Promise<PayPalDispute> {
    return this.requestData({
      method: "GET",
      path: `/v1/customer/disputes/${safeId(disputeId, "dispute id")}`,
      schema: DisputeSchema,
    });
  }

  async getCaptureRefund(refundId: string): Promise<PayPalCaptureRefund> {
    return this.requestData({
      method: "GET",
      path: `/v2/payments/refunds/${safeId(refundId, "refund id")}`,
      schema: CaptureRefundSchema,
    });
  }

  // ---------------------------------------------------------------- webhooks

  async verifyWebhookSignature(input: VerifyWebhookSignatureInput): Promise<boolean> {
    const r = await this.requestData({
      method: "POST",
      path: "/v1/notifications/verify-webhook-signature",
      body: {
        auth_algo: input.authAlgo,
        cert_url: input.certUrl,
        transmission_id: input.transmissionId,
        transmission_sig: input.transmissionSig,
        transmission_time: input.transmissionTime,
        webhook_id: input.webhookId,
        webhook_event: input.webhookEvent,
      },
      schema: VerifySignatureResponseSchema,
    });
    return r.verification_status === "SUCCESS";
  }
}

let shared: PayPalClient | null = null;

/** Process-wide client built from env (so the token cache is shared within one server instance). */
export function getPayPalClient(): PayPalClient {
  if (!shared) shared = new PayPalClient({ config: loadPayPalConfig() });
  return shared;
}
