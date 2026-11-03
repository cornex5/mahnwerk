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

  getCaseByInvoice(invoiceId: string): Promise<CaseRow | null>;
  /** Atomic: updates the case if version and state match, and writes the audit row. False on conflict. */
  transitionCase(write: CaseTransitionWrite): Promise<boolean>;
  insertAudit(row: AuditRow): Promise<void>;
}
