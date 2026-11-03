// Persistence port for the webhook pipeline and the reconciler. The Supabase implementation lives
// in lib/db/supabaseStore.ts; tests use lib/cases/memoryStore.ts.

import type { ActiveState, CaseState } from "./stateMachine";

export interface PayPalEventRow {
  event_id: string;
  event_type: string;
  resource_type: string | null;
  resource_id: string | null;
  verified: boolean;
  payload: unknown;
}

export interface StoredEvent extends PayPalEventRow {
  processed_at: string | null;
  attempts: number;
}

export interface InvoiceRow {
  id: string;
  workspace_id: string;
  paypal_invoice_id: string | null;
  number: string | null;
  currency: string;
  principal_cents: number;
}

export interface InvoiceSyncPatch {
  paypal_status: string;
  paypal_paid_cents: number;
  paypal_refunded_cents: number;
  paypal_due_cents: number | null;
  last_synced_at: string;
}

export interface LedgerRow {
  workspace_id: string;
  invoice_id: string;
  kind: "payment" | "refund";
  amount_cents: number;
  booked_on: string;
  paypal_ref: string;
  source: "paypal" | "manual";
}

/** Invoice facts the rules engine needs beyond InvoiceRow (from invoices, debtors and the audit log). */
export interface ClaimFacts {
  due_date: string;
  fixed_calendar_due: boolean;
  default_warning_printed: boolean;
  received_on: string | null;
  debtor_type: "consumer" | "business";
  /** Virtual date of the first sent reminder or Mahnung (BGB 286(1)), null if none was sent. */
  first_payment_request_on: string | null;
}

export type StepKind = "reminder" | "mahnung1" | "mahnung2" | "handover" | "fee_invoice" | "close";
export type StepStatus = "proposed" | "approved" | "sent" | "rejected" | "failed";

export interface StepRow {
  workspace_id: string;
  case_id: string;
  kind: StepKind;
  status: StepStatus;
  facts: Record<string, unknown>;
}

export interface CaseRow {
  id: string;
  workspace_id: string;
  invoice_id: string;
  state: CaseState;
  prev_state: ActiveState | null;
  paused_reason: string | null;
  version: number;
}

export type AuditActor = "user" | "system" | "ai" | "paypal";

export interface AuditRow {
  workspace_id: string | null;
  case_id: string | null;
  invoice_id: string | null;
  actor: AuditActor;
  action: string;
  from_state?: string | null;
  to_state?: string | null;
  virtual_date?: string | null;
  details?: Record<string, unknown>;
}

export interface CaseTransitionWrite {
  caseId: string;
  expectedVersion: number;
  fromState: CaseState;
  toState: CaseState;
  prevState: ActiveState | null;
  pausedReason: string | null;
  actor: AuditActor;
  action: string;
  virtualDate: string | null;
  details: Record<string, unknown>;
}

export interface ReconcileStore {
  /** Inserts the event unless its event_id exists. Returns the stored row and whether it was new. */
  insertEventIfNew(row: PayPalEventRow): Promise<{ inserted: boolean; event: StoredEvent }>;
  markEventProcessed(eventId: string, info: { workspaceId: string | null; note: string | null }): Promise<void>;
  markEventFailed(eventId: string, error: string): Promise<void>;

  findInvoiceByPayPalId(paypalInvoiceId: string): Promise<InvoiceRow | null>;
  findInvoiceByNumber(number: string): Promise<InvoiceRow | null>;
  /** Finds the invoice owning a ledger row with this PayPal reference (payment or transaction id). */
  findInvoiceByLedgerRef(ref: string): Promise<InvoiceRow | null>;
  getWorkspaceClockOffsetDays(workspaceId: string): Promise<number>;

  listLedger(invoiceId: string): Promise<LedgerRow[]>;
  /** Inserts rows, ignoring any (invoice_id, kind, paypal_ref) that already exists. Returns rows actually inserted. */
  insertLedgerIgnoreDuplicates(rows: LedgerRow[]): Promise<LedgerRow[]>;
  updateInvoiceSync(invoiceId: string, patch: InvoiceSyncPatch): Promise<void>;

  /** Engine inputs for an invoice, or null when the invoice or its debtor is missing. */
  getClaimFacts(invoiceId: string): Promise<ClaimFacts | null>;

  getCaseByInvoice(invoiceId: string): Promise<CaseRow | null>;
  /**
   * Inserts a 'fee_invoice' step in status 'proposed' unless the case already has a fee_invoice
   * step in any status (a rejected one is a human decision and is not re-proposed). Returns true
   * when inserted. Backed by a partial unique index in SQL (migration 0002).
   */
  insertFeeInvoiceStepIfAbsent(row: StepRow & { kind: "fee_invoice"; status: "proposed" }): Promise<boolean>;
  /** Atomic: updates the case if version and state match, and writes the audit row. False on conflict. */
  transitionCase(write: CaseTransitionWrite): Promise<boolean>;
  insertAudit(row: AuditRow): Promise<void>;
}
