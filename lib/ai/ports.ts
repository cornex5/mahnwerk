// Persistence ports for the AI layer. lib/ai never touches the database directly; the services
// layer implements these interfaces (Supabase, service role) and tests use in-memory fakes.

import type { ISODate, InvoiceFacts, LedgerEntry } from "../rules/types";

// ---------------------------------------------------------------------------
// Budget (AI call caps)
// ---------------------------------------------------------------------------

export type QuotaScope = "workspace" | "global";

export interface QuotaRequest {
  workspaceId: string;
  /** UTC calendar day of the call, YYYY-MM-DD. The global cap is per day. */
  day: ISODate;
  /** Lifetime cap for one workspace (demo workspaces are short-lived). */
  workspaceLimit: number;
  /** Cap for all workspaces together on `day`. */
  globalLimit: number;
}

export type QuotaDecision = { ok: true; workspaceUsed: number; globalUsed: number } | { ok: false; scope: QuotaScope };

export interface AiCallCounter {
  /**
   * Atomically consumes one call if both counters are below their limits, otherwise consumes
   * nothing. Implementations must be race-free (e.g. one SQL statement or a row lock).
   */
  tryConsume(req: QuotaRequest): Promise<QuotaDecision>;
}

// ---------------------------------------------------------------------------
// ai_runs recorder (one row per model call)
// ---------------------------------------------------------------------------

export type AiPurpose = "draft_letter" | "classify_reply" | "explain_step" | "copilot";

/** Same shape as the public.ai_runs table (minus id and created_at). */
export interface AiRunRow {
  workspace_id: string;
  step_id: string | null;
  purpose: AiPurpose;
  model: string;
  input_facts: Record<string, unknown>;
  raw_output: unknown;
  validation_passed: boolean | null;
  input_tokens: number | null;
  output_tokens: number | null;
}

export interface AiRunRecorder {
  record(row: AiRunRow): Promise<void>;
}

// ---------------------------------------------------------------------------
// Copilot store (read-only plus one proposal insert)
// ---------------------------------------------------------------------------

export type ProposableStepKind = "reminder" | "mahnung1" | "mahnung2" | "handover" | "fee_invoice" | "close";

export interface CopilotCaseSummary {
  id: string;
  invoice_id: string;
  invoice_number: string | null;
  debtor_name: string;
  debtor_type: "consumer" | "business";
  state: string;
  principal_cents: number;
  due_date: ISODate;
  next_step_kind: string | null;
  next_step_due: ISODate | null;
}

export interface CopilotCaseDetail extends CopilotCaseSummary {
  default_start: ISODate | null;
  paused_reason: string | null;
  paypal_status: string | null;
}

export interface CopilotLedgerRow {
  kind: "payment" | "refund";
  amount_cents: number;
  booked_on: ISODate;
}

export interface CopilotStepRow {
  id: string;
  case_id: string;
  kind: string;
  status: string;
  created_at: string;
}

/** Rules engine inputs for one case, as of the workspace's virtual date. */
export interface CopilotClaimInput {
  invoice: InvoiceFacts;
  ledger: LedgerEntry[];
  /** Workspace virtual "today" (real date plus clock_offset_days). */
  today: ISODate;
}

export interface ProposedStepInsert {
  workspace_id: string;
  case_id: string;
  kind: ProposableStepKind;
  status: "proposed";
  facts: { reason: string; proposed_by: "ai_copilot" };
}

/**
 * Every method takes the workspace id first and must scope its query to it. A case id from another
 * workspace must behave exactly like a missing case (return null or an empty list).
 */
export interface CopilotStore {
  getCase(workspaceId: string, caseId: string): Promise<CopilotCaseDetail | null>;
  listCases(workspaceId: string, opts: { state?: string; limit: number }): Promise<CopilotCaseSummary[]>;
  getLedger(workspaceId: string, caseId: string): Promise<CopilotLedgerRow[] | null>;
  getClaimInput(workspaceId: string, caseId: string): Promise<CopilotClaimInput | null>;
  listProposedSteps(workspaceId: string, caseId?: string): Promise<CopilotStepRow[]>;
  /** The only write: inserts one row into steps with status 'proposed'. Never sends anything. */
  insertProposedStep(row: ProposedStepInsert): Promise<{ id: string }>;
}
