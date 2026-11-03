// Persistence port for the service layer. Extends the reconciler port so simulator actions can run
// through the exact same reconcile path as a webhook. Supabase implementation:
// lib/db/supabaseServiceStore.ts. Tests: lib/services/memoryServiceStore.ts.

import type { ActiveState, CaseState } from "../cases/stateMachine";
import type { AuditActor, CaseRow, ReconcileStore, StepKind, StepStatus } from "../cases/store";

export type WorkspaceKind = "demo" | "real" | "golden";
export type Lang = "de" | "en";

export interface WorkspaceRow {
  id: string;
  owner_uid: string | null;
  kind: WorkspaceKind;
  name: string;
  clock_offset_days: number;
  expires_at: string | null;
  created_at?: string;
}

export interface CreditorSeed {
  name: string;
  address: Record<string, string>;
  kleinunternehmer: boolean;
  lang: Lang;
}

export interface DebtorSeed {
  name: string;
  email: string;
  type: "consumer" | "business";
  lang: Lang;
}

export interface CreditorRow extends CreditorSeed {
  id: string;
  workspace_id: string;
}

export interface DebtorRow extends DebtorSeed {
  id: string;
  workspace_id: string;
}

export interface CreateDemoWorkspaceInput {
  ownerUid: string;
  name: string;
  expiresAt: string;
  /** Wall clock (ISO) used to decide which workspaces are still live. */
  nowIso: string;
  perUserCap: number;
  globalCap: number;
  creditor: CreditorSeed;
  debtors: DebtorSeed[];
}

export type CreateDemoWorkspaceResult =
  | { ok: true; workspaceId: string }
  | { ok: false; reason: "user_cap" | "global_cap" };

export interface FullInvoiceRow {
  id: string;
  workspace_id: string;
  creditor_id: string | null;
  debtor_id: string;
  paypal_invoice_id: string | null;
  number: string | null;
  currency: string;
  issue_date: string;
  due_date: string;
  fixed_calendar_due: boolean;
  default_warning_printed: boolean;
  received_on: string | null;
  principal_cents: number;
  request_key: string | null;
}

export type PendingInvoiceInsert = Omit<FullInvoiceRow, "id" | "paypal_invoice_id">;

export interface FullCaseRow extends CaseRow {
  fee_invoice_paypal_id: string | null;
}

export interface FullStepRow {
  id: string;
  workspace_id: string;
  case_id: string;
  kind: StepKind;
  status: StepStatus;
  facts: Record<string, unknown>;
  draft: Record<string, unknown> | null;
  validation: Record<string, unknown> | null;
  approved_by: string | null;
  approved_at: string | null;
  sent_via: "paypal_remind" | "email" | "paypal_invoice" | "none" | null;
  sent_at: string | null;
  exec_token: string | null;
  exec_started_at: string | null;
  created_at?: string;
}

export type StepDecision = "approve" | "reject";

export interface DecideStepInput {
  stepId: string;
  decision: StepDecision;
  actorUid: string;
  virtualDate: string;
  note: string | null;
}

/** ok: this call changed the step. already: the step already had the target status (double click). */
export type DecideStepResult = "ok" | "already" | `invalid:${StepStatus}` | "not_found";

export interface CompleteStepInput {
  stepId: string;
  execToken: string;
  sentVia: NonNullable<FullStepRow["sent_via"]>;
  draft: Record<string, unknown>;
  actorUid: string;
  virtualDate: string;
  /** Case transition to apply atomically with marking the step sent; null for no transition. */
  transition: {
    expectedVersion: number;
    fromState: CaseState;
    toState: CaseState;
    prevState: ActiveState | null;
    pausedReason: string | null;
    actor: AuditActor;
    action: string;
    details: Record<string, unknown>;
  } | null;
  /** Extra details for the step.sent audit row. */
  details: Record<string, unknown>;
}

/** ok: step sent (and case moved). conflict: case version/state changed, nothing written. lost_claim: not ours. */
export type CompleteStepResult = "ok" | "conflict" | "lost_claim";

export interface ServiceStore extends ReconcileStore {
  // workspaces
  getWorkspace(id: string): Promise<WorkspaceRow | null>;
  /** Atomic: checks both caps and inserts workspace, creditor and debtors (one transaction). */
  createDemoWorkspace(input: CreateDemoWorkspaceInput): Promise<CreateDemoWorkspaceResult>;
  /** Compare-and-set on clock_offset_days. False when another writer changed it first. */
  setClockOffset(workspaceId: string, expectedOld: number, next: number): Promise<boolean>;
  getCreditorForWorkspace(workspaceId: string): Promise<CreditorRow | null>;
  getDebtor(id: string): Promise<DebtorRow | null>;
  listDebtors(workspaceId: string): Promise<DebtorRow[]>;

  // invoices
  getFullInvoice(id: string): Promise<FullInvoiceRow | null>;
  findInvoiceByRequestKey(key: string): Promise<FullInvoiceRow | null>;
  /** Inserts unless request_key exists. Returns the stored row and whether this call inserted it. */
  insertPendingInvoice(row: PendingInvoiceInsert): Promise<{ inserted: boolean; invoice: FullInvoiceRow }>;
  /** Sets paypal_invoice_id when still null (or already equal). False otherwise. */
  setInvoicePayPalId(invoiceId: string, paypalInvoiceId: string): Promise<boolean>;
  /** Deletes an invoice that has no dunning case yet. Returns false if a case exists (then nothing is deleted). */
  deletePendingInvoice(invoiceId: string): Promise<boolean>;
  /** Atomic and idempotent: creates the dunning case (state open) and its audit rows. Returns the case id. */
  finalizeInvoice(input: { invoiceId: string; paypalInvoiceId: string; actorUid: string; virtualDate: string; details: Record<string, unknown> }): Promise<string>;

  // cases
  getCase(id: string): Promise<FullCaseRow | null>;
  getCaseForInvoice(invoiceId: string): Promise<FullCaseRow | null>;
  listCases(workspaceId: string): Promise<FullCaseRow[]>;
  /** Sets fee_invoice_paypal_id only if still null. */
  setCaseFeeInvoiceId(caseId: string, paypalInvoiceId: string): Promise<void>;
  /** Virtual date of the latest step transition (reminder, Mahnung, handover) of the case, or null. */
  lastStepTransitionDate(caseId: string): Promise<string | null>;

  // steps
  getStep(id: string): Promise<FullStepRow | null>;
  listSteps(caseId: string): Promise<FullStepRow[]>;
  /** Inserts a proposed dunning step unless the case already has a pending (proposed or approved) one. */
  insertProposedStep(row: { workspace_id: string; case_id: string; kind: StepKind; facts: Record<string, unknown> }): Promise<{ inserted: boolean; step: FullStepRow | null }>;
  /** Atomic decision with audit row. */
  decideStep(input: DecideStepInput): Promise<DecideStepResult>;
  /** Takes the execution lease of an approved step. False when another executor holds a fresh lease. */
  claimStepExecution(stepId: string, token: string, nowIso: string, leaseMs: number): Promise<boolean>;
  releaseStepExecution(stepId: string, token: string): Promise<void>;
  /** Records the channel decision before the outbound call so a retry does not consume quota twice. */
  setStepSentVia(stepId: string, token: string, sentVia: NonNullable<FullStepRow["sent_via"]>): Promise<boolean>;
  /** Atomic: case transition (optional) + step sent + audit rows. */
  completeStep(input: CompleteStepInput): Promise<CompleteStepResult>;
  /** Marks an approved step failed (lease holder only) and writes an audit row. */
  failStep(stepId: string, token: string, reason: string, actorUid: string, virtualDate: string): Promise<boolean>;

  // quota
  /** Atomic increment of the reminder counter if below max. True when a slot was granted. */
  consumeReminderQuota(merchantId: string, day: string, max: number): Promise<boolean>;
}
