// Reconciles PayPal state into Mahnwerk (ledger, invoice sync fields, case state).
// Never trusts webhook payloads: the payload only tells us WHICH resource changed. Every amount,
// date and status comes from a fresh GET. Because the outcome depends only on the current PayPal
// state, processing is idempotent and order-independent (replays and out-of-order events converge).

import { addDays, isValidIsoDate } from "../rules/dates";
import { moneyToCents } from "../paypal/money";
import type { PayPalCaptureRefund, PayPalDispute, PayPalInvoice } from "../paypal/schemas";
import { isActive, transition, type CaseEvent, type CaseSnapshot, type CaseState } from "./stateMachine";
import type { AuditRow, CaseRow, InvoiceRow, LedgerRow, ReconcileStore, StoredEvent } from "./store";

export interface PayPalReader {
  getInvoice(id: string): Promise<PayPalInvoice>;
  getDispute(id: string): Promise<PayPalDispute>;
  getCaptureRefund(id: string): Promise<PayPalCaptureRefund>;
}

export interface ReconcileDeps {
  paypal: PayPalReader;
  store: ReconcileStore;
  /** Wall clock in ms; injected so tests are deterministic. */
  now: () => number;
}

export interface ProcessResult {
  workspaceId: string | null;
  note: string | null;
}

export const HANDLED_EVENT_TYPES = [
  "INVOICING.INVOICE.PAID",
  "INVOICING.INVOICE.UPDATED",
  "INVOICING.INVOICE.CANCELLED",
  "INVOICING.INVOICE.REFUNDED",
  "CUSTOMER.DISPUTE.CREATED",
  "CUSTOMER.DISPUTE.UPDATED",
  "CUSTOMER.DISPUTE.RESOLVED",
  "PAYMENT.CAPTURE.REFUNDED",
] as const;

const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_CAS_RETRIES = 3;

export class ReconcileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReconcileError";
  }
}

// ------------------------------------------------------------------ helpers

function str(v: unknown): string | null {
  return typeof v === "string" && ID_RE.test(v) ? v : null;
}

/** Extracts only the resource id from a webhook payload. Nothing else from the payload is used. */
export function extractResourceId(eventType: string, resource: Record<string, unknown>): string | null {
  if (eventType.startsWith("INVOICING.INVOICE.")) {
    const nested = resource.invoice as Record<string, unknown> | undefined;
    return str(resource.id) ?? str(nested?.id);
  }
  if (eventType.startsWith("CUSTOMER.DISPUTE.")) return str(resource.dispute_id) ?? str(resource.id);
  if (eventType === "PAYMENT.CAPTURE.REFUNDED") return str(resource.id);
  return null;
}

function toIsoDay(raw: string | undefined, what: string): string {
  const day = raw?.slice(0, 10);
  if (!day || !isValidIsoDate(day)) throw new ReconcileError(`${what} has no valid date (${JSON.stringify(raw)})`);
  return day;
}

export interface RemoteLedgerEntry {
  kind: "payment" | "refund";
  amount_cents: number;
  booked_on: string;
  paypal_ref: string;
}

/** Turns the payments and refunds of a fetched invoice into ledger entries. Throws on anything ambiguous. */
export function remoteLedger(remote: PayPalInvoice, currency: string): RemoteLedgerEntry[] {
  const out: RemoteLedgerEntry[] = [];
  const seen = new Set<string>();
  const push = (e: RemoteLedgerEntry) => {
    const key = `${e.kind}:${e.paypal_ref}`;
    if (seen.has(key)) throw new ReconcileError(`PayPal invoice ${remote.id} lists ${key} twice`);
    seen.add(key);
    out.push(e);
  };
  for (const p of remote.payments?.transactions ?? []) {
    const ref = p.payment_id ?? p.transaction_id;
    if (!ref) throw new ReconcileError(`Payment without id on PayPal invoice ${remote.id}`);
    const amount = moneyToCents(p.amount, currency);
    if (amount <= 0) throw new ReconcileError(`Non-positive payment ${ref} on ${remote.id}`);
    push({ kind: "payment", amount_cents: amount, booked_on: toIsoDay(p.payment_date, `Payment ${ref}`), paypal_ref: ref });
  }
  for (const r of remote.refunds?.transactions ?? []) {
    const ref = r.refund_id ?? r.transaction_id;
    if (!ref) throw new ReconcileError(`Refund without id on PayPal invoice ${remote.id}`);
    const amount = moneyToCents(r.amount, currency);
    if (amount <= 0) throw new ReconcileError(`Non-positive refund ${ref} on ${remote.id}`);
    push({ kind: "refund", amount_cents: amount, booked_on: toIsoDay(r.refund_date, `Refund ${ref}`), paypal_ref: ref });
  }
  return out;
}

export type DesiredOutcome = "cancelled" | "refunded" | "paid" | "unpaid" | "none" | "review";

export interface RemoteFacts {
  status: string;
  totalCents: number;
  paidCents: number;
  refundedCents: number;
  /** null when PayPal did not return due_amount. */
  dueCents: number | null;
}

const UNPAID_STATUSES = new Set(["SENT", "UNPAID", "PARTIALLY_PAID", "PAYMENT_PENDING", "SCHEDULED"]);

/** What PayPal says the claim looks like, independent of our current case state. */
export function desiredOutcome(f: RemoteFacts): { outcome: DesiredOutcome; why?: string } {
  switch (f.status) {
    case "CANCELLED":
      return { outcome: "cancelled" };
    case "REFUNDED":
    case "MARKED_AS_REFUNDED":
      return { outcome: "refunded" };
    case "PAID":
    case "MARKED_AS_PAID":
      if (f.paidCents - f.refundedCents < f.totalCents) return { outcome: "review", why: "status paid but net paid is below the invoice total" };
      if (f.dueCents !== null && f.dueCents > 0) return { outcome: "review", why: "status paid but due_amount is above zero" };
      return { outcome: "paid" };
    case "PARTIALLY_REFUNDED":
      // A partial refund only reopens the claim when PayPal itself reports a balance due again.
      if (f.dueCents === null) return { outcome: "review", why: "partially refunded without due_amount" };
      if (f.dueCents > 0) return { outcome: "unpaid" };
      return { outcome: "paid", why: "partial refund without balance due" };
    case "DRAFT":
      return { outcome: "none" };
    default:
      if (UNPAID_STATUSES.has(f.status)) return { outcome: "unpaid" };
      return { outcome: "review", why: `unknown PayPal status ${f.status}` };
  }
}

/** Maps the desired outcome onto a case event, or a review flag when the two cannot be reconciled. */
export function caseEventFor(state: CaseState, outcome: DesiredOutcome): { event: CaseEvent | null; conflict?: string } {
  const activeOrPaused = isActive(state) || state === "paused_dispute";
  switch (outcome) {
    case "cancelled":
      if (activeOrPaused) return { event: { type: "cancelled" } };
      if (state === "closed_cancelled") return { event: null };
      return { event: null, conflict: `PayPal cancelled but case is ${state}` };
    case "refunded":
      if (activeOrPaused || state === "closed_paid") return { event: { type: "refunded_in_full" } };
      if (state === "closed_refunded") return { event: null };
      return { event: null, conflict: `PayPal refunded but case is ${state}` };
    case "paid":
      if (activeOrPaused) return { event: { type: "paid_in_full" } };
      if (state === "closed_paid") return { event: null };
      return { event: null, conflict: `PayPal paid but case is ${state}` };
    case "unpaid":
      if (state === "closed_paid") return { event: { type: "reopened" } };
      if (state === "closed_refunded" || state === "closed_cancelled") return { event: null, conflict: `PayPal unpaid but case is ${state}` };
      return { event: null };
    default:
      return { event: null };
  }
}

// ------------------------------------------------------------------ reconciler

export class Reconciler {
  constructor(private readonly deps: ReconcileDeps) {}

  private virtualDate = async (workspaceId: string): Promise<string> => {
    const today = new Date(this.deps.now()).toISOString().slice(0, 10);
    return addDays(today, await this.deps.store.getWorkspaceClockOffsetDays(workspaceId));
  };

  private async audit(inv: InvoiceRow, caseId: string | null, action: string, details: Record<string, unknown>, actor: AuditRow["actor"] = "paypal") {
    await this.deps.store.insertAudit({
      workspace_id: inv.workspace_id,
      case_id: caseId,
      invoice_id: inv.id,
      actor,
      action,
      virtual_date: await this.virtualDate(inv.workspace_id),
      details,
    });
  }

  async processEvent(event: Pick<StoredEvent, "event_id" | "event_type" | "payload">): Promise<ProcessResult> {
    const payload = (event.payload ?? {}) as { resource?: Record<string, unknown> };
    const resource = payload.resource ?? {};
    const ctx = { event_id: event.event_id, event_type: event.event_type };
    if (!(HANDLED_EVENT_TYPES as readonly string[]).includes(event.event_type)) {
      return { workspaceId: null, note: "ignored_event_type" };
    }
    const id = extractResourceId(event.event_type, resource);
    if (!id) throw new ReconcileError(`No usable resource id in ${event.event_type}`);

    if (event.event_type.startsWith("INVOICING.INVOICE.")) return this.reconcileInvoice(id, ctx);
    if (event.event_type.startsWith("CUSTOMER.DISPUTE.")) return this.reconcileDispute(id, ctx);
    return this.reconcileCaptureRefund(id, ctx);
  }

  async reconcileInvoice(paypalInvoiceId: string, ctx: Record<string, unknown> = {}): Promise<ProcessResult> {
    const { store, paypal } = this.deps;
    const inv = await store.findInvoiceByPayPalId(paypalInvoiceId);
    if (!inv) return { workspaceId: null, note: "unknown_invoice" };

    const remote = await paypal.getInvoice(paypalInvoiceId);
    if (remote.id !== paypalInvoiceId) throw new ReconcileError(`GET returned invoice ${remote.id} for ${paypalInvoiceId}`);

    const problems: string[] = [];
    const totalCents = remote.amount ? moneyToCents(remote.amount, inv.currency) : null;
    if (totalCents === null) problems.push("PayPal invoice has no amount");
    else if (totalCents !== inv.principal_cents) problems.push(`PayPal total ${totalCents} differs from principal ${inv.principal_cents}`);

    const entries = remoteLedger(remote, inv.currency);
    const paidCents = entries.filter((e) => e.kind === "payment").reduce((a, e) => a + e.amount_cents, 0);
    const refundedCents = entries.filter((e) => e.kind === "refund").reduce((a, e) => a + e.amount_cents, 0);
    const dueCents = remote.due_amount ? moneyToCents(remote.due_amount, inv.currency) : null;
    if (remote.payments?.paid_amount && moneyToCents(remote.payments.paid_amount, inv.currency) !== paidCents) {
      problems.push("paid_amount does not match the sum of payment transactions");
    }
    if (remote.refunds?.refund_amount && moneyToCents(remote.refunds.refund_amount, inv.currency) !== refundedCents) {
      problems.push("refund_amount does not match the sum of refund transactions");
    }
    if (refundedCents > paidCents) problems.push("refunds exceed payments");

    // Existing rows are never changed or deleted. Differences are flagged for a human.
    const existing = await store.listLedger(inv.id);
    for (const row of existing.filter((r) => r.source === "paypal")) {
      const match = entries.find((e) => e.kind === row.kind && e.paypal_ref === row.paypal_ref);
      if (!match) problems.push(`ledger ${row.kind} ${row.paypal_ref} no longer listed at PayPal`);
      else if (match.amount_cents !== row.amount_cents || match.booked_on !== row.booked_on) {
        problems.push(`ledger ${row.kind} ${row.paypal_ref} changed at PayPal`);
      }
    }

    const toInsert: LedgerRow[] = entries
      .filter((e) => !existing.some((r) => r.kind === e.kind && r.paypal_ref === e.paypal_ref))
      .map((e) => ({ ...e, workspace_id: inv.workspace_id, invoice_id: inv.id, source: "paypal" as const }));
    if (refundedCents <= paidCents && toInsert.length > 0) {
      const inserted = await store.insertLedgerIgnoreDuplicates(toInsert);
      for (const r of inserted) {
        await this.audit(inv, null, `ledger.${r.kind}_recorded`, {
          ...ctx,
          amount_cents: r.amount_cents,
          booked_on: r.booked_on,
          paypal_ref: r.paypal_ref,
        });
      }
    }

    await store.updateInvoiceSync(inv.id, {
      paypal_status: remote.status,
      paypal_paid_cents: paidCents,
      paypal_refunded_cents: refundedCents,
      paypal_due_cents: dueCents,
      last_synced_at: new Date(this.deps.now()).toISOString(),
    });

    const caseRow = await store.getCaseByInvoice(inv.id);
    if (problems.length > 0) {
      await this.audit(inv, caseRow?.id ?? null, "reconcile.needs_review", { ...ctx, problems, paypal_status: remote.status }, "system");
      return { workspaceId: inv.workspace_id, note: "needs_review" };
    }
    if (!caseRow) return { workspaceId: inv.workspace_id, note: "no_case" };

    const facts: RemoteFacts = { status: remote.status, totalCents: totalCents as number, paidCents, refundedCents, dueCents };
    const desired = desiredOutcome(facts);
    if (desired.outcome === "review") {
      await this.audit(inv, caseRow.id, "reconcile.needs_review", { ...ctx, problems: [desired.why], paypal_status: remote.status }, "system");
      return { workspaceId: inv.workspace_id, note: "needs_review" };
    }

    const details = { ...ctx, paypal_status: remote.status, paid_cents: paidCents, refunded_cents: refundedCents, due_cents: dueCents, why: desired.why };
    const note = await this.applyCaseOutcome(inv, (state) => caseEventFor(state, desired.outcome), details);
    if (remote.status === "PARTIALLY_REFUNDED" && desired.outcome === "paid") {
      await this.audit(inv, caseRow.id, "reconcile.partial_refund_review", { ...ctx, refunded_cents: refundedCents }, "system");
    }
    return { workspaceId: inv.workspace_id, note };
  }

  /** Applies the event chosen for the current state, with optimistic locking and retry on conflict. */
  private async applyCaseOutcome(
    inv: InvoiceRow,
    choose: (state: CaseState, row: CaseRow) => { event: CaseEvent | null; conflict?: string },
    details: Record<string, unknown>,
  ): Promise<string> {
    const { store } = this.deps;
    for (let attempt = 0; attempt < MAX_CAS_RETRIES; attempt++) {
      const row = await store.getCaseByInvoice(inv.id);
      if (!row) return "no_case";
      const { event, conflict } = choose(row.state, row);
      if (conflict) {
        await this.audit(inv, row.id, "reconcile.state_conflict", { ...details, conflict }, "system");
        return "state_conflict";
      }
      if (!event) return "no_change";
      const snap: CaseSnapshot = { state: row.state, resumeState: row.prev_state, pausedReason: row.paused_reason };
      const next = transition(snap, event);
      const ok = await store.transitionCase({
        caseId: row.id,
        expectedVersion: row.version,
        fromState: row.state,
        toState: next.state,
        prevState: next.resumeState,
        pausedReason: next.pausedReason,
        actor: "paypal",
        action: `case.${event.type}`,
        virtualDate: await this.virtualDate(inv.workspace_id),
        details,
      });
      if (ok) return `case.${event.type}`;
    }
    throw new ReconcileError(`Case for invoice ${inv.id} kept changing; giving up after ${MAX_CAS_RETRIES} attempts`);
  }

  async reconcileDispute(disputeId: string, ctx: Record<string, unknown> = {}): Promise<ProcessResult> {
    const { store, paypal } = this.deps;
    const d = await paypal.getDispute(disputeId);
    if (d.dispute_id !== disputeId) throw new ReconcileError(`GET returned dispute ${d.dispute_id} for ${disputeId}`);

    let inv: InvoiceRow | null = null;
    for (const t of d.disputed_transactions ?? []) {
      if (!inv && t.seller_transaction_id) inv = await store.findInvoiceByLedgerRef(t.seller_transaction_id);
      if (!inv && t.invoice_number) inv = await store.findInvoiceByNumber(t.invoice_number);
    }
    if (!inv) return { workspaceId: null, note: "dispute_unlinked" };

    const reason = `dispute:${d.dispute_id}`;
    const details = { ...ctx, dispute_id: d.dispute_id, dispute_status: d.status, outcome: d.dispute_outcome?.outcome_code ?? null };
    const resolved = d.status === "RESOLVED";

    const note = await this.applyCaseOutcome(
      inv,
      (state, row) => {
        if (resolved) {
          if (state === "paused_dispute" && row.paused_reason === reason) return { event: { type: "dispute_resolved", reason } };
          return { event: null };
        }
        if (isActive(state)) return { event: { type: "dispute_opened", reason } };
        if (state === "paused_dispute") {
          return row.paused_reason === reason ? { event: null } : { event: null, conflict: "another dispute already pauses this case" };
        }
        return { event: null, conflict: `dispute open on a ${state} case` };
      },
      details,
    );

    // A resolution can move money (refund or reversal): bring the invoice up to date as well.
    if (resolved && inv.paypal_invoice_id) {
      const r = await this.reconcileInvoice(inv.paypal_invoice_id, ctx);
      return { workspaceId: inv.workspace_id, note: `${note};${r.note}` };
    }
    return { workspaceId: inv.workspace_id, note };
  }

  async reconcileCaptureRefund(refundId: string, ctx: Record<string, unknown> = {}): Promise<ProcessResult> {
    const { store, paypal } = this.deps;
    const refund = await paypal.getCaptureRefund(refundId);
    const up = refund.links?.find((l) => l.rel === "up" && /\/v2\/payments\/captures\//.test(l.href));
    const captureId = up ? (up.href.split("/captures/")[1] ?? "").split(/[/?#]/)[0] : null;

    let inv: InvoiceRow | null = null;
    if (captureId && ID_RE.test(captureId)) inv = await store.findInvoiceByLedgerRef(captureId);
    if (!inv && refund.invoice_id) inv = await store.findInvoiceByNumber(refund.invoice_id);
    if (!inv || !inv.paypal_invoice_id) return { workspaceId: null, note: "refund_unlinked" };
    return this.reconcileInvoice(inv.paypal_invoice_id, { ...ctx, refund_id: refund.id });
  }
}
