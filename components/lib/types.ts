// Row shapes of the tables the browser reads under RLS (see supabase/migrations/0001_init.sql).

export type CaseState =
  | "open"
  | "overdue"
  | "reminded"
  | "mahnung1"
  | "mahnung2"
  | "handover_ready"
  | "paused_dispute"
  | "closed_paid"
  | "closed_refunded"
  | "closed_cancelled";

export type StepKind = "reminder" | "mahnung1" | "mahnung2" | "handover" | "fee_invoice" | "close";
export type StepStatus = "proposed" | "approved" | "sent" | "rejected" | "failed";

export interface WorkspaceRow {
  id: string;
  owner_uid: string | null;
  kind: "demo" | "real" | "golden";
  name: string;
  clock_offset_days: number;
  expires_at: string | null;
  created_at: string;
}

export interface CreditorRow {
  id: string;
  workspace_id: string;
  name: string;
  kleinunternehmer: boolean;
  lang: "de" | "en";
}

export interface DebtorRow {
  id: string;
  workspace_id: string;
  name: string;
  email: string | null;
  type: "consumer" | "business";
  lang: "de" | "en";
}

export interface InvoiceRow {
  id: string;
  workspace_id: string;
  debtor_id: string;
  number: string | null;
  issue_date: string;
  due_date: string;
  fixed_calendar_due: boolean;
  default_warning_printed: boolean;
  received_on: string | null;
  principal_cents: number;
  paypal_status: string | null;
  paypal_invoice_id: string | null;
}

export interface LedgerRow {
  id: string;
  workspace_id: string;
  invoice_id: string;
  kind: "payment" | "refund";
  amount_cents: number;
  booked_on: string;
  paypal_ref: string;
  source: "paypal" | "manual";
  created_at: string;
}

export interface CaseRow {
  id: string;
  workspace_id: string;
  invoice_id: string;
  state: CaseState;
  prev_state: string | null;
  paused_reason: string | null;
  default_start: string | null;
  next_step_kind: string | null;
  next_step_due: string | null;
  hold_until: string | null;
  updated_at: string;
  created_at: string;
}

export interface StepRow {
  id: string;
  workspace_id: string;
  case_id: string;
  kind: StepKind;
  facts: Record<string, unknown>;
  draft: Record<string, unknown> | null;
  validation: Record<string, unknown> | null;
  status: StepStatus;
  approved_at: string | null;
  sent_via: "paypal_remind" | "email" | "paypal_invoice" | "none" | null;
  sent_at: string | null;
  created_at: string;
}

export interface AuditRow {
  id: number;
  workspace_id: string | null;
  case_id: string | null;
  invoice_id: string | null;
  actor: "user" | "system" | "ai" | "paypal";
  action: string;
  from_state: string | null;
  to_state: string | null;
  real_ts: string;
  virtual_date: string | null;
  details: Record<string, unknown>;
}

export interface WorkspaceData {
  workspace: WorkspaceRow;
  creditor: CreditorRow | null;
  debtors: DebtorRow[];
  invoices: InvoiceRow[];
  ledger: LedgerRow[];
  cases: CaseRow[];
  steps: StepRow[];
  audit: AuditRow[];
}
