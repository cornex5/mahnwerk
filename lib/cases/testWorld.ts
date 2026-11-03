// Test fixtures: a fake PayPal (GET only) and a seeded MemoryStore. Not used by production code.

import type { PayPalCaptureRefund, PayPalDispute, PayPalInvoice } from "../paypal/schemas";
import { MemoryStore } from "./memoryStore";
import type { PayPalReader } from "./reconcile";
import type { CaseState } from "./stateMachine";

export class FakePayPal implements PayPalReader {
  invoices = new Map<string, PayPalInvoice>();
  disputes = new Map<string, PayPalDispute>();
  refunds = new Map<string, PayPalCaptureRefund>();
  gets: string[] = [];
  verifyResult: boolean | Error = true;
  verifyCalls: unknown[] = [];

  async getInvoice(id: string) {
    this.gets.push(`invoice:${id}`);
    const v = this.invoices.get(id);
    if (!v) throw new Error(`404 invoice ${id}`);
    return structuredClone(v);
  }
  async getDispute(id: string) {
    this.gets.push(`dispute:${id}`);
    const v = this.disputes.get(id);
    if (!v) throw new Error(`404 dispute ${id}`);
    return structuredClone(v);
  }
  async getCaptureRefund(id: string) {
    this.gets.push(`refund:${id}`);
    const v = this.refunds.get(id);
    if (!v) throw new Error(`404 refund ${id}`);
    return structuredClone(v);
  }
  async verifyWebhookSignature(input: unknown) {
    this.verifyCalls.push(input);
    if (this.verifyResult instanceof Error) throw this.verifyResult;
    return this.verifyResult;
  }
}

export const WS = "11111111-1111-4111-8111-111111111111";
export const INV = "22222222-2222-4222-8222-222222222222";
export const CASE = "33333333-3333-4333-8333-333333333333";
export const PP_INV = "INV2-TEST-0001";

const eur = (cents: number) => ({ currency_code: "EUR", value: `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}` });

export interface RemoteState {
  status: string;
  payments?: { id: string; date: string; cents: number }[];
  refunds?: { id: string; date: string; cents: number }[];
  dueCents?: number | null;
  totalCents?: number;
}

export function remoteInvoice(s: RemoteState): PayPalInvoice {
  const total = s.totalCents ?? 100000;
  const paid = (s.payments ?? []).reduce((a, p) => a + p.cents, 0);
  const refunded = (s.refunds ?? []).reduce((a, p) => a + p.cents, 0);
  const due = s.dueCents === undefined ? Math.max(0, total - paid + refunded) : s.dueCents;
  return {
    id: PP_INV,
    status: s.status,
    detail: { invoice_number: "MW-0001", currency_code: "EUR" },
    amount: eur(total),
    ...(due === null ? {} : { due_amount: eur(due) }),
    payments: {
      paid_amount: eur(paid),
      transactions: (s.payments ?? []).map((p) => ({ payment_id: p.id, payment_date: p.date, method: "BANK_TRANSFER", type: "EXTERNAL", amount: eur(p.cents) })),
    },
    refunds: {
      refund_amount: eur(refunded),
      transactions: (s.refunds ?? []).map((r) => ({ refund_id: r.id, refund_date: r.date, method: "BANK_TRANSFER", type: "EXTERNAL", amount: eur(r.cents) })),
    },
  };
}

export function makeWorld(caseState: CaseState = "mahnung1") {
  const store = new MemoryStore();
  const paypal = new FakePayPal();
  store.invoices.set(INV, { id: INV, workspace_id: WS, paypal_invoice_id: PP_INV, number: "MW-0001", currency: "EUR", principal_cents: 100000 });
  store.cases.set(CASE, {
    id: CASE,
    workspace_id: WS,
    invoice_id: INV,
    state: caseState,
    prev_state: caseState === "paused_dispute" || caseState === "closed_paid" ? "reminded" : null,
    paused_reason: caseState === "paused_dispute" ? "dispute:PP-D-1" : null,
    version: 0,
  });
  // Business debtor, fixed calendar due date 2026-09-30: default from 2026-10-01 (BGB 286(2) no. 1).
  store.claimFacts.set(INV, {
    due_date: "2026-09-30",
    fixed_calendar_due: true,
    default_warning_printed: false,
    received_on: null,
    debtor_type: "business",
    first_payment_request_on: null,
  });
  store.clockOffsets.set(WS, 10);
  paypal.invoices.set(PP_INV, remoteInvoice({ status: "SENT" }));
  // 2026-11-03T12:00:00Z
  const now = () => Date.UTC(2026, 10, 3, 12);
  return { store, paypal, now };
}

export function invoiceEvent(eventId: string, type: string, resource: Record<string, unknown> = { id: PP_INV }) {
  return { event_id: eventId, event_type: type, payload: { id: eventId, event_type: type, resource_type: "invoices", resource } };
}
