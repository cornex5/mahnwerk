// In-memory ServiceStore with the same uniqueness, locking and atomicity semantics as the SQL
// schema and the 0003 functions. Each method runs without an await between its check and its write,
// so it is atomic on the single JS thread, like the SQL functions are in Postgres.
// Used by tests and local demos only.

import { randomUUID } from "node:crypto";
import { MemoryStore } from "../cases/memoryStore";
import type { ClaimFacts, StepRow } from "../cases/store";
import type {
  CompleteStepInput,
  CompleteStepResult,
  CreateDemoWorkspaceInput,
  CreateDemoWorkspaceResult,
  CreditorRow,
  DebtorRow,
  DecideStepInput,
  DecideStepResult,
  FullCaseRow,
  FullInvoiceRow,
  FullStepRow,
  PendingInvoiceInsert,
  ServiceStore,
  WorkspaceRow,
} from "./store";

const STEP_TRANSITION_ACTIONS = ["case.reminder_sent", "case.mahnung1_sent", "case.mahnung2_sent", "case.handover_prepared"];
const PAYMENT_REQUEST_ACTIONS = ["case.reminder_sent", "case.mahnung1_sent", "case.mahnung2_sent"];
const PENDING_DUNNING_KINDS = new Set(["reminder", "mahnung1", "mahnung2", "handover"]);

export class MemoryServiceStore extends MemoryStore implements ServiceStore {
  workspaces = new Map<string, WorkspaceRow>();
  creditors = new Map<string, CreditorRow>();
  debtors = new Map<string, DebtorRow>();
  fullInvoices = new Map<string, FullInvoiceRow>();
  feeInvoiceIds = new Map<string, string | null>();
  holds = new Map<string, string | null>();
  quota = new Map<string, number>();
  /** Test hooks to inject database failures. */
  failNext: Partial<Record<"finalizeInvoice" | "completeStep" | "setInvoicePayPalId" | "insertPendingInvoice", Error>> = {};

  private takeFailure(op: keyof MemoryServiceStore["failNext"]) {
    const e = this.failNext[op];
    if (e) {
      delete this.failNext[op];
      throw e;
    }
  }

  get fullSteps(): FullStepRow[] {
    return this.steps as unknown as FullStepRow[];
  }

  // ------------------------------------------------------------ reconciler overrides

  override async getWorkspaceClockOffsetDays(workspaceId: string) {
    const ws = this.workspaces.get(workspaceId);
    return ws ? ws.clock_offset_days : super.getWorkspaceClockOffsetDays(workspaceId);
  }

  override async getClaimFacts(invoiceId: string): Promise<ClaimFacts | null> {
    const inv = this.fullInvoices.get(invoiceId);
    if (!inv) return super.getClaimFacts(invoiceId);
    const debtor = this.debtors.get(inv.debtor_id);
    if (!debtor) return null;
    const dates = this.audit
      .filter((a) => a.invoice_id === invoiceId && PAYMENT_REQUEST_ACTIONS.includes(a.action) && a.virtual_date)
      .map((a) => a.virtual_date as string)
      .sort();
    return {
      due_date: inv.due_date,
      fixed_calendar_due: inv.fixed_calendar_due,
      default_warning_printed: inv.default_warning_printed,
      received_on: inv.received_on,
      debtor_type: debtor.type,
      first_payment_request_on: dates[0] ?? null,
    };
  }

  override async insertFeeInvoiceStepIfAbsent(row: StepRow & { kind: "fee_invoice"; status: "proposed" }) {
    if (!this.cases.has(row.case_id)) throw new Error("steps.case_id foreign key violated");
    if (this.fullSteps.some((s) => s.case_id === row.case_id && s.kind === "fee_invoice")) return false;
    this.fullSteps.push(this.newStep({ ...row }));
    return true;
  }

  private newStep(row: Pick<FullStepRow, "workspace_id" | "case_id" | "kind" | "status" | "facts">): FullStepRow {
    return {
      id: randomUUID(),
      workspace_id: row.workspace_id,
      case_id: row.case_id,
      kind: row.kind,
      status: row.status,
      facts: structuredClone(row.facts),
      draft: null,
      validation: null,
      approved_by: null,
      approved_at: null,
      sent_via: null,
      sent_at: null,
      exec_token: null,
      exec_started_at: null,
      created_at: new Date().toISOString(),
    };
  }

  // ------------------------------------------------------------ workspaces

  async getWorkspace(id: string) {
    const w = this.workspaces.get(id);
    return w ? { ...w } : null;
  }

  async createDemoWorkspace(input: CreateDemoWorkspaceInput): Promise<CreateDemoWorkspaceResult> {
    const live = [...this.workspaces.values()].filter((w) => w.kind === "demo" && w.expires_at !== null && w.expires_at > input.nowIso);
    if (live.filter((w) => w.owner_uid === input.ownerUid).length >= input.perUserCap) return { ok: false, reason: "user_cap" };
    if (live.length >= input.globalCap) return { ok: false, reason: "global_cap" };
    const id = randomUUID();
    this.workspaces.set(id, { id, owner_uid: input.ownerUid, kind: "demo", name: input.name, clock_offset_days: 0, expires_at: input.expiresAt, created_at: input.nowIso });
    const cid = randomUUID();
    this.creditors.set(cid, { ...structuredClone(input.creditor), id: cid, workspace_id: id });
    for (const d of input.debtors) {
      const did = randomUUID();
      this.debtors.set(did, { ...d, id: did, workspace_id: id });
    }
    this.audit.push({ seq: this.audit.length + 1, workspace_id: id, case_id: null, invoice_id: null, actor: "user", action: "workspace.created", details: { expires_at: input.expiresAt } });
    return { ok: true, workspaceId: id };
  }

  async setClockOffset(workspaceId: string, expectedOld: number, next: number) {
    const w = this.workspaces.get(workspaceId);
    if (!w || w.clock_offset_days !== expectedOld) return false;
    if (next < 0) throw new Error("clock_offset_days check violated");
    w.clock_offset_days = next;
    return true;
  }

  async getCreditorForWorkspace(workspaceId: string) {
    const c = [...this.creditors.values()].find((x) => x.workspace_id === workspaceId);
    return c ? structuredClone(c) : null;
  }

  async getDebtor(id: string) {
    const d = this.debtors.get(id);
    return d ? { ...d } : null;
  }

  async listDebtors(workspaceId: string) {
    return [...this.debtors.values()].filter((d) => d.workspace_id === workspaceId).map((d) => ({ ...d }));
  }

  // ------------------------------------------------------------ invoices

  async getFullInvoice(id: string) {
    const i = this.fullInvoices.get(id);
    return i ? { ...i } : null;
  }

  async findInvoiceByRequestKey(key: string) {
    const i = [...this.fullInvoices.values()].find((x) => x.request_key === key);
    return i ? { ...i } : null;
  }

  async insertPendingInvoice(row: PendingInvoiceInsert) {
    this.takeFailure("insertPendingInvoice");
    const existing = row.request_key ? [...this.fullInvoices.values()].find((x) => x.request_key === row.request_key) : undefined;
    if (existing) return { inserted: false, invoice: { ...existing } };
    if (!this.debtors.has(row.debtor_id)) throw new Error("invoices.debtor_id foreign key violated");
    if (row.principal_cents <= 0) throw new Error("principal_cents check violated");
    const inv: FullInvoiceRow = { ...row, id: randomUUID(), paypal_invoice_id: null };
    this.fullInvoices.set(inv.id, inv);
    this.invoices.set(inv.id, { id: inv.id, workspace_id: inv.workspace_id, paypal_invoice_id: null, number: inv.number, currency: inv.currency, principal_cents: inv.principal_cents });
    return { inserted: true, invoice: { ...inv } };
  }

  async setInvoicePayPalId(invoiceId: string, paypalInvoiceId: string) {
    this.takeFailure("setInvoicePayPalId");
    const inv = this.fullInvoices.get(invoiceId);
    if (!inv) return false;
    if (inv.paypal_invoice_id !== null && inv.paypal_invoice_id !== paypalInvoiceId) return false;
    const clash = [...this.fullInvoices.values()].some((x) => x.id !== invoiceId && x.paypal_invoice_id === paypalInvoiceId);
    if (clash) throw new Error("invoices.paypal_invoice_id unique violated");
    inv.paypal_invoice_id = paypalInvoiceId;
    this.invoices.get(invoiceId)!.paypal_invoice_id = paypalInvoiceId;
    return true;
  }

  async deletePendingInvoice(invoiceId: string) {
    if ([...this.cases.values()].some((c) => c.invoice_id === invoiceId)) return false;
    this.fullInvoices.delete(invoiceId);
    this.invoices.delete(invoiceId);
    this.ledger = this.ledger.filter((l) => l.invoice_id !== invoiceId);
    return true;
  }

  async finalizeInvoice(input: { invoiceId: string; paypalInvoiceId: string; actorUid: string; virtualDate: string; details: Record<string, unknown> }) {
    this.takeFailure("finalizeInvoice");
    const inv = this.fullInvoices.get(input.invoiceId);
    if (!inv || (inv.paypal_invoice_id !== null && inv.paypal_invoice_id !== input.paypalInvoiceId)) {
      throw new Error(`invoice ${input.invoiceId} missing or linked to another PayPal invoice`);
    }
    inv.paypal_invoice_id = input.paypalInvoiceId;
    this.invoices.get(inv.id)!.paypal_invoice_id = input.paypalInvoiceId;
    const existing = [...this.cases.values()].find((c) => c.invoice_id === inv.id);
    if (existing) return existing.id;
    const id = randomUUID();
    this.cases.set(id, { id, workspace_id: inv.workspace_id, invoice_id: inv.id, state: "open", prev_state: null, paused_reason: null, version: 0 });
    this.feeInvoiceIds.set(id, null);
    this.audit.push({ seq: this.audit.length + 1, workspace_id: inv.workspace_id, case_id: id, invoice_id: inv.id, actor: "user", action: "invoice.sent", to_state: "open", virtual_date: input.virtualDate, details: { ...input.details, actor_uid: input.actorUid } });
    return id;
  }

  // ------------------------------------------------------------ cases

  private fullCase(id: string): FullCaseRow | null {
    const c = this.cases.get(id);
    return c ? { ...c, fee_invoice_paypal_id: this.feeInvoiceIds.get(id) ?? null, hold_until: this.holds.get(id) ?? null } : null;
  }

  async getCase(id: string) {
    return this.fullCase(id);
  }

  async getCaseForInvoice(invoiceId: string) {
    const c = [...this.cases.values()].find((x) => x.invoice_id === invoiceId);
    return c ? this.fullCase(c.id) : null;
  }

  async listCases(workspaceId: string) {
    return [...this.cases.values()].filter((c) => c.workspace_id === workspaceId).map((c) => this.fullCase(c.id)!);
  }

  async setCaseHold(caseId: string, holdUntil: string | null) {
    this.holds.set(caseId, holdUntil);
  }

  async setCaseFeeInvoiceId(caseId: string, paypalInvoiceId: string) {
    if (!this.feeInvoiceIds.get(caseId)) this.feeInvoiceIds.set(caseId, paypalInvoiceId);
  }

  async lastStepTransitionDate(caseId: string) {
    const rows = this.audit.filter((a) => a.case_id === caseId && STEP_TRANSITION_ACTIONS.includes(a.action) && a.virtual_date);
    return rows.length > 0 ? (rows[rows.length - 1].virtual_date as string) : null;
  }

  // ------------------------------------------------------------ steps

  async getStep(id: string) {
    const s = this.fullSteps.find((x) => x.id === id);
    return s ? structuredClone(s) : null;
  }

  async listSteps(caseId: string) {
    return this.fullSteps.filter((s) => s.case_id === caseId).map((s) => structuredClone(s));
  }

  async insertProposedStep(row: { workspace_id: string; case_id: string; kind: FullStepRow["kind"]; facts: Record<string, unknown> }) {
    if (!this.cases.has(row.case_id)) throw new Error("steps.case_id foreign key violated");
    if (PENDING_DUNNING_KINDS.has(row.kind)) {
      const pending = this.fullSteps.find((s) => s.case_id === row.case_id && PENDING_DUNNING_KINDS.has(s.kind) && (s.status === "proposed" || s.status === "approved"));
      if (pending) return { inserted: false, step: structuredClone(pending) };
    }
    const s = this.newStep({ ...row, status: "proposed" });
    this.fullSteps.push(s);
    return { inserted: true, step: structuredClone(s) };
  }

  async setStepDraft(stepId: string, draft: Record<string, unknown> | null, validation: Record<string, unknown> | null) {
    const s = this.fullSteps.find((x) => x.id === stepId);
    if (!s || s.status !== "proposed") return false;
    s.draft = draft === null ? null : structuredClone(draft);
    s.validation = validation === null ? null : structuredClone(validation);
    return true;
  }

  async decideStep(input: DecideStepInput): Promise<DecideStepResult> {
    const s = this.fullSteps.find((x) => x.id === input.stepId);
    if (!s) return "not_found";
    const target = input.decision === "approve" ? "approved" : "rejected";
    if (s.status === target) return "already";
    if (input.decision === "approve" && s.status !== "proposed") return `invalid:${s.status}`;
    if (input.decision === "reject" && (!["proposed", "approved"].includes(s.status) || s.exec_token !== null)) return `invalid:${s.status}`;
    if (input.decision === "approve") {
      s.status = "approved";
      s.approved_by = input.actorUid;
      s.approved_at = new Date().toISOString();
    } else {
      s.status = "rejected";
      s.validation = { ...(s.validation ?? {}), rejected_by: input.actorUid, rejected_virtual_date: input.virtualDate, rejected_note: input.note };
    }
    this.audit.push({ seq: this.audit.length + 1, workspace_id: s.workspace_id, case_id: s.case_id, invoice_id: null, actor: "user", action: input.decision === "approve" ? "step.approved" : "step.rejected", virtual_date: input.virtualDate, details: { step_id: s.id, kind: s.kind, note: input.note } });
    return "ok";
  }

  async claimStepExecution(stepId: string, token: string, nowIso: string, leaseMs: number) {
    const s = this.fullSteps.find((x) => x.id === stepId);
    if (!s || s.status !== "approved") return false;
    const stale = s.exec_started_at === null || Date.parse(s.exec_started_at) < Date.parse(nowIso) - leaseMs;
    if (s.exec_token !== null && !stale) return false;
    s.exec_token = token;
    s.exec_started_at = nowIso;
    return true;
  }

  async releaseStepExecution(stepId: string, token: string) {
    const s = this.fullSteps.find((x) => x.id === stepId);
    if (s && s.exec_token === token) {
      s.exec_token = null;
      s.exec_started_at = null;
    }
  }

  async setStepSentVia(stepId: string, token: string, sentVia: NonNullable<FullStepRow["sent_via"]>) {
    const s = this.fullSteps.find((x) => x.id === stepId);
    if (!s || s.status !== "approved" || s.exec_token !== token) return false;
    s.sent_via = sentVia;
    return true;
  }

  async completeStep(input: CompleteStepInput): Promise<CompleteStepResult> {
    this.takeFailure("completeStep");
    const s = this.fullSteps.find((x) => x.id === input.stepId);
    if (!s || s.status !== "approved" || s.exec_token !== input.execToken) return "lost_claim";
    if (!s.approved_by || !s.approved_at) throw new Error(`step ${s.id} has no recorded approval`);
    if (input.transition) {
      const t = input.transition;
      const ok = await this.transitionCase({
        caseId: s.case_id,
        expectedVersion: t.expectedVersion,
        fromState: t.fromState,
        toState: t.toState,
        prevState: t.prevState,
        pausedReason: t.pausedReason,
        actor: t.actor,
        action: t.action,
        virtualDate: input.virtualDate,
        details: t.details,
      });
      if (!ok) return "conflict";
    }
    s.status = "sent";
    s.sent_via = input.sentVia;
    s.sent_at = new Date().toISOString();
    s.draft = structuredClone(input.draft);
    s.exec_token = null;
    s.exec_started_at = null;
    this.audit.push({ seq: this.audit.length + 1, workspace_id: s.workspace_id, case_id: s.case_id, invoice_id: null, actor: "user", action: "step.sent", virtual_date: input.virtualDate, details: { ...input.details, step_id: s.id, kind: s.kind, sent_via: input.sentVia } });
    return "ok";
  }

  async failStep(stepId: string, token: string, reason: string, actorUid: string, virtualDate: string) {
    const s = this.fullSteps.find((x) => x.id === stepId);
    if (!s || s.status !== "approved" || s.exec_token !== token) return false;
    s.status = "failed";
    s.exec_token = null;
    s.exec_started_at = null;
    s.validation = { ...(s.validation ?? {}), failed_reason: reason };
    this.audit.push({ seq: this.audit.length + 1, workspace_id: s.workspace_id, case_id: s.case_id, invoice_id: null, actor: "system", action: "step.failed", virtual_date: virtualDate, details: { step_id: s.id, kind: s.kind, reason, actor_uid: actorUid } });
    return true;
  }

  // ------------------------------------------------------------ quota

  async consumeReminderQuota(merchantId: string, day: string, max: number) {
    const cap = Math.min(Math.max(max, 0), 2);
    const key = `${merchantId}|${day}`;
    const used = this.quota.get(key) ?? 0;
    if (used >= cap) return false;
    this.quota.set(key, used + 1);
    return true;
  }
}
