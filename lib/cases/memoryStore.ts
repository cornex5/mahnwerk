// In-memory ReconcileStore with the same uniqueness and locking semantics as the SQL schema.
// Used by tests and local demos only.

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
} from "./store";

export class MemoryStore implements ReconcileStore {
  events = new Map<string, StoredEvent & { workspace_id: string | null; note: string | null; error: string | null }>();
  invoices = new Map<string, InvoiceRow & Partial<InvoiceSyncPatch>>();
  ledger: LedgerRow[] = [];
  cases = new Map<string, CaseRow>();
  audit: (AuditRow & { seq: number })[] = [];
  clockOffsets = new Map<string, number>();
  /** Test hook: called before each transitionCase, may mutate state to simulate a concurrent writer. */
  beforeTransition?: (write: CaseTransitionWrite) => void;

  async insertEventIfNew(row: PayPalEventRow) {
    const existing = this.events.get(row.event_id);
    if (existing) return { inserted: false, event: { ...existing } };
    const stored = { ...row, processed_at: null, attempts: 0, workspace_id: null, note: null, error: null };
    this.events.set(row.event_id, stored);
    return { inserted: true, event: { ...stored } };
  }

  async markEventProcessed(eventId: string, info: { workspaceId: string | null; note: string | null }) {
    const e = this.must(this.events.get(eventId), "event");
    e.processed_at = new Date().toISOString();
    e.attempts += 1;
    e.workspace_id = info.workspaceId;
    e.note = info.note;
    e.error = null;
  }

  async markEventFailed(eventId: string, error: string) {
    const e = this.must(this.events.get(eventId), "event");
    e.attempts += 1;
    e.error = error;
  }

  async findInvoiceByPayPalId(id: string) {
    for (const inv of this.invoices.values()) if (inv.paypal_invoice_id === id) return { ...inv };
    return null;
  }

  async findInvoiceByNumber(number: string) {
    const hits = [...this.invoices.values()].filter((i) => i.number === number);
    return hits.length === 1 ? { ...hits[0] } : null;
  }

  async findInvoiceByLedgerRef(ref: string) {
    const ids = new Set(this.ledger.filter((l) => l.paypal_ref === ref).map((l) => l.invoice_id));
    if (ids.size !== 1) return null;
    const inv = this.invoices.get([...ids][0]);
    return inv ? { ...inv } : null;
  }

  async getWorkspaceClockOffsetDays(workspaceId: string) {
    return this.clockOffsets.get(workspaceId) ?? 0;
  }

  async listLedger(invoiceId: string) {
    return this.ledger.filter((l) => l.invoice_id === invoiceId).map((l) => ({ ...l }));
  }

  async insertLedgerIgnoreDuplicates(rows: LedgerRow[]) {
    const inserted: LedgerRow[] = [];
    for (const r of rows) {
      if (!Number.isSafeInteger(r.amount_cents) || r.amount_cents <= 0) throw new RangeError("amount_cents must be > 0");
      const dup = this.ledger.some((l) => l.invoice_id === r.invoice_id && l.kind === r.kind && l.paypal_ref === r.paypal_ref);
      if (dup) continue;
      this.ledger.push({ ...r });
      inserted.push({ ...r });
    }
    return inserted;
  }

  async updateInvoiceSync(invoiceId: string, patch: InvoiceSyncPatch) {
    const inv = this.must(this.invoices.get(invoiceId), "invoice");
    Object.assign(inv, patch);
  }

  async getCaseByInvoice(invoiceId: string) {
    for (const c of this.cases.values()) if (c.invoice_id === invoiceId) return { ...c };
    return null;
  }

  async transitionCase(w: CaseTransitionWrite) {
    this.beforeTransition?.(w);
    const c = this.must(this.cases.get(w.caseId), "case");
    if (c.version !== w.expectedVersion || c.state !== w.fromState) return false;
    if ((w.toState === "paused_dispute") !== (w.pausedReason !== null)) throw new Error("paused_reason check violated");
    c.state = w.toState;
    c.prev_state = w.prevState;
    c.paused_reason = w.pausedReason;
    c.version += 1;
    this.audit.push({
      seq: this.audit.length + 1,
      workspace_id: c.workspace_id,
      case_id: c.id,
      invoice_id: c.invoice_id,
      actor: w.actor,
      action: w.action,
      from_state: w.fromState,
      to_state: w.toState,
      virtual_date: w.virtualDate,
      details: w.details,
    });
    return true;
  }

  async insertAudit(row: AuditRow) {
    this.audit.push({ ...row, seq: this.audit.length + 1 });
  }

  private must<T>(v: T | undefined, what: string): T {
    if (v === undefined) throw new Error(`${what} not found`);
    return v;
  }
}
