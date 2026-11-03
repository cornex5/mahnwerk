// Test fixtures for the service layer: a stateful fake PayPal (Invoicing subset) with PayPal-Request-Id
// idempotency and failure injection, and a seeded world. Not used by production code.

import { PayPalApiError } from "../paypal/client";
import { centsToMoney, moneyToCents, type PayPalMoney } from "../paypal/money";
import type { PayPalCaptureRefund, PayPalDispute, PayPalInvoice } from "../paypal/schemas";
import { realToday, type PayPalPort, type ServiceDeps, type ServiceLimits } from "./context";
import { MemoryServiceStore } from "./memoryServiceStore";
import { createDemoWorkspace } from "./workspaces";

type Op = "createInvoice" | "sendInvoice" | "getInvoice" | "remindInvoice" | "recordPayment" | "recordRefund" | "searchInvoices";

interface FakeInvoice {
  id: string;
  number: string;
  status: string;
  totalCents: number;
  body: Record<string, unknown>;
  payments: { id: string; date: string; cents: number }[];
  refunds: { id: string; date: string; cents: number }[];
}

export interface FakeCall {
  op: Op;
  id?: string;
  requestId?: string;
  body?: unknown;
}

export const apiError = (status: number, issue?: string) => new PayPalApiError(`PayPal fake failed with HTTP ${status}${issue ? `: ${issue}` : ""}`, status, "debug-fake", issue);

export class FakePayPalApi implements PayPalPort {
  readonly env = "sandbox" as const;
  invoices = new Map<string, FakeInvoice>();
  calls: FakeCall[] = [];
  /** Responses cached per PayPal-Request-Id (PayPal idempotency). */
  private cache = new Map<string, unknown>();
  honorRequestIds = true;
  /** Reject payment/refund dates after this date (PayPal may refuse future dates). */
  rejectDatesAfter: string | null = null;
  /** Called before a remind is performed (lets tests assert the approval gate at that moment). */
  onRemind?: (id: string) => void;
  private failures: { op: Op; err: Error; after: boolean }[] = [];
  private seq = 0;

  /** Next call of op fails. after=true: PayPal performs the write, then the response is lost. */
  failNext(op: Op, err: Error, opts: { after?: boolean } = {}) {
    this.failures.push({ op, err, after: opts.after ?? false });
  }

  count(op: Op) {
    return this.calls.filter((c) => c.op === op).length;
  }

  private async run<T>(op: Op, call: FakeCall, requestId: string | undefined, perform: () => T): Promise<T> {
    this.calls.push({ ...call, requestId });
    const fIdx = this.failures.findIndex((f) => f.op === op);
    const failure = fIdx >= 0 ? this.failures.splice(fIdx, 1)[0] : null;
    if (failure && !failure.after) throw failure.err;
    let result: T;
    const cacheKey = requestId ? `${op}:${requestId}` : null;
    if (cacheKey && this.honorRequestIds && this.cache.has(cacheKey)) {
      result = structuredClone(this.cache.get(cacheKey)) as T;
    } else {
      result = perform();
      if (cacheKey) this.cache.set(cacheKey, structuredClone(result));
    }
    if (failure) throw failure.err;
    return result;
  }

  private must(id: string): FakeInvoice {
    const inv = this.invoices.get(id);
    if (!inv) throw apiError(404, "INVALID_RESOURCE_ID");
    return inv;
  }

  private view(inv: FakeInvoice): PayPalInvoice {
    const paid = inv.payments.reduce((a, p) => a + p.cents, 0);
    const refunded = inv.refunds.reduce((a, p) => a + p.cents, 0);
    const eur = (c: number) => centsToMoney(c, "EUR");
    return {
      id: inv.id,
      status: inv.status,
      detail: { invoice_number: inv.number, currency_code: "EUR" },
      amount: { ...eur(inv.totalCents) },
      due_amount: eur(Math.max(0, inv.totalCents - paid + refunded)),
      payments: { paid_amount: eur(paid), transactions: inv.payments.map((p) => ({ payment_id: p.id, payment_date: p.date, method: "BANK_TRANSFER", type: "EXTERNAL", amount: eur(p.cents) })) },
      refunds: { refund_amount: eur(refunded), transactions: inv.refunds.map((r) => ({ refund_id: r.id, refund_date: r.date, method: "BANK_TRANSFER", type: "EXTERNAL", amount: eur(r.cents) })) },
    };
  }

  async createInvoice(body: Record<string, unknown>, opts: { requestId?: string } = {}) {
    return this.run("createInvoice", { op: "createInvoice", body }, opts.requestId, () => {
      const detail = body.detail as { invoice_number: string };
      if ([...this.invoices.values()].some((i) => i.number === detail.invoice_number)) throw apiError(422, "DUPLICATE_INVOICE_NUMBER");
      const items = body.items as { unit_amount: PayPalMoney; quantity: string }[];
      const total = items.reduce((a, i) => a + moneyToCents(i.unit_amount, "EUR") * Number(i.quantity), 0);
      const id = `INV2-FAKE-${String(++this.seq).padStart(4, "0")}`;
      const inv: FakeInvoice = { id, number: detail.invoice_number, status: "DRAFT", totalCents: total, body: structuredClone(body), payments: [], refunds: [] };
      this.invoices.set(id, inv);
      return this.view(inv);
    });
  }

  async sendInvoice(id: string, body: Record<string, unknown> = {}, opts: { requestId?: string } = {}) {
    void body;
    await this.run("sendInvoice", { op: "sendInvoice", id }, opts.requestId, () => {
      const inv = this.must(id);
      if (inv.status !== "DRAFT") throw apiError(422, "INVOICE_ALREADY_SENT");
      inv.status = "SENT";
      return null;
    });
  }

  async getInvoice(id: string) {
    return this.run("getInvoice", { op: "getInvoice", id }, undefined, () => this.view(this.must(id)));
  }

  async remindInvoice(id: string, body: Record<string, unknown> = {}, opts: { requestId?: string } = {}) {
    await this.run("remindInvoice", { op: "remindInvoice", id, body }, opts.requestId, () => {
      const inv = this.must(id);
      this.onRemind?.(id);
      if (!["SENT", "UNPAID", "PARTIALLY_PAID"].includes(inv.status)) throw apiError(422, "CANNOT_REMIND_INVOICE");
      return null;
    });
  }

  private checkDate(date: string) {
    if (this.rejectDatesAfter && date > this.rejectDatesAfter) throw apiError(422, "INVALID_PAYMENT_DATE");
  }

  async recordPayment(id: string, body: { method: string; payment_date: string; amount: PayPalMoney }, opts: { requestId?: string } = {}) {
    return this.run("recordPayment", { op: "recordPayment", id, body }, opts.requestId, () => {
      const inv = this.must(id);
      this.checkDate(body.payment_date);
      const cents = moneyToCents(body.amount, "EUR");
      const paid = inv.payments.reduce((a, p) => a + p.cents, 0);
      if (cents > inv.totalCents - paid) throw apiError(422, "PAYMENT_AMOUNT_EXCEEDS_DUE");
      const pid = `PAY-FAKE-${++this.seq}`;
      inv.payments.push({ id: pid, date: body.payment_date, cents });
      inv.status = paid + cents >= inv.totalCents ? "MARKED_AS_PAID" : "PARTIALLY_PAID";
      return pid;
    });
  }

  async recordRefund(id: string, body: { method: string; refund_date: string; amount: PayPalMoney }, opts: { requestId?: string } = {}) {
    return this.run("recordRefund", { op: "recordRefund", id, body }, opts.requestId, () => {
      const inv = this.must(id);
      this.checkDate(body.refund_date);
      const cents = moneyToCents(body.amount, "EUR");
      const paid = inv.payments.reduce((a, p) => a + p.cents, 0);
      const refunded = inv.refunds.reduce((a, p) => a + p.cents, 0);
      if (cents > paid - refunded) throw apiError(422, "REFUND_AMOUNT_EXCEEDED");
      const rid = `REF-FAKE-${++this.seq}`;
      inv.refunds.push({ id: rid, date: body.refund_date, cents });
      inv.status = refunded + cents >= paid ? "MARKED_AS_REFUNDED" : "PARTIALLY_REFUNDED";
      return rid;
    });
  }

  async searchInvoices(criteria: Record<string, unknown>, page: { page?: number; pageSize?: number } = {}, opts: { requestId?: string } = {}) {
    void page;
    void opts;
    // A search is a read: never served from the idempotency cache.
    return this.run("searchInvoices", { op: "searchInvoices", body: criteria }, undefined, () => {
      const items = [...this.invoices.values()].filter((i) => i.number === criteria.invoice_number).map((i) => this.view(i));
      return { total_items: items.length, total_pages: 1, items };
    });
  }

  async getDispute(id: string): Promise<PayPalDispute> {
    throw apiError(404, `dispute ${id} unknown to the fake`);
  }

  async getCaptureRefund(id: string): Promise<PayPalCaptureRefund> {
    throw apiError(404, `refund ${id} unknown to the fake`);
  }
}

export const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const OTHER_USER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
/** 2026-11-03T12:00:00Z */
export const T0 = Date.UTC(2026, 10, 3, 12);

export async function makeServiceWorld(opts: { limits?: Partial<ServiceLimits> } = {}) {
  const store = new MemoryServiceStore();
  const paypal = new FakePayPalApi();
  let clock = T0;
  let ids = 0;
  const deps: ServiceDeps = {
    store,
    paypal,
    now: () => clock,
    paypalEnv: "sandbox",
    merchantId: "pp-test-merchant",
    limits: opts.limits,
    newId: () => `00000000-0000-4000-8000-${String(++ids).padStart(12, "0")}`,
  };
  const { workspace } = await createDemoWorkspace(deps, USER);
  const debtors = await store.listDebtors(workspace.id);
  const consumer = debtors.find((d) => d.type === "consumer")!;
  const business = debtors.filter((d) => d.type === "business");
  return {
    store,
    paypal,
    deps,
    ws: workspace,
    consumer,
    business,
    tick: (ms: number) => {
      clock += ms;
    },
    today: () => realToday(clock),
  };
}

export type ServiceWorld = Awaited<ReturnType<typeof makeServiceWorld>>;
