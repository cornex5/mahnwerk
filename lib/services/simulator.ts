// Customer simulator for the demo (PayPal SANDBOX only): pay in full, pay partially, refund, open
// and resolve a dispute. Every action ends in the same reconciler path a webhook uses, called
// directly after the PayPal call, so the demo works even when the webhook is late or never comes.
//
// Limitations (sandbox):
// - A buyer paying through the PayPal checkout needs an interactive buyer login. The simulator
//   therefore uses the merchant "record payment" and "record refund" Invoicing APIs, which PayPal
//   lists as external (e.g. BANK_TRANSFER) transactions. Webhooks for these may differ from a real
//   PayPal checkout payment.
// - Disputes can only be opened by a buyer on a real PayPal transaction, which recorded payments
//   are not. Dispute actions use a synthetic dispute (id SIM-D-...) fed to the reconciler through a
//   PayPalReader wrapper; everything else (invoice GETs) still goes to PayPal.

import { Reconciler, type PayPalReader, type ProcessResult } from "../cases/reconcile";
import { centsToMoney, moneyToCents } from "../paypal/money";
import type { PayPalDispute } from "../paypal/schemas";
import { ServiceError } from "./errors";
import { assertSandbox, loadMutableWorkspace, realToday, stableKey, virtualDateFor, type PayPalPort, type ServiceDeps } from "./context";
import { isDefinitivePayPalFailure, payPalIssue } from "./paypalErrors";
import { refreshProposals } from "./steps";
import type { FullCaseRow, FullInvoiceRow } from "./store";

export type SimulatorAction =
  | { type: "pay_full" }
  | { type: "pay_partial"; amountCents: number }
  | { type: "refund"; amountCents?: number }
  | { type: "dispute_open" }
  | { type: "dispute_resolve" };

export interface SimulateResult {
  action: SimulatorAction["type"];
  reconcile: ProcessResult;
  case: FullCaseRow;
  /** PayPal payment or refund id when one was recorded. */
  paypalRef?: string;
  /** Set when PayPal refused the virtual date and the real date was used instead. */
  usedRealDate?: boolean;
}

const NONCE_RE = /^[A-Za-z0-9_-]{8,64}$/;

export function simDisputeId(caseId: string): string {
  return `SIM-D-${caseId.replace(/-/g, "").slice(0, 16).toUpperCase()}`;
}

/** Serves one synthetic dispute; every other call goes to the real PayPal port. */
export class SimDisputeReader implements PayPalReader {
  constructor(
    private readonly inner: Pick<PayPalPort, "getInvoice" | "getDispute" | "getCaptureRefund">,
    private readonly dispute: PayPalDispute,
  ) {}
  getInvoice(id: string) {
    return this.inner.getInvoice(id);
  }
  async getDispute(id: string) {
    if (id === this.dispute.dispute_id) return structuredClone(this.dispute);
    return this.inner.getDispute(id);
  }
  getCaptureRefund(id: string) {
    return this.inner.getCaptureRefund(id);
  }
}

function isDateRejection(err: unknown): boolean {
  return isDefinitivePayPalFailure(err) && /DATE/i.test(payPalIssue(err) ?? "");
}

export async function simulate(deps: ServiceDeps, actorUid: string, caseId: string, action: SimulatorAction, nonce: string): Promise<SimulateResult> {
  assertSandbox(deps);
  if (!NONCE_RE.test(nonce)) throw new ServiceError("invalid_input", "nonce must be 8 to 64 characters [A-Za-z0-9_-]");
  const c = await deps.store.getCase(caseId);
  if (!c) throw new ServiceError("not_found", "Case not found");
  const ws = await loadMutableWorkspace(deps, c.workspace_id, actorUid);
  const inv = await deps.store.getFullInvoice(c.invoice_id);
  if (!inv?.paypal_invoice_id) throw new ServiceError("not_executable", "The invoice has no PayPal invoice");
  const virtualDate = virtualDateFor(ws, deps.now());
  // Bring the case up to date first (open -> overdue when the due date has passed).
  await refreshProposals(deps, ws.id).catch(() => undefined);
  const requestId = `mw-sim-${stableKey(caseId, action.type, nonce).slice(0, 32)}`;

  await deps.store.insertAudit({
    workspace_id: ws.id,
    case_id: c.id,
    invoice_id: inv.id,
    actor: "user",
    action: `simulator.${action.type}`,
    virtual_date: virtualDate,
    details: { ...action, actor_uid: actorUid, nonce },
  });

  let out: Omit<SimulateResult, "case">;
  if (action.type === "dispute_open" || action.type === "dispute_resolve") {
    out = await simulateDispute(deps, c, inv, action.type);
  } else {
    out = await simulateMoney(deps, inv, action, virtualDate, requestId);
  }

  // Bring proposals up to date (e.g. a resolved dispute resumes the ladder). Never fails the action.
  await refreshProposals(deps, ws.id).catch(() => undefined);
  return { ...out, case: (await deps.store.getCase(c.id)) as FullCaseRow };
}

async function simulateMoney(
  deps: ServiceDeps,
  inv: FullInvoiceRow,
  action: Extract<SimulatorAction, { type: "pay_full" | "pay_partial" | "refund" }>,
  virtualDate: string,
  requestId: string,
): Promise<Omit<SimulateResult, "case">> {
  const ppId = inv.paypal_invoice_id as string;
  const remote = await deps.paypal.getInvoice(ppId);
  const total = remote.amount ? moneyToCents(remote.amount, inv.currency) : inv.principal_cents;
  const paid = remote.payments?.paid_amount ? moneyToCents(remote.payments.paid_amount, inv.currency) : 0;
  const refunded = remote.refunds?.refund_amount ? moneyToCents(remote.refunds.refund_amount, inv.currency) : 0;
  const due = remote.due_amount ? moneyToCents(remote.due_amount, inv.currency) : Math.max(0, total - paid);

  let amount: number;
  if (action.type === "pay_full") {
    amount = due;
    if (amount <= 0) throw new ServiceError("invalid_input", "Nothing is due on this invoice at PayPal");
  } else if (action.type === "pay_partial") {
    amount = action.amountCents;
    if (!Number.isSafeInteger(amount) || amount <= 0 || amount >= due) {
      throw new ServiceError("invalid_input", `A partial payment must be between 1 and ${due - 1} cents`);
    }
  } else {
    const refundable = paid - refunded;
    amount = action.amountCents ?? refundable;
    if (!Number.isSafeInteger(amount) || amount <= 0 || amount > refundable) {
      throw new ServiceError("invalid_input", `A refund must be between 1 and ${refundable} cents (recorded payments minus refunds)`);
    }
  }

  const money = centsToMoney(amount, inv.currency);
  const record = (date: string, rid: string) =>
    action.type === "refund"
      ? deps.paypal.recordRefund(ppId, { method: "BANK_TRANSFER", refund_date: date, amount: money }, { requestId: rid })
      : deps.paypal.recordPayment(ppId, { method: "BANK_TRANSFER", payment_date: date, amount: money, note: "Mahnwerk simulator" }, { requestId: rid });

  const reconciler = new Reconciler({ paypal: deps.paypal, store: deps.store, now: deps.now });
  let ref: string;
  let usedRealDate = false;
  try {
    try {
      ref = await record(virtualDate, requestId);
    } catch (err) {
      // PayPal may refuse a payment date in the future (the demo clock runs ahead). Fall back to today.
      if (!isDateRejection(err) || virtualDate === realToday(deps.now())) throw err;
      ref = await record(realToday(deps.now()), `${requestId}-rt`);
      usedRealDate = true;
    }
  } catch (err) {
    // The write may have happened even though the response was lost: reconcile anyway (GET based,
    // idempotent), so local state matches PayPal whatever happened.
    await reconciler.reconcileInvoice(ppId, { source: "simulator", action: action.type, after_error: true }).catch(() => undefined);
    throw new ServiceError("paypal_failed", "PayPal did not confirm the transaction; the invoice was re-synced", { issue: payPalIssue(err) ?? null });
  }

  const reconcile = await reconciler.reconcileInvoice(ppId, { source: "simulator", action: action.type, paypal_ref: ref });
  return { action: action.type, reconcile, paypalRef: ref, ...(usedRealDate ? { usedRealDate } : {}) };
}

async function simulateDispute(
  deps: ServiceDeps,
  c: FullCaseRow,
  inv: FullInvoiceRow,
  type: "dispute_open" | "dispute_resolve",
): Promise<Omit<SimulateResult, "case">> {
  if (!inv.number) throw new ServiceError("not_executable", "The invoice has no number to link a dispute");
  const id = simDisputeId(c.id);
  if (type === "dispute_resolve" && !(c.state === "paused_dispute" && c.paused_reason === `dispute:${id}`)) {
    throw new ServiceError("not_executable", "There is no open simulated dispute on this case");
  }
  const dispute: PayPalDispute = {
    dispute_id: id,
    status: type === "dispute_open" ? "OPEN" : "RESOLVED",
    reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
    disputed_transactions: [{ invoice_number: inv.number }],
    ...(type === "dispute_resolve" ? { dispute_outcome: { outcome_code: "RESOLVED_IN_SELLER_FAVOUR" } } : {}),
  };
  const reconciler = new Reconciler({ paypal: new SimDisputeReader(deps.paypal, dispute), store: deps.store, now: deps.now });
  const reconcile = await reconciler.reconcileDispute(id, { source: "simulator", action: type, simulated: true });
  return { action: type, reconcile };
}
