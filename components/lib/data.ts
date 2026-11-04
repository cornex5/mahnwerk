// Reads one workspace with all its tables directly from Supabase under RLS.

import { getSupabase } from "./supabase";
import type { AuditRow, CaseRow, CreditorRow, DebtorRow, InvoiceRow, LedgerRow, StepRow, WorkspaceData, WorkspaceRow } from "./types";

export class NotFoundError extends Error {
  constructor() {
    super("This workspace does not exist, has expired, or belongs to another browser session.");
    this.name = "NotFoundError";
  }
}

function must<T>(res: { data: T | null; error: { message: string } | null }, what: string): T {
  if (res.error) throw new Error(`Could not load ${what}: ${res.error.message}`);
  return res.data as T;
}

export async function loadWorkspaceData(id: string): Promise<WorkspaceData> {
  const sb = getSupabase();
  const wsRes = await sb.from("workspaces").select("id, owner_uid, kind, name, clock_offset_days, expires_at, created_at").eq("id", id).maybeSingle();
  const workspace = must<WorkspaceRow | null>(wsRes as never, "workspace");
  if (!workspace) throw new NotFoundError();
  const [creditors, debtors, invoices, ledger, cases, steps, audit] = await Promise.all([
    sb.from("creditors").select("id, workspace_id, name, kleinunternehmer, lang").eq("workspace_id", id).limit(1),
    sb.from("debtors").select("id, workspace_id, name, email, type, lang").eq("workspace_id", id).order("created_at"),
    sb
      .from("invoices")
      .select("id, workspace_id, debtor_id, number, issue_date, due_date, fixed_calendar_due, default_warning_printed, received_on, principal_cents, paypal_status, paypal_invoice_id")
      .eq("workspace_id", id),
    sb.from("ledger").select("id, workspace_id, invoice_id, kind, amount_cents, booked_on, paypal_ref, source, created_at").eq("workspace_id", id).order("booked_on"),
    sb.from("dunning_cases").select("id, workspace_id, invoice_id, state, prev_state, paused_reason, default_start, next_step_kind, next_step_due, hold_until, updated_at, created_at").eq("workspace_id", id),
    sb
      .from("steps")
      .select("id, workspace_id, case_id, kind, facts, draft, validation, status, approved_at, sent_via, sent_at, created_at")
      .eq("workspace_id", id)
      .order("created_at"),
    sb
      .from("audit_log")
      .select("id, workspace_id, case_id, invoice_id, actor, action, from_state, to_state, real_ts, virtual_date, details")
      .eq("workspace_id", id)
      .order("real_ts", { ascending: true })
      .order("id", { ascending: true })
      .limit(1000),
  ]);
  return {
    workspace,
    creditor: must<CreditorRow[]>(creditors as never, "creditor")[0] ?? null,
    debtors: must<DebtorRow[]>(debtors as never, "debtors"),
    invoices: must<InvoiceRow[]>(invoices as never, "invoices"),
    ledger: must<LedgerRow[]>(ledger as never, "ledger"),
    cases: must<CaseRow[]>(cases as never, "cases"),
    steps: must<StepRow[]>(steps as never, "steps"),
    audit: must<AuditRow[]>(audit as never, "audit log"),
  };
}

export async function findGoldenWorkspaceId(): Promise<string | null> {
  const res = await getSupabase().from("workspaces").select("id").eq("kind", "golden").limit(1).maybeSingle();
  if (res.error) throw new Error(`Could not look up the example workspace: ${res.error.message}`);
  return (res.data as { id: string } | null)?.id ?? null;
}

export async function findLatestOwnDemoId(uid: string): Promise<string | null> {
  const res = await getSupabase()
    .from("workspaces")
    .select("id")
    .eq("owner_uid", uid)
    .eq("kind", "demo")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (res.error) return null;
  return (res.data as { id: string } | null)?.id ?? null;
}
