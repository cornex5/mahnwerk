import { describe, expect, it } from "vitest";
import { ServiceError } from "./errors";
import { createAndSendInvoice } from "./invoices";
import { simDisputeId, simulate } from "./simulator";
import { USER, apiError, makeServiceWorld, type ServiceWorld } from "./testkit";
import { advanceClock } from "./workspaces";

async function setup(cents = 100000) {
  const w = await makeServiceWorld();
  const r = await createAndSendInvoice(w.deps, USER, { workspaceId: w.ws.id, debtorId: w.business[0].id, amountCents: cents, dueDate: "2026-11-10", nonce: "sim-invoice-1" });
  return { w, caseId: r.case.id, invoiceId: r.invoice.id, ppId: r.invoice.paypal_invoice_id! };
}

const state = (w: ServiceWorld, caseId: string) => w.store.cases.get(caseId)!.state;
const code = async (p: Promise<unknown>) => {
  const e = await p.then(() => null, (x) => x);
  return e instanceof ServiceError ? e.code : String(e);
};

describe("customer simulator", () => {
  it("pay in full: recorded at PayPal on the virtual date and reconciled to closed_paid at once", async () => {
    const { w, caseId, invoiceId, ppId } = await setup();
    await advanceClock(w.deps, w.ws.id, USER, 5);
    const r = await simulate(w.deps, USER, caseId, { type: "pay_full" }, "pay-full-001");
    expect(r.case.state).toBe("closed_paid");
    expect(r.reconcile.note).toBe("case.paid_in_full");
    const pay = w.paypal.calls.find((c) => c.op === "recordPayment")!;
    expect(pay.body).toMatchObject({ method: "BANK_TRANSFER", payment_date: "2026-11-08", amount: { currency_code: "EUR", value: "1000.00" } });
    expect(pay.requestId).toMatch(/^mw-sim-[0-9a-f]{32}$/);
    expect(w.store.ledger).toEqual([expect.objectContaining({ invoice_id: invoiceId, kind: "payment", amount_cents: 100000, booked_on: "2026-11-08", paypal_ref: r.paypalRef })]);
    expect(w.store.audit.some((a) => a.action === "simulator.pay_full")).toBe(true);
    expect(w.paypal.invoices.get(ppId)!.status).toBe("MARKED_AS_PAID");
  });

  it("double click with the same nonce records one payment", async () => {
    const { w, caseId } = await setup();
    await Promise.allSettled([
      simulate(w.deps, USER, caseId, { type: "pay_partial", amountCents: 30000 }, "pay-part-001"),
      simulate(w.deps, USER, caseId, { type: "pay_partial", amountCents: 30000 }, "pay-part-001"),
    ]);
    await simulate(w.deps, USER, caseId, { type: "pay_partial", amountCents: 30000 }, "pay-part-001").catch(() => undefined);
    expect([...w.paypal.invoices.values()][0].payments).toHaveLength(1);
    expect(w.store.ledger).toHaveLength(1);
  });

  it("partial payment: ledger row, case state unchanged; invalid amounts refused", async () => {
    const { w, caseId } = await setup();
    const r = await simulate(w.deps, USER, caseId, { type: "pay_partial", amountCents: 40000 }, "pay-part-002");
    expect(r.case.state).toBe("open");
    expect(w.store.ledger.map((l) => l.amount_cents)).toEqual([40000]);
    expect(await code(simulate(w.deps, USER, caseId, { type: "pay_partial", amountCents: 60000 }, "pay-part-003"))).toBe("invalid_input");
    expect(await code(simulate(w.deps, USER, caseId, { type: "pay_partial", amountCents: 0 }, "pay-part-004"))).toBe("invalid_input");
  });

  it("refund after full payment closes the case as refunded via the reconciler", async () => {
    const { w, caseId } = await setup();
    await simulate(w.deps, USER, caseId, { type: "pay_full" }, "pay-full-002");
    expect(await code(simulate(w.deps, USER, caseId, { type: "refund", amountCents: 100001 }, "refund-0001"))).toBe("invalid_input");
    const r = await simulate(w.deps, USER, caseId, { type: "refund" }, "refund-0002");
    expect(r.case.state).toBe("closed_refunded");
    expect(w.store.ledger.filter((l) => l.kind === "refund").map((l) => l.amount_cents)).toEqual([100000]);
  });

  it("refund before any payment is refused", async () => {
    const { w, caseId } = await setup();
    expect(await code(simulate(w.deps, USER, caseId, { type: "refund" }, "refund-0003"))).toBe("invalid_input");
  });

  it("dispute open and resolve go through the reconciler (synthetic dispute)", async () => {
    const { w, caseId } = await setup();
    await advanceClock(w.deps, w.ws.id, USER, 8);
    const o = await simulate(w.deps, USER, caseId, { type: "dispute_open" }, "dispute-0001");
    expect(o.case).toMatchObject({ state: "paused_dispute", paused_reason: `dispute:${simDisputeId(caseId)}`, prev_state: "overdue" });
    // Opening again is a no-op, not a second pause.
    expect((await simulate(w.deps, USER, caseId, { type: "dispute_open" }, "dispute-0002")).reconcile.note).toBe("no_change");
    const r = await simulate(w.deps, USER, caseId, { type: "dispute_resolve" }, "dispute-0003");
    expect(r.case.state).toBe("overdue");
    expect(w.store.audit.filter((a) => a.action === "case.dispute_opened")).toHaveLength(1);
    expect(w.store.audit.filter((a) => a.action === "case.dispute_resolved")).toHaveLength(1);
    expect(await code(simulate(w.deps, USER, caseId, { type: "dispute_resolve" }, "dispute-0004"))).toBe("not_executable");
  });

  it("falls back to the real date when PayPal refuses a future payment date", async () => {
    const { w, caseId } = await setup();
    await advanceClock(w.deps, w.ws.id, USER, 20);
    w.paypal.rejectDatesAfter = w.today();
    const r = await simulate(w.deps, USER, caseId, { type: "pay_full" }, "pay-full-003");
    expect(r.usedRealDate).toBe(true);
    expect(w.store.ledger[0].booked_on).toBe("2026-11-03");
    expect(r.case.state).toBe("closed_paid");
  });

  it("PayPal failure leaves nothing behind but the attempt audit row", async () => {
    const { w, caseId } = await setup();
    w.paypal.failNext("recordPayment", apiError(500));
    expect(await code(simulate(w.deps, USER, caseId, { type: "pay_full" }, "pay-full-004"))).toBe("paypal_failed");
    expect(w.store.ledger).toEqual([]);
    expect(state(w, caseId)).toBe("open");
  });

  it("lost PayPal response: local state is re-synced at once, a retry records nothing new", async () => {
    const { w, caseId } = await setup();
    w.paypal.failNext("recordPayment", apiError(502), { after: true });
    expect(await code(simulate(w.deps, USER, caseId, { type: "pay_full" }, "pay-full-005"))).toBe("paypal_failed");
    expect(state(w, caseId)).toBe("closed_paid");
    expect(w.store.ledger).toHaveLength(1);
    expect(await code(simulate(w.deps, USER, caseId, { type: "pay_full" }, "pay-full-005"))).toBe("invalid_input");
    expect([...w.paypal.invoices.values()][0].payments).toHaveLength(1);
    expect(w.store.ledger).toHaveLength(1);
  });

  it("refuses outside the sandbox and for other users", async () => {
    const { w, caseId } = await setup();
    expect(await code(simulate({ ...w.deps, paypalEnv: "live" }, USER, caseId, { type: "pay_full" }, "pay-full-006"))).toBe("not_sandbox");
    expect(await code(simulate(w.deps, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", caseId, { type: "pay_full" }, "pay-full-007"))).toBe("forbidden");
    expect(w.paypal.count("recordPayment")).toBe(0);
  });
});
