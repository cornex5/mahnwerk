import { describe, expect, it } from "vitest";
import { calculateClaim } from "../rules/engine";
import { DE_BASE_RATES, DE_RULESET } from "../rules/de";
import { Reconciler, caseEventFor, desiredOutcome, extractResourceId, remoteLedger } from "./reconcile";
import { processStoredEvent } from "../webhooks/paypalWebhook";
import { CASE, INV, PP_INV, WS, invoiceEvent, makeWorld, remoteInvoice } from "./testWorld";
import type { CaseState } from "./stateMachine";

type World = ReturnType<typeof makeWorld>;

async function run(w: World, ev: { event_id: string; event_type: string; payload: unknown }) {
  await w.store.insertEventIfNew({ event_id: ev.event_id, event_type: ev.event_type, resource_type: null, resource_id: null, verified: true, payload: ev.payload });
  await processStoredEvent(w, ev);
  return w.store.events.get(ev.event_id)!;
}

const caseOf = (w: World) => w.store.cases.get(CASE)!;
const transitions = (w: World) => w.store.audit.filter((a) => a.action.startsWith("case."));

describe("pure helpers", () => {
  it("extracts only the resource id", () => {
    expect(extractResourceId("INVOICING.INVOICE.PAID", { id: "INV2-X" })).toBe("INV2-X");
    expect(extractResourceId("INVOICING.INVOICE.PAID", { invoice: { id: "INV2-Y" } })).toBe("INV2-Y");
    expect(extractResourceId("CUSTOMER.DISPUTE.CREATED", { dispute_id: "PP-D-9" })).toBe("PP-D-9");
    expect(extractResourceId("PAYMENT.CAPTURE.REFUNDED", { id: "R-1" })).toBe("R-1");
    expect(extractResourceId("INVOICING.INVOICE.PAID", { id: "../../etc" })).toBeNull();
  });

  it("maps PayPal status to outcomes conservatively", () => {
    const f = { totalCents: 100000, paidCents: 100000, refundedCents: 0, dueCents: 0 };
    expect(desiredOutcome({ ...f, status: "PAID" }).outcome).toBe("paid");
    expect(desiredOutcome({ ...f, status: "MARKED_AS_PAID" }).outcome).toBe("paid");
    expect(desiredOutcome({ ...f, status: "PAID", paidCents: 99999 }).outcome).toBe("review");
    expect(desiredOutcome({ ...f, status: "PAID", dueCents: 1 }).outcome).toBe("review");
    expect(desiredOutcome({ ...f, status: "PARTIALLY_PAID", paidCents: 400 }).outcome).toBe("unpaid");
    // Refunds are credit notes (Nov 3 2026): a partial refund never reopens, whatever PayPal's
    // due_amount says. (Before: dueCents 0 -> paid, dueCents > 0 -> unpaid/reopen, null -> review.)
    expect(desiredOutcome({ ...f, status: "PARTIALLY_REFUNDED", refundedCents: 100, dueCents: 0 }).outcome).toBe("none");
    expect(desiredOutcome({ ...f, status: "PARTIALLY_REFUNDED", refundedCents: 100, dueCents: 100 }).outcome).toBe("none");
    expect(desiredOutcome({ ...f, status: "PARTIALLY_REFUNDED", refundedCents: 100, dueCents: null }).outcome).toBe("none");
    expect(desiredOutcome({ ...f, status: "SENT", refundedCents: 100, dueCents: 100 }).outcome).toBe("none");
    expect(desiredOutcome({ ...f, status: "REFUNDED", paidCents: 0, refundedCents: 100000 }).outcome).toBe("refunded");
    expect(desiredOutcome({ ...f, status: "REFUNDED", paidCents: 0, refundedCents: 50000 }).outcome).toBe("review");
    expect(desiredOutcome({ ...f, status: "SOMETHING_NEW" }).outcome).toBe("review");
    expect(desiredOutcome({ ...f, status: "DRAFT" }).outcome).toBe("none");
  });

  it("never maps an outcome onto an illegal transition", () => {
    const states: CaseState[] = ["open", "overdue", "reminded", "mahnung1", "mahnung2", "handover_ready", "paused_dispute", "closed_paid", "closed_refunded", "closed_cancelled"];
    for (const s of states) {
      for (const o of ["cancelled", "refunded", "paid", "unpaid", "none", "review"] as const) {
        const r = caseEventFor(s, o);
        if (s === "closed_refunded" || s === "closed_cancelled") expect(r.event).toBeNull();
      }
    }
    expect(caseEventFor("closed_paid", "cancelled").conflict).toMatch(/cancelled/);
    // No automatic reopen any more: a closed_paid case reported unpaid goes to a human.
    expect(caseEventFor("closed_paid", "unpaid")).toEqual({ event: null, conflict: "PayPal unpaid but case is closed_paid" });
  });

  it("refuses payments without an id or with sub-cent amounts", () => {
    const inv = remoteInvoice({ status: "PAID", payments: [{ id: "P1", date: "2026-11-01", cents: 100000 }] });
    delete (inv.payments!.transactions![0] as Record<string, unknown>).payment_id;
    expect(() => remoteLedger(inv, "EUR")).toThrow(/without id/);
    const inv2 = remoteInvoice({ status: "PAID", payments: [{ id: "P1", date: "2026-11-01", cents: 100000 }] });
    inv2.payments!.transactions![0].amount.value = "1000.001";
    expect(() => remoteLedger(inv2, "EUR")).toThrow(/2 decimals/);
  });
});

describe("invoice reconciliation", () => {
  it("records a full payment from the GET, closes the case and audits both", async () => {
    const w = makeWorld("mahnung1");
    w.paypal.invoices.set(PP_INV, remoteInvoice({ status: "PAID", payments: [{ id: "PAY-1", date: "2026-11-02", cents: 100000 }] }));
    const ev = await run(w, invoiceEvent("WH-1", "INVOICING.INVOICE.PAID"));
    expect(ev.error).toBeNull();
    expect(ev.processed_at).not.toBeNull();
    expect(ev.note).toBe("case.paid_in_full");
    expect(w.store.ledger).toEqual([
      { workspace_id: WS, invoice_id: INV, kind: "payment", amount_cents: 100000, booked_on: "2026-11-02", paypal_ref: "PAY-1", source: "paypal" },
    ]);
    expect(caseOf(w)).toMatchObject({ state: "closed_paid", prev_state: "mahnung1", version: 1 });
    expect(transitions(w)).toHaveLength(1);
    expect(transitions(w)[0]).toMatchObject({ actor: "paypal", from_state: "mahnung1", to_state: "closed_paid", virtual_date: "2026-11-13" });
    expect(w.store.audit.filter((a) => a.action === "ledger.payment_recorded")).toHaveLength(1);
    expect(w.store.invoices.get(INV)).toMatchObject({ paypal_status: "PAID", paypal_paid_cents: 100000, paypal_due_cents: 0 });
  });

  it("ignores amounts in the webhook payload and uses the GET", async () => {
    const w = makeWorld("reminded");
    w.paypal.invoices.set(PP_INV, remoteInvoice({ status: "PARTIALLY_PAID", payments: [{ id: "PAY-1", date: "2026-11-02", cents: 40000 }] }));
    const forged = { id: PP_INV, status: "PAID", payments: { transactions: [{ payment_id: "PAY-1", amount: { currency_code: "EUR", value: "1000.00" } }] } };
    await run(w, invoiceEvent("WH-1", "INVOICING.INVOICE.PAID", forged));
    expect(w.store.ledger.map((l) => l.amount_cents)).toEqual([40000]);
    expect(caseOf(w).state).toBe("reminded");
    expect(w.paypal.gets).toEqual([`invoice:${PP_INV}`]);
  });

  it("is idempotent: the same change delivered under different event ids", async () => {
    const w = makeWorld("mahnung2");
    w.paypal.invoices.set(PP_INV, remoteInvoice({ status: "PAID", payments: [{ id: "PAY-1", date: "2026-11-02", cents: 100000 }] }));
    for (const [id, type] of [["WH-1", "INVOICING.INVOICE.PAID"], ["WH-2", "INVOICING.INVOICE.UPDATED"], ["WH-3", "INVOICING.INVOICE.PAID"]]) {
      await run(w, invoiceEvent(id, type));
    }
    expect(w.store.ledger).toHaveLength(1);
    expect(transitions(w)).toHaveLength(1);
    expect(caseOf(w).version).toBe(1);
    expect(w.store.events.get("WH-2")!.note).toBe("no_change");
  });

  it("converges on out-of-order events (final state first, earlier partial event later)", async () => {
    const w = makeWorld("mahnung1");
    // PayPal now: two payments, fully paid. Event for the first (partial) payment arrives last.
    w.paypal.invoices.set(PP_INV, remoteInvoice({ status: "PAID", payments: [{ id: "PAY-1", date: "2026-11-01", cents: 40000 }, { id: "PAY-2", date: "2026-11-02", cents: 60000 }] }));
    await run(w, invoiceEvent("WH-PAID", "INVOICING.INVOICE.PAID"));
    await run(w, invoiceEvent("WH-PARTIAL", "INVOICING.INVOICE.UPDATED"));
    expect(caseOf(w).state).toBe("closed_paid");
    expect(w.store.ledger.map((l) => l.paypal_ref).sort()).toEqual(["PAY-1", "PAY-2"]);
    expect(transitions(w)).toHaveLength(1);
  });

  // Refund tests below were changed deliberately on Nov 3 2026 (refund = credit note, reduces the
  // claim, never reopens). The old versions expected the engine to reopen principal and a
  // closed_paid case to reopen when PayPal reported a balance due after a partial refund.
  it("partial payment then refund: ledger has both, case stays in its stage, engine reduces the claim", async () => {
    const w = makeWorld("mahnung1");
    w.paypal.invoices.set(PP_INV, remoteInvoice({ status: "PARTIALLY_PAID", payments: [{ id: "PAY-1", date: "2026-10-20", cents: 40000 }] }));
    await run(w, invoiceEvent("WH-1", "INVOICING.INVOICE.UPDATED"));
    expect(caseOf(w).state).toBe("mahnung1");
    w.paypal.invoices.set(
      PP_INV,
      remoteInvoice({ status: "SENT", payments: [{ id: "PAY-1", date: "2026-10-20", cents: 40000 }], refunds: [{ id: "REF-1", date: "2026-10-25", cents: 40000 }] }),
    );
    await run(w, invoiceEvent("WH-2", "INVOICING.INVOICE.REFUNDED"));
    await run(w, invoiceEvent("WH-2b", "INVOICING.INVOICE.UPDATED")); // replay under another id
    await run(w, invoiceEvent("WH-2", "INVOICING.INVOICE.REFUNDED")); // replay under the same id
    expect(w.store.ledger.map((l) => `${l.kind}:${l.amount_cents}`)).toEqual(["payment:40000", "refund:40000"]);
    expect(caseOf(w).state).toBe("mahnung1");
    expect(transitions(w)).toHaveLength(0);
    // Flagged once for review, no cap (the refund is below the open principal).
    expect(w.store.audit.filter((a) => a.action === "reconcile.refund_review")).toHaveLength(1);
    expect(w.store.audit.filter((a) => a.action === "reconcile.refund_capped")).toHaveLength(0);

    // Engine on the stored ledger: business debtor, fixed due date 2026-09-30, calc 2026-10-31.
    // 2026-10-01..2026-10-20: 19 days on 100000 at 10.52: 547.6 -> 548. Payment 40000: fee 4000,
    // interest 548, principal 35452 -> 64548. Refund 40000 reduces the claim: 24548.
    const res = calculateClaim({
      invoice: { principalCents: 100000, dueDate: "2026-09-30", fixedCalendarDue: true, defaultWarningPrinted: false, debtorType: "business" },
      ledger: w.store.ledger.map((l) => ({ date: l.booked_on, kind: l.kind, amountCents: l.amount_cents })),
      calcDate: "2026-10-31",
      ruleSet: DE_RULESET,
      baseRates: DE_BASE_RATES,
    });
    expect(res.openPrincipalCents).toBe(24548);
    expect(res.creditCents).toBe(0);
    expect(res.refundCappedCents).toBe(0);
  });

  it("partial refund after full payment keeps closed_paid, flags review and the cap once", async () => {
    const w = makeWorld("closed_paid");
    w.paypal.invoices.set(
      PP_INV,
      remoteInvoice({ status: "PARTIALLY_REFUNDED", payments: [{ id: "PAY-1", date: "2026-11-01", cents: 100000 }], refunds: [{ id: "REF-1", date: "2026-11-02", cents: 10000 }], dueCents: 0 }),
    );
    await run(w, invoiceEvent("WH-1", "INVOICING.INVOICE.REFUNDED"));
    await run(w, invoiceEvent("WH-1", "INVOICING.INVOICE.REFUNDED")); // replay
    expect(caseOf(w)).toMatchObject({ state: "closed_paid", version: 0 });
    expect(transitions(w)).toHaveLength(0);
    expect(w.store.audit.filter((a) => a.action === "reconcile.refund_review")).toHaveLength(1);
    // 31 days on 100000: 893. Payment: fee 4000, interest 893, principal 95107 -> open 4893.
    // Refund 10000 reduces principal to 0, 5107 is capped.
    const capped = w.store.audit.filter((a) => a.action === "reconcile.refund_capped");
    expect(capped).toHaveLength(1);
    expect(capped[0]).toMatchObject({ actor: "system", case_id: CASE, details: { capped_cents: 5107, open_principal_cents: 0 } });
  });

  it("partial refund never reopens a closed case, even when PayPal reports a balance due", async () => {
    const w = makeWorld("closed_paid"); // prev_state reminded
    w.paypal.invoices.set(
      PP_INV,
      remoteInvoice({ status: "PARTIALLY_REFUNDED", payments: [{ id: "PAY-1", date: "2026-11-01", cents: 100000 }], refunds: [{ id: "REF-1", date: "2026-11-02", cents: 10000 }], dueCents: 10000 }),
    );
    expect((await run(w, invoiceEvent("WH-1", "INVOICING.INVOICE.UPDATED"))).note).toBe("no_change");
    // PayPal may also flip the status back to an unpaid one after a refund: still no reopen.
    w.paypal.invoices.set(
      PP_INV,
      remoteInvoice({ status: "PARTIALLY_PAID", payments: [{ id: "PAY-1", date: "2026-11-01", cents: 100000 }], refunds: [{ id: "REF-1", date: "2026-11-02", cents: 10000 }], dueCents: 10000 }),
    );
    expect((await run(w, invoiceEvent("WH-2", "INVOICING.INVOICE.UPDATED"))).note).toBe("no_change");
    expect(caseOf(w)).toMatchObject({ state: "closed_paid", prev_state: "reminded", version: 0 });
    expect(transitions(w)).toHaveLength(0);
  });

  it("full refund with nothing paid closes the case as closed_refunded", async () => {
    const w = makeWorld("mahnung1");
    w.paypal.invoices.set(PP_INV, remoteInvoice({ status: "REFUNDED", refunds: [{ id: "REF-1", date: "2026-11-02", cents: 100000 }] }));
    const ev = await run(w, invoiceEvent("WH-1", "INVOICING.INVOICE.REFUNDED"));
    expect(ev.note).toBe("case.refunded_in_full");
    expect(caseOf(w).state).toBe("closed_refunded");
    expect(w.store.ledger.map((l) => `${l.kind}:${l.amount_cents}`)).toEqual(["refund:100000"]);
    expect(w.store.audit.filter((a) => a.action === "reconcile.refund_capped" || a.action === "reconcile.refund_review")).toHaveLength(0);
    expect(w.store.steps).toHaveLength(0);
  });

  it("full refund closes as refunded; cancel on a paid case is a conflict, not a transition", async () => {
    const w = makeWorld("closed_paid");
    w.paypal.invoices.set(PP_INV, remoteInvoice({ status: "CANCELLED" }));
    expect((await run(w, invoiceEvent("WH-1", "INVOICING.INVOICE.CANCELLED"))).note).toBe("state_conflict");
    expect(caseOf(w).state).toBe("closed_paid");
    w.paypal.invoices.set(
      PP_INV,
      remoteInvoice({ status: "REFUNDED", payments: [{ id: "PAY-1", date: "2026-11-01", cents: 100000 }], refunds: [{ id: "REF-1", date: "2026-11-02", cents: 100000 }] }),
    );
    await run(w, invoiceEvent("WH-2", "INVOICING.INVOICE.REFUNDED"));
    expect(caseOf(w).state).toBe("closed_refunded");
  });

  it("cancels an active case", async () => {
    const w = makeWorld("overdue");
    w.paypal.invoices.set(PP_INV, remoteInvoice({ status: "CANCELLED" }));
    await run(w, invoiceEvent("WH-1", "INVOICING.INVOICE.CANCELLED"));
    expect(caseOf(w).state).toBe("closed_cancelled");
  });

  it("flags a total that differs from the stored principal and does not transition", async () => {
    const w = makeWorld("mahnung1");
    w.paypal.invoices.set(PP_INV, remoteInvoice({ status: "PAID", totalCents: 90000, payments: [{ id: "PAY-1", date: "2026-11-01", cents: 90000 }] }));
    expect((await run(w, invoiceEvent("WH-1", "INVOICING.INVOICE.PAID"))).note).toBe("needs_review");
    expect(caseOf(w).state).toBe("mahnung1");
  });

  it("flags a ledger entry that changed at PayPal and never rewrites it", async () => {
    const w = makeWorld("mahnung1");
    w.paypal.invoices.set(PP_INV, remoteInvoice({ status: "PARTIALLY_PAID", payments: [{ id: "PAY-1", date: "2026-11-01", cents: 40000 }] }));
    await run(w, invoiceEvent("WH-1", "INVOICING.INVOICE.UPDATED"));
    w.paypal.invoices.set(PP_INV, remoteInvoice({ status: "PAID", payments: [{ id: "PAY-1", date: "2026-11-01", cents: 100000 }] }));
    expect((await run(w, invoiceEvent("WH-2", "INVOICING.INVOICE.PAID"))).note).toBe("needs_review");
    expect(w.store.ledger.map((l) => l.amount_cents)).toEqual([40000]);
    expect(caseOf(w).state).toBe("mahnung1");
  });

  it("flags status PAID when the money does not add up", async () => {
    const w = makeWorld("mahnung1");
    w.paypal.invoices.set(PP_INV, remoteInvoice({ status: "PAID", payments: [{ id: "PAY-1", date: "2026-11-01", cents: 50000 }], dueCents: 0 }));
    expect((await run(w, invoiceEvent("WH-1", "INVOICING.INVOICE.PAID"))).note).toBe("needs_review");
    expect(caseOf(w).state).toBe("mahnung1");
  });

  it("marks the event failed on a currency mismatch, nothing written", async () => {
    const w = makeWorld("mahnung1");
    const inv = remoteInvoice({ status: "PAID", payments: [{ id: "PAY-1", date: "2026-11-01", cents: 100000 }] });
    inv.payments!.transactions![0].amount.currency_code = "USD";
    w.paypal.invoices.set(PP_INV, inv);
    const ev = await run(w, invoiceEvent("WH-1", "INVOICING.INVOICE.PAID"));
    expect(ev.processed_at).toBeNull();
    expect(ev.error).toMatch(/Currency mismatch/);
    expect(w.store.ledger).toHaveLength(0);
    expect(caseOf(w).state).toBe("mahnung1");
  });

  it("handles unknown invoices and ignored event types without failing", async () => {
    const w = makeWorld();
    expect((await run(w, invoiceEvent("WH-1", "INVOICING.INVOICE.PAID", { id: "INV2-OTHER" }))).note).toBe("unknown_invoice");
    expect((await run(w, invoiceEvent("WH-2", "CHECKOUT.ORDER.APPROVED"))).note).toBe("ignored_event_type");
  });

  it("retries on an optimistic-lock conflict and transitions exactly once", async () => {
    const w = makeWorld("mahnung1");
    w.paypal.invoices.set(PP_INV, remoteInvoice({ status: "PAID", payments: [{ id: "PAY-1", date: "2026-11-01", cents: 100000 }] }));
    let bumped = false;
    w.store.beforeTransition = () => {
      if (!bumped) {
        bumped = true;
        w.store.cases.get(CASE)!.version += 1; // a concurrent writer touched the case
      }
    };
    await run(w, invoiceEvent("WH-1", "INVOICING.INVOICE.PAID"));
    expect(caseOf(w)).toMatchObject({ state: "closed_paid", version: 2 });
    expect(transitions(w)).toHaveLength(1);
  });

  it("processing two deliveries concurrently still writes one ledger row and one transition", async () => {
    const w = makeWorld("reminded");
    w.paypal.invoices.set(PP_INV, remoteInvoice({ status: "PAID", payments: [{ id: "PAY-1", date: "2026-11-01", cents: 100000 }] }));
    const r = new Reconciler(w);
    await Promise.all([r.reconcileInvoice(PP_INV), r.reconcileInvoice(PP_INV), r.reconcileInvoice(PP_INV)]);
    expect(w.store.ledger).toHaveLength(1);
    expect(transitions(w)).toHaveLength(1);
    expect(w.store.audit.filter((a) => a.action === "ledger.payment_recorded")).toHaveLength(1);
  });
});

describe("fee invoice after paid (interest and flat fee still owed)", () => {
  const paidWorld = (state: CaseState = "mahnung1", paymentDate = "2026-11-02") => {
    const w = makeWorld(state);
    w.paypal.invoices.set(PP_INV, remoteInvoice({ status: "PAID", payments: [{ id: "PAY-1", date: paymentDate, cents: 100000 }] }));
    return w;
  };
  const feeSteps = (w: World) => w.store.steps.filter((st) => st.kind === "fee_invoice");

  it("closes as closed_paid and proposes one fee_invoice step with the engine figures", async () => {
    const w = paidWorld();
    const ev = await run(w, invoiceEvent("WH-1", "INVOICING.INVOICE.PAID"));
    expect(ev.note).toBe("case.paid_in_full");
    expect(caseOf(w).state).toBe("closed_paid");
    // Default 2026-10-01. 32 days on 100000 at 10.52: 922.30 -> 922 (settled at the payment).
    // Payment 100000: fee 4000, interest 922, principal 95078 -> open 4922.
    // 2026-11-02..2026-11-13 (virtual date): 11 days on 4922: 15.60 -> 16. Total 4922 + 16 = 4938.
    expect(feeSteps(w)).toHaveLength(1);
    expect(feeSteps(w)[0]).toMatchObject({
      workspace_id: WS,
      case_id: CASE,
      kind: "fee_invoice",
      status: "proposed",
      facts: { principalCents: 100000, interestCents: 938, feeCents: 4000, totalCents: 4938, calcDate: "2026-11-13", defaultStart: "2026-10-01" },
    });
    const f = feeSteps(w)[0].facts as { interestCents: number; feeCents: number; totalCents: number };
    expect(f.interestCents + f.feeCents).toBe(f.totalCents);
    expect(w.store.audit.filter((a) => a.action === "step.fee_invoice_proposed")).toHaveLength(1);
    // Nothing is sent: the only PayPal call is the GET.
    expect(w.paypal.gets).toEqual([`invoice:${PP_INV}`]);
  });

  it("replays (same id, other ids, concurrent) never create a second proposed step", async () => {
    const w = paidWorld();
    await run(w, invoiceEvent("WH-1", "INVOICING.INVOICE.PAID"));
    await run(w, invoiceEvent("WH-1", "INVOICING.INVOICE.PAID"));
    await run(w, invoiceEvent("WH-2", "INVOICING.INVOICE.UPDATED"));
    const r = new Reconciler(w);
    await Promise.all([r.reconcileInvoice(PP_INV), r.reconcileInvoice(PP_INV), r.reconcileInvoice(PP_INV)]);
    expect(feeSteps(w)).toHaveLength(1);
    expect(w.store.audit.filter((a) => a.action === "step.fee_invoice_proposed")).toHaveLength(1);
    expect(transitions(w)).toHaveLength(1);
  });

  it("concurrent first deliveries create exactly one step", async () => {
    const w = paidWorld("reminded");
    const r = new Reconciler(w);
    await Promise.all([r.reconcileInvoice(PP_INV), r.reconcileInvoice(PP_INV), r.reconcileInvoice(PP_INV)]);
    expect(feeSteps(w)).toHaveLength(1);
    expect(transitions(w)).toHaveLength(1);
  });

  it("a rejected proposal is not proposed again on replay", async () => {
    const w = paidWorld();
    await run(w, invoiceEvent("WH-1", "INVOICING.INVOICE.PAID"));
    w.store.steps[0].status = "rejected";
    await run(w, invoiceEvent("WH-2", "INVOICING.INVOICE.PAID"));
    expect(feeSteps(w).map((st) => st.status)).toEqual(["rejected"]);
  });

  it("paid before the default start: no interest, no fee, no step", async () => {
    const w = paidWorld("open", "2026-09-30");
    await run(w, invoiceEvent("WH-1", "INVOICING.INVOICE.PAID"));
    expect(caseOf(w).state).toBe("closed_paid");
    expect(w.store.steps).toHaveLength(0);
    expect(w.store.audit.some((a) => a.action === "step.fee_invoice_proposed")).toBe(false);
  });

  it("consumer debtor: interest only, never the flat fee", async () => {
    const w = paidWorld();
    w.store.claimFacts.set(INV, { ...w.store.claimFacts.get(INV)!, debtor_type: "consumer" });
    await run(w, invoiceEvent("WH-1", "INVOICING.INVOICE.PAID"));
    // 32 days at 6.52: 571.6 -> 572. Payment: interest 572, principal 99428 -> open 572.
    // 11 days on 572: 1.12 -> 1. Total 573, all interest.
    expect(feeSteps(w)[0].facts).toMatchObject({ interestCents: 573, feeCents: 0, totalCents: 573 });
  });

  it("missing claim facts: still closes, no step, flagged for review", async () => {
    const w = paidWorld();
    w.store.claimFacts.delete(INV);
    const ev = await run(w, invoiceEvent("WH-1", "INVOICING.INVOICE.PAID"));
    expect(ev.note).toBe("case.paid_in_full");
    expect(caseOf(w).state).toBe("closed_paid");
    expect(w.store.steps).toHaveLength(0);
    expect(w.store.audit.some((a) => a.action === "reconcile.needs_review")).toBe(true);
  });

  it("no step when the paid status does not reconcile (needs review, case unchanged)", async () => {
    const w = makeWorld("mahnung1");
    w.paypal.invoices.set(PP_INV, remoteInvoice({ status: "PAID", payments: [{ id: "PAY-1", date: "2026-11-01", cents: 50000 }], dueCents: 0 }));
    await run(w, invoiceEvent("WH-1", "INVOICING.INVOICE.PAID"));
    expect(caseOf(w).state).toBe("mahnung1");
    expect(w.store.steps).toHaveLength(0);
  });
});

describe("disputes and capture refunds", () => {
  const disputeEvent = (id: string, type: string) => ({ event_id: id, event_type: type, payload: { id, event_type: type, resource: { dispute_id: "PP-D-1" } } });

  function withPayment(state: CaseState) {
    const w = makeWorld(state);
    w.store.ledger.push({ workspace_id: WS, invoice_id: INV, kind: "payment", amount_cents: 40000, booked_on: "2026-10-20", paypal_ref: "TX-1", source: "paypal" });
    w.paypal.invoices.set(PP_INV, remoteInvoice({ status: "PARTIALLY_PAID", payments: [{ id: "TX-1", date: "2026-10-20", cents: 40000 }] }));
    return w;
  }

  it("pauses on an open dispute and resumes to the same stage on resolution", async () => {
    const w = withPayment("mahnung1");
    w.paypal.disputes.set("PP-D-1", { dispute_id: "PP-D-1", status: "OPEN", disputed_transactions: [{ seller_transaction_id: "TX-1" }] });
    await run(w, disputeEvent("WH-D1", "CUSTOMER.DISPUTE.CREATED"));
    expect(caseOf(w)).toMatchObject({ state: "paused_dispute", prev_state: "mahnung1", paused_reason: "dispute:PP-D-1" });
    await run(w, disputeEvent("WH-D1", "CUSTOMER.DISPUTE.CREATED")); // replay
    w.paypal.disputes.get("PP-D-1")!.status = "UNDER_REVIEW";
    await run(w, disputeEvent("WH-D2", "CUSTOMER.DISPUTE.UPDATED"));
    expect(transitions(w)).toHaveLength(1);
    w.paypal.disputes.get("PP-D-1")!.status = "RESOLVED";
    await run(w, disputeEvent("WH-D3", "CUSTOMER.DISPUTE.RESOLVED"));
    expect(caseOf(w)).toMatchObject({ state: "mahnung1", paused_reason: null });
    expect(transitions(w).map((t) => t.action)).toEqual(["case.dispute_opened", "case.dispute_resolved"]);
    expect(w.paypal.gets).toContain(`invoice:${PP_INV}`); // resolution re-syncs the invoice
  });

  it("does not pause when CREATED is processed after the dispute already resolved", async () => {
    const w = withPayment("reminded");
    w.paypal.disputes.set("PP-D-1", { dispute_id: "PP-D-1", status: "RESOLVED", disputed_transactions: [{ seller_transaction_id: "TX-1" }] });
    await run(w, disputeEvent("WH-D3", "CUSTOMER.DISPUTE.RESOLVED"));
    await run(w, disputeEvent("WH-D1", "CUSTOMER.DISPUTE.CREATED"));
    expect(caseOf(w).state).toBe("reminded");
    expect(transitions(w)).toHaveLength(0);
  });

  it("links by invoice number when no transaction matches, flags disputes on closed cases", async () => {
    const w = makeWorld("closed_paid");
    w.paypal.disputes.set("PP-D-1", { dispute_id: "PP-D-1", status: "OPEN", disputed_transactions: [{ invoice_number: "MW-0001" }] });
    expect((await run(w, disputeEvent("WH-D1", "CUSTOMER.DISPUTE.CREATED"))).note).toBe("state_conflict");
    expect(caseOf(w).state).toBe("closed_paid");
  });

  it("leaves unlinked disputes alone", async () => {
    const w = makeWorld("reminded");
    w.paypal.disputes.set("PP-D-1", { dispute_id: "PP-D-1", status: "OPEN", disputed_transactions: [{ seller_transaction_id: "TX-UNKNOWN" }] });
    expect((await run(w, disputeEvent("WH-D1", "CUSTOMER.DISPUTE.CREATED"))).note).toBe("dispute_unlinked");
  });

  it("PAYMENT.CAPTURE.REFUNDED finds the invoice through the capture and reconciles from the invoice GET", async () => {
    const w = withPayment("mahnung1");
    w.paypal.refunds.set("RF-1", {
      id: "RF-1",
      status: "COMPLETED",
      amount: { currency_code: "EUR", value: "999.00" }, // must not be used
      links: [{ rel: "up", href: "https://api.sandbox.paypal.com/v2/payments/captures/TX-1", method: "GET" }],
    });
    w.paypal.invoices.set(
      PP_INV,
      remoteInvoice({ status: "SENT", payments: [{ id: "TX-1", date: "2026-10-20", cents: 40000 }], refunds: [{ id: "RF-1", date: "2026-10-28", cents: 40000 }] }),
    );
    await run(w, { event_id: "WH-R1", event_type: "PAYMENT.CAPTURE.REFUNDED", payload: { id: "WH-R1", resource: { id: "RF-1" } } });
    expect(w.store.ledger.filter((l) => l.kind === "refund").map((l) => l.amount_cents)).toEqual([40000]);
    expect(caseOf(w).state).toBe("mahnung1");
  });
});
