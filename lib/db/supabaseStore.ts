// ReconcileStore backed by Supabase (service role). Uniqueness and locking are enforced by the
// database: unique event_id, unique (invoice_id, kind, paypal_ref), and mw_transition_case().

import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  AuditRow,
  CaseRow,
  CaseTransitionWrite,
  InvoiceRow,
  InvoiceSyncPatch,
  LedgerRow,
  PayPalEventRow,
  ReconcileStore,
  StoredEvent,
} from "../cases/store";

const INVOICE_COLS = "id, workspace_id, paypal_invoice_id, number, currency, principal_cents";
const LEDGER_COLS = "workspace_id, invoice_id, kind, amount_cents, booked_on, paypal_ref, source";
const CASE_COLS = "id, workspace_id, invoice_id, state, prev_state, paused_reason, version";
const EVENT_COLS = "event_id, event_type, resource_type, resource_id, verified, payload, processed_at, attempts";

function fail(op: string, error: { message: string } | null): never {
  throw new Error(`Supabase ${op} failed: ${error?.message ?? "unknown error"}`);
}

export class SupabaseStore implements ReconcileStore {
  constructor(private readonly db: SupabaseClient) {}

  async insertEventIfNew(row: PayPalEventRow) {
    const ins = await this.db
      .from("paypal_events")
      .upsert(row, { onConflict: "event_id", ignoreDuplicates: true })
      .select(EVENT_COLS);
    if (ins.error) fail("insert paypal_events", ins.error);
    if (ins.data && ins.data.length === 1) return { inserted: true, event: ins.data[0] as StoredEvent };
    const cur = await this.db.from("paypal_events").select(EVENT_COLS).eq("event_id", row.event_id).single();
    if (cur.error) fail("read paypal_events", cur.error);
    return { inserted: false, event: cur.data as StoredEvent };
  }

  async markEventProcessed(eventId: string, info: { workspaceId: string | null; note: string | null }) {
    const cur = await this.db.from("paypal_events").select("attempts").eq("event_id", eventId).single();
    if (cur.error) fail("read paypal_events", cur.error);
    const r = await this.db
      .from("paypal_events")
      .update({
        processed_at: new Date().toISOString(),
        attempts: (cur.data.attempts as number) + 1,
        workspace_id: info.workspaceId,
        note: info.note,
        error: null,
      })
      .eq("event_id", eventId);
    if (r.error) fail("update paypal_events", r.error);
  }

  async markEventFailed(eventId: string, error: string) {
    const cur = await this.db.from("paypal_events").select("attempts").eq("event_id", eventId).single();
    if (cur.error) fail("read paypal_events", cur.error);
    const r = await this.db
      .from("paypal_events")
      .update({ attempts: (cur.data.attempts as number) + 1, error })
      .eq("event_id", eventId);
    if (r.error) fail("update paypal_events", r.error);
  }

  private async oneInvoice(column: string, value: string): Promise<InvoiceRow | null> {
    const r = await this.db.from("invoices").select(INVOICE_COLS).eq(column, value).limit(2);
    if (r.error) fail("read invoices", r.error);
    // Ambiguous matches are treated as no match: never attach money to a guessed invoice.
    return r.data.length === 1 ? (r.data[0] as InvoiceRow) : null;
  }

  findInvoiceByPayPalId(id: string) {
    return this.oneInvoice("paypal_invoice_id", id);
  }

  findInvoiceByNumber(number: string) {
    return this.oneInvoice("number", number);
  }

  async findInvoiceByLedgerRef(ref: string) {
    const r = await this.db.from("ledger").select("invoice_id").eq("paypal_ref", ref);
    if (r.error) fail("read ledger", r.error);
    const ids = [...new Set(r.data.map((x) => x.invoice_id as string))];
    return ids.length === 1 ? this.oneInvoice("id", ids[0]) : null;
  }

  async getWorkspaceClockOffsetDays(workspaceId: string) {
    const r = await this.db.from("workspaces").select("clock_offset_days").eq("id", workspaceId).single();
    if (r.error) fail("read workspaces", r.error);
    return r.data.clock_offset_days as number;
  }

  async listLedger(invoiceId: string) {
    const r = await this.db.from("ledger").select(LEDGER_COLS).eq("invoice_id", invoiceId);
    if (r.error) fail("read ledger", r.error);
    return r.data as LedgerRow[];
  }

  async insertLedgerIgnoreDuplicates(rows: LedgerRow[]) {
    if (rows.length === 0) return [];
    const r = await this.db
      .from("ledger")
      .upsert(rows, { onConflict: "invoice_id,kind,paypal_ref", ignoreDuplicates: true })
      .select(LEDGER_COLS);
    if (r.error) fail("insert ledger", r.error);
    return r.data as LedgerRow[];
  }

  async updateInvoiceSync(invoiceId: string, patch: InvoiceSyncPatch) {
    const r = await this.db.from("invoices").update(patch).eq("id", invoiceId);
    if (r.error) fail("update invoices", r.error);
  }

  async getCaseByInvoice(invoiceId: string) {
    const r = await this.db.from("dunning_cases").select(CASE_COLS).eq("invoice_id", invoiceId).maybeSingle();
    if (r.error) fail("read dunning_cases", r.error);
    return (r.data as CaseRow | null) ?? null;
  }

  async transitionCase(w: CaseTransitionWrite) {
    const r = await this.db.rpc("mw_transition_case", {
      p_case_id: w.caseId,
      p_expected_version: w.expectedVersion,
      p_from_state: w.fromState,
      p_to_state: w.toState,
      p_prev_state: w.prevState,
      p_paused_reason: w.pausedReason,
      p_actor: w.actor,
      p_action: w.action,
      p_virtual_date: w.virtualDate,
      p_details: w.details,
    });
    if (r.error) fail("mw_transition_case", r.error);
    return r.data === true;
  }

  async insertAudit(row: AuditRow) {
    const r = await this.db.from("audit_log").insert({ ...row, details: row.details ?? {} });
    if (r.error) fail("insert audit_log", r.error);
  }
}
