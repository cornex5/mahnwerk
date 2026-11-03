import { describe, expect, it } from "vitest";
import { PayPalClient } from "../paypal/client";
import { PAYPAL_BASE_URLS } from "../paypal/config";
import { ServiceError } from "./errors";
import { createAndSendInvoice, invoiceNumberFor, paypalDates, type CreateInvoiceInput } from "./invoices";
import { OTHER_USER, T0, USER, apiError, makeServiceWorld, type ServiceWorld } from "./testkit";
import { stableKey, type PayPalPort } from "./context";
import { advanceClock } from "./workspaces";

const input = (w: ServiceWorld, extra: Partial<CreateInvoiceInput> = {}): CreateInvoiceInput => ({
  workspaceId: w.ws.id,
  debtorId: w.business[0].id,
  amountCents: 123456,
  dueDate: "2026-11-17",
  nonce: "nonce-0001",
  ...extra,
});

const counts = (w: ServiceWorld) => ({
  invoices: w.store.fullInvoices.size,
  cases: w.store.cases.size,
  paypalInvoices: w.paypal.invoices.size,
});

describe("createAndSendInvoice", () => {
  it("creates and sends a PayPal sandbox invoice, then stores invoice, open case and audit row", async () => {
    const w = await makeServiceWorld();
    const r = await createAndSendInvoice(w.deps, USER, input(w));
    expect(r.replayed).toBe(false);
    expect(r.case.state).toBe("open");
    expect(r.invoice).toMatchObject({ principal_cents: 123456, issue_date: "2026-11-03", due_date: "2026-11-17", received_on: "2026-11-03", default_warning_printed: true, fixed_calendar_due: false });
    expect(r.invoice.paypal_invoice_id).toMatch(/^INV2-FAKE-/);
    const pp = w.paypal.invoices.get(r.invoice.paypal_invoice_id!)!;
    expect(pp.status).toBe("SENT");
    expect(pp.totalCents).toBe(123456);
    expect(pp.number).toBe(r.invoice.number);
    const key = stableKey("invoice", w.ws.id, w.business[0].id, "nonce-0001");
    expect(r.invoice.number).toBe(invoiceNumberFor(key));
    const create = w.paypal.calls.find((c) => c.op === "createInvoice")!;
    const send = w.paypal.calls.find((c) => c.op === "sendInvoice")!;
    expect(create.requestId).toBe(`mw-ic-${key.slice(0, 32)}`);
    expect(send.requestId).toBe(`mw-is-${key.slice(0, 32)}`);
    expect(w.store.audit.filter((a) => a.action === "invoice.sent")).toHaveLength(1);
  });

  it("maps the demo term onto real PayPal dates", async () => {
    const w = await makeServiceWorld();
    await advanceClock(w.deps, w.ws.id, USER, 5);
    const r = await createAndSendInvoice(w.deps, USER, input(w, { dueDate: "2026-11-22" }));
    expect(r.invoice.issue_date).toBe("2026-11-08");
    const body = w.paypal.invoices.get(r.invoice.paypal_invoice_id!)!.body as { detail: { invoice_date: string; payment_term: { due_date: string } } };
    expect(body.detail.invoice_date).toBe("2026-11-03");
    expect(body.detail.payment_term.due_date).toBe("2026-11-17");
    expect(paypalDates("2026-11-08", "2026-11-22", T0)).toEqual({ invoiceDate: "2026-11-03", dueDate: "2026-11-17" });
  });

  it("prints the consumer default warning and the Kleinunternehmer note", async () => {
    const w = await makeServiceWorld();
    const r = await createAndSendInvoice(w.deps, USER, input(w, { debtorId: w.consumer.id }));
    const body = w.paypal.invoices.get(r.invoice.paypal_invoice_id!)!.body as { detail: { note: string }; primary_recipients: { billing_info: Record<string, unknown> }[] };
    expect(body.detail.note).toMatch(/BGB 286 Abs\. 3/);
    expect(body.detail.note).toMatch(/19 UStG/);
    expect(body.primary_recipients[0].billing_info).toMatchObject({ name: { given_name: "Lena", surname: "Beispiel" }, email_address: w.consumer.email });
  });

  it("refuses unless PAYPAL_ENV=sandbox, before any write", async () => {
    const w = await makeServiceWorld();
    for (const env of [undefined, "live"]) {
      const err = await createAndSendInvoice({ ...w.deps, paypalEnv: env }, USER, input(w)).catch((e) => e);
      expect(err.code).toBe("not_sandbox");
    }
    expect(w.paypal.calls).toEqual([]);
    expect(counts(w)).toEqual({ invoices: 0, cases: 0, paypalInvoices: 0 });
  });

  it("validates input and ownership", async () => {
    const w = await makeServiceWorld();
    const other = await makeServiceWorld();
    const bad: [Partial<CreateInvoiceInput>, string][] = [
      [{ amountCents: 0 }, "invalid_input"],
      [{ amountCents: 10.5 }, "invalid_input"],
      [{ dueDate: "2026-11-02" }, "invalid_input"],
      [{ dueDate: "2026-02-30" }, "invalid_input"],
      [{ nonce: "short" }, "invalid_input"],
      [{ debtorId: other.consumer.id }, "not_found"],
    ];
    for (const [patch, expected] of bad) {
      const err = await createAndSendInvoice(w.deps, USER, input(w, patch)).catch((e) => e);
      expect(err.code, JSON.stringify(patch)).toBe(expected);
    }
    expect((await createAndSendInvoice(w.deps, OTHER_USER, input(w)).catch((e) => e)).code).toBe("forbidden");
    expect(w.paypal.calls).toEqual([]);
  });

  it("is idempotent per nonce: a replay creates nothing new", async () => {
    const w = await makeServiceWorld();
    const a = await createAndSendInvoice(w.deps, USER, input(w));
    const callsAfterFirst = w.paypal.calls.length;
    const b = await createAndSendInvoice(w.deps, USER, input(w));
    expect(b.replayed).toBe(true);
    expect(b.invoice.id).toBe(a.invoice.id);
    expect(w.paypal.calls.length).toBe(callsAfterFirst);
    expect(counts(w)).toEqual({ invoices: 1, cases: 1, paypalInvoices: 1 });
    // Same nonce, different content: refused.
    expect((await createAndSendInvoice(w.deps, USER, input(w, { amountCents: 999 })).catch((e) => e)).code).toBe("conflict");
  });

  it("handles a double click: one PayPal invoice, one row, one case", async () => {
    const w = await makeServiceWorld();
    const results = await Promise.allSettled([createAndSendInvoice(w.deps, USER, input(w)), createAndSendInvoice(w.deps, USER, input(w))]);
    const ok = results.filter((r) => r.status === "fulfilled");
    expect(ok.length).toBeGreaterThanOrEqual(1);
    for (const r of results) if (r.status === "rejected") expect((r.reason as ServiceError).code).toBe("in_progress");
    expect(counts(w)).toEqual({ invoices: 1, cases: 1, paypalInvoices: 1 });
    expect((await createAndSendInvoice(w.deps, USER, input(w))).replayed).toBe(true);
  });

  it("definitive PayPal rejection on create: nothing stays in the database, a retry works", async () => {
    const w = await makeServiceWorld();
    w.paypal.failNext("createInvoice", apiError(422, "INVALID_PARAMETER"));
    const err = await createAndSendInvoice(w.deps, USER, input(w)).catch((e) => e);
    expect(err.code).toBe("paypal_failed");
    expect(err.details).toMatchObject({ stage: "create", retryable: false });
    expect(counts(w)).toEqual({ invoices: 0, cases: 0, paypalInvoices: 0 });
    expect(w.store.audit.filter((a) => a.action === "invoice.create_failed")).toHaveLength(1);
    const r = await createAndSendInvoice(w.deps, USER, input(w));
    expect(r.case.state).toBe("open");
    expect(counts(w)).toEqual({ invoices: 1, cases: 1, paypalInvoices: 1 });
  });

  it("ambiguous failure after create (lost response): retry resumes on the same PayPal invoice", async () => {
    const w = await makeServiceWorld();
    w.paypal.failNext("createInvoice", apiError(503), { after: true });
    const err = await createAndSendInvoice(w.deps, USER, input(w)).catch((e) => e);
    expect(err.details).toMatchObject({ stage: "create", retryable: true });
    // PayPal created a draft; locally a pending row (no case) waits for the retry.
    expect(counts(w)).toEqual({ invoices: 1, cases: 0, paypalInvoices: 1 });
    const r = await createAndSendInvoice(w.deps, USER, input(w));
    expect(r.replayed).toBe(false);
    expect(counts(w)).toEqual({ invoices: 1, cases: 1, paypalInvoices: 1 });
    expect(w.paypal.invoices.get(r.invoice.paypal_invoice_id!)!.status).toBe("SENT");
  });

  it("send fails ambiguously: retry sends once, no second invoice", async () => {
    const w = await makeServiceWorld();
    w.paypal.failNext("sendInvoice", apiError(500));
    expect((await createAndSendInvoice(w.deps, USER, input(w)).catch((e) => e)).details).toMatchObject({ stage: "send", retryable: true });
    const pending = [...w.store.fullInvoices.values()][0];
    expect(pending.paypal_invoice_id).toMatch(/^INV2-/);
    const r = await createAndSendInvoice(w.deps, USER, input(w));
    expect(r.invoice.paypal_invoice_id).toBe(pending.paypal_invoice_id);
    expect(w.paypal.count("createInvoice")).toBe(1);
    expect(counts(w)).toEqual({ invoices: 1, cases: 1, paypalInvoices: 1 });
  });

  it("send succeeded but the response was lost: retry sees SENT and does not send again", async () => {
    const w = await makeServiceWorld();
    w.paypal.failNext("sendInvoice", apiError(502), { after: true });
    await createAndSendInvoice(w.deps, USER, input(w)).catch(() => undefined);
    await createAndSendInvoice(w.deps, USER, input(w));
    expect(w.paypal.count("sendInvoice")).toBe(1);
    expect(counts(w)).toEqual({ invoices: 1, cases: 1, paypalInvoices: 1 });
  });

  it("database failure after PayPal success: retry finalizes without touching PayPal again", async () => {
    const w = await makeServiceWorld();
    w.store.failNext.finalizeInvoice = new Error("connection reset");
    const err = await createAndSendInvoice(w.deps, USER, input(w)).catch((e) => e);
    expect(err.details).toMatchObject({ stage: "finalize", retryable: true });
    expect(counts(w)).toEqual({ invoices: 1, cases: 0, paypalInvoices: 1 });
    const before = w.paypal.calls.filter((c) => c.op !== "getInvoice").length;
    const r = await createAndSendInvoice(w.deps, USER, input(w));
    expect(r.case.state).toBe("open");
    expect(w.paypal.calls.filter((c) => c.op !== "getInvoice").length).toBe(before);
    expect(w.store.audit.filter((a) => a.action === "invoice.sent")).toHaveLength(1);
  });

  it("database failure while linking the PayPal id: retry relies on PayPal idempotency", async () => {
    const w = await makeServiceWorld();
    w.store.failNext.setInvoicePayPalId = new Error("timeout");
    await createAndSendInvoice(w.deps, USER, input(w)).catch(() => undefined);
    const r = await createAndSendInvoice(w.deps, USER, input(w));
    expect(counts(w)).toEqual({ invoices: 1, cases: 1, paypalInvoices: 1 });
    expect(w.paypal.calls.filter((c) => c.op === "createInvoice").every((c) => c.requestId === w.paypal.calls[0].requestId)).toBe(true);
    expect(r.invoice.paypal_invoice_id).toBe([...w.paypal.invoices.keys()][0]);
  });

  it("recovers by invoice number when PayPal does not replay the request id", async () => {
    const w = await makeServiceWorld();
    w.paypal.honorRequestIds = false;
    w.paypal.failNext("createInvoice", apiError(504), { after: true });
    await createAndSendInvoice(w.deps, USER, input(w)).catch(() => undefined);
    const r = await createAndSendInvoice(w.deps, USER, input(w));
    expect(w.paypal.count("searchInvoices")).toBe(1);
    expect(counts(w)).toEqual({ invoices: 1, cases: 1, paypalInvoices: 1 });
    expect(r.invoice.paypal_invoice_id).toBe([...w.paypal.invoices.keys()][0]);
  });
});

describe("createAndSendInvoice with the real PayPalClient (mocked fetch)", () => {
  it("sends a stable PayPal-Request-Id across HTTP retries and talks to the sandbox host", async () => {
    const w = await makeServiceWorld();
    const seen: { url: string; method: string; requestId?: string }[] = [];
    let creates = 0;
    const fetchMock = (async (url: RequestInfo | URL, init?: RequestInit) => {
      const u = String(url);
      const headers = (init?.headers ?? {}) as Record<string, string>;
      seen.push({ url: u, method: init?.method ?? "GET", requestId: headers["PayPal-Request-Id"] });
      const json = (status: number, body: unknown) => new Response(body === null ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
      if (u.endsWith("/v1/oauth2/token")) return json(200, { access_token: "t", token_type: "Bearer", expires_in: 3600 });
      if (u.endsWith("/v2/invoicing/invoices") && init?.method === "POST") {
        creates++;
        if (creates === 1) return json(503, { name: "SERVICE_UNAVAILABLE" });
        return json(201, { id: "INV2-REAL-0001", status: "DRAFT", amount: { currency_code: "EUR", value: "1234.56" } });
      }
      if (u.endsWith("/v2/invoicing/invoices/INV2-REAL-0001") && (init?.method ?? "GET") === "GET") {
        return json(200, { id: "INV2-REAL-0001", status: "DRAFT", amount: { currency_code: "EUR", value: "1234.56" } });
      }
      if (u.endsWith("/send")) return json(202, null);
      return json(404, { name: "NOT_FOUND" });
    }) as typeof fetch;
    const client = new PayPalClient({
      config: { env: "sandbox", baseUrl: PAYPAL_BASE_URLS.sandbox, clientId: "id", clientSecret: "secret" },
      fetch: fetchMock,
      sleep: async () => undefined,
      random: () => 0,
    });
    const r = await createAndSendInvoice({ ...w.deps, paypal: client as unknown as PayPalPort }, USER, input(w));
    expect(r.invoice.paypal_invoice_id).toBe("INV2-REAL-0001");
    const createCalls = seen.filter((s) => s.url.endsWith("/v2/invoicing/invoices") && s.method === "POST");
    expect(createCalls).toHaveLength(2);
    expect(createCalls[0].requestId).toBe(createCalls[1].requestId);
    expect(createCalls[0].requestId).toMatch(/^mw-ic-[0-9a-f]{32}$/);
    expect(seen.every((s) => s.url.startsWith("https://api-m.sandbox.paypal.com/"))).toBe(true);
  });
});
