import { describe, expect, it } from "vitest";
import { PayPalApiError, PayPalClient, PayPalSchemaError } from "./client";
import { PAYPAL_BASE_URLS, loadPayPalConfig, resolvePayPalEnv } from "./config";
import { centsToMoney, moneyToCents } from "./money";

// Obviously fake test credentials.
const CFG = { env: "sandbox" as const, baseUrl: PAYPAL_BASE_URLS.sandbox, clientId: "test-client-id", clientSecret: "test-client-secret" };

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

type Handler = (call: Call) => Response | Promise<Response>;

function mockFetch(handlers: Handler[]) {
  const calls: Call[] = [];
  let i = 0;
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? "GET",
      headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)),
      body: typeof init?.body === "string" ? init.body : undefined,
    };
    calls.push(call);
    const h = handlers[Math.min(i++, handlers.length - 1)];
    return h(call);
  }) as typeof fetch;
  return { fn, calls };
}

const jsonRes = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

const token = (expiresIn = 32400, value = "tok-1") => () => jsonRes(200, { access_token: value, token_type: "Bearer", expires_in: expiresIn });

const INVOICE = {
  id: "INV2-AAAA-BBBB",
  status: "SENT",
  amount: { currency_code: "EUR", value: "1000.00" },
  due_amount: { currency_code: "EUR", value: "1000.00" },
};

function client(handlers: Handler[], extra: Partial<ConstructorParameters<typeof PayPalClient>[0]> = {}) {
  const f = mockFetch(handlers);
  const sleeps: number[] = [];
  let clock = 1_000_000;
  let n = 0;
  const c = new PayPalClient({
    config: CFG,
    fetch: f.fn,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    now: () => clock,
    random: () => 0,
    newRequestId: () => `req-${++n}`,
    ...extra,
  });
  return { c, calls: f.calls, sleeps, advance: (ms: number) => (clock += ms) };
}

describe("config", () => {
  it("defaults to sandbox", () => {
    expect(resolvePayPalEnv({})).toBe("sandbox");
    expect(resolvePayPalEnv({ PAYPAL_ENV: "" })).toBe("sandbox");
    expect(loadPayPalConfig({ PAYPAL_CLIENT_ID: "a", PAYPAL_CLIENT_SECRET: "b" }).baseUrl).toBe("https://api-m.sandbox.paypal.com");
  });
  it("throws on anything other than sandbox or live", () => {
    expect(() => resolvePayPalEnv({ PAYPAL_ENV: "production" })).toThrow(/sandbox" or "live/);
    expect(() => resolvePayPalEnv({ PAYPAL_ENV: "Sandbox" })).toThrow();
  });
  it("refuses live unless ALLOW_LIVE=1", () => {
    expect(() => resolvePayPalEnv({ PAYPAL_ENV: "live" })).toThrow(/refused/);
    expect(() => resolvePayPalEnv({ PAYPAL_ENV: "live", ALLOW_LIVE: "true" })).toThrow(/refused/);
    expect(resolvePayPalEnv({ PAYPAL_ENV: "live", ALLOW_LIVE: "1" })).toBe("live");
  });
  it("requires credentials without echoing them", () => {
    expect(() => loadPayPalConfig({ PAYPAL_CLIENT_ID: "x" })).toThrow("PAYPAL_CLIENT_SECRET is not set");
  });
});

describe("money", () => {
  it("converts exactly", () => {
    expect(moneyToCents({ currency_code: "EUR", value: "1000.00" }, "EUR")).toBe(100000);
    expect(moneyToCents({ currency_code: "EUR", value: "0.1" }, "EUR")).toBe(10);
    expect(moneyToCents({ currency_code: "EUR", value: "8.650" }, "EUR")).toBe(865);
    expect(moneyToCents({ currency_code: "EUR", value: "12" }, "EUR")).toBe(1200);
    expect(centsToMoney(854, "EUR")).toEqual({ currency_code: "EUR", value: "8.54" });
    expect(centsToMoney(5, "EUR").value).toBe("0.05");
  });
  it("rejects wrong currency, negatives, junk and sub-cent values", () => {
    expect(() => moneyToCents({ currency_code: "USD", value: "1.00" }, "EUR")).toThrow(/Currency/);
    expect(() => moneyToCents({ currency_code: "EUR", value: "-1.00" }, "EUR")).toThrow();
    expect(() => moneyToCents({ currency_code: "EUR", value: "1,00" }, "EUR")).toThrow();
    expect(() => moneyToCents({ currency_code: "EUR", value: "1.005" }, "EUR")).toThrow(/2 decimals/);
    expect(() => moneyToCents({ currency_code: "EUR", value: "1e3" }, "EUR")).toThrow();
  });
  it("round-trips", () => {
    for (const c of [0, 1, 99, 100, 101, 123456789]) expect(moneyToCents(centsToMoney(c, "EUR"), "EUR")).toBe(c);
  });
});

describe("PayPalClient auth", () => {
  it("fetches a token once with basic auth and caches it", async () => {
    const { c, calls } = client([token(), () => jsonRes(200, INVOICE), () => jsonRes(200, INVOICE)]);
    await c.getInvoice("INV2-AAAA-BBBB");
    await c.getInvoice("INV2-AAAA-BBBB");
    expect(calls.map((x) => x.url)).toEqual([
      "https://api-m.sandbox.paypal.com/v1/oauth2/token",
      "https://api-m.sandbox.paypal.com/v2/invoicing/invoices/INV2-AAAA-BBBB",
      "https://api-m.sandbox.paypal.com/v2/invoicing/invoices/INV2-AAAA-BBBB",
    ]);
    expect(calls[0].headers.Authorization).toBe(`Basic ${Buffer.from("test-client-id:test-client-secret").toString("base64")}`);
    expect(calls[0].body).toBe("grant_type=client_credentials");
    expect(calls[1].headers.Authorization).toBe("Bearer tok-1");
  });

  it("refreshes before expiry", async () => {
    const { c, calls, advance } = client([token(3600, "tok-1"), () => jsonRes(200, INVOICE), token(3600, "tok-2"), () => jsonRes(200, INVOICE)]);
    await c.getInvoice("INV2-AAAA-BBBB");
    advance(3600_000 - 300_000); // exactly at the refresh point (lifetime minus 10 percent, capped at 5 min)
    await c.getInvoice("INV2-AAAA-BBBB");
    expect(calls.filter((x) => x.url.endsWith("/oauth2/token"))).toHaveLength(2);
    expect(calls[3].headers.Authorization).toBe("Bearer tok-2");
  });

  it("does not refresh before the refresh point", async () => {
    const { c, calls, advance } = client([token(3600), () => jsonRes(200, INVOICE)]);
    await c.getInvoice("INV2-AAAA-BBBB");
    advance(3600_000 - 300_001);
    await c.getInvoice("INV2-AAAA-BBBB");
    expect(calls.filter((x) => x.url.endsWith("/oauth2/token"))).toHaveLength(1);
  });

  it("shares one token request between concurrent callers", async () => {
    const { c, calls } = client([token(), () => jsonRes(200, INVOICE)]);
    await Promise.all([c.getInvoice("INV2-AAAA-BBBB"), c.getInvoice("INV2-AAAA-BBBB"), c.getInvoice("INV2-AAAA-BBBB")]);
    expect(calls.filter((x) => x.url.endsWith("/oauth2/token"))).toHaveLength(1);
  });

  it("re-authenticates once on 401", async () => {
    const { c, calls } = client([token(3600, "old"), () => jsonRes(401, { name: "AUTHENTICATION_FAILURE" }), token(3600, "new"), () => jsonRes(200, INVOICE)]);
    const inv = await c.getInvoice("INV2-AAAA-BBBB");
    expect(inv.id).toBe("INV2-AAAA-BBBB");
    expect(calls[3].headers.Authorization).toBe("Bearer new");
  });

  it("never puts the secret or token into errors", async () => {
    const { c } = client([() => jsonRes(401, { error: "invalid_client", error_description: "Client Authentication failed" })]);
    const err = await c.getAccessToken().catch((e) => e);
    expect(err).toBeInstanceOf(PayPalApiError);
    expect(String(err.message)).not.toContain("test-client-secret");
    expect(JSON.stringify(err)).not.toContain("test-client-secret");
  });
});

describe("PayPalClient retries and idempotency", () => {
  it("retries 5xx and 429 with backoff and keeps the same PayPal-Request-Id", async () => {
    const { c, calls, sleeps } = client([
      token(),
      () => jsonRes(500, { name: "INTERNAL_SERVER_ERROR" }),
      () => jsonRes(429, { name: "RATE_LIMIT_REACHED" }, { "retry-after": "2" }),
      () => jsonRes(200, { payment_id: "EXTR-1" }),
    ]);
    const id = await c.recordPayment("INV2-AAAA-BBBB", { method: "BANK_TRANSFER", payment_date: "2026-11-03", amount: centsToMoney(40000, "EUR") });
    expect(id).toBe("EXTR-1");
    const posts = calls.filter((x) => x.url.endsWith("/payments"));
    expect(posts).toHaveLength(3);
    expect(new Set(posts.map((p) => p.headers["PayPal-Request-Id"]))).toEqual(new Set(["req-1"]));
    expect(sleeps).toEqual([300, 2000]);
    expect(JSON.parse(posts[0].body!)).toEqual({ method: "BANK_TRANSFER", payment_date: "2026-11-03", amount: { currency_code: "EUR", value: "400.00" } });
  });

  it("uses a caller supplied request id", async () => {
    const { c, calls } = client([token(), () => new Response(null, { status: 204 })]);
    await c.remindInvoice("INV2-AAAA-BBBB", { subject: "Reminder" }, { requestId: "step-42" });
    expect(calls[1].headers["PayPal-Request-Id"]).toBe("step-42");
  });

  it("does not send a request id on GET", async () => {
    const { c, calls } = client([token(), () => jsonRes(200, INVOICE)]);
    await c.getInvoice("INV2-AAAA-BBBB");
    expect(calls[1].headers["PayPal-Request-Id"]).toBeUndefined();
  });

  it("retries network errors, then gives up", async () => {
    const boom = () => {
      throw new TypeError("fetch failed");
    };
    const { c, sleeps } = client([token(), boom, boom, boom, boom]);
    await expect(c.getInvoice("INV2-AAAA-BBBB")).rejects.toThrow(/Network error/);
    expect(sleeps).toEqual([300, 600, 1200]);
  });

  it("does not retry 4xx and surfaces PayPal error details", async () => {
    const { c, calls } = client([
      token(),
      () => jsonRes(422, { name: "UNPROCESSABLE_ENTITY", message: "The requested action could not be performed.", debug_id: "dbg1", details: [{ issue: "CANT_CANCEL_PAID_INVOICE" }] }),
    ]);
    const err = await c.cancelInvoice("INV2-AAAA-BBBB").catch((e) => e);
    expect(err).toBeInstanceOf(PayPalApiError);
    expect(err.status).toBe(422);
    expect(err.debugId).toBe("dbg1");
    expect(err.issue).toBe("CANT_CANCEL_PAID_INVOICE");
    expect(calls).toHaveLength(2);
  });

  it("returns the last 5xx as an error after max retries", async () => {
    const { c } = client([token(), () => jsonRes(503, { name: "SERVICE_UNAVAILABLE" })]);
    const err = await c.getInvoice("INV2-AAAA-BBBB").catch((e) => e);
    expect(err.status).toBe(503);
  });
});

describe("PayPalClient endpoints and validation", () => {
  it("rejects responses that fail the schema", async () => {
    const { c } = client([token(), () => jsonRes(200, { status: "SENT" })]);
    await expect(c.getInvoice("INV2-AAAA-BBBB")).rejects.toBeInstanceOf(PayPalSchemaError);
  });

  it("rejects unsafe ids before calling PayPal", async () => {
    const { c, calls } = client([token()]);
    await expect(c.getInvoice("../oauth2/token")).rejects.toThrow(/Invalid invoice id/);
    expect(calls).toHaveLength(0);
  });

  it("calls the documented paths", async () => {
    const { c, calls } = client([
      token(),
      () => jsonRes(200, { invoice_number: "MW-0001" }),
      () => jsonRes(201, { ...INVOICE, status: "DRAFT" }),
      () => jsonRes(202, undefined),
      () => jsonRes(200, { refund_id: "EXTR-R1" }),
      () => jsonRes(200, { total_items: 1, items: [INVOICE] }),
      () => jsonRes(200, { items: [{ dispute_id: "PP-D-1", status: "OPEN" }] }),
      () => jsonRes(200, { dispute_id: "PP-D-1", status: "OPEN" }),
      () => jsonRes(200, { id: "R1", status: "COMPLETED" }),
      () => jsonRes(200, { verification_status: "SUCCESS" }),
    ]);
    expect(await c.generateNextInvoiceNumber()).toBe("MW-0001");
    expect((await c.createInvoice({ detail: {} })).status).toBe("DRAFT");
    await c.sendInvoice("INV2-AAAA-BBBB", { send_to_recipient: true });
    expect(await c.recordRefund("INV2-AAAA-BBBB", { method: "BANK_TRANSFER", refund_date: "2026-11-03", amount: centsToMoney(100, "EUR") })).toBe("EXTR-R1");
    expect((await c.searchInvoices({ status: ["SENT"] })).items).toHaveLength(1);
    expect((await c.listDisputes({ page_size: 10 })).items[0].dispute_id).toBe("PP-D-1");
    expect((await c.getDispute("PP-D-1")).status).toBe("OPEN");
    expect((await c.getCaptureRefund("R1")).status).toBe("COMPLETED");
    expect(
      await c.verifyWebhookSignature({ authAlgo: "SHA256withRSA", certUrl: "https://api.sandbox.paypal.com/cert", transmissionId: "t", transmissionSig: "s", transmissionTime: "now", webhookId: "WH-1", webhookEvent: { id: "WH-EVT" } }),
    ).toBe(true);
    const paths = calls.slice(1).map((x) => `${x.method} ${new URL(x.url).pathname}${new URL(x.url).search}`);
    expect(paths).toEqual([
      "POST /v2/invoicing/generate-next-invoice-number",
      "POST /v2/invoicing/invoices",
      "POST /v2/invoicing/invoices/INV2-AAAA-BBBB/send",
      "POST /v2/invoicing/invoices/INV2-AAAA-BBBB/refunds",
      "POST /v2/invoicing/search-invoices?page=1&page_size=20&total_required=true",
      "GET /v1/customer/disputes?page_size=10",
      "GET /v1/customer/disputes/PP-D-1",
      "GET /v2/payments/refunds/R1",
      "POST /v1/notifications/verify-webhook-signature",
    ]);
    expect(calls[2].headers.Prefer).toBe("return=representation");
    expect(JSON.parse(calls[9].body!).webhook_id).toBe("WH-1");
    for (const call of calls.slice(1)) {
      if (call.method === "POST") expect(call.headers["PayPal-Request-Id"]).toMatch(/^req-\d+$/);
    }
  });

  it("reports verification FAILURE as false", async () => {
    const { c } = client([token(), () => jsonRes(200, { verification_status: "FAILURE" })]);
    expect(
      await c.verifyWebhookSignature({ authAlgo: "a", certUrl: "b", transmissionId: "c", transmissionSig: "d", transmissionTime: "e", webhookId: "f", webhookEvent: {} }),
    ).toBe(false);
  });
});
